import React, { useRef } from 'react';
import { BookOpen, Upload } from 'lucide-react';

export type ActiveTab = 'reader' | 'library' | 'export';

interface TopBarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  onUploadPdf: (file: File) => void;
  isUploading?: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  onSelectTab,
  onUploadPdf,
  isUploading = false,
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
    { id: 'reader', label: 'Reader' },
    { id: 'library', label: 'Library' },
    { id: 'export', label: 'Export PDF' },
  ];

  return (
    <header className="no-print sticky top-0 z-30 h-14 border-b border-stone-200 dark:border-stone-800 bg-[#FAF9F5]/95 dark:bg-[#111110]/95 backdrop-blur-sm">
      <div className="h-full max-w-[1680px] mx-auto px-4 sm:px-6 flex items-center justify-between gap-4">
        {/* Zone 1: Brand Wordmark */}
        <button
          type="button"
          onClick={() => onSelectTab('reader')}
          className="flex items-center gap-2.5 text-stone-900 dark:text-stone-100 whitespace-nowrap shrink-0 focus:outline-none group"
        >
          <BookOpen className="w-5 h-5 text-amber-700 dark:text-amber-500 transition-transform group-hover:scale-105" />
          <span className="font-display text-lg font-semibold tracking-tight">
            BhashaBook
          </span>
        </button>

        {/* Zone 2: Primary Navigation */}
        <nav aria-label="Main navigation" className="flex items-center gap-1 sm:gap-6">
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`relative h-14 px-2.5 sm:px-1 inline-flex items-center text-sm font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
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

        {/* Zone 3: Single Primary Action */}
        <div className="shrink-0">
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
            className="inline-flex items-center gap-2 h-9 px-3.5 rounded-md text-sm font-medium whitespace-nowrap shrink-0 bg-stone-900 text-stone-50 hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-stone-200 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <Upload className="w-4 h-4" />
            <span>{isUploading ? 'Loading…' : 'Upload PDF'}</span>
          </button>
        </div>
      </div>
    </header>
  );
};
