import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  BookOpen,
  CheckCircle2,
  Download,
  FileText,
  GraduationCap,
  Languages,
  Loader2,
  Moon,
  PanelLeft,
  SlidersHorizontal,
  Sparkles,
  Square,
  Sun,
  WifiOff,
  X,
  Zap,
} from 'lucide-react';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import {
  cacheBookForOffline,
  getCachedBookBufferFromSW,
  removeBookFromOfflineCache,
} from './lib/offlineCache';
import { TopBar, type ActiveTab } from './components/TopBar';
import { DiscoverView, type DiscoverBookAction } from './components/DiscoverView';
import { ChapterSidebar } from './components/ChapterSidebar';
import { PdfViewerPane, type PendingOcrReview } from './components/PdfViewerPane';
import {
  TranslatedReaderPane,
  type NextPagePrefetchStatus,
} from './components/TranslatedReaderPane';
import {
  AudiobookBar,
  type AudiobookControlHandle,
} from './components/AudiobookBar';
import { LibraryView } from './components/LibraryView';
import { ExportView } from './components/ExportView';
import { ShareHighlightModal } from './components/ShareHighlightModal';
import {
  exportHighlightsSummarySheet,
  fetchExternalBookAsPdfBuffer,
  summarizeChapterApi,
} from './lib/bookDiscovery';
import type { ShareQuotePayload } from './lib/highlightCardCanvas';
import {
  getLanguageOption,
  LANGUAGES,
  PRELOADED_OBS_BOOK_ID,
  PRELOADED_OBS_BOOK_URL,
} from './lib/languages';
import {
  getVoiceStylePreferenceOption,
  VOICE_STYLE_PREFERENCES,
  type VoiceStylePreference,
} from './lib/voiceProfiles';
import {
  detectChapters,
  detectGarbledBlocks,
  extractPageContent,
  loadPdfFromBuffer,
  loadPdfFromUrl,
  renderPageToDataUrl,
  runClientOcrOnPage,
  type LoadedPdf,
} from './lib/pdfEngine';
import { exportTranslatedPdf } from './lib/pdfExporter';
import {
  deleteBook,
  getBook,
  getBookPdfData,
  getParsedPage,
  getTranslation,
  listBooks,
  listTranslationsForBookLang,
  makeTranslationKey,
  saveBook,
  saveParsedPage,
  saveTranslation,
  stripBookBinary,
  toggleBookBookmark,
  toggleBookSavedBookmark,
  updateBookProgress,
} from './lib/storage';
import {
  getDailyReadingGoalSnapshot,
  recordPageReadToday,
  setDailyReadingGoalPages,
  type DailyReadingGoalSnapshot,
} from './lib/readingGoal';
import {
  countPageWords,
  countReadableWords,
  estimateChapterFinishTime,
  getReadingSpeedSnapshot,
  recordPageTurnSample,
  resetReadingSpeedHistory,
  type ChapterReadingEstimate,
  type ReadingSpeedSnapshot,
} from './lib/readingSpeed';
import {
  checkServerCapabilities,
  DEFAULT_TUTOR_PROMPT,
  downloadBlob,
  sanitizeUserFacingError,
  splitBlocksIntoSentences,
  translatePageBlocks,
  translatePagesBatchFast,
  triggerBlobUrlDownload,
} from './lib/translatorClient';
import { logDevError } from './lib/devErrorLog';
import type {
  BatchTranslationProgress,
  ChapterItem,
  ChapterSummaryResult,
  DiscoveredBook,
  LanguageCode,
  OcrScriptMode,
  ParsedPage,
  ReadingTheme,
  StoredBook,
  TextHighlight,
  TextHighlightColor,
  TranslatedPageRecord,
  TranslationEngine,
  TranslationStyle,
} from './types';

type MobilePane = 'pdf' | 'translated' | 'chapters';

