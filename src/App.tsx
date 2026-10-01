/**
 * DeadLockIQ - Distributed Concurrency & Deadlock Resolution Platform
 *
 * DETECT → EXPLAIN → RESOLVE → RETRY → PROVE
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Header } from './components/Header.tsx';
import { MetricsBar } from './components/MetricsBar.tsx';
import { WaitForGraphView } from './components/WaitForGraphView.tsx';
import { IncidentPanel } from './components/IncidentPanel.tsx';
import { SimulatorControls } from './components/SimulatorControls.tsx';
import { TerminalLogs, LogEntry } from './components/TerminalLogs.tsx';
import { PostgresObserver } from './components/PostgresObserver.tsx';
import { BenchmarkPanel } from './components/BenchmarkPanel.tsx';
import { TransactionDetailModal } from './components/TransactionDetailModal.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import {
  Transaction,
  LockRecord,
  GraphSnapshot,
  DeadlockIncident,
  MetricSnapshot,
  PostgresLockRecord,
  WebSocketEvent,
} from './types/index.ts';
import { ScenarioType } from './server/simulator.ts';
import { BenchmarkResult } from './server/benchmark.ts';
import {
  Layers,
  Database,
  Gauge,
  Activity,
  Cpu,
  Search,
  CheckCircle2,
} from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<'GRAPH' | 'POSTGRES' | 'BENCHMARK' | 'TRANSACTIONS'>('GRAPH');

  // Core Data States
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [locks, setLocks] = useState<LockRecord[]>([]);
  const [graphSnapshot, setGraphSnapshot] = useState<GraphSnapshot | null>(null);
  const [incidents, setIncidents] = useState<DeadlockIncident[]>([]);
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | undefined>();
  const [metrics, setMetrics] = useState<MetricSnapshot | null>(null);
  const [postgresLocks, setPostgresLocks] = useState<PostgresLockRecord[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // UI Interactive States
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [isScenarioRunning, setIsScenarioRunning] = useState<boolean>(false);
  const [activeScenario, setActiveScenario] = useState<string | null>(null);
  const [isResetting, setIsResetting] = useState<boolean>(false);
  const [isSolving, setIsSolving] = useState<boolean>(false);
  const [inspectedTxId, setInspectedTxId] = useState<string | null>(null);
  const [benchmarkResult, setBenchmarkResult] = useState<BenchmarkResult | null>(null);
  const [isBenchmarking, setIsBenchmarking] = useState<boolean>(false);

  const wsRef = useRef<WebSocket | null>(null);

  const addLog = useCallback(
    (message: string, level: 'info' | 'warn' | 'error' | 'success' = 'info') => {
      const entry: LogEntry = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        message,
        level,
        timestamp: Date.now(),
      };
      setLogs(prev => [...prev.slice(-300), entry]);
    },
    []
  );

  // Initialize WebSocket connection
  useEffect(() => {
    let reconnectTimeout: NodeJS.Timeout;

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        addLog('Connected to DeadLockIQ WebSocket Engine (/ws)', 'success');
      };

      ws.onmessage = evt => {
        try {
          const event: WebSocketEvent = JSON.parse(evt.data);

          switch (event.type) {
            case 'INIT_STATE':
              setTransactions(Array.isArray(event.payload.transactions) ? event.payload.transactions : []);
              setLocks(Array.isArray(event.payload.locks) ? event.payload.locks : []);
              setGraphSnapshot(event.payload.graph || null);
              setIncidents(Array.isArray(event.payload.incidents) ? event.payload.incidents : []);
              setMetrics(event.payload.metrics || null);
              setPostgresLocks(Array.isArray(event.payload.postgresLocks) ? event.payload.postgresLocks : []);
              if (event.payload.incidents?.length > 0) {
                setSelectedIncidentId(event.payload.incidents[0].id);
              }
              break;

            case 'GRAPH_EDGE_ADDED':
            case 'GRAPH_EDGE_REMOVED':
              if (event.payload && Array.isArray(event.payload.nodes)) {
                setGraphSnapshot(event.payload);
              }
              break;

            case 'TRANSACTION_CREATED':
              if (event.payload?.tx?.id) {
                setTransactions(prev => {
                  const existing = prev.findIndex(t => t.id === event.payload.tx.id);
                  if (existing >= 0) {
                    const updated = [...prev];
                    updated[existing] = event.payload.tx;
                    return updated;
                  }
                  return [...prev, event.payload.tx];
                });
              }
              break;

            case 'DEADLOCK_DETECTED':
            case 'INCIDENT_UPDATED':
            case 'INCIDENT_RESOLVED': {
              const inc: DeadlockIncident = event.payload;
              // Guard: Only update incidents if a valid incident with ID was received
              if (inc && typeof inc.id === 'string' && inc.id.startsWith('INC-')) {
                setIncidents(prev => {
                  const idx = prev.findIndex(i => i.id === inc.id);
                  if (idx >= 0) {
                    const updated = [...prev];
                    updated[idx] = inc;
                    return updated;
                  }
                  return [inc, ...prev];
                });
                setSelectedIncidentId(inc.id);
                addLog(`Incident ${inc.id} updated [Status: ${inc.status || 'DETECTED'}]`, inc.status === 'RESOLVED' ? 'success' : 'warn');
              }
              break;
            }

            case 'METRICS_UPDATED':
              if (event.payload) {
                setMetrics(event.payload);
              }
              break;

            case 'LOG_EVENT':
              if (event.payload?.message) {
                addLog(event.payload.message, event.payload.level || 'info');
              }
              break;

            default:
              break;
          }
        } catch (e) {
          console.error('[DeadLockIQ WS] Error processing event:', e);
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        reconnectTimeout = setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        setWsConnected(false);
      };
    }

    connect();

    return () => {
      clearTimeout(reconnectTimeout);
      wsRef.current?.close();
    };
  }, [addLog]);

  // Scenario Execution
  const handleRunScenario = async (scenario: ScenarioType) => {
    setIsScenarioRunning(true);
    setActiveScenario(scenario);
    addLog(`Running scenario: ${scenario}...`, 'info');
    try {
      const resp = await fetch(`/api/v1/simulator/scenarios/${scenario}`, {
        method: 'POST',
      });
      const data = await resp.json();
      if (!data.success) {
        addLog(`Scenario warning: ${data.message}`, 'warn');
      } else {
        addLog(`Scenario ${scenario} completed.`, 'success');
      }

      // Fetch fresh incidents and graph
      const [deadlocksRes, graphRes] = await Promise.all([
        fetch('/api/v1/deadlocks').then(r => r.json()).catch(() => null),
        fetch('/api/v1/graph').then(r => r.json()).catch(() => null),
      ]);

      if (deadlocksRes?.incidents?.length > 0) {
        setIncidents(deadlocksRes.incidents);
        setSelectedIncidentId(deadlocksRes.incidents[0].id);
      }
      if (graphRes && Array.isArray(graphRes.nodes)) {
        setGraphSnapshot(graphRes);
      }
    } catch (err: any) {
      addLog(`Failed to execute scenario: ${err.message}`, 'error');
    } finally {
      setIsScenarioRunning(false);
      setActiveScenario(null);
    }
  };

  // Solve / Resolve Deadlock Incident
  const handleSolveIncident = async (id: string) => {
    setIsSolving(true);
    addLog(`Initiating automated resolution & recovery pipeline for ${id}...`, 'info');
    try {
      const resp = await fetch(`/api/v1/deadlocks/${id}/resolve`, {
        method: 'POST',
      });
      const data = await resp.json();

      if (data.success) {
        addLog(`Resolution Pipeline Succeeded: ${data.message}`, 'success');
        if (data.incident) {
          setIncidents(prev => prev.map(i => (i.id === data.incident.id ? data.incident : i)));
        }

        // Refresh graph and transactions
        const [graphRes, txsRes] = await Promise.all([
          fetch('/api/v1/graph').then(r => r.json()).catch(() => null),
          fetch('/api/v1/transactions').then(r => r.json()).catch(() => null),
        ]);

        if (graphRes && Array.isArray(graphRes.nodes)) {
          setGraphSnapshot(graphRes);
        }
        if (txsRes?.transactions) {
          setTransactions(txsRes.transactions);
        }
      } else {
        addLog(`Resolution error: ${data.message || data.error}`, 'error');
      }
    } catch (err: any) {
      addLog(`Failed to resolve incident: ${err.message}`, 'error');
    } finally {
      setIsSolving(false);
    }
  };

  // System Reset
  const handleReset = async () => {
    setIsResetting(true);
    try {
      await fetch('/api/v1/simulator/reset', { method: 'POST' });
      setTransactions([]);
      setLocks([]);
      setIncidents([]);
      setSelectedIncidentId(undefined);
      setGraphSnapshot({ nodes: [], edges: [], activeCycles: [] });
      addLog('Engine state reset cleanly.', 'info');
    } catch (err: any) {
      addLog(`Reset failed: ${err.message}`, 'error');
    } finally {
      setIsResetting(false);
    }
  };

  // Benchmark Runner
  const handleRunBenchmark = async (workers: number): Promise<BenchmarkResult | null> => {
    setIsBenchmarking(true);
    try {
      addLog(`Initiating concurrent benchmark with ${workers} workers...`, 'info');
      const resp = await fetch('/api/v1/benchmark/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workers }),
      });
      const result: BenchmarkResult = await resp.json();
      setBenchmarkResult(result);
      addLog(
        `Benchmark completed: ${result.totalOperations} ops, Throughput: ${result.throughputOpsSec} ops/s. Overhead: ${result.uncontendedOverheadMs.toFixed(3)}ms (Target <0.8ms Met: ${result.overheadTargetMet})`,
        result.overheadTargetMet ? 'success' : 'warn'
      );
      return result;
    } catch (err: any) {
      addLog(`Benchmark failed: ${err.message}`, 'error');
      return null;
    } finally {
      setIsBenchmarking(false);
    }
  };

  const inspectedTransaction = inspectedTxId
    ? transactions.find(t => t.id === inspectedTxId) || null
    : null;

  return (
    <ErrorBoundary fallbackTitle="DeadLockIQ Platform Safeguard">
      <div className="min-h-screen bg-[#070a12] text-slate-100 flex flex-col font-sans">
        {/* Header */}
        <Header
          metrics={metrics}
          wsConnected={wsConnected}
          onReset={handleReset}
          isResetting={isResetting}
        />

        {/* Live Metrics Stats Bar */}
        <MetricsBar metrics={metrics} />

        {/* Main Navigation Tabs */}
        <div className="px-4 lg:px-6 pt-3 border-b border-slate-800/80 bg-slate-950/40 flex items-center justify-between">
          <div className="flex items-center gap-1 font-mono text-xs">
            <button
              onClick={() => setActiveTab('GRAPH')}
              className={`flex items-center gap-2 px-4 py-2.5 border-b-2 font-bold transition-all cursor-pointer ${
                activeTab === 'GRAPH'
                  ? 'border-sky-400 text-sky-300 bg-sky-950/20'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Layers className="w-4 h-4" />
              <span>Wait-For Graph &amp; Resolution</span>
            </button>

            <button
              onClick={() => setActiveTab('POSTGRES')}
              className={`flex items-center gap-2 px-4 py-2.5 border-b-2 font-bold transition-all cursor-pointer ${
                activeTab === 'POSTGRES'
                  ? 'border-sky-400 text-sky-300 bg-sky-950/20'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Database className="w-4 h-4" />
              <span>PostgreSQL Lock Observer</span>
            </button>

            <button
              onClick={() => setActiveTab('BENCHMARK')}
              className={`flex items-center gap-2 px-4 py-2.5 border-b-2 font-bold transition-all cursor-pointer ${
                activeTab === 'BENCHMARK'
                  ? 'border-sky-400 text-sky-300 bg-sky-950/20'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Gauge className="w-4 h-4" />
              <span>Concurrency Benchmark</span>
            </button>

            <button
              onClick={() => setActiveTab('TRANSACTIONS')}
              className={`flex items-center gap-2 px-4 py-2.5 border-b-2 font-bold transition-all cursor-pointer ${
                activeTab === 'TRANSACTIONS'
                  ? 'border-sky-400 text-sky-300 bg-sky-950/20'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Cpu className="w-4 h-4" />
              <span>Transactions ({transactions.length})</span>
            </button>
          </div>

          <div className="hidden md:flex items-center gap-2 text-xs font-mono text-slate-400">
            <span className="text-emerald-400 animate-pulse">●</span>
            <span>Incremental Cycle Reachability &lt; 0.05ms</span>
          </div>
        </div>

        {/* Main Tab Views */}
        <main className="flex-1 p-4 lg:p-6 space-y-6">
          {activeTab === 'GRAPH' && (
            <div className="space-y-6">
              {/* Top Row: Wait-For Graph (65%) and Incident Resolution Card (35%) */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-7 xl:col-span-8">
                  <WaitForGraphView
                    snapshot={graphSnapshot}
                    onNodeClick={nodeId => setInspectedTxId(nodeId)}
                  />
                </div>

                <div className="lg:col-span-5 xl:col-span-4">
                  <IncidentPanel
                    incidents={incidents}
                    selectedIncidentId={selectedIncidentId}
                    onSelectIncident={id => setSelectedIncidentId(id)}
                    onSolveIncident={handleSolveIncident}
                    isSolving={isSolving}
                  />
                </div>
              </div>

              {/* Bottom Row: Deterministic Simulator Controls and Real-time WebSocket Log Terminal */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-8">
                  <SimulatorControls
                    onRunScenario={handleRunScenario}
                    isRunning={isScenarioRunning}
                    activeScenario={activeScenario}
                    onReset={handleReset}
                  />
                </div>

                <div className="lg:col-span-4">
                  <TerminalLogs logs={logs} onClear={() => setLogs([])} />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'POSTGRES' && (
            <div className="space-y-6">
              <PostgresObserver
                locks={postgresLocks}
                hasDeadlock={metrics?.postgresStatus === 'SIMULATING'}
                status={metrics?.postgresStatus || 'OBSERVING'}
              />

              <div className="bg-slate-900/60 p-4 rounded-xl border border-slate-800 font-mono text-xs text-slate-400 leading-relaxed">
                <span className="font-bold text-sky-400 block mb-1">
                  Unified Dependency Model Note:
                </span>
                DeadLockIQ separates OBSERVATION of PostgreSQL internals from distributed CONTROL of application lock leases. The pg_locks catalog observer continuously polls PostgreSQL lock acquisition queues, correlates relation and tuple locks with distributed Redis tokens, and raises alerts when cross-database circular waits occur.
              </div>
            </div>
          )}

          {activeTab === 'BENCHMARK' && (
            <div className="space-y-6">
              <BenchmarkPanel
                onRunBenchmark={handleRunBenchmark}
                lastResult={benchmarkResult}
                isRunning={isBenchmarking}
              />
            </div>
          )}

          {activeTab === 'TRANSACTIONS' && (
            <div className="bg-slate-900/80 rounded-xl border border-slate-800 shadow-xl overflow-hidden p-4 space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <div className="flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-sky-400" />
                  <h2 className="text-sm font-bold font-mono text-white">
                    Active Transaction Registry
                  </h2>
                </div>
                <span className="text-xs font-mono text-slate-400">
                  {transactions.length} registered in-flight transactions
                </span>
              </div>

              {transactions.length === 0 ? (
                <div className="text-center py-12 text-slate-500 font-mono text-xs">
                  No transactions currently registered. Launch a simulation scenario above to begin.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left font-mono text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400">
                        <th className="p-2.5">TX ID</th>
                        <th className="p-2.5">Worker</th>
                        <th className="p-2.5">State</th>
                        <th className="p-2.5">Priority</th>
                        <th className="p-2.5">Held Locks</th>
                        <th className="p-2.5">Waiting On</th>
                        <th className="p-2.5">Retries</th>
                        <th className="p-2.5">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {transactions.map(tx => (
                        <tr key={tx.id} className="hover:bg-slate-950/60">
                          <td className="p-2.5 font-bold text-sky-400">{tx.id}</td>
                          <td className="p-2.5 text-slate-400">{tx.workerId}</td>
                          <td className="p-2.5">
                            <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-800 text-slate-300 border border-slate-700">
                              {tx.state}
                            </span>
                          </td>
                          <td className="p-2.5 text-indigo-300">
                            {tx.effectivePriority} <span className="text-[10px] text-slate-500">(base {tx.priority})</span>
                          </td>
                          <td className="p-2.5 text-emerald-400">
                            {tx.locksHeld.length > 0 ? tx.locksHeld.join(', ') : '—'}
                          </td>
                          <td className="p-2.5 text-amber-400">
                            {tx.waitingForLock || '—'}
                          </td>
                          <td className="p-2.5 text-slate-300">
                            {tx.retryCount} / {tx.maxRetries}
                          </td>
                          <td className="p-2.5">
                            <button
                              onClick={() => setInspectedTxId(tx.id)}
                              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-mono transition-colors cursor-pointer"
                            >
                              Inspect
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </main>

        {/* Transaction Detail Inspector Modal */}
        <TransactionDetailModal
          transaction={inspectedTransaction}
          onClose={() => setInspectedTxId(null)}
        />
      </div>
    </ErrorBoundary>
  );
}
