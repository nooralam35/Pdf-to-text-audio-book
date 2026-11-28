import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  ExternalLink,
  Globe,
  Headphones,
  Languages,
  Loader2,
  Search,
  Star,
  Upload,
  X,
} from 'lucide-react';
import {
  CATEGORY_BY_ID,
  CATEGORY_GROUPS,
  getBookJacketTheme,
  WORLD_BOOK_CATEGORIES,
  type CategoryGroupId,
  type WorldBookCategoryMeta,
} from '../lib/bookCategories';
import { resolveArchiveMetadata, searchGlobalBooks } from '../lib/bookDiscovery';
import { getLanguageOption } from '../lib/languages';
import type {
  BookCategory,
  BookFormatFilter,
  BookSortBy,
  DiscoveredBook,
  LanguageCode,
  StoredBook,
} from '../types';

export type DiscoverBookAction = 'read' | 'translate' | 'listen' | 'download' | 'bookmark';

interface DiscoverViewProps {
  targetLang: LanguageCode;
  savedBooks?: StoredBook[];
  onActionBook: (book: DiscoveredBook, action: DiscoverBookAction) => Promise<void>;
  loadingBookAction: { bookId: string; action: DiscoverBookAction; status: string } | null;
  onUploadPdf: (file: File) => void;
  isUploading: boolean;
}

