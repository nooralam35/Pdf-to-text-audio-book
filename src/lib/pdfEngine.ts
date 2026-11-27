import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/types/src/display/api';
import type {
  ChapterItem,
  ExtractedFigure,
  OcrScriptMode,
  ParsedPage,
  TextBlock,
} from '../types';
import {
  OCR_SCRIPT_OPTIONS,
  detectTextLanguageCode,
  getLanguageOption,
  hasNonLatinScript,
  isTextPredominantlyRtl,
} from './languages';

// Configure PDF.js worker using Vite asset URL resolution
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

export type LoadedPdf = PDFDocumentProxy;

const PDF_DOCUMENT_OPTIONS = {
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  wasmUrl: '/pdfjs/wasm/',
  iccUrl: '/pdfjs/iccs/',
  useSystemFonts: false,
  verbosity: pdfjsLib.VerbosityLevel.ERRORS,
} as const;

// Serialize graphics/render operations per (document, pageNumber) so concurrent
// PdfViewerPane canvas renders and extractPageContent operator-list/figure crops
// never race PDF.js internal page.objs image XObject decoding.
const pageRenderLocks = new WeakMap<PDFDocumentProxy, Map<number, Promise<void>>>();

async function withPageRenderLock<T>(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  task: () => Promise<T>
): Promise<T> {
  let docMap = pageRenderLocks.get(pdf);
  if (!docMap) {
    docMap = new Map<number, Promise<void>>();
    pageRenderLocks.set(pdf, docMap);
  }
  const previous = docMap.get(pageNumber) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  docMap.set(pageNumber, chained);

  await previous;
  try {
    return await task();
  } finally {
    release();
    if (docMap.get(pageNumber) === chained) {
      docMap.delete(pageNumber);
    }
  }
}

export async function loadPdfFromUrl(url: string): Promise<PDFDocumentProxy> {
  const loadingTask = pdfjsLib.getDocument({
    url,
    ...PDF_DOCUMENT_OPTIONS,
  });
  return loadingTask.promise;
}

export async function loadPdfFromBuffer(buffer: ArrayBuffer): Promise<PDFDocumentProxy> {
  // Clone buffer because PDF.js transfers ownership to its web worker
  const copy = buffer.slice(0);
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(copy),
    ...PDF_DOCUMENT_OPTIONS,
  });
  return loadingTask.promise;
}

export function renderPdfPageToCanvas(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale = 1.5
): { promise: Promise<{ width: number; height: number }>; cancel: () => void } {
  let renderTask: RenderTask | null = null;
  let cancelled = false;

  const promise = (async () => {
    if (cancelled) return { width: 0, height: 0 };

    return withPageRenderLock(pdf, pageNumber, async () => {
      if (cancelled) return { width: 0, height: 0 };

      const page = await pdf.getPage(pageNumber);
      if (cancelled) return { width: 0, height: 0 };

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale });
      const renderViewport = page.getViewport({ scale: scale * dpr });

      canvas.width = Math.floor(renderViewport.width);
      canvas.height = Math.floor(renderViewport.height);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable');

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      renderTask = page.render({
        canvasContext: ctx,
        viewport: renderViewport,
        canvas,
      });
      await renderTask.promise;
      return { width: viewport.width, height: viewport.height };
    });
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
      try {
        renderTask?.cancel();
      } catch {
        // Ignore cancellation race
      }
    },
  };
}

export async function renderPageToDataUrl(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  scale = 2.0,
  mimeType: 'image/png' | 'image/jpeg' = 'image/jpeg',
  quality = 0.92
): Promise<{ dataUrl: string; width: number; height: number }> {
  return withPageRenderLock(pdf, pageNumber, async () => {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not initialize offscreen canvas');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: ctx,
      viewport,
      canvas,
    }).promise;

    const dataUrl =
      mimeType === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', quality);
    return {
      dataUrl,
      width: canvas.width,
      height: canvas.height,
    };
  });
}

