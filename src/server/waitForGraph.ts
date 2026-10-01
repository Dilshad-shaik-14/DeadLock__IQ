/**
 * DeadLockIQ Wait-For Graph (WFG) & Incremental Cycle Detector
 *
 * Maintains a live in-memory dependency graph between transactions and resources:
 * - Transaction A -> Resource R (A is WAITING for R)
 * - Resource R -> Transaction B (R is HELD by B)
 * - Flattened dependency: Transaction A -> Transaction B (A waits for B)
 *
 * Incremental cycle detection checks whether target node B can already reach source A
 * BEFORE or UPON adding edge A -> B.
 */

import { GraphSnapshot, GraphNodeData, GraphEdgeData, TxState } from '../types/index.ts';

export interface CycleDetectionResult {
  hasCycle: boolean;
  cycleTxIds: string[];
  cyclePath: string[]; // e.g. ["Tx1", "ResA", "Tx2", "ResB", "Tx1"]
  resourcesInvolved: string[];
  latencyUs: number; // Measured in microseconds
}

export class WaitForGraph {
  // Direct Tx -> Tx dependency adjacency: txA -> Set of txB (txA waits for txB)
  private txWaitAdj: Map<string, Set<string>> = new Map();

  // Resource mappings
  // resourceId -> holderTxId
  private resourceHolders: Map<string, string> = new Map();
  // resourceId -> Set of waiting txIds
  private resourceWaiters: Map<string, Set<string>> = new Map();
  // txId -> Set of held resourceIds
  private txHeldResources: Map<string, Set<string>> = new Map();
  // txId -> waitingForResourceId
  private txWaitingFor: Map<string, string> = new Map();

  // Known transaction metadata for graph rendering
  private txMetadata: Map<
    string,
    {
      workerId: string;
      state: TxState;
      priority: number;
      effectivePriority: number;
      fencingToken?: number;
    }
  > = new Map();

  // Currently detected active cycles for UI highlight
  private activeCycles: string[][] = [];

  /**
   * Register or update transaction metadata
   */
  public registerTransaction(
    txId: string,
    workerId: string,
    state: TxState,
    priority: number,
    effectivePriority: number,
    fencingToken?: number
  ) {
    if (!this.txWaitAdj.has(txId)) {
      this.txWaitAdj.set(txId, new Set());
    }
    if (!this.txHeldResources.has(txId)) {
      this.txHeldResources.set(txId, new Set());
    }
    this.txMetadata.set(txId, {
      workerId,
      state,
      priority,
      effectivePriority,
      fencingToken,
    });
  }

  public updateTransactionState(txId: string, state: TxState, effectivePriority?: number) {
    const meta = this.txMetadata.get(txId);
    if (meta) {
      meta.state = state;
      if (effectivePriority !== undefined) {
        meta.effectivePriority = effectivePriority;
      }
    }
  }

  /**
   * Record that a transaction holds a resource
   */
  public recordLockAcquired(resourceId: string, txId: string) {
    // If it was waiting for this resource, clear wait
    const waitingRes = this.txWaitingFor.get(txId);
    if (waitingRes === resourceId) {
      this.txWaitingFor.delete(txId);
    }

    const waiters = this.resourceWaiters.get(resourceId);
    if (waiters) {
      waiters.delete(txId);
    }

    // Set holder
    this.resourceHolders.set(resourceId, txId);

    let held = this.txHeldResources.get(txId);
    if (!held) {
      held = new Set();
      this.txHeldResources.set(txId, held);
    }
    held.add(resourceId);

    // Rebuild edges for anyone who was waiting on this resource
    this.rebuildTxEdgesForResource(resourceId);
  }

