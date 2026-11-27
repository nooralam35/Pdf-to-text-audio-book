import type { ChapterItem, ParsedPage, TranslatedPageRecord } from '../types';
import { extractPagePlainText, type LoadedPdf } from './pdfEngine';
import { listParsedPagesForBook } from './storage';

export type BookSearchScope = 'all' | 'translated' | 'original';

export interface SearchMatchRange {
  start: number;
  end: number;
}

export interface BookSearchMatch {
  id: string;
  pageNumber: number;
  chapterTitle?: string;
  source: 'translated' | 'original';
  /** 0-based index of this occurrence among all matches of the same source on this page */
  matchIndexOnPage: number;
  snippetBefore: string;
  matchedText: string;
  snippetAfter: string;
}

export interface BookSearchProgress {
  scannedPages: number;
  totalPages: number;
  matchesFound: number;
}

const MAX_TOTAL_MATCHES = 400;
const MAX_MATCHES_PER_PAGE_SOURCE = 25;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a whitespace-tolerant regex for phrase search so multi-word queries
 * still match across line breaks or double spaces in PDF/translated text.
 */
function buildSearchRegex(query: string, caseSensitive: boolean): RegExp | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const tokens = trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => escapeRegExp(tok));
  if (tokens.length === 0) return null;

  const pattern = tokens.join('\\s+');
  return new RegExp(pattern, caseSensitive ? 'gu' : 'giu');
}

/**
 * Finds all non-overlapping character ranges matching `query` inside `text`.
 * Used both for global book search and for inline text highlighting in the reader.
 */
export function findSearchRangesInText(
  text: string,
  query: string,
  caseSensitive = false
): SearchMatchRange[] {
  if (!text || !query.trim()) return [];
  const re = buildSearchRegex(query, caseSensitive);
  if (!re) return [];

  const ranges: SearchMatchRange[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const matched = match[0];
    if (!matched) {
      re.lastIndex += 1;
      continue;
    }
    ranges.push({
      start: match.index,
      end: match.index + matched.length,
    });
    if (ranges.length >= 200) break;
  }
  return ranges;
}

function buildSnippet(
  fullText: string,
  start: number,
  end: number,
  contextRadius = 48
): { before: string; match: string; after: string } {
  const rawBeforeStart = Math.max(0, start - contextRadius);
  const rawAfterEnd = Math.min(fullText.length, end + contextRadius);

  let before = fullText.slice(rawBeforeStart, start);
  let after = fullText.slice(end, rawAfterEnd);

  // Trim partial words at the outer edges of the snippet when truncated
  if (rawBeforeStart > 0) {
    const firstSpace = before.indexOf(' ');
    if (firstSpace > 0 && firstSpace < 16) {
      before = before.slice(firstSpace + 1);
    }
    before = `…${before}`;
  }
  if (rawAfterEnd < fullText.length) {
    const lastSpace = after.lastIndexOf(' ');
    if (lastSpace > after.length - 16 && lastSpace > 0) {
      after = after.slice(0, lastSpace);
    }
    after = `${after}…`;
  }

  return {
    before,
    match: fullText.slice(start, end),
    after,
  };
}

function findChapterTitle(chapters: ChapterItem[], pageNumber: number): string | undefined {
  const ch = chapters.find((c) => pageNumber >= c.startPage && pageNumber <= c.endPage);
  return ch?.title;
}

function collectMatchesInPageText(params: {
  text: string;
  query: string;
  caseSensitive: boolean;
  pageNumber: number;
  chapterTitle?: string;
  source: 'translated' | 'original';
  remainingQuota: number;
}): BookSearchMatch[] {
  const { text, query, caseSensitive, pageNumber, chapterTitle, source, remainingQuota } = params;
  if (!text || remainingQuota <= 0) return [];

  const ranges = findSearchRangesInText(text, query, caseSensitive);
  if (ranges.length === 0) return [];

  const limit = Math.min(ranges.length, MAX_MATCHES_PER_PAGE_SOURCE, remainingQuota);
  const results: BookSearchMatch[] = [];

  for (let i = 0; i < limit; i++) {
    const range = ranges[i];
    const snippet = buildSnippet(text, range.start, range.end);
    results.push({
      id: `p${pageNumber}-${source}-${i}`,
      pageNumber,
      chapterTitle,
      source,
      matchIndexOnPage: i,
      snippetBefore: snippet.before,
      matchedText: snippet.match,
      snippetAfter: snippet.after,
    });
  }
  return results;
}

