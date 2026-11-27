import type { ChapterItem, ParsedPage, TranslatedPageRecord } from '../types';

const STORAGE_KEY = 'bhashabook-reading-speed-v1';
const MAX_SAMPLES = 40;

export const DEFAULT_BASELINE_WPM = 200;
export const DEFAULT_WORDS_PER_PAGE = 260;

const MIN_VALID_WORDS = 20;
const MIN_VALID_SECONDS = 5;
const MAX_VALID_SECONDS = 900; // 15 minutes max active dwell per page
const MIN_VALID_WPM = 45;
const MAX_VALID_WPM = 850;

export interface PageTurnSample {
  bookId: string;
  pageNumber: number;
  wordCount: number;
  durationSeconds: number;
  wpm: number;
  recordedAt: number;
}

interface StoredReadingSpeedData {
  version: 1;
  samples: PageTurnSample[];
}

export interface ReadingSpeedSnapshot {
  /** Personalized rolling average WPM, or baseline 200 WPM before valid page turns are recorded */
  averageWpm: number;
  /** True once at least one valid page turn has been timed */
  isMeasured: boolean;
  /** Number of valid page turns included in history */
  sampleCount: number;
  /** WPM of the most recent recorded page turn, if any */
  lastPageWpm: number | null;
  /** Average words per page from recorded page turns (or fallback 260) */
  avgWordsPerPage: number;
  /** Total words read across stored page-turn samples */
  totalWordsTimed: number;
  /** Total active reading seconds across stored page-turn samples */
  totalSecondsTimed: number;
  /** Most recent samples (oldest to newest) */
  recentSamples: PageTurnSample[];
}

export interface ChapterReadingEstimate {
  chapterId: string;
  chapterTitle: string;
  totalPages: number;
  remainingPages: number;
  totalWords: number;
  remainingWords: number;
  totalMinutes: number;
  remainingMinutes: number;
  knownWordPages: number;
}

// Matches CJK ideographs, Hiragana, Katakana, Hangul Syllables, Thai, Lao, Khmer, Myanmar
const NON_SPACED_SCRIPT_RE =
  /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u0E00-\u0E7F\u0E80-\u0EFF\u1000-\u109F\u1780-\u17FF]/g;

/**
 * Counts readable words accurately across both space-delimited scripts
 * (Latin, Devanagari, Arabic/Urdu, Bengali, Tamil, Cyrillic, etc.)
 * and non-spaced scripts (Chinese, Japanese, Thai, Myanmar, Khmer).
 */
export function countReadableWords(text: string): number {
  if (!text) return 0;
  const normalized = text.trim();
  if (!normalized) return 0;

  let nonSpacedCount = 0;
  const withoutNonSpaced = normalized.replace(NON_SPACED_SCRIPT_RE, () => {
    nonSpacedCount += 1;
    return ' ';
  });

  const spacedWords = withoutNonSpaced
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token)).length;

  // Roughly 2 CJK/Thai characters ≈ 1 word equivalent for reading pace estimation
  const nonSpacedWords = nonSpacedCount > 0 ? Math.round(nonSpacedCount / 2) : 0;

  return spacedWords + nonSpacedWords;
}

/**
 * Counts words for a page using the translated text when available
 * (or the original text when preferOriginal is true or no translation exists).
 */
export function countPageWords(
  parsedPage?: ParsedPage | null,
  translatedPage?: TranslatedPageRecord | null,
  preferOriginal = false
): number {
  if (translatedPage && translatedPage.blocks.length > 0 && !preferOriginal) {
    let total = 0;
    for (const blk of translatedPage.blocks) {
      const txt = (blk.translatedText || blk.text || '').trim();
      if (txt) total += countReadableWords(txt);
    }
    if (total > 0) return total;
  }

  if (parsedPage && parsedPage.blocks.length > 0) {
    let total = 0;
    for (const blk of parsedPage.blocks) {
      const txt = (blk.text || '').trim();
      if (txt) total += countReadableWords(txt);
    }
    return total;
  }

  return 0;
}

