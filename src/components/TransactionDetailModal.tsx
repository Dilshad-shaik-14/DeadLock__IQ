import React from 'react';
import { Transaction } from '../types/index.ts';
import { X, Clock, Shield, Lock, Cpu, RotateCw, History } from 'lucide-react';

interface TransactionDetailModalProps {
  transaction: Transaction | null;
  onClose: () => void;
}

export const TransactionDetailModal: React.FC<TransactionDetailModalProps> = ({
  transaction,
  onClose,
}) => {
  if (!transaction) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-4 bg-slate-950/80 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-sky-400" />
            <div>
              <h3 className="font-mono text-sm font-bold text-white">
                Transaction Inspector: {transaction.id}
              </h3>
              <span className="text-[11px] font-mono text-slate-400">
                Worker: {transaction.workerId}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4 overflow-y-auto font-mono text-xs">
          {/* Quick Metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
            <div className="bg-slate-950 p-2 rounded-lg border border-slate-800">
              <span className="text-slate-500 block text-[10px]">State</span>
              <span className="font-bold text-sky-400">{transaction.state}</span>
            </div>
            <div className="bg-slate-950 p-2 rounded-lg border border-slate-800">
              <span className="text-slate-500 block text-[10px]">Effective Priority</span>
              <span className="font-bold text-indigo-400">{transaction.effectivePriority}</span>
            </div>
            <div className="bg-slate-950 p-2 rounded-lg border border-slate-800">
              <span className="text-slate-500 block text-[10px]">Retry Count</span>
              <span className="font-bold text-amber-400">
                {transaction.retryCount} / {transaction.maxRetries}
              </span>
            </div>
            <div className="bg-slate-950 p-2 rounded-lg border border-slate-800">
              <span className="text-slate-500 block text-[10px]">Fencing Token</span>
              <span className="font-bold text-emerald-400">
                {transaction.fencingToken ?? 'N/A'}
              </span>
            </div>
          </div>

          {/* Locks Held & Waiting */}
          <div className="space-y-2">
            <span className="font-bold text-slate-300 flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-emerald-400" />
              Held Distributed Locks ({transaction.locksHeld.length})
            </span>
            {transaction.locksHeld.length === 0 ? (
              <div className="text-slate-500 italic p-2 bg-slate-950 rounded border border-slate-800">
                No active locks currently held.
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {transaction.locksHeld.map(r => (
                  <span
                    key={r}
                    className="px-2 py-0.5 rounded bg-emerald-950/70 text-emerald-300 border border-emerald-700/60"
                  >
                    {r}
                  </span>
                ))}
              </div>
            )}

            {transaction.waitingForLock && (
              <div className="mt-2 p-2 bg-amber-950/60 rounded border border-amber-700/60 flex items-center justify-between text-amber-300">
                <span>Blocked waiting for:</span>
                <span className="font-bold">{transaction.waitingForLock}</span>
              </div>
            )}
          </div>

          {/* State History Audit Trail */}
          <div className="space-y-2">
            <span className="font-bold text-slate-300 flex items-center gap-1.5">
              <History className="w-3.5 h-3.5 text-sky-400" />
              State Machine Audit Trail
            </span>
            <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800 space-y-2 max-h-48 overflow-y-auto">
              {transaction.history.map((h, i) => (
                <div key={i} className="flex items-start justify-between border-b border-slate-900 pb-1 last:border-0 last:pb-0">
                  <div>
                    <span className="font-bold text-sky-300">{h.state}</span>
                    {h.reason && <p className="text-[10px] text-slate-400">{h.reason}</p>}
                  </div>
                  <span className="text-[10px] text-slate-500 shrink-0">
                    {new Date(h.timestamp).toLocaleTimeString()}.
                    {String(h.timestamp % 1000).padStart(3, '0')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-3 bg-slate-950/80 border-t border-slate-800 text-right">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-mono transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
