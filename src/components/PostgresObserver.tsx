import React from 'react';
import { PostgresLockRecord } from '../types/index.ts';
import { Database, AlertOctagon, CheckCircle2, Search, ArrowRight } from 'lucide-react';

interface PostgresObserverProps {
  locks: PostgresLockRecord[];
  hasDeadlock: boolean;
  status: string;
}

export const PostgresObserver: React.FC<PostgresObserverProps> = ({
  locks,
  hasDeadlock,
  status,
}) => {
  return (
    <div className="bg-slate-900/80 rounded-xl border border-slate-800 shadow-xl overflow-hidden flex flex-col">
      <div className="p-3.5 bg-slate-950/70 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-sky-400" />
          <span className="font-mono text-xs font-bold text-slate-100">
            PostgreSQL Engine Lock Monitor (pg_locks & pg_stat_activity)
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
            OBSERVATION ONLY
          </span>
          {hasDeadlock ? (
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-rose-950 text-rose-300 border border-rose-600 font-bold flex items-center gap-1">
              <AlertOctagon className="w-3 h-3" />
              PG CYCLE OBSERVED
            </span>
          ) : (
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-600 flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" />
              HEALTHY
            </span>
          )}
        </div>
      </div>

      <div className="overflow-x-auto p-2">
        <table className="w-full text-left font-mono text-[11px]">
          <thead>
            <tr className="border-b border-slate-800 text-slate-400">
              <th className="p-2">PID</th>
              <th className="p-2">Database</th>
              <th className="p-2">Relation / Target</th>
              <th className="p-2">Lock Type</th>
              <th className="p-2">Mode</th>
              <th className="p-2">Status</th>
              <th className="p-2">Waiting For</th>
              <th className="p-2">Active Query</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {locks.map((lk, idx) => (
              <tr key={idx} className="hover:bg-slate-950/50">
                <td className="p-2 font-bold text-sky-400">{lk.pid}</td>
                <td className="p-2 text-slate-300">{lk.database}</td>
                <td className="p-2 text-indigo-300">{lk.relation}</td>
                <td className="p-2 text-slate-400">{lk.locktype}</td>
                <td className="p-2 text-amber-300">{lk.mode}</td>
                <td className="p-2">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] ${
                      lk.granted
                        ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                        : 'bg-rose-950 text-rose-300 border border-rose-800 animate-pulse'
                    }`}
                  >
                    {lk.granted ? 'GRANTED' : 'BLOCKED'}
                  </span>
                </td>
                <td className="p-2">
                  {lk.waitingForPid ? (
                    <span className="text-rose-400 font-bold flex items-center gap-1">
                      <ArrowRight className="w-3 h-3" /> PID {lk.waitingForPid}
                    </span>
                  ) : (
                    <span className="text-slate-600">—</span>
                  )}
                </td>
                <td className="p-2 text-[10px] text-slate-400 max-w-xs truncate font-mono" title={lk.query}>
                  {lk.query}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
