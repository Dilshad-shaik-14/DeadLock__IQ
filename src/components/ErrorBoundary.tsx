import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertOctagon, RotateCcw, ShieldAlert } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[DeadLockIQ ErrorBoundary] Caught render error:', error, errorInfo);
    this.setState({ error, errorInfo });
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  private handleFullReload = () => {
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[280px] p-6 m-3 rounded-2xl bg-red-950/40 border border-red-500/50 shadow-2xl flex flex-col justify-center items-center text-center backdrop-blur-md">
          <div className="w-12 h-12 rounded-xl bg-red-900/60 border border-red-500 flex items-center justify-center text-red-300 mb-3 shadow-lg shadow-red-950">
            <AlertOctagon className="w-6 h-6 animate-pulse" />
          </div>

          <h2 className="text-base font-bold font-mono text-red-200 tracking-wide">
            {this.props.fallbackTitle || 'Component Render Safeguard Triggered'}
          </h2>

          <p className="text-xs text-slate-300 font-sans max-w-md mt-1 mb-4 leading-relaxed">
            The application intercepted an unexpected render exception and prevented a blank screen crash. Concurrency state is preserved.
          </p>

          {this.state.error && (
            <div className="w-full max-w-lg bg-slate-950/90 border border-red-900/60 rounded-lg p-3 text-left font-mono text-[11px] text-red-400 overflow-x-auto mb-4">
              <span className="font-bold text-red-300 block mb-1">
                {this.state.error.name}: {this.state.error.message}
              </span>
              {this.state.errorInfo?.componentStack && (
                <pre className="text-[10px] text-slate-500 whitespace-pre-wrap leading-tight max-h-28 overflow-y-auto">
                  {this.state.errorInfo.componentStack}
                </pre>
              )}
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={this.handleReset}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white font-mono text-xs font-semibold shadow-lg transition-all active:scale-95 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Retry Render</span>
            </button>
            <button
              onClick={this.handleFullReload}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 font-mono text-xs font-semibold transition-all cursor-pointer"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
