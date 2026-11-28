import type {
  DictionaryLookupResult,
  LanguageCode,
  ParsedPage,
  SentenceSpan,
  TranslatedBlock,
  TranslatedPageRecord,
  TranslationEngine,
  TranslationStyle,
} from '../types';
import { makeTranslationKey } from './storage';

export const DEFAULT_TUTOR_PROMPT =
  'Act as an expert translator and tutor. Translate and explain the content in simple, conversational Hindi, breaking down complex concepts with everyday examples familiar to an Indian audience.';

export interface SafeJsonResult<T> {
  ok: boolean;
  data?: T;
  isHtml: boolean;
  errorMessage?: string;
}

export function sanitizeUserFacingError(
  err: unknown,
  fallback = 'Temporary connection issue. Please try again.'
): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const cleaned = raw.trim();
  if (!cleaned) return fallback;
  if (/unexpected token\s*['"]?<|<!doctype|<html|is not valid json|unexpected end of json/i.test(cleaned)) {
    return 'Server was briefly reconnecting. Please wait a moment or tap Retry.';
  }
  return cleaned;
}

export async function parseJsonResponseSafe<T>(response: Response): Promise<SafeJsonResult<T>> {
  try {
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const rawText = await response.text();
    const trimmed = rawText.trim();
    const looksLikeHtml =
      contentType.includes('text/html') ||
      trimmed.startsWith('<') ||
      /^<!doctype/i.test(trimmed);

    if (!trimmed || looksLikeHtml) {
      return {
        ok: false,
        isHtml: looksLikeHtml,
        errorMessage: looksLikeHtml
          ? 'Server returned a temporary web page while reconnecting.'
          : 'Server returned an empty response.',
      };
    }

    const parsed = JSON.parse(trimmed) as T;
    return { ok: true, data: parsed, isHtml: false };
  } catch {
    return {
      ok: false,
      isHtml: false,
      errorMessage: 'Received an incomplete response from the server.',
    };
  }
}

async function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Client-side language code mapping for direct browser emergency fallback (CORS-enabled public endpoints)
const BROWSER_FALLBACK_GTX_CODES: Record<LanguageCode, string> = {
  orig: 'en',
  hi: 'hi',
  sa: 'sa',
  hinglish: 'hi',
  mr: 'mr',
  ur: 'ur',
  ar: 'ar',
  fa: 'fa',
  bn: 'bn',
  ta: 'ta',
  te: 'te',
  gu: 'gu',
  pa: 'pa',
  kn: 'kn',
  ml: 'ml',
  or: 'or',
  ne: 'ne',
  en: 'en',
  zh: 'zh-CN',
  ja: 'ja',
  ko: 'ko',
  ru: 'ru',
  es: 'es',
  fr: 'fr',
  de: 'de',
  pt: 'pt',
  it: 'it',
  tr: 'tr',
  id: 'id',
  th: 'th',
  vi: 'vi',
  he: 'iw',
  uk: 'uk',
};

function parseGtxSegments(data: unknown): string {
  if (Array.isArray(data) && Array.isArray(data[0])) {
    return data[0]
      .map((seg: unknown) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : ''))
      .join('');
  }
  return '';
}

