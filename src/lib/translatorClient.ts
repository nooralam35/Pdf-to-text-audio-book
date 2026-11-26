import type {
  DictionaryLookupResult,
  LanguageCode,
  ParsedPage,
  SentenceSpan,
  TranslatedBlock,
  TranslatedPageRecord,
  TranslationEngine,
} from '../types';
import { makeTranslationKey } from './storage';

export interface ServerCapabilities {
  aiAvailable: boolean;
}

export async function checkServerCapabilities(): Promise<ServerCapabilities> {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return { aiAvailable: false };
    const data = (await res.json()) as { aiAvailable?: boolean };
    return { aiAvailable: Boolean(data.aiAvailable) };
  } catch {
    return { aiAvailable: false };
  }
}

export interface TranslatePageParams {
  bookId: string;
  bookTitle: string;
  parsedPage: ParsedPage;
  targetLang: LanguageCode;
  engine: TranslationEngine;
  preserveTerms: boolean;
  customTerms: string[];
  pageImageBase64?: string;
  signal?: AbortSignal;
}

export async function translatePageBlocks(
  params: TranslatePageParams
): Promise<TranslatedPageRecord> {
  const {
    bookId,
    bookTitle,
    parsedPage,
    targetLang,
    engine,
    preserveTerms,
    customTerms,
    pageImageBase64,
    signal,
  } = params;

  const key = makeTranslationKey(bookId, targetLang, parsedPage.pageNumber);

  // If page has no extractable text (e.g., blank or pure image page), still record figures cleanly
  if (parsedPage.blocks.length === 0) {
    return {
      key,
      bookId,
      pageNumber: parsedPage.pageNumber,
      lang: targetLang,
      engine,
      blocks: [],
      figures: parsedPage.figures,
      imageExplanations: [],
      updatedAt: Date.now(),
    };
  }

  // English clean script mode with free engine needs no network hop
  if (targetLang === 'en' && engine === 'free') {
    const blocks: TranslatedBlock[] = parsedPage.blocks.map((b) => ({
      ...b,
      translatedText: b.text,
    }));
    return {
      key,
      bookId,
      pageNumber: parsedPage.pageNumber,
      lang: targetLang,
      engine,
      blocks,
      figures: parsedPage.figures,
      imageExplanations: [],
      updatedAt: Date.now(),
    };
  }

  const endpoint = engine === 'ai' ? '/api/translate-ai' : '/api/translate-free';
  const payload =
    engine === 'ai'
      ? {
          blocks: parsedPage.blocks.map((b) => ({
            id: b.id,
            kind: b.kind,
            text: b.text,
          })),
          targetLang,
          preserveTerms,
          customTerms,
          pageImageBase64,
          bookTitle,
          pageNumber: parsedPage.pageNumber,
        }
      : {
          blocks: parsedPage.blocks.map((b) => ({
            id: b.id,
            kind: b.kind,
            text: b.text,
          })),
          targetLang,
          preserveTerms,
          customTerms,
        };

  const timeoutMs = engine === 'ai' ? 45000 : 22000;
  const maxAttempts = engine === 'free' ? 2 : 1;
  let response: Response | null = null;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Translation cancelled', 'AbortError');
    }
    if (attempt > 0) {
      await new Promise((r) => window.setTimeout(r, 650));
      if (signal?.aborted) {
        throw new DOMException('Translation cancelled', 'AbortError');
      }
    }

    const reqController = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => reqController.abort();
    if (signal) {
      signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    const timer = window.setTimeout(() => {
      timedOut = true;
      reqController.abort();
    }, timeoutMs);

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: reqController.signal,
      });

      if (res.ok) {
        response = res;
        break;
      }

      let errMsg = `Translation request failed (${res.status})`;
      try {
        const errBody = (await res.json()) as { error?: string };
        if (errBody.error) errMsg = errBody.error;
      } catch {
        // keep default message
      }
      lastError = new Error(errMsg);
      if (res.status < 500 && res.status !== 429) {
        throw lastError;
      }
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      if (timedOut) {
        lastError = new Error('Translation took too long. Please tap Retry.');
      } else {
        lastError = err instanceof Error ? err : new Error('Network error during translation.');
      }
    } finally {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  if (!response) {
    throw lastError ?? new Error('Translation failed. Please try again.');
  }

  const data = (await response.json()) as {
    translations?: Record<string, string>;
    imageExplanations?: string[];
  };

  const map = data.translations ?? {};
  const translatedBlocks: TranslatedBlock[] = parsedPage.blocks.map((b) => ({
    ...b,
    translatedText: (map[b.id] ?? b.text).trim(),
  }));

  return {
    key,
    bookId,
    pageNumber: parsedPage.pageNumber,
    lang: targetLang,
    engine,
    blocks: translatedBlocks,
    figures: parsedPage.figures,
    imageExplanations: Array.isArray(data.imageExplanations) ? data.imageExplanations : [],
    updatedAt: Date.now(),
  };
}