// Matrix multiplication for PDF 2D affine transforms [a, b, c, d, e, f]
function multiplyMatrix(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function applyTransform(m: number[], x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function mergeOverlappingBoxes(boxes: BBox[], marginX: number, marginY: number): BBox[] {
  if (boxes.length === 0) return [];
  const sorted = [...boxes].sort((a, b) => a.y0 - b.y0);
  const merged: BBox[] = [];

  for (const box of sorted) {
    let didMerge = false;
    for (const existing of merged) {
      const horizOverlap =
        box.x0 <= existing.x1 + marginX && box.x1 >= existing.x0 - marginX;
      const vertOverlap =
        box.y0 <= existing.y1 + marginY && box.y1 >= existing.y0 - marginY;
      if (horizOverlap && vertOverlap) {
        existing.x0 = Math.min(existing.x0, box.x0);
        existing.y0 = Math.min(existing.y0, box.y0);
        existing.x1 = Math.max(existing.x1, box.x1);
        existing.y1 = Math.max(existing.y1, box.y1);
        didMerge = true;
        break;
      }
    }
    if (!didMerge) {
      merged.push({ ...box });
    }
  }
  return merged;
}

interface RawLine {
  y: number; // PDF top-down coordinate (0 = top)
  x: number;
  text: string;
  fontSize: number;
  isBold: boolean;
}

export async function extractPageContent(
  pdf: PDFDocumentProxy,
  pageNumber: number
): Promise<ParsedPage> {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1.0 });
  const pageWidth = viewport.width;
  const pageHeight = viewport.height;

  // 1. Extract embedded images/screenshots/diagrams via Operator List CTM tracking
  const rawImageBoxes: BBox[] = [];
  try {
    const opList = await withPageRenderLock(pdf, pageNumber, () => page.getOperatorList());
    const OPS = pdfjsLib.OPS;
    const stack: number[][] = [];
    let ctm = [1, 0, 0, 1, 0, 0];

    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i];

      if (fn === OPS.save) {
        stack.push([...ctm]);
      } else if (fn === OPS.restore) {
        ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      } else if (fn === OPS.transform && Array.isArray(args) && args.length === 6) {
        ctm = multiplyMatrix(ctm, args as number[]);
      } else if (
        fn === OPS.paintImageXObject ||
        fn === OPS.paintInlineImageXObject ||
        fn === OPS.paintImageXObjectRepeat
      ) {
        const corners: Array<[number, number]> = [
          applyTransform(ctm, 0, 0),
          applyTransform(ctm, 1, 0),
          applyTransform(ctm, 0, 1),
          applyTransform(ctm, 1, 1),
        ];
        // Convert PDF bottom-up coords to top-down viewport coords
        const xs = corners.map((c) => c[0]);
        const ys = corners.map((c) => pageHeight - c[1]);
        const x0 = Math.max(0, Math.min(...xs));
        const x1 = Math.min(pageWidth, Math.max(...xs));
        const y0 = Math.max(0, Math.min(...ys));
        const y1 = Math.min(pageHeight, Math.max(...ys));
        const w = x1 - x0;
        const h = y1 - y0;

        // Filter out tiny icons, decorative 1px borders, or full-page white masks
        if (w >= pageWidth * 0.16 && h >= pageHeight * 0.06 && !(w > pageWidth * 0.98 && h > pageHeight * 0.98)) {
          rawImageBoxes.push({ x0, y0, x1, y1 });
        }
      }
    }
  } catch {
    // Graceful fallback if operator list inspection fails on a malformed page
  }

  // Merge nearby/side-by-side images that belong to the same diagram frame
  const mergedImgBoxes = mergeOverlappingBoxes(
    rawImageBoxes,
    pageWidth * 0.12,
    pageHeight * 0.05
  );

  // 2. Extract structured text items with coordinates & font metrics
  const textContent = await page.getTextContent();
  const styles = textContent.styles as Record<string, { fontFamily?: string }>;

  interface PositionedWord {
    x: number;
    y: number; // top-down
    width: number;
    height: number;
    str: string;
    fontSize: number;
    isBold: boolean;
  }

  const words: PositionedWord[] = [];
  for (const item of textContent.items) {
    if (!('str' in item)) continue;
    const str = item.str.normalize('NFKC');
    if (!str || !str.trim()) continue;
    const tx = item.transform;
    const fontSize = Math.hypot(tx[0], tx[1]) || item.height || 11;
    const x = tx[4];
    const y = pageHeight - tx[5]; // top-down baseline
    const fontName = `${item.fontName ?? ''} ${styles[item.fontName]?.fontFamily ?? ''}`.toLowerCase();
    const isBold = fontName.includes('bold') || fontName.includes('black') || fontName.includes('heavy');

    words.push({
      x,
      y,
      width: item.width || fontSize * str.length * 0.5,
      height: item.height || fontSize,
      str,
      fontSize,
      isBold,
    });
  }

  // Group words into baseline visual line buckets first, then order LTR or RTL cleanly inside each bucket
  words.sort((a, b) => a.y - b.y || a.x - b.x);

  const lineBuckets: PositionedWord[][] = [];
  for (const w of words) {
    const lastBucket = lineBuckets[lineBuckets.length - 1];
    if (
      lastBucket &&
      Math.abs(lastBucket[0].y - w.y) <= Math.max(4, Math.max(lastBucket[0].fontSize, w.fontSize) * 0.45)
    ) {
      lastBucket.push(w);
    } else {
      lineBuckets.push([w]);
    }
  }

  const COMBINING_START_RE = /^[\p{M}\u200C\u200D\u094D\u09CD\u0A4D\u0ACD\u0B4D\u0BCD\u0C4D\u0D4D]/u;
  const VIRAMA_END_RE = /[\u200C\u200D\u094D\u09CD\u0A4D\u0ACD\u0B4D\u0BCD\u0C4D\u0D4D]$/;

  const lines: RawLine[] = [];
  for (const bucket of lineBuckets) {
    const bucketPreview = bucket.map((b) => b.str).join(' ');
    const rtlLine = isTextPredominantlyRtl(bucketPreview);
    bucket.sort((a, b) => (rtlLine ? b.x - a.x : a.x - b.x));

    let text = '';
    let maxFontSize = bucket[0]?.fontSize ?? 11;
    let isBold = false;
    let prev = bucket[0];

    for (let i = 0; i < bucket.length; i++) {
      const w = bucket[i];
      maxFontSize = Math.max(maxFontSize, w.fontSize);
      isBold = isBold || w.isBold;
      if (i === 0) {
        text = w.str;
      } else {
        const gap = rtlLine
          ? prev.x - (w.x + w.width)
          : w.x - (prev.x + prev.width);
        const isCombiningJoin =
          COMBINING_START_RE.test(w.str) || VIRAMA_END_RE.test(text);
        const needsSpace =
          !isCombiningJoin &&
          !text.endsWith(' ') &&
          !w.str.startsWith(' ') &&
          gap > Math.max(1.2, w.fontSize * 0.14);
        text += (needsSpace ? ' ' : '') + w.str;
      }
      prev = w;
    }

    const leftX = Math.min(...bucket.map((b) => b.x));
    const avgY = bucket.reduce((acc, b) => acc + b.y, 0) / bucket.length;
    lines.push({
      y: avgY,
      x: leftX,
      text,
      fontSize: maxFontSize,
      isBold,
    });
  }

  // Filter out running book headers at very top & standalone page numbers at very bottom
  // AND filter out text labels that sit *inside* extracted diagram boxes (so we don't duplicate screenshot labels)
  const cleanedLines = lines.filter((line) => {
    const trimmed = line.text.replace(/\s+/g, ' ').trim();
    if (!trimmed) return false;

    const yPct = (line.y / pageHeight) * 100;
    // Top running header (e.g., "OBS Super User Guidebook")
    if (yPct < 8.5 && trimmed.length < 48 && pageNumber > 4) {
      return false;
    }
    // Bottom standalone page number (e.g., "14", "187")
    if (yPct > 89.5 && /^\d{1,4}$/.test(trimmed)) {
      return false;
    }

    // Check if text sits strictly inside an extracted image/screenshot bounding box
    const insideFigure = mergedImgBoxes.some(
      (box) =>
        line.y >= box.y0 + 4 &&
        line.y <= box.y1 - 4 &&
        line.x >= box.x0 - 8 &&
        line.x <= box.x1 + 8
    );
    if (insideFigure) return false;

    return true;
  });

  // Compute median body font size for hierarchy classification
  const fontSizes = cleanedLines.map((l) => l.fontSize).sort((a, b) => a - b);
  const bodySize = fontSizes.length > 0 ? fontSizes[Math.floor(fontSizes.length * 0.5)] : 11;

  // Merge lines into coherent audiobook-ready paragraphs, headings, bullets, and callouts
  const blocks: TextBlock[] = [];
  let blockCounter = 0;

  const isBulletStart = (s: string) =>
    /^(?:[●•○■▪▸►\-–—*]|\d{1,2}\.)\s+/.test(s) || /^o\s+[A-Z]/.test(s);

  const isCalloutStart = (s: string) =>
    /^(?:Pro Tip|Note|Key Takeaways|Warning|Tip|Example Use|Pros and Cons|Alternatives)/i.test(s);

  for (let i = 0; i < cleanedLines.length; i++) {
    const line = cleanedLines[i];
    const text = line.text.replace(/\s+/g, ' ').trim();
    const prevLine = cleanedLines[i - 1];
    const lineGap = prevLine ? line.y - prevLine.y : 0;
    const expectedLineStep = Math.max(line.fontSize * 1.45, bodySize * 1.45);

    // Check if an extracted figure sits vertically between prevLine and this line
    const figureBetween =
      prevLine &&
      mergedImgBoxes.some((box) => box.y0 > prevLine.y - 4 && box.y1 < line.y + 4);

    const isMajorHeading =
      line.fontSize >= bodySize * 1.25 ||
      (/^\d{1,2}\s+[A-Z0-9\s®:.-]{4,}$/.test(text) && text.length < 75) ||
      (/^[A-Z][A-Z\s]{4,}$/.test(text) && text.length < 60 && lineGap > expectedLineStep * 1.1);

    const isSubheading =
      !isMajorHeading &&
      ((line.isBold && text.length < 85 && !text.endsWith('.')) ||
        /^OBS\s+v\d+/i.test(text) ||
        /^Key Takeaways:?$/i.test(text));

    const startsNewBlock =
      blocks.length === 0 ||
      figureBetween ||
      isMajorHeading ||
      isSubheading ||
      isBulletStart(text) ||
      isCalloutStart(text) ||
      lineGap > expectedLineStep * 1.38;

    const lastBlock = blocks[blocks.length - 1];

    if (
      !startsNewBlock &&
      lastBlock &&
      (lastBlock.kind === 'paragraph' || lastBlock.kind === 'bullet' || lastBlock.kind === 'callout')
    ) {
      // Join smoothly without hyphenation breaks
      if (lastBlock.text.endsWith('-') && !lastBlock.text.endsWith(' -')) {
        lastBlock.text = lastBlock.text.slice(0, -1) + text;
      } else {
        lastBlock.text = `${lastBlock.text} ${text}`;
      }
    } else if (
      lastBlock &&
      lastBlock.kind === 'heading' &&
      isMajorHeading &&
      lineGap <= expectedLineStep * 1.45 &&
      !figureBetween
    ) {
      // Two-line chapter heading (e.g. "29 CHOOSING A COMPUTER AND ADDITIONAL" + "HARDWARE FOR OBS")
      lastBlock.text = `${lastBlock.text} ${text}`;
    } else {
      let kind: TextBlock['kind'] = 'paragraph';
      if (isMajorHeading) kind = 'heading';
      else if (isCalloutStart(text)) kind = 'callout';
      else if (isBulletStart(text)) kind = 'bullet';
      else if (isSubheading) kind = 'subheading';

      blocks.push({
        id: `p${pageNumber}-b${++blockCounter}`,
        kind,
        text,
        yPercent: Math.max(0, Math.min(100, (line.y / pageHeight) * 100)),
        fontSize: line.fontSize,
      });
    }
  }

  // 3. Crop high-resolution extracted screenshots/diagrams from rendered page canvas
  const figures: ExtractedFigure[] = [];
  if (mergedImgBoxes.length > 0 && pageNumber > 1) {
    try {
      const renderScale = 2.0;
      const hiViewport = page.getViewport({ scale: renderScale });
      const offCanvas = document.createElement('canvas');
      offCanvas.width = Math.floor(hiViewport.width);
      offCanvas.height = Math.floor(hiViewport.height);
      const offCtx = offCanvas.getContext('2d');

      if (offCtx) {
        offCtx.fillStyle = '#ffffff';
        offCtx.fillRect(0, 0, offCanvas.width, offCanvas.height);
        await withPageRenderLock(pdf, pageNumber, async () => {
          await page.render({ canvasContext: offCtx, viewport: hiViewport, canvas: offCanvas }).promise;
        });

        mergedImgBoxes.forEach((box, idx) => {
          // Slight padding around diagrams to capture callout borders cleanly
          const padX = Math.min(12, pageWidth * 0.03);
          const padY = Math.min(10, pageHeight * 0.015);
          const sx = Math.max(0, Math.floor((box.x0 - padX) * renderScale));
          const sy = Math.max(0, Math.floor((box.y0 - padY) * renderScale));
          const sw = Math.min(
            offCanvas.width - sx,
            Math.ceil((box.x1 - box.x0 + padX * 2) * renderScale)
          );
          const sh = Math.min(
            offCanvas.height - sy,
            Math.ceil((box.y1 - box.y0 + padY * 2) * renderScale)
          );

          if (sw > 60 && sh > 40) {
            const cropCanvas = document.createElement('canvas');
            cropCanvas.width = sw;
            cropCanvas.height = sh;
            const cropCtx = cropCanvas.getContext('2d');
            if (cropCtx) {
              cropCtx.drawImage(offCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
              figures.push({
                id: `p${pageNumber}-fig${idx + 1}`,
                dataUrl: cropCanvas.toDataURL('image/png'),
                yPercent: Math.max(0, Math.min(100, (box.y0 / pageHeight) * 100)),
                widthRatio: (box.x1 - box.x0) / pageWidth,
                heightRatio: (box.y1 - box.y0) / pageHeight,
                aspectRatio: sw / sh,
              });
            }
          }
        });
      }
    } catch {
      // Ignore figure cropping failures on exotic PDFs
    }
  }

  const combinedText = blocks.map((b) => b.text).join(' ');
  const looksGarbled = detectGarbledBlocks(blocks);
  const scriptDirection: 'ltr' | 'rtl' = isTextPredominantlyRtl(combinedText) ? 'rtl' : 'ltr';
  const detectedLangCode = detectTextLanguageCode(combinedText);
  const detectedLang = getLanguageOption(detectedLangCode).name;

  return {
    pageNumber,
    width: pageWidth,
    height: pageHeight,
    blocks,
    figures,
    isBlank: blocks.length === 0 && figures.length === 0,
    looksGarbled,
    scriptDirection,
    detectedLang,
  };
}