  /**
   * Record that a transaction is waiting for a resource held by another transaction.
   * Runs incremental cycle detection and returns result.
   */
  public recordLockWaiting(
    waiterTxId: string,
    resourceId: string,
    holderTxId: string
  ): CycleDetectionResult {
    const startHr = process.hrtime.bigint();

    this.txWaitingFor.set(waiterTxId, resourceId);

    let waiters = this.resourceWaiters.get(resourceId);
    if (!waiters) {
      waiters = new Set();
      this.resourceWaiters.set(resourceId, waiters);
    }
    waiters.add(waiterTxId);

    // Add direct dependency: waiterTxId -> holderTxId
    let edges = this.txWaitAdj.get(waiterTxId);
    if (!edges) {
      edges = new Set();
      this.txWaitAdj.set(waiterTxId, edges);
    }
    edges.add(holderTxId);

    // Incremental cycle detection:
    // Check if holderTxId can already reach waiterTxId!
    const cyclePath = this.findPath(holderTxId, waiterTxId);

    const endHr = process.hrtime.bigint();
    const latencyUs = Number(endHr - startHr) / 1000;

    if (cyclePath) {
      // We found a cycle: waiterTxId -> holderTxId -> ... -> waiterTxId
      const fullCycleTxIds = [waiterTxId, ...cyclePath];
      // Construct rich cycle explanation path with resources
      const richPath: string[] = [];
      const resourcesInvolved: string[] = [];

      for (let i = 0; i < fullCycleTxIds.length - 1; i++) {
        const fromTx = fullCycleTxIds[i];
        const toTx = fullCycleTxIds[i + 1];
        const res = this.txWaitingFor.get(fromTx) || 'resource';
        richPath.push(fromTx);
        richPath.push(res);
        if (!resourcesInvolved.includes(res)) {
          resourcesInvolved.push(res);
        }
      }
      richPath.push(fullCycleTxIds[fullCycleTxIds.length - 1]);

      // Record active cycle
      this.activeCycles = [fullCycleTxIds];

      return {
        hasCycle: true,
        cycleTxIds: fullCycleTxIds.slice(0, -1), // unique participants
        cyclePath: richPath,
        resourcesInvolved,
        latencyUs,
      };
    }

    return {
      hasCycle: false,
      cycleTxIds: [],
      cyclePath: [],
      resourcesInvolved: [],
      latencyUs,
    };
  }

  /**
   * Release a resource and update all dependencies
   */
  public recordLockReleased(resourceId: string, txId: string) {
    if (this.resourceHolders.get(resourceId) === txId) {
      this.resourceHolders.delete(resourceId);
    }

    const held = this.txHeldResources.get(txId);
    if (held) {
      held.delete(resourceId);
    }

    // Remove direct edges pointing to txId for this resource
    const waiters = this.resourceWaiters.get(resourceId);
    if (waiters) {
      for (const waiterId of waiters) {
        const edges = this.txWaitAdj.get(waiterId);
        if (edges) {
          edges.delete(txId);
        }
      }
    }

    this.clearCyclesIfBroken();
  }

  /**
   * Remove transaction completely from graph (e.g. on commit or rollback)
   */
  public removeTransaction(txId: string) {
    // Release all held resources
    const held = this.txHeldResources.get(txId);
    if (held) {
      for (const resId of [...held]) {
        this.recordLockReleased(resId, txId);
      }
    }

    // Clear waiting resource
    const waitingRes = this.txWaitingFor.get(txId);
    if (waitingRes) {
      const waiters = this.resourceWaiters.get(waitingRes);
      if (waiters) {
        waiters.delete(txId);
      }
      this.txWaitingFor.delete(txId);
    }

    // Remove all edges from and to this tx
    this.txWaitAdj.delete(txId);
    for (const [, edges] of this.txWaitAdj.entries()) {
      edges.delete(txId);
    }

    this.txMetadata.delete(txId);
    this.txHeldResources.delete(txId);

    this.clearCyclesIfBroken();
  }

  /**
   * Rebuilds tx -> tx wait edges when a resource holder changes
   */
  private rebuildTxEdgesForResource(resourceId: string) {
    const holder = this.resourceHolders.get(resourceId);
    const waiters = this.resourceWaiters.get(resourceId);

    if (!waiters) return;

    for (const waiter of waiters) {
      let edges = this.txWaitAdj.get(waiter);
      if (!edges) {
        edges = new Set();
        this.txWaitAdj.set(waiter, edges);
      }
      if (holder && holder !== waiter) {
        edges.add(holder);
      }
    }
  }

