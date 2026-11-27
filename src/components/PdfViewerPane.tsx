import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Columns2,
  Download,
  Eraser,
  Eye,
  EyeOff,
  FileText,
  Highlighter,
  Image as ImageIcon,
  Loader2,
  MousePointer2,
  PenTool,
  Redo2,
  RotateCcw,
  ScanText,
  StickyNote as StickyNoteIcon,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { LoadedPdf } from '../lib/pdfEngine';
import { renderPdfPageToCanvas } from '../lib/pdfEngine';
import {
  exportAnnotatedPageImage,
  exportAnnotatedPdf,
} from '../lib/pdfExporter';
import { downloadBlob } from '../lib/translatorClient';
import {
  getBookPageAnnotation,
  saveBookPageAnnotation,
} from '../lib/storage';
import {
  OCR_SCRIPT_OPTIONS,
  detectTextLanguageCode,
  getLanguageOption,
  isTextPredominantlyRtl,
} from '../lib/languages';
import type {
  AnnotationStroke,
  AnnotationTool,
  OcrScriptMode,
  PageAnnotationLayer,
  ParsedPage,
  StickyNote,
  StoredBook,
} from '../types';
import {
  NOTE_PALETTE,
  PdfAnnotationLayer,
  renderStrokesToDataUrl,
} from './PdfAnnotationLayer';

export interface PendingOcrReview {
  pageNumber: number;
  originalPage: ParsedPage | null;
  ocrPage: ParsedPage;
  runCount: number;
  dpiScale: number;
  completedAt: number;
}

type OcrCompareMode = 'original' | 'rerun' | 'compare';

function countPageWords(page: ParsedPage | null): number {
  if (!page || page.blocks.length === 0) return 0;
  return page.blocks.reduce((sum, block) => {
    const words = block.text.trim().split(/\s+/).filter(Boolean).length;
    return sum + words;
  }, 0);
}

interface PdfViewerPaneProps {
  bookId: string;
  bookTitle?: string;
  pdf: LoadedPdf | null;
  pageNumber: number;
  numPages: number;
  figureCount: number;
  onChangePage: (page: number) => void;
  onRunOcr: () => void;
  onRerunOcr?: (highRes: boolean) => void;
  onSaveOcrReview?: () => void;
  onKeepOriginalOcr?: () => void;
  isRunningOcr: boolean;
  ocrProgress: number;
  ocrStage?: string;
  ocrScriptMode?: OcrScriptMode;
  onChangeOcrScriptMode?: (mode: OcrScriptMode) => void;
  pendingOcrReview?: PendingOcrReview | null;
  onBookMetadataUpdated?: (updatedBook: StoredBook) => void;
  onReachPageEnd?: () => void;
}

const HIGHLIGHT_SWATCHES = [
  { color: '#FACC15', label: 'Yellow highlighter' },
  { color: '#4ADE80', label: 'Green highlighter' },
  { color: '#38BDF8', label: 'Blue highlighter' },
  { color: '#FB7185', label: 'Pink highlighter' },
];

const PEN_SWATCHES = [
  { color: '#DC2626', label: 'Red ink' },
  { color: '#D97706', label: 'Amber ink' },
  { color: '#2563EB', label: 'Blue ink' },
  { color: '#18181B', label: 'Black ink' },
];

