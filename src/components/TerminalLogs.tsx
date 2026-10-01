import React, { useRef, useEffect } from 'react';
import { Terminal, Trash2 } from 'lucide-react';

export interface LogEntry {
  id: string;
  message: string;
  level: 'info' | 'warn' | 'error' | 'success';
  timestamp: number;
}

interface TerminalLogsProps {
  logs: LogEntry[];
  onClear: () => void;
}

export const TerminalLogs: React.FC<TerminalLogsProps> = ({ logs, onClear }) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const levelStyles = {
    info: 'text-slate-300',
    warn: 'text-amber-400 font-semibold',
    error: 'text-rose-400 font-bold',
    success: 'text-emerald-400 font-semibold',
  };

  return (
    <div className="bg-slate-950 rounded-xl border border-slate-800 shadow-xl overflow-hidden flex flex-col h-[320px]">
      <div className="px-3.5 py-2 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5 text-sky-400" />
          <span className="text-xs font-mono font-bold text-slate-200">
            Engine Event Stream (/ws)
          </span>
          <span className="text-[10px] font-mono text-slate-400 px-1.5 py-0.5 rounded bg-slate-800">
            {logs.length} events
          </span>
        </div>
        <button
          onClick={onClear}
          className="text-slate-400 hover:text-slate-200 text-xs flex items-center gap-1 transition-colors p-1"
          title="Clear log"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      <div className="p-3 font-mono text-[11px] overflow-y-auto space-y-1 flex-1 leading-relaxed">
        {logs.length === 0 ? (
          <div className="text-slate-600 italic py-8 text-center">
            Waiting for concurrent worker events...
          </div>
        ) : (
          logs.map(log => (
            <div key={log.id} className="flex items-start gap-2 hover:bg-slate-900/40 px-1 rounded">
              <span className="text-slate-400 text-[10px] shrink-0 select-none">
                {new Date(log.timestamp).toLocaleTimeString()}.
                {String(log.timestamp % 1000).padStart(3, '0')}
              </span>
              <span className="text-slate-600 select-none">»</span>
              <span className={`break-all ${levelStyles[log.level]}`}>
                {log.message}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};
