package main

import (
	"fmt"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/deadlockiq/engine/internal/benchmark"
	"github.com/deadlockiq/engine/internal/coordinator"
	"github.com/deadlockiq/engine/internal/fencing"
	"github.com/deadlockiq/engine/internal/graph"
	"github.com/deadlockiq/engine/internal/metrics"
	"github.com/deadlockiq/engine/internal/postgres"
	"github.com/deadlockiq/engine/internal/recovery"
	"github.com/deadlockiq/engine/internal/redisengine"
	"github.com/deadlockiq/engine/internal/simulator"
	"github.com/deadlockiq/engine/internal/transaction"
	"github.com/deadlockiq/engine/internal/types"
	"github.com/deadlockiq/engine/internal/websocket"
	"github.com/gin-gonic/gin"
)

var (
	startTime = time.Now()
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}

	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Recovery())

	// Core Singletons
	fencingMgr := fencing.NewTokenManager()
	txMgr := transaction.NewManager()
	wfg := graph.NewWaitForGraph()
	pgMonitor := postgres.NewMonitor()

	var hub *websocket.Hub
	hub = websocket.NewHub(func(count int) {})
	go hub.Run()

	var metricsMgr *metrics.Manager

	recEng := recovery.NewEngine(
		func(inc types.DeadlockIncident) {
			hub.BroadcastEvent("DEADLOCK_DETECTED", inc)
			hub.BroadcastEvent("INCIDENT_UPDATED", inc)
			if metricsMgr != nil {
				hub.BroadcastEvent("METRICS_UPDATED", metricsMgr.GetSnapshot())
			}
		},
		func(txID string, retryCount int) {
			hub.BroadcastEvent("RETRY_STARTED", gin.H{
				"txId":       txID,
				"retryCount": retryCount,
			})
		},
	)

	redisEng := redisengine.NewEngine(fencingMgr, func(expired types.LockRecord) {
		wfg.RecordLockReleased(expired.ResourceID, expired.HolderTxID)
		txMgr.RemoveLockHeld(expired.HolderTxID, expired.ResourceID)
		hub.BroadcastEvent("LOCK_RELEASED", gin.H{
			"resourceId": expired.ResourceID,
			"txId":       expired.HolderTxID,
			"expired":    true,
		})
	})

	coord := coordinator.NewCoordinator(
		txMgr,
		redisEng,
		wfg,
		recEng,
		fencingMgr,
		func(eventType, resourceID, txID string, details interface{}) {
			if eventType == "DEADLOCK_DETECTED" {
				if inc, ok := details.(*types.DeadlockIncident); ok && inc != nil {
					hub.BroadcastEvent("DEADLOCK_DETECTED", *inc)
				}
			} else {
				hub.BroadcastEvent(eventType, gin.H{
					"type":       eventType,
					"resourceId": resourceID,
					"txId":       txID,
					"details":    details,
				})
			}
			hub.BroadcastEvent("GRAPH_EDGE_ADDED", wfg.GetSnapshot())
			if metricsMgr != nil {
				hub.BroadcastEvent("METRICS_UPDATED", metricsMgr.GetSnapshot())
			}
		},
	)

	metricsMgr = metrics.NewManager(txMgr, redisEng, fencingMgr, pgMonitor)

	txMgr.SetOnStateChange(func(tx types.Transaction, oldState, newState types.TxState) {
		hub.BroadcastEvent("TRANSACTION_CREATED", gin.H{
			"tx":       tx,
			"oldState": oldState,
			"newState": newState,
		})
		hub.BroadcastEvent("METRICS_UPDATED", metricsMgr.GetSnapshot())
	})

	sim := simulator.NewSimulator(
		coord,
		txMgr,
		redisEng,
		wfg,
		recEng,
		fencingMgr,
		pgMonitor,
		metricsMgr,
		func(message, level string) {
			hub.BroadcastEvent("LOG_EVENT", gin.H{
				"message":   message,
				"level":     level,
				"timestamp": time.Now().UnixMilli(),
			})
		},
	)

	benchEng := benchmark.NewEngine()

	// Periodic graph sync broadcast
	go func() {
		ticker := time.NewTicker(1 * time.Second)
		for range ticker.C {
			hub.BroadcastEvent("GRAPH_EDGE_ADDED", wfg.GetSnapshot())
			hub.BroadcastEvent("METRICS_UPDATED", metricsMgr.GetSnapshot())
		}
	}()

	// WebSocket Route (/ws)
	router.GET("/ws", func(c *gin.Context) {
		hub.HandleWebSocket(c.Writer, c.Request, func() interface{} {
			return gin.H{
				"transactions": txMgr.GetAllTransactions(),
				"locks":        redisEng.GetAllLocks(),
				"graph":        wfg.GetSnapshot(),
				"incidents":    recEng.GetAllIncidents(),
				"metrics":      metricsMgr.GetSnapshot(),
				"postgresLocks": pgMonitor.GetObservedLocks(),
			}
		})
	})

	// Health Check
	router.GET("/api/v1/health", func(c *gin.Context) {
		redisStatus := "OK"
		if !redisEng.IsHealthy() {
			redisStatus = "DEGRADED"
		}
		c.JSON(http.StatusOK, gin.H{
			"status":           "HEALTHY",
			"service":          "DeadLockIQ Distributed Concurrency Engine (Go)",
			"uptime":           time.Since(startTime).Seconds(),
			"timestamp":        time.Now().UnixMilli(),
			"redis":            redisStatus,
			"postgresObserver": pgMonitor.GetStatus(),
			"activeWorkers":    0,
		})
	})

	// Prometheus Metrics
	router.GET("/metrics", func(c *gin.Context) {
		c.Header("Content-Type", "text/plain; version=0.0.4")
		c.String(http.StatusOK, metricsMgr.ToPrometheusFormat())
	})

	// Metrics Snapshot
	router.GET("/api/v1/metrics", func(c *gin.Context) {
		c.JSON(http.StatusOK, metricsMgr.GetSnapshot())
	})

	// Transactions API
	router.GET("/api/v1/transactions", func(c *gin.Context) {
		txs := txMgr.GetAllTransactions()
		c.JSON(http.StatusOK, gin.H{
			"transactions": txs,
			"total":        len(txs),
		})
	})

	router.GET("/api/v1/transactions/:id", func(c *gin.Context) {
		id := c.Param("id")
		tx, exists := txMgr.GetTransaction(id)
		if !exists {
			c.JSON(http.StatusNotFound, gin.H{"error": "Transaction not found"})
			return
		}
		c.JSON(http.StatusOK, tx)
	})

	router.POST("/api/v1/transactions", func(c *gin.Context) {
		var req struct {
			ID            string `json:"id"`
			WorkerID      string `json:"workerId"`
			Priority      int    `json:"priority"`
			MaxRetries    int    `json:"maxRetries"`
			WorkDoneUnits int    `json:"workDoneUnits"`
			RollbackCost  int    `json:"rollbackCost"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || req.ID == "" || req.WorkerID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "id and workerId are required"})
			return
		}
		tx := txMgr.CreateTransaction(transaction.CreateTxParams{
			ID:            req.ID,
			WorkerID:      req.WorkerID,
			Priority:      req.Priority,
			MaxRetries:    req.MaxRetries,
			WorkDoneUnits: req.WorkDoneUnits,
			RollbackCost:  req.RollbackCost,
		})
		c.JSON(http.StatusCreated, tx)
	})

	// Locks API
	router.POST("/api/v1/locks/acquire", func(c *gin.Context) {
		var req struct {
			ResourceID string `json:"resourceId"`
			TxID       string `json:"txId"`
			WorkerID   string `json:"workerId"`
			TTLMs      int    `json:"ttlMs"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || req.ResourceID == "" || req.TxID == "" || req.WorkerID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "resourceId, txId, and workerId are required"})
			return
		}
		res := coord.AcquireLock(c.Request.Context(), req.ResourceID, req.TxID, req.WorkerID, req.TTLMs)
		c.JSON(http.StatusOK, res)
	})

	router.POST("/api/v1/locks/release", func(c *gin.Context) {
		var req struct {
			ResourceID   string  `json:"resourceId"`
			TxID         string  `json:"txId"`
			FencingToken *uint64 `json:"fencingToken"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || req.ResourceID == "" || req.TxID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "resourceId and txId are required"})
			return
		}
		res := coord.ReleaseLock(c.Request.Context(), req.ResourceID, req.TxID, req.FencingToken)
		c.JSON(http.StatusOK, res)
	})

	// Graph API
	router.GET("/api/v1/graph", func(c *gin.Context) {
		c.JSON(http.StatusOK, wfg.GetSnapshot())
	})

	// Deadlocks API
	router.GET("/api/v1/deadlocks", func(c *gin.Context) {
		incidents := recEng.GetAllIncidents()
		c.JSON(http.StatusOK, gin.H{
			"incidents": incidents,
			"total":     len(incidents),
		})
	})

	router.GET("/api/v1/deadlocks/:id", func(c *gin.Context) {
		id := c.Param("id")
		inc, exists := recEng.GetIncident(id)
		if !exists {
			c.JSON(http.StatusNotFound, gin.H{"error": "Incident not found"})
			return
		}
		c.JSON(http.StatusOK, inc)
	})

	router.POST("/api/v1/deadlocks/:id/resolve", func(c *gin.Context) {
		id := c.Param("id")
		resolvedInc, err := coord.ResolveDeadlock(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"success": false,
				"error":   err.Error(),
			})
			return
		}
		hub.BroadcastEvent("DEADLOCK_DETECTED", *resolvedInc)
		hub.BroadcastEvent("INCIDENT_RESOLVED", *resolvedInc)
		hub.BroadcastEvent("GRAPH_EDGE_ADDED", wfg.GetSnapshot())
		hub.BroadcastEvent("METRICS_UPDATED", metricsMgr.GetSnapshot())

		c.JSON(http.StatusOK, gin.H{
			"success":  true,
			"message":  fmt.Sprintf("Deadlock incident %s resolved successfully", resolvedInc.ID),
			"incident": resolvedInc,
		})
	})

	router.POST("/api/v1/deadlocks/resolve", func(c *gin.Context) {
		resolvedInc, err := coord.ResolveDeadlock(c.Request.Context(), "latest")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"success": false,
				"error":   err.Error(),
			})
			return
		}
		hub.BroadcastEvent("DEADLOCK_DETECTED", *resolvedInc)
		hub.BroadcastEvent("INCIDENT_RESOLVED", *resolvedInc)
		hub.BroadcastEvent("GRAPH_EDGE_ADDED", wfg.GetSnapshot())
		hub.BroadcastEvent("METRICS_UPDATED", metricsMgr.GetSnapshot())

		c.JSON(http.StatusOK, gin.H{
			"success":  true,
			"message":  fmt.Sprintf("Deadlock incident %s resolved successfully", resolvedInc.ID),
			"incident": resolvedInc,
		})
	})

	// PostgreSQL Lock Observer API
	router.GET("/api/v1/postgres/locks", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"locks":       pgMonitor.GetObservedLocks(),
			"hasDeadlock": pgMonitor.IsDeadlockObserved(),
			"status":      pgMonitor.GetStatus(),
		})
	})

	// Simulator API
	router.POST("/api/v1/simulator/scenarios/:scenario", func(c *gin.Context) {
		scenario := c.Param("scenario")
		res := sim.RunScenario(c.Request.Context(), scenario)
		c.JSON(http.StatusOK, res)
	})

	router.POST("/api/v1/simulator/reset", func(c *gin.Context) {
		sim.ResetAll()
		hub.BroadcastEvent("INIT_STATE", gin.H{
			"transactions":  []types.Transaction{},
			"locks":         []types.LockRecord{},
			"graph":         wfg.GetSnapshot(),
			"incidents":     []types.DeadlockIncident{},
			"metrics":       metricsMgr.GetSnapshot(),
			"postgresLocks": pgMonitor.GetObservedLocks(),
		})
		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"message": "All engine state, locks, and graphs reset successfully",
		})
	})

	// Benchmark API
	router.POST("/api/v1/benchmark/run", func(c *gin.Context) {
		var req struct {
			Workers interface{} `json:"workers"`
		}
		workerCount := 500
		if err := c.ShouldBindJSON(&req); err == nil && req.Workers != nil {
			switch v := req.Workers.(type) {
			case float64:
				workerCount = int(v)
			case string:
				if parsed, err := strconv.Atoi(v); err == nil {
					workerCount = parsed
				}
			}
		}
		result := benchEng.RunBenchmark(workerCount)
		c.JSON(http.StatusOK, result)
	})

	// Static Web Assets (Frontend SPA)
	if _, err := os.Stat("dist"); err == nil {
		router.Static("/assets", "dist/assets")
		router.NoRoute(func(c *gin.Context) {
			c.File("dist/index.html")
		})
	}

	addr := fmt.Sprintf("0.0.0.0:%s", port)
	fmt.Printf("[DeadLockIQ Go Engine] Listening on %s\n", addr)
	if err := router.Run(addr); err != nil {
		fmt.Printf("Server failed: %v\n", err)
	}
}
