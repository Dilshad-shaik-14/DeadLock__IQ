package simulator

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/deadlockiq/engine/internal/coordinator"
	"github.com/deadlockiq/engine/internal/fencing"
	"github.com/deadlockiq/engine/internal/graph"
	"github.com/deadlockiq/engine/internal/metrics"
	"github.com/deadlockiq/engine/internal/postgres"
	"github.com/deadlockiq/engine/internal/recovery"
	"github.com/deadlockiq/engine/internal/redisengine"
	"github.com/deadlockiq/engine/internal/transaction"
	"github.com/deadlockiq/engine/internal/types"
)

type LogEmitter func(message, level string)

type Simulator struct {
	mu             sync.Mutex
	isRunning      bool
	activeScenario string
	coordinator    *coordinator.Coordinator
	txMgr          *transaction.Manager
	redisEng       *redisengine.Engine
	wfg            *graph.WaitForGraph
	recoveryEng    *recovery.Engine
	fencing        *fencing.TokenManager
	pgMonitor      *postgres.Monitor
	metricsMgr     *metrics.Manager
	logEmitter     LogEmitter
}

func NewSimulator(
	coord *coordinator.Coordinator,
	txMgr *transaction.Manager,
	redisEng *redisengine.Engine,
	wfg *graph.WaitForGraph,
	recoveryEng *recovery.Engine,
	fencing *fencing.TokenManager,
	pgMonitor *postgres.Monitor,
	metricsMgr *metrics.Manager,
	emitter LogEmitter,
) *Simulator {
	return &Simulator{
		coordinator: coord,
		txMgr:       txMgr,
		redisEng:    redisEng,
		wfg:         wfg,
		recoveryEng: recoveryEng,
		fencing:     fencing,
		pgMonitor:   pgMonitor,
		metricsMgr:  metricsMgr,
		logEmitter:  emitter,
	}
}

func (s *Simulator) log(msg, level string) {
	if s.logEmitter != nil {
		s.logEmitter(msg, level)
	}
}

type ScenarioResult struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

func (s *Simulator) RunScenario(ctx context.Context, scenario string) ScenarioResult {
	s.mu.Lock()
	if s.isRunning {
		active := s.activeScenario
		s.mu.Unlock()
		return ScenarioResult{
			Success: false,
			Message: fmt.Sprintf("Scenario %s is already executing", active),
		}
	}
	s.isRunning = true
	s.activeScenario = scenario
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.isRunning = false
		s.activeScenario = ""
		s.mu.Unlock()
	}()

	s.log(fmt.Sprintf("--- Starting Scenario: %s ---", scenario), "info")

	var err error
	switch scenario {
	case "TWO_WAY_DEADLOCK":
		err = s.runTwoWayDeadlock(ctx)
	case "THREE_WAY_DEADLOCK":
		err = s.runThreeWayDeadlock(ctx)
	case "N_WAY_DEADLOCK":
		err = s.runNWayDeadlock(ctx, 5)
	case "NORMAL_CONTENTION":
		err = s.runNormalContention(ctx)
	case "MULTIPLE_DEADLOCKS":
		err = s.runMultipleDeadlocks(ctx)
	case "STALE_WORKER", "FENCING_VIOLATION":
		err = s.runStaleWorker(ctx)
	case "RETRY_STORM":
		err = s.runRetryStorm(ctx)
	case "POSTGRES_DEADLOCK":
		err = s.runPostgresDeadlock(ctx)
	case "REDIS_FAILURE":
		err = s.runRedisFailure(ctx)
	case "WORKER_CRASH":
		err = s.runWorkerCrash(ctx)
	case "NETWORK_DELAY":
		err = s.runNetworkDelay(ctx)
	case "CROSS_SYSTEM_DEADLOCK":
		err = s.runCrossSystemDeadlock(ctx)
	default:
		err = fmt.Errorf("Unknown scenario: %s", scenario)
	}

	if err != nil {
		s.log(fmt.Sprintf("Scenario Error: %v", err), "error")
		return ScenarioResult{Success: false, Message: err.Error()}
	}

	s.log(fmt.Sprintf("--- Completed Scenario: %s ---", scenario), "success")
	return ScenarioResult{Success: true, Message: fmt.Sprintf("Scenario %s executed successfully", scenario)}
}