export interface TranslateBatchParams {
  bookId: string;
  parsedPages: ParsedPage[];
  targetLang: LanguageCode;
  preserveTerms: boolean;
  customTerms: string[];
  signal?: AbortSignal;
}

export interface TranslateBatchResult {
  records: TranslatedPageRecord[];
  failedPages: number[];
}

/**
 * Translates a wave of pages in a single parallelized server batch request
 * using the 100% free open engine with a per-request timeout guard and partial-success reporting.
 */
export async function translatePagesBatchFast(
  params: TranslateBatchParams
): Promise<TranslateBatchResult> {
  const { bookId, parsedPages, targetLang, preserveTerms, customTerms, signal } = params;
  const results = new Map<number, TranslatedPageRecord>();
  const networkPages: ParsedPage[] = [];
  const failedPages: number[] = [];

  for (const parsedPage of parsedPages) {
    const key = makeTranslationKey(bookId, targetLang, parsedPage.pageNumber);
    if (parsedPage.blocks.length === 0) {
      results.set(parsedPage.pageNumber, {
        key,
        bookId,
        pageNumber: parsedPage.pageNumber,
        lang: targetLang,
        engine: 'free',
        blocks: [],
        figures: parsedPage.figures,
        imageExplanations: [],
        updatedAt: Date.now(),
      });
    } else if (targetLang === 'en') {
      results.set(parsedPage.pageNumber, {
        key,
        bookId,
        pageNumber: parsedPage.pageNumber,
        lang: targetLang,
        engine: 'free',
        blocks: parsedPage.blocks.map((b) => ({ ...b, translatedText: b.text })),
        figures: parsedPage.figures,
        imageExplanations: [],
        updatedAt: Date.now(),
      });
    } else {
      networkPages.push(parsedPage);
    }
  }

  if (networkPages.length > 0) {
    // Combine user cancel signal with a 45-second socket timeout so mobile networks never hang indefinitely
    const reqController = new AbortController();
    let timedOut = false;
    const onUserAbort = () => reqController.abort();
    if (signal) {
      if (signal.aborted) {
        reqController.abort();
      } else {
        signal.addEventListener('abort', onUserAbort, { once: true });
      }
    }
    const timer = window.setTimeout(() => {
      timedOut = true;
      reqController.abort();
    }, 45000);

    let response: Response;
    try {
      response = await fetch('/api/translate-free-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pages: networkPages.map((p) => ({
            pageNumber: p.pageNumber,
            blocks: p.blocks.map((b) => ({
              id: b.id,
              kind: b.kind,
              text: b.text,
            })),
          })),
          targetLang,
          preserveTerms,
          customTerms,
        }),
        signal: reqController.signal,
      });
    } catch (err) {
      if (timedOut) {
        throw new Error('Batch request timed out — retrying automatically.');
      }
      throw err;
    } finally {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onUserAbort);
    }

    if (!response.ok) {
      let errMsg = `Fast batch translation failed (${response.status})`;
      try {
        const errBody = (await response.json()) as { error?: string };
        if (errBody.error) errMsg = errBody.error;
      } catch {
        // keep default
      }
      throw new Error(errMsg);
    }

    const data = (await response.json()) as {
      pages?: Record<string, Record<string, string>>;
      failedPages?: number[];
    };
    const pagesMap = data.pages ?? {};
    const failedSet = new Set<number>(Array.isArray(data.failedPages) ? data.failedPages : []);

    for (const parsedPage of networkPages) {
      const pageKeyStr = String(parsedPage.pageNumber);
      if (failedSet.has(parsedPage.pageNumber) || !pagesMap[pageKeyStr]) {
        failedPages.push(parsedPage.pageNumber);
        continue;
      }
      const key = makeTranslationKey(bookId, targetLang, parsedPage.pageNumber);
      const map = pagesMap[pageKeyStr];
      const translatedBlocks: TranslatedBlock[] = parsedPage.blocks.map((b) => ({
        ...b,
        translatedText: (map[b.id] ?? b.text).trim(),
      }));
      results.set(parsedPage.pageNumber, {
        key,
        bookId,
        pageNumber: parsedPage.pageNumber,
        lang: targetLang,
        engine: 'free',
        blocks: translatedBlocks,
        figures: parsedPage.figures,
        imageExplanations: [],
        updatedAt: Date.now(),
      });
    }
  }

  return {
    records: parsedPages
      .map((p) => results.get(p.pageNumber))
      .filter((r): r is TranslatedPageRecord => Boolean(r)),
    failedPages,
  };
}

