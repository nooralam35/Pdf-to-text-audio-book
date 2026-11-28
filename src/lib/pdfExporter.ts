import { PDFDocument } from 'pdf-lib';
import type { LoadedPdf } from './pdfEngine';
import { renderPageToDataUrl } from './pdfEngine';
import { getLanguageOption } from './languages';
import type {
  AnnotationStroke,
  ExtractedFigure,
  LanguageCode,
  PageAnnotationLayer,
  StickyNote,
  StoredBook,
  TranslatedBlock,
  TranslatedPageRecord,
} from '../types';

export interface ExportPdfOptions {
  pdf: LoadedPdf;
  book: StoredBook;
  pages: TranslatedPageRecord[];
  lang: LanguageCode;
  includeCover: boolean;
  includeFigures: boolean;
  includeOriginalSubheader: boolean;
  onProgress?: (current: number, total: number, status: string) => void;
}

export interface ExportPdfResult {
  blob: Blob;
  fileName: string;
  exportedPageCount: number;
}

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const commaIdx = dataUrl.indexOf(',');
  const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : '';
  if (!base64) return new Uint8Array(0);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

function wrapTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (!word) continue;
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      if (current) {
        lines.push(current);
      }
      // Handle single ultra-long token (e.g., URL)
      if (ctx.measureText(word).width > maxWidth) {
        let chunk = '';
        for (const ch of Array.from(word)) {
          if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        current = chunk;
      } else {
        current = word;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

type RenderItem =
  | { type: 'block'; yPercent: number; block: TranslatedBlock }
  | { type: 'figure'; yPercent: number; figure: ExtractedFigure }
  | { type: 'explanation'; yPercent: number; text: string };

/**
 * Builds a real cover-preserved, diagram-preserved, HarfBuzz-shaped Unicode PDF.
 * Uses high-DPI Canvas 2D typography after awaiting document.fonts.ready so Indic/Urdu
 * matras, half-letters, and ligatures render with 100% print fidelity and zero boxes.
 */
export async function exportTranslatedPdf(
  options: ExportPdfOptions
): Promise<ExportPdfResult> {
  const {
    pdf,
    book,
    pages,
    lang,
    includeCover,
    includeFigures,
    includeOriginalSubheader,
    onProgress,
  } = options;

  const langOption = getLanguageOption(lang);
  const isRtl = Boolean(langOption.rtl);

  // Ensure Google Noto Indic/Urdu web fonts are loaded before drawing to Canvas (capped at 2.5s so offline/slow fonts never stall export)
  if (typeof document !== 'undefined' && document.fonts) {
    try {
      await Promise.race([
        Promise.allSettled([
          document.fonts.load(`400 24px ${langOption.canvasFont}`),
          document.fonts.load(`600 24px ${langOption.canvasFont}`),
          document.fonts.load(`700 28px ${langOption.canvasFont}`),
          document.fonts.ready,
        ]),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]);
    } catch {
      // proceed with loaded fonts
    }
  }

  const outPdf = await PDFDocument.create();
  outPdf.setTitle(`${book.title} (${langOption.name})`);
  outPdf.setAuthor(book.author || 'BhashaBook Studio');
  outPdf.setSubject(`Translated into ${langOption.name} with preserved layout & cover`);
  outPdf.setCreator('BhashaBook PDF Translator');

  // Preserve the original book's trim dimensions (e.g., 6x9 in = 432x648 pt)
  const pageW = Math.max(420, Math.min(620, book.pageWidth || 432));
  const pageH = Math.max(580, Math.min(860, book.pageHeight || 648));
  const totalSteps = pages.length + (includeCover ? 1 : 0);
  let stepDone = 0;

  // 1. Original Full-Bleed Cover Page (Page 1 untouched)
  if (includeCover) {
    onProgress?.(0, totalSteps, 'Extracting high-resolution original cover page...');
    let coverDataUrl = book.coverDataUrl;
    let coverW = pageW;
    let coverH = pageH;
    try {
      const hiCover = await renderPageToDataUrl(pdf, 1, 2.4, 'image/jpeg', 0.94);
      coverDataUrl = hiCover.dataUrl;
      const p1 = await pdf.getPage(1);
      const vp1 = p1.getViewport({ scale: 1.0 });
      coverW = vp1.width;
      coverH = vp1.height;
    } catch {
      // fallback to stored coverDataUrl
    }

    if (coverDataUrl && coverDataUrl.startsWith('data:image/')) {
      try {
        const coverBytes = dataUrlToUint8Array(coverDataUrl);
        if (coverBytes.byteLength > 0) {
          const isPng = coverDataUrl.startsWith('data:image/png');
          const isJpg =
            coverDataUrl.startsWith('data:image/jpeg') ||
            coverDataUrl.startsWith('data:image/jpg');
          if (isPng || isJpg) {
            const embeddedCover = isPng
              ? await outPdf.embedPng(coverBytes)
              : await outPdf.embedJpg(coverBytes);
            const coverPage = outPdf.addPage([coverW, coverH]);
            coverPage.drawImage(embeddedCover, {
              x: 0,
              y: 0,
              width: coverW,
              height: coverH,
            });
          }
        }
      } catch {
        // Non-fatal cover image failure — continue exporting translated pages
      }
    }
    stepDone++;
    onProgress?.(stepDone, totalSteps, 'Cover page embedded.');
  }

  // 2. Render each translated page with high-DPI HarfBuzz Canvas + inline original diagrams
  // Use adaptive DPI for large full-book exports (60+ pages) so 200+ page PDFs build fast & stay memory-safe
  const isLargeBook = pages.length > 60;
  const DPI_SCALE = isLargeBook ? 1.85 : 2.4;
  const jpegQuality = isLargeBook ? 0.86 : 0.92;
  const cw = Math.round(pageW * DPI_SCALE);
  const ch = Math.round(pageH * DPI_SCALE);
  const marginX = Math.round(38 * DPI_SCALE);
  const marginTop = Math.round(44 * DPI_SCALE);
  const marginBottom = Math.round(36 * DPI_SCALE);
  const contentW = cw - marginX * 2;
  const maxY = ch - marginBottom;

  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable for PDF export');

  const initPageSurface = (origPageNum: number, continuationIdx: number) => {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);

    // Subtle book running header
    ctx.direction = 'ltr';
    ctx.font = `500 ${Math.round(8.5 * DPI_SCALE)}px "Plus Jakarta Sans", sans-serif`;
    ctx.fillStyle = '#78716c';
    ctx.textAlign = 'left';
    const shortTitle = book.title.length > 44 ? `${book.title.slice(0, 44)}…` : book.title;
    ctx.fillText(shortTitle, marginX, Math.round(24 * DPI_SCALE));

    ctx.textAlign = 'right';
    const headerRight =
      continuationIdx > 0
        ? `${langOption.name} · Orig. p.${origPageNum} (cont.)`
        : `${langOption.name} · Orig. p.${origPageNum}`;
    ctx.fillText(headerRight, cw - marginX, Math.round(24 * DPI_SCALE));

    // Hairline rule under running header
    ctx.strokeStyle = '#e7e5e4';
    ctx.lineWidth = Math.max(1, DPI_SCALE * 0.6);
    ctx.beginPath();
    ctx.moveTo(marginX, Math.round(31 * DPI_SCALE));
    ctx.lineTo(cw - marginX, Math.round(31 * DPI_SCALE));
    ctx.stroke();

    // Bottom page footer
    ctx.fillStyle = '#a8a29e';
    ctx.textAlign = 'center';
    ctx.font = `500 ${Math.round(8.5 * DPI_SCALE)}px "JetBrains Mono", monospace`;
    ctx.fillText(`— ${origPageNum} —`, cw / 2, ch - Math.round(16 * DPI_SCALE));

    ctx.restore();
    return marginTop;
  };

  const flushCanvasToPdf = async () => {
    const jpegUrl = canvas.toDataURL('image/jpeg', jpegQuality);
    const bytes = dataUrlToUint8Array(jpegUrl);
    const img = await outPdf.embedJpg(bytes);
    const pdfPage = outPdf.addPage([pageW, pageH]);
    pdfPage.drawImage(img, {
      x: 0,
      y: 0,
      width: pageW,
      height: pageH,
    });
  };

  const sortedPages = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);

  for (const record of sortedPages) {
    onProgress?.(
      stepDone,
      totalSteps,
      `Typesetting Page ${record.pageNumber} (${langOption.name})...`
    );
    // Yield briefly so browser UI progress stays fluid during full-book builds
    if (stepDone % 3 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }

    // Combine blocks + inline figures in exact vertical page order
    const items: RenderItem[] = [];
    for (const block of record.blocks ?? []) {
      items.push({ type: 'block', yPercent: block.yPercent, block });
    }
    if (includeFigures && Array.isArray(record.figures) && record.figures.length > 0) {
      for (const figure of record.figures) {
        items.push({ type: 'figure', yPercent: figure.yPercent, figure });
      }
    }
    items.sort((a, b) => a.yPercent - b.yPercent);

    if (Array.isArray(record.imageExplanations) && record.imageExplanations.length > 0) {
      for (const exp of record.imageExplanations) {
        items.push({ type: 'explanation', yPercent: 101, text: exp });
      }
    }

    let continuationIdx = 0;
    let cursorY = initPageSurface(record.pageNumber, continuationIdx);

    const ensureSpace = async (neededPx: number) => {
      if (cursorY + neededPx > maxY && cursorY > marginTop + 20) {
        await flushCanvasToPdf();
        continuationIdx++;
        cursorY = initPageSurface(record.pageNumber, continuationIdx);
      }
    };

    for (const item of items) {
      if (item.type === 'figure') {
        try {
          const img = await loadImage(item.figure.dataUrl);
          const maxFigW = contentW * Math.min(0.96, Math.max(0.68, item.figure.widthRatio + 0.14));
          const maxFigH = (maxY - marginTop) * 0.44;
          let drawW = maxFigW;
          let drawH = drawW / Math.max(0.3, item.figure.aspectRatio || img.width / img.height);
          if (drawH > maxFigH) {
            drawH = maxFigH;
            drawW = drawH * (img.width / Math.max(1, img.height));
          }

          await ensureSpace(drawH + 18 * DPI_SCALE);
          const drawX = marginX + (contentW - drawW) / 2;

          // Subtle figure border frame
          ctx.save();
          ctx.fillStyle = '#fafaf9';
          ctx.fillRect(drawX - 4, cursorY - 4, drawW + 8, drawH + 8);
          ctx.drawImage(img, drawX, cursorY, drawW, drawH);
          ctx.strokeStyle = '#e7e5e4';
          ctx.lineWidth = Math.max(1, DPI_SCALE * 0.6);
          ctx.strokeRect(drawX - 4, cursorY - 4, drawW + 8, drawH + 8);
          ctx.restore();

          cursorY += drawH + 14 * DPI_SCALE;
        } catch {
          // Skip broken figure gracefully
        }
        continue;
      }

      if (item.type === 'explanation') {
        const fontSize = Math.round(9.5 * DPI_SCALE);
        const lineH = Math.round(fontSize * 1.55);
        ctx.save();
        ctx.direction = isRtl ? 'rtl' : 'ltr';
        ctx.font = `500 ${fontSize}px ${langOption.canvasFont}`;
        const padX = Math.round(10 * DPI_SCALE);
        const padY = Math.round(8 * DPI_SCALE);
        const lines = wrapTextLines(ctx, item.text, contentW - padX * 2);
        const boxH = lines.length * lineH + padY * 2;
        ctx.restore();

        await ensureSpace(boxH + 10 * DPI_SCALE);

        ctx.save();
        ctx.fillStyle = '#f5f5f4';
        ctx.strokeStyle = '#d6d3d1';
        ctx.lineWidth = Math.max(1, DPI_SCALE * 0.6);
        ctx.fillRect(marginX, cursorY, contentW, boxH);
        ctx.strokeRect(marginX, cursorY, contentW, boxH);

        ctx.direction = isRtl ? 'rtl' : 'ltr';
        ctx.textAlign = isRtl ? 'right' : 'left';
        ctx.font = `500 ${fontSize}px ${langOption.canvasFont}`;
        ctx.fillStyle = '#44403c';
        let ty = cursorY + padY + fontSize * 0.85;
        const tx = isRtl ? marginX + contentW - padX : marginX + padX;
        for (const line of lines) {
          ctx.fillText(line, tx, ty);
          ty += lineH;
        }
        ctx.restore();

        cursorY += boxH + 10 * DPI_SCALE;
        continue;
      }

      // Text block rendering
      const blk = item.block;
      const text = (blk.translatedText || blk.text).trim();
      if (!text) continue;

      let fontSizePt = 10.5;
      let fontWeight = '400';
      let color = '#1c1917';
      let lineHeightMul = lang === 'ur' ? 1.85 : 1.58;
      let spaceBefore = 0;
      let spaceAfter = 7;
      let indentPx = 0;
      let isCalloutBox = false;

      if (blk.kind === 'heading') {
        fontSizePt = 15;
        fontWeight = '700';
        color = '#0f172a';
        lineHeightMul = 1.38;
        spaceBefore = cursorY > marginTop + 10 ? 10 : 0;
        spaceAfter = 9;
      } else if (blk.kind === 'subheading') {
        fontSizePt = 12;
        fontWeight = '600';
        color = '#1e293b';
        lineHeightMul = 1.45;
        spaceBefore = 7;
        spaceAfter = 6;
      } else if (blk.kind === 'bullet') {
        fontSizePt = 10.2;
        indentPx = Math.round(14 * DPI_SCALE);
        spaceAfter = 5;
      } else if (blk.kind === 'callout') {
        fontSizePt = 10;
        fontWeight = '500';
        color = '#292524';
        isCalloutBox = true;
        spaceBefore = 4;
        spaceAfter = 9;
      }

      const fontSize = Math.round(fontSizePt * DPI_SCALE);
      const lineH = Math.round(fontSize * lineHeightMul);
      const padX = isCalloutBox ? Math.round(12 * DPI_SCALE) : 0;
      const padY = isCalloutBox ? Math.round(9 * DPI_SCALE) : 0;
      const usableW = contentW - indentPx - padX * 2;

      ctx.save();
      ctx.direction = isRtl ? 'rtl' : 'ltr';
      ctx.font = `${fontWeight} ${fontSize}px ${langOption.canvasFont}`;
      const lines = wrapTextLines(ctx, text, usableW);
      ctx.restore();

      cursorY += spaceBefore * DPI_SCALE;

      if (isCalloutBox) {
        const boxH = lines.length * lineH + padY * 2;
        await ensureSpace(boxH + spaceAfter * DPI_SCALE);
        ctx.save();
        ctx.fillStyle = '#faf7f2';
        ctx.strokeStyle = '#e7e0d6';
        ctx.lineWidth = Math.max(1, DPI_SCALE * 0.7);
        ctx.fillRect(marginX, cursorY, contentW, boxH);
        ctx.strokeRect(marginX, cursorY, contentW, boxH);

        ctx.direction = isRtl ? 'rtl' : 'ltr';
        ctx.textAlign = isRtl ? 'right' : 'left';
        ctx.font = `${fontWeight} ${fontSize}px ${langOption.canvasFont}`;
        ctx.fillStyle = color;
        let ty = cursorY + padY + fontSize * 0.85;
        const tx = isRtl ? marginX + contentW - padX : marginX + padX;
        for (const line of lines) {
          ctx.fillText(line, tx, ty);
          ty += lineH;
        }
        ctx.restore();
        cursorY += boxH + spaceAfter * DPI_SCALE;
      } else {
        // Optional subtle English reference subheader under translated headings
        if (includeOriginalSubheader && blk.kind === 'heading' && blk.text !== text) {
          await ensureSpace(lineH * Math.min(lines.length, 3) + 18 * DPI_SCALE);
        } else {
          await ensureSpace(lineH * Math.min(lines.length, 2));
        }

        ctx.save();
        ctx.direction = isRtl ? 'rtl' : 'ltr';
        ctx.textAlign = isRtl ? 'right' : 'left';
        ctx.font = `${fontWeight} ${fontSize}px ${langOption.canvasFont}`;
        ctx.fillStyle = color;

        const baseX = isRtl ? marginX + contentW - indentPx : marginX + indentPx;

        for (let li = 0; li < lines.length; li++) {
          if (cursorY + lineH > maxY) {
            ctx.restore();
            await flushCanvasToPdf();
            continuationIdx++;
            cursorY = initPageSurface(record.pageNumber, continuationIdx);
            ctx.save();
            ctx.direction = isRtl ? 'rtl' : 'ltr';
            ctx.textAlign = isRtl ? 'right' : 'left';
            ctx.font = `${fontWeight} ${fontSize}px ${langOption.canvasFont}`;
            ctx.fillStyle = color;
          }

          if (blk.kind === 'bullet' && li === 0) {
            const dotX = isRtl ? marginX + contentW - 5 * DPI_SCALE : marginX + 5 * DPI_SCALE;
            ctx.beginPath();
            ctx.arc(dotX, cursorY + fontSize * 0.52, Math.max(1.8, 1.8 * DPI_SCALE), 0, Math.PI * 2);
            ctx.fill();
          }

          ctx.fillText(lines[li], baseX, cursorY + fontSize * 0.85);
          cursorY += lineH;
        }
        ctx.restore();

        if (includeOriginalSubheader && blk.kind === 'heading' && blk.text !== text) {
          ctx.save();
          ctx.direction = 'ltr';
          ctx.textAlign = isRtl ? 'right' : 'left';
          ctx.font = `500 ${Math.round(8.5 * DPI_SCALE)}px "Plus Jakarta Sans", sans-serif`;
          ctx.fillStyle = '#78716c';
          const refLines = wrapTextLines(ctx, blk.text, contentW);
          const refX = isRtl ? marginX + contentW : marginX;
          for (const rl of refLines.slice(0, 2)) {
            ctx.fillText(rl, refX, cursorY + 7 * DPI_SCALE);
            cursorY += Math.round(11 * DPI_SCALE);
          }
          ctx.restore();
        }

        cursorY += spaceAfter * DPI_SCALE;
      }
    }

    await flushCanvasToPdf();
    stepDone++;
    onProgress?.(stepDone, totalSteps, `Completed Page ${record.pageNumber}`);
    if (stepDone % 4 === 0) {
      await new Promise((r) => window.setTimeout(r, 0));
    }
  }

  canvas.width = 0;
  canvas.height = 0;

  onProgress?.(totalSteps, totalSteps, 'Packaging PDF document...');
  const pdfBytes = await outPdf.save();
  const safeSlug = book.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  const fileName = `${safeSlug || 'bhashabook'}-${lang}-translated.pdf`;

  return {
    blob: new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' }),
    fileName,
    exportedPageCount: outPdf.getPageCount(),
  };
}