func (s *Simulator) runTwoWayDeadlock(ctx context.Context) error {
	s.log("Creating Tx1 (Worker-A, Priority 2) and Tx2 (Worker-B, Priority 1)...", "info")
	tx1 := s.txMgr.CreateTransaction(transaction.CreateTxParams{
		ID:            "tx_alpha",
		WorkerID:      "worker_alpha",
		Priority:      2,
		WorkDoneUnits: 45,
		RollbackCost:  3,
	})
	tx2 := s.txMgr.CreateTransaction(transaction.CreateTxParams{
		ID:            "tx_beta",
		WorkerID:      "worker_beta",
		Priority:      1,
		WorkDoneUnits: 10,
		RollbackCost:  1,
	})

	s.log("Tx1 acquires Resource orders_db_shard1...", "info")
	s.coordinator.AcquireLock(ctx, "orders_db_shard1", tx1.ID, tx1.WorkerID, 10000)
	s.metricsMgr.RecordOp()

	s.log("Tx2 acquires Resource inventory_cache_v2...", "info")
	s.coordinator.AcquireLock(ctx, "inventory_cache_v2", tx2.ID, tx2.WorkerID, 10000)
	s.metricsMgr.RecordOp()

	time.Sleep(600 * time.Millisecond)

	s.log("Tx1 requests inventory_cache_v2 (held by Tx2) -> WAITING...", "info")
	s.coordinator.AcquireLock(ctx, "inventory_cache_v2", tx1.ID, tx1.WorkerID, 10000)
	s.metricsMgr.RecordOp()

	time.Sleep(600 * time.Millisecond)

	s.log("Tx2 requests orders_db_shard1 (held by Tx1) -> TRIGGERING DEADLOCK CYCLE!", "info")
	res := s.coordinator.AcquireLock(ctx, "orders_db_shard1", tx2.ID, tx2.WorkerID, 10000)
	s.metricsMgr.RecordOp()

	if res.DeadlockDetected && res.Incident != nil {
		s.metricsMgr.RecordDeadlockDetected(res.Incident.DetectionLatencyMs)
		s.log(fmt.Sprintf("DEADLOCK DETECTED! Incident %s created in %.2fms", res.Incident.ID, res.Incident.DetectionLatencyMs), "warn")
		s.log(fmt.Sprintf("Victim Selection: %s", res.Incident.Explanation), "info")
	}
	return nil
}

func (s *Simulator) runThreeWayDeadlock(ctx context.Context) error {
	s.log("Initializing 3-worker transaction ring...", "info")
	tx1 := s.txMgr.CreateTransaction(transaction.CreateTxParams{ID: "tx_ring_1", WorkerID: "worker_1", Priority: 3})
	tx2 := s.txMgr.CreateTransaction(transaction.CreateTxParams{ID: "tx_ring_2", WorkerID: "worker_2", Priority: 2})
	tx3 := s.txMgr.CreateTransaction(transaction.CreateTxParams{ID: "tx_ring_3", WorkerID: "worker_3", Priority: 1})

	s.coordinator.AcquireLock(ctx, "res_gold", tx1.ID, tx1.WorkerID, 6000)
	s.coordinator.AcquireLock(ctx, "res_silver", tx2.ID, tx2.WorkerID, 6000)
	s.coordinator.AcquireLock(ctx, "res_bronze", tx3.ID, tx3.WorkerID, 6000)

	time.Sleep(400 * time.Millisecond)

	s.log("Tx1 requests res_silver...", "info")
	s.coordinator.AcquireLock(ctx, "res_silver", tx1.ID, tx1.WorkerID, 6000)

	s.log("Tx2 requests res_bronze...", "info")
	s.coordinator.AcquireLock(ctx, "res_bronze", tx2.ID, tx2.WorkerID, 6000)

	time.Sleep(400 * time.Millisecond)

	s.log("Tx3 requests res_gold -> 3-way circular wait completed!", "info")
	res := s.coordinator.AcquireLock(ctx, "res_gold", tx3.ID, tx3.WorkerID, 6000)

	if res.DeadlockDetected && res.Incident != nil {
		s.metricsMgr.RecordDeadlockDetected(res.Incident.DetectionLatencyMs)
		s.log(fmt.Sprintf("3-WAY DEADLOCK DETECTED! Incident %s", res.Incident.ID), "warn")
	}
	return nil
}

