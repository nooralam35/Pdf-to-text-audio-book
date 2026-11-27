import { registerSW } from 'virtual:pwa-register';
import type { StoredBook } from '../types';
import { getBookPdfData, saveBook, stripBookBinary } from './storage';

export const OFFLINE_LIBRARY_CACHE = 'bhashabook-library-offline-v1';
export const PDFJS_ASSETS_CACHE = 'bhashabook-pdfjs-assets-v1';

export type ServiceWorkerStatus = 'unsupported' | 'registering' | 'active' | 'error';

export interface OfflineLibraryInspection {
  swStatus: ServiceWorkerStatus;
  swControlled: boolean;
  cachedBookIds: Set<string>;
  swCacheEntries: number;
  storageUsageBytes: number | null;
  storageQuotaBytes: number | null;
}

let swInitialized = false;
let currentSwStatus: ServiceWorkerStatus =
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    ? 'registering'
    : 'unsupported';

const swStatusListeners = new Set<(status: ServiceWorkerStatus) => void>();

function emitSwStatus(next: ServiceWorkerStatus) {
  currentSwStatus = next;
  swStatusListeners.forEach((cb) => cb(next));
}

export function subscribeServiceWorkerStatus(
  listener: (status: ServiceWorkerStatus) => void
): () => void {
  swStatusListeners.add(listener);
  listener(currentSwStatus);
  return () => {
    swStatusListeners.delete(listener);
  };
}

export function getServiceWorkerStatus(): ServiceWorkerStatus {
  return currentSwStatus;
}

export function getOfflineBookCacheUrl(bookId: string): string {
  return `/offline-library/books/${encodeURIComponent(bookId)}.pdf`;
}

/**
 * Registers the VitePWA Workbox Service Worker and monitors activation so
 * the My Library view, PDF.js assets, and saved PDFs work completely offline.
 */
export function initOfflineServiceWorker(): void {
  if (swInitialized || typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) {
    emitSwStatus('unsupported');
    return;
  }

  swInitialized = true;
  emitSwStatus('registering');

  try {
    // In Vite dev mode, register the lightweight classic /sw.js served by Express
    // (avoids VitePWA dev-dist module/importScripts conflicts and reload loops).
    if (import.meta.env.DEV) {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then((registration) => {
          if (registration.active || navigator.serviceWorker.controller) {
            emitSwStatus('active');
          }
          return navigator.serviceWorker.ready;
        })
        .then(() => {
          emitSwStatus('active');
        })
        .catch(() => {
          emitSwStatus('error');
        });

      navigator.serviceWorker.addEventListener('controllerchange', () => {
        emitSwStatus('active');
      });
      return;
    }

    registerSW({
      immediate: true,
      onRegisteredSW(_swUrl, registration) {
        if (registration?.active || navigator.serviceWorker.controller) {
          emitSwStatus('active');
        }
        navigator.serviceWorker.ready
          .then(() => {
            emitSwStatus('active');
          })
          .catch(() => {});
      },
      onOfflineReady() {
        emitSwStatus('active');
      },
      onRegisterError() {
        emitSwStatus('error');
      },
    });

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      emitSwStatus('active');
    });

    navigator.serviceWorker.ready
      .then(() => {
        emitSwStatus('active');
      })
      .catch(() => {});
  } catch {
    emitSwStatus('error');
  }
}

/**
 * Mirrors a PDF ArrayBuffer into Cache Storage under the service worker's
 * offline library cache bucket so both SW fetch interception and IndexedDB
 * have an offline copy ready.
 */
async function putPdfBufferIntoCache(
  cacheUrl: string,
  buffer: ArrayBuffer,
  fileName?: string
): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(OFFLINE_LIBRARY_CACHE);
    const copy = buffer.slice(0);
    const headers = new Headers({
      'Content-Type': 'application/pdf',
      'Content-Length': String(copy.byteLength),
      'X-BhashaBook-Offline-Cached': String(Date.now()),
    });
    if (fileName) {
      headers.set('X-BhashaBook-Filename', encodeURIComponent(fileName));
    }
    const response = new Response(copy, { status: 200, statusText: 'OK', headers });
    await cache.put(cacheUrl, response);
  } catch {
    // Storage quota or restricted iframe cache API — IndexedDB copy still works
  }
}

/**
 * Ensures a StoredBook's PDF binary is cached both in IndexedDB (pdfData) and
 * in the Service Worker's Cache Storage bucket. For URL-backed books (such as
 * the preloaded guidebook), downloads the PDF once and persists it offline.
 */
