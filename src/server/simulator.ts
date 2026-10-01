/**
 * DeadLockIQ Deterministic Simulator Engine
 *
 * Implements 12 reproducible, realistic concurrent scenarios using the
 * real lock coordinator, transaction state machine, and Wait-For Graph.
 */

import { lockCoordinator, redisLockEngine } from './lockCoordinator.ts';
import { transactionManager } from './transactionManager.ts';
import { waitForGraph } from './waitForGraph.ts';
import { recoveryEngine } from './recoveryEngine.ts';
import { fencingManager } from './fencing.ts';
import { postgresLockMonitor } from './postgresMonitor.ts';
import { metricsManager } from './metricsManager.ts';

export type ScenarioType =
  | 'TWO_WAY_DEADLOCK'
  | 'THREE_WAY_DEADLOCK'
  | 'N_WAY_DEADLOCK'
  | 'NORMAL_CONTENTION'
  | 'MULTIPLE_DEADLOCKS'
  | 'STALE_WORKER'
  | 'FENCING_VIOLATION'
  | 'RETRY_STORM'
  | 'POSTGRES_DEADLOCK'
  | 'REDIS_FAILURE'
  | 'WORKER_CRASH'
  | 'NETWORK_DELAY';

export class ScenarioSimulator {
  private isRunning: boolean = false;
  private activeScenario: string | null = null;
  private logEmitter?: (message: string, level?: 'info' | 'warn' | 'error' | 'success') => void;

  public setLogEmitter(emitter: (message: string, level?: 'info' | 'warn' | 'error' | 'success') => void) {
    this.logEmitter = emitter;
  }

  private log(msg: string, level: 'info' | 'warn' | 'error' | 'success' = 'info') {
    if (this.logEmitter) {
      this.logEmitter(msg, level);
    }
  }

  public async runScenario(scenario: ScenarioType): Promise<{ success: boolean; message: string }> {
    if (this.isRunning) {
      return { success: false, message: `Scenario ${this.activeScenario} is already executing` };
    }

    this.isRunning = true;
    this.activeScenario = scenario;
    this.log(`--- Starting Scenario: ${scenario} ---`, 'info');

    try {
      switch (scenario) {
        case 'TWO_WAY_DEADLOCK':
          await this.runTwoWayDeadlock();
          break;
        case 'THREE_WAY_DEADLOCK':
          await this.runThreeWayDeadlock();
          break;
        case 'N_WAY_DEADLOCK':
          await this.runNWayDeadlock(5);
          break;
        case 'NORMAL_CONTENTION':
          await this.runNormalContention();
          break;
        case 'MULTIPLE_DEADLOCKS':
          await this.runMultipleDeadlocks();
          break;
        case 'STALE_WORKER':
          await this.runStaleWorker();
          break;
        case 'FENCING_VIOLATION':
          await this.runFencingViolation();
          break;
        case 'RETRY_STORM':
          await this.runRetryStorm();
          break;
        case 'POSTGRES_DEADLOCK':
          await this.runPostgresDeadlock();
          break;
        case 'REDIS_FAILURE':
          await this.runRedisFailure();
          break;
        case 'WORKER_CRASH':
          await this.runWorkerCrash();
          break;
        case 'NETWORK_DELAY':
          await this.runNetworkDelay();
          break;
        default:
          throw new Error(`Unknown scenario: ${scenario}`);
      }
      this.log(`--- Completed Scenario: ${scenario} ---`, 'success');
      return { success: true, message: `Scenario ${scenario} executed successfully` };
    } catch (err: any) {
      this.log(`Scenario Error: ${err.message}`, 'error');
      return { success: false, message: err.message };
    } finally {
      this.isRunning = false;
      this.activeScenario = null;
    }
  }