func (s *Simulator) runNWayDeadlock(ctx context.Context, n int) error {
	s.log(fmt.Sprintf("Creating %d-transaction circular wait ring...", n), "info")
	txs := make([]types.Transaction, n)
	resources := make([]string, n)

	for i := 0; i < n; i++ {
		txs[i] = s.txMgr.CreateTransaction(transaction.CreateTxParams{
			ID:       fmt.Sprintf("tx_n_%d", i+1),
			WorkerID: fmt.Sprintf("worker_n_%d", i+1),
			Priority: (i % 3) + 1,
		})
		resources[i] = fmt.Sprintf("res_cluster_slot_%d", i+1)
	}

	for i := 0; i < n; i++ {
		s.coordinator.AcquireLock(ctx, resources[i], txs[i].ID, txs[i].WorkerID, 6000)
		s.metricsMgr.RecordOp()
	}

	time.Sleep(400 * time.Millisecond)

	for i := 0; i < n; i++ {
		nextRes := resources[(i+1)%n]
		s.log(fmt.Sprintf("%s requesting %s...", txs[i].ID, nextRes), "info")
		res := s.coordinator.AcquireLock(ctx, nextRes, txs[i].ID, txs[i].WorkerID, 6000)
		s.metricsMgr.RecordOp()

		if res.DeadlockDetected && res.Incident != nil {
			s.metricsMgr.RecordDeadlockDetected(res.Incident.DetectionLatencyMs)
			s.log(fmt.Sprintf("N-WAY CYCLE CLOSED by %s! Incident: %s", txs[i].ID, res.Incident.ID), "warn")
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	return nil
}

func (s *Simulator) runNormalContention(ctx context.Context) error {
	s.log("Testing regular uncontended / queued lock behavior...", "info")
	txA := s.txMgr.CreateTransaction(transaction.CreateTxParams{ID: "tx_order_checkout", WorkerID: "w_checkout"})
	txB := s.txMgr.CreateTransaction(transaction.CreateTxParams{ID: "tx_order_refund", WorkerID: "w_refund"})

	s.log("tx_order_checkout acquires payment_gateway_lock...", "info")
	s.coordinator.AcquireLock(ctx, "payment_gateway_lock", txA.ID, txA.WorkerID, 6000)

	s.log("tx_order_refund attempts acquisition on same resource (queuing cleanly)...", "info")
	acqB := s.coordinator.AcquireLock(ctx, "payment_gateway_lock", txB.ID, txB.WorkerID, 6000)
	s.log(fmt.Sprintf("tx_order_refund status: waiting=%v (no cycle)", acqB.Waiting), "info")

	time.Sleep(600 * time.Millisecond)

	s.log("tx_order_checkout finishes work and releases lock...", "info")
	s.coordinator.ReleaseLock(ctx, "payment_gateway_lock", txA.ID, nil)
	_, _ = s.txMgr.TransitionState(txA.ID, types.TxCompleted, "Done")

	s.log("tx_order_refund now acquires released lock...", "info")
	s.coordinator.AcquireLock(ctx, "payment_gateway_lock", txB.ID, txB.WorkerID, 6000)
	time.Sleep(300 * time.Millisecond)
	s.coordinator.ReleaseLock(ctx, "payment_gateway_lock", txB.ID, nil)
	_, _ = s.txMgr.TransitionState(txB.ID, types.TxCompleted, "Done")
	s.log("Normal contention resolved with zero deadlocks!", "success")
	return nil
}

func (s *Simulator) runMultipleDeadlocks(ctx context.Context) error {
	s.log("Triggering two simultaneous independent deadlock rings...", "info")
	t1 := s.txMgr.CreateTransaction(transaction.CreateTxParams{ID: "tx_pairA_1", WorkerID: "wA1", Priority: 2})
	t2 := s.txMgr.CreateTransaction(transaction.CreateTxParams{ID: "tx_pairA_2", WorkerID: "wA2", Priority: 1})
	s.coordinator.AcquireLock(ctx, "shard_east_1", t1.ID, t1.WorkerID, 6000)
	s.coordinator.AcquireLock(ctx, "shard_east_2", t2.ID, t2.WorkerID, 6000)

	t3 := s.txMgr.CreateTransaction(transaction.CreateTxParams{ID: "tx_pairB_1", WorkerID: "wB1", Priority: 2})
	t4 := s.txMgr.CreateTransaction(transaction.CreateTxParams{ID: "tx_pairB_2", WorkerID: "wB2", Priority: 1})
	s.coordinator.AcquireLock(ctx, "shard_west_1", t3.ID, t3.WorkerID, 6000)
	s.coordinator.AcquireLock(ctx, "shard_west_2", t4.ID, t4.WorkerID, 6000)

	time.Sleep(300 * time.Millisecond)

	s.coordinator.AcquireLock(ctx, "shard_east_2", t1.ID, t1.WorkerID, 6000)
	s.coordinator.AcquireLock(ctx, "shard_east_1", t2.ID, t2.WorkerID, 6000)

	s.coordinator.AcquireLock(ctx, "shard_west_2", t3.ID, t3.WorkerID, 6000)
	s.coordinator.AcquireLock(ctx, "shard_west_1", t4.ID, t4.WorkerID, 6000)
	return nil
}

func (s *Simulator) runStaleWorker(ctx context.Context) error {
	s.log("Demonstrating Stale Worker protection with Monotonic Fencing Tokens...", "info")
	txOld := s.txMgr.CreateTransaction(transaction.CreateTxParams{ID: "tx_stale_1", WorkerID: "worker_laggy"})
	resA := s.coordinator.AcquireLock(ctx, "customer_profile_99", txOld.ID, txOld.WorkerID, 1500)

	oldToken := *resA.FencingToken
	s.log(fmt.Sprintf("Worker-Laggy granted lock with fencing token: [%d]", oldToken), "info")

	s.log("Worker-Laggy undergoes 1800ms GC freeze; lock lease expires...", "info")
	time.Sleep(1600 * time.Millisecond)

	txNew := s.txMgr.CreateTransaction(transaction.CreateTxParams{ID: "tx_fresh_2", WorkerID: "worker_healthy"})
	resB := s.coordinator.AcquireLock(ctx, "customer_profile_99", txNew.ID, txNew.WorkerID, 5000)
	newToken := *resB.FencingToken
	s.log(fmt.Sprintf("Worker-Healthy acquires renewed lock with NEW fencing token: [%d]", newToken), "success")

	s.log(fmt.Sprintf("Worker-Laggy awakes and attempts mutation with old token [%d]...", oldToken), "info")
	valid, reason := s.fencing.ValidateToken("customer_profile_99", oldToken)

	if !valid {
		s.log(fmt.Sprintf("FENCING BLOCKED STALE WRITE: %s", reason), "warn")
	} else {
		s.log("Stale worker was not caught!", "error")
	}
	return nil
}

func (s *Simulator) runRetryStorm(ctx context.Context) error {
	s.log("Simulating 8 concurrent workers simultaneously colliding on hot_account_balance...", "info")
	var wg sync.WaitGroup
	granted := 0
	queued := 0
	var mu sync.Mutex

	for i := 1; i <= 8; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			tx := s.txMgr.CreateTransaction(transaction.CreateTxParams{
				ID:       fmt.Sprintf("tx_storm_%d", idx),
				WorkerID: fmt.Sprintf("worker_%d", idx),
				Priority: 1,
			})
			s.metricsMgr.RecordOp()
			res := s.coordinator.AcquireLock(ctx, "hot_account_balance", tx.ID, tx.WorkerID, 6000)
			mu.Lock()
			if res.Success {
				granted++
			} else if res.Waiting {
				queued++
			}
			mu.Unlock()
		}(i)
	}

	wg.Wait()
	s.log(fmt.Sprintf("Immediate result: %d granted, %d queued under jitter backoff protection", granted, queued), "info")
	return nil
}

