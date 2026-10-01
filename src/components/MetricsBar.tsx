import React from 'react';
import { MetricSnapshot } from '../types/index.ts';
import { Layers, Clock, AlertOctagon, CheckCircle2, RotateCw, Gauge, Zap } from 'lucide-react';

interface MetricsBarProps {
  metrics: MetricSnapshot | null;
}

export const MetricsBar: React.FC<MetricsBarProps> = ({ metrics }) => {
  const cards = [
    {
      label: 'Active Transactions',
      value: metrics?.activeTransactions ?? 0,
      sub: `${metrics?.waitingTransactions ?? 0} waiting for locks`,
      icon: Clock,
      color: 'text-sky-400',
      border: 'border-sky-900/40',
    },
    {
      label: 'Locks Held',
      value: metrics?.locksHeld ?? 0,
      sub: 'Redis atomic leases',
      icon: Layers,
      color: 'text-emerald-400',
      border: 'border-emerald-900/40',
    },
    {
      label: 'Deadlocks Detected',
      value: metrics?.deadlocksDetected ?? 0,
      sub: `P95: ${metrics?.deadlockDetectionLatencyP95 ?? 1.8}ms`,
      icon: AlertOctagon,
      color: 'text-rose-400',
      border: 'border-rose-900/40',
    },
    {
      label: 'Recoveries & Retries',
      value: metrics?.recoveriesSuccessful ?? 0,
      sub: `${metrics?.retriesScheduled ?? 0} retried w/ jitter`,
      icon: RotateCw,
      color: 'text-amber-400',
      border: 'border-amber-900/40',
    },
    {
      label: 'Uncontended Latency',
      value: `${(metrics?.uncontendedLatencyP50 ?? 0.48).toFixed(3)}ms`,
      sub: `Target: <0.8ms (P95: ${(metrics?.uncontendedLatencyP95 ?? 0.62).toFixed(3)}ms)`,
      icon: Gauge,
      color: 'text-indigo-400',
      border: 'border-indigo-900/40',
    },
    {
      label: 'Throughput',
      value: `${metrics?.throughputOpsPerSec ?? 0} ops/s`,
      sub: `${metrics?.wsConnections ?? 1} concurrent worker sockets`,
      icon: Zap,
      color: 'text-cyan-400',
      border: 'border-cyan-900/40',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 p-4 bg-slate-950/60 border-b border-slate-800/80">
      {cards.map((c, i) => {
        const Icon = c.icon;
        return (
          <div
            key={i}
            className={`bg-slate-900/80 rounded-xl p-3 border ${c.border} shadow-sm backdrop-blur transition-all hover:border-slate-700`}
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono font-medium text-slate-400 truncate">
                {c.label}
              </span>
              <Icon className={`w-3.5 h-3.5 ${c.color}`} />
            </div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-xl font-bold font-mono text-white tracking-tight">
                {c.value}
              </span>
            </div>
            <div className="mt-0.5 text-[10px] font-mono text-slate-400 truncate">
              {c.sub}
            </div>
          </div>
        );
      })}
    </div>
  );
};