export const PdfViewerPane: React.FC<PdfViewerPaneProps> = ({
  bookId,
  bookTitle = 'Annotated Book',
  pdf,
  pageNumber,
  numPages,
  figureCount,
  onChangePage,
  onRunOcr,
  onRerunOcr,
  onSaveOcrReview,
  onKeepOriginalOcr,
  isRunningOcr,
  ocrProgress,
  ocrStage = '',
  ocrScriptMode = 'auto',
  onChangeOcrScriptMode,
  pendingOcrReview = null,
  onBookMetadataUpdated,
  onReachPageEnd,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pdfEndTriggeredPageRef = useRef<number | null>(null);
  const [zoom, setZoom] = useState(1.15);
  const [pageInput, setPageInput] = useState(String(pageNumber));
  const [renderError, setRenderError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  // OCR Verification & Comparison Toggle State
  const [ocrCompareMode, setOcrCompareMode] = useState<OcrCompareMode>('compare');
  const [ocrPanelExpanded, setOcrPanelExpanded] = useState(true);
  const [ocrHighDpiRerun, setOcrHighDpiRerun] = useState(true);

  useEffect(() => {
    if (pendingOcrReview) {
      setOcrPanelExpanded(true);
      const hasOriginalBlocks = (pendingOcrReview.originalPage?.blocks.length ?? 0) > 0;
      setOcrCompareMode(hasOriginalBlocks ? 'compare' : 'rerun');
    }
  }, [pendingOcrReview?.completedAt]);

  const ocrStats = useMemo(() => {
    if (!pendingOcrReview) return null;
    const origBlocks = pendingOcrReview.originalPage?.blocks.length ?? 0;
    const origWords = countPageWords(pendingOcrReview.originalPage);
    const ocrBlocks = pendingOcrReview.ocrPage.blocks.length;
    const ocrWords = countPageWords(pendingOcrReview.ocrPage);
    return {
      origBlocks,
      origWords,
      ocrBlocks,
      ocrWords,
      wordDelta: ocrWords - origWords,
    };
  }, [pendingOcrReview]);

  // HTML5 Canvas Brush, Opacity, Color & Sticky Note Controls
  const [tool, setTool] = useState<AnnotationTool>('cursor');
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_SWATCHES[0].color);
  const [penColor, setPenColor] = useState(PEN_SWATCHES[0].color);
  const [highlightBrushSize, setHighlightBrushSize] = useState(18); // px (6..36)
  const [penBrushSize, setPenBrushSize] = useState(3.5); // px (1..20)
  const [highlightOpacity, setHighlightOpacity] = useState(0.4); // 0.15..1.0
  const [penOpacity, setPenOpacity] = useState(0.95); // 0.15..1.0
  const [noteColor, setNoteColor] = useState<StickyNote['color']>('amber');

  const [showAnnotations, setShowAnnotations] = useState(true);
  const [strokes, setStrokes] = useState<AnnotationStroke[]>([]);
  const [redoStack, setRedoStack] = useState<AnnotationStroke[]>([]);
  const [notes, setNotes] = useState<StickyNote[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [showNotesTray, setShowNotesTray] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [showQuickExport, setShowQuickExport] = useState(false);
  const [isQuickExporting, setIsQuickExporting] = useState(false);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<(() => void) | null>(null);
  const onBookUpdatedRef = useRef(onBookMetadataUpdated);
  onBookUpdatedRef.current = onBookMetadataUpdated;

  const flushPendingSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (pendingSaveRef.current) {
      const fn = pendingSaveRef.current;
      pendingSaveRef.current = null;
      fn();
    }
  }, []);

  useEffect(() => {
    setPageInput(String(pageNumber));
    setActiveNoteId(null);
    setConfirmClear(false);
    pdfEndTriggeredPageRef.current = null;
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [pageNumber]);

  // Load saved annotation layer from the current book's metadata in IndexedDB
  useEffect(() => {
    flushPendingSave();
    let cancelled = false;
    setStrokes([]);
    setRedoStack([]);
    setNotes([]);
    setActiveNoteId(null);

    if (!bookId) return;
    getBookPageAnnotation(bookId, pageNumber)
      .then((layer) => {
        if (cancelled) return;
        if (layer) {
          setStrokes(layer.strokes ?? []);
          setNotes(layer.notes ?? []);
        }
      })
      .catch(() => {
        // graceful fallback
      });

    return () => {
      cancelled = true;
      flushPendingSave();
    };
  }, [bookId, pageNumber, flushPendingSave]);

  const persistAnnotation = useCallback(
    (
      nextStrokes: AnnotationStroke[],
      nextNotes: StickyNote[],
      immediate = false,
      canvasDataUrl?: string
    ) => {
      if (!bookId) return;
      const writeNow = () => {
        const snapshot =
          canvasDataUrl ??
          renderStrokesToDataUrl(nextStrokes, canvasSize.width, canvasSize.height);
        const layer: PageAnnotationLayer = {
          strokes: nextStrokes,
          notes: nextNotes,
          canvasDataUrl: snapshot,
          updatedAt: Date.now(),
        };
        saveBookPageAnnotation(bookId, pageNumber, layer)
          .then((updatedBook) => {
            if (updatedBook) {
              onBookUpdatedRef.current?.(updatedBook);
            }
          })
          .catch(() => {});
      };

      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (immediate) {
        pendingSaveRef.current = null;
        writeNow();
      } else {
        pendingSaveRef.current = writeNow;
        saveTimerRef.current = setTimeout(() => {
          saveTimerRef.current = null;
          pendingSaveRef.current = null;
          writeNow();
        }, 220);
      }
    },
    [bookId, pageNumber, canvasSize.width, canvasSize.height]
  );

  // Track displayed canvas dimensions accurately even when responsive max-w-full scales it
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const syncRect = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setCanvasSize({ width: rect.width, height: rect.height });
      }
    };
    syncRect();
    const ro = new ResizeObserver(syncRect);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pdf, pageNumber, zoom]);

  useEffect(() => {
    if (!pdf || !canvasRef.current) return;
    let active = true;
    setIsRendering(true);
    setRenderError(null);

    const containerWidth = containerRef.current?.clientWidth ?? 540;
    const baseFitScale = Math.min(1.4, Math.max(0.75, (containerWidth - 40) / 460));
    const effectiveScale = Math.max(0.6, Math.min(2.4, baseFitScale * zoom));

    const task = renderPdfPageToCanvas(pdf, pageNumber, canvasRef.current, effectiveScale);
    task.promise
      .then((dims) => {
        if (!active) return;
        setIsRendering(false);
        const rect = canvasRef.current?.getBoundingClientRect();
        setCanvasSize({
          width: rect && rect.width > 0 ? rect.width : dims.width,
          height: rect && rect.height > 0 ? rect.height : dims.height,
        });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const msg = err instanceof Error ? err.message : '';
        if (msg.toLowerCase().includes('cancel')) return;
        setRenderError('Unable to render this PDF page.');
        setIsRendering(false);
      });

    return () => {
      active = false;
      task.cancel();
    };
  }, [pdf, pageNumber, zoom]);

  const handlePageSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseInt(pageInput, 10);
    if (!Number.isNaN(parsed)) {
      const clamped = Math.max(1, Math.min(numPages, parsed));
      onChangePage(clamped);
      setPageInput(String(clamped));
    } else {
      setPageInput(String(pageNumber));
    }
  };

  // Annotation mutations
  const handleAddStroke = (stroke: AnnotationStroke, canvasSnapshot?: string) => {
    setRedoStack([]);
    setStrokes((prev) => {
      const next = [...prev, stroke];
      persistAnnotation(next, notes, true, canvasSnapshot);
      return next;
    });
  };

  const handleEraseStroke = (strokeId: string, canvasSnapshot?: string) => {
    setStrokes((prev) => {
      const next = prev.filter((s) => s.id !== strokeId);
      if (next.length !== prev.length) {
        persistAnnotation(next, notes, true, canvasSnapshot);
      }
      return next;
    });
  };

  const handleUndoStroke = () => {
    setStrokes((prev) => {
      if (prev.length === 0) return prev;
      const popped = prev[prev.length - 1];
      const next = prev.slice(0, -1);
      setRedoStack((r) => [...r, popped]);
      persistAnnotation(next, notes, true);
      return next;
    });
  };

  const handleRedoStroke = () => {
    setRedoStack((prevRedo) => {
      if (prevRedo.length === 0) return prevRedo;
      const restored = prevRedo[prevRedo.length - 1];
      const nextRedo = prevRedo.slice(0, -1);
      setStrokes((prevStrokes) => {
        const nextStrokes = [...prevStrokes, restored];
        persistAnnotation(nextStrokes, notes, true);
        return nextStrokes;
      });
      return nextRedo;
    });
  };

  const handleAddNote = (x: number, y: number, color: StickyNote['color']) => {
    const now = Date.now();
    const newNote: StickyNote = {
      id: `note-${now}-${Math.random().toString(36).slice(2, 6)}`,
      x: Math.max(0.04, Math.min(0.96, x)),
      y: Math.max(0.04, Math.min(0.96, y)),
      text: '',
      color,
      createdAt: now,
      updatedAt: now,
    };
    setNotes((prev) => {
      const next = [...prev, newNote];
      persistAnnotation(strokes, next, true);
      return next;
    });
    setActiveNoteId(newNote.id);
    setTool('cursor');
  };

  const handleUpdateNote = (
    noteId: string,
    patch: Partial<Pick<StickyNote, 'text' | 'x' | 'y' | 'color'>>
  ) => {
    setNotes((prev) => {
      const next = prev.map((n) =>
        n.id === noteId ? { ...n, ...patch, updatedAt: Date.now() } : n
      );
      persistAnnotation(strokes, next, false);
      return next;
    });
  };

  const handleDeleteNote = (noteId: string) => {
    setNotes((prev) => {
      const next = prev.filter((n) => n.id !== noteId);
      persistAnnotation(strokes, next, true);
      return next;
    });
    if (activeNoteId === noteId) {
      setActiveNoteId(null);
    }
  };

  const handleClearPageMarkup = () => {
    setStrokes([]);
    setRedoStack([]);
    setNotes([]);
    setActiveNoteId(null);
    setConfirmClear(false);
    persistAnnotation([], [], true, undefined);
  };

  const handleQuickExport = async (kind: 'png' | 'jpeg' | 'pdf') => {
    if (!pdf || isQuickExporting) return;
    setShowQuickExport(false);
    setIsQuickExporting(true);
    try {
      const currentLayer: PageAnnotationLayer = {
        strokes,
        notes,
        updatedAt: Date.now(),
      };
      if (kind === 'png' || kind === 'jpeg') {
        const { blob, fileName } = await exportAnnotatedPageImage({
          pdf,
          bookTitle,
          pageNumber,
          layer: currentLayer,
          format: kind,
          includeNotes: true,
          includeNoteText: true,
        });
        downloadBlob(blob, fileName);
      } else {
        const stubBook: StoredBook = {
          id: bookId,
          title: bookTitle,
          author: '',
          fileName: `${bookTitle}.pdf`,
          numPages,
          coverDataUrl: '',
          chapters: [],
          addedAt: Date.now(),
          lastPage: pageNumber,
        };
        const { blob, fileName } = await exportAnnotatedPdf({
          pdf,
          book: stubBook,
          pageNumbers: [pageNumber],
          annotationsMap: { [pageNumber]: currentLayer },
          includeCover: false,
          includeNotes: true,
          includeNoteText: true,
        });
        downloadBlob(blob, fileName);
      }
    } catch {
      // keep UI clean if export fails on unloaded page
    } finally {
      setIsQuickExporting(false);
    }
  };

  const isBrushTool = tool === 'highlight' || tool === 'pen';
  const activeStrokeColor = tool === 'highlight' ? highlightColor : penColor;
  const activeStrokeWidth = tool === 'highlight' ? highlightBrushSize : penBrushSize;
  const activeStrokeOpacity = tool === 'highlight' ? highlightOpacity : penOpacity;
  const activeSwatches = tool === 'highlight' ? HIGHLIGHT_SWATCHES : PEN_SWATCHES;
  const hasMarkup = strokes.length > 0 || notes.length > 0;

  return (
    <section className="flex flex-col h-full bg-[#F1EFEA] dark:bg-[#141312] min-w-0">
      {/* Pane Sub-Header */}
      <div className="px-3 sm:px-4 h-11 border-b border-stone-200 dark:border-stone-800 bg-[#FAF9F5] dark:bg-[#181715] flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400 whitespace-nowrap">
            Original PDF
          </span>
          {figureCount > 0 && (
            <span className="hidden sm:inline-flex items-center gap-1 text-xs text-stone-500 dark:text-stone-400 font-mono-num whitespace-nowrap">
              · <ImageIcon className="w-3.5 h-3.5 text-amber-700 dark:text-amber-500" />
              {figureCount} {figureCount === 1 ? 'figure' : 'figures'}
            </span>
          )}
        </div>

        {/* Page Navigator */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onChangePage(Math.max(1, pageNumber - 1))}
            disabled={pageNumber <= 1}
            aria-label="Previous page"
            className="h-8 w-8 inline-flex items-center justify-center rounded text-stone-600 dark:text-stone-300 hover:bg-stone-200/70 dark:hover:bg-stone-800 disabled:opacity-35 cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          <form onSubmit={handlePageSubmit} className="flex items-center gap-1">
            <input
              type="text"
              inputMode="numeric"
              aria-label="Current page number"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              className="w-12 h-7 text-center font-mono-num text-xs rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#1F1E1B] text-stone-900 dark:text-stone-100 focus:outline-none focus:border-amber-700"
            />
            <span className="text-xs text-stone-500 dark:text-stone-400 font-mono-num whitespace-nowrap">
              / {numPages}
            </span>
          </form>

          <button
            type="button"
            onClick={() => onChangePage(Math.min(numPages, pageNumber + 1))}
            disabled={pageNumber >= numPages}
            aria-label="Next page"
            className="h-8 w-8 inline-flex items-center justify-center rounded text-stone-600 dark:text-stone-300 hover:bg-stone-200/70 dark:hover:bg-stone-800 disabled:opacity-35 cursor-pointer"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Zoom & OCR Controls */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.7, Number((z - 0.15).toFixed(2))))}
            aria-label="Zoom out"
            className="hidden sm:inline-flex h-7 w-7 items-center justify-center rounded text-stone-600 dark:text-stone-300 hover:bg-stone-200/70 dark:hover:bg-stone-800 cursor-pointer"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="hidden md:inline-block w-10 text-center text-[11px] font-mono-num text-stone-500 dark:text-stone-400">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(2.0, Number((z + 0.15).toFixed(2))))}
            aria-label="Zoom in"
            className="hidden sm:inline-flex h-7 w-7 items-center justify-center rounded text-stone-600 dark:text-stone-300 hover:bg-stone-200/70 dark:hover:bg-stone-800 cursor-pointer"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>

          {onChangeOcrScriptMode && (
            <select
              aria-label="OCR book script"
              title="Select PDF script for OCR (Auto detects Sanskrit, Hindi, Marathi, Urdu, Arabic, Bengali, Tamil, Telugu & English)"
              disabled={isRunningOcr || !pdf}
              value={ocrScriptMode}
              onChange={(e) => onChangeOcrScriptMode(e.target.value as OcrScriptMode)}
              className="hidden sm:inline-block h-7 max-w-[116px] px-1.5 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#1F1E1B] text-[11px] font-medium text-stone-700 dark:text-stone-200 focus:outline-none focus:border-amber-700 disabled:opacity-45 cursor-pointer"
            >
              {OCR_SCRIPT_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.shortLabel}
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            onClick={onRunOcr}
            disabled={isRunningOcr || !pdf}
            title="Run universal multilingual OCR (Sanskrit, Hindi, Marathi, Urdu, Arabic, Bengali, Tamil, Telugu, English)"
            className="ml-0.5 inline-flex items-center gap-1.5 h-7 px-2.5 rounded border border-stone-300 dark:border-stone-700 text-xs font-medium text-stone-700 dark:text-stone-300 hover:bg-stone-200/70 dark:hover:bg-stone-800 disabled:opacity-45 cursor-pointer whitespace-nowrap"
          >
            <ScanText className="w-3.5 h-3.5" />
            <span>{isRunningOcr ? `OCR ${ocrProgress}%` : 'OCR'}</span>
          </button>
        </div>
      </div>

      {/* HTML5 Canvas Markup & Sticky Notes Toolbar */}
      <div className="px-3 sm:px-4 py-1.5 border-b border-stone-200 dark:border-stone-800 bg-[#F5F3EE] dark:bg-[#151412] space-y-1.5 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* Primary Tool Selector */}
          <div className="flex items-center gap-1">
            {[
              { id: 'cursor' as const, label: 'Browse', Icon: MousePointer2 },
              { id: 'highlight' as const, label: 'Highlight', Icon: Highlighter },
              { id: 'pen' as const, label: 'Draw', Icon: PenTool },
              { id: 'note' as const, label: 'Note', Icon: StickyNoteIcon },
              { id: 'eraser' as const, label: 'Erase', Icon: Eraser },
            ].map(({ id, label, Icon }) => {
              const active = tool === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setTool(id);
                    if (id !== 'cursor' && !showAnnotations) {
                      setShowAnnotations(true);
                    }
                  }}
                  title={
                    id === 'note'
                      ? 'Click anywhere on the PDF to pin a sticky note'
                      : id === 'eraser'
                      ? 'Click or drag across highlights/drawings to erase'
                      : label
                  }
                  className={`inline-flex items-center gap-1 h-7 px-2 rounded text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    active
                      ? 'bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-950'
                      : 'text-stone-600 dark:text-stone-300 hover:bg-stone-200/70 dark:hover:bg-stone-800'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span className="hidden xl:inline">{label}</span>
                </button>
              );
            })}

            {tool === 'note' && (
              <div className="ml-1.5 pl-2 border-l border-stone-300 dark:border-stone-700 flex items-center gap-1.5">
                {(['amber', 'sage', 'sky', 'rose'] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Sticky note color ${NOTE_PALETTE[c].label}`}
                    onClick={() => setNoteColor(c)}
                    className={`w-4 h-4 rounded-full border cursor-pointer ${NOTE_PALETTE[c].pin} ${
                      noteColor === c
                        ? 'ring-2 ring-offset-1 ring-stone-900 dark:ring-stone-100 scale-110'
                        : 'opacity-75 hover:opacity-100'
                    }`}
                  />
                ))}
                <span className="hidden sm:inline text-[11px] text-stone-500 dark:text-stone-400 ml-1">
                  Click PDF to pin
                </span>
              </div>
            )}
          </div>

          {/* Utility Actions: Notes Tray, Undo/Redo, Visibility, Clear */}
          <div className="flex items-center gap-1">
            {notes.length > 0 && (
              <button
                type="button"
                onClick={() => setShowNotesTray((v) => !v)}
                className={`h-7 px-2 rounded text-xs font-mono-num transition-colors cursor-pointer whitespace-nowrap ${
                  showNotesTray
                    ? 'bg-amber-700 text-white'
                    : 'text-stone-600 dark:text-stone-300 hover:bg-stone-200/70 dark:hover:bg-stone-800'
                }`}
                title="Toggle quick-reference list of sticky notes on this page"
              >
                Notes ({notes.length})
              </button>
            )}

            <button
              type="button"
              disabled={strokes.length === 0}
              onClick={handleUndoStroke}
              aria-label="Undo last stroke"
              title="Undo last highlight or drawing stroke"
              className="h-7 w-7 inline-flex items-center justify-center rounded text-stone-600 dark:text-stone-300 hover:bg-stone-200/70 dark:hover:bg-stone-800 disabled:opacity-30 cursor-pointer"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              disabled={redoStack.length === 0}
              onClick={handleRedoStroke}
              aria-label="Redo stroke"
              title="Redo stroke"
              className="h-7 w-7 inline-flex items-center justify-center rounded text-stone-600 dark:text-stone-300 hover:bg-stone-200/70 dark:hover:bg-stone-800 disabled:opacity-30 cursor-pointer"
            >
              <Redo2 className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => setShowAnnotations((v) => !v)}
              aria-label={showAnnotations ? 'Hide page markup' : 'Show page markup'}
              title={showAnnotations ? 'Hide markup layer' : 'Show markup layer'}
              className="h-7 w-7 inline-flex items-center justify-center rounded text-stone-600 dark:text-stone-300 hover:bg-stone-200/70 dark:hover:bg-stone-800 cursor-pointer"
            >
              {showAnnotations ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            </button>

            {/* Quick Export Annotated Page (PNG / JPEG / PDF) */}
            <div className="relative">
              <button
                type="button"
                disabled={!pdf || isQuickExporting}
                onClick={() => setShowQuickExport((v) => !v)}
                title="Export this annotated page as PNG, JPEG, or PDF"
                className="inline-flex items-center gap-1 h-7 px-2 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#1F1E1B] text-xs font-medium text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-40 cursor-pointer whitespace-nowrap"
              >
                {isQuickExporting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                <span className="hidden sm:inline">Save</span>
              </button>

              {showQuickExport && (
                <div className="absolute right-0 top-8 z-40 w-48 py-1 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-[#1C1B19] shadow-lg text-xs">
                  <button
                    type="button"
                    onClick={() => handleQuickExport('png')}
                    className="w-full px-3 py-2 text-left flex items-center gap-2 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
                  >
                    <ImageIcon className="w-3.5 h-3.5 text-amber-700 dark:text-amber-500" />
                    <span>Export Page as PNG</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleQuickExport('jpeg')}
                    className="w-full px-3 py-2 text-left flex items-center gap-2 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
                  >
                    <ImageIcon className="w-3.5 h-3.5 text-stone-500" />
                    <span>Export Page as JPEG</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleQuickExport('pdf')}
                    className="w-full px-3 py-2 text-left flex items-center gap-2 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 border-t border-stone-200/80 dark:border-stone-800 cursor-pointer"
                  >
                    <FileText className="w-3.5 h-3.5 text-amber-700 dark:text-amber-500" />
                    <span>Export Page as PDF</span>
                  </button>
                </div>
              )}
            </div>

            {hasMarkup &&
              (confirmClear ? (
                <div className="flex items-center gap-1 pl-1 text-xs">
                  <button
                    type="button"
                    onClick={handleClearPageMarkup}
                    className="text-red-700 dark:text-red-400 font-medium hover:underline cursor-pointer"
                  >
                    Clear all
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClear(false)}
                    className="text-stone-500 hover:underline cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmClear(true)}
                  aria-label="Clear all markup on this page"
                  title="Clear all highlights, drawings, and notes on this page"
                  className="h-7 w-7 inline-flex items-center justify-center rounded text-stone-500 hover:text-red-700 dark:text-stone-400 dark:hover:text-red-400 hover:bg-stone-200/70 dark:hover:bg-stone-800 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              ))}
          </div>
        </div>

        {/* Brush Properties Strip (Colors + Custom Picker + Brush Size + Opacity) */}
        {isBrushTool && (
          <div className="pt-1.5 border-t border-stone-200/80 dark:border-stone-800/80 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-stone-600 dark:text-stone-400">
            {/* Color Swatches + Custom Color Picker */}
            <div className="flex items-center gap-1.5">
              <span className="uppercase tracking-wider font-medium text-[10px] text-stone-500 dark:text-stone-400">
                Color
              </span>
              {activeSwatches.map((sw) => (
                <button
                  key={sw.color}
                  type="button"
                  aria-label={sw.label}
                  onClick={() =>
                    tool === 'highlight'
                      ? setHighlightColor(sw.color)
                      : setPenColor(sw.color)
                  }
                  style={{ backgroundColor: sw.color }}
                  className={`w-4 h-4 rounded-full border border-stone-500/40 cursor-pointer transition-transform ${
                    activeStrokeColor.toLowerCase() === sw.color.toLowerCase()
                      ? 'ring-2 ring-offset-1 ring-stone-900 dark:ring-stone-100 scale-110'
                      : 'opacity-80 hover:opacity-100'
                  }`}
                />
              ))}
              <label
                title="Choose custom color"
                className="relative w-5 h-5 rounded-full border border-stone-400 dark:border-stone-600 overflow-hidden cursor-pointer shrink-0 flex items-center justify-center"
                style={{ backgroundColor: activeStrokeColor }}
              >
                <input
                  type="color"
                  aria-label="Custom brush color"
                  value={activeStrokeColor}
                  onChange={(e) =>
                    tool === 'highlight'
                      ? setHighlightColor(e.target.value)
                      : setPenColor(e.target.value)
                  }
                  className="opacity-0 absolute inset-0 w-full h-full cursor-pointer"
                />
              </label>
            </div>

            {/* Brush Size Slider with Live Dot Preview */}
            <label className="flex items-center gap-2 whitespace-nowrap">
              <span className="uppercase tracking-wider font-medium text-[10px] text-stone-500 dark:text-stone-400">
                Size
              </span>
              <input
                type="range"
                min={tool === 'highlight' ? 6 : 1}
                max={tool === 'highlight' ? 36 : 20}
                step={tool === 'highlight' ? 1 : 0.5}
                value={activeStrokeWidth}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (tool === 'highlight') setHighlightBrushSize(val);
                  else setPenBrushSize(val);
                }}
                aria-label="Brush size"
                className="w-20 accent-amber-700 cursor-pointer"
              />
              <span className="font-mono-num w-8 text-stone-700 dark:text-stone-300">
                {Math.round(activeStrokeWidth)}px
              </span>
            </label>

            {/* Opacity Slider */}
            <label className="flex items-center gap-2 whitespace-nowrap">
              <span className="uppercase tracking-wider font-medium text-[10px] text-stone-500 dark:text-stone-400">
                Opacity
              </span>
              <input
                type="range"
                min={15}
                max={100}
                step={5}
                value={Math.round(activeStrokeOpacity * 100)}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10) / 100;
                  if (tool === 'highlight') setHighlightOpacity(val);
                  else setPenOpacity(val);
                }}
                aria-label="Brush opacity"
                className="w-20 accent-amber-700 cursor-pointer"
              />
              <span className="font-mono-num w-8 text-stone-700 dark:text-stone-300">
                {Math.round(activeStrokeOpacity * 100)}%
              </span>
            </label>

            {/* Live Brush Preview Swatch */}
            <span
              aria-hidden="true"
              title="Live brush preview"
              className="hidden sm:inline-flex items-center justify-center w-6 h-5 rounded border border-stone-300 dark:border-stone-700 bg-white shrink-0"
            >
              <span
                className="rounded-full block"
                style={{
                  width: `${Math.max(3, Math.min(16, activeStrokeWidth * 0.65))}px`,
                  height: `${Math.max(3, Math.min(16, activeStrokeWidth * 0.65))}px`,
                  backgroundColor: activeStrokeColor,
                  opacity: activeStrokeOpacity,
                }}
              />
            </span>
          </div>
        )}
      </div>

      {/* Visual OCR Progress Bar */}
      {isRunningOcr && (
        <div
          role="progressbar"
          aria-label="OCR text extraction progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.max(0, Math.min(100, ocrProgress))}
          className="px-3 sm:px-4 py-2.5 border-b border-amber-200/90 sepia:border-[#D4C29E] dark:border-amber-900/60 bg-amber-50/90 sepia:bg-[#EFE4CA] dark:bg-[#1E1A13] shrink-0"
        >
          <div className="flex items-center justify-between gap-2 text-xs mb-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <Loader2 className="w-3.5 h-3.5 text-amber-700 dark:text-amber-400 animate-spin shrink-0" />
              <span className="font-medium text-amber-950 sepia:text-[#3B2F23] dark:text-amber-100 truncate">
                {ocrStage || `Scanning Page ${pageNumber} layout with OCR…`}
              </span>
            </div>
            <span className="font-mono-num tabular-nums font-semibold text-amber-900 sepia:text-[#5E3A14] dark:text-amber-300 shrink-0">
              {Math.max(0, Math.min(100, ocrProgress))}%
            </span>
          </div>
          <div className="w-full h-2 rounded-sm bg-amber-200/80 sepia:bg-[#DFD0AE] dark:bg-stone-800 overflow-hidden">
            <div
              className="h-full bg-amber-700 dark:bg-amber-500 transition-[width] duration-200 ease-out"
              style={{ width: `${Math.max(4, Math.min(100, ocrProgress))}%` }}
            />
          </div>
        </div>
      )}

      {/* Pre-Save OCR Verification & Keep Original / Re-run Comparison Panel */}
      {!isRunningOcr && pendingOcrReview && pendingOcrReview.pageNumber === pageNumber && ocrStats && (
        <div className="border-b border-stone-300 sepia:border-[#D4C6AA] dark:border-stone-700 bg-[#FAF9F5] sepia:bg-[#F7EFE0] dark:bg-[#191816] shrink-0">
          {/* Verification Header & Comparison Toggle */}
          <div className="px-3 sm:px-4 py-2 flex flex-wrap items-center justify-between gap-2 border-b border-stone-200/80 sepia:border-[#DFD4BC] dark:border-stone-800">
            <div className="flex items-center gap-2 min-w-0">
              <ScanText className="w-4 h-4 text-amber-700 dark:text-amber-500 shrink-0" />
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-semibold text-stone-900 sepia:text-[#2E241A] dark:text-stone-100">
                    Verify OCR Before Saving
                  </span>
                  <span className="text-[11px] font-mono-num tabular-nums text-stone-500 dark:text-stone-400">
                    Pass #{pendingOcrReview.runCount} · {pendingOcrReview.dpiScale.toFixed(1)}× DPI
                    {pendingOcrReview.ocrPage.detectedLang
                      ? ` · ${pendingOcrReview.ocrPage.detectedLang}`
                      : ''}
                    {pendingOcrReview.ocrPage.ocrEngine === 'ai-vision'
                      ? ' · AI Vision'
                      : ' · Offline OCR'}
                  </span>
                </div>
                <p className="text-[11px] text-stone-500 sepia:text-[#66543F] dark:text-stone-400 font-mono-num tabular-nums">
                  Original: {ocrStats.origBlocks} blk / {ocrStats.origWords}w · OCR:{' '}
                  {ocrStats.ocrBlocks} blk / {ocrStats.ocrWords}w (
                  {ocrStats.wordDelta >= 0 ? `+${ocrStats.wordDelta}` : ocrStats.wordDelta}w)
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              {/* Keep Original / Re-run / Compare Segmented Toggle */}
              <div
                role="tablist"
                aria-label="Compare original and OCR extracted text"
                className="inline-flex items-center rounded-md border border-stone-300 sepia:border-[#D4C6AA] dark:border-stone-700 bg-stone-100/90 sepia:bg-[#EAE0C8] dark:bg-[#121110] p-0.5"
              >
                {(
                  [
                    { id: 'original', label: 'Keep Original' },
                    { id: 'rerun', label: 'OCR Re-run' },
                    { id: 'compare', label: 'Compare' },
                  ] as const
                ).map((tab) => {
                  const active = ocrCompareMode === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => {
                        setOcrCompareMode(tab.id);
                        if (!ocrPanelExpanded) setOcrPanelExpanded(true);
                      }}
                      className={`h-6 px-2 rounded text-[11px] font-medium transition-colors whitespace-nowrap cursor-pointer inline-flex items-center gap-1 ${
                        active
                          ? 'bg-white sepia:bg-[#FBF6E9] dark:bg-stone-800 text-stone-950 sepia:text-[#2E241A] dark:text-stone-50 shadow-xs'
                          : 'text-stone-600 sepia:text-[#5C4936] dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'
                      }`}
                    >
                      {tab.id === 'compare' && <Columns2 className="w-3 h-3" />}
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={() => setOcrPanelExpanded((v) => !v)}
                aria-label={ocrPanelExpanded ? 'Collapse OCR comparison' : 'Expand OCR comparison'}
                title={ocrPanelExpanded ? 'Collapse preview to inspect full PDF' : 'Expand preview'}
                className="h-7 w-7 inline-flex items-center justify-center rounded text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100 hover:bg-stone-200/70 dark:hover:bg-stone-800 cursor-pointer"
              >
                {ocrPanelExpanded ? (
                  <ChevronUp className="w-4 h-4" />
                ) : (
                  <ChevronDown className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>

          {/* Extracted Text Comparison Body */}
          {ocrPanelExpanded && (
            <div className="px-3 sm:px-4 py-2.5 max-h-56 overflow-y-auto bg-white/80 sepia:bg-[#FBF6E9]/85 dark:bg-[#141311]">
              <div
                className={
                  ocrCompareMode === 'compare'
                    ? 'grid grid-cols-1 md:grid-cols-2 gap-3'
                    : 'space-y-2'
                }
              >
                {/* Original Extracted Text Column */}
                {(ocrCompareMode === 'original' || ocrCompareMode === 'compare') && (
                  <div className="rounded border border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-[#FAF9F5] sepia:bg-[#F4ECD8]/70 dark:bg-[#191816] p-2.5">
                    <div className="flex items-center justify-between gap-2 pb-1.5 mb-2 border-b border-stone-200/80 sepia:border-[#DFD4BC] dark:border-stone-800">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-600 sepia:text-[#5C4936] dark:text-stone-400">
                        Original PDF Layer
                      </span>
                      <span className="text-[11px] font-mono-num tabular-nums text-stone-500 dark:text-stone-400">
                        {ocrStats.origBlocks} blocks · {ocrStats.origWords} words
                      </span>
                    </div>
                    {pendingOcrReview.originalPage &&
                    pendingOcrReview.originalPage.blocks.length > 0 ? (
                      <div
                        dir={
                          pendingOcrReview.originalPage.scriptDirection === 'rtl' ||
                          isTextPredominantlyRtl(
                            pendingOcrReview.originalPage.blocks.map((b) => b.text).join(' ')
                          )
                            ? 'rtl'
                            : 'ltr'
                        }
                        className={`space-y-2 text-xs leading-relaxed text-stone-700 sepia:text-[#3B2F23] dark:text-stone-300 ${
                          getLanguageOption(
                            detectTextLanguageCode(
                              pendingOcrReview.originalPage.blocks.map((b) => b.text).join(' '),
                              pendingOcrReview.originalPage.detectedLang
                            )
                          ).cssClass
                        }`}
                      >
                        {pendingOcrReview.originalPage.blocks.map((block, idx) => (
                          <div key={block.id} className="flex items-start gap-2">
                            <span
                              dir="ltr"
                              className="text-[10px] font-mono-num tabular-nums text-stone-400 mt-0.5 shrink-0 w-5"
                            >
                              {idx + 1}.
                            </span>
                            <p
                              className={
                                block.kind === 'heading'
                                  ? 'font-semibold text-stone-900 dark:text-stone-100'
                                  : ''
                              }
                            >
                              {block.text}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs italic text-stone-500 dark:text-stone-400">
                        No embedded text layer found on this page (likely a scanned image).
                      </p>
                    )}
                  </div>
                )}

                {/* OCR Re-run Extracted Text Column */}
                {(ocrCompareMode === 'rerun' || ocrCompareMode === 'compare') && (
                  <div className="rounded border border-amber-300/80 sepia:border-[#C9B387] dark:border-amber-800/70 bg-amber-50/40 sepia:bg-[#F7EED7] dark:bg-amber-950/15 p-2.5">
                    <div className="flex items-center justify-between gap-2 pb-1.5 mb-2 border-b border-amber-200/80 sepia:border-[#D9C6A0] dark:border-amber-900/50">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-900 sepia:text-[#6B3A10] dark:text-amber-300">
                        OCR Extracted (Pass #{pendingOcrReview.runCount})
                      </span>
                      <span className="text-[11px] font-mono-num tabular-nums text-amber-800/80 dark:text-amber-400/90">
                        {ocrStats.ocrBlocks} blocks · {ocrStats.ocrWords} words
                      </span>
                    </div>
                    {pendingOcrReview.ocrPage.blocks.length > 0 ? (
                      <div
                        dir={
                          pendingOcrReview.ocrPage.scriptDirection === 'rtl' ||
                          isTextPredominantlyRtl(
                            pendingOcrReview.ocrPage.blocks.map((b) => b.text).join(' ')
                          )
                            ? 'rtl'
                            : 'ltr'
                        }
                        className={`space-y-2 text-xs leading-relaxed text-stone-800 sepia:text-[#2E241A] dark:text-stone-200 ${
                          getLanguageOption(
                            detectTextLanguageCode(
                              pendingOcrReview.ocrPage.blocks.map((b) => b.text).join(' '),
                              pendingOcrReview.ocrPage.detectedLang
                            )
                          ).cssClass
                        }`}
                      >
                        {pendingOcrReview.ocrPage.blocks.map((block, idx) => (
                          <div key={block.id} className="flex items-start gap-2">
                            <span
                              dir="ltr"
                              className="text-[10px] font-mono-num tabular-nums text-amber-700/80 dark:text-amber-400/80 mt-0.5 shrink-0 w-5"
                            >
                              {idx + 1}.
                            </span>
                            <p
                              className={
                                block.kind === 'heading'
                                  ? 'font-semibold text-stone-950 dark:text-stone-50'
                                  : ''
                              }
                            >
                              {block.text}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs italic text-amber-900/80 dark:text-amber-300/80">
                        No readable text detected in this OCR pass. Select the book script or try
                        High-DPI Re-run.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Decision Footer: Keep Original | Script | Re-run OCR | Save OCR Text */}
          <div className="px-3 sm:px-4 py-2 border-t border-stone-200/80 sepia:border-[#DFD4BC] dark:border-stone-800 bg-[#F5F3EE] sepia:bg-[#EFE5CF] dark:bg-[#161513] flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onKeepOriginalOcr}
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded border border-stone-300 sepia:border-[#CBB994] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#1F1E1B] text-xs font-medium text-stone-700 sepia:text-[#3B2F23] dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors whitespace-nowrap cursor-pointer"
              >
                <span>Keep Original</span>
              </button>

              {onChangeOcrScriptMode && (
                <select
                  aria-label="Select script for OCR re-run"
                  disabled={isRunningOcr || !pdf}
                  value={ocrScriptMode}
                  onChange={(e) => onChangeOcrScriptMode(e.target.value as OcrScriptMode)}
                  className="h-7 px-2 rounded border border-stone-300 sepia:border-[#CBB994] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#1F1E1B] text-[11px] font-medium text-stone-700 sepia:text-[#3B2F23] dark:text-stone-200 focus:outline-none focus:border-amber-700 cursor-pointer"
                >
                  {OCR_SCRIPT_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              )}

              <button
                type="button"
                onClick={() => (onRerunOcr ? onRerunOcr(ocrHighDpiRerun) : onRunOcr())}
                disabled={isRunningOcr || !pdf}
                title="Re-run OCR on this page to compare a fresh extraction before saving"
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded border border-amber-300 sepia:border-[#C9B387] dark:border-amber-700/80 bg-amber-50 sepia:bg-[#F4E6C5] dark:bg-amber-950/40 text-xs font-medium text-amber-900 sepia:text-[#6B3A10] dark:text-amber-300 hover:bg-amber-100/80 dark:hover:bg-amber-900/45 transition-colors whitespace-nowrap cursor-pointer disabled:opacity-45"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Re-run OCR {ocrHighDpiRerun ? '(2.6×)' : '(2.0×)'}</span>
              </button>

              <label className="inline-flex items-center gap-1.5 text-[11px] text-stone-600 sepia:text-[#5C4936] dark:text-stone-400 cursor-pointer select-none whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={ocrHighDpiRerun}
                  onChange={(e) => setOcrHighDpiRerun(e.target.checked)}
                  className="rounded border-stone-300 accent-amber-700 cursor-pointer"
                />
                <span>High-DPI scan</span>
              </label>
            </div>

            <button
              type="button"
              onClick={onSaveOcrReview}
              disabled={pendingOcrReview.ocrPage.blocks.length === 0}
              title="Save this OCR text as the active extracted text for this page"
              className="inline-flex items-center gap-1.5 h-7 px-3 rounded bg-stone-900 text-stone-50 hover:bg-stone-800 dark:bg-amber-600 dark:text-stone-950 dark:hover:bg-amber-500 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer disabled:opacity-40"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Save OCR Text</span>
            </button>
          </div>
        </div>
      )}

      {/* Canvas Viewport with Overlaid HTML5 Canvas & Sticky Notes Layer */}
      <div
        ref={containerRef}
        onScroll={(e) => {
          if (!onReachPageEnd || pageNumber >= numPages) return;
          if (pdfEndTriggeredPageRef.current === pageNumber) return;
          const el = e.currentTarget;
          const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
          if (el.scrollTop > 20 && distanceFromBottom <= 120) {
            pdfEndTriggeredPageRef.current = pageNumber;
            onReachPageEnd();
          }
        }}
        className="flex-1 overflow-auto p-4 sm:p-6 flex justify-center items-start"
      >
        {!pdf ? (
          <div className="my-auto text-sm text-stone-500 dark:text-stone-400">
            Loading original PDF document…
          </div>
        ) : renderError ? (
          <div className="my-auto text-sm text-red-700 dark:text-red-400">{renderError}</div>
        ) : (
          <div className="relative inline-block shadow-[0_8px_30px_rgba(28,25,23,0.12)] dark:shadow-[0_10px_36px_rgba(0,0,0,0.45)] border border-stone-300/70 dark:border-stone-700 bg-white">
            <canvas ref={canvasRef} className="block max-w-full h-auto" />
            <PdfAnnotationLayer
              width={canvasSize.width}
              height={canvasSize.height}
              tool={tool}
              strokeColor={activeStrokeColor}
              strokeWidth={activeStrokeWidth}
              strokeOpacity={activeStrokeOpacity}
              noteColor={noteColor}
              visible={showAnnotations}
              strokes={strokes}
              notes={notes}
              activeNoteId={activeNoteId}
              onSelectNote={setActiveNoteId}
              onAddStroke={handleAddStroke}
              onEraseStroke={handleEraseStroke}
              onAddNote={handleAddNote}
              onUpdateNote={handleUpdateNote}
              onDeleteNote={handleDeleteNote}
            />
            {isRendering && (
              <div className="absolute inset-0 z-30 bg-white/50 flex items-center justify-center pointer-events-none">
                <span className="text-xs font-medium text-stone-600 bg-white/95 px-3 py-1.5 rounded border border-stone-200">
                  Rendering page {pageNumber}…
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Collapsible Quick-Reference Notes Tray for Current Page */}
      {showNotesTray && notes.length > 0 && (
        <div className="border-t border-stone-200 dark:border-stone-800 bg-[#FAF9F5] dark:bg-[#181715] max-h-44 overflow-y-auto px-4 py-2.5 space-y-2 shrink-0">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400 font-mono-num">
              Page {pageNumber} Reference Notes ({notes.length})
            </span>
            <button
              type="button"
              onClick={() => setShowNotesTray(false)}
              className="text-xs text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 cursor-pointer"
            >
              Hide
            </button>
          </div>
          <div className="divide-y divide-stone-200/70 dark:divide-stone-800/70">
            {notes.map((n, i) => {
              const theme = NOTE_PALETTE[n.color] ?? NOTE_PALETTE.amber;
              return (
                <div
                  key={n.id}
                  className="py-1.5 flex items-start justify-between gap-2 text-xs"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setShowAnnotations(true);
                      setActiveNoteId(n.id);
                    }}
                    className="flex items-start gap-2 text-left min-w-0 flex-1 cursor-pointer group"
                  >
                    <span
                      className={`mt-0.5 w-4 h-4 rounded-full border text-[10px] font-mono-num font-bold flex items-center justify-center shrink-0 ${theme.pin}`}
                    >
                      {i + 1}
                    </span>
                    <span className="text-stone-700 dark:text-stone-300 group-hover:text-stone-950 dark:group-hover:text-white line-clamp-2">
                      {n.text.trim() || 'Empty note — click to add reference text'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteNote(n.id)}
                    aria-label={`Delete note ${i + 1}`}
                    className="p-1 text-stone-400 hover:text-red-700 dark:hover:text-red-400 cursor-pointer shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
};
