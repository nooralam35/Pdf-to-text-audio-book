import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Headphones,
  Languages,
  Loader2,
  Search,
  Star,
  Upload,
  X,
} from 'lucide-react';
import { resolveArchiveMetadata, searchGlobalBooks } from '../lib/bookDiscovery';
import { getLanguageOption } from '../lib/languages';
import type {
  BookCategory,
  BookFormatFilter,
  BookSortBy,
  DiscoveredBook,
  LanguageCode,
} from '../types';

export type DiscoverBookAction = 'read' | 'translate' | 'listen' | 'download';

interface DiscoverViewProps {
  targetLang: LanguageCode;
  onActionBook: (book: DiscoveredBook, action: DiscoverBookAction) => Promise<void>;
  loadingBookAction: { bookId: string; action: DiscoverBookAction; status: string } | null;
  onUploadPdf: (file: File) => void;
  isUploading: boolean;
}

const CATEGORIES: Array<{ id: BookCategory; label: string }> = [
  { id: 'all', label: 'All Books' },
  { id: 'programming', label: 'Tech & Programming' },
  { id: 'business', label: 'Business' },
  { id: 'science', label: 'Science' },
  { id: 'history', label: 'History' },
  { id: 'fiction', label: 'Classic Fiction' },
  { id: 'self_help', label: 'Self-Help & Philosophy' },
];

const SEARCH_LANGUAGES = [
  { code: 'all', label: 'All Languages' },
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'ar', label: 'Arabic' },
  { code: 'ur', label: 'Urdu' },
];

function formatCompactCount(n?: number): string | null {
  if (!n || n <= 0) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function sourceDisplayName(source: DiscoveredBook['source']): string {
  if (source === 'internet_archive') return 'Internet Archive';
  if (source === 'open_library') return 'Open Library';
  return 'Project Gutenberg';
}

function safeExternalUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const BookCoverFrame: React.FC<{
  book: DiscoveredBook;
  size?: 'card' | 'modal';
}> = ({ book, size = 'card' }) => {
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [book.coverUrl]);

  const dimClass =
    size === 'modal'
      ? 'w-40 sm:w-48 aspect-[3/4] shrink-0'
      : 'w-24 sm:w-28 aspect-[3/4] shrink-0';

  if (book.coverUrl && !imgFailed) {
    return (
      <div
        className={`${dimClass} overflow-hidden rounded-[3px] bg-[#EFECE6] sepia:bg-[#E7DEC8] dark:bg-[#141312] border border-stone-200 dark:border-stone-800 flex items-center justify-center`}
      >
        <img
          src={book.coverUrl}
          alt={`${book.title} cover`}
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setImgFailed(true)}
          className="w-full h-full object-cover"
        />
      </div>
    );
  }

  return (
    <div
      className={`${dimClass} rounded-[3px] border border-stone-300/80 dark:border-stone-700 bg-gradient-to-b from-[#F5EFE2] to-[#E6DCC7] dark:from-[#23201C] dark:to-[#171512] p-3 flex flex-col justify-between text-left select-none`}
    >
      <BookOpen className="w-4 h-4 text-amber-800/70 dark:text-amber-500/70" />
      <div className="space-y-1">
        <p className="font-display text-[11px] font-semibold leading-tight text-stone-900 dark:text-stone-100 line-clamp-3">
          {book.title}
        </p>
        <p className="text-[10px] text-stone-600 dark:text-stone-400 truncate">{book.author}</p>
      </div>
    </div>
  );
};

