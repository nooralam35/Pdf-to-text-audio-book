import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Download,
  Edit3,
  Eye,
  EyeOff,
  FileText,
  Gauge,
  Highlighter,
  Image as ImageIcon,
  Languages,
  Loader2,
  LocateFixed,
  RefreshCw,
  RotateCcw,
  ScanText,
  Search,
  Share2,
  Sparkles,
  StickyNote,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import {
  findSearchRangesInText,
  searchEntireBook,
  type BookSearchMatch,
  type BookSearchProgress,
  type BookSearchScope,
} from '../lib/bookSearch';
import {
  detectTextLanguageCode,
  getLanguageOption,
  isTextPredominantlyRtl,
} from '../lib/languages';
import type { LoadedPdf } from '../lib/pdfEngine';
import {
  formatReadingDuration,
  type ChapterReadingEstimate,
  type ReadingSpeedSnapshot,
} from '../lib/readingSpeed';
import { startPerfSpan } from '../lib/perfMonitor';
import { lookupDictionaryTerm } from '../lib/translatorClient';
import type {
  ChapterItem,
  DictionaryLookupResult,
  ExtractedFigure,
  LanguageCode,
  ParsedPage,
  SentenceSpan,
  TextHighlight,
  TextHighlightColor,
  TranslatedBlock,
  TranslatedPageRecord,
  TranslationEngine,
} from '../types';

export type NextPagePrefetchStatus = 'idle' | 'translating' | 'saved' | 'error';

interface TranslatedReaderPaneProps {
  pageNumber: number;
  numPages: number;
  parsedPage: ParsedPage | null;
  translatedPage: TranslatedPageRecord | null;
  targetLang: LanguageCode;
  engine: TranslationEngine;
  currentChapter: ChapterItem | null;
  sentences: SentenceSpan[];
  activeSentenceIndex: number | null;
  isSpeaking: boolean;
  isTranslating: boolean;
  translationError: string | null;
  autoPreloadNext: boolean;
  nextPageStatus: NextPagePrefetchStatus;
  onReachPageEnd: () => void;
  onGoToNextPage: () => void;
  onTranslatePage: (force?: boolean) => void;
  onCancelTranslation?: () => void;
  onTranslateChapter: (chapter: ChapterItem) => void;
  onUpdateBlockText: (blockId: string, newText: string) => void;
  onUpdateHighlights: (highlights: TextHighlight[]) => void;
  onClickSentence: (sentenceIndex: number) => void;
  readerFontSize?: number;
  readerLineHeight?: number;
  onSummarizeCurrentChapter?: () => void;
  isSummarizingChapter?: boolean;
  onExportHighlights?: () => void;
  onShareQuote?: (draft: {
    id?: string;
    quoteText: string;
    note?: string;
    highlightColor?: TextHighlightColor;
  }) => void;
  onOpenShareStudio?: () => void;
  onRunOcr?: () => void;
  isRunningOcr?: boolean;
  readingSpeed?: ReadingSpeedSnapshot;
  chapterReadingEstimate?: ChapterReadingEstimate | null;
  onResetReadingSpeed?: () => void;
  bookId?: string;
  pdf?: LoadedPdf | null;
  chapters?: ChapterItem[];
  bookTranslations?: TranslatedPageRecord[];
  onSelectPage?: (page: number) => void;
}

type StreamItem =
  | { kind: 'block'; yPercent: number; block: TranslatedBlock }
  | { kind: 'figure'; yPercent: number; figure: ExtractedFigure };

type PopoverMode = 'menu' | 'note' | 'dictionary';

interface SelectionPopoverState {
  blockId: string;
  startOffset: number;
  endOffset: number;
  selectedText: string;
  top: number;
  left: number;
  placeBelow: boolean;
  highlightId?: string;
  color: TextHighlightColor;
  mode: PopoverMode;
}

const HIGHLIGHT_COLORS: {
  id: TextHighlightColor;
  label: string;
  swatch: string;
  markClass: string;
  barClass: string;
}[] = [
  {
    id: 'amber',
    label: 'Warm Gold',
    swatch: '#F5C451',
    markClass:
      'bg-amber-200/80 dark:bg-amber-700/45 text-stone-950 dark:text-amber-50 hover:bg-amber-300/80 dark:hover:bg-amber-700/65',
    barClass: 'bg-amber-500',
  },
  {
    id: 'sage',
    label: 'Sage Leaf',
    swatch: '#6EE7B7',
    markClass:
      'bg-emerald-200/75 dark:bg-emerald-800/45 text-stone-950 dark:text-emerald-50 hover:bg-emerald-300/75 dark:hover:bg-emerald-800/65',
    barClass: 'bg-emerald-500',
  },
  {
    id: 'sky',
    label: 'Sky Ink',
    swatch: '#7DD3FC',
    markClass:
      'bg-sky-200/75 dark:bg-sky-800/45 text-stone-950 dark:text-sky-50 hover:bg-sky-300/75 dark:hover:bg-sky-800/65',
    barClass: 'bg-sky-500',
  },
  {
    id: 'rose',
    label: 'Clay Rose',
    swatch: '#FDA4AF',
    markClass:
      'bg-rose-200/75 dark:bg-rose-800/45 text-stone-950 dark:text-rose-50 hover:bg-rose-300/75 dark:hover:bg-rose-800/65',
    barClass: 'bg-rose-500',
  },
];

const HIGHLIGHT_STYLE_MAP: Record<TextHighlightColor, (typeof HIGHLIGHT_COLORS)[number]> = {
  amber: HIGHLIGHT_COLORS[0],
  sage: HIGHLIGHT_COLORS[1],
  sky: HIGHLIGHT_COLORS[2],
  rose: HIGHLIGHT_COLORS[3],
};

function findClosestBlockElement(
  node: Node | null,
  boundary: HTMLElement
): HTMLElement | null {
  let curr: Node | null = node;
  while (curr && curr !== boundary) {
    if (curr instanceof HTMLElement && curr.dataset.blockId) {
      return curr;
    }
    curr = curr.parentNode;
  }
  return null;
}

function computeBlockSelectionOffsets(
  blockEl: HTMLElement,
  range: Range
): { start: number; end: number; text: string } | null {
  const fullText = blockEl.textContent ?? '';
  if (!fullText.trim()) return null;

  let start = 0;
  let end = fullText.length;

  try {
    if (blockEl.contains(range.startContainer)) {
      const preRange = document.createRange();
      preRange.selectNodeContents(blockEl);
      preRange.setEnd(range.startContainer, range.startOffset);
      start = preRange.toString().length;
    }

    if (blockEl.contains(range.endContainer)) {
      const endRange = document.createRange();
      endRange.selectNodeContents(blockEl);
      endRange.setEnd(range.endContainer, range.endOffset);
      end = endRange.toString().length;
    }
  } catch {
    return null;
  }

  start = Math.max(0, Math.min(start, fullText.length));
  end = Math.max(0, Math.min(end, fullText.length));
  if (end <= start) return null;

  // Trim leading/trailing whitespace so highlight bounds hug actual words cleanly
  while (start < end && /\s/.test(fullText[start])) start++;
  while (end > start && /\s/.test(fullText[end - 1])) end--;

  if (end <= start) return null;
  return {
    start,
    end,
    text: fullText.slice(start, end),
  };
}

interface IndexedSearchRange {
  start: number;
  end: number;
  pageMatchIdx: number;
}

const EMPTY_HIGHLIGHTS: TextHighlight[] = [];
const EMPTY_SEARCH_RANGES: IndexedSearchRange[] = [];
const EMPTY_SENTENCE_SPANS: SentenceSpan[] = [];
const EMPTY_CHAPTERS: ChapterItem[] = [];
const EMPTY_TRANSLATIONS: TranslatedPageRecord[] = [];

function renderPlainSearchMarks(
  text: string,
  ranges: IndexedSearchRange[],
  source: 'translated' | 'original',
  focusedPageMatchIdx: number | null
): React.ReactNode {
  if (!ranges || ranges.length === 0 || !text) return text;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const r of ranges) {
    const start = Math.max(cursor, Math.min(r.start, text.length));
    const end = Math.max(start, Math.min(r.end, text.length));
    if (start > cursor) {
      nodes.push(<React.Fragment key={`pt-${cursor}`}>{text.slice(cursor, start)}</React.Fragment>);
    }
    if (end > start) {
      const isCurrentFocused =
        focusedPageMatchIdx !== null && focusedPageMatchIdx === r.pageMatchIdx;
      nodes.push(
        <mark
          key={`ps-${source}-${r.pageMatchIdx}-${start}`}
          data-search-match="true"
          data-search-source={source}
          data-search-page-idx={r.pageMatchIdx}
          className={
            isCurrentFocused
              ? 'bg-orange-400/95 dark:bg-orange-500/85 text-stone-950 dark:text-white ring-2 ring-orange-500/75 dark:ring-orange-300/80 rounded-[2px] px-[1px] font-medium'
              : 'bg-yellow-300/90 dark:bg-yellow-500/45 text-stone-950 dark:text-yellow-50 rounded-[2px] px-[1px]'
          }
        >
          {text.slice(start, end)}
        </mark>
      );
    }
    cursor = end;
  }
  if (cursor < text.length) {
    nodes.push(<React.Fragment key={`pt-end-${cursor}`}>{text.slice(cursor)}</React.Fragment>);
  }
  return nodes;
}

function renderInterleavedHighlightSlice(
  text: string,
  baseOffset: number,
  blockHighlights: TextHighlight[],
  blockSearchRanges: IndexedSearchRange[],
  focusedTranslatedMatchIdx: number | null,
  onOpenHighlightPopover: (hl: TextHighlight, anchorEl: HTMLElement) => void
): React.ReactNode {
  if (text.length === 0) return text;

  const sliceEnd = baseOffset + text.length;
  const overlappingHighlights = blockHighlights.filter(
    (h) => h.endOffset > baseOffset && h.startOffset < sliceEnd
  );
  const overlappingSearch = blockSearchRanges.filter(
    (r) => r.end > baseOffset && r.start < sliceEnd
  );

  if (overlappingHighlights.length === 0 && overlappingSearch.length === 0) {
    return text;
  }

  const cutPoints = new Set<number>([baseOffset, sliceEnd]);
  for (const hl of overlappingHighlights) {
    cutPoints.add(Math.max(baseOffset, hl.startOffset));
    cutPoints.add(Math.min(sliceEnd, hl.endOffset));
  }
  for (const sr of overlappingSearch) {
    cutPoints.add(Math.max(baseOffset, sr.start));
    cutPoints.add(Math.min(sliceEnd, sr.end));
  }
  const sortedPoints = Array.from(cutPoints).sort((a, b) => a - b);

  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < sortedPoints.length - 1; i++) {
    const segStart = sortedPoints[i];
    const segEnd = sortedPoints[i + 1];
    if (segEnd <= segStart) continue;

    const segmentText = text.slice(segStart - baseOffset, segEnd - baseOffset);

    let covering: TextHighlight | null = null;
    for (const hl of overlappingHighlights) {
      if (hl.startOffset <= segStart && hl.endOffset >= segEnd) {
        if (!covering || hl.updatedAt >= covering.updatedAt) {
          covering = hl;
        }
      }
    }

    let coveringSearch: IndexedSearchRange | null = null;
    for (const sr of overlappingSearch) {
      if (sr.start <= segStart && sr.end >= segEnd) {
        coveringSearch = sr;
        break;
      }
    }

    let innerNode: React.ReactNode = segmentText;
    if (coveringSearch) {
      const isCurrentFocused =
        focusedTranslatedMatchIdx !== null &&
        focusedTranslatedMatchIdx === coveringSearch.pageMatchIdx;
      innerNode = (
        <mark
          key={`sm-${coveringSearch.pageMatchIdx}-${segStart}`}
          data-search-match="true"
          data-search-source="translated"
          data-search-page-idx={coveringSearch.pageMatchIdx}
          className={
            isCurrentFocused
              ? 'bg-orange-400/95 dark:bg-orange-500/85 text-stone-950 dark:text-white ring-2 ring-orange-500/75 dark:ring-orange-300/80 rounded-[2px] px-[0.5px] font-medium'
              : 'bg-yellow-300/90 dark:bg-yellow-500/45 text-stone-950 dark:text-yellow-50 rounded-[2px] px-[0.5px]'
          }
        >
          {segmentText}
        </mark>
      );
    }

    if (!covering) {
      nodes.push(<React.Fragment key={`t-${segStart}`}>{innerNode}</React.Fragment>);
    } else {
      const hl = covering;
      const style = HIGHLIGHT_STYLE_MAP[hl.color] ?? HIGHLIGHT_STYLE_MAP.amber;
      const hasNote = Boolean(hl.note && hl.note.trim());
      nodes.push(
        <mark
          key={`m-${hl.id}-${segStart}`}
          data-highlight-id={hl.id}
          onClick={(e) => {
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
              return;
            }
            e.stopPropagation();
            onOpenHighlightPopover(hl, e.currentTarget);
          }}
          title={
            hasNote
              ? `Note: ${hl.note} (click to edit or look up)`
              : 'Highlighted segment (click to add note, change color, or define)'
          }
          className={`${style.markClass} rounded-[2px] px-[1px] transition-colors cursor-pointer ${
            hasNote
              ? 'underline decoration-dotted decoration-amber-800/75 dark:decoration-amber-300/80 underline-offset-4'
              : ''
          }`}
        >
          {innerNode}
        </mark>
      );
    }
  }

  return nodes;
}

