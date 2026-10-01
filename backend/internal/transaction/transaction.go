package transaction

import (
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/deadlockiq/engine/internal/types"
)

var validTransitions = map[types.TxState]map[types.TxState]bool{
	types.TxCreated: {
		types.TxWaiting:  true,
		types.TxAcquired: true,
		types.TxRunning:  true,
		types.TxFailed:   true,
	},
	types.TxWaiting: {
		types.TxAcquired:         true,
		types.TxDeadlockDetected: true,
		types.TxVictimSelected:   true,
		types.TxAborting:         true,
		types.TxFailed:           true,
	},
	types.TxAcquired: {
		types.TxRunning:          true,
		types.TxCommitting:       true,
		types.TxWaiting:          true,
		types.TxDeadlockDetected: true,
		types.TxFailed:           true,
	},
	types.TxRunning: {
		types.TxWaiting:          true,
		types.TxCommitting:       true,
		types.TxDeadlockDetected: true,
		types.TxAborting:         true,
		types.TxFailed:           true,
	},
	types.TxCommitting: {
		types.TxCompleted: true,
		types.TxFailed:    true,
	},
	types.TxCompleted: {},
	types.TxDeadlockDetected: {
		types.TxVictimSelected: true,
		types.TxWaiting:        true,
		types.TxAcquired:       true,
		types.TxAborting:       true,
		types.TxFailed:         true,
	},
	types.TxVictimSelected: {
		types.TxAborting: true,
		types.TxFailed:   true,
	},
	types.TxAborting: {
		types.TxRolledBack: true,
		types.TxFailed:     true,
	},
	types.TxRolledBack: {
		types.TxBackoff:  true,
		types.TxFailed:   true,
		types.TxRetrying: true,
	},
	types.TxBackoff: {
		types.TxRetrying: true,
		types.TxFailed:   true,
	},
	types.TxRetrying: {
		types.TxWaiting:  true,
		types.TxAcquired: true,
		types.TxRunning:  true,
		types.TxFailed:   true,
	},
	types.TxFailed: {},
}

type StateChangeCallback func(tx types.Transaction, oldState, newState types.TxState)

type Manager struct {
	mu             sync.RWMutex
	transactions   map[string]*types.Transaction
	onStateChange  StateChangeCallback
}

func NewManager() *Manager {
	return &Manager{
		transactions: make(map[string]*types.Transaction),
	}
}

func (m *Manager) SetOnStateChange(cb StateChangeCallback) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onStateChange = cb
}

type CreateTxParams struct {
	ID            string
	WorkerID      string
	Priority      int
	MaxRetries    int
	WorkDoneUnits int
	RollbackCost  int
}

func (m *Manager) CreateTransaction(params CreateTxParams) types.Transaction {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now().UnixMilli()
	p := params.Priority
	if p <= 0 {
		p = 1
	}
	maxRetries := params.MaxRetries
	if maxRetries <= 0 {
		maxRetries = 3
	}
	rbCost := params.RollbackCost
	if rbCost <= 0 {
		rbCost = 1
	}

	tx := &types.Transaction{
		ID:                params.ID,
		WorkerID:          params.WorkerID,
		Priority:          p,
		EffectivePriority: float64(p),
		State:             types.TxCreated,
		LocksHeld:         make([]string, 0),
		WorkDoneUnits:     params.WorkDoneUnits,
		RollbackCost:      rbCost,
		RetryCount:        0,
		MaxRetries:        maxRetries,
		CreatedAt:         now,
		UpdatedAt:         now,
		History: []types.TxHistoryEntry{
			{State: types.TxCreated, Timestamp: now},
		},
	}

	m.transactions[tx.ID] = tx
	return *tx
}

func (m *Manager) GetTransaction(txID string) (types.Transaction, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	tx, exists := m.transactions[txID]
	if !exists {
		return types.Transaction{}, false
	}
	return m.refreshEffectivePriority(tx), true
}

