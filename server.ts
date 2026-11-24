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
  hi: { name: 'Hindi', gtxCode: 'hi', myMemoryCode: 'hi' },
  hinglish: { name: 'Hinglish', gtxCode: 'hi', myMemoryCode: 'hi' },
  bn: { name: 'Bengali', gtxCode: 'bn', myMemoryCode: 'bn' },
  ta: { name: 'Tamil', gtxCode: 'ta', myMemoryCode: 'ta' },
  te: { name: 'Telugu', gtxCode: 'te', myMemoryCode: 'te' },
  mr: { name: 'Marathi', gtxCode: 'mr', myMemoryCode: 'mr' },
  ur: { name: 'Urdu', gtxCode: 'ur', myMemoryCode: 'ur' },
  es: { name: 'Spanish', gtxCode: 'es', myMemoryCode: 'es' },
  fr: { name: 'French', gtxCode: 'fr', myMemoryCode: 'fr' },
  de: { name: 'German', gtxCode: 'de', myMemoryCode: 'de' },
  ar: { name: 'Arabic', gtxCode: 'ar', myMemoryCode: 'ar' },
  en: { name: 'English', gtxCode: 'en', myMemoryCode: 'en' },
};

const DEFAULT_TECH_TERMS = [
  'Open Broadcaster Software',
  'OBS Studio',
  'OBS Classic',
  'OBS',
  'Audio Mixer',
  'Browser Docks',
  'Browser Dock',
  'Custom Browser Docks',
  'Custom Docks',
  'Stats Dock',
  'Studio Mode',
  'Source Docks',
  'Source Dock',
  'Source Record',
  'Replay Source',
  'Replay Buffer',
  'Advanced Scene Switcher',
  'Multiple RTMP Output',
  'Audio Monitor',
  'Virtual Audio Cables',
  'Virtual Audio Cable',
  'Filter Hotkeys',
  'Animated Lower Thirds',
  'Lower Thirds',
  'Lower Third',
  'Background Removal',
  'OBS Color Monitor',
  'Color Monitor',
  'Color Correction',
  'Image Mask/Blend',
  'Chroma Key',
  'Luma Key',
  'LUT Filter',
  'LUT',
  'Move Transitions',
  'Scene Collections',
  'Scene Transitions',
  'Virtual Camera',
  'Web-Captioner',
  'Web Captioner',
  'VDO.ninja',
  'VDO.Ninja',
  'PTZOptics',
  'StreamGeeks',
  'Elgato StreamDeck',
  'StreamDeck',
  'Touch Portal',
  'VoiceMeeter',
  'VB-CABLE',
  'ReaGate',
  'ReaEQ',
  'ReaXcomp',
  'Sidechain/Ducking',
  'Sidechain Compression',
  'Noise Suppression',
  'Noise Gate',
  'Compressor',
  'Expander',
  'Limiter',
  'RNNoise',
  'Speex',
  'NVENC',
  'QuickSync',
  'AMF',
  'x264',
  'H.264',
  'H.265',
  'HEVC',
  'NDI®|HX',
  'NDI|HX',
  'NDI®',
  'NDI',
  'RTMP',
  'RTSP',
  'SRT',
  'IPMX',
  'WebSockets',
  'WebSocket',
  'WebRTC',
  'Bitrate',
  'Dynamic Bitrates',
  'CBR',
  'VBR',
  'ABR',
  'CQP',
  'Keyframe',
  'T-Bar',
  'Multiview',
  'Hotkeys',
  'Hotkey',
  'Plugins',
  'Plugin',
  'Scenes',
  'Scene',
  'Sources',
  'Source',
  'Filters',
  'Filter',
  'Vectorscope',
  'Waveform Monitor',
  'Histogram',
  'Tally Light',
  'Tally Lights',
  'Sync Offset',
  'PTZ',
  'VST',
  'DAW',
  'NTP',
  'DHCP',
  'VLAN',
  'LAN',
  'WAN',
  'ISP',
  'NIC',
  'CDN',
  'PoE',
  'HDMI',
  'SDI',
  'PCIe',
  'USB',
  'GPU',
  'CPU',
  'VRAM',
  'DRAM',
  'DDR4',
  'SSD',
  'HDD',
  'FPS',
  '4K',
  '1080p',
  '720p',
  'GitHub',
  'YouTube',
  'Twitch',
  'Facebook',
  'Zoom',
  'Microsoft Teams',
  'Skype',
  'Task Manager',
  'Activity Monitor',
  'QSS',
  'CSS',
  'HTML',
  'API',
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

const FREE_TRANSLATE_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];
let uaCounter = 0;
let gtxCooldownUntil = 0;

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