export default function App() {
  // Connectivity & Reading Goal State
  const isOnline = useOnlineStatus();
  const [downloadingBookId, setDownloadingBookId] = useState<string | null>(null);
  const [dailyReadingGoal, setDailyReadingGoal] = useState<DailyReadingGoalSnapshot>(() =>
    getDailyReadingGoalSnapshot()
  );
  const [readingSpeed, setReadingSpeed] = useState<ReadingSpeedSnapshot>(() =>
    getReadingSpeedSnapshot()
  );

  // Navigation & Reading Themes (Light Paper, Sepia, OLED Dark)
  const [activeTab, setActiveTab] = useState<ActiveTab>(() =>
    typeof navigator !== 'undefined' && navigator.onLine === false ? 'library' : 'discover'
  );
  const [mobilePane, setMobilePane] = useState<MobilePane>('translated');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileChaptersOpen, setMobileChaptersOpen] = useState(false);
  const [readingTheme, setReadingTheme] = useState<ReadingTheme>(() => {
    if (typeof window === 'undefined') return 'light';
    const saved = localStorage.getItem('bhashabook-theme');
    if (saved === 'dark' || saved === 'sepia' || saved === 'light') return saved;
    return 'light';
  });
  const [readerFontSize, setReaderFontSize] = useState<number>(() => {
    if (typeof window === 'undefined') return 16;
    const n = parseInt(localStorage.getItem('bhashabook-font-size') ?? '16', 10);
    return Number.isFinite(n) && n >= 13 && n <= 24 ? n : 16;
  });
  const [readerLineHeight, setReaderLineHeight] = useState<number>(() => {
    if (typeof window === 'undefined') return 1.82;
    const n = parseFloat(localStorage.getItem('bhashabook-line-height') ?? '1.82');
    return Number.isFinite(n) && n >= 1.4 && n <= 2.3 ? n : 1.82;
  });

  // Server capabilities
  const [aiAvailable, setAiAvailable] = useState(false);

  // Books & Active PDF
  const [books, setBooks] = useState<StoredBook[]>([]);
  const [activeBook, setActiveBook] = useState<StoredBook | null>(null);
  const [loadedPdf, setLoadedPdf] = useState<LoadedPdf | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isLoadingActivePdf, setIsLoadingActivePdf] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [appBanner, setAppBanner] = useState<string | null>(null);
  const lazyOpenInFlightRef = useRef<string | null>(null);

  // Reader State
  const [currentPage, setCurrentPage] = useState(1);
  const [targetLang, setTargetLang] = useState<LanguageCode>('hi');
  const [engine, setEngineState] = useState<TranslationEngine>(() => {
    if (typeof window === 'undefined') return 'free';
    const saved = localStorage.getItem('bhashabook-engine');
    return saved === 'ai' || saved === 'free' ? saved : 'free';
  });
  const setEngine = useCallback((next: TranslationEngine) => {
    setEngineState(next);
    try {
      localStorage.setItem('bhashabook-engine', next);
    } catch {
      // ignore storage errors
    }
  }, []);
  const [translationStyle, setTranslationStyle] = useState<TranslationStyle>(() => {
    if (typeof window === 'undefined') return 'tutor';
    const saved = localStorage.getItem('bhashabook-translation-style');
    return saved === 'faithful' ? 'faithful' : 'tutor';
  });
  const [tutorPrompt, setTutorPrompt] = useState<string>(() => {
    if (typeof window === 'undefined') return DEFAULT_TUTOR_PROMPT;
    const saved = localStorage.getItem('bhashabook-tutor-prompt');
    return saved && saved.trim().length > 0 ? saved : DEFAULT_TUTOR_PROMPT;
  });
  const [preserveTerms, setPreserveTerms] = useState(false);
  const [autoPreloadNext, setAutoPreloadNext] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const saved = localStorage.getItem('bhashabook-auto-preload-next');
    return saved === null ? true : saved === 'true';
  });
  const [customTermsInput, setCustomTermsInput] = useState('');
  const [voiceStylePreference, setVoiceStylePreference] = useState<VoiceStylePreference>(() => {
    if (typeof window === 'undefined') return 'teacher';
    const saved = localStorage.getItem('bhashabook-voice-style-preference');
    return saved === 'narrator' || saved === 'energetic' ? saved : 'teacher';
  });
  const [showGlossaryPopover, setShowGlossaryPopover] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem('bhashabook-translation-style', translationStyle);
    } catch {
      // ignore storage errors
    }
  }, [translationStyle]);

  useEffect(() => {
    try {
      localStorage.setItem('bhashabook-tutor-prompt', tutorPrompt);
    } catch {
      // ignore storage errors
    }
  }, [tutorPrompt]);

  useEffect(() => {
    try {
      localStorage.setItem('bhashabook-voice-style-preference', voiceStylePreference);
    } catch {
      // ignore storage errors
    }
  }, [voiceStylePreference]);

  // Page Parsed & Translated Records
  const [parsedPage, setParsedPage] = useState<ParsedPage | null>(null);
  const [translatedPage, setTranslatedPage] = useState<TranslatedPageRecord | null>(null);
  const [bookTranslations, setBookTranslations] = useState<TranslatedPageRecord[]>([]);
  const [shareModalPayload, setShareModalPayload] = useState<ShareQuotePayload | null>(null);
  const [translatedCountsByBook, setTranslatedCountsByBook] = useState<Record<string, number>>({});

  // Loading / Processing States
  const [isTranslatingPage, setIsTranslatingPage] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [isRunningOcr, setIsRunningOcr] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrStage, setOcrStage] = useState('');
  const [ocrScriptMode, setOcrScriptMode] = useState<OcrScriptMode>(() => {
    if (typeof window === 'undefined') return 'auto';
    const saved = localStorage.getItem('bhashabook-ocr-script');
    const allowed: OcrScriptMode[] = [
      'auto',
      'devanagari',
      'persoarabic',
      'bengali',
      'tamil',
      'telugu',
      'gujarati',
      'gurmukhi',
      'cjk',
      'cyrillic',
      'latin',
    ];
    return allowed.includes(saved as OcrScriptMode) ? (saved as OcrScriptMode) : 'auto';
  });
  const [pendingOcrReview, setPendingOcrReview] = useState<PendingOcrReview | null>(null);
  const [batchProgress, setBatchProgress] = useState<BatchTranslationProgress | null>(null);
  const batchInFlightRef = useRef(false);
  const [autoDownloadAfterFast, setAutoDownloadAfterFast] = useState(true);
  const autoDownloadAfterFastRef = useRef(true);
  autoDownloadAfterFastRef.current = autoDownloadAfterFast;
  const activeTabRef = useRef<ActiveTab>(activeTab);
  activeTabRef.current = activeTab;
  const exportPdfOptionsRef = useRef<{
    includeCover: boolean;
    includeFigures: boolean;
    includeOriginalSubheader: boolean;
  }>({
    includeCover: true,
    includeFigures: true,
    includeOriginalSubheader: false,
  });
  const handleSyncExportPdfOptions = useCallback(
    (opts: {
      includeCover: boolean;
      includeFigures: boolean;
      includeOriginalSubheader: boolean;
    }) => {
      exportPdfOptionsRef.current = opts;
    },
    []
  );
  const [autoPdfBuildProgress, setAutoPdfBuildProgress] = useState<{
    current: number;
    total: number;
    status: string;
  } | null>(null);
  const [readyAutoPdf, setReadyAutoPdf] = useState<{
    url: string;
    fileName: string;
    exportedPageCount: number;
    includeCover: boolean;
    waitingForFocus?: boolean;
  } | null>(null);
  const [autoPdfError, setAutoPdfError] = useState<string | null>(null);
  const readyAutoPdfUrlRef = useRef<string | null>(null);
  const pendingVisibilityDownloadRef = useRef<{ url: string; fileName: string } | null>(null);
  const batchCancelRef = useRef(false);
  const batchAbortRef = useRef<AbortController | null>(null);
  const pageTranslateAbortRef = useRef<AbortController | null>(null);

  const setReadyAutoPdfSafe = useCallback(
    (
      next: {
        blob: Blob;
        fileName: string;
        exportedPageCount: number;
        includeCover: boolean;
        waitingForFocus?: boolean;
      } | null
    ): string | null => {
      pendingVisibilityDownloadRef.current = null;
      const previousUrl = readyAutoPdfUrlRef.current;
      readyAutoPdfUrlRef.current = null;
      if (previousUrl) {
        // Delay revocation so any active browser download transfer from the previous URL never aborts mid-stream
        window.setTimeout(() => {
          try {
            URL.revokeObjectURL(previousUrl);
          } catch {
            // ignore revoke error
          }
        }, 60_000);
      }
      if (!next) {
        setReadyAutoPdf(null);
        return null;
      }
      const url = URL.createObjectURL(next.blob);
      readyAutoPdfUrlRef.current = url;
      setReadyAutoPdf({
        url,
        fileName: next.fileName,
        exportedPageCount: next.exportedPageCount,
        includeCover: next.includeCover,
        waitingForFocus: next.waitingForFocus,
      });
      return url;
    },
    []
  );

  // If a converted PDF finished while the browser tab was hidden/backgrounded, trigger the download the instant the user returns
  useEffect(() => {
    const flushPendingVisibleDownload = () => {
      const pending = pendingVisibilityDownloadRef.current;
      if (!pending) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      pendingVisibilityDownloadRef.current = null;
      triggerBlobUrlDownload(pending.url, pending.fileName);
      setReadyAutoPdf((prev) =>
        prev && prev.url === pending.url ? { ...prev, waitingForFocus: false } : prev
      );
    };

    document.addEventListener('visibilitychange', flushPendingVisibleDownload);
    window.addEventListener('focus', flushPendingVisibleDownload);
    return () => {
      document.removeEventListener('visibilitychange', flushPendingVisibleDownload);
      window.removeEventListener('focus', flushPendingVisibleDownload);
    };
  }, []);

  useEffect(() => {
    setReadyAutoPdfSafe(null);
    setAutoPdfError(null);
  }, [activeBook?.id, targetLang, setReadyAutoPdfSafe]);

  useEffect(() => {
    return () => {
      pendingVisibilityDownloadRef.current = null;
      if (readyAutoPdfUrlRef.current) {
        try {
          URL.revokeObjectURL(readyAutoPdfUrlRef.current);
        } catch {
          // ignore
        }
        readyAutoPdfUrlRef.current = null;
      }
    };
  }, []);

  // Deduplicated Background Auto-Translate & Auto-Save Tracking
  const inFlightTranslationsRef = useRef<Map<string, Promise<TranslatedPageRecord>>>(new Map());
  const autoOcrInFlightRef = useRef<Map<string, Promise<ParsedPage>>>(new Map());
  const [inFlightKeys, setInFlightKeys] = useState<Set<string>>(() => new Set());
  const [prefetchErrorKeys, setPrefetchErrorKeys] = useState<Set<string>>(() => new Set());
  const activeBookIdRef = useRef<string | null>(null);
  const currentPageRef = useRef<number>(1);
  const targetLangRef = useRef<LanguageCode>('hi');
  const aiAvailableRef = useRef<boolean>(false);
  const ocrScriptModeRef = useRef<OcrScriptMode>('auto');

  // Audiobook Playback Sync State
  const [activeSentenceIndex, setActiveSentenceIndex] = useState<number | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPreparingAudio, setIsPreparingAudio] = useState(false);
  const [narrationSource, setNarrationSource] = useState<'translated' | 'original'>('translated');
  const [jumpRequest, setJumpRequest] = useState<{ index: number; nonce: number } | null>(null);
  const audiobookControlRef = useRef<AudiobookControlHandle | null>(null);

  // Discovery Hub & Chapter Summarizer State
  const [loadingBookAction, setLoadingBookAction] = useState<{
    bookId: string;
    action: DiscoverBookAction;
    status: string;
  } | null>(null);
  const bookmarkPendingRef = useRef<Set<string>>(new Set());
  const bookmarkSeqRef = useRef(0);
  const [pendingPostLoadAction, setPendingPostLoadAction] = useState<{
    bookId: string;
    action: 'translate' | 'listen';
    targetPage?: number;
    sentenceIndex?: number;
    narrationSource?: 'translated' | 'original';
  } | null>(null);
  const [chapterSummaryModal, setChapterSummaryModal] = useState<ChapterSummaryResult | null>(null);
  const [summarizingChapterId, setSummarizingChapterId] = useState<string | null>(null);

  // Print-only Selectable Unicode PDF State
  const [printPayload, setPrintPayload] = useState<{
    pages: TranslatedPageRecord[];
    includeCover: boolean;
  } | null>(null);

  // Sync reading theme (light / sepia / dark) on <html>
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('dark', 'sepia');
    if (readingTheme === 'dark') {
      root.classList.add('dark');
    } else if (readingTheme === 'sepia') {
      root.classList.add('sepia');
    }
    localStorage.setItem('bhashabook-theme', readingTheme);
  }, [readingTheme]);

  useEffect(() => {
    localStorage.setItem('bhashabook-font-size', String(readerFontSize));
  }, [readerFontSize]);

  useEffect(() => {
    localStorage.setItem('bhashabook-line-height', String(readerLineHeight));
  }, [readerLineHeight]);

  useEffect(() => {
    localStorage.setItem('bhashabook-auto-preload-next', String(autoPreloadNext));
  }, [autoPreloadNext]);

  // Refresh Daily Reading Goal snapshot on midnight date rollover or when opening Library
  useEffect(() => {
    if (activeTab === 'library') {
      setDailyReadingGoal(getDailyReadingGoalSnapshot());
    }
  }, [activeTab]);

  useEffect(() => {
    const handleFocus = () => {
      setDailyReadingGoal(getDailyReadingGoalSnapshot());
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  const handleUpdateDailyReadingGoal = useCallback((pages: number) => {
    setDailyReadingGoal(setDailyReadingGoalPages(pages));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('bhashabook-ocr-script', ocrScriptMode);
    } catch {
      // ignore storage errors
    }
  }, [ocrScriptMode]);

  activeBookIdRef.current = activeBook?.id ?? null;
  currentPageRef.current = currentPage;
  targetLangRef.current = targetLang;
  aiAvailableRef.current = aiAvailable;
  ocrScriptModeRef.current = ocrScriptMode;

  const customTerms = useMemo(
    () =>
      customTermsInput
        .split(/[,\n]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    [customTermsInput]
  );

  // Refresh translated counts across library for active language
  const refreshLibraryCounts = useCallback(
    async (bookList: StoredBook[], lang: LanguageCode) => {
      const counts: Record<string, number> = {};
      await Promise.all(
        bookList.map(async (b) => {
          const rows = await listTranslationsForBookLang(b.id, lang);
          counts[b.id] = rows.length;
        })
      );
      setTranslatedCountsByBook(counts);
    },
    []
  );

  const booksRef = useRef(books);
  booksRef.current = books;

  const activeBookRef = useRef<StoredBook | null>(null);
  activeBookRef.current = activeBook;

  // Keep in-memory Library list & activeBook synchronized immutably and ordered by most recently used
  const syncUpdatedBookInState = useCallback((updated: StoredBook, syncActive = true) => {
    const stripped = stripBookBinary(updated);
    const normalized: StoredBook = {
      ...stripped,
      chapters: Array.isArray(stripped.chapters) ? stripped.chapters : [],
      bookmarks: Array.isArray(stripped.bookmarks)
        ? [...stripped.bookmarks].filter((n) => typeof n === 'number' && Number.isFinite(n))
        : stripped.bookmarks,
    };

    setBooks((prev) => {
      const exists = prev.some((b) => b.id === normalized.id);
      const next = exists
        ? prev.map((b) => (b.id === normalized.id ? normalized : b))
        : [normalized, ...prev];
      return [...next].sort(
        (a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt)
      );
    });

    if (syncActive) {
      setActiveBook((curr) => {
        if (!curr || curr.id !== normalized.id) return curr;
        return {
          ...curr,
          ...normalized,
          bookmarks: normalized.bookmarks ? [...normalized.bookmarks] : undefined,
        };
      });
    }
  }, []);

  // Reconcile activeBook immutably whenever books metadata updates, preventing stale or null state renders
  useEffect(() => {
    setActiveBook((curr) => {
      if (!curr) return curr;
      const match = books.find((b) => b.id === curr.id);
      if (!match) return curr;
      const cleanMatch = stripBookBinary(match);
      const currBookmarks = Array.isArray(curr.bookmarks) ? curr.bookmarks : [];
      const nextBookmarks = Array.isArray(cleanMatch.bookmarks) ? cleanMatch.bookmarks : [];
      const bookmarksChanged =
        currBookmarks.length !== nextBookmarks.length ||
        currBookmarks.some((p, i) => p !== nextBookmarks[i]);

      if (
        !bookmarksChanged &&
        curr.isBookmarked === cleanMatch.isBookmarked &&
        curr.lastPage === cleanMatch.lastPage &&
        curr.annotations === cleanMatch.annotations &&
        curr.hasLocalPdf === cleanMatch.hasLocalPdf &&
        curr.numPages === cleanMatch.numPages &&
        curr.chapters.length === (cleanMatch.chapters?.length ?? 0)
      ) {
        return curr;
      }

      return {
        ...curr,
        ...cleanMatch,
        bookmarks: cleanMatch.bookmarks ? [...nextBookmarks] : undefined,
      };
    });
  }, [books]);

  // Hydrate PDF binary, chapters & cover on demand for lightweight bookmarked Discover books
  const hydrateDiscoveredBookPdf = useCallback(
    async (
      book: StoredBook,
      onStatus?: (message: string) => void
    ): Promise<{ book: StoredBook; pdf: LoadedPdf; buffer: ArrayBuffer }> => {
      if (!book.discoveredBook) {
        throw new Error('PDF source data missing for this book.');
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error(
          'This bookmarked book has not been downloaded for offline reading yet. Reconnect once and open or save it offline.'
        );
      }

      const { buffer, fileName } = await fetchExternalBookAsPdfBuffer(
        book.discoveredBook,
        onStatus
      );
      onStatus?.(`Preparing chapters & cover for “${book.title}”…`);

      const pdf = await loadPdfFromBuffer(buffer);
      const [{ chapters, detectedTitle, detectedAuthor }, coverRes, p1] = await Promise.all([
        detectChapters(pdf),
        renderPageToDataUrl(pdf, 1, 1.25, 'image/jpeg', 0.85),
        pdf.getPage(1),
      ]);
      const vp1 = p1.getViewport({ scale: 1.0 });
      const ch1 = chapters.find((c) => c.index === 1) ?? chapters[0];
      const defaultStartPage =
        ch1 && ch1.startPage > 1 ? ch1.startPage : pdf.numPages > 1 ? 2 : 1;

      const hydrated: StoredBook = {
        ...book,
        title: book.title || detectedTitle || 'Public Domain E-Book',
        author: book.author || detectedAuthor || '',
        fileName: fileName || book.fileName,
        numPages: pdf.numPages,
        coverDataUrl: coverRes.dataUrl || book.coverDataUrl,
        chapters: chapters.length > 0 ? chapters : book.chapters,
        pdfData: buffer,
        hasLocalPdf: true,
        lastPage: book.lastPage > 1 ? Math.min(pdf.numPages, book.lastPage) : defaultStartPage,
        lastOpenedAt: Date.now(),
        pageWidth: vp1.width,
        pageHeight: vp1.height,
      };

      await saveBook(hydrated);
      cacheBookForOffline(hydrated).catch(() => {});
      const stripped = stripBookBinary(hydrated);
      syncUpdatedBookInState(stripped, false);
      return { book: stripped, pdf, buffer };
    },
    [syncUpdatedBookInState]
  );

  // Open a StoredBook into the active PDF.js instance (offline-first: IndexedDB -> SW Cache -> Network -> Lazy Discover Hydration)
  const openStoredBook = useCallback(
    async (
      book: StoredBook,
      options?: { pageOverride?: number; restoreAudioState?: boolean }
    ) => {
      setAppBanner(null);
      setIsLoadingActivePdf(true);
      try {
        let resolvedBook = book;
        let pdfDoc: LoadedPdf;
        let localPdfData =
          book.pdfData && book.pdfData.byteLength > 0 ? book.pdfData : undefined;
        if (!localPdfData && book.hasLocalPdf) {
          localPdfData = await getBookPdfData(book.id);
        }

        if (localPdfData && localPdfData.byteLength > 0) {
          pdfDoc = await loadPdfFromBuffer(localPdfData);
        } else {
          const cachedSwBuffer = await getCachedBookBufferFromSW(book);
          if (cachedSwBuffer) {
            pdfDoc = await loadPdfFromBuffer(cachedSwBuffer);
          } else if (book.sourceUrl) {
            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
              throw new Error(
                'This PDF has not been saved for offline reading yet. Reconnect once and click “Save Offline” in My Library.'
              );
            }
            pdfDoc = await loadPdfFromUrl(book.sourceUrl);
            // Persist into Service Worker cache in background so future offline opens work immediately
            cacheBookForOffline(book)
              .then((cached) => {
                syncUpdatedBookInState(cached);
              })
              .catch(() => {});
          } else if (book.discoveredBook) {
            const hydrated = await hydrateDiscoveredBookPdf(book);
            resolvedBook = hydrated.book;
            pdfDoc = hydrated.pdf;
          } else {
            throw new Error('PDF source data missing for this book.');
          }
        }

        const targetPage = Math.max(
          1,
          Math.min(
            resolvedBook.numPages,
            options?.pageOverride ??
              (options?.restoreAudioState
                ? resolvedBook.lastAudioPage ?? resolvedBook.lastPage
                : resolvedBook.lastPage) ??
              1
          )
        );

        const now = Date.now();
        const updatedBook = stripBookBinary(
          (await updateBookProgress(resolvedBook.id, {
            lastPage: targetPage,
            lastOpenedAt: now,
          }).catch(() => undefined)) ?? { ...resolvedBook, lastPage: targetPage, lastOpenedAt: now }
        );

        setLoadedPdf((prev) => {
          if (prev && prev !== pdfDoc) {
            prev.cleanup().catch(() => {});
          }
          return pdfDoc;
        });
        setActiveBook(updatedBook);
        syncUpdatedBookInState(updatedBook);
        setCurrentPage(targetPage);

        if (options?.restoreAudioState) {
          if (updatedBook.lastTargetLang) {
            setTargetLang(updatedBook.lastTargetLang);
          }
          if (updatedBook.lastNarrationSource) {
            setNarrationSource(updatedBook.lastNarrationSource);
          }
        }

        if (
          updatedBook.lastAudioPage === targetPage &&
          typeof updatedBook.lastSentenceIndex === 'number'
        ) {
          setActiveSentenceIndex(updatedBook.lastSentenceIndex);
        } else {
          setActiveSentenceIndex(null);
        }
      } finally {
        setIsLoadingActivePdf(false);
      }
    },
    [hydrateDiscoveredBookPdf, syncUpdatedBookInState]
  );

  // Boot: lightweight IndexedDB metadata load only so Discover & Library render fast with low memory
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        checkServerCapabilities()
          .then((caps) => {
            if (!cancelled) {
              setAiAvailable(caps.aiAvailable);
              if (caps.aiAvailable && typeof window !== 'undefined' && !localStorage.getItem('bhashabook-engine')) {
                setEngineState('ai');
              }
            }
            if (!cancelled && !caps.aiAvailable) {
              window.setTimeout(() => {
                if (cancelled) return;
                checkServerCapabilities()
                  .then((retryCaps) => {
                    if (!cancelled && retryCaps.aiAvailable) {
                      setAiAvailable(true);
                      if (typeof window !== 'undefined' && !localStorage.getItem('bhashabook-engine')) {
                        setEngineState('ai');
                      }
                    }
                  })
                  .catch(() => {});
              }, 2500);
            }
          })
          .catch(() => {});

        const existingBooks = await listBooks();
        if (cancelled) return;

        setBooks(existingBooks);
        refreshLibraryCounts(existingBooks, targetLang).catch(() => {});

        const initialBook =
          existingBooks.find((b) => b.id === PRELOADED_OBS_BOOK_ID) ?? existingBooks[0];
        if (initialBook && !activeBookIdRef.current) {
          const stripped = stripBookBinary(initialBook);
          setActiveBook(stripped);
          setCurrentPage(
            Math.max(1, Math.min(stripped.numPages, stripped.lastPage ?? 1))
          );
        }
      } finally {
        if (!cancelled) setIsInitializing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Lazy-load the active PDF (or initialize the sample guidebook on first Reader/Export visit)
  const activeBookIdForLazy = activeBook?.id ?? null;
  useEffect(() => {
    if (isInitializing) return;
    if (activeTab !== 'reader' && activeTab !== 'export') return;
    if (loadedPdf) return;

    let cancelled = false;
    const targetBook = activeBookRef.current;

    if (targetBook && activeBookIdForLazy === targetBook.id) {
      if (lazyOpenInFlightRef.current === targetBook.id) return;
      lazyOpenInFlightRef.current = targetBook.id;
      openStoredBook(targetBook)
        .catch(() => {})
        .finally(() => {
          if (lazyOpenInFlightRef.current === targetBook.id) {
            lazyOpenInFlightRef.current = null;
          }
        });
      return () => {
        cancelled = true;
      };
    }

    if (
      books.length === 0 &&
      (typeof navigator === 'undefined' || navigator.onLine !== false) &&
      lazyOpenInFlightRef.current !== PRELOADED_OBS_BOOK_ID
    ) {
      lazyOpenInFlightRef.current = PRELOADED_OBS_BOOK_ID;
      setIsLoadingActivePdf(true);
      (async () => {
        try {
          const pdf = await loadPdfFromUrl(PRELOADED_OBS_BOOK_URL);
          if (cancelled) {
            pdf.cleanup().catch(() => {});
            return;
          }
          const [{ chapters, detectedTitle, detectedAuthor }, coverRes, p1] = await Promise.all([
            detectChapters(pdf),
            renderPageToDataUrl(pdf, 1, 1.35, 'image/jpeg', 0.88),
            pdf.getPage(1),
          ]);
          const vp1 = p1.getViewport({ scale: 1.0 });
          const ch1 = chapters.find((c) => c.index === 1) ?? chapters[0];
          const initialPage = ch1 ? ch1.startPage : 1;

          const obsBook: StoredBook = {
            id: PRELOADED_OBS_BOOK_ID,
            title: detectedTitle || 'The OBS Superuser Guidebook',
            author: detectedAuthor || 'Paul Richards',
            fileName: 'OBS ADVANCED BOOK 6 x 9 in.docx.pdf',
            numPages: pdf.numPages,
            coverDataUrl: coverRes.dataUrl,
            chapters,
            sourceUrl: PRELOADED_OBS_BOOK_URL,
            addedAt: Date.now(),
            lastPage: initialPage,
            pageWidth: vp1.width,
            pageHeight: vp1.height,
          };
          await saveBook(obsBook);
          cacheBookForOffline(obsBook)
            .then((cachedObs) => {
              if (!cancelled) {
                syncUpdatedBookInState(cachedObs);
              }
            })
            .catch(() => {});
          const updatedList = await listBooks();
          if (!cancelled) {
            setBooks(updatedList);
            refreshLibraryCounts(updatedList, targetLangRef.current).catch(() => {});
            if (!activeBookIdRef.current) {
              setLoadedPdf(pdf);
              setActiveBook(stripBookBinary(obsBook));
              setCurrentPage(initialPage);
            } else {
              pdf.cleanup().catch(() => {});
            }
          } else {
            pdf.cleanup().catch(() => {});
          }
        } catch {
          // Non-fatal: user can upload any local PDF or browse Discover
        } finally {
          if (lazyOpenInFlightRef.current === PRELOADED_OBS_BOOK_ID) {
            lazyOpenInFlightRef.current = null;
          }
          if (!cancelled) {
            setIsLoadingActivePdf(false);
          }
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [activeBookIdForLazy, activeTab, books.length, isInitializing, loadedPdf, openStoredBook, refreshLibraryCounts, syncUpdatedBookInState]);

  // Load all cached translations for the active book + target language
  const activeBookId = activeBook?.id ?? null;
  useEffect(() => {
    if (!activeBookId) return;
    let cancelled = false;
    listTranslationsForBookLang(activeBookId, targetLang).then((rows) => {
      if (!cancelled) {
        setBookTranslations(rows);
        setTranslatedCountsByBook((prev) => ({
          ...prev,
          [activeBookId]: rows.length,
        }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeBookId, targetLang]);

  // Refresh library counts when book list membership or language changes
  const bookIdsKey = useMemo(() => books.map((b) => b.id).sort().join('|'), [books]);
  useEffect(() => {
    if (booksRef.current.length > 0) {
      refreshLibraryCounts(booksRef.current, targetLang);
    }
  }, [bookIdsKey, targetLang, refreshLibraryCounts]);

  // Load parsed page + cached translation (or attach to an in-flight auto-save prefetch) whenever activeBookId / page / targetLang changes
  useEffect(() => {
    if (!activeBookId || !loadedPdf) return;
    let cancelled = false;

    // Abort any stale single-page translation from the previous page/language so the spinner never gets stuck
    pageTranslateAbortRef.current?.abort();
    pageTranslateAbortRef.current = null;
    setIsTranslatingPage(false);
    setTranslationError(null);
    updateBookProgress(activeBookId, {
      lastPage: currentPage,
      lastTargetLang: targetLang,
      lastOpenedAt: Date.now(),
    })
      .then((updated) => {
        if (!cancelled && updated) {
          syncUpdatedBookInState(updated, false);
        }
      })
      .catch(() => {});

    // Record this unique page toward today's Daily Reading Goal when actively reading
    if (activeTab === 'reader') {
      setDailyReadingGoal(recordPageReadToday(activeBookId, currentPage));
    }

    (async () => {
      // 1. Check cached translation immediately for instant offline rendering
      const cachedTr = await getTranslation(activeBookId, targetLang, currentPage);
      if (!cancelled) {
        setTranslatedPage(cachedTr ?? null);
      }

      // 2. Check cached parsed page or extract fresh from PDF.js (and auto-recover garbled/scanned pages with AI Vision OCR)
      let parsed = await getParsedPage(activeBookId, currentPage);
      if (!parsed) {
        try {
          parsed = await extractPageContent(loadedPdf, currentPage);
          await saveParsedPage(activeBookId, parsed);
        } catch {
          parsed = {
            pageNumber: currentPage,
            width: activeBook?.pageWidth || 432,
            height: activeBook?.pageHeight || 648,
            blocks: [],
            figures: [],
            isBlank: true,
          };
        }
      }
      if (!cancelled) {
        setParsedPage(parsed);
      }

      const looksGarbled =
        !parsed.isOcr &&
        (parsed.isBlank || parsed.looksGarbled || detectGarbledBlocks(parsed.blocks));
      if (
        looksGarbled &&
        aiAvailableRef.current &&
        (typeof navigator === 'undefined' || navigator.onLine !== false)
      ) {
        const cleanParsed = await ensureCleanParsedPage(
          activeBookId,
          loadedPdf,
          currentPage,
          parsed
        ).catch(() => parsed);
        if (!cancelled && cleanParsed && cleanParsed !== parsed) {
          parsed = cleanParsed;
          setParsedPage(cleanParsed);
        }
      }

      // 3. If a background auto-translation for this exact page is already in flight, attach cleanly without duplicating the request
      if (!cachedTr) {
        const key = makeTranslationKey(activeBookId, targetLang, currentPage);
        const pending = inFlightTranslationsRef.current.get(key);
        if (pending && !cancelled) {
          setIsTranslatingPage(true);
          try {
            const record = await pending;
            if (!cancelled) {
              setTranslatedPage(record);
            }
          } catch (err) {
            logDevError('app', err, `In-flight translation attach (page ${currentPage})`);
            if (!cancelled) {
              setTranslationError(err instanceof Error ? err.message : 'Translation failed.');
            }
          } finally {
            if (!cancelled) {
              setIsTranslatingPage(false);
            }
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeBookId, loadedPdf, currentPage, targetLang, activeTab, syncUpdatedBookInState]);

  // If AI capability resolves or device comes online while viewing a garbled/scanned page, auto-recover clean book text
  useEffect(() => {
    if (!aiAvailable || !isOnline || !activeBookId || !loadedPdf || !parsedPage) return;
    if (parsedPage.pageNumber !== currentPage || parsedPage.isOcr) return;
    const needsClean =
      parsedPage.isBlank || parsedPage.looksGarbled || detectGarbledBlocks(parsedPage.blocks);
    if (!needsClean) return;

    let cancelled = false;
    ensureCleanParsedPage(activeBookId, loadedPdf, currentPage, parsedPage)
      .then((cleanParsed) => {
        if (!cancelled && cleanParsed !== parsedPage && cleanParsed.blocks.length > 0) {
          setParsedPage(cleanParsed);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [aiAvailable, isOnline, activeBookId, loadedPdf, currentPage, parsedPage]);

  // Upload a new PDF file from disk
  const handleUploadPdf = async (file: File) => {
    setIsUploading(true);
    setAppBanner(null);
    try {
      const buffer = await file.arrayBuffer();
      const pdf = await loadPdfFromBuffer(buffer);
      const [{ chapters, detectedTitle, detectedAuthor }, coverRes, p1] = await Promise.all([
        detectChapters(pdf),
        renderPageToDataUrl(pdf, 1, 1.35, 'image/jpeg', 0.88),
        pdf.getPage(1),
      ]);
      const vp1 = p1.getViewport({ scale: 1.0 });

      const cleanFileTitle = file.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim();
      const ch1 = chapters.find((c) => c.index === 1) ?? chapters[0];
      const startPage = ch1 ? ch1.startPage : 1;

      const newBook: StoredBook = {
        id: `book-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title: detectedTitle || cleanFileTitle || 'Uploaded PDF Book',
        author: detectedAuthor || '',
        fileName: file.name,
        numPages: pdf.numPages,
        coverDataUrl: coverRes.dataUrl,
        chapters,
        pdfData: buffer,
        addedAt: Date.now(),
        lastOpenedAt: Date.now(),
        lastPage: startPage,
        lastTargetLang: targetLang,
        pageWidth: vp1.width,
        pageHeight: vp1.height,
      };

      await saveBook(newBook);
      await cacheBookForOffline(newBook).catch(() => {});
      const all = await listBooks();
      setBooks(all);

      setLoadedPdf((prev) => {
        if (prev && prev !== pdf) prev.cleanup().catch(() => {});
        return pdf;
      });
      setActiveBook(stripBookBinary(newBook));
      setCurrentPage(startPage);
      setActiveTab('reader');
    } catch (err) {
      logDevError('app', err, `Upload PDF (${file.name})`);
      setAppBanner(
        err instanceof Error ? `Failed to parse PDF: ${err.message}` : 'Failed to load PDF file.'
      );
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteBook = async (bookId: string) => {
    const target = books.find((b) => b.id === bookId);
    if (target) {
      await removeBookFromOfflineCache(target);
    }
    await deleteBook(bookId);
    const remaining = await listBooks();
    setBooks(remaining);
    if (activeBook?.id === bookId) {
      const fallback = remaining[0];
      if (fallback) {
        await openStoredBook(fallback).catch(() => {});
      } else {
        setActiveBook(null);
        setLoadedPdf(null);
      }
    }
  };

  // Toggle Book-level Bookmark / Save (distinct from page bookmarks; metadata-only, crash-safe)
  const handleToggleBookSavedBookmark = useCallback(
    async (bookId: string) => {
      const lockKey = `book:${bookId}`;
      if (bookmarkPendingRef.current.has(lockKey)) return;
      bookmarkPendingRef.current.add(lockKey);
      try {
        const updated = await toggleBookSavedBookmark(bookId);
        if (updated) {
          syncUpdatedBookInState(updated);
          setAppBanner(
            updated.isBookmarked
              ? `Bookmarked “${updated.title}” in My Library.`
              : `Removed “${updated.title}” from Bookmarks.`
          );
        }
      } catch (err) {
        logDevError('app', err, `Toggle book bookmark (${bookId})`);
        setAppBanner(
          err instanceof Error ? `Could not update bookmark: ${err.message}` : 'Could not update bookmark.'
        );
      } finally {
        bookmarkPendingRef.current.delete(lockKey);
      }
    },
    [syncUpdatedBookInState]
  );

  // Resume listening directly from any Library card at its exact saved page & sentence
  const handleListenStoredBook = useCallback(
    async (book: StoredBook) => {
      audiobookControlRef.current?.unlockAudio();
      const resumePage = Math.max(
        1,
        Math.min(book.numPages, book.lastAudioPage ?? book.lastPage ?? 1)
      );
      const resumeSentence = book.lastSentenceIndex ?? 0;
      try {
        await openStoredBook(book, { pageOverride: resumePage, restoreAudioState: true });
        setActiveTab('reader');
        setMobilePane('translated');
        setPendingPostLoadAction({
          bookId: book.id,
          action: 'listen',
          targetPage: resumePage,
          sentenceIndex: resumeSentence,
          narrationSource: book.lastNarrationSource,
        });
      } catch (err) {
        logDevError('app', err, `Listen stored book (${book.title})`);
        setAppBanner(
          err instanceof Error ? err.message : 'Unable to start audio for this book.'
        );
      }
    },
    [openStoredBook]
  );

  // Open & translate directly from any Library card
  const handleTranslateStoredBook = useCallback(
    async (book: StoredBook) => {
      try {
        await openStoredBook(book);
        setActiveTab('reader');
        setMobilePane('translated');
        setPendingPostLoadAction({ bookId: book.id, action: 'translate' });
      } catch (err) {
        logDevError('app', err, `Translate stored book (${book.title})`);
        setAppBanner(
          err instanceof Error ? err.message : 'Unable to open this book for translation.'
        );
      }
    },
    [openStoredBook]
  );

  // Download PDF directly from any Library card (offline-first from IndexedDB / SW Cache)
  const handleDownloadStoredBook = useCallback(
    async (book: StoredBook) => {
      if (downloadingBookId) return;
      setDownloadingBookId(book.id);
      setAppBanner(null);
      try {
        let buffer: ArrayBuffer | null =
          book.pdfData && book.pdfData.byteLength > 0 ? book.pdfData : null;
        if (!buffer && book.hasLocalPdf) {
          buffer = (await getBookPdfData(book.id)) ?? null;
        }
        if (!buffer) {
          buffer = await getCachedBookBufferFromSW(book);
        }
        if (!buffer && book.sourceUrl) {
          const resp = await fetch(book.sourceUrl);
          if (!resp.ok) throw new Error(`Could not fetch PDF (${resp.status}).`);
          buffer = await resp.arrayBuffer();
        }
        if (!buffer && book.discoveredBook) {
          const hydrated = await hydrateDiscoveredBookPdf(book);
          buffer = hydrated.buffer;
          hydrated.pdf.cleanup().catch(() => {});
        }
        if (!buffer) {
          throw new Error('PDF file data is not cached locally yet.');
        }
        const safeName =
          book.fileName && book.fileName.toLowerCase().endsWith('.pdf')
            ? book.fileName
            : `${book.title.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60)}.pdf`;
        downloadBlob(new Blob([buffer], { type: 'application/pdf' }), safeName);
        const updated = await updateBookProgress(book.id, { lastOpenedAt: Date.now() }).catch(
          () => undefined
        );
        if (updated) syncUpdatedBookInState(updated);
        setAppBanner(`Downloaded “${book.title}” (${safeName}).`);
      } catch (err) {
        logDevError('app', err, `Download stored book (${book.title})`);
        setAppBanner(
          err instanceof Error ? err.message : 'Unable to download this PDF right now.'
        );
      } finally {
        setDownloadingBookId(null);
      }
    },
    [downloadingBookId, hydrateDiscoveredBookPdf, syncUpdatedBookInState]
  );

  // Load, translate, listen, bookmark, or download a book from Global E-Book Discovery Hub
  // Every interaction automatically creates/updates its record in My Library and preserves resume history
  const handleActionDiscoveredBook = async (
    book: DiscoveredBook,
    action: DiscoverBookAction
  ) => {
    setAppBanner(null);
    const storedId = `discover-${book.source}-${book.identifier
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 40)}`;

    // Reuse existing Library record so reading/listening progress, bookmarks & translations are preserved
    const existing = books.find(
      (b) => b.discoveredBookId === book.id || b.id === storedId
    );
    if (existing) {
      if (action === 'bookmark') {
        await handleToggleBookSavedBookmark(existing.id);
        return;
      }

      const needsHydration =
        !existing.hasLocalPdf && !existing.sourceUrl && Boolean(existing.discoveredBook);
      if (needsHydration) {
        setLoadingBookAction({
          bookId: book.id,
          action,
          status: `Downloading & preparing “${book.title}”…`,
        });
      }

      try {
        if (action === 'download') {
          await handleDownloadStoredBook(existing);
          return;
        }
        if (action === 'listen') {
          await handleListenStoredBook(existing);
          return;
        }
        if (action === 'translate') {
          await handleTranslateStoredBook(existing);
          return;
        }
        await openStoredBook(existing);
        setActiveTab('reader');
      } catch (err) {
        logDevError('app', err, `Open saved discover book "${action}" (${book.title})`);
        setAppBanner(
          err instanceof Error ? err.message : 'Unable to open this saved book.'
        );
      } finally {
        if (needsHydration) {
          setLoadingBookAction(null);
        }
      }
      return;
    }

    // Bookmarking a discovered book MUST stay lightweight & instant (metadata-only, zero PDF download/parsing)
    if (action === 'bookmark') {
      const lockKey = `discover-bookmark:${storedId}`;
      if (bookmarkPendingRef.current.has(lockKey)) return;
      bookmarkPendingRef.current.add(lockKey);
      try {
        const safeSlug =
          book.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 48) || 'ebook';
        const now = Date.now();
        const lightBook: StoredBook = {
          id: storedId,
          discoveredBookId: book.id,
          discoveredBook: book,
          title: book.title || 'Public Domain E-Book',
          author: book.author || '',
          fileName: `${safeSlug}.pdf`,
          numPages: Math.max(1, book.pageCount || 1),
          coverDataUrl: book.coverUrl
            ? `/api/books/proxy-cover?url=${encodeURIComponent(book.coverUrl)}`
            : '',
          chapters: [],
          hasLocalPdf: false,
          addedAt: now,
          lastOpenedAt: now,
          lastPage: 1,
          lastTargetLang: targetLang,
          isBookmarked: true,
          bookmarkedAt: now,
          externalSource: book.source,
          externalUrl: book.readOnlineUrl,
        };
        await saveBook(lightBook);
        syncUpdatedBookInState(lightBook, false);
        setAppBanner(`Bookmarked “${lightBook.title}” — saved in My Library.`);
      } catch (err) {
        logDevError('app', err, `Bookmark discover book (${book.title})`);
        setAppBanner(
          err instanceof Error
            ? `Could not bookmark “${book.title}”: ${err.message}`
            : 'Could not bookmark this book.'
        );
      } finally {
        bookmarkPendingRef.current.delete(lockKey);
      }
      return;
    }

    setLoadingBookAction({
      bookId: book.id,
      action,
      status: `Preparing "${book.title}"…`,
    });

    try {
      const { buffer, fileName } = await fetchExternalBookAsPdfBuffer(book, (status) => {
        setLoadingBookAction({ bookId: book.id, action, status });
      });

      setLoadingBookAction({
        bookId: book.id,
        action,
        status: `Saving record, chapters & cover for "${book.title}" in My Library…`,
      });

      const pdf = await loadPdfFromBuffer(buffer);
      const [{ chapters, detectedTitle, detectedAuthor }, coverRes, p1] = await Promise.all([
        detectChapters(pdf),
        renderPageToDataUrl(pdf, 1, 1.35, 'image/jpeg', 0.88),
        pdf.getPage(1),
      ]);
      const vp1 = p1.getViewport({ scale: 1.0 });

      // Start on page 2 if Page 1 is pure cover art and book has multiple pages
      const ch1 = chapters.find((c) => c.index === 1) ?? chapters[0];
      const startPage =
        ch1 && ch1.startPage > 1
          ? ch1.startPage
          : pdf.numPages > 1
          ? 2
          : 1;

      const now = Date.now();
      const newBook: StoredBook = {
        id: storedId,
        discoveredBookId: book.id,
        discoveredBook: book,
        title: book.title || detectedTitle || 'Public Domain E-Book',
        author: book.author || detectedAuthor || '',
        fileName,
        numPages: pdf.numPages,
        coverDataUrl: coverRes.dataUrl,
        chapters,
        pdfData: buffer,
        addedAt: now,
        lastOpenedAt: now,
        lastPage: startPage,
        lastTargetLang: targetLang,
        isBookmarked: false,
        pageWidth: vp1.width,
        pageHeight: vp1.height,
        externalSource: book.source,
        externalUrl: book.readOnlineUrl,
      };

      await saveBook(newBook);
      await cacheBookForOffline(newBook).catch(() => {});
      const all = await listBooks();
      setBooks(all);

      if (action === 'download') {
        pdf.cleanup().catch(() => {});
        downloadBlob(new Blob([buffer], { type: 'application/pdf' }), fileName);
        setAppBanner(
          `Downloaded “${newBook.title}” (${fileName}) and saved its record in My Library.`
        );
        return;
      }

      setLoadedPdf((prev) => {
        if (prev && prev !== pdf) prev.cleanup().catch(() => {});
        return pdf;
      });
      setActiveBook(stripBookBinary(newBook));
      setCurrentPage(startPage);
      setActiveSentenceIndex(null);
      setActiveTab('reader');

      if (action === 'translate' || action === 'listen') {
        setPendingPostLoadAction({
          bookId: storedId,
          action,
          targetPage: startPage,
          sentenceIndex: 0,
        });
      }
    } catch (err) {
      logDevError('app', err, `Discover book action "${action}" (${book.title})`);
      setAppBanner(
        err instanceof Error
          ? err.message
          : 'Unable to open this public-domain book right now.'
      );
    } finally {
      setLoadingBookAction(null);
    }
  };

  // Toggle Bookmark for the active page (immutable activeBook update, serialized against race conditions)
  const handleToggleCurrentPageBookmark = useCallback(async () => {
    const targetBook = activeBookRef.current;
    if (!targetBook) return;
    const bookId = targetBook.id;
    const targetPage = Math.max(1, Math.min(targetBook.numPages || currentPage, currentPage));
    const lockKey = `page:${bookId}:${targetPage}`;
    if (bookmarkPendingRef.current.has(lockKey)) return;

    bookmarkPendingRef.current.add(lockKey);
    const seq = ++bookmarkSeqRef.current;
    try {
      const updated = await toggleBookBookmark(bookId, targetPage);
      if (!updated) return;
      if (seq !== bookmarkSeqRef.current && activeBookIdRef.current !== bookId) {
        return;
      }

      const nextBookmarks = Array.isArray(updated.bookmarks)
        ? [...updated.bookmarks]
        : [];
      const immutableBook: StoredBook = {
        ...stripBookBinary(updated),
        bookmarks: nextBookmarks,
      };

      setActiveBook((curr) =>
        curr && curr.id === bookId
          ? {
              ...curr,
              ...immutableBook,
              bookmarks: [...nextBookmarks],
            }
          : curr
      );
      syncUpdatedBookInState(immutableBook, false);
    } catch (err) {
      logDevError('app', err, `Toggle page bookmark (${bookId}, p.${targetPage})`);
      setAppBanner(
        err instanceof Error ? `Could not mark page: ${err.message}` : 'Could not update page bookmark.'
      );
    } finally {
      bookmarkPendingRef.current.delete(lockKey);
    }
  }, [currentPage, syncUpdatedBookInState]);

  // One-Click Chapter Summarizer & Key Takeaways
  const handleSummarizeChapter = useCallback(
    async (chapter: ChapterItem) => {
      if (!activeBook || !loadedPdf || summarizingChapterId) return;
      setSummarizingChapterId(chapter.id);
      setAppBanner(null);
      try {
        // Sample up to first 6 pages of the chapter so summarization is fast and thorough
        const end = Math.min(chapter.endPage, chapter.startPage + 5);
        const chunks: string[] = [];
        for (let p = chapter.startPage; p <= end; p++) {
          const cachedTr = await getTranslation(activeBook.id, targetLang, p);
          if (cachedTr && cachedTr.blocks.length > 0) {
            chunks.push(cachedTr.blocks.map((b) => b.translatedText || b.text).join(' '));
            continue;
          }
          let parsed = await getParsedPage(activeBook.id, p);
          if (!parsed) {
            parsed = await extractPageContent(loadedPdf, p);
            await saveParsedPage(activeBook.id, parsed);
          }
          if (parsed.blocks.length > 0) {
            chunks.push(parsed.blocks.map((b) => b.text).join(' '));
          }
        }
        const combined = chunks.join('\n\n').trim();
        if (combined.length < 40) {
          setAppBanner(`Not enough extractable text in "${chapter.title}" to summarize.`);
          return;
        }
        const summary = await summarizeChapterApi({
          chapterTitle: chapter.title,
          text: combined,
          targetLang,
          translationStyle,
          tutorPrompt,
        });
        setChapterSummaryModal(summary);
      } catch (err) {
        setAppBanner(
          err instanceof Error ? `Chapter summary failed: ${err.message}` : 'Chapter summary failed.'
        );
      } finally {
        setSummarizingChapterId(null);
      }
    },
    [activeBook, loadedPdf, summarizingChapterId, targetLang, translationStyle, tutorPrompt]
  );

  // Export all Highlights, Sticky Notes & Bookmarks as a study summary sheet
  const handleExportHighlightsSheet = useCallback(() => {
    if (!activeBook) return;
    const { exportedCount, fileName } = exportHighlightsSummarySheet(
      activeBook,
      bookTranslations,
      getLanguageOption(targetLang).name
    );
    setAppBanner(
      exportedCount > 0
        ? `Exported ${exportedCount} highlights, notes & bookmarks to ${fileName}.`
        : `Downloaded ${fileName}. Highlight passages or bookmark pages to populate your study sheet.`
    );
  }, [activeBook, bookTranslations, targetLang]);

  // Auto-upgrade scanned or legacy-font garbled pages via AI Vision OCR (deduplicated per book+page)
  const ensureCleanParsedPage = useCallback(
    async (
      bookId: string,
      pdf: LoadedPdf,
      pageNum: number,
      existingParsed?: ParsedPage | null
    ): Promise<ParsedPage> => {
      let parsed = existingParsed ?? (await getParsedPage(bookId, pageNum));
      if (!parsed) {
        parsed = await extractPageContent(pdf, pageNum);
        await saveParsedPage(bookId, parsed);
      }

      const needsCleanOcr =
        !parsed.isOcr &&
        (parsed.isBlank || parsed.looksGarbled || detectGarbledBlocks(parsed.blocks));

      if (
        !needsCleanOcr ||
        !aiAvailableRef.current ||
        (typeof navigator !== 'undefined' && navigator.onLine === false)
      ) {
        return parsed;
      }

      const ocrKey = `${bookId}::${pageNum}`;
      const existingTask = autoOcrInFlightRef.current.get(ocrKey);
      if (existingTask) return existingTask;

      const task = (async (): Promise<ParsedPage> => {
        try {
          const ocrResult = await runClientOcrOnPage(pdf, pageNum, undefined, {
            scale: 2.0,
            scriptMode: ocrScriptModeRef.current,
            preferAiVision: true,
          });
          if (ocrResult.blocks.length > 0 && !detectGarbledBlocks(ocrResult.blocks)) {
            const upgraded: ParsedPage = {
              ...ocrResult,
              figures: parsed.figures,
            };
            await saveParsedPage(bookId, upgraded);
            return upgraded;
          }
          return parsed;
        } catch {
          return parsed;
        } finally {
          autoOcrInFlightRef.current.delete(ocrKey);
        }
      })();

      autoOcrInFlightRef.current.set(ocrKey, task);
      return task;
    },
    []
  );

  // Helper to translate a single page with deduplication and auto-save to IndexedDB
  const translateSinglePageInternal = useCallback(
    async (
      book: StoredBook,
      pdf: LoadedPdf,
      pageNum: number,
      lang: LanguageCode,
      force = false,
      signal?: AbortSignal
    ): Promise<TranslatedPageRecord> => {
      const key = makeTranslationKey(book.id, lang, pageNum);

      if (!force) {
        const inFlight = inFlightTranslationsRef.current.get(key);
        if (inFlight) return inFlight;

        const existing = await getTranslation(book.id, lang, pageNum);
        if (existing) return existing;
      }

      const task = (async (): Promise<TranslatedPageRecord> => {
        const parsed = await ensureCleanParsedPage(book.id, pdf, pageNum);

        // If Smart AI mode is active and the page has figures, scarce text, or looks garbled, attach a compressed page image
        let pageImageBase64: string | undefined;
        if (
          engine === 'ai' &&
          (parsed.figures.length > 0 ||
            parsed.blocks.length <= 2 ||
            parsed.looksGarbled ||
            detectGarbledBlocks(parsed.blocks))
        ) {
          try {
            const snap = await renderPageToDataUrl(pdf, pageNum, 1.35, 'image/jpeg', 0.84);
            pageImageBase64 = snap.dataUrl;
          } catch {
            // proceed text-only
          }
        }

        const record = await translatePageBlocks({
          bookId: book.id,
          bookTitle: book.title,
          parsedPage: parsed,
          targetLang: lang,
          engine,
          translationStyle,
          tutorPrompt,
          preserveTerms,
          customTerms,
          pageImageBase64,
          signal,
        });

        await saveTranslation(record);
        return record;
      })();

      inFlightTranslationsRef.current.set(key, task);
      setInFlightKeys((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      setPrefetchErrorKeys((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });

      try {
        const record = await task;
        return record;
      } finally {
        if (inFlightTranslationsRef.current.get(key) === task) {
          inFlightTranslationsRef.current.delete(key);
        }
        setInFlightKeys((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [engine, translationStyle, tutorPrompt, preserveTerms, customTerms, ensureCleanParsedPage]
  );

  // Merge a newly saved translation into local state if it belongs to the active book & language
  const commitSavedTranslationToState = useCallback(
    (record: TranslatedPageRecord) => {
      if (
        activeBookIdRef.current !== record.bookId ||
        targetLangRef.current !== record.lang
      ) {
        return;
      }

      if (currentPageRef.current === record.pageNumber) {
        setTranslatedPage(record);
      }

      setBookTranslations((prev) => {
        const next = [...prev.filter((r) => r.pageNumber !== record.pageNumber), record].sort(
          (a, b) => a.pageNumber - b.pageNumber
        );
        setTranslatedCountsByBook((counts) => ({
          ...counts,
          [record.bookId]: next.length,
        }));
        return next;
      });
    },
    []
  );

  const handleCancelPageTranslation = useCallback(() => {
    pageTranslateAbortRef.current?.abort();
    pageTranslateAbortRef.current = null;
    setIsTranslatingPage(false);
  }, []);

  // Translate currently visible page (with AbortController safeguard so it never hangs)
  const handleTranslateCurrentPage = useCallback(
    async (force = false) => {
      if (!activeBook || !loadedPdf) return;
      pageTranslateAbortRef.current?.abort();
      const controller = new AbortController();
      pageTranslateAbortRef.current = controller;

      setIsTranslatingPage(true);
      setTranslationError(null);
      try {
        const record = await translateSinglePageInternal(
          activeBook,
          loadedPdf,
          currentPage,
          targetLang,
          force,
          controller.signal
        );
        if (!controller.signal.aborted) {
          commitSavedTranslationToState(record);
        }
      } catch (err) {
        if (
          controller.signal.aborted ||
          (err instanceof DOMException && err.name === 'AbortError')
        ) {
          return;
        }
        logDevError('app', err, `Translate page ${currentPage} (${targetLang})`);
        setTranslationError(
          sanitizeUserFacingError(err, 'Translation could not complete. Retrying automatically…')
        );
      } finally {
        if (pageTranslateAbortRef.current === controller) {
          pageTranslateAbortRef.current = null;
          setIsTranslatingPage(false);
        }
      }
    },
    [
      activeBook,
      loadedPdf,
      currentPage,
      targetLang,
      translateSinglePageInternal,
      commitSavedTranslationToState,
    ]
  );

  // Automatic self-healing recovery: if a page translation ever hit a transient network/proxy hiccup,
  // automatically retry once after a short cooldown (and immediately when connectivity returns)
  const autoRetryKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!translationError || !isOnline || isTranslatingPage || !activeBook || !loadedPdf) {
      return;
    }
    const retryKey = `${activeBook.id}::${targetLang}::${currentPage}`;
    if (autoRetryKeyRef.current === retryKey) {
      return;
    }
    autoRetryKeyRef.current = retryKey;
    const timer = window.setTimeout(() => {
      void handleTranslateCurrentPage(false);
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [
    translationError,
    isOnline,
    isTranslatingPage,
    activeBook,
    loadedPdf,
    targetLang,
    currentPage,
    handleTranslateCurrentPage,
  ]);

  useEffect(() => {
    if (!translationError) {
      autoRetryKeyRef.current = null;
    }
  }, [translationError, currentPage, targetLang, activeBook?.id]);

  // Background Auto-Translate & Auto-Save for the next page when the user reaches the end of the current page
  const prefetchNextPage = useCallback(
    async (pageToPrefetch: number) => {
      if (!autoPreloadNext || !activeBook || !loadedPdf || batchProgress) return;
      if (pageToPrefetch < 1 || pageToPrefetch > activeBook.numPages) return;

      const key = makeTranslationKey(activeBook.id, targetLang, pageToPrefetch);
      if (inFlightTranslationsRef.current.has(key)) return;

      const existing = await getTranslation(activeBook.id, targetLang, pageToPrefetch);
      if (existing) {
        commitSavedTranslationToState(existing);
        return;
      }

      try {
        const record = await translateSinglePageInternal(
          activeBook,
          loadedPdf,
          pageToPrefetch,
          targetLang,
          false
        );
        commitSavedTranslationToState(record);
      } catch {
        setPrefetchErrorKeys((prev) => {
          const next = new Set(prev);
          next.add(key);
          return next;
        });
      }
    },
    [
      autoPreloadNext,
      activeBook,
      loadedPdf,
      batchProgress,
      targetLang,
      translateSinglePageInternal,
      commitSavedTranslationToState,
    ]
  );

  const handleReachPageEnd = useCallback(() => {
    if (!activeBook || currentPage >= activeBook.numPages) return;
    prefetchNextPage(currentPage + 1);
  }, [activeBook, currentPage, prefetchNextPage]);

  const handleCancelBatch = useCallback(() => {
    batchCancelRef.current = true;
    batchAbortRef.current?.abort();
  }, []);

  // Merge multiple saved translation records in one state update (used by fast multi-page batches)
  const commitSavedBatchToState = useCallback((records: TranslatedPageRecord[]) => {
    if (records.length === 0) return;
    const first = records[0];
    if (
      activeBookIdRef.current !== first.bookId ||
      targetLangRef.current !== first.lang
    ) {
      return;
    }

    const currentMatch = records.find((r) => r.pageNumber === currentPageRef.current);
    if (currentMatch) {
      setTranslatedPage(currentMatch);
    }

    const pageSet = new Set(records.map((r) => r.pageNumber));
    setBookTranslations((prev) => {
      const next = [...prev.filter((r) => !pageSet.has(r.pageNumber)), ...records].sort(
        (a, b) => a.pageNumber - b.pageNumber
      );
      setTranslatedCountsByBook((counts) => ({
        ...counts,
        [first.bookId]: next.length,
      }));
      return next;
    });
  }, []);

  // High-Speed Continuous Full-PDF / Range / Chapter Translator with Auto-Save, Wake Lock & Self-Healing Retries
  const handleFastTranslateRange = useCallback(
    async (options: {
      startPage: number;
      endPage: number;
      label: string;
      autoDownloadPdfOptions?: {
        includeCover: boolean;
        includeFigures: boolean;
        includeOriginalSubheader: boolean;
      };
    }): Promise<{
      records: TranslatedPageRecord[];
      cancelled: boolean;
      autoDownloaded?: boolean;
      autoDownloadFileName?: string;
    }> => {
      if (!activeBook || !loadedPdf) {
        return { records: [], cancelled: false };
      }
      if (batchInFlightRef.current) {
        return { records: [], cancelled: false };
      }

      batchInFlightRef.current = true;
      setAutoPdfError(null);
      if (options.autoDownloadPdfOptions) {
        exportPdfOptionsRef.current = options.autoDownloadPdfOptions;
        setReadyAutoPdfSafe(null);
      }

      const book = activeBook;
      const pdf = loadedPdf;
      const lang = targetLang;
      const activeEngine = engine;

      const startPage = Math.max(1, Math.min(book.numPages, options.startPage));
      const endPage = Math.max(startPage, Math.min(book.numPages, options.endPage));
      const allPages = Array.from(
        { length: endPage - startPage + 1 },
        (_, i) => startPage + i
      );

      batchCancelRef.current = false;
      const controller = new AbortController();
      batchAbortRef.current = controller;
      setTranslationError(null);

      // Keep mobile screens awake during long 200+ page conversions so the browser doesn't pause fetch loops
      const wakeLockBox: { current: { release: () => Promise<void> } | null } = { current: null };
      const acquireWakeLock = async () => {
        try {
          const nav = navigator as Navigator & {
            wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
          };
          if (nav.wakeLock && document.visibilityState === 'visible') {
            wakeLockBox.current = await nav.wakeLock.request('screen');
          }
        } catch {
          // Wake Lock unsupported or denied — continue normally
        }
      };
      const releaseWakeLock = () => {
        const sentinel = wakeLockBox.current;
        wakeLockBox.current = null;
        sentinel?.release().catch(() => {});
      };
      const handleVisibilityWake = () => {
        if (document.visibilityState === 'visible' && !batchCancelRef.current) {
          acquireWakeLock().catch(() => {});
        }
      };
      await acquireWakeLock();
      document.addEventListener('visibilitychange', handleVisibilityWake);

      const waitWithCancel = (ms: number): Promise<void> =>
        new Promise((resolve) => {
          if (batchCancelRef.current || ms <= 0) {
            resolve();
            return;
          }
          const timer = window.setTimeout(() => {
            controller.signal.removeEventListener('abort', onAbort);
            resolve();
          }, ms);
          const onAbort = () => {
            window.clearTimeout(timer);
            resolve();
          };
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });

      const waitUntilOnline = async (pageHint: number) => {
        if (typeof navigator === 'undefined' || navigator.onLine !== false) return;
        setBatchProgress({
          label: options.label,
          startPage,
          endPage,
          current: done,
          total: allPages.length,
          currentPage: pageHint,
          startedAt,
          newlyTranslated,
          skippedCached,
          statusNote: 'Waiting for internet connection to reconnect…',
        });
        while (!batchCancelRef.current && navigator.onLine === false) {
          await waitWithCancel(1500);
        }
      };

      const startedAt = Date.now();
      const collected = new Map<number, TranslatedPageRecord>();
      const missingPages: number[] = [];

      // 1. Instantly load & skip already cached pages from IndexedDB
      const existingList = await Promise.all(
        allPages.map((p) => getTranslation(book.id, lang, p))
      );
      for (let i = 0; i < allPages.length; i++) {
        const existing = existingList[i];
        if (existing) {
          collected.set(allPages[i], existing);
        } else {
          missingPages.push(allPages[i]);
        }
      }

      const skippedCached = collected.size;
      let done = skippedCached;
      let newlyTranslated = 0;

      const pushProgress = (pageNum: number, statusNote?: string) => {
        setBatchProgress({
          label: options.label,
          startPage,
          endPage,
          current: done,
          total: allPages.length,
          currentPage: pageNum,
          startedAt,
          newlyTranslated,
          skippedCached,
          statusNote,
        });
      };

      const loadParsedPageSafe = async (pNum: number): Promise<ParsedPage> => {
        try {
          return await ensureCleanParsedPage(book.id, pdf, pNum);
        } catch {
          return {
            pageNumber: pNum,
            width: book.pageWidth || 432,
            height: book.pageHeight || 648,
            blocks: [],
            figures: [],
            isBlank: true,
          };
        }
      };

      const persistBatchRecords = async (records: TranslatedPageRecord[]) => {
        if (records.length === 0) return;
        await Promise.all(records.map((rec) => saveTranslation(rec)));
        for (const rec of records) {
          if (!collected.has(rec.pageNumber)) {
            newlyTranslated++;
          }
          collected.set(rec.pageNumber, rec);
        }
        commitSavedBatchToState(records);
        done = collected.size;
      };

      const runAutoPdfBuildAndDownload = async (
        recordsToExport: TranslatedPageRecord[]
      ): Promise<{ autoDownloaded: boolean; autoDownloadFileName?: string }> => {
        const shouldAutoDownload =
          autoDownloadAfterFastRef.current &&
          (Boolean(options.autoDownloadPdfOptions) || activeTabRef.current === 'export');

        if (!shouldAutoDownload) {
          return { autoDownloaded: false };
        }

        // Pull latest layout options so mid-translation toggles (Cover / Figures / Subheader) are honored
        const pdfOpts = exportPdfOptionsRef.current;

        // If recordsToExport came back empty, double-check IndexedDB for any saved pages in this range
        let finalRecords = recordsToExport;
        if (finalRecords.length === 0) {
          const reloaded = await Promise.all(
            allPages.map((p) => getTranslation(book.id, lang, p))
          );
          finalRecords = reloaded
            .filter((r): r is TranslatedPageRecord => Boolean(r))
            .sort((a, b) => a.pageNumber - b.pageNumber);
        }

        if (finalRecords.length === 0) {
          setAutoPdfError(
            'Translation finished with 0 exportable pages, so the PDF could not be generated.'
          );
          return { autoDownloaded: false };
        }

        setAutoPdfError(null);
        setAutoPdfBuildProgress({
          current: 0,
          total: finalRecords.length + (pdfOpts.includeCover ? 1 : 0),
          status: 'Building converted PDF for automatic download…',
        });
        try {
          const result = await exportTranslatedPdf({
            pdf,
            book,
            pages: finalRecords,
            lang,
            includeCover: pdfOpts.includeCover,
            includeFigures: pdfOpts.includeFigures,
            includeOriginalSubheader: pdfOpts.includeOriginalSubheader,
            onProgress: (current, total, status) => {
              setAutoPdfBuildProgress({ current, total, status });
            },
          });

          const isTabVisible =
            typeof document === 'undefined' || document.visibilityState === 'visible';
          const readyUrl = setReadyAutoPdfSafe({
            blob: result.blob,
            fileName: result.fileName,
            exportedPageCount: result.exportedPageCount,
            includeCover: pdfOpts.includeCover,
            waitingForFocus: !isTabVisible,
          });

          if (readyUrl) {
            if (isTabVisible) {
              triggerBlobUrlDownload(readyUrl, result.fileName);
            } else {
              // Tab is backgrounded: still attempt immediate trigger AND guarantee download when user returns to tab
              pendingVisibilityDownloadRef.current = {
                url: readyUrl,
                fileName: result.fileName,
              };
              triggerBlobUrlDownload(readyUrl, result.fileName);
            }
          } else {
            downloadBlob(result.blob, result.fileName);
          }

          return { autoDownloaded: true, autoDownloadFileName: result.fileName };
        } catch (pdfErr) {
          const msg =
            pdfErr instanceof Error
              ? pdfErr.message
              : 'Auto-download PDF generation encountered an error.';
          logDevError('app', pdfErr, 'Auto-download converted PDF');
          setAutoPdfError(msg);
          return { autoDownloaded: false };
        } finally {
          setAutoPdfBuildProgress(null);
        }
      };

      if (missingPages.length === 0) {
        try {
          const sortedAll = Array.from(collected.values()).sort(
            (a, b) => a.pageNumber - b.pageNumber
          );
          commitSavedBatchToState(sortedAll);
          const autoRes = await runAutoPdfBuildAndDownload(sortedAll);
          return {
            records: sortedAll,
            cancelled: false,
            autoDownloaded: autoRes.autoDownloaded,
            autoDownloadFileName: autoRes.autoDownloadFileName,
          };
        } finally {
          document.removeEventListener('visibilitychange', handleVisibilityWake);
          releaseWakeLock();
          batchAbortRef.current = null;
          batchInFlightRef.current = false;
        }
      }

      pushProgress(missingPages[0]);

      try {
        if (activeEngine === 'free') {
          // Helper to translate a single page with escalating retries (never halts the whole book)
          const translateSinglePageWithRetries = async (
            parsed: ParsedPage,
            maxAttempts = 4
          ): Promise<boolean> => {
            const retryDelays = [1800, 3800, 7000, 11000];
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
              if (batchCancelRef.current) return false;
              await waitUntilOnline(parsed.pageNumber);
              if (batchCancelRef.current) return false;

              if (attempt > 0) {
                const delay = retryDelays[attempt - 1] ?? 5000;
                pushProgress(
                  parsed.pageNumber,
                  `Retrying Page ${parsed.pageNumber} (${attempt + 1}/${maxAttempts}) after ${Math.round(
                    delay / 1000
                  )}s cooldown…`
                );
                await waitWithCancel(delay);
                if (batchCancelRef.current) return false;
              }

              try {
                const { records, failedPages } = await translatePagesBatchFast({
                  bookId: book.id,
                  parsedPages: [parsed],
                  targetLang: lang,
                  preserveTerms,
                  customTerms,
                  signal: controller.signal,
                });
                if (records.length > 0) {
                  await persistBatchRecords(records);
                  pushProgress(parsed.pageNumber);
                  return true;
                }
                if (failedPages.length === 0) {
                  return true;
                }
              } catch (err) {
                if (batchCancelRef.current) return false;
                if (err instanceof DOMException && err.name === 'AbortError' && controller.signal.aborted) {
                  return false;
                }
              }
            }
            return false;
          };

          // Fast 6-page wave size with short pacing runs smoothly and rapidly across large books
          const WAVE_SIZE = 6;
          const deferredFailed: ParsedPage[] = [];

          for (let offset = 0; offset < missingPages.length; offset += WAVE_SIZE) {
            if (batchCancelRef.current) break;
            const waveNums = missingPages.slice(offset, offset + WAVE_SIZE);
            pushProgress(waveNums[0]);

            const parsedWave = await Promise.all(waveNums.map((pNum) => loadParsedPageSafe(pNum)));
            if (batchCancelRef.current) break;

            let waveSucceeded = false;
            let partialFailedNums: number[] = [];
            const waveRetryDelays = [2200, 5000];

            for (let attempt = 0; attempt < 3; attempt++) {
              if (batchCancelRef.current) break;
              await waitUntilOnline(waveNums[0]);
              if (batchCancelRef.current) break;

              if (attempt > 0) {
                const delay = waveRetryDelays[attempt - 1] ?? 4000;
                pushProgress(
                  waveNums[0],
                  `Rate-limit cooldown (${Math.round(delay / 1000)}s) — continuing automatically…`
                );
                await waitWithCancel(delay);
                if (batchCancelRef.current) break;
              }

              try {
                const { records, failedPages } = await translatePagesBatchFast({
                  bookId: book.id,
                  parsedPages: parsedWave,
                  targetLang: lang,
                  preserveTerms,
                  customTerms,
                  signal: controller.signal,
                });
                if (records.length > 0) {
                  await persistBatchRecords(records);
                }
                partialFailedNums = failedPages;
                waveSucceeded = true;
                break;
              } catch (err) {
                if (batchCancelRef.current) break;
                if (err instanceof DOMException && err.name === 'AbortError' && controller.signal.aborted) {
                  break;
                }
              }
            }

            if (batchCancelRef.current) break;

            // If wave partially or completely failed, isolate and recover page-by-page immediately
            const pagesNeedingRecovery = waveSucceeded
              ? parsedWave.filter((p) => partialFailedNums.includes(p.pageNumber))
              : parsedWave.filter((p) => !collected.has(p.pageNumber));

            for (const singleParsed of pagesNeedingRecovery) {
              if (batchCancelRef.current) break;
              const ok = await translateSinglePageWithRetries(singleParsed, 3);
              if (!ok && !batchCancelRef.current) {
                deferredFailed.push(singleParsed);
              }
            }

            pushProgress(waveNums[waveNums.length - 1]);

            // Gentle breather between waves keeps free translation endpoints happy for 200+ consecutive pages
            if (offset + WAVE_SIZE < missingPages.length && !batchCancelRef.current) {
              await waitWithCancel(120);
            }
          }

          // Automatic end-of-book recovery sweep for any pages that hit temporary network drops
          let remainingToRecover = deferredFailed.filter((p) => !collected.has(p.pageNumber));
          for (let pass = 1; pass <= 2 && remainingToRecover.length > 0 && !batchCancelRef.current; pass++) {
            pushProgress(
              remainingToRecover[0].pageNumber,
              `Auto-recovering ${remainingToRecover.length} remaining ${
                remainingToRecover.length === 1 ? 'page' : 'pages'
              } (pass ${pass}/2)…`
            );
            await waitWithCancel(5000);
            const stillFailed: ParsedPage[] = [];
            for (const parsed of remainingToRecover) {
              if (batchCancelRef.current) break;
              const ok = await translateSinglePageWithRetries(parsed, 4);
              if (!ok && !batchCancelRef.current) {
                stillFailed.push(parsed);
              }
            }
            remainingToRecover = stillFailed;
          }

          // Final safeguard: if a page is still unreachable after all retries, save original fallback blocks so export can still reach 100%
          if (remainingToRecover.length > 0 && !batchCancelRef.current) {
            const fallbackRecords: TranslatedPageRecord[] = remainingToRecover.map((p) => ({
              key: makeTranslationKey(book.id, lang, p.pageNumber),
              bookId: book.id,
              pageNumber: p.pageNumber,
              lang,
              engine: 'free',
              blocks: p.blocks.map((b) => ({ ...b, translatedText: b.text })),
              figures: p.figures,
              imageExplanations: [],
              updatedAt: Date.now(),
            }));
            await persistBatchRecords(fallbackRecords);
          }
        } else {
          // Smart AI Engine: 3-way parallel worker pool with per-page retries & immediate IndexedDB auto-save
          let cursor = 0;
          const workerCount = Math.min(3, missingPages.length);
          const aiFailedPages: number[] = [];

          const runAiPageWithRetry = async (pNum: number, maxAttempts = 3): Promise<boolean> => {
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
              if (batchCancelRef.current) return false;
              await waitUntilOnline(pNum);
              if (attempt > 0) {
                const delay = attempt * 3000;
                pushProgress(
                  pNum,
                  `Retrying AI Page ${pNum} (${attempt + 1}/${maxAttempts})…`
                );
                await waitWithCancel(delay);
                if (batchCancelRef.current) return false;
              }
              try {
                const record = await translateSinglePageInternal(book, pdf, pNum, lang, false);
                collected.set(pNum, record);
                commitSavedTranslationToState(record);
                newlyTranslated++;
                done = collected.size;
                pushProgress(pNum);
                return true;
              } catch (err) {
                if (batchCancelRef.current) return false;
                // Surface immediate missing-API-key configuration errors without looping 200 times
                if (err instanceof Error && /GEMINI_API_KEY/i.test(err.message)) {
                  throw err;
                }
              }
            }
            return false;
          };

          await Promise.all(
            Array.from({ length: workerCount }, async () => {
              while (!batchCancelRef.current) {
                const idx = cursor++;
                if (idx >= missingPages.length) break;
                const pNum = missingPages[idx];
                const ok = await runAiPageWithRetry(pNum, 3);
                if (!ok && !batchCancelRef.current) {
                  aiFailedPages.push(pNum);
                }
              }
            })
          );

          // Recovery pass for any transient AI failures
          if (aiFailedPages.length > 0 && !batchCancelRef.current) {
            await waitWithCancel(4000);
            for (const pNum of aiFailedPages) {
              if (batchCancelRef.current) break;
              await runAiPageWithRetry(pNum, 2);
            }
          }

          // Final safeguard for Smart AI: save original fallback blocks for any page still unreachable so PDF export still completes at 100%
          const unresolvedAiPages = missingPages.filter((p) => !collected.has(p));
          if (unresolvedAiPages.length > 0 && !batchCancelRef.current) {
            const parsedFallbacks = await Promise.all(
              unresolvedAiPages.map((pNum) => loadParsedPageSafe(pNum))
            );
            const fallbackRecords: TranslatedPageRecord[] = parsedFallbacks.map((p) => ({
              key: makeTranslationKey(book.id, lang, p.pageNumber),
              bookId: book.id,
              pageNumber: p.pageNumber,
              lang,
              engine: 'ai',
              blocks: p.blocks.map((b) => ({ ...b, translatedText: b.text })),
              figures: p.figures,
              imageExplanations: [],
              updatedAt: Date.now(),
            }));
            await persistBatchRecords(fallbackRecords);
          }
        }

        const sortedRecords = Array.from(collected.values()).sort(
          (a, b) => a.pageNumber - b.pageNumber
        );
        const wasCancelled = batchCancelRef.current;

        // Clear translation progress before transitioning smoothly into PDF build & auto-download
        setBatchProgress(null);

        if (!wasCancelled) {
          const autoRes = await runAutoPdfBuildAndDownload(sortedRecords);
          return {
            records: sortedRecords,
            cancelled: false,
            autoDownloaded: autoRes.autoDownloaded,
            autoDownloadFileName: autoRes.autoDownloadFileName,
          };
        }

        return { records: sortedRecords, cancelled: true };
      } catch (err) {
        if (batchCancelRef.current || (err instanceof DOMException && err.name === 'AbortError')) {
          const sortedRecords = Array.from(collected.values()).sort(
            (a, b) => a.pageNumber - b.pageNumber
          );
          return { records: sortedRecords, cancelled: true };
        }
        logDevError('app', err, `Batch fast translate (${options.label ?? 'range'})`);
        setTranslationError(
          err instanceof Error
            ? `Fast translation paused: ${err.message}`
            : 'Fast translation stopped due to an error.'
        );
        throw err;
      } finally {
        document.removeEventListener('visibilitychange', handleVisibilityWake);
        releaseWakeLock();
        batchAbortRef.current = null;
        batchInFlightRef.current = false;
        setBatchProgress(null);
      }
    },
    [
      activeBook,
      loadedPdf,
      targetLang,
      engine,
      preserveTerms,
      customTerms,
      commitSavedBatchToState,
      commitSavedTranslationToState,
      ensureCleanParsedPage,
      translateSinglePageInternal,
      setReadyAutoPdfSafe,
    ]
  );

  // Batch translate an entire chapter using the fast parallel engine
  const handleTranslateChapter = useCallback(
    async (chapter: ChapterItem) => {
      try {
        await handleFastTranslateRange({
          startPage: chapter.startPage,
          endPage: chapter.endPage,
          label: chapter.title,
        });
      } catch {
        // Error banner already updated in handleFastTranslateRange
      }
    },
    [handleFastTranslateRange]
  );

  // Clear any unsaved OCR verification panel when switching books or pages
  useEffect(() => {
    setPendingOcrReview(null);
  }, [activeBook?.id, currentPage]);

  // Run multilingual OCR (AI Vision first when online, Tesseract fallback) on current page and stage for review
  const handleRunOcr = async (opts?: { highRes?: boolean }) => {
    if (!activeBook || !loadedPdf || isRunningOcr) return;
    const targetPage = currentPage;
    const bookIdAtStart = activeBook.id;
    const dpiScale = opts?.highRes ? 2.6 : 2.0;
    const baseOriginal =
      pendingOcrReview && pendingOcrReview.pageNumber === targetPage
        ? pendingOcrReview.originalPage
        : parsedPage;
    const prevRunCount =
      pendingOcrReview && pendingOcrReview.pageNumber === targetPage
        ? pendingOcrReview.runCount
        : 0;

    setIsRunningOcr(true);
    setOcrProgress(4);
    setOcrStage('Preparing page for multilingual OCR…');
    setTranslationError(null);
    try {
      const ocrParsed = await runClientOcrOnPage(
        loadedPdf,
        targetPage,
        ({ progress, stage }) => {
          setOcrProgress(progress);
          setOcrStage(stage);
        },
        {
          scale: dpiScale,
          scriptMode: ocrScriptModeRef.current,
          preferAiVision: aiAvailableRef.current,
        }
      );
      const mergedOcrPage: ParsedPage = {
        ...ocrParsed,
        figures: baseOriginal?.figures ?? ocrParsed.figures,
      };
      if (activeBookIdRef.current === bookIdAtStart && currentPageRef.current === targetPage) {
        setPendingOcrReview({
          pageNumber: targetPage,
          originalPage: baseOriginal,
          ocrPage: mergedOcrPage,
          runCount: prevRunCount + 1,
          dpiScale,
          completedAt: Date.now(),
        });
        const engineLabel =
          mergedOcrPage.ocrEngine === 'ai-vision' ? 'AI Vision OCR' : 'Offline OCR';
        const langTag = mergedOcrPage.detectedLang ? ` · ${mergedOcrPage.detectedLang}` : '';
        setAppBanner(
          `${engineLabel} pass #${prevRunCount + 1} ready for Page ${targetPage} (${mergedOcrPage.blocks.length} blocks${langTag}). Verify against the PDF before saving.`
        );
      }
    } catch (err) {
      logDevError('app', err, `OCR pass on page ${targetPage}`);
      setAppBanner(err instanceof Error ? `OCR failed: ${err.message}` : 'OCR failed.');
    } finally {
      setIsRunningOcr(false);
      setOcrStage('');
    }
  };

  const handleSaveOcrReview = async () => {
    if (!activeBook || !pendingOcrReview) return;
    const savedPage = pendingOcrReview.ocrPage;
    await saveParsedPage(activeBook.id, savedPage);
    setParsedPage(savedPage);
    setPendingOcrReview(null);
    const hadTranslationOnPage = translatedPage?.pageNumber === savedPage.pageNumber;
    if (hadTranslationOnPage || targetLang === 'orig') {
      setTranslatedPage(null);
      setAppBanner(
        `Saved ${savedPage.detectedLang || 'book'} text for Page ${savedPage.pageNumber}. Refreshing reader view…`
      );
      void handleTranslateCurrentPage(true);
    } else {
      setAppBanner(
        `Saved ${savedPage.detectedLang || 'OCR'} text for Page ${savedPage.pageNumber} (${savedPage.blocks.length} blocks). Click Translate to translate this exact text.`
      );
    }
  };

  const handleKeepOriginalOcr = () => {
    if (!pendingOcrReview) return;
    const pg = pendingOcrReview.pageNumber;
    setPendingOcrReview(null);
    setAppBanner(`Kept original extracted text for Page ${pg}.`);
  };

  // Inline edit of a translated block -> persists to IndexedDB immediately and re-anchors any text highlights
  const handleUpdateBlockText = async (blockId: string, newText: string) => {
    if (!translatedPage || !activeBook) return;
    const reanchoredHighlights = (translatedPage.highlights ?? []).reduce<TextHighlight[]>(
      (acc, hl) => {
        if (hl.blockId !== blockId) {
          acc.push(hl);
          return acc;
        }
        const newStart = newText.indexOf(hl.selectedText);
        if (newStart >= 0) {
          acc.push({
            ...hl,
            startOffset: newStart,
            endOffset: newStart + hl.selectedText.length,
          });
        }
        return acc;
      },
      []
    );
    const updated: TranslatedPageRecord = {
      ...translatedPage,
      blocks: translatedPage.blocks.map((b) =>
        b.id === blockId ? { ...b, translatedText: newText } : b
      ),
      highlights: reanchoredHighlights,
      updatedAt: Date.now(),
    };
    setTranslatedPage(updated);
    await saveTranslation(updated);
    setBookTranslations((prev) =>
      prev.map((r) => (r.pageNumber === updated.pageNumber ? updated : r))
    );
  };

  // Persist text selection highlights and attached notes on the active translated page
  const handleUpdatePageHighlights = useCallback(
    async (nextHighlights: TextHighlight[]) => {
      if (!translatedPage || !activeBook) return;
      const updated: TranslatedPageRecord = {
        ...translatedPage,
        highlights: nextHighlights,
        updatedAt: Date.now(),
      };
      setTranslatedPage(updated);
      await saveTranslation(updated);
      setBookTranslations((prev) =>
        prev.map((r) => (r.pageNumber === updated.pageNumber ? updated : r))
      );
    },
    [translatedPage, activeBook]
  );

  // Derived active chapter & sentence spans
  const currentChapter = useMemo(() => {
    if (!activeBook) return null;
    return (
      activeBook.chapters.find(
        (ch) => currentPage >= ch.startPage && currentPage <= ch.endPage
      ) ?? null
    );
  }, [activeBook, currentPage]);

  const translatedPageNumbers = useMemo(
    () => new Set(bookTranslations.map((r) => r.pageNumber)),
    [bookTranslations]
  );

  // Word counts per translated page in the current chapter for accurate chapter duration & seeking
  const chapterPageWordCounts = useMemo<Record<number, number>>(() => {
    const counts: Record<number, number> = {};
    const startP = currentChapter ? currentChapter.startPage : currentPage;
    const endP = currentChapter ? currentChapter.endPage : currentPage;
    for (const rec of bookTranslations) {
      if (rec.pageNumber < startP || rec.pageNumber > endP) continue;
      let words = 0;
      for (const blk of rec.blocks) {
        const txt = (narrationSource === 'original' ? blk.text : blk.translatedText || blk.text).trim();
        if (txt) {
          words += countReadableWords(txt);
        }
      }
      if (words > 0) {
        counts[rec.pageNumber] = words;
      }
    }
    return counts;
  }, [bookTranslations, currentChapter, currentPage, narrationSource]);

  // All known page word counts across the active book (translated pages + current parsed page)
  const allBookPageWordCounts = useMemo<Record<number, number>>(() => {
    const counts: Record<number, number> = {};
    for (const rec of bookTranslations) {
      let words = 0;
      for (const blk of rec.blocks) {
        const txt = (narrationSource === 'original' ? blk.text : blk.translatedText || blk.text).trim();
        if (txt) {
          words += countReadableWords(txt);
        }
      }
      if (words > 0) {
        counts[rec.pageNumber] = words;
      }
    }
    const currentPageWords = countPageWords(
      parsedPage && parsedPage.pageNumber === currentPage ? parsedPage : null,
      translatedPage && translatedPage.pageNumber === currentPage ? translatedPage : null,
      narrationSource === 'original'
    );
    if (currentPageWords > 0) {
      counts[currentPage] = currentPageWords;
    }
    return counts;
  }, [bookTranslations, parsedPage, translatedPage, currentPage, narrationSource]);

  const bookFallbackWordsPerPage = useMemo(() => {
    const values = Object.values(allBookPageWordCounts).filter((w) => w >= 20);
    if (values.length >= 2) {
      const sum = values.reduce((acc, val) => acc + val, 0);
      return Math.max(80, Math.round(sum / values.length));
    }
    return readingSpeed.avgWordsPerPage;
  }, [allBookPageWordCounts, readingSpeed.avgWordsPerPage]);

  const chapterReadingEstimate = useMemo<ChapterReadingEstimate | null>(
    () =>
      estimateChapterFinishTime({
        chapter: currentChapter,
        currentPage,
        wpm: readingSpeed.averageWpm,
        knownPageWordCounts: allBookPageWordCounts,
        fallbackWordsPerPage: bookFallbackWordsPerPage,
      }),
    [
      currentChapter,
      currentPage,
      readingSpeed.averageWpm,
      allBookPageWordCounts,
      bookFallbackWordsPerPage,
    ]
  );

  const handleResetReadingSpeed = useCallback(() => {
    setReadingSpeed(resetReadingSpeedHistory());
  }, []);

  // Page-turning reading speed tracker (visibility-aware, pauses when tabbed away or listening to TTS)
  const pageReadSessionRef = useRef<{
    bookId: string;
    pageNumber: number;
    accumulatedMs: number;
    resumedAt: number | null;
    wordCount: number;
  } | null>(null);

  // Keep current page's word count synced as soon as parsed/translated content arrives
  useEffect(() => {
    const session = pageReadSessionRef.current;
    if (!session || session.bookId !== activeBookId || session.pageNumber !== currentPage) return;
    const words = countPageWords(
      parsedPage && parsedPage.pageNumber === currentPage ? parsedPage : null,
      translatedPage && translatedPage.pageNumber === currentPage ? translatedPage : null,
      narrationSource === 'original'
    );
    if (words > 0) {
      session.wordCount = words;
    }
  }, [activeBookId, currentPage, parsedPage, translatedPage, narrationSource]);

  // Pause/resume active page timer on tab visibility, window focus, or audiobook speech
  useEffect(() => {
    const pauseSession = () => {
      const session = pageReadSessionRef.current;
      if (session && session.resumedAt !== null) {
        session.accumulatedMs += Math.max(0, Date.now() - session.resumedAt);
        session.resumedAt = null;
      }
    };
    const resumeSession = () => {
      const session = pageReadSessionRef.current;
      if (
        session &&
        session.resumedAt === null &&
        activeTab === 'reader' &&
        !isSpeaking &&
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible'
      ) {
        session.resumedAt = Date.now();
      }
    };

    if (activeTab !== 'reader' || isSpeaking) {
      pauseSession();
    } else {
      resumeSession();
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        resumeSession();
      } else {
        pauseSession();
      }
    };
    window.addEventListener('blur', pauseSession);
    window.addEventListener('focus', resumeSession);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', pauseSession);
      window.removeEventListener('focus', resumeSession);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [activeTab, isSpeaking]);

  // Commit completed page turn whenever the user turns to a new page or leaves the reader
  useEffect(() => {
    const finalizePrevious = () => {
      const prev = pageReadSessionRef.current;
      if (!prev) return;
      const totalMs =
        prev.accumulatedMs + (prev.resumedAt !== null ? Math.max(0, Date.now() - prev.resumedAt) : 0);
      pageReadSessionRef.current = null;
      if (prev.wordCount >= 20 && totalMs >= 5000) {
        const snapshot = recordPageTurnSample({
          bookId: prev.bookId,
          pageNumber: prev.pageNumber,
          wordCount: prev.wordCount,
          durationSeconds: totalMs / 1000,
        });
        setReadingSpeed(snapshot);
      }
    };

    if (activeTab !== 'reader' || !activeBookId) {
      finalizePrevious();
      return;
    }

    const prev = pageReadSessionRef.current;
    if (prev && (prev.bookId !== activeBookId || prev.pageNumber !== currentPage)) {
      finalizePrevious();
    }

    if (
      !pageReadSessionRef.current ||
      pageReadSessionRef.current.bookId !== activeBookId ||
      pageReadSessionRef.current.pageNumber !== currentPage
    ) {
      const initialWords = countPageWords(
        parsedPage && parsedPage.pageNumber === currentPage ? parsedPage : null,
        translatedPage && translatedPage.pageNumber === currentPage ? translatedPage : null,
        narrationSource === 'original'
      );
      const isVisible =
        typeof document === 'undefined' || document.visibilityState === 'visible';
      pageReadSessionRef.current = {
        bookId: activeBookId,
        pageNumber: currentPage,
        accumulatedMs: 0,
        resumedAt: !isSpeaking && isVisible ? Date.now() : null,
        wordCount: initialWords,
      };
    }
  }, [activeTab, activeBookId, currentPage]);

  const sentences = useMemo(() => {
    if (narrationSource === 'original') {
      if (!parsedPage) return [];
      return splitBlocksIntoSentences(
        parsedPage.blocks.map((b) => ({ ...b, translatedText: b.text })),
        []
      );
    }
    if (!translatedPage) return [];
    return splitBlocksIntoSentences(
      translatedPage.blocks,
      translatedPage.imageExplanations
    );
  }, [narrationSource, parsedPage, translatedPage]);

  // Continuously save exact audio listening position (page, sentence, source, language) to Library record
  useEffect(() => {
    if (!activeBookId || activeSentenceIndex === null) return;
    let cancelled = false;
    updateBookProgress(activeBookId, {
      lastPage: currentPage,
      lastAudioPage: currentPage,
      lastSentenceIndex: activeSentenceIndex,
      lastNarrationSource: narrationSource,
      lastTargetLang: targetLang,
      lastOpenedAt: Date.now(),
    })
      .then((updated) => {
        if (!cancelled && updated) {
          syncUpdatedBookInState(updated, false);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    activeBookId,
    currentPage,
    activeSentenceIndex,
    narrationSource,
    targetLang,
    syncUpdatedBookInState,
  ]);

  // Execute queued Translate or Listen (with exact sentence resume) right after opening a book from Discover or Library
  useEffect(() => {
    if (!pendingPostLoadAction || !activeBook || !loadedPdf) return;
    if (activeBook.id !== pendingPostLoadAction.bookId) return;
    if (
      pendingPostLoadAction.targetPage !== undefined &&
      currentPage !== pendingPostLoadAction.targetPage
    ) {
      return;
    }
    if (!parsedPage || parsedPage.pageNumber !== currentPage) return;

    const { action, sentenceIndex = 0, narrationSource: preferredSource } = pendingPostLoadAction;
    setPendingPostLoadAction(null);

    if (action === 'translate') {
      if (!translatedPage) {
        handleTranslateCurrentPage(false);
      }
    } else if (action === 'listen') {
      const hasCurrentTranslation = Boolean(
        translatedPage && translatedPage.pageNumber === currentPage
      );
      if (preferredSource === 'original') {
        setNarrationSource('original');
        setTimeout(
          () => audiobookControlRef.current?.playFromSentence(sentenceIndex, currentPage),
          80
        );
      } else if (hasCurrentTranslation) {
        setNarrationSource('translated');
        setTimeout(
          () => audiobookControlRef.current?.playFromSentence(sentenceIndex, currentPage),
          80
        );
      } else if (preferredSource === 'translated' && isOnline && !parsedPage.isBlank) {
        setNarrationSource('translated');
        setTimeout(
          () => audiobookControlRef.current?.playFromSentence(sentenceIndex, currentPage),
          100
        );
      } else if (!parsedPage.isBlank) {
        setNarrationSource('original');
        setTimeout(
          () => audiobookControlRef.current?.playFromSentence(sentenceIndex, currentPage),
          120
        );
      }
    }
  }, [
    pendingPostLoadAction,
    activeBook,
    loadedPdf,
    parsedPage,
    translatedPage,
    currentPage,
    isOnline,
    handleTranslateCurrentPage,
  ]);

  // Audiobook lookahead: auto-translate & auto-save next page when narration approaches the last 2 sentences
  useEffect(() => {
    if (
      !autoPreloadNext ||
      !isSpeaking ||
      activeSentenceIndex === null ||
      sentences.length === 0 ||
      !activeBook ||
      currentPage >= activeBook.numPages
    ) {
      return;
    }
    if (activeSentenceIndex >= Math.max(0, sentences.length - 2)) {
      prefetchNextPage(currentPage + 1);
    }
  }, [
    autoPreloadNext,
    isSpeaking,
    activeSentenceIndex,
    sentences.length,
    activeBook,
    currentPage,
    prefetchNextPage,
  ]);

  const nextPageStatus = useMemo<NextPagePrefetchStatus>(() => {
    if (!activeBook || currentPage >= activeBook.numPages) return 'idle';
    const nextNum = currentPage + 1;
    if (translatedPageNumbers.has(nextNum)) return 'saved';
    const nextKey = makeTranslationKey(activeBook.id, targetLang, nextNum);
    if (inFlightKeys.has(nextKey)) return 'translating';
    if (prefetchErrorKeys.has(nextKey)) return 'error';
    return 'idle';
  }, [
    activeBook,
    currentPage,
    targetLang,
    translatedPageNumbers,
    inFlightKeys,
    prefetchErrorKeys,
  ]);

  const handleClickSentence = (idx: number) => {
    audiobookControlRef.current?.unlockAudio();
    setJumpRequest({ index: idx, nonce: Date.now() });
  };

  const handleAdvancePageFromAudio = () => {
    if (!activeBook || currentPage >= activeBook.numPages) return;
    setCurrentPage((p) => Math.min(activeBook.numPages, p + 1));
  };

  const handleGoToNextPage = useCallback(() => {
    if (!activeBook || currentPage >= activeBook.numPages) return;
    setCurrentPage((p) => Math.min(activeBook.numPages, p + 1));
  }, [activeBook, currentPage]);

  // Aggregate all saved text highlights across the active book for the Share Highlights Studio
  const allBookShareHighlights = useMemo<ShareQuotePayload[]>(() => {
    if (!activeBook) return [];
    const list: ShareQuotePayload[] = [];
    const sortedPages = [...bookTranslations].sort((a, b) => a.pageNumber - b.pageNumber);
    for (const pg of sortedPages) {
      const ch = activeBook.chapters.find(
        (c) => pg.pageNumber >= c.startPage && pg.pageNumber <= c.endPage
      );
      for (const hl of pg.highlights ?? []) {
        list.push({
          id: hl.id,
          quoteText: hl.selectedText,
          note: hl.note,
          bookTitle: activeBook.title,
          author: activeBook.author,
          pageNumber: pg.pageNumber,
          chapterTitle: ch?.title,
          lang: pg.lang,
          coverDataUrl: activeBook.coverDataUrl,
          highlightColor: hl.color,
        });
      }
    }
    return list;
  }, [activeBook, bookTranslations]);

  const handleShareQuoteFromReader = useCallback(
    (draft: {
      id?: string;
      quoteText: string;
      note?: string;
      highlightColor?: TextHighlightColor;
    }) => {
      if (!activeBook) return;
      setShareModalPayload({
        id: draft.id,
        quoteText: draft.quoteText,
        note: draft.note,
        bookTitle: activeBook.title,
        author: activeBook.author,
        pageNumber: currentPage,
        chapterTitle: currentChapter?.title,
        lang: targetLang,
        coverDataUrl: activeBook.coverDataUrl,
        highlightColor: draft.highlightColor,
      });
    },
    [activeBook, currentPage, currentChapter, targetLang]
  );

  const handleOpenShareStudio = useCallback(() => {
    if (!activeBook) return;
    // Prefer latest highlight on current page, then any saved book highlight, then first paragraph on current page
    const pageHls = translatedPage?.highlights ?? [];
    if (pageHls.length > 0) {
      const latest = pageHls[pageHls.length - 1];
      handleShareQuoteFromReader({
        id: latest.id,
        quoteText: latest.selectedText,
        note: latest.note,
        highlightColor: latest.color,
      });
      return;
    }
    if (allBookShareHighlights.length > 0) {
      setShareModalPayload(allBookShareHighlights[allBookShareHighlights.length - 1]);
      return;
    }
    const sampleBlock =
      translatedPage?.blocks.find(
        (b) => (b.kind === 'paragraph' || b.kind === 'callout') && (b.translatedText || b.text).trim().length > 24
      ) ?? translatedPage?.blocks[0];
    const fallbackText = (sampleBlock?.translatedText || sampleBlock?.text || '').trim().slice(0, 280);
    handleShareQuoteFromReader({
      quoteText: fallbackText || `Reading "${activeBook.title}" on Page ${currentPage}.`,
      highlightColor: 'amber',
    });
  }, [activeBook, translatedPage, allBookShareHighlights, currentPage, handleShareQuoteFromReader]);

  // Play or pause audio directly from any chapter's audio button in the Chapter List
  const handlePlayChapterAudio = useCallback(
    (chapter: ChapterItem) => {
      const ctrl = audiobookControlRef.current;
      const isInThisChapter =
        currentPage >= chapter.startPage && currentPage <= chapter.endPage;

      if (isInThisChapter && isSpeaking) {
        ctrl?.pausePlayback();
        return;
      }

      // Unlock mobile audio synchronously inside the click gesture
      ctrl?.unlockAudio();

      if (isInThisChapter) {
        ctrl?.playCurrentPage();
      } else {
        ctrl?.queueChapterPlayback(chapter.startPage, chapter.endPage, chapter.title);
        setCurrentPage(chapter.startPage);
      }
    },
    [currentPage, isSpeaking]
  );

  const langOption = getLanguageOption(targetLang);
  const isCurrentPageBookmarked =
    Array.isArray(activeBook?.bookmarks) && activeBook.bookmarks.includes(currentPage);

  const cycleTheme = () => {
    setReadingTheme((curr) =>
      curr === 'light' ? 'sepia' : curr === 'sepia' ? 'dark' : 'light'
    );
  };

  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden flex flex-col bg-[#FAF9F5] sepia:bg-[#F4ECD8] dark:bg-[#090908] text-stone-900 sepia:text-[#3B2F23] dark:text-stone-100">
      {/* Top 3-Zone Navigation Bar */}
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onUploadPdf={handleUploadPdf}
        isUploading={isUploading}
      />

      {/* Offline Mode Connectivity Bar */}
      {!isOnline && (
        <div
          role="status"
          className="no-print px-4 py-2 text-xs bg-amber-50 sepia:bg-[#ECE2CA] dark:bg-[#1E1A14] border-b border-amber-200/80 sepia:border-[#D4C6AA] dark:border-amber-900/50 text-amber-950 sepia:text-[#3B2F23] dark:text-amber-200 flex flex-wrap items-center justify-between gap-2"
        >
          <div className="flex items-center gap-2 min-w-0">
            <WifiOff className="w-3.5 h-3.5 text-amber-700 dark:text-amber-400 shrink-0" />
            <span>
              You are offline. Cached PDFs, saved translations, and device-voice narration in My
              Library remain fully available.
            </span>
          </div>
          {activeTab !== 'library' && activeTab !== 'reader' && (
            <button
              type="button"
              onClick={() => setActiveTab('library')}
              className="h-7 px-2.5 rounded border border-amber-700/40 dark:border-amber-500/40 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] text-xs font-medium text-amber-900 dark:text-amber-300 hover:bg-amber-100/60 dark:hover:bg-amber-950/40 cursor-pointer whitespace-nowrap"
            >
              Open My Library
            </button>
          )}
        </div>
      )}

      {/* Reader Workspace Utility Bar */}
      {activeTab === 'reader' && (
        <div className="no-print w-full border-b border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-[#F5F3EE] sepia:bg-[#ECE2CA] dark:bg-[#141312]">
          <div className="w-full max-w-[1680px] mx-auto px-2.5 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2">
            {/* Left controls: Sidebar toggle + Language + Engine */}
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 min-w-0 max-w-full">
              <button
                type="button"
                onClick={() => {
                  if (window.innerWidth < 1024) {
                    setMobileChaptersOpen(true);
                  } else {
                    setSidebarOpen((v) => !v);
                  }
                }}
                aria-label="Toggle chapters panel"
                className="inline-flex items-center gap-1.5 h-8 px-2 sm:px-2.5 rounded border border-stone-300 dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#1F1E1B] text-xs font-medium text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer whitespace-nowrap shrink-0"
              >
                <PanelLeft className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Chapters</span>
              </button>

              {/* Target Language Selector */}
              <div className="inline-flex items-center gap-1.5 min-w-0">
                <Languages className="w-3.5 h-3.5 text-amber-700 dark:text-amber-500 hidden sm:block shrink-0" />
                <select
                  aria-label="Target translation language"
                  value={targetLang}
                  onChange={(e) => setTargetLang(e.target.value as LanguageCode)}
                  className="h-8 max-w-[136px] sm:max-w-none px-2 sm:px-2.5 rounded border border-stone-300 dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#1F1E1B] text-xs font-medium text-stone-900 dark:text-stone-100 focus:outline-none focus:border-amber-700 cursor-pointer truncate"
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.name} ({l.nativeName})
                    </option>
                  ))}
                </select>
              </div>

              {/* Engine & Style Selector (Free Open + AI Tutor + AI Faithful) */}
              <div className="inline-flex rounded border border-stone-300 dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#1F1E1B] p-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setEngine('free')}
                  className={`h-7 px-2 sm:px-2.5 rounded-sm text-[11px] sm:text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    engine === 'free'
                      ? 'bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-950'
                      : 'text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100'
                  }`}
                >
                  Free Open
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEngine('ai');
                    setTranslationStyle('tutor');
                  }}
                  title={
                    aiAvailable
                      ? 'Expert Translator & Tutor: explains complex concepts in simple conversational Hindi with everyday Indian examples'
                      : 'Requires GEMINI_API_KEY in Settings > Secrets'
                  }
                  className={`inline-flex items-center gap-1 h-7 px-2 sm:px-2.5 rounded-sm text-[11px] sm:text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    engine === 'ai' && translationStyle === 'tutor'
                      ? 'bg-amber-700 text-white'
                      : 'text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100'
                  }`}
                >
                  <GraduationCap className="w-3 h-3" />
                  <span>AI Tutor</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEngine('ai');
                    setTranslationStyle('faithful');
                  }}
                  title={
                    aiAvailable
                      ? 'Smart AI Faithful: strict sentence-for-sentence translation with diagram notes'
                      : 'Requires GEMINI_API_KEY in Settings > Secrets'
                  }
                  className={`inline-flex items-center gap-1 h-7 px-2 sm:px-2.5 rounded-sm text-[11px] sm:text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    engine === 'ai' && translationStyle === 'faithful'
                      ? 'bg-amber-700 text-white'
                      : 'text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100'
                  }`}
                >
                  <Sparkles className="w-3 h-3" />
                  <span className="hidden sm:inline">AI Literal</span>
                </button>
              </div>

              {/* Technical Term Preservation, Auto-Save Next Toggle & Custom Reading Preferences */}
              <div className="relative flex items-center gap-1.5">
                <label className="hidden md:inline-flex items-center gap-1.5 h-8 px-2.5 rounded border border-stone-300 dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#1F1E1B] text-xs text-stone-700 dark:text-stone-200 cursor-pointer select-none whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={preserveTerms}
                    onChange={(e) => setPreserveTerms(e.target.checked)}
                    className="rounded accent-amber-700"
                  />
                  <span>Keep Tech Terms</span>
                </label>

                <label
                  title="Automatically translate and save the next page in the background when you reach the end of the current page"
                  className="hidden xl:inline-flex items-center gap-1.5 h-8 px-2.5 rounded border border-stone-300 dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#1F1E1B] text-xs text-stone-700 dark:text-stone-200 cursor-pointer select-none whitespace-nowrap"
                >
                  <input
                    type="checkbox"
                    checked={autoPreloadNext}
                    onChange={(e) => setAutoPreloadNext(e.target.checked)}
                    className="rounded accent-amber-700"
                  />
                  <span>Auto-save next</span>
                </label>

                <button
                  type="button"
                  onClick={() => setShowGlossaryPopover((v) => !v)}
                  title="Reading theme, font size, spacing & glossary preferences"
                  className="h-8 w-8 inline-flex items-center justify-center rounded border border-stone-300 dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#1F1E1B] text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                </button>

                {showGlossaryPopover && (
                  <div className="fixed sm:absolute left-3 right-3 sm:left-0 sm:right-auto top-28 sm:top-10 z-40 sm:w-80 max-w-[calc(100vw-24px)] max-h-[75vh] overflow-y-auto p-4 rounded-lg border border-stone-200 dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#1C1B19] shadow-lg space-y-3.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-stone-900 dark:text-stone-100">
                        Reading &amp; Translation Preferences
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowGlossaryPopover(false)}
                        className="text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* 3-Mode Reading Theme Picker */}
                    <div className="space-y-1.5">
                      <span className="block text-[11px] font-medium text-stone-500 dark:text-stone-400">
                        Reading Theme
                      </span>
                      <div className="grid grid-cols-3 gap-1.5 text-xs font-medium">
                        {(
                          [
                            { id: 'light', label: 'Light' },
                            { id: 'sepia', label: 'Sepia Paper' },
                            { id: 'dark', label: 'OLED Dark' },
                          ] as const
                        ).map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => setReadingTheme(t.id)}
                            className={`h-8 rounded border transition-colors cursor-pointer ${
                              readingTheme === t.id
                                ? 'border-amber-700 bg-amber-700 text-white'
                                : 'border-stone-300 dark:border-stone-700 text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800'
                            }`}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Font Size & Line Spacing Sliders */}
                    <div className="grid grid-cols-2 gap-3 pt-1">
                      <label className="space-y-1 text-[11px] text-stone-600 dark:text-stone-400">
                        <div className="flex justify-between font-mono-num">
                          <span>Font Size</span>
                          <span>{readerFontSize}px</span>
                        </div>
                        <input
                          type="range"
                          min={13}
                          max={23}
                          step={1}
                          value={readerFontSize}
                          onChange={(e) => setReaderFontSize(parseInt(e.target.value, 10))}
                          className="w-full accent-amber-700 cursor-pointer"
                        />
                      </label>

                      <label className="space-y-1 text-[11px] text-stone-600 dark:text-stone-400">
                        <div className="flex justify-between font-mono-num">
                          <span>Line Space</span>
                          <span>{readerLineHeight.toFixed(2)}</span>
                        </div>
                        <input
                          type="range"
                          min={1.45}
                          max={2.25}
                          step={0.05}
                          value={readerLineHeight}
                          onChange={(e) => setReaderLineHeight(parseFloat(e.target.value))}
                          className="w-full accent-amber-700 cursor-pointer"
                        />
                      </label>
                    </div>

                    {/* AI Audiobook Voice Preference */}
                    <div className="pt-2 border-t border-stone-200 dark:border-stone-800 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium text-stone-500 dark:text-stone-400">
                          Voice Preference
                        </span>
                        <span className="text-[10px] text-stone-400 dark:text-stone-500">
                          AI Audiobook Style
                        </span>
                      </div>
                      <div
                        role="radiogroup"
                        aria-label="Audiobook AI voice style preference"
                        className="grid grid-cols-3 gap-1.5 text-xs font-medium"
                      >
                        {VOICE_STYLE_PREFERENCES.map((opt) => {
                          const isActive = voiceStylePreference === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              role="radio"
                              aria-checked={isActive}
                              onClick={() => setVoiceStylePreference(opt.id)}
                              className={`h-8 rounded border transition-colors cursor-pointer whitespace-nowrap ${
                                isActive
                                  ? 'border-amber-700 bg-amber-700 text-white'
                                  : 'border-stone-300 dark:border-stone-700 text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800'
                              }`}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                      <p className="text-[11px] leading-snug text-stone-500 dark:text-stone-400">
                        {getVoiceStylePreferenceOption(voiceStylePreference).description}
                      </p>
                    </div>

                    {/* AI Translator & Tutor Persona Settings */}
                    <div className="pt-2 border-t border-stone-200 dark:border-stone-800 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium text-stone-500 dark:text-stone-400">
                          AI Translation Style
                        </span>
                        <span className="text-[10px] text-amber-700 dark:text-amber-400 font-medium">
                          {translationStyle === 'tutor' ? 'Tutor + Examples' : 'Strict Literal'}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5 text-xs font-medium">
                        <button
                          type="button"
                          onClick={() => {
                            setEngine('ai');
                            setTranslationStyle('tutor');
                          }}
                          className={`h-8 rounded border transition-colors cursor-pointer ${
                            translationStyle === 'tutor'
                              ? 'border-amber-700 bg-amber-700 text-white'
                              : 'border-stone-300 dark:border-stone-700 text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800'
                          }`}
                        >
                          Expert Tutor
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEngine('ai');
                            setTranslationStyle('faithful');
                          }}
                          className={`h-8 rounded border transition-colors cursor-pointer ${
                            translationStyle === 'faithful'
                              ? 'border-amber-700 bg-amber-700 text-white'
                              : 'border-stone-300 dark:border-stone-700 text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800'
                          }`}
                        >
                          Faithful Literal
                        </button>
                      </div>
                      {translationStyle === 'tutor' && (
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <label
                              htmlFor="tutor-prompt-input"
                              className="text-[11px] text-stone-500 dark:text-stone-400"
                            >
                              Tutor Instruction
                            </label>
                            {tutorPrompt.trim() !== DEFAULT_TUTOR_PROMPT && (
                              <button
                                type="button"
                                onClick={() => setTutorPrompt(DEFAULT_TUTOR_PROMPT)}
                                className="text-[10px] text-amber-700 dark:text-amber-400 hover:underline cursor-pointer"
                              >
                                Reset default
                              </button>
                            )}
                          </div>
                          <textarea
                            id="tutor-prompt-input"
                            rows={3}
                            value={tutorPrompt}
                            onChange={(e) => setTutorPrompt(e.target.value)}
                            className="w-full p-2 text-[11px] leading-relaxed rounded border border-stone-300 dark:border-stone-700 bg-[#FAF9F5] dark:bg-[#141312] text-stone-900 dark:text-stone-100 focus:outline-none focus:border-amber-700"
                          />
                        </div>
                      )}
                      {activeBook && loadedPdf && (
                        <button
                          type="button"
                          onClick={() => {
                            setShowGlossaryPopover(false);
                            void handleTranslateCurrentPage(true);
                          }}
                          disabled={isTranslatingPage}
                          className="w-full h-8 rounded bg-stone-900 dark:bg-stone-100 text-stone-50 dark:text-stone-950 text-xs font-medium hover:bg-stone-800 dark:hover:bg-stone-200 disabled:opacity-50 transition-colors cursor-pointer"
                        >
                          Apply &amp; Re-translate Page
                        </button>
                      )}
                    </div>

                    <div className="pt-2 border-t border-stone-200 dark:border-stone-800 space-y-2.5">
                      <label className="flex items-start gap-2 text-xs text-stone-700 dark:text-stone-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={autoPreloadNext}
                          onChange={(e) => setAutoPreloadNext(e.target.checked)}
                          className="mt-0.5 rounded accent-amber-700"
                        />
                        <span>
                          Auto-translate &amp; save next page when reaching the end of the current page
                        </span>
                      </label>
                      <label className="flex items-center gap-2 text-xs text-stone-700 dark:text-stone-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={preserveTerms}
                          onChange={(e) => setPreserveTerms(e.target.checked)}
                          className="rounded accent-amber-700"
                        />
                        Keep software &amp; UI terms in English
                      </label>
                      <div>
                        <label className="block text-[11px] text-stone-500 dark:text-stone-400 mb-1">
                          Extra protected terms (comma-separated):
                        </label>
                        <textarea
                          rows={2}
                          value={customTermsInput}
                          onChange={(e) => setCustomTermsInput(e.target.value)}
                          className="w-full p-2 text-xs rounded border border-stone-300 dark:border-stone-700 bg-[#FAF9F5] dark:bg-[#141312] text-stone-900 dark:text-stone-100 focus:outline-none focus:border-amber-700"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Right controls: Save Book Bookmark + Page Bookmark + Fast Full-PDF Converter + Quick Translate + Theme cycle */}
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 max-w-full">
              {activeBook && (
                <>
                  <button
                    type="button"
                    onClick={() => handleToggleBookSavedBookmark(activeBook.id)}
                    title={
                      activeBook.isBookmarked
                        ? 'Bookmarked in My Library — click to remove'
                        : 'Bookmark this book in My Library'
                    }
                    aria-label={
                      activeBook.isBookmarked ? 'Remove book bookmark' : 'Bookmark this book'
                    }
                    className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded border text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                      activeBook.isBookmarked
                        ? 'border-amber-700 bg-amber-700 text-white'
                        : 'border-stone-300 dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#1F1E1B] text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800'
                    }`}
                  >
                    <Bookmark
                      className={`w-3.5 h-3.5 ${activeBook.isBookmarked ? 'fill-current' : ''}`}
                    />
                    <span className="hidden md:inline">
                      {activeBook.isBookmarked ? 'Bookmarked' : 'Save Book'}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={handleToggleCurrentPageBookmark}
                    title={
                      isCurrentPageBookmarked
                        ? `Remove page mark on Page ${currentPage}`
                        : `Mark Page ${currentPage}`
                    }
                    aria-label={
                      isCurrentPageBookmarked
                        ? 'Remove current page mark'
                        : 'Mark current page'
                    }
                    className={`h-8 px-2 inline-flex items-center justify-center gap-1 rounded border text-[11px] font-mono-num transition-colors cursor-pointer whitespace-nowrap ${
                      isCurrentPageBookmarked
                        ? 'border-stone-900 bg-stone-900 text-stone-50 dark:border-stone-100 dark:bg-stone-100 dark:text-stone-950'
                        : 'border-stone-300 dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#1F1E1B] text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800'
                    }`}
                  >
                    <Bookmark
                      className={`w-3 h-3 ${isCurrentPageBookmarked ? 'fill-current' : ''}`}
                    />
                    <span>p.{currentPage}</span>
                  </button>
                </>
              )}

              {batchProgress ? (
                <div className="flex items-center gap-2.5 px-3 h-8 rounded border border-amber-700/40 bg-amber-50/80 dark:bg-amber-950/30 text-xs">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-700 dark:text-amber-400 shrink-0" />
                  <span className="text-stone-800 dark:text-stone-200 font-mono-num truncate max-w-[190px]">
                    p.{batchProgress.currentPage} ({batchProgress.current}/{batchProgress.total})
                  </span>
                  <button
                    type="button"
                    onClick={handleCancelBatch}
                    className="inline-flex items-center gap-1 text-red-700 dark:text-red-400 font-medium hover:underline cursor-pointer"
                  >
                    <Square className="w-3 h-3" />
                    Stop
                  </button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={!activeBook || isTranslatingPage}
                    onClick={() => handleTranslateCurrentPage(false)}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded text-xs font-medium bg-amber-700 hover:bg-amber-800 text-white disabled:opacity-45 cursor-pointer whitespace-nowrap"
                  >
                    {isTranslatingPage ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Languages className="w-3.5 h-3.5" />
                    )}
                    <span>{translatedPage ? 'Translated' : `Translate p.${currentPage}`}</span>
                  </button>

                  <button
                    type="button"
                    disabled={!activeBook}
                    onClick={() => setActiveTab('export')}
                    title="Fast-translate all pages in parallel batches and convert the full PDF"
                    className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded border border-amber-700/45 dark:border-amber-600/50 bg-white sepia:bg-[#FBF6E9] dark:bg-[#1F1E1B] text-xs font-medium text-amber-800 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Full PDF Fast</span>
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={cycleTheme}
                title={`Reading Theme: ${readingTheme === 'light' ? 'Light' : readingTheme === 'sepia' ? 'Sepia Paper' : 'OLED Dark'} (click to switch)`}
                aria-label="Cycle reading theme (Light, Sepia, OLED Dark)"
                className="h-8 px-2 inline-flex items-center justify-center gap-1 rounded border border-stone-300 dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#1F1E1B] text-xs font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer whitespace-nowrap"
              >
                {readingTheme === 'dark' ? (
                  <Sun className="w-3.5 h-3.5" />
                ) : readingTheme === 'sepia' ? (
                  <BookOpen className="w-3.5 h-3.5 text-amber-800" />
                ) : (
                  <Moon className="w-3.5 h-3.5" />
                )}
                <span className="hidden xl:inline capitalize">{readingTheme}</span>
              </button>
            </div>
          </div>

          {/* Mobile Single-Column Tabs (< lg) */}
          <div className="lg:hidden w-full grid grid-cols-3 border-t border-stone-200 dark:border-stone-800 bg-[#FAF9F5] dark:bg-[#181715]">
            {[
              { id: 'pdf' as const, label: 'Original PDF' },
              { id: 'translated' as const, label: `${langOption.name} Reader` },
              { id: 'chapters' as const, label: 'Chapters' },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setMobilePane(tab.id)}
                className={`h-10 px-1 text-xs font-medium border-b-2 truncate transition-colors cursor-pointer ${
                  mobilePane === tab.id
                    ? 'border-amber-700 dark:border-amber-500 text-stone-950 dark:text-stone-50'
                    : 'border-transparent text-stone-500 dark:text-stone-400'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Optional Info Banner */}
      {appBanner && (
        <div className="no-print px-4 py-2 text-xs bg-stone-100 dark:bg-stone-900 border-b border-stone-200 dark:border-stone-800 text-stone-700 dark:text-stone-300 flex items-center justify-between gap-2">
          <span>{appBanner}</span>
          <button
            type="button"
            onClick={() => setAppBanner(null)}
            className="text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Auto-Download Converted PDF Status Bar (visible when user switched away from Export tab) */}
      {activeTab !== 'export' && autoPdfBuildProgress && (
        <div className="no-print px-4 py-2 text-xs bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900/60 text-amber-900 dark:text-amber-200 flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 min-w-0">
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            <span className="truncate">{autoPdfBuildProgress.status}</span>
          </span>
          <span className="font-mono-num shrink-0">
            {autoPdfBuildProgress.current}/{autoPdfBuildProgress.total}
          </span>
        </div>
      )}

      {activeTab !== 'export' && !autoPdfBuildProgress && readyAutoPdf && (
        <div className="no-print px-4 py-2 text-xs bg-emerald-50 dark:bg-emerald-950/40 border-b border-emerald-200 dark:border-emerald-900/60 text-emerald-900 dark:text-emerald-200 flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2 min-w-0">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">
              Converted PDF ready ({readyAutoPdf.exportedPageCount} pages):{' '}
              <strong>{readyAutoPdf.fileName}</strong>
            </span>
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href={readyAutoPdf.url}
              download={readyAutoPdf.fileName}
              className="inline-flex items-center gap-1 h-7 px-2.5 rounded bg-emerald-700 hover:bg-emerald-800 text-white font-medium transition-colors"
            >
              <Download className="w-3 h-3" />
              <span>Save PDF</span>
            </a>
            <button
              type="button"
              onClick={() => setReadyAutoPdfSafe(null)}
              aria-label="Dismiss PDF ready notice"
              className="text-emerald-700 dark:text-emerald-300 hover:opacity-75 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Main View Content */}
      <div className="no-print flex-1 flex flex-col min-h-0">
        {activeTab === 'discover' ? (
          <DiscoverView
            targetLang={targetLang}
            savedBooks={books}
            onActionBook={handleActionDiscoveredBook}
            loadingBookAction={loadingBookAction}
            onUploadPdf={handleUploadPdf}
            isUploading={isUploading}
          />
        ) : isInitializing ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 py-20 text-stone-600 dark:text-stone-400">
            <Loader2 className="w-6 h-6 animate-spin text-amber-700 dark:text-amber-500" />
            <p className="text-sm font-medium">
              Loading library &amp; detecting book chapters…
            </p>
          </div>
        ) : activeTab === 'library' ? (
          <LibraryView
            books={books}
            activeBookId={activeBook?.id ?? null}
            translatedCountsByBook={translatedCountsByBook}
            dailyReadingGoal={dailyReadingGoal}
            onChangeDailyGoal={handleUpdateDailyReadingGoal}
            downloadingBookId={downloadingBookId}
            onSelectBook={async (book) => {
              try {
                await openStoredBook(book);
                setActiveTab('reader');
              } catch (err) {
                setAppBanner(
                  err instanceof Error
                    ? err.message
                    : 'Unable to open this book right now.'
                );
              }
            }}
            onListenBook={handleListenStoredBook}
            onTranslateBook={handleTranslateStoredBook}
            onDownloadBook={handleDownloadStoredBook}
            onToggleBookBookmark={handleToggleBookSavedBookmark}
            onUploadPdf={handleUploadPdf}
            onDeleteBook={handleDeleteBook}
            onGoToDiscover={() => setActiveTab('discover')}
            isUploading={isUploading}
          />
        ) : activeTab === 'export' ? (
          <ExportView
            pdf={loadedPdf}
            book={activeBook}
            currentPage={currentPage}
            currentChapter={currentChapter}
            targetLang={targetLang}
            onChangeTargetLang={setTargetLang}
            engine={engine}
            onChangeEngine={setEngine}
            aiAvailable={aiAvailable}
            translatedPages={bookTranslations}
            batchProgress={batchProgress}
            autoDownloadAfterFast={autoDownloadAfterFast}
            onChangeAutoDownloadAfterFast={setAutoDownloadAfterFast}
            onSyncExportPdfOptions={handleSyncExportPdfOptions}
            autoPdfBuildProgress={autoPdfBuildProgress}
            readyAutoPdf={readyAutoPdf}
            autoPdfError={autoPdfError}
            onDismissReadyAutoPdf={() => setReadyAutoPdfSafe(null)}
            onFastTranslateRange={handleFastTranslateRange}
            onCancelBatch={handleCancelBatch}
            onPreparePrintPages={(pages, includeCover) =>
              setPrintPayload({ pages, includeCover })
            }
            onTranslateChapter={handleTranslateChapter}
            onGoToReader={() => setActiveTab('reader')}
          />
        ) : !activeBook ? (
          isLoadingActivePdf ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 py-20 text-stone-600 dark:text-stone-400">
              <Loader2 className="w-6 h-6 animate-spin text-amber-700 dark:text-amber-500" />
              <p className="text-sm font-medium">Opening book &amp; preparing reader…</p>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 py-20 text-center">
              <BookOpen className="w-10 h-10 text-stone-400" />
              <h1 className="font-display text-2xl font-semibold">No Book Loaded</h1>
              <p className="text-sm text-stone-600 dark:text-stone-400 max-w-md">
                Discover free public-domain PDFs and e-books or upload your own illustrated PDF to
                start translating, listening, and exporting with the original cover preserved.
              </p>
              <button
                type="button"
                onClick={() => setActiveTab('discover')}
                className="h-9 px-4 rounded-md text-xs font-medium bg-amber-700 hover:bg-amber-800 text-white cursor-pointer"
              >
                Browse Global E-Book Search
              </button>
            </div>
          )
        ) : (
          /* Split-Screen Desktop / Tabbed Mobile Reader */
          <div className="flex-1 flex min-h-0 min-h-[calc(100dvh-190px)] lg:h-[calc(100vh-160px)] w-full max-w-full">
            {/* Desktop Collapsible Chapters & Bookmarks Sidebar */}
            {sidebarOpen && (
              <div className="hidden lg:block w-[272px] shrink-0 h-full overflow-hidden">
                <ChapterSidebar
                  bookTitle={activeBook.title}
                  numPages={activeBook.numPages}
                  chapters={activeBook.chapters}
                  currentPage={currentPage}
                  translatedPageNumbers={translatedPageNumbers}
                  bookmarks={activeBook.bookmarks ?? []}
                  isSpeaking={isSpeaking}
                  isPreparingAudio={isPreparingAudio}
                  onSelectPage={setCurrentPage}
                  onPlayChapterAudio={handlePlayChapterAudio}
                  onTranslateChapter={handleTranslateChapter}
                  onSummarizeChapter={handleSummarizeChapter}
                  summarizingChapterId={summarizingChapterId}
                  isBatchTranslating={Boolean(batchProgress)}
                  readingSpeed={readingSpeed}
                  chapterReadingEstimate={chapterReadingEstimate}
                  pageWordCounts={allBookPageWordCounts}
                  fallbackWordsPerPage={bookFallbackWordsPerPage}
                />
              </div>
            )}

            {/* Mobile Slide-Over Chapters Drawer */}
            {mobileChaptersOpen && (
              <div className="lg:hidden fixed inset-0 z-50 flex">
                <div className="w-80 max-w-[85vw] h-full shadow-2xl">
                  <ChapterSidebar
                    bookTitle={activeBook.title}
                    numPages={activeBook.numPages}
                    chapters={activeBook.chapters}
                    currentPage={currentPage}
                    translatedPageNumbers={translatedPageNumbers}
                    bookmarks={activeBook.bookmarks ?? []}
                    isSpeaking={isSpeaking}
                    isPreparingAudio={isPreparingAudio}
                    onSelectPage={(p) => {
                      setCurrentPage(p);
                      setMobileChaptersOpen(false);
                    }}
                    onPlayChapterAudio={(ch) => {
                      handlePlayChapterAudio(ch);
                      setMobileChaptersOpen(false);
                      setMobilePane('translated');
                    }}
                    onTranslateChapter={(ch) => {
                      setMobileChaptersOpen(false);
                      handleTranslateChapter(ch);
                    }}
                    onSummarizeChapter={(ch) => {
                      setMobileChaptersOpen(false);
                      handleSummarizeChapter(ch);
                    }}
                    summarizingChapterId={summarizingChapterId}
                    isBatchTranslating={Boolean(batchProgress)}
                    onCloseMobile={() => setMobileChaptersOpen(false)}
                    readingSpeed={readingSpeed}
                    chapterReadingEstimate={chapterReadingEstimate}
                    pageWordCounts={allBookPageWordCounts}
                    fallbackWordsPerPage={bookFallbackWordsPerPage}
                  />
                </div>
                <button
                  type="button"
                  aria-label="Close chapters drawer"
                  onClick={() => setMobileChaptersOpen(false)}
                  className="flex-1 bg-black/40"
                />
              </div>
            )}

            {/* Split Reader Area */}
            <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 min-w-0 h-full overflow-hidden">
              {/* Left Pane: Original PDF */}
              <div
                className={`h-full overflow-hidden border-r border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 ${
                  mobilePane === 'pdf' ? 'block' : 'hidden lg:block'
                }`}
              >
                <PdfViewerPane
                  bookId={activeBook.id}
                  bookTitle={activeBook.title}
                  pdf={loadedPdf}
                  pageNumber={currentPage}
                  numPages={activeBook.numPages}
                  figureCount={parsedPage?.figures.length ?? 0}
                  onChangePage={setCurrentPage}
                  onRunOcr={() => handleRunOcr({ highRes: false })}
                  onRerunOcr={(highRes) => handleRunOcr({ highRes })}
                  onSaveOcrReview={handleSaveOcrReview}
                  onKeepOriginalOcr={handleKeepOriginalOcr}
                  isRunningOcr={isRunningOcr}
                  ocrProgress={ocrProgress}
                  ocrStage={ocrStage}
                  ocrScriptMode={ocrScriptMode}
                  onChangeOcrScriptMode={setOcrScriptMode}
                  pendingOcrReview={
                    pendingOcrReview && pendingOcrReview.pageNumber === currentPage
                      ? pendingOcrReview
                      : null
                  }
                  onReachPageEnd={handleReachPageEnd}
                  onBookMetadataUpdated={(updatedBook) => {
                    syncUpdatedBookInState(updatedBook);
                  }}
                />
              </div>

              {/* Right Pane: Translated Illustrated Reader */}
              <div
                className={`h-full overflow-hidden ${
                  mobilePane === 'translated' ? 'block' : 'hidden lg:block'
                }`}
              >
                <TranslatedReaderPane
                  pageNumber={currentPage}
                  numPages={activeBook.numPages}
                  parsedPage={parsedPage}
                  translatedPage={translatedPage}
                  targetLang={targetLang}
                  engine={engine}
                  currentChapter={currentChapter}
                  sentences={sentences}
                  activeSentenceIndex={activeSentenceIndex}
                  isSpeaking={isSpeaking}
                  isTranslating={isTranslatingPage}
                  translationError={translationError}
                  autoPreloadNext={autoPreloadNext}
                  nextPageStatus={nextPageStatus}
                  onReachPageEnd={handleReachPageEnd}
                  onGoToNextPage={handleGoToNextPage}
                  onTranslatePage={handleTranslateCurrentPage}
                  onCancelTranslation={handleCancelPageTranslation}
                  onTranslateChapter={handleTranslateChapter}
                  onRunOcr={() => handleRunOcr({ highRes: false })}
                  isRunningOcr={isRunningOcr}
                  onUpdateBlockText={handleUpdateBlockText}
                  onUpdateHighlights={handleUpdatePageHighlights}
                  onClickSentence={handleClickSentence}
                  readerFontSize={readerFontSize}
                  readerLineHeight={readerLineHeight}
                  onSummarizeCurrentChapter={
                    currentChapter
                      ? () => handleSummarizeChapter(currentChapter)
                      : undefined
                  }
                  isSummarizingChapter={Boolean(summarizingChapterId)}
                  onExportHighlights={handleExportHighlightsSheet}
                  onShareQuote={handleShareQuoteFromReader}
                  onOpenShareStudio={handleOpenShareStudio}
                  readingSpeed={readingSpeed}
                  chapterReadingEstimate={chapterReadingEstimate}
                  onResetReadingSpeed={handleResetReadingSpeed}
                  bookId={activeBook.id}
                  pdf={loadedPdf}
                  chapters={activeBook.chapters}
                  bookTranslations={bookTranslations}
                  onSelectPage={setCurrentPage}
                />
              </div>

              {/* Mobile Inline Chapters Tab */}
              {mobilePane === 'chapters' && (
                <div className="lg:hidden h-full overflow-hidden">
                  <ChapterSidebar
                    bookTitle={activeBook.title}
                    numPages={activeBook.numPages}
                    chapters={activeBook.chapters}
                    currentPage={currentPage}
                    translatedPageNumbers={translatedPageNumbers}
                    bookmarks={activeBook.bookmarks ?? []}
                    isSpeaking={isSpeaking}
                    isPreparingAudio={isPreparingAudio}
                    onSelectPage={(p) => {
                      setCurrentPage(p);
                      setMobilePane('translated');
                    }}
                    onPlayChapterAudio={(ch) => {
                      handlePlayChapterAudio(ch);
                      setMobilePane('translated');
                    }}
                    onTranslateChapter={(ch) => {
                      setMobilePane('translated');
                      handleTranslateChapter(ch);
                    }}
                    onSummarizeChapter={(ch) => {
                      setMobilePane('translated');
                      handleSummarizeChapter(ch);
                    }}
                    summarizingChapterId={summarizingChapterId}
                    isBatchTranslating={Boolean(batchProgress)}
                    readingSpeed={readingSpeed}
                    chapterReadingEstimate={chapterReadingEstimate}
                    pageWordCounts={allBookPageWordCounts}
                    fallbackWordsPerPage={bookFallbackWordsPerPage}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Sticky Bottom Audiobook Player (shown in Reader) */}
      {activeTab === 'reader' && activeBook && (
        <AudiobookBar
          bookTitle={activeBook.title}
          bookAuthor={activeBook.author}
          bookCoverUrl={activeBook.coverDataUrl}
          isOnline={isOnline}
          pageNumber={currentPage}
          numPages={activeBook.numPages}
          currentChapter={currentChapter}
          chapterPageWordCounts={chapterPageWordCounts}
          targetLang={targetLang}
          parsedPage={parsedPage}
          translatedPage={translatedPage}
          isTranslatingPage={isTranslatingPage}
          sentences={sentences}
          activeSentenceIndex={activeSentenceIndex}
          onActiveSentenceChange={setActiveSentenceIndex}
          isSpeaking={isSpeaking}
          onSpeakingChange={setIsSpeaking}
          onPreparingChange={setIsPreparingAudio}
          controlRef={audiobookControlRef}
          jumpRequest={jumpRequest}
          onAdvancePage={handleAdvancePageFromAudio}
          onSeekToPage={(targetPage) =>
            setCurrentPage(Math.max(1, Math.min(activeBook.numPages, targetPage)))
          }
          onRequestTranslatePage={() => handleTranslateCurrentPage(false)}
          aiAvailable={aiAvailable}
          narrationSource={narrationSource}
          onNarrationSourceChange={setNarrationSource}
          voiceStylePreference={voiceStylePreference}
          onVoiceStylePreferenceChange={setVoiceStylePreference}
        />
      )}

      {/* One-Click Chapter Summary & Key Takeaways Modal */}
      {chapterSummaryModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="chapter-summary-title"
          className="no-print fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55 backdrop-blur-[1px]"
          onClick={() => setChapterSummaryModal(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-w-2xl max-h-[88vh] overflow-y-auto rounded-lg border border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-[#FAF9F5] sepia:bg-[#F4ECD8] dark:bg-[#191816] shadow-2xl ${langOption.cssClass}`}
            dir={langOption.rtl ? 'rtl' : 'ltr'}
          >
            <div
              dir="ltr"
              className="px-6 py-4 border-b border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="w-4 h-4 text-amber-700 dark:text-amber-500 shrink-0" />
                <span className="text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400 truncate">
                  Chapter Summary &amp; Key Takeaways · {chapterSummaryModal.readingTimeMinutes} min read
                </span>
              </div>
              <button
                type="button"
                onClick={() => setChapterSummaryModal(null)}
                aria-label="Close chapter summary"
                className="h-8 w-8 inline-flex items-center justify-center rounded-md text-stone-500 hover:text-stone-950 dark:hover:text-stone-100 hover:bg-stone-200/60 dark:hover:bg-stone-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-5">
              <div>
                <h2
                  id="chapter-summary-title"
                  className="font-display text-xl sm:text-2xl font-semibold text-stone-950 dark:text-stone-50"
                >
                  {chapterSummaryModal.chapterTitle}
                </h2>
                <p className="mt-2.5 text-sm sm:text-[15px] leading-relaxed text-stone-700 sepia:text-[#3B2F23] dark:text-stone-300">
                  {chapterSummaryModal.summary}
                </p>
              </div>

              <div className="pt-4 border-t border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 space-y-2.5">
                <h3
                  dir="ltr"
                  className="text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400"
                >
                  Key Takeaways
                </h3>
                <ul className="space-y-2.5">
                  {chapterSummaryModal.keyTakeaways.map((point, idx) => (
                    <li
                      key={idx}
                      className="flex items-start gap-2.5 text-sm leading-relaxed text-stone-800 sepia:text-[#3B2F23] dark:text-stone-200"
                    >
                      <span className="font-mono-num text-xs font-semibold text-amber-800 dark:text-amber-400 mt-0.5 shrink-0">
                        {String(idx + 1).padStart(2, '0')}.
                      </span>
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {chapterSummaryModal.keyTerms.length > 0 && (
                <div
                  dir="ltr"
                  className="pt-4 border-t border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 text-xs text-stone-600 dark:text-stone-400"
                >
                  <span className="font-semibold text-stone-800 dark:text-stone-200">
                    Key Concepts:{' '}
                  </span>
                  {chapterSummaryModal.keyTerms.join(' · ')}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Share Highlights Visual Quote Card Studio Modal */}
      {shareModalPayload && (
        <ShareHighlightModal
          initialPayload={shareModalPayload}
          savedHighlights={allBookShareHighlights}
          onClose={() => setShareModalPayload(null)}
        />
      )}

      {/* Hidden Print-Only Vector Unicode Document for "Print / Save Selectable PDF" */}
      {activeBook && printPayload && (
        <div
          className={`print-only bg-white text-black ${langOption.cssClass}`}
          dir={langOption.rtl ? 'rtl' : 'ltr'}
        >
          {printPayload.includeCover && activeBook.coverDataUrl && (
            <div className="print-page-break flex items-center justify-center min-h-screen">
              <img
                src={activeBook.coverDataUrl}
                alt={`${activeBook.title} Cover`}
                className="max-w-full max-h-[96vh] object-contain"
              />
            </div>
          )}
          {printPayload.pages.map((pg) => {
            const items = [
              ...pg.blocks.map((b) => ({ type: 'block' as const, y: b.yPercent, b })),
              ...pg.figures.map((f) => ({ type: 'fig' as const, y: f.yPercent, f })),
            ].sort((a, b) => a.y - b.y);

            return (
              <div key={pg.key} className="print-page-break p-8 max-w-2xl mx-auto space-y-4">
                <div
                  dir="ltr"
                  className="text-xs text-stone-500 border-b border-stone-300 pb-2 flex justify-between"
                >
                  <span>{activeBook.title}</span>
                  <span>
                    {langOption.name} · Page {pg.pageNumber}
                  </span>
                </div>
                {items.map((it) =>
                  it.type === 'fig' ? (
                    <img
                      key={it.f.id}
                      src={it.f.dataUrl}
                      alt={`Figure from page ${pg.pageNumber}`}
                      className="max-h-96 mx-auto my-4 object-contain border border-stone-200"
                    />
                  ) : it.b.kind === 'heading' ? (
                    <h2 key={it.b.id} className="text-2xl font-bold pt-2">
                      {it.b.translatedText || it.b.text}
                    </h2>
                  ) : it.b.kind === 'subheading' ? (
                    <h3 key={it.b.id} className="text-lg font-semibold pt-1">
                      {it.b.translatedText || it.b.text}
                    </h3>
                  ) : (
                    <p key={it.b.id} className="text-[14px] leading-relaxed">
                      {it.b.kind === 'bullet' ? '• ' : ''}
                      {it.b.translatedText || it.b.text}
                    </p>
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