export async function fetchFreeTtsBlob(
  text: string,
  targetLang: LanguageCode,
  signal?: AbortSignal
): Promise<Blob> {
  const response = await fetch('/api/tts-free', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, targetLang }),
    signal,
  });

  if (!response.ok) {
    let errMsg = `Speech playback failed (${response.status})`;
    try {
      const errBody = (await response.json()) as { error?: string };
      if (errBody.error) errMsg = errBody.error;
    } catch {
      // keep default
    }
    throw new Error(errMsg);
  }

  return response.blob();
}

export async function synthesizePageAudio(params: {
  text: string;
  voiceName: string;
  voiceStyle?: string;
  languageName: string;
  targetLang?: LanguageCode;
  sentenceKind?: string;
  modelTier?: 'flash' | 'lite';
  signal?: AbortSignal;
}): Promise<{ blob: Blob; ext: 'wav' | 'mp3' }> {
  const { signal, ...bodyPayload } = params;
  const response = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyPayload),
    signal,
  });

  if (!response.ok) {
    let errMsg = `Audio synthesis failed (${response.status})`;
    try {
      const errBody = (await response.json()) as { error?: string };
      if (errBody.error) errMsg = errBody.error;
    } catch {
      // keep default
    }
    throw new Error(errMsg);
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const ext: 'wav' | 'mp3' = contentType.includes('wav') ? 'wav' : 'mp3';
  const blob = await response.blob();
  return { blob, ext };
}

// Splits translated blocks into speakable sentences supporting Latin, Devanagari (।), and Urdu/Arabic (۔ ؟)
export function splitBlocksIntoSentences(
  blocks: TranslatedBlock[],
  imageExplanations: string[] = []
): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let globalIndex = 0;

  const pushText = (blockId: string, raw: string) => {
    const cleaned = raw.replace(/\s+/g, ' ').trim();
    if (!cleaned) return;

    // Match sentence chunks ending in punctuation or end-of-string
    const matches = cleaned.match(/[^.!?।۔؟]+(?:[.!?।۔؟]+["'”’)\]]*|$)/g);
    const parts = matches && matches.length > 0 ? matches : [cleaned];

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      spans.push({
        id: `${blockId}-s${globalIndex}`,
        blockId,
        text: trimmed,
        globalIndex,
      });
      globalIndex++;
    }
  };

  for (const block of blocks) {
    pushText(block.id, block.translatedText || block.text);
  }

  imageExplanations.forEach((exp, idx) => {
    pushText(`img-exp-${idx}`, exp);
  });

  return spans;
}

export function buildAudiobookText(record: TranslatedPageRecord): string {
  const lines: string[] = [];
  for (const b of record.blocks) {
    const t = (b.translatedText || b.text).trim();
    if (!t) continue;
    lines.push(t);
  }
  for (const exp of record.imageExplanations) {
    const cleaned = exp.replace(/^\[|\]$/g, '').trim();
    if (cleaned) lines.push(cleaned);
  }
  return lines.join('\n\n');
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function lookupDictionaryTerm(
  term: string,
  targetLang: LanguageCode,
  signal?: AbortSignal
): Promise<DictionaryLookupResult> {
  const response = await fetch('/api/dictionary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ term, targetLang }),
    signal,
  });

  if (!response.ok) {
    let errMsg = `Dictionary lookup failed (${response.status})`;
    try {
      const errBody = (await response.json()) as { error?: string };
      if (errBody.error) errMsg = errBody.error;
    } catch {
      // keep default
    }
    throw new Error(errMsg);
  }

  return (await response.json()) as DictionaryLookupResult;
}