func (s *Simulator) runPostgresDeadlock(ctx context.Context) error {
	s.log("Injecting PostgreSQL engine deadlock simulation into pg_locks...", "info")
	s.pgMonitor.SimulatePostgresDeadlock()
	s.log("PostgreSQL catalog now reports circular lock wait between PID 18401 and PID 18402!", "warn")
	return nil
}

func (s *Simulator) runRedisFailure(ctx context.Context) error {
	s.log("Injecting Redis cluster connection failure...", "info")
	s.redisEng.SetSimulateFailure(true)

	tx := s.txMgr.CreateTransaction(transaction.CreateTxParams{ID: "tx_failover_test", WorkerID: "w_test"})
	res := s.coordinator.AcquireLock(ctx, "res_critical", tx.ID, tx.WorkerID, 6000)
	s.log(fmt.Sprintf("Lock attempt during outage: %s", res.Error), "error")

	time.Sleep(1200 * time.Millisecond)
	s.log("Restoring Redis cluster health...", "success")
	s.redisEng.SetSimulateFailure(false)
	return nil
}

func (s *Simulator) runWorkerCrash(ctx context.Context) error {
	s.log("Worker acquiring lock with 2500ms lease TTL then immediately crashing (omitting release)...", "info")
	tx := s.txMgr.CreateTransaction(transaction.CreateTxParams{ID: "tx_crashed_worker", WorkerID: "w_crash"})
	s.coordinator.AcquireLock(ctx, "ephemeral_batch_lock", tx.ID, tx.WorkerID, 2500)

	txWait := s.txMgr.CreateTransaction(transaction.CreateTxParams{ID: "tx_waiting_for_lease", WorkerID: "w_wait"})
	s.coordinator.AcquireLock(ctx, "ephemeral_batch_lock", txWait.ID, txWait.WorkerID, 2500)
	s.log("tx_waiting_for_lease is queued. Waiting for TTL expiration auto-eviction...", "info")

	time.Sleep(2700 * time.Millisecond)
	s.log("Lease expired! Orphaned lock auto-reclaimed by TTL watcher.", "success")
	return nil
}

