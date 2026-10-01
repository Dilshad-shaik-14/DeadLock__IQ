package fencing

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// TokenRecord stores issued fencing token details
type TokenRecord struct {
	ResourceID string    `json:"resourceId"`
	Token      uint64    `json:"token"`
	TxID       string    `json:"txId"`
	IssuedAt   time.Time `json:"issuedAt"`
}

// TokenManager issues monotonically increasing fencing tokens
type TokenManager struct {
	mu            sync.RWMutex
	globalSeq     uint64
	latestTokens  map[string]uint64
	history       []TokenRecord
	violationCount uint64
}

// NewTokenManager initializes a new fencing token manager
func NewTokenManager() *TokenManager {
	return &TokenManager{
		globalSeq:    1000,
		latestTokens: make(map[string]uint64),
		history:      make([]TokenRecord, 0),
	}
}

// IssueToken increments the sequence atomically and sets the resource token
func (m *TokenManager) IssueToken(resourceID, txID string) uint64 {
	token := atomic.AddUint64(&m.globalSeq, 1)

	m.mu.Lock()
	defer m.mu.Unlock()

	m.latestTokens[resourceID] = token
	m.history = append(m.history, TokenRecord{
		ResourceID: resourceID,
		Token:      token,
		TxID:       txID,
		IssuedAt:   time.Now(),
	})

	if len(m.history) > 100 {
		m.history = m.history[1:]
	}

	return token
}

// ValidateToken verifies whether a provided token is still valid
func (m *TokenManager) ValidateToken(resourceID string, providedToken uint64) (bool, string) {
	m.mu.RLock()
	latest, exists := m.latestTokens[resourceID]
	m.mu.RUnlock()

	if !exists {
		return providedToken > 0, ""
	}

	if providedToken < latest {
		atomic.AddUint64(&m.violationCount, 1)
		return false, fmt.Sprintf("STALE_WORKER_REJECTED: Token %d is older than current resource token %d", providedToken, latest)
	}

	return true, ""
}

// GetViolationCount returns total rejected stale writes
func (m *TokenManager) GetViolationCount() uint64 {
	return atomic.LoadUint64(&m.violationCount)
}
