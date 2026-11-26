import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  BookOpen,
  FileText,
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
  inspectOfflineLibraryCache,
  removeBookFromOfflineCache,
  subscribeServiceWorkerStatus,
  warmPdfEngineOfflineAssets,
  type ServiceWorkerStatus,
} from './lib/offlineCache';
import { TopBar, type ActiveTab } from './components/TopBar';
import { DiscoverView, type DiscoverBookAction } from './components/DiscoverView';
import { ChapterSidebar } from './components/ChapterSidebar';
import { PdfViewerPane } from './components/PdfViewerPane';
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
  extractPageContent,
  loadPdfFromBuffer,
  loadPdfFromUrl,
  renderPageToDataUrl,
  runClientOcrOnPage,
  type LoadedPdf,
} from './lib/pdfEngine';
import {
  deleteBook,
  getBook,
  getParsedPage,
  getTranslation,
  listAllTranslationCountsByBook,
  listBooks,
  listTranslationsForBookLang,
  makeTranslationKey,
  saveBook,
  saveParsedPage,
  saveTranslation,
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
  checkServerCapabilities,
  downloadBlob,
  splitBlocksIntoSentences,
  translatePageBlocks,
  translatePagesBatchFast,
} from './lib/translatorClient';
import type {
  BatchTranslationProgress,
  ChapterItem,
  ChapterSummaryResult,
  DiscoveredBook,
  LanguageCode,
  ParsedPage,
  ReadingTheme,
  StoredBook,
  TextHighlight,
  TextHighlightColor,
  TranslatedPageRecord,
  TranslationEngine,
} from './types';

type MobilePane = 'pdf' | 'translated' | 'chapters';

