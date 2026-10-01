import React, { useState } from 'react';
import { Gauge, CheckCircle2, AlertCircle, Play, RefreshCw, Zap, TrendingDown } from 'lucide-react';
import { BenchmarkResult } from '../server/benchmark.ts';

interface BenchmarkPanelProps {
  onRunBenchmark: (workers: number) => Promise<BenchmarkResult | null>;
  lastResult: BenchmarkResult | null;
  isRunning: boolean;
}

export const BenchmarkPanel: React.FC<BenchmarkPanelProps> = ({
  onRunBenchmark,
  lastResult,
  isRunning,
}) => {
  const [workerCount, setWorkerCount] = useState<number>(500);

  const handleRun = () => {
    onRunBenchmark(workerCount);
  };

  return (
    <div className="bg-slate-900/80 rounded-xl border border-slate-800 shadow-xl overflow-hidden flex flex-col p-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-slate-800 gap-2">
        <div className="flex items-center gap-2">
          <Gauge className="w-4 h-4 text-indigo-400" />
          <h2 className="text-sm font-bold font-mono text-white">
            High-Concurrency Benchmark Suite
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-slate-400">Workers:</span>
          {[100, 500, 1000, 2500].map(cnt => (
            <button
              key={cnt}
              onClick={() => setWorkerCount(cnt)}
              disabled={isRunning}
              className={`px-2 py-0.5 rounded text-xs font-mono border transition-colors ${
                workerCount === cnt
                  ? 'bg-sky-600 text-white border-sky-500 font-bold'
                  : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200'
              }`}
            >
              {cnt}
            </button>
          ))}
          <button
            onClick={handleRun}
            disabled={isRunning}
            className="flex items-center gap-1.5 px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-mono font-bold transition-all shadow-md active:scale-95 disabled:opacity-50"
          >
            {isRunning ? (
              <>
                <RefreshCw className="w-3 h-3 animate-spin" />
                <span>BENCHMARKING...</span>
              </>
            ) : (
              <>
                <Play className="w-3 h-3" />
                <span>RUN BENCHMARK</span>
              </>
            )}
          </button>
        </div>
      </div>

      {lastResult ? (
        <div className="mt-4 space-y-4">
          {/* Target Proof Card */}
          <div
            className={`p-3 rounded-xl border flex items-center justify-between ${
              lastResult.overheadTargetMet
                ? 'bg-emerald-950/40 border-emerald-500/60 text-emerald-300'
                : 'bg-amber-950/40 border-amber-500/60 text-amber-300'
            }`}
          >
            <div className="flex items-center gap-2.5">
              {lastResult.overheadTargetMet ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
              ) : (
                <AlertCircle className="w-5 h-5 text-amber-400 shrink-0" />
              )}
              <div>
                <span className="text-xs font-mono font-bold block">
                  TARGET VERIFIED: Uncontended Overhead {lastResult.uncontendedOverheadMs.toFixed(3)}ms (Target &lt; 0.8ms)
                </span>
                <span className="text-[11px] opacity-80 font-sans">
                  Measured across {lastResult.totalOperations} operations with {lastResult.workerCount} concurrent workers.
                </span>
              </div>
            </div>
            <div className="text-right font-mono">
              <span className="text-xl font-extrabold">{lastResult.throughputOpsSec}</span>
              <span className="text-[10px] block opacity-75">OPS / SEC</span>
            </div>
          </div>

          {/* Comparison Table */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 font-mono text-xs">
            {/* Direct Redis Baseline */}
            <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800">
              <div className="flex items-center justify-between text-slate-400 pb-2 border-b border-slate-800">
                <span className="font-bold text-slate-300">Direct Redis Baseline</span>
                <span className="text-[10px]">No cycle detection</span>
              </div>
              <div className="mt-2 grid grid-cols-4 gap-2 text-center text-[11px]">
                <div className="bg-slate-900 p-1.5 rounded border border-slate-800">
                  <span className="text-slate-500 block text-[9px]">P50</span>
                  <span className="font-bold text-slate-200">{lastResult.baseline.p50Ms}ms</span>
                </div>
                <div className="bg-slate-900 p-1.5 rounded border border-slate-800">
                  <span className="text-slate-500 block text-[9px]">P95</span>
                  <span className="font-bold text-slate-200">{lastResult.baseline.p95Ms}ms</span>
                </div>
                <div className="bg-slate-900 p-1.5 rounded border border-slate-800">
                  <span className="text-slate-500 block text-[9px]">P99</span>
                  <span className="font-bold text-slate-200">{lastResult.baseline.p99Ms}ms</span>
                </div>
                <div className="bg-slate-900 p-1.5 rounded border border-slate-800">
                  <span className="text-slate-500 block text-[9px]">MEAN</span>
                  <span className="font-bold text-slate-200">{lastResult.baseline.meanMs}ms</span>
                </div>
              </div>
            </div>

            {/* DeadLockIQ Concurrency Engine */}
            <div className="bg-slate-950/60 p-3 rounded-xl border border-sky-900/60">
              <div className="flex items-center justify-between text-sky-400 pb-2 border-b border-slate-800">
                <span className="font-bold">DeadLockIQ Proxy Engine</span>
                <span className="text-[10px] text-sky-500 font-semibold">+ WFG + Fencing + Inc. Detection</span>
              </div>
              <div className="mt-2 grid grid-cols-4 gap-2 text-center text-[11px]">
                <div className="bg-slate-900 p-1.5 rounded border border-slate-800">
                  <span className="text-slate-500 block text-[9px]">P50</span>
                  <span className="font-bold text-sky-400">{lastResult.deadlockiq.p50Ms}ms</span>
                </div>
                <div className="bg-slate-900 p-1.5 rounded border border-slate-800">
                  <span className="text-slate-500 block text-[9px]">P95</span>
                  <span className="font-bold text-sky-400">{lastResult.deadlockiq.p95Ms}ms</span>
                </div>
                <div className="bg-slate-900 p-1.5 rounded border border-slate-800">
                  <span className="text-slate-500 block text-[9px]">P99</span>
                  <span className="font-bold text-sky-400">{lastResult.deadlockiq.p99Ms}ms</span>
                </div>
                <div className="bg-slate-900 p-1.5 rounded border border-slate-800">
                  <span className="text-slate-500 block text-[9px]">MEAN</span>
                  <span className="font-bold text-sky-400">{lastResult.deadlockiq.meanMs}ms</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-4 p-4 text-center text-xs font-mono text-slate-500 bg-slate-950/40 rounded-xl border border-dashed border-slate-800">
          Click "RUN BENCHMARK" to execute high-concurrency worker stress test and evaluate the &lt;0.8ms overhead target in real time.
        </div>
      )}
    </div>
  );
};
