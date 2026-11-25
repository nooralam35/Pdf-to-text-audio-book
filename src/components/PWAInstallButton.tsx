import React, { useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  className?: string;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({ className = '' }) => {
  const { canPromptNatively, isInstalled, isIOS, promptInstall } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  // Never show install prompt when already running in standalone installed mode
  if (isInstalled) return null;

  // Show when Chromium beforeinstallprompt is available OR on iOS Safari
  if (!canPromptNatively && !isIOS) return null;

  const handleClick = async () => {
    if (canPromptNatively) {
      await promptInstall();
    } else if (isIOS) {
      setShowIOSGuide(true);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className={`h-8 px-3 inline-flex items-center gap-1.5 rounded-md border border-stone-300 sepia:border-[#D4C6AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#1E1D1B] hover:bg-stone-100 dark:hover:bg-stone-800 text-xs font-medium text-stone-800 sepia:text-[#3B2F23] dark:text-stone-200 transition-colors cursor-pointer whitespace-nowrap ${className}`}
      >
        <Download className="w-3.5 h-3.5 text-amber-700 dark:text-amber-500" />
        <span>Install Offline App</span>
      </button>

      {showIOSGuide && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="ios-install-title"
          onClick={() => setShowIOSGuide(false)}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-[1px]"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-lg border border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-[#FAF9F5] sepia:bg-[#F4ECD8] dark:bg-[#191816] shadow-2xl p-5 space-y-3"
          >
            <div className="flex items-center justify-between gap-2">
              <h3
                id="ios-install-title"
                className="font-display text-lg font-semibold text-stone-950 sepia:text-[#2F241A] dark:text-stone-50"
              >
                Install BhashaBook Offline
              </h3>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                aria-label="Close install instructions"
                className="h-7 w-7 inline-flex items-center justify-center rounded text-stone-500 hover:text-stone-950 dark:hover:text-stone-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs leading-relaxed text-stone-600 sepia:text-[#5B4938] dark:text-stone-400">
              Add BhashaBook to your Home Screen to open your downloaded PDFs and cached
              translations directly without an internet connection:
            </p>
            <ol className="text-xs space-y-2 text-stone-800 sepia:text-[#3B2F23] dark:text-stone-200 list-decimal pl-4">
              <li className="leading-relaxed">
                Tap the{' '}
                <span className="inline-flex items-center gap-1 font-semibold">
                  <Share className="w-3.5 h-3.5 text-amber-700 dark:text-amber-500 inline" />
                  Share
                </span>{' '}
                button in Safari&apos;s toolbar.
              </li>
              <li className="leading-relaxed">
                Scroll down and select <span className="font-semibold">Add to Home Screen</span>.
              </li>
              <li className="leading-relaxed">
                Tap <span className="font-semibold">Add</span> to finish installing.
              </li>
            </ol>
          </div>
        </div>
      )}
    </>
  );
};