function loadStoredData(): StoredReadingSpeedData {
  if (typeof window === 'undefined') {
    return { version: 1, samples: [] };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, samples: [] };
    const parsed = JSON.parse(raw) as Partial<StoredReadingSpeedData>;
    const rawSamples = Array.isArray(parsed?.samples) ? parsed.samples : [];
    const validSamples: PageTurnSample[] = rawSamples
      .filter(
        (s): s is PageTurnSample =>
          Boolean(s) &&
          typeof s.bookId === 'string' &&
          typeof s.pageNumber === 'number' &&
          Number.isFinite(s.wordCount) &&
          s.wordCount >= MIN_VALID_WORDS &&
          Number.isFinite(s.durationSeconds) &&
          s.durationSeconds >= MIN_VALID_SECONDS &&
          s.durationSeconds <= MAX_VALID_SECONDS &&
          Number.isFinite(s.wpm) &&
          s.wpm >= MIN_VALID_WPM &&
          s.wpm <= MAX_VALID_WPM &&
          Number.isFinite(s.recordedAt)
      )
      .slice(-MAX_SAMPLES);
    return { version: 1, samples: validSamples };
  } catch {
    return { version: 1, samples: [] };
  }
}

function saveStoredData(data: StoredReadingSpeedData): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // ignore quota / privacy-mode storage errors
  }
}

function buildSnapshot(samples: PageTurnSample[]): ReadingSpeedSnapshot {
  if (samples.length === 0) {
    return {
      averageWpm: DEFAULT_BASELINE_WPM,
      isMeasured: false,
      sampleCount: 0,
      lastPageWpm: null,
      avgWordsPerPage: DEFAULT_WORDS_PER_PAGE,
      totalWordsTimed: 0,
      totalSecondsTimed: 0,
      recentSamples: [],
    };
  }

  // Trim extreme 10% outlier tails once we have enough samples, then apply gentle recency weighting
  let pool = samples.map((sample, idx) => ({ sample, idx }));
  if (pool.length >= 6) {
    const sortedByWpm = [...pool].sort((a, b) => a.sample.wpm - b.sample.wpm);
    const trimCount = Math.max(1, Math.floor(sortedByWpm.length * 0.1));
    const trimmedSet = new Set(
      sortedByWpm.slice(trimCount, sortedByWpm.length - trimCount).map((entry) => entry.idx)
    );
    const filtered = pool.filter((entry) => trimmedSet.has(entry.idx));
    if (filtered.length > 0) {
      pool = filtered;
    }
  }

  let weightedWpmSum = 0;
  let totalWeight = 0;
  const maxIdx = Math.max(1, samples.length - 1);

  for (const { sample, idx } of pool) {
    // Recency weight ranges from 1.0 (oldest) to 1.6 (newest)
    const recencyWeight = 1 + 0.6 * (idx / maxIdx);
    // Longer pages carry slightly higher confidence than very short snippets
    const lengthWeight = Math.min(1.5, Math.max(0.5, sample.wordCount / 220));
    const weight = recencyWeight * lengthWeight;
    weightedWpmSum += sample.wpm * weight;
    totalWeight += weight;
  }

  const averageWpm = Math.max(
    MIN_VALID_WPM,
    Math.min(MAX_VALID_WPM, Math.round(weightedWpmSum / Math.max(0.001, totalWeight)))
  );

  let totalWordsTimed = 0;
  let totalSecondsTimed = 0;
  for (const s of samples) {
    totalWordsTimed += s.wordCount;
    totalSecondsTimed += s.durationSeconds;
  }

  const avgWordsPerPage = Math.max(
    80,
    Math.round(totalWordsTimed / samples.length)
  );
  const lastSample = samples[samples.length - 1];

  return {
    averageWpm,
    isMeasured: true,
    sampleCount: samples.length,
    lastPageWpm: Math.round(lastSample.wpm),
    avgWordsPerPage,
    totalWordsTimed,
    totalSecondsTimed: Math.round(totalSecondsTimed),
    recentSamples: samples.slice(-10),
  };
}

export function getReadingSpeedSnapshot(): ReadingSpeedSnapshot {
  const data = loadStoredData();
  return buildSnapshot(data.samples);
}

/**
 * Records a completed page turn if it represents genuine reading activity
 * (filters out instant skips, blank/cover pages, and long idle pauses).
 */
