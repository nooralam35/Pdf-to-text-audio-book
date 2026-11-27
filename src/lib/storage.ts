import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  LanguageCode,
  PageAnnotationLayer,
  PageAnnotationRecord,
  ParsedPage,
  StoredBook,
  TranslatedPageRecord,
} from '../types';

interface BhashaBookDB extends DBSchema {
  books: {
    key: string;
    value: StoredBook;
    indexes: { 'by-added': number };
  };
  translations: {
    key: string; // `${bookId}::${lang}::${pageNumber}`
    value: TranslatedPageRecord;
    indexes: { 'by-book-lang': [string, LanguageCode] };
  };
  parsedPages: {
    key: string; // `${bookId}::${pageNumber}`
    value: {
      key: string;
      bookId: string;
      pageNumber: number;
      page: ParsedPage;
      updatedAt: number;
    };
  };
  annotations: {
    key: string; // `${bookId}::${pageNumber}`
    value: PageAnnotationRecord;
    indexes: { 'by-book': string };
  };
  bookBinaries: {
    key: string; // bookId
    value: {
      bookId: string;
      pdfData: ArrayBuffer;
      updatedAt: number;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<BhashaBookDB>> | null = null;

function getDb(): Promise<IDBPDatabase<BhashaBookDB>> {
  if (!dbPromise) {
    dbPromise = openDB<BhashaBookDB>('bhashabook-offline-v1', 3, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const bookStore = db.createObjectStore('books', { keyPath: 'id' });
          bookStore.createIndex('by-added', 'addedAt');

          const trStore = db.createObjectStore('translations', { keyPath: 'key' });
          trStore.createIndex('by-book-lang', ['bookId', 'lang']);

          db.createObjectStore('parsedPages', { keyPath: 'key' });
        }
        if (oldVersion < 2) {
          const annStore = db.createObjectStore('annotations', { keyPath: 'key' });
          annStore.createIndex('by-book', 'bookId');
        }
        if (oldVersion < 3) {
          if (!db.objectStoreNames.contains('bookBinaries')) {
            db.createObjectStore('bookBinaries', { keyPath: 'bookId' });
          }
        }
      },
    });
  }
  return dbPromise;
}

export function makeTranslationKey(bookId: string, lang: LanguageCode, pageNumber: number): string {
  return `${bookId}::${lang}::${pageNumber}`;
}

export function stripBookBinary(book: StoredBook): StoredBook {
  const hasLocal = Boolean(book.hasLocalPdf || (book.pdfData && book.pdfData.byteLength > 0));
  if (!book.pdfData && book.hasLocalPdf === hasLocal) {
    return book;
  }
  return {
    ...book,
    pdfData: undefined,
    hasLocalPdf: hasLocal,
  };
}

export async function saveBook(book: StoredBook): Promise<void> {
  const db = await getDb();
  const hasBinary = Boolean(book.pdfData && book.pdfData.byteLength > 0);
  if (hasBinary && book.pdfData) {
    await db.put('bookBinaries', {
      bookId: book.id,
      pdfData: book.pdfData,
      updatedAt: Date.now(),
    });
  }
  const metadataOnly: StoredBook = stripBookBinary({
    ...book,
    hasLocalPdf: Boolean(book.hasLocalPdf || hasBinary),
  });
  await db.put('books', metadataOnly);
}

export async function getBook(bookId: string): Promise<StoredBook | undefined> {
  const db = await getDb();
  const book = await db.get('books', bookId);
  return book ? stripBookBinary(book) : undefined;
}

export async function getBookPdfData(bookId: string): Promise<ArrayBuffer | undefined> {
  const db = await getDb();
  const binaryRow = await db.get('bookBinaries', bookId);
  if (binaryRow?.pdfData && binaryRow.pdfData.byteLength > 0) {
    return binaryRow.pdfData;
  }

  // Transparently migrate any legacy inline pdfData row out of the 'books' store
  const legacyBook = await db.get('books', bookId);
  if (legacyBook?.pdfData && legacyBook.pdfData.byteLength > 0) {
    const buffer = legacyBook.pdfData;
    try {
      await db.put('bookBinaries', {
        bookId,
        pdfData: buffer,
        updatedAt: Date.now(),
      });
      await db.put('books', stripBookBinary({ ...legacyBook, hasLocalPdf: true }));
    } catch {
      // Non-fatal migration error; still return the buffer
    }
    return buffer;
  }

  return undefined;
}

