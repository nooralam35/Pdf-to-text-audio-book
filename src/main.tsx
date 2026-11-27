import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { initOfflineServiceWorker } from './lib/offlineCache';
import {
  installDevErrorCapture,
  logDevError,
  openDevDebugPanel,
} from './lib/devErrorLog';
import { DevDebugLogPanel } from './components/DevDebugLogPanel';

installDevErrorCapture();
initOfflineServiceWorker();

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error?.message || 'Unexpected application error.' };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    logDevError('react', error, info.componentStack || undefined);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-[#FAF9F5] text-stone-900">
          <div className="max-w-md w-full rounded-lg border border-stone-200 bg-white p-6 shadow-sm space-y-3 text-center">
            <h1 className="text-lg font-semibold">Something went wrong</h1>
            <p className="text-sm text-stone-600">{this.state.message}</p>
            <div className="flex items-center justify-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex items-center justify-center h-9 px-4 rounded-md bg-stone-900 text-stone-50 text-sm font-medium hover:bg-stone-800 cursor-pointer"
              >
                Reload BhashaBook
              </button>
              {import.meta.env.DEV && (
                <button
                  type="button"
                  onClick={openDevDebugPanel}
                  className="inline-flex items-center justify-center h-9 px-3 rounded-md border border-stone-300 bg-white text-stone-700 text-sm font-medium hover:bg-stone-100 cursor-pointer"
                >
                  Dev Error Log
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
    {import.meta.env.DEV && <DevDebugLogPanel />}
  </>
);

