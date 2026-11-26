/**
 * Background & Offline Audio Continuity Utilities
 *
 * Ensures audiobook narration keeps playing smoothly on Mobile (Android/iOS) and PC:
 * 1. Persistent Cache Storage (`bhashabook-tts-audio-v1`) for synthesized TTS clips so
 *    previously played and lookahead-prefetched sentences play completely offline.
 * 2. Continuous silent keep-alive HTMLAudioElement loop so mobile OSes do not revoke
 *    background audio focus between sentences, across page turns, or when the display turns off.
 * 3. Media Session API metadata + lock-screen / Bluetooth playback controls.
 * 4. Optional Screen Wake Lock helper.
 */

export const OFFLINE_TTS_AUDIO_CACHE = 'bhashabook-tts-audio-v1';
const MAX_CACHED_TTS_ENTRIES = 260;

function hashString(input: string): string {
  // Fast deterministic 64-bit-ish dual FNV-1a hex hash (no async crypto needed)
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= ch;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

function getTtsCacheRequestUrl(cacheKey: string): string {
  return `/offline-audio/tts/${hashString(cacheKey)}`;
}

export async function getCachedTtsAudioBlob(
  cacheKey: string
): Promise<{ blob: Blob; source: 'ai' | 'free' } | null> {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(OFFLINE_TTS_AUDIO_CACHE);
    const match = await cache.match(getTtsCacheRequestUrl(cacheKey));
    if (!match || !match.ok) return null;
    const blob = await match.blob();
    if (blob.size === 0) return null;
    const srcHeader = match.headers.get('X-BhashaBook-Audio-Source');
    const source: 'ai' | 'free' =
      srcHeader === 'ai' || blob.type.includes('wav') ? 'ai' : 'free';
    return { blob, source };
  } catch {
    return null;
  }
}

export async function putCachedTtsAudioBlob(
  cacheKey: string,
  blob: Blob,
  source: 'ai' | 'free'
): Promise<void> {
  if (typeof caches === 'undefined' || blob.size === 0) return;
  try {
    const cache = await caches.open(OFFLINE_TTS_AUDIO_CACHE);
    const headers = new Headers({
      'Content-Type': blob.type || (source === 'ai' ? 'audio/wav' : 'audio/mpeg'),
      'Content-Length': String(blob.size),
      'X-BhashaBook-Audio-Source': source,
      'X-BhashaBook-Cached-At': String(Date.now()),
    });
    const response = new Response(blob, { status: 200, statusText: 'OK', headers });
    await cache.put(getTtsCacheRequestUrl(cacheKey), response);

    // Light pruning to keep offline audio cache well within browser quota
    const keys = await cache.keys();
    if (keys.length > MAX_CACHED_TTS_ENTRIES) {
      const overflow = keys.length - MAX_CACHED_TTS_ENTRIES;
      for (let i = 0; i < overflow; i++) {
        await cache.delete(keys[i]);
      }
    }
  } catch {
    // Quota or restricted cache API — in-memory playback still works
  }
}

/**
 * Generates a valid, uncompressed 4-second silent mono PCM WAV Blob URL.
 * Playing this silently in a loop (unmuted, tiny volume) maintains OS background
 * audio focus during gaps between sentences, page turns, and Web Speech API calls.
 */
function createSilentWavBlobUrl(durationSec = 4, sampleRate = 8000): string {
  const numSamples = durationSec * sampleRate;
  const dataSize = numSamples * 2; // 16-bit mono
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // Byte rate
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  // PCM samples remain 0 (pure digital silence)

  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

let cachedSilentUnlockUrl: string | null = null;

/**
 * Returns a real, valid 250ms silent 16-bit PCM WAV Blob URL.
 * Unlike 0-byte WAV data URIs (which mobile Safari/Chrome often reject),
 * playing this valid PCM clip inside a tap gesture reliably unlocks an HTMLAudioElement.
 */
export function getSilentUnlockWavUrl(): string {
  if (typeof window === 'undefined' || typeof Blob === 'undefined') return '';
  if (!cachedSilentUnlockUrl) {
    cachedSilentUnlockUrl = createSilentWavBlobUrl(0.25, 8000);
  }
  return cachedSilentUnlockUrl;
}

export class BackgroundAudioKeepAlive {
  private audioEl: HTMLAudioElement | null = null;
  private blobUrl: string | null = null;
  private active = false;

  private ensureElement(): HTMLAudioElement | null {
    if (typeof window === 'undefined' || typeof Audio === 'undefined') return null;
    if (!this.audioEl) {
      this.blobUrl = createSilentWavBlobUrl(4, 8000);
      const el = new Audio(this.blobUrl);
      el.loop = true;
      el.preload = 'auto';
      // Keep unmuted at very low volume so mobile OSes maintain background audio session
      el.muted = false;
      el.volume = 0.01;
      el.setAttribute('playsinline', 'true');
      el.setAttribute('webkit-playsinline', 'true');
      this.audioEl = el;
    }
    return this.audioEl;
  }

  /** Call synchronously inside a user gesture (Listen click) so mobile browsers allow playback */
  public unlock(): void {
    const el = this.ensureElement();
    if (!el) return;
    if (!el.paused) return;
    try {
      const p = el.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          if (!this.active) {
            el.pause();
          }
        }).catch(() => {});
      }
    } catch {
      // ignore
    }
  }

  public start(): void {
    this.active = true;
    const el = this.ensureElement();
    if (!el) return;
    if (el.paused) {
      el.play().catch(() => {});
    }
  }

  public ensureRunning(): void {
    if (!this.active) return;
    const el = this.ensureElement();
    if (el && el.paused) {
      el.play().catch(() => {});
    }
  }

  public stop(): void {
    this.active = false;
    if (this.audioEl && !this.audioEl.paused) {
      try {
        this.audioEl.pause();
      } catch {
        // ignore
      }
    }
  }

  public dispose(): void {
    this.stop();
    if (this.audioEl) {
      this.audioEl.src = '';
      this.audioEl = null;
    }
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
  }
}

