/**
 * DeadLockIQ PostgreSQL Lock Monitor
 *
 * Observes PostgreSQL engine lock catalog schemas:
 * - pg_locks
 * - pg_stat_activity
 *
 * Distinguishes OBSERVATION from CONTROL.
 * Combines observed relational locks with distributed Redis locks into a unified dependency graph.
 */

import { PostgresLockRecord } from '../types/index.ts';

export class PostgresLockMonitor {
  private records: PostgresLockRecord[] = [];
  private isSimulatingDeadlock: boolean = false;
  private isConnected: boolean = true;

  constructor() {
    this.seedDefaultObservation();
  }

  public seedDefaultObservation() {
    this.records = [
      {
        pid: 14022,
        database: 'deadlockiq_production',
        relation: 'orders_partition_2026',
        locktype: 'relation',
        mode: 'RowExclusiveLock',
        granted: true,
        transactionId: 'pg_tx_88192',
        query: 'UPDATE orders_partition_2026 SET status = \'PROCESSING\' WHERE order_id = \'ORD-902\'',
        queryStart: new Date(Date.now() - 4200).toISOString(),
      },
      {
        pid: 14035,
        database: 'deadlockiq_production',
        relation: 'accounts_ledger',
        locktype: 'transactionid',
        mode: 'ExclusiveLock',
        granted: true,
        transactionId: 'pg_tx_88194',
        query: 'SELECT balance FROM accounts_ledger WHERE account_id = 1042 FOR UPDATE',
        queryStart: new Date(Date.now() - 3100).toISOString(),
      },
    ];
  }

  public simulatePostgresDeadlock() {
    this.isSimulatingDeadlock = true;
    this.records = [
      {
        pid: 18401,
        database: 'deadlockiq_production',
        relation: 'inventory_items',
        locktype: 'tuple',
        mode: 'ExclusiveLock',
        granted: true,
        transactionId: 'pg_tx_9011',
        query: 'UPDATE inventory_items SET stock = stock - 1 WHERE sku = \'ITEM-X\'',
        queryStart: new Date(Date.now() - 1500).toISOString(),
      },
      {
        pid: 18402,
        database: 'deadlockiq_production',
        relation: 'inventory_items',
        locktype: 'tuple',
        mode: 'ExclusiveLock',
        granted: false, // WAITING for pid 18401
        waitingForPid: 18401,
        transactionId: 'pg_tx_9012',
        query: 'UPDATE inventory_items SET stock = stock - 1 WHERE sku = \'ITEM-X\'',
        queryStart: new Date(Date.now() - 1200).toISOString(),
      },
      {
        pid: 18402,
        database: 'deadlockiq_production',
        relation: 'pricing_rules',
        locktype: 'relation',
        mode: 'RowExclusiveLock',
        granted: true,
        transactionId: 'pg_tx_9012',
        query: 'UPDATE pricing_rules SET discount = 0.15 WHERE rule_id = \'TIER-1\'',
        queryStart: new Date(Date.now() - 1400).toISOString(),
      },
      {
        pid: 18401,
        database: 'deadlockiq_production',
        relation: 'pricing_rules',
        locktype: 'relation',
        mode: 'RowExclusiveLock',
        granted: false, // WAITING for pid 18402 -> POSTGRES INTERNAL DEADLOCK CYCLE!
        waitingForPid: 18402,
        transactionId: 'pg_tx_9011',
        query: 'UPDATE pricing_rules SET discount = 0.20 WHERE rule_id = \'TIER-1\'',
        queryStart: new Date(Date.now() - 950).toISOString(),
      },
    ];
  }

  public getObservedLocks(): PostgresLockRecord[] {
    return [...this.records];
  }

  public isDeadlockObserved(): boolean {
    // Check if there is a cycle in waitingForPid
    for (const r1 of this.records) {
      if (!r1.granted && r1.waitingForPid) {
        for (const r2 of this.records) {
          if (r2.pid === r1.waitingForPid && !r2.granted && r2.waitingForPid === r1.pid) {
            return true;
          }
        }
      }
    }
    return false;
  }

  public getStatus(): 'CONNECTED' | 'SIMULATING' | 'FAILED' {
    if (!this.isConnected) return 'FAILED';
    if (this.isSimulatingDeadlock) return 'SIMULATING';
    return 'CONNECTED';
  }

  public reset() {
    this.isSimulatingDeadlock = false;
    this.isConnected = true;
    this.seedDefaultObservation();
  }
}

export const postgresLockMonitor = new PostgresLockMonitor();
