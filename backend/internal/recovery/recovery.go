package recovery

import (
	"fmt"
	"math"
	"math/rand"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/deadlockiq/engine/internal/types"
)

type VictimSelectionResult struct {
	VictimTxID           string
	VictimScore          float64
	Factors              types.IncidentFactorBreakdown
	Explanation          string
	AlternativeCandidates []types.CandidateScore
}

func CalculateAgingBonus(tx types.Transaction) float64 {
	elapsed := time.Now().UnixMilli() - tx.CreatedAt
	return math.Min(10.0, math.Floor(float64(elapsed)/1200.0))
}

type scoredCandidate struct {
	tx                types.Transaction
	effectivePriority float64
	agingBonus        float64
	score             float64
}

func SelectVictim(cycleTxList []types.Transaction) VictimSelectionResult {
	if len(cycleTxList) == 0 {
		return VictimSelectionResult{
			VictimTxID:  "",
			Explanation: "No cycle participants found",
		}
	}

	if len(cycleTxList) == 1 {
		single := cycleTxList[0]
		agingBonus := CalculateAgingBonus(single)
		effPriority := float64(single.Priority) + agingBonus
		return VictimSelectionResult{
			VictimTxID:  single.ID,
			VictimScore: 10.0,
			Factors: types.IncidentFactorBreakdown{
				EffectivePriority: effPriority,
				AgingBonus:        agingBonus,
				LocksHeld:         len(single.LocksHeld),
				WorkDoneUnits:     single.WorkDoneUnits,
				RollbackCost:      single.RollbackCost,
				RetryCount:        single.RetryCount,
			},
			Explanation:           fmt.Sprintf("Transaction %s was the sole participant in self-referencing lock dependency.", single.ID),
			AlternativeCandidates: make([]types.CandidateScore, 0),
		}
	}

	candidates := make([]scoredCandidate, len(cycleTxList))
	for i, tx := range cycleTxList {
		agingBonus := CalculateAgingBonus(tx)
		effPriority := float64(tx.Priority) + agingBonus

		survivalScore := (effPriority * 5.0) +
			(float64(len(tx.LocksHeld)) * 4.0) +
			(float64(tx.WorkDoneUnits) * 2.0) +
			(float64(tx.RetryCount) * 15.0) -
			(float64(tx.RollbackCost) * 1.5)

		roundedScore := math.Round(survivalScore*10.0) / 10.0
		candidates[i] = scoredCandidate{
			tx:                tx,
			effectivePriority: effPriority,
			agingBonus:        agingBonus,
			score:             roundedScore,
		}
	}

	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].score < candidates[j].score
	})

	chosen := candidates[0]
	victimTx := chosen.tx

	alternatives := make([]types.CandidateScore, 0, len(candidates)-1)
	altNames := make([]string, 0, len(candidates)-1)
	for _, c := range candidates[1:] {
		alternatives = append(alternatives, types.CandidateScore{
			TxID:  c.tx.ID,
			Score: c.score,
			Reason: fmt.Sprintf("Effective priority %.1f, %d locks held, %d work units, %d prior retries",
				c.effectivePriority, len(c.tx.LocksHeld), c.tx.WorkDoneUnits, c.tx.RetryCount),
		})
		altNames = append(altNames, c.tx.ID)
	}

	cycleTxIDs := make([]string, len(cycleTxList))
	for i, t := range cycleTxList {
		cycleTxIDs[i] = t.ID
	}

	explanation := fmt.Sprintf(
		"Transaction %s selected as victim (score: %.1f) because it has the lowest rollback penalty among cycle participants [%s]. "+
			"It holds %d lock(s), has completed %d units of work, effective priority %.1f (base %d + %.1f aging bonus), "+
			"and has %d prior retries, making its cancellation less costly than %s.",
		victimTx.ID,
		chosen.score,
		strings.Join(cycleTxIDs, ", "),
		len(victimTx.LocksHeld),
		victimTx.WorkDoneUnits,
		chosen.effectivePriority,
		victimTx.Priority,
		chosen.agingBonus,
		victimTx.RetryCount,
		strings.Join(altNames, ", "),
	)

	return VictimSelectionResult{
		VictimTxID:  victimTx.ID,
		VictimScore: chosen.score,
		Factors: types.IncidentFactorBreakdown{
			EffectivePriority: chosen.effectivePriority,
			AgingBonus:        chosen.agingBonus,
			LocksHeld:         len(victimTx.LocksHeld),
			WorkDoneUnits:     victimTx.WorkDoneUnits,
			RollbackCost:      victimTx.RollbackCost,
			RetryCount:        victimTx.RetryCount,
		},
		Explanation:           explanation,
		AlternativeCandidates: alternatives,
	}
}

type IncidentCallback func(incident types.DeadlockIncident)
type RetryCallback func(txID string, retryCount int)

