import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  Loader2,
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
import { getLanguageOption } from '../lib/languages';
import {
  buildAudiobookText,
  downloadBlob,
  fetchFreeTtsBlob,
  synthesizePageAudio,
} from '../lib/translatorClient';
import {
  AI_VOICE_PROFILES,
  getAiVoiceProfile,
  type AiVoiceProfileId,
} from '../lib/voiceProfiles';
import type {
  LanguageCode,
  ParsedPage,
  SentenceSpan,
  TranslatedPageRecord,
} from '../types';

type SpeechEngineMode = 'hd' | 'device';

export interface AudiobookControlHandle {
  unlockAudio: () => void;
  pausePlayback: () => void;
  playCurrentPage: () => void;
  queueChapterPlayback: (targetPage: number, endPage: number, chapterTitle: string) => void;
}

interface AudiobookBarProps {
  bookTitle: string;
  pageNumber: number;
  numPages: number;
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
  onRequestTranslatePage: () => void;
  aiAvailable: boolean;
  narrationSource: 'translated' | 'original';
  onNarrationSourceChange: (src: 'translated' | 'original') => void;
}

export const AudiobookBar: React.FC<AudiobookBarProps> = ({
  bookTitle,
  pageNumber,
  numPages,
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
  onRequestTranslatePage,
  aiAvailable,
  narrationSource,
  onNarrationSourceChange,
}) => {
  const [engineMode, setEngineMode] = useState<SpeechEngineMode>('hd');
  const [aiVoiceProfileId, setAiVoiceProfileId] = useState<AiVoiceProfileId>(() => {
    if (typeof window === 'undefined') return 'Kore';
    const saved = localStorage.getItem('bhashabook-ai-voice-profile');
    return getAiVoiceProfile(saved).id;
  });
  const [rate, setRate] = useState(1.0); // 0.5x .. 2.0x
  const [pitch, setPitch] = useState(1.0); // 0.5 .. 1.8
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string>('');
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [isLoadingSentence, setIsLoadingSentence] = useState(false);
  const [isDownloadingAudio, setIsDownloadingAudio] = useState(false);
  const [audioMessage, setAudioMessage] = useState<string | null>(null);
  const [waitingForTranslation, setWaitingForTranslation] = useState(false);
  const [sleepTimerMinutes, setSleepTimerMinutes] = useState<number>(0);
  const [sleepSecondsLeft, setSleepSecondsLeft] = useState<number>(0);

  const effectiveAudioLang: LanguageCode = narrationSource === 'original' ? 'en' : targetLang;
  const langOption = getLanguageOption(effectiveAudioLang);
  const activeVoiceProfile = useMemo(
    () => getAiVoiceProfile(aiVoiceProfileId),
    [aiVoiceProfileId]
  );

  // Persistent HTML5 Audio element + independent Web Audio pitch shifter
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pitchShifterRef = useRef<ElementPitchShifter | null>(null);
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
  const aiAvailableRef = useRef(aiAvailable);
  const autoAdvanceRef = useRef(autoAdvance);
  const sentencesRef = useRef(sentences);
  const engineModeRef = useRef(engineMode);
  const targetLangRef = useRef(effectiveAudioLang);

  rateRef.current = rate;
  pitchRef.current = pitch;
  voiceIdRef.current = selectedVoiceId;
  aiVoiceProfileIdRef.current = aiVoiceProfileId;
  aiAvailableRef.current = aiAvailable;
  autoAdvanceRef.current = autoAdvance;
  sentencesRef.current = sentences;
  engineModeRef.current = engineMode;
  targetLangRef.current = effectiveAudioLang;

  useEffect(() => {
    try {
      localStorage.setItem('bhashabook-ai-voice-profile', aiVoiceProfileId);
    } catch {
      // ignore storage errors
    }
  }, [aiVoiceProfileId]);

  const speechSupported =
    typeof window !== 'undefined' && 'speechSynthesis' in window;

  const getPitchShifter = () => {
    if (!audioRef.current) return null;
    if (!pitchShifterRef.current) {
      pitchShifterRef.current = new ElementPitchShifter(audioRef.current);
    }
    return pitchShifterRef.current;
  };

  // Load native browser voices for offline Device Voice mode
  useEffect(() => {
    if (!speechSupported) return;
    const loadVoices = () => {
      const list = window.speechSynthesis.getVoices();
      if (list.length > 0) {
        setVoices(list);
      }
    };
    loadVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', loadVoices);
    };
  }, [speechSupported]);

  // Deduplicate and prioritize voices matching active target language with unique IDs
  const sortedVoices = useMemo(() => {
    const langPrefix = langOption.speechLang.split('-')[0].toLowerCase();
    const seenExact = new Set<string>();
    const uniqueRaw: SpeechSynthesisVoice[] = [];
    for (const v of voices) {
      const sig = `${v.voiceURI}||${v.name}||${v.lang}`;
      if (seenExact.has(sig)) continue;
      seenExact.add(sig);
      uniqueRaw.push(v);
    }

    const sorted = uniqueRaw.sort((a, b) => {
      const aMatch = a.lang.toLowerCase().startsWith(langPrefix) ? 0 : 1;
      const bMatch = b.lang.toLowerCase().startsWith(langPrefix) ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
      return a.name.localeCompare(b.name) || a.lang.localeCompare(b.lang);
    });

    return sorted.map((voice, idx) => ({
      id: `${voice.voiceURI}::${voice.lang}::${idx}`,
      voice,
    }));
  }, [voices, langOption.speechLang]);

  useEffect(() => {
    if (sortedVoices.length === 0) return;
    const langPrefix = langOption.speechLang.split('-')[0].toLowerCase();
    const match = sortedVoices.find((entry) =>
      entry.voice.lang.toLowerCase().startsWith(langPrefix)
    );
    if (match) {
      setSelectedVoiceId(match.id);
    } else {
      setSelectedVoiceId('');
    }
  }, [sortedVoices, langOption.speechLang]);

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

    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
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
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPlayback(true);
      clearCachedObjectUrls();
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

  // If page advanced automatically via Auto-next, seamlessly continue reading once the next page's sentences are ready
  useEffect(() => {
    if (!pendingAutoContinueRef.current) return;
    if (isTranslatingPage) return;

    if (sentences.length > 0) {
      pendingAutoContinueRef.current = false;
      speakFromIndex(0);
    } else if (parsedPage && !parsedPage.isBlank && !translatedPage) {
      // Fallback: if next page wasn't pre-saved yet, request translation and auto-start when ready
      pendingAutoContinueRef.current = false;
      setWaitingForTranslation(true);
      onRequestTranslatePage();
    } else if (parsedPage && parsedPage.isBlank) {
      pendingAutoContinueRef.current = false;
    }
  }, [pageNumber, targetLang, sentences.length, isTranslatingPage, parsedPage, translatedPage]);

  // Handle chapter audio start queued from the Chapter List Play button
  useEffect(() => {
    const pending = pendingChapterPlayRef.current;
    if (!pending) return;
    if (pageNumber !== pending.targetPage) return;
    if (isTranslatingPage) return;

    // Wait until parsedPage for this exact page has loaded from IndexedDB / PDF.js
    if (!parsedPage || parsedPage.pageNumber !== pageNumber) return;

    // If translatedPage is already loaded for this exact page and has sentences, play immediately
    if (translatedPage && translatedPage.pageNumber === pageNumber && sentences.length > 0) {
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

    // Otherwise, auto-translate this chapter page and start audio immediately once translation completes
    pendingChapterPlayRef.current = null;
    setWaitingForTranslation(true);
    setAudioMessage(`Translating "${pending.title}" (Page ${pageNumber}) to play audio…`);
    onRequestTranslatePage();
  }, [
    pageNumber,
    numPages,
    targetLang,
    parsedPage,
    translatedPage,
    sentences.length,
    isTranslatingPage,
  ]);

  // Notify parent when audio is preparing (translating or loading sentence audio)
  useEffect(() => {
    onPreparingChange?.(waitingForTranslation || isLoadingSentence || Boolean(pendingChapterPlayRef.current));
  }, [waitingForTranslation, isLoadingSentence, pageNumber, onPreparingChange]);

  const getSentenceAudioUrl = async (
    text: string,
    lang: LanguageCode,
    voiceProfileId: AiVoiceProfileId,
    signal?: AbortSignal
  ): Promise<{ url: string; source: 'ai' | 'free' }> => {
    const useAi = aiAvailableRef.current;
    const cacheKey = `${lang}::${useAi ? voiceProfileId : 'free'}::${text}`;
    const existing = objectUrlCacheRef.current.get(cacheKey);
    if (existing) return existing;

    const pending = inFlightFetchRef.current.get(cacheKey);
    if (pending) return pending;

    const fetchClip = async (): Promise<{ url: string; source: 'ai' | 'free' }> => {
      if (useAi) {
        try {
          const profile = getAiVoiceProfile(voiceProfileId);
          const langName = getLanguageOption(lang).name;
          const res = await synthesizePageAudio({
            text,
            voiceName: profile.id,
            voiceStyle: profile.style,
            languageName: langName,
            targetLang: lang,
            signal,
          });
          const url = URL.createObjectURL(res.blob);
          const clipSource: 'ai' | 'free' = res.ext === 'wav' ? 'ai' : 'free';
          return { url, source: clipSource };
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') throw err;
          // Fall back to Free MP3 if Studio AI TTS is unavailable
        }
      }
      const blob = await fetchFreeTtsBlob(text, lang, signal);
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

  // Offline Device Voice playback with native speed + pitch support
  const speakWithDeviceVoice = (startIndex: number, session: number) => {
    if (!speechSupported) {
      setAudioMessage('Audio playback is unavailable in this browser.');
      onSpeakingChange(false);
      return;
    }

    const runDeviceStep = (idx: number) => {
      if (playSessionRef.current !== session) return;
      const list = sentencesRef.current;
      if (idx >= list.length) {
        onSpeakingChange(false);
        onActiveSentenceChange(null);
        if (autoAdvanceRef.current && pageNumber < numPages) {
          pendingAutoContinueRef.current = true;
          onAdvancePage();
        }
        return;
      }

      const span = list[idx];
      onActiveSentenceChange(span.globalIndex);

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

      const chosenEntry = sortedVoices.find((entry) => entry.id === voiceIdRef.current);
      if (chosenEntry) {
        utter.voice = chosenEntry.voice;
      }

      currentUtteranceRef.current = utter;

      utter.onend = () => {
        if (playSessionRef.current !== session) return;
        currentUtteranceRef.current = null;
        runDeviceStep(idx + 1);
      };

      utter.onerror = (ev) => {
        if (playSessionRef.current !== session) return;
        currentUtteranceRef.current = null;
        if (ev.error === 'interrupted' || ev.error === 'canceled') return;
        setAudioMessage(
          'Device voice failed for this language. Switch to HD Voice for reliable playback.'
        );
        onSpeakingChange(false);
      };

      window.speechSynthesis.speak(utter);
    };

    runDeviceStep(startIndex);
  };

  const speakFromIndex = (startIndex: number) => {
    const list = sentencesRef.current;
    if (list.length === 0) return;

    const clamped = Math.max(0, Math.min(list.length - 1, startIndex));
    const session = ++playSessionRef.current;
    pausedInPlaceRef.current = false;

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
        if (autoAdvanceRef.current && pageNumber < numPages) {
          pendingAutoContinueRef.current = true;
          onAdvancePage();
        }
        return;
      }

      const span = currentList[idx];
      onActiveSentenceChange(span.globalIndex);
      setIsLoadingSentence(true);

      const nextSpan = currentList[idx + 1];
      if (nextSpan) {
        getSentenceAudioUrl(
          nextSpan.text,
          targetLangRef.current,
          aiVoiceProfileIdRef.current
        ).catch(() => {});
      }

      try {
        const { url: audioUrl, source: clipSource } = await getSentenceAudioUrl(
          span.text,
          targetLangRef.current,
          aiVoiceProfileIdRef.current,
          controller.signal
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
        audio.src = audioUrl;
        // Preserve pitch on HTMLAudioElement so Web Audio shifter controls pitch independently
        audio.preservesPitch = true;
        audio.playbackRate = effectiveRate;

        const shifter = getPitchShifter();
        shifter?.setPitch(effectivePitch);
        await shifter?.resume();

        audio.onended = () => {
          if (playSessionRef.current !== session) return;
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

  // Auto-start playback once translation finishes if user tapped Listen on an untranslated page
  useEffect(() => {
    if (waitingForTranslation && !isTranslatingPage && sentences.length > 0) {
      setWaitingForTranslation(false);
      speakFromIndex(0);
    } else if (waitingForTranslation && !isTranslatingPage && sentences.length === 0) {
      setWaitingForTranslation(false);
    }
  }, [waitingForTranslation, isTranslatingPage, sentences.length]);

  useEffect(() => {
    if (jumpRequest && sentences.length > 0) {
      speakFromIndex(jumpRequest.index);
    }
  }, [jumpRequest]);

  const unlockAudioElement = () => {
    const audio = audioRef.current;
    pitchShifterRef.current?.resume().catch(() => {});
    if (!audio || audioUnlockedRef.current) return;
    try {
      audio.src =
        'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
      const p = audio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          audio.pause();
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
        audioRef.current.pause();
        pausedInPlaceRef.current = true;
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
      const { effectiveRate, effectivePitch } = computeEffectiveTone(
        currentClipSourceRef.current
      );
      audioRef.current.preservesPitch = true;
      audioRef.current.playbackRate = effectiveRate;
      const shifter = getPitchShifter();
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
        pendingAutoContinueRef.current = false;
        setWaitingForTranslation(false);
        if (engineModeRef.current === 'hd' && audioRef.current && !isLoadingSentence) {
          audioRef.current.pause();
          pausedInPlaceRef.current = true;
          onSpeakingChange(false);
        } else {
          stopPlayback(false);
        }
      },
      playCurrentPage: () => {
        pendingChapterPlayRef.current = null;
        setAutoAdvance(true);
        autoAdvanceRef.current = true;
        if (!isSpeaking) {
          handlePlayPause();
        }
      },
      queueChapterPlayback: (targetPage, endPage, chapterTitle) => {
        unlockAudioElement();
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

  const handleVoiceProfileChange = (nextProfileId: AiVoiceProfileId) => {
    setAiVoiceProfileId(nextProfileId);
    aiVoiceProfileIdRef.current = nextProfileId;

    if (engineMode !== 'hd') return;

    if (aiAvailableRef.current) {
      // With Studio AI voices active, re-synthesize current sentence in the newly chosen AI voice
      if (isSpeaking && activeSentenceIndex !== null) {
        speakFromIndex(activeSentenceIndex);
      } else {
        pausedInPlaceRef.current = false;
      }
    } else if (audioRef.current) {
      // With Free HD voice active, immediately update acoustic timbre profile on the live audio element
      const { effectiveRate, effectivePitch } = computeEffectiveTone('free');
      audioRef.current.preservesPitch = true;
      audioRef.current.playbackRate = effectiveRate;
      const shifter = getPitchShifter();
      shifter?.setPitch(effectivePitch);
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
    if (wasPlaying && sentences.length > 0) {
      setTimeout(() => speakFromIndex(resumeIdx), 30);
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
      const { blob, ext } = await synthesizePageAudio({
        text: narrationText,
        voiceName: activeVoiceProfile.id,
        voiceStyle: activeVoiceProfile.style,
        languageName: effectiveLangOption.name,
        targetLang: effectiveLang,
      });
      const slug = bookTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 36);
      const fileName = `${slug || 'audiobook'}-p${pageNumber}-${effectiveLang}-${activeVoiceProfile.id.toLowerCase()}.${ext}`;
      downloadBlob(blob, fileName);
      setAudioMessage(`Downloaded ${fileName}`);
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

  const sleepDisplay =
    sleepSecondsLeft > 0
      ? `${Math.floor(sleepSecondsLeft / 60)}:${String(sleepSecondsLeft % 60).padStart(2, '0')}`
      : null;

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

          {/* AI Voice Profile Selector (shown in HD Voice mode) */}
          {engineMode === 'hd' && (
            <label
              title={`${activeVoiceProfile.name} (${activeVoiceProfile.tagline}) — ${activeVoiceProfile.description}`}
              className="inline-flex items-center gap-1.5 text-xs text-stone-600 dark:text-stone-400 whitespace-nowrap"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-700 dark:text-amber-500 shrink-0" />
              <select
                aria-label="AI narrator voice profile"
                value={aiVoiceProfileId}
                onChange={(e) =>
                  handleVoiceProfileChange(e.target.value as AiVoiceProfileId)
                }
                className="h-7 px-2 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#1F1E1B] text-xs font-medium text-stone-800 dark:text-stone-200 focus:outline-none focus:border-amber-700 dark:focus:border-amber-500 cursor-pointer"
              >
                {AI_VOICE_PROFILES.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} · {profile.tagline}
                  </option>
                ))}
              </select>
            </label>
          )}

          {/* Engine Toggle: Natural HD vs Offline Device Voice */}
          <div className="hidden md:inline-flex rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#1F1E1B] p-0.5">
            <button
              type="button"
              onClick={() => handleEngineSwitch('hd')}
              title={
                aiAvailable
                  ? 'AI studio narrator voices with free HD fallback'
                  : 'Free natural multi-language HD audio with voice profiles'
              }
              className={`h-6 px-2 rounded-sm text-[11px] font-medium cursor-pointer whitespace-nowrap ${
                engineMode === 'hd'
                  ? 'bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-950'
                  : 'text-stone-600 dark:text-stone-300'
              }`}
            >
              {aiAvailable ? 'AI Voice' : 'HD Voice'}
            </button>
            <button
              type="button"
              onClick={() => handleEngineSwitch('device')}
              title="Offline browser/OS speech synthesis"
              className={`h-6 px-2 rounded-sm text-[11px] font-medium cursor-pointer whitespace-nowrap ${
                engineMode === 'device'
                  ? 'bg-stone-900 text-stone-50 dark:bg-stone-100 dark:text-stone-950'
                  : 'text-stone-600 dark:text-stone-300'
              }`}
            >
              Device
            </button>
          </div>

          {engineMode === 'device' && sortedVoices.length > 0 && (
            <select
              aria-label="Narrator voice"
              value={selectedVoiceId}
              onChange={(e) => {
                setSelectedVoiceId(e.target.value);
                voiceIdRef.current = e.target.value;
                if (isSpeaking && activeSentenceIndex !== null) {
                  speakFromIndex(activeSentenceIndex);
                }
              }}
              className="hidden lg:block max-w-[170px] h-7 px-2 rounded border border-stone-300 dark:border-stone-700 bg-white dark:bg-[#1F1E1B] text-xs text-stone-800 dark:text-stone-200 truncate focus:outline-none focus:border-amber-700 cursor-pointer"
            >
              <option value="">Auto ({langOption.speechLang})</option>
              {sortedVoices.map(({ id, voice }) => (
                <option key={id} value={id}>
                  {voice.name} ({voice.lang})
                </option>
              ))}
            </select>
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
                ? 'Download page audiobook (Studio WAV / MP3)'
                : 'Download free page audiobook (MP3)'
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