export function recordPageTurnSample(params: {
  bookId: string;
  pageNumber: number;
  wordCount: number;
  durationSeconds: number;
}): ReadingSpeedSnapshot {
  const data = loadStoredData();
  const { bookId, pageNumber, wordCount, durationSeconds } = params;

  if (
    !bookId ||
    !Number.isFinite(pageNumber) ||
    !Number.isFinite(wordCount) ||
    !Number.isFinite(durationSeconds) ||
    wordCount < MIN_VALID_WORDS ||
    durationSeconds < MIN_VALID_SECONDS ||
    durationSeconds > MAX_VALID_SECONDS
  ) {
    return buildSnapshot(data.samples);
  }

  const rawWpm = (wordCount / durationSeconds) * 60;
  if (!Number.isFinite(rawWpm) || rawWpm < MIN_VALID_WPM || rawWpm > MAX_VALID_WPM) {
    return buildSnapshot(data.samples);
  }

  const now = Date.now();
  // Avoid double-recording the exact same page within 10 seconds
  const prev = data.samples[data.samples.length - 1];
  if (
    prev &&
    prev.bookId === bookId &&
    prev.pageNumber === pageNumber &&
    now - prev.recordedAt < 10_000
  ) {
    return buildSnapshot(data.samples);
  }

  const nextSample: PageTurnSample = {
    bookId,
    pageNumber,
    wordCount: Math.round(wordCount),
    durationSeconds: Math.round(durationSeconds * 10) / 10,
    wpm: Math.round(rawWpm),
    recordedAt: now,
  };

  const nextSamples = [...data.samples, nextSample].slice(-MAX_SAMPLES);
  saveStoredData({ version: 1, samples: nextSamples });
  return buildSnapshot(nextSamples);
}

export function resetReadingSpeedHistory(): ReadingSpeedSnapshot {
  saveStoredData({ version: 1, samples: [] });
  return buildSnapshot([]);
}

/**
 * Estimates total and remaining reading time for a chapter based on the user's WPM
 * and known word counts per page (falling back to average words/page for unparsed pages).
 */
export function estimateChapterFinishTime(params: {
  chapter: ChapterItem | null;
  currentPage: number;
  wpm: number;
  knownPageWordCounts?: Record<number, number>;
  fallbackWordsPerPage?: number;
}): ChapterReadingEstimate | null {
  const {
    chapter,
    currentPage,
    wpm,
    knownPageWordCounts = {},
    fallbackWordsPerPage = DEFAULT_WORDS_PER_PAGE,
  } = params;

  if (!chapter) return null;

  const safeWpm = Math.max(MIN_VALID_WPM, Number.isFinite(wpm) ? wpm : DEFAULT_BASELINE_WPM);
  const safeFallback = Math.max(80, Math.round(fallbackWordsPerPage || DEFAULT_WORDS_PER_PAGE));

  const start = Math.max(1, chapter.startPage);
  const end = Math.max(start, chapter.endPage);
  const totalPages = end - start + 1;

  const clampedCurrent = Math.min(end, Math.max(start, currentPage));
  const remainingPages = end - clampedCurrent + 1;

  let totalWords = 0;
  let remainingWords = 0;
  let knownWordPages = 0;

  for (let p = start; p <= end; p++) {
    const known = knownPageWordCounts[p];
    const pageWords =
      typeof known === 'number' && Number.isFinite(known) && known > 0
        ? known
        : safeFallback;
    if (typeof known === 'number' && Number.isFinite(known) && known > 0) {
      knownWordPages += 1;
    }
    totalWords += pageWords;
    if (p >= clampedCurrent) {
      remainingWords += pageWords;
    }
  }

  return {
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    totalPages,
    remainingPages,
    totalWords,
    remainingWords,
    totalMinutes: totalWords / safeWpm,
    remainingMinutes: remainingWords / safeWpm,
    knownWordPages,
  };
}

/**
 * Formats a minute duration cleanly for reader badges and chapter lists.
 * Examples: "< 1 min", "6 min", "1h 12m", "2h".
 */
export function formatReadingDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '< 1 min';
  if (minutes < 0.75) return '< 1 min';
  const rounded = Math.max(1, Math.round(minutes));
  if (rounded < 60) {
    return `${rounded} min`;
  }
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}