const SEARCH_LANGUAGES = [
  { code: 'all', label: 'All World Languages' },
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
  { code: 'sa', label: 'Sanskrit' },
  { code: 'ur', label: 'Urdu' },
  { code: 'bn', label: 'Bengali' },
  { code: 'ta', label: 'Tamil' },
  { code: 'mr', label: 'Marathi' },
  { code: 'gu', label: 'Gujarati' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'ar', label: 'Arabic' },
  { code: 'fa', label: 'Persian' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ru', label: 'Russian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
];

const QUICK_QUERIES = [
  'Sherlock Holmes',
  'Calculus Textbook',
  'World Atlas',
  "Gray's Anatomy",
  'Python Programming',
  'Pride and Prejudice',
  'Bhagavad Gita',
  'World History',
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
  if (source === 'arxiv') return 'arXiv Open PDF';
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

const EMPTY_SAVED_BOOKS: StoredBook[] = [];

const CategoryCoverThumb: React.FC<{
  cat: WorldBookCategoryMeta;
  liveCoverUrl?: string;
  size?: 'sm' | 'md';
}> = React.memo(({ cat, liveCoverUrl, size = 'sm' }) => {
  const candidates = useMemo(() => {
    const list: string[] = [];
    if (liveCoverUrl) list.push(liveCoverUrl);
    if (cat.coverUrl && !list.includes(cat.coverUrl)) list.push(cat.coverUrl);
    if (cat.fallbackCoverUrl && !list.includes(cat.fallbackCoverUrl)) {
      list.push(cat.fallbackCoverUrl);
    }
    return list;
  }, [liveCoverUrl, cat.coverUrl, cat.fallbackCoverUrl]);

  const [candidateIdx, setCandidateIdx] = useState(0);

  useEffect(() => {
    setCandidateIdx(0);
  }, [candidates]);

  const activeUrl = candidates[candidateIdx];
  const dimClass =
    size === 'md' ? 'w-12 h-16 shrink-0' : 'w-10 h-14 shrink-0';

  if (activeUrl) {
    return (
      <div
        className={`${dimClass} relative overflow-hidden rounded-[3px] bg-stone-200 dark:bg-stone-800 border border-stone-300/80 dark:border-stone-700 shadow-xs`}
      >
        <img
          src={activeUrl}
          alt={`${cat.label} cover`}
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setCandidateIdx((i) => i + 1)}
          onLoad={(e) => {
            if (e.currentTarget.naturalWidth < 20 || e.currentTarget.naturalHeight < 20) {
              setCandidateIdx((i) => i + 1);
            }
          }}
          className="w-full h-full object-cover"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-black/25"
        />
      </div>
    );
  }

  return (
    <div
      className={`${dimClass} relative overflow-hidden rounded-[3px] border border-black/20 shadow-xs flex ${cat.coverClass} select-none`}
    >
      <span aria-hidden="true" className={`w-1.5 h-full shrink-0 ${cat.spineClass}`} />
      <div className="flex-1 p-1 flex flex-col justify-between items-center text-center">
        <span
          className={`w-full border-b pb-0.5 text-[8px] font-mono-num font-bold tracking-wider ${cat.accentClass}`}
        >
          {cat.monogram}
        </span>
        <BookOpen className="w-3 h-3 text-white/80" />
      </div>
    </div>
  );
});

const BookCoverFrame: React.FC<{
  book: DiscoveredBook;
  size?: 'card' | 'modal';
}> = React.memo(({ book, size = 'card' }) => {
  const candidates = useMemo(() => {
    const list: string[] = [];
    if (book.coverUrl) list.push(book.coverUrl);
    if (book.fallbackCoverUrl && !list.includes(book.fallbackCoverUrl)) {
      list.push(book.fallbackCoverUrl);
    }
    return list;
  }, [book.coverUrl, book.fallbackCoverUrl]);

  const [candidateIdx, setCandidateIdx] = useState(0);

  useEffect(() => {
    setCandidateIdx(0);
  }, [candidates]);

  const activeUrl = candidates[candidateIdx];
  const dimClass =
    size === 'modal'
      ? 'w-40 sm:w-48 aspect-[2/3] shrink-0'
      : 'w-24 sm:w-28 aspect-[2/3] shrink-0';

  if (activeUrl) {
    return (
      <div
        className={`${dimClass} relative overflow-hidden rounded-[3px] bg-[#EFECE6] sepia:bg-[#E7DEC8] dark:bg-[#141312] border border-stone-300/80 dark:border-stone-700 shadow-sm flex items-center justify-center`}
      >
        <img
          src={activeUrl}
          alt={`${book.title} cover`}
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setCandidateIdx((i) => i + 1)}
          onLoad={(e) => {
            if (e.currentTarget.naturalWidth < 20 || e.currentTarget.naturalHeight < 20) {
              setCandidateIdx((i) => i + 1);
            }
          }}
          className="w-full h-full object-cover"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-1.5 bg-gradient-to-r from-black/30 to-transparent"
        />
      </div>
    );
  }

  const jacket = getBookJacketTheme(`${book.id}:${book.title}`);

  return (
    <div
      className={`${dimClass} relative overflow-hidden rounded-[3px] border border-black/25 dark:border-stone-700 shadow-sm flex ${jacket.coverClass} text-left select-none`}
    >
      <span aria-hidden="true" className={`w-2 h-full shrink-0 ${jacket.spineClass}`} />
      <div className="flex-1 p-2.5 flex flex-col justify-between min-w-0">
        <div className={`border-b pb-1 flex items-center justify-between gap-1 ${jacket.accentClass}`}>
          <span className="text-[9px] font-mono-num uppercase tracking-wider truncate">
            {book.format === 'PDF' ? 'Full PDF' : 'Full Book'}
          </span>
          {book.year && (
            <span className="text-[9px] font-mono-num shrink-0">{book.year}</span>
          )}
        </div>

        <div className="my-auto py-1 space-y-1">
          <p
            className={`font-display font-semibold leading-tight text-stone-50 ${
              size === 'modal' ? 'text-sm line-clamp-5' : 'text-[11px] line-clamp-4'
            }`}
          >
            {book.title}
          </p>
          <p className="text-[10px] text-stone-300/90 truncate">{book.author}</p>
        </div>

        <div className="pt-1 border-t border-white/15 flex items-center justify-between text-[9px] text-stone-300/80">
          <span className="truncate">{book.language}</span>
          <BookOpen className="w-3 h-3 shrink-0 opacity-80" />
        </div>
      </div>
    </div>
  );
});