export interface MediaSessionUpdateParams {
  title: string;
  artist: string;
  album: string;
  artworkUrl?: string;
  playbackState: 'playing' | 'paused' | 'none';
  durationSec?: number;
  positionSec?: number;
  playbackRate?: number;
}

export function updateMediaSessionState(params: MediaSessionUpdateParams): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  try {
    const ms = navigator.mediaSession;
    const artwork: MediaImage[] = [];
    if (params.artworkUrl) {
      artwork.push({ src: params.artworkUrl, sizes: '512x512', type: 'image/jpeg' });
    }
    artwork.push(
      { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' }
    );

    if (typeof MediaMetadata !== 'undefined') {
      ms.metadata = new MediaMetadata({
        title: params.title,
        artist: params.artist,
        album: params.album,
        artwork,
      });
    }

    ms.playbackState = params.playbackState;

    if (
      typeof ms.setPositionState === 'function' &&
      params.durationSec &&
      Number.isFinite(params.durationSec) &&
      params.durationSec > 0
    ) {
      const safeDuration = Math.max(1, params.durationSec);
      const safePosition = Math.max(0, Math.min(safeDuration, params.positionSec ?? 0));
      const safeRate = Math.max(0.5, Math.min(2.0, params.playbackRate ?? 1.0));
      ms.setPositionState({
        duration: safeDuration,
        playbackRate: safeRate,
        position: safePosition,
      });
    }
  } catch {
    // Some browsers restrict partial Media Session fields — fail silently
  }
}

export interface MediaSessionHandlers {
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onPreviousTrack: () => void;
  onNextTrack: () => void;
  onSeekBackward: () => void;
  onSeekForward: () => void;
}

export function registerMediaSessionHandlers(handlers: MediaSessionHandlers): () => void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
    return () => {};
  }
  const ms = navigator.mediaSession;
  const actions: Array<[MediaSessionAction, MediaSessionActionHandler | null]> = [
    ['play', () => handlers.onPlay()],
    ['pause', () => handlers.onPause()],
    ['stop', () => handlers.onStop()],
    ['previoustrack', () => handlers.onPreviousTrack()],
    ['nexttrack', () => handlers.onNextTrack()],
    ['seekbackward', () => handlers.onSeekBackward()],
    ['seekforward', () => handlers.onSeekForward()],
  ];

  for (const [action, handler] of actions) {
    try {
      ms.setActionHandler(action, handler);
    } catch {
      // Action unsupported on this browser
    }
  }

  return () => {
    for (const [action] of actions) {
      try {
        ms.setActionHandler(action, null);
      } catch {
        // ignore
      }
    }
  };
}

export class AudioWakeLock {
  private sentinel: { release: () => Promise<void> } | null = null;
  private wanted = false;

  public async acquire(): Promise<void> {
    this.wanted = true;
    if (typeof navigator === 'undefined' || typeof document === 'undefined') return;
    if (document.visibilityState !== 'visible' || this.sentinel) return;
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
      };
      if (nav.wakeLock) {
        this.sentinel = await nav.wakeLock.request('screen');
      }
    } catch {
      // Wake Lock unsupported or denied — silent keep-alive audio still handles screen-off
    }
  }

  public async reacquireIfWanted(): Promise<void> {
    if (!this.wanted) return;
    this.sentinel = null;
    await this.acquire();
  }

  public release(): void {
    this.wanted = false;
    const s = this.sentinel;
    this.sentinel = null;
    s?.release().catch(() => {});
  }
}