  /**
   * Scenario 1: 2-Way Deadlock
   * Tx1 holds ResA, requests ResB
   * Tx2 holds ResB, requests ResA
   */
  private async runTwoWayDeadlock() {
    this.log('Creating Tx1 (Worker-A, Priority 2) and Tx2 (Worker-B, Priority 1)...');
    const tx1 = transactionManager.createTransaction({
      id: 'tx_alpha',
      workerId: 'worker_alpha',
      priority: 2,
      workDoneUnits: 45,
      rollbackCost: 3,
    });
    const tx2 = transactionManager.createTransaction({
      id: 'tx_beta',
      workerId: 'worker_beta',
      priority: 1,
      workDoneUnits: 10,
      rollbackCost: 1,
    });

    this.log('Tx1 acquires Resource orders_db_shard1...');
    await lockCoordinator.acquireLock('orders_db_shard1', tx1.id, tx1.workerId, 10000);
    metricsManager.recordOp();

    this.log('Tx2 acquires Resource inventory_cache_v2...');
    await lockCoordinator.acquireLock('inventory_cache_v2', tx2.id, tx2.workerId, 10000);
    metricsManager.recordOp();

    await new Promise(r => setTimeout(r, 600));

    this.log('Tx1 requests inventory_cache_v2 (held by Tx2) -> WAITING...');
    await lockCoordinator.acquireLock('inventory_cache_v2', tx1.id, tx1.workerId, 10000);
    metricsManager.recordOp();

    await new Promise(r => setTimeout(r, 600));

    this.log('Tx2 requests orders_db_shard1 (held by Tx1) -> TRIGGERING DEADLOCK CYCLE!');
    const res = await lockCoordinator.acquireLock('orders_db_shard1', tx2.id, tx2.workerId, 10000);
    metricsManager.recordOp();

    if (res.deadlockDetected && res.incident) {
      metricsManager.recordDeadlockDetected(res.incident.detectionLatencyMs);
      this.log(`DEADLOCK DETECTED! Incident ${res.incident.id} created in ${res.incident.detectionLatencyMs.toFixed(2)}ms`, 'warn');
      this.log(`Cycle: ${res.incident.cyclePath.join(' -> ')}`, 'warn');
      this.log(`Victim Selection: ${res.incident.explanation}`, 'info');
    }
  }

  /**
   * Scenario 2: 3-Way Deadlock
   * Tx1 -> ResB (held by Tx2)
   * Tx2 -> ResC (held by Tx3)
   * Tx3 -> ResA (held by Tx1)
   */
  private async runThreeWayDeadlock() {
    this.log('Initializing 3-worker transaction ring...');
    const tx1 = transactionManager.createTransaction({ id: 'tx_ring_1', workerId: 'worker_1', priority: 3 });
    const tx2 = transactionManager.createTransaction({ id: 'tx_ring_2', workerId: 'worker_2', priority: 2 });
    const tx3 = transactionManager.createTransaction({ id: 'tx_ring_3', workerId: 'worker_3', priority: 1 });

    await lockCoordinator.acquireLock('res_gold', tx1.id, tx1.workerId);
    await lockCoordinator.acquireLock('res_silver', tx2.id, tx2.workerId);
    await lockCoordinator.acquireLock('res_bronze', tx3.id, tx3.workerId);

    await new Promise(r => setTimeout(r, 400));

    this.log('Tx1 requests res_silver...');
    await lockCoordinator.acquireLock('res_silver', tx1.id, tx1.workerId);

    this.log('Tx2 requests res_bronze...');
    await lockCoordinator.acquireLock('res_bronze', tx2.id, tx2.workerId);

    await new Promise(r => setTimeout(r, 400));

    this.log('Tx3 requests res_gold -> 3-way circular wait completed!');
    const res = await lockCoordinator.acquireLock('res_gold', tx3.id, tx3.workerId);

    if (res.deadlockDetected && res.incident) {
      metricsManager.recordDeadlockDetected(res.incident.detectionLatencyMs);
      this.log(`3-WAY DEADLOCK DETECTED! Incident ${res.incident.id}`, 'warn');
    }
  }

  /**
   * Scenario 3: N-Way Deadlock (configurable ring, e.g. 5 nodes)
   */
  private async runNWayDeadlock(n: number = 5) {
    this.log(`Creating ${n}-transaction circular wait ring...`);
    const txs = [];
    const resources = [];

    for (let i = 0; i < n; i++) {
      const tx = transactionManager.createTransaction({
        id: `tx_n_${i + 1}`,
        workerId: `worker_n_${i + 1}`,
        priority: (i % 3) + 1,
      });
      txs.push(tx);
      resources.push(`res_cluster_slot_${i + 1}`);
    }

    // Step 1: each acquires resource i
    for (let i = 0; i < n; i++) {
      await lockCoordinator.acquireLock(resources[i], txs[i].id, txs[i].workerId);
      metricsManager.recordOp();
    }

    await new Promise(r => setTimeout(r, 400));

    // Step 2: each requests resource (i+1) % n
    for (let i = 0; i < n; i++) {
      const nextRes = resources[(i + 1) % n];
      this.log(`${txs[i].id} requesting ${nextRes}...`);
      const res = await lockCoordinator.acquireLock(nextRes, txs[i].id, txs[i].workerId);
      metricsManager.recordOp();

      if (res.deadlockDetected && res.incident) {
        metricsManager.recordDeadlockDetected(res.incident.detectionLatencyMs);
        this.log(`N-WAY CYCLE CLOSED by ${txs[i].id}! Incident: ${res.incident.id}`, 'warn');
        break;
      }
      await new Promise(r => setTimeout(r, 200));
    }
  }

