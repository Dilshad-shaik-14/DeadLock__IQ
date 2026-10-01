package coordinator

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/deadlockiq/engine/internal/fencing"
	"github.com/deadlockiq/engine/internal/graph"
	"github.com/deadlockiq/engine/internal/recovery"
	"github.com/deadlockiq/engine/internal/redisengine"
	"github.com/deadlockiq/engine/internal/transaction"
	"github.com/deadlockiq/engine/internal/types"
)

type LockEventCallback func(eventType, resourceID, txID string, details interface{})

type Coordinator struct {
	mu          sync.Mutex
	txMgr       *transaction.Manager
	redisEng    *redisengine.Engine
	wfg         *graph.WaitForGraph
	recoveryEng *recovery.Engine
	fencing     *fencing.TokenManager
	onLockEvent LockEventCallback
	AutoResolve bool
}

func NewCoordinator(
	txMgr *transaction.Manager,
	redisEng *redisengine.Engine,
	wfg *graph.WaitForGraph,
	recEng *recovery.Engine,
	fencingMgr *fencing.TokenManager,
	onEvent LockEventCallback,
) *Coordinator {
	return &Coordinator{
		txMgr:       txMgr,
		redisEng:    redisEng,
		wfg:         wfg,
		recoveryEng: recEng,
		fencing:     fencingMgr,
		onLockEvent: onEvent,
		AutoResolve: false,
	}
}

type AcquireResponse struct {
	Success          bool                    `json:"success"`
	ResourceID       string                  `json:"resourceId"`
	TxID             string                  `json:"txId"`
	FencingToken     *uint64                 `json:"fencingToken,omitempty"`
	Waiting          bool                    `json:"waiting,omitempty"`
	HolderTxID       string                  `json:"holderTxId,omitempty"`
	DeadlockDetected bool                    `json:"deadlockDetected,omitempty"`
	Incident         *types.DeadlockIncident `json:"incident,omitempty"`
	Error            string                  `json:"error,omitempty"`
}

func (c *Coordinator) AcquireLock(ctx context.Context, resourceID, txID, workerID string, ttlMs int) AcquireResponse {
	tx, exists := c.txMgr.GetTransaction(txID)
	if !exists {
		return AcquireResponse{
			Success:    false,
			ResourceID: resourceID,
			TxID:       txID,
			Error:      fmt.Sprintf("Transaction %s not found", txID),
		}
	}

	c.wfg.RegisterTransaction(
		txID,
		workerID,
		tx.State,
		tx.Priority,
		tx.EffectivePriority,
		tx.FencingToken,
	)

	if c.onLockEvent != nil {
		c.onLockEvent("LOCK_REQUESTED", resourceID, txID, nil)
	}

	ttl := time.Duration(ttlMs) * time.Millisecond
	if ttlMs <= 0 {
		ttl = 6000 * time.Millisecond
	}

	acq := c.redisEng.Acquire(ctx, resourceID, txID, workerID, ttl)

	if acq.Success {
		c.txMgr.AddLockHeld(txID, resourceID)
		c.wfg.RecordLockAcquired(resourceID, txID)

		if tx.State == types.TxCreated || tx.State == types.TxWaiting || tx.State == types.TxRetrying {
			_, _ = c.txMgr.TransitionState(txID, types.TxAcquired, fmt.Sprintf("Acquired lock on %s", resourceID))
		}

		if c.onLockEvent != nil {
			c.onLockEvent("LOCK_ACQUIRED", resourceID, txID, map[string]interface{}{
				"fencingToken": acq.FencingToken,
			})
		}

		return AcquireResponse{
			Success:      true,
			ResourceID:   resourceID,
			TxID:         txID,
			FencingToken: &acq.FencingToken,
		}
	}

	holderTxID := acq.CurrentHolderTxID
	if holderTxID != "" {
		c.txMgr.SetWaitingFor(txID, resourceID)
		if tx.State != types.TxWaiting {
			_, _ = c.txMgr.TransitionState(txID, types.TxWaiting, fmt.Sprintf("Waiting for resource %s held by %s", resourceID, holderTxID))
		}

		if c.onLockEvent != nil {
			c.onLockEvent("LOCK_WAITING", resourceID, txID, map[string]interface{}{
				"holderTxId": holderTxID,
			})
		}

		// Incremental cycle detection
		cycleRes := c.wfg.RecordLockWaiting(txID, resourceID, holderTxID)

		if cycleRes.HasCycle {
			incident := c.handleDeadlock(ctx, cycleRes)

			if c.onLockEvent != nil {
				c.onLockEvent("DEADLOCK_DETECTED", resourceID, txID, incident)
			}

			return AcquireResponse{
				Success:          false,
				ResourceID:       resourceID,
				TxID:             txID,
				DeadlockDetected: true,
				Incident:         incident,
			}
		}

		return AcquireResponse{
			Success:    false,
			ResourceID: resourceID,
			TxID:       txID,
			Waiting:    true,
			HolderTxID: holderTxID,
		}
	}

	return AcquireResponse{
		Success:    false,
		ResourceID: resourceID,
		TxID:       txID,
		Error:      acq.Error,
	}
}

