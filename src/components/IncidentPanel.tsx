import React, { useState } from 'react';
import { DeadlockIncident } from '../types/index.ts';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Shield,
  Layers,
  Activity,
  ArrowRight,
  TrendingDown,
  Info,
  Wrench,
  Sparkles,
  RefreshCw,
} from 'lucide-react';
import { ErrorBoundary } from './ErrorBoundary.tsx';

interface IncidentPanelProps {
  incidents: DeadlockIncident[];
  selectedIncidentId?: string;
  onSelectIncident: (id: string) => void;
  onSolveIncident?: (id: string) => Promise<void> | void;
  isSolving?: boolean;
}

const IncidentPanelInner: React.FC<IncidentPanelProps> = ({
  incidents = [],
  selectedIncidentId,
  onSelectIncident,
  onSolveIncident,
  isSolving = false,
}) => {
  const safeIncidents = Array.isArray(incidents) ? incidents : [];
  const currentIncident =
    safeIncidents.find(i => i && i.id === selectedIncidentId) || safeIncidents[0];

  if (!currentIncident || !currentIncident.id) {
    return (
      <div className="bg-slate-900/60 rounded-xl p-5 border border-slate-800 text-center flex flex-col items-center justify-center min-h-[300px]">
        <div className="w-12 h-12 rounded-full bg-slate-800/80 flex items-center justify-center mb-3">
          <CheckCircle2 className="w-6 h-6 text-emerald-400" />
        </div>
        <h3 className="text-sm font-semibold font-mono text-slate-200">No Active Deadlock Incidents</h3>
        <p className="text-xs text-slate-400 max-w-sm mt-1">
          The dependency graph is currently acyclic and healthy. Trigger a 2-Way or 3-Way Deadlock scenario to observe real-time cycle detection and automated resolution.
        </p>
      </div>
    );
  }

  const cyclePath = Array.isArray(currentIncident.cyclePath) ? currentIncident.cyclePath : [];
  const timelineSteps = Array.isArray(currentIncident.timeline) ? currentIncident.timeline : [];
  const altCandidates = Array.isArray(currentIncident.alternativeCandidates)
    ? currentIncident.alternativeCandidates
    : [];

  const factors = currentIncident.factors || {
    effectivePriority: 1,
    agingBonus: 0,
    locksHeld: 0,
    workDoneUnits: 0,
    rollbackCost: 0,
    retryCount: 0,
  };

  const detectionLatency =
    typeof currentIncident.detectionLatencyMs === 'number'
      ? currentIncident.detectionLatencyMs.toFixed(2)
      : '0.00';

  const isResolved = currentIncident.status === 'RESOLVED';
  const isResolving = currentIncident.status === 'RESOLVING' || isSolving;

  return (
    <div className="bg-slate-900/80 rounded-xl border border-slate-800 shadow-xl overflow-hidden flex flex-col">
      {/* Header */}
      <div className="p-3.5 bg-slate-950/70 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className={`w-7 h-7 rounded-lg border flex items-center justify-center ${
              isResolved
                ? 'bg-emerald-950/80 border-emerald-500/70 text-emerald-400'
                : 'bg-red-950/80 border-red-500/70 text-red-400'
            }`}
          >
            {isResolved ? (
              <CheckCircle2 className="w-4 h-4" />
            ) : (
              <AlertTriangle className="w-4 h-4" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-bold text-white">
                Incident {currentIncident.id}
              </span>
              <span
                className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-semibold border ${
                  isResolved
                    ? 'bg-emerald-950 text-emerald-300 border-emerald-600'
                    : isResolving
                    ? 'bg-amber-950 text-amber-300 border-amber-600 animate-pulse'
                    : 'bg-red-950 text-red-300 border-red-600'
                }`}
              >
                {currentIncident.status || 'DETECTED'}
              </span>
            </div>
            <span className="text-[11px] font-mono text-slate-400">
              Detected in {detectionLatency}ms •{' '}
              {new Date(currentIncident.timestamp || Date.now()).toLocaleTimeString()}
            </span>
          </div>
        </div>

        {safeIncidents.length > 1 && (
          <select
            value={currentIncident.id}
            onChange={e => onSelectIncident(e.target.value)}
            className="bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono rounded-lg px-2 py-1 outline-none"
          >
            {safeIncidents.map((inc, i) => (
              <option key={inc.id || `inc-${i}`} value={inc.id}>
                {inc.id} ({inc.status || 'DETECTED'})
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="p-4 space-y-4 overflow-y-auto max-h-[560px]">
        {/* SOLVE BUTTON CALLOUT BANNER */}
        {!isResolved && (
          <div className="p-3 rounded-xl bg-gradient-to-r from-red-950/60 to-rose-950/60 border border-red-500/50 shadow-lg flex items-center justify-between gap-3">
            <div>
              <span className="font-mono text-xs font-bold text-white block">
                Deadlock Resolution Required
              </span>
              <span className="text-[11px] text-slate-300">
                Victim selected: <strong className="text-amber-400 font-mono">{currentIncident.victimId}</strong>. Trigger rollback & safe retry.
              </span>
            </div>

            <button
              onClick={() => onSolveIncident && onSolveIncident(currentIncident.id)}
              disabled={isResolving}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-mono text-xs font-bold shadow-lg shadow-emerald-950/50 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shrink-0"
            >
              {isResolving ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Resolving...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                  <span>Solve Deadlock</span>
                </>
              )}
            </button>
          </div>
        )}

        {isResolved && (
          <div className="p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-500/40 text-emerald-300 text-xs font-mono flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>Deadlock Resolved: All locks released & retry succeeded.</span>
            </span>
            <span className="text-[10px] text-emerald-500 font-bold uppercase">Healthy</span>
          </div>
        )}

        {/* Cycle Path Visualization */}
        {cyclePath.length > 0 && (
          <div>
            <span className="text-xs font-mono font-semibold text-slate-400 uppercase tracking-wider block mb-1.5">
              Detected Dependency Cycle
            </span>
            <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800/80 flex flex-wrap items-center gap-1.5 font-mono text-xs">
              {cyclePath.map((item, idx) => {
                const isResource = idx % 2 === 1;
                const isVictim = item === currentIncident.victimId;
                return (
                  <React.Fragment key={`cycle-step-${idx}-${item}`}>
                    <span
                      className={`px-2 py-0.5 rounded border text-[11px] font-semibold ${
                        isVictim
                          ? 'bg-rose-950 text-rose-300 border-rose-500 shadow-sm shadow-rose-950'
                          : isResource
                          ? 'bg-slate-900 text-emerald-400 border-emerald-900/60'
                          : 'bg-slate-900 text-sky-300 border-sky-900/60'
                      }`}
                    >
                      {item} {isVictim && '★ VICTIM'}
                    </span>
                    {idx < cyclePath.length - 1 && (
                      <ArrowRight className="w-3.5 h-3.5 text-slate-500" />
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        )}

        {/* Explainable Victim Selection */}
        <div className="bg-slate-950/60 p-3.5 rounded-lg border border-slate-800 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono font-semibold text-indigo-400 flex items-center gap-1.5">
              <TrendingDown className="w-3.5 h-3.5" />
              Explainable Victim Selection Decision
            </span>
            <span className="text-xs font-mono text-slate-400">
              Survival Score: <span className="text-amber-400 font-bold">{currentIncident.victimScore ?? 0}</span>
            </span>
          </div>

          <p className="text-xs text-slate-300 leading-relaxed font-sans bg-slate-900/90 p-2.5 rounded border border-slate-800">
            {currentIncident.explanation || 'No explanation provided.'}
          </p>

          {/* Factor Breakdown */}
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2 text-center pt-1 font-mono text-[10px]">
            <div className="bg-slate-900/80 p-1.5 rounded border border-slate-800">
              <span className="text-slate-400 block text-[9px]">Base Priority</span>
              <span className="font-bold text-white">
                {((factors.effectivePriority || 1) - (factors.agingBonus || 0)).toFixed(0)}
              </span>
            </div>
            <div className="bg-slate-900/80 p-1.5 rounded border border-slate-800">
              <span className="text-slate-400 block text-[9px]">Aging Bonus</span>
              <span className="font-bold text-sky-400">
                +{(factors.agingBonus || 0).toFixed(1)}
              </span>
            </div>
            <div className="bg-slate-900/80 p-1.5 rounded border border-slate-800">
              <span className="text-slate-400 block text-[9px]">Locks Held</span>
              <span className="font-bold text-emerald-400">{factors.locksHeld || 0}</span>
            </div>
            <div className="bg-slate-900/80 p-1.5 rounded border border-slate-800">
              <span className="text-slate-400 block text-[9px]">Work Units</span>
              <span className="font-bold text-indigo-400">{factors.workDoneUnits || 0}</span>
            </div>
            <div className="bg-slate-900/80 p-1.5 rounded border border-slate-800">
              <span className="text-slate-400 block text-[9px]">Rollback Cost</span>
              <span className="font-bold text-rose-400">{factors.rollbackCost || 0}</span>
            </div>
            <div className="bg-slate-900/80 p-1.5 rounded border border-slate-800">
              <span className="text-slate-400 block text-[9px]">Prior Retries</span>
              <span className="font-bold text-amber-400">{factors.retryCount || 0}</span>
            </div>
          </div>
        </div>

        {/* Alternative Candidates */}
        {altCandidates.length > 0 && (
          <div>
            <span className="text-xs font-mono font-semibold text-slate-400 uppercase tracking-wider block mb-1">
              Alternative Candidates Survived
            </span>
            <div className="space-y-1.5">
              {altCandidates.map((alt, altIdx) => (
                <div
                  key={`alt-${alt.txId || altIdx}`}
                  className="bg-slate-950/60 p-2 rounded border border-slate-800 flex items-center justify-between text-xs font-mono"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sky-300 font-semibold">{alt.txId}</span>
                    <span className="text-slate-400 text-[11px]">{alt.reason}</span>
                  </div>
                  <span className="text-emerald-400 font-bold bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/60 text-[11px]">
                    Score: {alt.score}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Resolution Timeline */}
        {timelineSteps.length > 0 && (
          <div>
            <span className="text-xs font-mono font-semibold text-slate-400 uppercase tracking-wider block mb-2">
              Resolution & Automated Recovery Timeline
            </span>
            <div className="relative pl-6 space-y-3 before:absolute before:left-2 before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-800">
              {timelineSteps.map((step, idx) => (
                <div
                  key={`step-${idx}-${step.step || 'step'}-${step.timestamp || idx}`}
                  className="relative text-xs font-mono"
                >
                  <span
                    className={`absolute -left-[21px] top-1 w-2.5 h-2.5 rounded-full border-2 border-slate-950 ${
                      step.step === 'RECOVERED'
                        ? 'bg-emerald-400'
                        : step.step === 'ROLLBACK_STARTED'
                        ? 'bg-rose-400'
                        : 'bg-sky-400'
                    }`}
                  ></span>
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-200">{step.step}</span>
                    <span className="text-[10px] text-slate-500">
                      {new Date(step.timestamp || Date.now()).toLocaleTimeString()}
                    </span>
                  </div>
                  {step.details && (
                    <p className="text-[11px] text-slate-400 mt-0.5 font-sans leading-normal">
                      {step.details}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export const IncidentPanel: React.FC<IncidentPanelProps> = (props) => {
  return (
    <ErrorBoundary fallbackTitle="Incident Panel Safeguard">
      <IncidentPanelInner {...props} />
    </ErrorBoundary>
  );
};