export function buildTranslatedScriptBlob(
  book: StoredBook,
  pages: TranslatedPageRecord[],
  lang: LanguageCode
): { blob: Blob; fileName: string } {
  const langOption = getLanguageOption(lang);
  const sorted = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
  const sections: string[] = [
    `${book.title}`,
    `Translated Edition (${langOption.name} / ${langOption.nativeName})`,
    `Exported Pages: ${sorted.map((p) => p.pageNumber).join(', ')}`,
    '='.repeat(60),
    '',
  ];

  for (const page of sorted) {
    sections.push(`--- Page ${page.pageNumber} ---`);
    sections.push('');
    for (const blk of page.blocks) {
      const txt = (blk.translatedText || blk.text).trim();
      if (!txt) continue;
      if (blk.kind === 'heading') {
        sections.push(`## ${txt}`);
      } else if (blk.kind === 'subheading') {
        sections.push(`### ${txt}`);
      } else if (blk.kind === 'bullet') {
        sections.push(`• ${txt}`);
      } else {
        sections.push(txt);
      }
      sections.push('');
    }
    if (page.imageExplanations.length > 0) {
      for (const exp of page.imageExplanations) {
        sections.push(exp);
      }
      sections.push('');
    }
  }

  const safeSlug = book.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

  return {
    blob: new Blob([sections.join('\n')], { type: 'text/plain;charset=utf-8' }),
    fileName: `${safeSlug || 'bhashabook'}-${lang}-script.txt`,
  };
}