func (c *Coordinator) ReleaseLock(ctx context.Context, resourceID, txID string, providedFencingToken *uint64) redisengine.ReleaseResult {
	rel := c.redisEng.Release(ctx, resourceID, txID, providedFencingToken)

	if rel.Success {
		c.txMgr.RemoveLockHeld(txID, resourceID)
		c.wfg.RecordLockReleased(resourceID, txID)

		if c.onLockEvent != nil {
			c.onLockEvent("LOCK_RELEASED", resourceID, txID, map[string]interface{}{
				"releasedFencingToken": rel.ReleasedFencingToken,
			})
		}
	}

	return rel
}

func (c *Coordinator) handleDeadlock(ctx context.Context, cycleRes graph.CycleDetectionResult) *types.DeadlockIncident {
	cycleTxs := make([]types.Transaction, 0, len(cycleRes.CycleTxIDs))
	for _, txID := range cycleRes.CycleTxIDs {
		if tx, exists := c.txMgr.GetTransaction(txID); exists {
			cycleTxs = append(cycleTxs, tx)
			_, _ = c.txMgr.TransitionState(txID, types.TxDeadlockDetected, "Deadlock cycle detected")
		}
	}

	victimRes := recovery.SelectVictim(cycleTxs)
	victimTxID := victimRes.VictimTxID
	latencyMs := float64(cycleRes.Latency.Microseconds()) / 1000.0

	incident := c.recoveryEng.CreateIncident(
		cycleRes.CycleTxIDs,
		cycleRes.CyclePath,
		cycleRes.ResourcesInvolved,
		latencyMs,
		victimRes,
	)

	for _, tx := range cycleTxs {
		if tx.ID == victimTxID {
			_, _ = c.txMgr.TransitionState(tx.ID, types.TxVictimSelected, "Chosen as deadlock victim")
		} else if tx.State == types.TxDeadlockDetected {
			_, _ = c.txMgr.TransitionState(tx.ID, types.TxWaiting, fmt.Sprintf("Waiting for deadlock resolution (victim: %s)", victimTxID))
		}
	}

	// If AutoResolve is configured, resolve after a short visible delay (1500ms)
	if c.AutoResolve {
		go func() {
			time.Sleep(1500 * time.Millisecond)
			_, _ = c.ResolveDeadlock(context.Background(), incident.ID)
		}()
	}

	return incident
}

