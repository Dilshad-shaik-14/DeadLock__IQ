package graph

import (
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/deadlockiq/engine/internal/types"
)

type TxMeta struct {
	WorkerID          string
	State             types.TxState
	Priority          int
	EffectivePriority float64
	FencingToken      *uint64
}

type CycleDetectionResult struct {
	HasCycle          bool          `json:"hasCycle"`
	CycleTxIDs        []string      `json:"cycleTxIds"`
	CyclePath         []string      `json:"cyclePath"`
	ResourcesInvolved []string      `json:"resourcesInvolved"`
	Latency           time.Duration `json:"latency"`
}

type WaitForGraph struct {
	mu              sync.RWMutex
	txWaitAdj       map[string]map[string]bool // txA -> set of txB
	resourceHolders map[string]string          // resource -> tx
	resourceWaiters map[string]map[string]bool // resource -> set of tx
	txHeldResources map[string]map[string]bool // tx -> set of resources
	txWaitingFor    map[string]string          // tx -> resource
	txMetadata      map[string]*TxMeta
	activeCycles    [][]string
}

func NewWaitForGraph() *WaitForGraph {
	return &WaitForGraph{
		txWaitAdj:       make(map[string]map[string]bool),
		resourceHolders: make(map[string]string),
		resourceWaiters: make(map[string]map[string]bool),
		txHeldResources: make(map[string]map[string]bool),
		txWaitingFor:    make(map[string]string),
		txMetadata:      make(map[string]*TxMeta),
		activeCycles:    make([][]string, 0),
	}
}

func (g *WaitForGraph) RegisterTransaction(txID, workerID string, state types.TxState, priority int, effectivePriority float64, fencingToken *uint64) {
	g.mu.Lock()
	defer g.mu.Unlock()

	if _, ok := g.txWaitAdj[txID]; !ok {
		g.txWaitAdj[txID] = make(map[string]bool)
	}
	if _, ok := g.txHeldResources[txID]; !ok {
		g.txHeldResources[txID] = make(map[string]bool)
	}
	g.txMetadata[txID] = &TxMeta{
		WorkerID:          workerID,
		State:             state,
		Priority:          priority,
		EffectivePriority: effectivePriority,
		FencingToken:      fencingToken,
	}
}

func (g *WaitForGraph) RecordLockAcquired(resourceID, txID string) {
	g.mu.Lock()
	defer g.mu.Unlock()

	if waitingRes, ok := g.txWaitingFor[txID]; ok && waitingRes == resourceID {
		delete(g.txWaitingFor, txID)
	}
	if waiters, ok := g.resourceWaiters[resourceID]; ok {
		delete(waiters, txID)
	}

	g.resourceHolders[resourceID] = txID

	if _, ok := g.txHeldResources[txID]; !ok {
		g.txHeldResources[txID] = make(map[string]bool)
	}
	g.txHeldResources[txID][resourceID] = true

	// Rebuild waiter edges: every transaction waiting for resourceID now waits for txID
	if waiters, ok := g.resourceWaiters[resourceID]; ok {
		for waiter := range waiters {
			if _, ok := g.txWaitAdj[waiter]; !ok {
				g.txWaitAdj[waiter] = make(map[string]bool)
			}
			if waiter != txID {
				g.txWaitAdj[waiter][txID] = true
			}
		}
	}
}