  /**
   * BFS reachability from startTx to targetTx.
   * Returns path array [startTx, ..., targetTx] if reachable, or null if not reachable.
   */
  public findPath(startTx: string, targetTx: string): string[] | null {
    if (startTx === targetTx) {
      return [startTx];
    }

    const queue: string[] = [startTx];
    const visited: Set<string> = new Set([startTx]);
    const parent: Map<string, string> = new Map();

    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = this.txWaitAdj.get(current);

      if (neighbors) {
        for (const next of neighbors) {
          if (next === targetTx) {
            // Reconstruct path
            const path: string[] = [targetTx];
            let curr = current;
            while (curr !== undefined) {
              path.unshift(curr);
              curr = parent.get(curr)!;
            }
            return path;
          }

          if (!visited.has(next)) {
            visited.add(next);
            parent.set(next, current);
            queue.push(next);
          }
        }
      }
    }

    return null;
  }

  /**
   * Scans the full graph for any cycles (used for verification and multiple cycle detection)
   */
  public detectAllCycles(): string[][] {
    const visited = new Map<string, number>(); // 0: unvisited, 1: visiting, 2: visited
    const parent = new Map<string, string>();
    const cycles: string[][] = [];

    const allTx = Array.from(this.txWaitAdj.keys());

    for (const tx of allTx) {
      visited.set(tx, 0);
    }

    const dfs = (node: string) => {
      visited.set(node, 1);
      const neighbors = this.txWaitAdj.get(node);

      if (neighbors) {
        for (const next of neighbors) {
          const state = visited.get(next) || 0;
          if (state === 1) {
            // Cycle detected!
            const cycle: string[] = [next];
            let curr = node;
            while (curr && curr !== next) {
              cycle.unshift(curr);
              curr = parent.get(curr)!;
            }
            cycle.unshift(next);
            cycles.push(cycle);
          } else if (state === 0) {
            parent.set(next, node);
            dfs(next);
          }
        }
      }
      visited.set(node, 2);
    };

    for (const tx of allTx) {
      if ((visited.get(tx) || 0) === 0) {
        dfs(tx);
      }
    }

    this.activeCycles = cycles;
    return cycles;
  }

  public clearCyclesIfBroken() {
    if (this.activeCycles.length === 0) return;

    // Verify if active cycles still exist
    const stillValidCycles: string[][] = [];
    for (const cycle of this.activeCycles) {
      let isIntact = true;
      for (let i = 0; i < cycle.length - 1; i++) {
        const u = cycle[i];
        const v = cycle[i + 1];
        const edges = this.txWaitAdj.get(u);
        if (!edges || !edges.has(v)) {
          isIntact = false;
          break;
        }
      }
      if (isIntact) {
        stillValidCycles.push(cycle);
      }
    }
    this.activeCycles = stillValidCycles;
  }

  /**
   * Generates a complete snapshot formatted for React Flow
   */
  public getSnapshot(): GraphSnapshot {
    const nodes: GraphSnapshot['nodes'] = [];
    const edges: GraphSnapshot['edges'] = [];

    // Collect all unique resources and transactions
    const allResources = new Set<string>([
      ...this.resourceHolders.keys(),
      ...this.resourceWaiters.keys(),
    ]);

    const allTx = new Set<string>([
      ...this.txMetadata.keys(),
      ...this.txWaitAdj.keys(),
    ]);

    // Active cycle set for fast edge highlighting
    const cycleEdgeKeys = new Set<string>();
    const cycleTxSet = new Set<string>();
    for (const cycle of this.activeCycles) {
      for (let i = 0; i < cycle.length - 1; i++) {
        cycleEdgeKeys.add(`${cycle[i]}->${cycle[i + 1]}`);
        cycleTxSet.add(cycle[i]);
      }
      if (cycle.length > 0) {
        cycleTxSet.add(cycle[cycle.length - 1]);
      }
    }

    // Position layout coordinates
    const txArray = Array.from(allTx);
    const resArray = Array.from(allResources);

    const radius = Math.max(180, (txArray.length + resArray.length) * 35);
    const centerX = 360;
    const centerY = 260;

    // Place Transactions in an outer or grouped circle
    txArray.forEach((txId, idx) => {
      const angle = (idx / Math.max(1, txArray.length)) * 2 * Math.PI;
      const x = centerX + radius * Math.cos(angle);
      const y = centerY + radius * Math.sin(angle);

      const meta = this.txMetadata.get(txId);
      const held = this.txHeldResources.get(txId);

      const isInCycle = cycleTxSet.has(txId);

      nodes.push({
        id: txId,
        type: 'transactionNode',
        position: { x: Math.round(x), y: Math.round(y) },
        data: {
          id: txId,
          nodeType: 'transaction',
          label: txId,
          state: meta?.state || 'RUNNING',
          workerId: meta?.workerId || 'w-0',
          priority: meta?.priority || 1,
          effectivePriority: meta?.effectivePriority || 1,
          locksCount: held ? held.size : 0,
          isInCycle,
          fencingToken: meta?.fencingToken,
        },
      });
    });

    // Place Resources in an inner circle
    resArray.forEach((resId, idx) => {
      const angle = ((idx + 0.5) / Math.max(1, resArray.length)) * 2 * Math.PI;
      const innerRadius = Math.max(90, radius * 0.45);
      const x = centerX + innerRadius * Math.cos(angle);
      const y = centerY + innerRadius * Math.sin(angle);

      const holder = this.resourceHolders.get(resId);
      const waiters = this.resourceWaiters.get(resId);

      nodes.push({
        id: resId,
        type: 'resourceNode',
        position: { x: Math.round(x), y: Math.round(y) },
        data: {
          id: resId,
          nodeType: 'resource',
          label: resId,
          holderTxId: holder,
          waitersCount: waiters ? waiters.size : 0,
        },
      });
    });

    // Generate edges:
    // 1. Transaction WAITING for Resource: txId -> resId
    for (const [resId, waiters] of this.resourceWaiters.entries()) {
      for (const waiterId of waiters) {
        const holderId = this.resourceHolders.get(resId);
        const isCycle = holderId ? cycleEdgeKeys.has(`${waiterId}->${holderId}`) : false;

        edges.push({
          id: `wait_${waiterId}_${resId}`,
          source: waiterId,
          target: resId,
          label: 'waits for',
          animated: true,
          style: {
            stroke: isCycle ? '#ef4444' : '#f59e0b',
            strokeWidth: isCycle ? 3 : 1.5,
            strokeDasharray: '4 4',
          },
          data: {
            id: `wait_${waiterId}_${resId}`,
            source: waiterId,
            target: resId,
            edgeType: 'waits_for',
            isCycle,
          },
        });
      }
    }

    // 2. Resource HELD by Transaction: resId -> txId
    for (const [resId, holderId] of this.resourceHolders.entries()) {
      // Check if this held resource is part of a cycle
      const isCycle = Array.from(cycleEdgeKeys).some(key => key.endsWith(`->${holderId}`));

      edges.push({
        id: `held_${resId}_${holderId}`,
        source: resId,
        target: holderId,
        label: 'held by',
        style: {
          stroke: isCycle ? '#ef4444' : '#10b981',
          strokeWidth: isCycle ? 3 : 2,
        },
        data: {
          id: `held_${resId}_${holderId}`,
          source: resId,
          target: holderId,
          edgeType: 'holds',
          isCycle,
        },
      });
    }

    return {
      nodes,
      edges,
      activeCycles: this.activeCycles,
    };
  }

  public reset() {
    this.txWaitAdj.clear();
    this.resourceHolders.clear();
    this.resourceWaiters.clear();
    this.txHeldResources.clear();
    this.txWaitingFor.clear();
    this.txMetadata.clear();
    this.activeCycles = [];
  }
}

export const waitForGraph = new WaitForGraph();