func (c *Coordinator) ResolveDeadlock(ctx context.Context, incidentID string) (*types.DeadlockIncident, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	inc, exists := c.recoveryEng.GetIncident(incidentID)
	if !exists {
		// Try latest incident if id is "latest" or empty
		all := c.recoveryEng.GetAllIncidents()
		if len(all) > 0 {
			inc = all[0]
			exists = true
		} else {
			return nil, fmt.Errorf("incident %s not found", incidentID)
		}
	}

	if inc.Status == "RESOLVED" {
		return &inc, nil
	}

	victimTxID := inc.VictimID
	if victimTxID == "" && len(inc.CycleTxIDs) > 0 {
		victimTxID = inc.CycleTxIDs[0]
	}

	// 1. Rollback Started
	c.recoveryEng.AddTimelineStep(inc.ID, "ROLLBACK_STARTED", fmt.Sprintf("Initiating abort and compensating transactions for victim %s", victimTxID))
	_, _ = c.txMgr.TransitionState(victimTxID, types.TxAborting, "Compensating transactions in progress")

	victimTx, _ := c.txMgr.GetTransaction(victimTxID)
	heldLocks := make([]string, 0)
	if victimTx.ID != "" {
		heldLocks = append(heldLocks, victimTx.LocksHeld...)
	}

	// 2. Release Locks Held by Victim
	for _, rID := range heldLocks {
		c.redisEng.Release(ctx, rID, victimTxID, nil)
		c.wfg.RecordLockReleased(rID, victimTxID)
		c.txMgr.RemoveLockHeld(victimTxID, rID)
	}

	if victimTx.WaitingForLock != "" {
		c.wfg.RecordLockReleased(victimTx.WaitingForLock, victimTxID)
		c.txMgr.SetWaitingFor(victimTxID, "")
	}

	_, _ = c.txMgr.TransitionState(victimTxID, types.TxRolledBack, "Locks released and state compensated")
	c.recoveryEng.AddTimelineStep(inc.ID, "LOCKS_RELEASED", fmt.Sprintf("Released %d locks. Wait-For Graph cycle severed.", len(heldLocks)))

	// 3. Sever cycle in Wait-For Graph
	c.wfg.SeverCycle(victimTxID)

	// 4. Unblock remaining transactions in the cycle
	for _, otherTxID := range inc.CycleTxIDs {
		if otherTxID == victimTxID {
			continue
		}
		otherTx, ok := c.txMgr.GetTransaction(otherTxID)
		if !ok {
			continue
		}

		waitingRes := otherTx.WaitingForLock
		if waitingRes != "" {
			acq := c.redisEng.Acquire(ctx, waitingRes, otherTxID, otherTx.WorkerID, 6000*time.Millisecond)
			if acq.Success {
				c.txMgr.AddLockHeld(otherTxID, waitingRes)
				c.wfg.RecordLockAcquired(waitingRes, otherTxID)
				c.txMgr.SetWaitingFor(otherTxID, "")
				_, _ = c.txMgr.TransitionState(otherTxID, types.TxAcquired, fmt.Sprintf("Acquired contested resource %s", waitingRes))
			}
		}

		// Progress transaction to completion and clean release
		go func(t types.Transaction) {
			time.Sleep(100 * time.Millisecond)
			_, _ = c.txMgr.TransitionState(t.ID, types.TxRunning, "Executing business logic")
			time.Sleep(100 * time.Millisecond)
			_, _ = c.txMgr.TransitionState(t.ID, types.TxCommitting, "Committing transaction changes")
			time.Sleep(50 * time.Millisecond)

			current, _ := c.txMgr.GetTransaction(t.ID)
			for _, rID := range current.LocksHeld {
				c.redisEng.Release(context.Background(), rID, t.ID, nil)
				c.wfg.RecordLockReleased(rID, t.ID)
			}
			c.txMgr.ClearAllLocks(t.ID)
			_, _ = c.txMgr.TransitionState(t.ID, types.TxCompleted, "Transaction committed and all locks released")
		}(otherTx)
	}

	// 5. Schedule retry for victim with exponential backoff & jitter
	retryNum := c.txMgr.IncrementRetry(victimTxID)
	backoffDelay := c.recoveryEng.CalculateBackoff(retryNum)

	_, _ = c.txMgr.TransitionState(victimTxID, types.TxBackoff, fmt.Sprintf("Backing off for %v (attempt #%d)", backoffDelay, retryNum))
	c.recoveryEng.AddTimelineStep(inc.ID, "BACKOFF_SCHEDULED", fmt.Sprintf("Retry #%d scheduled in %v (exponential backoff + jitter)", retryNum, backoffDelay))

	c.recoveryEng.AddTimelineStep(inc.ID, "RETRY_STARTED", fmt.Sprintf("Executing retry #%d for transaction %s", retryNum, victimTxID))
	_, _ = c.txMgr.TransitionState(victimTxID, types.TxRetrying, fmt.Sprintf("Retry attempt #%d", retryNum))

	// Execute retry completion
	go func() {
		time.Sleep(300 * time.Millisecond)
		_, _ = c.txMgr.TransitionState(victimTxID, types.TxAcquired, "Re-acquired required resources on retry")
		time.Sleep(100 * time.Millisecond)
		_, _ = c.txMgr.TransitionState(victimTxID, types.TxCommitting, "Committing changes")
		time.Sleep(50 * time.Millisecond)

		c.txMgr.ClearAllLocks(victimTxID)
		_, _ = c.txMgr.TransitionState(victimTxID, types.TxCompleted, "Transaction recovered and committed successfully")
		c.recoveryEng.AddTimelineStep(inc.ID, "RECOVERED", fmt.Sprintf("Transaction %s committed successfully. Concurrency restored.", victimTxID))
	}()

	latestInc, _ := c.recoveryEng.GetIncident(inc.ID)
	return &latestInc, nil
}
