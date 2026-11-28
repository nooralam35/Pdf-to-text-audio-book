import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpDown,
  Bookmark,
  BookOpen,
  Compass,
  Download,
  Flame,
  Headphones,
  Languages,
  Loader2,
  Minus,
  Plus,
  Search,
  Target,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { PRELOADED_OBS_BOOK_ID } from '../lib/languages';
import type { DailyReadingGoalSnapshot } from '../lib/readingGoal';
import type { StoredBook } from '../types';
import { PWAInstallButton } from './PWAInstallButton';

type LibraryFilterTab = 'all' | 'bookmarked' | 'listened';
type LibrarySearchScope = 'all' | 'title' | 'author';
type LibrarySortOption = 'recent' | 'title' | 'author';

const GOAL_PRESETS = [10, 15, 25, 50] as const;

interface CircularProgressRingProps {
  value: number;
  max: number;
  size?: number;
  strokeWidth?: number;
  label?: string;
  sublabel?: string;
  ariaLabel: string;
}

const CircularProgressRing: React.FC<CircularProgressRingProps> = ({
  value,
  max,
  size = 44,
  strokeWidth = 4,
  label,
  sublabel,
  ariaLabel,
}) => {
  const safeMax = Math.max(1, max);
  const ratio = Math.max(0, Math.min(1, value / safeMax));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - ratio);
  const completed = value >= safeMax;

  return (
    <div
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={Math.min(value, safeMax)}
      className="relative inline-flex items-center justify-center shrink-0"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          className="stroke-stone-200 sepia:stroke-[#DFD4BC] dark:stroke-stone-800"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          className={`transition-[stroke-dashoffset] duration-300 ease-out ${
            completed
              ? 'stroke-emerald-600 dark:stroke-emerald-400'
              : value > 0
              ? 'stroke-amber-700 dark:stroke-amber-500'
              : 'stroke-transparent'
          }`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none select-none font-mono-num">
        <span
          className={`font-semibold ${
            size >= 56 ? 'text-xs' : 'text-[10px]'
          } ${
            completed
              ? 'text-emerald-800 dark:text-emerald-300'
              : value > 0
              ? 'text-stone-900 sepia:text-[#2F241A] dark:text-stone-100'
              : 'text-stone-400 dark:text-stone-500'
          }`}
        >
          {label ?? `${Math.round(ratio * 100)}%`}
        </span>
        {sublabel && (
          <span className="text-[9px] text-stone-500 dark:text-stone-400 mt-0.5">
            {sublabel}
          </span>
        )}
      </div>
    </div>
  );
};

function renderHighlightedText(text: string, tokens: string[]): React.ReactNode {
  if (!text || tokens.length === 0) return text;
  const escaped = tokens
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (escaped.length === 0) return text;
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(regex);
  return parts.map((part, idx) =>
    idx % 2 === 1 ? (
      <mark
        key={idx}
        className="bg-amber-200/80 dark:bg-amber-700/50 text-inherit rounded-[2px] px-0.5"
      >
        {part}
      </mark>
    ) : (
      part
    )
  );
}

interface LibraryViewProps {
  books: StoredBook[];
  activeBookId: string | null;
  translatedCountsByBook: Record<string, number>;
  dailyReadingGoal: DailyReadingGoalSnapshot;
  onChangeDailyGoal: (pages: number) => void;
  downloadingBookId?: string | null;
  onSelectBook: (book: StoredBook) => void;
  onListenBook: (book: StoredBook) => void;
  onTranslateBook: (book: StoredBook) => void;
  onDownloadBook: (book: StoredBook) => void;
  onToggleBookBookmark: (bookId: string) => void;
  onUploadPdf: (file: File) => void;
  onDeleteBook: (bookId: string) => void;
  onGoToDiscover?: () => void;
  isUploading: boolean;
}

