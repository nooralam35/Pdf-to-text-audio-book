import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Languages,
  Loader2,
  Moon,
  PanelLeft,
  SlidersHorizontal,
  Sparkles,
  Square,
  Sun,
  X,
  Zap,
} from 'lucide-react';
import { TopBar, type ActiveTab } from './components/TopBar';
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
import {
  getLanguageOption,
  LANGUAGES,
  PRELOADED_OBS_BOOK_ID,
  PRELOADED_OBS_BOOK_URL,
} from './lib/languages';
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
  listBooks,
  listTranslationsForBookLang,
  makeTranslationKey,
  saveBook,
  saveParsedPage,
  saveTranslation,
  updateBookLastPage,
} from './lib/storage';
import {
  checkServerCapabilities,
  splitBlocksIntoSentences,
  translatePageBlocks,
  translatePagesBatchFast,
} from './lib/translatorClient';
import type {
  BatchTranslationProgress,
  ChapterItem,
  LanguageCode,
  ParsedPage,
  StoredBook,
  TextHighlight,
  TranslatedPageRecord,
  TranslationEngine,
} from './types';

type MobilePane = 'pdf' | 'translated' | 'chapters';

export default function App() {
  // Navigation & Theme
  const [activeTab, setActiveTab] = useState<ActiveTab>('reader');
  const [mobilePane, setMobilePane] = useState<MobilePane>('translated');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileChaptersOpen, setMobileChaptersOpen] = useState(false);
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('bhashabook-theme') === 'dark';
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
  const [showGlossaryPopover, setShowGlossaryPopover] = useState(false);

  // Page Parsed & Translated Records
  const [parsedPage, setParsedPage] = useState<ParsedPage | null>(null);
  const [translatedPage, setTranslatedPage] = useState<TranslatedPageRecord | null>(null);
  const [bookTranslations, setBookTranslations] = useState<TranslatedPageRecord[]>([]);
  const [translatedCountsByBook, setTranslatedCountsByBook] = useState<Record<string, number>>({});

  // Loading / Processing States
  const [isTranslatingPage, setIsTranslatingPage] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [isRunningOcr, setIsRunningOcr] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [batchProgress, setBatchProgress] = useState<BatchTranslationProgress | null>(null);
  const batchCancelRef = useRef(false);
  const batchAbortRef = useRef<AbortController | null>(null);

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
  const [jumpRequest, setJumpRequest] = useState<{ index: number; nonce: number } | null>(null);
  const audiobookControlRef = useRef<AudiobookControlHandle | null>(null);

  // Print-only Selectable Unicode PDF State
  const [printPayload, setPrintPayload] = useState<{
    pages: TranslatedPageRecord[];
    includeCover: boolean;
  } | null>(null);

  // Sync dark mode class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
      localStorage.setItem('bhashabook-theme', 'dark');
    } else {
      root.classList.remove('dark');
      localStorage.setItem('bhashabook-theme', 'light');
    }
  }, [darkMode]);

  useEffect(() => {
    localStorage.setItem('bhashabook-auto-preload-next', String(autoPreloadNext));
  }, [autoPreloadNext]);

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

  // Open a StoredBook into the active PDF.js instance
  const openStoredBook = useCallback(async (book: StoredBook) => {
    setAppBanner(null);
    let pdfDoc: LoadedPdf;
    if (book.pdfData) {
      pdfDoc = await loadPdfFromBuffer(book.pdfData);
    } else if (book.sourceUrl) {
      pdfDoc = await loadPdfFromUrl(book.sourceUrl);
    } else {
      throw new Error('PDF source data missing for this book.');
    }

    setLoadedPdf((prev) => {
      if (prev && prev !== pdfDoc) {
        prev.cleanup().catch(() => {});
      }
      return pdfDoc;
    });
    setActiveBook(book);
    setCurrentPage(Math.max(1, Math.min(book.numPages, book.lastPage || 1)));
  }, []);

  // Boot: check server capabilities + load IndexedDB library or preload attached OBS Superuser Guidebook
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const caps = await checkServerCapabilities();
        if (!cancelled) setAiAvailable(caps.aiAvailable);

        const existingBooks = await listBooks();
        let obsBook = await getBook(PRELOADED_OBS_BOOK_ID);
        let openedDuringBoot = false;

        if (!obsBook) {
          try {
            const pdf = await loadPdfFromUrl(PRELOADED_OBS_BOOK_URL);
            const [{ chapters, detectedTitle, detectedAuthor }, coverRes, p1] = await Promise.all([
              detectChapters(pdf),
              renderPageToDataUrl(pdf, 1, 1.35, 'image/jpeg', 0.88),
              pdf.getPage(1),
            ]);
            const vp1 = p1.getViewport({ scale: 1.0 });
            // Start at Chapter 1 so user immediately sees rich illustrated technical content
            const ch1 = chapters.find((c) => c.index === 1) ?? chapters[0];
            const initialPage = ch1 ? ch1.startPage : 1;

            obsBook = {
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
            if (!cancelled) {
              setLoadedPdf(pdf);
              setActiveBook(obsBook);
              setCurrentPage(initialPage);
              openedDuringBoot = true;
            }
          } catch (err) {
            if (!cancelled) {
              setAppBanner(
                err instanceof Error
                  ? `Could not preload sample guidebook: ${err.message}`
                  : 'Upload any PDF to begin translating.'
              );
            }
          }
        }

        const updatedList = await listBooks();
        if (!cancelled) {
          setBooks(updatedList);
          await refreshLibraryCounts(updatedList, targetLang);
        }

        const toOpen = obsBook ?? existingBooks[0];
        if (toOpen && !openedDuringBoot && !cancelled) {
          await openStoredBook(toOpen).catch(() => {});
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
  useEffect(() => {
    if (!activeBook) return;
    let cancelled = false;
    listTranslationsForBookLang(activeBook.id, targetLang).then((rows) => {
      if (!cancelled) {
        setBookTranslations(rows);
        setTranslatedCountsByBook((prev) => ({
          ...prev,
          [activeBook.id]: rows.length,
        }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeBook, targetLang]);

  // Refresh library counts when language changes
  useEffect(() => {
    if (books.length > 0) {
      refreshLibraryCounts(books, targetLang);
    }
  }, [books, targetLang, refreshLibraryCounts]);

  // Load parsed page + cached translation (or attach to an in-flight auto-save prefetch) whenever activeBook / page / targetLang changes
  useEffect(() => {
    if (!activeBook || !loadedPdf) return;
    let cancelled = false;

    setTranslationError(null);
    updateBookLastPage(activeBook.id, currentPage).catch(() => {});

    (async () => {
      // 1. Check cached translation immediately for instant offline rendering
      const cachedTr = await getTranslation(activeBook.id, targetLang, currentPage);
      if (!cancelled) {
        setTranslatedPage(cachedTr ?? null);
      }

      // 2. Check cached parsed page or extract fresh from PDF.js
      let parsed = await getParsedPage(activeBook.id, currentPage);
      if (!parsed) {
        try {
          parsed = await extractPageContent(loadedPdf, currentPage);
          await saveParsedPage(activeBook.id, parsed);
        } catch {
          parsed = {
            pageNumber: currentPage,
            width: activeBook.pageWidth || 432,
            height: activeBook.pageHeight || 648,
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
        const key = makeTranslationKey(activeBook.id, targetLang, currentPage);
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
  }, [activeBook, loadedPdf, currentPage, targetLang]);

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
        lastPage: startPage,
        pageWidth: vp1.width,
        pageHeight: vp1.height,
      };

      await saveBook(newBook);
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
    await deleteBook(bookId);
    const remaining = await listBooks();
    setBooks(remaining);
    if (activeBook?.id === bookId) {
      const fallback = remaining[0];
      if (fallback) {
        await openStoredBook(fallback);
      } else {
        setActiveBook(null);
        setLoadedPdf(null);
      }
    }
  };

  // Helper to translate a single page with deduplication and auto-save to IndexedDB
  const translateSinglePageInternal = useCallback(
    async (
      book: StoredBook,
      pdf: LoadedPdf,
      pageNum: number,
      lang: LanguageCode,
      force = false
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

  // Translate currently visible page
  const handleTranslateCurrentPage = useCallback(
    async (force = false) => {
      if (!activeBook || !loadedPdf) return;
      setIsTranslatingPage(true);
      setTranslationError(null);
      try {
        const record = await translateSinglePageInternal(
          activeBook,
          loadedPdf,
          currentPage,
          targetLang,
          force
        );
        commitSavedTranslationToState(record);
      } catch (err) {
        setTranslationError(err instanceof Error ? err.message : 'Translation failed.');
      } finally {
        setIsTranslatingPage(false);
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

          // Steady wave size (4 pages) with gentle pacing avoids 429 bursts and runs smoothly to 100%
          const WAVE_SIZE = 4;
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
              await waitWithCancel(260);
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

  const sentences = useMemo(() => {
    if (!translatedPage) return [];
    return splitBlocksIntoSentences(
      translatedPage.blocks,
      translatedPage.imageExplanations
    );
  }, [translatedPage]);

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

  return (
    <div className="min-h-screen flex flex-col bg-[#FAF9F5] dark:bg-[#111110] text-stone-900 dark:text-stone-100">
      {/* Top 3-Zone Navigation Bar */}
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onUploadPdf={handleUploadPdf}
        isUploading={isUploading}
      />

      {/* Reader Workspace Utility Bar */}
      {activeTab === 'reader' && (
        <div className="no-print border-b border-stone-200 dark:border-stone-800 bg-[#F5F3EE] dark:bg-[#161513]">
          <div className="max-w-[1680px] mx-auto px-3 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2.5">
            {/* Left controls: Sidebar toggle + Language + Engine */}
            <div className="flex flex-wrap items-center gap-2">
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
                className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#1F1E1B] text-xs font-medium text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer whitespace-nowrap"
              >
                <PanelLeft className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Chapters</span>
              </button>

              {/* Target Language Selector */}
              <div className="inline-flex items-center gap-1.5">
                <Languages className="w-3.5 h-3.5 text-amber-700 dark:text-amber-500 hidden sm:block" />
                <select
                  aria-label="Target translation language"
                  value={targetLang}
                  onChange={(e) => setTargetLang(e.target.value as LanguageCode)}
                  className="h-8 px-2.5 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#1F1E1B] text-xs font-medium text-stone-900 dark:text-stone-100 focus:outline-none focus:border-amber-700 cursor-pointer"
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.name} ({l.nativeName})
                    </option>
                  ))}
                </select>
              </div>

              {/* Engine Selector (Free Open Default + Optional Smart AI) */}
              <div className="inline-flex rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#1F1E1B] p-0.5">
                <button
                  type="button"
                  onClick={() => setEngine('free')}
                  className={`h-7 px-2.5 rounded-sm text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
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
                  className={`inline-flex items-center gap-1 h-7 px-2.5 rounded-sm text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    engine === 'ai'
                      ? 'bg-amber-700 text-white'
                      : 'text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100'
                  }`}
                >
                  <Sparkles className="w-3 h-3" />
                  <span>Smart AI</span>
                </button>
              </div>

              {/* Technical Term Preservation, Auto-Save Next Toggle & Custom Glossary */}
              <div className="relative flex items-center gap-1.5">
                <label className="hidden md:inline-flex items-center gap-1.5 h-8 px-2.5 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#1F1E1B] text-xs text-stone-700 dark:text-stone-200 cursor-pointer select-none whitespace-nowrap">
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
                  className="hidden xl:inline-flex items-center gap-1.5 h-8 px-2.5 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#1F1E1B] text-xs text-stone-700 dark:text-stone-200 cursor-pointer select-none whitespace-nowrap"
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
                  title="Reading & translation preferences"
                  className="h-8 w-8 inline-flex items-center justify-center rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#1F1E1B] text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                </button>

                {showGlossaryPopover && (
                  <div className="absolute left-0 top-10 z-40 w-80 p-4 rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-[#1C1B19] shadow-lg space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-stone-900 dark:text-stone-100">
                        Translation &amp; Reading Preferences
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowGlossaryPopover(false)}
                        className="text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
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
                        rows={3}
                        value={customTermsInput}
                        onChange={(e) => setCustomTermsInput(e.target.value)}
                        className="w-full p-2 text-xs rounded border border-stone-300 dark:border-stone-700 bg-[#FAF9F5] dark:bg-[#141312] text-stone-900 dark:text-stone-100 focus:outline-none focus:border-amber-700"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Right controls: Fast Full-PDF Converter + Batch progress or Quick Translate + Theme toggle */}
            <div className="flex items-center gap-2">
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
                    className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded border border-amber-700/45 dark:border-amber-600/50 bg-white dark:bg-[#1F1E1B] text-xs font-medium text-amber-800 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Full PDF Fast</span>
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={() => setDarkMode((d) => !d)}
                aria-label={darkMode ? 'Switch to light reading paper' : 'Switch to dark theme'}
                className="h-8 w-8 inline-flex items-center justify-center rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#1F1E1B] text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
              >
                {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Mobile Single-Column Tabs (< lg) */}
          <div className="lg:hidden grid grid-cols-3 border-t border-stone-200 dark:border-stone-800 bg-[#FAF9F5] dark:bg-[#181715]">
            {[
              { id: 'pdf' as const, label: 'Original PDF' },
              { id: 'translated' as const, label: `${langOption.name} Reader` },
              { id: 'chapters' as const, label: 'Chapters' },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setMobilePane(tab.id)}
                className={`h-10 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
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
        {isInitializing ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 py-20 text-stone-600 dark:text-stone-400">
            <Loader2 className="w-6 h-6 animate-spin text-amber-700 dark:text-amber-500" />
            <p className="text-sm font-medium">
              Loading The OBS Superuser Guidebook & detecting chapters…
            </p>
          </div>
        ) : activeTab === 'library' ? (
          <LibraryView
            books={books}
            activeBookId={activeBook?.id ?? null}
            translatedCountsByBook={translatedCountsByBook}
            onSelectBook={async (book) => {
              await openStoredBook(book);
              setActiveTab('reader');
            }}
            onUploadPdf={handleUploadPdf}
            onDeleteBook={handleDeleteBook}
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
              Upload any illustrated PDF guidebook using the Upload PDF button above to start
              translating, listening, and exporting with the original cover preserved.
            </p>
          </div>
        ) : (
          /* Split-Screen Desktop / Tabbed Mobile Reader */
          <div className="flex-1 flex min-h-0 h-[calc(100vh-160px)]">
            {/* Desktop Collapsible Chapters Sidebar */}
            {sidebarOpen && (
              <div className="hidden lg:block w-[272px] shrink-0 h-full overflow-hidden">
                <ChapterSidebar
                  bookTitle={activeBook.title}
                  numPages={activeBook.numPages}
                  chapters={activeBook.chapters}
                  currentPage={currentPage}
                  translatedPageNumbers={translatedPageNumbers}
                  isSpeaking={isSpeaking}
                  isPreparingAudio={isPreparingAudio}
                  onSelectPage={setCurrentPage}
                  onPlayChapterAudio={handlePlayChapterAudio}
                  onTranslateChapter={handleTranslateChapter}
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
                className={`h-full overflow-hidden border-r border-stone-200 dark:border-stone-800 ${
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
                  onTranslateChapter={handleTranslateChapter}
                  onUpdateBlockText={handleUpdateBlockText}
                  onUpdateHighlights={handleUpdatePageHighlights}
                  onClickSentence={handleClickSentence}
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
          pageNumber={currentPage}
          numPages={activeBook.numPages}
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
          onRequestTranslatePage={() => handleTranslateCurrentPage(false)}
          aiAvailable={aiAvailable}
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
