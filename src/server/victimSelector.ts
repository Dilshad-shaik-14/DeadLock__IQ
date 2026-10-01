/**
 * DeadLockIQ Victim Selector
 *
 * Implements an explainable, multi-factor victim selection algorithm with
 * dynamic priority aging and starvation prevention.
 */

import { Transaction, DeadlockIncident, CandidateScore, IncidentFactorBreakdown } from '../types/index.ts';

export interface VictimSelectionResult {
  victimTxId: string;
  victimScore: number;
  factors: IncidentFactorBreakdown;
  explanation: string;
  alternativeCandidates: CandidateScore[];
}

export class VictimSelector {
  /**
   * Evaluates each cycle participant and selects the optimal victim to abort.
   *
   * Higher survival score means the transaction is more valuable/costly to abort.
   * Lowest survival score = chosen victim (least disruptive to abort and rollback).
   *
   * Factors:
   * + Effective Priority (base priority + aging bonus for waiting time)
   * + Locks held (aborting a transaction with fewer locks disrupts fewer downstream dependents)
   * + Work done (sunk computation cost)
   * + Retry count (protect against starvation: transactions with prior retries get high bonus)
   * - Rollback cost (higher rollback cost increases survival score)
   */
  public selectVictim(cycleTxList: Transaction[]): VictimSelectionResult {
    if (cycleTxList.length === 0) {
      throw new Error('Cannot select victim from empty cycle');
    }

    if (cycleTxList.length === 1) {
      const single = cycleTxList[0];
      const agingBonus = this.calculateAgingBonus(single);
      const effectivePriority = single.priority + agingBonus;
      return {
        victimTxId: single.id,
        victimScore: 10,
        factors: {
          effectivePriority,
          agingBonus,
          locksHeld: single.locksHeld.length,
          workDoneUnits: single.workDoneUnits,
          rollbackCost: single.rollbackCost,
          retryCount: single.retryCount,
        },
        explanation: `Transaction ${single.id} was the sole participant in self-referencing lock dependency.`,
        alternativeCandidates: [],
      };
    }

    const scoredCandidates = cycleTxList.map(tx => {
      const agingBonus = this.calculateAgingBonus(tx);
      const effectivePriority = tx.priority + agingBonus;

      // Survival Score Calculation:
      // High score = should SURVIVE
      // Low score = best VICTIM
      // Starvation protection: heavily penalize aborting an already retried transaction (+15 pts per retry)
      const survivalScore =
        effectivePriority * 5.0 +
        tx.locksHeld.length * 4.0 +
        tx.workDoneUnits * 2.0 +
        tx.retryCount * 15.0 -
        tx.rollbackCost * 1.5;

      return {
        tx,
        effectivePriority,
        agingBonus,
        score: Math.round(survivalScore * 10) / 10,
      };
    });

    // Sort ascending: lowest survival score first -> selected victim
    scoredCandidates.sort((a, b) => a.score - b.score);

    const chosen = scoredCandidates[0];
    const victimTx = chosen.tx;

    const alternatives: CandidateScore[] = scoredCandidates.slice(1).map(c => ({
      txId: c.tx.id,
      score: c.score,
      reason: `Effective priority ${c.effectivePriority.toFixed(1)}, ${c.tx.locksHeld.length} locks held, ${c.tx.workDoneUnits} work units, ${c.tx.retryCount} prior retries`,
    }));

    // Generate clear, dynamic, data-driven explanation
    const altNames = alternatives.map(a => a.txId).join(', ');
    const explanation =
      `Transaction ${victimTx.id} selected as victim (score: ${chosen.score}) because it has ` +
      `the lowest rollback penalty among cycle participants [${cycleTxList.map(t => t.id).join(', ')}]. ` +
      `It holds ${victimTx.locksHeld.length} lock(s), has completed ${victimTx.workDoneUnits} units of work, ` +
      `effective priority ${chosen.effectivePriority.toFixed(1)} (base ${victimTx.priority} + ${chosen.agingBonus.toFixed(1)} aging bonus), ` +
      `and has ${victimTx.retryCount} prior retries, making its cancellation less costly than ${altNames}.`;

    return {
      victimTxId: victimTx.id,
      victimScore: chosen.score,
      factors: {
        effectivePriority: chosen.effectivePriority,
        agingBonus: chosen.agingBonus,
        locksHeld: victimTx.locksHeld.length,
        workDoneUnits: victimTx.workDoneUnits,
        rollbackCost: victimTx.rollbackCost,
        retryCount: victimTx.retryCount,
      },
      explanation,
      alternativeCandidates: alternatives,
    };
  }

  /**
   * Calculates dynamic aging bonus based on how long the transaction has been alive or waiting
   */
  public calculateAgingBonus(tx: Transaction): number {
    const elapsedMs = Date.now() - tx.createdAt;
    // +1 priority point per 1200ms of wait to prevent starvation
    return Math.min(10, Math.floor(elapsedMs / 1200));
  }
}

export const victimSelector = new VictimSelector();