export default function App() {
  // Connectivity & Service Worker Offline Cache State
  const isOnline = useOnlineStatus();
  const [swStatus, setSwStatus] = useState<ServiceWorkerStatus>('registering');
  const [cachedBookIds, setCachedBookIds] = useState<Set<string>>(() => new Set());
  const [storageUsageBytes, setStorageUsageBytes] = useState<number | null>(null);
  const [allLangTranslationCountsByBook, setAllLangTranslationCountsByBook] = useState<
    Record<string, number>
  >({});
  const [cachingBookId, setCachingBookId] = useState<string | null>(null);
  const [downloadingBookId, setDownloadingBookId] = useState<string | null>(null);
  const [isSyncingAllOffline, setIsSyncingAllOffline] = useState(false);
  const [dailyReadingGoal, setDailyReadingGoal] = useState<DailyReadingGoalSnapshot>(() =>
    getDailyReadingGoalSnapshot()
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
  const [isUploading, setIsUploading] = useState(false);
  const [appBanner, setAppBanner] = useState<string | null>(null);

  // Reader State
  const [currentPage, setCurrentPage] = useState(1);
  const [targetLang, setTargetLang] = useState<LanguageCode>('hi');
  const [engine, setEngine] = useState<TranslationEngine>('free');
  const [preserveTerms, setPreserveTerms] = useState(true);
  const [autoPreloadNext, setAutoPreloadNext] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const saved = localStorage.getItem('bhashabook-auto-preload-next');
    return saved === null ? true : saved === 'true';
  });
  const [customTermsInput, setCustomTermsInput] = useState(
    'OBS, Scene, Source, Plugin, Bitrate, NDI, SRT, Audio Mixer'
  );
  const [voiceStylePreference, setVoiceStylePreference] = useState<VoiceStylePreference>(() => {
    if (typeof window === 'undefined') return 'teacher';
    const saved = localStorage.getItem('bhashabook-voice-style-preference');
    return saved === 'narrator' || saved === 'energetic' ? saved : 'teacher';
  });
  const [showGlossaryPopover, setShowGlossaryPopover] = useState(false);

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
  const [batchProgress, setBatchProgress] = useState<BatchTranslationProgress | null>(null);
  const batchCancelRef = useRef(false);
  const batchAbortRef = useRef<AbortController | null>(null);
  const pageTranslateAbortRef = useRef<AbortController | null>(null);

  // Deduplicated Background Auto-Translate & Auto-Save Tracking
  const inFlightTranslationsRef = useRef<Map<string, Promise<TranslatedPageRecord>>>(new Map());
  const [inFlightKeys, setInFlightKeys] = useState<Set<string>>(() => new Set());
  const [prefetchErrorKeys, setPrefetchErrorKeys] = useState<Set<string>>(() => new Set());
  const activeBookIdRef = useRef<string | null>(null);
  const currentPageRef = useRef<number>(1);
  const targetLangRef = useRef<LanguageCode>('hi');

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

  activeBookIdRef.current = activeBook?.id ?? null;
  currentPageRef.current = currentPage;
  targetLangRef.current = targetLang;

  const customTerms = useMemo(
    () =>
      customTermsInput
        .split(/[,\n]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    [customTermsInput]
  );

  // Refresh translated counts across library for active language + all cached languages
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
      const allCounts = await listAllTranslationCountsByBook().catch(() => counts);
      setAllLangTranslationCountsByBook(allCounts);
    },
    []
  );

  // Refresh Service Worker & local IndexedDB offline cache diagnostics
  const refreshOfflineInspection = useCallback(async (bookList: StoredBook[]) => {
    const info = await inspectOfflineLibraryCache(bookList);
    setCachedBookIds(info.cachedBookIds);
    setStorageUsageBytes(info.storageUsageBytes);
  }, []);

  // Subscribe to Service Worker registration status & warm PDF.js fonts once online
  useEffect(() => {
    const unsubscribe = subscribeServiceWorkerStatus((status) => {
      setSwStatus(status);
    });
    return unsubscribe;
  }, []);

  const booksCacheSignature = useMemo(
    () => books.map((b) => `${b.id}:${b.pdfData && b.pdfData.byteLength > 0 ? 1 : 0}`).join('|'),
    [books]
  );
  const booksRef = useRef(books);
  booksRef.current = books;

  useEffect(() => {
    refreshOfflineInspection(booksRef.current);
  }, [booksCacheSignature, swStatus, translatedCountsByBook, refreshOfflineInspection]);

  useEffect(() => {
    if (isOnline && swStatus === 'active') {
      warmPdfEngineOfflineAssets().catch(() => {});
    }
  }, [isOnline, swStatus]);

  // Keep in-memory Library list & activeBook synchronized and ordered by most recently used
  const syncUpdatedBookInState = useCallback((updated: StoredBook, syncActive = true) => {
    setBooks((prev) => {
      const exists = prev.some((b) => b.id === updated.id);
      const next = exists
        ? prev.map((b) => (b.id === updated.id ? updated : b))
        : [updated, ...prev];
      return [...next].sort(
        (a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt)
      );
    });
    if (syncActive) {
      setActiveBook((curr) => (curr && curr.id === updated.id ? updated : curr));
    }
  }, []);

  // Open a StoredBook into the active PDF.js instance (offline-first: IndexedDB -> SW Cache -> Network)
  const openStoredBook = useCallback(
    async (
      book: StoredBook,
      options?: { pageOverride?: number; restoreAudioState?: boolean }
    ) => {
      setAppBanner(null);
      let pdfDoc: LoadedPdf;
      if (book.pdfData && book.pdfData.byteLength > 0) {
        pdfDoc = await loadPdfFromBuffer(book.pdfData);
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
          // Persist into Service Worker cache & IndexedDB in background so future offline opens work immediately
          cacheBookForOffline(book)
            .then((cached) => {
              syncUpdatedBookInState(cached);
            })
            .catch(() => {});
        } else {
          throw new Error('PDF source data missing for this book.');
        }
      }

      const targetPage = Math.max(
        1,
        Math.min(
          book.numPages,
          options?.pageOverride ??
            (options?.restoreAudioState ? book.lastAudioPage ?? book.lastPage : book.lastPage) ??
            1
        )
      );

      const now = Date.now();
      const updatedBook =
        (await updateBookProgress(book.id, {
          lastPage: targetPage,
          lastOpenedAt: now,
        }).catch(() => undefined)) ?? { ...book, lastPage: targetPage, lastOpenedAt: now };

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
    },
    [syncUpdatedBookInState]
  );

  // Boot: non-blocking IndexedDB load first so Discover & Library render immediately, then preload sample guidebook in background
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        checkServerCapabilities()
          .then((caps) => {
            if (!cancelled) setAiAvailable(caps.aiAvailable);
          })
          .catch(() => {});

        const existingBooks = await listBooks();
        if (!cancelled) {
          setBooks(existingBooks);
          setIsInitializing(false);
          refreshLibraryCounts(existingBooks, targetLang).catch(() => {});
        }

        const existingObs = existingBooks.find((b) => b.id === PRELOADED_OBS_BOOK_ID);
        if (existingObs) {
          if (!cancelled) {
            await openStoredBook(existingObs).catch(() => {});
          }
          return;
        }

        if (existingBooks.length > 0) {
          if (!cancelled) {
            await openStoredBook(existingBooks[0]).catch(() => {});
          }
          return;
        }

        // First-ever visit with empty library: preload sample guidebook in the background without blocking Discover UI
        if (typeof navigator === 'undefined' || navigator.onLine !== false) {
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
                  setBooks((prev) =>
                    prev.map((b) => (b.id === cachedObs.id ? cachedObs : b))
                  );
                  setActiveBook((prev) =>
                    prev && prev.id === cachedObs.id ? cachedObs : prev
                  );
                }
              })
              .catch(() => {});
            const updatedList = await listBooks();
            if (!cancelled) {
              setBooks(updatedList);
              refreshLibraryCounts(updatedList, targetLang).catch(() => {});
              // Only attach as active book if user hasn't already opened another book
              if (!activeBookIdRef.current) {
                setLoadedPdf(pdf);
                setActiveBook(obsBook);
                setCurrentPage(initialPage);
              } else {
                pdf.cleanup().catch(() => {});
              }
            }
          } catch {
            // Non-fatal: user can browse Discover or upload any local PDF directly
          }
        }
      } finally {
        if (!cancelled) setIsInitializing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

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

      // 2. Check cached parsed page or extract fresh from PDF.js
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
      setActiveBook(newBook);
      setCurrentPage(startPage);
      setActiveTab('reader');
    } catch (err) {
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

  const handleCacheBookOffline = useCallback(
    async (book: StoredBook) => {
      if (cachingBookId || isSyncingAllOffline) return;
      setCachingBookId(book.id);
      setAppBanner(null);
      try {
        const cached = await cacheBookForOffline(book);
        await warmPdfEngineOfflineAssets();
        const updatedList = await listBooks();
        setBooks(updatedList);
        if (activeBook?.id === cached.id) {
          setActiveBook(cached);
        }
        await refreshOfflineInspection(updatedList);
        setAppBanner(`“${book.title}” is now cached in your browser for offline reading.`);
      } catch (err) {
        setAppBanner(
          err instanceof Error
            ? `Could not cache “${book.title}” offline: ${err.message}`
            : 'Could not cache this book offline.'
        );
      } finally {
        setCachingBookId(null);
      }
    },
    [activeBook?.id, cachingBookId, isSyncingAllOffline, refreshOfflineInspection]
  );

  const handleSyncAllOffline = useCallback(async () => {
    if (isSyncingAllOffline || books.length === 0) return;
    setIsSyncingAllOffline(true);
    setAppBanner(null);
    let newlyCached = 0;
    let failed = 0;
    try {
      await warmPdfEngineOfflineAssets();
      for (const book of books) {
        try {
          await cacheBookForOffline(book);
          newlyCached++;
        } catch {
          failed++;
        }
      }
      const updatedList = await listBooks();
      setBooks(updatedList);
      await refreshOfflineInspection(updatedList);
      if (failed === 0) {
        setAppBanner(
          `Offline cache verified: all ${newlyCached} ${
            newlyCached === 1 ? 'book' : 'books'
          } and PDF viewer assets are ready offline.`
        );
      } else {
        setAppBanner(
          `Cached ${newlyCached} book(s) offline (${failed} could not be downloaded right now).`
        );
      }
    } finally {
      setIsSyncingAllOffline(false);
    }
  }, [books, isSyncingAllOffline, refreshOfflineInspection]);

  // Toggle Book-level Bookmark / Save (distinct from page bookmarks)
  const handleToggleBookSavedBookmark = useCallback(
    async (bookId: string) => {
      const updated = await toggleBookSavedBookmark(bookId);
      if (updated) {
        syncUpdatedBookInState(updated);
        setAppBanner(
          updated.isBookmarked
            ? `Bookmarked “${updated.title}” in My Library.`
            : `Removed “${updated.title}” from Bookmarks.`
        );
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
        if (!buffer) {
          buffer = await getCachedBookBufferFromSW(book);
        }
        if (!buffer && book.sourceUrl) {
          const resp = await fetch(book.sourceUrl);
          if (!resp.ok) throw new Error(`Could not fetch PDF (${resp.status}).`);
          buffer = await resp.arrayBuffer();
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
        setAppBanner(
          err instanceof Error ? err.message : 'Unable to download this PDF right now.'
        );
      } finally {
        setDownloadingBookId(null);
      }
    },
    [downloadingBookId, syncUpdatedBookInState]
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
      try {
        await openStoredBook(existing);
        setActiveTab('reader');
      } catch (err) {
        setAppBanner(
          err instanceof Error ? err.message : 'Unable to open this saved book.'
        );
      }
      return;
    }

    setLoadingBookAction({
      bookId: book.id,
      action,
      status:
        action === 'bookmark'
          ? `Bookmarking & saving "${book.title}" to My Library…`
          : `Preparing "${book.title}"…`,
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
        isBookmarked: action === 'bookmark',
        bookmarkedAt: action === 'bookmark' ? now : undefined,
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

      if (action === 'bookmark') {
        pdf.cleanup().catch(() => {});
        setAppBanner(
          `Bookmarked “${newBook.title}” — saved in My Library for reading, listening & PDF download.`
        );
        return;
      }

      setLoadedPdf((prev) => {
        if (prev && prev !== pdf) prev.cleanup().catch(() => {});
        return pdf;
      });
      setActiveBook(newBook);
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
      setAppBanner(
        err instanceof Error
          ? err.message
          : 'Unable to open this public-domain book right now.'
      );
    } finally {
      setLoadingBookAction(null);
    }
  };

  // Toggle Bookmark for the active page
  const handleToggleCurrentPageBookmark = useCallback(async () => {
    if (!activeBook) return;
    const updated = await toggleBookBookmark(activeBook.id, currentPage);
    if (updated) {
      syncUpdatedBookInState(updated);
    }
  }, [activeBook, currentPage, syncUpdatedBookInState]);

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
    [activeBook, loadedPdf, summarizingChapterId, targetLang]
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
        let parsed = await getParsedPage(book.id, pageNum);
        if (!parsed) {
          parsed = await extractPageContent(pdf, pageNum);
          await saveParsedPage(book.id, parsed);
        }

        // If Smart AI mode is active and the page contains diagrams or figures, attach a compressed page screenshot
        let pageImageBase64: string | undefined;
        if (engine === 'ai' && (parsed.figures.length > 0 || parsed.blocks.length <= 2)) {
          try {
            const snap = await renderPageToDataUrl(pdf, pageNum, 1.25, 'image/jpeg', 0.8);
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
    [engine, preserveTerms, customTerms]
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
        setTranslationError(err instanceof Error ? err.message : 'Translation failed.');
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
    }): Promise<{ records: TranslatedPageRecord[]; cancelled: boolean }> => {
      if (!activeBook || !loadedPdf) {
        return { records: [], cancelled: false };
      }
      if (batchProgress) {
        return { records: [], cancelled: false };
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
        const cachedParsed = await getParsedPage(book.id, pNum);
        if (cachedParsed) return cachedParsed;
        try {
          const fresh = await extractPageContent(pdf, pNum);
          await saveParsedPage(book.id, fresh);
          return fresh;
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

      if (missingPages.length === 0) {
        const sortedAll = Array.from(collected.values()).sort(
          (a, b) => a.pageNumber - b.pageNumber
        );
        commitSavedBatchToState(sortedAll);
        document.removeEventListener('visibilitychange', handleVisibilityWake);
        releaseWakeLock();
        batchAbortRef.current = null;
        return { records: sortedAll, cancelled: false };
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
        }

        const sortedRecords = Array.from(collected.values()).sort(
          (a, b) => a.pageNumber - b.pageNumber
        );
        return { records: sortedRecords, cancelled: batchCancelRef.current };
      } catch (err) {
        if (batchCancelRef.current || (err instanceof DOMException && err.name === 'AbortError')) {
          const sortedRecords = Array.from(collected.values()).sort(
            (a, b) => a.pageNumber - b.pageNumber
          );
          return { records: sortedRecords, cancelled: true };
        }
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
        setBatchProgress(null);
      }
    },
    [
      activeBook,
      loadedPdf,
      batchProgress,
      targetLang,
      engine,
      preserveTerms,
      customTerms,
      commitSavedBatchToState,
      commitSavedTranslationToState,
      translateSinglePageInternal,
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

  // Run client-side Tesseract OCR on current page
  const handleRunOcr = async () => {
    if (!activeBook || !loadedPdf || isRunningOcr) return;
    setIsRunningOcr(true);
    setOcrProgress(0);
    setTranslationError(null);
    try {
      const ocrParsed = await runClientOcrOnPage(loadedPdf, currentPage, setOcrProgress);
      await saveParsedPage(activeBook.id, ocrParsed);
      setParsedPage(ocrParsed);
      setAppBanner(
        `OCR completed on Page ${currentPage} (${ocrParsed.blocks.length} text blocks extracted). Click Re-translate to translate the OCR text.`
      );
    } catch (err) {
      setAppBanner(err instanceof Error ? `OCR failed: ${err.message}` : 'OCR failed.');
    } finally {
      setIsRunningOcr(false);
    }
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
          words += txt.split(/\s+/).filter(Boolean).length;
        }
      }
      if (words > 0) {
        counts[rec.pageNumber] = words;
      }
    }
    return counts;
  }, [bookTranslations, currentChapter, currentPage, narrationSource]);

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
  const isCurrentPageBookmarked = Boolean(
    activeBook?.bookmarks?.includes(currentPage)
  );

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

              {/* Engine Selector (Free Open Default + Optional Smart AI) */}
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
                  onClick={() => setEngine('ai')}
                  title={
                    aiAvailable
                      ? 'Uses Gemini AI to explain diagrams/screenshots and refine audiobook flow'
                      : 'Requires GEMINI_API_KEY in Settings > Secrets'
                  }
                  className={`inline-flex items-center gap-1 h-7 px-2 sm:px-2.5 rounded-sm text-[11px] sm:text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    engine === 'ai'
                      ? 'bg-amber-700 text-white'
                      : 'text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100'
                  }`}
                >
                  <Sparkles className="w-3 h-3" />
                  <span>Smart AI</span>
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
            allLangTranslationCountsByBook={allLangTranslationCountsByBook}
            dailyReadingGoal={dailyReadingGoal}
            onChangeDailyGoal={handleUpdateDailyReadingGoal}
            isOnline={isOnline}
            swStatus={swStatus}
            cachedBookIds={cachedBookIds}
            storageUsageBytes={storageUsageBytes}
            cachingBookId={cachingBookId}
            downloadingBookId={downloadingBookId}
            isSyncingAllOffline={isSyncingAllOffline}
            onSelectBook={async (book) => {
              try {
                await openStoredBook(book);
                setActiveTab('reader');
              } catch (err) {
                setAppBanner(
                  err instanceof Error
                    ? err.message
                    : 'Unable to open this book while offline.'
                );
              }
            }}
            onListenBook={handleListenStoredBook}
            onTranslateBook={handleTranslateStoredBook}
            onDownloadBook={handleDownloadStoredBook}
            onToggleBookBookmark={handleToggleBookSavedBookmark}
            onUploadPdf={handleUploadPdf}
            onDeleteBook={handleDeleteBook}
            onCacheBookOffline={handleCacheBookOffline}
            onSyncAllOffline={handleSyncAllOffline}
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
            onFastTranslateRange={handleFastTranslateRange}
            onCancelBatch={handleCancelBatch}
            onPreparePrintPages={(pages, includeCover) =>
              setPrintPayload({ pages, includeCover })
            }
            onTranslateChapter={handleTranslateChapter}
            onGoToReader={() => setActiveTab('reader')}
          />
        ) : !activeBook ? (
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
                  onRunOcr={handleRunOcr}
                  isRunningOcr={isRunningOcr}
                  ocrProgress={ocrProgress}
                  onReachPageEnd={handleReachPageEnd}
                  onBookMetadataUpdated={(updatedBook) => {
                    setActiveBook((curr) => (curr?.id === updatedBook.id ? updatedBook : curr));
                    setBooks((prev) =>
                      prev.map((b) => (b.id === updatedBook.id ? updatedBook : b))
                    );
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
