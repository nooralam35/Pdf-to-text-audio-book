import { getLanguageOption } from './languages';
import type { LanguageCode, TextHighlightColor } from '../types';

export type QuoteCardThemeId = 'paper' | 'gallery' | 'nocturne' | 'sepia' | 'lapis';
export type QuoteCardAspectId = 'square' | 'portrait' | 'story' | 'wide';

export interface ShareQuotePayload {
  id?: string;
  quoteText: string;
  note?: string;
  bookTitle: string;
  author?: string;
  pageNumber: number;
  chapterTitle?: string;
  lang: LanguageCode;
  coverDataUrl?: string;
  highlightColor?: TextHighlightColor;
}

export interface QuoteCardOptions {
  theme: QuoteCardThemeId;
  aspect: QuoteCardAspectId;
  showCover: boolean;
  showNote: boolean;
  showPageMeta: boolean;
  showWatermark: boolean;
}

export interface QuoteCardThemeSpec {
  id: QuoteCardThemeId;
  label: string;
  bg: string;
  bgAccent: string;
  frame: string;
  text: string;
  muted: string;
  accent: string;
  noteBg: string;
  isDark: boolean;
}

export const QUOTE_CARD_THEMES: QuoteCardThemeSpec[] = [
  {
    id: 'paper',
    label: 'Archival Paper',
    bg: '#FAF8F2',
    bgAccent: '#F2ECE0',
    frame: 'rgba(120, 113, 108, 0.28)',
    text: '#1C1917',
    muted: '#6B655E',
    accent: '#9A3412',
    noteBg: 'rgba(154, 52, 18, 0.06)',
    isDark: false,
  },
  {
    id: 'gallery',
    label: 'Gallery White',
    bg: '#FFFFFF',
    bgAccent: '#F5F5F4',
    frame: 'rgba(23, 23, 23, 0.16)',
    text: '#0A0A0A',
    muted: '#666666',
    accent: '#1C1917',
    noteBg: 'rgba(23, 23, 23, 0.04)',
    isDark: false,
  },
  {
    id: 'sepia',
    label: 'Sepia Folio',
    bg: '#F0E6D0',
    bgAccent: '#E4D5B7',
    frame: 'rgba(92, 64, 38, 0.28)',
    text: '#2E241A',
    muted: '#6E5A46',
    accent: '#78350F',
    noteBg: 'rgba(120, 53, 15, 0.07)',
    isDark: false,
  },
  {
    id: 'nocturne',
    label: 'Nocturne Ink',
    bg: '#141312',
    bgAccent: '#1E1C1A',
    frame: 'rgba(245, 240, 230, 0.18)',
    text: '#F5F0E6',
    muted: '#A8A29E',
    accent: '#D97706',
    noteBg: 'rgba(255, 255, 255, 0.05)',
    isDark: true,
  },
  {
    id: 'lapis',
    label: 'Deep Lapis',
    bg: '#14213D',
    bgAccent: '#1D2F57',
    frame: 'rgba(248, 244, 236, 0.2)',
    text: '#F8F5EE',
    muted: '#B6C2D9',
    accent: '#E2B45A',
    noteBg: 'rgba(255, 255, 255, 0.06)',
    isDark: true,
  },
];

export interface QuoteCardAspectSpec {
  id: QuoteCardAspectId;
  label: string;
  ratioLabel: string;
  channelHint: string;
  width: number;
  height: number;
}

export const QUOTE_CARD_ASPECTS: QuoteCardAspectSpec[] = [
  {
    id: 'square',
    label: 'Square',
    ratioLabel: '1:1',
    channelHint: 'Instagram · LinkedIn',
    width: 1080,
    height: 1080,
  },
  {
    id: 'portrait',
    label: 'Portrait',
    ratioLabel: '4:5',
    channelHint: 'Instagram · Pinterest',
    width: 1080,
    height: 1350,
  },
  {
    id: 'story',
    label: 'Story',
    ratioLabel: '9:16',
    channelHint: 'Stories · WhatsApp',
    width: 1080,
    height: 1920,
  },
  {
    id: 'wide',
    label: 'Wide',
    ratioLabel: '16:9',
    channelHint: 'X · Facebook',
    width: 1200,
    height: 675,
  },
];

const HIGHLIGHT_ACCENT_LIGHT: Record<TextHighlightColor, string> = {
  amber: '#B45309',
  sage: '#047857',
  sky: '#0369A1',
  rose: '#BE123C',
};

