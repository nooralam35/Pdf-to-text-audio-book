import React, { useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  BookOpen,
  CheckCircle2,
  CloudDownload,
  Compass,
  Download,
  HardDrive,
  Headphones,
  Languages,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  WifiOff,
  X,
} from 'lucide-react';
import { PRELOADED_OBS_BOOK_ID } from '../lib/languages';
import { formatStorageBytes, type ServiceWorkerStatus } from '../lib/offlineCache';
import type { StoredBook } from '../types';
import { PWAInstallButton } from './PWAInstallButton';

type LibraryFilterTab = 'all' | 'bookmarked' | 'listened' | 'offline';

interface LibraryViewProps {
  books: StoredBook[];
  activeBookId: string | null;
  translatedCountsByBook: Record<string, number>;
  allLangTranslationCountsByBook: Record<string, number>;
  isOnline: boolean;
  swStatus: ServiceWorkerStatus;
  cachedBookIds: Set<string>;
  storageUsageBytes: number | null;
  cachingBookId: string | null;
  downloadingBookId?: string | null;
  isSyncingAllOffline: boolean;
  onSelectBook: (book: StoredBook) => void;
  onListenBook: (book: StoredBook) => void;
  onTranslateBook: (book: StoredBook) => void;
  onDownloadBook: (book: StoredBook) => void;
  onToggleBookBookmark: (bookId: string) => void;
  onUploadPdf: (file: File) => void;
  onDeleteBook: (bookId: string) => void;
  onCacheBookOffline: (book: StoredBook) => void;
  onSyncAllOffline: () => void;
  onGoToDiscover?: () => void;
  isUploading: boolean;
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  books,
  activeBookId,
  translatedCountsByBook,
  allLangTranslationCountsByBook,
  isOnline,
  swStatus,
  cachedBookIds,
  storageUsageBytes,
  cachingBookId,
  downloadingBookId = null,
  isSyncingAllOffline,
  onSelectBook,
  onListenBook,
  onTranslateBook,
  onDownloadBook,
  onToggleBookBookmark,
  onUploadPdf,
  onDeleteBook,
  onCacheBookOffline,
  onSyncAllOffline,
  onGoToDiscover,
  isUploading,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<LibraryFilterTab>('all');

  const isBookOfflineReady = (book: StoredBook): boolean =>
    cachedBookIds.has(book.id) || Boolean(book.pdfData && book.pdfData.byteLength > 0);

  const offlineReadyCount = useMemo(
    () => books.filter((b) => isBookOfflineReady(b)).length,
    [books, cachedBookIds]
  );

  const bookmarkedCount = useMemo(
    () => books.filter((b) => Boolean(b.isBookmarked)).length,
    [books]
  );

  const listenedCount = useMemo(
    () =>
      books.filter(
        (b) => b.lastAudioPage !== undefined || b.lastSentenceIndex !== undefined
      ).length,
    [books]
  );

  const totalCachedTranslations = useMemo(
    () => Object.values(allLangTranslationCountsByBook).reduce((sum, n) => sum + n, 0),
    [allLangTranslationCountsByBook]
  );

  const filteredBooks = useMemo(() => {
    const trimmed = searchQuery.trim().toLowerCase();
    const tokens = trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];
    return books.filter((book) => {
      if (activeFilter === 'offline' && !isBookOfflineReady(book)) {
        return false;
      }
      if (activeFilter === 'bookmarked' && !book.isBookmarked) {
        return false;
      }
      if (
        activeFilter === 'listened' &&
        book.lastAudioPage === undefined &&
        book.lastSentenceIndex === undefined
      ) {
        return false;
      }
      if (tokens.length === 0) return true;
      const haystack = `${book.title ?? ''} ${book.author ?? ''}`.toLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
  }, [books, searchQuery, activeFilter, cachedBookIds]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.name.toLowerCase().endsWith('.pdf')) {
      onUploadPdf(file);
    }
  };

  const hasQuery = searchQuery.trim().length > 0;
  const hasActiveFilter = hasQuery || activeFilter !== 'all';
  const uncachedCount = Math.max(0, books.length - offlineReadyCount);