func (g *WaitForGraph) RecordLockWaiting(waiterTxID, resourceID, holderTxID string) CycleDetectionResult {
	start := time.Now()
	g.mu.Lock()
	defer g.mu.Unlock()

	g.txWaitingFor[waiterTxID] = resourceID

	if _, ok := g.resourceWaiters[resourceID]; !ok {
		g.resourceWaiters[resourceID] = make(map[string]bool)
	}
	g.resourceWaiters[resourceID][waiterTxID] = true

	if _, ok := g.txWaitAdj[waiterTxID]; !ok {
		g.txWaitAdj[waiterTxID] = make(map[string]bool)
	}
	g.txWaitAdj[waiterTxID][holderTxID] = true

	// Incremental Cycle Detection: can holderTxID already reach waiterTxID?
	cyclePath := g.findPath(holderTxID, waiterTxID)
	elapsed := time.Since(start)

	if len(cyclePath) > 0 {
		fullCycle := append([]string{waiterTxID}, cyclePath...)

		richPath := make([]string, 0)
		resourcesInvolved := make([]string, 0)
		resSet := make(map[string]bool)

		for i := 0; i < len(fullCycle)-1; i++ {
			fromTx := fullCycle[i]
			richPath = append(richPath, fromTx)
			res := g.txWaitingFor[fromTx]
			if res == "" {
				res = resourceID
			}
			richPath = append(richPath, res)
			if !resSet[res] {
				resSet[res] = true
				resourcesInvolved = append(resourcesInvolved, res)
			}
		}
		richPath = append(richPath, fullCycle[len(fullCycle)-1])

		g.activeCycles = [][]string{fullCycle}

		return CycleDetectionResult{
			HasCycle:          true,
			CycleTxIDs:        fullCycle[:len(fullCycle)-1],
			CyclePath:         richPath,
			ResourcesInvolved: resourcesInvolved,
			Latency:           elapsed,
		}
	}

	return CycleDetectionResult{
		HasCycle:          false,
		CycleTxIDs:        make([]string, 0),
		CyclePath:         make([]string, 0),
		ResourcesInvolved: make([]string, 0),
		Latency:           elapsed,
	}
}

func (g *WaitForGraph) RecordLockReleased(resourceID, txID string) {
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.resourceHolders[resourceID] == txID {
		delete(g.resourceHolders, resourceID)
	}
	if held, ok := g.txHeldResources[txID]; ok {
		delete(held, resourceID)
	}
	if waitingRes, ok := g.txWaitingFor[txID]; ok && waitingRes == resourceID {
		delete(g.txWaitingFor, txID)
	}

	if waiters, ok := g.resourceWaiters[resourceID]; ok {
		delete(waiters, txID)
		for waiter := range waiters {
			if edges, ok := g.txWaitAdj[waiter]; ok {
				delete(edges, txID)
			}
		}
	}

	g.clearCyclesIfBroken()
}

func (g *WaitForGraph) SeverCycle(victimTxID string) {
	g.mu.Lock()
	defer g.mu.Unlock()

	delete(g.txWaitAdj, victimTxID)
	for _, neighbors := range g.txWaitAdj {
		delete(neighbors, victimTxID)
	}

	delete(g.txWaitingFor, victimTxID)

	stillValid := make([][]string, 0)
	for _, cycle := range g.activeCycles {
		containsVictim := false
		for _, tx := range cycle {
			if tx == victimTxID {
				containsVictim = true
				break
			}
		}
		if !containsVictim {
			stillValid = append(stillValid, cycle)
		}
	}
	g.activeCycles = stillValid
}

func (g *WaitForGraph) ClearCyclesIfBroken() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.clearCyclesIfBroken()
}

func (g *WaitForGraph) clearCyclesIfBroken() {
	if len(g.activeCycles) == 0 {
		return
	}

	stillValid := make([][]string, 0)
	for _, cycle := range g.activeCycles {
		intact := true
		for i := 0; i < len(cycle)-1; i++ {
			u := cycle[i]
			v := cycle[i+1]
			edges, ok := g.txWaitAdj[u]
			if !ok || !edges[v] {
				intact = false
				break
			}
		}
		if intact {
			stillValid = append(stillValid, cycle)
		}
	}
	g.activeCycles = stillValid
}