async function translateViaClients5Mirror(
  text: string,
  slGtx: string,
  tlGtx: string
): Promise<string | null> {
  try {
    const url = new URL('https://clients5.google.com/translate_a/t');
    url.searchParams.set('client', 'dict-chrome-ex');
    url.searchParams.set('sl', slGtx);
    url.searchParams.set('tl', tlGtx);

    const body = new URLSearchParams();
    body.set('q', text);

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'User-Agent': nextUserAgent(),
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });

    if (response.status === 429 || response.status === 503) {
      gtxCooldownUntil = Math.max(gtxCooldownUntil, Date.now() + 2500);
      return null;
    }
    if (!response.ok) return null;

    const data: unknown = await response.json();
    if (Array.isArray(data)) {
      if (typeof data[0] === 'string' && data[0].trim()) {
        return data[0];
      }
      if (Array.isArray(data[0]) && typeof data[0][0] === 'string' && data[0][0].trim()) {
        return data[0][0];
      }
    }
  } catch {
    // ignore and fall through
  }
  return null;
}

async function translateFreeSingle(
  text: string,
  gtxCode: string,
  myMemoryCode: string,
  sourceLang?: { gtxCode: string; myMemoryCode: string }
): Promise<string> {
  if (!text.trim()) return '';
  if (gtxCode === 'en' && !sourceLang) return text;

  const slGtx = sourceLang?.gtxCode || 'auto';
  const slMyMemory = sourceLang?.myMemoryCode || 'en';

  // Respect shared cooldown if Google GTX recently returned 429
  const nowWait = gtxCooldownUntil - Date.now();
  if (nowWait > 0) {
    await sleepMs(Math.min(nowWait, 4500));
  }

  // Primary: Google Translate public GTX via POST with progressive backoff on 429/5xx
  const backoffDelays = [900, 2200, 4200];
  for (let attempt = 0; attempt < 3; attempt++) {
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
        signal: AbortSignal.timeout(16000),
      });

      if (response.ok) {
        const data = await response.json();
        const joined = parseGtxResponse(data);
        if (joined.trim()) return joined;
      } else if (response.status === 429 || response.status === 503 || response.status >= 500) {
        const delay = backoffDelays[attempt] ?? 3000;
        gtxCooldownUntil = Math.max(gtxCooldownUntil, Date.now() + delay);
        if (attempt < 2) {
          await sleepMs(delay);
          continue;
        }
      }
    } catch {
      if (attempt < 2) {
        await sleepMs(backoffDelays[attempt] ?? 1500);
        continue;
      }
    }
    break;
  }

  // Secondary: Google clients5 mirror (separate host & quota pool)
  const mirrorResult = await translateViaClients5Mirror(text, slGtx, gtxCode);
  if (mirrorResult && mirrorResult.trim()) {
    return mirrorResult;
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
        signal: AbortSignal.timeout(14000),
      });

      if (response.ok) {
        const data = await response.json();
        const joined = parseGtxResponse(data);
        if (joined.trim()) return joined;
      }
    } catch {
      // Fall through to MyMemory
    }
  }

  // Quaternary: Chunked MyMemory free public translation API (no 480-char truncation)
  if (slMyMemory.toLowerCase() !== myMemoryCode.toLowerCase()) {
    try {
      const segments = splitTextForMyMemory(text, 430);
      const translatedSegments: string[] = [];
      for (const seg of segments) {
        const mmUrl = new URL('https://api.mymemory.translated.net/get');
        mmUrl.searchParams.set('q', seg);
        mmUrl.searchParams.set('langpair', `${slMyMemory}|${myMemoryCode}`);
        const response = await fetch(mmUrl.toString(), {
          signal: AbortSignal.timeout(12000),
        });
        if (!response.ok) {
          throw new Error(`MyMemory HTTP ${response.status}`);
        }
        const data = (await response.json()) as {
          responseStatus?: number;
          responseData?: { translatedText?: string };
        };
        if (data.responseStatus === 200 && data.responseData?.translatedText) {
          translatedSegments.push(data.responseData.translatedText);
        } else {
          throw new Error('MyMemory quota or status error');
        }
      }
      const joinedMm = translatedSegments.join(' ').trim();
      if (joinedMm) return joinedMm;
    } catch {
      // Fall through
    }
  }

  throw new Error('Free translation endpoints are temporarily rate-limited. Retrying automatically...');
}