func (s *Simulator) runNetworkDelay(ctx context.Context) error {
	s.log("Injecting 250ms synthetic network latency into Redis transport...", "info")
	s.redisEng.SetArtificialLatency(250 * time.Millisecond)

	start := time.Now()
	tx := s.txMgr.CreateTransaction(transaction.CreateTxParams{ID: "tx_latency_test", WorkerID: "w_lat"})
	s.coordinator.AcquireLock(ctx, "res_latency", tx.ID, tx.WorkerID, 6000)
	duration := time.Since(start)
	s.log(fmt.Sprintf("Lock acquired with artificial delay in %v", duration), "info")

	s.redisEng.SetArtificialLatency(0)
	s.log("Network latency cleared.", "success")
	return nil
}

func (s *Simulator) runCrossSystemDeadlock(ctx context.Context) error {
	s.log("Injecting Cross-System Redis + PostgreSQL unified dependency deadlock...", "info")
	tx1 := s.txMgr.CreateTransaction(transaction.CreateTxParams{ID: "tx_cross_redis", WorkerID: "w_redis", Priority: 2})
	s.coordinator.AcquireLock(ctx, "inventory_lock_slot_1", tx1.ID, tx1.WorkerID, 6000)

	s.pgMonitor.SimulatePostgresDeadlock()
	s.log("Observed cross-system lock contention: Redis distributed worker waiting on PostgreSQL PID 18401!", "warn")
	return nil
}

func (s *Simulator) ResetAll() {
	s.redisEng.Reset()
	s.wfg.Reset()
	s.txMgr.Reset()
	s.recoveryEng.Reset()
	s.pgMonitor.Reset()
	s.metricsMgr.Reset()
	s.log("System state reset to clean baseline.", "info")
}