func (g *WaitForGraph) findPath(start, target string) []string {
	if start == target {
		return []string{start}
	}

	queue := []string{start}
	visited := map[string]bool{start: true}
	parent := make(map[string]string)

	for len(queue) > 0 {
		curr := queue[0]
		queue = queue[1:]

		neighbors := g.txWaitAdj[curr]
		for next := range neighbors {
			if next == target {
				path := []string{target}
				p := curr
				for p != "" {
					path = append([]string{p}, path...)
					p = parent[p]
				}
				return path
			}

			if !visited[next] {
				visited[next] = true
				parent[next] = curr
				queue = append(queue, next)
			}
		}
	}

	return nil
}

func (g *WaitForGraph) GetSnapshot() types.GraphSnapshot {
	g.mu.RLock()
	defer g.mu.RUnlock()

	nodes := make([]types.GraphNode, 0)
	edges := make([]types.GraphEdge, 0)

	allResources := make(map[string]bool)
	for r := range g.resourceHolders {
		allResources[r] = true
	}
	for r := range g.resourceWaiters {
		allResources[r] = true
	}
	for _, r := range g.txWaitingFor {
		if r != "" {
			allResources[r] = true
		}
	}

	allTx := make(map[string]bool)
	for tx := range g.txMetadata {
		allTx[tx] = true
	}
	for tx := range g.txWaitAdj {
		allTx[tx] = true
	}
	for _, tx := range g.resourceHolders {
		if tx != "" {
			allTx[tx] = true
		}
	}
	for _, waiters := range g.resourceWaiters {
		for tx := range waiters {
			allTx[tx] = true
		}
	}
	for tx := range g.txWaitingFor {
		if tx != "" {
			allTx[tx] = true
		}
	}
	for _, cycle := range g.activeCycles {
		for _, tx := range cycle {
			if tx != "" {
				allTx[tx] = true
			}
		}
	}

	cycleEdgeKeys := make(map[string]bool)
	cycleTxSet := make(map[string]bool)
	for _, cycle := range g.activeCycles {
		for i := 0; i < len(cycle)-1; i++ {
			cycleEdgeKeys[fmt.Sprintf("%s->%s", cycle[i], cycle[i+1])] = true
			cycleTxSet[cycle[i]] = true
		}
		if len(cycle) > 0 {
			cycleTxSet[cycle[len(cycle)-1]] = true
		}
	}

	txArray := make([]string, 0, len(allTx))
	for tx := range allTx {
		txArray = append(txArray, tx)
	}

	resArray := make([]string, 0, len(allResources))
	for r := range allResources {
		resArray = append(resArray, r)
	}

	radius := math.Max(180, float64(len(txArray)+len(resArray))*35)
	centerX := 360.0
	centerY := 260.0

	validNodeIds := make(map[string]bool)

	for i, txID := range txArray {
		angle := (float64(i) / math.Max(1, float64(len(txArray)))) * 2 * math.Pi
		x := int(centerX + radius*math.Cos(angle))
		y := int(centerY + radius*math.Sin(angle))

		meta := g.txMetadata[txID]
		heldCount := len(g.txHeldResources[txID])
		state := types.TxRunning
		workerID := "w-0"
		priority := 1
		effPriority := 1.0
		var fToken *uint64

		if meta != nil {
			state = meta.State
			workerID = meta.WorkerID
			priority = meta.Priority
			effPriority = meta.EffectivePriority
			fToken = meta.FencingToken
		}

		validNodeIds[txID] = true
		nodes = append(nodes, types.GraphNode{
			ID:   txID,
			Type: "transactionNode",
			Position: types.GraphPosition{
				X: x,
				Y: y,
			},
			Data: types.GraphNodeData{
				ID:                txID,
				NodeType:          "transaction",
				Label:             txID,
				State:             state,
				WorkerID:          workerID,
				Priority:          priority,
				EffectivePriority: effPriority,
				LocksCount:        heldCount,
				IsInCycle:         cycleTxSet[txID],
				FencingToken:      fToken,
			},
		})
	}

	for i, resID := range resArray {
		angle := ((float64(i) + 0.5) / math.Max(1, float64(len(resArray)))) * 2 * math.Pi
		innerRadius := math.Max(90, radius*0.45)
		x := int(centerX + innerRadius*math.Cos(angle))
		y := int(centerY + innerRadius*math.Sin(angle))

		holder := g.resourceHolders[resID]
		waitersCount := len(g.resourceWaiters[resID])

		validNodeIds[resID] = true
		nodes = append(nodes, types.GraphNode{
			ID:   resID,
			Type: "resourceNode",
			Position: types.GraphPosition{
				X: x,
				Y: y,
			},
			Data: types.GraphNodeData{
				ID:           resID,
				NodeType:     "resource",
				Label:        resID,
				HolderTxID:   holder,
				WaitersCount: waitersCount,
			},
		})
	}

	for resID, waiters := range g.resourceWaiters {
		for waiterID := range waiters {
			// Skip if either endpoint is not in nodes
			if !validNodeIds[waiterID] || !validNodeIds[resID] {
				continue
			}

			holderID := g.resourceHolders[resID]
			isCycle := false
			if holderID != "" {
				isCycle = cycleEdgeKeys[fmt.Sprintf("%s->%s", waiterID, holderID)]
			}

			strokeColor := "#f59e0b"
			strokeWidth := 1.5
			if isCycle {
				strokeColor = "#ef4444"
				strokeWidth = 3.0
			}

			edges = append(edges, types.GraphEdge{
				ID:       fmt.Sprintf("wait_%s_%s", waiterID, resID),
				Source:   waiterID,
				Target:   resID,
				Label:    "waits for",
				Animated: true,
				Style: map[string]interface{}{
					"stroke":          strokeColor,
					"strokeWidth":     strokeWidth,
					"strokeDasharray": "4 4",
				},
				Data: types.GraphEdgeData{
					ID:       fmt.Sprintf("wait_%s_%s", waiterID, resID),
					Source:   waiterID,
					Target:   resID,
					EdgeType: "waits_for",
					IsCycle:  isCycle,
				},
			})
		}
	}

	for resID, holderID := range g.resourceHolders {
		if !validNodeIds[resID] || !validNodeIds[holderID] {
			continue
		}

		isCycle := cycleTxSet[holderID] && len(g.activeCycles) > 0

		strokeColor := "#10b981"
		strokeWidth := 2.0
		if isCycle {
			strokeColor = "#ef4444"
			strokeWidth = 3.0
		}

		edges = append(edges, types.GraphEdge{
			ID:     fmt.Sprintf("held_%s_%s", resID, holderID),
			Source: resID,
			Target: holderID,
			Label:  "held by",
			Style: map[string]interface{}{
				"stroke":      strokeColor,
				"strokeWidth": strokeWidth,
			},
			Data: types.GraphEdgeData{
				ID:       fmt.Sprintf("held_%s_%s", resID, holderID),
				Source:   resID,
				Target:   holderID,
				EdgeType: "holds",
				IsCycle:  isCycle,
			},
		})
	}

	activeCycles := g.activeCycles
	if activeCycles == nil {
		activeCycles = make([][]string, 0)
	}

	return types.GraphSnapshot{
		Nodes:        nodes,
		Edges:        edges,
		ActiveCycles: activeCycles,
	}
}

func (g *WaitForGraph) Reset() {
	g.mu.Lock()
	defer g.mu.Unlock()

	g.txWaitAdj = make(map[string]map[string]bool)
	g.resourceHolders = make(map[string]string)
	g.resourceWaiters = make(map[string]map[string]bool)
	g.txHeldResources = make(map[string]map[string]bool)
	g.txWaitingFor = make(map[string]string)
	g.txMetadata = make(map[string]*TxMeta)
	g.activeCycles = make([][]string, 0)
}