  const swStatusLabel = !isOnline
    ? 'Offline mode active · serving cached books & reader engine locally'
    : swStatus === 'active'
    ? 'Service worker active · My Library & reader cached for offline access'
    : swStatus === 'registering'
    ? 'Activating offline service worker cache…'
    : 'Local IndexedDB offline storage active';

  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-7">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 pb-5">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-semibold tracking-tight text-stone-950 sepia:text-[#2F241A] dark:text-stone-50">
            My Library, Bookmarks &amp; Audio History
          </h1>
          <p className="mt-1.5 text-sm text-stone-600 sepia:text-[#5B4938] dark:text-stone-400">
            Every book you open, listen to, bookmark, or download is recorded here automatically —
            resume reading or listening from your exact page &amp; line anytime, online or offline.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <PWAInstallButton />
          {onGoToDiscover && (
            <button
              type="button"
              onClick={onGoToDiscover}
              disabled={!isOnline}
              title={
                isOnline
                  ? 'Search free public-domain books online'
                  : 'Reconnect to search online repositories'
              }
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-stone-300 sepia:border-[#D4C6AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] text-xs font-medium text-stone-800 sepia:text-[#3B2F23] dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
            >
              <Compass className="w-3.5 h-3.5 text-amber-700 dark:text-amber-500" />
              <span>Discover Free Books</span>
            </button>
          )}
        </div>
      </div>

      {/* Offline Service Worker & Local Cache Summary Strip */}
      <section
        aria-label="Offline cache status"
        className="rounded-lg border border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] px-4 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
      >
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2 text-xs font-medium text-stone-900 sepia:text-[#2F241A] dark:text-stone-100">
            {!isOnline ? (
              <WifiOff className="w-4 h-4 text-amber-700 dark:text-amber-500 shrink-0" />
            ) : (
              <HardDrive className="w-4 h-4 text-amber-700 dark:text-amber-500 shrink-0" />
            )}
            <span className="truncate">{swStatusLabel}</span>
          </div>
          <p className="text-xs font-mono-num text-stone-500 sepia:text-[#6E5A47] dark:text-stone-400 pl-6">
            {offlineReadyCount} / {books.length} {books.length === 1 ? 'PDF' : 'PDFs'} cached
            offline · {bookmarkedCount} bookmarked · {totalCachedTranslations} translated{' '}
            {totalCachedTranslations === 1 ? 'page' : 'pages'} saved
            {storageUsageBytes !== null ? ` · ${formatStorageBytes(storageUsageBytes)} local storage` : ''}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0 pl-6 sm:pl-0">
          <button
            type="button"
            disabled={!isOnline || isSyncingAllOffline || books.length === 0}
            onClick={onSyncAllOffline}
            title={
              !isOnline
                ? 'Reconnect to cache additional books offline'
                : uncachedCount > 0
                ? `Download and cache ${uncachedCount} remaining book(s) plus PDF viewer fonts for offline reading`
                : 'Verify offline cache and pre-warm PDF.js fonts for offline reading'
            }
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-stone-300 sepia:border-[#D4C6AA] dark:border-stone-700 bg-[#FAF9F5] sepia:bg-[#F4ECD8] dark:bg-[#22211E] hover:bg-stone-100 dark:hover:bg-stone-800 text-xs font-medium text-stone-800 sepia:text-[#3B2F23] dark:text-stone-200 disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap transition-colors"
          >
            {isSyncingAllOffline ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-700 dark:text-amber-500" />
                <span>Caching Library…</span>
              </>
            ) : uncachedCount > 0 ? (
              <>
                <CloudDownload className="w-3.5 h-3.5 text-amber-700 dark:text-amber-500" />
                <span>Cache All Offline ({uncachedCount})</span>
              </>
            ) : (
              <>
                <RefreshCw className="w-3.5 h-3.5 text-amber-700 dark:text-amber-500" />
                <span>Verify Offline Cache</span>
              </>
            )}
          </button>
        </div>
      </section>

      {/* Drag & Drop Upload Zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`rounded-lg border border-dashed p-5 sm:p-6 text-center transition-colors ${
          isDragging
            ? 'border-amber-700 bg-amber-50/60 dark:border-amber-500 dark:bg-amber-950/20'
            : 'border-stone-300 sepia:border-[#D4C6AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816]'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUploadPdf(f);
            e.target.value = '';
          }}
          className="hidden"
        />
        <Upload className="w-5 h-5 mx-auto text-amber-700 dark:text-amber-500" />
        <p className="mt-2.5 text-sm font-medium text-stone-900 sepia:text-[#2F241A] dark:text-stone-100">
          Drop any illustrated technical guidebook or PDF here (works offline too)
        </p>
        <p className="mt-1 text-xs text-stone-500 sepia:text-[#6E5A47] dark:text-stone-400">
          Automatically saves the PDF, reading progress, audio position, chapters, and cover locally.
        </p>
        <button
          type="button"
          disabled={isUploading}
          onClick={() => fileInputRef.current?.click()}
          className="mt-3.5 inline-flex items-center gap-2 h-9 px-4 rounded-md text-sm font-medium bg-stone-900 text-stone-50 hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-stone-200 disabled:opacity-50 cursor-pointer"
        >
          {isUploading ? 'Parsing PDF & Caching Offline…' : 'Choose PDF File'}
        </button>
      </div>

      {/* Shelf Filter Tabs & Search Bar */}
      {books.length > 0 && (
        <div className="space-y-4">
          <div
            role="tablist"
            aria-label="Library shelf filters"
            className="flex items-center gap-1 overflow-x-auto pb-1 border-b border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800"
          >
            {(
              [
                { id: 'all', label: `All Books (${books.length})` },
                { id: 'bookmarked', label: `Bookmarked (${bookmarkedCount})` },
                { id: 'listened', label: `Audio History (${listenedCount})` },
                { id: 'offline', label: `Offline Ready (${offlineReadyCount})` },
              ] as const
            ).map((tab) => {
              const active = activeFilter === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveFilter(tab.id)}
                  className={`px-3 py-2 text-xs sm:text-[13px] font-medium whitespace-nowrap shrink-0 border-b-2 transition-colors cursor-pointer ${
                    active
                      ? 'border-amber-700 dark:border-amber-500 text-stone-950 dark:text-stone-50'
                      : 'border-transparent text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="relative flex-1 max-w-md">
              <Search
                aria-hidden="true"
                className="w-4 h-4 text-stone-400 dark:text-stone-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && searchQuery) {
                    setSearchQuery('');
                  }
                }}
                placeholder="Search saved books by title or author…"
                aria-label="Filter library books by title or author"
                className="w-full h-10 pl-9 pr-9 rounded-md border border-stone-300 sepia:border-[#D4C6AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] text-sm text-stone-900 sepia:text-[#2F241A] dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:outline-none focus:border-amber-700 dark:focus:border-amber-500 transition-colors"
              />
              {hasQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear book search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 inline-flex items-center justify-center rounded text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <p className="text-xs font-mono-num text-stone-500 dark:text-stone-400">
              {hasActiveFilter
                ? `Showing ${filteredBooks.length} of ${books.length} ${
                    books.length === 1 ? 'book' : 'books'
                  }`
                : `${books.length} ${books.length === 1 ? 'book' : 'books'} · sorted by most recent`}
            </p>
          </div>
        </div>
      )}

      {/* Empty Search / Filter Results State */}
      {books.length > 0 && filteredBooks.length === 0 ? (
        <div className="rounded-lg border border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] px-6 py-12 text-center">
          <Bookmark className="w-6 h-6 mx-auto text-stone-400 dark:text-stone-500" />
          <p className="mt-3 text-sm font-medium text-stone-900 dark:text-stone-100">
            {hasQuery
              ? `No books match “${searchQuery.trim()}”`
              : activeFilter === 'bookmarked'
              ? 'No bookmarked books yet'
              : activeFilter === 'listened'
              ? 'No audiobook listening history yet'
              : 'No offline-cached books match this filter yet'}
          </p>
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            {hasQuery
              ? 'Try searching with a different title keyword or author name.'
              : activeFilter === 'bookmarked'
              ? 'Click the Bookmark button on any book in Discover, Library, or Reader to save it here.'
              : activeFilter === 'listened'
              ? 'Click Listen Now on any book — your exact page and sentence position will be saved automatically.'
              : 'Click “Cache All Offline” above while online to save your library for offline reading.'}
          </p>
          <button
            type="button"
            onClick={() => {
              setSearchQuery('');
              setActiveFilter('all');
            }}
            className="mt-4 inline-flex items-center gap-1.5 h-8 px-3.5 rounded text-xs font-medium border border-stone-300 dark:border-stone-700 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
            <span>Show All Books</span>
          </button>
        </div>
      ) : (
        /* Books Grid */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredBooks.map((book) => {
            const isCurrent = book.id === activeBookId;
            const translatedCount = translatedCountsByBook[book.id] ?? 0;
            const totalSavedTranslations =
              allLangTranslationCountsByBook[book.id] ?? translatedCount;
            const isPreloaded = book.id === PRELOADED_OBS_BOOK_ID;
            const offlineReady = isBookOfflineReady(book);
            const isCachingThis = cachingBookId === book.id;
            const isDownloadingThis = downloadingBookId === book.id;
            const unavailableOffline = !isOnline && !offlineReady;
            const hasAudioHistory =
              book.lastAudioPage !== undefined || book.lastSentenceIndex !== undefined;
            const audioResumePage = book.lastAudioPage ?? book.lastPage ?? 1;
            const audioResumeLine = (book.lastSentenceIndex ?? 0) + 1;

            return (
              <article
                key={book.id}
                className={`flex flex-col rounded-lg border overflow-hidden bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] transition-colors ${
                  isCurrent || book.isBookmarked
                    ? 'border-amber-700/65 dark:border-amber-500/65'
                    : 'border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800'
                }`}
              >
                {/* Original Cover Thumbnail with Bookmark Toggle */}
                <div className="relative h-52 bg-[#F1EFEA] sepia:bg-[#ECE2CA] dark:bg-[#131211] p-4 flex items-center justify-center border-b border-stone-200/80 sepia:border-[#DFD4BC] dark:border-stone-800/80">
                  {book.coverDataUrl ? (
                    <img
                      src={book.coverDataUrl}
                      alt={`${book.title} cover`}
                      className="h-full w-auto object-contain rounded-[2px] shadow-[0_6px_20px_rgba(28,25,23,0.16)] border border-stone-200 dark:border-stone-700"
                    />
                  ) : (
                    <BookOpen className="w-10 h-10 text-stone-400" />
                  )}

                  <button
                    type="button"
                    onClick={() => onToggleBookBookmark(book.id)}
                    title={
                      book.isBookmarked
                        ? 'Bookmarked — click to remove from Bookmarks'
                        : 'Bookmark this book for quick access'
                    }
                    aria-label={
                      book.isBookmarked
                        ? `Remove ${book.title} from Bookmarks`
                        : `Bookmark ${book.title}`
                    }
                    className={`absolute top-2.5 right-2.5 h-8 w-8 inline-flex items-center justify-center rounded border shadow-sm transition-colors cursor-pointer ${
                      book.isBookmarked
                        ? 'border-amber-700 bg-amber-700 text-white'
                        : 'border-stone-300/90 dark:border-stone-700 bg-white/95 sepia:bg-[#FBF6E9]/95 dark:bg-[#191816]/95 text-stone-600 dark:text-stone-300 hover:text-amber-800 dark:hover:text-amber-400'
                    }`}
                  >
                    <Bookmark
                      className={`w-4 h-4 ${book.isBookmarked ? 'fill-current' : ''}`}
                    />
                  </button>
                </div>

                {/* Book Details */}
                <div className="p-4 flex-1 flex flex-col">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-display text-base font-semibold leading-snug text-stone-950 sepia:text-[#2F241A] dark:text-stone-50 line-clamp-2">
                      {book.title}
                    </h2>
                    {!isPreloaded &&
                      (confirmDeleteId === book.id ? (
                        <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
                          <button
                            type="button"
                            onClick={() => {
                              onDeleteBook(book.id);
                              setConfirmDeleteId(null);
                            }}
                            className="text-xs font-medium text-red-700 dark:text-red-400 hover:underline cursor-pointer"
                          >
                            Remove
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="text-xs text-stone-500 hover:underline cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(book.id)}
                          aria-label={`Remove ${book.title}`}
                          title="Remove from Library"
                          className="p-1 rounded text-stone-400 hover:text-red-700 dark:hover:text-red-400 cursor-pointer shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      ))}
                  </div>

                  {book.author && (
                    <p className="mt-0.5 text-xs text-stone-500 sepia:text-[#6E5A47] dark:text-stone-400 truncate">
                      {book.author}
                    </p>
                  )}

                  <p className="mt-2.5 text-xs text-stone-500 sepia:text-[#6E5A47] dark:text-stone-400 font-mono-num">
                    {book.numPages} pages · {book.chapters.length} chapters · {translatedCount}{' '}
                    translated
                    {book.bookmarks && book.bookmarks.length > 0
                      ? ` · ${book.bookmarks.length} page marks`
                      : ''}
                  </p>

                  {/* Saved Listening Position Indicator */}
                  {hasAudioHistory && (
                    <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-800 dark:text-amber-400 font-mono-num">
                      <Headphones className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">
                        Audio saved: Page {audioResumePage} · Line {audioResumeLine}
                      </span>
                    </p>
                  )}

                  {/* Per-book Offline Readiness Line */}
                  <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
                    {offlineReady ? (
                      <span className="inline-flex items-center gap-1.5 text-emerald-800 dark:text-emerald-400 font-medium">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        <span>
                          Available offline
                          {totalSavedTranslations > 0
                            ? ` · ${totalSavedTranslations} translated ${
                                totalSavedTranslations === 1 ? 'page' : 'pages'
                              }`
                            : ''}
                        </span>
                      </span>
                    ) : (
                      <>
                        <span className="inline-flex items-center gap-1.5 text-stone-500 dark:text-stone-400">
                          <CloudDownload className="w-3.5 h-3.5 shrink-0" />
                          <span>{isOnline ? 'Not yet cached offline' : 'Offline unavailable'}</span>
                        </span>
                        {isOnline && (
                          <button
                            type="button"
                            disabled={isCachingThis || isSyncingAllOffline}
                            onClick={() => onCacheBookOffline(book)}
                            className="inline-flex items-center gap-1 font-medium text-amber-800 dark:text-amber-400 hover:underline disabled:opacity-50 cursor-pointer whitespace-nowrap"
                          >
                            {isCachingThis ? (
                              <>
                                <Loader2 className="w-3 h-3 animate-spin" />
                                <span>Saving…</span>
                              </>
                            ) : (
                              <span>Save Offline</span>
                            )}
                          </button>
                        )}
                      </>
                    )}
                  </div>

                  {/* Continue Reading Progress Bar */}
                  {(() => {
                    const lastPg = Math.max(1, Math.min(book.numPages, book.lastPage || 1));
                    const pct = Math.max(
                      1,
                      Math.min(100, Math.round((lastPg / Math.max(1, book.numPages)) * 100))
                    );
                    return (
                      <div className="mt-3 space-y-1">
                        <div className="flex items-center justify-between text-[11px] text-stone-500 dark:text-stone-400 font-mono-num">
                          <span>
                            Page {lastPg} of {book.numPages}
                          </span>
                          <span>{pct}% read</span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-stone-200 sepia:bg-[#DFD4BC] dark:bg-stone-800 overflow-hidden">
                          <div
                            className="h-full bg-amber-700 dark:bg-amber-500 transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })()}

                  {/* All-Facilities 4-in-1 Actions on Every Library Card */}
                  <div className="mt-auto pt-4">
                    <div className="pt-3 border-t border-stone-200/80 sepia:border-[#DFD4BC] dark:border-stone-800/80 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={unavailableOffline}
                        onClick={() => onSelectBook(book)}
                        title={
                          unavailableOffline
                            ? 'Reconnect once and save this PDF offline to read without internet'
                            : `Resume reading at Page ${book.lastPage || 1}`
                        }
                        className="h-8 px-2.5 rounded text-xs font-medium inline-flex items-center justify-center gap-1.5 bg-stone-900 text-stone-50 hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-stone-200 disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
                      >
                        <BookOpen className="w-3.5 h-3.5" />
                        <span>
                          {unavailableOffline
                            ? 'Needs Internet'
                            : isCurrent || (book.lastPage ?? 1) > 1
                            ? `Continue p.${book.lastPage || 1}`
                            : 'Read Book'}
                        </span>
                      </button>

                      <button
                        type="button"
                        disabled={unavailableOffline}
                        onClick={() => onListenBook(book)}
                        title={
                          hasAudioHistory
                            ? `Continue listening from Page ${audioResumePage}, Line ${audioResumeLine}`
                            : 'Open and start audiobook narration'
                        }
                        className="h-8 px-2.5 rounded text-xs font-medium inline-flex items-center justify-center gap-1.5 bg-amber-700 hover:bg-amber-800 text-white disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
                      >
                        <Headphones className="w-3.5 h-3.5" />
                        <span>{hasAudioHistory ? 'Resume Audio' : 'Listen Now'}</span>
                      </button>

                      <button
                        type="button"
                        disabled={unavailableOffline}
                        onClick={() => onTranslateBook(book)}
                        title="Open in Reader and translate"
                        className="h-8 px-2.5 rounded text-xs font-medium inline-flex items-center justify-center gap-1.5 border border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
                      >
                        <Languages className="w-3.5 h-3.5" />
                        <span>Translate</span>
                      </button>

                      <button
                        type="button"
                        disabled={unavailableOffline || isDownloadingThis}
                        onClick={() => onDownloadBook(book)}
                        title="Download this PDF to your device"
                        className="h-8 px-2.5 rounded text-xs font-medium inline-flex items-center justify-center gap-1.5 border border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-45 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
                      >
                        {isDownloadingThis ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Download className="w-3.5 h-3.5" />
                        )}
                        <span>Download PDF</span>
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
};
