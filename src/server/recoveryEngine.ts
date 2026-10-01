/**
 * DeadLockIQ Deadlock Incident, Recovery & Retry Engine
 *
 * Coordinates:
 * 1. Cycle incident creation
 * 2. Victim selection
 * 3. Victim rollback and atomic lock release
 * 4. Graph dependency update & cycle breakage verification
 * 5. Exponential backoff + full jitter calculation
 * 6. Automated retry execution
 */

import { DeadlockIncident, Transaction } from '../types/index.ts';
import { waitForGraph } from './waitForGraph.ts';
import { transactionManager } from './transactionManager.ts';
import { redisLockEngine } from './lockCoordinator.ts';
import { victimSelector } from './victimSelector.ts';

export class RecoveryEngine {
  private incidents: Map<string, DeadlockIncident> = new Map();
  private incidentCounter = 1000;
  private pendingRetries: Map<string, NodeJS.Timeout> = new Map();
  private onIncidentUpdated?: (incident: DeadlockIncident) => void;
  private onRetryTriggered?: (txId: string, retryCount: number) => void;

  public setCallbacks(
    onIncidentUpdated?: (incident: DeadlockIncident) => void,
    onRetryTriggered?: (txId: string, retryCount: number) => void
  ) {
    this.onIncidentUpdated = onIncidentUpdated;
    this.onRetryTriggered = onRetryTriggered;
  }

  /**
   * Main resolution workflow
   */
  public async handleDeadlock(
    cycleTxIds: string[],
    cyclePath: string[],
    resourcesInvolved: string[],
    detectionLatencyMs: number
  ): Promise<DeadlockIncident> {
    const incidentId = `INC-${++this.incidentCounter}`;
    const now = Date.now();

    // 1. Mark involved transactions as DEADLOCK_DETECTED
    const cycleTxs: Transaction[] = [];
    for (const txId of cycleTxIds) {
      const tx = transactionManager.getTransaction(txId);
      if (tx) {
        cycleTxs.push(tx);
        try {
          transactionManager.transitionState(txId, 'DEADLOCK_DETECTED', `Deadlock cycle detected: ${incidentId}`);
        } catch {
          // If already transitioning, continue
        }
      }
    }

    // 2. Select Victim
    const victimSelection = victimSelector.selectVictim(cycleTxs);
    const victimTxId = victimSelection.victimTxId;

    // 3. Create Incident Record
    const incident: DeadlockIncident = {
      id: incidentId,
      timestamp: now,
      cycleTxIds,
      cyclePath,
      resourcesInvolved,
      detectionLatencyMs,
      victimId: victimTxId,
      victimScore: victimSelection.victimScore,
      factors: victimSelection.factors,
      explanation: victimSelection.explanation,
      alternativeCandidates: victimSelection.alternativeCandidates,
      timeline: [
        { step: 'DETECTED', timestamp: now, details: `Cycle of ${cycleTxIds.length} transactions identified in ${detectionLatencyMs.toFixed(2)}ms` },
        { step: 'VICTIM_SELECTED', timestamp: Date.now(), details: `Selected ${victimTxId}: ${victimSelection.explanation}` },
      ],
      status: 'RESOLVING',
    };

    this.incidents.set(incidentId, incident);
    this.emitIncidentUpdate(incident);

    // 4. Mark victim as VICTIM_SELECTED, others revert to WAITING
    for (const tx of cycleTxs) {
      if (tx.id === victimTxId) {
        try {
          transactionManager.transitionState(tx.id, 'VICTIM_SELECTED', `Chosen as deadlock victim`);
        } catch {}
      } else {
        try {
          // Others return to WAITING
          if (tx.state === 'DEADLOCK_DETECTED') {
            transactionManager.transitionState(tx.id, 'WAITING', `Waiting for deadlock resolution on victim ${victimTxId}`);
          }
        } catch {}
      }
    }

    // Small delay to allow UI to visualize VICTIM_SELECTED stage
    await new Promise(r => setTimeout(r, 120));

    // 5. Abort and Rollback victim
    incident.timeline.push({
      step: 'ROLLBACK_STARTED',
      timestamp: Date.now(),
      details: `Initiating abort and compensating transactions for ${victimTxId}`,
    });
    this.emitIncidentUpdate(incident);

    try {
      transactionManager.transitionState(victimTxId, 'ABORTING', 'Compensating transactions in progress');
    } catch {}

    // 6. Release all locks held by victim
    const victimTx = transactionManager.getTransaction(victimTxId);
    const heldLocks = victimTx ? [...victimTx.locksHeld] : [];

    for (const resId of heldLocks) {
      await redisLockEngine.release(resId, victimTxId);
      waitForGraph.recordLockReleased(resId, victimTxId);
      transactionManager.removeLockHeld(victimTxId, resId);
    }

    // Clear wait edge for victim
    if (victimTx?.waitingForLock) {
      waitForGraph.recordLockReleased(victimTx.waitingForLock, victimTxId);
      transactionManager.setWaitingFor(victimTxId, undefined);
    }

    try {
      transactionManager.transitionState(victimTxId, 'ROLLED_BACK', 'Locks released and state compensated');
    } catch {}

    incident.timeline.push({
      step: 'LOCKS_RELEASED',
      timestamp: Date.now(),
      details: `Released ${heldLocks.length} locks [${heldLocks.join(', ')}]. Wait-For Graph cycle severed.`,
    });
    this.emitIncidentUpdate(incident);

    // 7. Verify cycle removed in graph
    waitForGraph.clearCyclesIfBroken();

    // 8. Exponential backoff and Retry scheduling
    const currentTx = transactionManager.getTransaction(victimTxId);
    if (currentTx && currentTx.retryCount < currentTx.maxRetries) {
      const retryCount = transactionManager.incrementRetry(victimTxId);

      // Backoff = min(maxDelay, baseDelay * 2^retryCount) + jitter(0..jitterMax)
      const baseDelay = 200;
      const maxDelay = 3000;
      const exponential = Math.min(maxDelay, baseDelay * Math.pow(2, retryCount));
      const jitter = Math.floor(Math.random() * 100);
      const backoffDelay = exponential + jitter;

      try {
        transactionManager.transitionState(victimTxId, 'BACKOFF', `Backing off for ${backoffDelay}ms (attempt #${retryCount})`);
      } catch {}

      incident.timeline.push({
        step: 'BACKOFF_SCHEDULED',
        timestamp: Date.now(),
        details: `Retry #${retryCount} scheduled in ${backoffDelay}ms (exponential backoff + jitter)`,
      });
      this.emitIncidentUpdate(incident);

      // Schedule retry execution
      const timer = setTimeout(async () => {
        this.pendingRetries.delete(victimTxId);
        await this.executeRetry(victimTxId, heldLocks, incidentId);
      }, backoffDelay);

      this.pendingRetries.set(victimTxId, timer);
    } else {
      try {
        transactionManager.transitionState(victimTxId, 'FAILED', `Exhausted retry budget (${currentTx?.maxRetries} max retries)`);
      } catch {}

      incident.timeline.push({
        step: 'FAILED',
        timestamp: Date.now(),
        details: `Transaction ${victimTxId} exceeded retry budget. Marked as FAILED.`,
      });
      incident.status = 'FAILED';
      this.emitIncidentUpdate(incident);
    }

    return incident;
  }

