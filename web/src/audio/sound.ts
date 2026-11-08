// Synthesized sound for the town (Web Audio, no audio files).
// Fire = crackle bed + random pops + low rumble, scaled by setLevel(0..1).
// Alerts are short tones; sirens wail for a few seconds when engines roll.
// Browsers only allow audio after a user gesture, so call unlock() from a pointer/key handler.

const STORE_KEY = 'lantern.muted';

function readMuted(): boolean {
  try { return localStorage.getItem(STORE_KEY) === '1'; } catch { return false; }
}

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private crackle: GainNode | null = null;
  private rumble: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private level = 0;
  muted = readMuted();

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // crackle bed: bright, hissy noise
    this.crackle = ctx.createGain();
    this.crackle.gain.value = 0;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1400;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3200;
    bp.Q.value = 0.6;
    this.loopNoise().connect(hp);
    hp.connect(bp).connect(this.crackle).connect(this.master);

    // rumble: the roar of a big fire
    this.rumble = ctx.createGain();
    this.rumble.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 160;
    this.loopNoise().connect(lp);
    lp.connect(this.rumble).connect(this.master);

    window.setInterval(() => this.maybePop(), 55);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend();
      else void this.ctx.resume();
    });
  }

  private loopNoise(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.start();
    return src;
  }

  /** One wood-pop: a few milliseconds of filtered noise with a sharp decay. */
  private maybePop() {
    const ctx = this.ctx;
    if (!ctx || this.muted || this.level <= 0.01) return;
    if (Math.random() > this.level * 0.55) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1200 + Math.random() * 4200;
    f.Q.value = 2 + Math.random() * 4;
    const g = ctx.createGain();
    const peak = (0.15 + Math.random() * 0.45) * (0.4 + this.level * 0.6);
    const dur = 0.012 + Math.random() * 0.04;
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t, Math.random() * 1.5, dur + 0.02);
  }

  /** 0 = no fire, 1 = town on fire. */
  setLevel(level: number) {
    this.level = Math.max(0, Math.min(1, level));
    const ctx = this.ctx;
    if (!ctx || !this.crackle || !this.rumble) return;
    const t = ctx.currentTime;
    this.crackle.gain.setTargetAtTime(this.level * 0.07, t, 0.6);
    this.rumble.gain.setTargetAtTime(this.level * 0.55, t, 0.9);
  }

  private tone(freq: number, start: number, dur: number, type: OscillatorType, vol: number, glideTo?: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, start);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, start + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(vol, start + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    o.connect(lp).connect(g).connect(this.master!);
    o.start(start);
    o.stop(start + dur + 0.05);
  }

  alert(kind: 'fire' | 'behind' | 'good') {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime + 0.01;
    if (kind === 'fire') {
      this.tone(880, t, 0.22, 'square', 0.09, 640);
      this.tone(880, t + 0.26, 0.22, 'square', 0.09, 640);
      this.tone(880, t + 0.52, 0.32, 'square', 0.09, 560);
    } else if (kind === 'behind') {
      this.tone(740, t, 0.12, 'sine', 0.16);
      this.tone(740, t + 0.18, 0.12, 'sine', 0.16);
    } else {
      this.tone(523, t, 0.14, 'sine', 0.12);
      this.tone(784, t + 0.12, 0.22, 'sine', 0.12);
    }
  }

  /** A few seconds of two-tone wail for an engine leaving the station. */
  siren(seconds = 4) {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime + 0.02;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.9;
    const depth = ctx.createGain();
    depth.gain.value = 260;
    o.frequency.value = 760;
    lfo.connect(depth).connect(o.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.3);
    g.gain.setValueAtTime(0.05, t + seconds - 0.8);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800;
    o.connect(lp).connect(g).connect(this.master!);
    o.start(t);
    lfo.start(t);
    o.stop(t + seconds + 0.1);
    lfo.stop(t + seconds + 0.1);
  }

  /** Structural failure: a deep thud and a rolling rumble of debris. Strength 0..1. */
  crash(strength = 1) {
    const ctx = this.ctx;
    if (!ctx || this.muted || !this.noise) return;
    const t = ctx.currentTime + 0.01;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 0.9);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.6 * strength, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + 1.4);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(140, t + 2.2);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.35 * strength, t + 0.08);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    src.connect(lp).connect(ng).connect(this.master!);
    src.start(t, Math.random(), 2.5);
  }

  setMuted(m: boolean) {
    this.muted = m;
    try { localStorage.setItem(STORE_KEY, m ? '1' : '0'); } catch { /* storage blocked: preference lasts this session */ }
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }
}

export const sound = new SoundEngine();
