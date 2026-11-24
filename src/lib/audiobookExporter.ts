import JSZip from 'jszip';
import { getLanguageOption } from './languages';
import {
  buildAudiobookText,
  fetchFreeTtsBlob,
  synthesizePageAudio,
} from './translatorClient';
import type {
  ChapterItem,
  LanguageCode,
  StoredBook,
  TranslatedPageRecord,
} from '../types';

export interface TranslatedChapterAudioEntry {
  trackNumber: number;
  chapter: ChapterItem;
  translatedPages: TranslatedPageRecord[];
  totalChapterPages: number;
  scriptText: string;
  wordCount: number;
}

export interface AudiobookZipProgress {
  chapterIndex: number;
  totalChapters: number;
  chapterTitle: string;
  chunkIndex: number;
  totalChunks: number;
  overallPercent: number;
  status: string;
}

export interface ExportAudiobookZipOptions {
  book: StoredBook;
  translatedPages: TranslatedPageRecord[];
  targetLang: LanguageCode;
  useAiVoice?: boolean;
  aiVoiceName?: string;
  includeTranscripts?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: AudiobookZipProgress) => void;
}

export interface ExportAudiobookZipResult {
  blob: Blob;
  fileName: string;
  chapterCount: number;
  audioExt: 'mp3' | 'wav';
}

