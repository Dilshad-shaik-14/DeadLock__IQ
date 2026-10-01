import React from 'react';
import { Activity, ShieldCheck, Database, Radio, GitCommit, RefreshCw, Zap } from 'lucide-react';
import { MetricSnapshot } from '../types/index.ts';

interface HeaderProps {
  metrics: MetricSnapshot | null;
  wsConnected: boolean;
  onReset: () => void;
  isResetting: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  metrics,
  wsConnected,
  onReset,
  isResetting,
}) => {
  return (
    <header className="bg-slate-900/95 border-b border-slate-800/80 backdrop-blur sticky top-0 z-40 px-4 lg:px-6 py-3">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        {/* Brand & Story Badge */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-sky-600 via-indigo-600 to-rose-500 p-0.5 shadow-lg shadow-sky-950/50">
            <div className="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center">
              <Zap className="w-5 h-5 text-sky-400" />
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-extrabold tracking-tight text-white font-mono">
                DeadLock<span className="text-transparent bg-clip-text bg-gradient-to-r from-sky-400 to-indigo-400">IQ</span>
              </h1>
              <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full bg-sky-950 text-sky-400 border border-sky-800/70">
                v1.4 Distributed Proxy
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-slate-400 mt-0.5 font-mono">
              <span className="text-sky-400 font-semibold">DETECT</span>
              <span className="text-slate-600">→</span>
              <span className="text-indigo-400 font-semibold">EXPLAIN</span>
              <span className="text-slate-600">→</span>
              <span className="text-rose-400 font-semibold">RESOLVE</span>
              <span className="text-slate-600">→</span>
              <span className="text-amber-400 font-semibold">RETRY</span>
              <span className="text-slate-600">→</span>
              <span className="text-emerald-400 font-semibold">PROVE</span>
            </div>
          </div>
        </div>

        {/* Live Cluster Health Status Indicators */}
        <div className="flex flex-wrap items-center gap-2">
          {/* WebSocket Status */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-950/80 border border-slate-800 text-xs font-mono">
            <span className="relative flex h-2 w-2">
              {wsConnected && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              )}
              <span
                className={`relative inline-flex rounded-full h-2 w-2 ${
                  wsConnected ? 'bg-emerald-500' : 'bg-rose-500'
                }`}
              ></span>
            </span>
            <Radio className="w-3.5 h-3.5 text-slate-400" />
            <span className={wsConnected ? 'text-emerald-400' : 'text-rose-400'}>
              {wsConnected ? 'LIVE WS' : 'RECONNECTING'}
            </span>
          </div>

          {/* Redis Distributed Lock Engine */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-950/80 border border-slate-800 text-xs font-mono">
            <Activity className="w-3.5 h-3.5 text-rose-400" />
            <span className="text-slate-400">Redis:</span>
            <span
              className={`font-semibold ${
                metrics?.redisStatus === 'CONNECTED'
                  ? 'text-emerald-400'
                  : metrics?.redisStatus === 'DEGRADED'
                  ? 'text-amber-400'
                  : 'text-rose-400'
              }`}
            >
              {metrics?.redisStatus || 'ACTIVE'}
            </span>
          </div>

          {/* PostgreSQL Lock Catalog Observer */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-950/80 border border-slate-800 text-xs font-mono">
            <Database className="w-3.5 h-3.5 text-sky-400" />
            <span className="text-slate-400">Postgres:</span>
            <span
              className={`font-semibold ${
                metrics?.postgresStatus === 'CONNECTED'
                  ? 'text-emerald-400'
                  : metrics?.postgresStatus === 'SIMULATING'
                  ? 'text-amber-400'
                  : 'text-rose-400'
              }`}
            >
              {metrics?.postgresStatus || 'OBSERVING'}
            </span>
          </div>

          {/* Fencing Authority */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-950/80 border border-slate-800 text-xs font-mono">
            <ShieldCheck className="w-3.5 h-3.5 text-indigo-400" />
            <span className="text-slate-400">Fencing:</span>
            <span className="text-indigo-400 font-semibold">
              {metrics?.fencingViolationsDetected ?? 0} Blocked
            </span>
          </div>

          {/* Reset System Engine State */}
          <button
            onClick={onReset}
            disabled={isResetting}
            className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-mono transition-colors border border-slate-700 active:scale-95 disabled:opacity-50"
            title="Reset all in-memory graphs, locks, and active cycles"
          >
            <RefreshCw className={`w-3 h-3 ${isResetting ? 'animate-spin' : ''}`} />
            <span>Reset Engine</span>
          </button>
        </div>
      </div>
    </header>
  );
};