const LibraryViewInner: React.FC<LibraryViewProps> = ({
  books,
  activeBookId,
  translatedCountsByBook,
  dailyReadingGoal,
  onChangeDailyGoal,
  downloadingBookId = null,
  onSelectBook,
  onListenBook,
  onTranslateBook,
  onDownloadBook,
  onToggleBookBookmark,
  onUploadPdf,
  onDeleteBook,
  onGoToDiscover,
  isUploading,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<LibrarySearchScope>('all');
  const [sortBy, setSortBy] = useState<LibrarySortOption>('recent');
  const [activeFilter, setActiveFilter] = useState<LibraryFilterTab>('all');

  // Press '/' anywhere outside form fields to jump straight into the Library search bar
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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

  const searchTokens = useMemo(() => {
    const trimmed = searchQuery.normalize('NFKC').trim().toLowerCase();
    return trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];
  }, [searchQuery]);

  const filteredBooks = useMemo(() => {
    const matched = books.filter((book) => {
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
      if (searchTokens.length === 0) return true;
      const normTitle = `${book.title ?? ''} ${book.fileName ?? ''}`.normalize('NFKC').toLowerCase();
      const normAuthor = (book.author ?? '').normalize('NFKC').toLowerCase();
      const haystack =
        searchScope === 'title'
          ? normTitle
          : searchScope === 'author'
          ? normAuthor
          : `${normTitle} ${normAuthor}`;
      return searchTokens.every((token) => haystack.includes(token));
    });

    if (sortBy === 'title') {
      return [...matched].sort((a, b) =>
        (a.title ?? '').localeCompare(b.title ?? '', undefined, { sensitivity: 'base' })
      );
    }
    if (sortBy === 'author') {
      return [...matched].sort((a, b) => {
        const aAuth = (a.author ?? '').trim();
        const bAuth = (b.author ?? '').trim();
        if (!aAuth && bAuth) return 1;
        if (aAuth && !bAuth) return -1;
        return aAuth.localeCompare(bAuth, undefined, { sensitivity: 'base' });
      });
    }
    return matched;
  }, [books, searchTokens, searchScope, activeFilter, sortBy]);

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
              title="Search free public-domain books online"
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-stone-300 sepia:border-[#D4C6AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] text-xs font-medium text-stone-800 sepia:text-[#3B2F23] dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer whitespace-nowrap"
            >
              <Compass className="w-3.5 h-3.5 text-amber-700 dark:text-amber-500" />
              <span>Discover Free Books</span>
            </button>
          )}
        </div>
      </div>

      {/* Daily Reading Goal Tracker */}
      {(() => {
        const { goalPages, pagesReadToday, streakDays, goalMetToday } = dailyReadingGoal;
        const remaining = Math.max(0, goalPages - pagesReadToday);
        const pctToday = Math.min(100, Math.round((pagesReadToday / Math.max(1, goalPages)) * 100));

        return (
          <section
            aria-label="Daily Reading Goal"
            className="rounded-lg border border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] px-4 sm:px-5 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
          >
            <div className="flex items-center gap-4 min-w-0">
              <CircularProgressRing
                value={pagesReadToday}
                max={goalPages}
                size={60}
                strokeWidth={5}
                label={`${pctToday}%`}
                sublabel="today"
                ariaLabel={`Daily reading goal progress: ${pagesReadToday} of ${goalPages} pages read today`}
              />
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold text-stone-950 sepia:text-[#2F241A] dark:text-stone-50">
                    <Target className="w-4 h-4 text-amber-700 dark:text-amber-500 shrink-0" />
                    <span>Daily Reading Goal</span>
                  </h2>
                  {streakDays > 0 && (
                    <span className="inline-flex items-center gap-1 text-xs font-mono-num font-medium text-amber-800 dark:text-amber-400">
                      <Flame className="w-3.5 h-3.5 shrink-0" />
                      <span>{streakDays}-day streak</span>
                    </span>
                  )}
                </div>
                <p className="text-xs text-stone-600 sepia:text-[#5B4938] dark:text-stone-400 font-mono-num">
                  <span className="font-semibold text-stone-900 sepia:text-[#2F241A] dark:text-stone-100">
                    {pagesReadToday} / {goalPages}
                  </span>{' '}
                  {pagesReadToday === 1 ? 'page' : 'pages'} read today
                  {' · '}
                  {goalMetToday ? (
                    <span className="text-emerald-800 dark:text-emerald-400 font-medium">
                      Daily goal reached
                    </span>
                  ) : (
                    <span>
                      {remaining} {remaining === 1 ? 'page' : 'pages'} left
                    </span>
                  )}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <span className="text-[11px] font-medium text-stone-500 dark:text-stone-400 mr-0.5">
                Target:
              </span>
              <div className="inline-flex items-center rounded-md border border-stone-300 sepia:border-[#D4C6AA] dark:border-stone-700 bg-[#FAF9F5] sepia:bg-[#F4ECD8] dark:bg-[#141312]">
                <button
                  type="button"
                  onClick={() => onChangeDailyGoal(Math.max(1, goalPages - 5))}
                  disabled={goalPages <= 1}
                  aria-label="Decrease daily page goal by 5"
                  className="h-8 w-8 inline-flex items-center justify-center text-stone-600 dark:text-stone-300 hover:text-stone-950 dark:hover:text-stone-50 disabled:opacity-40 cursor-pointer"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <span className="px-2 text-xs font-mono-num font-semibold text-stone-900 sepia:text-[#2F241A] dark:text-stone-100 min-w-[3.5rem] text-center">
                  {goalPages}p/day
                </span>
                <button
                  type="button"
                  onClick={() => onChangeDailyGoal(Math.min(300, goalPages + 5))}
                  disabled={goalPages >= 300}
                  aria-label="Increase daily page goal by 5"
                  className="h-8 w-8 inline-flex items-center justify-center text-stone-600 dark:text-stone-300 hover:text-stone-950 dark:hover:text-stone-50 disabled:opacity-40 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="inline-flex items-center gap-1">
                {GOAL_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => onChangeDailyGoal(preset)}
                    className={`h-8 px-2 rounded text-xs font-mono-num font-medium border transition-colors cursor-pointer ${
                      goalPages === preset
                        ? 'border-amber-700 bg-amber-700 text-white'
                        : 'border-stone-300 sepia:border-[#D4C6AA] dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800'
                    }`}
                  >
                    {preset}p
                  </button>
                ))}
              </div>
            </div>
          </section>
        );
      })()}

      {/* Prominent Library Search Bar & Shelf Filter Tabs */}
      <section aria-label="Search and filter saved books" className="space-y-4">
        <div className="flex flex-col md:flex-row md:items-center gap-2.5">
          <div className="relative flex-1 min-w-0">
            <Search
              aria-hidden="true"
              className="w-4 h-4 text-stone-400 dark:text-stone-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
            />
            <input
              ref={searchInputRef}
              type="text"
              role="searchbox"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              spellCheck={false}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && searchQuery) {
                  setSearchQuery('');
                }
              }}
              placeholder={
                searchScope === 'title'
                  ? 'Filter saved books by title…'
                  : searchScope === 'author'
                  ? 'Filter saved books by author…'
                  : 'Search saved books by title or author…'
              }
              aria-label="Filter library books by title or author"
              className="w-full h-11 pl-10 pr-24 rounded-md border border-stone-300 sepia:border-[#D4C6AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] text-sm text-stone-900 sepia:text-[#2F241A] dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:outline-none focus:border-amber-700 dark:focus:border-amber-500 transition-colors"
            />
            {hasQuery ? (
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
                <span
                  aria-live="polite"
                  className="text-[11px] font-mono-num text-stone-500 dark:text-stone-400 select-none"
                >
                  {filteredBooks.length} {filteredBooks.length === 1 ? 'match' : 'matches'}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    searchInputRef.current?.focus();
                  }}
                  aria-label="Clear library search"
                  className="h-6 w-6 inline-flex items-center justify-center rounded text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <kbd
                aria-hidden="true"
                className="hidden sm:inline-flex items-center justify-center absolute right-3 top-1/2 -translate-y-1/2 h-5 min-w-[20px] px-1.5 rounded border border-stone-200 sepia:border-[#D4C6AA] dark:border-stone-700 bg-stone-50 sepia:bg-[#F4ECD8] dark:bg-[#22211E] text-[10px] font-mono-num text-stone-400 dark:text-stone-500 pointer-events-none"
              >
                /
              </kbd>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0 flex-wrap sm:flex-nowrap">
            <div
              role="group"
              aria-label="Search field scope"
              className="inline-flex h-11 rounded-md border border-stone-300 sepia:border-[#D4C6AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] p-1 shrink-0"
            >
              {(
                [
                  { id: 'all', label: 'Title & Author' },
                  { id: 'title', label: 'Title' },
                  { id: 'author', label: 'Author' },
                ] as const
              ).map((scope) => (
                <button
                  key={scope.id}
                  type="button"
                  aria-pressed={searchScope === scope.id}
                  onClick={() => setSearchScope(scope.id)}
                  className={`px-2.5 rounded text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
                    searchScope === scope.id
                      ? 'bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-950'
                      : 'text-stone-600 sepia:text-[#5B4938] dark:text-stone-300 hover:text-stone-950 dark:hover:text-stone-100'
                  }`}
                >
                  {scope.label}
                </button>
              ))}
            </div>

            <div className="relative inline-flex items-center h-11 rounded-md border border-stone-300 sepia:border-[#D4C6AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] px-2.5 shrink-0">
              <ArrowUpDown
                aria-hidden="true"
                className="w-3.5 h-3.5 text-stone-400 dark:text-stone-500 mr-1.5 shrink-0"
              />
              <select
                aria-label="Sort saved books"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as LibrarySortOption)}
                className="h-full bg-transparent text-xs font-medium text-stone-700 sepia:text-[#3B2F23] dark:text-stone-200 focus:outline-none cursor-pointer pr-1"
              >
                <option value="recent">Recent</option>
                <option value="title">Title A–Z</option>
                <option value="author">Author A–Z</option>
              </select>
            </div>
          </div>
        </div>

        {books.length > 0 && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800">
            <div
              role="tablist"
              aria-label="Library shelf filters"
              className="flex items-center gap-1 overflow-x-auto"
            >
              {(
                [
                  { id: 'all', label: `All Books (${books.length})` },
                  { id: 'bookmarked', label: `Bookmarked (${bookmarkedCount})` },
                  { id: 'listened', label: `Audio History (${listenedCount})` },
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

            <p
              aria-live="polite"
              className="text-xs font-mono-num text-stone-500 dark:text-stone-400 pb-2 sm:pb-0 whitespace-nowrap"
            >
              {hasActiveFilter
                ? `Showing ${filteredBooks.length} of ${books.length} ${
                    books.length === 1 ? 'book' : 'books'
                  }`
                : `${books.length} ${books.length === 1 ? 'book' : 'books'} · ${
                    sortBy === 'title'
                      ? 'sorted by title'
                      : sortBy === 'author'
                      ? 'sorted by author'
                      : 'most recent'
                  }`}
            </p>
          </div>
        )}
      </section>

      {/* Empty Search / Filter Results State */}
      {books.length > 0 && filteredBooks.length === 0 ? (
        <div className="rounded-lg border border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] px-6 py-12 text-center">
          {hasQuery ? (
            <Search className="w-6 h-6 mx-auto text-stone-400 dark:text-stone-500" />
          ) : (
            <Bookmark className="w-6 h-6 mx-auto text-stone-400 dark:text-stone-500" />
          )}
          <p className="mt-3 text-sm font-medium text-stone-900 dark:text-stone-100">
            {hasQuery
              ? `No books match “${searchQuery.trim()}”`
              : activeFilter === 'bookmarked'
              ? 'No bookmarked books yet'
              : 'No audiobook listening history yet'}
          </p>
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            {hasQuery
              ? 'Try searching with a different title keyword, author name, or switch scope to Title & Author.'
              : activeFilter === 'bookmarked'
              ? 'Click the Bookmark button on any book in Discover, Library, or Reader to save it here.'
              : 'Click Listen Now on any book — your exact page and sentence position will be saved automatically.'}
          </p>
          <button
            type="button"
            onClick={() => {
              setSearchQuery('');
              setSearchScope('all');
              setActiveFilter('all');
            }}
            className="mt-4 inline-flex items-center gap-1.5 h-8 px-3.5 rounded text-xs font-medium border border-stone-300 dark:border-stone-700 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
            <span>{hasQuery ? 'Clear Search' : 'Show All Books'}</span>
          </button>
        </div>
      ) : (
        /* Books Grid */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredBooks.map((book) => {
            const isCurrent = book.id === activeBookId;
            const translatedCount = translatedCountsByBook[book.id] ?? 0;
            const isPreloaded = book.id === PRELOADED_OBS_BOOK_ID;
            const isDownloadingThis = downloadingBookId === book.id;
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
                      loading="lazy"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
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
                      {searchScope !== 'author'
                        ? renderHighlightedText(book.title, searchTokens)
                        : book.title}
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
                      {searchScope !== 'title'
                        ? renderHighlightedText(book.author, searchTokens)
                        : book.author}
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

                  {/* Daily Reading Goal Circular Progress Ring + Book Reading Progress */}
                  {(() => {
                    const lastPg = Math.max(1, Math.min(book.numPages, book.lastPage || 1));
                    const pct = Math.max(
                      1,
                      Math.min(100, Math.round((lastPg / Math.max(1, book.numPages)) * 100))
                    );
                    const bookPagesToday = dailyReadingGoal.pagesReadTodayByBook[book.id] ?? 0;
                    const goalPages = Math.max(1, dailyReadingGoal.goalPages);
                    const todayGoalPct = Math.min(
                      100,
                      Math.round((bookPagesToday / goalPages) * 100)
                    );
                    return (
                      <div className="mt-3.5 pt-3 border-t border-stone-200/70 sepia:border-[#DFD4BC]/80 dark:border-stone-800/80 flex items-center gap-3">
                        <div
                          title={`${bookPagesToday} of ${goalPages} daily goal pages read in "${book.title}" today (${todayGoalPct}%)`}
                        >
                          <CircularProgressRing
                            value={bookPagesToday}
                            max={goalPages}
                            size={44}
                            strokeWidth={4}
                            label={`${bookPagesToday}p`}
                            ariaLabel={`${book.title}: ${bookPagesToday} of ${goalPages} daily goal pages read today`}
                          />
                        </div>

                        <div className="flex-1 min-w-0 space-y-1.5">
                          <div className="flex items-center justify-between gap-2 text-[11px] font-mono-num">
                            <span
                              className={
                                bookPagesToday >= goalPages
                                  ? 'font-medium text-emerald-800 dark:text-emerald-400'
                                  : bookPagesToday > 0
                                  ? 'font-medium text-amber-800 dark:text-amber-400'
                                  : 'text-stone-500 dark:text-stone-400'
                              }
                            >
                              Today: {bookPagesToday}/{goalPages}p
                            </span>
                            <span className="text-stone-500 dark:text-stone-400">
                              p.{lastPg}/{book.numPages} ({pct}%)
                            </span>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-stone-200 sepia:bg-[#DFD4BC] dark:bg-stone-800 overflow-hidden">
                            <div
                              className="h-full bg-amber-700 dark:bg-amber-500 transition-all"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* All-Facilities 4-in-1 Actions on Every Library Card */}
                  <div className="mt-auto pt-4">
                    <div className="pt-3 border-t border-stone-200/80 sepia:border-[#DFD4BC] dark:border-stone-800/80 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => onSelectBook(book)}
                        title={`Resume reading at Page ${book.lastPage || 1}`}
                        className="h-8 px-2.5 rounded text-xs font-medium inline-flex items-center justify-center gap-1.5 bg-stone-900 text-stone-50 hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-stone-200 cursor-pointer whitespace-nowrap"
                      >
                        <BookOpen className="w-3.5 h-3.5" />
                        <span>
                          {isCurrent || (book.lastPage ?? 1) > 1
                            ? `Continue p.${book.lastPage || 1}`
                            : 'Read Book'}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => onListenBook(book)}
                        title={
                          hasAudioHistory
                            ? `Continue listening from Page ${audioResumePage}, Line ${audioResumeLine}`
                            : 'Open and start audiobook narration'
                        }
                        className="h-8 px-2.5 rounded text-xs font-medium inline-flex items-center justify-center gap-1.5 bg-amber-700 hover:bg-amber-800 text-white cursor-pointer whitespace-nowrap"
                      >
                        <Headphones className="w-3.5 h-3.5" />
                        <span>{hasAudioHistory ? 'Resume Audio' : 'Listen Now'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => onTranslateBook(book)}
                        title="Open in Reader and translate"
                        className="h-8 px-2.5 rounded text-xs font-medium inline-flex items-center justify-center gap-1.5 border border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer whitespace-nowrap"
                      >
                        <Languages className="w-3.5 h-3.5" />
                        <span>Translate</span>
                      </button>

                      <button
                        type="button"
                        disabled={isDownloadingThis}
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
          Drop any PDF book in any language here to open directly
        </p>
        <p className="mt-1 text-xs text-stone-500 sepia:text-[#6E5A47] dark:text-stone-400">
          Reads every world language faithfully — Sanskrit, Hindi, Marathi, Urdu, Arabic, English, Chinese, Japanese, Russian &amp; more.
        </p>
        <button
          type="button"
          disabled={isUploading}
          onClick={() => fileInputRef.current?.click()}
          className="mt-3.5 inline-flex items-center gap-2 h-9 px-4 rounded-md text-sm font-medium bg-stone-900 text-stone-50 hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-stone-200 disabled:opacity-50 cursor-pointer"
        >
          {isUploading ? 'Opening PDF…' : 'Choose PDF File'}
        </button>
      </div>
    </main>
  );
};

export const LibraryView = React.memo(LibraryViewInner);
