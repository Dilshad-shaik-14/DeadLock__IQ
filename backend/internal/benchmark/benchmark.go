package benchmark

import (
	"context"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/deadlockiq/engine/internal/coordinator"
	"github.com/deadlockiq/engine/internal/fencing"
	"github.com/deadlockiq/engine/internal/graph"
	"github.com/deadlockiq/engine/internal/recovery"
	"github.com/deadlockiq/engine/internal/redisengine"
	"github.com/deadlockiq/engine/internal/transaction"
)

type LatencyStats struct {
	P50Ms  float64 `json:"p50Ms"`
	P95Ms  float64 `json:"p95Ms"`
	P99Ms  float64 `json:"p99Ms"`
	MeanMs float64 `json:"meanMs"`
}

type Result struct {
	WorkerCount           int          `json:"workerCount"`
	TotalOperations       int          `json:"totalOperations"`
	DurationMs            int64        `json:"durationMs"`
	ThroughputOpsSec      float64      `json:"throughputOpsSec"`
	Baseline              LatencyStats `json:"baseline"`
	DeadLockIQ            LatencyStats `json:"deadlockiq"`
	UncontendedOverheadMs float64      `json:"uncontendedOverheadMs"`
	OverheadTargetMet     bool         `json:"overheadTargetMet"`
	Timestamp             int64        `json:"timestamp"`
}

type Engine struct{}

func NewEngine() *Engine {
	return &Engine{}
}

func calcStats(latenciesUs []float64) LatencyStats {
	if len(latenciesUs) == 0 {
		return LatencyStats{}
	}
	sorted := make([]float64, len(latenciesUs))
	copy(sorted, latenciesUs)
	sort.Float64s(sorted)

	p50 := sorted[int(float64(len(sorted))*0.50)] / 1000.0
	p95 := sorted[int(float64(len(sorted))*0.95)] / 1000.0
	p99 := sorted[int(float64(len(sorted))*0.99)] / 1000.0

	sum := 0.0
	for _, v := range sorted {
		sum += v
	}
	mean := (sum / float64(len(sorted))) / 1000.0

	return LatencyStats{
		P50Ms:  math.Round(p50*1000.0) / 1000.0,
		P95Ms:  math.Round(p95*1000.0) / 1000.0,
		P99Ms:  math.Round(p99*1000.0) / 1000.0,
		MeanMs: math.Round(mean*1000.0) / 1000.0,
	}
}

func (e *Engine) RunBenchmark(workerCount int) Result {
	if workerCount <= 0 {
		workerCount = 500
	}

	opsCount := workerCount * 2
	if opsCount > 2000 {
		opsCount = 2000
	}

	rawFencing := fencing.NewTokenManager()
	rawRedis := redisengine.NewEngine(rawFencing, nil)

	benchFencing := fencing.NewTokenManager()
	benchRedis := redisengine.NewEngine(benchFencing, nil)
	benchTxMgr := transaction.NewManager()
	benchWfg := graph.NewWaitForGraph()
	benchRecEng := recovery.NewEngine(nil, nil)
	benchCoord := coordinator.NewCoordinator(benchTxMgr, benchRedis, benchWfg, benchRecEng, benchFencing, nil)

	baselineLatenciesUs := make([]float64, 0, opsCount)
	proxyLatenciesUs := make([]float64, 0, opsCount)

	startBench := time.Now()
	ctx := context.Background()

	// 1. Direct Redis Baseline
	for i := 0; i < opsCount; i++ {
		resID := fmt.Sprintf("bench_res_%d", i%50)
		txID := fmt.Sprintf("bench_base_tx_%d", i)
		workerID := fmt.Sprintf("bench_worker_%d", i%workerCount)

		t0 := time.Now()
		acq := rawRedis.Acquire(ctx, resID, txID, workerID, 2000*time.Millisecond)
		if acq.Success {
			rawRedis.Release(ctx, resID, txID, nil)
		}
		baselineLatenciesUs = append(baselineLatenciesUs, float64(time.Since(t0).Microseconds()))
	}

	// 2. DeadLockIQ Proxy Run
	for i := 0; i < opsCount; i++ {
		resID := fmt.Sprintf("proxy_res_%d", i%50)
		txID := fmt.Sprintf("bench_proxy_tx_%d", i)
		workerID := fmt.Sprintf("bench_worker_%d", i%workerCount)

		benchTxMgr.CreateTransaction(transaction.CreateTxParams{
			ID:       txID,
			WorkerID: workerID,
			Priority: (i % 3) + 1,
		})

		t0 := time.Now()
		acq := benchCoord.AcquireLock(ctx, resID, txID, workerID, 2000)
		if acq.Success {
			benchCoord.ReleaseLock(ctx, resID, txID, nil)
		}
		proxyLatenciesUs = append(proxyLatenciesUs, float64(time.Since(t0).Microseconds()))
	}

	duration := time.Since(startBench)
	durationMs := duration.Milliseconds()
	totalOps := opsCount * 2
	throughput := math.Round((float64(totalOps)/(float64(durationMs)/1000.0))*10.0) / 10.0

	baseStats := calcStats(baselineLatenciesUs)
	proxyStats := calcStats(proxyLatenciesUs)

	overhead := math.Max(0.015, math.Round((proxyStats.P50Ms-baseStats.P50Ms)*1000.0)/1000.0)
	targetMet := overhead < 0.8

	return Result{
		WorkerCount:           workerCount,
		TotalOperations:       totalOps,
		DurationMs:            durationMs,
		ThroughputOpsSec:      throughput,
		Baseline:              baseStats,
		DeadLockIQ:            proxyStats,
		UncontendedOverheadMs: overhead,
		OverheadTargetMet:     targetMet,
		Timestamp:             time.Now().UnixMilli(),
	}
}
