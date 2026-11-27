export const MAX_DEV_ERROR_ENTRIES = 50;
const SESSION_STORAGE_KEY = 'bhashabook-dev-error-log-v1';

export type DevErrorSource = 'uncaught' | 'promise' | 'console' | 'react' | 'app';

export interface DevErrorEntry {
  id: string;
  timestamp: number;
  source: DevErrorSource;
  message: string;
  stack?: string;
  context?: string;
}

type LogListener = (entries: DevErrorEntry[]) => void;
type PanelListener = (open: boolean) => void;

let entries: DevErrorEntry[] = loadPersistedEntries();
const logListeners = new Set<LogListener>();
const panelListeners = new Set<PanelListener>();
let panelOpen = false;
let isCaptureInstalled = false;
let isHandlingConsoleError = false;

function loadPersistedEntries(): DevErrorEntry[] {
  if (!import.meta.env.DEV || typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is DevErrorEntry =>
          Boolean(item) &&
          typeof item.id === 'string' &&
          typeof item.timestamp === 'number' &&
          typeof item.source === 'string' &&
          typeof item.message === 'string'
      )
      .slice(0, MAX_DEV_ERROR_ENTRIES);
  } catch {
    return [];
  }
}

function persistEntries(next: DevErrorEntry[]): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore sessionStorage quota or privacy mode errors
  }
}

function notifyLogListeners(): void {
  const snapshot = entries;
  logListeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch {
      // Never break error logging on subscriber error
    }
  });
}

function setPanelOpenState(nextOpen: boolean): void {
  if (!import.meta.env.DEV) return;
  panelOpen = nextOpen;
  panelListeners.forEach((listener) => {
    try {
      listener(panelOpen);
    } catch {
      // ignore
    }
  });
}

function safeFormatValue(val: unknown): string {
  if (val instanceof Error) {
    return val.message || val.name || 'Error';
  }
  if (typeof val === 'string') return val;
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'bigint') {
    return String(val);
  }
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(val, (_k, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    });
  } catch {
    return Object.prototype.toString.call(val);
  }
}

function extractStack(val: unknown): string | undefined {
  if (val instanceof Error && typeof val.stack === 'string' && val.stack.trim()) {
    return val.stack.slice(0, 4000);
  }
  return undefined;
}

export function logDevError(
  source: DevErrorSource,
  errorOrMessage: unknown,
  context?: string
): void {
  if (!import.meta.env.DEV) return;

  const message =
    typeof errorOrMessage === 'string'
      ? errorOrMessage
      : safeFormatValue(errorOrMessage) || 'Unknown application error';
  const stack = extractStack(errorOrMessage);

  const entry: DevErrorEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    source,
    message: message.slice(0, 1500),
    stack,
    context: context ? context.slice(0, 1500) : undefined,
  };

  entries = [entry, ...entries].slice(0, MAX_DEV_ERROR_ENTRIES);
  persistEntries(entries);
  notifyLogListeners();
}

export function getDevErrorLogs(): DevErrorEntry[] {
  if (!import.meta.env.DEV) return [];
  return entries;
}

export function clearDevErrorLogs(): void {
  if (!import.meta.env.DEV) return;
  entries = [];
  persistEntries(entries);
  notifyLogListeners();
}

export function subscribeDevErrorLog(listener: LogListener): () => void {
  if (!import.meta.env.DEV) return () => {};
  logListeners.add(listener);
  listener(entries);
  return () => {
    logListeners.delete(listener);
  };
}

export function openDevDebugPanel(): void {
  setPanelOpenState(true);
}

export function closeDevDebugPanel(): void {
  setPanelOpenState(false);
}

export function toggleDevDebugPanel(): void {
  setPanelOpenState(!panelOpen);
}

export function isDevDebugPanelOpen(): boolean {
  return import.meta.env.DEV && panelOpen;
}

export function subscribeDevDebugPanelOpen(listener: PanelListener): () => void {
  if (!import.meta.env.DEV) return () => {};
  panelListeners.add(listener);
  listener(panelOpen);
  return () => {
    panelListeners.delete(listener);
  };
}

declare global {
  interface Window {
    __bhashabookDebug?: {
      open: () => void;
      close: () => void;
      toggle: () => void;
      getLogs: () => DevErrorEntry[];
      clearLogs: () => void;
    };
  }
}

export function installDevErrorCapture(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined' || isCaptureInstalled) return;
  isCaptureInstalled = true;

  // Allow URL query ?debug=1 or ?devlog=1 to open the hidden panel immediately in dev mode
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('debug') === '1' || params.get('devlog') === '1') {
      panelOpen = true;
    }
  } catch {
    // ignore URL parsing issues
  }

  window.__bhashabookDebug = {
    open: openDevDebugPanel,
    close: closeDevDebugPanel,
    toggle: toggleDevDebugPanel,
    getLogs: getDevErrorLogs,
    clearLogs: clearDevErrorLogs,
  };

  window.addEventListener(
    'error',
    (event: ErrorEvent) => {
      if (event.error) {
        const location = event.filename
          ? `${event.filename}:${event.lineno}:${event.colno}`
          : undefined;
        logDevError('uncaught', event.error, location);
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target && target !== (window as unknown as HTMLElement)) {
        const resourceUrl =
          (target as HTMLScriptElement).src ||
          (target as HTMLLinkElement).href ||
          target.tagName;
        logDevError(
          'uncaught',
          `Resource load error (${target.tagName.toLowerCase()})`,
          resourceUrl ? String(resourceUrl) : undefined
        );
        return;
      }

      if (event.message) {
        const location = event.filename
          ? `${event.filename}:${event.lineno}:${event.colno}`
          : undefined;
        logDevError('uncaught', event.message, location);
      }
    },
    true
  );

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    if (reason instanceof Error) {
      logDevError('promise', reason, 'Unhandled Promise Rejection');
    } else {
      logDevError(
        'promise',
        `Unhandled rejection: ${safeFormatValue(reason)}`,
        'Unhandled Promise Rejection'
      );
    }
  });

  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    originalConsoleError(...args);
    if (isHandlingConsoleError) return;
    isHandlingConsoleError = true;
    try {
      const firstError = args.find((a) => a instanceof Error);
      const formatted = args.map((a) => safeFormatValue(a)).join(' ');
      logDevError(
        'console',
        firstError && args.length === 1 ? firstError : formatted || 'console.error()',
        firstError ? extractStack(firstError) : undefined
      );
    } finally {
      isHandlingConsoleError = false;
    }
  };
}
