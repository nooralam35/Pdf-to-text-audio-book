import React, { useCallback, useRef } from 'react';
import { BookOpen, Upload } from 'lucide-react';
import { openDevDebugPanel } from '../lib/devErrorLog';

export type ActiveTab = 'discover' | 'reader' | 'library' | 'export';

interface TopBarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  onUploadPdf: (file: File) => void;
  isUploading?: boolean;
}

const NAV_ITEMS: Array<{ id: ActiveTab; label: string }> = [
  { id: 'discover', label: 'Discover' },
  { id: 'reader', label: 'Reader' },
  { id: 'library', label: 'Library' },
  { id: 'export', label: 'Export PDF' },
];

const TopBarInner: React.FC<TopBarProps> = ({
  activeTab,
  onSelectTab,
  onUploadPdf,
  isUploading = false,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const devTapStateRef = useRef<{ count: number; lastTapAt: number }>({
    count: 0,
    lastTapAt: 0,
  });
  const devHoldTimerRef = useRef<number | null>(null);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        onUploadPdf(file);
      }
      e.target.value = '';
    },
    [onUploadPdf]
  );

  const handleBrandClick = useCallback(() => {
    if (import.meta.env.DEV) {
      const now = Date.now();
      const prev = devTapStateRef.current;
      const nextCount = now - prev.lastTapAt < 1500 ? prev.count + 1 : 1;
      devTapStateRef.current = { count: nextCount, lastTapAt: now };
      if (nextCount >= 5) {
        devTapStateRef.current = { count: 0, lastTapAt: 0 };
        openDevDebugPanel();
        return;
      }
    }
    onSelectTab('discover');
  }, [onSelectTab]);

  const handleBrandPointerDown = useCallback(() => {
    if (!import.meta.env.DEV) return;
    if (devHoldTimerRef.current !== null) {
      window.clearTimeout(devHoldTimerRef.current);
    }
    devHoldTimerRef.current = window.setTimeout(() => {
      devHoldTimerRef.current = null;
      openDevDebugPanel();
    }, 700);
  }, []);

  const clearBrandHold = useCallback(() => {
    if (devHoldTimerRef.current !== null) {
      window.clearTimeout(devHoldTimerRef.current);
      devHoldTimerRef.current = null;
    }
  }, []);

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  return (
    <header className="no-print sticky top-0 z-30 w-full border-b border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-[#FAF9F5] sepia:bg-[#F4ECD8] dark:bg-[#0D0D0C]">
      <div className="max-w-[1680px] mx-auto px-3 sm:px-6 h-12 md:h-14 flex items-center justify-between gap-2 sm:gap-4">
        {/* Zone 1: Brand Wordmark */}
        <button
          type="button"
          onClick={handleBrandClick}
          onPointerDown={handleBrandPointerDown}
          onPointerUp={clearBrandHold}
          onPointerCancel={clearBrandHold}
          onPointerLeave={clearBrandHold}
          className="flex items-center gap-2 text-stone-900 sepia:text-[#2E241A] dark:text-stone-100 whitespace-nowrap shrink-0 focus:outline-none group cursor-pointer"
        >
          <BookOpen className="w-5 h-5 text-amber-700 dark:text-amber-500 transition-transform group-hover:scale-105" />
          <span className="font-display text-base sm:text-lg font-semibold tracking-tight">
            BhashaBook
          </span>
        </button>

        {/* Zone 2: Primary Navigation (Desktop inline) */}
        <nav aria-label="Main navigation" className="hidden md:flex items-center gap-6">
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`relative h-14 px-1 inline-flex items-center text-sm font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                  isActive
                    ? 'text-stone-950 dark:text-stone-50'
                    : 'text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'
                }`}
              >
                {item.label}
                {isActive && (
                  <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-amber-700 dark:bg-amber-500" />
                )}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Direct Upload Action */}
        <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            type="button"
            disabled={isUploading}
            onClick={handleUploadClick}
            className="inline-flex items-center gap-1.5 sm:gap-2 h-8 md:h-9 px-2.5 sm:px-3.5 rounded-md text-xs sm:text-sm font-medium whitespace-nowrap shrink-0 bg-stone-900 text-stone-50 hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-stone-200 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            <span className="sm:hidden">{isUploading ? 'Loading…' : 'Upload'}</span>
            <span className="hidden sm:inline">{isUploading ? 'Loading…' : 'Upload PDF'}</span>
          </button>
        </div>
      </div>

      {/* Mobile Full-Width 4-Tab Navigation Row (< md, zero horizontal overflow) */}
      <nav
        aria-label="Mobile navigation"
        className="md:hidden grid grid-cols-4 border-t border-stone-200/80 sepia:border-[#DFD4BC] dark:border-stone-800"
      >
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              className={`relative h-10 px-1 inline-flex items-center justify-center text-xs font-medium truncate transition-colors cursor-pointer ${
                isActive
                  ? 'text-stone-950 dark:text-stone-50'
                  : 'text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-200'
              }`}
            >
              <span className="truncate">{item.label}</span>
              {isActive && (
                <span className="absolute bottom-0 left-1 right-1 h-[2px] bg-amber-700 dark:bg-amber-500" />
              )}
            </button>
          );
        })}
      </nav>
    </header>
  );
};

export const TopBar = React.memo(TopBarInner);
