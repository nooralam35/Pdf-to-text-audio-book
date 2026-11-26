import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Download,
  Loader2,
  Mic,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Sparkles,
  Square,
  Timer,
  Volume2,
} from 'lucide-react';
import { ElementPitchShifter } from '../lib/audioPitchShifter';
import {
  AudioWakeLock,
  BackgroundAudioKeepAlive,
  getCachedTtsAudioBlob,
  putCachedTtsAudioBlob,
  registerMediaSessionHandlers,
  updateMediaSessionState,
} from '../lib/backgroundAudio';
import { getLanguageOption } from '../lib/languages';
import {
  buildAudiobookText,
  downloadBlob,
  fetchFreeTtsBlob,
  synthesizePageAudio,
} from '../lib/translatorClient';
import {
  AI_VOICE_PROFILES,
  detectSentenceProsody,
  getAiVoiceProfile,
  getPreferredVoiceProfileForStyle,
  getVoiceStylePreferenceFromProfile,
  getVoiceStylePreferenceOption,
  type AiVoiceProfileId,
  type SentenceProsodyKind,
  type VoiceStylePreference,
} from '../lib/voiceProfiles';
import type {
  ChapterItem,
  LanguageCode,
  ParsedPage,
  SentenceSpan,
  TranslatedPageRecord,
} from '../types';

type SpeechEngineMode = 'hd' | 'device';

function estimateSentenceBaseSeconds(text: string): number {
  const cleaned = text.trim();
  if (!cleaned) return 1.5;
  const words = cleaned.split(/\s+/).filter(Boolean).length;
  const chars = cleaned.replace(/\s+/g, '').length;
  // Blend word rate (~148 wpm) & char rate (~14.5 chars/sec) so both English and Indic/RTL scripts stay accurate
  const byWords = words / 2.46;
  const byChars = chars / 14.5;
  return Math.max(1.2, Math.max(byWords, byChars * 0.85));
}

