import React, { useEffect, useMemo, useState } from 'react';
import { Bug, Check, Copy, Search, Trash2, X } from 'lucide-react';
import {
  clearDevErrorLogs,
  closeDevDebugPanel,
  MAX_DEV_ERROR_ENTRIES,
  subscribeDevDebugPanelOpen,
  subscribeDevErrorLog,
  toggleDevDebugPanel,
  type DevErrorEntry,
  type DevErrorSource,
} from '../lib/devErrorLog';

const SOURCE_LABELS: Record<DevErrorSource, { label: string; className: string }> = {
  uncaught: {
    label: 'UNCAUGHT',
    className: 'bg-red-950/70 text-red-300 border-red-700/60',
  },
  promise: {
    label: 'PROMISE',
    className: 'bg-orange-950/70 text-orange-300 border-orange-700/60',
  },
  react: {
    label: 'REACT',
    className: 'bg-rose-950/70 text-rose-300 border-rose-700/60',
  },
  console: {
    label: 'CONSOLE',
    className: 'bg-amber-950/70 text-amber-300 border-amber-700/60',
  },
  app: {
    label: 'APP',
    className: 'bg-sky-950/70 text-sky-300 border-sky-700/60',
  },
};

function formatTime(ts: number): string {
  try {
    const d = new Date(ts);
    const base = d.toLocaleTimeString('en-GB', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${base}.${ms}`;
  } catch {
    return String(ts);
  }
}

export const DevDebugLogPanel: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [entries, setEntries] = useState<DevErrorEntry[]>([]);
  const [sourceFilter, setSourceFilter] = useState<'all' | DevErrorSource>('all');
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const unsubOpen = subscribeDevDebugPanelOpen(setIsOpen);
    const unsubLogs = subscribeDevErrorLog(setEntries);

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        toggleDevDebugPanel();
        return;
      }
      if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        toggleDevDebugPanel();
        return;
      }
      if (e.key === 'Escape') {
        closeDevDebugPanel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      unsubOpen();
      unsubLogs();
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((item) => {
      if (sourceFilter !== 'all' && item.source !== sourceFilter) return false;
      if (!q) return true;
      return (
        item.message.toLowerCase().includes(q) ||
        item.source.toLowerCase().includes(q) ||
        (item.context ?? '').toLowerCase().includes(q) ||
        (item.stack ?? '').toLowerCase().includes(q)
      );
    });
  }, [entries, sourceFilter, query]);

  if (!import.meta.env.DEV || !isOpen) {
    return null;
  }

  const handleCopyReport = async () => {
    const payload = {
      generatedAt: new Date().toISOString(),
      url: typeof window !== 'undefined' ? window.location.href : '',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      totalEntries: entries.length,
      entries,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Fallback ignored if clipboard permissions are blocked
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Developer Error Log"
      className="no-print fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/65 backdrop-blur-[1px] p-0 sm:p-4"
      onClick={closeDevDebugPanel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-3xl max-h-[88vh] flex flex-col rounded-t-xl sm:rounded-lg border border-stone-700 bg-[#141413] text-stone-100 shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-stone-800 bg-[#1B1A18] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Bug className="w-4 h-4 text-amber-400 shrink-0" />
            <h2 className="text-sm font-semibold text-stone-100 tracking-tight">
              Dev Error Log
            </h2>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider bg-amber-950/80 text-amber-300 border border-amber-700/60">
              Dev Only
            </span>
            <span className="text-xs font-mono text-stone-400 tabular-nums">
              {entries.length}/{MAX_DEV_ERROR_ENTRIES}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleCopyReport}
              disabled={entries.length === 0}
              className="h-7 px-2.5 inline-flex items-center gap-1.5 rounded border border-stone-700 bg-stone-800/80 hover:bg-stone-700 text-[11px] font-medium text-stone-200 disabled:opacity-40 cursor-pointer"
            >
              {copied ? (
                <>
                  <Check className="w-3 h-3 text-emerald-400" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  <span>Copy JSON</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={clearDevErrorLogs}
              disabled={entries.length === 0}
              className="h-7 px-2.5 inline-flex items-center gap-1.5 rounded border border-stone-700 bg-stone-800/80 hover:bg-red-950/70 hover:border-red-800 text-[11px] font-medium text-stone-300 hover:text-red-200 disabled:opacity-40 cursor-pointer"
            >
              <Trash2 className="w-3 h-3" />
              <span>Clear</span>
            </button>

            <button
              type="button"
              onClick={closeDevDebugPanel}
              aria-label="Close dev error log"
              className="h-7 w-7 inline-flex items-center justify-center rounded border border-stone-700 bg-stone-800/80 hover:bg-stone-700 text-stone-300 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Filter & Search Bar */}
        <div className="px-4 py-2.5 border-b border-stone-800 bg-[#171614] flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="w-3.5 h-3.5 text-stone-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter errors, stack traces, or source…"
              className="w-full h-8 pl-8 pr-2.5 rounded border border-stone-700 bg-[#10100F] text-xs text-stone-100 placeholder:text-stone-500 focus:outline-none focus:border-amber-600"
            />
          </div>

          <div className="flex items-center gap-1 overflow-x-auto">
            {(['all', 'uncaught', 'promise', 'react', 'console', 'app'] as const).map((src) => (
              <button
                key={src}
                type="button"
                onClick={() => setSourceFilter(src)}
                className={`h-7 px-2 rounded text-[11px] font-medium uppercase tracking-wide border transition-colors cursor-pointer ${
                  sourceFilter === src
                    ? 'border-amber-600 bg-amber-950/60 text-amber-200'
                    : 'border-stone-800 bg-stone-900 text-stone-400 hover:text-stone-200'
                }`}
              >
                {src}
              </button>
            ))}
          </div>
        </div>

        {/* Entries List */}
        <div className="flex-1 overflow-y-auto divide-y divide-stone-800/80 font-mono text-xs">
          {filteredEntries.length === 0 ? (
            <div className="py-12 px-6 text-center text-stone-400 font-sans space-y-1.5">
              <p className="text-sm font-medium text-stone-300">
                {entries.length === 0
                  ? 'No errors captured in this dev session.'
                  : 'No error entries match the current filter.'}
              </p>
              <p className="text-xs text-stone-500">
                Shortcut: Ctrl/Cmd+Shift+D · Header logo: 5 rapid taps or long-press
              </p>
            </div>
          ) : (
            filteredEntries.map((entry, idx) => {
              const badge = SOURCE_LABELS[entry.source];
              const hasDetails = Boolean(entry.stack || entry.context);
              const isExpanded = expandedId === entry.id;
              return (
                <div key={entry.id} className="px-4 py-2.5 hover:bg-stone-900/60">
                  <div className="flex items-start gap-2.5">
                    <span className="text-[10px] text-stone-500 tabular-nums pt-0.5 shrink-0">
                      #{String(idx + 1).padStart(2, '0')} · {formatTime(entry.timestamp)}
                    </span>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border shrink-0 ${badge.className}`}
                    >
                      {badge.label}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-stone-100 break-words leading-relaxed">
                        {entry.message}
                      </p>
                      {entry.context && !isExpanded && (
                        <p className="mt-0.5 text-[11px] text-stone-400 truncate">
                          {entry.context}
                        </p>
                      )}
                    </div>
                    {hasDetails && (
                      <button
                        type="button"
                        onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                        className="shrink-0 h-6 px-2 rounded border border-stone-700 bg-stone-900 text-[10px] text-stone-300 hover:text-white cursor-pointer"
                      >
                        {isExpanded ? 'Hide' : 'Details'}
                      </button>
                    )}
                  </div>

                  {isExpanded && hasDetails && (
                    <div className="mt-2 ml-0 sm:ml-6 p-2.5 rounded border border-stone-800 bg-[#0B0B0A] text-[11px] text-stone-300 space-y-1.5 overflow-x-auto">
                      {entry.context && (
                        <div className="text-amber-300/90 break-all">
                          Context: {entry.context}
                        </div>
                      )}
                      {entry.stack && (
                        <pre className="whitespace-pre-wrap break-words text-stone-400 leading-relaxed">
                          {entry.stack}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