export async function cacheBookForOffline(book: StoredBook): Promise<StoredBook> {
  const localBuffer =
    book.pdfData && book.pdfData.byteLength > 0
      ? book.pdfData
      : book.hasLocalPdf
      ? await getBookPdfData(book.id)
      : undefined;

  if (localBuffer && localBuffer.byteLength > 0) {
    await putPdfBufferIntoCache(getOfflineBookCacheUrl(book.id), localBuffer, book.fileName);
    if (book.sourceUrl) {
      await putPdfBufferIntoCache(book.sourceUrl, localBuffer, book.fileName);
    }
    return stripBookBinary({ ...book, hasLocalPdf: true });
  }

  if (book.sourceUrl) {
    // Check Service Worker Cache Storage first before hitting the network
    let cachedHit = false;
    if (typeof caches !== 'undefined') {
      try {
        const cachedResp =
          (await caches.match(book.sourceUrl)) ??
          (await caches.match(getOfflineBookCacheUrl(book.id)));
        if (cachedResp && cachedResp.ok) {
          cachedHit = true;
        }
      } catch {
        // fallback to fetch
      }
    }

    if (cachedHit) {
      return stripBookBinary(book);
    }

    const resp = await fetch(book.sourceUrl);
    if (!resp.ok) {
      throw new Error(`Could not download PDF for offline access (HTTP ${resp.status}).`);
    }
    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength === 0) {
      throw new Error('Downloaded PDF file was empty.');
    }

    await putPdfBufferIntoCache(book.sourceUrl, buffer, book.fileName);
    await putPdfBufferIntoCache(getOfflineBookCacheUrl(book.id), buffer, book.fileName);

    // Only duplicate binary into IndexedDB if Cache Storage API is unavailable
    if (typeof caches === 'undefined') {
      await saveBook({ ...book, pdfData: buffer, hasLocalPdf: true });
      return stripBookBinary({ ...book, hasLocalPdf: true });
    }
    return stripBookBinary(book);
  }

  throw new Error('This book has no local PDF binary or downloadable URL.');
}

/**
 * Attempts to read a book's PDF bytes from Service Worker Cache Storage if
 * IndexedDB pdfData is not present (e.g. preloaded guidebook cached by SW).
 */
export async function getCachedBookBufferFromSW(book: StoredBook): Promise<ArrayBuffer | null> {
  if (typeof caches === 'undefined') return null;
  try {
    const candidates: string[] = [getOfflineBookCacheUrl(book.id)];
    if (book.sourceUrl) {
      candidates.unshift(book.sourceUrl);
    }
    for (const url of candidates) {
      const match = await caches.match(url);
      if (match && match.ok) {
        const buf = await match.arrayBuffer();
        if (buf.byteLength > 0) return buf;
      }
    }
  } catch {
    // ignore cache read failures
  }
  return null;
}

/**
 * Removes a deleted book's cached PDF entries from the Service Worker cache.
 */
export async function removeBookFromOfflineCache(book: StoredBook): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(OFFLINE_LIBRARY_CACHE);
    await cache.delete(getOfflineBookCacheUrl(book.id));
    if (book.sourceUrl) {
      await cache.delete(book.sourceUrl);
    }
  } catch {
    // ignore cleanup failures
  }
}

/**
 * Pre-warms essential PDF.js standard fonts and app shell assets inside the
 * Service Worker cache so PDF rendering works smoothly when completely offline.
 */
export async function warmPdfEngineOfflineAssets(): Promise<void> {
  if (typeof caches === 'undefined' || (typeof navigator !== 'undefined' && !navigator.onLine)) {
    return;
  }

  const coreFontUrls = [
    '/pdfjs/standard_fonts/LiberationSans-Regular.ttf',
    '/pdfjs/standard_fonts/LiberationSans-Bold.ttf',
    '/pdfjs/standard_fonts/LiberationSans-Italic.ttf',
    '/pdfjs/standard_fonts/FoxitSans.pfb',
    '/pdfjs/standard_fonts/FoxitSerif.pfb',
  ];

  try {
    const pdfCache = await caches.open(PDFJS_ASSETS_CACHE);
    await Promise.allSettled(
      coreFontUrls.map(async (url) => {
        const existing = await pdfCache.match(url);
        if (existing) return;
        const resp = await fetch(url);
        if (resp.ok) {
          await pdfCache.put(url, resp);
        }
      })
    );
  } catch {
    // non-fatal warm-up
  }
}

/**
 * Checks Service Worker readiness, which books are cached offline (IndexedDB
 * pdfData or Service Worker Cache Storage), and total local storage usage.
 */
export async function inspectOfflineLibraryCache(
  books: StoredBook[]
): Promise<OfflineLibraryInspection> {
  const cachedBookIds = new Set<string>();
  let swCacheEntries = 0;

  // Check IndexedDB pdfData / hasLocalPdf flag first
  for (const book of books) {
    if (book.hasLocalPdf || (book.pdfData && book.pdfData.byteLength > 0)) {
      cachedBookIds.add(book.id);
    }
  }

  // Check Service Worker Cache Storage for any additional cached URL books
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(OFFLINE_LIBRARY_CACHE);
      const keys = await cache.keys();
      swCacheEntries = keys.length;

      await Promise.all(
        books.map(async (book) => {
          if (cachedBookIds.has(book.id)) return;
          const byId = await cache.match(getOfflineBookCacheUrl(book.id));
          if (byId) {
            cachedBookIds.add(book.id);
            return;
          }
          if (book.sourceUrl) {
            const byUrl = await cache.match(book.sourceUrl);
            if (byUrl) {
              cachedBookIds.add(book.id);
            }
          }
        })
      );
    } catch {
      // Cache API unavailable
    }
  }

  let storageUsageBytes: number | null = null;
  let storageQuotaBytes: number | null = null;
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      storageUsageBytes = typeof est.usage === 'number' ? est.usage : null;
      storageQuotaBytes = typeof est.quota === 'number' ? est.quota : null;
    } catch {
      // ignore estimate failures
    }
  }

  const swControlled =
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    Boolean(navigator.serviceWorker.controller);

  return {
    swStatus: currentSwStatus,
    swControlled,
    cachedBookIds,
    swCacheEntries,
    storageUsageBytes,
    storageQuotaBytes,
  };
}

export function formatStorageBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
