import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  CheckCircle2,
  Download,
  FileAudio,
  FileText,
  Headphones,
  Image as ImageIcon,
  Languages,
  Loader2,
  PenTool,
  Printer,
  Sparkles,
  Square,
  Zap,
} from 'lucide-react';
import { getLanguageOption, LANGUAGES } from '../lib/languages';
import type { LoadedPdf } from '../lib/pdfEngine';
import {
  buildTranslatedScriptBlob,
  exportAnnotatedPageImage,
  exportAnnotatedPdf,
  exportTranslatedPdf,
} from '../lib/pdfExporter';
import {
  collectTranslatedChaptersForAudio,
  exportAudiobookZip,
  type AudiobookZipProgress,
} from '../lib/audiobookExporter';
import {
  buildAudiobookText,
  downloadBlob,
  synthesizePageAudio,
} from '../lib/translatorClient';
import type {
  BatchTranslationProgress,
  ChapterItem,
  LanguageCode,
  PageAnnotationLayer,
  StoredBook,
  TranslatedPageRecord,
  TranslationEngine,
} from '../types';

type ExportMode = 'translated' | 'annotated';
type ExportScope = 'current_page' | 'current_chapter' | 'all_translated';
type AnnotatedScope = 'all_annotated' | 'current_chapter_annotated' | 'current_page';

interface ExportViewProps {
  pdf: LoadedPdf | null;
  book: StoredBook | null;
  currentPage: number;
  currentChapter: ChapterItem | null;
  targetLang: LanguageCode;
  onChangeTargetLang: (lang: LanguageCode) => void;
  engine: TranslationEngine;
  onChangeEngine: (engine: TranslationEngine) => void;
  aiAvailable: boolean;
  translatedPages: TranslatedPageRecord[];
  batchProgress: BatchTranslationProgress | null;
  autoDownloadAfterFast?: boolean;
  onChangeAutoDownloadAfterFast?: (enabled: boolean) => void;
  onSyncExportPdfOptions?: (opts: {
    includeCover: boolean;
    includeFigures: boolean;
    includeOriginalSubheader: boolean;
  }) => void;
  autoPdfBuildProgress?: {
    current: number;
    total: number;
    status: string;
  } | null;
  readyAutoPdf?: {
    url: string;
    fileName: string;
    exportedPageCount: number;
    includeCover: boolean;
    waitingForFocus?: boolean;
  } | null;
  autoPdfError?: string | null;
  onDismissReadyAutoPdf?: () => void;
  onFastTranslateRange: (options: {
    startPage: number;
    endPage: number;
    label: string;
    autoDownloadPdfOptions?: {
      includeCover: boolean;
      includeFigures: boolean;
      includeOriginalSubheader: boolean;
    };
  }) => Promise<{
    records: TranslatedPageRecord[];
    cancelled: boolean;
    autoDownloaded?: boolean;
    autoDownloadFileName?: string;
  }>;
  onCancelBatch: () => void;
  onPreparePrintPages: (pages: TranslatedPageRecord[], includeCover: boolean) => void;
  onTranslateChapter: (chapter: ChapterItem) => void;
  onGoToReader: () => void;
}