const HIGHLIGHT_ACCENT_DARK: Record<TextHighlightColor, string> = {
  amber: '#F59E0B',
  sage: '#34D399',
  sky: '#38BDF8',
  rose: '#FB7185',
};

function getThemeSpec(id: QuoteCardThemeId): QuoteCardThemeSpec {
  return QUOTE_CARD_THEMES.find((t) => t.id === id) ?? QUOTE_CARD_THEMES[0];
}

export function getAspectSpec(id: QuoteCardAspectId): QuoteCardAspectSpec {
  return QUOTE_CARD_ASPECTS.find((a) => a.id === id) ?? QUOTE_CARD_ASPECTS[0];
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const lines: string[] = [];

  const pushParagraph = (para: string) => {
    const words = para.split(' ');
    let current = '';

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        current = candidate;
      } else {
        if (current) {
          lines.push(current);
          current = '';
        }
        // Handle single very long word cleanly
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
  };

  for (const p of paragraphs) {
    pushParagraph(p);
  }

  if (lines.length <= maxLines) {
    return lines;
  }

  const trimmed = lines.slice(0, maxLines);
  let last = trimmed[trimmed.length - 1];
  while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
    last = last.slice(0, -1).trimEnd();
  }
  trimmed[trimmed.length - 1] = `${last}…`;
  return trimmed;
}