  private async executeRetry(txId: string, resourcesToAcquire: string[], incidentId: string) {
    const incident = this.incidents.get(incidentId);
    const tx = transactionManager.getTransaction(txId);
    if (!tx) return;

    if (incident) {
      incident.timeline.push({
        step: 'RETRY_STARTED',
        timestamp: Date.now(),
        details: `Executing retry #${tx.retryCount} for transaction ${txId}`,
      });
      this.emitIncidentUpdate(incident);
    }

    try {
      transactionManager.transitionState(txId, 'RETRYING', `Retry attempt #${tx.retryCount}`);
    } catch {}

    if (this.onRetryTriggered) {
      this.onRetryTriggered(txId, tx.retryCount);
    }

    // Try to re-acquire locks with fair retry
    let allAcquired = true;
    for (const resId of resourcesToAcquire) {
      const acq = await redisLockEngine.acquire(resId, txId, tx.workerId, 6000);
      if (acq.success) {
        transactionManager.addLockHeld(txId, resId);
        waitForGraph.recordLockAcquired(resId, txId);
      } else {
        allAcquired = false;
        break;
      }
    }

    if (allAcquired) {
      try {
        transactionManager.transitionState(txId, 'ACQUIRED', 'All locks successfully re-acquired');
        // Simulate completion after execution
        setTimeout(() => {
          try {
            transactionManager.transitionState(txId, 'COMMITTING', 'Committing transaction');
            for (const r of resourcesToAcquire) {
              redisLockEngine.release(r, txId);
              waitForGraph.recordLockReleased(r, txId);
            }
            transactionManager.clearAllLocks(txId);
            transactionManager.transitionState(txId, 'COMPLETED', 'Transaction recovered and committed successfully');

            if (incident) {
              incident.timeline.push({
                step: 'RECOVERED',
                timestamp: Date.now(),
                details: `Transaction ${txId} committed successfully. Concurrency restored.`,
              });
              incident.status = 'RESOLVED';
              this.emitIncidentUpdate(incident);
            }
          } catch {}
        }, 150);
      } catch {}
    } else {
      // Re-queue
      try {
        transactionManager.transitionState(txId, 'WAITING', 'Contention remains; queued for re-acquisition');
      } catch {}
    }
  }

  private emitIncidentUpdate(incident: DeadlockIncident) {
    if (this.onIncidentUpdated) {
      this.onIncidentUpdated({ ...incident, timeline: [...incident.timeline] });
    }
  }

  public getIncident(id: string): DeadlockIncident | undefined {
    return this.incidents.get(id);
  }

  public getAllIncidents(): DeadlockIncident[] {
    return Array.from(this.incidents.values()).sort((a, b) => b.timestamp - a.timestamp);
  }

  public reset() {
    for (const timer of this.pendingRetries.values()) {
      clearTimeout(timer);
    }
    this.pendingRetries.clear();
    this.incidents.clear();
    this.incidentCounter = 1000;
  }
}

export const recoveryEngine = new RecoveryEngine();
