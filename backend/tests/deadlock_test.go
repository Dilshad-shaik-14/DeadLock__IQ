package tests

import (
	"testing"
	"github.com/deadlockiq/engine/internal/fencing"
	"github.com/deadlockiq/engine/internal/graph"
)

func TestTwoWayDeadlockIncrementalDetection(t *testing.T) {
	wfg := graph.NewWaitForGraph()

	// Tx1 holds ResA
	wfg.RecordLockAcquired("ResA", "Tx1")
	// Tx2 holds ResB
	wfg.RecordLockAcquired("ResB", "Tx2")

	// Tx1 requests ResB (waits for Tx2) -> No cycle yet
	res1 := wfg.RecordLockWaiting("Tx1", "ResB", "Tx2")
	if res1.HasCycle {
		t.Fatalf("Expected no cycle when Tx1 waits for Tx2")
	}

	// Tx2 requests ResA (waits for Tx1) -> CYCLE DETECTED!
	res2 := wfg.RecordLockWaiting("Tx2", "ResA", "Tx1")
	if !res2.HasCycle {
		t.Fatalf("Expected cycle detection when Tx2 waits for Tx1")
	}

	if len(res2.CycleTxIDs) < 2 {
		t.Fatalf("Expected at least 2 transactions in cycle, got %d", len(res2.CycleTxIDs))
	}
}

func TestFencingTokenStaleWorkerProtection(t *testing.T) {
	mgr := fencing.NewTokenManager()

	token1 := mgr.IssueToken("ResA", "Tx1")
	token2 := mgr.IssueToken("ResA", "Tx2")

	if token2 <= token1 {
		t.Fatalf("Tokens must be monotonically strictly increasing: token1=%d, token2=%d", token1, token2)
	}

	// Stale worker Tx1 validates old token
	valid1, err1 := mgr.ValidateToken("ResA", token1)
	if valid1 {
		t.Fatalf("Expected stale token %d to be rejected for ResA, but was marked valid", token1)
	}
	if err1 == "" {
		t.Fatalf("Expected rejection error message for stale token")
	}

	// Current worker Tx2 validates new token
	valid2, _ := mgr.ValidateToken("ResA", token2)
	if !valid2 {
		t.Fatalf("Expected current token %d to be valid", token2)
	}
}