export const DiscoverView: React.FC<DiscoverViewProps> = ({
  targetLang,
  onActionBook,
  loadingBookAction,
  onUploadPdf,
  isUploading,
}) => {
  const [queryInput, setQueryInput] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [category, setCategory] = useState<BookCategory>('all');
  const [searchLang, setSearchLang] = useState('all');
  const [format, setFormat] = useState<BookFormatFilter>('all');
  const [sort, setSort] = useState<BookSortBy>('downloads');
  const [page, setPage] = useState(1);

  const [books, setBooks] = useState<DiscoveredBook[]>([]);
  const [sourceCounts, setSourceCounts] = useState({
    internetArchive: 0,
    openLibrary: 0,
    gutenberg: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Book Details Modal state
  const [selectedBook, setSelectedBook] = useState<DiscoveredBook | null>(null);
  const [enrichedDescription, setEnrichedDescription] = useState<string | null>(null);
  const [enrichedPages, setEnrichedPages] = useState<number | null>(null);
  const [isEnrichingModal, setIsEnrichingModal] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const targetLangOption = getLanguageOption(targetLang);

  const runSearch = useCallback(
    async (opts: {
      q: string;
      cat: BookCategory;
      lang: string;
      fmt: BookFormatFilter;
      srt: BookSortBy;
      pg: number;
    }) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setIsLoading(true);
      setError(null);
      try {
        const res = await searchGlobalBooks({
          query: opts.q,
          category: opts.cat,
          lang: opts.lang,
          format: opts.fmt,
          sort: opts.srt,
          page: opts.pg,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setBooks(res.books);
          setSourceCounts(res.sources);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(
          err instanceof Error
            ? err.message
            : 'Unable to reach public e-book repositories right now.'
        );
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    runSearch({
      q: activeQuery,
      cat: category,
      lang: searchLang,
      fmt: format,
      srt: sort,
      pg: page,
    });
    return () => {
      abortRef.current?.abort();
    };
  }, [activeQuery, category, searchLang, format, sort, page, runSearch]);

  // Enrich Internet Archive book details when modal opens
  useEffect(() => {
    if (!selectedBook) {
      setEnrichedDescription(null);
      setEnrichedPages(null);
      setIsEnrichingModal(false);
      return;
    }
    if (
      selectedBook.source === 'internet_archive' &&
      (!selectedBook.description || !selectedBook.pageCount)
    ) {
      let cancelled = false;
      setIsEnrichingModal(true);
      resolveArchiveMetadata(selectedBook.identifier)
        .then((meta) => {
          if (cancelled) return;
          if (meta.description) setEnrichedDescription(meta.description);
          if (meta.pageCount) setEnrichedPages(meta.pageCount);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setIsEnrichingModal(false);
        });
      return () => {
        cancelled = true;
      };
    }
  }, [selectedBook]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setActiveQuery(queryInput.trim());
  };

  const quickQueries = [
    'Python programming',
    'Physics',
    'World History',
    'Sherlock Holmes',
    'Philosophy',
    'Economics',
  ];

  const isBusyGlobal = Boolean(loadingBookAction);

  return (
    <main className="max-w-6xl mx-auto w-full px-4 sm:px-6 py-8 sm:py-10 space-y-8">
      {/* Hero Discovery Header */}
      <section className="space-y-5 border-b border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 pb-7">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div className="max-w-2xl">
            <p className="text-xs uppercase tracking-widest text-stone-500 dark:text-stone-400">
              Internet Archive · Open Library · Project Gutenberg
            </p>
            <h1 className="mt-2 font-display text-3xl sm:text-4xl font-semibold tracking-tight text-stone-950 sepia:text-[#2E241A] dark:text-stone-50">
              Global E-Book &amp; PDF Discovery Hub
            </h1>
            <p className="mt-2 text-sm sm:text-[15px] text-stone-600 sepia:text-[#574838] dark:text-stone-400 leading-relaxed">
              Search millions of free public-domain PDFs and classic e-books across open libraries.
              Open any title directly in the bilingual translator, listen with synchronized narration,
              or export a cover-preserved {targetLangOption.name} PDF.
            </p>
          </div>

          <div className="shrink-0">
            <input
              ref={uploadInputRef}
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUploadPdf(f);
                e.target.value = '';
              }}
              className="hidden"
            />
            <button
              type="button"
              disabled={isUploading}
              onClick={() => uploadInputRef.current?.click()}
              className="inline-flex items-center gap-2 h-10 px-4 rounded-md border border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] text-sm font-medium text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Upload className="w-4 h-4 text-amber-700 dark:text-amber-500" />
              <span>{isUploading ? 'Parsing Local PDF…' : 'Upload Local PDF'}</span>
            </button>
          </div>
        </div>

        {/* Focal Unified Search Form */}
        <form onSubmit={handleSearchSubmit} className="flex flex-col sm:flex-row gap-2.5">
          <div className="relative flex-1">
            <Search
              aria-hidden="true"
              className="w-4 h-4 text-stone-400 dark:text-stone-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
            />
            <input
              type="search"
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              placeholder="Search by book title, author, topic, or ISBN (e.g. Python, Physics, Pride and Prejudice)…"
              aria-label="Search free e-books and PDFs"
              className="w-full h-11 pl-10 pr-10 rounded-md border border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] text-sm text-stone-950 dark:text-stone-50 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:outline-none focus:border-amber-700 dark:focus:border-amber-500 transition-colors"
            />
            {queryInput && (
              <button
                type="button"
                onClick={() => {
                  setQueryInput('');
                  setActiveQuery('');
                  setPage(1);
                }}
                aria-label="Clear search query"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 h-7 w-7 inline-flex items-center justify-center rounded text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <button
            type="submit"
            disabled={isLoading}
            className="h-11 px-6 rounded-md text-sm font-medium bg-amber-700 hover:bg-amber-800 text-white transition-colors disabled:opacity-60 cursor-pointer whitespace-nowrap shrink-0 inline-flex items-center justify-center gap-2"
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            <span>Search Books</span>
          </button>
        </form>

        {/* Quick Topic Shortcuts */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-stone-500 dark:text-stone-400">
          <span>Popular searches:</span>
          {quickQueries.map((term, idx) => (
            <React.Fragment key={term}>
              <button
                type="button"
                onClick={() => {
                  setQueryInput(term);
                  setActiveQuery(term);
                  setPage(1);
                }}
                className="text-stone-700 dark:text-stone-300 hover:text-amber-800 dark:hover:text-amber-400 underline-offset-4 hover:underline cursor-pointer whitespace-nowrap"
              >
                {term}
              </button>
              {idx < quickQueries.length - 1 && <span aria-hidden="true">·</span>}
            </React.Fragment>
          ))}
        </div>
      </section>

      {/* Active Fetching Progress Banner */}
      {loadingBookAction && (
        <div className="rounded-md border border-amber-700/40 bg-amber-50/90 dark:bg-amber-950/35 px-4 py-3 flex items-center gap-3 text-sm text-amber-950 dark:text-amber-100">
          <Loader2 className="w-4 h-4 animate-spin text-amber-700 dark:text-amber-400 shrink-0" />
          <span className="font-medium">{loadingBookAction.status}</span>
        </div>
      )}

      {/* Smart Filter & Sort Controls */}
      <section className="space-y-4">
        {/* Category Tabs */}
        <div
          role="tablist"
          aria-label="Book categories"
          className="flex items-center gap-1 overflow-x-auto pb-1 border-b border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800"
        >
          {CATEGORIES.map((cat) => {
            const active = category === cat.id;
            return (
              <button
                key={cat.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  setCategory(cat.id);
                  setPage(1);
                }}
                className={`px-3 py-2 text-xs sm:text-[13px] font-medium whitespace-nowrap shrink-0 border-b-2 transition-colors cursor-pointer ${
                  active
                    ? 'border-amber-700 dark:border-amber-500 text-stone-950 dark:text-stone-50'
                    : 'border-transparent text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'
                }`}
              >
                {cat.label}
              </button>
            );
          })}
        </div>

        {/* Language, Format, Sort & Counts Row */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <select
              aria-label="Filter by book language"
              value={searchLang}
              onChange={(e) => {
                setSearchLang(e.target.value);
                setPage(1);
              }}
              className="h-9 px-3 rounded-md border border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] text-xs font-medium text-stone-800 dark:text-stone-200 focus:outline-none focus:border-amber-700 cursor-pointer"
            >
              {SEARCH_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>

            <div className="inline-flex rounded-md border border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] p-0.5">
              {(
                [
                  { id: 'all', label: 'All Formats' },
                  { id: 'pdf', label: 'PDF' },
                  { id: 'text', label: 'EPUB / Text' },
                  { id: 'online', label: 'Read Online' },
                ] as const
              ).map((fmt) => (
                <button
                  key={fmt.id}
                  type="button"
                  onClick={() => {
                    setFormat(fmt.id);
                    setPage(1);
                  }}
                  className={`h-8 px-2.5 rounded text-xs font-medium whitespace-nowrap cursor-pointer transition-colors ${
                    format === fmt.id
                      ? 'bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-950'
                      : 'text-stone-600 dark:text-stone-300 hover:text-stone-950 dark:hover:text-stone-100'
                  }`}
                >
                  {fmt.label}
                </button>
              ))}
            </div>

            <select
              aria-label="Sort book results"
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as BookSortBy);
                setPage(1);
              }}
              className="h-9 px-3 rounded-md border border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] text-xs font-medium text-stone-800 dark:text-stone-200 focus:outline-none focus:border-amber-700 cursor-pointer"
            >
              <option value="downloads">Sort: Most Downloaded</option>
              <option value="rating">Sort: Top Rated</option>
              <option value="latest">Sort: Latest Published</option>
            </select>
          </div>

          <div className="text-xs text-stone-500 dark:text-stone-400 font-mono-num">
            {isLoading
              ? 'Querying public repositories…'
              : `${books.length} results · Archive ${sourceCounts.internetArchive} · Open Library ${sourceCounts.openLibrary} · Gutenberg ${sourceCounts.gutenberg}`}
          </div>
        </div>
      </section>

      {/* Error State */}
      {error && (
        <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50/70 dark:bg-red-950/25 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-red-900 dark:text-red-200">{error}</p>
            <p className="mt-1 text-xs text-red-700/80 dark:text-red-300/80">
              Public book repositories occasionally throttle traffic. Retry or upload a local PDF directly.
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              runSearch({
                q: activeQuery,
                cat: category,
                lang: searchLang,
                fmt: format,
                srt: sort,
                pg: page,
              })
            }
            className="h-9 px-4 rounded-md text-xs font-medium bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-950 cursor-pointer shrink-0"
          >
            Retry Search
          </button>
        </div>
      )}

      {/* Results Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div
              key={idx}
              className="rounded-lg border border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] p-4 space-y-4 animate-pulse"
            >
              <div className="flex gap-4">
                <div className="w-24 aspect-[3/4] rounded bg-stone-200 dark:bg-stone-800 shrink-0" />
                <div className="flex-1 space-y-2.5 py-1">
                  <div className="h-4 bg-stone-200 dark:bg-stone-800 rounded w-5/6" />
                  <div className="h-3 bg-stone-200 dark:bg-stone-800 rounded w-1/2" />
                  <div className="h-3 bg-stone-200 dark:bg-stone-800 rounded w-3/4" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 pt-3 border-t border-stone-200/70 dark:border-stone-800/70">
                <div className="h-8 bg-stone-200 dark:bg-stone-800 rounded" />
                <div className="h-8 bg-stone-200 dark:bg-stone-800 rounded" />
                <div className="h-8 bg-stone-200 dark:bg-stone-800 rounded" />
                <div className="h-8 bg-stone-200 dark:bg-stone-800 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : books.length === 0 ? (
        <div className="rounded-lg border border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] px-6 py-14 text-center">
          <BookOpen className="w-7 h-7 mx-auto text-stone-400" />
          <h2 className="mt-3 font-display text-lg font-semibold text-stone-900 dark:text-stone-100">
            No matching public-domain books found
          </h2>
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400 max-w-md mx-auto">
            Try switching format to &ldquo;All Formats&rdquo;, broadening the category, or searching a
            different title or author name.
          </p>
          <button
            type="button"
            onClick={() => {
              setQueryInput('');
              setActiveQuery('');
              setCategory('all');
              setSearchLang('all');
              setFormat('all');
              setPage(1);
            }}
            className="mt-4 h-9 px-4 rounded-md border border-stone-300 dark:border-stone-700 text-xs font-medium text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
          >
            Reset Filters
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {books.map((book) => {
              const downloadsLabel = formatCompactCount(book.downloads);
              const canImportInApp = Boolean(book.pdfUrl || book.textUrl);
              const isThisBookLoading = loadingBookAction?.bookId === book.id;

              return (
                <article
                  key={book.id}
                  className="flex flex-col rounded-lg border border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] p-4 transition-colors hover:border-stone-300 dark:hover:border-stone-700"
                >
                  {/* Top Split: Cover + Editorial Metadata */}
                  <div className="flex gap-4 flex-1">
                    <button
                      type="button"
                      onClick={() => setSelectedBook(book)}
                      aria-label={`Inspect details for ${book.title}`}
                      className="shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-700 rounded-[3px] cursor-pointer"
                    >
                      <BookCoverFrame book={book} size="card" />
                    </button>

                    <div className="min-w-0 flex-1 flex flex-col">
                      <p className="text-[11px] text-stone-500 dark:text-stone-400 truncate">
                        {sourceDisplayName(book.source)} · {book.format}
                      </p>

                      <button
                        type="button"
                        onClick={() => setSelectedBook(book)}
                        className="mt-1 text-left focus:outline-none group cursor-pointer"
                      >
                        <h2 className="font-display text-base font-semibold leading-snug text-stone-950 sepia:text-[#2E241A] dark:text-stone-50 line-clamp-2 group-hover:text-amber-800 dark:group-hover:text-amber-400 transition-colors">
                          {book.title}
                        </h2>
                      </button>

                      <p className="mt-1 text-xs text-stone-600 sepia:text-[#574838] dark:text-stone-400 truncate">
                        {book.author}
                      </p>

                      <div className="mt-auto pt-3 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-stone-500 dark:text-stone-400 font-mono-num">
                        <span>{book.language}</span>
                        {book.pageCount && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{book.pageCount}p</span>
                          </>
                        )}
                        {book.year && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{book.year}</span>
                          </>
                        )}
                        {downloadsLabel && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{downloadsLabel} DL</span>
                          </>
                        )}
                        {book.rating && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="inline-flex items-center gap-0.5 text-amber-800 dark:text-amber-400">
                              <Star className="w-3 h-3 fill-current" />
                              {book.rating.toFixed(1)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 4-in-1 Quick-Action Buttons */}
                  <div className="mt-4 pt-3.5 border-t border-stone-200/80 sepia:border-[#DFD4BC] dark:border-stone-800/80 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={isBusyGlobal || !canImportInApp}
                      onClick={() => onActionBook(book, 'read')}
                      title={
                        canImportInApp
                          ? 'Open directly in BhashaBook Reader'
                          : 'Reference-only entry — open on source library'
                      }
                      className="h-8 px-2.5 rounded text-xs font-medium inline-flex items-center justify-center gap-1.5 bg-stone-900 text-stone-50 hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-stone-200 disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      {isThisBookLoading && loadingBookAction?.action === 'read' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <BookOpen className="w-3.5 h-3.5" />
                      )}
                      <span>Read Online</span>
                    </button>

                    <button
                      type="button"
                      disabled={isBusyGlobal || !canImportInApp}
                      onClick={() => onActionBook(book, 'translate')}
                      title={`Load & translate into ${targetLangOption.name}`}
                      className="h-8 px-2.5 rounded text-xs font-medium inline-flex items-center justify-center gap-1.5 bg-amber-700 hover:bg-amber-800 text-white disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      {isThisBookLoading && loadingBookAction?.action === 'translate' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Languages className="w-3.5 h-3.5" />
                      )}
                      <span>Translate &amp; Read</span>
                    </button>

                    <button
                      type="button"
                      disabled={isBusyGlobal || !canImportInApp}
                      onClick={() => onActionBook(book, 'listen')}
                      title="Open & start synchronized audiobook narration"
                      className="h-8 px-2.5 rounded text-xs font-medium inline-flex items-center justify-center gap-1.5 border border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      {isThisBookLoading && loadingBookAction?.action === 'listen' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Headphones className="w-3.5 h-3.5" />
                      )}
                      <span>Listen Now</span>
                    </button>

                    {canImportInApp ? (
                      <button
                        type="button"
                        disabled={isBusyGlobal}
                        onClick={() => onActionBook(book, 'download')}
                        title="Download PDF to your device"
                        className="h-8 px-2.5 rounded text-xs font-medium inline-flex items-center justify-center gap-1.5 border border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40 transition-colors cursor-pointer whitespace-nowrap"
                      >
                        {isThisBookLoading && loadingBookAction?.action === 'download' ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Download className="w-3.5 h-3.5" />
                        )}
                        <span>Download PDF</span>
                      </button>
                    ) : safeExternalUrl(book.readOnlineUrl) ? (
                      <a
                        href={safeExternalUrl(book.readOnlineUrl)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="h-8 px-2.5 rounded text-xs font-medium inline-flex items-center justify-center gap-1.5 border border-stone-300 dark:border-stone-700 text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors whitespace-nowrap"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        <span>View Source</span>
                      </a>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>

          {/* Pagination Controls */}
          <div className="pt-4 border-t border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 flex items-center justify-between">
            <button
              type="button"
              disabled={page <= 1 || isLoading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md border border-stone-300 dark:border-stone-700 text-xs font-medium text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40 cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
              <span>Previous Page</span>
            </button>

            <span className="text-xs font-mono-num text-stone-500 dark:text-stone-400">
              Results Page {page}
            </span>

            <button
              type="button"
              disabled={isLoading || books.length < 6}
              onClick={() => setPage((p) => p + 1)}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md border border-stone-300 dark:border-stone-700 text-xs font-medium text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40 cursor-pointer"
            >
              <span>Next Page</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </>
      )}

      {/* Book Details Modal */}
      {selectedBook && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="book-detail-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55 backdrop-blur-[1px]"
          onClick={() => setSelectedBook(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg border border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-[#FAF9F5] sepia:bg-[#F4ECD8] dark:bg-[#191816] shadow-2xl"
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800">
              <p className="text-xs text-stone-500 dark:text-stone-400">
                {sourceDisplayName(selectedBook.source)} · {selectedBook.format} ·{' '}
                {selectedBook.language}
              </p>
              <button
                type="button"
                onClick={() => setSelectedBook(null)}
                aria-label="Close book details"
                className="h-8 w-8 inline-flex items-center justify-center rounded-md text-stone-500 hover:text-stone-950 dark:hover:text-stone-100 hover:bg-stone-200/60 dark:hover:bg-stone-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-6">
              <div className="flex flex-col sm:flex-row gap-6">
                <BookCoverFrame book={selectedBook} size="modal" />

                <div className="flex-1 min-w-0 space-y-3">
                  <div>
                    <h2
                      id="book-detail-title"
                      className="font-display text-2xl font-semibold leading-snug text-stone-950 dark:text-stone-50"
                    >
                      {selectedBook.title}
                    </h2>
                    <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
                      by {selectedBook.author}
                    </p>
                  </div>

                  {/* Accession Metadata Grid */}
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 pt-3 border-t border-stone-200 dark:border-stone-800 text-xs">
                    <div>
                      <dt className="text-stone-500 dark:text-stone-400">Published</dt>
                      <dd className="font-mono-num font-medium text-stone-900 dark:text-stone-100">
                        {selectedBook.year ?? 'Classic / Public Domain'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-stone-500 dark:text-stone-400">Length</dt>
                      <dd className="font-mono-num font-medium text-stone-900 dark:text-stone-100">
                        {enrichedPages ?? selectedBook.pageCount
                          ? `${enrichedPages ?? selectedBook.pageCount} pages`
                          : 'Full e-book'}
                      </dd>
                    </div>
                    {selectedBook.downloads && (
                      <div>
                        <dt className="text-stone-500 dark:text-stone-400">Downloads</dt>
                        <dd className="font-mono-num font-medium text-stone-900 dark:text-stone-100">
                          {selectedBook.downloads.toLocaleString()}
                        </dd>
                      </div>
                    )}
                    {selectedBook.isbn && (
                      <div>
                        <dt className="text-stone-500 dark:text-stone-400">ISBN</dt>
                        <dd className="font-mono-num font-medium text-stone-900 dark:text-stone-100">
                          {selectedBook.isbn}
                        </dd>
                      </div>
                    )}
                  </dl>

                  {selectedBook.subjects.length > 0 && (
                    <p className="text-xs text-stone-500 dark:text-stone-400 leading-relaxed">
                      <span className="font-medium text-stone-700 dark:text-stone-300">
                        Subjects:{' '}
                      </span>
                      {selectedBook.subjects.join(' · ')}
                    </p>
                  )}
                </div>
              </div>

              {/* Synopsis */}
              <div className="pt-4 border-t border-stone-200 dark:border-stone-800">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
                  Overview
                </h3>
                {isEnrichingModal ? (
                  <p className="mt-2 text-xs text-stone-500 inline-flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Loading archive synopsis…
                  </p>
                ) : (
                  <p className="mt-2 text-sm text-stone-700 dark:text-stone-300 leading-relaxed">
                    {enrichedDescription ||
                      selectedBook.description ||
                      'Free public-domain edition ready for side-by-side bilingual translation, interactive dictionary lookup, synchronized audiobook playback, and cover-preserved PDF export.'}
                  </p>
                )}
              </div>

              {/* Modal 4-in-1 Actions */}
              <div className="pt-4 border-t border-stone-200 dark:border-stone-800 flex flex-wrap items-center gap-2.5">
                {Boolean(selectedBook.pdfUrl || selectedBook.textUrl) ? (
                  <>
                    <button
                      type="button"
                      disabled={isBusyGlobal}
                      onClick={async () => {
                        const target = selectedBook;
                        setSelectedBook(null);
                        await onActionBook(target, 'read');
                      }}
                      className="h-9 px-4 rounded-md text-xs font-medium inline-flex items-center gap-1.5 bg-stone-900 text-white hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-950 cursor-pointer"
                    >
                      <BookOpen className="w-3.5 h-3.5" />
                      <span>Read Online</span>
                    </button>

                    <button
                      type="button"
                      disabled={isBusyGlobal}
                      onClick={async () => {
                        const target = selectedBook;
                        setSelectedBook(null);
                        await onActionBook(target, 'translate');
                      }}
                      className="h-9 px-4 rounded-md text-xs font-medium inline-flex items-center gap-1.5 bg-amber-700 hover:bg-amber-800 text-white cursor-pointer"
                    >
                      <Languages className="w-3.5 h-3.5" />
                      <span>Translate to {targetLangOption.name}</span>
                    </button>

                    <button
                      type="button"
                      disabled={isBusyGlobal}
                      onClick={async () => {
                        const target = selectedBook;
                        setSelectedBook(null);
                        await onActionBook(target, 'listen');
                      }}
                      className="h-9 px-4 rounded-md text-xs font-medium inline-flex items-center gap-1.5 border border-stone-300 dark:border-stone-700 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
                    >
                      <Headphones className="w-3.5 h-3.5" />
                      <span>Listen Now</span>
                    </button>

                    <button
                      type="button"
                      disabled={isBusyGlobal}
                      onClick={async () => {
                        const target = selectedBook;
                        setSelectedBook(null);
                        await onActionBook(target, 'download');
                      }}
                      className="h-9 px-4 rounded-md text-xs font-medium inline-flex items-center gap-1.5 border border-stone-300 dark:border-stone-700 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download PDF</span>
                    </button>
                  </>
                ) : (
                  <p className="text-xs text-stone-500 dark:text-stone-400">
                    This catalog entry does not include a direct open-access PDF file.
                  </p>
                )}

                {safeExternalUrl(selectedBook.readOnlineUrl) && (
                  <a
                    href={safeExternalUrl(selectedBook.readOnlineUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto inline-flex items-center gap-1 text-xs text-stone-500 hover:text-amber-800 dark:text-stone-400 dark:hover:text-amber-400 hover:underline"
                  >
                    <span>Source Record</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
};
