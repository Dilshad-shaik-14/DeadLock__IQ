package types

type TxState string

const (
	TxCreated          TxState = "CREATED"
	TxWaiting          TxState = "WAITING"
	TxAcquired         TxState = "ACQUIRED"
	TxRunning          TxState = "RUNNING"
	TxCommitting       TxState = "COMMITTING"
	TxCompleted        TxState = "COMPLETED"
	TxDeadlockDetected TxState = "DEADLOCK_DETECTED"
	TxVictimSelected   TxState = "VICTIM_SELECTED"
	TxAborting         TxState = "ABORTING"
	TxRolledBack       TxState = "ROLLED_BACK"
	TxBackoff          TxState = "BACKOFF"
	TxRetrying         TxState = "RETRYING"
	TxFailed           TxState = "FAILED"
)

type TxHistoryEntry struct {
	State     TxState `json:"state"`
	Timestamp int64   `json:"timestamp"`
	Reason    string  `json:"reason,omitempty"`
}

type Transaction struct {
	ID                string           `json:"id"`
	WorkerID          string           `json:"workerId"`
	Priority          int              `json:"priority"`
	EffectivePriority float64          `json:"effectivePriority"`
	State             TxState          `json:"state"`
	LocksHeld         []string         `json:"locksHeld"`
	WaitingForLock    string           `json:"waitingForLock,omitempty"`
	FencingToken      *uint64          `json:"fencingToken,omitempty"`
	WorkDoneUnits     int              `json:"workDoneUnits"`
	RollbackCost      int              `json:"rollbackCost"`
	RetryCount        int              `json:"retryCount"`
	MaxRetries        int              `json:"maxRetries"`
	CreatedAt         int64            `json:"createdAt"`
	UpdatedAt         int64            `json:"updatedAt"`
	RetryScheduledAt  int64            `json:"retryScheduledAt,omitempty"`
	History           []TxHistoryEntry `json:"history"`
}

type LockRecord struct {
	ResourceID     string   `json:"resourceId"`
	HolderTxID     string   `json:"holderTxId"`
	HolderWorkerID string   `json:"holderWorkerId"`
	FencingToken   uint64   `json:"fencingToken"`
	AcquiredAt     int64    `json:"acquiredAt"`
	ExpiresAt      int64    `json:"expiresAt"`
	TTLMs          int      `json:"ttlMs"`
	WaitingTxIDs   []string `json:"waitingTxIds"`
}

type GraphNodeData struct {
	ID                string  `json:"id"`
	NodeType          string  `json:"nodeType"` // "transaction" | "resource"
	Label             string  `json:"label"`
	State             TxState `json:"state,omitempty"`
	WorkerID          string  `json:"workerId,omitempty"`
	Priority          int     `json:"priority,omitempty"`
	EffectivePriority float64 `json:"effectivePriority,omitempty"`
	LocksCount        int     `json:"locksCount,omitempty"`
	IsInCycle         bool    `json:"isInCycle,omitempty"`
	IsVictim          bool    `json:"isVictim,omitempty"`
	HolderTxID        string  `json:"holderTxId,omitempty"`
	FencingToken      *uint64 `json:"fencingToken,omitempty"`
	WaitersCount      int     `json:"waitersCount,omitempty"`
}

type GraphPosition struct {
	X int `json:"x"`
	Y int `json:"y"`
}

type GraphNode struct {
	ID       string        `json:"id"`
	Type     string        `json:"type"` // "transactionNode" | "resourceNode"
	Position GraphPosition `json:"position"`
	Data     GraphNodeData `json:"data"`
}

type GraphEdgeData struct {
	ID       string `json:"id"`
	Source   string `json:"source"`
	Target   string `json:"target"`
	EdgeType string `json:"edgeType"` // "holds" | "waits_for"
	IsCycle  bool   `json:"isCycle"`
}

type GraphEdge struct {
	ID        string                 `json:"id"`
	Source    string                 `json:"source"`
	Target    string                 `json:"target"`
	Label     string                 `json:"label,omitempty"`
	Animated  bool                   `json:"animated"`
	Style     map[string]interface{} `json:"style,omitempty"`
	Data      GraphEdgeData          `json:"data"`
}