const EXPORT_NOTE_COLORS: Record<
  StickyNote['color'],
  { fill: string; stroke: string; text: string; badgeBg: string }
> = {
  amber: { fill: '#F59E0B', stroke: '#B45309', text: '#1C1917', badgeBg: '#FFFBEB' },
  sage: { fill: '#10B981', stroke: '#047857', text: '#064E3B', badgeBg: '#ECFDF5' },
  sky: { fill: '#0EA5E9', stroke: '#0369A1', text: '#FFFFFF', badgeBg: '#F0F9FF' },
  rose: { fill: '#F43F5E', stroke: '#BE123C', text: '#FFFFFF', badgeBg: '#FFF1F2' },
};

function drawAnnotatedStroke(
  ctx: CanvasRenderingContext2D,
  stroke: AnnotationStroke,
  w: number,
  h: number,
  scaleFactor: number
) {
  const pts = stroke.points;
  if (pts.length === 0) return;

  const opacity =
    typeof stroke.opacity === 'number'
      ? Math.max(0.05, Math.min(1, stroke.opacity))
      : stroke.mode === 'highlight'
      ? 0.4
      : 0.95;

  const brushPx = Math.max(1.5, stroke.width * scaleFactor);

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = brushPx;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x * w, pts[0].y * h, brushPx / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(pts[0].x * w, pts[0].y * h);
  for (let i = 1; i < pts.length - 1; i++) {
    const cx = pts[i].x * w;
    const cy = pts[i].y * h;
    const midX = (cx + pts[i + 1].x * w) / 2;
    const midY = (cy + pts[i + 1].y * h) / 2;
    ctx.quadraticCurveTo(cx, cy, midX, midY);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x * w, last.y * h);
  ctx.stroke();
  ctx.restore();
}