const DiscoverViewInner: React.FC<DiscoverViewProps> = ({
  targetLang,
  savedBooks = EMPTY_SAVED_BOOKS,
  onActionBook,
  loadingBookAction,
  onUploadPdf,
  isUploading,
}) => {
  const [queryInput, setQueryInput] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [category, setCategory] = useState<BookCategory>('all');
  const [categoryGroup, setCategoryGroup] = useState<CategoryGroupId>('all');
  const [categoryFilterText, setCategoryFilterText] = useState('');
  const [categoriesExpanded, setCategoriesExpanded] = useState(true);
  const [liveCategoryCovers, setLiveCategoryCovers] = useState<Partial<Record<BookCategory, string>>>(
    {}
  );

  const [searchLang, setSearchLang] = useState('all');
  const [format, setFormat] = useState<BookFormatFilter>('all');
  const [sort, setSort] = useState<BookSortBy>('downloads');
  const [page, setPage] = useState(1);

  const [books, setBooks] = useState<DiscoveredBook[]>([]);
  const [sourceCounts, setSourceCounts] = useState({
    internetArchive: 0,
    openLibrary: 0,
    gutenberg: 0,
    arxiv: 0,
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
  const resultsSectionRef = useRef<HTMLElement | null>(null);
  const targetLangOption = getLanguageOption(targetLang);

  const activeCategoryMeta = CATEGORY_BY_ID[category];

  const visibleCategories = useMemo(() => {
    const q = categoryFilterText.trim().toLowerCase();
    return WORLD_BOOK_CATEGORIES.filter((cat) => {
      if (categoryGroup !== 'all' && cat.group !== categoryGroup) return false;
      if (!q) return true;
      return (
        cat.label.toLowerCase().includes(q) ||
        cat.tagline.toLowerCase().includes(q)
      );
    });
  }, [categoryGroup, categoryFilterText]);

  const displayedCategories = useMemo(() => {
    if (categoriesExpanded || categoryFilterText.trim() || categoryGroup !== 'all') {
      return visibleCategories;
    }
    return visibleCategories.slice(0, 10);
  }, [visibleCategories, categoriesExpanded, categoryFilterText, categoryGroup]);

  const savedBooksLookup = useMemo(() => {
    const byDiscoveredId = new Map<string, StoredBook>();
    const byStoredId = new Map<string, StoredBook>();
    for (const b of savedBooks) {
      if (b.discoveredBookId) byDiscoveredId.set(b.discoveredBookId, b);
      byStoredId.set(b.id, b);
    }
    return { byDiscoveredId, byStoredId };
  }, [savedBooks]);

  const findSavedBook = useCallback(
    (book: DiscoveredBook): StoredBook | undefined => {
      const direct = savedBooksLookup.byDiscoveredId.get(book.id);
      if (direct) return direct;
      const legacyStoredId = `discover-${book.source}-${book.identifier
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 40)}`;
      return savedBooksLookup.byStoredId.get(legacyStoredId);
    },
    [savedBooksLookup]
  );

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
          setSourceCounts({
            internetArchive: res.sources.internetArchive ?? 0,
            openLibrary: res.sources.openLibrary ?? 0,
            gutenberg: res.sources.gutenberg ?? 0,
            arxiv: res.sources.arxiv ?? 0,
          });
          // Cache the top real cover for the browsed category to keep genre thumbnails fresh
          if (opts.cat !== 'all' && !opts.q) {
            const firstWithCover = res.books.find((b) => Boolean(b.coverUrl));
            if (firstWithCover?.coverUrl) {
              setLiveCategoryCovers((prev) =>
                prev[opts.cat] === firstWithCover.coverUrl
                  ? prev
                  : { ...prev, [opts.cat]: firstWithCover.coverUrl }
              );
            }
          }
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
      (selectedBook.source === 'internet_archive' ||
        (selectedBook.source === 'open_library' && Boolean(selectedBook.pdfUrl))) &&
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

  const handleSelectCategory = useCallback((nextCat: BookCategory, scrollToResults = false) => {
    setCategory(nextCat);
    setPage(1);
    if (scrollToResults) {
      window.requestAnimationFrame(() => {
        resultsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }, []);

  const handleSearchSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = queryInput.trim();
      setPage(1);
      setActiveQuery(trimmed);
      if (trimmed) {
        setSort('relevance');
      } else if (sort === 'relevance') {
        setSort('downloads');
      }
      window.requestAnimationFrame(() => {
        resultsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    },
    [queryInput, sort]
  );

  const isBusyGlobal = Boolean(loadingBookAction);

  return (
    <main className="max-w-7xl mx-auto w-full px-4 sm:px-6 py-7 sm:py-9 space-y-7">
      {/* Hero World Books Search Engine Header */}
      <section className="space-y-5 border-b border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 pb-7">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div className="max-w-2xl">
            <p className="inline-flex items-center gap-1.5 text-xs uppercase tracking-widest text-stone-500 dark:text-stone-400">
              <Globe className="w-3.5 h-3.5 text-amber-700 dark:text-amber-500 shrink-0" />
              <span>Internet Archive · Open Library · Project Gutenberg · arXiv · 35 Genres</span>
            </p>
            <h1 className="mt-2 font-display text-3xl sm:text-4xl font-semibold tracking-tight text-stone-950 sepia:text-[#2E241A] dark:text-stone-50">
              World Books Search Engine
            </h1>
            <p className="mt-2 text-sm sm:text-[15px] text-stone-600 sepia:text-[#574838] dark:text-stone-400 leading-relaxed">
              Explore full books with covers across 35 global categories — from thrillers, manga,
              and world atlases to exam prep and university textbooks. Every book opens directly
              for online reading, {targetLangOption.name} translation, audiobook narration,
              bookmarking, and PDF download.
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

        {/* Focal Unified World Books Search Form */}
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
              placeholder="Search full world books by title, author, subject, exam, or ISBN…"
              aria-label="Search full world books"
              className="w-full h-11 pl-10 pr-10 rounded-md border border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] text-sm text-stone-950 dark:text-stone-50 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:outline-none focus:border-amber-700 dark:focus:border-amber-500 transition-colors"
            />
            {queryInput && (
              <button
                type="button"
                onClick={() => {
                  setQueryInput('');
                  setActiveQuery('');
                  if (sort === 'relevance') setSort('downloads');
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
            <span>Search Full Books</span>
          </button>
        </form>

        {/* Quick Topic Shortcuts */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-stone-500 dark:text-stone-400">
          <span>Popular searches:</span>
          {QUICK_QUERIES.map((term, idx) => (
            <React.Fragment key={term}>
              <button
                type="button"
                onClick={() => {
                  setQueryInput(term);
                  setActiveQuery(term);
                  setSort('relevance');
                  setPage(1);
                  window.requestAnimationFrame(() => {
                    resultsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  });
                }}
                className="text-stone-700 dark:text-stone-300 hover:text-amber-800 dark:hover:text-amber-400 underline-offset-4 hover:underline cursor-pointer whitespace-nowrap"
              >
                {term}
              </button>
              {idx < QUICK_QUERIES.length - 1 && <span aria-hidden="true">·</span>}
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

      {/* 35 World Book Categories Directory with Covers */}
      <section
        aria-label="Browse 35 world book categories"
        className="space-y-4 border-b border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 pb-7"
      >
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-lg sm:text-xl font-semibold text-stone-950 sepia:text-[#2E241A] dark:text-stone-50">
              Browse by Category
            </h2>
            <span className="text-xs font-mono-num text-stone-500 dark:text-stone-400">
              · {WORLD_BOOK_CATEGORIES.length} Full-Book Genres with Covers
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="w-3.5 h-3.5 text-stone-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              />
              <input
                type="search"
                value={categoryFilterText}
                onChange={(e) => setCategoryFilterText(e.target.value)}
                placeholder="Filter 35 genres…"
                aria-label="Filter book categories"
                className="h-8 w-44 sm:w-52 pl-8 pr-7 rounded-md border border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] text-xs text-stone-900 dark:text-stone-100 placeholder:text-stone-400 focus:outline-none focus:border-amber-700"
              />
              {categoryFilterText && (
                <button
                  type="button"
                  onClick={() => setCategoryFilterText('')}
                  aria-label="Clear genre filter"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 inline-flex items-center justify-center text-stone-400 hover:text-stone-800 dark:hover:text-stone-200 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {categoryGroup === 'all' && !categoryFilterText.trim() && (
              <button
                type="button"
                onClick={() => setCategoriesExpanded((v) => !v)}
                className="h-8 px-3 rounded-md border border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] text-xs font-medium text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                {categoriesExpanded ? (
                  <>
                    <ChevronUp className="w-3.5 h-3.5" />
                    <span>Compact Shelf</span>
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-3.5 h-3.5" />
                    <span>Show All {WORLD_BOOK_CATEGORIES.length}</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Category Group Filter Tabs */}
        <div
          role="tablist"
          aria-label="Category groups"
          className="flex items-center gap-1 overflow-x-auto pb-1 border-b border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800"
        >
          {CATEGORY_GROUPS.map((grp) => {
            const active = categoryGroup === grp.id;
            return (
              <button
                key={grp.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setCategoryGroup(grp.id)}
                className={`px-3 py-2 text-xs sm:text-[13px] font-medium whitespace-nowrap shrink-0 border-b-2 transition-colors cursor-pointer ${
                  active
                    ? 'border-amber-700 dark:border-amber-500 text-stone-950 dark:text-stone-50'
                    : 'border-transparent text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'
                }`}
              >
                {grp.label}
              </button>
            );
          })}

          {category !== 'all' && (
            <button
              type="button"
              onClick={() => handleSelectCategory('all', false)}
              className="ml-auto px-2.5 py-1.5 text-xs font-medium text-amber-800 dark:text-amber-400 hover:underline whitespace-nowrap shrink-0 cursor-pointer"
            >
              Reset to All World Books
            </button>
          )}
        </div>

        {/* Category Cards Grid — Every Category Shown with Book Cover */}
        {displayedCategories.length === 0 ? (
          <p className="text-xs text-stone-500 dark:text-stone-400 py-3">
            No genre matches &ldquo;{categoryFilterText}&rdquo;. Clear the filter to browse all 35
            categories.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2.5">
            {displayedCategories.map((cat) => {
              const isSelected = category === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => handleSelectCategory(cat.id, true)}
                  className={`group flex items-center gap-3 p-2.5 rounded-md border text-left transition-colors cursor-pointer ${
                    isSelected
                      ? 'border-amber-700 dark:border-amber-500 bg-amber-50/75 sepia:bg-[#EFE3C5] dark:bg-amber-950/35 ring-1 ring-amber-700/30'
                      : 'border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] hover:border-amber-700/50 dark:hover:border-amber-500/50 hover:bg-stone-50/80 dark:hover:bg-[#201E1B]'
                  }`}
                >
                  <CategoryCoverThumb
                    cat={cat}
                    liveCoverUrl={liveCategoryCovers[cat.id]}
                    size="sm"
                  />
                  <div className="min-w-0 flex-1">
                    <p
                      className={`text-xs font-semibold leading-snug line-clamp-2 ${
                        isSelected
                          ? 'text-amber-900 dark:text-amber-300'
                          : 'text-stone-900 sepia:text-[#2E241A] dark:text-stone-100 group-hover:text-amber-800 dark:group-hover:text-amber-400'
                      }`}
                    >
                      {cat.label}
                    </p>
                    <p className="mt-0.5 text-[11px] text-stone-500 sepia:text-[#6B5A47] dark:text-stone-400 line-clamp-1">
                      {cat.tagline}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Active Category Banner + Filter / Sort Controls */}
      <section ref={resultsSectionRef} className="space-y-4 scroll-mt-20">
        {activeCategoryMeta && (
          <div className="rounded-lg border border-amber-700/35 bg-amber-50/60 sepia:bg-[#EFE4C9] dark:bg-amber-950/25 p-3.5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <CategoryCoverThumb
                cat={activeCategoryMeta}
                liveCoverUrl={liveCategoryCovers[activeCategoryMeta.id]}
                size="md"
              />
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-wider font-semibold text-amber-800 dark:text-amber-400">
                  Selected Genre · Full Books
                </p>
                <h2 className="font-display text-lg font-semibold text-stone-950 dark:text-stone-50 truncate">
                  {activeCategoryMeta.label}
                </h2>
                <p className="text-xs text-stone-600 dark:text-stone-400 line-clamp-1">
                  {activeCategoryMeta.tagline}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => handleSelectCategory('all', false)}
              className="h-8 px-3 rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#191816] text-xs font-medium text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer shrink-0"
            >
              All World Books
            </button>
          </div>
        )}

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
                  { id: 'all', label: 'All Full Books' },
                  { id: 'pdf', label: 'Full PDF' },
                  { id: 'text', label: 'EPUB / Text' },
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
              <option value="relevance">Sort: Best Match</option>
              <option value="downloads">Sort: Most Downloaded</option>
              <option value="latest">Sort: Latest Published</option>
              <option value="oldest">Sort: Oldest Classics</option>
              <option value="rating">Sort: Top Rated</option>
            </select>
          </div>

          <div className="text-xs text-stone-500 dark:text-stone-400 font-mono-num">
            {isLoading
              ? 'Searching world libraries…'
              : `${books.length} full books · Archive ${sourceCounts.internetArchive} · Open Library ${sourceCounts.openLibrary} · Gutenberg ${sourceCounts.gutenberg}${
                  sourceCounts.arxiv > 0 ? ` · arXiv ${sourceCounts.arxiv}` : ''
                }`}
          </div>
        </div>
      </section>

      {/* Error State */}
      {error && (
        <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50/70 dark:bg-red-950/25 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-red-900 dark:text-red-200">{error}</p>
            <p className="mt-1 text-xs text-red-700/80 dark:text-red-300/80">
              Public book repositories occasionally throttle traffic. Retry or upload a local PDF
              directly.
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
                <div className="w-24 aspect-[2/3] rounded bg-stone-200 dark:bg-stone-800 shrink-0" />
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
            No matching full books found
          </h2>
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400 max-w-md mx-auto">
            Try switching format to &ldquo;All Full Books&rdquo;, choosing &ldquo;All World
            Languages&rdquo;, or searching a broader title or subject.
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
              const isThisBookLoading = loadingBookAction?.bookId === book.id;
              const savedMatch = findSavedBook(book);
              const isSavedBookmark = Boolean(savedMatch?.isBookmarked);
              const hasReadingResume = Boolean(savedMatch && (savedMatch.lastPage ?? 1) > 1);
              const hasAudioResume = Boolean(
                savedMatch &&
                  (savedMatch.lastAudioPage !== undefined ||
                    savedMatch.lastSentenceIndex !== undefined)
              );

              return (
                <article
                  key={book.id}
                  className={`flex flex-col rounded-lg border bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] p-4 transition-colors ${
                    isSavedBookmark
                      ? 'border-amber-700/55 dark:border-amber-500/55'
                      : 'border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 hover:border-stone-300 dark:hover:border-stone-700'
                  }`}
                >
                  {/* Top Split: Book Cover + Editorial Metadata */}
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
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-[11px] text-stone-500 dark:text-stone-400 truncate pt-0.5">
                          {sourceDisplayName(book.source)} · Full {book.format}
                        </p>

                        <button
                          type="button"
                          disabled={isBusyGlobal}
                          onClick={() => onActionBook(book, 'bookmark')}
                          title={
                            isSavedBookmark
                              ? 'Bookmarked in My Library — click to remove bookmark'
                              : 'Bookmark & save this book to My Library'
                          }
                          aria-label={
                            isSavedBookmark
                              ? `Remove ${book.title} bookmark`
                              : `Bookmark ${book.title} to My Library`
                          }
                          className={`shrink-0 h-7 w-7 inline-flex items-center justify-center rounded border transition-colors cursor-pointer disabled:opacity-50 ${
                            isSavedBookmark
                              ? 'border-amber-700 bg-amber-700 text-white'
                              : 'border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-700 text-stone-500 dark:text-stone-400 hover:text-amber-800 dark:hover:text-amber-400 hover:border-amber-700/50'
                          }`}
                        >
                          {isThisBookLoading && loadingBookAction?.action === 'bookmark' ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Bookmark
                              className={`w-3.5 h-3.5 ${isSavedBookmark ? 'fill-current' : ''}`}
                            />
                          )}
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={() => setSelectedBook(book)}
                        className="mt-1 text-left focus:outline-none group cursor-pointer"
                      >
                        <h3 className="font-display text-base font-semibold leading-snug text-stone-950 sepia:text-[#2E241A] dark:text-stone-50 line-clamp-2 group-hover:text-amber-800 dark:group-hover:text-amber-400 transition-colors">
                          {book.title}
                        </h3>
                      </button>

                      <p className="mt-1 text-xs text-stone-600 sepia:text-[#574838] dark:text-stone-400 truncate">
                        {book.author}
                      </p>

                      {savedMatch && (
                        <p className="mt-1.5 text-[11px] font-mono-num text-amber-800 dark:text-amber-400 truncate">
                          {isSavedBookmark ? 'Bookmarked' : 'In Library'}
                          {' · '}p.{savedMatch.lastPage || 1}/{savedMatch.numPages}
                          {hasAudioResume
                            ? ` · Audio p.${savedMatch.lastAudioPage ?? savedMatch.lastPage ?? 1}`
                            : ''}
                        </p>
                      )}

                      <div className="mt-auto pt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-stone-500 dark:text-stone-400 font-mono-num">
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

                  {/* All-Facilities 4-in-1 Action Buttons (Guaranteed on Every Book Shown) */}
                  <div className="mt-4 pt-3.5 border-t border-stone-200/80 sepia:border-[#DFD4BC] dark:border-stone-800/80 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={isBusyGlobal}
                      onClick={() => onActionBook(book, 'read')}
                      title={
                        hasReadingResume
                          ? `Continue reading from Page ${savedMatch?.lastPage}`
                          : 'Open full book directly in Reader & save to Library'
                      }
                      className="h-8 px-2.5 rounded text-xs font-medium inline-flex items-center justify-center gap-1.5 bg-stone-900 text-stone-50 hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-stone-200 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      {isThisBookLoading && loadingBookAction?.action === 'read' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <BookOpen className="w-3.5 h-3.5" />
                      )}
                      <span>
                        {hasReadingResume ? `Continue p.${savedMatch?.lastPage}` : 'Read Online'}
                      </span>
                    </button>

                    <button
                      type="button"
                      disabled={isBusyGlobal}
                      onClick={() => onActionBook(book, 'translate')}
                      title={`Load & translate into ${targetLangOption.name}`}
                      className="h-8 px-2.5 rounded text-xs font-medium inline-flex items-center justify-center gap-1.5 bg-amber-700 hover:bg-amber-800 text-white disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
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
                      disabled={isBusyGlobal}
                      onClick={() => onActionBook(book, 'listen')}
                      title={
                        hasAudioResume
                          ? `Resume audio from Page ${savedMatch?.lastAudioPage ?? savedMatch?.lastPage ?? 1}, Line ${(savedMatch?.lastSentenceIndex ?? 0) + 1}`
                          : 'Open & start synchronized audiobook narration'
                      }
                      className="h-8 px-2.5 rounded text-xs font-medium inline-flex items-center justify-center gap-1.5 border border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      {isThisBookLoading && loadingBookAction?.action === 'listen' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Headphones className="w-3.5 h-3.5" />
                      )}
                      <span>{hasAudioResume ? 'Resume Audio' : 'Listen Now'}</span>
                    </button>

                    <button
                      type="button"
                      disabled={isBusyGlobal}
                      onClick={() => onActionBook(book, 'download')}
                      title="Download full PDF to your device & keep a record in My Library"
                      className="h-8 px-2.5 rounded text-xs font-medium inline-flex items-center justify-center gap-1.5 border border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      {isThisBookLoading && loadingBookAction?.action === 'download' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Download className="w-3.5 h-3.5" />
                      )}
                      <span>Download PDF</span>
                    </button>
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
              onClick={() => {
                setPage((p) => Math.max(1, p - 1));
                resultsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
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
              onClick={() => {
                setPage((p) => p + 1);
                resultsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
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
                {sourceDisplayName(selectedBook.source)} · Full {selectedBook.format} ·{' '}
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
                      'Full public-domain edition ready for side-by-side bilingual translation, interactive dictionary lookup, synchronized audiobook playback, and cover-preserved PDF export.'}
                  </p>
                )}
              </div>

              {/* Modal All-Facilities Actions */}
              {(() => {
                const modalSaved = findSavedBook(selectedBook);
                const modalBookmarked = Boolean(modalSaved?.isBookmarked);
                return (
                  <div className="pt-4 border-t border-stone-200 dark:border-stone-800 flex flex-wrap items-center gap-2.5">
                    <button
                      type="button"
                      disabled={isBusyGlobal}
                      onClick={async () => {
                        const target = selectedBook;
                        setSelectedBook(null);
                        await onActionBook(target, 'read');
                      }}
                      className="h-9 px-4 rounded-md text-xs font-medium inline-flex items-center gap-1.5 bg-stone-900 text-white hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-950 cursor-pointer whitespace-nowrap"
                    >
                      <BookOpen className="w-3.5 h-3.5" />
                      <span>
                        {modalSaved && (modalSaved.lastPage ?? 1) > 1
                          ? `Continue p.${modalSaved.lastPage}`
                          : 'Read Online'}
                      </span>
                    </button>

                    <button
                      type="button"
                      disabled={isBusyGlobal}
                      onClick={async () => {
                        const target = selectedBook;
                        setSelectedBook(null);
                        await onActionBook(target, 'translate');
                      }}
                      className="h-9 px-4 rounded-md text-xs font-medium inline-flex items-center gap-1.5 bg-amber-700 hover:bg-amber-800 text-white cursor-pointer whitespace-nowrap"
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
                      className="h-9 px-4 rounded-md text-xs font-medium inline-flex items-center gap-1.5 border border-stone-300 dark:border-stone-700 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer whitespace-nowrap"
                    >
                      <Headphones className="w-3.5 h-3.5" />
                      <span>
                        {modalSaved?.lastSentenceIndex !== undefined
                          ? 'Resume Audio'
                          : 'Listen Now'}
                      </span>
                    </button>

                    <button
                      type="button"
                      disabled={isBusyGlobal}
                      onClick={async () => {
                        const target = selectedBook;
                        setSelectedBook(null);
                        await onActionBook(target, 'download');
                      }}
                      className="h-9 px-4 rounded-md text-xs font-medium inline-flex items-center gap-1.5 border border-stone-300 dark:border-stone-700 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer whitespace-nowrap"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download PDF</span>
                    </button>

                    <button
                      type="button"
                      disabled={isBusyGlobal}
                      onClick={async () => {
                        const target = selectedBook;
                        await onActionBook(target, 'bookmark');
                      }}
                      className={`h-9 px-3.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 border transition-colors cursor-pointer whitespace-nowrap ${
                        modalBookmarked
                          ? 'border-amber-700 bg-amber-700 text-white'
                          : 'border-stone-300 dark:border-stone-700 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800'
                      }`}
                    >
                      <Bookmark
                        className={`w-3.5 h-3.5 ${modalBookmarked ? 'fill-current' : ''}`}
                      />
                      <span>{modalBookmarked ? 'Bookmarked' : 'Bookmark'}</span>
                    </button>

                    {safeExternalUrl(selectedBook.readOnlineUrl) && (
                      <a
                        href={safeExternalUrl(selectedBook.readOnlineUrl)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-auto inline-flex items-center gap-1 text-xs text-stone-500 hover:text-amber-800 dark:text-stone-400 dark:hover:text-amber-400 hover:underline whitespace-nowrap"
                      >
                        <span>Source Record</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </main>
  );
};

export const DiscoverView = React.memo(DiscoverViewInner);
