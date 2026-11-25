export type LanguageCode =
  | 'hi'
  | 'hinglish'
  | 'bn'
  | 'ta'
  | 'te'
  | 'mr'
  | 'ur'
  | 'es'
  | 'fr'
  | 'de'
  | 'ar'
  | 'en';

export type TranslationEngine = 'free' | 'ai';

export interface LanguageOption {
  code: LanguageCode;
  name: string;
  nativeName: string;
  speechLang: string;
  canvasFont: string;
  cssClass: string;
  rtl?: boolean;
}

export type BlockKind =
  | 'heading'
  | 'subheading'
  | 'paragraph'
  | 'bullet'
  | 'callout'
  | 'caption'
  | 'table';

export interface TextBlock {
  id: string;
  kind: BlockKind;
  text: string;
  yPercent: number; // 0..100 from top of page
  fontSize: number;
}

export interface ExtractedFigure {
  id: string;
  dataUrl: string;
  yPercent: number; // 0..100 vertical center/top on original page
  widthRatio: number; // 0..1 of page width
  heightRatio: number; // 0..1 of page height
  aspectRatio: number;
}

export interface ParsedPage {
  pageNumber: number;
  width: number;
  height: number;
  blocks: TextBlock[];
  figures: ExtractedFigure[];
  isBlank: boolean;
  isOcr?: boolean;
}

export interface TranslatedBlock extends TextBlock {
  translatedText: string;
}

export type TextHighlightColor = 'amber' | 'sage' | 'sky' | 'rose';

export interface TextHighlight {
  id: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  selectedText: string;
  color: TextHighlightColor;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DictionaryMeaning {
  partOfSpeech: string;
  definition: string;
  example?: string;
  synonyms?: string[];
}

export interface DictionaryLookupResult {
  term: string;
  phonetic?: string;
  englishEquivalent?: string;
  targetEquivalent?: string;
  meanings: DictionaryMeaning[];
  summary?: string;
  source: string;
}

export interface TranslatedPageRecord {
  key: string; // `${bookId}::${lang}::${pageNumber}`
  bookId: string;
  pageNumber: number;
  lang: LanguageCode;
  engine: TranslationEngine;
  blocks: TranslatedBlock[];
  figures: ExtractedFigure[];
  imageExplanations: string[];
  highlights?: TextHighlight[];
  updatedAt: number;
}

export interface ChapterItem {
  id: string;
  index: number;
  title: string;
  startPage: number; // 1-based PDF page
  endPage: number;   // 1-based PDF page
  bookPageLabel?: string;
}

export interface StoredBook {
  id: string;
  title: string;
  author: string;
  fileName: string;
  numPages: number;
  coverDataUrl: string;
  chapters: ChapterItem[];
  sourceUrl?: string;
  pdfData?: ArrayBuffer;
  addedAt: number;
  lastPage: number;
  pageWidth?: number;
  pageHeight?: number;
  annotations?: Record<number, PageAnnotationLayer>;
  bookmarks?: number[];
  externalSource?: BookSearchSource;
  externalUrl?: string;
}

export type BookSearchSource = 'internet_archive' | 'open_library' | 'gutenberg';

export type BookCategory =
  | 'all'
  | 'programming'
  | 'business'
  | 'science'
  | 'history'
  | 'fiction'
  | 'self_help';

export type BookFormatFilter = 'all' | 'pdf' | 'text' | 'online';

export type BookSortBy = 'downloads' | 'rating' | 'latest';

export interface DiscoveredBook {
  id: string;
  source: BookSearchSource;
  identifier: string;
  title: string;
  author: string;
  year?: number;
  language: string;
  pageCount?: number;
  downloads?: number;
  rating?: number;
  subjects: string[];
  description?: string;
  coverUrl?: string;
  pdfUrl?: string;
  textUrl?: string;
  epubUrl?: string;
  readOnlineUrl?: string;
  format: 'PDF' | 'EPUB / Text' | 'Read Online';
  isbn?: string;
}

export type ReadingTheme = 'light' | 'sepia' | 'dark';

export interface ChapterSummaryResult {
  chapterTitle: string;
  summary: string;
  keyTakeaways: string[];
  keyTerms: string[];
  readingTimeMinutes: number;
  source: 'ai' | 'extractive';
}

export interface SentenceSpan {
  id: string;
  blockId: string;
  text: string;
  globalIndex: number;
}

export type AnnotationTool = 'cursor' | 'highlight' | 'pen' | 'note' | 'eraser';

export interface AnnotationPoint {
  x: number; // normalized 0..1 relative to PDF page width
  y: number; // normalized 0..1 relative to PDF page height
}

export interface AnnotationStroke {
  id: string;
  mode: 'highlight' | 'pen';
  color: string;
  width: number; // base brush size at 540px reference width
  opacity: number; // 0.1..1.0
  points: AnnotationPoint[];
}

export interface StickyNote {
  id: string;
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  text: string;
  color: 'amber' | 'sage' | 'sky' | 'rose';
  createdAt: number;
  updatedAt: number;
}

export interface PageAnnotationLayer {
  strokes: AnnotationStroke[];
  notes: StickyNote[];
  canvasDataUrl?: string; // transparent PNG snapshot of the HTML5 Canvas layer
  updatedAt: number;
}

export interface PageAnnotationRecord extends PageAnnotationLayer {
  key: string; // `${bookId}::${pageNumber}`
  bookId: string;
  pageNumber: number;
}

export interface BatchTranslationProgress {
  label: string;
  startPage: number;
  endPage: number;
  current: number;
  total: number;
  currentPage: number;
  startedAt: number;
  newlyTranslated: number;
  skippedCached: number;
  statusNote?: string;
}