async function translateSingleTextDirectBrowser(
  text: string,
  tlCode: string,
  signal?: AbortSignal
): Promise<string | null> {
  const clean = text.trim();
  if (!clean) return '';

  // Primary direct browser fallback: CORS-enabled translate.googleapis.com GTX endpoint
  try {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = window.setTimeout(() => controller.abort(), 9000);
    try {
      const url = new URL('https://translate.googleapis.com/translate_a/single');
      url.searchParams.set('client', 'gtx');
      url.searchParams.set('sl', 'auto');
      url.searchParams.set('tl', tlCode);
      url.searchParams.set('dt', 't');
      url.searchParams.set('q', clean.slice(0, 1800));

      const res = await fetch(url.toString(), { signal: controller.signal });
      if (res.ok) {
        const parsed = await parseJsonResponseSafe<unknown>(res);
        if (parsed.ok) {
          const joined = parseGtxSegments(parsed.data);
          if (joined.trim()) return joined.trim();
        }
      }
    } finally {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  } catch (err) {
    if (signal?.aborted) throw err;
  }

  // Secondary direct browser fallback: CORS-enabled MyMemory API (for concise blocks)
  if (clean.length <= 480) {
    try {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = window.setTimeout(() => controller.abort(), 8000);
      try {
        const mmUrl = new URL('https://api.mymemory.translated.net/get');
        mmUrl.searchParams.set('q', clean);
        mmUrl.searchParams.set('langpair', `autodetect|${tlCode === 'iw' ? 'he' : tlCode}`);
        const res = await fetch(mmUrl.toString(), { signal: controller.signal });
        if (res.ok) {
          const parsed = await parseJsonResponseSafe<{
            responseStatus?: number;
            responseData?: { translatedText?: string };
          }>(res);
          const out = parsed.data?.responseData?.translatedText?.trim();
          if (parsed.ok && parsed.data?.responseStatus === 200 && out) {
            return out;
          }
        }
      } finally {
        window.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }

  return null;
}

async function translateBlocksDirectBrowserFallback(
  blocks: Array<{ id: string; text: string }>,
  targetLang: LanguageCode,
  signal?: AbortSignal
): Promise<Record<string, string> | null> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return null;
  }
  const tlCode = BROWSER_FALLBACK_GTX_CODES[targetLang] ?? 'hi';
  const result: Record<string, string> = {};
  const nonEmpty = blocks.filter((b) => b.text.trim().length > 0);
  if (nonEmpty.length === 0) return result;

  // Group into compact chunks of <=1500 chars with a numeric delimiter for fast direct translation
  const chunks: Array<Array<{ id: string; text: string }>> = [];
  let current: Array<{ id: string; text: string }> = [];
  let currentLen = 0;
  for (const blk of nonEmpty) {
    const t = blk.text.trim();
    if (current.length > 0 && (currentLen + t.length > 1400 || current.length >= 10)) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push({ id: blk.id, text: t });
    currentLen += t.length + 14;
  }
  if (current.length > 0) chunks.push(current);

  let translatedCount = 0;
  for (const chunk of chunks) {
    if (signal?.aborted) {
      throw new DOMException('Translation cancelled', 'AbortError');
    }

    if (chunk.length === 1) {
      const one = await translateSingleTextDirectBrowser(chunk[0].text, tlCode, signal);
      if (one) {
        result[chunk[0].id] = one;
        translatedCount++;
      }
      continue;
    }

    const joined = chunk.map((c) => c.text).join('\n###9901###\n');
    const batchOut = await translateSingleTextDirectBrowser(joined, tlCode, signal);
    const parts = batchOut ? batchOut.split(/\s*###\s*[9९۹][9९۹][0०۰][1१۱]\s*###\s*/) : [];
    if (parts.length === chunk.length) {
      for (let i = 0; i < chunk.length; i++) {
        const piece = parts[i]?.trim();
        if (piece) {
          result[chunk[i].id] = piece;
          translatedCount++;
        }
      }
      continue;
    }

    // Per-block direct recovery if delimiter split didn't align
    for (const item of chunk) {
      const single = await translateSingleTextDirectBrowser(item.text, tlCode, signal);
      if (single) {
        result[item.id] = single;
        translatedCount++;
      }
    }
  }

  return translatedCount > 0 ? result : null;
}

async function postJsonWithAutoRetry<T>(
  endpoint: string,
  payload: unknown,
  options: {
    timeoutMs: number;
    maxAttempts: number;
    signal?: AbortSignal;
  }
): Promise<T> {
  const { timeoutMs, maxAttempts, signal } = options;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Translation cancelled', 'AbortError');
    }
    if (attempt > 0) {
      await waitWithAbort(attempt === 1 ? 650 : 1450, signal);
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
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: reqController.signal,
      });

      const parsed = await parseJsonResponseSafe<T & { error?: string }>(res);

      if (res.ok && parsed.ok && parsed.data !== undefined) {
        return parsed.data;
      }

      // If proxy/server returned HTML (even with 200 OK!) or non-JSON, always treat as retriable transient hiccup
      if (parsed.isHtml || !parsed.ok) {
        lastError = new Error(
          parsed.isHtml
            ? 'Server was briefly reconnecting. Retrying automatically.'
            : parsed.errorMessage || `Translation request failed (${res.status})`
        );
        continue;
      }

      const serverMsg =
        parsed.data && typeof parsed.data.error === 'string' && parsed.data.error.trim()
          ? sanitizeUserFacingError(parsed.data.error)
          : `Translation request failed (${res.status})`;
      lastError = new Error(serverMsg);

      // Non-retriable 4xx validation error (except 408/413/429)
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 413 && res.status !== 429) {
        throw lastError;
      }
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      if (timedOut) {
        lastError = new Error('Translation took too long — retrying automatically.');
      } else {
        lastError = new Error(sanitizeUserFacingError(err, 'Network error during translation.'));
      }
    } finally {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  throw lastError ?? new Error('Translation service is temporarily busy. Please tap Retry.');
}

