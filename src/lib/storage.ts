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
}

let dbPromise: Promise<IDBPDatabase<BhashaBookDB>> | null = null;

function getDb(): Promise<IDBPDatabase<BhashaBookDB>> {
  if (!dbPromise) {
    dbPromise = openDB<BhashaBookDB>('bhashabook-offline-v1', 2, {
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
      },
    });
  }
  return dbPromise;
}

export function makeTranslationKey(bookId: string, lang: LanguageCode, pageNumber: number): string {
  return `${bookId}::${lang}::${pageNumber}`;
}

export async function saveBook(book: StoredBook): Promise<void> {
  const db = await getDb();
  await db.put('books', book);
}

export async function getBook(bookId: string): Promise<StoredBook | undefined> {
  const db = await getDb();
  return db.get('books', bookId);
}

export async function listBooks(): Promise<StoredBook[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex('books', 'by-added');
  return all.reverse();
}

export async function updateBookLastPage(bookId: string, lastPage: number): Promise<void> {
  const db = await getDb();
  const existing = await db.get('books', bookId);
  if (existing) {
    existing.lastPage = lastPage;
    await db.put('books', existing);
  }
}

export async function toggleBookBookmark(
  bookId: string,
  pageNumber: number
): Promise<StoredBook | undefined> {
  const db = await getDb();
  const existing = await db.get('books', bookId);
  if (!existing) return undefined;
  const current = new Set<number>(existing.bookmarks ?? []);
  if (current.has(pageNumber)) {
    current.delete(pageNumber);
  } else {
    current.add(pageNumber);
  }
  existing.bookmarks = Array.from(current).sort((a, b) => a - b);
  await db.put('books', existing);
  return existing;
}

export async function deleteBook(bookId: string): Promise<void> {
  const db = await getDb();
  await db.delete('books', bookId);

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
  const db = await getDb();
  const book = await db.get('books', bookId);
  if (!book) return undefined;

  const nextAnnotations: Record<number, PageAnnotationLayer> = {
    ...(book.annotations ?? {}),
  };

  if (layer.strokes.length === 0 && layer.notes.length === 0) {
    delete nextAnnotations[pageNumber];
  } else {
    nextAnnotations[pageNumber] = layer;
  }

  book.annotations = nextAnnotations;
  await db.put('books', book);

  // Also keep standalone annotations store synced for fast lookups
  await db.put('annotations', {
    key: makeAnnotationKey(bookId, pageNumber),
    bookId,
    pageNumber,
    ...layer,
  });

  return book;
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

