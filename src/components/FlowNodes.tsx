import React, { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Shield, Clock, Lock, AlertTriangle, Layers, Cpu } from 'lucide-react';
import { GraphNodeData } from '../types/index.ts';

const stateColors: Record<string, { bg: string; text: string; border: string }> = {
  CREATED: { bg: 'bg-slate-800', text: 'text-slate-300', border: 'border-slate-600' },
  WAITING: { bg: 'bg-amber-950/70', text: 'text-amber-400', border: 'border-amber-500' },
  ACQUIRED: { bg: 'bg-emerald-950/70', text: 'text-emerald-400', border: 'border-emerald-500' },
  RUNNING: { bg: 'bg-cyan-950/70', text: 'text-cyan-400', border: 'border-cyan-500' },
  COMMITTING: { bg: 'bg-indigo-950/70', text: 'text-indigo-400', border: 'border-indigo-500' },
  COMPLETED: { bg: 'bg-teal-950/70', text: 'text-teal-400', border: 'border-teal-500' },
  DEADLOCK_DETECTED: { bg: 'bg-red-950/90', text: 'text-red-300', border: 'border-red-500' },
  VICTIM_SELECTED: { bg: 'bg-rose-950/90', text: 'text-rose-200', border: 'border-rose-400' },
  ABORTING: { bg: 'bg-orange-950/90', text: 'text-orange-300', border: 'border-orange-500' },
  ROLLED_BACK: { bg: 'bg-purple-950/70', text: 'text-purple-300', border: 'border-purple-500' },
  BACKOFF: { bg: 'bg-blue-950/70', text: 'text-blue-300', border: 'border-blue-500' },
  RETRYING: { bg: 'bg-yellow-950/70', text: 'text-yellow-300', border: 'border-yellow-500' },
  FAILED: { bg: 'bg-zinc-900', text: 'text-zinc-500', border: 'border-zinc-700' },
};

export const TransactionNode = memo(({ data }: { data?: GraphNodeData }) => {
  const safeData = data || {
    id: 'unknown',
    nodeType: 'transaction' as const,
    label: 'TX',
    state: 'RUNNING' as any,
    workerId: 'w-0',
    priority: 1,
    effectivePriority: 1,
    locksCount: 0,
    isInCycle: false,
  };

  const stateStyle = stateColors[safeData.state || 'RUNNING'] || stateColors.RUNNING;
  const isInCycle = !!safeData.isInCycle;
  const isVictim = safeData.state === 'VICTIM_SELECTED' || safeData.state === 'ABORTING';

  return (
    <div
      className={`relative min-w-[170px] rounded-xl px-3 py-2.5 shadow-xl transition-all duration-300 border ${
        isInCycle
          ? 'border-red-500 bg-red-950/80 shadow-[0_0_25px_rgba(239,68,68,0.5)] deadlock-cycle-pulse'
          : `${stateStyle.border} ${stateStyle.bg}`
      }`}
    >
      <Handle type="target" position={Position.Top} className="!w-2 !h-2 !bg-sky-400 !border-slate-900" />
      <Handle type="source" position={Position.Bottom} className="!w-2 !h-2 !bg-sky-400 !border-slate-900" />

      {/* Header */}
      <div className="flex items-center justify-between gap-1 pb-1.5 border-b border-slate-700/60">
        <div className="flex items-center gap-1.5">
          <Cpu className={`w-3.5 h-3.5 ${isInCycle ? 'text-red-400' : 'text-sky-400'}`} />
          <span className="font-mono text-xs font-bold text-slate-100">{safeData.label || safeData.id}</span>
        </div>
        <span className="text-[10px] font-mono text-slate-400">{safeData.workerId || 'w-0'}</span>
      </div>

      {/* State Badge */}
      <div className="mt-2 flex items-center justify-between">
        <span
          className={`text-[9px] font-mono font-semibold px-2 py-0.5 rounded-full border ${stateStyle.border} ${stateStyle.bg} ${stateStyle.text}`}
        >
          {safeData.state || 'RUNNING'}
        </span>
        {isInCycle && (
          <span className="flex items-center gap-0.5 text-[9px] font-mono font-bold text-red-300 bg-red-900/80 px-1.5 py-0.5 rounded border border-red-500 animate-pulse">
            <AlertTriangle className="w-2.5 h-2.5" />
            {isVictim ? 'VICTIM' : 'CYCLE'}
          </span>
        )}
      </div>

      {/* Priority & Locks stats */}
      <div className="mt-2 grid grid-cols-2 gap-1 text-[10px] text-slate-300 font-mono">
        <div className="flex items-center gap-1 bg-slate-900/60 px-1.5 py-0.5 rounded border border-slate-800">
          <Shield className="w-2.5 h-2.5 text-indigo-400" />
          <span>P:{safeData.effectivePriority ?? safeData.priority ?? 1}</span>
        </div>
        <div className="flex items-center gap-1 bg-slate-900/60 px-1.5 py-0.5 rounded border border-slate-800">
          <Lock className="w-2.5 h-2.5 text-emerald-400" />
          <span>Held:{safeData.locksCount ?? 0}</span>
        </div>
      </div>
    </div>
  );
});

TransactionNode.displayName = 'TransactionNode';

export const ResourceNode = memo(({ data }: { data?: GraphNodeData }) => {
  const safeData = data || {
    id: 'res-unknown',
    nodeType: 'resource' as const,
    label: 'Resource',
    holderTxId: '',
    waitersCount: 0,
  };

  const isHeld = !!safeData.holderTxId;

  return (
    <div
      className={`relative min-w-[150px] rounded-xl px-3 py-2.5 shadow-lg border transition-all duration-300 ${
        isHeld
          ? 'bg-slate-900/90 border-emerald-500/70 shadow-[0_0_15px_rgba(16,185,129,0.15)]'
          : 'bg-slate-900/60 border-slate-700/60'
      }`}
    >
      <Handle type="target" position={Position.Top} className="!w-2 !h-2 !bg-emerald-400 !border-slate-900" />
      <Handle type="source" position={Position.Bottom} className="!w-2 !h-2 !bg-emerald-400 !border-slate-900" />

      <div className="flex items-center gap-1.5 pb-1 border-b border-slate-800">
        <Layers className="w-3.5 h-3.5 text-emerald-400" />
        <span className="font-mono text-xs font-semibold text-slate-200 truncate">{safeData.label || safeData.id}</span>
      </div>

      <div className="mt-1.5 text-[10px] font-mono space-y-0.5">
        <div className="flex items-center justify-between text-slate-400">
          <span>Holder:</span>
          <span className={isHeld ? 'text-emerald-400 font-semibold' : 'text-slate-500'}>
            {safeData.holderTxId || 'FREE'}
          </span>
        </div>
        {(safeData.waitersCount ?? 0) > 0 && (
          <div className="flex items-center justify-between text-amber-400 font-semibold">
            <span>Waiters:</span>
            <span>{safeData.waitersCount}</span>
          </div>
        )}
      </div>
    </div>
  );
});

ResourceNode.displayName = 'ResourceNode';
