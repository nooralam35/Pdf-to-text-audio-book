import React, { useRef } from 'react';
import {
  BookOpen,
  CheckCircle2,
  Clock,
  CloudOff,
  CloudUpload,
  RefreshCw,
  Upload,
} from 'lucide-react';
import type { ServiceWorkerStatus } from '../lib/offlineCache';

export type ActiveTab = 'discover' | 'reader' | 'library' | 'export';

export interface LibrarySyncStatusInfo {
  swStatus: ServiceWorkerStatus;
  isOnline: boolean;
  totalBooks: number;
  cachedBooks: number;
  isSyncing: boolean;
  onSyncAction: () => void;
}

interface TopBarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  onUploadPdf: (file: File) => void;
  isUploading?: boolean;
  librarySync?: LibrarySyncStatusInfo;
}

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  onSelectTab,
  onUploadPdf,
  isUploading = false,
  librarySync,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onUploadPdf(file);
    }
    e.target.value = '';
  };

  const navItems: Array<{ id: ActiveTab; label: string }> = [
    { id: 'discover', label: 'Discover' },
    { id: 'reader', label: 'Reader' },
    { id: 'library', label: 'Library' },
    { id: 'export', label: 'Export PDF' },
  ];

  // Derive clear, accessible library sync state from Service Worker & offline cache status
  const syncVisual = (() => {
    if (!librarySync) return null;
    const { swStatus, isOnline, totalBooks, cachedBooks, isSyncing } = librarySync;
    const pendingBooks = Math.max(0, totalBooks - cachedBooks);

    if (isSyncing) {
      return {
        shortLabel: 'Syncing…',
        fullLabel: 'Syncing Library…',
        tooltip: 'Caching library books and reader assets via Service Worker for offline access.',
        toneClass:
          'border-amber-300/80 sepia:border-[#C9B387] dark:border-amber-700/70 bg-amber-50/80 sepia:bg-[#EDE1C5] dark:bg-amber-950/30 text-amber-900 sepia:text-[#6B3A10] dark:text-amber-300',
        Icon: RefreshCw,
        spin: true,
      };
    }

    if (swStatus === 'registering') {
      return {
        shortLabel: 'Pending',
        fullLabel: 'Sync Pending',
        tooltip: 'Offline Service Worker is initializing. Library sync will verify shortly.',
        toneClass:
          'border-amber-300/80 sepia:border-[#C9B387] dark:border-amber-700/70 bg-amber-50/70 sepia:bg-[#EDE1C5] dark:bg-amber-950/25 text-amber-900 sepia:text-[#6B3A10] dark:text-amber-300',
        Icon: Clock,
        spin: false,
      };
    }

    if (swStatus === 'error' || swStatus === 'unsupported') {
      return {
        shortLabel: swStatus === 'error' ? 'Sync Issue' : 'Local Only',
        fullLabel: swStatus === 'error' ? 'Sync Pending' : 'Browser Storage',
        tooltip:
          swStatus === 'error'
            ? `Service Worker registration encountered an issue (${cachedBooks}/${totalBooks} books stored locally). Click to inspect Library.`
            : `Service Worker unavailable in this browser (${cachedBooks}/${totalBooks} books stored locally). Click to inspect Library.`,
        toneClass:
          'border-stone-300 sepia:border-[#D4C6AA] dark:border-stone-700 bg-stone-100/80 sepia:bg-[#EAE0C8] dark:bg-stone-900 text-stone-700 sepia:text-[#5C4936] dark:text-stone-300',
        Icon: CloudOff,
        spin: false,
      };
    }

    // swStatus === 'active'
    if (pendingBooks > 0) {
      return {
        shortLabel: `Pending · ${pendingBooks}`,
        fullLabel: `Sync Pending (${pendingBooks})`,
        tooltip: isOnline
          ? `${cachedBooks} of ${totalBooks} library books synced offline. Click to sync the remaining ${pendingBooks} ${
              pendingBooks === 1 ? 'book' : 'books'
            }.`
          : `Offline: ${cachedBooks} of ${totalBooks} library books synced. Reconnect to sync ${pendingBooks} pending ${
              pendingBooks === 1 ? 'book' : 'books'
            }.`,
        toneClass:
          'border-amber-300 sepia:border-[#C9B387] dark:border-amber-700/80 bg-amber-50/85 sepia:bg-[#EFE2C6] dark:bg-amber-950/35 text-amber-900 sepia:text-[#6B3A10] dark:text-amber-300 hover:bg-amber-100/80 dark:hover:bg-amber-900/40',
        Icon: CloudUpload,
        spin: false,
      };
    }

    return {
      shortLabel: 'Synced',
      fullLabel: totalBooks > 0 ? 'Library Synced' : 'Offline Ready',
      tooltip:
        totalBooks > 0
          ? `Service Worker active — all ${totalBooks} library ${
              totalBooks === 1 ? 'book is' : 'books are'
            } synced for offline reading. Click to view Library.`
          : 'Service Worker active and ready to sync library books for offline reading.',
      toneClass:
        'border-emerald-300/80 sepia:border-[#A9C2A8] dark:border-emerald-800/80 bg-emerald-50/75 sepia:bg-[#E7EBD8] dark:bg-emerald-950/30 text-emerald-800 sepia:text-[#2A593C] dark:text-emerald-300 hover:bg-emerald-100/70 dark:hover:bg-emerald-900/35',
      Icon: CheckCircle2,
      spin: false,
    };
  })();

  return (
    <header className="no-print sticky top-0 z-30 w-full border-b border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-[#FAF9F5]/95 sepia:bg-[#F4ECD8]/95 dark:bg-[#0D0D0C]/95 backdrop-blur-sm">
      <div className="max-w-[1680px] mx-auto px-3 sm:px-6 h-12 md:h-14 flex items-center justify-between gap-2 sm:gap-4">
        {/* Zone 1: Brand Wordmark */}
        <button
          type="button"
          onClick={() => onSelectTab('discover')}
          className="flex items-center gap-2 text-stone-900 sepia:text-[#2E241A] dark:text-stone-100 whitespace-nowrap shrink-0 focus:outline-none group cursor-pointer"
        >
          <BookOpen className="w-5 h-5 text-amber-700 dark:text-amber-500 transition-transform group-hover:scale-105" />
          <span className="font-display text-base sm:text-lg font-semibold tracking-tight">
            BhashaBook
          </span>
        </button>

        {/* Zone 2: Primary Navigation (Desktop inline) */}
        <nav aria-label="Main navigation" className="hidden md:flex items-center gap-6">
          {navItems.map((item) => {
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

        {/* Zone 3: Library Sync Indicator & Primary Upload Action */}
        <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
          {syncVisual && librarySync && (
            <button
              type="button"
              onClick={librarySync.onSyncAction}
              disabled={librarySync.isSyncing}
              title={syncVisual.tooltip}
              aria-label={syncVisual.tooltip}
              aria-live="polite"
              className={`inline-flex items-center gap-1.5 h-8 md:h-9 px-2 sm:px-2.5 rounded-md border text-[11px] sm:text-xs font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer disabled:cursor-wait ${syncVisual.toneClass}`}
            >
              <syncVisual.Icon
                className={`w-3.5 h-3.5 shrink-0 ${syncVisual.spin ? 'animate-spin' : ''}`}
              />
              <span className="sm:hidden tabular-nums">{syncVisual.shortLabel}</span>
              <span className="hidden sm:inline tabular-nums">{syncVisual.fullLabel}</span>
            </button>
          )}

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
            onClick={() => fileInputRef.current?.click()}
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
        {navItems.map((item) => {
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
