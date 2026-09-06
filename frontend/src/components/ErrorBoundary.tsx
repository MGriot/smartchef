import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/** Catches render-time crashes anywhere below it and shows the actual error
 *  instead of the blank white page React leaves behind otherwise — this app
 *  had no error boundary anywhere before this, so any uncaught render
 *  exception (a malformed draft, a bad API response shape, ...) was
 *  completely silent and undebuggable for anyone but a developer with
 *  DevTools open. "Try again" just re-renders the same tree (fixes a
 *  transient issue); a real bug also needs a full reload, offered below it. */
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('SmartChef: uncaught render error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-[#fafaf5] dark:bg-zinc-950 flex items-center justify-center p-6 font-outfit">
          <div className="w-full max-w-lg bg-white dark:bg-zinc-900 rounded-[32px] shadow-sm border border-zinc-100 dark:border-zinc-800 p-8 text-center">
            <span className="material-symbols-outlined text-4xl text-red-400 mb-3">error</span>
            <h1 className="text-xl font-black text-zinc-900 dark:text-zinc-100 mb-2">Something went wrong</h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4 font-mono break-words">
              {this.state.error.message}
            </p>
            <div className="flex gap-3 justify-center">
              <button
                type="button"
                onClick={() => this.setState({ error: null })}
                className="px-5 py-2.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 rounded-2xl font-bold text-sm hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="px-5 py-2.5 bg-primary text-white rounded-2xl font-bold text-sm hover:bg-primary/90 transition-colors"
              >
                Reload app
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
