import React from 'react';
import {
  Play,
  RotateCcw,
  Zap,
  ShieldAlert,
  Layers,
  Database,
  WifiOff,
  Flame,
  AlertTriangle,
  Clock,
  Cpu,
  RefreshCw,
} from 'lucide-react';
import { ScenarioType } from '../server/simulator.ts';

interface SimulatorControlsProps {
  onRunScenario: (scenario: ScenarioType) => void;
  isRunning: boolean;
  activeScenario: string | null;
  onReset: () => void;
}

export const SimulatorControls: React.FC<SimulatorControlsProps> = ({
  onRunScenario,
  isRunning,
  activeScenario,
  onReset,
}) => {
  const scenarios: {
    id: ScenarioType;
    title: string;
    description: string;
    icon: React.ElementType;
    color: string;
    tag?: string;
  }[] = [
    {
      id: 'TWO_WAY_DEADLOCK',
      title: '2-Way Deadlock',
      description: 'Tx1 holds R1, requests R2; Tx2 holds R2, requests R1',
      icon: Zap,
      color: 'text-rose-400 border-rose-900/60 bg-rose-950/40 hover:bg-rose-900/50',
      tag: 'Core Story',
    },
    {
      id: 'THREE_WAY_DEADLOCK',
      title: '3-Way Deadlock',
      description: 'Triangular circular dependency ring: Tx1->R2->Tx2->R3->Tx3->R1',
      icon: AlertTriangle,
      color: 'text-amber-400 border-amber-900/60 bg-amber-950/40 hover:bg-amber-900/50',
    },
    {
      id: 'N_WAY_DEADLOCK',
      title: 'N-Way Ring (5 Workers)',
      description: '5-worker circular wait ring verified by incremental detector',
      icon: Layers,
      color: 'text-indigo-400 border-indigo-900/60 bg-indigo-950/40 hover:bg-indigo-900/50',
    },
    {
      id: 'NORMAL_CONTENTION',
      title: 'Normal Contention',
      description: 'Queue serialization on shared lock without cycle triggers',
      icon: Clock,
      color: 'text-emerald-400 border-emerald-900/60 bg-emerald-950/40 hover:bg-emerald-900/50',
    },
    {
      id: 'MULTIPLE_DEADLOCKS',
      title: 'Dual Deadlocks',
      description: 'Two simultaneous independent cycle rings resolved concurrently',
      icon: Flame,
      color: 'text-orange-400 border-orange-900/60 bg-orange-950/40 hover:bg-orange-900/50',
    },
    {
      id: 'STALE_WORKER',
      title: 'Stale Worker & Fencing',
      description: 'GC pause expires lease; stale worker rejected by fencing token',
      icon: ShieldAlert,
      color: 'text-cyan-400 border-cyan-900/60 bg-cyan-950/40 hover:bg-cyan-900/50',
      tag: 'Fencing Proof',
    },
    {
      id: 'RETRY_STORM',
      title: 'Retry Storm & Jitter',
      description: '8 workers compete on hot row; backoff & jitter prevent thundering herd',
      icon: RefreshCw,
      color: 'text-violet-400 border-violet-900/60 bg-violet-950/40 hover:bg-violet-900/50',
    },
    {
      id: 'POSTGRES_DEADLOCK',
      title: 'PostgreSQL Lock Cycle',
      description: 'Observes pg_locks catalog cross-table lock contention & waits',
      icon: Database,
      color: 'text-blue-400 border-blue-900/60 bg-blue-950/40 hover:bg-blue-900/50',
      tag: 'PG Observation',
    },
    {
      id: 'REDIS_FAILURE',
      title: 'Redis Cluster Outage',
      description: 'Simulates transport partition and proxy fallback behavior',
      icon: WifiOff,
      color: 'text-pink-400 border-pink-900/60 bg-pink-950/40 hover:bg-pink-900/50',
    },
    {
      id: 'WORKER_CRASH',
      title: 'Worker Crash & TTL',
      description: 'Worker dies ungracefully; TTL watcher auto-evicts orphaned lock',
      icon: Cpu,
      color: 'text-yellow-400 border-yellow-900/60 bg-yellow-950/40 hover:bg-yellow-900/50',
    },
    {
      id: 'NETWORK_DELAY',
      title: 'Network Jitter (250ms)',
      description: 'Injects artificial transport latency to test timeout tolerance',
      icon: Clock,
      color: 'text-teal-400 border-teal-900/60 bg-teal-950/40 hover:bg-teal-900/50',
    },
  ];

  return (
    <div className="bg-slate-900/80 rounded-xl p-4 border border-slate-800 shadow-xl">
      <div className="flex items-center justify-between pb-3 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Play className="w-4 h-4 text-sky-400" />
          <h2 className="text-sm font-bold font-mono text-white tracking-wide">
            Deterministic Concurrency Scenarios
          </h2>
        </div>
        <span className="text-[11px] font-mono text-slate-400">
          Real in-engine execution • 12 reproducible simulations
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2.5 mt-3">
        {scenarios.map(sc => {
          const Icon = sc.icon;
          const isCurrent = activeScenario === sc.id;

          return (
            <button
              key={sc.id}
              onClick={() => onRunScenario(sc.id)}
              disabled={isRunning}
              className={`p-2.5 rounded-xl border text-left transition-all relative overflow-hidden flex flex-col justify-between group active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed ${sc.color}`}
            >
              <div>
                <div className="flex items-center justify-between gap-1 mb-1">
                  <div className="flex items-center gap-1.5">
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    <span className="font-mono text-xs font-bold text-slate-100">
                      {sc.title}
                    </span>
                  </div>
                  {sc.tag && (
                    <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-slate-950 text-slate-300 border border-slate-800">
                      {sc.tag}
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-slate-300 font-sans leading-tight">
                  {sc.description}
                </p>
              </div>

              {isCurrent && (
                <div className="mt-2 flex items-center gap-1 text-[10px] font-mono font-bold text-sky-300 animate-pulse">
                  <RefreshCw className="w-2.5 h-2.5 animate-spin" />
                  <span>EXECUTING...</span>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};
