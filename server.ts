import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;

const ALLOWED_LANGS: Record<string, { name: string; gtxCode: string; myMemoryCode: string }> = {
  orig: { name: 'Original Book', gtxCode: 'en', myMemoryCode: 'en' },
  hi: { name: 'Hindi', gtxCode: 'hi', myMemoryCode: 'hi' },
  sa: { name: 'Sanskrit', gtxCode: 'sa', myMemoryCode: 'sa' },
  hinglish: { name: 'Hinglish', gtxCode: 'hi', myMemoryCode: 'hi' },
  mr: { name: 'Marathi', gtxCode: 'mr', myMemoryCode: 'mr' },
  ur: { name: 'Urdu', gtxCode: 'ur', myMemoryCode: 'ur' },
  ar: { name: 'Arabic', gtxCode: 'ar', myMemoryCode: 'ar' },
  fa: { name: 'Persian', gtxCode: 'fa', myMemoryCode: 'fa' },
  bn: { name: 'Bengali', gtxCode: 'bn', myMemoryCode: 'bn' },
  ta: { name: 'Tamil', gtxCode: 'ta', myMemoryCode: 'ta' },
  te: { name: 'Telugu', gtxCode: 'te', myMemoryCode: 'te' },
  gu: { name: 'Gujarati', gtxCode: 'gu', myMemoryCode: 'gu' },
  pa: { name: 'Punjabi', gtxCode: 'pa', myMemoryCode: 'pa' },
  kn: { name: 'Kannada', gtxCode: 'kn', myMemoryCode: 'kn' },
  ml: { name: 'Malayalam', gtxCode: 'ml', myMemoryCode: 'ml' },
  or: { name: 'Odia', gtxCode: 'or', myMemoryCode: 'or' },
  ne: { name: 'Nepali', gtxCode: 'ne', myMemoryCode: 'ne' },
  en: { name: 'English', gtxCode: 'en', myMemoryCode: 'en' },
  zh: { name: 'Chinese', gtxCode: 'zh-CN', myMemoryCode: 'zh-CN' },
  ja: { name: 'Japanese', gtxCode: 'ja', myMemoryCode: 'ja' },
  ko: { name: 'Korean', gtxCode: 'ko', myMemoryCode: 'ko' },
  ru: { name: 'Russian', gtxCode: 'ru', myMemoryCode: 'ru' },
  es: { name: 'Spanish', gtxCode: 'es', myMemoryCode: 'es' },
  fr: { name: 'French', gtxCode: 'fr', myMemoryCode: 'fr' },
  de: { name: 'German', gtxCode: 'de', myMemoryCode: 'de' },
  pt: { name: 'Portuguese', gtxCode: 'pt', myMemoryCode: 'pt' },
  it: { name: 'Italian', gtxCode: 'it', myMemoryCode: 'it' },
  tr: { name: 'Turkish', gtxCode: 'tr', myMemoryCode: 'tr' },
  id: { name: 'Indonesian', gtxCode: 'id', myMemoryCode: 'id' },
  th: { name: 'Thai', gtxCode: 'th', myMemoryCode: 'th' },
  vi: { name: 'Vietnamese', gtxCode: 'vi', myMemoryCode: 'vi' },
  he: { name: 'Hebrew', gtxCode: 'iw', myMemoryCode: 'he' },
  uk: { name: 'Ukrainian', gtxCode: 'uk', myMemoryCode: 'uk' },
};

