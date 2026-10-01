/**
 * DeadLockIQ Transaction Manager & State Machine
 *
 * Enforces strict transaction lifecycle transitions, dynamic priority aging,
 * lock tracking, and rollback state management.
 */

import { Transaction, TxState } from '../types/index.ts';

const VALID_TRANSITIONS: Record<TxState, Set<TxState>> = {
  CREATED: new Set(['WAITING', 'ACQUIRED', 'RUNNING', 'FAILED']),
  WAITING: new Set(['ACQUIRED', 'DEADLOCK_DETECTED', 'VICTIM_SELECTED', 'ABORTING', 'FAILED']),
  ACQUIRED: new Set(['RUNNING', 'COMMITTING', 'WAITING', 'DEADLOCK_DETECTED', 'FAILED']),
  RUNNING: new Set(['WAITING', 'COMMITTING', 'DEADLOCK_DETECTED', 'ABORTING', 'FAILED']),
  COMMITTING: new Set(['COMPLETED', 'FAILED']),
  COMPLETED: new Set([]), // Terminal
  DEADLOCK_DETECTED: new Set(['VICTIM_SELECTED', 'WAITING', 'ACQUIRED', 'ABORTING', 'FAILED']),
  VICTIM_SELECTED: new Set(['ABORTING', 'FAILED']),
  ABORTING: new Set(['ROLLED_BACK', 'FAILED']),
  ROLLED_BACK: new Set(['BACKOFF', 'FAILED', 'RETRYING']),
  BACKOFF: new Set(['RETRYING', 'FAILED']),
  RETRYING: new Set(['WAITING', 'ACQUIRED', 'RUNNING', 'FAILED']),
  FAILED: new Set([]), // Terminal
};

export class TransactionManager {
  private transactions: Map<string, Transaction> = new Map();
  private onStateChangeCallback?: (tx: Transaction, oldState: TxState, newState: TxState) => void;

  public setOnStateChange(cb: (tx: Transaction, oldState: TxState, newState: TxState) => void) {
    this.onStateChangeCallback = cb;
  }

  public createTransaction(params: {
    id: string;
    workerId: string;
    priority?: number;
    maxRetries?: number;
    workDoneUnits?: number;
    rollbackCost?: number;
  }): Transaction {
    const now = Date.now();
    const priority = params.priority ?? 1;

    const tx: Transaction = {
      id: params.id,
      workerId: params.workerId,
      priority,
      effectivePriority: priority,
      state: 'CREATED',
      locksHeld: [],
      workDoneUnits: params.workDoneUnits ?? 0,
      rollbackCost: params.rollbackCost ?? 1,
      retryCount: 0,
      maxRetries: params.maxRetries ?? 3,
      createdAt: now,
      updatedAt: now,
      history: [{ state: 'CREATED', timestamp: now }],
    };

    this.transactions.set(tx.id, tx);
    return { ...tx };
  }

  public getTransaction(txId: string): Transaction | undefined {
    const tx = this.transactions.get(txId);
    if (!tx) return undefined;
    return this.refreshEffectivePriority(tx);
  }

  public getAllTransactions(): Transaction[] {
    return Array.from(this.transactions.values()).map(tx => this.refreshEffectivePriority(tx));
  }

  public getActiveTransactions(): Transaction[] {
    const activeStates: Set<TxState> = new Set([
      'CREATED',
      'WAITING',
      'ACQUIRED',
      'RUNNING',
      'COMMITTING',
      'DEADLOCK_DETECTED',
      'VICTIM_SELECTED',
      'ABORTING',
      'BACKOFF',
      'RETRYING',
    ]);
    return this.getAllTransactions().filter(t => activeStates.has(t.state));
  }

  /**
   * Concurrency-safe transition check and state change
   */
  public transitionState(txId: string, newState: TxState, reason?: string): Transaction {
    const tx = this.transactions.get(txId);
    if (!tx) {
      throw new Error(`Transaction [${txId}] not found`);
    }

    const oldState = tx.state;
    if (oldState === newState) {
      return { ...tx };
    }

    const allowed = VALID_TRANSITIONS[oldState];
    if (!allowed || !allowed.has(newState)) {
      throw new Error(
        `INVALID_STATE_TRANSITION: Cannot transition transaction [${txId}] from ${oldState} to ${newState}`
      );
    }

    const now = Date.now();
    tx.state = newState;
    tx.updatedAt = now;
    tx.history.push({ state: newState, timestamp: now, reason });

    this.refreshEffectivePriority(tx);

    if (this.onStateChangeCallback) {
      this.onStateChangeCallback({ ...tx }, oldState, newState);
    }

    return { ...tx };
  }

  public addLockHeld(txId: string, resourceId: string) {
    const tx = this.transactions.get(txId);
    if (tx && !tx.locksHeld.includes(resourceId)) {
      tx.locksHeld.push(resourceId);
      tx.updatedAt = Date.now();
    }
  }

  public removeLockHeld(txId: string, resourceId: string) {
    const tx = this.transactions.get(txId);
    if (tx) {
      tx.locksHeld = tx.locksHeld.filter(r => r !== resourceId);
      tx.updatedAt = Date.now();
    }
  }

  public clearAllLocks(txId: string): string[] {
    const tx = this.transactions.get(txId);
    if (!tx) return [];
    const released = [...tx.locksHeld];
    tx.locksHeld = [];
    tx.waitingForLock = undefined;
    tx.updatedAt = Date.now();
    return released;
  }

  public setWaitingFor(txId: string, resourceId: string | undefined) {
    const tx = this.transactions.get(txId);
    if (tx) {
      tx.waitingForLock = resourceId;
      tx.updatedAt = Date.now();
    }
  }

  public incrementRetry(txId: string): number {
    const tx = this.transactions.get(txId);
    if (!tx) return 0;
    tx.retryCount++;
    tx.updatedAt = Date.now();
    return tx.retryCount;
  }

  public setWorkDone(txId: string, units: number) {
    const tx = this.transactions.get(txId);
    if (tx) {
      tx.workDoneUnits = units;
      tx.updatedAt = Date.now();
    }
  }

  private refreshEffectivePriority(tx: Transaction): Transaction {
    const elapsed = Date.now() - tx.createdAt;
    const agingBonus = Math.min(10, Math.floor(elapsed / 1200));
    tx.effectivePriority = tx.priority + agingBonus;
    return { ...tx };
  }

  public reset() {
    this.transactions.clear();
  }
}

export const transactionManager = new TransactionManager();