function formatAudioDuration(totalSeconds: number): string {
  const clamped = Math.max(0, Math.round(totalSeconds));
  const hrs = Math.floor(clamped / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export interface AudiobookControlHandle {
  unlockAudio: () => void;
  pausePlayback: () => void;
  playCurrentPage: () => void;
  playFromSentence: (sentenceIndex: number, targetPage?: number) => void;
  queueChapterPlayback: (targetPage: number, endPage: number, chapterTitle: string) => void;
}

interface AudiobookBarProps {
  bookTitle: string;
  bookAuthor?: string;
  bookCoverUrl?: string;
  isOnline?: boolean;
  pageNumber: number;
  numPages: number;
  currentChapter?: ChapterItem | null;
  chapterPageWordCounts?: Record<number, number>;
  targetLang: LanguageCode;
  parsedPage: ParsedPage | null;
  translatedPage: TranslatedPageRecord | null;
  isTranslatingPage: boolean;
  sentences: SentenceSpan[];
  activeSentenceIndex: number | null;
  onActiveSentenceChange: (idx: number | null) => void;
  isSpeaking: boolean;
  onSpeakingChange: (speaking: boolean) => void;
  onPreparingChange?: (preparing: boolean) => void;
  controlRef?: React.MutableRefObject<AudiobookControlHandle | null>;
  jumpRequest: { index: number; nonce: number } | null;
  onAdvancePage: () => void;
  onSeekToPage?: (targetPage: number) => void;
  onRequestTranslatePage: () => void;
  aiAvailable: boolean;
  narrationSource: 'translated' | 'original';
  onNarrationSourceChange: (src: 'translated' | 'original') => void;
  voiceStylePreference?: VoiceStylePreference;
  onVoiceStylePreferenceChange?: (pref: VoiceStylePreference) => void;
}

export const AudiobookBar: React.FC<AudiobookBarProps> = ({
  bookTitle,
  bookAuthor = '',
  bookCoverUrl,
  isOnline = true,
  pageNumber,
  numPages,
  currentChapter = null,
  chapterPageWordCounts = {},
  targetLang,
  parsedPage,
  translatedPage,
  isTranslatingPage,
  sentences,
  activeSentenceIndex,
  onActiveSentenceChange,
  isSpeaking,
  onSpeakingChange,
  onPreparingChange,
  controlRef,
  jumpRequest,
  onAdvancePage,
  onSeekToPage,
  onRequestTranslatePage,
  aiAvailable,
  narrationSource,
  onNarrationSourceChange,
  voiceStylePreference = 'teacher',
  onVoiceStylePreferenceChange,
}) => {
  const [engineMode, setEngineMode] = useState<SpeechEngineMode>(() => {
    if (typeof window === 'undefined') return 'hd';
    const saved = localStorage.getItem('bhashabook-speech-engine');
    return saved === 'device' ? 'device' : 'hd';
  });
  const [aiVoiceProfileId, setAiVoiceProfileId] = useState<AiVoiceProfileId>(() => {
    if (typeof window === 'undefined') return 'female-teacher';
    const saved = localStorage.getItem('bhashabook-ai-voice-profile');
    return getAiVoiceProfile(saved).id;
  });
  const [neuralMenuOpen, setNeuralMenuOpen] = useState(false);
  const [neuralFilter, setNeuralFilter] = useState<
    'all' | 'Teacher' | 'Female' | 'Male' | 'Expressive' | 'Natural'
  >('all');
  const [previewingNeuralId, setPreviewingNeuralId] = useState<AiVoiceProfileId | null>(null);
  const neuralDropdownRef = useRef<HTMLDivElement | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const [rate, setRate] = useState(1.0); // 0.5x .. 2.0x
  const [pitch, setPitch] = useState(1.0); // 0.5 .. 1.8
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voicesLoaded, setVoicesLoaded] = useState(false);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string>('');
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [isLoadingSentence, setIsLoadingSentence] = useState(false);
  const [isDownloadingAudio, setIsDownloadingAudio] = useState(false);
  const [audioMessage, setAudioMessage] = useState<string | null>(null);
  const [waitingForTranslation, setWaitingForTranslation] = useState(false);
  const [sleepTimerMinutes, setSleepTimerMinutes] = useState<number>(0);
  const [sleepSecondsLeft, setSleepSecondsLeft] = useState<number>(0);
  const [sentenceProgress, setSentenceProgress] = useState(0); // 0..1 within active sentence
  const [scrubSec, setScrubSec] = useState<number | null>(null);
  const [hoverSec, setHoverSec] = useState<number | null>(null);
  const scrubSecRef = useRef<number | null>(null);
  const isDraggingTimelineRef = useRef(false);
  const timelineTrackRef = useRef<HTMLDivElement | null>(null);
  const pendingSeekRef = useRef<{
    targetPage: number;
    fraction: number;
    autoPlay: boolean;
  } | null>(null);
  const pendingSentenceStartRef = useRef<{
    targetPage: number;
    sentenceIndex: number;
  } | null>(null);
  const sentenceStartedAtRef = useRef<number>(0);

  const effectiveAudioLang: LanguageCode = narrationSource === 'original' ? 'en' : targetLang;
  const langOption = getLanguageOption(effectiveAudioLang);
  const activeVoiceProfile = useMemo(
    () => getAiVoiceProfile(aiVoiceProfileId),
    [aiVoiceProfileId]
  );

  // Map blockId -> block kind so Neural TTS applies heading/caption/list/question prosody automatically
  const blockKindById = useMemo(() => {
    const map = new Map<string, string>();
    const sourceBlocks =
      narrationSource === 'original' ? parsedPage?.blocks : translatedPage?.blocks ?? parsedPage?.blocks;
    if (sourceBlocks) {
      for (const b of sourceBlocks) {
        map.set(b.id, b.kind);
      }
    }
    return map;
  }, [narrationSource, parsedPage, translatedPage]);
  const blockKindByIdRef = useRef(blockKindById);
  blockKindByIdRef.current = blockKindById;

  // Persistent HTML5 Audio element + independent Web Audio pitch shifter + background continuity
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pitchShifterRef = useRef<ElementPitchShifter | null>(null);
  const keepAliveRef = useRef<BackgroundAudioKeepAlive | null>(null);
  const wakeLockRef = useRef<AudioWakeLock | null>(null);
  const speechKeepAliveIntervalRef = useRef<number | null>(null);
  const speechWatchdogTimerRef = useRef<number | null>(null);
  const unexpectedPauseTimerRef = useRef<number | null>(null);
  const objectUrlCacheRef = useRef<Map<string, { url: string; source: 'ai' | 'free' }>>(new Map());
  const inFlightFetchRef = useRef<Map<string, Promise<{ url: string; source: 'ai' | 'free' }>>>(
    new Map()
  );
  const currentClipSourceRef = useRef<'ai' | 'free'>('free');
  const abortRef = useRef<AbortController | null>(null);
  const currentUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const audioUnlockedRef = useRef(false);

  const playSessionRef = useRef(0);
  const pausedInPlaceRef = useRef(false);
  const pendingAutoContinueRef = useRef(false);
  const pendingChapterPlayRef = useRef<{
    targetPage: number;
    endPage: number;
    title: string;
  } | null>(null);
  const rateRef = useRef(rate);
  const pitchRef = useRef(pitch);
  const voiceIdRef = useRef(selectedVoiceId);
  const aiVoiceProfileIdRef = useRef<AiVoiceProfileId>(aiVoiceProfileId);
  const voiceStylePrefRef = useRef<VoiceStylePreference>(voiceStylePreference);
  const prevVoiceStylePrefRef = useRef<VoiceStylePreference>(voiceStylePreference);
  const aiAvailableRef = useRef(aiAvailable);
  const autoAdvanceRef = useRef(autoAdvance);
  const sentencesRef = useRef(sentences);
  const engineModeRef = useRef(engineMode);
  const targetLangRef = useRef(effectiveAudioLang);
  const isSpeakingRef = useRef(isSpeaking);
  const isLoadingSentenceRef = useRef(isLoadingSentence);
  const isOnlineRef = useRef(isOnline);
  const activeSentenceIndexRef = useRef<number | null>(activeSentenceIndex);
  const pageNumberRef = useRef(pageNumber);
  const numPagesRef = useRef(numPages);

  rateRef.current = rate;
  pitchRef.current = pitch;
  voiceIdRef.current = selectedVoiceId;
  aiVoiceProfileIdRef.current = aiVoiceProfileId;
  voiceStylePrefRef.current = voiceStylePreference;
  aiAvailableRef.current = aiAvailable;
  autoAdvanceRef.current = autoAdvance;
  sentencesRef.current = sentences;
  engineModeRef.current = engineMode;
  targetLangRef.current = effectiveAudioLang;
  isSpeakingRef.current = isSpeaking;
  isLoadingSentenceRef.current = isLoadingSentence;
  isOnlineRef.current = isOnline;
  activeSentenceIndexRef.current = activeSentenceIndex;
  pageNumberRef.current = pageNumber;
  numPagesRef.current = numPages;

  const isCurrentlyOnline = () =>
    typeof navigator === 'undefined'
      ? isOnlineRef.current
      : navigator.onLine !== false && isOnlineRef.current;

  const getKeepAlive = () => {
    if (!keepAliveRef.current) {
      keepAliveRef.current = new BackgroundAudioKeepAlive();
    }
    return keepAliveRef.current;
  };

  const getWakeLock = () => {
    if (!wakeLockRef.current) {
      wakeLockRef.current = new AudioWakeLock();
    }
    return wakeLockRef.current;
  };

  const clearSpeechTimers = () => {
    if (speechKeepAliveIntervalRef.current !== null) {
      window.clearInterval(speechKeepAliveIntervalRef.current);
      speechKeepAliveIntervalRef.current = null;
    }
    if (speechWatchdogTimerRef.current !== null) {
      window.clearTimeout(speechWatchdogTimerRef.current);
      speechWatchdogTimerRef.current = null;
    }
    if (unexpectedPauseTimerRef.current !== null) {
      window.clearTimeout(unexpectedPauseTimerRef.current);
      unexpectedPauseTimerRef.current = null;
    }
  };

  useEffect(() => {
    try {
      localStorage.setItem('bhashabook-ai-voice-profile', aiVoiceProfileId);
    } catch {
      // ignore storage errors
    }
  }, [aiVoiceProfileId]);

  // Sync active neural voice profile when user updates Voice Preference in the Glossary popover
  useEffect(() => {
    if (prevVoiceStylePrefRef.current === voiceStylePreference) return;
    prevVoiceStylePrefRef.current = voiceStylePreference;

    const currentPref = getVoiceStylePreferenceFromProfile(aiVoiceProfileIdRef.current);
    if (currentPref !== voiceStylePreference) {
      const nextProfileId = getPreferredVoiceProfileForStyle(
        voiceStylePreference,
        aiVoiceProfileIdRef.current
      );
      setAiVoiceProfileId(nextProfileId);
      aiVoiceProfileIdRef.current = nextProfileId;
    }

    if (isSpeakingRef.current && engineModeRef.current === 'hd' && activeSentenceIndexRef.current !== null) {
      speakFromIndex(activeSentenceIndexRef.current);
    } else {
      pausedInPlaceRef.current = false;
    }
  }, [voiceStylePreference]);

  useEffect(() => {
    try {
      localStorage.setItem('bhashabook-speech-engine', engineMode);
    } catch {
      // ignore storage errors
    }
  }, [engineMode]);

  // Close the Neural TTS voice dropdown on outside click or Escape key
  useEffect(() => {
    if (!neuralMenuOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (
        neuralDropdownRef.current &&
        !neuralDropdownRef.current.contains(e.target as Node)
      ) {
        setNeuralMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setNeuralMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [neuralMenuOpen]);

  const filteredNeuralVoices = useMemo(() => {
    if (neuralFilter === 'all') return AI_VOICE_PROFILES;
    if (neuralFilter === 'Female' || neuralFilter === 'Male') {
      return AI_VOICE_PROFILES.filter((p) => p.gender === neuralFilter);
    }
    return AI_VOICE_PROFILES.filter((p) => p.category === neuralFilter);
  }, [neuralFilter]);

  const speechSupported =
    typeof window !== 'undefined' && 'speechSynthesis' in window;

  const getPitchShifter = () => {
    if (!audioRef.current) return null;
    if (!pitchShifterRef.current) {
      pitchShifterRef.current = new ElementPitchShifter(audioRef.current);
    }
    return pitchShifterRef.current;
  };

  // Reliably fetch available Web Speech API system voice profiles (handles async browser voice loading)
  const refreshSystemVoices = () => {
    if (!speechSupported) return;
    try {
      const list = window.speechSynthesis.getVoices();
      if (list.length > 0) {
        setVoices([...list]);
        setVoicesLoaded(true);
      }
    } catch {
      // ignore Web Speech API errors
    }
  };

  useEffect(() => {
    if (!speechSupported) return;
    refreshSystemVoices();

    const handleVoicesChanged = () => {
      refreshSystemVoices();
    };
    window.speechSynthesis.addEventListener?.('voiceschanged', handleVoicesChanged);

    // Some Chromium/WebKit builds populate getVoices() slightly after mount without firing voiceschanged
    const timers = [150, 600, 1500].map((delay) =>
      window.setTimeout(() => {
        refreshSystemVoices();
      }, delay)
    );

    return () => {
      window.speechSynthesis.removeEventListener?.('voiceschanged', handleVoicesChanged);
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [speechSupported]);

  // Deduplicate, assign stable IDs, and group Web Speech API system voices by active language
  const { sortedVoices, matchingVoices, otherVoices } = useMemo(() => {
    const langPrefix = langOption.speechLang.split('-')[0].toLowerCase();
    const seenIds = new Set<string>();
    const entries: Array<{ id: string; voice: SpeechSynthesisVoice; matchesLang: boolean }> = [];

    for (const v of voices) {
      const baseId = `${v.voiceURI || v.name}::${v.lang}`;
      if (seenIds.has(baseId)) continue;
      seenIds.add(baseId);
      entries.push({
        id: baseId,
        voice: v,
        matchesLang: v.lang.toLowerCase().startsWith(langPrefix),
      });
    }

    const compareEntries = (
      a: (typeof entries)[number],
      b: (typeof entries)[number]
    ) => {
      if (a.matchesLang !== b.matchesLang) return a.matchesLang ? -1 : 1;
      if (a.voice.default !== b.voice.default) return a.voice.default ? -1 : 1;
      if (a.voice.localService !== b.voice.localService) return a.voice.localService ? -1 : 1;
      return a.voice.name.localeCompare(b.voice.name) || a.voice.lang.localeCompare(b.voice.lang);
    };

    entries.sort(compareEntries);

    return {
      sortedVoices: entries,
      matchingVoices: entries.filter((e) => e.matchesLang),
      otherVoices: entries.filter((e) => !e.matchesLang),
    };
  }, [voices, langOption.speechLang]);

  // Restore saved system voice preference per language, or pick best matching system voice automatically
  useEffect(() => {
    if (sortedVoices.length === 0) return;
    const storageKey = `bhashabook-system-voice::${langOption.speechLang}`;
    let savedId = '';
    try {
      savedId = localStorage.getItem(storageKey) ?? '';
    } catch {
      // ignore storage errors
    }

    if (savedId && sortedVoices.some((entry) => entry.id === savedId)) {
      setSelectedVoiceId(savedId);
      return;
    }

    if (matchingVoices.length > 0) {
      setSelectedVoiceId(matchingVoices[0].id);
    } else {
      setSelectedVoiceId('');
    }
  }, [sortedVoices, matchingVoices, langOption.speechLang]);

  const clearCachedObjectUrls = () => {
    for (const entry of objectUrlCacheRef.current.values()) {
      URL.revokeObjectURL(entry.url);
    }
    objectUrlCacheRef.current.clear();
    inFlightFetchRef.current.clear();
  };

  const computeEffectiveTone = (clipSource: 'ai' | 'free') => {
    const profile = getAiVoiceProfile(aiVoiceProfileIdRef.current);
    const effectiveRate =
      clipSource === 'ai'
        ? rateRef.current
        : Math.max(0.5, Math.min(2.0, rateRef.current * profile.fallbackRate));
    const effectivePitch =
      clipSource === 'ai'
        ? pitchRef.current
        : Math.max(0.5, Math.min(1.8, pitchRef.current * profile.fallbackPitch));
    return { effectiveRate, effectivePitch };
  };

  const stopPlayback = (clearHighlight = false) => {
    playSessionRef.current++;
    pausedInPlaceRef.current = false;
    setIsLoadingSentence(false);
    clearSpeechTimers();

    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.onpause = null;
      audio.ontimeupdate = null;
      audio.pause();
      if (clearHighlight) {
        audio.currentTime = 0;
      }
    }

    if (speechSupported) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
    currentUtteranceRef.current = null;

    onSpeakingChange(false);
    if (clearHighlight) {
      onActiveSentenceChange(null);
      setSentenceProgress(0);
    }
  };

  // Keep silent background audio session, Web Audio active flag, and optional Wake Lock synced
  useEffect(() => {
    const keepRunning =
      isSpeaking ||
      waitingForTranslation ||
      isLoadingSentence ||
      pendingAutoContinueRef.current ||
      Boolean(pendingChapterPlayRef.current);

    pitchShifterRef.current?.setActive(isSpeaking);

    if (keepRunning) {
      getKeepAlive().start();
      void getWakeLock().acquire();
    } else {
      keepAliveRef.current?.stop();
      wakeLockRef.current?.release();
    }
  }, [isSpeaking, waitingForTranslation, isLoadingSentence, pageNumber]);

  // Display-off / Screen-lock / Background tab continuity (Mobile & PC)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!isSpeakingRef.current && !pendingAutoContinueRef.current) return;

      if (document.visibilityState === 'hidden') {
        // Never pause when display turns off or app backgrounds — keep OS audio focus alive
        keepAliveRef.current?.ensureRunning();
        pitchShifterRef.current?.resume().catch(() => {});
        if (engineModeRef.current === 'device' && speechSupported) {
          try {
            window.speechSynthesis.resume();
          } catch {
            // ignore
          }
        }
      } else if (document.visibilityState === 'visible') {
        keepAliveRef.current?.ensureRunning();
        pitchShifterRef.current?.resume().catch(() => {});
        void wakeLockRef.current?.reacquireIfWanted();
      }
    };

    const handleOfflineDrop = () => {
      // If network drops mid-fetch while waiting for an online HD clip, switch immediately to offline device voice
      if (
        isSpeakingRef.current &&
        isLoadingSentenceRef.current &&
        engineModeRef.current === 'hd' &&
        speechSupported
      ) {
        const resumeIdx = activeSentenceIndexRef.current ?? 0;
        const session = ++playSessionRef.current;
        if (abortRef.current) {
          abortRef.current.abort();
          abortRef.current = null;
        }
        setIsLoadingSentence(false);
        setAudioMessage('Offline detected — continuing seamlessly with offline device voice.');
        speakWithDeviceVoice(resumeIdx, session);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('offline', handleOfflineDrop);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('offline', handleOfflineDrop);
    };
  }, [speechSupported]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPlayback(true);
      previewAbortRef.current?.abort();
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
        previewAudioRef.current = null;
      }
      clearCachedObjectUrls();
      keepAliveRef.current?.dispose();
      keepAliveRef.current = null;
      wakeLockRef.current?.release();
      wakeLockRef.current = null;
      pitchShifterRef.current?.dispose();
      pitchShifterRef.current = null;
    };
  }, []);

  // Reset audio state & cache when switching pages, languages, or narration source
  useEffect(() => {
    stopPlayback(true);
    clearCachedObjectUrls();
    setAudioMessage(null);
    setWaitingForTranslation(false);
    setSentenceProgress(0);
    setScrubSec(null);
    scrubSecRef.current = null;
  }, [pageNumber, targetLang, narrationSource]);

  // Countdown Sleep Timer: pauses playback cleanly when countdown hits 0
  useEffect(() => {
    if (sleepSecondsLeft <= 0) return;
    const id = window.setInterval(() => {
      setSleepSecondsLeft((prev) => {
        if (prev <= 1) {
          stopPlayback(false);
          setSleepTimerMinutes(0);
          setAudioMessage('Sleep timer ended — audiobook playback paused.');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [sleepSecondsLeft > 0]);

  // Smooth intra-sentence progress ticker during System Voice (Web Speech API) playback
  useEffect(() => {
    if (!isSpeaking || engineMode !== 'device' || activeSentenceIndex === null) return;
    const activeSpan = sentences.find((s) => s.globalIndex === activeSentenceIndex);
    if (!activeSpan) return;
    const estDurationMs = (estimateSentenceBaseSeconds(activeSpan.text) / Math.max(0.5, rate)) * 1000;
    sentenceStartedAtRef.current = Date.now();
    setSentenceProgress(0);

    const timer = window.setInterval(() => {
      const elapsed = Date.now() - sentenceStartedAtRef.current;
      setSentenceProgress(Math.min(0.96, elapsed / Math.max(600, estDurationMs)));
    }, 250);

    return () => window.clearInterval(timer);
  }, [isSpeaking, engineMode, activeSentenceIndex, sentences, rate]);

  // If page advanced automatically via Auto-next, seamlessly continue reading once the next page's sentences are ready
  useEffect(() => {
    if (!pendingAutoContinueRef.current) return;
    if (isTranslatingPage) return;

    if (sentences.length > 0) {
      pendingAutoContinueRef.current = false;
      speakFromIndex(0);
      return;
    }

    if (!parsedPage || parsedPage.pageNumber !== pageNumber) return;

    if (parsedPage.isBlank) {
      // Automatically skip blank / cover-only pages so listening never stops mid-book
      if (pageNumber < numPages) {
        onAdvancePage();
      } else {
        pendingAutoContinueRef.current = false;
      }
      return;
    }

    if (!translatedPage) {
      if (!isCurrentlyOnline()) {
        // Offline on an untranslated page: switch to original text so playback continues without stopping
        if (narrationSource === 'translated') {
          setAudioMessage(
            `Offline mode — reading Page ${pageNumber} original text so playback continues.`
          );
          onNarrationSourceChange('original');
        } else {
          pendingAutoContinueRef.current = false;
        }
        return;
      }
      // Fallback: if next page wasn't pre-saved yet, request translation and auto-start when ready
      pendingAutoContinueRef.current = false;
      setWaitingForTranslation(true);
      onRequestTranslatePage();
    }
  }, [
    pageNumber,
    numPages,
    targetLang,
    narrationSource,
    sentences.length,
    isTranslatingPage,
    parsedPage,
    translatedPage,
    isOnline,
  ]);

  // Complete a cross-page seek once the destination page inside the chapter has loaded
  useEffect(() => {
    const pending = pendingSeekRef.current;
    if (!pending || pending.targetPage !== pageNumber) return;
    if (isTranslatingPage) return;

    if (sentences.length > 0) {
      const targetIdx = Math.min(
        sentences.length - 1,
        Math.max(0, Math.floor(pending.fraction * sentences.length))
      );
      pendingSeekRef.current = null;
      if (pending.autoPlay) {
        speakFromIndex(targetIdx);
      } else {
        onActiveSentenceChange(sentences[targetIdx].globalIndex);
      }
      return;
    }

    if (parsedPage && parsedPage.pageNumber === pageNumber && !parsedPage.isBlank && !translatedPage) {
      if (!isCurrentlyOnline()) {
        if (narrationSource === 'translated') {
          setAudioMessage('Offline mode — reading original text.');
          onNarrationSourceChange('original');
        } else {
          pendingSeekRef.current = null;
        }
        return;
      }
      // Auto-translate the sought page so playback resumes smoothly
      setWaitingForTranslation(true);
      onRequestTranslatePage();
    } else if (parsedPage && parsedPage.pageNumber === pageNumber && parsedPage.isBlank) {
      pendingSeekRef.current = null;
    }
  }, [pageNumber, sentences, isTranslatingPage, parsedPage, translatedPage, narrationSource, isOnline]);

  // Resume playback at an exact saved sentence index once the destination page & sentences finish loading
  useEffect(() => {
    const pending = pendingSentenceStartRef.current;
    if (!pending || pending.targetPage !== pageNumber) return;
    if (isTranslatingPage) return;

    if (
      sentences.length > 0 &&
      (narrationSource === 'original' ||
        (translatedPage && translatedPage.pageNumber === pageNumber))
    ) {
      const clampedIdx = Math.min(sentences.length - 1, Math.max(0, pending.sentenceIndex));
      pendingSentenceStartRef.current = null;
      speakFromIndex(clampedIdx);
      return;
    }

    if (parsedPage && parsedPage.pageNumber === pageNumber) {
      if (parsedPage.isBlank) {
        pendingSentenceStartRef.current = null;
        return;
      }
      if (!translatedPage && narrationSource === 'translated') {
        if (!isCurrentlyOnline()) {
          setAudioMessage('Offline mode — resuming original text.');
          onNarrationSourceChange('original');
        } else {
          setWaitingForTranslation(true);
          onRequestTranslatePage();
        }
      }
    }
  }, [pageNumber, sentences, isTranslatingPage, parsedPage, translatedPage, narrationSource, isOnline]);

  // Handle chapter audio start queued from the Chapter List Play button
  useEffect(() => {
    const pending = pendingChapterPlayRef.current;
    if (!pending) return;
    if (pageNumber !== pending.targetPage) return;
    if (isTranslatingPage) return;

    // Wait until parsedPage for this exact page has loaded from IndexedDB / PDF.js
    if (!parsedPage || parsedPage.pageNumber !== pageNumber) return;

    // If sentences are already ready for this exact page, play immediately
    if (sentences.length > 0 && (narrationSource === 'original' || (translatedPage && translatedPage.pageNumber === pageNumber))) {
      pendingChapterPlayRef.current = null;
      speakFromIndex(0);
      return;
    }

    // If the starting page of the chapter is blank/cover art with no text, advance to the next page within the chapter
    if (parsedPage.isBlank) {
      if (pageNumber < pending.endPage && pageNumber < numPages) {
        pendingChapterPlayRef.current = {
          ...pending,
          targetPage: pageNumber + 1,
        };
        onAdvancePage();
      } else {
        pendingChapterPlayRef.current = null;
        setAudioMessage(`No speakable text found in "${pending.title}".`);
      }
      return;
    }

    if (!isCurrentlyOnline()) {
      if (narrationSource === 'translated') {
        setAudioMessage(`Offline mode — playing "${pending.title}" original text.`);
        onNarrationSourceChange('original');
      } else {
        pendingChapterPlayRef.current = null;
      }
      return;
    }

    // Otherwise, auto-translate this chapter page and start audio immediately once translation completes
    pendingChapterPlayRef.current = null;
    setWaitingForTranslation(true);
    setAudioMessage(`Translating "${pending.title}" (Page ${pageNumber}) to play audio…`);
    onRequestTranslatePage();
  }, [
    pageNumber,
    numPages,
    targetLang,
    narrationSource,
    parsedPage,
    translatedPage,
    sentences.length,
    isTranslatingPage,
    isOnline,
  ]);

  // Notify parent when audio is preparing (translating or loading sentence audio)
  useEffect(() => {
    onPreparingChange?.(waitingForTranslation || isLoadingSentence || Boolean(pendingChapterPlayRef.current));
  }, [waitingForTranslation, isLoadingSentence, pageNumber, onPreparingChange]);

  const getSentenceAudioUrl = async (
    text: string,
    lang: LanguageCode,
    voiceProfileId: AiVoiceProfileId,
    signal?: AbortSignal,
    sentenceKind: SentenceProsodyKind = 'narration'
  ): Promise<{ url: string; source: 'ai' | 'free' }> => {
    const stylePref = voiceStylePrefRef.current;
    const cacheKey = `v5-teacher-tts::${lang}::${stylePref}::${voiceProfileId}::${sentenceKind}::${text}`;
    const existing = objectUrlCacheRef.current.get(cacheKey);
    if (existing) return existing;

    const pending = inFlightFetchRef.current.get(cacheKey);
    if (pending) return pending;

    const fetchClip = async (): Promise<{ url: string; source: 'ai' | 'free' }> => {
      // 1. Check persistent offline Cache Storage first so previously heard / prefetched clips play offline instantly
      const cached = await getCachedTtsAudioBlob(cacheKey);
      if (cached) {
        return { url: URL.createObjectURL(cached.blob), source: cached.source };
      }

      if (!isCurrentlyOnline()) {
        // Also check alternate fallback key in persistent Cache Storage before falling back to local device voice
        const fallbackKey = `v5-teacher-tts::${lang}::free::${text}`;
        if (fallbackKey !== cacheKey) {
          const fallbackCached = await getCachedTtsAudioBlob(fallbackKey);
          if (fallbackCached) {
            return {
              url: URL.createObjectURL(fallbackCached.blob),
              source: fallbackCached.source,
            };
          }
        }
        throw new Error('OFFLINE_UNCACHED');
      }

      // 2. Always invoke /api/tts first when online so Gemini 3.8 Neural Teacher TTS runs even before /api/health resolves
      try {
        const profile = getAiVoiceProfile(voiceProfileId);
        const prefOption = getVoiceStylePreferenceOption(stylePref);
        const langName = getLanguageOption(lang).name;
        const res = await synthesizePageAudio({
          text,
          voiceName: profile.voiceName,
          voiceStyle: `${prefOption.styleDirective}. ${profile.style}`,
          languageName: langName,
          targetLang: lang,
          sentenceKind,
          modelTier: profile.modelTier,
          signal,
        });
        const clipSource: 'ai' | 'free' = res.ext === 'wav' ? 'ai' : 'free';
        putCachedTtsAudioBlob(cacheKey, res.blob, clipSource).catch(() => {});
        const url = URL.createObjectURL(res.blob);
        return { url, source: clipSource };
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        // Fall back to Free MP3 only if /api/tts completely failed
      }

      const blob = await fetchFreeTtsBlob(text, lang, signal);
      putCachedTtsAudioBlob(`v5-teacher-tts::${lang}::free::${text}`, blob, 'free').catch(() => {});
      return { url: URL.createObjectURL(blob), source: 'free' };
    };

    const promise = fetchClip()
      .then((entry) => {
        objectUrlCacheRef.current.set(cacheKey, entry);
        inFlightFetchRef.current.delete(cacheKey);
        return entry;
      })
      .catch((err) => {
        inFlightFetchRef.current.delete(cacheKey);
        throw err;
      });

    inFlightFetchRef.current.set(cacheKey, promise);
    return promise;
  };

  // Offline & Screen-Off Resilient Device Voice playback with local-voice preference + keep-alive + stall watchdog
  const speakWithDeviceVoice = (startIndex: number, session: number) => {
    if (!speechSupported) {
      setAudioMessage('Audio playback is unavailable in this browser.');
      onSpeakingChange(false);
      return;
    }

    getKeepAlive().start();

    // Pick best Web Speech voice — strictly preferring offline localService voices when offline
    const pickDeviceVoice = (preferLocalOnly: boolean): SpeechSynthesisVoice | null => {
      const liveList =
        sortedVoices.length > 0
          ? sortedVoices
          : (() => {
              try {
                const raw = window.speechSynthesis.getVoices();
                const prefix = langOption.speechLang.split('-')[0].toLowerCase();
                return raw.map((v) => ({
                  id: `${v.voiceURI || v.name}::${v.lang}`,
                  voice: v,
                  matchesLang: v.lang.toLowerCase().startsWith(prefix),
                }));
              } catch {
                return [];
              }
            })();

      const chosen = liveList.find((e) => e.id === voiceIdRef.current);
      if (preferLocalOnly) {
        if (chosen && chosen.voice.localService) return chosen.voice;
        const localMatching = liveList.find((e) => e.matchesLang && e.voice.localService);
        if (localMatching) return localMatching.voice;
        const anyLocal = liveList.find((e) => e.voice.localService);
        if (anyLocal) return anyLocal.voice;
        return chosen?.voice ?? liveList[0]?.voice ?? null;
      }

      if (chosen) return chosen.voice;
      const matching = liveList.find((e) => e.matchesLang);
      return matching?.voice ?? null;
    };

    // Periodic speechSynthesis.resume() prevents Chromium/Android from silently pausing long utterances when screen locks
    if (speechKeepAliveIntervalRef.current !== null) {
      window.clearInterval(speechKeepAliveIntervalRef.current);
    }
    speechKeepAliveIntervalRef.current = window.setInterval(() => {
      if (playSessionRef.current !== session) {
        clearSpeechTimers();
        return;
      }
      getKeepAlive().ensureRunning();
      try {
        if (window.speechSynthesis.paused || window.speechSynthesis.speaking) {
          window.speechSynthesis.resume();
        }
      } catch {
        // ignore
      }
    }, 8000);

    const runDeviceStep = (idx: number, forceLocalVoice = !isCurrentlyOnline()) => {
      if (playSessionRef.current !== session) return;
      const list = sentencesRef.current;
      if (idx >= list.length) {
        clearSpeechTimers();
        onSpeakingChange(false);
        onActiveSentenceChange(null);
        if (autoAdvanceRef.current && pageNumberRef.current < numPagesRef.current) {
          pendingAutoContinueRef.current = true;
          onAdvancePage();
        }
        return;
      }

      const span = list[idx];
      onActiveSentenceChange(span.globalIndex);
      getKeepAlive().ensureRunning();

      if (speechWatchdogTimerRef.current !== null) {
        window.clearTimeout(speechWatchdogTimerRef.current);
        speechWatchdogTimerRef.current = null;
      }

      try {
        window.speechSynthesis.cancel();
        if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
      } catch {
        // ignore
      }

      const utter = new SpeechSynthesisUtterance(span.text);
      utter.lang = langOption.speechLang;
      utter.rate = rateRef.current;
      utter.pitch = pitchRef.current;

      const selectedVoice = pickDeviceVoice(forceLocalVoice);
      if (selectedVoice) {
        utter.voice = selectedVoice;
        if (selectedVoice.lang) {
          utter.lang = selectedVoice.lang;
        }
      }

      currentUtteranceRef.current = utter;
      let settled = false;

      const advanceNext = () => {
        if (settled || playSessionRef.current !== session) return;
        settled = true;
        if (speechWatchdogTimerRef.current !== null) {
          window.clearTimeout(speechWatchdogTimerRef.current);
          speechWatchdogTimerRef.current = null;
        }
        currentUtteranceRef.current = null;
        runDeviceStep(idx + 1, !isCurrentlyOnline());
      };

      // Stall watchdog: if mobile OS drops onend while display is off, automatically move to next sentence
      const estMs = (estimateSentenceBaseSeconds(span.text) / Math.max(0.5, rateRef.current)) * 1000;
      const watchdogMs = Math.max(15000, Math.min(90000, Math.round(estMs * 2.6 + 6000)));
      speechWatchdogTimerRef.current = window.setTimeout(() => {
        if (settled || playSessionRef.current !== session) return;
        try {
          window.speechSynthesis.cancel();
        } catch {
          // ignore
        }
        advanceNext();
      }, watchdogMs);

      utter.onend = () => {
        advanceNext();
      };

      utter.onerror = (ev) => {
        if (settled || playSessionRef.current !== session) return;
        if (ev.error === 'interrupted' || ev.error === 'canceled') return;
        settled = true;
        if (speechWatchdogTimerRef.current !== null) {
          window.clearTimeout(speechWatchdogTimerRef.current);
          speechWatchdogTimerRef.current = null;
        }
        currentUtteranceRef.current = null;

        // If a cloud system voice failed (e.g. went offline), retry this same sentence with a local offline voice
        if (!forceLocalVoice) {
          runDeviceStep(idx, true);
          return;
        }

        // Skip bad sentence instead of halting the whole audiobook if more sentences follow
        if (idx + 1 < list.length) {
          runDeviceStep(idx + 1, true);
          return;
        }

        clearSpeechTimers();
        setAudioMessage(
          'Offline device voice could not speak this page. Install a local voice pack in device settings for best offline narration.'
        );
        onSpeakingChange(false);
      };

      window.speechSynthesis.speak(utter);
    };

    runDeviceStep(startIndex, !isCurrentlyOnline());
  };

  const speakFromIndex = (startIndex: number) => {
    const list = sentencesRef.current;
    if (list.length === 0) return;

    const clamped = Math.max(0, Math.min(list.length - 1, startIndex));
    const session = ++playSessionRef.current;
    pausedInPlaceRef.current = false;
    clearSpeechTimers();
    getKeepAlive().start();

    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    if (speechSupported) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }

    setAudioMessage(null);
    onSpeakingChange(true);

    if (engineModeRef.current === 'device') {
      speakWithDeviceVoice(clamped, session);
      return;
    }

    const runHdStep = async (idx: number) => {
      if (playSessionRef.current !== session) return;
      const currentList = sentencesRef.current;
      if (idx >= currentList.length) {
        setIsLoadingSentence(false);
        onSpeakingChange(false);
        onActiveSentenceChange(null);
        if (autoAdvanceRef.current && pageNumberRef.current < numPagesRef.current) {
          pendingAutoContinueRef.current = true;
          onAdvancePage();
        }
        return;
      }

      const span = currentList[idx];
      onActiveSentenceChange(span.globalIndex);
      setIsLoadingSentence(true);
      getKeepAlive().ensureRunning();

      // Prefetch up to 4 upcoming sentences into persistent offline Cache Storage while online
      if (isCurrentlyOnline()) {
        for (let ahead = 1; ahead <= 4; ahead++) {
          const nextSpan = currentList[idx + ahead];
          if (!nextSpan) break;
          const nextKind = detectSentenceProsody(
            nextSpan.text,
            blockKindByIdRef.current.get(nextSpan.blockId)
          );
          getSentenceAudioUrl(
            nextSpan.text,
            targetLangRef.current,
            aiVoiceProfileIdRef.current,
            undefined,
            nextKind
          ).catch(() => {});
        }
      }

      const spanKind = detectSentenceProsody(
        span.text,
        blockKindByIdRef.current.get(span.blockId)
      );

      try {
        const { url: audioUrl, source: clipSource } = await getSentenceAudioUrl(
          span.text,
          targetLangRef.current,
          aiVoiceProfileIdRef.current,
          controller.signal,
          spanKind
        );
        if (playSessionRef.current !== session) return;

        const audio = audioRef.current;
        if (!audio) {
          throw new Error('Audio element unavailable');
        }

        currentClipSourceRef.current = clipSource;
        const { effectiveRate, effectivePitch } = computeEffectiveTone(clipSource);

        audio.onended = null;
        audio.onerror = null;
        audio.onpause = null;
        audio.ontimeupdate = null;
        audio.src = audioUrl;
        // Preserve pitch on HTMLAudioElement so Web Audio shifter controls pitch independently
        audio.preservesPitch = true;
        audio.playbackRate = effectiveRate;

        const shifter = getPitchShifter();
        shifter?.setActive(true);
        shifter?.setPitch(effectivePitch);
        await shifter?.resume();

        setSentenceProgress(0);
        audio.ontimeupdate = () => {
          if (playSessionRef.current !== session) return;
          if (Number.isFinite(audio.duration) && audio.duration > 0) {
            setSentenceProgress(Math.min(1, Math.max(0, audio.currentTime / audio.duration)));
          }
        };

        audio.onpause = () => {
          if (
            playSessionRef.current !== session ||
            pausedInPlaceRef.current ||
            audio.ended
          ) {
            return;
          }
          // Auto-recover if mobile/desktop OS momentarily pauses playback when screen turns off
          if (unexpectedPauseTimerRef.current !== null) {
            window.clearTimeout(unexpectedPauseTimerRef.current);
          }
          unexpectedPauseTimerRef.current = window.setTimeout(() => {
            unexpectedPauseTimerRef.current = null;
            if (
              playSessionRef.current === session &&
              !pausedInPlaceRef.current &&
              audioRef.current === audio &&
              audio.paused &&
              !audio.ended
            ) {
              getKeepAlive().ensureRunning();
              pitchShifterRef.current?.resume().catch(() => {});
              audio.play().catch(() => {
                if (playSessionRef.current === session && speechSupported) {
                  speakWithDeviceVoice(idx, session);
                }
              });
            }
          }, 250);
        };

        audio.onended = () => {
          if (playSessionRef.current !== session) return;
          if (unexpectedPauseTimerRef.current !== null) {
            window.clearTimeout(unexpectedPauseTimerRef.current);
            unexpectedPauseTimerRef.current = null;
          }
          setSentenceProgress(1);
          runHdStep(idx + 1);
        };

        audio.onerror = () => {
          if (playSessionRef.current !== session) return;
          setIsLoadingSentence(false);
          speakWithDeviceVoice(idx, session);
        };

        await audio.play();
        if (playSessionRef.current === session) {
          setIsLoadingSentence(false);
        }
      } catch (err) {
        if (playSessionRef.current !== session) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setIsLoadingSentence(false);

        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          setAudioMessage('Tap Listen once more to allow audio playback in your browser.');
          onSpeakingChange(false);
          return;
        }

        if (speechSupported) {
          if (!isCurrentlyOnline()) {
            setAudioMessage('Offline mode — continuing seamlessly with offline device voice.');
          }
          speakWithDeviceVoice(idx, session);
        } else {
          setAudioMessage(
            err instanceof Error ? err.message : 'Unable to play audio for this sentence.'
          );
          onSpeakingChange(false);
        }
      }
    };

    runHdStep(clamped);
  };

  // Auto-start playback once translation finishes if user tapped Listen or sought on an untranslated page
  useEffect(() => {
    if (waitingForTranslation && !isTranslatingPage && sentences.length > 0) {
      setWaitingForTranslation(false);
      const pendingSentence = pendingSentenceStartRef.current;
      const pending = pendingSeekRef.current;
      if (pendingSentence && pendingSentence.targetPage === pageNumber) {
        pendingSentenceStartRef.current = null;
        const clampedIdx = Math.min(
          sentences.length - 1,
          Math.max(0, pendingSentence.sentenceIndex)
        );
        speakFromIndex(clampedIdx);
      } else if (pending && pending.targetPage === pageNumber) {
        pendingSeekRef.current = null;
        const targetIdx = Math.min(
          sentences.length - 1,
          Math.max(0, Math.floor(pending.fraction * sentences.length))
        );
        speakFromIndex(targetIdx);
      } else {
        speakFromIndex(0);
      }
    } else if (waitingForTranslation && !isTranslatingPage && sentences.length === 0) {
      setWaitingForTranslation(false);
      // If translation failed because device went offline, immediately fall back to original text so playback continues
      if (!isCurrentlyOnline() && parsedPage && !parsedPage.isBlank && narrationSource === 'translated') {
        pendingAutoContinueRef.current = true;
        setAudioMessage('Offline mode — reading original text with offline voice.');
        onNarrationSourceChange('original');
      }
    }
  }, [waitingForTranslation, isTranslatingPage, sentences.length, pageNumber, parsedPage, narrationSource]);

  useEffect(() => {
    if (jumpRequest && sentences.length > 0) {
      speakFromIndex(jumpRequest.index);
    }
  }, [jumpRequest]);

  const SILENT_UNLOCK_DATA_URI =
    'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

  const unlockAudioElement = () => {
    getKeepAlive().unlock();
    const audio = audioRef.current;
    pitchShifterRef.current?.resume().catch(() => {});
    if (!audio || audioUnlockedRef.current) return;
    try {
      audio.src = SILENT_UNLOCK_DATA_URI;
      const p = audio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          // Only pause if real TTS audio hasn't already replaced the silent unlock URI
          if (audio.src === SILENT_UNLOCK_DATA_URI) {
            audio.pause();
          }
          audioUnlockedRef.current = true;
        }).catch(() => {});
      }
    } catch {
      // ignore
    }
  };

  const handlePlayPause = () => {
    unlockAudioElement();

    if (sentences.length === 0) {
      if (parsedPage && !parsedPage.isBlank && !isTranslatingPage) {
        if (!isCurrentlyOnline() && narrationSource === 'translated') {
          pendingAutoContinueRef.current = true;
          setAudioMessage('Offline mode — reading original text with offline voice.');
          onNarrationSourceChange('original');
          return;
        }
        setWaitingForTranslation(true);
        setAudioMessage(
          `Translating Page ${pageNumber} into ${langOption.name} to start listening…`
        );
        onRequestTranslatePage();
      } else {
        setAudioMessage('No speakable text found on this page.');
      }
      return;
    }

    if (isSpeaking) {
      if (engineMode === 'hd' && audioRef.current && !isLoadingSentence) {
        pausedInPlaceRef.current = true;
        audioRef.current.pause();
        onSpeakingChange(false);
      } else {
        stopPlayback(false);
      }
      return;
    }

    if (
      engineMode === 'hd' &&
      pausedInPlaceRef.current &&
      audioRef.current &&
      audioRef.current.src &&
      activeSentenceIndex !== null
    ) {
      pausedInPlaceRef.current = false;
      getKeepAlive().start();
      const { effectiveRate, effectivePitch } = computeEffectiveTone(
        currentClipSourceRef.current
      );
      audioRef.current.preservesPitch = true;
      audioRef.current.playbackRate = effectiveRate;
      const shifter = getPitchShifter();
      shifter?.setActive(true);
      shifter?.setPitch(effectivePitch);
      shifter?.resume().catch(() => {});
      onSpeakingChange(true);
      audioRef.current.play().catch(() => {
        speakFromIndex(activeSentenceIndex);
      });
      return;
    }

    const startAt = activeSentenceIndex !== null ? activeSentenceIndex : 0;
    speakFromIndex(startAt);
  };

  // Expose imperative controls so Chapter List Play/Pause buttons can unlock mobile audio synchronously on click
  if (controlRef) {
    controlRef.current = {
      unlockAudio: () => {
        unlockAudioElement();
      },
      pausePlayback: () => {
        pendingChapterPlayRef.current = null;
        pendingSentenceStartRef.current = null;
        pendingAutoContinueRef.current = false;
        setWaitingForTranslation(false);
        if (engineModeRef.current === 'hd' && audioRef.current && !isLoadingSentence) {
          pausedInPlaceRef.current = true;
          audioRef.current.pause();
          onSpeakingChange(false);
        } else {
          stopPlayback(false);
        }
      },
      playCurrentPage: () => {
        pendingChapterPlayRef.current = null;
        pendingSentenceStartRef.current = null;
        setAutoAdvance(true);
        autoAdvanceRef.current = true;
        if (!isSpeaking) {
          handlePlayPause();
        }
      },
      playFromSentence: (sentenceIndex, targetPage) => {
        unlockAudioElement();
        pendingChapterPlayRef.current = null;
        setAutoAdvance(true);
        autoAdvanceRef.current = true;
        const destPage = targetPage ?? pageNumberRef.current;
        const safeIdx = Math.max(0, sentenceIndex);
        if (
          destPage === pageNumberRef.current &&
          sentencesRef.current.length > 0 &&
          (narrationSource === 'original' ||
            (translatedPage && translatedPage.pageNumber === destPage))
        ) {
          pendingSentenceStartRef.current = null;
          speakFromIndex(Math.min(sentencesRef.current.length - 1, safeIdx));
        } else {
          pendingSentenceStartRef.current = {
            targetPage: destPage,
            sentenceIndex: safeIdx,
          };
        }
      },
      queueChapterPlayback: (targetPage, endPage, chapterTitle) => {
        unlockAudioElement();
        pendingSentenceStartRef.current = null;
        setAutoAdvance(true);
        autoAdvanceRef.current = true;
        pendingChapterPlayRef.current = { targetPage, endPage, title: chapterTitle };
      },
    };
  }

  const handleSpeedChange = (newRate: number) => {
    const rounded = Math.round(newRate * 20) / 20;
    setRate(rounded);
    rateRef.current = rounded;
    if (engineMode === 'hd' && audioRef.current) {
      const { effectiveRate } = computeEffectiveTone(currentClipSourceRef.current);
      audioRef.current.preservesPitch = true;
      audioRef.current.playbackRate = effectiveRate;
    } else if (isSpeaking && activeSentenceIndex !== null) {
      speakFromIndex(activeSentenceIndex);
    }
  };

  const handlePitchChange = (newPitch: number) => {
    const rounded = Math.round(newPitch * 20) / 20;
    setPitch(rounded);
    pitchRef.current = rounded;
    if (engineMode === 'hd') {
      const { effectivePitch } = computeEffectiveTone(currentClipSourceRef.current);
      const shifter = getPitchShifter();
      shifter?.setPitch(effectivePitch);
    } else if (isSpeaking && activeSentenceIndex !== null) {
      speakFromIndex(activeSentenceIndex);
    }
  };

  const stopNeuralPreview = () => {
    if (previewAbortRef.current) {
      previewAbortRef.current.abort();
      previewAbortRef.current = null;
    }
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.src = '';
    }
    setPreviewingNeuralId(null);
  };

  const handleVoiceProfileChange = (nextProfileId: AiVoiceProfileId) => {
    unlockAudioElement();
    stopNeuralPreview();
    setAiVoiceProfileId(nextProfileId);
    aiVoiceProfileIdRef.current = nextProfileId;
    const syncedPref = getVoiceStylePreferenceFromProfile(nextProfileId);
    prevVoiceStylePrefRef.current = syncedPref;
    voiceStylePrefRef.current = syncedPref;
    onVoiceStylePreferenceChange?.(syncedPref);
    setNeuralMenuOpen(false);

    const wasPlaying = isSpeaking;
    const resumeIdx = activeSentenceIndex ?? 0;

    // Automatically switch narration engine to Neural HD when user chooses a Neural TTS voice
    if (engineModeRef.current !== 'hd') {
      stopPlayback(false);
      setEngineMode('hd');
      engineModeRef.current = 'hd';
      if (wasPlaying && sentences.length > 0) {
        setTimeout(() => speakFromIndex(resumeIdx), 30);
      }
      return;
    }

    // Re-synthesize current sentence immediately in the newly chosen Neural voice
    if (wasPlaying && activeSentenceIndex !== null) {
      speakFromIndex(activeSentenceIndex);
    } else {
      pausedInPlaceRef.current = false;
    }
  };

  const handlePreviewNeuralVoice = async (
    profileId: AiVoiceProfileId,
    e: React.MouseEvent
  ) => {
    e.stopPropagation();

    if (previewingNeuralId === profileId) {
      stopNeuralPreview();
      return;
    }

    stopNeuralPreview();
    if (isSpeaking) {
      stopPlayback(false);
    }

    // Synchronously create & unlock preview Audio element INSIDE the click gesture so mobile Safari/Chrome allow playback after async fetch
    const el = previewAudioRef.current ?? new Audio();
    el.setAttribute('playsinline', 'true');
    el.setAttribute('webkit-playsinline', 'true');
    previewAudioRef.current = el;
    try {
      el.src = SILENT_UNLOCK_DATA_URI;
      const unlockP = el.play();
      if (unlockP && typeof unlockP.then === 'function') {
        unlockP
          .then(() => {
            if (el.src === SILENT_UNLOCK_DATA_URI) {
              el.pause();
            }
          })
          .catch(() => {});
      }
    } catch {
      // ignore unlock errors
    }

    const profile = getAiVoiceProfile(profileId);
    const controller = new AbortController();
    previewAbortRef.current = controller;
    setPreviewingNeuralId(profileId);

    const sampleSource =
      sentences[activeSentenceIndex ?? 0]?.text ||
      (effectiveAudioLang === 'hi' || effectiveAudioLang === 'hinglish'
        ? `नमस्ते! मैं ${profile.name} हूँ — आज हम इस पाठ को बिल्कुल सहज लय और स्पष्ट उतार-चढ़ाव के साथ समझेंगे, क्या आप तैयार हैं?`
        : `Hello! I'm ${profile.name}. Let's explore this chapter together with clear emphasis, natural rhythm, and engaging intonation — ready to begin?`);
    const sampleText = sampleSource.slice(0, 145);
    const sampleKind = detectSentenceProsody(sampleText);

    try {
      const { url, source } = await getSentenceAudioUrl(
        sampleText,
        effectiveAudioLang,
        profileId,
        controller.signal,
        sampleKind
      );
      if (controller.signal.aborted) return;

      el.onended = () => setPreviewingNeuralId(null);
      el.onerror = () => setPreviewingNeuralId(null);
      el.src = url;
      el.preservesPitch = true;
      el.playbackRate =
        source === 'ai'
          ? rateRef.current
          : Math.max(0.5, Math.min(2.0, rateRef.current * profile.fallbackRate));
      await el.play();
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setAudioMessage(`Unable to preview ${profile.name} voice right now.`);
      }
      setPreviewingNeuralId(null);
    }
  };

  const handleResetTone = () => {
    handleSpeedChange(1.0);
    handlePitchChange(1.0);
  };

  const handleEngineSwitch = (nextMode: SpeechEngineMode) => {
    if (nextMode === engineMode) return;
    const wasPlaying = isSpeaking;
    const resumeIdx = activeSentenceIndex ?? 0;
    stopPlayback(false);
    setEngineMode(nextMode);
    engineModeRef.current = nextMode;
    if (nextMode === 'device') {
      refreshSystemVoices();
    }
    if (wasPlaying && sentences.length > 0) {
      setTimeout(() => speakFromIndex(resumeIdx), 30);
    }
  };

  const handleSystemVoiceChange = (nextVoiceId: string) => {
    setSelectedVoiceId(nextVoiceId);
    voiceIdRef.current = nextVoiceId;
    try {
      const storageKey = `bhashabook-system-voice::${langOption.speechLang}`;
      if (nextVoiceId) {
        localStorage.setItem(storageKey, nextVoiceId);
      } else {
        localStorage.removeItem(storageKey);
      }
    } catch {
      // ignore storage errors
    }

    const wasPlaying = isSpeaking;
    const resumeIdx = activeSentenceIndex ?? 0;
    // Automatically switch narration engine to System Voice when a user chooses a Web Speech API voice
    if (engineModeRef.current !== 'device') {
      stopPlayback(false);
      setEngineMode('device');
      engineModeRef.current = 'device';
      if (wasPlaying && sentences.length > 0) {
        setTimeout(() => speakFromIndex(resumeIdx), 30);
      }
      return;
    }

    if (wasPlaying && activeSentenceIndex !== null) {
      speakFromIndex(activeSentenceIndex);
    }
  };

  const handlePreviewSystemVoice = () => {
    if (!speechSupported) return;
    refreshSystemVoices();
    const chosenEntry = sortedVoices.find((entry) => entry.id === voiceIdRef.current);
    const sampleSource =
      sentences[activeSentenceIndex ?? 0]?.text ||
      (langOption.code === 'hi'
        ? 'नमस्ते, यह आपकी चयनित सिस्टम आवाज़ का नमूना है।'
        : `Hello, this is a preview of ${chosenEntry?.voice.name || 'your selected system voice'}.`);
    const sampleText = sampleSource.slice(0, 90);

    try {
      if (isSpeaking) {
        stopPlayback(false);
      } else {
        window.speechSynthesis.cancel();
      }
      const utter = new SpeechSynthesisUtterance(sampleText);
      utter.lang = chosenEntry?.voice.lang || langOption.speechLang;
      utter.rate = rateRef.current;
      utter.pitch = pitchRef.current;
      if (chosenEntry) {
        utter.voice = chosenEntry.voice;
      }
      window.speechSynthesis.speak(utter);
    } catch {
      setAudioMessage('Unable to preview system voice in this browser.');
    }
  };

  const handleDownloadAudio = async () => {
    const useOriginal = narrationSource === 'original' || !translatedPage;
    const narrationText = useOriginal
      ? parsedPage
        ? parsedPage.blocks.map((b) => b.text).join('\n\n')
        : ''
      : buildAudiobookText(translatedPage);

    if (!narrationText.trim()) {
      setAudioMessage('No text available on this page to generate audio.');
      return;
    }

    setIsDownloadingAudio(true);
    setAudioMessage(null);
    try {
      const effectiveLang: LanguageCode = useOriginal ? 'en' : targetLang;
      const effectiveLangOption = getLanguageOption(effectiveLang);
      const prefOption = getVoiceStylePreferenceOption(voiceStylePrefRef.current);
      const { blob, ext } = await synthesizePageAudio({
        text: narrationText,
        voiceName: activeVoiceProfile.voiceName,
        voiceStyle: `${prefOption.styleDirective}. ${activeVoiceProfile.style}`,
        languageName: effectiveLangOption.name,
        targetLang: effectiveLang,
        sentenceKind: 'narration',
        modelTier: activeVoiceProfile.modelTier,
      });
      const slug = bookTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 36);
      const fileName = `${slug || 'audiobook'}-p${pageNumber}-${effectiveLang}-${activeVoiceProfile.id}.${ext}`;
      downloadBlob(blob, fileName);
      setAudioMessage(
        `Downloaded ${fileName} (${activeVoiceProfile.name} · ${activeVoiceProfile.tagline})`
      );
    } catch (err) {
      setAudioMessage(
        err instanceof Error ? err.message : 'Unable to generate downloadable audio.'
      );
    } finally {
      setIsDownloadingAudio(false);
    }
  };

  const hasText = sentences.length > 0;
  const canTranslateAndPlay = Boolean(parsedPage && !parsedPage.isBlank);
  const canClickListen = hasText || canTranslateAndPlay;
  const currentPos = activeSentenceIndex !== null ? activeSentenceIndex + 1 : 0;
  const isCustomTone = Math.abs(rate - 1.0) > 0.01 || Math.abs(pitch - 1.0) > 0.01;

  // Build speed-adjusted chapter audio timeline for remaining duration & interactive seek slider
  const chapterTimeline = useMemo(() => {
    const startPage = currentChapter ? Math.max(1, currentChapter.startPage) : pageNumber;
    const endPage = currentChapter
      ? Math.min(numPages, Math.max(startPage, currentChapter.endPage))
      : pageNumber;

    const sentenceBaseDurations = sentences.map((s) => estimateSentenceBaseSeconds(s.text));
    const currentPageFromSentences = sentenceBaseDurations.reduce((acc, d) => acc + d, 0);

    const parsedWordCount = parsedPage
      ? parsedPage.blocks.reduce(
          (acc, b) => acc + b.text.trim().split(/\s+/).filter(Boolean).length,
          0
        )
      : 0;
    const currentPageBaseSec =
      currentPageFromSentences > 0
        ? currentPageFromSentences
        : parsedWordCount > 0
        ? Math.max(8, parsedWordCount / 2.46)
        : 45;

    // Derive fallback average page duration from known translated pages in this chapter
    const knownDurations: number[] = [];
    if (currentPageBaseSec > 0) knownDurations.push(currentPageBaseSec);
    for (const [pgKey, wc] of Object.entries(chapterPageWordCounts)) {
      const pNum = Number(pgKey);
      if (pNum >= startPage && pNum <= endPage && pNum !== pageNumber && wc > 0) {
        knownDurations.push(Math.max(10, wc / 2.46));
      }
    }
    const avgPageBaseSec =
      knownDurations.length > 0
        ? knownDurations.reduce((a, b) => a + b, 0) / knownDurations.length
        : 55;

    const speedDivisor = Math.max(0.5, rate);
    const pages: Array<{ pageNumber: number; startSec: number; durationSec: number }> = [];
    let cursorSec = 0;

    for (let p = startPage; p <= endPage; p++) {
      let baseSec = avgPageBaseSec;
      if (p === pageNumber) {
        baseSec = currentPageBaseSec;
      } else if (chapterPageWordCounts[p] && chapterPageWordCounts[p] > 0) {
        baseSec = Math.max(8, chapterPageWordCounts[p] / 2.46);
      }
      const durationSec = Math.max(4, baseSec / speedDivisor);
      pages.push({ pageNumber: p, startSec: cursorSec, durationSec });
      cursorSec += durationSec;
    }

    const totalSec = Math.max(1, cursorSec);
    const currentPageSeg = pages.find((seg) => seg.pageNumber === pageNumber) ?? pages[0];

    let currentPageElapsedSec = 0;
    if (sentences.length > 0 && activeSentenceIndex !== null) {
      const idxInList = sentences.findIndex((s) => s.globalIndex === activeSentenceIndex);
      if (idxInList >= 0) {
        let baseElapsed = 0;
        for (let i = 0; i < idxInList; i++) {
          baseElapsed += sentenceBaseDurations[i];
        }
        baseElapsed += sentenceBaseDurations[idxInList] * Math.min(1, Math.max(0, sentenceProgress));
        currentPageElapsedSec = Math.min(
          currentPageSeg.durationSec,
          baseElapsed / speedDivisor
        );
      }
    }

    const elapsedSec = Math.min(
      totalSec,
      Math.max(0, (currentPageSeg?.startSec ?? 0) + currentPageElapsedSec)
    );
    const remainingSec = Math.max(0, totalSec - elapsedSec);

    return {
      startPage,
      endPage,
      chapterLabel: currentChapter?.title || `Page ${pageNumber}`,
      pages,
      sentenceDurationsSec: sentenceBaseDurations.map((d) => d / speedDivisor),
      totalSec,
      elapsedSec,
      remainingSec,
    };
  }, [
    currentChapter,
    pageNumber,
    numPages,
    sentences,
    parsedPage,
    chapterPageWordCounts,
    rate,
    activeSentenceIndex,
    sentenceProgress,
  ]);

  const commitSeek = (targetSec: number) => {
    const clampedSec = Math.max(0, Math.min(chapterTimeline.totalSec, targetSec));
    const seg =
      chapterTimeline.pages.find(
        (p) => clampedSec >= p.startSec && clampedSec <= p.startSec + p.durationSec
      ) ?? chapterTimeline.pages[chapterTimeline.pages.length - 1];
    if (!seg) return;

    const offsetInPage = Math.max(0, clampedSec - seg.startSec);
    const fraction = Math.min(0.999, Math.max(0, offsetInPage / Math.max(1, seg.durationSec)));

    // Seeking within the currently displayed page
    if (seg.pageNumber === pageNumber) {
      if (sentences.length === 0) {
        if (canTranslateAndPlay && !isTranslatingPage) {
          pendingSeekRef.current = { targetPage: pageNumber, fraction, autoPlay: true };
          if (!isCurrentlyOnline() && narrationSource === 'translated') {
            setAudioMessage('Offline mode — reading original text.');
            onNarrationSourceChange('original');
            return;
          }
          setWaitingForTranslation(true);
          onRequestTranslatePage();
        }
        return;
      }

      let accum = 0;
      let targetIdx = sentences.length - 1;
      let intraRatio = 0;
      for (let i = 0; i < chapterTimeline.sentenceDurationsSec.length; i++) {
        const dur = chapterTimeline.sentenceDurationsSec[i];
        if (offsetInPage <= accum + dur || i === chapterTimeline.sentenceDurationsSec.length - 1) {
          targetIdx = i;
          intraRatio = Math.min(0.95, Math.max(0, (offsetInPage - accum) / Math.max(0.2, dur)));
          break;
        }
        accum += dur;
      }

      const targetSpan = sentences[targetIdx];
      // Fast-path exact intra-sentence seek when already on that HD audio clip
      if (
        engineMode === 'hd' &&
        targetSpan &&
        targetSpan.globalIndex === activeSentenceIndex &&
        audioRef.current &&
        Number.isFinite(audioRef.current.duration) &&
        audioRef.current.duration > 0
      ) {
        audioRef.current.currentTime = intraRatio * audioRef.current.duration;
        setSentenceProgress(intraRatio);
        return;
      }

      unlockAudioElement();
      setSentenceProgress(0);
      speakFromIndex(targetIdx);
      return;
    }

    // Seeking to another page inside the current chapter
    if (onSeekToPage) {
      unlockAudioElement();
      pendingSeekRef.current = {
        targetPage: seg.pageNumber,
        fraction,
        autoPlay: true,
      };
      onSeekToPage(seg.pageNumber);
    }
  };

  const resolveTimelinePoint = (targetSec: number) => {
    const clampedSec = Math.max(0, Math.min(chapterTimeline.totalSec, targetSec));
    const percent = Math.min(100, Math.max(0, (clampedSec / Math.max(1, chapterTimeline.totalSec)) * 100));
    const seg =
      chapterTimeline.pages.find(
        (p) => clampedSec >= p.startSec && clampedSec <= p.startSec + p.durationSec
      ) ?? chapterTimeline.pages[chapterTimeline.pages.length - 1];
    const targetPage = seg?.pageNumber ?? pageNumber;

    let sentencePreview: string | null = null;
    if (seg && targetPage === pageNumber && sentences.length > 0) {
      const offsetInPage = Math.max(0, clampedSec - seg.startSec);
      let accum = 0;
      for (let i = 0; i < chapterTimeline.sentenceDurationsSec.length; i++) {
        const dur = chapterTimeline.sentenceDurationsSec[i];
        if (offsetInPage <= accum + dur || i === chapterTimeline.sentenceDurationsSec.length - 1) {
          const text = sentences[i]?.text?.trim() ?? '';
          if (text) {
            sentencePreview = text.length > 56 ? `${text.slice(0, 56).trim()}…` : text;
          }
          break;
        }
        accum += dur;
      }
    }

    return { sec: clampedSec, percent, pageNumber: targetPage, sentencePreview };
  };

  const clientXToTimelineSec = (clientX: number): number | null => {
    const track = timelineTrackRef.current;
    if (!track) return null;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * chapterTimeline.totalSec;
  };

  const isTimelineDisabled = !canClickListen && chapterTimeline.pages.length <= 1;

  const displayedElapsedSec = scrubSec !== null ? scrubSec : chapterTimeline.elapsedSec;
  const displayedRemainingSec = Math.max(0, chapterTimeline.totalSec - displayedElapsedSec);
  const progressPercent = Math.min(
    100,
    Math.max(0, (displayedElapsedSec / Math.max(1, chapterTimeline.totalSec)) * 100)
  );
  const activePageSeg = chapterTimeline.pages.find((p) => p.pageNumber === pageNumber) ?? null;
  const previewSec = scrubSec !== null ? scrubSec : hoverSec;
  const previewInfo = previewSec !== null ? resolveTimelinePoint(previewSec) : null;
  const scrubTargetPage = previewInfo?.pageNumber ?? null;

  // Sentence tick positions for single-page timelines (keeps the visual rhythm scannable without clutter)
  const sentenceTickPercents = useMemo(() => {
    if (chapterTimeline.pages.length !== 1) return [];
    const count = chapterTimeline.sentenceDurationsSec.length;
    if (count < 2 || count > 36) return [];
    const total = Math.max(1, chapterTimeline.totalSec);
    const ticks: number[] = [];
    let accum = 0;
    for (let i = 0; i < count - 1; i++) {
      accum += chapterTimeline.sentenceDurationsSec[i];
      ticks.push((accum / total) * 100);
    }
    return ticks;
  }, [chapterTimeline]);

  const sleepDisplay =
    sleepSecondsLeft > 0
      ? `${Math.floor(sleepSecondsLeft / 60)}:${String(sleepSecondsLeft % 60).padStart(2, '0')}`
      : null;

  // Keep Media Session metadata, position state & lock-screen / Bluetooth controls in sync
  const mediaHandlersRef = useRef({
    onPlay: () => {},
    onPause: () => {},
    onStop: () => {},
    onPreviousTrack: () => {},
    onNextTrack: () => {},
    onSeekBackward: () => {},
    onSeekForward: () => {},
  });

  mediaHandlersRef.current = {
    onPlay: () => {
      if (!isSpeakingRef.current) {
        handlePlayPause();
      }
    },
    onPause: () => {
      if (isSpeakingRef.current) {
        handlePlayPause();
      }
    },
    onStop: () => {
      pendingAutoContinueRef.current = false;
      pendingChapterPlayRef.current = null;
      stopPlayback(true);
    },
    onPreviousTrack: () => {
      const idx = activeSentenceIndexRef.current ?? 0;
      if (idx > 0 && sentencesRef.current.length > 0) {
        speakFromIndex(idx - 1);
      } else if (pageNumberRef.current > 1 && onSeekToPage) {
        pendingSeekRef.current = {
          targetPage: pageNumberRef.current - 1,
          fraction: 0,
          autoPlay: true,
        };
        onSeekToPage(pageNumberRef.current - 1);
      }
    },
    onNextTrack: () => {
      const idx = activeSentenceIndexRef.current ?? -1;
      if (idx + 1 < sentencesRef.current.length) {
        speakFromIndex(idx + 1);
      } else if (pageNumberRef.current < numPagesRef.current) {
        pendingAutoContinueRef.current = true;
        onAdvancePage();
      }
    },
    onSeekBackward: () => {
      commitSeek(Math.max(0, chapterTimeline.elapsedSec - 15));
    },
    onSeekForward: () => {
      commitSeek(Math.min(chapterTimeline.totalSec, chapterTimeline.elapsedSec + 15));
    },
  };

  useEffect(() => {
    return registerMediaSessionHandlers({
      onPlay: () => mediaHandlersRef.current.onPlay(),
      onPause: () => mediaHandlersRef.current.onPause(),
      onStop: () => mediaHandlersRef.current.onStop(),
      onPreviousTrack: () => mediaHandlersRef.current.onPreviousTrack(),
      onNextTrack: () => mediaHandlersRef.current.onNextTrack(),
      onSeekBackward: () => mediaHandlersRef.current.onSeekBackward(),
      onSeekForward: () => mediaHandlersRef.current.onSeekForward(),
    });
  }, []);

  useEffect(() => {
    const state: 'playing' | 'paused' | 'none' = isSpeaking
      ? 'playing'
      : activeSentenceIndex !== null
      ? 'paused'
      : 'none';
    updateMediaSessionState({
      title: `${bookTitle} · Page ${pageNumber}`,
      artist: bookAuthor || 'BhashaBook Audiobook',
      album: chapterTimeline.chapterLabel,
      artworkUrl: bookCoverUrl,
      playbackState: state,
      durationSec: chapterTimeline.totalSec,
      positionSec: chapterTimeline.elapsedSec,
      playbackRate: rate,
    });
  }, [
    bookTitle,
    bookAuthor,
    bookCoverUrl,
    pageNumber,
    chapterTimeline.chapterLabel,
    chapterTimeline.totalSec,
    Math.floor(chapterTimeline.elapsedSec),
    isSpeaking,
    activeSentenceIndex,
    rate,
  ]);

  return (
    <div className="no-print sticky bottom-0 z-20 border-t border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 bg-[#FAF9F5]/95 sepia:bg-[#F4ECD8]/95 dark:bg-[#141312]/95 backdrop-blur-sm">
      <audio ref={audioRef} playsInline preload="auto" className="hidden" />

      {audioMessage && (
        <div className="px-4 py-1.5 text-xs bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 border-b border-amber-200/70 dark:border-amber-900/50 flex items-center justify-between gap-2">
          <span className="truncate">{audioMessage}</span>
          <button
            type="button"
            onClick={() => setAudioMessage(null)}
            className="text-xs underline shrink-0 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Visual Chapter Audio Timeline & Click-to-Seek Progress Bar */}
      <div className="border-b border-stone-200/70 sepia:border-[#DFD4BC]/80 dark:border-stone-800/80">
        <div className="max-w-[1680px] mx-auto px-3 sm:px-6 pt-1.5 pb-1 flex items-center gap-2.5 sm:gap-3">
          {/* Elapsed Time & Chapter Context */}
          <div className="flex items-center gap-2 shrink-0 min-w-0">
            <span className="font-mono-num tabular-nums text-[11px] font-medium text-stone-700 dark:text-stone-300 w-10 sm:w-11 text-right">
              {formatAudioDuration(displayedElapsedSec)}
            </span>
            <span
              title={chapterTimeline.chapterLabel}
              className="hidden md:inline-block text-[11px] text-stone-500 dark:text-stone-400 truncate max-w-[180px]"
            >
              {scrubSec !== null && scrubTargetPage !== null && scrubTargetPage !== pageNumber
                ? `Seek to Page ${scrubTargetPage}`
                : chapterTimeline.chapterLabel}
            </span>
          </div>

          {/* Interactive Visual Timeline Rail (Click-to-Seek, Drag-to-Scrub, Keyboard Accessible) */}
          <div
            ref={timelineTrackRef}
            role="slider"
            tabIndex={isTimelineDisabled ? -1 : 0}
            aria-label={`Seek chapter audio timeline (${chapterTimeline.chapterLabel})`}
            aria-disabled={isTimelineDisabled}
            aria-valuemin={0}
            aria-valuemax={Math.round(chapterTimeline.totalSec)}
            aria-valuenow={Math.round(displayedElapsedSec)}
            aria-valuetext={`${formatAudioDuration(displayedElapsedSec)} of ${formatAudioDuration(chapterTimeline.totalSec)}, ${formatAudioDuration(displayedRemainingSec)} remaining in ${chapterTimeline.chapterLabel}`}
            onPointerDown={(e) => {
              if (isTimelineDisabled || e.button !== 0) return;
              const nextSec = clientXToTimelineSec(e.clientX);
              if (nextSec === null) return;
              e.preventDefault();
              isDraggingTimelineRef.current = true;
              setScrubSec(nextSec);
              scrubSecRef.current = nextSec;
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                // ignore pointer capture fallback
              }
            }}
            onPointerMove={(e) => {
              if (isTimelineDisabled) return;
              const nextSec = clientXToTimelineSec(e.clientX);
              if (nextSec === null) return;
              if (isDraggingTimelineRef.current) {
                setScrubSec(nextSec);
                scrubSecRef.current = nextSec;
              } else {
                setHoverSec(nextSec);
              }
            }}
            onPointerUp={(e) => {
              if (!isDraggingTimelineRef.current) return;
              isDraggingTimelineRef.current = false;
              const releaseSec = clientXToTimelineSec(e.clientX) ?? scrubSecRef.current;
              setScrubSec(null);
              scrubSecRef.current = null;
              try {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                }
              } catch {
                // ignore
              }
              if (releaseSec !== null) {
                commitSeek(releaseSec);
              }
            }}
            onPointerCancel={() => {
              isDraggingTimelineRef.current = false;
              setScrubSec(null);
              scrubSecRef.current = null;
            }}
            onPointerLeave={() => {
              if (!isDraggingTimelineRef.current) {
                setHoverSec(null);
              }
            }}
            onKeyDown={(e) => {
              if (isTimelineDisabled) return;
              const base = chapterTimeline.elapsedSec;
              let target: number | null = null;
              if (e.key === 'ArrowRight' || e.key === 'ArrowUp') target = base + 5;
              else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') target = base - 5;
              else if (e.key === 'PageUp') target = base + 15;
              else if (e.key === 'PageDown') target = base - 15;
              else if (e.key === 'Home') target = 0;
              else if (e.key === 'End') target = chapterTimeline.totalSec;
              if (target !== null) {
                e.preventDefault();
                commitSeek(target);
              }
            }}
            className={`relative flex-1 h-6 flex items-center select-none touch-none group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700/60 dark:focus-visible:ring-amber-400/60 rounded ${
              isTimelineDisabled ? 'opacity-45 cursor-not-allowed' : 'cursor-pointer'
            }`}
          >
            {/* Floating Hover / Scrub Preview Tooltip */}
            {previewInfo && !isTimelineDisabled && (
              <div
                style={{
                  left: `${Math.min(92, Math.max(8, previewInfo.percent))}%`,
                }}
                className="pointer-events-none absolute -top-9 -translate-x-1/2 z-30 max-w-[260px] px-2.5 py-1 rounded-md bg-stone-900 dark:bg-stone-100 text-stone-50 dark:text-stone-900 shadow-md text-[11px] leading-tight whitespace-nowrap flex items-center gap-1.5"
              >
                <span className="font-mono-num tabular-nums font-semibold">
                  {formatAudioDuration(previewInfo.sec)}
                </span>
                {chapterTimeline.pages.length > 1 && (
                  <span className="text-stone-300 dark:text-stone-600">
                    · p.{previewInfo.pageNumber}
                  </span>
                )}
                {previewInfo.sentencePreview && (
                  <span className="hidden sm:inline text-stone-300 dark:text-stone-600 truncate max-w-[165px]">
                    · {previewInfo.sentencePreview}
                  </span>
                )}
              </div>
            )}

            {/* Base Timeline Track */}
            <div className="w-full h-1.5 group-hover:h-2 transition-[height] duration-150 rounded-full bg-stone-200/90 sepia:bg-[#DFD4BC] dark:bg-stone-800 overflow-hidden relative">
              {/* Highlight Current Page Band inside Multi-Page Chapter */}
              {activePageSeg && chapterTimeline.pages.length > 1 && (
                <div
                  aria-hidden="true"
                  style={{
                    left: `${(activePageSeg.startSec / Math.max(1, chapterTimeline.totalSec)) * 100}%`,
                    width: `${(activePageSeg.durationSec / Math.max(1, chapterTimeline.totalSec)) * 100}%`,
                  }}
                  className="absolute top-0 bottom-0 bg-amber-700/15 dark:bg-amber-400/15 pointer-events-none"
                />
              )}

              {/* Subtle Hover Target Fill */}
              {hoverSec !== null && scrubSec === null && previewInfo && (
                <div
                  aria-hidden="true"
                  style={{ width: `${previewInfo.percent}%` }}
                  className="absolute inset-y-0 left-0 bg-stone-400/35 dark:bg-stone-500/35 pointer-events-none"
                />
              )}

              {/* Filled Chapter Progress */}
              <div
                style={{ width: `${progressPercent}%` }}
                className="relative h-full bg-amber-700 dark:bg-amber-500 transition-[width] duration-150 ease-out"
              />

              {/* Multi-Page Chapter Segment Boundary Ticks */}
              {chapterTimeline.pages.length > 1 && chapterTimeline.pages.length <= 28 && (
                <>
                  {chapterTimeline.pages.slice(1).map((seg) => (
                    <span
                      key={seg.pageNumber}
                      aria-hidden="true"
                      style={{
                        left: `${(seg.startSec / Math.max(1, chapterTimeline.totalSec)) * 100}%`,
                      }}
                      className="absolute top-0 bottom-0 w-px bg-[#FAF9F5]/90 sepia:bg-[#F4ECD8]/90 dark:bg-[#141312]/75 pointer-events-none"
                    />
                  ))}
                </>
              )}

              {/* Single-Page Sentence Rhythm Ticks */}
              {sentenceTickPercents.length > 0 && (
                <>
                  {sentenceTickPercents.map((pct, i) => (
                    <span
                      key={i}
                      aria-hidden="true"
                      style={{ left: `${pct}%` }}
                      className="absolute top-0 bottom-0 w-px bg-stone-400/35 dark:bg-stone-600/40 pointer-events-none"
                    />
                  ))}
                </>
              )}
            </div>

            {/* Hover Guide Hairline */}
            {hoverSec !== null && scrubSec === null && previewInfo && !isTimelineDisabled && (
              <span
                aria-hidden="true"
                style={{ left: `${previewInfo.percent}%` }}
                className="absolute top-1 bottom-1 w-0.5 -translate-x-1/2 rounded-full bg-stone-600/70 dark:bg-stone-300/70 pointer-events-none"
              />
            )}

            {/* Visual Playhead / Scrubber Thumb */}
            <span
              aria-hidden="true"
              style={{ left: `${progressPercent}%` }}
              className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 rounded-full bg-amber-700 dark:bg-amber-400 ring-2 ring-[#FAF9F5] sepia:ring-[#F4ECD8] dark:ring-[#141312] shadow-sm pointer-events-none transition-transform duration-150 ${
                scrubSec !== null ? 'scale-125' : 'scale-95 group-hover:scale-115'
              }`}
            />
          </div>

          {/* Remaining Duration, Total Duration & Chapter Progress */}
          <div className="flex items-center gap-1.5 shrink-0 font-mono-num tabular-nums text-[11px] whitespace-nowrap">
            <span
              title={`Remaining duration in "${chapterTimeline.chapterLabel}" at ${rate.toFixed(2).replace(/0$/, '')}x speed`}
              className="font-medium text-stone-700 dark:text-stone-300"
            >
              -{formatAudioDuration(displayedRemainingSec)}
            </span>
            <span className="hidden sm:inline text-stone-400 dark:text-stone-500">
              / {formatAudioDuration(chapterTimeline.totalSec)}
            </span>
            <span className="hidden md:inline text-stone-400 dark:text-stone-500">
              · {Math.round(progressPercent)}%
            </span>
            {chapterTimeline.endPage > chapterTimeline.startPage && (
              <span className="hidden lg:inline text-stone-400 dark:text-stone-500">
                · p.{scrubTargetPage ?? pageNumber}/{chapterTimeline.endPage}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-[1680px] mx-auto px-3 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        {/* Left: Playback Transport */}
        <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
          <button
            type="button"
            disabled={!hasText}
            onClick={() =>
              speakFromIndex(Math.max(0, (activeSentenceIndex ?? 0) - 1))
            }
            aria-label="Previous sentence"
            className="h-9 w-8 sm:w-9 inline-flex items-center justify-center rounded-md text-stone-600 dark:text-stone-300 hover:bg-stone-200/70 dark:hover:bg-stone-800 disabled:opacity-35 cursor-pointer"
          >
            <SkipBack className="w-4 h-4" />
          </button>

          <button
            type="button"
            disabled={!canClickListen || waitingForTranslation}
            onClick={handlePlayPause}
            aria-label={isSpeaking ? 'Pause audiobook' : 'Play audiobook'}
            className="h-9 px-3 sm:px-3.5 inline-flex items-center gap-1.5 sm:gap-2 rounded-md text-sm font-medium bg-amber-700 hover:bg-amber-800 text-white disabled:opacity-35 transition-colors cursor-pointer whitespace-nowrap"
          >
            {waitingForTranslation || isLoadingSentence ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{waitingForTranslation ? 'Translating…' : 'Loading…'}</span>
              </>
            ) : isSpeaking ? (
              <>
                <Pause className="w-4 h-4" />
                <span>Pause</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4" />
                <span>Listen</span>
              </>
            )}
          </button>

          <button
            type="button"
            disabled={!hasText}
            onClick={() =>
              speakFromIndex(
                Math.min(sentences.length - 1, (activeSentenceIndex ?? -1) + 1)
              )
            }
            aria-label="Next sentence"
            className="h-9 w-8 sm:w-9 inline-flex items-center justify-center rounded-md text-stone-600 dark:text-stone-300 hover:bg-stone-200/70 dark:hover:bg-stone-800 disabled:opacity-35 cursor-pointer"
          >
            <SkipForward className="w-4 h-4" />
          </button>

          {(isSpeaking || activeSentenceIndex !== null) && (
            <button
              type="button"
              onClick={() => stopPlayback(true)}
              aria-label="Stop playback"
              className="h-9 w-8 inline-flex items-center justify-center rounded-md text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100 hover:bg-stone-200/70 dark:hover:bg-stone-800 cursor-pointer"
            >
              <Square className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Center: Progress + Speed & Pitch Sliders + Voice Engine */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0 flex-1 justify-center">
          <div className="hidden xl:flex items-center gap-1.5 text-xs text-stone-600 dark:text-stone-400 font-mono-num whitespace-nowrap">
            <Volume2 className="w-3.5 h-3.5 text-amber-700 dark:text-amber-500 shrink-0" />
            <span>
              {hasText
                ? `${currentPos}/${sentences.length}`
                : canTranslateAndPlay
                ? 'Ready'
                : 'No text'}
            </span>
          </div>

          {/* Speed Slider */}
          <label className="inline-flex items-center gap-1.5 text-[11px] text-stone-600 dark:text-stone-400 whitespace-nowrap">
            <span className="uppercase tracking-wider font-medium text-[10px]">Speed</span>
            <input
              type="range"
              min={0.5}
              max={2.0}
              step={0.05}
              value={rate}
              onChange={(e) => handleSpeedChange(parseFloat(e.target.value))}
              aria-label="Playback speed"
              className="w-16 sm:w-20 accent-amber-700 cursor-pointer"
            />
            <span className="font-mono-num w-9 text-stone-800 dark:text-stone-200">
              {rate.toFixed(2).replace(/0$/, '')}x
            </span>
          </label>

          {/* Pitch Slider */}
          <label className="inline-flex items-center gap-1.5 text-[11px] text-stone-600 dark:text-stone-400 whitespace-nowrap">
            <span className="uppercase tracking-wider font-medium text-[10px]">Pitch</span>
            <input
              type="range"
              min={0.5}
              max={1.8}
              step={0.05}
              value={pitch}
              onChange={(e) => handlePitchChange(parseFloat(e.target.value))}
              aria-label="Playback pitch"
              className="w-16 sm:w-20 accent-amber-700 cursor-pointer"
            />
            <span className="font-mono-num w-9 text-stone-800 dark:text-stone-200">
              {pitch.toFixed(2).replace(/0$/, '')}x
            </span>
          </label>

          {isCustomTone && (
            <button
              type="button"
              onClick={handleResetTone}
              title="Reset speed and pitch to 1.0x"
              aria-label="Reset speed and pitch"
              className="h-6 px-1.5 inline-flex items-center gap-1 rounded text-[11px] text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100 hover:bg-stone-200/70 dark:hover:bg-stone-800 cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              <span className="hidden sm:inline">Reset</span>
            </button>
          )}

          {/* Neural TTS Voice Selector Dropdown (Male, Female, Natural, Expressive — used for live Neural playback & Audio generation) */}
          <div ref={neuralDropdownRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setNeuralMenuOpen((prev) => !prev)}
              aria-haspopup="listbox"
              aria-expanded={neuralMenuOpen}
              aria-label="Choose neural TTS voice for audiobook generation"
              title={`Neural TTS Voice: ${activeVoiceProfile.name} (${activeVoiceProfile.tagline}) — ${activeVoiceProfile.description}`}
              className={`h-7 px-2.5 inline-flex items-center gap-1.5 rounded border text-xs transition-colors cursor-pointer whitespace-nowrap ${
                engineMode === 'hd'
                  ? 'border-amber-700/60 dark:border-amber-500/60 bg-white sepia:bg-[#FBF6E9] dark:bg-[#1F1E1B] text-stone-900 dark:text-stone-100 font-medium'
                  : 'border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#1F1E1B] text-stone-700 dark:text-stone-300'
              } hover:border-amber-700 dark:hover:border-amber-500`}
            >
              <Sparkles
                className={`w-3.5 h-3.5 shrink-0 ${
                  engineMode === 'hd'
                    ? 'text-amber-700 dark:text-amber-500'
                    : 'text-stone-400 dark:text-stone-500'
                }`}
              />
              <span className="truncate max-w-[150px] sm:max-w-[195px]">
                {activeVoiceProfile.name} · {activeVoiceProfile.tagline}
              </span>
              <ChevronDown
                className={`w-3.5 h-3.5 text-stone-400 transition-transform shrink-0 ${
                  neuralMenuOpen ? 'rotate-180' : ''
                }`}
              />
            </button>

            {neuralMenuOpen && (
              <div
                role="listbox"
                aria-label="Neural TTS voice options"
                className="fixed sm:absolute bottom-24 sm:bottom-full left-3 right-3 sm:left-0 sm:right-auto sm:mb-2 z-50 sm:w-[356px] max-w-[calc(100vw-24px)] rounded-lg border border-stone-200 sepia:border-[#D4C7AA] dark:border-stone-700 bg-[#FAF9F5] sepia:bg-[#FBF6E9] dark:bg-[#191816] shadow-2xl overflow-hidden"
              >
                {/* Header & Style Filter Tabs */}
                <div className="px-3.5 py-2.5 border-b border-stone-200 sepia:border-[#DFD4BC] dark:border-stone-800 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-700 sepia:text-[#3B2F23] dark:text-stone-200">
                      Neural TTS Voices
                    </span>
                    <span className="text-[10px] font-mono-num text-amber-800 dark:text-amber-400">
                      {aiAvailable ? 'Gemini 3.8 Neural · Teacher' : 'Neural HD Audio'}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 flex-wrap">
                    {(['all', 'Teacher', 'Female', 'Male', 'Expressive', 'Natural'] as const).map(
                      (tab) => (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => setNeuralFilter(tab)}
                          className={`h-6 px-2 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                            neuralFilter === tab
                              ? 'bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-950'
                              : 'text-stone-600 dark:text-stone-400 hover:bg-stone-200/70 dark:hover:bg-stone-800'
                          }`}
                        >
                          {tab === 'all' ? 'All' : tab}
                        </button>
                      )
                    )}
                  </div>
                </div>

                {/* Neural Voice Profile List */}
                <div className="max-h-72 overflow-y-auto divide-y divide-stone-200/70 sepia:divide-[#DFD4BC]/80 dark:divide-stone-800/80">
                  {filteredNeuralVoices.map((profile) => {
                    const isSelected = profile.id === aiVoiceProfileId;
                    const isPreviewing = previewingNeuralId === profile.id;

                    return (
                      <div
                        key={profile.id}
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => handleVoiceProfileChange(profile.id)}
                        className={`px-3.5 py-2.5 flex items-start justify-between gap-2.5 transition-colors cursor-pointer ${
                          isSelected
                            ? 'bg-amber-50/80 sepia:bg-[#EFE3C8] dark:bg-amber-950/25'
                            : 'hover:bg-stone-100/80 sepia:hover:bg-[#F3E9D2] dark:hover:bg-stone-800/60'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold text-stone-950 sepia:text-[#2F241A] dark:text-stone-50">
                              {profile.name}
                            </span>
                            <span className="text-[11px] font-medium text-amber-800 dark:text-amber-400">
                              {profile.tagline}
                            </span>
                            {isSelected && (
                              <Check className="w-3.5 h-3.5 text-amber-700 dark:text-amber-400 shrink-0" />
                            )}
                          </div>
                          <p className="mt-0.5 text-[11px] leading-snug text-stone-500 sepia:text-[#6E5A47] dark:text-stone-400">
                            {profile.description}
                          </p>
                        </div>

                        <button
                          type="button"
                          onClick={(e) => handlePreviewNeuralVoice(profile.id, e)}
                          title={
                            isPreviewing
                              ? `Stop ${profile.name} preview`
                              : `Preview ${profile.name} (${profile.tagline})`
                          }
                          aria-label={`Preview ${profile.name} neural voice`}
                          className={`mt-0.5 h-7 px-2 inline-flex items-center gap-1 rounded border text-[11px] font-medium shrink-0 cursor-pointer transition-colors ${
                            isPreviewing
                              ? 'border-amber-700 bg-amber-700 text-white'
                              : 'border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#22211E] text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800'
                          }`}
                        >
                          {isPreviewing ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Play className="w-3 h-3" />
                          )}
                          <span>{isPreviewing ? 'Stop' : 'Test'}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Engine Toggle: Neural TTS vs System Voice (Web Speech API) */}
          <div className="inline-flex rounded border border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#1F1E1B] p-0.5 shrink-0">
            <button
              type="button"
              onClick={() => handleEngineSwitch('hd')}
              title={
                aiAvailable
                  ? 'Neural studio TTS voices with free HD fallback'
                  : 'Natural multi-language HD audio with neural voice profiles'
              }
              className={`h-6 px-2 rounded-sm text-[11px] font-medium cursor-pointer whitespace-nowrap transition-colors ${
                engineMode === 'hd'
                  ? 'bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-950'
                  : 'text-stone-600 dark:text-stone-300'
              }`}
            >
              Neural
            </button>
            <button
              type="button"
              disabled={!speechSupported}
              onClick={() => handleEngineSwitch('device')}
              title={
                speechSupported
                  ? `System voices via Web Speech API (${sortedVoices.length} available)`
                  : 'Web Speech API is not supported in this browser'
              }
              className={`h-6 px-2 rounded-sm text-[11px] font-medium cursor-pointer whitespace-nowrap disabled:opacity-40 transition-colors ${
                engineMode === 'device'
                  ? 'bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-950'
                  : 'text-stone-600 dark:text-stone-300'
              }`}
            >
              System
            </button>
          </div>

          {/* Web Speech API System Voice Profile Selector (always accessible when browser supports speechSynthesis) */}
          {speechSupported && (
            <div className="inline-flex items-center gap-1 shrink-0">
              <label
                title={
                  sortedVoices.length > 0
                    ? `Choose a preferred Web Speech API system voice (${sortedVoices.length} installed)`
                    : 'Fetching system voices from Web Speech API'
                }
                className="inline-flex items-center gap-1.5 text-xs text-stone-600 dark:text-stone-400 whitespace-nowrap"
              >
                <Mic
                  className={`w-3.5 h-3.5 shrink-0 ${
                    engineMode === 'device'
                      ? 'text-amber-700 dark:text-amber-500'
                      : 'text-stone-400 dark:text-stone-500'
                  }`}
                />
                <select
                  aria-label="System narrator voice (Web Speech API)"
                  value={selectedVoiceId}
                  onFocus={refreshSystemVoices}
                  onMouseDown={refreshSystemVoices}
                  onChange={(e) => handleSystemVoiceChange(e.target.value)}
                  className={`max-w-[165px] sm:max-w-[205px] h-7 px-2 rounded border text-xs truncate focus:outline-none focus:border-amber-700 dark:focus:border-amber-500 cursor-pointer transition-colors ${
                    engineMode === 'device'
                      ? 'border-amber-700/60 dark:border-amber-500/60 bg-white sepia:bg-[#FBF6E9] dark:bg-[#1F1E1B] text-stone-900 dark:text-stone-100 font-medium'
                      : 'border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#1F1E1B] text-stone-700 dark:text-stone-300'
                  }`}
                >
                  {sortedVoices.length === 0 ? (
                    <option value="">
                      {voicesLoaded
                        ? `System Default (${langOption.speechLang})`
                        : 'Loading system voices…'}
                    </option>
                  ) : (
                    <>
                      <option value="">
                        Auto System ({langOption.speechLang})
                      </option>
                      {matchingVoices.length > 0 && (
                        <optgroup label={`${langOption.name} Voices (${matchingVoices.length})`}>
                          {matchingVoices.map(({ id, voice }) => (
                            <option key={id} value={id}>
                              {voice.name} ({voice.lang})
                              {voice.localService ? ' · Local' : ''}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {otherVoices.length > 0 && (
                        <optgroup label={`Other System Voices (${otherVoices.length})`}>
                          {otherVoices.map(({ id, voice }) => (
                            <option key={id} value={id}>
                              {voice.name} ({voice.lang})
                              {voice.localService ? ' · Local' : ''}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </>
                  )}
                </select>
              </label>

              {engineMode === 'device' && sortedVoices.length > 0 && (
                <button
                  type="button"
                  onClick={handlePreviewSystemVoice}
                  title="Preview selected system voice"
                  aria-label="Preview selected system voice"
                  className="h-7 px-2 rounded border border-stone-300 sepia:border-[#D4C7AA] dark:border-stone-700 bg-white sepia:bg-[#FBF6E9] dark:bg-[#1F1E1B] text-[11px] font-medium text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer whitespace-nowrap"
                >
                  Test
                </button>
              )}
            </div>
          )}

          {/* Original EN vs Translated Narration Source */}
          <div className="hidden lg:inline-flex rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#1F1E1B] p-0.5">
            <button
              type="button"
              onClick={() => onNarrationSourceChange('translated')}
              title="Read translated text aloud"
              className={`h-6 px-2 rounded-sm text-[11px] font-medium cursor-pointer whitespace-nowrap ${
                narrationSource === 'translated'
                  ? 'bg-amber-700 text-white'
                  : 'text-stone-600 dark:text-stone-300'
              }`}
            >
              Translated
            </button>
            <button
              type="button"
              onClick={() => onNarrationSourceChange('original')}
              title="Read original English text aloud"
              className={`h-6 px-2 rounded-sm text-[11px] font-medium cursor-pointer whitespace-nowrap ${
                narrationSource === 'original'
                  ? 'bg-amber-700 text-white'
                  : 'text-stone-600 dark:text-stone-300'
              }`}
            >
              Original EN
            </button>
          </div>

          {/* Sleep Timer */}
          <label
            title="Sleep Timer — automatically pauses narration"
            className="hidden sm:inline-flex items-center gap-1 text-xs text-stone-600 dark:text-stone-400 whitespace-nowrap"
          >
            <Timer
              className={`w-3.5 h-3.5 shrink-0 ${
                sleepSecondsLeft > 0
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-stone-400 dark:text-stone-500'
              }`}
            />
            <select
              aria-label="Audiobook sleep timer"
              value={sleepTimerMinutes}
              onChange={(e) => {
                const mins = parseInt(e.target.value, 10) || 0;
                setSleepTimerMinutes(mins);
                setSleepSecondsLeft(mins * 60);
              }}
              className="h-7 px-1.5 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#1F1E1B] text-[11px] font-mono-num text-stone-800 dark:text-stone-200 focus:outline-none focus:border-amber-700 cursor-pointer"
            >
              <option value={0}>Sleep: Off</option>
              <option value={5}>5 min</option>
              <option value={15}>15 min</option>
              <option value={30}>30 min</option>
              <option value={60}>60 min</option>
            </select>
            {sleepDisplay && (
              <span className="font-mono-num text-[11px] font-medium text-amber-800 dark:text-amber-400">
                {sleepDisplay}
              </span>
            )}
          </label>

          <label className="hidden 2xl:inline-flex items-center gap-1.5 text-xs text-stone-600 dark:text-stone-400 cursor-pointer whitespace-nowrap select-none">
            <input
              type="checkbox"
              checked={autoAdvance}
              onChange={(e) => setAutoAdvance(e.target.checked)}
              className="rounded border-stone-300 dark:border-stone-600 accent-amber-700"
            />
            Auto-next
          </label>
        </div>

        {/* Right: Download Audio (MP3 / WAV) */}
        <div className="shrink-0 flex items-center gap-2">
          {hasText && (
            <span className="xl:hidden text-[11px] font-mono-num text-stone-500 dark:text-stone-400 whitespace-nowrap">
              {currentPos}/{sentences.length}
            </span>
          )}
          <button
            type="button"
            disabled={!canClickListen || isDownloadingAudio}
            onClick={handleDownloadAudio}
            title={
              aiAvailable
                ? `Generate & download page audiobook with ${activeVoiceProfile.name} (${activeVoiceProfile.tagline})`
                : `Generate & download page audiobook (${activeVoiceProfile.name} · ${activeVoiceProfile.tagline})`
            }
            className="inline-flex items-center gap-1.5 h-8 px-2.5 sm:px-3 rounded-md border border-stone-300 dark:border-stone-700 text-xs font-medium text-stone-700 dark:text-stone-200 hover:bg-stone-200/70 dark:hover:bg-stone-800 disabled:opacity-40 cursor-pointer whitespace-nowrap"
          >
            {isDownloadingAudio ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Download className="w-3.5 h-3.5" />
            )}
            <span className="hidden sm:inline">
              {isDownloadingAudio ? 'Saving…' : 'Audio'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
