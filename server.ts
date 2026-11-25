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
    es: 'spa',
    fr: 'fre',
    de: 'ger',
    ar: 'ara',
    ur: 'urd',
    bn: 'ben',
  };

  const normalizeLangLabel = (raw: unknown): string => {
    const val = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw ?? '');
    const lower = val.toLowerCase().trim();
    if (!lower) return 'English';
    if (lower.startsWith('en')) return 'English';
    if (lower.startsWith('hi')) return 'Hindi';
    if (lower.startsWith('es') || lower === 'spa') return 'Spanish';
    if (lower.startsWith('fr') || lower === 'fre') return 'French';
    if (lower.startsWith('de') || lower === 'ger') return 'German';
    if (lower.startsWith('ar') || lower === 'ara') return 'Arabic';
    if (lower.startsWith('ur') || lower === 'urd') return 'Urdu';
    if (lower.startsWith('bn') || lower === 'ben') return 'Bengali';
    return val.slice(0, 16);
  };

  // GET /api/books/search — Multi-source free public-domain e-book discovery
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
        typeof req.query.sort === 'string' && ['downloads', 'rating', 'latest'].includes(req.query.sort)
          ? req.query.sort
          : 'downloads';
      const pageNum = Math.max(1, Math.min(10, parseInt(String(req.query.page ?? '1'), 10) || 1));

      const catCfg = CATEGORY_KEYWORDS[category];
      const effectiveQuery = rawQuery || catCfg.queryHint || 'classic literature science programming';

      type SearchBookItem = {
        id: string;
        source: 'internet_archive' | 'open_library' | 'gutenberg';
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

      const fetchJsonWithTimeout = async (url: string, timeoutMs = 8500): Promise<unknown> => {
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

      // 1. Internet Archive Advanced Search (Direct PDF & open-access texts)
      const queryInternetArchive = async (): Promise<SearchBookItem[]> => {
        const safeTerm = effectiveQuery.replace(/[()":\\]/g, ' ').trim();
        const clauses: string[] = ['mediatype:texts', 'format:"Text PDF"'];
        if (safeTerm) {
          clauses.push(`(title:(${safeTerm}) OR creator:(${safeTerm}) OR subject:(${safeTerm}))`);
        }
        if (catCfg.iaSubject) {
          clauses.push(`subject:(${catCfg.iaSubject})`);
        }
        if (lang !== 'all' && LANG_TO_IA[lang]) {
          clauses.push(`language:${LANG_TO_IA[lang]}`);
        }
        const iaSort =
          sort === 'rating'
            ? 'avg_rating desc'
            : sort === 'latest'
            ? 'year desc'
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
        params.set('rows', '12');
        params.set('page', String(pageNum));
        params.set('output', 'json');

        const data = (await fetchJsonWithTimeout(
          `https://archive.org/advancedsearch.php?${params.toString()}`,
          9000
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

      // 2. Open Library Search API (Rich metadata, ratings, page counts, high-res covers & public IA links)
      const queryOpenLibrary = async (): Promise<SearchBookItem[]> => {
        const params = new URLSearchParams();
        params.set('q', rawQuery || catCfg.queryHint || 'programming');
        if (catCfg.olSubject) {
          params.set('subject', catCfg.olSubject);
        }
        if (lang !== 'all' && LANG_TO_IA[lang]) {
          params.set('language', LANG_TO_IA[lang]);
        }
        if (sort === 'rating') params.set('sort', 'rating');
        else if (sort === 'latest') params.set('sort', 'new');
        params.set('limit', '12');
        params.set('page', String(pageNum));
        params.set(
          'fields',
          'key,title,author_name,first_publish_year,cover_i,ia,number_of_pages_median,ratings_average,subject,language,isbn,ebook_access,edition_count'
        );

        const data = (await fetchJsonWithTimeout(
          `https://openlibrary.org/search.json?${params.toString()}`,
          11000
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

        const docs = data?.docs ?? [];
        const items: SearchBookItem[] = [];
        for (const d of docs) {
          if (!d.key || !d.title) continue;
          const isPublicIa = d.ebook_access === 'public' && Array.isArray(d.ia) && d.ia.length > 0;
          const iaId = isPublicIa ? d.ia![0] : undefined;
          const coverUrl = d.cover_i
            ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`
            : iaId
            ? `https://archive.org/services/img/${encodeURIComponent(iaId)}`
            : undefined;

          items.push({
            id: `ol:${d.key}`,
            source: 'open_library',
            identifier: iaId || d.key,
            title: String(d.title).trim(),
            author: Array.isArray(d.author_name) && d.author_name.length > 0
              ? d.author_name.slice(0, 2).join(', ')
              : 'Unknown Author',
            year: typeof d.first_publish_year === 'number' ? d.first_publish_year : undefined,
            language: normalizeLangLabel(d.language),
            pageCount: typeof d.number_of_pages_median === 'number' ? d.number_of_pages_median : undefined,
            downloads: typeof d.edition_count === 'number' ? d.edition_count * 120 : undefined,
            rating:
              typeof d.ratings_average === 'number' && d.ratings_average > 0
                ? Math.round(d.ratings_average * 10) / 10
                : undefined,
            subjects: Array.isArray(d.subject) ? d.subject.slice(0, 5) : [],
            coverUrl,
            pdfUrl: iaId
              ? `https://archive.org/download/${encodeURIComponent(iaId)}/${encodeURIComponent(iaId)}.pdf`
              : undefined,
            readOnlineUrl: iaId
              ? `https://archive.org/details/${encodeURIComponent(iaId)}`
              : `https://openlibrary.org${d.key}`,
            format: iaId ? 'PDF' : 'Read Online',
            isbn: Array.isArray(d.isbn) ? d.isbn[0] : undefined,
          });
        }
        return items;
      };

      // 3. Gutendex / Project Gutenberg API (with fast fallback to Archive's official Project Gutenberg mirror)
      const queryGutendex = async (): Promise<SearchBookItem[]> => {
        const params = new URLSearchParams();
        if (rawQuery) {
          params.set('search', rawQuery);
        }
        if (catCfg.gutenTopic) {
          params.set('topic', catCfg.gutenTopic);
        }
        if (lang !== 'all') {
          params.set('languages', lang);
        }
        params.set('page', String(pageNum));

        const data = (await fetchJsonWithTimeout(
          `https://gutendex.com/books?${params.toString()}`,
          4200
        )) as {
          results?: Array<{
            id?: number;
            title?: string;
            authors?: Array<{ name?: string; birth_year?: number; death_year?: number }>;
            subjects?: string[];
            bookshelves?: string[];
            languages?: string[];
            download_count?: number;
            summaries?: string[];
            formats?: Record<string, string>;
          }>;
        } | null;

        const results = data?.results ?? [];
        const items: SearchBookItem[] = [];
        for (const b of results.slice(0, 12)) {
          if (!b.id || !b.title) continue;
          const formats = b.formats ?? {};
          const textUrl =
            formats['text/plain; charset=utf-8'] ||
            formats['text/plain; charset=us-ascii'] ||
            formats['text/plain'] ||
            undefined;
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

        if (items.length > 0) return items;

        // Fast resilient fallback: Internet Archive's official Project Gutenberg mirror
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
        gParams.append('sort[]', 'downloads desc');
        gParams.set('rows', '8');
        gParams.set('page', String(pageNum));
        gParams.set('output', 'json');

        const mirror = (await fetchJsonWithTimeout(
          `https://archive.org/advancedsearch.php?${gParams.toString()}`,
          5000
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

      const [iaResults, olResults, gutenResults] = await Promise.all([
        queryInternetArchive(),
        queryOpenLibrary(),
        queryGutendex(),
      ]);

      // Merge & deduplicate by normalized title+author, preferring items with direct PDF or Text URLs
      const mergedMap = new Map<string, SearchBookItem>();
      const allRaw = [...gutenResults, ...iaResults, ...olResults];

      for (const item of allRaw) {
        const key = `${item.title.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 36)}::${item.author
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '')
          .slice(0, 18)}`;
        const existing = mergedMap.get(key);
        if (!existing) {
          mergedMap.set(key, item);
        } else {
          // Prefer whichever entry has direct downloadable PDF or plain text
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

      let combined = Array.from(mergedMap.values());

      // Apply format filter
      if (format === 'pdf') {
        combined = combined.filter((b) => Boolean(b.pdfUrl));
      } else if (format === 'text') {
        combined = combined.filter((b) => Boolean(b.textUrl || b.epubUrl));
      } else if (format === 'online') {
        combined = combined.filter((b) => Boolean(b.pdfUrl || b.textUrl || b.readOnlineUrl));
      }

      // Sort merged catalog
      combined.sort((a, b) => {
        if (sort === 'rating') {
          return (b.rating ?? 0) - (a.rating ?? 0) || (b.downloads ?? 0) - (a.downloads ?? 0);
        }
        if (sort === 'latest') {
          return (b.year ?? 0) - (a.year ?? 0) || (b.downloads ?? 0) - (a.downloads ?? 0);
        }
        // Prioritize immediately readable PDF/Text items alongside download volume
        const aReadable = a.pdfUrl || a.textUrl ? 1 : 0;
        const bReadable = b.pdfUrl || b.textUrl ? 1 : 0;
        if (aReadable !== bReadable) return bReadable - aReadable;
        return (b.downloads ?? 0) - (a.downloads ?? 0);
      });

      return res.json({
        query: rawQuery,
        page: pageNum,
        total: combined.length,
        sources: {
          internetArchive: iaResults.length,
          openLibrary: olResults.length,
          gutenberg: gutenResults.length,
        },
        books: combined.slice(0, 30),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Book search failed.';
      return res.status(502).json({ error: message });
    }
  });

  // GET /api/books/resolve — Resolve exact downloadable PDF/Text file & metadata for an Internet Archive identifier
  app.get('/api/books/resolve', async (req, res) => {
    try {
      const identifier = typeof req.query.identifier === 'string' ? req.query.identifier.trim() : '';
      if (!identifier || !/^[A-Za-z0-9._-]{1,160}$/.test(identifier)) {
        return res.status(400).json({ error: 'Invalid book identifier.' });
      }

      const { response } = await safeFetchAllowlisted(
        `https://archive.org/metadata/${encodeURIComponent(identifier)}`,
        { timeoutMs: 12000, accept: 'application/json' }
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

      // Prefer standard Text PDF / PDF under 45 MB
      const pdfCandidates = publicFiles
        .filter((f) => /\.pdf$/i.test(f.name!) && !/encrypted/i.test(f.format ?? ''))
        .sort((a, b) => {
          const aScore =
            (/text pdf/i.test(a.format ?? '') ? 10 : 0) +
            (!/_bw\.pdf$/i.test(a.name!) ? 5 : 0) +
            (Number(a.size ?? 0) > 0 && Number(a.size ?? 0) < 42_000_000 ? 4 : -10);
          const bScore =
            (/text pdf/i.test(b.format ?? '') ? 10 : 0) +
            (!/_bw\.pdf$/i.test(b.name!) ? 5 : 0) +
            (Number(b.size ?? 0) > 0 && Number(b.size ?? 0) < 42_000_000 ? 4 : -10);
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

      return res.json({
        identifier,
        pdfUrl,
        pdfSize: bestPdf ? Number(bestPdf.size ?? 0) : undefined,
        textUrl,
        pageCount: meta.metadata?.imagecount ? Number(meta.metadata.imagecount) : undefined,
        description: rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 900) || undefined,
      });
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
      const MAX_PDF_BYTES = 48 * 1024 * 1024;
      if (contentLen > MAX_PDF_BYTES) {
        return res.status(413).json({ error: 'PDF exceeds 48 MB browser streaming limit.' });
      }

      const arrBuf = await response.arrayBuffer();
      if (arrBuf.byteLength > MAX_PDF_BYTES) {
        return res.status(413).json({ error: 'PDF exceeds 48 MB browser streaming limit.' });
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
      const { chapterTitle, text, targetLang = 'en' } = req.body ?? {};
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

      // 1. Optional Gemini AI structured summary when API key is configured
      const ai = getGeminiClient();
      if (ai) {
        try {
          const prompt = `Summarize the following book chapter titled "${safeTitle}" for a student/reader in ${langMeta.name}.
Return strict JSON with:
- "summary": concise 2-3 sentence overview in ${langMeta.name}
- "keyTakeaways": 4 to 6 crisp, actionable bullet-point takeaways in ${langMeta.name}
- "keyTerms": 4 to 6 important concepts/terms mentioned in the chapter.

Chapter text:
${clipped.slice(0, 14000)}`;

          const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: prompt,
            config: {
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

          const parsed = JSON.parse(response.text || '{}') as {
            summary?: string;
            keyTakeaways?: string[];
            keyTerms?: string[];
          };
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
      if (targetLang !== 'en' && asciiRatio > 0.45) {
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