/**
 * Searches for a term or phrase across ALL pages (1..numPages) of the active book.
 * Searches both translated pages (when available) and original PDF/OCR text so every
 * page in the book is searchable immediately—even pages not yet opened or translated.
 */
export async function searchEntireBook(params: {
  bookId: string;
  numPages: number;
  pdf: LoadedPdf | null;
  chapters: ChapterItem[];
  bookTranslations: TranslatedPageRecord[];
  currentParsedPage?: ParsedPage | null;
  query: string;
  scope?: BookSearchScope;
  caseSensitive?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: BookSearchProgress, partialMatches: BookSearchMatch[]) => void;
}): Promise<{ matches: BookSearchMatch[]; truncated: boolean }> {
  const {
    bookId,
    numPages,
    pdf,
    chapters,
    bookTranslations,
    currentParsedPage,
    query,
    scope = 'all',
    caseSensitive = false,
    signal,
    onProgress,
  } = params;

  const trimmed = query.trim();
  if (!trimmed || numPages <= 0) {
    return { matches: [], truncated: false };
  }

  const translationByPage = new Map<number, TranslatedPageRecord>();
  for (const tr of bookTranslations) {
    translationByPage.set(tr.pageNumber, tr);
  }

  let parsedByPage = new Map<number, ParsedPage>();
  try {
    parsedByPage = await listParsedPagesForBook(bookId);
  } catch {
    parsedByPage = new Map();
  }
  if (currentParsedPage) {
    parsedByPage.set(currentParsedPage.pageNumber, currentParsedPage);
  }

  const matches: BookSearchMatch[] = [];
  let truncated = false;

  for (let p = 1; p <= numPages; p++) {
    if (signal?.aborted) {
      return { matches, truncated };
    }

    const chapterTitle = findChapterTitle(chapters, p);
    const tr = translationByPage.get(p);
    const parsed = parsedByPage.get(p);

    let translatedText = '';
    if (tr && (scope === 'all' || scope === 'translated')) {
      const blockTexts = tr.blocks.map((b) => (b.translatedText || b.text || '').trim()).filter(Boolean);
      const expTexts = (tr.imageExplanations ?? []).map((e) => e.trim()).filter(Boolean);
      translatedText = [...blockTexts, ...expTexts].join(' ');

      const trHits = collectMatchesInPageText({
        text: translatedText,
        query: trimmed,
        caseSensitive,
        pageNumber: p,
        chapterTitle,
        source: 'translated',
        remainingQuota: MAX_TOTAL_MATCHES - matches.length,
      });
      matches.push(...trHits);
    }

    if (matches.length >= MAX_TOTAL_MATCHES) {
      truncated = true;
      onProgress?.(
        { scannedPages: p, totalPages: numPages, matchesFound: matches.length },
        [...matches]
      );
      break;
    }

    if (scope === 'all' || scope === 'original') {
      let originalText = '';
      if (tr) {
        originalText = tr.blocks
          .map((b) => (b.text || '').trim())
          .filter(Boolean)
          .join(' ');
      } else if (parsed) {
        originalText = parsed.blocks
          .map((b) => (b.text || '').trim())
          .filter(Boolean)
          .join(' ');
      } else if (pdf) {
        originalText = await extractPagePlainText(pdf, p);
      }

      if (signal?.aborted) {
        return { matches, truncated };
      }

      // When targetLang is 'orig' or translated text is identical to original text,
      // avoid emitting duplicate hits in 'all' mode
      const isDuplicateOfTranslated =
        scope === 'all' &&
        Boolean(translatedText) &&
        originalText.trim() === translatedText.trim();

      if (originalText && !isDuplicateOfTranslated) {
        const origHits = collectMatchesInPageText({
          text: originalText,
          query: trimmed,
          caseSensitive,
          pageNumber: p,
          chapterTitle,
          source: 'original',
          remainingQuota: MAX_TOTAL_MATCHES - matches.length,
        });
        matches.push(...origHits);
      }
    }

    if (matches.length >= MAX_TOTAL_MATCHES) {
      truncated = true;
      onProgress?.(
        { scannedPages: p, totalPages: numPages, matchesFound: matches.length },
        [...matches]
      );
      break;
    }

    // Yield periodically on multi-page scans to keep typing and UI interactions silky smooth
    if (p % 10 === 0 || p === numPages) {
      onProgress?.(
        { scannedPages: p, totalPages: numPages, matchesFound: matches.length },
        [...matches]
      );
      if (p < numPages) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  return { matches, truncated };
}