function slugifyFilePart(input: string, maxLen = 42): string {
  const ascii = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
  return ascii || 'chapter';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Splits a chapter's full translated script into synthesis-safe chunks at natural
 * sentence/paragraph boundaries so full multi-page chapters synthesize smoothly.
 */
function splitChapterTextForSynthesis(text: string, maxLen: number): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  const chunks: string[] = [];
  let remaining = cleaned;

  while (remaining.length > maxLen) {
    let cut = -1;
    const minCut = Math.floor(maxLen * 0.45);
    for (let i = maxLen; i >= minCut; i--) {
      if (/[.!?।۔؟\n]/.test(remaining[i])) {
        cut = i + 1;
        break;
      }
    }
    if (cut === -1) {
      const spaceIdx = remaining.lastIndexOf(' ', maxLen);
      cut = spaceIdx > 40 ? spaceIdx : maxLen;
    }
    const piece = remaining.slice(0, cut).trim();
    if (piece) chunks.push(piece);
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Merges multiple WAV blobs (sharing PCM format) into a single valid RIFF/WAVE file.
 * Falls back to raw concatenation if a chunk does not carry a standard RIFF header.
 */
async function mergeWavBlobs(blobs: Blob[]): Promise<Blob> {
  if (blobs.length === 1) return blobs[0];
  const buffers = await Promise.all(blobs.map((b) => b.arrayBuffer()));
  const pcmChunks: Uint8Array[] = [];
  let headerBytes: Uint8Array | null = null;

  for (const buf of buffers) {
    const view = new DataView(buf);
    const isRiff =
      buf.byteLength > 44 &&
      view.getUint32(0, false) === 0x52494646 && // "RIFF"
      view.getUint32(8, false) === 0x57415645; // "WAVE"

    if (!isRiff) {
      return new Blob(buffers, { type: 'audio/wav' });
    }

    // Locate the "data" subchunk offset cleanly
    let offset = 12;
    let dataStart = 44;
    let dataLength = buf.byteLength - 44;
    while (offset + 8 <= buf.byteLength) {
      const chunkId = view.getUint32(offset, false);
      const chunkSize = view.getUint32(offset + 4, true);
      if (chunkId === 0x64617461) {
        // "data"
        dataStart = offset + 8;
        dataLength = Math.min(chunkSize, buf.byteLength - dataStart);
        break;
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }

    if (!headerBytes) {
      headerBytes = new Uint8Array(buf.slice(0, dataStart));
    }
    pcmChunks.push(new Uint8Array(buf, dataStart, Math.max(0, dataLength)));
  }

  if (!headerBytes) {
    return new Blob(buffers, { type: 'audio/wav' });
  }

  const totalPcmLen = pcmChunks.reduce((sum, arr) => sum + arr.byteLength, 0);
  const out = new Uint8Array(headerBytes.byteLength + totalPcmLen);
  out.set(headerBytes, 0);

  let writeOffset = headerBytes.byteLength;
  for (const chunk of pcmChunks) {
    out.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }

  const outView = new DataView(out.buffer);
  // Update RIFF chunk size (fileSize - 8) and "data" subchunk size
  outView.setUint32(4, out.byteLength - 8, true);
  outView.setUint32(headerBytes.byteLength - 4, totalPcmLen, true);

  return new Blob([out], { type: 'audio/wav' });
}

async function fetchFreeTtsWithRetry(
  chunkText: string,
  targetLang: LanguageCode,
  signal?: AbortSignal,
  maxAttempts = 3
): Promise<Blob> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Audiobook export cancelled.', 'AbortError');
    }
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, attempt * 1500));
    }
    try {
      return await fetchFreeTtsBlob(chunkText, targetLang, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Speech synthesis failed for audio chunk.');
}

/**
 * Groups translated pages by the book's detected chapters, returning all chapters
 * that have speakable translated content ready for audiobook ZIP generation.
 */
export function collectTranslatedChaptersForAudio(
  book: StoredBook,
  translatedPages: TranslatedPageRecord[]
): TranslatedChapterAudioEntry[] {
  const sortedPages = [...translatedPages].sort((a, b) => a.pageNumber - b.pageNumber);
  if (sortedPages.length === 0) return [];

  const entries: TranslatedChapterAudioEntry[] = [];
  const usedPageNums = new Set<number>();

  for (const ch of book.chapters) {
    const chPages = sortedPages.filter(
      (p) => p.pageNumber >= ch.startPage && p.pageNumber <= ch.endPage
    );
    if (chPages.length === 0) continue;

    const pageTexts = chPages
      .map((p) => buildAudiobookText(p).trim())
      .filter((t) => t.length > 0);
    if (pageTexts.length === 0) continue;

    for (const p of chPages) usedPageNums.add(p.pageNumber);

    const scriptText = `${ch.title}.\n\n${pageTexts.join('\n\n')}`;
    const wordCount = scriptText.split(/\s+/).filter(Boolean).length;

    entries.push({
      trackNumber: entries.length + 1,
      chapter: ch,
      translatedPages: chPages,
      totalChapterPages: Math.max(1, ch.endPage - ch.startPage + 1),
      scriptText,
      wordCount,
    });
  }

  // Fallback for books without chapter metadata or translated pages outside chapter bounds
  const orphanPages = sortedPages.filter((p) => !usedPageNums.has(p.pageNumber));
  if (orphanPages.length > 0) {
    const orphanTexts = orphanPages
      .map((p) => buildAudiobookText(p).trim())
      .filter((t) => t.length > 0);
    if (orphanTexts.length > 0) {
      const firstPage = orphanPages[0].pageNumber;
      const lastPage = orphanPages[orphanPages.length - 1].pageNumber;
      const syntheticChapter: ChapterItem = {
        id: 'ch-additional',
        index: entries.length + 1,
        title: entries.length === 0 ? book.title : `Additional Pages (p.${firstPage}-${lastPage})`,
        startPage: firstPage,
        endPage: lastPage,
      };
      const scriptText = orphanTexts.join('\n\n');
      entries.push({
        trackNumber: entries.length + 1,
        chapter: syntheticChapter,
        translatedPages: orphanPages,
        totalChapterPages: orphanPages.length,
        scriptText,
        wordCount: scriptText.split(/\s+/).filter(Boolean).length,
      });
    }
  }

  return entries;
}

/**
 * Generates a downloadable ZIP archive containing one audio file per translated chapter,
 * an M3U playlist for continuous playback, and optional plain-text chapter transcripts.
 */
export async function exportAudiobookZip(
  options: ExportAudiobookZipOptions
): Promise<ExportAudiobookZipResult> {
  const {
    book,
    translatedPages,
    targetLang,
    useAiVoice = false,
    aiVoiceName = 'Kore',
    includeTranscripts = true,
    signal,
    onProgress,
  } = options;

  const langOption = getLanguageOption(targetLang);
  const chapterEntries = collectTranslatedChaptersForAudio(book, translatedPages);

  if (chapterEntries.length === 0) {
    throw new Error(
      'No translated chapter text found. Translate at least one page before exporting an audiobook.'
    );
  }

  const chunkLimit = useAiVoice ? 3000 : 1050;
  const chapterPlans = chapterEntries.map((entry) => ({
    entry,
    chunks: splitChapterTextForSynthesis(entry.scriptText, chunkLimit),
  }));

  const totalWorkUnits = Math.max(
    1,
    chapterPlans.reduce((sum, p) => sum + p.chunks.length, 0)
  );
  let completedWorkUnits = 0;

  const zip = new JSZip();
  const trackNames: string[] = [];
  const manifestLines: string[] = [
    `${book.title}`,
    book.author ? `Author: ${book.author}` : '',
    `Language: ${langOption.name} (${langOption.nativeName})`,
    `Translated Chapters Included: ${chapterEntries.length}`,
    '',
    'Tracklist:',
  ].filter((line, idx) => line !== '' || idx > 2);

  let detectedExt: 'mp3' | 'wav' = 'mp3';

  for (let cIdx = 0; cIdx < chapterPlans.length; cIdx++) {
    if (signal?.aborted) {
      throw new DOMException('Audiobook export cancelled.', 'AbortError');
    }

    const { entry, chunks } = chapterPlans[cIdx];
    const trackPrefix = pad2(entry.trackNumber);
    const cleanSlug = slugifyFilePart(entry.chapter.title);
    const audioParts: Blob[] = [];
    let chapterExt: 'mp3' | 'wav' = 'mp3';

    for (let k = 0; k < chunks.length; k++) {
      if (signal?.aborted) {
        throw new DOMException('Audiobook export cancelled.', 'AbortError');
      }

      onProgress?.({
        chapterIndex: cIdx + 1,
        totalChapters: chapterPlans.length,
        chapterTitle: entry.chapter.title,
        chunkIndex: k + 1,
        totalChunks: chunks.length,
        overallPercent: Math.min(96, Math.round((completedWorkUnits / totalWorkUnits) * 95)),
        status: `Synthesizing Ch. ${cIdx + 1}/${chapterPlans.length}: ${entry.chapter.title} (part ${k + 1}/${chunks.length})…`,
      });

      if (useAiVoice) {
        const res = await synthesizePageAudio({
          text: chunks[k],
          voiceName: aiVoiceName,
          languageName: langOption.name,
          targetLang,
        });
        chapterExt = res.ext;
        audioParts.push(res.blob);
      } else {
        const mp3Blob = await fetchFreeTtsWithRetry(chunks[k], targetLang, signal, 3);
        chapterExt = 'mp3';
        audioParts.push(mp3Blob);
      }

      completedWorkUnits++;
    }

    detectedExt = chapterExt;
    const chapterAudioBlob =
      chapterExt === 'wav'
        ? await mergeWavBlobs(audioParts)
        : new Blob(audioParts, { type: 'audio/mpeg' });

    const audioFileName = `${trackPrefix}-${cleanSlug}.${chapterExt}`;
    // Audio streams are already compressed (MP3) — STORE is dramatically faster
    zip.file(audioFileName, chapterAudioBlob, {
      compression: chapterExt === 'mp3' ? 'STORE' : 'DEFLATE',
    });

    trackNames.push(audioFileName);
    manifestLines.push(
      `${trackPrefix}. ${entry.chapter.title} (${entry.translatedPages.length}/${entry.totalChapterPages} pages translated) -> ${audioFileName}`
    );

    if (includeTranscripts) {
      zip.file(`scripts/${trackPrefix}-${cleanSlug}.txt`, entry.scriptText, {
        compression: 'DEFLATE',
      });
    }
  }

  if (signal?.aborted) {
    throw new DOMException('Audiobook export cancelled.', 'AbortError');
  }

  onProgress?.({
    chapterIndex: chapterPlans.length,
    totalChapters: chapterPlans.length,
    chapterTitle: 'Packaging ZIP',
    chunkIndex: 1,
    totalChunks: 1,
    overallPercent: 98,
    status: `Packaging ${chapterPlans.length} chapter audio files into ZIP archive…`,
  });

  // Add standard M3U playlist so users can play all chapters sequentially in any player
  const m3uLines = ['#EXTM3U'];
  chapterEntries.forEach((entry, i) => {
    m3uLines.push(`#EXTINF:-1,${entry.chapter.title}`);
    m3uLines.push(trackNames[i]);
  });
  zip.file('playlist.m3u', m3uLines.join('\n'), { compression: 'DEFLATE' });
  zip.file('00-tracklist.txt', manifestLines.join('\n'), { compression: 'DEFLATE' });

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  const bookSlug = slugifyFilePart(book.title, 36);
  const fileName = `${bookSlug}-${targetLang}-audiobook.zip`;

  onProgress?.({
    chapterIndex: chapterPlans.length,
    totalChapters: chapterPlans.length,
    chapterTitle: 'Complete',
    chunkIndex: 1,
    totalChunks: 1,
    overallPercent: 100,
    status: 'Audiobook ZIP ready!',
  });

  return {
    blob: zipBlob,
    fileName,
    chapterCount: chapterPlans.length,
    audioExt: detectedExt,
  };
}