async function translateBlocksFast(
  validBlocks: Array<{ id: string; text: string }>,
  targetLang: string,
  preserveTerms: boolean,
  safeCustomTerms: string[],
  concurrency = 3,
  allowPartialFailure = false
): Promise<{ translations: Record<string, string>; failedIds: string[] }> {
  const langMeta = ALLOWED_LANGS[targetLang];
  const translations: Record<string, string> = {};
  const failedIds: string[] = [];

  type ChunkItem = {
    id: string;
    masked: string;
    tokens: Array<{ token: string; original: string }>;
  };

  const chunks: ChunkItem[][] = [];
  let currentChunk: ChunkItem[] = [];
  let currentLen = 0;

  for (const blk of validBlocks) {
    const cleanText = blk.text.trim();
    if (!cleanText) {
      translations[blk.id] = '';
      continue;
    }
    const { masked, tokens } = preserveTerms
      ? protectTechnicalTerms(cleanText, safeCustomTerms)
      : { masked: cleanText, tokens: [] };

    if (currentLen + masked.length > 2600 && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentLen = 0;
    }
    currentChunk.push({ id: blk.id, masked, tokens });
    currentLen += masked.length + 16;
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  const finalizeText = (raw: string, tokens: Array<{ token: string; original: string }>) => {
    let textOut = raw.trim();
    if (targetLang === 'hinglish') {
      textOut = devanagariToHinglish(textOut);
    }
    if (preserveTerms) {
      textOut = restoreTechnicalTerms(textOut, tokens);
    }
    return textOut;
  };

  const translateSingleItemSafely = async (item: ChunkItem) => {
    try {
      const raw = await translateFreeSingle(item.masked, langMeta.gtxCode, langMeta.myMemoryCode);
      translations[item.id] = finalizeText(raw, item.tokens);
    } catch (err) {
      if (!allowPartialFailure) throw err;
      failedIds.push(item.id);
    }
  };

  await runWithConcurrency(chunks, concurrency, async (chunk, chunkIdx) => {
    // Gentle stagger across concurrent chunks to avoid burst 429s
    if (chunkIdx > 0) {
      await sleepMs(110);
    }

    if (chunk.length === 1) {
      await translateSingleItemSafely(chunk[0]);
      return;
    }

    const delimiter = '\n[[[SEP]]]\n';
    const combined = chunk.map((c) => c.masked).join(delimiter);

    try {
      const rawTranslated = await translateFreeSingle(
        combined,
        langMeta.gtxCode,
        langMeta.myMemoryCode
      );
      const parts = rawTranslated.split(/\s*\[\[\[SEP\]\]\]\s*/i);

      if (parts.length === chunk.length) {
        for (let i = 0; i < chunk.length; i++) {
          translations[chunk[i].id] = finalizeText(parts[i], chunk[i].tokens);
        }
        return;
      }
    } catch (err) {
      if (!allowPartialFailure) {
        // Still try per-block recovery before giving up
        await runWithConcurrency(chunk, 2, async (item) => {
          const raw = await translateFreeSingle(
            item.masked,
            langMeta.gtxCode,
            langMeta.myMemoryCode
          );
          translations[item.id] = finalizeText(raw, item.tokens);
        });
        return;
      }
    }

    // Fallback: translate each block in this chunk gently (2 at a time)
    await runWithConcurrency(chunk, 2, async (item) => {
      await sleepMs(80);
      await translateSingleItemSafely(item);
    });
  });

  return { translations, failedIds };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // Serve PDF.js bundled standard fonts, CMaps, ICC profiles, and WASM image decoders
  // so PDF rendering never falls back to missing OS system fonts (e.g. Helvetica) or fails decoding JPX/JBIG2 images
  const pdfjsDistDir = path.resolve(__dirname, 'node_modules/pdfjs-dist');
  const pdfjsStaticOpts = { maxAge: '7d', immutable: true };
  app.use('/pdfjs/standard_fonts', express.static(path.join(pdfjsDistDir, 'standard_fonts'), pdfjsStaticOpts));
  app.use('/pdfjs/cmaps', express.static(path.join(pdfjsDistDir, 'cmaps'), pdfjsStaticOpts));
  app.use('/pdfjs/wasm', express.static(path.join(pdfjsDistDir, 'wasm'), pdfjsStaticOpts));
  app.use('/pdfjs/iccs', express.static(path.join(pdfjsDistDir, 'iccs'), pdfjsStaticOpts));

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      aiAvailable: Boolean(getGeminiClient()),
    });
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

      const { translations } = await translateBlocksFast(
        validBlocks,
        targetLang,
        Boolean(preserveTerms),
        safeCustomTerms,
        3,
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
          if (flatBlocks.length >= 1200) break;
          const compositeId = `p${pg.pageNumber}::${blk.id}`;
          flatBlocks.push({ id: compositeId, text: blk.text });
          pageIdMap.set(compositeId, { pageNumber: pg.pageNumber, blockId: blk.id });
        }
      }

      if (flatBlocks.length > 0) {
        const { translations: translatedFlat, failedIds } = await translateBlocksFast(
          flatBlocks,
          targetLang,
          Boolean(preserveTerms),
          safeCustomTerms,
          2,
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

  // Smart Technical Book & Diagram AI Translator (Gemini 4 Hydrogen — Server-Side)
  app.post('/api/translate-ai', async (req, res) => {
    try {
      const ai = getGeminiClient();
      if (!ai) {
        return res.status(503).json({
          error:
            'Smart AI mode requires GEMINI_API_KEY in Settings > Secrets. Switch to Free Open Engine for zero-cost translation.',
        });
      }

      const {
        blocks,
        targetLang,
        preserveTerms = true,
        customTerms = [],
        pageImageBase64,
        bookTitle = 'Technical Guidebook',
        pageNumber = 1,
      } = req.body ?? {};

      if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > 80) {
        return res.status(400).json({ error: 'Invalid blocks array (expected 1-80 blocks).' });
      }
      if (typeof targetLang !== 'string' || !ALLOWED_LANGS[targetLang]) {
        return res.status(400).json({ error: 'Unsupported target language.' });
      }

      const langName = ALLOWED_LANGS[targetLang].name;
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

      const extraTermsNote =
        Array.isArray(customTerms) && customTerms.length > 0
          ? `Additional terms to keep in English: ${customTerms.slice(0, 40).join(', ')}.`
          : '';

      const systemInstruction = `You are an expert technical book translator and audiobook narrator translating "${String(bookTitle).slice(0, 120)}" (Page ${Number(pageNumber) || 1}).
Follow these exact rules:
1. Accurate & Natural Translation: Translate every block into natural, easy-to-understand ${langName}${targetLang === 'hinglish' ? ' (conversational Hindi written clearly in Latin/English script)' : ''}.
2. Technical Term Preservation: ${preserveTerms ? 'Keep standard technical/software terms (e.g., OBS, Scene, Source, Plugin, Bitrate, NDI, SRT, RTSP, RTMP, Audio Mixer, Hotkeys, Browser Dock, Chroma Key, LUT, NVENC, PTZ, VST, Sidechain, Ducking, Replay Buffer, Studio Mode, T-Bar) in English so technical clarity is preserved.' : 'Translate naturally while keeping proper brand names accurate.'} ${extraTermsNote}
3. Preserve Structure & Hierarchy: Keep Headings concise, preserve bullet points, Pro Tips, Key Takeaways, and table structure cleanly.
4. Audiobook-Ready Formatting: Write smooth, natural flowing sentences without broken mid-sentence line breaks or page-number interruptions so Text-to-Speech sounds like a fluent human audiobook narrator.
5. Image & Diagram Context: If a page screenshot is provided and contains diagrams, screenshots, charts, or UI callouts, add 1-3 concise bracketed explanations in ${langName} inside imageExplanations (e.g. "[Image Explanation: ...]") describing the visible labels and callouts. If the page is text-only with no images/diagrams, return an empty imageExplanations array.`;

      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

      if (typeof pageImageBase64 === 'string' && pageImageBase64.length > 100 && pageImageBase64.length < 8_000_000) {
        const match = pageImageBase64.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
        if (match) {
          parts.push({
            inlineData: {
              mimeType: match[1],
              data: match[2],
            },
          });
        }
      }

      parts.push({
        text: `Translate each JSON block below into ${langName}, returning the exact same "id" for every block:\n${JSON.stringify(safeBlocks)}`,
      });

      const response = await ai.models.generateContent({
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

      const parsed = JSON.parse((response.text ?? '{}').trim()) as {
        items?: Array<{ id: string; translatedText: string }>;
        imageExplanations?: string[];
      };

      const translations: Record<string, string> = {};
      if (Array.isArray(parsed.items)) {
        for (const item of parsed.items) {
          if (item && typeof item.id === 'string' && typeof item.translatedText === 'string') {
            translations[item.id] = item.translatedText.trim();
          }
        }
      }

      return res.json({
        translations,
        imageExplanations: Array.isArray(parsed.imageExplanations)
          ? parsed.imageExplanations.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          : [],
        engine: 'gemini-4-hydrogen',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Smart AI translation failed.';
      return res.status(502).json({ error: message });
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

  // Audiobook Download Synthesis Endpoint (Gemini Studio WAV with automatic Free MP3 fallback)
  app.post('/api/tts', async (req, res) => {
    try {
      const {
        text,
        voiceName = 'Kore',
        voiceStyle,
        languageName = 'Hindi',
        targetLang = 'hi',
      } = req.body ?? {};
      if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Text is required for audio generation.' });
      }

      const clippedText = text.trim().slice(0, 3500);
      const safeLang =
        typeof targetLang === 'string' && ALLOWED_LANGS[targetLang] ? targetLang : 'hi';

      const ai = getGeminiClient();
      if (ai) {
        try {
          const allowedVoices = new Set(['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr']);
          const safeVoice = allowedVoices.has(voiceName) ? voiceName : 'Kore';
          const safeStyle =
            typeof voiceStyle === 'string' && voiceStyle.trim()
              ? voiceStyle.trim().slice(0, 180)
              : 'Clear, warm, natural technical audiobook narrator';

          const response = await ai.models.generateContent({
            model: 'gemini-3.8-flash-lite-tts',
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: clippedText,
                    speechMetadata: {
                      style: `${safeStyle} speaking ${String(languageName).slice(0, 40)} with crisp pronunciation of English technical terms`,
                    },
                  },
                ],
              },
            ],
            config: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: safeVoice },
                },
              },
            },
          });

          const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
          if (base64Audio) {
            const wavBuffer = Buffer.from(base64Audio, 'base64');
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('Content-Length', String(wavBuffer.length));
            res.setHeader('Content-Disposition', 'attachment; filename="audiobook-page.wav"');
            return res.send(wavBuffer);
          }
        } catch {
          // Gracefully fall back to free MP3 synthesis below
        }
      }

      const mp3Buffer = await synthesizeFreeTtsMp3(clippedText, safeLang);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', String(mp3Buffer.length));
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

  if (process.env.NODE_ENV !== 'production') {
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

    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    const publicDir = path.resolve(__dirname, 'public');
    if (fs.existsSync(publicDir)) {
      app.use(express.static(publicDir));
    }
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`BhashaBook server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
