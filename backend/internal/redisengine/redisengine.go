package redisengine

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/deadlockiq/engine/internal/fencing"
	"github.com/deadlockiq/engine/internal/types"
	"github.com/redis/go-redis/v9"
)

// Safe atomic release Lua script verifying lock holder
// KEYS[1] = resource key
// ARGV[1] = txId
const releaseScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`

type LockExpiredCallback func(lock types.LockRecord)

type Engine struct {
	mu                  sync.RWMutex
	client              *redis.Client
	isUpstashConnected  bool
	isSimulatingFailure bool
	artificialLatency   time.Duration

	// In-memory fallback and metadata cache
	localLocks          map[string]*types.LockRecord
	expirationTimers    map[string]*time.Timer
	onLockExpired       LockExpiredCallback
	fencing             *fencing.TokenManager
}

func NewEngine(fencingMgr *fencing.TokenManager, onExpired LockExpiredCallback) *Engine {
	eng := &Engine{
		localLocks:       make(map[string]*types.LockRecord),
		expirationTimers: make(map[string]*time.Timer),
		onLockExpired:    onExpired,
		fencing:          fencingMgr,
	}

	redisURL := os.Getenv("REDIS_URL")
	if redisURL != "" {
		eng.connectUpstash(redisURL)
	}

	return eng
}

func (e *Engine) connectUpstash(redisURL string) {
	parsed, err := url.Parse(redisURL)
	if err != nil {
		fmt.Printf("[Redis] Warning: Failed to parse REDIS_URL: %v\n", err)
		return
	}

	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		fmt.Printf("[Redis] Warning: Failed to parse redis URL into options: %v\n", err)
		return
	}

	// If using rediss:// protocol, enforce TLS
	if strings.HasPrefix(redisURL, "rediss://") || parsed.Scheme == "rediss" {
		if opt.TLSConfig == nil {
			opt.TLSConfig = &tls.Config{
				MinVersion: tls.VersionTLS12,
			}
		}
	}

	client := redis.NewClient(opt)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	if err := client.Ping(ctx).Err(); err != nil {
		fmt.Printf("[Redis] Warning: Initial Upstash connection check failed (%v). Falling back to safe engine mode.\n", err)
		client.Close()
		return
	}

	e.client = client
	e.isUpstashConnected = true
	fmt.Printf("[Redis] Successfully connected to Upstash Cloud Redis at %s\n", opt.Addr)
}

func (e *Engine) IsHealthy() bool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return !e.isSimulatingFailure
}

func (e *Engine) IsUpstashOnline() bool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.isUpstashConnected && !e.isSimulatingFailure
}

func (e *Engine) SetSimulateFailure(sim bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.isSimulatingFailure = sim
}

func (e *Engine) SetArtificialLatency(d time.Duration) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.artificialLatency = d
}

type AcquireResult struct {
	Success           bool
	ResourceID        string
	TxID              string
	FencingToken      uint64
	CurrentHolderTxID string
	ExpiresAt         int64
	Error             string
}

type ReleaseResult struct {
	Success              bool
	ResourceID           string
	TxID                 string
	ReleasedFencingToken uint64
	Error                string
}

func (e *Engine) Acquire(ctx context.Context, resourceID, txID, workerID string, ttl time.Duration) AcquireResult {
	e.mu.Lock()
	latency := e.artificialLatency
	simFailure := e.isSimulatingFailure
	e.mu.Unlock()

	if latency > 0 {
		time.Sleep(latency)
	}

	if simFailure {
		return AcquireResult{
			Success:    false,
			ResourceID: resourceID,
			TxID:       txID,
			Error:      "REDIS_CONNECTION_REFUSED: Cluster connection pool exhausted / node unreachable",
		}
	}

	e.mu.Lock()
	defer e.mu.Unlock()

	now := time.Now().UnixMilli()
	ttlMs := int(ttl.Milliseconds())
	if ttlMs <= 0 {
		ttlMs = 5000
	}

	existingLock, exists := e.localLocks[resourceID]
	if exists {
		if existingLock.ExpiresAt > now {
			if existingLock.HolderTxID == txID {
				// Re-entrancy / renewal
				existingLock.ExpiresAt = now + int64(ttlMs)
				e.rescheduleExpiration(resourceID, time.Duration(ttlMs)*time.Millisecond)
				return AcquireResult{
					Success:      true,
					ResourceID:   resourceID,
					TxID:         txID,
					FencingToken: existingLock.FencingToken,
					ExpiresAt:    existingLock.ExpiresAt,
				}
			}
			return AcquireResult{
				Success:           false,
				ResourceID:        resourceID,
				TxID:              txID,
				CurrentHolderTxID: existingLock.HolderTxID,
				ExpiresAt:         existingLock.ExpiresAt,
			}
		}
		// Expired
		e.evictExpired(resourceID)
	}

	// Try real Upstash command if available
	if e.isUpstashConnected && e.client != nil {
		rKey := "deadlockiq:lock:" + resourceID
		acquired, err := e.client.SetNX(ctx, rKey, txID, ttl).Result()
		if err != nil {
			fmt.Printf("[Redis Upstash] Acquire error: %v\n", err)
		} else if !acquired {
			currentHolder, _ := e.client.Get(ctx, rKey).Result()
			return AcquireResult{
				Success:           false,
				ResourceID:        resourceID,
				TxID:              txID,
				CurrentHolderTxID: currentHolder,
			}
		}
	}

	// Issue monotonic fencing token
	fToken := e.fencing.IssueToken(resourceID, txID)
	lockRec := &types.LockRecord{
		ResourceID:     resourceID,
		HolderTxID:     txID,
		HolderWorkerID: workerID,
		FencingToken:   fToken,
		AcquiredAt:     now,
		ExpiresAt:      now + int64(ttlMs),
		TTLMs:          ttlMs,
		WaitingTxIDs:   make([]string, 0),
	}

	e.localLocks[resourceID] = lockRec
	e.rescheduleExpiration(resourceID, time.Duration(ttlMs)*time.Millisecond)

	return AcquireResult{
		Success:      true,
		ResourceID:   resourceID,
		TxID:         txID,
		FencingToken: fToken,
		ExpiresAt:    lockRec.ExpiresAt,
	}
}

func (e *Engine) Release(ctx context.Context, resourceID, txID string, providedFencingToken *uint64) ReleaseResult {
	e.mu.Lock()
	latency := e.artificialLatency
	simFailure := e.isSimulatingFailure
	e.mu.Unlock()

	if latency > 0 {
		time.Sleep(latency)
	}

	if simFailure {
		return ReleaseResult{
			Success:    false,
			ResourceID: resourceID,
			TxID:       txID,
			Error:      "REDIS_CONNECTION_REFUSED: Cannot execute lock release script",
		}
	}

	e.mu.Lock()
	defer e.mu.Unlock()

	currentLock, exists := e.localLocks[resourceID]
	if !exists {
		return ReleaseResult{
			Success:    false,
			ResourceID: resourceID,
			TxID:       txID,
			Error:      fmt.Sprintf("LOCK_NOT_FOUND: No active lease for resource %s", resourceID),
		}
	}

	if currentLock.HolderTxID != txID {
		return ReleaseResult{
			Success:    false,
			ResourceID: resourceID,
			TxID:       txID,
			Error:      fmt.Sprintf("OWNERSHIP_VIOLATION: Lock held by %s, cannot be released by %s", currentLock.HolderTxID, txID),
		}
	}

	if providedFencingToken != nil && *providedFencingToken != currentLock.FencingToken {
		return ReleaseResult{
			Success:    false,
			ResourceID: resourceID,
			TxID:       txID,
			Error:      fmt.Sprintf("FENCING_MISMATCH: Lock fencing token is %d, but provided %d", currentLock.FencingToken, *providedFencingToken),
		}
	}

	// Release in Upstash with Lua script
	if e.isUpstashConnected && e.client != nil {
		rKey := "deadlockiq:lock:" + resourceID
		_ = e.client.Eval(ctx, releaseScript, []string{rKey}, txID).Err()
	}

	if timer, ok := e.expirationTimers[resourceID]; ok {
		timer.Stop()
		delete(e.expirationTimers, resourceID)
	}
	delete(e.localLocks, resourceID)

	return ReleaseResult{
		Success:              true,
		ResourceID:           resourceID,
		TxID:                 txID,
		ReleasedFencingToken: currentLock.FencingToken,
	}
}

func (e *Engine) GetAllLocks() []types.LockRecord {
	e.mu.Lock()
	defer e.mu.Unlock()

	now := time.Now().UnixMilli()
	res := make([]types.LockRecord, 0, len(e.localLocks))
	for rID, lock := range e.localLocks {
		if lock.ExpiresAt <= now {
			e.evictExpired(rID)
		} else {
			res = append(res, *lock)
		}
	}
	return res
}

func (e *Engine) rescheduleExpiration(resourceID string, d time.Duration) {
	if timer, ok := e.expirationTimers[resourceID]; ok {
		timer.Stop()
	}
	e.expirationTimers[resourceID] = time.AfterFunc(d, func() {
		e.mu.Lock()
		defer e.mu.Unlock()
		e.evictExpired(resourceID)
	})
}

func (e *Engine) evictExpired(resourceID string) {
	lock, exists := e.localLocks[resourceID]
	if timer, ok := e.expirationTimers[resourceID]; ok {
		timer.Stop()
		delete(e.expirationTimers, resourceID)
	}
	if exists {
		delete(e.localLocks, resourceID)
		if e.onLockExpired != nil {
			go e.onLockExpired(*lock)
		}
	}
}

func (e *Engine) Reset() {
	e.mu.Lock()
	defer e.mu.Unlock()

	for _, timer := range e.expirationTimers {
		timer.Stop()
	}
	e.expirationTimers = make(map[string]*time.Timer)
	e.localLocks = make(map[string]*types.LockRecord)
	e.isSimulatingFailure = false
	e.artificialLatency = 0
}