type GraphSnapshot struct {
	Nodes        []GraphNode   `json:"nodes"`
	Edges        []GraphEdge   `json:"edges"`
	ActiveCycles [][]string    `json:"activeCycles"`
}

type IncidentFactorBreakdown struct {
	EffectivePriority float64 `json:"effectivePriority"`
	AgingBonus        float64 `json:"agingBonus"`
	LocksHeld         int     `json:"locksHeld"`
	WorkDoneUnits     int     `json:"workDoneUnits"`
	RollbackCost      int     `json:"rollbackCost"`
	RetryCount        int     `json:"retryCount"`
}

type CandidateScore struct {
	TxID   string  `json:"txId"`
	Score  float64 `json:"score"`
	Reason string  `json:"reason"`
}

type IncidentTimelineStep struct {
	Step      string `json:"step"`
	Timestamp int64  `json:"timestamp"`
	Details   string `json:"details,omitempty"`
}

type DeadlockIncident struct {
	ID                    string                  `json:"id"`
	Timestamp             int64                   `json:"timestamp"`
	CycleTxIDs            []string                `json:"cycleTxIds"`
	CyclePath             []string                `json:"cyclePath"`
	ResourcesInvolved     []string                `json:"resourcesInvolved"`
	DetectionLatencyMs    float64                 `json:"detectionLatencyMs"`
	VictimID              string                  `json:"victimId"`
	VictimScore           float64                 `json:"victimScore"`
	Factors               IncidentFactorBreakdown `json:"factors"`
	Explanation           string                  `json:"explanation"`
	AlternativeCandidates []CandidateScore        `json:"alternativeCandidates"`
	Timeline              []IncidentTimelineStep  `json:"timeline"`
	Status                string                  `json:"status"` // "DETECTED" | "RESOLVING" | "RESOLVED" | "FAILED"
}

type PostgresLockRecord struct {
	PID           int    `json:"pid"`
	Database      string `json:"database"`
	Relation      string `json:"relation"`
	LockType      string `json:"locktype"`
	Mode          string `json:"mode"`
	Granted       bool   `json:"granted"`
	TransactionID string `json:"transactionId,omitempty"`
	Query         string `json:"query"`
	QueryStart    string `json:"queryStart"`
	WaitingForPID int    `json:"waitingForPid,omitempty"`
}

type MetricSnapshot struct {
	ActiveTransactions         int     `json:"activeTransactions"`
	WaitingTransactions        int     `json:"waitingTransactions"`
	LocksHeld                  int     `json:"locksHeld"`
	DeadlocksDetected          int     `json:"deadlocksDetected"`
	RecoveriesSuccessful       int     `json:"recoveriesSuccessful"`
	RetriesScheduled           int     `json:"retriesScheduled"`
	FailuresTotal              int     `json:"failuresTotal"`
	FencingViolationsDetected  int     `json:"fencingViolationsDetected"`
	UncontendedLatencyP50      float64 `json:"uncontendedLatencyP50"`
	UncontendedLatencyP95      float64 `json:"uncontendedLatencyP95"`
	UncontendedLatencyP99      float64 `json:"uncontendedLatencyP99"`
	DeadlockDetectionLatencyP50 float64 `json:"deadlockDetectionLatencyP50"`
	DeadlockDetectionLatencyP95 float64 `json:"deadlockDetectionLatencyP95"`
	DeadlockDetectionLatencyP99 float64 `json:"deadlockDetectionLatencyP99"`
	RecoveryLatencyP50         float64 `json:"recoveryLatencyP50"`
	RecoveryLatencyP95         float64 `json:"recoveryLatencyP95"`
	RecoveryLatencyP99         float64 `json:"recoveryLatencyP99"`
	ThroughputOpsPerSec        float64 `json:"throughputOpsPerSec"`
	WSConnections              int     `json:"wsConnections"`
	RedisStatus                string  `json:"redisStatus"`    // "CONNECTED" | "DEGRADED" | "FAILED"
	PostgresStatus             string  `json:"postgresStatus"` // "CONNECTED" | "SIMULATING" | "FAILED"
}

type WSEvent struct {
	Type      string      `json:"type"`
	Payload   interface{} `json:"payload"`
	Timestamp int64       `json:"timestamp"`
}