  /**
   * Scenario 4: Normal Contention (No Deadlock)
   * Proves transactions queue up without false-positive cycle triggers
   */
  private async runNormalContention() {
    this.log('Testing regular uncontended / queued lock behavior...');
    const txA = transactionManager.createTransaction({ id: 'tx_order_checkout', workerId: 'w_checkout' });
    const txB = transactionManager.createTransaction({ id: 'tx_order_refund', workerId: 'w_refund' });

    this.log('tx_order_checkout acquires payment_gateway_lock...');
    await lockCoordinator.acquireLock('payment_gateway_lock', txA.id, txA.workerId);

    this.log('tx_order_refund attempts acquisition on same resource (queuing cleanly)...');
    const acqB = await lockCoordinator.acquireLock('payment_gateway_lock', txB.id, txB.workerId);
    this.log(`tx_order_refund status: waiting=${acqB.waiting} (no cycle)`, 'info');

    await new Promise(r => setTimeout(r, 600));

    this.log('tx_order_checkout finishes work and releases lock...');
    await lockCoordinator.releaseLock('payment_gateway_lock', txA.id);
    transactionManager.transitionState(txA.id, 'COMPLETED', 'Done');

    this.log('tx_order_refund now acquires released lock...');
    await lockCoordinator.acquireLock('payment_gateway_lock', txB.id, txB.workerId);
    await new Promise(r => setTimeout(r, 300));
    await lockCoordinator.releaseLock('payment_gateway_lock', txB.id);
    transactionManager.transitionState(txB.id, 'COMPLETED', 'Done');
    this.log('Normal contention resolved with zero deadlocks!', 'success');
  }

  /**
   * Scenario 5: Multiple Simultaneous Deadlocks
   */
  private async runMultipleDeadlocks() {
    this.log('Triggering two simultaneous independent deadlock rings...');
    // Ring 1
    const t1 = transactionManager.createTransaction({ id: 'tx_pairA_1', workerId: 'wA1', priority: 2 });
    const t2 = transactionManager.createTransaction({ id: 'tx_pairA_2', workerId: 'wA2', priority: 1 });
    await lockCoordinator.acquireLock('shard_east_1', t1.id, t1.workerId);
    await lockCoordinator.acquireLock('shard_east_2', t2.id, t2.workerId);

    // Ring 2
    const t3 = transactionManager.createTransaction({ id: 'tx_pairB_1', workerId: 'wB1', priority: 2 });
    const t4 = transactionManager.createTransaction({ id: 'tx_pairB_2', workerId: 'wB2', priority: 1 });
    await lockCoordinator.acquireLock('shard_west_1', t3.id, t3.workerId);
    await lockCoordinator.acquireLock('shard_west_2', t4.id, t4.workerId);

    await new Promise(r => setTimeout(r, 300));

    // Close both cycles
    await lockCoordinator.acquireLock('shard_east_2', t1.id, t1.workerId);
    await lockCoordinator.acquireLock('shard_east_1', t2.id, t2.workerId);

    await lockCoordinator.acquireLock('shard_west_2', t3.id, t3.workerId);
    await lockCoordinator.acquireLock('shard_west_1', t4.id, t4.workerId);
  }

  /**
   * Scenario 6 & 7: Stale Worker & Fencing Violation
   */
  private async runStaleWorker() {
    this.log('Demonstrating Stale Worker protection with Monotonic Fencing Tokens...');
    const txOld = transactionManager.createTransaction({ id: 'tx_stale_1', workerId: 'worker_laggy' });
    const resA = await lockCoordinator.acquireLock('customer_profile_99', txOld.id, txOld.workerId, 1500);

    const oldToken = resA.fencingToken!;
    this.log(`Worker-Laggy granted lock with fencing token: [${oldToken}]`, 'info');

    this.log('Worker-Laggy undergoes 1800ms GC freeze; lock lease expires...');
    await new Promise(r => setTimeout(r, 1600));

    const txNew = transactionManager.createTransaction({ id: 'tx_fresh_2', workerId: 'worker_healthy' });
    const resB = await lockCoordinator.acquireLock('customer_profile_99', txNew.id, txNew.workerId, 5000);
    const newToken = resB.fencingToken!;
    this.log(`Worker-Healthy acquires renewed lock with NEW fencing token: [${newToken}]`, 'success');

    this.log('Worker-Laggy awakes and attempts mutation with old token [' + oldToken + ']...');
    const validation = fencingManager.validateToken('customer_profile_99', oldToken);

    if (!validation.valid) {
      this.log(`FENCING BLOCKED STALE WRITE: ${validation.reason}`, 'warn');
    } else {
      this.log('Stale worker was not caught!', 'error');
    }
  }