function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function isMostlyLatinScript(text: string): boolean {
  const nonSpace = text.replace(/\s+/g, '');
  if (!nonSpace.length) return true;
  const latinCount = (nonSpace.match(/[A-Za-z0-9\u00C0-\u024F.,;:'"!?()\-—–]/g) ?? []).length;
  return latinCount / nonSpace.length > 0.72;
}

/**
 * Renders a high-resolution, print/social-ready editorial quote card onto the supplied HTMLCanvasElement.
 */
export async function renderHighlightCardCanvas(
  canvas: HTMLCanvasElement,
  payload: ShareQuotePayload,
  options: QuoteCardOptions
): Promise<void> {
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch {
      // proceed with loaded fonts
    }
  }

  const aspect = getAspectSpec(options.aspect);
  const theme = getThemeSpec(options.theme);
  const langOption = getLanguageOption(payload.lang);
  const isRtl = Boolean(langOption.rtl);

  const W = aspect.width;
  const H = aspect.height;
  canvas.width = W;
  canvas.height = H;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Accent hue respects highlight swatch on light/dark themes when chosen, else theme default
  const accentColor = payload.highlightColor
    ? theme.isDark
      ? HIGHLIGHT_ACCENT_DARK[payload.highlightColor]
      : HIGHLIGHT_ACCENT_LIGHT[payload.highlightColor]
    : theme.accent;

  // 1. Background Surface & Subtle Archival Depth Gradient
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, theme.bg);
  grad.addColorStop(1, theme.bgAccent);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Subtle deterministic paper grain dots for tactile archival feel
  ctx.save();
  ctx.fillStyle = theme.isDark ? 'rgba(255,255,255,0.018)' : 'rgba(28,25,23,0.022)';
  const grainStep = 28;
  for (let gx = 16; gx < W; gx += grainStep) {
    for (let gy = 16; gy < H; gy += grainStep) {
      const jitterX = ((gx * 13 + gy * 7) % 11) - 5;
      const jitterY = ((gx * 5 + gy * 17) % 11) - 5;
      ctx.fillRect(gx + jitterX, gy + jitterY, 1.5, 1.5);
    }
  }
  ctx.restore();

  // 2. Outer Gallery Hairline Framing
  const isWide = options.aspect === 'wide';
  const isStory = options.aspect === 'story';
  const frameInset = isWide ? 34 : 44;
  const padX = isWide ? 82 : isStory ? 92 : 96;
  const padTop = isWide ? 64 : isStory ? 128 : 96;
  const padBottom = isWide ? 60 : isStory ? 120 : 88;
  const contentWidth = W - padX * 2;

  ctx.save();
  ctx.strokeStyle = theme.frame;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(frameInset, frameInset, W - frameInset * 2, H - frameInset * 2);
  ctx.restore();

  // 3. Top Archival Header Strip (Book Edition / Language / Page Meta)
  let topCursorY = padTop;
  ctx.save();
  ctx.direction = 'ltr';
  ctx.textBaseline = 'top';
  const headerFontSize = isWide ? 18 : 22;
  ctx.font = `600 ${headerFontSize}px "Plus Jakarta Sans", sans-serif`;
  ctx.fillStyle = theme.muted;

  const metaParts: string[] = [];
  if (options.showPageMeta) {
    if (payload.chapterTitle) {
      const shortCh =
        payload.chapterTitle.length > 40
          ? `${payload.chapterTitle.slice(0, 38).trim()}…`
          : payload.chapterTitle;
      metaParts.push(shortCh);
    }
    metaParts.push(`Page ${payload.pageNumber}`);
  }
  metaParts.push(langOption.name);
  const topMetaLabel = metaParts.join('  ·  ');

  ctx.textAlign = 'left';
  ctx.fillText(topMetaLabel, padX, topCursorY);

  // Subtle horizontal rule under header
  const ruleY = topCursorY + headerFontSize + (isWide ? 16 : 22);
  ctx.strokeStyle = theme.frame;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padX, ruleY);
  ctx.lineTo(W - padX, ruleY);
  ctx.stroke();

  // Short accent register mark aligned to left of rule
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(padX, ruleY);
  ctx.lineTo(padX + (isWide ? 56 : 72), ruleY);
  ctx.stroke();
  ctx.restore();

  const quoteRegionTop = ruleY + (isWide ? 24 : isStory ? 72 : 44);

  // 4. Reserve Footer Height (Cover + Title/Author + Colophon)
  const coverImg =
    options.showCover && payload.coverDataUrl ? await loadImage(payload.coverDataUrl) : null;
  const footerHeight = isWide ? 104 : isStory ? 164 : 136;
  const footerTopY = H - padBottom - footerHeight;

  // 5. Measure & Auto-Fit Quote Body + Optional Personal Note inside [quoteRegionTop, footerTopY]
  const cleanQuote = payload.quoteText.trim() || 'Select a passage to create a shareable highlight card.';
  const cleanNote = options.showNote && payload.note?.trim() ? payload.note.trim() : '';

  const quoteFontFamily = isMostlyLatinScript(cleanQuote)
    ? '"Fraunces", Georgia, serif'
    : langOption.canvasFont;

  const availHeight = Math.max(180, footerTopY - quoteRegionTop - (isWide ? 24 : 36));
  const noteReservedHeight = cleanNote ? (isWide ? 78 : 114) : 0;
  const quoteMaxHeight = Math.max(120, availHeight - noteReservedHeight);

  // Opening typographic quotation mark
  const glyphSize = isWide ? 64 : isStory ? 104 : 88;
  const glyphAdvance = isWide ? 36 : isStory ? 60 : 50;

  // Dynamic font size selection so short & long quotes both feel balanced
  const startSize = isWide ? 38 : isStory ? 54 : 48;
  const minSize = isWide ? 22 : 27;
  let chosenSize = minSize;
  let chosenLineHeight = minSize * 1.5;
  let quoteLines: string[] = [];

  for (let size = startSize; size >= minSize; size -= 2) {
    const lineH = Math.round(size * (isMostlyLatinScript(cleanQuote) ? 1.44 : 1.62));
    const maxLinesFit = Math.max(2, Math.floor((quoteMaxHeight - glyphAdvance) / lineH));
    ctx.font = `500 ${size}px ${quoteFontFamily}`;
    const wrapped = wrapLines(ctx, cleanQuote, contentWidth, maxLinesFit + 1);
    if (wrapped.length <= maxLinesFit) {
      chosenSize = size;
      chosenLineHeight = lineH;
      quoteLines = wrapped;
      break;
    }
    if (size === minSize) {
      chosenSize = minSize;
      chosenLineHeight = lineH;
      quoteLines = wrapLines(ctx, cleanQuote, contentWidth, maxLinesFit);
    }
  }

  // Measure optional study note
  const noteFontSize = isWide ? 18 : 22;
  const noteLineH = Math.round(noteFontSize * 1.5);
  let noteLines: string[] = [];
  let noteBoxH = 0;
  if (cleanNote) {
    ctx.font = `400 ${noteFontSize}px "Plus Jakarta Sans", ${langOption.canvasFont}`;
    noteLines = wrapLines(ctx, cleanNote, contentWidth - 40, isWide ? 2 : 3);
    noteBoxH = noteLines.length * noteLineH + 34;
  }

  const totalTextBlockH =
    glyphAdvance + quoteLines.length * chosenLineHeight + (noteLines.length > 0 ? 28 + noteBoxH : 0);
  const blockStartY =
    quoteRegionTop + Math.max(0, Math.round((availHeight - totalTextBlockH) / 2));

  // Draw oversized opening quotation mark
  ctx.save();
  ctx.font = `600 ${glyphSize}px "Fraunces", Georgia, serif`;
  ctx.fillStyle = accentColor;
  ctx.textBaseline = 'top';
  ctx.textAlign = isRtl ? 'right' : 'left';
  ctx.fillText(isRtl ? '”' : '“', isRtl ? W - padX : padX, blockStartY - (isWide ? 14 : 20));
  ctx.restore();

  // Draw Quote Lines
  ctx.save();
  ctx.direction = isRtl ? 'rtl' : 'ltr';
  ctx.textAlign = isRtl ? 'right' : 'left';
  ctx.textBaseline = 'top';
  ctx.font = `500 ${chosenSize}px ${quoteFontFamily}`;
  ctx.fillStyle = theme.text;

  let textY = blockStartY + glyphAdvance;
  const textAnchorX = isRtl ? W - padX : padX;
  for (const line of quoteLines) {
    ctx.fillText(line, textAnchorX, textY);
    textY += chosenLineHeight;
  }
  ctx.restore();

  // Draw Optional Personal Study Note Card
  if (noteLines.length > 0) {
    const noteY = textY + 24;
    ctx.save();
    drawRoundedRectPath(ctx, padX, noteY, contentWidth, noteBoxH, 8);
    ctx.fillStyle = theme.noteBg;
    ctx.fill();
    ctx.strokeStyle = theme.frame;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.direction = 'ltr';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `400 ${noteFontSize}px "Plus Jakarta Sans", ${langOption.canvasFont}`;
    ctx.fillStyle = theme.muted;

    let ny = noteY + 17;
    for (const nl of noteLines) {
      ctx.fillText(nl, padX + 20, ny);
      ny += noteLineH;
    }
    ctx.restore();
  }

  // 6. Footer Hairline Divider + Book Attribution + Cover Thumbnail
  ctx.save();
  ctx.strokeStyle = theme.frame;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padX, footerTopY);
  ctx.lineTo(W - padX, footerTopY);
  ctx.stroke();

  const footerContentY = footerTopY + (isWide ? 22 : 28);
  let metaLeftX = padX;

  if (coverImg) {
    const thumbH = isWide ? 74 : isStory ? 112 : 96;
    const ratio = coverImg.width / Math.max(1, coverImg.height);
    const thumbW = Math.round(Math.max(46, Math.min(thumbH * 0.82, thumbH * ratio)));

    ctx.save();
    drawRoundedRectPath(ctx, padX, footerContentY, thumbW, thumbH, 4);
    ctx.clip();
    ctx.drawImage(coverImg, padX, footerContentY, thumbW, thumbH);
    ctx.restore();

    ctx.save();
    drawRoundedRectPath(ctx, padX, footerContentY, thumbW, thumbH, 4);
    ctx.strokeStyle = theme.frame;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();

    metaLeftX = padX + thumbW + (isWide ? 20 : 26);
  }

  const colophonWidth = options.showWatermark ? (isWide ? 175 : 200) : 0;
  const titleMaxW = Math.max(180, W - padX - metaLeftX - colophonWidth);

  const titleSize = isWide ? 24 : 28;
  const authorSize = isWide ? 18 : 21;

  ctx.direction = 'ltr';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = `600 ${titleSize}px "Fraunces", Georgia, serif`;
  ctx.fillStyle = theme.text;
  const titleLines = wrapLines(ctx, payload.bookTitle, titleMaxW, 2);

  let metaY = footerContentY + (coverImg ? 4 : 0);
  for (const tl of titleLines) {
    ctx.fillText(tl, metaLeftX, metaY);
    metaY += Math.round(titleSize * 1.28);
  }

  if (payload.author?.trim()) {
    ctx.font = `400 ${authorSize}px "Plus Jakarta Sans", sans-serif`;
    ctx.fillStyle = theme.muted;
    const authorLines = wrapLines(ctx, payload.author.trim(), titleMaxW, 1);
    if (authorLines[0]) {
      ctx.fillText(authorLines[0], metaLeftX, metaY + 4);
    }
  }

  // Quiet Brand Colophon on right edge of footer
  if (options.showWatermark) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.font = `600 ${isWide ? 20 : 24}px "Fraunces", Georgia, serif`;
    ctx.fillStyle = theme.text;
    ctx.fillText('BhashaBook', W - padX, footerContentY + 6);

    ctx.font = `500 ${isWide ? 13 : 15}px "Plus Jakarta Sans", sans-serif`;
    ctx.fillStyle = theme.muted;
    ctx.fillText('Bilingual Reader', W - padX, footerContentY + (isWide ? 32 : 38));
  }
  ctx.restore();
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Could not export highlight image card.'));
      },
      'image/png',
      1.0
    );
  });
}
