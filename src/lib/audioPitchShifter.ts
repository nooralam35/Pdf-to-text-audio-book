/**
 * Real-time, constant-amplitude 2-tap crossfaded Web Audio pitch shifter
 * for an HTMLAudioElement. Leaves playback speed completely independent
 * (controlled via audio.playbackRate with preservesPitch = true).
 *
 * At pitch === 1.0, routes directly through a zero-latency dry bypass gain.
 */
export class ElementPitchShifter {
  private ctx: AudioContext | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private dryGain: GainNode | null = null;
  private wetGain: GainNode | null = null;

  private delayA: DelayNode | null = null;
  private delayB: DelayNode | null = null;
  private fadeGainA: GainNode | null = null;
  private fadeGainB: GainNode | null = null;

  private modNodes: AudioBufferSourceNode[] = [];
  private upRampBuf: AudioBuffer | null = null;
  private downRampBuf: AudioBuffer | null = null;
  private hannBuf: AudioBuffer | null = null;

  private currentDirection: 'up' | 'down' | 'bypass' = 'bypass';
  private pitch = 1.0;
  private readonly windowSec = 0.065; // 65ms window ideal for speech clarity

  constructor(private readonly audioEl: HTMLAudioElement) {}

  private ensureGraph(): boolean {
    if (this.ctx) return true;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return false;

    const ctx = new AudioCtx();
    const source = ctx.createMediaElementSource(this.audioEl);
    const dryGain = ctx.createGain();
    const wetGain = ctx.createGain();

    const delayA = ctx.createDelay(0.5);
    const delayB = ctx.createDelay(0.5);
    const fadeGainA = ctx.createGain();
    const fadeGainB = ctx.createGain();

    // Base gain is 0 so LFO buffer controls fade strictly in [0, 1]
    fadeGainA.gain.value = 0;
    fadeGainB.gain.value = 0;
    delayA.delayTime.value = 0;
    delayB.delayTime.value = 0;

    // Dry bypass path
    source.connect(dryGain);
    dryGain.connect(ctx.destination);

    // Wet 2-tap pitch-shift path
    source.connect(delayA);
    source.connect(delayB);
    delayA.connect(fadeGainA);
    delayB.connect(fadeGainB);
    fadeGainA.connect(wetGain);
    fadeGainB.connect(wetGain);
    wetGain.connect(ctx.destination);

    dryGain.gain.value = 1;
    wetGain.gain.value = 0;

    // Precompute 1-second modulation buffers so playbackRate equals cycle frequency in Hz
    const sr = ctx.sampleRate;
    const len = sr;
    const upRampBuf = ctx.createBuffer(1, len, sr);
    const downRampBuf = ctx.createBuffer(1, len, sr);
    const hannBuf = ctx.createBuffer(1, len, sr);

    const upData = upRampBuf.getChannelData(0);
    const downData = downRampBuf.getChannelData(0);
    const hannData = hannBuf.getChannelData(0);

    for (let i = 0; i < len; i++) {
      const t = i / len; // 0..1
      upData[i] = t * this.windowSec;
      downData[i] = (1 - t) * this.windowSec;
      // Hann window: tapA(t) + tapB(t + 0.5) === 1.0 everywhere, 0 at ramp wrap
      hannData[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * t);
    }

    this.ctx = ctx;
    this.source = source;
    this.dryGain = dryGain;
    this.wetGain = wetGain;
    this.delayA = delayA;
    this.delayB = delayB;
    this.fadeGainA = fadeGainA;
    this.fadeGainB = fadeGainB;
    this.upRampBuf = upRampBuf;
    this.downRampBuf = downRampBuf;
    this.hannBuf = hannBuf;
    return true;
  }

  private stopModulators() {
    for (const node of this.modNodes) {
      try {
        node.stop();
        node.disconnect();
      } catch {
        // ignore
      }
    }
    this.modNodes = [];
  }

  private startModulators(direction: 'up' | 'down', freqHz: number) {
    if (
      !this.ctx ||
      !this.upRampBuf ||
      !this.downRampBuf ||
      !this.hannBuf ||
      !this.delayA ||
      !this.delayB ||
      !this.fadeGainA ||
      !this.fadeGainB
    ) {
      return;
    }

    this.stopModulators();
    const rampBuf = direction === 'down' ? this.downRampBuf : this.upRampBuf;
    const now = this.ctx.currentTime;

    const makeLoop = (buf: AudioBuffer, offsetSec: number, target: AudioParam) => {
      const src = this.ctx!.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.playbackRate.setValueAtTime(freqHz, now);
      src.connect(target);
      src.start(now, offsetSec);
      this.modNodes.push(src);
    };

    // Tap A at phase 0.0, Tap B at phase 0.5 (180 degrees out of phase)
    makeLoop(rampBuf, 0, this.delayA.delayTime);
    makeLoop(this.hannBuf, 0, this.fadeGainA.gain);
    makeLoop(rampBuf, 0.5, this.delayB.delayTime);
    makeLoop(this.hannBuf, 0.5, this.fadeGainB.gain);
  }

  public async resume(): Promise<void> {
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        // ignore
      }
    }
  }

  public setPitch(nextPitch: number): void {
    const clamped = Math.max(0.5, Math.min(2.0, nextPitch));
    this.pitch = clamped;

    // Avoid creating AudioContext at all until user shifts pitch away from 1.0
    if (Math.abs(clamped - 1.0) < 0.015) {
      if (this.ctx && this.dryGain && this.wetGain) {
        const now = this.ctx.currentTime;
        this.dryGain.gain.setTargetAtTime(1, now, 0.015);
        this.wetGain.gain.setTargetAtTime(0, now, 0.015);
        this.stopModulators();
        this.currentDirection = 'bypass';
      }
      return;
    }

    if (!this.ensureGraph() || !this.ctx || !this.dryGain || !this.wetGain) {
      return;
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    const direction: 'up' | 'down' = clamped > 1.0 ? 'down' : 'up';
    const freqHz = Math.max(0.05, Math.abs(clamped - 1.0) / this.windowSec);
    const now = this.ctx.currentTime;

    if (this.currentDirection !== direction) {
      this.startModulators(direction, freqHz);
      this.currentDirection = direction;
    } else {
      for (const node of this.modNodes) {
        node.playbackRate.setTargetAtTime(freqHz, now, 0.02);
      }
    }

    this.dryGain.gain.setTargetAtTime(0, now, 0.015);
    this.wetGain.gain.setTargetAtTime(1, now, 0.015);
  }

  public getPitch(): number {
    return this.pitch;
  }

  public dispose(): void {
    this.stopModulators();
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.source = null;
  }
}