/**
 * Detects legacy non-Unicode custom font encodings (KrutiDev, Chanakya, Walkman, broken CMaps)
 * or scrambled Tesseract/PDF mojibake so the reader can auto-recover clean Unicode text.
 */
export function detectGarbledBlocks(blocks: TextBlock[]): boolean {
  if (!blocks || blocks.length === 0) return false;
  const fullText = blocks.map((b) => b.text).join(' ').replace(/\s+/g, ' ').trim();
  if (!fullText) return false;

  const nonSpace = fullText.replace(/\s+/g, '');
  if (nonSpace.length < 12) return false;

  // 1. Replacement chars or Private-Use-Area glyphs almost always mean broken font ToUnicode CMap
  const brokenGlyphs = (fullText.match(/[\uFFFD\uE000-\uF8FF]/g) ?? []).length;
  if (brokenGlyphs >= 3 || brokenGlyphs / nonSpace.length > 0.025) {
    return true;
  }

  // 2. Stray control/symbol noise characters common in mojibake / bad English-only OCR of Indic/RTL pages
  const weirdSymbols = (
    fullText.match(/[~`|^\\<>@#$%*=+_{}[\]©®°±×÷¤¦¨ª«¬¯²³´µ¶¸¹º»¿ØÞƒ†‡]/g) ?? []
  ).length;
  if (weirdSymbols / nonSpace.length > 0.055) {
    return true;
  }

  // 3. Classic legacy Indian non-Unicode ASCII font encoding markers (KrutiDev / Chanakya / Shusha)
  if (!hasNonLatinScript(fullText)) {
    const legacyIndicMatches =
      fullText.match(
        /\b(?:vkSj|dks|gSa|gS|esa|dh|fd|ls|ij|bl|dk|ds|ugha|rFkk|iz|v\/;|\w+[\[\]{};\\]+\w+)\b/g
      ) ?? [];
    if (legacyIndicMatches.length >= 3) {
      return true;
    }
    // Excessive mixed-case inside lowercase ASCII words or digits embedded inside words
    const tokens = fullText.split(/\s+/).filter(Boolean);
    if (tokens.length >= 6) {
      const suspiciousTokens = tokens.filter(
        (t) =>
          (t.length >= 3 && /[a-z][A-Z]|[;'\[\]{}~`]/.test(t)) ||
          /^[.,:;!?~`|><\-_=+]+$/.test(t)
      ).length;
      if (suspiciousTokens / tokens.length > 0.34) {
        return true;
      }
    }
  }

  // 4. Severe line fragmentation: too many tiny symbol/1-2 char garbage blocks
  if (blocks.length >= 5) {
    const tinyGarbageBlocks = blocks.filter((b) => {
      const t = b.text.trim();
      const letters = t.replace(/[\s\p{P}\p{S}\d]/gu, '');
      return t.length <= 4 && letters.length <= 2;
    }).length;
    if (tinyGarbageBlocks / blocks.length > 0.45) {
      return true;
    }
  }

  return false;
}

// Auto-detect book chapters from PDF Outline OR Table of Contents pages
export async function detectChapters(pdf: PDFDocumentProxy): Promise<{
  chapters: ChapterItem[];
  detectedTitle?: string;
  detectedAuthor?: string;
}> {
  const numPages = pdf.numPages;

  // Attempt to grab title/author from Page 1 text or PDF metadata
  let detectedTitle: string | undefined;
  let detectedAuthor: string | undefined;
  try {
    const meta = await pdf.getMetadata();
    const info = meta.info as Record<string, unknown> | undefined;
    if (typeof info?.Title === 'string' && info.Title.trim().length > 2) {
      detectedTitle = info.Title.trim();
    }
    if (typeof info?.Author === 'string' && info.Author.trim().length > 2) {
      detectedAuthor = info.Author.trim();
    }
  } catch {
    // ignore metadata error
  }

  try {
    const p1 = await pdf.getPage(1);
    const p1Text = await p1.getTextContent();
    const lines = p1Text.items
      .map((it) => ('str' in it ? it.str.trim() : ''))
      .filter(Boolean);
    if (!detectedTitle && lines.length > 0) {
      detectedTitle = lines.slice(0, 3).join(' ').replace(/:$/, '').trim();
    }
    if (!detectedAuthor && lines.length >= 3) {
      const last = lines[lines.length - 1];
      if (last.length > 3 && last.length < 40) {
        detectedAuthor = last;
      }
    }
  } catch {
    // ignore
  }

  // Strategy 1: Native PDF Outline (Bookmarks)
  try {
    const outline = await pdf.getOutline();
    if (outline && outline.length >= 2) {
      const rawItems: Array<{ title: string; startPage: number }> = [];
      for (const item of outline) {
        let dest = item.dest;
        if (typeof dest === 'string') {
          dest = await pdf.getDestination(dest);
        }
        if (Array.isArray(dest) && dest[0]) {
          try {
            const pageIdx = await pdf.getPageIndex(dest[0]);
            rawItems.push({
              title: item.title.trim(),
              startPage: pageIdx + 1,
            });
          } catch {
            // skip unresolved bookmark
          }
        }
      }
      if (rawItems.length >= 2) {
        rawItems.sort((a, b) => a.startPage - b.startPage);
        const chapters: ChapterItem[] = rawItems.map((it, idx) => ({
          id: `ch-outline-${idx}`,
          index: idx + 1,
          title: it.title,
          startPage: it.startPage,
          endPage:
            idx + 1 < rawItems.length
              ? Math.max(it.startPage, rawItems[idx + 1].startPage - 1)
              : numPages,
        }));
        return { chapters, detectedTitle, detectedAuthor };
      }
    }
  } catch {
    // Fallback to TOC parser
  }

  // Strategy 2: Parse Table of Contents from early pages (Pages 2..10)
  const tocEntries: Array<{ num: number; title: string; bookPage: number }> = [];
  const scanLimit = Math.min(numPages, 10);

  for (let p = 2; p <= scanLimit; p++) {
    try {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const viewport = page.getViewport({ scale: 1.0 });

      // Rebuild lines sorted by Y
      const items = tc.items
        .filter((it): it is typeof it & { str: string; transform: number[] } => 'str' in it && Boolean(it.str.trim()))
        .map((it) => ({
          x: it.transform[4],
          y: viewport.height - it.transform[5],
          str: it.str.trim(),
        }))
        .sort((a, b) => (Math.abs(a.y - b.y) < 4 ? a.x - b.x : a.y - b.y));

      const lineStrings: string[] = [];
      let curY = -100;
      let curLine = '';
      for (const it of items) {
        if (Math.abs(it.y - curY) <= 5) {
          curLine += ' ' + it.str;
        } else {
          if (curLine.trim()) lineStrings.push(curLine.trim());
          curLine = it.str;
          curY = it.y;
        }
      }
      if (curLine.trim()) lineStrings.push(curLine.trim());

      for (const line of lineStrings) {
        // Matches e.g. "1 An update on the updates Pg 1" or "12 Replay Source ... 78"
        const match = line.match(/^(\d{1,2})\s+(.+?)\s+(?:Pg\.?\s*|p\.?\s*|\.{2,}\s*)(\d{1,4})$/i);
        if (match) {
          const chNum = parseInt(match[1], 10);
          const title = match[2].replace(/\.{2,}$/, '').trim();
          const bookPage = parseInt(match[3], 10);
          if (title.length >= 3 && bookPage >= 1 && bookPage <= numPages) {
            tocEntries.push({ num: chNum, title, bookPage });
          }
        }
      }
    } catch {
      // ignore page error
    }
  }

  if (tocEntries.length >= 3) {
    // Auto-detect offset between printed "Pg 1" and actual PDF page index
    let pageOffset = 0;
    const firstCh = tocEntries[0];
    const searchStart = Math.max(2, firstCh.bookPage);
    const searchEnd = Math.min(numPages, firstCh.bookPage + 20);
    const titleNeedle = firstCh.title.toLowerCase().slice(0, 14);

    for (let p = searchStart; p <= searchEnd; p++) {
      try {
        const pg = await pdf.getPage(p);
        const tc = await pg.getTextContent();
        const combined = tc.items
          .map((it) => ('str' in it ? it.str : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .toLowerCase();
        // Skip TOC pages themselves
        if (combined.includes('contents') && combined.includes('pg 1')) continue;
        if (combined.includes(titleNeedle)) {
          pageOffset = p - firstCh.bookPage;
          break;
        }
      } catch {
        // continue
      }
    }

    const chapters: ChapterItem[] = [];
    const firstPdfStart = Math.max(1, firstCh.bookPage + pageOffset);
    if (firstPdfStart > 1) {
      chapters.push({
        id: 'ch-front-matter',
        index: 0,
        title: 'Cover, Contents & Front Matter',
        startPage: 1,
        endPage: firstPdfStart - 1,
        bookPageLabel: 'Front',
      });
    }

    for (let i = 0; i < tocEntries.length; i++) {
      const entry = tocEntries[i];
      const startPage = Math.min(numPages, Math.max(1, entry.bookPage + pageOffset));
      const nextStart =
        i + 1 < tocEntries.length
          ? Math.min(numPages, Math.max(startPage, tocEntries[i + 1].bookPage + pageOffset))
          : numPages + 1;
      chapters.push({
        id: `ch-toc-${entry.num}-${i}`,
        index: entry.num,
        title: entry.title,
        startPage,
        endPage: Math.max(startPage, Math.min(numPages, nextStart - 1)),
        bookPageLabel: `Pg ${entry.bookPage}`,
      });
    }

    // Check if there is back matter (e.g. Glossary / About the Author after Conclusion)
    const lastCh = chapters[chapters.length - 1];
    if (lastCh && numPages - lastCh.startPage >= 4) {
      for (let p = lastCh.startPage + 1; p <= numPages; p++) {
        try {
          const pg = await pdf.getPage(p);
          const tc = await pg.getTextContent();
          const text = tc.items.map((it) => ('str' in it ? it.str : '')).join(' ');
          if (/GLOSSARY OF TERMS/i.test(text)) {
            lastCh.endPage = p - 1;
            chapters.push({
              id: 'ch-glossary',
              index: chapters.length,
              title: 'Glossary of Terms & Resources',
              startPage: p,
              endPage: numPages,
              bookPageLabel: `Pg ${p - pageOffset}`,
            });
            break;
          }
        } catch {
          // ignore
        }
      }
    }

    return { chapters, detectedTitle, detectedAuthor };
  }

  // Strategy 3: Chunk any arbitrary PDF cleanly into 10-page reading sections
  const chapters: ChapterItem[] = [];
  const chunkSize = numPages > 40 ? 10 : Math.max(5, Math.ceil(numPages / 4));
  let idx = 1;
  for (let start = 1; start <= numPages; start += chunkSize) {
    const end = Math.min(numPages, start + chunkSize - 1);
    chapters.push({
      id: `ch-sec-${idx}`,
      index: idx,
      title: start === 1 ? 'Cover & Opening Pages' : `Section ${idx} (Pages ${start}–${end})`,
      startPage: start,
      endPage: end,
      bookPageLabel: `P.${start}`,
    });
    idx++;
  }

  return { chapters, detectedTitle, detectedAuthor };
}

export interface OcrProgressUpdate {
  progress: number;
  stage: string;
}

export interface OcrRunOptions {
  scale?: number;
  scriptMode?: OcrScriptMode;
  preferAiVision?: boolean;
}

function cleanOcrFallbackText(rawText: string): string[] {
  return rawText
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((p) => {
      if (p.length <= 1) return false;
      // Drop pure punctuation/symbol noise lines while preserving real words in any Unicode script
      const letters = p.replace(/[\s\p{P}\p{S}]/gu, '');
      return letters.length >= 2;
    });
}

// Universal On-Demand OCR: uses Gemini AI Vision (/api/ocr-page) for near-100% fidelity across
// Sanskrit, Hindi, Marathi, Urdu, Arabic, Bengali, Tamil, Telugu, Gujarati, Punjabi & English,
// with multilingual Tesseract.js fallback for offline reading.
export async function runClientOcrOnPage(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  onProgress?: (update: OcrProgressUpdate) => void,
  options?: OcrRunOptions
): Promise<ParsedPage> {
  const scale = options?.scale ?? 2.0;
  const scriptMode: OcrScriptMode = options?.scriptMode ?? 'auto';
  const preferAiVision = options?.preferAiVision !== false;

  onProgress?.({
    progress: 8,
    stage: scale > 2.1 ? 'Rendering high-DPI page snapshot…' : 'Rendering page snapshot…',
  });

  // Render clean JPEG for fast AI Vision upload (fallback PNG only if needed for Tesseract)
  const { dataUrl: jpegUrl, width, height } = await renderPageToDataUrl(
    pdf,
    pageNumber,
    scale,
    'image/jpeg',
    0.92
  );

  // Path A: Universal Multilingual AI Vision OCR (reads every script verbatim without gibberish)
  if (preferAiVision && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
    try {
      onProgress?.({
        progress: 34,
        stage: 'Reading exact script & layout with AI Vision OCR…',
      });

      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 36000);
      try {
        const res = await fetch('/api/ocr-page', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            imageBase64: jpegUrl,
            pageNumber,
            scriptMode,
          }),
          signal: controller.signal,
        });

        if (res.ok) {
          onProgress?.({ progress: 92, stage: 'Structuring exact extracted text blocks…' });
          const data = (await res.json()) as {
            detectedLang?: string;
            scriptDirection?: 'ltr' | 'rtl';
            blocks?: TextBlock[];
          };

          const aiBlocks = Array.isArray(data.blocks)
            ? data.blocks.filter((b) => b && typeof b.text === 'string' && b.text.trim().length > 0)
            : [];

          onProgress?.({ progress: 100, stage: 'Multilingual OCR extraction ready for review' });
          return {
            pageNumber,
            width: width / scale,
            height: height / scale,
            blocks: aiBlocks,
            figures: [],
            isBlank: aiBlocks.length === 0,
            isOcr: true,
            ocrEngine: 'ai-vision',
            looksGarbled: false,
            detectedLang: data.detectedLang || 'Auto',
            scriptDirection: data.scriptDirection === 'rtl' ? 'rtl' : 'ltr',
          };
        }
      } finally {
        window.clearTimeout(timeoutId);
      }
    } catch {
      // Gracefully fall through to offline multilingual Tesseract OCR
    }
  }

  // Path B: Multilingual Tesseract.js Offline Fallback
  const scriptOpt =
    OCR_SCRIPT_OPTIONS.find((opt) => opt.id === scriptMode) ?? OCR_SCRIPT_OPTIONS[0];
  onProgress?.({
    progress: 18,
    stage: `Loading offline ${scriptOpt.shortLabel} OCR engine…`,
  });

  const Tesseract = await import('tesseract.js');
  const recognizeWithLang = async (langs: string) =>
    Tesseract.recognize(jpegUrl, langs, {
      logger: (m) => {
        const p = typeof m.progress === 'number' ? Math.max(0, Math.min(1, m.progress)) : 0;
        if (m.status === 'loading tesseract core' || m.status === 'initializing tesseract') {
          onProgress?.({
            progress: Math.round(20 + p * 10),
            stage: 'Initializing offline OCR core…',
          });
        } else if (m.status === 'loading language traineddata') {
          onProgress?.({
            progress: Math.round(30 + p * 15),
            stage: `Loading ${scriptOpt.shortLabel} language model…`,
          });
        } else if (m.status === 'initializing api') {
          onProgress?.({
            progress: 46,
            stage: 'Preparing multilingual recognizer…',
          });
        } else if (m.status === 'recognizing text') {
          onProgress?.({
            progress: Math.round(48 + p * 48),
            stage: `Recognizing ${scriptOpt.shortLabel} text…`,
          });
        }
      },
    });

  let result;
  try {
    result = await recognizeWithLang(scriptOpt.tesseractLangs);
  } catch {
    // Secondary fallback if combined traineddata fails to fetch offline
    result = await recognizeWithLang('eng');
  }

  onProgress?.({ progress: 99, stage: 'Structuring extracted text blocks…' });

  const rawText = (result.data.text ?? '').normalize('NFKC');
  const paragraphs = cleanOcrFallbackText(rawText);

  const blocks: TextBlock[] = paragraphs.map((text, idx) => ({
    id: `p${pageNumber}-ocr-${idx + 1}`,
    kind: idx === 0 && text.length < 70 ? 'heading' : 'paragraph',
    text,
    yPercent: Math.round(((idx + 1) / (paragraphs.length + 1)) * 90),
    fontSize: idx === 0 ? 15 : 11,
  }));

  const combined = blocks.map((b) => b.text).join(' ');
  const detectedCode = detectTextLanguageCode(combined);

  onProgress?.({ progress: 100, stage: 'OCR extraction ready for review' });

  return {
    pageNumber,
    width: width / scale,
    height: height / scale,
    blocks,
    figures: [],
    isBlank: blocks.length === 0,
    isOcr: true,
    ocrEngine: 'tesseract',
    looksGarbled: detectGarbledBlocks(blocks),
    detectedLang: getLanguageOption(detectedCode).name,
    scriptDirection: isTextPredominantlyRtl(combined) ? 'rtl' : 'ltr',
  };
}
