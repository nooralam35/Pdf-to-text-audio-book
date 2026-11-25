import React, { useMemo, useRef, useState } from 'react';
import { BookOpen, Compass, HardDrive, Search, Trash2, Upload, X } from 'lucide-react';
import { PRELOADED_OBS_BOOK_ID } from '../lib/languages';
import type { StoredBook } from '../types';

interface LibraryViewProps {
  books: StoredBook[];
  activeBookId: string | null;
  translatedCountsByBook: Record<string, number>;
  onSelectBook: (book: StoredBook) => void;
  onUploadPdf: (file: File) => void;
  onDeleteBook: (bookId: string) => void;
  onGoToDiscover?: () => void;
  isUploading: boolean;
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  books,
  activeBookId,
  translatedCountsByBook,
  onSelectBook,
  onUploadPdf,
  onDeleteBook,
  onGoToDiscover,
  isUploading,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const filteredBooks = useMemo(() => {
    const trimmed = searchQuery.trim().toLowerCase();
    if (!trimmed) return books;
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    return books.filter((book) => {
      const haystack = `${book.title ?? ''} ${book.author ?? ''}`.toLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
  }, [books, searchQuery]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.name.toLowerCase().endsWith('.pdf')) {
      onUploadPdf(file);
    }
  };

  const hasQuery = searchQuery.trim().length > 0;

  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-stone-200 dark:border-stone-800 pb-5">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-semibold tracking-tight text-stone-950 dark:text-stone-50">
            Book Library & Offline Shelf
          </h1>
          <p className="mt-1.5 text-sm text-stone-600 dark:text-stone-400">
            Books and translated pages are cached locally in IndexedDB for instant offline reading
            and audiobook playback.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="inline-flex items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400 font-mono-num">
            <HardDrive className="w-3.5 h-3.5" />
            <span>{books.length} {books.length === 1 ? 'book' : 'books'} cached</span>
          </div>
          {onGoToDiscover && (
            <button
              type="button"
              onClick={onGoToDiscover}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-stone-300 dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#191816] text-xs font-medium text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer whitespace-nowrap"
            >
              <Compass className="w-3.5 h-3.5 text-amber-700 dark:text-amber-500" />
              <span>Discover Free Books</span>
            </button>
          )}
        </div>
      </div>

      {/* Drag & Drop Upload Zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`rounded-lg border border-dashed p-6 sm:p-8 text-center transition-colors ${
          isDragging
            ? 'border-amber-700 bg-amber-50/60 dark:border-amber-500 dark:bg-amber-950/20'
            : 'border-stone-300 dark:border-stone-700 bg-white dark:bg-[#191816]'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUploadPdf(f);
            e.target.value = '';
          }}
          className="hidden"
        />
        <Upload className="w-6 h-6 mx-auto text-amber-700 dark:text-amber-500" />
        <p className="mt-3 text-sm font-medium text-stone-900 dark:text-stone-100">
          Drop any illustrated technical guidebook or PDF here (supports 200+ pages)
        </p>
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
          Automatically extracts chapters, embedded screenshots, and Page 1 cover art directly in your browser.
        </p>
        <button
          type="button"
          disabled={isUploading}
          onClick={() => fileInputRef.current?.click()}
          className="mt-4 inline-flex items-center gap-2 h-9 px-4 rounded-md text-sm font-medium bg-stone-900 text-stone-50 hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-stone-200 disabled:opacity-50 cursor-pointer"
        >
          {isUploading ? 'Parsing PDF & Detecting Chapters…' : 'Choose PDF File'}
        </button>
      </div>

      {/* Search & Filter Bar */}
      {books.length > 0 && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-md">
            <Search
              aria-hidden="true"
              className="w-4 h-4 text-stone-400 dark:text-stone-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && searchQuery) {
                  setSearchQuery('');
                }
              }}
              placeholder="Search books by title or author…"
              aria-label="Filter library books by title or author"
              className="w-full h-10 pl-9 pr-9 rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#191816] text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:outline-none focus:border-amber-700 dark:focus:border-amber-500 transition-colors"
            />
            {hasQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear book search"
                className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 inline-flex items-center justify-center rounded text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <p className="text-xs font-mono-num text-stone-500 dark:text-stone-400">
            {hasQuery
              ? `Showing ${filteredBooks.length} of ${books.length} ${
                  books.length === 1 ? 'book' : 'books'
                }`
              : `${books.length} ${books.length === 1 ? 'book' : 'books'} in shelf`}
          </p>
        </div>
      )}

      {/* Empty Search Results State */}
      {books.length > 0 && filteredBooks.length === 0 ? (
        <div className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-[#191816] px-6 py-12 text-center">
          <Search className="w-6 h-6 mx-auto text-stone-400 dark:text-stone-500" />
          <p className="mt-3 text-sm font-medium text-stone-900 dark:text-stone-100">
            No books match “{searchQuery.trim()}”
          </p>
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            Try searching with a different title keyword or author name.
          </p>
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            className="mt-4 inline-flex items-center gap-1.5 h-8 px-3.5 rounded text-xs font-medium border border-stone-300 dark:border-stone-700 text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
            <span>Clear Search</span>
          </button>
        </div>
      ) : (
        /* Books Grid */
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredBooks.map((book) => {
            const isCurrent = book.id === activeBookId;
            const translatedCount = translatedCountsByBook[book.id] ?? 0;
            const isPreloaded = book.id === PRELOADED_OBS_BOOK_ID;

            return (
              <article
                key={book.id}
                className={`flex flex-col rounded-lg border overflow-hidden bg-white dark:bg-[#191816] transition-colors ${
                  isCurrent
                    ? 'border-amber-700/70 dark:border-amber-500/70'
                    : 'border-stone-200 dark:border-stone-800'
                }`}
              >
                {/* Original Cover Thumbnail */}
                <div className="h-56 bg-[#F1EFEA] dark:bg-[#131211] p-4 flex items-center justify-center border-b border-stone-200/80 dark:border-stone-800/80">
                  {book.coverDataUrl ? (
                    <img
                      src={book.coverDataUrl}
                      alt={`${book.title} cover`}
                      className="h-full w-auto object-contain rounded-[2px] shadow-[0_6px_20px_rgba(28,25,23,0.16)] border border-stone-200 dark:border-stone-700"
                    />
                  ) : (
                    <BookOpen className="w-10 h-10 text-stone-400" />
                  )}
                </div>

                {/* Book Details */}
                <div className="p-4 flex-1 flex flex-col">
                  <h2 className="font-display text-base font-semibold leading-snug text-stone-950 dark:text-stone-50 line-clamp-2">
                    {book.title}
                  </h2>
                  {book.author && (
                    <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400 truncate">
                      {book.author}
                    </p>
                  )}

                  <p className="mt-3 text-xs text-stone-500 dark:text-stone-400 font-mono-num">
                    {book.numPages} pages · {book.chapters.length} chapters · {translatedCount}{' '}
                    translated
                    {book.bookmarks && book.bookmarks.length > 0
                      ? ` · ${book.bookmarks.length} bookmarked`
                      : ''}
                    {book.annotations && Object.keys(book.annotations).length > 0
                      ? ` · ${Object.keys(book.annotations).length} annotated`
                      : ''}
                  </p>

                  {/* Continue Reading Progress Bar */}
                  {(() => {
                    const lastPg = Math.max(1, Math.min(book.numPages, book.lastPage || 1));
                    const pct = Math.max(
                      1,
                      Math.min(100, Math.round((lastPg / Math.max(1, book.numPages)) * 100))
                    );
                    return (
                      <div className="mt-3 space-y-1">
                        <div className="flex items-center justify-between text-[11px] text-stone-500 dark:text-stone-400 font-mono-num">
                          <span>Page {lastPg} of {book.numPages}</span>
                          <span>{pct}% read</span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-stone-200 dark:bg-stone-800 overflow-hidden">
                          <div
                            className="h-full bg-amber-700 dark:bg-amber-500 transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })()}

                  <div className="mt-4 pt-3 border-t border-stone-200/80 dark:border-stone-800/80 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => onSelectBook(book)}
                      className="inline-flex items-center gap-1.5 h-8 px-3 rounded text-xs font-medium bg-stone-900 text-stone-50 hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-stone-200 cursor-pointer"
                    >
                      <BookOpen className="w-3.5 h-3.5" />
                      <span>{isCurrent || (book.lastPage ?? 1) > 1 ? 'Continue Reading' : 'Open Reader'}</span>
                    </button>

                    {!isPreloaded && (
                      confirmDeleteId === book.id ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              onDeleteBook(book.id);
                              setConfirmDeleteId(null);
                            }}
                            className="text-xs font-medium text-red-700 dark:text-red-400 hover:underline cursor-pointer"
                          >
                            Remove
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="text-xs text-stone-500 hover:underline cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(book.id)}
                          aria-label={`Remove ${book.title}`}
                          className="p-1.5 rounded text-stone-400 hover:text-red-700 dark:hover:text-red-400 cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
};
