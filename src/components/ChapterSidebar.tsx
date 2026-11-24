import React, { useMemo, useState } from 'react';
import {
  BookMarked,
  Check,
  Languages,
  Loader2,
  Pause,
  Play,
  Search,
  Volume2,
  X,
} from 'lucide-react';
import type { ChapterItem } from '../types';

interface ChapterSidebarProps {
  bookTitle: string;
  numPages: number;
  chapters: ChapterItem[];
  currentPage: number;
  translatedPageNumbers: Set<number>;
  isSpeaking: boolean;
  isPreparingAudio?: boolean;
  onSelectPage: (page: number) => void;
  onPlayChapterAudio: (chapter: ChapterItem) => void;
  onTranslateChapter: (chapter: ChapterItem) => void;
  isBatchTranslating: boolean;
  onCloseMobile?: () => void;
}

export const ChapterSidebar: React.FC<ChapterSidebarProps> = ({
  bookTitle,
  numPages,
  chapters,
  currentPage,
  translatedPageNumbers,
  isSpeaking,
  isPreparingAudio = false,
  onSelectPage,
  onPlayChapterAudio,
  onTranslateChapter,
  isBatchTranslating,
  onCloseMobile,
}) => {
  const [query, setQuery] = useState('');

  const filteredChapters = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chapters;
    return chapters.filter(
      (ch) =>
        ch.title.toLowerCase().includes(q) ||
        String(ch.index).includes(q) ||
        String(ch.startPage).includes(q)
    );
  }, [chapters, query]);

  const totalTranslated = translatedPageNumbers.size;

  return (
    <aside className="flex flex-col h-full bg-[#F5F3EE] dark:bg-[#161513] border-r border-stone-200 dark:border-stone-800">
      {/* Header */}
      <div className="px-4 py-3.5 border-b border-stone-200 dark:border-stone-800">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-medium text-stone-500 dark:text-stone-400">
              <BookMarked className="w-3.5 h-3.5 text-amber-700 dark:text-amber-500 shrink-0" />
              <span className="uppercase tracking-wider">Contents</span>
            </div>
            <h2
              className="mt-1 font-display text-sm font-semibold text-stone-900 dark:text-stone-100 truncate"
              title={bookTitle}
            >
              {bookTitle}
            </h2>
            <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400 font-mono-num">
              {chapters.length} sections · {totalTranslated}/{numPages} translated
            </p>
          </div>
          {onCloseMobile && (
            <button
              type="button"
              onClick={onCloseMobile}
              aria-label="Close chapters"
              className="p-2 -mr-1 text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Search chapters */}
        <div className="mt-3 relative">
          <Search className="w-3.5 h-3.5 text-stone-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter chapters…"
            className="w-full h-8 pl-8 pr-2.5 text-xs rounded-md bg-white dark:bg-[#1F1E1B] border border-stone-200 dark:border-stone-700 text-stone-900 dark:text-stone-100 placeholder:text-stone-400 focus:outline-none focus:border-amber-700 dark:focus:border-amber-500"
          />
        </div>
      </div>

      {/* Chapter List */}
      <div className="flex-1 overflow-y-auto divide-y divide-stone-200/70 dark:divide-stone-800/70">
        {filteredChapters.length === 0 ? (
          <div className="px-4 py-8 text-xs text-stone-500 dark:text-stone-400 text-center">
            No matching chapters found.
          </div>
        ) : (
          filteredChapters.map((ch) => {
            const isActive = currentPage >= ch.startPage && currentPage <= ch.endPage;
            const isThisChapterPlaying = isActive && isSpeaking;
            const isThisChapterPreparing = isActive && isPreparingAudio && !isSpeaking;
            const pageCount = Math.max(1, ch.endPage - ch.startPage + 1);
            let doneCount = 0;
            for (let p = ch.startPage; p <= ch.endPage; p++) {
              if (translatedPageNumbers.has(p)) doneCount++;
            }
            const isComplete = doneCount === pageCount;

            return (
              <div
                key={ch.id}
                className={`group px-3.5 py-2.5 transition-colors ${
                  isActive
                    ? 'bg-white dark:bg-[#22201D]'
                    : 'hover:bg-stone-200/40 dark:hover:bg-stone-800/40'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      onSelectPage(ch.startPage);
                      onCloseMobile?.();
                    }}
                    className="flex-1 text-left min-w-0 cursor-pointer"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono-num text-[11px] text-stone-400 dark:text-stone-500 shrink-0 w-5">
                        {ch.index === 0 ? '—' : String(ch.index).padStart(2, '0')}
                      </span>
                      <span
                        className={`text-[13px] leading-snug ${
                          isActive
                            ? 'font-semibold text-amber-800 dark:text-amber-400'
                            : 'font-medium text-stone-800 dark:text-stone-200'
                        }`}
                      >
                        {ch.title}
                      </span>
                    </div>
                    <div className="mt-1 pl-7 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-stone-500 dark:text-stone-400 font-mono-num">
                      <span>
                        p.{ch.startPage}
                        {ch.endPage > ch.startPage ? `–${ch.endPage}` : ''}
                      </span>
                      <span>·</span>
                      <span className={isComplete ? 'text-emerald-700 dark:text-emerald-400' : ''}>
                        {isComplete ? (
                          <span className="inline-flex items-center gap-0.5">
                            <Check className="w-3 h-3" /> {doneCount}/{pageCount}
                          </span>
                        ) : (
                          `${doneCount}/${pageCount} done`
                        )}
                      </span>
                      {isThisChapterPlaying && (
                        <>
                          <span>·</span>
                          <span className="inline-flex items-center gap-1 font-sans font-medium text-amber-700 dark:text-amber-400">
                            <Volume2 className="w-3 h-3 animate-pulse" />
                            Playing
                          </span>
                        </>
                      )}
                    </div>
                  </button>

                  {/* Chapter Action Buttons: Audio Player + Fast Translate */}
                  <div className="flex items-center gap-1 shrink-0 pt-0.5">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onPlayChapterAudio(ch);
                      }}
                      aria-label={
                        isThisChapterPlaying
                          ? `Pause audio for ${ch.title}`
                          : `Play audio for ${ch.title}`
                      }
                      title={
                        isThisChapterPlaying
                          ? `Pause "${ch.title}" audio`
                          : `Listen to "${ch.title}" audio`
                      }
                      className={`h-7 w-7 inline-flex items-center justify-center rounded-md border transition-colors cursor-pointer ${
                        isThisChapterPlaying
                          ? 'border-amber-700 bg-amber-700 text-white hover:bg-amber-800'
                          : isThisChapterPreparing
                          ? 'border-amber-600/50 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400'
                          : 'border-stone-300/80 dark:border-stone-700 bg-white dark:bg-[#1F1E1B] text-stone-700 dark:text-stone-200 hover:border-amber-700 hover:text-amber-800 dark:hover:border-amber-500 dark:hover:text-amber-400'
                      }`}
                    >
                      {isThisChapterPreparing ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : isThisChapterPlaying ? (
                        <Pause className="w-3.5 h-3.5" />
                      ) : (
                        <Play className="w-3.5 h-3.5 translate-x-[0.5px]" />
                      )}
                    </button>

                    <button
                      type="button"
                      disabled={isBatchTranslating}
                      onClick={(e) => {
                        e.stopPropagation();
                        onTranslateChapter(ch);
                      }}
                      aria-label={`Translate ${ch.title}`}
                      title={`Fast-translate all ${pageCount} pages of "${ch.title}"`}
                      className="h-7 w-7 inline-flex items-center justify-center rounded-md text-stone-500 hover:text-amber-800 dark:text-stone-400 dark:hover:text-amber-400 hover:bg-stone-200/70 dark:hover:bg-stone-700/60 transition-colors disabled:opacity-30 cursor-pointer"
                    >
                      <Languages className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
};