const ReaderFigureItem = React.memo<{ figure: ExtractedFigure; pageNumber: number }>(
  ({ figure, pageNumber }) => (
    <figure className="my-6 rounded-md border border-stone-200 dark:border-stone-800 bg-white dark:bg-[#191816] p-3">
      <img
        src={figure.dataUrl}
        alt={`Original book figure from page ${pageNumber}`}
        className="w-full h-auto max-h-[420px] object-contain mx-auto rounded-sm bg-white"
      />
      <figcaption
        dir="ltr"
        className="mt-2 flex items-center justify-between text-[11px] text-stone-500 dark:text-stone-400"
      >
        <span className="inline-flex items-center gap-1">
          <ImageIcon className="w-3 h-3" />
          Original illustration preserved from Page {pageNumber}
        </span>
      </figcaption>
    </figure>
  )
);

interface ReaderBlockItemProps {
  block: TranslatedBlock;
  spans: SentenceSpan[];
  blockHighlights: TextHighlight[];
  blockSearchRanges: IndexedSearchRange[];
  originalSearchRanges: IndexedSearchRange[];
  activeSentenceIndexInBlock: number | null;
  focusedTranslatedMatchIdx: number | null;
  focusedOriginalMatchIdx: number | null;
  isEditing: boolean;
  editDraft: string;
  readerFontSize: number;
  readerLineHeight: number;
  showOriginalRef: boolean;
  langRtl: boolean;
  sourceRtl: boolean;
  sourceCssClass: string;
  activeSentenceRef: React.MutableRefObject<HTMLSpanElement | null>;
  onStartEdit: (block: TranslatedBlock) => void;
  onCancelEdit: () => void;
  onEditDraftChange: (val: string) => void;
  onCommitEdit: () => void;
  onSentenceClick: (sentenceIndex: number) => void;
  onOpenHighlightPopover: (hl: TextHighlight, anchorEl: HTMLElement) => void;
}

const ReaderBlockItem = React.memo<ReaderBlockItemProps>(
  ({
    block,
    spans,
    blockHighlights,
    blockSearchRanges,
    originalSearchRanges,
    activeSentenceIndexInBlock,
    focusedTranslatedMatchIdx,
    focusedOriginalMatchIdx,
    isEditing,
    editDraft,
    readerFontSize,
    readerLineHeight,
    showOriginalRef,
    langRtl,
    sourceRtl,
    sourceCssClass,
    activeSentenceRef,
    onStartEdit,
    onCancelEdit,
    onEditDraftChange,
    onCommitEdit,
    onSentenceClick,
    onOpenHighlightPopover,
  }) => {
    const textVal = block.translatedText || block.text;

    if (isEditing) {
      return (
        <div className="p-3.5 rounded-md border border-amber-700/50 dark:border-amber-500/50 bg-white dark:bg-[#191816] space-y-2.5">
          <textarea
            value={editDraft}
            onChange={(e) => onEditDraftChange(e.target.value)}
            rows={Math.max(3, Math.ceil(editDraft.length / 70))}
            className="w-full text-[15px] leading-relaxed bg-transparent text-stone-900 dark:text-stone-100 focus:outline-none resize-y"
          />
          <div dir="ltr" className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancelEdit}
              className="inline-flex items-center gap-1 h-8 px-3 rounded text-xs font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
              Cancel
            </button>
            <button
              type="button"
              onClick={onCommitEdit}
              className="inline-flex items-center gap-1 h-8 px-3 rounded text-xs font-medium bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-950 cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              Save Edit
            </button>
          </div>
        </div>
      );
    }

    const renderedSentences =
      spans.length === 0 ? (
        <span>
          {renderInterleavedHighlightSlice(
            textVal,
            0,
            blockHighlights,
            blockSearchRanges,
            focusedTranslatedMatchIdx,
            onOpenHighlightPopover
          )}
        </span>
      ) : (
        (() => {
          let cursor = 0;
          return spans.map((span, idx) => {
            const spanStart = cursor;
            const spanEnd = spanStart + span.text.length;
            cursor = spanEnd + (idx < spans.length - 1 ? 1 : 0);

            const isActive = activeSentenceIndexInBlock === span.globalIndex;
            const spaceSep =
              idx < spans.length - 1
                ? renderInterleavedHighlightSlice(
                    ' ',
                    spanEnd,
                    blockHighlights,
                    blockSearchRanges,
                    focusedTranslatedMatchIdx,
                    onOpenHighlightPopover
                  )
                : null;

            return (
              <React.Fragment key={span.id}>
                <span
                  ref={isActive ? activeSentenceRef : null}
                  onClick={() => {
                    const sel = window.getSelection();
                    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
                      return;
                    }
                    onSentenceClick(span.globalIndex);
                  }}
                  title="Click to read aloud · Drag to highlight, take notes, or define"
                  className={`cursor-pointer rounded-sm transition-colors ${
                    isActive
                      ? 'bg-amber-200/85 dark:bg-amber-800/55 text-stone-950 dark:text-amber-50 px-0.5'
                      : 'hover:bg-stone-200/60 dark:hover:bg-stone-800/70'
                  }`}
                >
                  {renderInterleavedHighlightSlice(
                    span.text,
                    spanStart,
                    blockHighlights,
                    blockSearchRanges,
                    focusedTranslatedMatchIdx,
                    onOpenHighlightPopover
                  )}
                </span>
                {spaceSep}
              </React.Fragment>
            );
          });
        })()
      );

    return (
      <div className="group relative">
        <button
          type="button"
          onClick={() => onStartEdit(block)}
          title="Edit translated text"
          className={`opacity-0 group-hover:opacity-100 focus:opacity-100 absolute top-0 ${
            langRtl ? '-left-8' : '-right-8'
          } p-1.5 rounded text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 hover:bg-stone-200/70 dark:hover:bg-stone-800 transition-opacity cursor-pointer`}
        >
          <Edit3 className="w-3.5 h-3.5" />
        </button>

        {block.kind === 'heading' ? (
          <h2
            data-block-id={block.id}
            className="font-display text-2xl sm:text-[26px] font-semibold tracking-tight leading-snug text-stone-950 dark:text-stone-50 pt-1 select-text"
          >
            {renderedSentences}
          </h2>
        ) : block.kind === 'subheading' ? (
          <h3
            data-block-id={block.id}
            className="text-lg font-semibold leading-snug text-stone-900 dark:text-stone-100 pt-2 select-text"
          >
            {renderedSentences}
          </h3>
        ) : block.kind === 'callout' ? (
          <div
            data-block-id={block.id}
            style={{
              fontSize: `${Math.max(13, readerFontSize - 1)}px`,
              lineHeight: readerLineHeight,
            }}
            className="p-4 rounded-md border border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-[#F4F1EA] sepia:bg-[#ECE2CA] dark:bg-[#1B1917] text-stone-800 sepia:text-[#3B2F23] dark:text-stone-200 select-text"
          >
            {renderedSentences}
          </div>
        ) : block.kind === 'bullet' ? (
          <div
            style={{
              fontSize: `${readerFontSize}px`,
              lineHeight: readerLineHeight,
            }}
            className="flex items-start gap-2.5 text-stone-800 sepia:text-[#3B2F23] dark:text-stone-200"
          >
            <span
              aria-hidden="true"
              className="mt-2.5 w-1.5 h-1.5 rounded-full bg-amber-700 dark:bg-amber-500 shrink-0"
            />
            <p data-block-id={block.id} className="flex-1 select-text">
              {renderedSentences}
            </p>
          </div>
        ) : (
          <p
            data-block-id={block.id}
            style={{
              fontSize: `${readerFontSize}px`,
              lineHeight: readerLineHeight,
            }}
            className="text-stone-800 sepia:text-[#3B2F23] dark:text-stone-200 select-text"
          >
            {renderedSentences}
          </p>
        )}

        {showOriginalRef && block.text !== textVal && (
          <p
            dir={sourceRtl ? 'rtl' : 'ltr'}
            className={`mt-1.5 text-xs leading-relaxed text-stone-500 dark:text-stone-400 ${sourceCssClass}`}
          >
            {renderPlainSearchMarks(
              block.text,
              originalSearchRanges,
              'original',
              focusedOriginalMatchIdx
            )}
          </p>
        )}
      </div>
    );
  }
);