// Only unambiguous technical acronyms/protocols (never ordinary book words)
const DEFAULT_TECH_TERMS = [
  'OBS Studio',
  'NVENC',
  'H.264',
  'H.265',
  'HEVC',
  'RTMP',
  'RTSP',
  'WebSocket',
  'WebRTC',
  'HDMI',
  'USB',
  'GPU',
  'CPU',
  'VRAM',
  'SSD',
  'HTTP',
  'HTTPS',
  'JSON',
  'HTML',
  'CSS',
  'SQL',
  'API',
  'PDF',
  'GitHub',
  'YouTube',
];

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function protectTechnicalTerms(
  text: string,
  extraTerms: string[] = []
): { masked: string; tokens: Array<{ token: string; original: string }> } {
  const merged = Array.from(
    new Set([...extraTerms.map((t) => t.trim()).filter(Boolean), ...DEFAULT_TECH_TERMS])
  ).sort((a, b) => b.length - a.length);

  const tokens: Array<{ token: string; original: string }> = [];
  let masked = text;

  for (const term of merged) {
    if (term.length < 2) continue;
    const regex = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(term)}(?![A-Za-z0-9_])`, 'g');
    masked = masked.replace(regex, (match) => {
      const idx = tokens.length;
      const token = `XT${idx}X`;
      tokens.push({ token, original: match });
      return token;
    });
  }

  return { masked, tokens };
}

function restoreTechnicalTerms(
  translated: string,
  tokens: Array<{ token: string; original: string }>
): string {
  let result = translated;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const { token, original } = tokens[i];
    const re = new RegExp(`\\b${token}\\b`, 'gi');
    result = result.replace(re, original);
  }
  return result;
}

// Accurate Devanagari to Romanized Hinglish phonetic transliterator (100% free, zero API cost)
const DEV_VOWELS: Record<string, string> = {
  'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo',
  'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ऍ': 'e',
};
const DEV_MATRAS: Record<string, string> = {
  'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo',
  'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e',
};
const DEV_CONSONANTS: Record<string, string> = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ng',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'ny',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh',
  'ष': 'sh', 'स': 's', 'ह': 'h', 'ळ': 'l',
  'क़': 'q', 'ख़': 'kh', 'ग़': 'gh', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f',
};
const DEV_DIGITS: Record<string, string> = {
  '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
  '५': '5', '६': '6', '७': '7', '८': '8', '९': '9',
};

function devanagariToHinglish(input: string): string {
  const chars = Array.from(input);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const next = chars[i + 1];

    // Nukta handling
    if (next === '़' && DEV_CONSONANTS[ch + next]) {
      const base = DEV_CONSONANTS[ch + next];
      const after = chars[i + 2];
      i++;
      if (after === '्') {
        out += base;
        i++;
      } else if (after && DEV_MATRAS[after]) {
        out += base + DEV_MATRAS[after];
        i++;
      } else {
        const isWordEnd = !after || /[\s.,!?;:()\[\]"'\-।]/.test(after);
        out += isWordEnd ? base : base + 'a';
      }
      continue;
    }

    if (DEV_CONSONANTS[ch]) {
      const base = DEV_CONSONANTS[ch];
      if (next === '्') {
        out += base;
        i++;
      } else if (next && DEV_MATRAS[next]) {
        out += base + DEV_MATRAS[next];
        i++;
      } else {
        const isWordEnd = !next || /[\s.,!?;:()\[\]"'\-।]/.test(next);
        out += isWordEnd ? base : base + 'a';
      }
    } else if (DEV_VOWELS[ch]) {
      out += DEV_VOWELS[ch];
    } else if (DEV_MATRAS[ch]) {
      out += DEV_MATRAS[ch];
    } else if (ch === 'ं' || ch === 'ँ') {
      out += 'n';
    } else if (ch === 'ः') {
      out += 'h';
    } else if (ch === '।') {
      out += '.';
    } else if (DEV_DIGITS[ch]) {
      out += DEV_DIGITS[ch];
    } else if (ch === '्' || ch === '़') {
      // skip stray halant/nukta
    } else {
      out += ch;
    }
  }
  return out
    .replace(/\baa\b/g, 'aa')
    .replace(/\bmain\b/gi, 'mein')
    .replace(/\s+\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) break;
        results[idx] = await worker(items[idx], idx);
      }
    })
  );

  return results;
}

function parseGtxResponse(data: unknown): string {
  if (Array.isArray(data) && Array.isArray(data[0])) {
    return data[0]
      .map((seg: unknown) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : ''))
      .join('');
  }
  return '';
}

async function safeParseJsonResponse(response: Response): Promise<unknown | null> {
  try {
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const raw = await response.text();
    const trimmed = raw.trim();
    if (!trimmed) return null;
    // Guard against HTML gateway/CAPTCHA/error pages (<!doctype html>, <html>, etc.)
    if (
      contentType.includes('text/html') ||
      trimmed.startsWith('<') ||
      /^<!doctype/i.test(trimmed)
    ) {
      return null;
    }
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function safeParseLlmJson<T>(rawText: string | undefined | null): T | null {
  if (typeof rawText !== 'string') return null;
  let cleaned = rawText.trim();
  if (!cleaned) return null;
  if (cleaned.startsWith('<') || /^<!doctype/i.test(cleaned)) return null;

  // Strip optional markdown code fences (```json ... ```)
  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Attempt extracting outermost JSON object if extra prose surrounded it
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

// Fast in-memory LRU cache for translated text blocks (instant <1ms repeat lookups)
const TRANSLATION_CACHE_MAX = 4000;
const TRANSLATION_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const translationBlockCache = new Map<string, { value: string; expiresAt: number }>();

function getCachedTranslation(cacheKey: string): string | null {
  const entry = translationBlockCache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    translationBlockCache.delete(cacheKey);
    return null;
  }
  // Refresh LRU order
  translationBlockCache.delete(cacheKey);
  translationBlockCache.set(cacheKey, entry);
  return entry.value;
}

function setCachedTranslation(cacheKey: string, value: string): void {
  if (!value) return;
  if (translationBlockCache.size >= TRANSLATION_CACHE_MAX) {
    const oldestKey = translationBlockCache.keys().next().value;
    if (oldestKey !== undefined) {
      translationBlockCache.delete(oldestKey);
    }
  }
  translationBlockCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + TRANSLATION_CACHE_TTL_MS,
  });
}

const FREE_TRANSLATE_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];
let uaCounter = 0;
let gtxCooldownUntil = 0;
let clients5CooldownUntil = 0;

function nextUserAgent(): string {
  return FREE_TRANSLATE_USER_AGENTS[uaCounter++ % FREE_TRANSLATE_USER_AGENTS.length];
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitTextForMyMemory(text: string, maxLen = 430): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return [trimmed];
  const parts: string[] = [];
  const pieces = trimmed.split(/(?<=[.!?\n])\s+/);
  let buf = '';
  for (const piece of pieces) {
    if (!piece) continue;
    if (piece.length > maxLen) {
      if (buf) {
        parts.push(buf);
        buf = '';
      }
      for (let i = 0; i < piece.length; i += maxLen) {
        parts.push(piece.slice(i, i + maxLen));
      }
      continue;
    }
    if (buf && buf.length + 1 + piece.length > maxLen) {
      parts.push(buf);
      buf = piece;
    } else {
      buf = buf ? `${buf} ${piece}` : piece;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

/**
 * High-speed native multi-block translation via Google clients5 multi-`q` POST.
 * Translates an entire array of blocks in ~500-700ms with exact 1-to-1 array alignment
 * and ZERO delimiter mangling across Hindi, Urdu, Arabic, Tamil, Bengali, and European scripts.
 */
async function translateBatchViaClients5(
  texts: string[],
  slGtx: string,
  tlGtx: string
): Promise<string[] | null> {
  if (texts.length === 0) return [];
  if (Date.now() < clients5CooldownUntil) return null;

  try {
    const url = new URL('https://clients5.google.com/translate_a/t');
    url.searchParams.set('client', 'dict-chrome-ex');
    url.searchParams.set('sl', slGtx);
    url.searchParams.set('tl', tlGtx);

    const body = new URLSearchParams();
    for (const t of texts) {
      body.append('q', t);
    }

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'User-Agent': nextUserAgent(),
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(7000),
    });

    if (response.status === 429 || response.status === 503) {
      clients5CooldownUntil = Math.max(clients5CooldownUntil, Date.now() + 2500);
      return null;
    }
    if (!response.ok) return null;

    const data = await safeParseJsonResponse(response);
    if (!Array.isArray(data)) return null;

    // Single-input clients5 can return ["translated", "en"] or [["translated", "en"]]
    if (texts.length === 1) {
      if (typeof data[0] === 'string' && data[0].trim()) {
        return [data[0]];
      }
      if (Array.isArray(data[0]) && typeof data[0][0] === 'string' && data[0][0].trim()) {
        return [data[0][0]];
      }
      return null;
    }

    if (data.length !== texts.length) return null;

    const out: string[] = [];
    for (const entry of data) {
      if (typeof entry === 'string') {
        out.push(entry);
      } else if (Array.isArray(entry) && typeof entry[0] === 'string') {
        out.push(entry[0]);
      } else {
        return null;
      }
    }
    return out;
  } catch {
    return null;
  }
}

async function translateViaClients5Mirror(
  text: string,
  slGtx: string,
  tlGtx: string
): Promise<string | null> {
  const res = await translateBatchViaClients5([text], slGtx, tlGtx);
  return res && res[0] ? res[0] : null;
}

async function translateFreeSingle(
  text: string,
  gtxCode: string,
  myMemoryCode: string,
  sourceLang?: { gtxCode: string; myMemoryCode: string }
): Promise<string> {
  if (!text.trim()) return '';

  const slGtx = sourceLang?.gtxCode || 'auto';
  const slMyMemory = sourceLang?.myMemoryCode || 'autodetect';

  // Fast Primary A: clients5 mirror (fast ~400-600ms, high throughput)
  if (Date.now() >= clients5CooldownUntil) {
    const fastC5 = await translateViaClients5Mirror(text, slGtx, gtxCode);
    if (fastC5 && fastC5.trim()) return fastC5;
  }

  // Respect brief shared cooldown if Google GTX recently returned 429
  const nowWait = gtxCooldownUntil - Date.now();
  if (nowWait > 0) {
    await sleepMs(Math.min(nowWait, 1500));
  }

  // Primary B: Google Translate public GTX via POST with tight timeout & 1 fast retry
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const url = new URL('https://translate.googleapis.com/translate_a/single');
      url.searchParams.set('client', 'gtx');
      url.searchParams.set('sl', slGtx);
      url.searchParams.set('tl', gtxCode);
      url.searchParams.set('dt', 't');

      const body = new URLSearchParams();
      body.set('q', text);

      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'User-Agent': nextUserAgent(),
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(7000),
      });

      if (response.ok) {
        const data = await safeParseJsonResponse(response);
        const joined = parseGtxResponse(data);
        if (joined.trim()) return joined;
      } else if (response.status === 429 || response.status === 503 || response.status >= 500) {
        const delay = attempt === 0 ? 600 : 1400;
        gtxCooldownUntil = Math.max(gtxCooldownUntil, Date.now() + delay);
        if (attempt === 0) {
          await sleepMs(delay);
          continue;
        }
      }
    } catch {
      if (attempt === 0) {
        await sleepMs(450);
        continue;
      }
    }
    break;
  }

  // Tertiary: GTX GET fallback for shorter payloads
  if (text.length <= 1500) {
    try {
      const url = new URL('https://translate.googleapis.com/translate_a/single');
      url.searchParams.set('client', 'gtx');
      url.searchParams.set('sl', slGtx);
      url.searchParams.set('tl', gtxCode);
      url.searchParams.set('dt', 't');
      url.searchParams.set('q', text);

      const response = await fetch(url.toString(), {
        headers: { 'User-Agent': nextUserAgent() },
        signal: AbortSignal.timeout(6500),
      });

      if (response.ok) {
        const data = await safeParseJsonResponse(response);
        const joined = parseGtxResponse(data);
        if (joined.trim()) return joined;
      }
    } catch {
      // Fall through to MyMemory
    }
  }

  // Quaternary: Chunked MyMemory free public translation API
  if (slMyMemory.toLowerCase() !== myMemoryCode.toLowerCase()) {
    try {
      const segments = splitTextForMyMemory(text, 430);
      const translatedSegments = await runWithConcurrency(segments, 3, async (seg) => {
        const mmUrl = new URL('https://api.mymemory.translated.net/get');
        mmUrl.searchParams.set('q', seg);
        mmUrl.searchParams.set('langpair', `${slMyMemory}|${myMemoryCode}`);
        const response = await fetch(mmUrl.toString(), {
          signal: AbortSignal.timeout(7000),
        });
        if (!response.ok) {
          throw new Error(`MyMemory HTTP ${response.status}`);
        }
        const data = (await safeParseJsonResponse(response)) as {
          responseStatus?: number;
          responseData?: { translatedText?: string };
        } | null;
        if (data?.responseStatus === 200 && data.responseData?.translatedText) {
          return data.responseData.translatedText;
        }
        throw new Error('MyMemory quota or status error');
      });
      const joinedMm = translatedSegments.join(' ').trim();
      if (joinedMm) return joinedMm;
    } catch {
      // Fall through
    }
  }

  throw new Error('Free translation endpoints are temporarily busy. Please tap Retry.');
}

async function translateBlocksFast(
  validBlocks: Array<{ id: string; text: string }>,
  targetLang: string,
  preserveTerms: boolean,
  safeCustomTerms: string[],
  concurrency = 4,
  allowPartialFailure = false
): Promise<{ translations: Record<string, string>; failedIds: string[] }> {
  const langMeta = ALLOWED_LANGS[targetLang];
  const translations: Record<string, string> = {};
  const failedIds: string[] = [];

  type ChunkItem = {
    id: string;
    cacheKey: string;
    masked: string;
    tokens: Array<{ token: string; original: string }>;
  };

  const termsSig = preserveTerms ? safeCustomTerms.join('|').slice(0, 120) : 'raw';
  const chunks: ChunkItem[][] = [];
  let currentChunk: ChunkItem[] = [];
  let currentLen = 0;

  for (const blk of validBlocks) {
    const cleanText = blk.text.trim();
    if (!cleanText) {
      translations[blk.id] = '';
      continue;
    }

    const cacheKey = `${targetLang}::${termsSig}::${cleanText}`;
    const cached = getCachedTranslation(cacheKey);
    if (cached !== null) {
      translations[blk.id] = cached;
      continue;
    }

    const { masked, tokens } = preserveTerms
      ? protectTechnicalTerms(cleanText, safeCustomTerms)
      : { masked: cleanText, tokens: [] };

    if ((currentLen + masked.length > 3600 || currentChunk.length >= 24) && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentLen = 0;
    }
    currentChunk.push({ id: blk.id, cacheKey, masked, tokens });
    currentLen += masked.length + 18;
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  if (chunks.length === 0) {
    return { translations, failedIds };
  }

  const finalizeText = (
    raw: string,
    tokens: Array<{ token: string; original: string }>,
    cacheKey: string
  ) => {
    let textOut = raw.trim();
    if (targetLang === 'hinglish') {
      textOut = devanagariToHinglish(textOut);
    }
    if (preserveTerms) {
      textOut = restoreTechnicalTerms(textOut, tokens);
    }
    setCachedTranslation(cacheKey, textOut);
    return textOut;
  };

  const translateSingleItemSafely = async (item: ChunkItem) => {
    try {
      const raw = await translateFreeSingle(item.masked, langMeta.gtxCode, langMeta.myMemoryCode);
      translations[item.id] = finalizeText(raw, item.tokens, item.cacheKey);
    } catch (err) {
      if (!allowPartialFailure) throw err;
      failedIds.push(item.id);
    }
  };

  await runWithConcurrency(chunks, concurrency, async (chunk, chunkIdx) => {
    if (chunkIdx > 0) {
      await sleepMs(45);
    }

    if (chunk.length === 1) {
      await translateSingleItemSafely(chunk[0]);
      return;
    }

    // Strategy 1 (Fastest & 100% Delimiter-Free): Google clients5 native multi-`q` array translation
    const c5Batch = await translateBatchViaClients5(
      chunk.map((c) => c.masked),
      'auto',
      langMeta.gtxCode
    );
    if (c5Batch && c5Batch.length === chunk.length) {
      for (let i = 0; i < chunk.length; i++) {
        translations[chunk[i].id] = finalizeText(c5Batch[i], chunk[i].tokens, chunk[i].cacheKey);
      }
      return;
    }

    // Strategy 2 (Fast Delimiter Batch via GTX): Purely numeric marker `###9901###` (NEVER translated as "September"!)
    const delimiter = '\n###9901###\n';
    const combined = chunk.map((c) => c.masked).join(delimiter);

    try {
      const rawTranslated = await translateFreeSingle(
        combined,
        langMeta.gtxCode,
        langMeta.myMemoryCode
      );
      const parts = rawTranslated.split(/\s*###\s*[9९۹][9९۹][0०۰][1१۱]\s*###\s*/);

      if (parts.length === chunk.length) {
        for (let i = 0; i < chunk.length; i++) {
          translations[chunk[i].id] = finalizeText(parts[i], chunk[i].tokens, chunk[i].cacheKey);
        }
        return;
      }
    } catch (err) {
      if (!allowPartialFailure) {
        await runWithConcurrency(chunk, 4, async (item) => {
          const raw = await translateFreeSingle(
            item.masked,
            langMeta.gtxCode,
            langMeta.myMemoryCode
          );
          translations[item.id] = finalizeText(raw, item.tokens, item.cacheKey);
        });
        return;
      }
    }

    // Strategy 3: Parallel per-block recovery (4 concurrent workers)
    await runWithConcurrency(chunk, 4, async (item) => {
      await translateSingleItemSafely(item);
    });
  });

  return { translations, failedIds };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // Serve PDF.js bundled standard fonts, CMaps, ICC profiles, and WASM image decoders
  // so PDF rendering never falls back to missing OS system fonts (e.g. Helvetica) or fails decoding JPX/JBIG2 images
  const pdfjsDistDir = path.resolve(__dirname, 'node_modules/pdfjs-dist');
  const pdfjsStaticOpts = { maxAge: '7d', immutable: true };
  app.use('/pdfjs/standard_fonts', express.static(path.join(pdfjsDistDir, 'standard_fonts'), pdfjsStaticOpts));
  app.use('/pdfjs/cmaps', express.static(path.join(pdfjsDistDir, 'cmaps'), pdfjsStaticOpts));
  app.use('/pdfjs/wasm', express.static(path.join(pdfjsDistDir, 'wasm'), pdfjsStaticOpts));
  app.use('/pdfjs/iccs', express.static(path.join(pdfjsDistDir, 'iccs'), pdfjsStaticOpts));

  app.get('/api/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({
      status: 'ok',
      aiAvailable: Boolean(getGeminiClient()),
    });
  });

  // Universal Multilingual Vision OCR Endpoint (Gemini 4 Hydrogen — exact verbatim transcription in any script)
  app.post('/api/ocr-page', async (req, res) => {
    try {
      const ai = getGeminiClient();
      if (!ai) {
        return res.status(503).json({
          error: 'AI Vision OCR requires GEMINI_API_KEY. Using offline Tesseract OCR instead.',
        });
      }

      const { imageBase64, pageNumber = 1, scriptMode = 'auto' } = req.body ?? {};
      if (typeof imageBase64 !== 'string' || imageBase64.length < 100 || imageBase64.length > 10_000_000) {
        return res.status(400).json({ error: 'Valid page image data is required for OCR.' });
      }

      const match = imageBase64.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
      if (!match) {
        return res.status(400).json({ error: 'Unsupported image format for OCR.' });
      }

      const scriptHintMap: Record<string, string> = {
        auto: 'Detect the exact language(s) and script(s) on the page automatically — supports EVERY language in the world (Sanskrit, Hindi, Marathi, Nepali, Urdu, Arabic, Persian, Bengali, Tamil, Telugu, Gujarati, Punjabi, Kannada, Malayalam, Odia, Chinese, Japanese, Korean, Russian, Ukrainian, Hebrew, Greek, Thai, Vietnamese, Turkish, Spanish, French, German, Portuguese, English, or mixed scripts).',
        devanagari: 'The page is likely printed in Devanagari script (Hindi, Sanskrit, Marathi, or Nepali, possibly with English terms). Preserve every matra, halant/virama, anusvara, visarga, and conjunct accurately.',
        persoarabic: 'The page is likely printed in Perso-Arabic / Nastaliq / Naskh script (Urdu, Arabic, or Persian/Farsi). Read right-to-left accurately and preserve exact words and diacritics.',
        bengali: 'The page is likely printed in Bengali / Bangla script.',
        tamil: 'The page is likely printed in Tamil script.',
        telugu: 'The page is likely printed in Telugu script.',
        gujarati: 'The page is likely printed in Gujarati script.',
        gurmukhi: 'The page is likely printed in Gurmukhi / Punjabi script.',
        cjk: 'The page is likely printed in Chinese, Japanese, or Korean script.',
        cyrillic: 'The page is likely printed in Cyrillic script (Russian, Ukrainian, etc.).',
        latin: 'The page is likely printed in English or European Latin script.',
      };

      const scriptGuidance =
        typeof scriptMode === 'string' && scriptHintMap[scriptMode]
          ? scriptHintMap[scriptMode]
          : scriptHintMap.auto;

      const systemInstruction = `You are a high-precision universal world-language book OCR transcriber processing Page ${Number(pageNumber) || 1}.
${scriptGuidance}
CRITICAL FIDELITY RULES:
1. EXACT VERBATIM TRANSCRIPTION ("same to same"): Output the EXACT printed text word-for-word, character-for-character in the SAME language and script as printed on the page — zero distortion.
2. NEVER translate, summarize, paraphrase, modernize, or invent text. Whatever world language is printed on the page (Sanskrit, Hindi, Marathi, Urdu, Arabic, Persian, Bengali, Tamil, Telugu, Gujarati, Punjabi, Kannada, Malayalam, Odia, Chinese, Japanese, Korean, Russian, Hebrew, Thai, European, English, etc.), transcribe it verbatim in its native Unicode script.
3. Preserve authentic reading order (top-to-bottom across columns, right-to-left order within Urdu/Arabic/Persian/Hebrew lines) and merge broken line-wrap hyphens cleanly into natural book blocks.
4. Skip tiny edge artifacts, scanner shadows, or page border specks while keeping all headings, chapter titles, shlokas/verses, bullets, callouts, footnotes, and paragraphs.
5. Classify each block's "kind" as one of: "heading", "subheading", "paragraph", "bullet", "callout", "caption", or "table", and provide "yPercent" (0 to 100 vertical position from top of page).
6. Set "scriptDirection" to "rtl" if the page text is primarily Arabic, Urdu, Persian, Hebrew, or another right-to-left script; otherwise "ltr". Set "detectedLang" to the primary language name in English (e.g. "Sanskrit", "Hindi", "Marathi", "Urdu", "Arabic", "Persian", "Chinese", "Japanese", "Russian", "English").`;

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: match[1],
                data: match[2],
              },
            },
            {
              text: 'Transcribe all readable book text on this page verbatim into structured JSON blocks in its exact original language and script.',
            },
          ],
        },
        config: {
          systemInstruction,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              detectedLang: { type: Type.STRING },
              scriptDirection: { type: Type.STRING },
              blocks: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    kind: { type: Type.STRING },
                    text: { type: Type.STRING },
                    yPercent: { type: Type.NUMBER },
                  },
                  required: ['kind', 'text', 'yPercent'],
                },
              },
            },
            required: ['detectedLang', 'scriptDirection', 'blocks'],
          },
        },
      });

      const parsed =
        safeParseLlmJson<{
          detectedLang?: string;
          scriptDirection?: string;
          blocks?: Array<{ kind?: string; text?: string; yPercent?: number }>;
        }>(response.text) ?? {};

      const allowedKinds = new Set([
        'heading',
        'subheading',
        'paragraph',
        'bullet',
        'callout',
        'caption',
        'table',
      ]);

      const rawBlocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
      const cleanBlocks = rawBlocks
        .map((b, idx) => {
          const text = typeof b?.text === 'string' ? b.text.replace(/\s+/g, ' ').trim() : '';
          if (!text) return null;
          const kind =
            typeof b?.kind === 'string' && allowedKinds.has(b.kind) ? b.kind : 'paragraph';
          const yVal =
            typeof b?.yPercent === 'number' && Number.isFinite(b.yPercent)
              ? Math.max(0, Math.min(100, b.yPercent))
              : Math.round(((idx + 1) / (rawBlocks.length + 1)) * 90);
          return {
            id: `p${Number(pageNumber) || 1}-ocr-${idx + 1}`,
            kind,
            text,
            yPercent: yVal,
            fontSize: kind === 'heading' ? 16 : kind === 'subheading' ? 13 : 11,
          };
        })
        .filter((b): b is NonNullable<typeof b> => Boolean(b));

      const scriptDirection =
        parsed.scriptDirection === 'rtl' ? 'rtl' : 'ltr';
      const detectedLang =
        typeof parsed.detectedLang === 'string' && parsed.detectedLang.trim()
          ? parsed.detectedLang.trim().slice(0, 40)
          : 'Unknown';

      return res.json({
        detectedLang,
        scriptDirection,
        blocks: cleanBlocks,
        engine: 'gemini-4-hydrogen',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI Vision OCR failed.';
      return res.status(502).json({ error: message });
    }
  });

  // 100% Free Open Translation Endpoint (Zero Paid API Cost, Fast Concurrent Chunks)
  app.post('/api/translate-free', async (req, res) => {
    try {
      const { blocks, targetLang, preserveTerms = true, customTerms = [] } = req.body ?? {};
      if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > 160) {
        return res.status(400).json({ error: 'Invalid blocks array (expected 1-160 blocks).' });
      }
      if (typeof targetLang !== 'string' || !ALLOWED_LANGS[targetLang]) {
        return res.status(400).json({ error: 'Unsupported target language.' });
      }

      const safeCustomTerms = Array.isArray(customTerms)
        ? customTerms.filter((t): t is string => typeof t === 'string').slice(0, 60)
        : [];

      const validBlocks = blocks.filter(
        (b): b is { id: string; text: string; kind?: string } =>
          Boolean(b && typeof b.id === 'string' && typeof b.text === 'string')
      );

      if (targetLang === 'orig') {
        const translations: Record<string, string> = {};
        for (const blk of validBlocks) {
          translations[blk.id] = blk.text;
        }
        return res.json({
          translations,
          imageExplanations: [],
          engine: 'free-open',
        });
      }

      const { translations } = await translateBlocksFast(
        validBlocks,
        targetLang,
        Boolean(preserveTerms),
        safeCustomTerms,
        4,
        false
      );

      return res.json({
        translations,
        imageExplanations: [],
        engine: 'free-open',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Translation failed.';
      return res.status(502).json({ error: message });
    }
  });

  // High-Speed Multi-Page Batch Translation Endpoint for Full-PDF Conversion
  app.post('/api/translate-free-batch', async (req, res) => {
    try {
      const { pages, targetLang, preserveTerms = true, customTerms = [] } = req.body ?? {};
      if (!Array.isArray(pages) || pages.length === 0 || pages.length > 12) {
        return res.status(400).json({ error: 'Invalid pages batch (expected 1-12 pages).' });
      }
      if (typeof targetLang !== 'string' || !ALLOWED_LANGS[targetLang]) {
        return res.status(400).json({ error: 'Unsupported target language.' });
      }

      const safeCustomTerms = Array.isArray(customTerms)
        ? customTerms.filter((t): t is string => typeof t === 'string').slice(0, 60)
        : [];

      const flatBlocks: Array<{ id: string; text: string }> = [];
      const pageIdMap = new Map<string, { pageNumber: number; blockId: string }>();
      const pageTranslations: Record<number, Record<string, string>> = {};
      const failedPageSet = new Set<number>();

      for (const pg of pages) {
        if (!pg || typeof pg.pageNumber !== 'number' || !Array.isArray(pg.blocks)) continue;
        pageTranslations[pg.pageNumber] = {};
        for (const blk of pg.blocks) {
          if (!blk || typeof blk.id !== 'string' || typeof blk.text !== 'string') continue;
          if (targetLang === 'orig') {
            pageTranslations[pg.pageNumber][blk.id] = blk.text;
            continue;
          }
          if (flatBlocks.length >= 1200) break;
          const compositeId = `p${pg.pageNumber}::${blk.id}`;
          flatBlocks.push({ id: compositeId, text: blk.text });
          pageIdMap.set(compositeId, { pageNumber: pg.pageNumber, blockId: blk.id });
        }
      }

      if (targetLang !== 'orig' && flatBlocks.length > 0) {
        const { translations: translatedFlat, failedIds } = await translateBlocksFast(
          flatBlocks,
          targetLang,
          Boolean(preserveTerms),
          safeCustomTerms,
          4,
          true
        );

        for (const fid of failedIds) {
          const meta = pageIdMap.get(fid);
          if (meta) failedPageSet.add(meta.pageNumber);
        }

        for (const [compositeId, textOut] of Object.entries(translatedFlat)) {
          const meta = pageIdMap.get(compositeId);
          if (meta && !failedPageSet.has(meta.pageNumber)) {
            if (!pageTranslations[meta.pageNumber]) {
              pageTranslations[meta.pageNumber] = {};
            }
            pageTranslations[meta.pageNumber][meta.blockId] = textOut;
          }
        }

        // Remove incomplete failed pages from the completed map so client retries only those pages
        for (const fp of failedPageSet) {
          delete pageTranslations[fp];
        }

        // If every single page in this wave failed, signal 502 so client runs backoff retry
        if (Object.keys(pageTranslations).length === 0 && failedPageSet.size > 0) {
          return res.status(502).json({
            error: 'Free translation endpoints are temporarily rate-limited. Retrying automatically...',
            failedPages: Array.from(failedPageSet),
          });
        }
      }

      return res.json({
        pages: pageTranslations,
        failedPages: Array.from(failedPageSet),
        engine: 'free-open-fast',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Batch translation failed.';
      return res.status(502).json({ error: message });
    }
  });

  // Smart Multilingual Book & Diagram AI Translator (Gemini 4 Hydrogen — Server-Side with Automatic Free Fallback)
  app.post('/api/translate-ai', async (req, res) => {
    try {
      const DEFAULT_TUTOR_PROMPT =
        'Act as an expert translator and tutor. Translate and explain the content in simple, conversational Hindi, breaking down complex concepts with everyday examples familiar to an Indian audience.';

      const {
        blocks,
        targetLang,
        preserveTerms = true,
        customTerms = [],
        pageImageBase64,
        bookTitle = 'Book',
        pageNumber = 1,
        translationStyle = 'tutor',
        tutorPrompt,
      } = req.body ?? {};

      if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > 80) {
        return res.status(400).json({ error: 'Invalid blocks array (expected 1-80 blocks).' });
      }
      if (typeof targetLang !== 'string' || !ALLOWED_LANGS[targetLang]) {
        return res.status(400).json({ error: 'Unsupported target language.' });
      }

      const effectiveStyle: 'faithful' | 'tutor' =
        translationStyle === 'faithful' ? 'faithful' : 'tutor';
      const cleanedTutorPrompt =
        typeof tutorPrompt === 'string' && tutorPrompt.trim().length > 0
          ? tutorPrompt.trim().slice(0, 800)
          : DEFAULT_TUTOR_PROMPT;

      const safeCustomTerms = Array.isArray(customTerms)
        ? customTerms.filter((t): t is string => typeof t === 'string').slice(0, 60)
        : [];

      const safeBlocks = blocks
        .filter(
          (b): b is { id: string; text: string; kind: string } =>
            Boolean(b && typeof b.id === 'string' && typeof b.text === 'string')
        )
        .map((b) => ({
          id: b.id,
          kind: typeof b.kind === 'string' ? b.kind : 'paragraph',
          text: b.text.slice(0, 4000),
        }));

      if (targetLang === 'orig') {
        const translations: Record<string, string> = {};
        for (const b of safeBlocks) {
          translations[b.id] = b.text;
        }
        return res.json({
          translations,
          imageExplanations: [],
          engine: 'gemini-4-hydrogen',
          translationStyle: effectiveStyle,
        });
      }

      const runFreeFallback = async (reason?: string) => {
        const { translations } = await translateBlocksFast(
          safeBlocks,
          targetLang,
          Boolean(preserveTerms),
          safeCustomTerms,
          4,
          false
        );
        return res.json({
          translations,
          imageExplanations: [],
          engine: 'free-open',
          fallbackUsed: true,
          fallbackReason: reason,
        });
      };

      const ai = getGeminiClient();
      if (!ai) {
        return await runFreeFallback('AI key unavailable; used Free Open Engine automatically.');
      }

      const langName = ALLOWED_LANGS[targetLang].name;
      const extraTermsNote =
        safeCustomTerms.length > 0
          ? `Additional terms to keep untranslated when present: ${safeCustomTerms.slice(0, 40).join(', ')}.`
          : '';

      const languageGuidance =
        targetLang === 'hi'
          ? 'simple, warm, conversational Hindi (Devanagari script, everyday spoken style that any Indian reader understands easily — avoid overly stiff or archaic phrasing)'
          : targetLang === 'hinglish'
            ? 'simple, warm, conversational Hindi written clearly in Latin/English script (natural Indian Hinglish)'
            : `simple, warm, conversational ${langName}`;

      const systemInstruction =
        effectiveStyle === 'tutor'
          ? `${cleanedTutorPrompt}

You are translating and tutoring the reader through "${String(bookTitle).slice(0, 120)}" (Page ${Number(pageNumber) || 1}).
Follow these clear guidelines:
1. CONVERSATIONAL TRANSLATION + TUTOR EXPLANATION: Deliver every block in ${languageGuidance}. First convey the author's exact idea clearly and accurately, and whenever a paragraph, callout, or bullet introduces a complex, technical, abstract, or dense concept, break it down naturally in 1-2 short, friendly sentences using relatable everyday Indian examples (such as chai, cricket, UPI, Indian Railways, local bazaar/kirana, traffic, or household analogies) so the reader grasps it effortlessly.
2. STAY GROUNDED IN THE BOOK: Keep all explanations directly tied to what the book actually teaches on this page — never drift off-topic or contradict the author. Keep short headings, subheadings, titles, page labels, and simple factual lines crisp and concise without adding unnecessary analogies.
3. ANY SOURCE LANGUAGE SUPPORTED: The book may be in English, Sanskrit, Hindi, Marathi, Urdu, Arabic, Bengali, Tamil, Telugu, Gujarati, Punjabi, or any other language. If a page screenshot is attached AND any extracted text block looks garbled/incomplete/legacy-encoded, read the ACTUAL printed words directly from the screenshot first before translating and explaining.
4. Technical & Proper Term Preservation: ${preserveTerms ? 'Keep proper nouns and key technical/software terms accurate (you may briefly explain technical terms in parentheses in simple words).' : 'Translate naturally into everyday language while keeping proper names accurate.'} ${extraTermsNote}
5. Audiobook-Ready Smooth Flow: Write smooth, natural spoken sentences without broken mid-sentence line breaks or markdown symbols (no **bold** or # headings) so Text-to-Speech sounds like a friendly Indian teacher reading aloud.
6. Image & Diagram Context: If a page screenshot is provided and contains genuine diagrams, charts, or UI callouts, add 1-3 short, friendly tutor notes in ${languageGuidance} inside imageExplanations explaining what the visual shows in simple terms. If the page is text-only, return an empty imageExplanations array.`
          : `You are a faithful multilingual book translator and audiobook narrator translating "${String(bookTitle).slice(0, 120)}" (Page ${Number(pageNumber) || 1}).
Follow these strict fidelity rules:
1. STRICT SOURCE FIDELITY: Translate ONLY what is actually written in the book — sentence-for-sentence and meaning-for-meaning — into clear, natural ${langName}${targetLang === 'hinglish' ? ' (conversational Hindi written clearly in Latin/English script)' : ''}. NEVER invent extra ideas, substitute unrelated topics, or alter the author's meaning.
2. ANY SOURCE LANGUAGE SUPPORTED: The book may be in Sanskrit, Hindi, Marathi, Urdu, Arabic, Bengali, Tamil, Telugu, Gujarati, Punjabi, English, or mixed scripts. If a page screenshot is attached AND any extracted text block looks garbled/incomplete/legacy-encoded, read the ACTUAL printed words directly from the page screenshot first and translate that exact book text faithfully. If the source block is already in ${langName}, keep it faithful and cleanly formatted in ${langName}.
3. Technical & Proper Term Preservation: ${preserveTerms ? 'Keep proper nouns and genuine technical/software terms or acronyms that appear in the source text accurate.' : 'Translate naturally while keeping proper names accurate.'} ${extraTermsNote}
4. Preserve Structure & Hierarchy: Keep Headings concise, preserve verses/shlokas, bullet points, callouts, and table content faithfully.
5. Audiobook-Ready Formatting: Write smooth, natural flowing sentences in ${langName} without broken mid-sentence line breaks so Text-to-Speech sounds clear and faithful to the book.
6. Image & Diagram Context: If a page screenshot is provided and contains genuine diagrams, charts, or UI callouts, add 1-3 concise bracketed notes in ${langName} inside imageExplanations describing only the visible labels in the diagram. If the page is text-only (no diagrams/charts), return an empty imageExplanations array.`;

      const textPromptPart = {
        text:
          effectiveStyle === 'tutor'
            ? `Translate and explain each JSON block below in ${languageGuidance} as an expert translator and friendly Indian tutor (breaking down complex concepts with everyday Indian examples while keeping headings concise), returning the exact same "id" for every block:\n${JSON.stringify(safeBlocks)}`
            : `Translate each JSON block below faithfully into ${langName}, returning the exact same "id" for every block:\n${JSON.stringify(safeBlocks)}`,
      };

      const imageMatch =
        typeof pageImageBase64 === 'string' &&
        pageImageBase64.length > 100 &&
        pageImageBase64.length < 8_000_000
          ? pageImageBase64.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/)
          : null;

      const callGemini = async (includeImage: boolean) => {
        const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
        if (includeImage && imageMatch) {
          parts.push({
            inlineData: {
              mimeType: imageMatch[1],
              data: imageMatch[2],
            },
          });
        }
        parts.push(textPromptPart);

        return await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: { parts },
          config: {
            systemInstruction,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                items: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      id: { type: Type.STRING },
                      translatedText: { type: Type.STRING },
                    },
                    required: ['id', 'translatedText'],
                  },
                },
                imageExplanations: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: 'Brief explanations of screenshots/diagrams/callouts visible on the page in the target language.',
                },
              },
              required: ['items', 'imageExplanations'],
            },
          },
        });
      };

      let parsed: {
        items?: Array<{ id: string; translatedText: string }>;
        imageExplanations?: string[];
      } | null = null;

      try {
        const response = await callGemini(Boolean(imageMatch));
        parsed = safeParseLlmJson(response.text);
        // If multimodal request returned unparseable output, retry text-only automatically
        if ((!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) && imageMatch) {
          const textOnlyRes = await callGemini(false);
          parsed = safeParseLlmJson(textOnlyRes.text);
        }
      } catch (aiErr) {
        // If multimodal request failed, automatically retry text-only once
        if (imageMatch) {
          try {
            const textOnlyRes = await callGemini(false);
            parsed = safeParseLlmJson(textOnlyRes.text);
          } catch {
            parsed = null;
          }
        }
        if (!parsed) {
          // Seamless server-side self-healing fallback to Free Open Engine
          try {
            return await runFreeFallback(
              aiErr instanceof Error ? aiErr.message.slice(0, 140) : 'Smart AI temporarily busy.'
            );
          } catch {
            // Fall through to clean 502 error below
          }
        }
      }

      const translations: Record<string, string> = {};
      if (parsed && Array.isArray(parsed.items)) {
        for (const item of parsed.items) {
          if (item && typeof item.id === 'string' && typeof item.translatedText === 'string') {
            const trimmedVal = item.translatedText.trim();
            if (trimmedVal) {
              translations[item.id] = trimmedVal;
            }
          }
        }
      }

      // If Gemini returned empty/broken JSON, automatically recover via Free Open Engine
      if (Object.keys(translations).length === 0) {
        return await runFreeFallback('Smart AI returned an empty response; recovered automatically.');
      }

      // Fill any individual blocks Gemini omitted using Free Open Engine so no block is left untranslated
      const missingBlocks = safeBlocks.filter((b) => b.text.trim() && !translations[b.id]);
      if (missingBlocks.length > 0) {
        try {
          const { translations: filled } = await translateBlocksFast(
            missingBlocks,
            targetLang,
            Boolean(preserveTerms),
            safeCustomTerms,
            4,
            true
          );
          for (const [id, val] of Object.entries(filled)) {
            if (val && val.trim()) {
              translations[id] = val.trim();
            }
          }
        } catch {
          // keep Gemini blocks
        }
      }

      return res.json({
        translations,
        imageExplanations:
          parsed && Array.isArray(parsed.imageExplanations)
            ? parsed.imageExplanations.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
            : [],
        engine: 'gemini-4-hydrogen',
        translationStyle: effectiveStyle,
      });
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : 'Translation service temporarily busy.';
      const cleanMsg =
        /unexpected token|<!doctype|<html/i.test(rawMsg)
          ? 'Translation service is temporarily busy. Retrying automatically.'
          : rawMsg;
      return res.status(502).json({ error: cleanMsg });
    }
  });

  // Split text into <=175-char chunks at punctuation/word boundaries for free TTS synthesis
  function splitTtsChunks(input: string, maxLen = 175): string[] {
    const cleaned = input.replace(/\s+/g, ' ').trim();
    if (!cleaned) return [];
    const chunks: string[] = [];
    let remaining = cleaned;

    while (remaining.length > maxLen) {
      let cut = -1;
      // Prefer sentence or clause boundaries
      for (let i = maxLen; i >= Math.floor(maxLen * 0.45); i--) {
        if (/[.!?।۔؟,;:—\-]/.test(remaining[i])) {
          cut = i + 1;
          break;
        }
      }
      // Fallback to whitespace boundary
      if (cut === -1) {
        const spaceIdx = remaining.lastIndexOf(' ', maxLen);
        cut = spaceIdx > 20 ? spaceIdx : maxLen;
      }
      const piece = remaining.slice(0, cut).trim();
      if (piece) chunks.push(piece);
      remaining = remaining.slice(cut).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  }

  async function synthesizeFreeTtsMp3(text: string, targetLang: string): Promise<Buffer> {
    const langMeta = ALLOWED_LANGS[targetLang] ?? ALLOWED_LANGS.en;
    const tl = langMeta.gtxCode;
    const chunks = splitTtsChunks(text.slice(0, 3500), 175);
    if (chunks.length === 0) {
      throw new Error('No speakable text provided.');
    }

    const buffers: Buffer[] = [];
    for (const chunk of chunks) {
      let chunkBuf: Buffer | null = null;
      let lastStatus = 0;

      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          await sleepMs(attempt * 900);
        }
        try {
          const url = new URL('https://translate.googleapis.com/translate_tts');
          url.searchParams.set('ie', 'UTF-8');
          url.searchParams.set('client', 'tw-ob');
          url.searchParams.set('tl', tl);
          url.searchParams.set('q', chunk);

          const response = await fetch(url.toString(), {
            headers: {
              'User-Agent': nextUserAgent(),
              Referer: 'https://translate.google.com/',
            },
            signal: AbortSignal.timeout(14000),
          });

          lastStatus = response.status;
          if (response.ok) {
            const arr = await response.arrayBuffer();
            if (arr.byteLength > 0) {
              chunkBuf = Buffer.from(arr);
              break;
            }
          } else if (response.status !== 429 && response.status < 500) {
            break;
          }
        } catch {
          // retry on transient network failure
        }
      }

      if (!chunkBuf) {
        throw new Error(`Free TTS service returned HTTP ${lastStatus || 'error'}`);
      }
      buffers.push(chunkBuf);
    }

    if (buffers.length === 0) {
      throw new Error('Free TTS returned empty audio.');
    }
    return Buffer.concat(buffers);
  }

  // 100% Free Multi-Language MP3 Speech Synthesis (works reliably on mobile, desktop & iframes)
  app.post('/api/tts-free', async (req, res) => {
    try {
      const { text, targetLang = 'hi' } = req.body ?? {};
      if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Text is required for speech playback.' });
      }
      const safeLang =
        typeof targetLang === 'string' && ALLOWED_LANGS[targetLang] ? targetLang : 'en';

      const mp3Buffer = await synthesizeFreeTtsMp3(text.trim().slice(0, 1200), safeLang);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', String(mp3Buffer.length));
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.send(mp3Buffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Free TTS synthesis failed.';
      return res.status(502).json({ error: message });
    }
  });

  // Server-side LRU cache for synthesized Neural TTS clips (instant repeat playback & voice previews)
  interface TtsCacheEntry {
    buffer: Buffer;
    contentType: string;
    model: string;
    ts: number;
  }
  const ttsAudioCache = new Map<string, TtsCacheEntry>();
  const TTS_CACHE_MAX = 120;
  const TTS_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

  let cachedTtsAiClient: GoogleGenAI | null | undefined;
  function getTtsAiClient(): GoogleGenAI | null {
    if (cachedTtsAiClient !== undefined) return cachedTtsAiClient;
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      cachedTtsAiClient = null;
      return null;
    }
    cachedTtsAiClient = new GoogleGenAI({
      apiKey,
      apiVersion: 'v1beta',
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
    return cachedTtsAiClient;
  }

  function withPromiseTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      promise.then(
        (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  function splitTextForNeuralTts(text: string, maxChunkChars = 950): string[] {
    const normalized = text.replace(/\r\n/g, '\n').trim();
    if (normalized.length <= maxChunkChars) return [normalized];

    const paragraphs = normalized.split(/\n+/).map((p) => p.trim()).filter(Boolean);
    const chunks: string[] = [];
    let current = '';

    const pushParagraph = (para: string) => {
      if (para.length <= maxChunkChars) {
        if (!current) {
          current = para;
        } else if (current.length + 2 + para.length <= maxChunkChars) {
          current = `${current}\n\n${para}`;
        } else {
          chunks.push(current);
          current = para;
        }
        return;
      }
      // Split long paragraph along sentence punctuation boundaries
      const parts = para.match(/[^.!?।۔؟]+(?:[.!?।۔؟]+["'”’)\]]*|$)/g) ?? [para];
      for (const part of parts) {
        const s = part.trim();
        if (!s) continue;
        if (!current) {
          current = s.slice(0, maxChunkChars);
        } else if (current.length + 1 + s.length <= maxChunkChars) {
          current = `${current} ${s}`;
        } else {
          chunks.push(current);
          current = s.slice(0, maxChunkChars);
        }
      }
    };

    for (const p of paragraphs) {
      pushParagraph(p);
    }
    if (current) chunks.push(current);
    return chunks.length > 0 ? chunks : [normalized.slice(0, maxChunkChars)];
  }

  function buildPcmWavHeader(dataByteLength: number, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
    const header = Buffer.alloc(44);
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataByteLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataByteLength, 40);
    return header;
  }

  function extractPcmFromWavOrRaw(rawBuf: Buffer, mime: string): { pcm: Buffer; sampleRate: number } {
    const isWav =
      rawBuf.length >= 44 &&
      rawBuf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      rawBuf.subarray(8, 12).toString('ascii') === 'WAVE';

    if (isWav) {
      const sampleRate = rawBuf.readUInt32LE(24) || 24000;
      let offset = 12;
      while (offset + 8 <= rawBuf.length) {
        const chunkId = rawBuf.subarray(offset, offset + 4).toString('ascii');
        const chunkSize = rawBuf.readUInt32LE(offset + 4);
        if (chunkId === 'data') {
          const end = Math.min(rawBuf.length, offset + 8 + chunkSize);
          return { pcm: rawBuf.subarray(offset + 8, end), sampleRate };
        }
        offset += 8 + chunkSize + (chunkSize % 2);
      }
      return { pcm: rawBuf.subarray(44), sampleRate };
    }

    const rateMatch = mime.match(/rate=(\d+)/);
    const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
    return { pcm: rawBuf, sampleRate };
  }

  // Neural Studio Audiobook Synthesis Endpoint (Expressive Gemini 3.8 Neural TTS with Teacher-like Prosody + Free MP3 fallback)
  app.post('/api/tts', async (req, res) => {
    try {
      const {
        text,
        voiceName = 'Kore',
        voiceStyle,
        languageName = 'Hindi',
        targetLang = 'hi',
        sentenceKind = 'narration',
        modelTier = 'flash',
        expressiveness = 'expressive',
      } = req.body ?? {};
      if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Text is required for audio generation.' });
      }

      const clippedText = text.trim().slice(0, 3500);
      const safeLang =
        typeof targetLang === 'string' && ALLOWED_LANGS[targetLang] ? targetLang : 'hi';
      const allowedVoices = new Set(['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr']);
      const safeVoice = allowedVoices.has(voiceName) ? voiceName : 'Kore';
      const safeTier = modelTier === 'lite' ? 'lite' : 'flash';
      const safeExpressiveness =
        expressiveness === 'calm' || expressiveness === 'balanced' ? expressiveness : 'expressive';

      const baseStyle =
        typeof voiceStyle === 'string' && voiceStyle.trim()
          ? voiceStyle.trim().slice(0, 520)
          : 'Warm, experienced teacher explaining a book aloud to a curious student: expressive vocal rise and fall (intonation), natural conversational rhythm, gentle emphasis on key ideas, and clear breathing pauses — never flat or monotonous';

      const expressivenessCue: Record<string, string> = {
        calm: 'Keep vocal transitions smooth, gentle, and unhurried with soft melodic intonation and comforting pauses.',
        balanced: 'Use clear, engaging natural intonation with balanced vocal modulation and crisp punctuation pauses.',
        expressive:
          'Use rich, lively human pitch modulation (expressive rise and fall), warm emphasis on key words, and deliberate classroom-style breathing pauses — never monotone or flat.',
      };

      const prosodyCueByKind: Record<string, string> = {
        heading:
          'Speak like an engaging teacher introducing a new chapter or section: slightly slower and welcoming, with a warm upward lift on the main topic and a poised pause at the end.',
        question:
          'Speak like an encouraging teacher asking an intriguing question in class: clear rising intonation toward the end, curious warmth, and inviting cadence.',
        exclamation:
          'Speak with genuine classroom enthusiasm, lively vocal lift, bright energy, and warm emphasis on the key takeaway.',
        list:
          'Speak with crisp instructional cadence: gently highlight the opening point, pause briefly after enumerations, and keep an easy-to-follow teaching rhythm.',
        caption:
          'Speak as if pointing to an illustration or diagram beside a student, explaining it clearly with warm conversational clarity.',
        narration:
          'Speak like an experienced, beloved teacher narrating aloud: natural human pitch rise-and-fall, warm emphasis on important words, subtle micro-pauses at commas and clauses, and fluid storytelling rhythm — strictly avoid flat, robotic, or monotone delivery.',
      };

      const safeKind =
        typeof sentenceKind === 'string' && prosodyCueByKind[sentenceKind]
          ? sentenceKind
          : 'narration';

      const ttsCacheKey = `${safeTier}::${safeVoice}::${safeLang}::${safeKind}::${safeExpressiveness}::${baseStyle.slice(0, 140)}::${clippedText}`;
      const cachedHit = ttsAudioCache.get(ttsCacheKey);
      if (cachedHit && Date.now() - cachedHit.ts < TTS_CACHE_TTL_MS) {
        // Refresh LRU position
        ttsAudioCache.delete(ttsCacheKey);
        ttsAudioCache.set(ttsCacheKey, cachedHit);
        res.setHeader('Content-Type', cachedHit.contentType);
        res.setHeader('Content-Length', String(cachedHit.buffer.length));
        res.setHeader('X-BhashaBook-TTS-Model', cachedHit.model);
        res.setHeader('X-BhashaBook-TTS-Cache', 'hit');
        res.setHeader(
          'Content-Disposition',
          cachedHit.contentType.includes('wav')
            ? 'attachment; filename="audiobook-page.wav"'
            : 'attachment; filename="audiobook-page.mp3"'
        );
        return res.send(cachedHit.buffer);
      }

      const ttsAi = getTtsAiClient();

      if (ttsAi) {
        const isIndic = [
          'hi',
          'sa',
          'hinglish',
          'bn',
          'ta',
          'te',
          'mr',
          'ur',
          'gu',
          'pa',
          'kn',
          'ml',
          'or',
          'ne',
        ].includes(safeLang);
        const languageCadence = isIndic
          ? `Speak ${String(languageName).slice(0, 40)} with natural, expressive Indian educator cadence, melodic rise-and-fall intonation, clear pauses at purna viram (।) and commas, and crisp pronunciation of English technical terms.`
          : `Speak ${String(languageName).slice(0, 40)} with natural, expressive educator cadence, melodic rise-and-fall intonation, clear clause pauses, and crisp pronunciation of technical terms.`;

        const fullTeacherStyle = `${baseStyle}. ${expressivenessCue[safeExpressiveness]} ${prosodyCueByKind[safeKind]} ${languageCadence}`;

        const candidateModels =
          safeTier === 'lite'
            ? ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts']
            : ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'];

        const synthesizeSingleChunk = async (
          chunkText: string
        ): Promise<{ pcm: Buffer; sampleRate: number; model: string } | null> => {
          const directedPrompt = `Read the following passage aloud with this exact vocal delivery (${fullTeacherStyle}):\n\n${chunkText}`;
          const chunkTimeoutMs = Math.min(34000, Math.max(18000, 12000 + chunkText.length * 14));

          for (const modelName of candidateModels) {
            const attempts = [
              [
                {
                  role: 'user',
                  parts: [
                    {
                      text: chunkText,
                      speechMetadata: { style: fullTeacherStyle },
                    },
                  ],
                },
              ],
              [
                {
                  role: 'user',
                  parts: [{ text: directedPrompt }],
                },
              ],
            ];

            for (let attemptIdx = 0; attemptIdx < attempts.length; attemptIdx++) {
              try {
                const response = await withPromiseTimeout(
                  ttsAi.models.generateContent({
                    model: modelName,
                    contents: attempts[attemptIdx],
                    config: {
                      responseModalities: ['AUDIO'],
                      speechConfig: {
                        voiceConfig: {
                          prebuiltVoiceConfig: { voiceName: safeVoice },
                        },
                      },
                    },
                  }),
                  chunkTimeoutMs,
                  `Gemini TTS (${modelName})`
                );

                const part = response.candidates?.[0]?.content?.parts?.[0];
                const base64Audio = part?.inlineData?.data;
                if (base64Audio) {
                  const rawBuf = Buffer.from(base64Audio, 'base64');
                  const mime = (part?.inlineData?.mimeType ?? '').toLowerCase();
                  const { pcm, sampleRate } = extractPcmFromWavOrRaw(rawBuf, mime);
                  if (pcm.length > 0) {
                    return { pcm, sampleRate, model: modelName };
                  }
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                // Retry directed prompt on same model if speechMetadata or INVALID_ARGUMENT caused a 400
                if (
                  attemptIdx === 0 &&
                  (msg.includes('speechMetadata') ||
                    msg.includes('INVALID_ARGUMENT') ||
                    msg.includes('400'))
                ) {
                  continue;
                }
                break;
              }
            }
          }
          return null;
        };

        const textChunks = splitTextForNeuralTts(clippedText, 950);
        const pcmParts: Buffer[] = [];
        let outputSampleRate = 24000;
        let usedModel = candidateModels[0];
        let allSucceeded = true;

        for (let i = 0; i < textChunks.length; i++) {
          const chunkRes = await synthesizeSingleChunk(textChunks[i]);
          if (!chunkRes) {
            allSucceeded = false;
            break;
          }
          if (i === 0) {
            outputSampleRate = chunkRes.sampleRate;
            usedModel = chunkRes.model;
          }
          pcmParts.push(chunkRes.pcm);
          // Add a natural 240ms teacher pause between stitched paragraph chunks
          if (i < textChunks.length - 1) {
            const pauseBytes = Math.round(outputSampleRate * 0.24) * 2;
            pcmParts.push(Buffer.alloc(pauseBytes));
          }
        }

        if (allSucceeded && pcmParts.length > 0) {
          const mergedPcm = pcmParts.length === 1 ? pcmParts[0] : Buffer.concat(pcmParts);
          const wavBuffer = Buffer.concat([
            buildPcmWavHeader(mergedPcm.length, outputSampleRate, 1, 16),
            mergedPcm,
          ]);

          // Store in LRU cache (skip huge multi-minute full-page downloads to keep RAM bounded)
          if (wavBuffer.length <= 1_800_000) {
            if (ttsAudioCache.size >= TTS_CACHE_MAX) {
              const oldestKey = ttsAudioCache.keys().next().value;
              if (oldestKey) ttsAudioCache.delete(oldestKey);
            }
            ttsAudioCache.set(ttsCacheKey, {
              buffer: wavBuffer,
              contentType: 'audio/wav',
              model: usedModel,
              ts: Date.now(),
            });
          }

          res.setHeader('Content-Type', 'audio/wav');
          res.setHeader('Content-Length', String(wavBuffer.length));
          res.setHeader('X-BhashaBook-TTS-Model', usedModel);
          res.setHeader('X-BhashaBook-TTS-Cache', 'miss');
          res.setHeader('Content-Disposition', 'attachment; filename="audiobook-page.wav"');
          return res.send(wavBuffer);
        }
      }

      const mp3Buffer = await synthesizeFreeTtsMp3(clippedText, safeLang);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', String(mp3Buffer.length));
      res.setHeader('X-BhashaBook-TTS-Model', 'free-mp3-fallback');
      res.setHeader('X-BhashaBook-TTS-Cache', 'miss');
      res.setHeader('Content-Disposition', 'attachment; filename="audiobook-page.mp3"');
      return res.send(mp3Buffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Audio generation failed.';
      return res.status(502).json({ error: message });
    }
  });

  // Free Dictionary, Technical Glossary & Cross-Language Lookup Endpoint
  app.post('/api/dictionary', async (req, res) => {
    try {
      const { term, targetLang = 'hi' } = req.body ?? {};
      if (typeof term !== 'string' || !term.trim()) {
        return res.status(400).json({ error: 'Selected text is required for dictionary lookup.' });
      }

      const cleanTerm = term
        .replace(/^[\s"'“”‘’()[\]{},.;:!?।۔؟\-–—]+|[\s"'“”‘’()[\]{},.;:!?।۔؟\-–—]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);

      if (!cleanTerm) {
        return res.status(400).json({ error: 'Please select a word or phrase to look up.' });
      }

      const safeLang =
        typeof targetLang === 'string' && ALLOWED_LANGS[targetLang] ? targetLang : 'hi';
      const langMeta = ALLOWED_LANGS[safeLang];
      const isAsciiLatin = /^[A-Za-z0-9\s\-_./+&#']+$/u.test(cleanTerm);

      let englishEquivalent: string | undefined;
      let targetEquivalent: string | undefined;

      const reverseSource =
        safeLang !== 'en'
          ? { gtxCode: langMeta.gtxCode, myMemoryCode: langMeta.myMemoryCode }
          : { gtxCode: 'auto', myMemoryCode: 'hi' };

      // Cross-language translation (non-ASCII -> English, or ASCII -> targetLang + English if reading in es/fr/de/hinglish)
      if (!isAsciiLatin) {
        try {
          const enText = await translateFreeSingle(cleanTerm, 'en', 'en', reverseSource);
          if (enText.trim() && enText.trim().toLowerCase() !== cleanTerm.toLowerCase()) {
            englishEquivalent = enText.trim();
          }
        } catch {
          // continue without English equivalent
        }
      } else if (safeLang !== 'en') {
        try {
          let trText = await translateFreeSingle(
            cleanTerm,
            langMeta.gtxCode,
            langMeta.myMemoryCode
          );
          if (safeLang === 'hinglish') {
            trText = devanagariToHinglish(trText);
          }
          if (trText.trim() && trText.trim().toLowerCase() !== cleanTerm.toLowerCase()) {
            targetEquivalent = trText.trim();
          }
        } catch {
          // continue without target equivalent
        }

        if (['es', 'fr', 'de', 'hinglish'].includes(safeLang)) {
          try {
            const enText = await translateFreeSingle(cleanTerm, 'en', 'en', reverseSource);
            if (enText.trim() && enText.trim().toLowerCase() !== cleanTerm.toLowerCase()) {
              englishEquivalent = enText.trim();
            }
          } catch {
            // continue without English equivalent
          }
        }
      }

      const lookupWord = (englishEquivalent || cleanTerm).trim();
      const firstWord = lookupWord.split(/\s+/)[0] || lookupWord;
      const isSingleEnglishWord = /^[A-Za-z][A-Za-z\-']{0,38}$/.test(lookupWord);

      let phonetic: string | undefined;
      const meanings: Array<{
        partOfSpeech: string;
        definition: string;
        example?: string;
        synonyms?: string[];
      }> = [];
      let summary: string | undefined;
      let source = 'Cross-Language Lookup';

      // 1. Free Dictionary API for English single-word definitions & phonetics
      if (isSingleEnglishWord || /^[A-Za-z][A-Za-z\-']{1,38}$/.test(firstWord)) {
        const candidateWord = isSingleEnglishWord ? lookupWord : firstWord;
        try {
          const dictRes = await fetch(
            `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(
              candidateWord.toLowerCase()
            )}`,
            { signal: AbortSignal.timeout(6000) }
          );
          if (dictRes.ok) {
            const entries = (await dictRes.json()) as Array<{
              phonetic?: string;
              phonetics?: Array<{ text?: string }>;
              meanings?: Array<{
                partOfSpeech?: string;
                definitions?: Array<{ definition?: string; example?: string }>;
                synonyms?: string[];
              }>;
            }>;
            const entry = entries?.[0];
            if (entry) {
              phonetic =
                entry.phonetic ||
                entry.phonetics?.find((p) => typeof p.text === 'string' && p.text.trim())?.text;
              if (Array.isArray(entry.meanings)) {
                for (const m of entry.meanings.slice(0, 3)) {
                  const firstDef = m.definitions?.[0];
                  if (firstDef?.definition) {
                    meanings.push({
                      partOfSpeech: m.partOfSpeech || 'term',
                      definition: firstDef.definition,
                      example: firstDef.example,
                      synonyms: Array.isArray(m.synonyms) ? m.synonyms.slice(0, 4) : undefined,
                    });
                  }
                }
              }
              if (meanings.length > 0) {
                source = 'Free Dictionary';
              }
            }
          }
        } catch {
          // continue to Wikipedia fallback
        }
      }

      // 2. Wikipedia REST Summary for technical terms / multi-word phrases if dictionary had no match
      if (meanings.length === 0 && lookupWord.length <= 64) {
        try {
          const wikiSlug = lookupWord.replace(/\s+/g, '_');
          const wikiRes = await fetch(
            `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiSlug)}`,
            {
              headers: { 'User-Agent': 'BhashaBookReader/1.0' },
              signal: AbortSignal.timeout(6000),
            }
          );
          if (wikiRes.ok) {
            const wikiData = (await wikiRes.json()) as {
              type?: string;
              extract?: string;
            };
            if (
              wikiData.extract &&
              wikiData.type !== 'disambiguation' &&
              wikiData.extract.trim().length > 20
            ) {
              summary = wikiData.extract.trim().slice(0, 360);
              source = 'Wikipedia Reference';
            }
          }
        } catch {
          // proceed with translation-only result
        }
      }

      return res.json({
        term: cleanTerm,
        phonetic,
        englishEquivalent,
        targetEquivalent,
        meanings,
        summary,
        source,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Dictionary lookup failed.';
      return res.status(502).json({ error: message });
    }
  });

  // ---------------------------------------------------------------------------
  // MODULE 1 & 5: Multi-Source Public-Domain E-Book Search, Safe Proxy & Summarizer
  // ---------------------------------------------------------------------------
  const ALLOWED_BOOK_HOST_PATTERNS = [
    /^archive\.org$/i,
    /^[a-z0-9-]+\.archive\.org$/i,
    /^[a-z0-9-]+\.[a-z0-9-]+\.archive\.org$/i,
    /^gutenberg\.org$/i,
    /^[a-z0-9-]+\.gutenberg\.org$/i,
    /^openlibrary\.org$/i,
    /^covers\.openlibrary\.org$/i,
    /^arxiv\.org$/i,
    /^export\.arxiv\.org$/i,
  ];

  const isPrivateOrNumericHost = (host: string): boolean => {
    const h = host.toLowerCase();
    if (
      h === 'localhost' ||
      h === '0.0.0.0' ||
      h === '::1' ||
      h.startsWith('[') ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(h) ||
      /^\d+$/.test(h)
    ) {
      return true;
    }
    return false;
  };

  const parseAllowedBookUrl = (rawUrl: string): URL | null => {
    if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.length > 2048) return null;
    try {
      const parsed = new URL(rawUrl.trim());
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
      if (parsed.username || parsed.password) return null;
      if (isPrivateOrNumericHost(parsed.hostname)) return null;
      const allowed = ALLOWED_BOOK_HOST_PATTERNS.some((re) => re.test(parsed.hostname));
      return allowed ? parsed : null;
    } catch {
      return null;
    }
  };

  // Follow redirects manually while validating every redirect hop against the public-domain host allowlist
  const safeFetchAllowlisted = async (
    rawUrl: string,
    opts: { timeoutMs?: number; accept?: string; maxRedirects?: number } = {}
  ): Promise<{ response: Response; finalUrl: string }> => {
    const { timeoutMs = 22000, accept = '*/*', maxRedirects = 5 } = opts;
    let currentUrl = rawUrl;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const validated = parseAllowedBookUrl(currentUrl);
      if (!validated) {
        throw new Error('Blocked request to disallowed external host.');
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(validated.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            Accept: accept,
            'User-Agent': 'BhashaBook/1.0 (+https://openlibrary.org)',
          },
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) {
          throw new Error(`Redirect missing location header (${res.status})`);
        }
        currentUrl = new URL(location, validated).toString();
        continue;
      }

      return { response: res, finalUrl: validated.toString() };
    }

    throw new Error('Too many redirects while fetching external book resource.');
  };

  const CATEGORY_KEYWORDS: Record<string, { iaSubject: string; olSubject: string; gutenTopic: string; queryHint: string }> = {
    all: { iaSubject: '', olSubject: '', gutenTopic: '', queryHint: '' },
    programming: {
      iaSubject: 'programming OR computer OR software OR python',
      olSubject: 'programming',
      gutenTopic: 'computer',
      queryHint: 'programming software',
    },
    business: {
      iaSubject: 'business OR economics OR management OR finance',
      olSubject: 'business',
      gutenTopic: 'economics',
      queryHint: 'business economics',
    },
    science: {
      iaSubject: 'science OR physics OR biology OR mathematics',
      olSubject: 'science',
      gutenTopic: 'science',
      queryHint: 'science physics',
    },
    history: {
      iaSubject: 'history OR biography OR civilization',
      olSubject: 'history',
      gutenTopic: 'history',
      queryHint: 'history',
    },
    fiction: {
      iaSubject: 'fiction OR novel OR literature OR stories',
      olSubject: 'fiction',
      gutenTopic: 'fiction',
      queryHint: 'classic fiction',
    },
    self_help: {
      iaSubject: 'self-help OR philosophy OR psychology OR productivity',
      olSubject: 'psychology',
      gutenTopic: 'philosophy',
      queryHint: 'philosophy psychology',
    },
  };

  const LANG_TO_IA: Record<string, string> = {
    en: 'eng',
    hi: 'hin',
    sa: 'san',
    mr: 'mar',
    gu: 'guj',
    pa: 'pan',
    kn: 'kan',
    ml: 'mal',
    or: 'ori',
    ne: 'nep',
    es: 'spa',
    fr: 'fre',
    de: 'ger',
    pt: 'por',
    it: 'ita',
    ru: 'rus',
    uk: 'ukr',
    ar: 'ara',
    fa: 'per',
    ur: 'urd',
    he: 'heb',
    bn: 'ben',
    ta: 'tam',
    te: 'tel',
    zh: 'chi',
    ja: 'jpn',
    ko: 'kor',
    tr: 'tur',
    id: 'ind',
    th: 'tha',
    vi: 'vie',
  };

  const normalizeLangLabel = (raw: unknown): string => {
    const val = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw ?? '');
    const lower = val.toLowerCase().trim();
    if (!lower) return 'English';
    if (lower.startsWith('en')) return 'English';
    if (lower.startsWith('hi')) return 'Hindi';
    if (lower.startsWith('sa')) return 'Sanskrit';
    if (lower.startsWith('mr') || lower === 'mar') return 'Marathi';
    if (lower.startsWith('gu')) return 'Gujarati';
    if (lower.startsWith('pa') || lower === 'pan') return 'Punjabi';
    if (lower.startsWith('kn') || lower === 'kan') return 'Kannada';
    if (lower.startsWith('ml') || lower === 'mal') return 'Malayalam';
    if (lower.startsWith('or') || lower === 'ori') return 'Odia';
    if (lower.startsWith('ne') || lower === 'nep') return 'Nepali';
    if (lower.startsWith('es') || lower === 'spa') return 'Spanish';
    if (lower.startsWith('fr') || lower === 'fre') return 'French';
    if (lower.startsWith('de') || lower === 'ger') return 'German';
    if (lower.startsWith('pt') || lower === 'por') return 'Portuguese';
    if (lower.startsWith('it') || lower === 'ita') return 'Italian';
    if (lower.startsWith('ru') || lower === 'rus') return 'Russian';
    if (lower.startsWith('uk') || lower === 'ukr') return 'Ukrainian';
    if (lower.startsWith('ar') || lower === 'ara') return 'Arabic';
    if (lower.startsWith('fa') || lower === 'per' || lower === 'fas') return 'Persian';
    if (lower.startsWith('ur') || lower === 'urd') return 'Urdu';
    if (lower.startsWith('he') || lower === 'heb' || lower === 'iw') return 'Hebrew';
    if (lower.startsWith('bn') || lower === 'ben') return 'Bengali';
    if (lower.startsWith('ta') || lower === 'tam') return 'Tamil';
    if (lower.startsWith('te') || lower === 'tel') return 'Telugu';
    if (lower.startsWith('zh') || lower === 'chi') return 'Chinese';
    if (lower.startsWith('ja') || lower === 'jpn') return 'Japanese';
    if (lower.startsWith('ko') || lower === 'kor') return 'Korean';
    if (lower.startsWith('tr') || lower === 'tur') return 'Turkish';
    if (lower.startsWith('id') || lower === 'ind') return 'Indonesian';
    if (lower.startsWith('th') || lower === 'tha') return 'Thai';
    if (lower.startsWith('vi') || lower === 'vie') return 'Vietnamese';
    return val.slice(0, 16);
  };

  // Server-side LRU caches for instant repeat book searches & archive file resolution
  const BOOK_SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
  const BOOK_SEARCH_CACHE_MAX = 250;
  const bookSearchCache = new Map<string, { payload: unknown; expiresAt: number }>();

  const ARCHIVE_RESOLVE_CACHE_TTL_MS = 30 * 60 * 1000;
  const ARCHIVE_RESOLVE_CACHE_MAX = 500;
  const archiveResolveCache = new Map<string, { payload: unknown; expiresAt: number }>();

  const decodeXmlEntities = (str: string): string =>
    str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

  // GET /api/books/search — Ultra-fast multi-source e-book discovery (Oldest Classics to Newest Open-Access PDFs)
  app.get('/api/books/search', async (req, res) => {
    try {
      const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 140) : '';
      const category =
        typeof req.query.category === 'string' && CATEGORY_KEYWORDS[req.query.category]
          ? req.query.category
          : 'all';
      const lang =
        typeof req.query.lang === 'string' && /^[a-z]{2,3}$/i.test(req.query.lang)
          ? req.query.lang.toLowerCase()
          : 'all';
      const format =
        typeof req.query.format === 'string' && ['all', 'pdf', 'text', 'online'].includes(req.query.format)
          ? req.query.format
          : 'all';
      const sort =
        typeof req.query.sort === 'string' &&
        ['relevance', 'downloads', 'rating', 'latest', 'oldest'].includes(req.query.sort)
          ? req.query.sort
          : rawQuery
          ? 'relevance'
          : 'downloads';
      const pageNum = Math.max(1, Math.min(10, parseInt(String(req.query.page ?? '1'), 10) || 1));

      const cacheKey = `${rawQuery.toLowerCase()}|${category}|${lang}|${format}|${sort}|${pageNum}`;
      const cachedSearch = bookSearchCache.get(cacheKey);
      if (cachedSearch && cachedSearch.expiresAt > Date.now()) {
        bookSearchCache.delete(cacheKey);
        bookSearchCache.set(cacheKey, cachedSearch);
        res.setHeader('Cache-Control', 'public, max-age=180');
        return res.json(cachedSearch.payload);
      }

      const catCfg = CATEGORY_KEYWORDS[category];
      const effectiveQuery = rawQuery || catCfg.queryHint || 'classic literature science programming';

      type SearchBookItem = {
        id: string;
        source: 'internet_archive' | 'open_library' | 'gutenberg' | 'arxiv';
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
      };

      const fetchJsonWithTimeout = async (url: string, timeoutMs = 4500): Promise<unknown> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const r = await fetch(url, {
            signal: controller.signal,
            headers: {
              Accept: 'application/json',
              'User-Agent': 'BhashaBook/1.0 (+https://openlibrary.org)',
            },
          });
          if (!r.ok) return null;
          return await r.json();
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      };

      const fetchTextWithTimeout = async (url: string, timeoutMs = 4200): Promise<string | null> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const r = await fetch(url, {
            signal: controller.signal,
            headers: {
              Accept: 'application/atom+xml,application/xml,text/xml,*/*',
              'User-Agent': 'BhashaBook/1.0 (+https://openlibrary.org)',
            },
          });
          if (!r.ok) return null;
          return await r.text();
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      };

      // 1. Internet Archive Broad Open-Access Search (excludes borrow-only inlibrary/printdisabled so EVERY PDF is open & downloadable!)
      const queryInternetArchive = async (): Promise<SearchBookItem[]> => {
        const safeTerm = effectiveQuery.replace(/[()":\\]/g, ' ').trim();
        const clauses: string[] = [
          'mediatype:texts',
          '(format:"Text PDF" OR format:"PDF" OR format:"Additional Text PDF")',
          '-collection:inlibrary',
          '-collection:printdisabled',
        ];
        if (safeTerm) {
          clauses.push(`(title:(${safeTerm}) OR creator:(${safeTerm}) OR subject:(${safeTerm}))`);
        }
        if (catCfg.iaSubject) {
          clauses.push(`subject:(${catCfg.iaSubject})`);
        }
        if (lang !== 'all' && LANG_TO_IA[lang]) {
          clauses.push(`language:${LANG_TO_IA[lang]}`);
        }
        if (sort === 'oldest') {
          clauses.push('year:[1450 TO 2030]');
        } else if (sort === 'latest') {
          clauses.push('year:[1990 TO 2030]');
        }

        const iaSort =
          sort === 'rating'
            ? 'avg_rating desc'
            : sort === 'latest'
            ? 'year desc'
            : sort === 'oldest'
            ? 'year asc'
            : 'downloads desc';

        const params = new URLSearchParams();
        params.set('q', clauses.join(' AND '));
        params.append('fl[]', 'identifier');
        params.append('fl[]', 'title');
        params.append('fl[]', 'creator');
        params.append('fl[]', 'downloads');
        params.append('fl[]', 'avg_rating');
        params.append('fl[]', 'year');
        params.append('fl[]', 'language');
        params.append('fl[]', 'subject');
        params.append('fl[]', 'description');
        params.append('sort[]', iaSort);
        params.set('rows', '16');
        params.set('page', String(pageNum));
        params.set('output', 'json');

        const data = (await fetchJsonWithTimeout(
          `https://archive.org/advancedsearch.php?${params.toString()}`,
          4800
        )) as {
          response?: {
            docs?: Array<{
              identifier?: string;
              title?: string;
              creator?: string | string[];
              downloads?: number;
              avg_rating?: number;
              year?: string | number;
              language?: string | string[];
              subject?: string | string[];
              description?: string | string[];
            }>;
          };
        } | null;

        const docs = data?.response?.docs ?? [];
        const items: SearchBookItem[] = [];
        for (const d of docs) {
          if (!d.identifier || !d.title) continue;
          const author = Array.isArray(d.creator)
            ? d.creator.slice(0, 2).join(', ')
            : String(d.creator ?? 'Unknown Author');
          const rawSubjects = Array.isArray(d.subject)
            ? d.subject
            : typeof d.subject === 'string'
            ? [d.subject]
            : [];
          const desc = Array.isArray(d.description)
            ? String(d.description[0] ?? '')
            : typeof d.description === 'string'
            ? d.description
            : '';
          const parsedYear = parseInt(String(d.year ?? ''), 10);

          items.push({
            id: `ia:${d.identifier}`,
            source: 'internet_archive',
            identifier: d.identifier,
            title: String(d.title).trim(),
            author: author.trim() || 'Unknown Author',
            year: Number.isFinite(parsedYear) && parsedYear > 1400 && parsedYear <= 2030 ? parsedYear : undefined,
            language: normalizeLangLabel(d.language),
            downloads: typeof d.downloads === 'number' ? d.downloads : undefined,
            rating: typeof d.avg_rating === 'number' && d.avg_rating > 0 ? Math.min(5, d.avg_rating) : undefined,
            subjects: rawSubjects.map((s) => String(s).trim()).filter(Boolean).slice(0, 5),
            description: desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) || undefined,
            coverUrl: `https://archive.org/services/img/${encodeURIComponent(d.identifier)}`,
            pdfUrl: `https://archive.org/download/${encodeURIComponent(d.identifier)}/${encodeURIComponent(d.identifier)}.pdf`,
            readOnlineUrl: `https://archive.org/details/${encodeURIComponent(d.identifier)}`,
            format: 'PDF',
          });
        }
        return items;
      };

      // 2. Open Library Fast Single-Request Search (~750ms instead of 22s!)
      const queryOpenLibrary = async (): Promise<SearchBookItem[]> => {
        const baseQuery = rawQuery || catCfg.queryHint || 'programming';
        const params = new URLSearchParams();
        params.set('q', baseQuery);
        params.set('has_fulltext', 'true');
        if (catCfg.olSubject) {
          params.set('subject', catCfg.olSubject);
        }
        if (lang !== 'all' && LANG_TO_IA[lang]) {
          params.set('language', LANG_TO_IA[lang]);
        }
        if (sort === 'rating') params.set('sort', 'rating');
        else if (sort === 'latest') params.set('sort', 'new');
        else if (sort === 'oldest') params.set('sort', 'old');
        params.set('limit', '28');
        params.set('page', String(pageNum));
        params.set(
          'fields',
          'key,title,author_name,first_publish_year,cover_i,ia,number_of_pages_median,ratings_average,subject,language,isbn,ebook_access,edition_count'
        );

        const data = (await fetchJsonWithTimeout(
          `https://openlibrary.org/search.json?${params.toString()}`,
          4500
        )) as {
          docs?: Array<{
            key?: string;
            title?: string;
            author_name?: string[];
            first_publish_year?: number;
            cover_i?: number;
            ia?: string[];
            number_of_pages_median?: number;
            ratings_average?: number;
            subject?: string[];
            language?: string[];
            isbn?: string[];
            ebook_access?: string;
            edition_count?: number;
          }>;
        } | null;

        const items: SearchBookItem[] = [];
        for (const d of data?.docs ?? []) {
          if (!d.key || !d.title) continue;
          const isPublicIa =
            d.ebook_access === 'public' && Array.isArray(d.ia) && d.ia.length > 0;
          if (!isPublicIa) continue;
          const iaId = d.ia![0];
          const coverUrl = d.cover_i
            ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`
            : `https://archive.org/services/img/${encodeURIComponent(iaId)}`;

          items.push({
            id: `ol:${d.key}`,
            source: 'open_library',
            identifier: iaId,
            title: String(d.title).trim(),
            author:
              Array.isArray(d.author_name) && d.author_name.length > 0
                ? d.author_name.slice(0, 2).join(', ')
                : 'Unknown Author',
            year: typeof d.first_publish_year === 'number' ? d.first_publish_year : undefined,
            language: normalizeLangLabel(d.language),
            pageCount:
              typeof d.number_of_pages_median === 'number' ? d.number_of_pages_median : undefined,
            downloads: typeof d.edition_count === 'number' ? d.edition_count * 120 : undefined,
            rating:
              typeof d.ratings_average === 'number' && d.ratings_average > 0
                ? Math.round(d.ratings_average * 10) / 10
                : undefined,
            subjects: Array.isArray(d.subject) ? d.subject.slice(0, 5) : [],
            coverUrl,
            pdfUrl: `https://archive.org/download/${encodeURIComponent(iaId)}/${encodeURIComponent(iaId)}.pdf`,
            readOnlineUrl: `https://archive.org/details/${encodeURIComponent(iaId)}`,
            format: 'PDF',
            isbn: Array.isArray(d.isbn) ? d.isbn[0] : undefined,
          });
          if (items.length >= 12) break;
        }

        return items;
      };

      // 3. Project Gutenberg (Run Gutendex & Archive's Gutenberg Mirror IN PARALLEL with tight timeouts — zero sequential stall!)
      const queryGutenbergFast = async (): Promise<SearchBookItem[]> => {
        const fetchFromGutendex = async (): Promise<SearchBookItem[]> => {
          const params = new URLSearchParams();
          if (rawQuery) params.set('search', rawQuery);
          if (catCfg.gutenTopic) params.set('topic', catCfg.gutenTopic);
          if (lang !== 'all') params.set('languages', lang);
          params.set('page', String(pageNum));

          const data = (await fetchJsonWithTimeout(
            `https://gutendex.com/books?${params.toString()}`,
            2800
          )) as {
            results?: Array<{
              id?: number;
              title?: string;
              authors?: Array<{ name?: string }>;
              subjects?: string[];
              bookshelves?: string[];
              languages?: string[];
              download_count?: number;
              summaries?: string[];
              formats?: Record<string, string>;
            }>;
          } | null;

          const items: SearchBookItem[] = [];
          for (const b of (data?.results ?? []).slice(0, 12)) {
            if (!b.id || !b.title) continue;
            const formats = b.formats ?? {};
            const textUrl =
              formats['text/plain; charset=utf-8'] ||
              formats['text/plain; charset=us-ascii'] ||
              formats['text/plain'] ||
              undefined;
            if (!textUrl) continue;
            const epubUrl = formats['application/epub+zip'] || undefined;
            const htmlUrl =
              formats['text/html'] ||
              formats['text/html; charset=utf-8'] ||
              `https://www.gutenberg.org/ebooks/${b.id}`;
            const coverUrl = formats['image/jpeg'] || undefined;

            const authorName =
              Array.isArray(b.authors) && b.authors.length > 0
                ? b.authors
                    .slice(0, 2)
                    .map((a) => {
                      const name = (a.name ?? '').trim();
                      if (name.includes(',')) {
                        const [last, first] = name.split(',').map((s) => s.trim());
                        return first ? `${first} ${last}` : last;
                      }
                      return name;
                    })
                    .filter(Boolean)
                    .join(', ')
                : 'Project Gutenberg Author';

            const rawDesc = Array.isArray(b.summaries) && b.summaries[0] ? b.summaries[0] : undefined;

            items.push({
              id: `gutenberg:${b.id}`,
              source: 'gutenberg',
              identifier: String(b.id),
              title: b.title.trim(),
              author: authorName || 'Unknown Author',
              language: normalizeLangLabel(b.languages),
              downloads: typeof b.download_count === 'number' ? b.download_count : undefined,
              subjects: [...(b.subjects ?? []), ...(b.bookshelves ?? [])]
                .map((s) => s.replace(/^Browsing:\s*/i, '').trim())
                .filter(Boolean)
                .slice(0, 5),
              description: rawDesc ? rawDesc.slice(0, 500) : undefined,
              coverUrl,
              textUrl,
              epubUrl,
              readOnlineUrl: htmlUrl,
              format: 'EPUB / Text',
            });
          }
          return items;
        };

        const fetchFromArchiveGutenberg = async (): Promise<SearchBookItem[]> => {
          const safeTerm = (rawQuery || catCfg.gutenTopic || '').replace(/[()":\\]/g, ' ').trim();
          const gClauses = ['collection:gutenberg', 'mediatype:texts'];
          if (safeTerm) {
            gClauses.push(`(title:(${safeTerm}) OR creator:(${safeTerm}) OR subject:(${safeTerm}))`);
          }
          if (lang !== 'all' && LANG_TO_IA[lang]) {
            gClauses.push(`language:${LANG_TO_IA[lang]}`);
          }
          const gParams = new URLSearchParams();
          gParams.set('q', gClauses.join(' AND '));
          gParams.append('fl[]', 'identifier');
          gParams.append('fl[]', 'title');
          gParams.append('fl[]', 'creator');
          gParams.append('fl[]', 'downloads');
          gParams.append('fl[]', 'year');
          gParams.append('fl[]', 'language');
          gParams.append('fl[]', 'subject');
          gParams.append('sort[]', sort === 'oldest' ? 'year asc' : 'downloads desc');
          gParams.set('rows', '10');
          gParams.set('page', String(pageNum));
          gParams.set('output', 'json');

          const mirror = (await fetchJsonWithTimeout(
            `https://archive.org/advancedsearch.php?${gParams.toString()}`,
            4000
          )) as {
            response?: {
              docs?: Array<{
                identifier?: string;
                title?: string;
                creator?: string | string[];
                downloads?: number;
                year?: string | number;
                language?: string | string[];
                subject?: string | string[];
              }>;
            };
          } | null;

          const items: SearchBookItem[] = [];
          for (const d of mirror?.response?.docs ?? []) {
            if (!d.identifier || !d.title) continue;
            const author = Array.isArray(d.creator)
              ? d.creator.slice(0, 2).join(', ')
              : String(d.creator ?? 'Project Gutenberg Author');
            const parsedYear = parseInt(String(d.year ?? ''), 10);
            items.push({
              id: `gutenberg-ia:${d.identifier}`,
              source: 'gutenberg',
              identifier: d.identifier,
              title: String(d.title).trim(),
              author: author.trim() || 'Project Gutenberg Author',
              year: Number.isFinite(parsedYear) && parsedYear > 1400 && parsedYear <= 2030 ? parsedYear : undefined,
              language: normalizeLangLabel(d.language),
              downloads: typeof d.downloads === 'number' ? d.downloads : undefined,
              subjects: (Array.isArray(d.subject) ? d.subject : typeof d.subject === 'string' ? [d.subject] : [])
                .map((s) => String(s).trim())
                .filter(Boolean)
                .slice(0, 4),
              coverUrl: `https://archive.org/services/img/${encodeURIComponent(d.identifier)}`,
              pdfUrl: `https://archive.org/download/${encodeURIComponent(d.identifier)}/${encodeURIComponent(d.identifier)}.pdf`,
              readOnlineUrl: `https://archive.org/details/${encodeURIComponent(d.identifier)}`,
              format: 'EPUB / Text',
            });
          }
          return items;
        };

        const [direct, mirror] = await Promise.all([
          fetchFromGutendex(),
          fetchFromArchiveGutenberg(),
        ]);
        return direct.length > 0 ? [...direct, ...mirror.slice(0, 4)] : mirror;
      };

      // 4. arXiv Open-Access Monographs, Textbooks & Latest Research PDFs (2010-2026, ~900ms, guaranteed direct PDF!)
      const queryArxiv = async (): Promise<SearchBookItem[]> => {
        if (lang !== 'all' && lang !== 'en') return [];
        if (format === 'text') return [];
        if (!rawQuery && !['all', 'programming', 'science', 'business'].includes(category)) {
          return [];
        }
        const arxivQuery = rawQuery || catCfg.queryHint || 'computer science physics textbook';
        const cleanTerms = arxivQuery.replace(/[^\p{L}\p{N}\s-]/gu, ' ').trim();
        if (!cleanTerms) return [];

        const start = (pageNum - 1) * 6;
        const sortBy = sort === 'latest' ? 'submittedDate' : 'relevance';
        const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(
          cleanTerms
        )}&start=${start}&max_results=6&sortBy=${sortBy}&sortOrder=descending`;

        const xml = await fetchTextWithTimeout(url, 3800);
        if (!xml) return [];

        const items: SearchBookItem[] = [];
        const entryMatches = xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g);
        for (const m of entryMatches) {
          const entry = m[1];
          const rawId = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() ?? '';
          const arxivId = rawId.replace(/^https?:\/\/arxiv\.org\/abs\//i, '').trim();
          const title = decodeXmlEntities(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
          if (!arxivId || !title) continue;

          const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)]
            .map((a) => decodeXmlEntities(a[1]))
            .filter(Boolean)
            .slice(0, 2);
          const summary = decodeXmlEntities(entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? '');
          const published = entry.match(/<published>(\d{4})/)?.[1];
          const year = published ? parseInt(published, 10) : undefined;
          const cats = [...entry.matchAll(/<category[^>]*term="([^"]+)"/g)]
            .map((c) => c[1])
            .slice(0, 4);

          items.push({
            id: `arxiv:${arxivId}`,
            source: 'arxiv',
            identifier: arxivId,
            title,
            author: authors.join(', ') || 'arXiv Author',
            year: year && year >= 1991 && year <= 2030 ? year : undefined,
            language: 'English',
            subjects: cats.length > 0 ? cats : ['Open Access Research'],
            description: summary ? summary.slice(0, 500) : undefined,
            pdfUrl: `https://arxiv.org/pdf/${encodeURIComponent(arxivId)}.pdf`,
            readOnlineUrl: `https://arxiv.org/abs/${encodeURIComponent(arxivId)}`,
            format: 'PDF',
          });
        }
        return items;
      };

      const [iaResults, olResults, gutenResults, arxivResults] = await Promise.all([
        queryInternetArchive(),
        queryOpenLibrary(),
        queryGutenbergFast(),
        queryArxiv(),
      ]);

      // Unicode-aware merge & deduplication (preserves Hindi, Urdu, Arabic, Bengali, Tamil titles cleanly!)
      const mergedMap = new Map<string, SearchBookItem>();
      const allRaw = [...gutenResults, ...iaResults, ...olResults, ...arxivResults];

      for (const item of allRaw) {
        const normTitle = item.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 40);
        const normAuthor = item.author.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 20);
        const key = normTitle ? `${normTitle}::${normAuthor}` : item.id;
        const existing = mergedMap.get(key);
        if (!existing) {
          mergedMap.set(key, item);
        } else {
          const existingScore = (existing.pdfUrl ? 3 : 0) + (existing.textUrl ? 2 : 0) + (existing.coverUrl ? 1 : 0);
          const nextScore = (item.pdfUrl ? 3 : 0) + (item.textUrl ? 2 : 0) + (item.coverUrl ? 1 : 0);
          if (nextScore > existingScore) {
            mergedMap.set(key, {
              ...item,
              rating: item.rating ?? existing.rating,
              pageCount: item.pageCount ?? existing.pageCount,
              description: item.description ?? existing.description,
            });
          }
        }
      }

      // Only surface books that support ALL in-app facilities: Read, Translate, Listen, Bookmark & Download PDF
      let combined = Array.from(mergedMap.values()).filter((b) =>
        Boolean(b.pdfUrl || b.textUrl)
      );

      // Apply format filter
      if (format === 'pdf') {
        combined = combined.filter((b) => Boolean(b.pdfUrl));
      } else if (format === 'text') {
        combined = combined.filter((b) => Boolean(b.textUrl || b.epubUrl));
      } else if (format === 'online') {
        combined = combined.filter((b) => Boolean(b.pdfUrl || b.textUrl));
      }

      // Relevance scoring so exact searched titles & authors always surface right at the top
      const queryLower = rawQuery.toLowerCase();
      const queryTokens = queryLower
        .split(/\s+/)
        .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
        .filter((t) => t.length >= 2);

      const computeRelevance = (book: SearchBookItem): number => {
        if (!queryLower) return 0;
        const t = book.title.toLowerCase();
        const a = book.author.toLowerCase();
        let score = 0;
        if (t === queryLower) score += 120;
        else if (t.startsWith(queryLower)) score += 85;
        else if (t.includes(queryLower)) score += 65;
        if (a.includes(queryLower)) score += 45;

        if (queryTokens.length > 0) {
          let titleHits = 0;
          let authorHits = 0;
          for (const tok of queryTokens) {
            if (t.includes(tok)) titleHits++;
            if (a.includes(tok)) authorHits++;
          }
          score += (titleHits / queryTokens.length) * 40;
          score += (authorHits / queryTokens.length) * 20;
          if (titleHits === queryTokens.length) score += 25;
        }
        if (book.coverUrl) score += 6;
        if (book.downloads && book.downloads > 500) score += Math.min(12, Math.log10(book.downloads) * 2);
        return score;
      };

      combined.sort((a, b) => {
        if (sort === 'rating') {
          return (b.rating ?? 0) - (a.rating ?? 0) || (b.downloads ?? 0) - (a.downloads ?? 0);
        }
        if (sort === 'latest') {
          return (b.year ?? 0) - (a.year ?? 0) || computeRelevance(b) - computeRelevance(a);
        }
        if (sort === 'oldest') {
          const ay = a.year ?? 9999;
          const by = b.year ?? 9999;
          return ay - by || (b.downloads ?? 0) - (a.downloads ?? 0);
        }
        if (sort === 'relevance' && rawQuery) {
          const diff = computeRelevance(b) - computeRelevance(a);
          if (Math.abs(diff) > 2) return diff;
          return (b.downloads ?? 0) - (a.downloads ?? 0);
        }
        return (b.downloads ?? 0) - (a.downloads ?? 0);
      });

      const slice = combined.slice(0, 32);

      const responsePayload = {
        query: rawQuery,
        page: pageNum,
        total: combined.length,
        sources: {
          internetArchive: slice.filter((b) => b.source === 'internet_archive').length,
          openLibrary: slice.filter((b) => b.source === 'open_library').length,
          gutenberg: slice.filter((b) => b.source === 'gutenberg').length,
          arxiv: slice.filter((b) => b.source === 'arxiv').length,
        },
        books: slice,
      };

      if (slice.length > 0) {
        if (bookSearchCache.size >= BOOK_SEARCH_CACHE_MAX) {
          const oldest = bookSearchCache.keys().next().value;
          if (oldest !== undefined) bookSearchCache.delete(oldest);
        }
        bookSearchCache.set(cacheKey, {
          payload: responsePayload,
          expiresAt: Date.now() + BOOK_SEARCH_CACHE_TTL_MS,
        });
      }

      res.setHeader('Cache-Control', 'public, max-age=180');
      return res.json(responsePayload);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Book search failed.';
      return res.status(502).json({ error: message });
    }
  });

  // GET /api/books/resolve — Cached resolver for exact downloadable PDF/Text file & metadata on Internet Archive
  app.get('/api/books/resolve', async (req, res) => {
    try {
      const identifier = typeof req.query.identifier === 'string' ? req.query.identifier.trim() : '';
      if (!identifier || !/^[A-Za-z0-9._-]{1,160}$/.test(identifier)) {
        return res.status(400).json({ error: 'Invalid book identifier.' });
      }

      const cached = archiveResolveCache.get(identifier);
      if (cached && cached.expiresAt > Date.now()) {
        res.setHeader('Cache-Control', 'public, max-age=600');
        return res.json(cached.payload);
      }

      const { response } = await safeFetchAllowlisted(
        `https://archive.org/metadata/${encodeURIComponent(identifier)}`,
        { timeoutMs: 9000, accept: 'application/json' }
      );
      if (!response.ok) {
        return res.status(502).json({ error: `Could not fetch metadata (${response.status}).` });
      }

      const meta = (await response.json()) as {
        metadata?: {
          title?: string;
          creator?: string | string[];
          description?: string | string[];
          imagecount?: string | number;
          year?: string | number;
        };
        files?: Array<{
          name?: string;
          format?: string;
          size?: string | number;
          private?: string | boolean;
        }>;
      };

      const files = Array.isArray(meta.files) ? meta.files : [];
      const publicFiles = files.filter((f) => f.private !== 'true' && f.private !== true && typeof f.name === 'string');

      // Prefer standard Text PDF / PDF under 45 MB (prefer smaller fast-loading PDFs)
      const pdfCandidates = publicFiles
        .filter((f) => /\.pdf$/i.test(f.name!) && !/encrypted/i.test(f.format ?? ''))
        .sort((a, b) => {
          const aSize = Number(a.size ?? 0);
          const bSize = Number(b.size ?? 0);
          const aScore =
            (/text pdf/i.test(a.format ?? '') ? 10 : 0) +
            (!/_bw\.pdf$/i.test(a.name!) ? 4 : 0) +
            (aSize > 0 && aSize < 15_000_000 ? 6 : aSize > 0 && aSize < 44_000_000 ? 3 : -12);
          const bScore =
            (/text pdf/i.test(b.format ?? '') ? 10 : 0) +
            (!/_bw\.pdf$/i.test(b.name!) ? 4 : 0) +
            (bSize > 0 && bSize < 15_000_000 ? 6 : bSize > 0 && bSize < 44_000_000 ? 3 : -12);
          return bScore - aScore;
        });

      const txtCandidate = publicFiles.find(
        (f) => /_djvu\.txt$/i.test(f.name!) || /\.txt$/i.test(f.name!)
      );

      const bestPdf = pdfCandidates[0];
      const pdfUrl = bestPdf
        ? `https://archive.org/download/${encodeURIComponent(identifier)}/${bestPdf.name!
            .split('/')
            .map(encodeURIComponent)
            .join('/')}`
        : undefined;

      const textUrl = txtCandidate
        ? `https://archive.org/download/${encodeURIComponent(identifier)}/${txtCandidate.name!
            .split('/')
            .map(encodeURIComponent)
            .join('/')}`
        : undefined;

      const rawDesc = Array.isArray(meta.metadata?.description)
        ? String(meta.metadata?.description[0] ?? '')
        : String(meta.metadata?.description ?? '');

      const resolvePayload = {
        identifier,
        pdfUrl,
        pdfSize: bestPdf ? Number(bestPdf.size ?? 0) : undefined,
        textUrl,
        pageCount: meta.metadata?.imagecount ? Number(meta.metadata.imagecount) : undefined,
        description: rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 900) || undefined,
      };

      if (archiveResolveCache.size >= ARCHIVE_RESOLVE_CACHE_MAX) {
        const oldest = archiveResolveCache.keys().next().value;
        if (oldest !== undefined) archiveResolveCache.delete(oldest);
      }
      archiveResolveCache.set(identifier, {
        payload: resolvePayload,
        expiresAt: Date.now() + ARCHIVE_RESOLVE_CACHE_TTL_MS,
      });

      res.setHeader('Cache-Control', 'public, max-age=600');
      return res.json(resolvePayload);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to resolve book files.';
      return res.status(502).json({ error: message });
    }
  });

  // GET /api/books/proxy-pdf — SSRF-protected streaming proxy for allowlisted public-domain PDFs
  app.get('/api/books/proxy-pdf', async (req, res) => {
    try {
      const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
      if (!parseAllowedBookUrl(rawUrl)) {
        return res.status(400).json({ error: 'Only verified public-domain book URLs are allowed.' });
      }

      const { response } = await safeFetchAllowlisted(rawUrl, {
        timeoutMs: 30000,
        accept: 'application/pdf,*/*',
      });

      if (!response.ok) {
        return res.status(502).json({ error: `Upstream PDF unavailable (${response.status}).` });
      }

      const contentLen = Number(response.headers.get('content-length') ?? '0');
      const MAX_PDF_BYTES = 24 * 1024 * 1024;
      if (contentLen > MAX_PDF_BYTES) {
        return res.status(413).json({
          error: 'PDF exceeds 24 MB mobile streaming limit. Try the plain-text edition if available.',
        });
      }

      const arrBuf = await response.arrayBuffer();
      if (arrBuf.byteLength > MAX_PDF_BYTES) {
        return res.status(413).json({
          error: 'PDF exceeds 24 MB mobile streaming limit. Try the plain-text edition if available.',
        });
      }
      const buf = Buffer.from(arrBuf);
      // Verify PDF magic header (%PDF-) to avoid serving HTML login/error pages as PDFs
      const headerSlice = buf.subarray(0, 1024).toString('latin1');
      if (!headerSlice.includes('%PDF-')) {
        return res.status(422).json({
          error: 'This book requires borrowing or is not an open downloadable PDF on Internet Archive.',
        });
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.send(buf);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not fetch remote PDF.';
      return res.status(502).json({ error: message });
    }
  });

  // GET /api/books/fetch-text — SSRF-protected plain-text e-book fetcher (Gutendex / Internet Archive)
  app.get('/api/books/fetch-text', async (req, res) => {
    try {
      const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
      if (!parseAllowedBookUrl(rawUrl)) {
        return res.status(400).json({ error: 'Only verified public-domain text URLs are allowed.' });
      }

      const { response } = await safeFetchAllowlisted(rawUrl, {
        timeoutMs: 20000,
        accept: 'text/plain,text/html;q=0.8,*/*',
      });
      if (!response.ok) {
        return res.status(502).json({ error: `Upstream text unavailable (${response.status}).` });
      }

      const rawText = await response.text();
      if (rawText.length > 8_000_000) {
        return res.status(413).json({ error: 'Text e-book exceeds 8 MB size limit.' });
      }

      // Clean Project Gutenberg header & footer boilerplate if present
      let cleaned = rawText.replace(/\r\n/g, '\n');
      const startMatch = cleaned.match(/\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i);
      if (startMatch && startMatch.index !== undefined) {
        cleaned = cleaned.slice(startMatch.index + startMatch[0].length);
      }
      const endMatch = cleaned.match(/\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i);
      if (endMatch && endMatch.index !== undefined) {
        cleaned = cleaned.slice(0, endMatch.index);
      }

      // Strip HTML tags cleanly if an HTML stream was returned
      if (/<html[\s>]/i.test(cleaned.slice(0, 600))) {
        cleaned = cleaned
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<\/(?:p|div|h[1-6]|li|br)>/gi, '\n\n')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&quot;/gi, '"');
      }

      return res.json({ text: cleaned.trim() });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch book text.';
      return res.status(502).json({ error: message });
    }
  });

  // GET /api/books/proxy-cover — SSRF-protected image proxy so pdf-lib can embed remote book covers onto Page 1
  app.get('/api/books/proxy-cover', async (req, res) => {
    try {
      const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
      if (!parseAllowedBookUrl(rawUrl)) {
        return res.status(400).json({ error: 'Invalid cover URL.' });
      }
      const { response } = await safeFetchAllowlisted(rawUrl, {
        timeoutMs: 12000,
        accept: 'image/jpeg,image/png,image/webp,*/*',
      });
      if (!response.ok) {
        return res.status(404).end();
      }
      const ct = response.headers.get('content-type') || 'image/jpeg';
      if (!ct.toLowerCase().startsWith('image/')) {
        return res.status(415).end();
      }
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.byteLength > 5 * 1024 * 1024) {
        return res.status(413).end();
      }
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(buf);
    } catch {
      return res.status(404).end();
    }
  });

  // POST /api/summarize-chapter — One-Click Chapter Summarizer & Key Takeaways (100% Free + Optional AI Upgrade)
  app.post('/api/summarize-chapter', async (req, res) => {
    try {
      const {
        chapterTitle,
        text,
        targetLang = 'en',
        translationStyle = 'tutor',
        tutorPrompt,
      } = req.body ?? {};
      if (typeof text !== 'string' || text.trim().length < 40) {
        return res.status(400).json({ error: 'Chapter needs at least a few sentences to summarize.' });
      }
      if (typeof targetLang !== 'string' || !ALLOWED_LANGS[targetLang]) {
        return res.status(400).json({ error: 'Unsupported target language.' });
      }

      const safeTitle = typeof chapterTitle === 'string' ? chapterTitle.trim().slice(0, 140) : 'Current Chapter';
      const clipped = text.replace(/\s+/g, ' ').trim().slice(0, 22000);
      const wordCount = clipped.split(/\s+/).filter(Boolean).length;
      const readingTimeMinutes = Math.max(1, Math.round(wordCount / 210));
      const langMeta = ALLOWED_LANGS[targetLang];
      const summaryLangInstruction =
        targetLang === 'orig'
          ? 'the exact same language and script as the chapter text'
          : targetLang === 'hi'
            ? 'simple, conversational Hindi (Devanagari script)'
            : targetLang === 'hinglish'
              ? 'simple, conversational Hindi in Latin script (Hinglish)'
              : langMeta.name;
      const isTutorSummary = translationStyle !== 'faithful';
      const effectiveSummaryTutorPrompt =
        typeof tutorPrompt === 'string' && tutorPrompt.trim().length > 0
          ? tutorPrompt.trim().slice(0, 800)
          : 'Act as an expert translator and tutor. Translate and explain the content in simple, conversational Hindi, breaking down complex concepts with everyday examples familiar to an Indian audience.';

      // 1. Optional Gemini AI structured summary when API key is configured
      const ai = getGeminiClient();
      if (ai) {
        try {
          const prompt = isTutorSummary
            ? `Summarize and explain the following book chapter titled "${safeTitle}" in ${summaryLangInstruction}, breaking down any complex concepts with simple everyday examples familiar to an Indian audience.
Return strict JSON with:
- "summary": warm, easy-to-understand 2-3 sentence conversational overview in ${summaryLangInstruction}
- "keyTakeaways": 4 to 6 crisp, conversational bullet-point takeaways in ${summaryLangInstruction} (include brief relatable Indian examples where helpful for tough ideas)
- "keyTerms": 4 to 6 important concepts/terms mentioned in the chapter.

Chapter text:
${clipped.slice(0, 14000)}`
            : `Summarize the following book chapter titled "${safeTitle}" for a student/reader in ${summaryLangInstruction}.
Return strict JSON with:
- "summary": concise 2-3 sentence overview in ${summaryLangInstruction}
- "keyTakeaways": 4 to 6 crisp, actionable bullet-point takeaways in ${summaryLangInstruction}
- "keyTerms": 4 to 6 important concepts/terms mentioned in the chapter.

Chapter text:
${clipped.slice(0, 14000)}`;

          const response = await ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: prompt,
            config: {
              ...(isTutorSummary ? { systemInstruction: effectiveSummaryTutorPrompt } : {}),
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  summary: { type: Type.STRING },
                  keyTakeaways: { type: Type.ARRAY, items: { type: Type.STRING } },
                  keyTerms: { type: Type.ARRAY, items: { type: Type.STRING } },
                },
                required: ['summary', 'keyTakeaways', 'keyTerms'],
              },
            },
          });

          const parsed =
            safeParseLlmJson<{
              summary?: string;
              keyTakeaways?: string[];
              keyTerms?: string[];
            }>(response.text) ?? {};
          if (parsed.summary && Array.isArray(parsed.keyTakeaways) && parsed.keyTakeaways.length > 0) {
            return res.json({
              chapterTitle: safeTitle,
              summary: parsed.summary.trim(),
              keyTakeaways: parsed.keyTakeaways.map((s) => s.trim()).filter(Boolean).slice(0, 6),
              keyTerms: (parsed.keyTerms ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 8),
              readingTimeMinutes,
              source: 'ai',
            });
          }
        } catch {
          // Fall through cleanly to zero-cost extractive summarizer
        }
      }

      // 2. 100% Free Extractive Summarizer (TF-IDF term-frequency scoring + automatic target language translation)
      const rawSentences = (clipped.match(/[^.!?।۔؟]+[.!?।۔؟]+/g) ?? [clipped])
        .map((s) => s.trim())
        .filter((s) => s.length >= 35 && s.length <= 360);

      const stopWords = new Set([
        'the', 'and', 'for', 'that', 'with', 'this', 'from', 'have', 'were', 'been', 'will',
        'their', 'there', 'which', 'about', 'would', 'could', 'should', 'into', 'more', 'also',
        'they', 'them', 'then', 'than', 'when', 'what', 'your', 'some', 'only', 'such', 'other',
        'very', 'just', 'like', 'over', 'most', 'many', 'each', 'well', 'make', 'made', 'using',
      ]);

      const freq = new Map<string, number>();
      for (const s of rawSentences) {
        const words = s.toLowerCase().match(/[a-z\u0900-\u097f]{4,}/g) ?? [];
        for (const w of words) {
          if (!stopWords.has(w)) {
            freq.set(w, (freq.get(w) ?? 0) + 1);
          }
        }
      }

      const keyTerms = Array.from(freq.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([w]) => w.charAt(0).toUpperCase() + w.slice(1));

      const scored = rawSentences.map((sentence, idx) => {
        const words = sentence.toLowerCase().match(/[a-z\u0900-\u097f]{4,}/g) ?? [];
        let score = 0;
        for (const w of words) {
          score += freq.get(w) ?? 0;
        }
        // Mild positional boost for opening/concluding thesis sentences
        const posBoost = idx < 3 ? 1.28 : idx >= rawSentences.length - 2 ? 1.12 : 1.0;
        const normScore = (score / Math.max(6, words.length)) * posBoost;
        return { sentence, idx, score: normScore };
      });

      const topCount = Math.min(6, Math.max(3, scored.length));
      const picked = scored
        .sort((a, b) => b.score - a.score)
        .slice(0, topCount)
        .sort((a, b) => a.idx - b.idx)
        .map((s) => s.sentence);

      let summaryText = picked.slice(0, 2).join(' ');
      let takeaways = picked.slice(0, 5);

      // If text looks English and user wants a non-English target language, translate summary & takeaways for free
      const asciiRatio =
        (summaryText.match(/[A-Za-z]/g)?.length ?? 0) / Math.max(1, summaryText.length);
      if (targetLang !== 'en' && targetLang !== 'orig' && asciiRatio > 0.45) {
        try {
          const blocksToTr = [
            { id: 'sum', text: summaryText },
            ...takeaways.map((t, i) => ({ id: `tk-${i}`, text: t })),
          ];
          const { translations } = await translateBlocksFast(blocksToTr, targetLang, true, []);
          if (translations.sum) summaryText = translations.sum;
          takeaways = takeaways.map((t, i) => translations[`tk-${i}`] || t);
        } catch {
          // Keep original summary text if free translation momentarily fails
        }
      }

      return res.json({
        chapterTitle: safeTitle,
        summary: summaryText || clipped.slice(0, 320),
        keyTakeaways: takeaways.length > 0 ? takeaways : [clipped.slice(0, 220)],
        keyTerms,
        readingTimeMinutes,
        source: 'extractive',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Chapter summarization failed.';
      return res.status(502).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    // Serve a clean, lightweight classic Service Worker in dev mode so offline library
    // caching works reliably without Workbox dev-dist module/importScripts conflicts or reload loops.
    app.get('/sw.js', (_req, res) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(`
const LIBRARY_CACHE = 'bhashabook-library-offline-v1';
const PDFJS_CACHE = 'bhashabook-pdfjs-assets-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never intercept Vite dev modules, HMR, source files, or API translate/TTS calls
  if (
    url.pathname.startsWith('/@') ||
    url.pathname.startsWith('/src/') ||
    url.pathname.startsWith('/node_modules/') ||
    (url.pathname.startsWith('/api/') &&
      url.pathname !== '/api/books/proxy-pdf' &&
      url.pathname !== '/api/books/proxy-cover')
  ) {
    return;
  }

  if (url.pathname.startsWith('/pdfjs/')) {
    event.respondWith(
      caches.open(PDFJS_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const resp = await fetch(req);
        if (resp && resp.ok) {
          cache.put(req, resp.clone()).catch(() => {});
        }
        return resp;
      })
    );
    return;
  }

  if (
    /^\\/assets\\/aistudio\\/.*\\.pdf$/i.test(url.pathname) ||
    url.pathname === '/api/books/proxy-pdf' ||
    url.pathname === '/api/books/proxy-cover'
  ) {
    event.respondWith(
      caches.open(LIBRARY_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const resp = await fetch(req);
        if (resp && resp.ok) {
          cache.put(req, resp.clone()).catch(() => {});
        }
        return resp;
      })
    );
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => {
        const cache = await caches.open(LIBRARY_CACHE);
        return (await cache.match('/')) || Response.error();
      })
    );
  }
});
`);
    });

    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
      },
      appType: 'spa',
    });

    // When HMR is disabled in Express middlewareMode, Vite 8 still injects /@vite/client
    // which attempts to open a WebSocket on port 24678 and throws an unhandled rejection.
    // Serve a clean WebSocket-free shim providing the exact style & hot-context exports.
    app.get('/@vite/client', (_req, res) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      return res.send(`
const sheetsMap = new Map();
export function updateStyle(id, content) {
  if (typeof document === 'undefined') return;
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    document.head.appendChild(style);
    sheetsMap.set(id, style);
  }
  style.textContent = content;
}
export function removeStyle(id) {
  if (typeof document === 'undefined') return;
  const style = sheetsMap.get(id);
  if (style) {
    document.head.removeChild(style);
    sheetsMap.delete(id);
  }
}
export function createHotContext() {
  const noop = () => {};
  return {
    data: {},
    accept: noop,
    acceptExports: noop,
    dispose: noop,
    prune: noop,
    decline: noop,
    invalidate: noop,
    on: noop,
    off: noop,
    send: noop,
  };
}
export function injectQuery(url, queryToInject) {
  if (!url || (!url.startsWith('.') && !url.startsWith('/'))) return url;
  const [pathname, search] = url.split('?');
  return pathname + '?' + queryToInject + (search ? '&' + search : '');
}
const BaseElement = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};
export class ErrorOverlay extends BaseElement {}
`);
    });

    // Never allow /api/* routes to fall through to Vite SPA HTML (<!doctype html>)
    app.all('/api/*', (_req, res) => {
      return res.status(404).json({ error: 'API endpoint not found.' });
    });

    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    const publicDir = path.resolve(__dirname, 'public');
    if (fs.existsSync(publicDir)) {
      app.use(express.static(publicDir));
    }
    app.use(express.static(distDir));
    // Never allow /api/* routes to fall through to static SPA index.html
    app.all('/api/*', (_req, res) => {
      return res.status(404).json({ error: 'API endpoint not found.' });
    });
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // Global JSON error handler: guarantees /api/* errors (e.g., PayloadTooLargeError, SyntaxError) NEVER return HTML
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      return next(err);
    }
    if (req.path.startsWith('/api/')) {
      const errObj = err as { status?: number; statusCode?: number; type?: string; message?: string };
      const status =
        typeof errObj?.status === 'number'
          ? errObj.status
          : typeof errObj?.statusCode === 'number'
            ? errObj.statusCode
            : 500;
      const message =
        errObj?.type === 'entity.too.large'
          ? 'Page payload was too large. Retrying in lightweight mode.'
          : errObj?.message && !/<!doctype|<html/i.test(errObj.message)
            ? errObj.message
            : 'Temporary server error. Please retry.';
      return res.status(status >= 400 && status < 600 ? status : 500).json({ error: message });
    }
    return next(err);
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`BhashaBook server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
