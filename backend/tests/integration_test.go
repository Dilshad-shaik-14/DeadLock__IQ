package tests

import (
	"context"
	"testing"
	"time"

	"github.com/deadlockiq/engine/internal/coordinator"
	"github.com/deadlockiq/engine/internal/fencing"
	"github.com/deadlockiq/engine/internal/graph"
	"github.com/deadlockiq/engine/internal/recovery"
	"github.com/deadlockiq/engine/internal/redisengine"
	"github.com/deadlockiq/engine/internal/transaction"
	"github.com/deadlockiq/engine/internal/types"
)

func TestVictimSelectionExplainability(t *testing.T) {
	txA := types.Transaction{
		ID:            "tx_high_priority",
		Priority:      3,
		LocksHeld:     []string{"res1", "res2"},
		WorkDoneUnits: 50,
		RollbackCost:  5,
		RetryCount:    1,
		CreatedAt:     time.Now().UnixMilli() - 5000,
	}
	txB := types.Transaction{
		ID:            "tx_cheap_victim",
		Priority:      1,
		LocksHeld:     []string{"res3"},
		WorkDoneUnits: 5,
		RollbackCost:  1,
		RetryCount:    0,
		CreatedAt:     time.Now().UnixMilli(),
	}

	result := recovery.SelectVictim([]types.Transaction{txA, txB})
	if result.VictimTxID != "tx_cheap_victim" {
		t.Fatalf("Expected tx_cheap_victim to be chosen as victim, got %s", result.VictimTxID)
	}
	if result.Explanation == "" {
		t.Fatalf("Expected non-empty explainability text")
	}
}

func TestRedisLockOwnershipAndTTL(t *testing.T) {
	fencingMgr := fencing.NewTokenManager()
	engine := redisengine.NewEngine(fencingMgr, nil)
	ctx := context.Background()

	// Acquire lock on resource_alpha by worker_1
	acq1 := engine.Acquire(ctx, "resource_alpha", "tx_1", "worker_1", 2000*time.Millisecond)
	if !acq1.Success {
		t.Fatalf("Expected successful initial acquisition")
	}

	// Another worker attempts to acquire same resource -> fails
	acq2 := engine.Acquire(ctx, "resource_alpha", "tx_2", "worker_2", 2000*time.Millisecond)
	if acq2.Success {
		t.Fatalf("Expected lock acquisition to be rejected when held by tx_1")
	}

	// Another worker attempts to release -> ownership violation
	relBad := engine.Release(ctx, "resource_alpha", "tx_2", nil)
	if relBad.Success {
		t.Fatalf("Expected ownership violation error when tx_2 attempts to release tx_1's lock")
	}

	// Owner releases -> succeeds
	relGood := engine.Release(ctx, "resource_alpha", "tx_1", nil)
	if !relGood.Success {
		t.Fatalf("Expected owner release to succeed")
	}
}

func TestCoordinatorDeadlockResolutionPipeline(t *testing.T) {
	fencingMgr := fencing.NewTokenManager()
	redisEng := redisengine.NewEngine(fencingMgr, nil)
	txMgr := transaction.NewManager()
	wfg := graph.NewWaitForGraph()
	recEng := recovery.NewEngine(nil, nil)

	deadlockDetected := false
	coord := coordinator.NewCoordinator(txMgr, redisEng, wfg, recEng, fencingMgr, func(eventType, resourceID, txID string, details interface{}) {
		if eventType == "DEADLOCK_DETECTED" {
			deadlockDetected = true
		}
	})

	ctx := context.Background()

	t1 := txMgr.CreateTransaction(transaction.CreateTxParams{ID: "t1", WorkerID: "w1", Priority: 2})
	t2 := txMgr.CreateTransaction(transaction.CreateTxParams{ID: "t2", WorkerID: "w2", Priority: 1})

	coord.AcquireLock(ctx, "res_A", t1.ID, t1.WorkerID, 5000)
	coord.AcquireLock(ctx, "res_B", t2.ID, t2.WorkerID, 5000)

	coord.AcquireLock(ctx, "res_B", t1.ID, t1.WorkerID, 5000)
	res := coord.AcquireLock(ctx, "res_A", t2.ID, t2.WorkerID, 5000)

	if !res.DeadlockDetected || res.Incident == nil {
		t.Fatalf("Expected deadlock detection on circular wait")
	}

	if !deadlockDetected {
		t.Fatalf("Expected DEADLOCK_DETECTED event to be emitted")
	}
}