const TranslatedReaderPaneInner: React.FC<TranslatedReaderPaneProps> = ({
  pageNumber,
  numPages,
  parsedPage,
  translatedPage,
  targetLang,
  engine,
  currentChapter,
  sentences,
  activeSentenceIndex,
  isSpeaking,
  isTranslating,
  translationError,
  autoPreloadNext,
  nextPageStatus,
  onReachPageEnd,
  onGoToNextPage,
  onTranslatePage,
  onCancelTranslation,
  onTranslateChapter,
  onUpdateBlockText,
  onUpdateHighlights,
  onClickSentence,
  readerFontSize = 16,
  readerLineHeight = 1.82,
  onSummarizeCurrentChapter,
  isSummarizingChapter = false,
  onExportHighlights,
  onShareQuote,
  onOpenShareStudio,
  onRunOcr,
  isRunningOcr = false,
  readingSpeed,
  chapterReadingEstimate = null,
  onResetReadingSpeed,
  bookId,
  pdf = null,
  chapters = EMPTY_CHAPTERS,
  bookTranslations = EMPTY_TRANSLATIONS,
  onSelectPage,
}) => {
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [showOriginalRef, setShowOriginalRef] = useState(false);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const saved = localStorage.getItem('bhashabook-audio-autoscroll');
    return saved === null ? true : saved === 'true';
  });
  const [autoScrollPausedByUser, setAutoScrollPausedByUser] = useState(false);

  // Text selection highlighting, note-taking & dictionary popover state
  const [popover, setPopover] = useState<SelectionPopoverState | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [copiedSelection, setCopiedSelection] = useState(false);
  const [showHighlightsTray, setShowHighlightsTray] = useState(false);
  const [dictLoading, setDictLoading] = useState(false);
  const [dictResult, setDictResult] = useState<DictionaryLookupResult | null>(null);
  const [dictError, setDictError] = useState<string | null>(null);
  const dictAbortRef = useRef<AbortController | null>(null);

  const activeSentenceRef = useRef<HTMLSpanElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const endSentinelRef = useRef<HTMLDivElement | null>(null);
  const reachedKeyRef = useRef<string | null>(null);
  const onReachPageEndRef = useRef(onReachPageEnd);
  onReachPageEndRef.current = onReachPageEnd;

  // Global full-book search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<BookSearchScope>('all');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchResultsOpen, setSearchResultsOpen] = useState(true);
  const [isSearchingBook, setIsSearchingBook] = useState(false);
  const [searchProgress, setSearchProgress] = useState<BookSearchProgress | null>(null);
  const [searchMatches, setSearchMatches] = useState<BookSearchMatch[]>([]);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [activeMatchIdx, setActiveMatchIdx] = useState(-1);
  const [pendingScrollMatch, setPendingScrollMatch] = useState<{
    pageNumber: number;
    source: 'translated' | 'original';
    matchIndexOnPage: number;
  } | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const pageNumberRef = useRef(pageNumber);
  pageNumberRef.current = pageNumber;

  useEffect(() => {
    try {
      localStorage.setItem('bhashabook-audio-autoscroll', String(autoScrollEnabled));
    } catch {
      // ignore storage errors
    }
  }, [autoScrollEnabled]);

  const langOption = getLanguageOption(targetLang);
  const sourceScriptInfo = useMemo(() => {
    const sample = parsedPage?.blocks.slice(0, 8).map((b) => b.text).join(' ') ?? '';
    const detectedCode = detectTextLanguageCode(sample, parsedPage?.detectedLang);
    const detectedOpt = getLanguageOption(detectedCode);
    const isRtl =
      parsedPage?.scriptDirection === 'rtl' ||
      isTextPredominantlyRtl(sample) ||
      Boolean(detectedOpt.rtl);
    return {
      code: detectedCode,
      name: parsedPage?.detectedLang || detectedOpt.name,
      cssClass: detectedOpt.cssClass,
      rtl: isRtl,
    };
  }, [parsedPage]);

  const effectivePaneRtl = targetLang === 'orig' ? sourceScriptInfo.rtl : Boolean(langOption.rtl);
  const effectivePaneCssClass =
    targetLang === 'orig' ? sourceScriptInfo.cssClass : langOption.cssClass;

  const pageHighlights = useMemo(
    () => translatedPage?.highlights ?? [],
    [translatedPage?.highlights]
  );

  const closePopover = useCallback(() => {
    dictAbortRef.current?.abort();
    dictAbortRef.current = null;
    setPopover(null);
    setNoteDraft('');
    setDictLoading(false);
    setDictResult(null);
    setDictError(null);
    setCopiedSelection(false);
  }, []);

  // Reset editing state, popover, and scroll back to top when page or language changes
  useEffect(() => {
    setEditingBlockId(null);
    setEditDraft('');
    closePopover();
    setAutoScrollPausedByUser(false);
    reachedKeyRef.current = null;
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [pageNumber, targetLang, closePopover]);

  // Clear book-wide search state when switching to a different book
  useEffect(() => {
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    setSearchQuery('');
    setSearchMatches([]);
    setSearchProgress(null);
    setSearchTruncated(false);
    setIsSearchingBook(false);
    setActiveMatchIdx(-1);
    setPendingScrollMatch(null);
  }, [bookId]);

  // Open search bar on Ctrl+F / Cmd+F while reading
  useEffect(() => {
    const handleGlobalFind = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        setSearchResultsOpen(true);
        window.setTimeout(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        }, 20);
      }
    };
    window.addEventListener('keydown', handleGlobalFind);
    return () => window.removeEventListener('keydown', handleGlobalFind);
  }, []);

  // Debounced, cancellable full-book search across all pages
  useEffect(() => {
    const trimmed = searchQuery.trim();
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;

    if (!trimmed || !bookId) {
      setSearchMatches([]);
      setSearchProgress(null);
      setSearchTruncated(false);
      setIsSearchingBook(false);
      setActiveMatchIdx(-1);
      return;
    }

    const controller = new AbortController();
    searchAbortRef.current = controller;
    setIsSearchingBook(true);

    const timer = window.setTimeout(async () => {
      const searchSpan = startPerfSpan(
        'TranslatedReaderPane:search',
        'task',
        `"${trimmed.slice(0, 24)}" (${numPages}p)`,
        200
      );
      try {
        const result = await searchEntireBook({
          bookId,
          numPages,
          pdf,
          chapters,
          bookTranslations,
          currentParsedPage: parsedPage,
          query: trimmed,
          scope: searchScope,
          caseSensitive: searchCaseSensitive,
          signal: controller.signal,
          onProgress: (prog, partial) => {
            if (controller.signal.aborted) return;
            setSearchProgress(prog);
            setSearchMatches(partial);
          },
        });
        if (controller.signal.aborted) return;
        searchSpan.end(`${result.matches.length} hits`);
        setSearchMatches(result.matches);
        setSearchTruncated(result.truncated);
        setSearchProgress({
          scannedPages: numPages,
          totalPages: numPages,
          matchesFound: result.matches.length,
        });
        setActiveMatchIdx((prev) => {
          if (result.matches.length === 0) return -1;
          if (prev >= 0 && prev < result.matches.length) return prev;
          const onCurrentPageIdx = result.matches.findIndex(
            (m) => m.pageNumber === pageNumberRef.current
          );
          return onCurrentPageIdx >= 0 ? onCurrentPageIdx : 0;
        });
      } catch {
        // Ignore aborted or transient search errors
      } finally {
        if (!controller.signal.aborted) {
          setIsSearchingBook(false);
        }
      }
    }, 180);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    searchQuery,
    searchScope,
    searchCaseSensitive,
    bookId,
    numPages,
    pdf,
    chapters,
    bookTranslations,
    parsedPage,
  ]);

  const activeSearchQuery = searchOpen ? searchQuery.trim() : '';
  const activeSearchMatch =
    activeMatchIdx >= 0 && activeMatchIdx < searchMatches.length
      ? searchMatches[activeMatchIdx]
      : null;

  const jumpToSearchMatch = useCallback(
    (index: number) => {
      if (searchMatches.length === 0) return;
      const wrapped =
        ((index % searchMatches.length) + searchMatches.length) % searchMatches.length;
      const target = searchMatches[wrapped];
      if (!target) return;

      setActiveMatchIdx(wrapped);
      setPendingScrollMatch({
        pageNumber: target.pageNumber,
        source: target.source,
        matchIndexOnPage: target.matchIndexOnPage,
      });

      if (target.source === 'original') {
        setShowOriginalRef(true);
      }

      if (target.pageNumber !== pageNumber && onSelectPage) {
        onSelectPage(target.pageNumber);
      }
    },
    [searchMatches, pageNumber, onSelectPage]
  );

  // Smoothly scroll to the exact highlighted occurrence once the target page renders
  useEffect(() => {
    if (!pendingScrollMatch || pendingScrollMatch.pageNumber !== pageNumber) return;
    if (!activeSearchQuery) {
      setPendingScrollMatch(null);
      return;
    }

    let frame2 = 0;
    const frame1 = window.requestAnimationFrame(() => {
      frame2 = window.requestAnimationFrame(() => {
        const container = scrollContainerRef.current;
        if (!container) return;

        const exactEl = container.querySelector<HTMLElement>(
          `mark[data-search-match="true"][data-search-source="${pendingScrollMatch.source}"][data-search-page-idx="${pendingScrollMatch.matchIndexOnPage}"]`
        );
        const fallbackEl =
          exactEl ??
          container.querySelector<HTMLElement>('mark[data-search-match="true"]');

        if (fallbackEl) {
          fallbackEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setPendingScrollMatch(null);
        }
      });
    });

    return () => {
      window.cancelAnimationFrame(frame1);
      if (frame2) window.cancelAnimationFrame(frame2);
    };
  }, [
    pendingScrollMatch,
    pageNumber,
    translatedPage,
    parsedPage,
    showOriginalRef,
    activeSearchQuery,
  ]);

  // Precompute per-block search match ranges on the current page in exact reading order
  const currentPageSearchRanges = useMemo(() => {
    type IndexedRange = { start: number; end: number; pageMatchIdx: number };
    const translatedByBlock = new Map<string, IndexedRange[]>();
    const originalByBlock = new Map<string, IndexedRange[]>();
    const untranslatedByBlock = new Map<string, IndexedRange[]>();

    if (!activeSearchQuery) {
      return {
        translatedByBlock,
        originalByBlock,
        untranslatedByBlock,
        hasUntranslatedMatches: false,
      };
    }

    if (translatedPage) {
      if (searchScope === 'all' || searchScope === 'translated') {
        let trCounter = 0;
        for (const blk of translatedPage.blocks) {
          const textVal = blk.translatedText || blk.text || '';
          const ranges = findSearchRangesInText(textVal, activeSearchQuery, searchCaseSensitive);
          if (ranges.length > 0) {
            translatedByBlock.set(
              blk.id,
              ranges.map((r) => ({ ...r, pageMatchIdx: trCounter++ }))
            );
          }
        }
        translatedPage.imageExplanations.forEach((exp, idx) => {
          const ranges = findSearchRangesInText(exp, activeSearchQuery, searchCaseSensitive);
          if (ranges.length > 0) {
            translatedByBlock.set(
              `img-exp-${idx}`,
              ranges.map((r) => ({ ...r, pageMatchIdx: trCounter++ }))
            );
          }
        });
      }

      if (searchScope === 'all' || searchScope === 'original') {
        let origCounter = 0;
        for (const blk of translatedPage.blocks) {
          const origVal = blk.text || '';
          const ranges = findSearchRangesInText(origVal, activeSearchQuery, searchCaseSensitive);
          if (ranges.length > 0) {
            originalByBlock.set(
              blk.id,
              ranges.map((r) => ({ ...r, pageMatchIdx: origCounter++ }))
            );
          }
        }
      }
    }

    let hasUntranslatedMatches = false;
    if (parsedPage && (searchScope === 'all' || searchScope === 'original')) {
      let unCounter = 0;
      for (const blk of parsedPage.blocks) {
        const ranges = findSearchRangesInText(blk.text || '', activeSearchQuery, searchCaseSensitive);
        if (ranges.length > 0) {
          hasUntranslatedMatches = true;
          untranslatedByBlock.set(
            blk.id,
            ranges.map((r) => ({ ...r, pageMatchIdx: unCounter++ }))
          );
        }
      }
    }

    return {
      translatedByBlock,
      originalByBlock,
      untranslatedByBlock,
      hasUntranslatedMatches,
    };
  }, [activeSearchQuery, searchCaseSensitive, searchScope, translatedPage, parsedPage]);

  // Reset user scroll pause when audiobook stops playing
  useEffect(() => {
    if (!isSpeaking) {
      setAutoScrollPausedByUser(false);
    }
  }, [isSpeaking]);

  // Pause auto-scroll gracefully when the user manually scrolls the reading pane during playback
  useEffect(() => {
    if (!isSpeaking || !autoScrollEnabled) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const pauseOnManualScroll = () => {
      setAutoScrollPausedByUser(true);
    };

    const handleKeyScroll = (e: KeyboardEvent) => {
      if (
        e.key === 'PageUp' ||
        e.key === 'PageDown' ||
        e.key === 'Home' ||
        e.key === 'End'
      ) {
        setAutoScrollPausedByUser(true);
      }
    };

    container.addEventListener('wheel', pauseOnManualScroll, { passive: true });
    container.addEventListener('touchmove', pauseOnManualScroll, { passive: true });
    container.addEventListener('keydown', handleKeyScroll);

    return () => {
      container.removeEventListener('wheel', pauseOnManualScroll);
      container.removeEventListener('touchmove', pauseOnManualScroll);
      container.removeEventListener('keydown', handleKeyScroll);
    };
  }, [isSpeaking, autoScrollEnabled]);

  // Center the actively spoken sentence vertically within the reader scroll container
  const centerActiveSentence = useCallback((instant = false) => {
    const container = scrollContainerRef.current;
    const activeEl = activeSentenceRef.current;
    if (!container || !activeEl) return;

    const containerRect = container.getBoundingClientRect();
    const sentenceRect = activeEl.getBoundingClientRect();
    if (containerRect.height <= 0) return;

    const sentenceCenterInContainer =
      sentenceRect.top - containerRect.top + container.scrollTop + sentenceRect.height / 2;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const targetScrollTop = Math.max(
      0,
      Math.min(maxScrollTop, sentenceCenterInContainer - container.clientHeight / 2)
    );

    if (Math.abs(container.scrollTop - targetScrollTop) < 4) return;

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    container.scrollTo({
      top: targetScrollTop,
      behavior: instant || prefersReducedMotion ? 'auto' : 'smooth',
    });
  }, []);

  // Dismiss popover on Escape or clicking outside
  useEffect(() => {
    if (!popover) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closePopover();
      }
    };

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-selection-popover="true"]')) return;
      if (target.closest('[data-highlight-id]')) return;
      closePopover();
    };

    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [popover, closePopover]);

  // Smoothly keep the actively spoken sentence vertically centered during audiobook playback
  useEffect(() => {
    if (
      !isSpeaking ||
      activeSentenceIndex === null ||
      !autoScrollEnabled ||
      autoScrollPausedByUser ||
      editingBlockId !== null ||
      popover !== null
    ) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      centerActiveSentence(false);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [
    activeSentenceIndex,
    isSpeaking,
    autoScrollEnabled,
    autoScrollPausedByUser,
    editingBlockId,
    popover,
    translatedPage,
    readerFontSize,
    readerLineHeight,
    showOriginalRef,
    centerActiveSentence,
  ]);

  // Automatically trigger next-page translation & auto-save when the reader reaches the end of the page
  useEffect(() => {
    if (!autoPreloadNext || !translatedPage || isTranslating || pageNumber >= numPages) {
      return;
    }

    const pageKey = `${pageNumber}::${targetLang}`;
    const triggerOnce = () => {
      if (reachedKeyRef.current === pageKey) return;
      reachedKeyRef.current = pageKey;
      onReachPageEndRef.current();
    };

    const container = scrollContainerRef.current;
    const sentinel = endSentinelRef.current;
    if (!container || !sentinel) return;

    const isShortPage = container.scrollHeight <= container.clientHeight + 40;
    let shortPageTimer: ReturnType<typeof setTimeout> | null = null;
    if (isShortPage) {
      shortPageTimer = setTimeout(triggerOnce, 1400);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !isShortPage) {
            triggerOnce();
          }
        }
      },
      {
        root: container,
        rootMargin: '0px 0px 160px 0px',
        threshold: 0.05,
      }
    );
    observer.observe(sentinel);

    const handleScroll = () => {
      const distanceFromBottom =
        container.scrollHeight - (container.scrollTop + container.clientHeight);
      if (distanceFromBottom <= 160) {
        triggerOnce();
      }
    };
    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      if (shortPageTimer) clearTimeout(shortPageTimer);
      observer.disconnect();
      container.removeEventListener('scroll', handleScroll);
    };
  }, [autoPreloadNext, translatedPage, isTranslating, pageNumber, numPages, targetLang]);

  // Group SentenceSpans by blockId for O(1) lookup during render
  const sentencesByBlock = useMemo(() => {
    const map = new Map<string, SentenceSpan[]>();
    for (const span of sentences) {
      const existing = map.get(span.blockId);
      if (existing) {
        existing.push(span);
      } else {
        map.set(span.blockId, [span]);
      }
    }
    return map;
  }, [sentences]);

  // Group saved text highlights by blockId
  const highlightsByBlock = useMemo(() => {
    const map = new Map<string, TextHighlight[]>();
    for (const hl of pageHighlights) {
      const existing = map.get(hl.blockId);
      if (existing) {
        existing.push(hl);
      } else {
        map.set(hl.blockId, [hl]);
      }
    }
    return map;
  }, [pageHighlights]);

  // Interleave translated blocks and inline cropped figures sorted by original vertical position
  const streamItems = useMemo<StreamItem[]>(() => {
    if (!translatedPage) return [];
    const items: StreamItem[] = [];
    for (const block of translatedPage.blocks) {
      items.push({ kind: 'block', yPercent: block.yPercent, block });
    }
    for (const figure of translatedPage.figures) {
      items.push({ kind: 'figure', yPercent: figure.yPercent, figure });
    }
    items.sort((a, b) => a.yPercent - b.yPercent);
    return items;
  }, [translatedPage]);

  // Compute popover anchor coordinates relative to scrollContainerRef
  const computeAnchorPosition = useCallback((rect: DOMRect) => {
    const container = scrollContainerRef.current;
    if (!container) {
      return { top: 24, left: 180, placeBelow: true };
    }
    const containerRect = container.getBoundingClientRect();
    const relTop = rect.top - containerRect.top + container.scrollTop;
    const relBottom = rect.bottom - containerRect.top + container.scrollTop;
    const relCenterX = rect.left - containerRect.left + rect.width / 2;

    const placeBelow = rect.top - containerRect.top < 110;
    const halfWidth = Math.min(180, Math.max(130, container.clientWidth * 0.44));
    const clampedLeft = Math.max(
      halfWidth + 8,
      Math.min(container.clientWidth - halfWidth - 8, relCenterX)
    );

    return {
      top: placeBelow ? relBottom + 10 : relTop - 10,
      left: clampedLeft,
      placeBelow,
    };
  }, []);

  // Capture text selection inside any translated text block
  const handleTextSelectionEnd = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      if (editingBlockId || !translatedPage) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-selection-popover="true"]')) return;

      window.setTimeout(() => {
        const container = scrollContainerRef.current;
        if (!container) return;

        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

        const rawSelected = selection.toString().trim();
        if (!rawSelected) return;

        const range = selection.getRangeAt(0);
        const blockEl =
          findClosestBlockElement(range.startContainer, container) ??
          findClosestBlockElement(range.endContainer, container);
        if (!blockEl || !blockEl.dataset.blockId) return;

        const computed = computeBlockSelectionOffsets(blockEl, range);
        if (!computed || !computed.text) return;

        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;

        const blockId = blockEl.dataset.blockId;
        const existingMatch = pageHighlights.find(
          (h) =>
            h.blockId === blockId &&
            h.startOffset === computed.start &&
            h.endOffset === computed.end
        );

        const pos = computeAnchorPosition(rect);
        dictAbortRef.current?.abort();
        setDictLoading(false);
        setDictResult(null);
        setDictError(null);
        setCopiedSelection(false);
        setNoteDraft(existingMatch?.note ?? '');
        setPopover({
          blockId,
          startOffset: computed.start,
          endOffset: computed.end,
          selectedText: computed.text,
          top: pos.top,
          left: pos.left,
          placeBelow: pos.placeBelow,
          highlightId: existingMatch?.id,
          color: existingMatch?.color ?? 'amber',
          mode: 'menu',
        });
      }, 15);
    },
    [editingBlockId, translatedPage, pageHighlights, computeAnchorPosition]
  );

  // Trigger dictionary lookup for a term inside the popover
  const runDictionaryLookup = useCallback(
    async (term: string) => {
      dictAbortRef.current?.abort();
      const controller = new AbortController();
      dictAbortRef.current = controller;

      setDictLoading(true);
      setDictError(null);
      setDictResult(null);

      try {
        const res = await lookupDictionaryTerm(term, targetLang, controller.signal);
        if (!controller.signal.aborted) {
          setDictResult(res);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setDictError(
          err instanceof Error ? err.message : 'Could not fetch dictionary entry right now.'
        );
      } finally {
        if (!controller.signal.aborted) {
          setDictLoading(false);
        }
      }
    },
    [targetLang]
  );

  // Open popover on an existing highlight mark
  const openHighlightPopover = useCallback(
    (
      hl: TextHighlight,
      anchorEl: HTMLElement,
      initialMode: PopoverMode = hl.note?.trim() ? 'note' : 'menu'
    ) => {
      const rect = anchorEl.getBoundingClientRect();
      const pos = computeAnchorPosition(rect);
      dictAbortRef.current?.abort();
      setDictLoading(false);
      setDictResult(null);
      setDictError(null);
      setCopiedSelection(false);
      setNoteDraft(hl.note ?? '');
      setPopover({
        blockId: hl.blockId,
        startOffset: hl.startOffset,
        endOffset: hl.endOffset,
        selectedText: hl.selectedText,
        top: pos.top,
        left: pos.left,
        placeBelow: pos.placeBelow,
        highlightId: hl.id,
        color: hl.color,
        mode: initialMode,
      });

      if (initialMode === 'dictionary') {
        runDictionaryLookup(hl.selectedText);
      }
    },
    [computeAnchorPosition, runDictionaryLookup]
  );

  // Create or update a highlight with the chosen color
  const applyHighlightColor = useCallback(
    (color: TextHighlightColor) => {
      if (!popover) return;
      const now = Date.now();
      let nextHighlights: TextHighlight[];
      let activeId = popover.highlightId;

      if (activeId) {
        nextHighlights = pageHighlights.map((h) =>
          h.id === activeId ? { ...h, color, updatedAt: now } : h
        );
      } else {
        activeId = `hl-${now}-${Math.random().toString(36).slice(2, 7)}`;
        const created: TextHighlight = {
          id: activeId,
          blockId: popover.blockId,
          startOffset: popover.startOffset,
          endOffset: popover.endOffset,
          selectedText: popover.selectedText,
          color,
          note: noteDraft.trim() || undefined,
          createdAt: now,
          updatedAt: now,
        };
        nextHighlights = [...pageHighlights, created];
      }

      onUpdateHighlights(nextHighlights);
      window.getSelection()?.removeAllRanges();
      setPopover((prev) => (prev ? { ...prev, highlightId: activeId, color } : null));
    },
    [popover, pageHighlights, noteDraft, onUpdateHighlights]
  );

  // Save or update note (auto-creates a highlight if not yet saved)
  const saveNoteForSelection = useCallback(
    (explicitNote?: string) => {
      if (!popover) return;
      const cleanNote = (explicitNote ?? noteDraft).trim();
      const now = Date.now();
      let activeId = popover.highlightId;
      let nextHighlights: TextHighlight[];

      if (activeId) {
        nextHighlights = pageHighlights.map((h) =>
          h.id === activeId
            ? {
                ...h,
                color: popover.color,
                note: cleanNote || undefined,
                updatedAt: now,
              }
            : h
        );
      } else {
        activeId = `hl-${now}-${Math.random().toString(36).slice(2, 7)}`;
        const created: TextHighlight = {
          id: activeId,
          blockId: popover.blockId,
          startOffset: popover.startOffset,
          endOffset: popover.endOffset,
          selectedText: popover.selectedText,
          color: popover.color,
          note: cleanNote || undefined,
          createdAt: now,
          updatedAt: now,
        };
        nextHighlights = [...pageHighlights, created];
      }

      onUpdateHighlights(nextHighlights);
      window.getSelection()?.removeAllRanges();
      setNoteDraft(cleanNote);
      setPopover((prev) =>
        prev ? { ...prev, highlightId: activeId, mode: 'menu' } : null
      );
    },
    [popover, noteDraft, pageHighlights, onUpdateHighlights]
  );

  const deleteHighlightById = useCallback(
    (highlightId: string) => {
      const next = pageHighlights.filter((h) => h.id !== highlightId);
      onUpdateHighlights(next);
      if (popover?.highlightId === highlightId) {
        closePopover();
      }
    },
    [pageHighlights, onUpdateHighlights, popover?.highlightId, closePopover]
  );

  const handleCopySelectedText = useCallback(async () => {
    if (!popover) return;
    try {
      await navigator.clipboard.writeText(popover.selectedText);
      setCopiedSelection(true);
      window.setTimeout(() => setCopiedSelection(false), 1400);
    } catch {
      // Clipboard unavailable in restricted context
    }
  }, [popover]);

  const handleSaveDictionaryMeaningAsNote = useCallback(() => {
    if (!dictResult) return;
    const parts: string[] = [];
    if (dictResult.englishEquivalent && dictResult.englishEquivalent !== dictResult.term) {
      parts.push(`English: ${dictResult.englishEquivalent}`);
    }
    if (dictResult.targetEquivalent && dictResult.targetEquivalent !== dictResult.term) {
      parts.push(`${langOption.name}: ${dictResult.targetEquivalent}`);
    }
    if (dictResult.meanings[0]) {
      const m = dictResult.meanings[0];
      parts.push(`(${m.partOfSpeech}) ${m.definition}`);
    } else if (dictResult.summary) {
      parts.push(dictResult.summary);
    }
    const formatted = parts.join(' — ');
    if (formatted) {
      saveNoteForSelection(formatted);
    }
  }, [dictResult, langOption.name, saveNoteForSelection]);

  const jumpToHighlightInPage = useCallback(
    (hl: TextHighlight, openMode: PopoverMode = 'note') => {
      const container = scrollContainerRef.current;
      if (!container) return;
      const markEl = container.querySelector<HTMLElement>(
        `mark[data-highlight-id="${hl.id}"]`
      );
      if (markEl) {
        markEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        window.setTimeout(() => {
          openHighlightPopover(hl, markEl, openMode);
        }, 220);
      }
    },
    [openHighlightPopover]
  );

  const startEdit = useCallback(
    (block: TranslatedBlock) => {
      closePopover();
      setEditingBlockId(block.id);
      setEditDraft(block.translatedText || block.text);
    },
    [closePopover]
  );

  const cancelEdit = useCallback(() => {
    setEditingBlockId(null);
  }, []);

  const commitEdit = useCallback(() => {
    if (editingBlockId && editDraft.trim()) {
      onUpdateBlockText(editingBlockId, editDraft.trim());
    }
    setEditingBlockId(null);
    setEditDraft('');
  }, [editingBlockId, editDraft, onUpdateBlockText]);

  const handleSentenceClick = useCallback(
    (sentenceIndex: number) => {
      setAutoScrollPausedByUser(false);
      onClickSentence(sentenceIndex);
    },
    [onClickSentence]
  );

  const handleOpenBlockHighlightPopover = useCallback(
    (hl: TextHighlight, anchorEl: HTMLElement) => {
      openHighlightPopover(hl, anchorEl);
    },
    [openHighlightPopover]
  );

  const focusedTranslatedPageMatchIdx =
    activeSearchMatch &&
    activeSearchMatch.pageNumber === pageNumber &&
    activeSearchMatch.source === 'translated'
      ? activeSearchMatch.matchIndexOnPage
      : null;

  const focusedOriginalPageMatchIdx =
    activeSearchMatch &&
    activeSearchMatch.pageNumber === pageNumber &&
    activeSearchMatch.source === 'original'
      ? activeSearchMatch.matchIndexOnPage
      : null;

  const renderClickableSentences = useCallback(
    (blockId: string, fallbackText: string) => {
      const spans = sentencesByBlock.get(blockId);
      const blockHighlights = highlightsByBlock.get(blockId) ?? EMPTY_HIGHLIGHTS;
      const blockSearchRanges =
        currentPageSearchRanges.translatedByBlock.get(blockId) ?? EMPTY_SEARCH_RANGES;

      if (!spans || spans.length === 0) {
        return (
          <span>
            {renderInterleavedHighlightSlice(
              fallbackText,
              0,
              blockHighlights,
              blockSearchRanges,
              focusedTranslatedPageMatchIdx,
              handleOpenBlockHighlightPopover
            )}
          </span>
        );
      }

      let cursor = 0;
      return spans.map((span, idx) => {
        const spanStart = cursor;
        const spanEnd = spanStart + span.text.length;
        cursor = spanEnd + (idx < spans.length - 1 ? 1 : 0);

        const isActive = activeSentenceIndex === span.globalIndex;
        const spaceSep =
          idx < spans.length - 1
            ? renderInterleavedHighlightSlice(
                ' ',
                spanEnd,
                blockHighlights,
                blockSearchRanges,
                focusedTranslatedPageMatchIdx,
                handleOpenBlockHighlightPopover
              )
            : null;

        return (
          <React.Fragment key={span.id}>
            <span
              ref={isActive ? activeSentenceRef : null}
              onClick={() => {
                const sel = window.getSelection();
                if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
                  return;
                }
                handleSentenceClick(span.globalIndex);
              }}
              title="Click to read aloud · Drag to highlight, take notes, or define"
              className={`cursor-pointer rounded-sm transition-colors ${
                isActive
                  ? 'bg-amber-200/85 dark:bg-amber-800/55 text-stone-950 dark:text-amber-50 px-0.5'
                  : 'hover:bg-stone-200/60 dark:hover:bg-stone-800/70'
              }`}
            >
              {renderInterleavedHighlightSlice(
                span.text,
                spanStart,
                blockHighlights,
                blockSearchRanges,
                focusedTranslatedPageMatchIdx,
                handleOpenBlockHighlightPopover
              )}
            </span>
            {spaceSep}
          </React.Fragment>
        );
      });
    },
    [
      sentencesByBlock,
      highlightsByBlock,
      currentPageSearchRanges.translatedByBlock,
      focusedTranslatedPageMatchIdx,
      handleOpenBlockHighlightPopover,
      activeSentenceIndex,
      handleSentenceClick,
    ]
  );

  return (
    <section className="flex flex-col h-full bg-[#FAF9F5] sepia:bg-[#F4ECD8] dark:bg-[#0D0D0C] min-w-0 max-w-full overflow-hidden">
      {/* Pane Sub-Header */}
      <div className="px-3 sm:px-4 h-11 border-b border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-[#FAF9F5] sepia:bg-[#EFE5CE] dark:bg-[#141312] flex items-center justify-between gap-2 sm:gap-3 shrink-0 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400 whitespace-nowrap">
            {langOption.name} Edition
          </span>
          <span className="text-xs text-stone-400 dark:text-stone-500 truncate">
            · {langOption.nativeName}
          </span>
          {translatedPage && (
            <span className="hidden md:inline text-xs text-stone-500 dark:text-stone-400 whitespace-nowrap">
              ·{' '}
              {translatedPage.engine === 'ai'
                ? translatedPage.translationStyle === 'faithful'
                  ? 'Smart AI · Faithful'
                  : 'Smart AI · Tutor'
                : 'Free Open'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => {
              setSearchOpen((prev) => {
                const next = !prev;
                if (next) {
                  setSearchResultsOpen(true);
                  window.setTimeout(() => {
                    searchInputRef.current?.focus();
                    searchInputRef.current?.select();
                  }, 20);
                }
                return next;
              });
            }}
            aria-expanded={searchOpen}
            className={`inline-flex items-center gap-1.5 h-7 px-2 rounded text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
              searchOpen || activeSearchQuery
                ? 'bg-amber-100/90 sepia:bg-[#E7D8B6] dark:bg-amber-950/60 text-amber-900 sepia:text-[#6B3A10] dark:text-amber-300'
                : 'text-stone-600 dark:text-stone-300 hover:bg-stone-200/70 dark:hover:bg-stone-800'
            }`}
            title="Search terms or phrases across all pages of this book (Ctrl+F)"
          >
            <Search className="w-3.5 h-3.5" />
            <span className="hidden lg:inline">Search</span>
            {activeSearchQuery && searchMatches.length > 0 && (
              <span className="font-mono-num text-[10px] px-1 rounded bg-amber-700/15 dark:bg-amber-500/20">
                {searchMatches.length}
              </span>
            )}
          </button>

          {onSummarizeCurrentChapter && (
            <button
              type="button"
              disabled={isSummarizingChapter}
              onClick={onSummarizeCurrentChapter}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-200/70 dark:hover:bg-stone-800 disabled:opacity-45 cursor-pointer whitespace-nowrap"
              title="Generate Chapter Summary & Key Takeaways"
            >
              {isSummarizingChapter ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-700" />
              ) : (
                <FileText className="w-3.5 h-3.5" />
              )}
              <span className="hidden xl:inline">Summary</span>
            </button>
          )}

          {onOpenShareStudio && translatedPage && (
            <button
              type="button"
              onClick={onOpenShareStudio}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs font-medium text-stone-700 dark:text-stone-200 hover:bg-stone-200/70 dark:hover:bg-stone-800 cursor-pointer whitespace-nowrap"
              title="Create a shareable visual quote card from your highlights"
            >
              <Share2 className="w-3.5 h-3.5 text-amber-700 dark:text-amber-500" />
              <span className="hidden xl:inline">Share Quote</span>
            </button>
          )}

          {onExportHighlights && (
            <button
              type="button"
              onClick={onExportHighlights}
              className="inline-flex items-center gap-1.5 h-7 px-2 rounded text-xs font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-200/70 dark:hover:bg-stone-800 cursor-pointer whitespace-nowrap"
              title="Export all highlights, sticky notes & bookmarks as a summary sheet"
            >
              <Download className="w-3.5 h-3.5" />
              <span className="hidden 2xl:inline">Export Notes</span>
            </button>
          )}

          {translatedPage && (
            <>
              {pageHighlights.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowHighlightsTray((v) => !v)}
                  className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    showHighlightsTray
                      ? 'bg-amber-700 text-white'
                      : 'text-amber-800 dark:text-amber-300 bg-amber-100/70 dark:bg-amber-950/50 hover:bg-amber-200/70 dark:hover:bg-amber-900/50'
                  }`}
                  title="View saved highlights and notes on this page"
                >
                  <Highlighter className="w-3.5 h-3.5" />
                  <span className="font-mono-num">{pageHighlights.length}</span>
                  <span className="hidden sm:inline">Notes</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  if (!autoScrollEnabled) {
                    setAutoScrollEnabled(true);
                    setAutoScrollPausedByUser(false);
                    if (isSpeaking && activeSentenceIndex !== null) {
                      window.requestAnimationFrame(() => centerActiveSentence(false));
                    }
                  } else if (autoScrollPausedByUser && isSpeaking) {
                    setAutoScrollPausedByUser(false);
                    window.requestAnimationFrame(() => centerActiveSentence(false));
                  } else {
                    setAutoScrollEnabled(false);
                  }
                }}
                aria-pressed={autoScrollEnabled && !autoScrollPausedByUser}
                className={`inline-flex items-center gap-1.5 h-7 px-2 rounded text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  autoScrollEnabled && !autoScrollPausedByUser
                    ? isSpeaking
                      ? 'bg-amber-100/90 sepia:bg-[#E7D8B6] dark:bg-amber-950/60 text-amber-900 sepia:text-[#6B3A10] dark:text-amber-300'
                      : 'text-stone-700 sepia:text-[#3B2F23] dark:text-stone-200 hover:bg-stone-200/70 dark:hover:bg-stone-800'
                    : 'text-stone-400 dark:text-stone-500 hover:bg-stone-200/70 dark:hover:bg-stone-800'
                }`}
                title={
                  autoScrollEnabled
                    ? autoScrollPausedByUser && isSpeaking
                      ? 'Auto-scroll paused while browsing — click to re-center on speaking sentence'
                      : 'Auto-scroll active: keeps the currently speaking sentence vertically centered'
                    : 'Auto-scroll off — click to keep the speaking sentence centered while playing'
                }
              >
                <LocateFixed className="w-3.5 h-3.5" />
                <span className="hidden xl:inline">
                  {autoScrollEnabled ? (autoScrollPausedByUser && isSpeaking ? 'Re-center' : 'Auto-scroll') : 'Scroll Off'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setShowOriginalRef((v) => !v)}
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-200/70 dark:hover:bg-stone-800 cursor-pointer whitespace-nowrap"
                title="Toggle original book text beneath translated paragraphs"
              >
                {showOriginalRef ? (
                  <EyeOff className="w-3.5 h-3.5" />
                ) : (
                  <Eye className="w-3.5 h-3.5" />
                )}
                <span className="hidden sm:inline">
                  {showOriginalRef ? 'Hide Original' : 'Compare'}
                </span>
              </button>

              <button
                type="button"
                disabled={isTranslating}
                onClick={() => onTranslatePage(true)}
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded border border-stone-300 dark:border-stone-700 text-xs font-medium text-stone-700 dark:text-stone-200 hover:bg-stone-200/70 dark:hover:bg-stone-800 disabled:opacity-45 cursor-pointer whitespace-nowrap"
                title="Re-translate this page using the currently selected engine and settings"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isTranslating ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">Re-translate</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Reading Pace & Chapter Time-to-Finish Strip */}
      {readingSpeed && (
        <div
          dir="ltr"
          className="px-3 sm:px-4 min-h-[32px] py-1 border-b border-stone-200/80 sepia:border-[#DFD4BC] dark:border-stone-800/80 bg-[#F5F3EE]/85 sepia:bg-[#F1E8D2]/90 dark:bg-[#11100F] flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-stone-600 sepia:text-[#5B4B3A] dark:text-stone-400 shrink-0"
        >
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 min-w-0">
            <span
              className="inline-flex items-center gap-1.5 font-medium text-stone-700 sepia:text-[#443527] dark:text-stone-200 whitespace-nowrap"
              title={
                readingSpeed.isMeasured
                  ? `Personal average calculated from your last ${readingSpeed.sampleCount} timed ${
                      readingSpeed.sampleCount === 1 ? 'page turn' : 'page turns'
                    }${
                      readingSpeed.lastPageWpm
                        ? ` (last page: ${readingSpeed.lastPageWpm} WPM)`
                        : ''
                    }`
                  : 'Default estimate — turns into your personal reading speed automatically as you turn pages'
              }
            >
              <Gauge className="w-3.5 h-3.5 text-amber-700 dark:text-amber-500 shrink-0" />
              <span className="font-mono-num">
                {readingSpeed.isMeasured ? '' : '~'}
                {readingSpeed.averageWpm} WPM
              </span>
              <span className="text-stone-500 sepia:text-[#6E5C49] dark:text-stone-400 font-normal">
                {readingSpeed.isMeasured
                  ? `(${readingSpeed.sampleCount} ${
                      readingSpeed.sampleCount === 1 ? 'page' : 'pages'
                    })`
                  : '(est.)'}
              </span>
            </span>

            {chapterReadingEstimate && (
              <>
                <span className="text-stone-300 dark:text-stone-700 select-none">·</span>
                <span
                  className="inline-flex items-center gap-1.5 whitespace-nowrap"
                  title={`Estimated time to finish "${chapterReadingEstimate.chapterTitle}" (${chapterReadingEstimate.remainingPages} of ${chapterReadingEstimate.totalPages} pages left, ~${chapterReadingEstimate.remainingWords.toLocaleString()} words at ${readingSpeed.averageWpm} WPM)`}
                >
                  <Clock className="w-3.5 h-3.5 text-stone-500 dark:text-stone-400 shrink-0" />
                  <span className="font-medium text-stone-800 sepia:text-[#3B2F23] dark:text-stone-200 font-mono-num">
                    ~{formatReadingDuration(chapterReadingEstimate.remainingMinutes)}
                  </span>
                  <span>left in chapter</span>
                  <span className="hidden sm:inline text-stone-400 dark:text-stone-500 font-mono-num">
                    ({chapterReadingEstimate.remainingPages}p)
                  </span>
                </span>
              </>
            )}

            {!readingSpeed.isMeasured && (
              <span className="hidden xl:inline text-stone-400 dark:text-stone-500 truncate">
                · Turn pages to calibrate your pace
              </span>
            )}
          </div>

          {readingSpeed.isMeasured && onResetReadingSpeed && (
            <button
              type="button"
              onClick={onResetReadingSpeed}
              className="inline-flex items-center gap-1 text-[11px] text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200 transition-colors cursor-pointer shrink-0"
              title="Reset recorded reading speed history"
            >
              <RotateCcw className="w-3 h-3" />
              <span className="hidden sm:inline">Reset pace</span>
            </button>
          )}
        </div>
      )}

      {/* Global Book-Wide Search Panel */}
      {searchOpen && (
        <div
          dir="ltr"
          className="border-b border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-white sepia:bg-[#FBF6E9] dark:bg-[#171614] shrink-0"
        >
          {/* Search Input & Controls Row */}
          <div className="px-3 sm:px-4 py-2 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="w-3.5 h-3.5 text-stone-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setSearchResultsOpen(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (searchMatches.length > 0) {
                      jumpToSearchMatch(
                        e.shiftKey
                          ? activeMatchIdx <= 0
                            ? searchMatches.length - 1
                            : activeMatchIdx - 1
                          : activeMatchIdx + 1
                      );
                    }
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setSearchOpen(false);
                  }
                }}
                placeholder={`Search across all ${numPages} pages…`}
                aria-label="Search across all pages of this book"
                className="w-full h-8 pl-8 pr-7 rounded-md border border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 bg-[#FAF9F5] sepia:bg-[#F5EEDB] dark:bg-[#100F0E] text-xs text-stone-900 dark:text-stone-100 placeholder:text-stone-400 focus:outline-none focus:border-amber-700 dark:focus:border-amber-500"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    searchInputRef.current?.focus();
                  }}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Scope Filter: All / Translated / Original */}
            <div className="inline-flex items-center rounded-md border border-stone-200 sepia:border-[#D4C7AA] dark:border-stone-700 bg-stone-100/70 sepia:bg-[#EFE5CE] dark:bg-[#11100F] p-0.5 text-[11px]">
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'translated', label: 'Translated' },
                  { id: 'original', label: 'Original' },
                ] as { id: BookSearchScope; label: string }[]
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setSearchScope(opt.id)}
                  className={`h-6 px-2 rounded transition-colors cursor-pointer ${
                    searchScope === opt.id
                      ? 'bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-950 font-medium'
                      : 'text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Case Sensitivity Toggle */}
            <button
              type="button"
              onClick={() => setSearchCaseSensitive((v) => !v)}
              aria-pressed={searchCaseSensitive}
              title="Match case"
              className={`h-7 px-2 rounded border text-[11px] font-mono font-semibold transition-colors cursor-pointer ${
                searchCaseSensitive
                  ? 'border-amber-700 bg-amber-100/90 dark:bg-amber-950/60 text-amber-900 dark:text-amber-300'
                  : 'border-stone-200 dark:border-stone-700 text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200'
              }`}
            >
              Aa
            </button>

            {/* Match Counter + Prev / Next Navigation */}
            <div className="flex items-center gap-1 shrink-0">
              <span className="text-[11px] font-mono-num text-stone-500 dark:text-stone-400 min-w-[54px] text-right pr-1">
                {isSearchingBook && searchProgress ? (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin text-amber-700" />
                    {searchProgress.scannedPages}/{searchProgress.totalPages}
                  </span>
                ) : activeSearchQuery ? (
                  searchMatches.length > 0 ? (
                    `${activeMatchIdx >= 0 ? activeMatchIdx + 1 : 1}/${searchMatches.length}${
                      searchTruncated ? '+' : ''
                    }`
                  ) : (
                    '0 hits'
                  )
                ) : (
                  ''
                )}
              </span>

              <button
                type="button"
                disabled={searchMatches.length === 0}
                onClick={() =>
                  jumpToSearchMatch(
                    activeMatchIdx <= 0 ? searchMatches.length - 1 : activeMatchIdx - 1
                  )
                }
                aria-label="Previous match"
                title="Previous occurrence (Shift+Enter)"
                className="h-7 w-7 inline-flex items-center justify-center rounded border border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-35 cursor-pointer"
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                disabled={searchMatches.length === 0}
                onClick={() => jumpToSearchMatch(activeMatchIdx + 1)}
                aria-label="Next match"
                title="Next occurrence (Enter)"
                className="h-7 w-7 inline-flex items-center justify-center rounded border border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-35 cursor-pointer"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>

              {activeSearchQuery && searchMatches.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSearchResultsOpen((v) => !v)}
                  className="h-7 px-2 rounded text-[11px] font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer whitespace-nowrap"
                  title={searchResultsOpen ? 'Hide results list' : 'Show results list'}
                >
                  {searchResultsOpen ? 'Hide list' : 'Show list'}
                </button>
              )}

              <button
                type="button"
                onClick={() => setSearchOpen(false)}
                aria-label="Close book search"
                title="Close search (Esc)"
                className="h-7 w-7 inline-flex items-center justify-center rounded text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Scrollable Global Results List */}
          {activeSearchQuery && searchResultsOpen && (
            <div className="border-t border-stone-200/80 sepia:border-[#DFD4BC] dark:border-stone-800 max-h-56 overflow-y-auto divide-y divide-stone-100 sepia:divide-[#E6DCC3] dark:divide-stone-800/70">
              {searchMatches.length === 0 ? (
                <div className="px-4 py-4 text-xs text-stone-500 dark:text-stone-400 text-center">
                  {isSearchingBook
                    ? `Scanning book pages (${searchProgress?.scannedPages ?? 0}/${numPages})…`
                    : `No matches found for "${activeSearchQuery}" across all ${numPages} pages.`}
                </div>
              ) : (
                searchMatches.map((m, idx) => {
                  const isFocused = idx === activeMatchIdx;
                  const isCurrentPg = m.pageNumber === pageNumber;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => jumpToSearchMatch(idx)}
                      className={`w-full px-3 sm:px-4 py-2 text-left transition-colors cursor-pointer flex items-start gap-2.5 ${
                        isFocused
                          ? 'bg-amber-50/90 sepia:bg-[#EFE2C1] dark:bg-amber-950/35'
                          : 'hover:bg-stone-50 sepia:hover:bg-[#F4EBD4] dark:hover:bg-[#1E1D1B]'
                      }`}
                    >
                      <span
                        className={`mt-0.5 shrink-0 font-mono-num text-[11px] font-semibold px-1.5 py-0.5 rounded ${
                          isFocused
                            ? 'bg-amber-700 text-white'
                            : isCurrentPg
                            ? 'bg-amber-100 dark:bg-amber-900/50 text-amber-900 dark:text-amber-300'
                            : 'bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-300'
                        }`}
                      >
                        p.{m.pageNumber}
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-[10px] text-stone-500 dark:text-stone-400">
                          {m.chapterTitle && (
                            <span className="truncate font-medium">{m.chapterTitle}</span>
                          )}
                          <span className="shrink-0 uppercase tracking-wider px-1 py-0.2 rounded bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400">
                            {m.source === 'translated' ? langOption.name : 'Original'}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs leading-relaxed text-stone-700 dark:text-stone-300 break-words">
                          <span>{m.snippetBefore}</span>
                          <mark className="bg-yellow-300/90 dark:bg-yellow-500/50 text-stone-950 dark:text-yellow-50 rounded-[2px] px-0.5 font-medium">
                            {m.matchedText}
                          </mark>
                          <span>{m.snippetAfter}</span>
                        </p>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
      )}

      {/* Main Editorial Reading Surface */}
      <div
        ref={scrollContainerRef}
        onMouseUp={handleTextSelectionEnd}
        onTouchEnd={handleTextSelectionEnd}
        className="relative flex-1 overflow-y-auto overflow-x-hidden px-4 sm:px-9 py-5 sm:py-8"
      >
        {/* Floating Selection Highlight / Note / Dictionary Popover */}
        {popover && (
          <div
            data-selection-popover="true"
            dir="ltr"
            style={{
              top: `${popover.top}px`,
              left: `${popover.left}px`,
            }}
            className={`absolute z-30 -translate-x-1/2 ${
              popover.placeBelow ? '' : '-translate-y-full'
            } rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#1C1B19] shadow-xl text-stone-900 dark:text-stone-100 ${
              popover.mode === 'menu' ? 'w-max max-w-[92vw]' : 'w-[320px] sm:w-[360px] max-w-[92vw]'
            }`}
          >
            {/* Action Bar */}
            <div className="px-2.5 py-2 flex items-center justify-between gap-1.5">
              {/* 4 Highlight Color Swatches */}
              <div className="flex items-center gap-1.5 pr-1.5 border-r border-stone-200 dark:border-stone-800">
                {HIGHLIGHT_COLORS.map((c) => {
                  const isSelected = Boolean(popover.highlightId) && popover.color === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => applyHighlightColor(c.id)}
                      title={`Highlight (${c.label})`}
                      aria-label={`Highlight ${c.label}`}
                      style={{ backgroundColor: c.swatch }}
                      className={`w-5 h-5 rounded-full flex items-center justify-center transition-transform hover:scale-110 cursor-pointer ${
                        isSelected
                          ? 'ring-2 ring-offset-1 ring-stone-900 dark:ring-stone-100 dark:ring-offset-[#1C1B19]'
                          : 'border border-black/15'
                      }`}
                    >
                      {isSelected && <Check className="w-3 h-3 text-stone-950 stroke-[2.5]" />}
                    </button>
                  );
                })}
              </div>

              {/* Note & Dictionary Triggers */}
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() =>
                    setPopover((prev) =>
                      prev ? { ...prev, mode: prev.mode === 'note' ? 'menu' : 'note' } : null
                    )
                  }
                  className={`inline-flex items-center gap-1 h-7 px-2 rounded text-xs font-medium transition-colors cursor-pointer ${
                    popover.mode === 'note'
                      ? 'bg-amber-700 text-white'
                      : 'text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800'
                  }`}
                  title="Add or edit a note on this segment"
                >
                  <StickyNote className="w-3.5 h-3.5" />
                  <span>Note</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    if (popover.mode === 'dictionary') {
                      setPopover((prev) => (prev ? { ...prev, mode: 'menu' } : null));
                    } else {
                      setPopover((prev) => (prev ? { ...prev, mode: 'dictionary' } : null));
                      if (!dictResult || dictResult.term !== popover.selectedText) {
                        runDictionaryLookup(popover.selectedText);
                      }
                    }
                  }}
                  className={`inline-flex items-center gap-1 h-7 px-2 rounded text-xs font-medium transition-colors cursor-pointer ${
                    popover.mode === 'dictionary'
                      ? 'bg-amber-700 text-white'
                      : 'text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800'
                  }`}
                  title="Look up definition & cross-language meaning"
                >
                  <BookOpen className="w-3.5 h-3.5" />
                  <span>Define</span>
                </button>

                {onShareQuote && (
                  <button
                    type="button"
                    onClick={() => {
                      const existing = popover.highlightId
                        ? pageHighlights.find((h) => h.id === popover.highlightId)
                        : undefined;
                      onShareQuote({
                        id: popover.highlightId,
                        quoteText: popover.selectedText,
                        note: noteDraft.trim() || existing?.note,
                        highlightColor: popover.color,
                      });
                      closePopover();
                    }}
                    className="inline-flex items-center gap-1 h-7 px-2 rounded text-xs font-medium text-amber-800 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/50 transition-colors cursor-pointer whitespace-nowrap"
                    title="Create a shareable visual quote card"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    <span>Share</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleCopySelectedText}
                  className="h-7 w-7 inline-flex items-center justify-center rounded text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
                  title="Copy selected text"
                >
                  {copiedSelection ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>

                {popover.highlightId && (
                  <button
                    type="button"
                    onClick={() => deleteHighlightById(popover.highlightId!)}
                    className="h-7 w-7 inline-flex items-center justify-center rounded text-stone-500 hover:text-red-600 dark:text-stone-400 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 cursor-pointer"
                    title="Remove highlight & note"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}

                <button
                  type="button"
                  onClick={closePopover}
                  aria-label="Close selection popover"
                  className="h-7 w-7 inline-flex items-center justify-center rounded text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Note-Taking Mode Panel */}
            {popover.mode === 'note' && (
              <div className="px-3 pb-3 pt-2 border-t border-stone-200 dark:border-stone-800 space-y-2.5">
                <p
                  dir={langOption.rtl ? 'rtl' : 'ltr'}
                  className="text-xs text-stone-500 dark:text-stone-400 line-clamp-2 border-l-2 border-amber-600 pl-2 italic"
                >
                  “{popover.selectedText}”
                </p>
                <textarea
                  autoFocus
                  rows={3}
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder="Write a study note, reminder, or key takeaway…"
                  className="w-full p-2.5 text-xs leading-relaxed rounded border border-stone-300 dark:border-stone-700 bg-[#FAF9F5] dark:bg-[#141312] text-stone-900 dark:text-stone-100 focus:outline-none focus:border-amber-700 resize-y"
                />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-stone-400 dark:text-stone-500">
                    Saved locally with Page {pageNumber}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        setPopover((prev) => (prev ? { ...prev, mode: 'menu' } : null))
                      }
                      className="h-7 px-2.5 rounded text-xs font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => saveNoteForSelection()}
                      className="inline-flex items-center gap-1 h-7 px-3 rounded text-xs font-medium bg-amber-700 hover:bg-amber-800 text-white cursor-pointer"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>Save Note</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Dictionary Lookup Mode Panel */}
            {popover.mode === 'dictionary' && (
              <div className="px-3 pb-3 pt-2.5 border-t border-stone-200 dark:border-stone-800 max-h-72 overflow-y-auto space-y-2.5">
                {dictLoading ? (
                  <div className="py-5 flex items-center justify-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                    <Loader2 className="w-4 h-4 animate-spin text-amber-700 dark:text-amber-500" />
                    <span>Looking up “{popover.selectedText.slice(0, 36)}”…</span>
                  </div>
                ) : dictError ? (
                  <div className="p-2.5 rounded bg-red-50/80 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 text-xs text-red-700 dark:text-red-300 space-y-2">
                    <p>{dictError}</p>
                    <button
                      type="button"
                      onClick={() => runDictionaryLookup(popover.selectedText)}
                      className="text-amber-700 dark:text-amber-400 font-medium underline cursor-pointer"
                    >
                      Try again
                    </button>
                  </div>
                ) : dictResult ? (
                  <>
                    <div className="space-y-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <h4 className="font-display text-sm font-semibold text-stone-950 dark:text-stone-50 break-words">
                          {dictResult.term}
                        </h4>
                        {dictResult.phonetic && (
                          <span className="text-[11px] font-mono text-stone-500 dark:text-stone-400 shrink-0">
                            {dictResult.phonetic}
                          </span>
                        )}
                      </div>

                      {(dictResult.englishEquivalent || dictResult.targetEquivalent) && (
                        <div className="text-xs text-amber-800 dark:text-amber-300 space-y-0.5">
                          {dictResult.englishEquivalent &&
                            dictResult.englishEquivalent.toLowerCase() !==
                              dictResult.term.toLowerCase() && (
                              <p>
                                <span className="text-stone-500 dark:text-stone-400">
                                  English:{' '}
                                </span>
                                <span className="font-medium">{dictResult.englishEquivalent}</span>
                              </p>
                            )}
                          {dictResult.targetEquivalent &&
                            dictResult.targetEquivalent.toLowerCase() !==
                              dictResult.term.toLowerCase() && (
                              <p>
                                <span className="text-stone-500 dark:text-stone-400">
                                  {langOption.name}:{' '}
                                </span>
                                <span className="font-medium">{dictResult.targetEquivalent}</span>
                              </p>
                            )}
                        </div>
                      )}
                    </div>

                    {dictResult.meanings.length > 0 && (
                      <div className="space-y-2 pt-1 border-t border-stone-200/80 dark:border-stone-800">
                        {dictResult.meanings.map((m, idx) => (
                          <div key={idx} className="text-xs leading-relaxed space-y-0.5">
                            <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
                              {m.partOfSpeech}
                            </span>
                            <p className="text-stone-800 dark:text-stone-200">{m.definition}</p>
                            {m.example && (
                              <p className="text-[11px] italic text-stone-500 dark:text-stone-400">
                                “{m.example}”
                              </p>
                            )}
                            {m.synonyms && m.synonyms.length > 0 && (
                              <p className="text-[11px] text-stone-500 dark:text-stone-400">
                                Similar: {m.synonyms.slice(0, 4).join(', ')}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {dictResult.summary && (
                      <p className="text-xs leading-relaxed text-stone-700 dark:text-stone-300 pt-1 border-t border-stone-200/80 dark:border-stone-800">
                        {dictResult.summary}
                      </p>
                    )}

                    <div className="pt-2 border-t border-stone-200/80 dark:border-stone-800 flex items-center justify-between gap-2">
                      <span className="text-[10px] text-stone-400 dark:text-stone-500 truncate">
                        Source: {dictResult.source}
                      </span>
                      <button
                        type="button"
                        onClick={handleSaveDictionaryMeaningAsNote}
                        className="inline-flex items-center gap-1 h-6 px-2 rounded border border-stone-300 dark:border-stone-700 text-[11px] font-medium text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer shrink-0"
                      >
                        <StickyNote className="w-3 h-3" />
                        <span>Save as note</span>
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            )}
          </div>
        )}

        <div
          dir={effectivePaneRtl ? 'rtl' : 'ltr'}
          className={`max-w-[660px] mx-auto ${effectivePaneCssClass}`}
        >
          {/* Error Banner */}
          {translationError && (
            <div
              dir="ltr"
              className="mb-6 p-4 rounded-md border border-red-200 dark:border-red-900/60 bg-red-50/70 dark:bg-red-950/30 text-sm text-red-800 dark:text-red-300 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="font-medium">Translation could not complete</p>
                <p className="mt-1 text-xs opacity-90 break-words">{translationError}</p>
              </div>
              <button
                type="button"
                onClick={() => onTranslatePage(true)}
                className="inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded text-xs font-medium bg-red-700 hover:bg-red-800 text-white shrink-0 cursor-pointer self-start sm:self-center"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Retry</span>
              </button>
            </div>
          )}

          {/* Loading State */}
          {isTranslating && (
            <div dir="ltr" className="py-10 sm:py-12 space-y-4 w-full max-w-full overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 text-sm font-medium text-stone-700 dark:text-stone-300 min-w-0">
                  <RefreshCw className="w-4 h-4 animate-spin text-amber-700 dark:text-amber-500 shrink-0" />
                  <span className="truncate">
                    Translating Page {pageNumber} into {langOption.name}
                    {engine === 'ai' ? ' (analyzing layout & diagrams)…' : '…'}
                  </span>
                </div>
                {onCancelTranslation && (
                  <button
                    type="button"
                    onClick={onCancelTranslation}
                    className="inline-flex items-center gap-1 h-7 px-2.5 rounded border border-stone-300 dark:border-stone-700 text-xs font-medium text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                    <span>Cancel</span>
                  </button>
                )}
              </div>
              <div className="space-y-2.5 animate-pulse w-full">
                <div className="h-5 w-2/3 max-w-full rounded bg-stone-200 dark:bg-stone-800" />
                <div className="h-3.5 w-full rounded bg-stone-200/80 dark:bg-stone-800/80" />
                <div className="h-3.5 w-11/12 rounded bg-stone-200/80 dark:bg-stone-800/80" />
                <div className="h-3.5 w-4/5 rounded bg-stone-200/80 dark:bg-stone-800/80" />
              </div>
            </div>
          )}

          {/* Untranslated State */}
          {!isTranslating && !translatedPage && (
            <div dir="ltr" className="py-8 sm:py-12">
              <div className="p-6 sm:p-8 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-[#191816]">
                <p className="text-xs font-mono-num uppercase tracking-wider text-stone-500 dark:text-stone-400">
                  Page {pageNumber}
                  {currentChapter ? ` · ${currentChapter.title}` : ''}
                </p>
                <h3 className="mt-2 font-display text-xl font-semibold text-stone-900 dark:text-stone-100">
                  Ready to translate into {langOption.name}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-stone-600 dark:text-stone-400">
                  {parsedPage && !parsedPage.isBlank ? (
                    <>
                      Detected{' '}
                      <span className="font-mono-num font-medium text-stone-900 dark:text-stone-200">
                        {parsedPage.blocks.length}
                      </span>{' '}
                      text blocks
                      {parsedPage.figures.length > 0 ? (
                        <>
                          {' '}
                          and{' '}
                          <span className="font-mono-num font-medium text-stone-900 dark:text-stone-200">
                            {parsedPage.figures.length}
                          </span>{' '}
                          embedded {parsedPage.figures.length === 1 ? 'diagram' : 'diagrams'}
                        </>
                      ) : (
                        ''
                      )}
                      . Technical terms remain clear in English and figures stay in their original positions.
                    </>
                  ) : (
                    'This page looks like a cover, full-page illustration, or scanned sheet. You can run OCR on the left pane or translate this page directly.'
                  )}
                </p>

                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => onTranslatePage(false)}
                    className="inline-flex items-center gap-2 h-10 px-4 rounded-md text-sm font-medium bg-amber-700 hover:bg-amber-800 text-white transition-colors cursor-pointer"
                  >
                    {engine === 'ai' ? (
                      <Sparkles className="w-4 h-4" />
                    ) : (
                      <Languages className="w-4 h-4" />
                    )}
                    <span>
                      {targetLang === 'orig'
                        ? `Open Clean Original Page ${pageNumber}`
                        : `Translate Page ${pageNumber}`}
                    </span>
                  </button>

                  {onRunOcr && (parsedPage?.looksGarbled || parsedPage?.isBlank) && (
                    <button
                      type="button"
                      disabled={isRunningOcr}
                      onClick={onRunOcr}
                      className="inline-flex items-center gap-2 h-10 px-4 rounded-md text-sm font-medium border border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/35 text-amber-900 dark:text-amber-200 hover:bg-amber-100/80 dark:hover:bg-amber-900/45 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <ScanText className="w-4 h-4" />
                      <span>{isRunningOcr ? 'Reading Script via OCR…' : 'Run Multilingual OCR'}</span>
                    </button>
                  )}

                  {currentChapter && (
                    <button
                      type="button"
                      onClick={() => onTranslateChapter(currentChapter)}
                      className="inline-flex items-center gap-2 h-10 px-4 rounded-md text-sm font-medium border border-stone-300 dark:border-stone-700 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors cursor-pointer"
                    >
                      <span>
                        Translate Chapter ({currentChapter.endPage - currentChapter.startPage + 1}{' '}
                        pages)
                      </span>
                    </button>
                  )}
                </div>

                {parsedPage?.looksGarbled && (
                  <p className="mt-4 text-xs text-amber-800 dark:text-amber-300 bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 rounded px-3 py-2">
                    This PDF page uses non-standard legacy font encoding or scanned images. Use{' '}
                    <strong>Run Multilingual OCR</strong> to read Sanskrit, Hindi, Marathi, Urdu,
                    Arabic, or other scripts cleanly before translating.
                  </p>
                )}

                {/* Brief raw extracted preview (expands to show highlighted matches when searching an untranslated page) */}
                {parsedPage && parsedPage.blocks.length > 0 && (
                  <div className="mt-7 pt-5 border-t border-stone-200 dark:border-stone-800">
                    <p className="text-[11px] uppercase tracking-wider font-medium text-stone-400 dark:text-stone-500">
                      Extracted Original Book Text ({sourceScriptInfo.name})
                      {currentPageSearchRanges.hasUntranslatedMatches && (
                        <span className="ml-2 normal-case tracking-normal text-amber-700 dark:text-amber-400 font-semibold">
                          · Search matches highlighted below
                        </span>
                      )}
                    </p>
                    {currentPageSearchRanges.hasUntranslatedMatches ? (
                      <div
                        dir={sourceScriptInfo.rtl ? 'rtl' : 'ltr'}
                        className={`mt-2.5 space-y-2.5 text-sm text-stone-700 dark:text-stone-300 leading-relaxed ${sourceScriptInfo.cssClass}`}
                      >
                        {parsedPage.blocks.map((b) => {
                          const ranges =
                            currentPageSearchRanges.untranslatedByBlock.get(b.id) ??
                            EMPTY_SEARCH_RANGES;
                          return (
                            <p key={b.id}>
                              {renderPlainSearchMarks(
                                b.text,
                                ranges,
                                'original',
                                focusedOriginalPageMatchIdx
                              )}
                            </p>
                          );
                        })}
                      </div>
                    ) : (
                      <p
                        dir={sourceScriptInfo.rtl ? 'rtl' : 'ltr'}
                        className={`mt-2 text-sm text-stone-600 dark:text-stone-400 leading-relaxed line-clamp-5 ${sourceScriptInfo.cssClass}`}
                      >
                        {parsedPage.blocks
                          .slice(0, 3)
                          .map((b) => b.text)
                          .join(' ')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Translated Content Stream (Blocks + Inline Cropped Figures) */}
          {!isTranslating && translatedPage && (
            <article className="space-y-5">
              {/* Quiet helper cue */}
              <div
                dir="ltr"
                className="flex items-center justify-between gap-2 text-xs text-stone-500 dark:text-stone-400 pb-3 border-b border-stone-200/80 dark:border-stone-800/80"
              >
                <span className="inline-flex items-center gap-1.5">
                  <Volume2 className="w-3.5 h-3.5 text-amber-700 dark:text-amber-500 shrink-0" />
                  Click sentence to listen · Select text to highlight, note, or define
                </span>
                <span className="font-mono-num shrink-0">p.{pageNumber}</span>
              </div>

              {streamItems.length === 0 ? (
                <div
                  dir="ltr"
                  className="py-10 text-center text-sm text-stone-500 dark:text-stone-400"
                >
                  No text blocks were detected on this page (cover or blank page). Original Page 1
                  is preserved automatically during PDF export.
                </div>
              ) : (
                streamItems.map((item) => {
                  if (item.kind === 'figure') {
                    return (
                      <ReaderFigureItem
                        key={item.figure.id}
                        figure={item.figure}
                        pageNumber={pageNumber}
                      />
                    );
                  }

                  const blk = item.block;
                  const spans = sentencesByBlock.get(blk.id) ?? EMPTY_SENTENCE_SPANS;
                  const blockHighlights = highlightsByBlock.get(blk.id) ?? EMPTY_HIGHLIGHTS;
                  const blockSearchRanges =
                    currentPageSearchRanges.translatedByBlock.get(blk.id) ?? EMPTY_SEARCH_RANGES;
                  const originalSearchRanges =
                    currentPageSearchRanges.originalByBlock.get(blk.id) ?? EMPTY_SEARCH_RANGES;

                  // Scope active sentence & focused search indices to ONLY the matching block
                  // so sibling React.memo blocks skip re-rendering on every sentence tick
                  const activeSentenceIndexInBlock =
                    activeSentenceIndex !== null &&
                    spans.some((s) => s.globalIndex === activeSentenceIndex)
                      ? activeSentenceIndex
                      : null;
                  const focusedTranslatedMatchIdx =
                    focusedTranslatedPageMatchIdx !== null &&
                    blockSearchRanges.some(
                      (r) => r.pageMatchIdx === focusedTranslatedPageMatchIdx
                    )
                      ? focusedTranslatedPageMatchIdx
                      : null;
                  const focusedOriginalMatchIdx =
                    focusedOriginalPageMatchIdx !== null &&
                    originalSearchRanges.some(
                      (r) => r.pageMatchIdx === focusedOriginalPageMatchIdx
                    )
                      ? focusedOriginalPageMatchIdx
                      : null;

                  const isEditing = editingBlockId === blk.id;

                  return (
                    <ReaderBlockItem
                      key={blk.id}
                      block={blk}
                      spans={spans}
                      blockHighlights={blockHighlights}
                      blockSearchRanges={blockSearchRanges}
                      originalSearchRanges={originalSearchRanges}
                      activeSentenceIndexInBlock={activeSentenceIndexInBlock}
                      focusedTranslatedMatchIdx={focusedTranslatedMatchIdx}
                      focusedOriginalMatchIdx={focusedOriginalMatchIdx}
                      isEditing={isEditing}
                      editDraft={isEditing ? editDraft : ''}
                      readerFontSize={readerFontSize}
                      readerLineHeight={readerLineHeight}
                      showOriginalRef={showOriginalRef}
                      langRtl={Boolean(langOption.rtl)}
                      sourceRtl={sourceScriptInfo.rtl}
                      sourceCssClass={sourceScriptInfo.cssClass}
                      activeSentenceRef={activeSentenceRef}
                      onStartEdit={startEdit}
                      onCancelEdit={cancelEdit}
                      onEditDraftChange={setEditDraft}
                      onCommitEdit={commitEdit}
                      onSentenceClick={handleSentenceClick}
                      onOpenHighlightPopover={handleOpenBlockHighlightPopover}
                    />
                  );
                })
              )}

              {/* Diagram / Screenshot Explanations from Smart AI Mode */}
              {translatedPage.imageExplanations.length > 0 && (
                <div className="mt-6 pt-5 border-t border-stone-200 dark:border-stone-800 space-y-3">
                  <p
                    dir="ltr"
                    className="text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400"
                  >
                    Diagram &amp; Screenshot Callout Notes
                  </p>
                  {translatedPage.imageExplanations.map((exp, idx) => (
                    <div
                      key={`exp-${idx}`}
                      data-block-id={`img-exp-${idx}`}
                      className="p-4 rounded-md border border-stone-200 dark:border-stone-800 bg-white dark:bg-[#191816] text-sm leading-relaxed text-stone-700 dark:text-stone-300 select-text"
                    >
                      {renderClickableSentences(`img-exp-${idx}`, exp)}
                    </div>
                  ))}
                </div>
              )}

              {/* End-of-Page Sentinel & Seamless Next-Page Auto-Save Bar */}
              <div
                ref={endSentinelRef}
                dir="ltr"
                className="mt-8 pt-5 border-t border-stone-200 dark:border-stone-800"
              >
                {pageNumber < numPages ? (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-xs text-stone-600 dark:text-stone-400 min-w-0">
                      {nextPageStatus === 'translating' ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-700 dark:text-amber-500 shrink-0" />
                          <span>
                            Auto-translating &amp; saving Page {pageNumber + 1}…
                          </span>
                        </>
                      ) : nextPageStatus === 'saved' ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400 shrink-0" />
                          <span>
                            Page {pageNumber + 1} auto-saved · ready for seamless reading
                          </span>
                        </>
                      ) : nextPageStatus === 'error' ? (
                        <>
                          <span>Could not auto-translate Page {pageNumber + 1}.</span>
                          <button
                            type="button"
                            onClick={() => {
                              reachedKeyRef.current = null;
                              onReachPageEnd();
                            }}
                            className="text-amber-700 dark:text-amber-400 font-medium underline cursor-pointer"
                          >
                            Retry
                          </button>
                        </>
                      ) : (
                        <span className="text-stone-500 dark:text-stone-400">
                          {autoPreloadNext
                            ? `End of Page ${pageNumber}`
                            : `End of Page ${pageNumber} · Auto-next paused`}
                        </span>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={onGoToNextPage}
                      className={`inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                        nextPageStatus === 'saved'
                          ? 'bg-amber-700 hover:bg-amber-800 text-white'
                          : 'border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#1F1E1B] text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800'
                      }`}
                    >
                      <span>Continue to Page {pageNumber + 1}</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <p className="text-xs text-stone-500 dark:text-stone-400 text-center">
                    End of book · Page {pageNumber} of {numPages}
                  </p>
                )}
              </div>
            </article>
          )}
        </div>

        {/* Floating Re-center Action when user scrolled away during active narration */}
        {isSpeaking && activeSentenceIndex !== null && (autoScrollPausedByUser || !autoScrollEnabled) && (
          <div className="sticky bottom-3 flex justify-end pointer-events-none mt-2">
            <button
              type="button"
              onClick={() => {
                setAutoScrollEnabled(true);
                setAutoScrollPausedByUser(false);
                window.requestAnimationFrame(() => centerActiveSentence(false));
              }}
              className="pointer-events-auto inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-amber-300 sepia:border-[#C9B387] dark:border-amber-700/80 bg-[#FAF9F5]/95 sepia:bg-[#F4ECD8]/95 dark:bg-[#1C1B19]/95 text-xs font-medium text-amber-900 sepia:text-[#5E3A14] dark:text-amber-300 shadow-md hover:bg-amber-50 dark:hover:bg-amber-950/70 transition-colors cursor-pointer whitespace-nowrap"
            >
              <LocateFixed className="w-3.5 h-3.5" />
              <span>Re-center speaking sentence</span>
            </button>
          </div>
        )}
      </div>

      {/* Collapsible Page Highlights & Study Notes Tray */}
      {showHighlightsTray && pageHighlights.length > 0 && (
        <div
          dir="ltr"
          className="shrink-0 border-t border-stone-200 dark:border-stone-800 bg-white dark:bg-[#181715] max-h-56 flex flex-col"
        >
          <div className="px-4 py-2 border-b border-stone-200/80 dark:border-stone-800 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-stone-600 dark:text-stone-300">
              Page {pageNumber} Highlights &amp; Notes ({pageHighlights.length})
            </span>
            <button
              type="button"
              onClick={() => setShowHighlightsTray(false)}
              className="text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 cursor-pointer"
              aria-label="Close highlights tray"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="overflow-y-auto divide-y divide-stone-200/70 dark:divide-stone-800/80">
            {pageHighlights.map((hl) => {
              const style = HIGHLIGHT_STYLE_MAP[hl.color] ?? HIGHLIGHT_STYLE_MAP.amber;
              return (
                <div
                  key={hl.id}
                  className="px-4 py-2.5 flex items-start justify-between gap-3 hover:bg-stone-50 dark:hover:bg-[#201F1C] transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => jumpToHighlightInPage(hl, 'note')}
                    className="flex-1 flex items-start gap-2.5 text-left min-w-0 cursor-pointer"
                  >
                    <span className={`mt-1 w-1 self-stretch rounded-full shrink-0 ${style.barClass}`} />
                    <div className="min-w-0 space-y-1">
                      <p
                        dir={langOption.rtl ? 'rtl' : 'ltr'}
                        className="text-xs text-stone-900 dark:text-stone-100 line-clamp-2"
                      >
                        “{hl.selectedText}”
                      </p>
                      {hl.note && hl.note.trim() ? (
                        <p className="text-xs text-stone-600 dark:text-stone-400 leading-snug">
                          {hl.note}
                        </p>
                      ) : (
                        <p className="text-[11px] text-stone-400 dark:text-stone-500">
                          Click to add a note…
                        </p>
                      )}
                    </div>
                  </button>

                  <div className="flex items-center gap-1 shrink-0">
                    {onShareQuote && (
                      <button
                        type="button"
                        onClick={() =>
                          onShareQuote({
                            id: hl.id,
                            quoteText: hl.selectedText,
                            note: hl.note,
                            highlightColor: hl.color,
                          })
                        }
                        title="Share as visual quote card"
                        className="h-7 w-7 inline-flex items-center justify-center rounded text-stone-500 hover:text-amber-700 dark:text-stone-400 dark:hover:text-amber-400 hover:bg-stone-200/60 dark:hover:bg-stone-800 cursor-pointer"
                      >
                        <Share2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => jumpToHighlightInPage(hl, 'dictionary')}
                      title="Look up in dictionary"
                      className="h-7 w-7 inline-flex items-center justify-center rounded text-stone-500 hover:text-amber-700 dark:text-stone-400 dark:hover:text-amber-400 hover:bg-stone-200/60 dark:hover:bg-stone-800 cursor-pointer"
                    >
                      <BookOpen className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteHighlightById(hl.id)}
                      title="Delete highlight"
                      className="h-7 w-7 inline-flex items-center justify-center rounded text-stone-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
};

export const TranslatedReaderPane = React.memo(TranslatedReaderPaneInner);
