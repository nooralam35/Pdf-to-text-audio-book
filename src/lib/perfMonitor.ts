import type { ProfilerOnRenderCallback } from 'react';

export type PerfPhase = 'mount' | 'update' | 'nested-update' | 'canvas' | 'task';

export interface PerfMetricEntry {
  id: string;
  pane: string;
  phase: PerfPhase;
  durationMs: number;
  baseDurationMs?: number;
  timestamp: number;
  detail?: string;
  isSlow: boolean;
}

export interface PanePerfSummary {
  pane: string;
  renders: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  lastMs: number;
  totalMs: number;
  slowRenders: number;
}

interface PaneAccumulator {
  pane: string;
  renders: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  lastMs: number;
  slowRenders: number;
}

const MAX_PERF_ENTRIES = 200;
const PERF_LOG_STORAGE_KEY = 'bhashabook-perf-logs';
const DEFAULT_REACT_SLOW_MS = 16.67; // 60fps frame budget
const DEFAULT_CANVAS_SLOW_MS = 120;

const recentEntries: PerfMetricEntry[] = [];
const summaryMap = new Map<string, PaneAccumulator>();
let seqCounter = 0;

function resolveInitialConsoleLogging(): boolean {
  if (typeof window === 'undefined') return Boolean(import.meta.env.DEV);
  try {
    const stored = window.localStorage.getItem(PERF_LOG_STORAGE_KEY);
    if (stored === 'true' || stored === '1') return true;
    if (stored === 'false' || stored === '0') return false;
  } catch {
    // ignore storage restrictions
  }
  return Boolean(import.meta.env.DEV);
}

let consoleLoggingEnabled = resolveInitialConsoleLogging();

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

export function setPerfConsoleLogging(enabled: boolean): void {
  consoleLoggingEnabled = enabled;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(PERF_LOG_STORAGE_KEY, enabled ? 'true' : 'false');
    } catch {
      // ignore storage errors
    }
  }
}

export function isPerfConsoleLoggingEnabled(): boolean {
  return consoleLoggingEnabled;
}

export function recordPerfSample(params: {
  pane: string;
  phase: PerfPhase;
  durationMs: number;
  baseDurationMs?: number;
  detail?: string;
  slowThresholdMs?: number;
}): PerfMetricEntry {
  const durationMs = roundMs(Math.max(0, params.durationMs));
  const baseDurationMs =
    typeof params.baseDurationMs === 'number' && Number.isFinite(params.baseDurationMs)
      ? roundMs(Math.max(0, params.baseDurationMs))
      : undefined;
  const threshold =
    params.slowThresholdMs ??
    (params.phase === 'canvas' || params.phase === 'task'
      ? DEFAULT_CANVAS_SLOW_MS
      : DEFAULT_REACT_SLOW_MS);
  const isSlow = durationMs >= threshold;

  const entry: PerfMetricEntry = {
    id: `perf-${++seqCounter}`,
    pane: params.pane,
    phase: params.phase,
    durationMs,
    baseDurationMs,
    timestamp: Date.now(),
    detail: params.detail,
    isSlow,
  };

  recentEntries.push(entry);
  if (recentEntries.length > MAX_PERF_ENTRIES) {
    recentEntries.shift();
  }

  let acc = summaryMap.get(params.pane);
  if (!acc) {
    acc = {
      pane: params.pane,
      renders: 0,
      totalMs: 0,
      minMs: durationMs,
      maxMs: durationMs,
      lastMs: durationMs,
      slowRenders: 0,
    };
    summaryMap.set(params.pane, acc);
  }
  acc.renders += 1;
  acc.totalMs += durationMs;
  if (durationMs < acc.minMs) acc.minMs = durationMs;
  if (durationMs > acc.maxMs) acc.maxMs = durationMs;
  acc.lastMs = durationMs;
  if (isSlow) acc.slowRenders += 1;

  if (consoleLoggingEnabled) {
    const baseTag =
      baseDurationMs !== undefined ? ` (base: ${baseDurationMs.toFixed(2)}ms)` : '';
    const detailTag = params.detail ? ` — ${params.detail}` : '';
    const msg = `[Perf][${params.pane}] ${params.phase} ${durationMs.toFixed(2)}ms${baseTag}${detailTag}`;
    if (isSlow) {
      console.warn(msg);
    } else {
      console.debug(msg);
    }
  }

  return entry;
}