export interface ServerCapabilities {
  aiAvailable: boolean;
}

export async function checkServerCapabilities(): Promise<ServerCapabilities> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch('/api/health', {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        const parsed = await parseJsonResponseSafe<{ aiAvailable?: boolean }>(res);
        if (parsed.ok && parsed.data) {
          return { aiAvailable: Boolean(parsed.data.aiAvailable) };
        }
      }
    } catch {
      // retry once below
    }
    if (attempt === 0) {
      await new Promise((r) => window.setTimeout(r, 450));
    }
  }
  return { aiAvailable: false };
}

export interface TranslatePageParams {
  bookId: string;
  bookTitle: string;
  parsedPage: ParsedPage;
  targetLang: LanguageCode;
  engine: TranslationEngine;
  translationStyle?: TranslationStyle;
  tutorPrompt?: string;
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
    translationStyle = 'tutor',
    tutorPrompt,
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

  // Original Book ("same to same") mode preserves the exact PDF text without modifying a single character
  if (targetLang === 'orig') {
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

  type TranslateApiPayload = {
    translations?: Record<string, string>;
    imageExplanations?: string[];
    engine?: string;
    translationStyle?: TranslationStyle;
    fallbackUsed?: boolean;
  };

  const compactBlocks = parsedPage.blocks.map((b) => ({
    id: b.id,
    kind: b.kind,
    text: b.text,
  }));

  const freePayload = {
    blocks: compactBlocks,
    targetLang,
    preserveTerms,
    customTerms,
  };

  let data: TranslateApiPayload | null = null;
  let effectiveEngine: TranslationEngine = engine;
  let lastErr: unknown = null;

  // Tier 1: Requested Engine (AI with multimodal -> text-only retry, or Free Open with 3 auto-retries)
  if (engine === 'ai') {
    const aiPayload = {
      blocks: compactBlocks,
      targetLang,
      preserveTerms,
      customTerms,
      pageImageBase64,
      bookTitle,
      pageNumber: parsedPage.pageNumber,
      translationStyle,
      tutorPrompt,
    };
    try {
      data = await postJsonWithAutoRetry<TranslateApiPayload>('/api/translate-ai', aiPayload, {
        timeoutMs: 42000,
        maxAttempts: 2,
        signal,
      });
      if (data.engine === 'free-open' || data.fallbackUsed) {
        effectiveEngine = 'free';
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
      // If payload included a large page screenshot, retry AI once text-only before falling back
      if (pageImageBase64) {
        try {
          data = await postJsonWithAutoRetry<TranslateApiPayload>(
            '/api/translate-ai',
            { ...aiPayload, pageImageBase64: undefined },
            { timeoutMs: 32000, maxAttempts: 1, signal }
          );
          if (data.engine === 'free-open' || data.fallbackUsed) {
            effectiveEngine = 'free';
          }
        } catch (textOnlyErr) {
          if (signal?.aborted) throw textOnlyErr;
          lastErr = textOnlyErr;
        }
      }
    }
  }

  // Tier 2: Automatic Free Open Engine (primary when engine==='free', or seamless auto-fallback when AI failed)
  if (!data) {
    try {
      data = await postJsonWithAutoRetry<TranslateApiPayload>('/api/translate-free', freePayload, {
        timeoutMs: 24000,
        maxAttempts: 3,
        signal,
      });
      effectiveEngine = 'free';
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
    }
  }

  // Tier 3: Automatic Direct Browser Fallback (recovers seamlessly even if preview proxy briefly returns HTML)
  if (!data) {
    const directMap = await translateBlocksDirectBrowserFallback(compactBlocks, targetLang, signal);
    if (directMap) {
      data = {
        translations: directMap,
        imageExplanations: [],
        engine: 'free-open',
      };
      effectiveEngine = 'free';
    }
  }

  if (!data) {
    throw new Error(
      sanitizeUserFacingError(lastErr, 'Translation could not complete. Please tap Retry.')
    );
  }

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
    engine: effectiveEngine,
    translationStyle:
      effectiveEngine === 'ai' ? (data.translationStyle ?? translationStyle) : undefined,
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
    } else if (targetLang === 'orig') {
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
    type BatchApiPayload = {
      pages?: Record<string, Record<string, string>>;
      failedPages?: number[];
    };

    let data: BatchApiPayload | null = null;
    try {
      data = await postJsonWithAutoRetry<BatchApiPayload>(
        '/api/translate-free-batch',
        {
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
        },
        {
          timeoutMs: 45000,
          maxAttempts: 2,
          signal,
        }
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      // Direct browser emergency recovery per page if server proxy transiently returned HTML
      const recoveredPages: Record<string, Record<string, string>> = {};
      const stillFailed: number[] = [];
      for (const np of networkPages) {
        const directMap = await translateBlocksDirectBrowserFallback(
          np.blocks.map((b) => ({ id: b.id, text: b.text })),
          targetLang,
          signal
        );
        if (directMap) {
          recoveredPages[String(np.pageNumber)] = directMap;
        } else {
          stillFailed.push(np.pageNumber);
        }
      }
      if (Object.keys(recoveredPages).length > 0) {
        data = { pages: recoveredPages, failedPages: stillFailed };
      } else {
        throw new Error(
          sanitizeUserFacingError(err, 'Batch translation briefly paused — retrying automatically.')
        );
      }
    }

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
    const parsedErr = await parseJsonResponseSafe<{ error?: string }>(response);
    const errMsg = parsedErr.data?.error
      ? sanitizeUserFacingError(parsedErr.data.error)
      : `Speech playback failed (${response.status})`;
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
  expressiveness?: 'calm' | 'balanced' | 'expressive';
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ blob: Blob; ext: 'wav' | 'mp3'; model: string }> {
  const { signal, timeoutMs = 26000, ...bodyPayload } = params;
  const maxAttempts = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const timeoutController = new AbortController();
    const timer = window.setTimeout(() => timeoutController.abort(), timeoutMs);
    const onParentAbort = () => timeoutController.abort();
    signal?.addEventListener('abort', onParentAbort, { once: true });

    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
        signal: timeoutController.signal,
      });

      if (!response.ok) {
        const parsedErr = await parseJsonResponseSafe<{ error?: string }>(response);
        const errMsg = parsedErr.data?.error
          ? sanitizeUserFacingError(parsedErr.data.error)
          : `Audio synthesis failed (${response.status})`;
        if ((response.status >= 500 || parsedErr.isHtml) && attempt < maxAttempts - 1) {
          lastError = new Error(errMsg);
          await new Promise((r) => window.setTimeout(r, 450));
          continue;
        }
        throw new Error(errMsg);
      }

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      const model = response.headers.get('x-bhashabook-tts-model') ?? '';
      const ext: 'wav' | 'mp3' = contentType.includes('wav') ? 'wav' : 'mp3';
      const blob = await response.blob();
      if (blob.size === 0) {
        throw new Error('Neural TTS returned an empty audio clip.');
      }
      return { blob, ext, model };
    } catch (err) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const isTimeout = err instanceof DOMException && err.name === 'AbortError';
      lastError = isTimeout
        ? new Error('Neural voice generation timed out — retrying.')
        : err instanceof Error
        ? err
        : new Error('Audio synthesis failed.');
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => window.setTimeout(r, 450));
        continue;
      }
    } finally {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onParentAbort);
    }
  }

  throw lastError ?? new Error('Unable to synthesize neural speech right now.');
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

export function triggerBlobUrlDownload(url: string, fileName: string): boolean {
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    a.style.position = 'fixed';
    a.style.left = '-9999px';
    a.style.top = '0';
    a.style.opacity = '0';
    a.style.pointerEvents = 'none';
    document.body.appendChild(a);
    a.click();
    window.setTimeout(() => {
      try {
        if (a.parentNode) {
          a.parentNode.removeChild(a);
        }
      } catch {
        // ignore DOM removal race
      }
    }, 1000);
    return true;
  } catch {
    return false;
  }
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  triggerBlobUrlDownload(url, fileName);
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function lookupDictionaryTerm(
  term: string,
  targetLang: LanguageCode,
  signal?: AbortSignal
): Promise<DictionaryLookupResult> {
  return await postJsonWithAutoRetry<DictionaryLookupResult>(
    '/api/dictionary',
    { term, targetLang },
    {
      timeoutMs: 14000,
      maxAttempts: 2,
      signal,
    }
  );
}