export async function listBooks(): Promise<StoredBook[]> {
  const db = await getDb();
  const summaries: StoredBook[] = [];
  const tx = db.transaction('books', 'readonly');
  let cursor = await tx.store.index('by-added').openCursor();
  while (cursor) {
    summaries.push(stripBookBinary(cursor.value));
    cursor = await cursor.continue();
  }
  await tx.done;
  return summaries.sort(
    (a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt)
  );
}

export interface BookProgressPatch {
  lastPage?: number;
  lastOpenedAt?: number;
  lastAudioPage?: number;
  lastSentenceIndex?: number;
  lastNarrationSource?: 'translated' | 'original';
  lastTargetLang?: LanguageCode;
  isBookmarked?: boolean;
  bookmarkedAt?: number;
}

const bookWriteQueues = new Map<string, Promise<unknown>>();

function withBookWriteLock<T>(bookId: string, fn: () => Promise<T>): Promise<T> {
  const previous = bookWriteQueues.get(bookId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  const cleanup = next.finally(() => {
    if (bookWriteQueues.get(bookId) === cleanup) {
      bookWriteQueues.delete(bookId);
    }
  });
  bookWriteQueues.set(bookId, cleanup);
  return next;
}

async function mutateBookMetadata(
  bookId: string,
  mutator: (cleanExisting: StoredBook) => StoredBook
): Promise<StoredBook | undefined> {
  return withBookWriteLock(bookId, async () => {
    const db = await getDb();
    const raw = await db.get('books', bookId);
    if (!raw) return undefined;

    // If a legacy row still carries inline pdfData, migrate it safely before writing metadata
    if (raw.pdfData && raw.pdfData.byteLength > 0) {
      await db.put('bookBinaries', {
        bookId,
        pdfData: raw.pdfData,
        updatedAt: Date.now(),
      });
    }

    const cleanExisting = stripBookBinary(raw);
    const updated = stripBookBinary(mutator(cleanExisting));
    await db.put('books', updated);
    return updated;
  });
}

export async function updateBookProgress(
  bookId: string,
  patch: BookProgressPatch
): Promise<StoredBook | undefined> {
  return mutateBookMetadata(bookId, (existing) => ({
    ...existing,
    ...patch,
  }));
}

export async function updateBookLastPage(bookId: string, lastPage: number): Promise<void> {
  await updateBookProgress(bookId, { lastPage, lastOpenedAt: Date.now() });
}

export async function toggleBookSavedBookmark(
  bookId: string
): Promise<StoredBook | undefined> {
  return mutateBookMetadata(bookId, (existing) => {
    const nextBookmarked = !existing.isBookmarked;
    return {
      ...existing,
      isBookmarked: nextBookmarked,
      bookmarkedAt: nextBookmarked ? Date.now() : undefined,
      lastOpenedAt: Date.now(),
    };
  });
}

export async function toggleBookBookmark(
  bookId: string,
  pageNumber: number
): Promise<StoredBook | undefined> {
  const safePage = Math.max(1, Math.floor(pageNumber));
  return mutateBookMetadata(bookId, (existing) => {
    const baseList = Array.isArray(existing.bookmarks)
      ? existing.bookmarks.filter((n) => typeof n === 'number' && Number.isFinite(n))
      : [];
    const current = new Set<number>(baseList);
    if (current.has(safePage)) {
      current.delete(safePage);
    } else {
      current.add(safePage);
    }
    const nextBookmarks = Array.from(current).sort((a, b) => a - b);
    return {
      ...existing,
      bookmarks: nextBookmarks,
    };
  });
}

export async function deleteBook(bookId: string): Promise<void> {
  const db = await getDb();
  await db.delete('books', bookId);
  await db.delete('bookBinaries', bookId);

  const txTr = db.transaction('translations', 'readwrite');
  let cursor = await txTr.store.openCursor();
  while (cursor) {
    if (cursor.value.bookId === bookId) {
      await cursor.delete();
    }
    cursor = await cursor.continue();
  }
  await txTr.done;

  const txPg = db.transaction('parsedPages', 'readwrite');
  let pgCursor = await txPg.store.openCursor();
  while (pgCursor) {
    if (pgCursor.value.bookId === bookId) {
      await pgCursor.delete();
    }
    pgCursor = await pgCursor.continue();
  }
  await txPg.done;

  const txAnn = db.transaction('annotations', 'readwrite');
  let annCursor = await txAnn.store.openCursor();
  while (annCursor) {
    if (annCursor.value.bookId === bookId) {
      await annCursor.delete();
    }
    annCursor = await annCursor.continue();
  }
  await txAnn.done;
}

export async function saveTranslation(record: TranslatedPageRecord): Promise<void> {
  const db = await getDb();
  await db.put('translations', record);
}

export async function getTranslation(
  bookId: string,
  lang: LanguageCode,
  pageNumber: number
): Promise<TranslatedPageRecord | undefined> {
  const db = await getDb();
  return db.get('translations', makeTranslationKey(bookId, lang, pageNumber));
}

export async function listTranslationsForBookLang(
  bookId: string,
  lang: LanguageCode
): Promise<TranslatedPageRecord[]> {
  const db = await getDb();
  const rows = await db.getAllFromIndex('translations', 'by-book-lang', [bookId, lang]);
  return rows.sort((a, b) => a.pageNumber - b.pageNumber);
}

export async function listAllTranslationCountsByBook(): Promise<Record<string, number>> {
  const db = await getDb();
  const counts: Record<string, number> = {};
  const tx = db.transaction('translations', 'readonly');
  let cursor = await tx.store.openCursor();
  while (cursor) {
    const id = cursor.value.bookId;
    counts[id] = (counts[id] ?? 0) + 1;
    cursor = await cursor.continue();
  }
  await tx.done;
  return counts;
}

export async function saveParsedPage(bookId: string, page: ParsedPage): Promise<void> {
  const db = await getDb();
  await db.put('parsedPages', {
    key: `${bookId}::${page.pageNumber}`,
    bookId,
    pageNumber: page.pageNumber,
    page,
    updatedAt: Date.now(),
  });
}

export async function getParsedPage(
  bookId: string,
  pageNumber: number
): Promise<ParsedPage | undefined> {
  const db = await getDb();
  const row = await db.get('parsedPages', `${bookId}::${pageNumber}`);
  return row?.page;
}

export async function listParsedPagesForBook(
  bookId: string
): Promise<Map<number, ParsedPage>> {
  const db = await getDb();
  const map = new Map<number, ParsedPage>();
  const tx = db.transaction('parsedPages', 'readonly');
  let cursor = await tx.store.openCursor();
  while (cursor) {
    if (cursor.value.bookId === bookId && cursor.value.page) {
      map.set(cursor.value.pageNumber, cursor.value.page);
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  return map;
}

export function makeAnnotationKey(bookId: string, pageNumber: number): string {
  return `${bookId}::${pageNumber}`;
}

export async function savePageAnnotation(record: PageAnnotationRecord): Promise<void> {
  const db = await getDb();
  await db.put('annotations', record);
}

export async function saveBookPageAnnotation(
  bookId: string,
  pageNumber: number,
  layer: PageAnnotationLayer
): Promise<StoredBook | undefined> {
  const updatedBook = await mutateBookMetadata(bookId, (existing) => {
    const nextAnnotations: Record<number, PageAnnotationLayer> = {
      ...(existing.annotations ?? {}),
    };

    if (layer.strokes.length === 0 && layer.notes.length === 0) {
      delete nextAnnotations[pageNumber];
    } else {
      nextAnnotations[pageNumber] = layer;
    }

    return {
      ...existing,
      annotations: nextAnnotations,
    };
  });

  if (!updatedBook) return undefined;

  // Also keep standalone annotations store synced for fast lookups
  const db = await getDb();
  await db.put('annotations', {
    key: makeAnnotationKey(bookId, pageNumber),
    bookId,
    pageNumber,
    ...layer,
  });

  return updatedBook;
}

export async function getBookPageAnnotation(
  bookId: string,
  pageNumber: number
): Promise<PageAnnotationLayer | undefined> {
  const db = await getDb();
  const book = await db.get('books', bookId);
  const fromBook = book?.annotations?.[pageNumber];
  if (fromBook) return fromBook;

  // Fallback to legacy standalone annotations store if present
  const legacy = await db.get('annotations', makeAnnotationKey(bookId, pageNumber));
  if (!legacy) return undefined;
  return {
    strokes: legacy.strokes ?? [],
    notes: legacy.notes ?? [],
    canvasDataUrl: legacy.canvasDataUrl,
    updatedAt: legacy.updatedAt,
  };
}

export async function listAnnotationsForBook(
  bookId: string
): Promise<PageAnnotationRecord[]> {
  const db = await getDb();
  const book = await db.get('books', bookId);
  if (book?.annotations) {
    return Object.entries(book.annotations)
      .map(([pg, layer]) => ({
        key: makeAnnotationKey(bookId, Number(pg)),
        bookId,
        pageNumber: Number(pg),
        ...layer,
      }))
      .sort((a, b) => a.pageNumber - b.pageNumber);
  }
  const rows = await db.getAllFromIndex('annotations', 'by-book', bookId);
  return rows.sort((a, b) => a.pageNumber - b.pageNumber);
}