type Engine struct {
	mu                sync.RWMutex
	incidents         map[string]*types.DeadlockIncident
	incidentCounter   int
	pendingRetries    map[string]*time.Timer
	onIncidentUpdated IncidentCallback
	onRetryTriggered  RetryCallback
}

func NewEngine(onUpdated IncidentCallback, onRetry RetryCallback) *Engine {
	return &Engine{
		incidents:         make(map[string]*types.DeadlockIncident),
		incidentCounter:   1000,
		pendingRetries:    make(map[string]*time.Timer),
		onIncidentUpdated: onUpdated,
		onRetryTriggered:  onRetry,
	}
}

func (e *Engine) CreateIncident(cycleTxIDs, cyclePath, resourcesInvolved []string, latencyMs float64, victimRes VictimSelectionResult) *types.DeadlockIncident {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.incidentCounter++
	incID := fmt.Sprintf("INC-%d", e.incidentCounter)
	now := time.Now().UnixMilli()

	if cycleTxIDs == nil {
		cycleTxIDs = make([]string, 0)
	}
	if cyclePath == nil {
		cyclePath = make([]string, 0)
	}
	if resourcesInvolved == nil {
		resourcesInvolved = make([]string, 0)
	}
	altCandidates := victimRes.AlternativeCandidates
	if altCandidates == nil {
		altCandidates = make([]types.CandidateScore, 0)
	}

	inc := &types.DeadlockIncident{
		ID:                    incID,
		Timestamp:             now,
		CycleTxIDs:            cycleTxIDs,
		CyclePath:             cyclePath,
		ResourcesInvolved:     resourcesInvolved,
		DetectionLatencyMs:    latencyMs,
		VictimID:              victimRes.VictimTxID,
		VictimScore:           victimRes.VictimScore,
		Factors:               victimRes.Factors,
		Explanation:           victimRes.Explanation,
		AlternativeCandidates: altCandidates,
		Timeline: []types.IncidentTimelineStep{
			{
				Step:      "DETECTED",
				Timestamp: now,
				Details:   fmt.Sprintf("Cycle of %d transactions identified in %.2fms", len(cycleTxIDs), latencyMs),
			},
			{
				Step:      "VICTIM_SELECTED",
				Timestamp: time.Now().UnixMilli(),
				Details:   fmt.Sprintf("Selected %s: %s", victimRes.VictimTxID, victimRes.Explanation),
			},
		},
		Status: "DETECTED",
	}

	e.incidents[inc.ID] = inc
	if e.onIncidentUpdated != nil {
		go e.onIncidentUpdated(*inc)
	}
	return inc
}

func (e *Engine) AddTimelineStep(incID, step, details string) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if inc, ok := e.incidents[incID]; ok {
		inc.Timeline = append(inc.Timeline, types.IncidentTimelineStep{
			Step:      step,
			Timestamp: time.Now().UnixMilli(),
			Details:   details,
		})
		if step == "RECOVERED" {
			inc.Status = "RESOLVED"
		} else if step == "ROLLBACK_STARTED" {
			inc.Status = "RESOLVING"
		} else if step == "FAILED" {
			inc.Status = "FAILED"
		}
		if e.onIncidentUpdated != nil {
			go e.onIncidentUpdated(*inc)
		}
	}
}

func (e *Engine) CalculateBackoff(retryCount int) time.Duration {
	baseDelay := 200.0
	maxDelay := 3000.0
	exponential := math.Min(maxDelay, baseDelay*math.Pow(2, float64(retryCount)))
	jitter := float64(rand.Intn(100))
	return time.Duration(exponential+jitter) * time.Millisecond
}

func (e *Engine) ScheduleRetry(txID string, delay time.Duration, task func()) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if oldTimer, ok := e.pendingRetries[txID]; ok {
		oldTimer.Stop()
	}

	timer := time.AfterFunc(delay, func() {
		e.mu.Lock()
		delete(e.pendingRetries, txID)
		e.mu.Unlock()
		task()
	})
	e.pendingRetries[txID] = timer
}

func (e *Engine) GetAllIncidents() []types.DeadlockIncident {
	e.mu.RLock()
	defer e.mu.RUnlock()

	result := make([]types.DeadlockIncident, 0, len(e.incidents))
	for _, inc := range e.incidents {
		result = append(result, *inc)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].Timestamp > result[j].Timestamp
	})
	return result
}

func (e *Engine) GetIncident(id string) (types.DeadlockIncident, bool) {
	e.mu.RLock()
	defer e.mu.RUnlock()

	inc, ok := e.incidents[id]
	if !ok {
		return types.DeadlockIncident{}, false
	}
	return *inc, true
}

func (e *Engine) Reset() {
	e.mu.Lock()
	defer e.mu.Unlock()

	for _, t := range e.pendingRetries {
		t.Stop()
	}
	e.pendingRetries = make(map[string]*time.Timer)
	e.incidents = make(map[string]*types.DeadlockIncident)
	e.incidentCounter = 1000
}