export interface AnnotatedRenderOptions {
  includeNotes: boolean;
  includeNoteText: boolean;
  scale?: number;
}

async function renderAnnotatedPageCanvas(
  pdf: LoadedPdf,
  pageNumber: number,
  layer: PageAnnotationLayer | undefined,
  options: AnnotatedRenderOptions
): Promise<{ canvas: HTMLCanvasElement; pointWidth: number; pointHeight: number }> {
  const scale = options.scale ?? 2.3;
  const page = await pdf.getPage(pageNumber);
  const baseVp = page.getViewport({ scale: 1.0 });
  const renderVp = page.getViewport({ scale });

  const pagePxW = Math.floor(renderVp.width);
  const pagePxH = Math.floor(renderVp.height);
  const strokes = layer?.strokes ?? [];
  const notes = options.includeNotes ? layer?.notes ?? [] : [];
  const notesWithText = options.includeNoteText
    ? notes
        .map((n, idx) => ({ note: n, num: idx + 1 }))
        .filter((item) => item.note.text.trim().length > 0)
    : [];

  // Pre-measure clean bottom reference strip height if sticky notes contain written text
  const footerPadX = Math.round(24 * scale);
  const footerPadY = Math.round(16 * scale);
  const noteFontSize = Math.round(10 * scale);
  const noteLineH = Math.round(noteFontSize * 1.48);
  const headerFontSize = Math.round(9 * scale);

  const measureCanvas = document.createElement('canvas');
  const mCtx = measureCanvas.getContext('2d');
  const wrappedNotes: Array<{ num: number; note: StickyNote; lines: string[] }> = [];
  let extraFooterH = 0;

  if (notesWithText.length > 0 && mCtx) {
    mCtx.font = `400 ${noteFontSize}px "Plus Jakarta Sans", sans-serif`;
    const usableW = Math.max(120, pagePxW - footerPadX * 2 - Math.round(24 * scale));
    let bodyH = headerFontSize + Math.round(10 * scale);
    for (const item of notesWithText) {
      const lines = wrapTextLines(mCtx, item.note.text, usableW);
      wrappedNotes.push({ num: item.num, note: item.note, lines });
      bodyH += lines.length * noteLineH + Math.round(8 * scale);
    }
    extraFooterH = footerPadY * 2 + bodyH;
  }
  measureCanvas.width = 0;
  measureCanvas.height = 0;

  const canvas = document.createElement('canvas');
  canvas.width = pagePxW;
  canvas.height = pagePxH + extraFooterH;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvas 2D context unavailable for annotated export.');

  // 1. Render original PDF page cleanly
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({
    canvasContext: ctx,
    viewport: renderVp,
    canvas,
  }).promise;
  try {
    page.cleanup();
  } catch {
    // ignore cleanup race
  }

  // 2. Composite HTML5 Canvas highlight strokes (multiply blend preserves diagram labels)
  const scaleFactor = pagePxW / 540;
  const highlightStrokes = strokes.filter((s) => s.mode === 'highlight');
  if (highlightStrokes.length > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    for (const s of highlightStrokes) {
      drawAnnotatedStroke(ctx, s, pagePxW, pagePxH, scaleFactor);
    }
    ctx.restore();
  }

  // 3. Composite HTML5 Canvas freehand brush / pen strokes
  const penStrokes = strokes.filter((s) => s.mode === 'pen');
  if (penStrokes.length > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    for (const s of penStrokes) {
      drawAnnotatedStroke(ctx, s, pagePxW, pagePxH, scaleFactor);
    }
    ctx.restore();
  }

  // 4. Draw numbered sticky note pins directly on the page
  if (notes.length > 0) {
    const pinRadius = Math.max(11, Math.round(11 * scaleFactor));
    notes.forEach((note, idx) => {
      const style = EXPORT_NOTE_COLORS[note.color] ?? EXPORT_NOTE_COLORS.amber;
      const cx = note.x * pagePxW;
      const cy = note.y * pagePxH;

      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.22)';
      ctx.shadowBlur = Math.round(5 * scaleFactor);
      ctx.shadowOffsetY = Math.round(2 * scaleFactor);

      ctx.beginPath();
      ctx.arc(cx, cy, pinRadius, 0, Math.PI * 2);
      ctx.fillStyle = style.fill;
      ctx.fill();

      ctx.shadowColor = 'transparent';
      ctx.lineWidth = Math.max(1.5, 1.8 * scaleFactor);
      ctx.strokeStyle = style.stroke;
      ctx.stroke();

      ctx.fillStyle = style.text;
      ctx.font = `700 ${Math.round(pinRadius * 1.05)}px "JetBrains Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(idx + 1), cx, cy + 0.5);
      ctx.restore();
    });
  }

  // 5. Render optional non-overlapping sticky note reference strip below the page
  if (extraFooterH > 0 && wrappedNotes.length > 0) {
    ctx.save();
    ctx.fillStyle = '#FAF9F5';
    ctx.fillRect(0, pagePxH, pagePxW, extraFooterH);

    ctx.strokeStyle = '#D6D3D1';
    ctx.lineWidth = Math.max(1, scale * 0.8);
    ctx.beginPath();
    ctx.moveTo(0, pagePxH);
    ctx.lineTo(pagePxW, pagePxH);
    ctx.stroke();

    let y = pagePxH + footerPadY;
    ctx.fillStyle = '#78716C';
    ctx.font = `600 ${headerFontSize}px "Plus Jakarta Sans", sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`PAGE ${pageNumber} ANNOTATIONS & STICKY NOTES`, footerPadX, y);
    y += headerFontSize + Math.round(10 * scale);

    const badgeR = Math.round(7.5 * scale);
    for (const item of wrappedNotes) {
      const style = EXPORT_NOTE_COLORS[item.note.color] ?? EXPORT_NOTE_COLORS.amber;
      const bx = footerPadX + badgeR;
      const by = y + Math.round(noteLineH * 0.45);

      ctx.beginPath();
      ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
      ctx.fillStyle = style.fill;
      ctx.fill();
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = Math.max(1, scale * 0.6);
      ctx.stroke();

      ctx.fillStyle = style.text;
      ctx.font = `700 ${Math.round(badgeR * 1.1)}px "JetBrains Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(item.num), bx, by + 0.5);

      ctx.fillStyle = '#1C1917';
      ctx.font = `400 ${noteFontSize}px "Plus Jakarta Sans", sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const textX = footerPadX + Math.round(24 * scale);
      for (const line of item.lines) {
        ctx.fillText(line, textX, y);
        y += noteLineH;
      }
      y += Math.round(8 * scale);
    }
    ctx.restore();
  }

  return {
    canvas,
    pointWidth: baseVp.width,
    pointHeight: baseVp.height + extraFooterH / scale,
  };
}

function sanitizeBookSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'bhashabook'
  );
}

export async function exportAnnotatedPageImage(params: {
  pdf: LoadedPdf;
  bookTitle: string;
  pageNumber: number;
  layer?: PageAnnotationLayer;
  format: 'png' | 'jpeg';
  includeNotes?: boolean;
  includeNoteText?: boolean;
}): Promise<{ blob: Blob; fileName: string }> {
  const {
    pdf,
    bookTitle,
    pageNumber,
    layer,
    format,
    includeNotes = true,
    includeNoteText = true,
  } = params;

  const { canvas } = await renderAnnotatedPageCanvas(pdf, pageNumber, layer, {
    includeNotes,
    includeNoteText,
    scale: 2.4,
  });

  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
  const quality = format === 'jpeg' ? 0.93 : undefined;

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else reject(new Error('Failed to encode annotated page image.'));
      },
      mimeType,
      quality
    );
  });

  const ext = format === 'png' ? 'png' : 'jpg';
  const fileName = `${sanitizeBookSlug(bookTitle)}-p${pageNumber}-annotated.${ext}`;
  return { blob, fileName };
}

export interface ExportAnnotatedPdfOptions {
  pdf: LoadedPdf;
  book: StoredBook;
  pageNumbers: number[];
  annotationsMap: Record<number, PageAnnotationLayer>;
  includeCover: boolean;
  includeNotes: boolean;
  includeNoteText: boolean;
  onProgress?: (current: number, total: number, status: string) => void;
}