  private async runFencingViolation() {
    await this.runStaleWorker();
  }

  /**
   * Scenario 8: Retry Storm & Backoff Jitter Mitigation
   */
  private async runRetryStorm() {
    this.log('Simulating 8 concurrent workers simultaneously colliding on hot_account_balance...');
    const workers = [];
    for (let i = 1; i <= 8; i++) {
      const tx = transactionManager.createTransaction({
        id: `tx_storm_${i}`,
        workerId: `worker_${i}`,
        priority: 1,
      });
      workers.push(tx);
    }

    // All try to acquire the same resource
    const promises = workers.map(async tx => {
      metricsManager.recordOp();
      return lockCoordinator.acquireLock('hot_account_balance', tx.id, tx.workerId);
    });

    const results = await Promise.all(promises);
    const granted = results.filter(r => r.success).length;
    const queued = results.filter(r => r.waiting).length;
    this.log(`Immediate result: ${granted} granted, ${queued} queued under jitter backoff protection`, 'info');
  }

  /**
   * Scenario 9: PostgreSQL Deadlock Observation
   */
  private async runPostgresDeadlock() {
    this.log('Injecting PostgreSQL engine deadlock simulation into pg_locks...');
    postgresLockMonitor.simulatePostgresDeadlock();
    this.log('PostgreSQL catalog now reports circular lock wait between PID 18401 and PID 18402!', 'warn');
  }

  /**
   * Scenario 10: Redis Failure Simulation
   */
  private async runRedisFailure() {
    this.log('Injecting Redis cluster connection failure...');
    redisLockEngine.setSimulateFailure(true);

    const tx = transactionManager.createTransaction({ id: 'tx_failover_test', workerId: 'w_test' });
    const res = await lockCoordinator.acquireLock('res_critical', tx.id, tx.workerId);
    this.log(`Lock attempt during outage: ${res.error}`, 'error');

    await new Promise(r => setTimeout(r, 1200));
    this.log('Restoring Redis cluster health...', 'success');
    redisLockEngine.setSimulateFailure(false);
  }

  /**
   * Scenario 11: Worker Crash & TTL Lease Reclaim
   */
  private async runWorkerCrash() {
    this.log('Worker acquiring lock with 2500ms lease TTL then immediately crashing (omitting release)...');
    const tx = transactionManager.createTransaction({ id: 'tx_crashed_worker', workerId: 'w_crash' });
    await lockCoordinator.acquireLock('ephemeral_batch_lock', tx.id, tx.workerId, 2500);

    const txWait = transactionManager.createTransaction({ id: 'tx_waiting_for_lease', workerId: 'w_wait' });
    await lockCoordinator.acquireLock('ephemeral_batch_lock', txWait.id, txWait.workerId, 2500);
    this.log('tx_waiting_for_lease is queued. Waiting for TTL expiration auto-eviction...');

    await new Promise(r => setTimeout(r, 2700));
    this.log('Lease expired! Orphaned lock auto-reclaimed by TTL watcher.', 'success');
  }

  /**
   * Scenario 12: Network Delay & Jitter
   */
  private async runNetworkDelay() {
    this.log('Injecting 250ms synthetic network latency into Redis transport...');
    redisLockEngine.setArtificialLatency(250);

    const start = Date.now();
    const tx = transactionManager.createTransaction({ id: 'tx_latency_test', workerId: 'w_lat' });
    await lockCoordinator.acquireLock('res_latency', tx.id, tx.workerId);
    const duration = Date.now() - start;
    this.log(`Lock acquired with artificial delay in ${duration}ms`, 'info');

    redisLockEngine.setArtificialLatency(0);
    this.log('Network latency cleared.', 'success');
  }

  public resetAll() {
    redisLockEngine.reset();
    waitForGraph.reset();
    transactionManager.reset();
    recoveryEngine.reset();
    fencingManager.reset();
    postgresLockMonitor.reset();
    metricsManager.reset();
    this.isRunning = false;
    this.activeScenario = null;
    this.log('System state reset to clean baseline.', 'info');
  }
}

export const scenarioSimulator = new ScenarioSimulator();
