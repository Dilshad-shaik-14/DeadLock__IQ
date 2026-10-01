export type TxState =
  | 'CREATED'
  | 'WAITING'
  | 'ACQUIRED'
  | 'RUNNING'
  | 'COMMITTING'
  | 'COMPLETED'
  | 'DEADLOCK_DETECTED'
  | 'VICTIM_SELECTED'
  | 'ABORTING'
  | 'ROLLED_BACK'
  | 'BACKOFF'
  | 'RETRYING'
  | 'FAILED';

export interface TxHistoryEntry {
  state: TxState;
  timestamp: number;
  reason?: string;
}

export interface Transaction {
  id: string;
  workerId: string;
  priority: number;
  effectivePriority: number;
  state: TxState;
  locksHeld: string[];
  waitingForLock?: string;
  fencingToken?: number;
  workDoneUnits: number;
  rollbackCost: number;
  retryCount: number;
  maxRetries: number;
  createdAt: number;
  updatedAt: number;
  retryScheduledAt?: number;
  history: TxHistoryEntry[];
}

export interface LockRecord {
  resourceId: string;
  holderTxId: string;
  holderWorkerId: string;
  fencingToken: number;
  acquiredAt: number;
  expiresAt: number;
  ttlMs: number;
  waitingTxIds: string[];
}

export interface GraphNodeData {
  [key: string]: unknown;
  id: string;
  nodeType: 'transaction' | 'resource';
  label: string;
  state?: TxState;
  workerId?: string;
  priority?: number;
  effectivePriority?: number;
  locksCount?: number;
  isInCycle?: boolean;
  isVictim?: boolean;
  holderTxId?: string;
  fencingToken?: number;
  waitersCount?: number;
}

export interface GraphEdgeData {
  [key: string]: unknown;
  id: string;
  source: string;
  target: string;
  edgeType: 'holds' | 'waits_for';
  isCycle?: boolean;
}

export interface GraphSnapshot {
  nodes: {
    id: string;
    type: 'transactionNode' | 'resourceNode';
    position: { x: number; y: number };
    data: GraphNodeData;
  }[];
  edges: {
    id: string;
    source: string;
    target: string;
    label?: string;
    animated?: boolean;
    style?: Record<string, any>;
    data: GraphEdgeData;
  }[];
  activeCycles: string[][];
}

export interface IncidentFactorBreakdown {
  effectivePriority: number;
  agingBonus: number;
  locksHeld: number;
  workDoneUnits: number;
  rollbackCost: number;
  retryCount: number;
}

export interface CandidateScore {
  txId: string;
  score: number;
  reason: string;
}

export interface DeadlockIncident {
  id: string;
  timestamp: number;
  cycleTxIds: string[];
  cyclePath: string[];
  resourcesInvolved: string[];
  detectionLatencyMs: number;
  victimId: string;
  victimScore: number;
  factors: IncidentFactorBreakdown;
  explanation: string;
  alternativeCandidates: CandidateScore[];
  timeline: {
    step: 'DETECTED' | 'VICTIM_SELECTED' | 'ROLLBACK_STARTED' | 'LOCKS_RELEASED' | 'BACKOFF_SCHEDULED' | 'RETRY_STARTED' | 'RECOVERED' | 'FAILED';
    timestamp: number;
    details?: string;
  }[];
  status: 'DETECTED' | 'RESOLVING' | 'RESOLVED' | 'FAILED';
}

export interface PostgresLockRecord {
  pid: number;
  database: string;
  relation: string;
  locktype: string;
  mode: string;
  granted: boolean;
  transactionId?: string;
  query: string;
  queryStart: string;
  waitingForPid?: number;
}

export interface MetricSnapshot {
  activeTransactions: number;
  waitingTransactions: number;
  locksHeld: number;
  deadlocksDetected: number;
  recoveriesSuccessful: number;
  retriesScheduled: number;
  failuresTotal: number;
  fencingViolationsDetected: number;
  uncontendedLatencyP50: number;
  uncontendedLatencyP95: number;
  uncontendedLatencyP99: number;
  deadlockDetectionLatencyP50: number;
  deadlockDetectionLatencyP95: number;
  deadlockDetectionLatencyP99: number;
  recoveryLatencyP50: number;
  recoveryLatencyP95: number;
  recoveryLatencyP99: number;
  throughputOpsPerSec: number;
  wsConnections: number;
  redisStatus: 'CONNECTED' | 'DEGRADED' | 'FAILED';
  postgresStatus: 'CONNECTED' | 'SIMULATING' | 'FAILED';
}

export type WSEventType =
  | 'INIT_STATE'
  | 'TRANSACTION_CREATED'
  | 'LOCK_REQUESTED'
  | 'LOCK_ACQUIRED'
  | 'LOCK_RELEASED'
  | 'LOCK_WAITING'
  | 'GRAPH_EDGE_ADDED'
  | 'GRAPH_EDGE_REMOVED'
  | 'DEADLOCK_DETECTED'
  | 'INCIDENT_UPDATED'
  | 'INCIDENT_RESOLVED'
  | 'VICTIM_SELECTED'
  | 'ROLLBACK_STARTED'
  | 'ROLLBACK_COMPLETED'
  | 'RETRY_SCHEDULED'
  | 'RETRY_STARTED'
  | 'TRANSACTION_RECOVERED'
  | 'TRANSACTION_FAILED'
  | 'FENCING_VIOLATION'
  | 'METRICS_UPDATED'
  | 'SYSTEM_HEALTH_CHANGED'
  | 'LOG_EVENT';

export interface WebSocketEvent {
  type: WSEventType;
  payload: any;
  timestamp: number;
}