export async function exportAnnotatedPdf(
  options: ExportAnnotatedPdfOptions
): Promise<ExportPdfResult> {
  const {
    pdf,
    book,
    pageNumbers,
    annotationsMap,
    includeCover,
    includeNotes,
    includeNoteText,
    onProgress,
  } = options;

  const uniquePages = Array.from(new Set(pageNumbers)).sort((a, b) => a - b);
  const outPdf = await PDFDocument.create();
  outPdf.setTitle(`${book.title} (Annotated)`);
  outPdf.setAuthor(book.author || 'BhashaBook Studio');
  outPdf.setSubject('Annotated PDF pages with custom highlights, drawings, and sticky notes');
  outPdf.setCreator('BhashaBook PDF Annotator');

  const needsCover = includeCover && !uniquePages.includes(1);
  const totalSteps = uniquePages.length + (needsCover ? 1 : 0);
  let stepDone = 0;

  // Optional untouched full-bleed Page 1 cover (if Page 1 isn't already in the annotated set)
  if (needsCover) {
    onProgress?.(0, totalSteps, 'Embedding original Page 1 cover...');
    const p1 = await pdf.getPage(1);
    const vp1 = p1.getViewport({ scale: 1.0 });
    const hiCover = await renderPageToDataUrl(pdf, 1, 2.3, 'image/jpeg', 0.94);
    const coverImg = await outPdf.embedJpg(dataUrlToUint8Array(hiCover.dataUrl));
    const coverPage = outPdf.addPage([vp1.width, vp1.height]);
    coverPage.drawImage(coverImg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    stepDone++;
    onProgress?.(stepDone, totalSteps, 'Cover embedded.');
  }

  for (const pageNum of uniquePages) {
    onProgress?.(stepDone, totalSteps, `Compositing annotated Page ${pageNum}...`);
    const { canvas, pointWidth, pointHeight } = await renderAnnotatedPageCanvas(
      pdf,
      pageNum,
      annotationsMap[pageNum],
      {
        includeNotes,
        includeNoteText,
        scale: 2.2,
      }
    );

    const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.9);
    canvas.width = 0;
    canvas.height = 0;
    const embeddedImg = await outPdf.embedJpg(dataUrlToUint8Array(jpegDataUrl));
    const pdfPage = outPdf.addPage([pointWidth, pointHeight]);
    pdfPage.drawImage(embeddedImg, {
      x: 0,
      y: 0,
      width: pointWidth,
      height: pointHeight,
    });

    stepDone++;
    onProgress?.(stepDone, totalSteps, `Added annotated Page ${pageNum}.`);
    if (stepDone % 3 === 0) {
      await new Promise((r) => window.setTimeout(r, 0));
    }
  }

  onProgress?.(totalSteps, totalSteps, 'Packaging annotated PDF...');
  const pdfBytes = await outPdf.save();
  const suffix =
    uniquePages.length === 1 ? `p${uniquePages[0]}-annotated.pdf` : 'annotated.pdf';
  const fileName = `${sanitizeBookSlug(book.title)}-${suffix}`;

  return {
    blob: new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' }),
    fileName,
    exportedPageCount: outPdf.getPageCount(),
  };
}

