import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type {
  BookCategory,
  BookFormatFilter,
  BookSortBy,
  ChapterSummaryResult,
  DiscoveredBook,
  LanguageCode,
  StoredBook,
  TranslatedPageRecord,
} from '../types';
import { downloadBlob } from './translatorClient';

export interface SearchBooksParams {
  query: string;
  category: BookCategory;
  lang: string;
  format: BookFormatFilter;
  sort: BookSortBy;
  page?: number;
  signal?: AbortSignal;
}

export interface SearchBooksResponse {
  query: string;
  page: number;
  total: number;
  sources: {
    internetArchive: number;
    openLibrary: number;
    gutenberg: number;
    arxiv?: number;
  };
  books: DiscoveredBook[];
}

const CLIENT_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const clientSearchCache = new Map<string, { data: SearchBooksResponse; expiresAt: number }>();

export async function searchGlobalBooks(params: SearchBooksParams): Promise<SearchBooksResponse> {
  const qs = new URLSearchParams();
  if (params.query.trim()) qs.set('q', params.query.trim());
  qs.set('category', params.category);
  qs.set('lang', params.lang);
  qs.set('format', params.format);
  qs.set('sort', params.sort);
  qs.set('page', String(params.page ?? 1));

  const cacheKey = qs.toString();
  const cached = clientSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const res = await fetch(`/api/books/search?${cacheKey}`, {
    signal: params.signal,
  });
  if (!res.ok) {
    let msg = `Search failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  const data = (await res.json()) as SearchBooksResponse;
  if (data.books && data.books.length > 0) {
    if (clientSearchCache.size >= 80) {
      const oldest = clientSearchCache.keys().next().value;
      if (oldest !== undefined) clientSearchCache.delete(oldest);
    }
    clientSearchCache.set(cacheKey, {
      data,
      expiresAt: Date.now() + CLIENT_SEARCH_CACHE_TTL_MS,
    });
  }
  return data;
}

export interface ResolvedArchiveBook {
  identifier: string;
  pdfUrl?: string;
  pdfSize?: number;
  textUrl?: string;
  pageCount?: number;
  description?: string;
}

export async function resolveArchiveMetadata(identifier: string): Promise<ResolvedArchiveBook> {
  const res = await fetch(`/api/books/resolve?identifier=${encodeURIComponent(identifier)}`);
  if (!res.ok) {
    throw new Error('Could not resolve book download links.');
  }
  return (await res.json()) as ResolvedArchiveBook;
}

// Sanitize text for WinAnsi StandardFonts inside pdf-lib so Gutenberg Unicode quotes/dashes never crash PDF building
function toWinAnsiSafe(input: string): string {
  return input
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

/**
 * Converts a public-domain plain-text e-book (e.g., Project Gutenberg) into a clean,
 * paginated, cover-preserved PDF ArrayBuffer right in the browser so it works natively
 * across Reader, Translator, Audiobook, Annotator, and Export PDF.
 */
async function buildPdfFromPlainText(
  book: DiscoveredBook,
  rawText: string,
  onStatus?: (msg: string) => void
): Promise<ArrayBuffer> {
  onStatus?.('Typesetting book pages & cover into PDF…');
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(toWinAnsiSafe(book.title));
  pdfDoc.setAuthor(toWinAnsiSafe(book.author));

  const titleFont = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const bodyFont = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const metaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const pageW = 432; // Classic 6 x 9 in book trim
  const pageH = 648;

  // Page 1: High-resolution cover art (fetched via safe proxy) OR archival typographic cover
  const coverPage = pdfDoc.addPage([pageW, pageH]);
  let embeddedCover = false;
  if (book.coverUrl) {
    try {
      const imgRes = await fetch(`/api/books/proxy-cover?url=${encodeURIComponent(book.coverUrl)}`);
      if (imgRes.ok) {
        const ct = (imgRes.headers.get('content-type') || '').toLowerCase();
        const bytes = new Uint8Array(await imgRes.arrayBuffer());
        const img = ct.includes('png') ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
        const scale = Math.min((pageW - 48) / img.width, (pageH - 72) / img.height);
        const drawW = img.width * scale;
        const drawH = img.height * scale;
        coverPage.drawRectangle({ x: 0, y: 0, width: pageW, height: pageH, color: rgb(0.97, 0.96, 0.94) });
        coverPage.drawImage(img, {
          x: (pageW - drawW) / 2,
          y: (pageH - drawH) / 2,
          width: drawW,
          height: drawH,
        });
        embeddedCover = true;
      }
    } catch {
      // Fallback to typographic cover below
    }
  }

  if (!embeddedCover) {
    coverPage.drawRectangle({ x: 0, y: 0, width: pageW, height: pageH, color: rgb(0.97, 0.95, 0.91) });
    coverPage.drawRectangle({
      x: 28,
      y: 28,
      width: pageW - 56,
      height: pageH - 56,
      borderColor: rgb(0.6, 0.25, 0.08),
      borderWidth: 1.5,
    });

    const safeTitle = toWinAnsiSafe(book.title);
    const words = safeTitle.split(/\s+/);
    const titleLines: string[] = [];
    let curr = '';
    for (const w of words) {
      const next = curr ? `${curr} ${w}` : w;
      if (titleFont.widthOfTextAtSize(next, 24) > pageW - 96 && curr) {
        titleLines.push(curr);
        curr = w;
      } else {
        curr = next;
      }
    }
    if (curr) titleLines.push(curr);

    let y = pageH - 180;
    for (const line of titleLines.slice(0, 5)) {
      const lw = titleFont.widthOfTextAtSize(line, 24);
      coverPage.drawText(line, {
        x: (pageW - lw) / 2,
        y,
        size: 24,
        font: titleFont,
        color: rgb(0.11, 0.1, 0.09),
      });
      y -= 32;
    }

    const safeAuthor = toWinAnsiSafe(book.author);
    const aw = bodyFont.widthOfTextAtSize(safeAuthor, 14);
    coverPage.drawText(safeAuthor, {
      x: Math.max(40, (pageW - aw) / 2),
      y: y - 24,
      size: 14,
      font: bodyFont,
      color: rgb(0.42, 0.38, 0.34),
    });

    const footerLabel = `Public Domain Edition · ${book.source === 'gutenberg' ? 'Project Gutenberg' : 'Open Archive'}`;
    const fw = metaFont.widthOfTextAtSize(footerLabel, 9);
    coverPage.drawText(footerLabel, {
      x: (pageW - fw) / 2,
      y: 62,
      size: 9,
      font: metaFont,
      color: rgb(0.45, 0.43, 0.4),
    });
  }

  // Paginate body paragraphs cleanly (cap at 180 pages for instant browser responsiveness)
  const paragraphs = toWinAnsiSafe(rawText)
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);

  const marginX = 42;
  const marginTop = 48;
  const marginBottom = 46;
  const maxWidth = pageW - marginX * 2;
  const MAX_CONTENT_PAGES = 180;

  let page = pdfDoc.addPage([pageW, pageH]);
  let cursorY = pageH - marginTop;
  let pageCount = 1;

  const ensureSpace = (needed: number): boolean => {
    if (cursorY - needed < marginBottom) {
      if (pageCount >= MAX_CONTENT_PAGES) return false;
      page = pdfDoc.addPage([pageW, pageH]);
      cursorY = pageH - marginTop;
      pageCount++;
    }
    return true;
  };

  for (const para of paragraphs) {
    const isHeading =
      para.length < 75 &&
      (/^(?:CHAPTER|BOOK|PART|SECTION|ACT|SCENE)\s+[IVXLCDM0-9]+/i.test(para) ||
        /^[A-Z0-9\s.:-]{5,}$/.test(para));

    const font = isHeading ? titleFont : bodyFont;
    const size = isHeading ? 14 : 10.5;
    const lineHeight = isHeading ? 19 : 14.5;

    if (isHeading && cursorY < pageH - marginTop - 24) {
      cursorY -= 10;
    }

    const words = para.split(/\s+/);
    let line = '';
    const wrapped: string[] = [];
    for (const w of words) {
      const candidate = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
        wrapped.push(line);
        line = w;
      } else {
        line = candidate;
      }
    }
    if (line) wrapped.push(line);

    for (const ln of wrapped) {
      if (!ensureSpace(lineHeight)) break;
      page.drawText(ln, {
        x: marginX,
        y: cursorY,
        size,
        font,
        color: rgb(0.12, 0.11, 0.1),
      });
      cursorY -= lineHeight;
    }

    cursorY -= isHeading ? 10 : 7;
    if (pageCount >= MAX_CONTENT_PAGES && cursorY < marginBottom + 20) break;
  }

  const bytes = await pdfDoc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Fetches an external discovered book (Internet Archive PDF, Open Library IA PDF,
 * or Project Gutenberg plain-text e-book) and returns a ready-to-load PDF ArrayBuffer.
 */
export async function fetchExternalBookAsPdfBuffer(
  book: DiscoveredBook,
  onStatus?: (message: string) => void
): Promise<{ buffer: ArrayBuffer; fileName: string }> {
  const safeSlug =
    book.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'ebook';
  const fileName = `${safeSlug}.pdf`;

  let pdfUrl = book.pdfUrl;
  let textUrl = book.textUrl;

  // For Internet Archive, Open Library IA, and Archive-mirrored Gutenberg entries, resolve the exact real PDF/text filename
  if (
    (book.source === 'internet_archive' ||
      (book.source === 'open_library' && book.pdfUrl) ||
      book.id.startsWith('gutenberg-ia:')) &&
    book.identifier &&
    !book.identifier.startsWith('/works/')
  ) {
    onStatus?.('Resolving open-access PDF file from Internet Archive…');
    try {
      const resolved = await resolveArchiveMetadata(book.identifier);
      if (resolved.pdfUrl) pdfUrl = resolved.pdfUrl;
      if (resolved.textUrl) textUrl = resolved.textUrl;
    } catch {
      // Fall back to existing pdfUrl/textUrl
    }
  }

  // Path A: Stream genuine PDF directly through safe proxy (with 35s timeout guard)
  if (pdfUrl) {
    onStatus?.(
      book.source === 'arxiv'
        ? 'Downloading open-access PDF from arXiv…'
        : 'Downloading PDF stream…'
    );
    const pdfController = new AbortController();
    const pdfTimer = window.setTimeout(() => pdfController.abort(), 35000);
    let res: Response | null = null;
    try {
      res = await fetch(`/api/books/proxy-pdf?url=${encodeURIComponent(pdfUrl)}`, {
        signal: pdfController.signal,
      });
    } catch {
      res = null;
    } finally {
      window.clearTimeout(pdfTimer);
    }

    if (res && res.ok) {
      const buffer = await res.arrayBuffer();
      return { buffer, fileName };
    }

    // If PDF wasn't open-downloadable or timed out and we have a plain-text fallback, seamlessly convert text!
    if (!textUrl) {
      let msg = res
        ? `Could not download PDF (${res.status}).`
        : 'PDF download timed out on this source. Try another edition or format.';
      if (res) {
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) msg = body.error;
        } catch {
          // ignore
        }
      }
      throw new Error(msg);
    }
  }

  // Path B: Fetch Project Gutenberg / Archive plain-text e-book & build a crisp cover-preserved PDF
  if (textUrl) {
    onStatus?.('Fetching full public-domain book text…');
    const txtController = new AbortController();
    const txtTimer = window.setTimeout(() => txtController.abort(), 25000);
    let res: Response;
    try {
      res = await fetch(`/api/books/fetch-text?url=${encodeURIComponent(textUrl)}`, {
        signal: txtController.signal,
      });
    } finally {
      window.clearTimeout(txtTimer);
    }
    if (!res.ok) {
      let msg = `Could not download book text (${res.status}).`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) msg = body.error;
      } catch {
        // ignore
      }
      throw new Error(msg);
    }
    const data = (await res.json()) as { text?: string };
    if (!data.text || data.text.trim().length < 40) {
      throw new Error('Downloaded book text was empty.');
    }
    const buffer = await buildPdfFromPlainText(book, data.text, onStatus);
    return { buffer, fileName };
  }

  throw new Error(
    'This edition could not be streamed directly right now. Try another edition of this book from the search results.'
  );
}

export async function summarizeChapterApi(params: {
  chapterTitle: string;
  text: string;
  targetLang: LanguageCode;
  signal?: AbortSignal;
}): Promise<ChapterSummaryResult> {
  const res = await fetch('/api/summarize-chapter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chapterTitle: params.chapterTitle,
      text: params.text,
      targetLang: params.targetLang,
    }),
    signal: params.signal,
  });

  if (!res.ok) {
    let msg = `Summary failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return (await res.json()) as ChapterSummaryResult;
}

/**
 * Exports all text highlights, attached study notes, PDF sticky notes, and bookmarked pages
 * for a book into a clean downloadable Markdown summary sheet.
 */
export function exportHighlightsSummarySheet(
  book: StoredBook,
  translatedPages: TranslatedPageRecord[],
  targetLangName: string
): { exportedCount: number; fileName: string } {
  const lines: string[] = [];
  lines.push(`# Study Summary & Highlights — ${book.title}`);
  if (book.author) lines.push(`**Author:** ${book.author}`);
  lines.push(`**Language:** ${targetLangName}  |  **Exported:** ${new Date().toLocaleDateString()}`);
  lines.push('');

  const bookmarks = [...(book.bookmarks ?? [])].sort((a, b) => a - b);
  if (bookmarks.length > 0) {
    lines.push('## Bookmarked Pages');
    for (const pg of bookmarks) {
      const ch = book.chapters.find((c) => pg >= c.startPage && pg <= c.endPage);
      lines.push(`- **Page ${pg}**${ch ? ` — ${ch.title}` : ''}`);
    }
    lines.push('');
  }

  let totalItems = bookmarks.length;
  const pagesWithHighlights = translatedPages
    .filter((p) => (p.highlights?.length ?? 0) > 0)
    .sort((a, b) => a.pageNumber - b.pageNumber);

  if (pagesWithHighlights.length > 0) {
    lines.push('## Highlighted Passages & Notes');
    lines.push('');
    for (const pg of pagesWithHighlights) {
      const ch = book.chapters.find((c) => pg.pageNumber >= c.startPage && pg.pageNumber <= c.endPage);
      lines.push(`### Page ${pg.pageNumber}${ch ? ` — ${ch.title}` : ''}`);
      for (const hl of pg.highlights ?? []) {
        totalItems++;
        const colorTag =
          hl.color === 'amber'
            ? 'Gold'
            : hl.color === 'sage'
            ? 'Green'
            : hl.color === 'sky'
            ? 'Blue'
            : 'Pink';
        lines.push(`> "${hl.selectedText}" _[${colorTag}]_`);
        if (hl.note?.trim()) {
          lines.push(`- **Note:** ${hl.note.trim()}`);
        }
        lines.push('');
      }
    }
  }

  const pdfNotePages = Object.entries(book.annotations ?? {})
    .map(([p, layer]) => ({ page: Number(p), notes: layer.notes ?? [] }))
    .filter((entry) => entry.notes.length > 0)
    .sort((a, b) => a.page - b.page);

  if (pdfNotePages.length > 0) {
    lines.push('## PDF Margin Sticky Notes');
    lines.push('');
    for (const entry of pdfNotePages) {
      lines.push(`### Page ${entry.page}`);
      for (const note of entry.notes) {
        totalItems++;
        lines.push(`- ${note.text}`);
      }
      lines.push('');
    }
  }

  if (totalItems === 0) {
    lines.push('_No highlights, sticky notes, or bookmarks have been saved for this book yet._');
  }

  const slug =
    book.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 42) || 'book';
  const fileName = `${slug}-highlights-summary.md`;
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  downloadBlob(blob, fileName);

  return { exportedCount: totalItems, fileName };
}