export const ExportView: React.FC<ExportViewProps> = ({
  pdf,
  book,
  currentPage,
  currentChapter,
  targetLang,
  onChangeTargetLang,
  engine,
  onChangeEngine,
  aiAvailable,
  translatedPages,
  batchProgress,
  autoDownloadAfterFast: autoDownloadProp,
  onChangeAutoDownloadAfterFast,
  onSyncExportPdfOptions,
  autoPdfBuildProgress = null,
  readyAutoPdf = null,
  autoPdfError = null,
  onDismissReadyAutoPdf,
  onFastTranslateRange,
  onCancelBatch,
  onPreparePrintPages,
  onTranslateChapter,
  onGoToReader,
}) => {
  const [exportMode, setExportMode] = useState<ExportMode>('translated');

  // Translated Export State
  const [scope, setScope] = useState<ExportScope>('all_translated');
  const [includeCover, setIncludeCover] = useState(true);
  const [includeFigures, setIncludeFigures] = useState(true);
  const [includeOriginalSubheader, setIncludeOriginalSubheader] = useState(false);

  // Annotated Export State
  const [annotatedScope, setAnnotatedScope] = useState<AnnotatedScope>('all_annotated');
  const [annotatedIncludeCover, setAnnotatedIncludeCover] = useState(true);
  const [includeStickyPins, setIncludeStickyPins] = useState(true);
  const [includeStickyFootnotes, setIncludeStickyFootnotes] = useState(true);
  const [imageFormat, setImageFormat] = useState<'png' | 'jpeg'>('png');

  // Fast Full-PDF Converter Range State
  const [rangeMode, setRangeMode] = useState<'full' | 'custom'>('full');
  const [rangeStart, setRangeStart] = useState(1);
  const [rangeEnd, setRangeEnd] = useState(book?.numPages ?? 1);
  const [localAutoDownload, setLocalAutoDownload] = useState(true);
  const autoDownloadAfterFast = autoDownloadProp ?? localAutoDownload;
  const setAutoDownloadAfterFast = (checked: boolean) => {
    setLocalAutoDownload(checked);
    onChangeAutoDownloadAfterFast?.(checked);
  };

  useEffect(() => {
    onSyncExportPdfOptions?.({
      includeCover,
      includeFigures,
      includeOriginalSubheader,
    });
  }, [includeCover, includeFigures, includeOriginalSubheader, onSyncExportPdfOptions]);

  useEffect(() => {
    if (book) {
      setRangeStart(1);
      setRangeEnd(book.numPages);
    }
  }, [book?.id, book?.numPages]);

  // Shared Export Progress & Feedback
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{
    current: number;
    total: number;
    status: string;
  } | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [isExportingWav, setIsExportingWav] = useState(false);

  // Full Chapter Audiobook ZIP Export State
  const [isExportingAudiobookZip, setIsExportingAudiobookZip] = useState(false);
  const [audiobookZipProgress, setAudiobookZipProgress] =
    useState<AudiobookZipProgress | null>(null);
  const [includeAudiobookTranscripts, setIncludeAudiobookTranscripts] = useState(true);
  const [useAiAudiobookVoice, setUseAiAudiobookVoice] = useState(false);
  const audiobookAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      audiobookAbortRef.current?.abort();
    };
  }, []);

  const langOption = getLanguageOption(targetLang);

  const translatedChaptersForAudio = useMemo(() => {
    if (!book) return [];
    return collectTranslatedChaptersForAudio(book, translatedPages);
  }, [book, translatedPages]);

  const selectedPages = useMemo(() => {
    if (scope === 'current_page') {
      return translatedPages.filter((p) => p.pageNumber === currentPage);
    }
    if (scope === 'current_chapter' && currentChapter) {
      return translatedPages.filter(
        (p) =>
          p.pageNumber >= currentChapter.startPage &&
          p.pageNumber <= currentChapter.endPage
      );
    }
    return translatedPages;
  }, [scope, translatedPages, currentPage, currentChapter]);

  // All pages in the current book's metadata that have strokes or sticky notes
  const annotationsMap = useMemo<Record<number, PageAnnotationLayer>>(() => {
    return book?.annotations ?? {};
  }, [book?.annotations]);

  const allAnnotatedPageNumbers = useMemo(() => {
    return Object.entries(annotationsMap)
      .filter(([, layer]) => (layer.strokes?.length ?? 0) > 0 || (layer.notes?.length ?? 0) > 0)
      .map(([pg]) => Number(pg))
      .filter((n) => !Number.isNaN(n) && n >= 1)
      .sort((a, b) => a - b);
  }, [annotationsMap]);

  const selectedAnnotatedPages = useMemo(() => {
    if (annotatedScope === 'current_page') {
      return [currentPage];
    }
    if (annotatedScope === 'current_chapter_annotated' && currentChapter) {
      return allAnnotatedPageNumbers.filter(
        (p) => p >= currentChapter.startPage && p <= currentChapter.endPage
      );
    }
    return allAnnotatedPageNumbers;
  }, [annotatedScope, allAnnotatedPageNumbers, currentPage, currentChapter]);

  const annotatedSummary = useMemo(() => {
    let totalStrokes = 0;
    let totalNotes = 0;
    for (const pg of selectedAnnotatedPages) {
      const layer = annotationsMap[pg];
      if (!layer) continue;
      totalStrokes += layer.strokes?.length ?? 0;
      totalNotes += layer.notes?.length ?? 0;
    }
    return { totalStrokes, totalNotes };
  }, [selectedAnnotatedPages, annotationsMap]);

  if (!book) {
    return (
      <main className="max-w-4xl mx-auto px-6 py-16 text-center text-sm text-stone-500">
        Load or upload a PDF book to configure export options.
      </main>
    );
  }

  // Translated Export Handlers
  const buildAndDownloadTranslatedPdf = async (pagesToExport: TranslatedPageRecord[]) => {
    if (!pdf || !book || pagesToExport.length === 0) return;
    setIsExporting(true);
    setExportError(null);
    setExportNotice(null);
    try {
      const result = await exportTranslatedPdf({
        pdf,
        book,
        pages: pagesToExport,
        lang: targetLang,
        includeCover,
        includeFigures,
        includeOriginalSubheader,
        onProgress: (current, total, status) => {
          setExportProgress({ current, total, status });
        },
      });
      downloadBlob(result.blob, result.fileName);
      setExportNotice(
        `Downloaded ${result.fileName} (${result.exportedPageCount} PDF pages${
          includeCover ? ', including original Page 1 cover' : ''
        }).`
      );
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : 'PDF export encountered an error.'
      );
    } finally {
      setIsExporting(false);
      setExportProgress(null);
    }
  };

  const handleDownloadTranslatedPdf = async () => {
    await buildAndDownloadTranslatedPdf(selectedPages);
  };

  const handleRunFastConverter = async (
    customRange?: { startPage: number; endPage: number; label: string }
  ) => {
    if (!book || !pdf || batchProgress || isExporting || autoPdfBuildProgress) return;
    const clampedStart = customRange
      ? Math.max(1, Math.min(book.numPages, customRange.startPage))
      : rangeMode === 'full'
      ? 1
      : Math.max(1, Math.min(book.numPages, Math.floor(rangeStart) || 1));
    const clampedEnd = customRange
      ? Math.max(clampedStart, Math.min(book.numPages, customRange.endPage))
      : rangeMode === 'full'
      ? book.numPages
      : Math.max(clampedStart, Math.min(book.numPages, Math.floor(rangeEnd) || book.numPages));

    const rangeLabel =
      customRange?.label ??
      (clampedStart === 1 && clampedEnd === book.numPages
        ? `Full PDF (${book.numPages} pages)`
        : `Pages ${clampedStart}–${clampedEnd}`);

    setExportError(null);
    setExportNotice(null);
    onDismissReadyAutoPdf?.();

    try {
      const { records, cancelled, autoDownloaded, autoDownloadFileName } =
        await onFastTranslateRange({
          startPage: clampedStart,
          endPage: clampedEnd,
          label: rangeLabel,
          autoDownloadPdfOptions: {
            includeCover,
            includeFigures,
            includeOriginalSubheader,
          },
        });

      if (cancelled) {
        setExportNotice(
          `Paused — ${records.length} translated pages are saved in your browser. Click again anytime to resume.`
        );
        return;
      }

      if (autoDownloaded && autoDownloadFileName) {
        setExportNotice(
          `Converted & downloaded ${autoDownloadFileName} (${records.length} translated pages${
            includeCover ? ', including original Page 1 cover' : ''
          }).`
        );
      } else if (!autoDownloadAfterFast) {
        setExportNotice(
          `Fast-translated & saved ${records.length} pages in ${langOption.name}. Ready to read or download as PDF.`
        );
      }
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : 'Fast full-PDF translation encountered an error.'
      );
    }
  };

  const handlePrintUnicodePdf = () => {
    if (selectedPages.length === 0) return;
    onPreparePrintPages(selectedPages, includeCover);
    setTimeout(() => {
      window.print();
    }, 180);
  };

  const handleDownloadScript = () => {
    if (selectedPages.length === 0) return;
    const { blob, fileName } = buildTranslatedScriptBlob(
      book,
      selectedPages,
      targetLang
    );
    downloadBlob(blob, fileName);
    setExportNotice(`Downloaded audiobook script: ${fileName}`);
  };

  const handleDownloadAudioWav = async () => {
    const firstPage = selectedPages[0];
    if (!firstPage) return;
    const combinedText = selectedPages
      .slice(0, 3)
      .map((p) => buildAudiobookText(p))
      .join('\n\n')
      .slice(0, 3500);
    if (!combinedText.trim()) return;

    setIsExportingWav(true);
    setExportError(null);
    try {
      const { blob, ext } = await synthesizePageAudio({
        text: combinedText,
        voiceName: 'Kore',
        languageName: langOption.name,
        targetLang,
      });
      const slug = book.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 36);
      downloadBlob(blob, `${slug || 'audiobook'}-${targetLang}.${ext}`);
      setExportNotice(`Downloaded ${ext.toUpperCase()} audiobook clip.`);
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : 'WAV synthesis failed.'
      );
    } finally {
      setIsExportingWav(false);
    }
  };

  const handleExportAudiobookZip = async () => {
    if (!book || translatedChaptersForAudio.length === 0 || isExportingAudiobookZip) return;

    const controller = new AbortController();
    audiobookAbortRef.current = controller;
    setIsExportingAudiobookZip(true);
    setAudiobookZipProgress({
      chapterIndex: 1,
      totalChapters: translatedChaptersForAudio.length,
      chapterTitle: translatedChaptersForAudio[0].chapter.title,
      chunkIndex: 1,
      totalChunks: 1,
      overallPercent: 2,
      status: 'Preparing translated chapters for audiobook synthesis…',
    });
    setExportError(null);
    setExportNotice(null);

    try {
      const result = await exportAudiobookZip({
        book,
        translatedPages,
        targetLang,
        useAiVoice: aiAvailable && useAiAudiobookVoice,
        aiVoiceName: 'Kore',
        includeTranscripts: includeAudiobookTranscripts,
        signal: controller.signal,
        onProgress: (prog) => setAudiobookZipProgress(prog),
      });

      downloadBlob(result.blob, result.fileName);
      setExportNotice(
        `Downloaded ${result.fileName} (${result.chapterCount} translated ${
          result.chapterCount === 1 ? 'chapter' : 'chapters'
        } as .${result.audioExt} tracks + playlist.m3u).`
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setExportNotice('Audiobook ZIP export cancelled.');
      } else {
        setExportError(
          err instanceof Error ? err.message : 'Audiobook ZIP export encountered an error.'
        );
      }
    } finally {
      audiobookAbortRef.current = null;
      setIsExportingAudiobookZip(false);
      setAudiobookZipProgress(null);
    }
  };

  const handleCancelAudiobookZip = () => {
    audiobookAbortRef.current?.abort();
  };

  // Annotated Pages Export Handlers
  const handleDownloadAnnotatedPdf = async () => {
    if (!pdf || selectedAnnotatedPages.length === 0) return;
    setIsExporting(true);
    setExportError(null);
    setExportNotice(null);
    try {
      const result = await exportAnnotatedPdf({
        pdf,
        book,
        pageNumbers: selectedAnnotatedPages,
        annotationsMap,
        includeCover: annotatedIncludeCover,
        includeNotes: includeStickyPins,
        includeNoteText: includeStickyPins && includeStickyFootnotes,
        onProgress: (current, total, status) => {
          setExportProgress({ current, total, status });
        },
      });
      downloadBlob(result.blob, result.fileName);
      setExportNotice(
        `Downloaded ${result.fileName} (${result.exportedPageCount} pages with custom highlights, drawings, and notes).`
      );
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : 'Annotated PDF export failed.'
      );
    } finally {
      setIsExporting(false);
      setExportProgress(null);
    }
  };

  const handleDownloadAnnotatedImages = async () => {
    if (!pdf || selectedAnnotatedPages.length === 0) return;
    setIsExporting(true);
    setExportError(null);
    setExportNotice(null);
    try {
      const total = selectedAnnotatedPages.length;
      for (let i = 0; i < total; i++) {
        const pageNum = selectedAnnotatedPages[i];
        setExportProgress({
          current: i,
          total,
          status: `Rendering Page ${pageNum} as ${imageFormat.toUpperCase()}...`,
        });
        const { blob, fileName } = await exportAnnotatedPageImage({
          pdf,
          bookTitle: book.title,
          pageNumber: pageNum,
          layer: annotationsMap[pageNum],
          format: imageFormat,
          includeNotes: includeStickyPins,
          includeNoteText: includeStickyPins && includeStickyFootnotes,
        });
        downloadBlob(blob, fileName);
        if (i < total - 1) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      setExportProgress({ current: total, total, status: 'Done' });
      setExportNotice(
        `Exported ${total} annotated ${total === 1 ? 'page' : 'pages'} as ${imageFormat.toUpperCase()} ${
          total === 1 ? 'image' : 'images'
        }.`
      );
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : 'Annotated image export failed.'
      );
    } finally {
      setIsExporting(false);
      setExportProgress(null);
    }
  };

  const figureTotal = selectedPages.reduce((sum, p) => sum + p.figures.length, 0);
  const coverActive =
    exportMode === 'translated' ? includeCover : annotatedIncludeCover;

  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
      <div className="border-b border-stone-200 dark:border-stone-800 pb-5 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-semibold tracking-tight text-stone-950 dark:text-stone-50">
            Export Studio
          </h1>
          <p className="mt-1.5 text-sm text-stone-600 dark:text-stone-400">
            {exportMode === 'translated' ? (
              <>
                Rebuilds your translated book in{' '}
                <span className="font-medium text-stone-900 dark:text-stone-200">
                  {langOption.name} ({langOption.nativeName})
                </span>{' '}
                with Page 1 retained untouched, embedded Indic/Urdu shaping, and inline diagrams.
              </>
            ) : (
              'Export your marked-up PDF pages with highlights, freehand drawings, and sticky notes flattened into high-resolution PNG/JPEG images or a new PDF document.'
            )}
          </p>
        </div>

        {/* Mode Switcher */}
        <div className="inline-flex rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#191816] p-0.5 shrink-0 self-start sm:self-auto">
          <button
            type="button"
            onClick={() => {
              setExportMode('translated');
              setExportNotice(null);
              setExportError(null);
            }}
            className={`h-8 px-3 rounded text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
              exportMode === 'translated'
                ? 'bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-950'
                : 'text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100'
            }`}
          >
            Translated Edition ({translatedPages.length})
          </button>
          <button
            type="button"
            onClick={() => {
              setExportMode('annotated');
              setExportNotice(null);
              setExportError(null);
            }}
            className={`inline-flex items-center gap-1.5 h-8 px-3 rounded text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
              exportMode === 'annotated'
                ? 'bg-amber-700 text-white'
                : 'text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100'
            }`}
          >
            <PenTool className="w-3.5 h-3.5" />
            <span>Annotated Pages ({allAnnotatedPageNumbers.length})</span>
          </button>
        </div>
      </div>

      <div className="mt-8 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left: Cover Page Preview & Coverage Summary */}
        <div className="lg:col-span-4 space-y-4">
          <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-[#191816] p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
              Page 1 Cover Preview
            </p>
            <div className="mt-3 aspect-[6/9] max-h-80 mx-auto rounded-sm overflow-hidden bg-[#F1EFEA] dark:bg-[#121110] border border-stone-200 dark:border-stone-700 flex items-center justify-center">
              {book.coverDataUrl ? (
                <img
                  src={book.coverDataUrl}
                  alt="Original book cover"
                  className={`w-full h-full object-contain transition-opacity ${
                    coverActive ? 'opacity-100' : 'opacity-30 grayscale'
                  }`}
                />
              ) : (
                <span className="text-xs text-stone-400">No cover preview</span>
              )}
            </div>

            {exportMode === 'translated' ? (
              <div className="mt-4 pt-4 border-t border-stone-200/80 dark:border-stone-800/80 space-y-1.5 text-xs text-stone-600 dark:text-stone-400 font-mono-num">
                <div className="flex justify-between">
                  <span>Translated pages cached</span>
                  <span className="font-semibold text-stone-900 dark:text-stone-100">
                    {translatedPages.length} / {book.numPages}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Selected for export</span>
                  <span className="font-semibold text-stone-900 dark:text-stone-100">
                    {selectedPages.length} {selectedPages.length === 1 ? 'page' : 'pages'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Embedded diagrams</span>
                  <span className="font-semibold text-stone-900 dark:text-stone-100">
                    {figureTotal}
                  </span>
                </div>
              </div>
            ) : (
              <div className="mt-4 pt-4 border-t border-stone-200/80 dark:border-stone-800/80 space-y-1.5 text-xs text-stone-600 dark:text-stone-400 font-mono-num">
                <div className="flex justify-between">
                  <span>Annotated pages saved</span>
                  <span className="font-semibold text-stone-900 dark:text-stone-100">
                    {allAnnotatedPageNumbers.length} / {book.numPages}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Selected for export</span>
                  <span className="font-semibold text-stone-900 dark:text-stone-100">
                    {selectedAnnotatedPages.length}{' '}
                    {selectedAnnotatedPages.length === 1 ? 'page' : 'pages'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Canvas strokes · Notes</span>
                  <span className="font-semibold text-stone-900 dark:text-stone-100">
                    {annotatedSummary.totalStrokes} · {annotatedSummary.totalNotes}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: Export Configuration & Actions */}
        <div className="lg:col-span-8 space-y-6">
          {exportMode === 'translated' ? (
            <>
              {/* Fast Full-PDF Page Converter Card */}
              <div className="rounded-lg border border-amber-700/35 dark:border-amber-600/40 bg-white dark:bg-[#191816] p-5 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Zap className="w-4 h-4 text-amber-700 dark:text-amber-500 shrink-0" />
                      <h2 className="text-sm font-semibold text-stone-950 dark:text-stone-50">
                        Fast Full-PDF Converter
                      </h2>
                    </div>
                    <p className="mt-1 text-xs text-stone-600 dark:text-stone-400">
                      Translates pages in parallel multi-page batches, skips already saved pages,
                      and converts the full book into a cover-preserved {langOption.name} PDF.
                    </p>
                  </div>

                  <span className="text-xs font-mono-num text-stone-600 dark:text-stone-300 shrink-0">
                    {translatedPages.length} / {book.numPages} saved (
                    {Math.round((translatedPages.length / Math.max(1, book.numPages)) * 100)}%)
                  </span>
                </div>

                {/* Coverage Progress Track */}
                <div className="h-1.5 w-full rounded-full bg-stone-200 dark:bg-stone-800 overflow-hidden">
                  <div
                    className="h-full bg-amber-700 dark:bg-amber-500 transition-all duration-300"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.round((translatedPages.length / Math.max(1, book.numPages)) * 100)
                      )}%`,
                    }}
                  />
                </div>

                {/* Language, Engine & Page Range Controls */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-stone-500 dark:text-stone-400 mb-1">
                      Target Language
                    </label>
                    <div className="relative flex items-center">
                      <Languages className="w-3.5 h-3.5 text-amber-700 dark:text-amber-500 absolute left-2.5 pointer-events-none" />
                      <select
                        aria-label="Converter target language"
                        disabled={Boolean(batchProgress)}
                        value={targetLang}
                        onChange={(e) => onChangeTargetLang(e.target.value as LanguageCode)}
                        className="w-full h-9 pl-8 pr-2.5 rounded border border-stone-300 dark:border-stone-700 bg-[#FAF9F5] dark:bg-[#141312] text-xs font-medium text-stone-900 dark:text-stone-100 focus:outline-none focus:border-amber-700 disabled:opacity-50 cursor-pointer"
                      >
                        {LANGUAGES.map((l) => (
                          <option key={l.code} value={l.code}>
                            {l.name} ({l.nativeName})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-stone-500 dark:text-stone-400 mb-1">
                      Translation Speed Engine
                    </label>
                    <div className="inline-flex w-full rounded border border-stone-300 dark:border-stone-700 bg-[#FAF9F5] dark:bg-[#141312] p-0.5 h-9">
                      <button
                        type="button"
                        disabled={Boolean(batchProgress)}
                        onClick={() => onChangeEngine('free')}
                        className={`flex-1 rounded-sm text-xs font-medium transition-colors cursor-pointer disabled:opacity-50 ${
                          engine === 'free'
                            ? 'bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-950'
                            : 'text-stone-600 dark:text-stone-300'
                        }`}
                      >
                        Free Fast
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(batchProgress)}
                        onClick={() => onChangeEngine('ai')}
                        title={
                          aiAvailable
                            ? 'Uses Gemini AI with diagram notes'
                            : 'Requires GEMINI_API_KEY in Settings > Secrets'
                        }
                        className={`flex-1 inline-flex items-center justify-center gap-1 rounded-sm text-xs font-medium transition-colors cursor-pointer disabled:opacity-50 ${
                          engine === 'ai'
                            ? 'bg-amber-700 text-white'
                            : 'text-stone-600 dark:text-stone-300'
                        }`}
                      >
                        <Sparkles className="w-3 h-3" />
                        <span>Smart AI</span>
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-stone-500 dark:text-stone-400 mb-1">
                      Page Range
                    </label>
                    <div className="inline-flex w-full rounded border border-stone-300 dark:border-stone-700 bg-[#FAF9F5] dark:bg-[#141312] p-0.5 h-9">
                      <button
                        type="button"
                        disabled={Boolean(batchProgress)}
                        onClick={() => setRangeMode('full')}
                        className={`flex-1 rounded-sm text-xs font-medium transition-colors cursor-pointer disabled:opacity-50 ${
                          rangeMode === 'full'
                            ? 'bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-950'
                            : 'text-stone-600 dark:text-stone-300'
                        }`}
                      >
                        All ({book.numPages}p)
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(batchProgress)}
                        onClick={() => setRangeMode('custom')}
                        className={`flex-1 rounded-sm text-xs font-medium transition-colors cursor-pointer disabled:opacity-50 ${
                          rangeMode === 'custom'
                            ? 'bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-950'
                            : 'text-stone-600 dark:text-stone-300'
                        }`}
                      >
                        Custom
                      </button>
                    </div>
                  </div>
                </div>

                {rangeMode === 'custom' && (
                  <div className="flex flex-wrap items-center gap-2.5 text-xs text-stone-700 dark:text-stone-300 pt-1">
                    <span>From page</span>
                    <input
                      type="number"
                      min={1}
                      max={book.numPages}
                      value={rangeStart}
                      disabled={Boolean(batchProgress)}
                      onChange={(e) =>
                        setRangeStart(
                          Math.max(1, Math.min(book.numPages, parseInt(e.target.value, 10) || 1))
                        )
                      }
                      className="w-20 h-8 px-2 font-mono-num rounded border border-stone-300 dark:border-stone-700 bg-[#FAF9F5] dark:bg-[#141312] text-stone-900 dark:text-stone-100 focus:outline-none focus:border-amber-700"
                    />
                    <span>to</span>
                    <input
                      type="number"
                      min={rangeStart}
                      max={book.numPages}
                      value={rangeEnd}
                      disabled={Boolean(batchProgress)}
                      onChange={(e) =>
                        setRangeEnd(
                          Math.max(
                            rangeStart,
                            Math.min(book.numPages, parseInt(e.target.value, 10) || book.numPages)
                          )
                        )
                      }
                      className="w-20 h-8 px-2 font-mono-num rounded border border-stone-300 dark:border-stone-700 bg-[#FAF9F5] dark:bg-[#141312] text-stone-900 dark:text-stone-100 focus:outline-none focus:border-amber-700"
                    />
                    <span className="font-mono-num text-stone-500 dark:text-stone-400">
                      ({Math.max(1, rangeEnd - rangeStart + 1)} pages)
                    </span>
                  </div>
                )}

                {/* Live Fast Batch Progress */}
                {batchProgress ? (
                  <div className="p-3.5 rounded-md border border-amber-700/40 bg-amber-50/70 dark:bg-amber-950/25 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="inline-flex items-center gap-2 font-medium text-stone-900 dark:text-stone-100">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-700 dark:text-amber-400" />
                        <span>
                          Fast-translating {batchProgress.label} · p.{batchProgress.currentPage}
                        </span>
                      </span>
                      <div className="flex items-center gap-3 font-mono-num text-stone-700 dark:text-stone-300">
                        <span>
                          {batchProgress.current}/{batchProgress.total} (
                          {Math.round(
                            (batchProgress.current / Math.max(1, batchProgress.total)) * 100
                          )}
                          %)
                        </span>
                        {(() => {
                          const elapsedSec = Math.max(
                            0.5,
                            (Date.now() - batchProgress.startedAt) / 1000
                          );
                          const pagesPerSec = batchProgress.newlyTranslated / elapsedSec;
                          const remaining = Math.max(
                            0,
                            batchProgress.total - batchProgress.current
                          );
                          const etaSec =
                            pagesPerSec > 0.05 ? Math.ceil(remaining / pagesPerSec) : null;
                          return (
                            <>
                              <span className="hidden sm:inline text-stone-500 dark:text-stone-400">
                                {pagesPerSec > 0 ? `${pagesPerSec.toFixed(1)} p/s` : 'starting…'}
                                {etaSec !== null && etaSec > 0
                                  ? ` · ~${etaSec >= 60 ? `${Math.ceil(etaSec / 60)}m` : `${etaSec}s`} left`
                                  : ''}
                              </span>
                            </>
                          );
                        })()}
                        <button
                          type="button"
                          onClick={onCancelBatch}
                          className="inline-flex items-center gap-1 text-red-700 dark:text-red-400 font-medium hover:underline cursor-pointer"
                        >
                          <Square className="w-3 h-3" />
                          Pause
                        </button>
                      </div>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-amber-200/80 dark:bg-amber-950 overflow-hidden">
                      <div
                        className="h-full bg-amber-700 dark:bg-amber-500 transition-all duration-200"
                        style={{
                          width: `${Math.round(
                            (batchProgress.current / Math.max(1, batchProgress.total)) * 100
                          )}%`,
                        }}
                      />
                    </div>
                    <p className="text-[11px] text-stone-600 dark:text-stone-400">
                      {batchProgress.statusNote
                        ? batchProgress.statusNote
                        : 'Continuous auto-retry & auto-save active — runs automatically to 100%.'}
                    </p>
                    <label className="pt-1 inline-flex items-center gap-2 text-xs text-stone-700 dark:text-stone-300 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={autoDownloadAfterFast}
                        onChange={(e) => setAutoDownloadAfterFast(e.target.checked)}
                        className="rounded accent-amber-700"
                      />
                      <span>Auto-download converted PDF when translation finishes</span>
                    </label>
                  </div>
                ) : autoPdfBuildProgress ? (
                  <div className="p-3.5 rounded-md border border-amber-700/40 bg-amber-50/70 dark:bg-amber-950/25 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="inline-flex items-center gap-2 font-medium text-stone-900 dark:text-stone-100">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-700 dark:text-amber-400" />
                        <span>{autoPdfBuildProgress.status}</span>
                      </span>
                      <span className="font-mono-num text-stone-700 dark:text-stone-300">
                        {autoPdfBuildProgress.current}/{autoPdfBuildProgress.total} (
                        {Math.round(
                          (autoPdfBuildProgress.current /
                            Math.max(1, autoPdfBuildProgress.total)) *
                            100
                        )}
                        %)
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-amber-200/80 dark:bg-amber-950 overflow-hidden">
                      <div
                        className="h-full bg-amber-700 dark:bg-amber-500 transition-all duration-200"
                        style={{
                          width: `${Math.round(
                            (autoPdfBuildProgress.current /
                              Math.max(1, autoPdfBuildProgress.total)) *
                              100
                          )}%`,
                        }}
                      />
                    </div>
                    <p className="text-[11px] text-stone-600 dark:text-stone-400">
                      Translation complete — automatically packaging and downloading your converted PDF…
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3 pt-1">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <label className="inline-flex items-center gap-2 text-xs text-stone-700 dark:text-stone-300 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={autoDownloadAfterFast}
                          onChange={(e) => setAutoDownloadAfterFast(e.target.checked)}
                          className="rounded accent-amber-700"
                        />
                        <span>Auto-download converted PDF when translation finishes</span>
                      </label>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={!pdf || isExporting || Boolean(autoPdfBuildProgress)}
                          onClick={() => handleRunFastConverter()}
                          className="inline-flex items-center gap-2 h-10 px-4 rounded-md text-xs sm:text-sm font-medium bg-amber-700 hover:bg-amber-800 text-white disabled:opacity-45 transition-colors cursor-pointer whitespace-nowrap"
                        >
                          <Zap className="w-4 h-4" />
                          <span>
                            {rangeMode === 'full' &&
                            translatedPages.length > 0 &&
                            translatedPages.length < book.numPages
                              ? autoDownloadAfterFast
                                ? `Resume & Convert Full PDF (${book.numPages - translatedPages.length}p left)`
                                : `Resume Fast Translate (${book.numPages - translatedPages.length}p left)`
                              : autoDownloadAfterFast
                              ? rangeMode === 'full'
                                ? `Fast Translate & Convert Full PDF (${book.numPages}p)`
                                : `Fast Translate & Convert p.${rangeStart}–${rangeEnd}`
                              : rangeMode === 'full'
                              ? `Fast Translate All ${book.numPages} Pages`
                              : `Fast Translate p.${rangeStart}–${rangeEnd}`}
                          </span>
                        </button>

                        {currentChapter && translatedPages.length === 0 && (
                          <button
                            type="button"
                            disabled={!pdf || isExporting || Boolean(autoPdfBuildProgress)}
                            onClick={() => {
                              if (autoDownloadAfterFast) {
                                void handleRunFastConverter({
                                  startPage: currentChapter.startPage,
                                  endPage: currentChapter.endPage,
                                  label: currentChapter.title,
                                });
                              } else {
                                onTranslateChapter(currentChapter);
                              }
                            }}
                            className="h-10 px-3 rounded-md text-xs font-medium border border-stone-300 dark:border-stone-700 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer whitespace-nowrap"
                          >
                            Chapter Only ({currentChapter.endPage - currentChapter.startPage + 1}p)
                          </button>
                        )}
                      </div>
                    </div>

                    {readyAutoPdf && (
                      <div className="p-3 rounded-md border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/75 dark:bg-emerald-950/30 flex flex-wrap items-center justify-between gap-2.5 text-xs text-emerald-900 dark:text-emerald-200">
                        <span className="inline-flex items-center gap-2 min-w-0">
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                          <span className="truncate">
                            PDF ready ({readyAutoPdf.exportedPageCount} pages):{' '}
                            <strong>{readyAutoPdf.fileName}</strong>
                          </span>
                        </span>
                        <a
                          href={readyAutoPdf.url}
                          download={readyAutoPdf.fileName}
                          className="inline-flex items-center gap-1.5 h-8 px-3 rounded bg-emerald-700 hover:bg-emerald-800 text-white font-medium transition-colors shrink-0"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Save PDF Again</span>
                        </a>
                      </div>
                    )}

                    {autoPdfError && (
                      <div className="p-3 rounded-md border border-red-200 dark:border-red-900/60 bg-red-50/70 dark:bg-red-950/30 text-xs text-red-800 dark:text-red-300">
                        {autoPdfError}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Translated Scope & Layout Options */}
              <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-[#191816] p-5 space-y-4">
                <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                  1. Export Scope
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {[
                    {
                      id: 'all_translated' as const,
                      title: 'All Translated Pages',
                      sub: `${translatedPages.length} pages ready`,
                    },
                    {
                      id: 'current_chapter' as const,
                      title: 'Current Chapter',
                      sub: currentChapter
                        ? `p.${currentChapter.startPage}–${currentChapter.endPage}`
                        : 'None active',
                    },
                    {
                      id: 'current_page' as const,
                      title: `Current Page (p.${currentPage})`,
                      sub: translatedPages.some((p) => p.pageNumber === currentPage)
                        ? 'Ready'
                        : 'Not translated yet',
                    },
                  ].map((opt) => {
                    const active = scope === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setScope(opt.id)}
                        className={`p-3.5 rounded-md border text-left transition-colors cursor-pointer ${
                          active
                            ? 'border-amber-700 dark:border-amber-500 bg-amber-50/50 dark:bg-amber-950/20'
                            : 'border-stone-200 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-800/40'
                        }`}
                      >
                        <p className="text-xs font-semibold text-stone-900 dark:text-stone-100">
                          {opt.title}
                        </p>
                        <p className="mt-0.5 text-[11px] font-mono-num text-stone-500 dark:text-stone-400">
                          {opt.sub}
                        </p>
                      </button>
                    );
                  })}
                </div>

                <div className="pt-4 border-t border-stone-200/80 dark:border-stone-800/80 space-y-3">
                  <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                    2. Layout & Typography Preservation
                  </h2>

                  <label className="flex items-start gap-2.5 text-sm text-stone-700 dark:text-stone-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeCover}
                      onChange={(e) => setIncludeCover(e.target.checked)}
                      className="mt-1 rounded accent-amber-700"
                    />
                    <span>
                      <strong className="font-medium text-stone-900 dark:text-stone-100">
                        Retain Original Full-Bleed Cover Page (Page 1)
                      </strong>
                      <span className="block text-xs text-stone-500 dark:text-stone-400">
                        Extracts original Page 1 at high DPI and places it untouched as Page 1 of
                        the exported PDF.
                      </span>
                    </span>
                  </label>

                  <label className="flex items-start gap-2.5 text-sm text-stone-700 dark:text-stone-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeFigures}
                      onChange={(e) => setIncludeFigures(e.target.checked)}
                      className="mt-1 rounded accent-amber-700"
                    />
                    <span>
                      <strong className="font-medium text-stone-900 dark:text-stone-100">
                        Keep Original Screenshots & Diagrams Inline
                      </strong>
                      <span className="block text-xs text-stone-500 dark:text-stone-400">
                        Places cropped diagrams and UI screenshots in their original relative
                        positions between translated paragraphs.
                      </span>
                    </span>
                  </label>

                  <label className="flex items-start gap-2.5 text-sm text-stone-700 dark:text-stone-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeOriginalSubheader}
                      onChange={(e) => setIncludeOriginalSubheader(e.target.checked)}
                      className="mt-1 rounded accent-amber-700"
                    />
                    <span>
                      <strong className="font-medium text-stone-900 dark:text-stone-100">
                        Include Original English Heading Reference
                      </strong>
                      <span className="block text-xs text-stone-500 dark:text-stone-400">
                        Prints the original English chapter/section heading subtly beneath
                        translated headings for technical clarity.
                      </span>
                    </span>
                  </label>
                </div>
              </div>

              {/* Export Audiobook (.zip) Card — All Translated Chapters */}
              <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-[#191816] p-5 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Headphones className="w-4 h-4 text-amber-700 dark:text-amber-500 shrink-0" />
                      <h2 className="text-sm font-semibold text-stone-950 dark:text-stone-50">
                        3. Export Audiobook (.zip)
                      </h2>
                    </div>
                    <p className="mt-1 text-xs text-stone-600 dark:text-stone-400">
                      Generates a downloadable ZIP archive containing numbered audio tracks for all
                      translated chapters in {langOption.name}, plus an M3U playlist.
                    </p>
                  </div>

                  <span className="text-xs font-mono-num text-stone-600 dark:text-stone-300 shrink-0">
                    {translatedChaptersForAudio.length} / {Math.max(1, book.chapters.length)}{' '}
                    {translatedChaptersForAudio.length === 1 ? 'chapter' : 'chapters'} ready
                  </span>
                </div>

                {translatedChaptersForAudio.length > 0 ? (
                  <>
                    <div className="rounded-md border border-stone-200/80 dark:border-stone-800 bg-[#FAF9F5] dark:bg-[#141312] max-h-40 overflow-y-auto divide-y divide-stone-200/70 dark:divide-stone-800/80">
                      {translatedChaptersForAudio.map((entry) => (
                        <div
                          key={entry.chapter.id}
                          className="px-3 py-2 flex items-center justify-between gap-3 text-xs"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-mono-num text-[11px] text-amber-700 dark:text-amber-400 shrink-0">
                              {String(entry.trackNumber).padStart(2, '0')}
                            </span>
                            <span className="text-stone-800 dark:text-stone-200 truncate font-medium">
                              {entry.chapter.title}
                            </span>
                          </div>
                          <span className="font-mono-num text-[11px] text-stone-500 dark:text-stone-400 shrink-0">
                            {entry.translatedPages.length}/{entry.totalChapterPages}p ·{' '}
                            {entry.wordCount.toLocaleString()} words
                          </span>
                        </div>
                      ))}
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <label className="inline-flex items-center gap-2 text-xs text-stone-700 dark:text-stone-300 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={includeAudiobookTranscripts}
                          disabled={isExportingAudiobookZip}
                          onChange={(e) => setIncludeAudiobookTranscripts(e.target.checked)}
                          className="rounded accent-amber-700"
                        />
                        <span>Include chapter text transcripts (.txt) &amp; playlist (.m3u)</span>
                      </label>

                      {aiAvailable && (
                        <div className="inline-flex rounded border border-stone-300 dark:border-stone-700 bg-[#FAF9F5] dark:bg-[#141312] p-0.5">
                          <button
                            type="button"
                            disabled={isExportingAudiobookZip}
                            onClick={() => setUseAiAudiobookVoice(false)}
                            className={`h-7 px-2.5 rounded-sm text-xs font-medium cursor-pointer disabled:opacity-50 ${
                              !useAiAudiobookVoice
                                ? 'bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-950'
                                : 'text-stone-600 dark:text-stone-300'
                            }`}
                          >
                            Free MP3
                          </button>
                          <button
                            type="button"
                            disabled={isExportingAudiobookZip}
                            onClick={() => setUseAiAudiobookVoice(true)}
                            className={`inline-flex items-center gap-1 h-7 px-2.5 rounded-sm text-xs font-medium cursor-pointer disabled:opacity-50 ${
                              useAiAudiobookVoice
                                ? 'bg-amber-700 text-white'
                                : 'text-stone-600 dark:text-stone-300'
                            }`}
                          >
                            <Sparkles className="w-3 h-3" />
                            <span>Studio AI</span>
                          </button>
                        </div>
                      )}
                    </div>

                    {audiobookZipProgress ? (
                      <div className="p-3.5 rounded-md border border-amber-700/40 bg-amber-50/70 dark:bg-amber-950/25 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <span className="inline-flex items-center gap-2 font-medium text-stone-900 dark:text-stone-100 min-w-0">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-700 dark:text-amber-400 shrink-0" />
                            <span className="truncate">{audiobookZipProgress.status}</span>
                          </span>
                          <div className="flex items-center gap-3 font-mono-num text-stone-700 dark:text-stone-300 shrink-0">
                            <span>{audiobookZipProgress.overallPercent}%</span>
                            <button
                              type="button"
                              onClick={handleCancelAudiobookZip}
                              className="inline-flex items-center gap-1 text-red-700 dark:text-red-400 font-medium hover:underline cursor-pointer"
                            >
                              <Square className="w-3 h-3" />
                              Cancel
                            </button>
                          </div>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-amber-200/80 dark:bg-amber-950 overflow-hidden">
                          <div
                            className="h-full bg-amber-700 dark:bg-amber-500 transition-all duration-200"
                            style={{ width: `${audiobookZipProgress.overallPercent}%` }}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                        <span className="text-[11px] text-stone-500 dark:text-stone-400">
                          Each translated chapter is exported as its own numbered .
                          {aiAvailable && useAiAudiobookVoice ? 'wav' : 'mp3'} audio file.
                        </span>
                        <button
                          type="button"
                          disabled={
                            isExportingAudiobookZip ||
                            isExporting ||
                            Boolean(batchProgress) ||
                            translatedChaptersForAudio.length === 0
                          }
                          onClick={handleExportAudiobookZip}
                          className="inline-flex items-center gap-2 h-10 px-4 rounded-md text-xs sm:text-sm font-medium bg-stone-900 hover:bg-stone-800 text-stone-50 dark:bg-stone-100 dark:hover:bg-stone-200 dark:text-stone-950 disabled:opacity-45 transition-colors cursor-pointer whitespace-nowrap"
                        >
                          <Archive className="w-4 h-4" />
                          <span>
                            Export Audiobook (.zip · {translatedChaptersForAudio.length}{' '}
                            {translatedChaptersForAudio.length === 1 ? 'chapter' : 'chapters'})
                          </span>
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-stone-500 dark:text-stone-400">
                    Translate one or more chapters using the Fast Full-PDF Converter above or in
                    the Reader to generate a chapter-by-chapter Audiobook ZIP.
                  </p>
                )}
              </div>
            </>
          ) : (
            /* Annotated PDF & Image Export Controls */
            <>
              {allAnnotatedPageNumbers.length === 0 && (
                <div className="p-5 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-[#191816] text-sm text-stone-700 dark:text-stone-300">
                  <p className="font-medium text-stone-900 dark:text-stone-100">
                    No marked-up pages saved yet
                  </p>
                  <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                    Use the Highlight, Draw, or Note tools over the Original PDF pane to annotate
                    diagrams. You can still export the current page (p.{currentPage}) right now by
                    selecting Current Page below.
                  </p>
                  <button
                    type="button"
                    onClick={onGoToReader}
                    className="mt-3 h-8 px-3 rounded text-xs font-medium bg-stone-900 text-stone-50 hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-950 cursor-pointer"
                  >
                    Annotate in Reader
                  </button>
                </div>
              )}

              <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-[#191816] p-5 space-y-4">
                <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                  1. Select Pages to Export
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {[
                    {
                      id: 'all_annotated' as const,
                      title: 'All Annotated Pages',
                      sub:
                        allAnnotatedPageNumbers.length > 0
                          ? `p.${allAnnotatedPageNumbers.slice(0, 4).join(', ')}${
                              allAnnotatedPageNumbers.length > 4 ? '…' : ''
                            }`
                          : '0 pages marked up',
                    },
                    {
                      id: 'current_chapter_annotated' as const,
                      title: 'Current Chapter',
                      sub: currentChapter
                        ? `p.${currentChapter.startPage}–${currentChapter.endPage}`
                        : 'None active',
                    },
                    {
                      id: 'current_page' as const,
                      title: `Current Page (p.${currentPage})`,
                      sub: annotationsMap[currentPage]
                        ? `${annotationsMap[currentPage].strokes.length} strokes · ${annotationsMap[currentPage].notes.length} notes`
                        : 'No markup yet',
                    },
                  ].map((opt) => {
                    const active = annotatedScope === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setAnnotatedScope(opt.id)}
                        className={`p-3.5 rounded-md border text-left transition-colors cursor-pointer ${
                          active
                            ? 'border-amber-700 dark:border-amber-500 bg-amber-50/50 dark:bg-amber-950/20'
                            : 'border-stone-200 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-800/40'
                        }`}
                      >
                        <p className="text-xs font-semibold text-stone-900 dark:text-stone-100">
                          {opt.title}
                        </p>
                        <p className="mt-0.5 text-[11px] font-mono-num text-stone-500 dark:text-stone-400 truncate">
                          {opt.sub}
                        </p>
                      </button>
                    );
                  })}
                </div>

                <div className="pt-4 border-t border-stone-200/80 dark:border-stone-800/80 space-y-3">
                  <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                    2. Annotation Layer & Output Format
                  </h2>

                  <label className="flex items-start gap-2.5 text-sm text-stone-700 dark:text-stone-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={annotatedIncludeCover}
                      onChange={(e) => setAnnotatedIncludeCover(e.target.checked)}
                      className="mt-1 rounded accent-amber-700"
                    />
                    <span>
                      <strong className="font-medium text-stone-900 dark:text-stone-100">
                        Include Original Full-Bleed Cover Page (PDF Export)
                      </strong>
                      <span className="block text-xs text-stone-500 dark:text-stone-400">
                        Prepends Page 1 of the original book before your annotated pages.
                      </span>
                    </span>
                  </label>

                  <label className="flex items-start gap-2.5 text-sm text-stone-700 dark:text-stone-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeStickyPins}
                      onChange={(e) => setIncludeStickyPins(e.target.checked)}
                      className="mt-1 rounded accent-amber-700"
                    />
                    <span>
                      <strong className="font-medium text-stone-900 dark:text-stone-100">
                        Embed Numbered Sticky Note Pins on Diagrams
                      </strong>
                      <span className="block text-xs text-stone-500 dark:text-stone-400">
                        Renders color-coded note markers directly over the exported page image.
                      </span>
                    </span>
                  </label>

                  {includeStickyPins && (
                    <label className="flex items-start gap-2.5 pl-6 text-sm text-stone-700 dark:text-stone-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={includeStickyFootnotes}
                        onChange={(e) => setIncludeStickyFootnotes(e.target.checked)}
                        className="mt-1 rounded accent-amber-700"
                      />
                      <span>
                        <strong className="font-medium text-stone-900 dark:text-stone-100">
                          Append Sticky Note Text Reference Footer
                        </strong>
                        <span className="block text-xs text-stone-500 dark:text-stone-400">
                          Adds a clean non-overlapping reference strip beneath pages that contain
                          written sticky notes.
                        </span>
                      </span>
                    </label>
                  )}

                  <div className="pt-2 flex items-center gap-3">
                    <span className="text-xs font-medium text-stone-700 dark:text-stone-300">
                      Image Format:
                    </span>
                    <div className="inline-flex rounded border border-stone-300 dark:border-stone-700 p-0.5">
                      {(['png', 'jpeg'] as const).map((fmt) => (
                        <button
                          key={fmt}
                          type="button"
                          onClick={() => setImageFormat(fmt)}
                          className={`h-7 px-3 rounded-sm text-xs font-mono-num uppercase cursor-pointer ${
                            imageFormat === fmt
                              ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-950'
                              : 'text-stone-600 dark:text-stone-300'
                          }`}
                        >
                          {fmt}
                        </button>
                      ))}
                    </div>
                    <span className="text-[11px] text-stone-500 dark:text-stone-400">
                      {imageFormat === 'png'
                        ? 'Lossless, sharp for diagrams & callouts'
                        : 'Smaller file size for sharing'}
                    </span>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Progress & Feedback */}
          {exportProgress && (
            <div className="p-4 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-[#191816] space-y-2">
              <div className="flex items-center justify-between text-xs text-stone-700 dark:text-stone-300">
                <span>{exportProgress.status}</span>
                <span className="font-mono-num">
                  {exportProgress.current} / {exportProgress.total}
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-stone-200 dark:bg-stone-800 overflow-hidden">
                <div
                  className="h-full bg-amber-700 dark:bg-amber-500 transition-all duration-200"
                  style={{
                    width: `${Math.round(
                      (exportProgress.current / Math.max(1, exportProgress.total)) * 100
                    )}%`,
                  }}
                />
              </div>
            </div>
          )}

          {exportNotice && (
            <div className="p-3.5 rounded-md border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/70 dark:bg-emerald-950/30 text-xs text-emerald-900 dark:text-emerald-200 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{exportNotice}</span>
            </div>
          )}

          {exportError && (
            <div className="p-3.5 rounded-md border border-red-200 dark:border-red-900/60 bg-red-50/70 dark:bg-red-950/30 text-xs text-red-800 dark:text-red-300">
              {exportError}
            </div>
          )}

          {/* Export Action Buttons */}
          {exportMode === 'translated' ? (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={isExporting || selectedPages.length === 0 || !pdf}
                onClick={handleDownloadTranslatedPdf}
                className="inline-flex items-center gap-2 h-11 px-5 rounded-md text-sm font-medium bg-amber-700 hover:bg-amber-800 text-white disabled:opacity-45 transition-colors cursor-pointer"
              >
                {isExporting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                <span>
                  {isExporting
                    ? 'Building Translated PDF…'
                    : 'Download Translated PDF (With Cover)'}
                </span>
              </button>

              <button
                type="button"
                disabled={selectedPages.length === 0}
                onClick={handlePrintUnicodePdf}
                className="inline-flex items-center gap-2 h-11 px-4 rounded-md text-sm font-medium border border-stone-300 dark:border-stone-700 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40 cursor-pointer"
                title="Opens system print dialog to save a vector selectable-text Unicode PDF"
              >
                <Printer className="w-4 h-4" />
                <span>Print Selectable PDF</span>
              </button>

              <button
                type="button"
                disabled={selectedPages.length === 0}
                onClick={handleDownloadScript}
                className="inline-flex items-center gap-2 h-11 px-4 rounded-md text-sm font-medium border border-stone-300 dark:border-stone-700 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40 cursor-pointer"
              >
                <FileText className="w-4 h-4" />
                <span>Audiobook Script (.txt)</span>
              </button>

              <button
                type="button"
                disabled={selectedPages.length === 0 || isExportingWav}
                onClick={handleDownloadAudioWav}
                className="inline-flex items-center gap-2 h-11 px-4 rounded-md text-sm font-medium border border-stone-300 dark:border-stone-700 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40 cursor-pointer"
              >
                {isExportingWav ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <FileAudio className="w-4 h-4" />
                )}
                <span>Download Audio (.wav)</span>
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={isExporting || selectedAnnotatedPages.length === 0 || !pdf}
                onClick={handleDownloadAnnotatedPdf}
                className="inline-flex items-center gap-2 h-11 px-5 rounded-md text-sm font-medium bg-amber-700 hover:bg-amber-800 text-white disabled:opacity-45 transition-colors cursor-pointer"
              >
                {isExporting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                <span>
                  {isExporting
                    ? 'Building Annotated PDF…'
                    : `Download Annotated PDF (${selectedAnnotatedPages.length} ${
                        selectedAnnotatedPages.length === 1 ? 'page' : 'pages'
                      })`}
                </span>
              </button>

              <button
                type="button"
                disabled={isExporting || selectedAnnotatedPages.length === 0 || !pdf}
                onClick={handleDownloadAnnotatedImages}
                className="inline-flex items-center gap-2 h-11 px-4 rounded-md text-sm font-medium border border-stone-300 dark:border-stone-700 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40 cursor-pointer"
              >
                <ImageIcon className="w-4 h-4" />
                <span>
                  Download {selectedAnnotatedPages.length === 1 ? 'Page Image' : 'Page Images'} (.
                  {imageFormat === 'png' ? 'png' : 'jpg'})
                </span>
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
};
