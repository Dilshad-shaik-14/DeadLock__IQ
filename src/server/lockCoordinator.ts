/**
 * DeadLockIQ Lock Coordinator
 *
 * Glues Redis distributed lock primitives, transaction state machine,
 * Wait-For Graph, and deadlock recovery workflow into an atomic pipeline.
 */

import { RedisLockEngine } from './redisLockEngine.ts';
import { waitForGraph } from './waitForGraph.ts';
import { transactionManager } from './transactionManager.ts';
import { recoveryEngine } from './recoveryEngine.ts';
import { DeadlockIncident } from '../types/index.ts';

export const redisLockEngine = new RedisLockEngine(expiredLock => {
  // Lease timeout handler: when a worker dies without releasing,
  // TTL expiration automatically clears it from graph and transactions
  waitForGraph.recordLockReleased(expiredLock.resourceId, expiredLock.holderTxId);
  transactionManager.removeLockHeld(expiredLock.holderTxId, expiredLock.resourceId);
});

export interface AcquireResponse {
  success: boolean;
  resourceId: string;
  txId: string;
  fencingToken?: number;
  waiting?: boolean;
  holderTxId?: string;
  deadlockDetected?: boolean;
  incident?: DeadlockIncident;
  error?: string;
}

export class LockCoordinator {
  private onLockEvent?: (event: {
    type: string;
    resourceId: string;
    txId: string;
    details?: any;
  }) => void;

  public setOnLockEvent(cb: (event: { type: string; resourceId: string; txId: string; details?: any }) => void) {
    this.onLockEvent = cb;
  }

  public async acquireLock(
    resourceId: string,
    txId: string,
    workerId: string,
    ttlMs: number = 6000
  ): Promise<AcquireResponse> {
    const tx = transactionManager.getTransaction(txId);
    if (!tx) {
      return { success: false, resourceId, txId, error: `Transaction ${txId} not found` };
    }

    waitForGraph.registerTransaction(
      txId,
      workerId,
      tx.state,
      tx.priority,
      tx.effectivePriority,
      tx.fencingToken
    );

    if (this.onLockEvent) {
      this.onLockEvent({ type: 'LOCK_REQUESTED', resourceId, txId });
    }

    const acq = await redisLockEngine.acquire(resourceId, txId, workerId, ttlMs);

    if (acq.success) {
      // Lock granted
      transactionManager.addLockHeld(txId, resourceId);
      waitForGraph.recordLockAcquired(resourceId, txId);

      try {
        if (tx.state === 'CREATED' || tx.state === 'WAITING' || tx.state === 'RETRYING') {
          transactionManager.transitionState(txId, 'ACQUIRED', `Acquired lock on ${resourceId}`);
        }
      } catch {}

      if (this.onLockEvent) {
        this.onLockEvent({
          type: 'LOCK_ACQUIRED',
          resourceId,
          txId,
          details: { fencingToken: acq.fencingToken },
        });
      }

      return {
        success: true,
        resourceId,
        txId,
        fencingToken: acq.fencingToken,
      };
    }

    // Lock failed: check holder
    const holderTxId = acq.currentHolderTxId;
    if (holderTxId) {
      transactionManager.setWaitingFor(txId, resourceId);
      try {
        if (tx.state !== 'WAITING') {
          transactionManager.transitionState(txId, 'WAITING', `Waiting for resource ${resourceId} held by ${holderTxId}`);
        }
      } catch {}

      if (this.onLockEvent) {
        this.onLockEvent({
          type: 'LOCK_WAITING',
          resourceId,
          txId,
          details: { holderTxId },
        });
      }

      // Record wait in graph and execute incremental cycle detection!
      const cycleResult = waitForGraph.recordLockWaiting(txId, resourceId, holderTxId);

      if (cycleResult.hasCycle) {
        // Deadlock detected!
        if (this.onLockEvent) {
          this.onLockEvent({
            type: 'DEADLOCK_DETECTED',
            resourceId,
            txId,
            details: cycleResult,
          });
        }

        const incident = await recoveryEngine.handleDeadlock(
          cycleResult.cycleTxIds,
          cycleResult.cyclePath,
          cycleResult.resourcesInvolved,
          cycleResult.latencyUs / 1000
        );

        return {
          success: false,
          resourceId,
          txId,
          deadlockDetected: true,
          incident,
        };
      }

      return {
        success: false,
        resourceId,
        txId,
        waiting: true,
        holderTxId,
      };
    }

    return {
      success: false,
      resourceId,
      txId,
      error: acq.error || 'Failed to acquire lock',
    };
  }

  public async releaseLock(
    resourceId: string,
    txId: string,
    providedFencingToken?: number
  ) {
    const rel = await redisLockEngine.release(resourceId, txId, providedFencingToken);

    if (rel.success) {
      transactionManager.removeLockHeld(txId, resourceId);
      waitForGraph.recordLockReleased(resourceId, txId);

      if (this.onLockEvent) {
        this.onLockEvent({
          type: 'LOCK_RELEASED',
          resourceId,
          txId,
          details: { releasedFencingToken: rel.releasedFencingToken },
        });
      }
    }

    return rel;
  }
}

export const lockCoordinator = new LockCoordinator();