/**
 * Creates a stable React <Profiler> onRender callback that logs commit duration
 * and base duration without causing any React state updates.
 */
export function createProfilerOnRender(
  paneName: string,
  slowThresholdMs = DEFAULT_REACT_SLOW_MS
): ProfilerOnRenderCallback {
  return (id, phase, actualDuration, baseDuration) => {
    const resolvedPane = paneName || id;
    recordPerfSample({
      pane: resolvedPane,
      phase,
      durationMs: actualDuration,
      baseDurationMs: baseDuration,
      slowThresholdMs,
    });
  };
}

/**
 * Starts a high-resolution span timer (using performance.now + User Timing marks)
 * for non-React operations like PDF.js canvas rasterization or full-book search.
 */
export function startPerfSpan(
  paneName: string,
  phase: 'canvas' | 'task' = 'canvas',
  detail?: string,
  slowThresholdMs?: number
): { end: (extraDetail?: string) => PerfMetricEntry | null } {
  const perfApi = typeof performance !== 'undefined' ? performance : null;
  const startTime = perfApi ? perfApi.now() : Date.now();
  const markId = perfApi && consoleLoggingEnabled ? `bb:${paneName}:${++seqCounter}` : null;
  const startMark = markId ? `${markId}:start` : null;
  const endMark = markId ? `${markId}:end` : null;

  if (perfApi && startMark) {
    try {
      perfApi.mark(startMark);
    } catch {
      // ignore restricted performance API
    }
  }

  let finished = false;
  return {
    end: (extraDetail?: string) => {
      if (finished) return null;
      finished = true;
      const endTime = perfApi ? perfApi.now() : Date.now();
      const durationMs = endTime - startTime;

      if (perfApi && startMark && endMark && markId) {
        try {
          perfApi.mark(endMark);
          perfApi.measure(markId, startMark, endMark);
          // Immediately clear marks/measures to prevent Performance timeline memory growth
          perfApi.clearMarks(startMark);
          perfApi.clearMarks(endMark);
          perfApi.clearMeasures(markId);
        } catch {
          // ignore
        }
      }

      const mergedDetail =
        detail && extraDetail ? `${detail} (${extraDetail})` : extraDetail ?? detail;

      return recordPerfSample({
        pane: paneName,
        phase,
        durationMs,
        detail: mergedDetail,
        slowThresholdMs,
      });
    },
  };
}

export function getPerfSummary(): PanePerfSummary[] {
  return Array.from(summaryMap.values())
    .map((acc) => ({
      pane: acc.pane,
      renders: acc.renders,
      avgMs: acc.renders > 0 ? roundMs(acc.totalMs / acc.renders) : 0,
      minMs: roundMs(acc.minMs),
      maxMs: roundMs(acc.maxMs),
      lastMs: roundMs(acc.lastMs),
      totalMs: roundMs(acc.totalMs),
      slowRenders: acc.slowRenders,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

export function getPerfEntries(pane?: string): PerfMetricEntry[] {
  if (!pane) return [...recentEntries];
  return recentEntries.filter((e) => e.pane === pane);
}

export function clearPerfMetrics(): void {
  recentEntries.length = 0;
  summaryMap.clear();
}

export function printPerfReport(): PanePerfSummary[] {
  const summary = getPerfSummary();
  if (typeof console !== 'undefined') {
    if (summary.length === 0) {
      console.info('[Perf] No render metrics recorded yet.');
    } else if (typeof console.table === 'function') {
      console.table(summary);
    } else {
      console.info('[Perf] Summary:', summary);
    }
  }
  return summary;
}

declare global {
  interface Window {
    __bhashabookPerf?: {
      getSummary: () => PanePerfSummary[];
      getEntries: (pane?: string) => PerfMetricEntry[];
      printReport: () => PanePerfSummary[];
      clear: () => void;
      setLogging: (enabled: boolean) => void;
      isLoggingEnabled: () => boolean;
    };
  }
}

export function installPerfMonitorGlobal(): void {
  if (typeof window === 'undefined') return;
  window.__bhashabookPerf = {
    getSummary: getPerfSummary,
    getEntries: getPerfEntries,
    printReport: printPerfReport,
    clear: clearPerfMetrics,
    setLogging: setPerfConsoleLogging,
    isLoggingEnabled: isPerfConsoleLoggingEnabled,
  };
}
