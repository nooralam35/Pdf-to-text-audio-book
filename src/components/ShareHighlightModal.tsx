import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Share2,
  X,
} from 'lucide-react';
import {
  canvasToPngBlob,
  getAspectSpec,
  QUOTE_CARD_ASPECTS,
  QUOTE_CARD_THEMES,
  renderHighlightCardCanvas,
  type QuoteCardAspectId,
  type QuoteCardThemeId,
  type ShareQuotePayload,
} from '../lib/highlightCardCanvas';
import { getLanguageOption } from '../lib/languages';
import { downloadBlob } from '../lib/translatorClient';

interface ShareHighlightModalProps {
  initialPayload: ShareQuotePayload;
  savedHighlights: ShareQuotePayload[];
  onClose: () => void;
}

const ShareHighlightModalInner: React.FC<ShareHighlightModalProps> = ({
  initialPayload,
  savedHighlights,
  onClose,
}) => {
  const [selectedSourceId, setSelectedSourceId] = useState<string>(
    initialPayload.id ?? '__custom__'
  );
  const [quoteText, setQuoteText] = useState(initialPayload.quoteText);
  const [noteText, setNoteText] = useState(initialPayload.note ?? '');
  const [pageNumber, setPageNumber] = useState(initialPayload.pageNumber);
  const [chapterTitle, setChapterTitle] = useState(initialPayload.chapterTitle);
  const [highlightColor, setHighlightColor] = useState(initialPayload.highlightColor);

  const [theme, setTheme] = useState<QuoteCardThemeId>('paper');
  const [aspect, setAspect] = useState<QuoteCardAspectId>('square');
  const [showCover, setShowCover] = useState(Boolean(initialPayload.coverDataUrl));
  const [showNote, setShowNote] = useState(Boolean(initialPayload.note?.trim()));
  const [showPageMeta, setShowPageMeta] = useState(true);
  const [showWatermark, setShowWatermark] = useState(true);

  const [isExporting, setIsExporting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [copiedImage, setCopiedImage] = useState(false);
  const [copiedCaption, setCopiedCaption] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);

  const langOption = getLanguageOption(initialPayload.lang);
  const activeAspect = getAspectSpec(aspect);

  const showTransientFeedback = useCallback((msg: string) => {
    setFeedback(msg);
    if (feedbackTimerRef.current) {
      window.clearTimeout(feedbackTimerRef.current);
    }
    feedbackTimerRef.current = window.setTimeout(() => setFeedback(null), 3200);
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) {
        window.clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  // Dismiss on Escape
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const activePayload = useMemo<ShareQuotePayload>(
    () => ({
      id: selectedSourceId,
      quoteText,
      note: noteText,
      bookTitle: initialPayload.bookTitle,
      author: initialPayload.author,
      pageNumber,
      chapterTitle,
      lang: initialPayload.lang,
      coverDataUrl: initialPayload.coverDataUrl,
      highlightColor,
    }),
    [
      selectedSourceId,
      quoteText,
      noteText,
      initialPayload.bookTitle,
      initialPayload.author,
      initialPayload.lang,
      initialPayload.coverDataUrl,
      pageNumber,
      chapterTitle,
      highlightColor,
    ]
  );

  // Re-render live high-resolution quote card whenever any option or text changes
  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handle = window.requestAnimationFrame(() => {
      if (cancelled) return;
      renderHighlightCardCanvas(canvas, activePayload, {
        theme,
        aspect,
        showCover,
        showNote,
        showPageMeta,
        showWatermark,
      }).catch(() => {});
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(handle);
    };
  }, [activePayload, theme, aspect, showCover, showNote, showPageMeta, showWatermark]);

  const handleSelectSavedHighlight = (item: ShareQuotePayload) => {
    setSelectedSourceId(item.id ?? '__custom__');
    setQuoteText(item.quoteText);
    setNoteText(item.note ?? '');
    setPageNumber(item.pageNumber);
    setChapterTitle(item.chapterTitle);
    setHighlightColor(item.highlightColor);
    setShowNote(Boolean(item.note?.trim()));
  };

  const buildFileName = () => {
    const slug =
      initialPayload.bookTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 36) || 'highlight';
    return `${slug}-p${pageNumber}-${aspect}.png`;
  };

  const socialCaption = useMemo(() => {
    const clean = quoteText.trim();
    const authorPart = initialPayload.author?.trim() ? ` by ${initialPayload.author.trim()}` : '';
    const refPart = showPageMeta ? ` (Page ${pageNumber})` : '';
    const notePart = showNote && noteText.trim() ? `\n\nNote: ${noteText.trim()}` : '';
    return `“${clean}”\n— ${initialPayload.bookTitle}${authorPart}${refPart}${notePart}\n\n#BhashaBook #ReadingNotes`;
  }, [quoteText, noteText, initialPayload.bookTitle, initialPayload.author, pageNumber, showPageMeta, showNote]);

  const handleDownloadPng = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setIsExporting(true);
    try {
      const blob = await canvasToPngBlob(canvas);
      const fileName = buildFileName();
      downloadBlob(blob, fileName);
      showTransientFeedback(`Downloaded ${fileName} (${activeAspect.width}×${activeAspect.height}px)`);
    } catch {
      showTransientFeedback('Could not export image. Please try again.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleCopyImage = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setIsExporting(true);
    try {
      const blob = await canvasToPngBlob(canvas);
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        setCopiedImage(true);
        window.setTimeout(() => setCopiedImage(false), 1800);
        showTransientFeedback('Card image copied — paste directly into X, LinkedIn, or WhatsApp.');
      } else {
        await navigator.clipboard.writeText(socialCaption);
        showTransientFeedback('Image clipboard unavailable here — copied formatted quote caption instead.');
      }
    } catch {
      try {
        await navigator.clipboard.writeText(socialCaption);
        showTransientFeedback('Copied formatted quote caption (download PNG to attach the image).');
      } catch {
        showTransientFeedback('Use Download PNG to save the image card.');
      }
    } finally {
      setIsExporting(false);
    }
  };

  const handleCopyCaption = async () => {
    try {
      await navigator.clipboard.writeText(socialCaption);
      setCopiedCaption(true);
      window.setTimeout(() => setCopiedCaption(false), 1600);
      showTransientFeedback('Post caption copied to clipboard.');
    } catch {
      showTransientFeedback('Clipboard permission blocked in this browser.');
    }
  };

  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const handleNativeShare = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !canNativeShare) return;
    setIsExporting(true);
    try {
      const blob = await canvasToPngBlob(canvas);
      const file = new File([blob], buildFileName(), { type: 'image/png' });
      const shareData: ShareData = {
        title: `Highlight from ${initialPayload.bookTitle}`,
        text: socialCaption,
      };
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        shareData.files = [file];
      }
      await navigator.share(shareData);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      showTransientFeedback('Direct share unavailable — use Download PNG or Copy Image.');
    } finally {
      setIsExporting(false);
    }
  };

  const xShareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    socialCaption.slice(0, 275)
  )}`;
  const whatsappShareUrl = `https://wa.me/?text=${encodeURIComponent(socialCaption)}`;
  const linkedinShareUrl = `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(
    socialCaption
  )}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-highlight-title"
      className="no-print fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/60 backdrop-blur-[1px]"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-5xl max-h-[92vh] overflow-hidden rounded-lg border border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-[#FAF9F5] sepia:bg-[#F4ECD8] dark:bg-[#191816] shadow-2xl flex flex-col"
      >
        {/* Modal Header */}
        <div className="px-5 sm:px-6 h-14 border-b border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <Share2 className="w-4 h-4 text-amber-700 dark:text-amber-500 shrink-0" />
            <h2
              id="share-highlight-title"
              className="font-display text-lg font-semibold text-stone-950 sepia:text-[#2E241A] dark:text-stone-50 truncate"
            >
              Share Highlight Card
            </h2>
            <span className="hidden sm:inline text-xs text-stone-500 dark:text-stone-400 font-mono-num whitespace-nowrap">
              · {activeAspect.width}×{activeAspect.height} PNG
            </span>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close Share Highlight Studio"
            className="h-9 w-9 inline-flex items-center justify-center rounded-md text-stone-500 hover:text-stone-950 dark:hover:text-stone-100 hover:bg-stone-200/70 dark:hover:bg-stone-800 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Two-Column Studio Workspace */}
        <div className="flex-1 overflow-y-auto grid grid-cols-1 lg:grid-cols-12 min-h-0">
          {/* Left Column: Live High-Resolution Gallery Preview */}
          <div className="lg:col-span-7 bg-[#EFECE6] sepia:bg-[#E7DEC8] dark:bg-[#0E0E0D] p-5 sm:p-7 flex flex-col items-center justify-between gap-4 border-b lg:border-b-0 lg:border-r border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800">
            <div className="w-full flex items-center justify-between text-xs text-stone-500 dark:text-stone-400">
              <span>Live Print-Quality Preview</span>
              <span className="font-mono-num">
                {activeAspect.label} ({activeAspect.ratioLabel}) · {activeAspect.channelHint}
              </span>
            </div>

            <div className="flex-1 w-full flex items-center justify-center py-2">
              <canvas
                ref={canvasRef}
                aria-label="Visual quote card preview"
                className="max-w-full max-h-[54vh] w-auto h-auto rounded-[4px] shadow-xl border border-black/10 dark:border-white/10"
              />
            </div>

            {/* Book Highlights Quick Switcher (when the book has saved highlights) */}
            {savedHighlights.length > 1 && (
              <div className="w-full pt-3 border-t border-stone-300/70 sepia:border-[#D4C7AA] dark:border-stone-800 space-y-2">
                <p className="text-xs text-stone-600 dark:text-stone-400">
                  Switch highlight from this book ({savedHighlights.length} saved)
                </p>
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                  {savedHighlights.map((item, idx) => {
                    const isActive = item.id === selectedSourceId;
                    return (
                      <button
                        key={item.id ?? idx}
                        type="button"
                        onClick={() => handleSelectSavedHighlight(item)}
                        className={`shrink-0 max-w-[220px] px-3 py-1.5 rounded-md border text-left text-xs transition-colors cursor-pointer ${
                          isActive
                            ? 'border-amber-700 dark:border-amber-500 bg-white dark:bg-[#1E1D1B] text-stone-950 dark:text-stone-50'
                            : 'border-stone-300/80 dark:border-stone-700 bg-white/60 dark:bg-[#171614] text-stone-600 dark:text-stone-300 hover:bg-white dark:hover:bg-[#1E1D1B]'
                        }`}
                      >
                        <span className="block truncate font-medium">“{item.quoteText}”</span>
                        <span className="block text-[10px] font-mono-num text-stone-400 mt-0.5">
                          Page {item.pageNumber}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Right Column: Editorial Controls & Social Export */}
          <div className="lg:col-span-5 p-5 sm:p-6 space-y-5 overflow-y-auto">
            {/* Editable Quote Text */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="share-quote-input"
                  className="text-xs font-medium text-stone-700 dark:text-stone-300"
                >
                  Selected Quote
                </label>
                <span className="text-[11px] font-mono-num text-stone-400 dark:text-stone-500">
                  {quoteText.trim().length} chars
                </span>
              </div>
              <textarea
                id="share-quote-input"
                dir={langOption.rtl ? 'rtl' : 'ltr'}
                rows={4}
                value={quoteText}
                onChange={(e) => setQuoteText(e.target.value)}
                placeholder="Type or refine the quote you want to share…"
                className={`w-full p-3 text-sm leading-relaxed rounded-md border border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#141312] text-stone-950 dark:text-stone-100 focus:outline-none focus:border-amber-700 dark:focus:border-amber-500 resize-y ${langOption.cssClass}`}
              />
            </div>

            {/* Aspect Ratio Selector */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-stone-700 dark:text-stone-300">
                Social Format
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-2 gap-2">
                {QUOTE_CARD_ASPECTS.map((item) => {
                  const active = aspect === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setAspect(item.id)}
                      className={`px-3 py-2 rounded-md border text-left transition-colors cursor-pointer ${
                        active
                          ? 'border-amber-700 dark:border-amber-500 bg-amber-50/70 dark:bg-amber-950/35 text-stone-950 dark:text-stone-50'
                          : 'border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-white sepia:bg-[#FBF6E9] dark:bg-[#141312] text-stone-700 dark:text-stone-300 hover:border-stone-300 dark:hover:border-stone-700'
                      }`}
                    >
                      <span className="flex items-center justify-between text-xs font-medium whitespace-nowrap">
                        <span>{item.label}</span>
                        <span className="font-mono-num text-[11px] text-stone-500 dark:text-stone-400">
                          {item.ratioLabel}
                        </span>
                      </span>
                      <span className="block text-[10px] text-stone-500 dark:text-stone-400 truncate mt-0.5">
                        {item.channelHint}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Editorial Theme Picker */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-stone-700 dark:text-stone-300">
                Card Aesthetic
              </p>
              <div className="grid grid-cols-5 gap-2">
                {QUOTE_CARD_THEMES.map((t) => {
                  const active = theme === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTheme(t.id)}
                      title={t.label}
                      className={`group flex flex-col items-center gap-1.5 p-1.5 rounded-md border transition-colors cursor-pointer ${
                        active
                          ? 'border-amber-700 dark:border-amber-500 bg-amber-50/60 dark:bg-amber-950/30'
                          : 'border-stone-200 dark:border-stone-800 hover:border-stone-300 dark:hover:border-stone-700'
                      }`}
                    >
                      <span
                        style={{ backgroundColor: t.bg, borderColor: t.frame }}
                        className="w-full h-7 rounded-[3px] border flex items-center justify-center"
                      >
                        <span
                          style={{ color: t.accent }}
                          className="font-display text-sm font-semibold leading-none"
                        >
                          Aa
                        </span>
                      </span>
                      <span className="text-[10px] text-stone-600 dark:text-stone-400 truncate w-full text-center">
                        {t.label.split(' ')[0]}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Optional Note + Card Detail Toggles */}
            <div className="space-y-2.5 pt-1 border-t border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800">
              <div className="grid grid-cols-2 gap-2 text-xs text-stone-700 dark:text-stone-300">
                {initialPayload.coverDataUrl && (
                  <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={showCover}
                      onChange={(e) => setShowCover(e.target.checked)}
                      className="rounded border-stone-300 dark:border-stone-600 accent-amber-700"
                    />
                    <span>Book cover</span>
                  </label>
                )}

                <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showPageMeta}
                    onChange={(e) => setShowPageMeta(e.target.checked)}
                    className="rounded border-stone-300 dark:border-stone-600 accent-amber-700"
                  />
                  <span>Chapter &amp; page</span>
                </label>

                <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showNote}
                    onChange={(e) => setShowNote(e.target.checked)}
                    className="rounded border-stone-300 dark:border-stone-600 accent-amber-700"
                  />
                  <span>Include note</span>
                </label>

                <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showWatermark}
                    onChange={(e) => setShowWatermark(e.target.checked)}
                    className="rounded border-stone-300 dark:border-stone-600 accent-amber-700"
                  />
                  <span>Reader mark</span>
                </label>
              </div>

              {showNote && (
                <input
                  type="text"
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="Add a short personal takeaway to display below the quote…"
                  className="w-full h-9 px-3 text-xs rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#141312] text-stone-900 dark:text-stone-100 focus:outline-none focus:border-amber-700"
                />
              )}
            </div>

            {/* Feedback Banner */}
            {feedback && (
              <div className="px-3 py-2 rounded-md border border-amber-700/30 bg-amber-50/90 dark:bg-amber-950/40 text-xs text-amber-950 dark:text-amber-200">
                {feedback}
              </div>
            )}

            {/* Primary Export & Share Actions */}
            <div className="space-y-2.5 pt-2 border-t border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={isExporting || !quoteText.trim()}
                  onClick={handleDownloadPng}
                  className="h-10 px-4 rounded-md text-xs font-medium inline-flex items-center justify-center gap-2 bg-amber-700 hover:bg-amber-800 text-white disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Download className="w-4 h-4" />
                  <span>Download PNG</span>
                </button>

                <button
                  type="button"
                  disabled={isExporting || !quoteText.trim()}
                  onClick={handleCopyImage}
                  className="h-10 px-4 rounded-md text-xs font-medium inline-flex items-center justify-center gap-2 border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#141312] text-stone-900 dark:text-stone-100 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                >
                  {copiedImage ? (
                    <>
                      <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                      <span>Copied Image</span>
                    </>
                  ) : (
                    <>
                      <ImageIcon className="w-4 h-4" />
                      <span>Copy Image</span>
                    </>
                  )}
                </button>
              </div>

              {canNativeShare && (
                <button
                  type="button"
                  disabled={isExporting || !quoteText.trim()}
                  onClick={handleNativeShare}
                  className="w-full h-9 px-4 rounded-md text-xs font-medium inline-flex items-center justify-center gap-2 bg-stone-900 hover:bg-stone-800 text-white dark:bg-stone-100 dark:text-stone-950 dark:hover:bg-stone-200 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  <span>Share Image Card Directly…</span>
                </button>
              )}

              {/* Social Post Shortcuts */}
              <div className="pt-2 space-y-2">
                <div className="flex items-center justify-between text-[11px] text-stone-500 dark:text-stone-400">
                  <span>Post to social media</span>
                  <button
                    type="button"
                    onClick={handleCopyCaption}
                    className="inline-flex items-center gap-1 text-stone-700 dark:text-stone-300 hover:text-amber-800 dark:hover:text-amber-400 cursor-pointer"
                  >
                    {copiedCaption ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-600" />
                        <span>Caption copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copy caption</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <a
                    href={xShareUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="h-8 px-2.5 rounded border border-stone-300 dark:border-stone-700 text-xs font-medium text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
                  >
                    <span>X / Twitter</span>
                    <ExternalLink className="w-3 h-3 opacity-60" />
                  </a>
                  <a
                    href={linkedinShareUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="h-8 px-2.5 rounded border border-stone-300 dark:border-stone-700 text-xs font-medium text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
                  >
                    <span>LinkedIn</span>
                    <ExternalLink className="w-3 h-3 opacity-60" />
                  </a>
                  <a
                    href={whatsappShareUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="h-8 px-2.5 rounded border border-stone-300 dark:border-stone-700 text-xs font-medium text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
                  >
                    <span>WhatsApp</span>
                    <ExternalLink className="w-3 h-3 opacity-60" />
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export const ShareHighlightModal = React.memo(ShareHighlightModalInner);