func (m *Manager) GetAllTransactions() []types.Transaction {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make([]types.Transaction, 0, len(m.transactions))
	for _, tx := range m.transactions {
		result = append(result, m.refreshEffectivePriority(tx))
	}
	return result
}

func (m *Manager) GetActiveTransactions() []types.Transaction {
	all := m.GetAllTransactions()
	active := make([]types.Transaction, 0, len(all))
	for _, tx := range all {
		if tx.State != types.TxCompleted && tx.State != types.TxFailed {
			active = append(active, tx)
		}
	}
	return active
}

func (m *Manager) TransitionState(txID string, newState types.TxState, reason string) (types.Transaction, error) {
	m.mu.Lock()
	tx, exists := m.transactions[txID]
	if !exists {
		m.mu.Unlock()
		return types.Transaction{}, fmt.Errorf("transaction [%s] not found", txID)
	}

	oldState := tx.State
	if oldState == newState {
		copied := m.refreshEffectivePriority(tx)
		m.mu.Unlock()
		return copied, nil
	}

	allowed, ok := validTransitions[oldState]
	if !ok || !allowed[newState] {
		m.mu.Unlock()
		return types.Transaction{}, fmt.Errorf("INVALID_STATE_TRANSITION: Cannot transition [%s] from %s to %s", txID, oldState, newState)
	}

	now := time.Now().UnixMilli()
	tx.State = newState
	tx.UpdatedAt = now
	tx.History = append(tx.History, types.TxHistoryEntry{
		State:     newState,
		Timestamp: now,
		Reason:    reason,
	})

	copied := m.refreshEffectivePriority(tx)
	cb := m.onStateChange
	m.mu.Unlock()

	if cb != nil {
		cb(copied, oldState, newState)
	}

	return copied, nil
}

func (m *Manager) AddLockHeld(txID, resourceID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if tx, exists := m.transactions[txID]; exists {
		for _, l := range tx.LocksHeld {
			if l == resourceID {
				return
			}
		}
		tx.LocksHeld = append(tx.LocksHeld, resourceID)
		tx.UpdatedAt = time.Now().UnixMilli()
	}
}

func (m *Manager) RemoveLockHeld(txID, resourceID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if tx, exists := m.transactions[txID]; exists {
		filtered := make([]string, 0, len(tx.LocksHeld))
		for _, l := range tx.LocksHeld {
			if l != resourceID {
				filtered = append(filtered, l)
			}
		}
		tx.LocksHeld = filtered
		tx.UpdatedAt = time.Now().UnixMilli()
	}
}

func (m *Manager) ClearAllLocks(txID string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()

	tx, exists := m.transactions[txID]
	if !exists {
		return nil
	}
	released := make([]string, len(tx.LocksHeld))
	copy(released, tx.LocksHeld)
	tx.LocksHeld = make([]string, 0)
	tx.WaitingForLock = ""
	tx.UpdatedAt = time.Now().UnixMilli()
	return released
}

func (m *Manager) SetWaitingFor(txID, resourceID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if tx, exists := m.transactions[txID]; exists {
		tx.WaitingForLock = resourceID
		tx.UpdatedAt = time.Now().UnixMilli()
	}
}

func (m *Manager) IncrementRetry(txID string) int {
	m.mu.Lock()
	defer m.mu.Unlock()

	if tx, exists := m.transactions[txID]; exists {
		tx.RetryCount++
		tx.UpdatedAt = time.Now().UnixMilli()
		return tx.RetryCount
	}
	return 0
}

func (m *Manager) refreshEffectivePriority(tx *types.Transaction) types.Transaction {
	elapsed := time.Now().UnixMilli() - tx.CreatedAt
	agingBonus := math.Min(10.0, math.Floor(float64(elapsed)/1200.0))
	tx.EffectivePriority = float64(tx.Priority) + agingBonus

	copied := *tx
	copied.LocksHeld = append([]string(nil), tx.LocksHeld...)
	copied.History = append([]types.TxHistoryEntry(nil), tx.History...)
	return copied
}

func (m *Manager) Reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.transactions = make(map[string]*types.Transaction)
}
