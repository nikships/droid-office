/**
 * Office sounds, synthesized with Web Audio so there are no audio files to ship: workers typing
 * while they work, thunder after a flash, the gong, and the dings when a worker
 * needs you. And the lounge jukebox, whose tunes are in music.ts.
 *
 * Everything here is triggered by something: there is no background hum, no weather, no random
 * room noise. Silence until something happens.
 *
 * Everything goes through one master gain that Settings turns down or mutes, except the jukebox,
 * which has a volume of its own.
 */
import { FLOOR, GONG, JUKEBOX } from '../shared/layout';
import type { GongWhy } from '../shared/protocol';
import { STREAM } from '../shared/jukebox';
import { soundCloudUrl } from '../shared/soundcloud';
import { TunePlayer } from './music';
import { SoundCloudPlayer } from './ui/soundcloud';
import type { GunCue } from './world/gun-motion';
import type { WandCue } from './world/wand-motion';

type Pos = { x: number; y: number; z: number };

/** What the office-wide jukebox plays: a tune or a stream, and when it started on performance.now()'s clock. */
export interface JukeboxPlay {
  track: string;
  url?: string;
  /** When it started on the office's clock, which tells one play of a track from the next. */
  startedAt: number;
  since: number;
}

/** How the jukebox fades with distance: the same curve for its tunes (a panner) and a stream (by hand). */
const MUSIC_REF = 2.5;
const MUSIC_ROLLOFF = 1.3;

/** Where you hear from: your head, facing where the camera looks. */
export interface Listener extends Pos {
  fx: number;
  fz: number;
}

/** The middle of the gong's disc. */
const GONG_AT: Pos = { x: GONG.x, y: GONG.height - 1.36, z: GONG.z };
/** A gong's overtones don't line up like a string's: [ratio to the lowest, loudness, seconds to die away]. */
const GONG_PARTIALS: [number, number, number][] = [
  [1, 0.8, 7],
  [1.51, 0.75, 5.5],
  [2.13, 0.65, 4.6],
  [2.66, 0.55, 3.8],
  [3.19, 0.45, 3.1],
  [3.84, 0.38, 2.5],
  [4.48, 0.3, 2],
  [5.27, 0.22, 1.6],
  [6.35, 0.16, 1.2],
  [7.61, 0.1, 0.9],
  [9.08, 0.07, 0.6],
];

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const randInt = (a: number, b: number) => Math.floor(rand(a, b + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

interface Typist {
  x: number;
  z: number;
  on: boolean;
  panner: PannerNode | null;
  /** When (audio clock) the next key lands. */
  next: number;
  /** Keys left in this burst; 0 means a pause is running and the next key starts a new burst. */
  left: number;
  /** Keys left in this word. */
  word: number;
}

export type AlertKind = 'needs_input' | 'done' | 'error';

/** Short, and not the same shape: a rise, a major third, two low notes down. Square is quieter so it doesn't shout. */
const ALERTS: Record<AlertKind, { freq: number; type: OscillatorType; at: number; len: number; gain: number }[]> = {
  needs_input: [
    { freq: 784, type: 'sine', at: 0, len: 0.09, gain: 0.22 },
    { freq: 1175, type: 'sine', at: 0.1, len: 0.11, gain: 0.2 },
  ],
  done: [
    { freq: 659, type: 'triangle', at: 0, len: 0.1, gain: 0.24 },
    { freq: 880, type: 'triangle', at: 0.11, len: 0.14, gain: 0.22 },
  ],
  error: [
    { freq: 392, type: 'square', at: 0, len: 0.08, gain: 0.08 },
    { freq: 247, type: 'square', at: 0.1, len: 0.12, gain: 0.07 },
  ],
};

export class OfficeSound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  /** The room itself; it goes quiet while the tab is hidden. */
  private ambience!: GainNode;
  /** The gong (other than a plain hit). Still audible in a background tab. */
  private alerts!: GainNode;
  /** Needs-you, done, and error. The alert mute is this bus alone, so it leaves the gong. */
  private dings!: GainNode;
  private analyser!: AnalyserNode;
  private buf!: Buffers;
  private volume = 0.7;
  private muted = false;
  /** Worker tones only. The office mute still silences them, because they share its volume. */
  private alertsMuted = false;
  private typists = new Map<string, Typist>();
  private listener: Listener = { x: 0, y: 1.4, z: 0, fx: 0, fz: -1 };
  // The jukebox: from the cabinet, through a filter that muffles it from across the room, to your own volume.
  private musicIn!: PannerNode;
  private musicTone!: BiquadFilterNode;
  private musicCutoff = 16000;
  private musicBus!: GainNode;
  private musicMeter!: AnalyserNode;
  private musicVolume = 0.5;
  private musicMuted = false;
  private jukebox: JukeboxPlay | null = null;
  private tune: TunePlayer | null = null;
  private stream: HTMLAudioElement | null = null;
  private soundcloud: SoundCloudPlayer | null = null;
  private musicTimer = 0;
  /** A stream that won't play here. */
  onMusicError?: (text: string) => void;
  /** How many of each sound have played, for quick checks from the console. */
  readonly played: Record<string, number> = {};

  constructor() {
    // Browsers only allow audio after a click or key press.
    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    document.addEventListener('visibilitychange', () => this.applyVisibility());
  }

  /** Volume is 0–1; muted silences everything without losing the level. */
  setVolume(volume: number, muted: boolean) {
    this.volume = Math.max(0, Math.min(1, volume));
    this.muted = muted;
    this.applyVolume();
  }

  /** Silences the worker tones (needs you, done, error) and leaves the room alone. */
  setAlertsMuted(muted: boolean) {
    this.alertsMuted = muted;
    this.applyAlerts();
  }

  /** Output level (RMS) right now, for headless checks. */
  level(): number {
    return this.ctx ? rms(this.analyser) : 0;
  }

  /** The jukebox's level (RMS) where you stand, after your music volume. A stream doesn't show here. */
  musicLevel(): number {
    return this.ctx ? rms(this.musicMeter) : 0;
  }

  get state(): AudioContextState | 'locked' {
    return this.ctx?.state ?? 'locked';
  }

  private unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      // A ding can start audio before you've touched the page, when a stream isn't allowed to play yet.
      if (this.stream?.paused) void this.stream.play().catch(() => {});
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      return; // no audio here
    }
    this.ctx = ctx;
    this.buf = makeBuffers(ctx);
    // A gentle compressor, so a room full of typing never clips.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(comp).connect(ctx.destination);
    comp.connect(this.analyser);
    this.ambience = ctx.createGain();
    this.ambience.connect(this.master);
    this.alerts = ctx.createGain();
    this.alerts.connect(this.master);
    this.dings = ctx.createGain();
    this.dings.connect(this.master);
    // The jukebox skips the master (it has its own volume) and keeps playing while the tab is hidden.
    this.musicIn = this.panner(JUKEBOX, MUSIC_REF, MUSIC_ROLLOFF);
    this.musicTone = biquad(ctx, 'lowpass', 16000, 0.5);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0;
    this.musicMeter = ctx.createAnalyser();
    this.musicMeter.fftSize = 2048;
    this.musicIn.connect(this.musicTone).connect(this.musicBus).connect(ctx.destination);
    this.musicBus.connect(this.musicMeter);
    this.applyVolume();
    this.applyAlerts();
    this.applyMusicVolume();
    this.applyJukebox();
    this.applyVisibility();
    void ctx.resume();
  }

  private applyVolume() {
    if (!this.ctx) return;
    // Squared, so the slider feels even to the ear.
    const g = this.muted ? 0 : this.volume * this.volume;
    this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.04);
  }

  private applyAlerts() {
    if (!this.ctx) return;
    this.dings.gain.setTargetAtTime(this.alertsMuted ? 0 : 1, this.ctx.currentTime, 0.03);
  }

  private applyVisibility() {
    if (!this.ctx) return;
    if (!document.hidden && this.ctx.state === 'suspended') void this.ctx.resume();
    this.ambience.gain.setTargetAtTime(document.hidden ? 0 : 1, this.ctx.currentTime, 0.15);
  }

  private count(what: string) {
    this.played[what] = (this.played[what] ?? 0) + 1;
  }

  // ---- Every frame -------------------------------------------------------------------------------

  /** Moves your ears and schedules whatever the room does next. */
  update(l: Listener) {
    const ctx = this.ctx;
    if (ctx?.state !== 'running') return;
    this.listener = l;
    // Level the facing, so looking straight down never lines it up with "up".
    const len = Math.hypot(l.fx, l.fz) || 1;
    const L = ctx.listener;
    if (L.positionX) {
      L.positionX.value = l.x;
      L.positionY.value = l.y;
      L.positionZ.value = l.z;
      L.forwardX.value = l.fx / len;
      L.forwardY.value = 0;
      L.forwardZ.value = l.fz / len;
      L.upX.value = 0;
      L.upY.value = 1;
      L.upZ.value = 0;
    } else {
      L.setPosition(l.x, l.y, l.z);
      L.setOrientation(l.fx / len, 0, l.fz / len, 0, 1, 0);
    }
    const now = ctx.currentTime;
    this.hearJukebox(now);
    this.scheduleTyping(now);
  }

  // ---- Workers typing ----------------------------------------------------------------------------

  /** The worker at desk (x, z) types while `on`. */
  setTyping(id: string, x: number, z: number, on: boolean) {
    let t = this.typists.get(id);
    if (!t) this.typists.set(id, (t = { x, z, on: false, panner: null, next: 0, left: 0, word: 0 }));
    if (t.panner && (t.x !== x || t.z !== z)) place(t.panner, x, 0.9, z);
    t.x = x;
    t.z = z;
    if (on && !t.on) t.next = 0;
    t.on = on;
  }

  removeTypist(id: string) {
    this.typists.get(id)?.panner?.disconnect();
    this.typists.delete(id);
  }

  private scheduleTyping(now: number) {
    // Schedule a little ahead on the audio clock so the rhythm doesn't wobble with the frame rate.
    const horizon = now + 0.12;
    for (const t of this.typists.values()) {
      if (!t.on) continue;
      if (!t.panner) {
        t.panner = this.panner({ x: t.x, y: 0.9, z: t.z }, 1.2, 1.3);
        t.panner.connect(this.ambience);
      }
      // Just started, or fell behind while the tab was hidden: begin again shortly.
      if (t.next < now - 0.25) {
        t.next = now + rand(0.05, 0.8);
        t.left = 0;
      }
      while (t.next < horizon) {
        const when = t.next;
        if (t.left === 0) {
          t.left = randInt(6, 36);
          t.word = randInt(2, 8);
          // Now and then they click around before typing again.
          if (Math.random() < 0.3) {
            this.key(t, when, 'mouse');
            if (Math.random() < 0.5) this.key(t, when + rand(0.1, 0.16), 'mouse');
            t.next = when + rand(0.4, 1.2);
            continue;
          }
        }
        t.left--;
        if (t.left === 0) {
          // End of a burst: often Enter, then a pause to read or think.
          this.key(t, when, Math.random() < 0.4 ? 'enter' : 'key');
          t.next = when + (Math.random() < 0.15 ? rand(4, 9) : rand(0.6, 3));
        } else if (--t.word <= 0) {
          this.key(t, when, 'space');
          t.word = randInt(2, 8);
          t.next = when + rand(0.1, 0.22);
        } else {
          this.key(t, when, 'key');
          t.next = when + rand(0.065, 0.16);
        }
      }
    }
  }

  private key(t: Typist, when: number, kind: 'key' | 'space' | 'enter' | 'mouse') {
    const b = this.buf;
    const buf = kind === 'key' ? pick(b.keys) : kind === 'mouse' ? b.mouse : pick(b.spaces);
    const gain = kind === 'enter' ? 0.55 : kind === 'space' ? 0.4 : kind === 'mouse' ? 0.3 : rand(0.24, 0.34);
    this.play(buf, { gain, rate: rand(0.93, 1.07), when, dest: t.panner! });
    this.count(kind);
  }

  // ---- Footsteps --------------------------------------------------------------------------------

  /** An issue card in your hands: taken off the board, or put down on a desk. */
  paper() {
    if (!this.ctx) return;
    this.play(this.buf.rustle, { gain: 0.5, rate: rand(1.1, 1.3) });
    this.count('paper');
  }

  // ---- The ladder and the fire poles -----------------------------------------------------------

  /** Your hand closing on a steel rung, or on the pole: a soft clank. */
  rung(soft = false) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.count('rung');
    const t0 = ctx.currentTime + 0.005;
    const f = rand(820, 980) * (soft ? 0.7 : 1);
    this.blip(this.ambience, t0, f, 0.97, 0.12, soft ? 0.05 : 0.08);
    this.blip(this.ambience, t0, f * 2.71, 0.98, 0.06, 0.03);
    this.play(pick(this.buf.steps), { gain: 0.12, rate: rand(1.6, 1.9) });
  }

  /** A trapdoor at the ladder: creaking open, or banging shut. From where it is, so you hear it from across the room. */
  hatch(at: { x: number; y: number; z: number }, open: boolean) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.count(open ? 'hatchOpen' : 'hatchShut');
    const out = this.panner(at, 2, 1.1);
    out.connect(this.ambience);
    const t0 = ctx.currentTime + 0.01;
    if (open) {
      // A creaky hinge: a rough, wavering squeak.
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(420, t0);
      o.frequency.linearRampToValueAtTime(640, t0 + 0.18);
      o.frequency.linearRampToValueAtTime(380, t0 + 0.36);
      const wobble = ctx.createOscillator();
      wobble.frequency.value = 23;
      const depth = ctx.createGain();
      depth.gain.value = 40;
      wobble.connect(depth).connect(o.frequency);
      const g = ctx.createGain();
      envelope(g.gain, t0, [
        [0.04, 0.05],
        [0.3, 0.04],
        [0.4, 0],
      ]);
      o.connect(biquad(ctx, 'bandpass', 1400, 2.5))
        .connect(g)
        .connect(out);
      for (const n of [o, wobble]) {
        n.start(t0);
        n.stop(t0 + 0.45);
      }
    } else this.play(pick(this.buf.steps), { gain: 0.5, rate: 0.62, dest: out });
  }

  /** Your head on the ceiling: the ladder doesn't go any higher. */
  bonk() {
    if (!this.ctx) return;
    this.count('bonk');
    this.play(pick(this.buf.steps), { gain: 0.35, rate: 0.5 });
    this.blip(this.ambience, this.ctx.currentTime + 0.01, 180, 0.6, 0.18, 0.12);
  }

  /** Whoosh: the rush of air and the squeal of hands on brass, all the way down a fire pole. */
  slide(seconds = 1.6) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.count('slide');
    const t0 = ctx.currentTime + 0.01;
    const end = t0 + seconds;
    const air = this.noise(this.buf.white, true);
    const tone = biquad(ctx, 'bandpass', 500, 0.9);
    tone.frequency.setValueAtTime(400, t0);
    tone.frequency.exponentialRampToValueAtTime(2200, end);
    const ag = ctx.createGain();
    envelope(ag.gain, t0, [
      [0.25, 0.22],
      [seconds * 0.85, 0.3],
      [seconds, 0],
    ]);
    air.connect(tone).connect(ag).connect(this.ambience);
    air.start(t0);
    air.stop(end + 0.05);
    // Palms squeaking on the brass, higher as you speed up.
    const squeal = ctx.createOscillator();
    squeal.type = 'triangle';
    squeal.frequency.setValueAtTime(1100, t0 + 0.1);
    squeal.frequency.exponentialRampToValueAtTime(1900, end);
    const vib = ctx.createOscillator();
    vib.frequency.value = 9;
    const vd = ctx.createGain();
    vd.gain.value = 35;
    vib.connect(vd).connect(squeal.frequency);
    const sg = ctx.createGain();
    envelope(sg.gain, t0, [
      [0.15, 0],
      [0.3, 0.035],
      [seconds * 0.8, 0.045],
      [seconds, 0],
    ]);
    squeal.connect(sg).connect(this.ambience);
    for (const n of [squeal, vib]) {
      n.start(t0);
      n.stop(end + 0.05);
    }
  }

  /** A little "wheee!" whistle, swinging round the pole. */
  twirl() {
    const ctx = this.ctx;
    if (!ctx) return;
    this.count('twirl');
    const t0 = ctx.currentTime + 0.01;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(600, t0);
    o.frequency.exponentialRampToValueAtTime(1500, t0 + 0.45);
    o.frequency.exponentialRampToValueAtTime(900, t0 + 1.0);
    const g = ctx.createGain();
    envelope(g.gain, t0, [
      [0.08, 0.09],
      [0.8, 0.07],
      [1.05, 0],
    ]);
    o.connect(g).connect(this.ambience);
    o.start(t0);
    o.stop(t0 + 1.1);
  }

  /**
   * Down the pole and onto the mat: a thump (harder the faster you came), and the firehouse bell,
   * ding-ding-ding. `at` is someone else landing; without it, it's you.
   */
  poleLanding(speed: number, at?: { x: number; y: number; z: number }) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.count('poleLanding');
    const out = at ? this.panner(at, 2.5, 0.9) : ctx.createGain();
    out.connect(this.ambience);
    this.play(pick(this.buf.steps), { gain: Math.min(0.9, 0.35 + speed * 0.07), rate: 0.55, dest: out });
    const t0 = ctx.currentTime + 0.08;
    for (let i = 0; i < 3; i++) {
      const when = t0 + i * 0.16;
      // A bell: a bright strike, then partials that ring on.
      for (const [ratio, amp, len] of [
        [1, 0.16, 1.1],
        [2.76, 0.07, 0.6],
        [5.4, 0.035, 0.3],
      ] as const) {
        const o = ctx.createOscillator();
        o.frequency.value = 1320 * ratio;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(amp, when + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, when + len);
        o.connect(g).connect(out);
        o.start(when);
        o.stop(when + len + 0.02);
      }
    }
  }

  /** A short pitched blip: a bubble when `ratio` > 1, a drip when < 1. */
  private blip(dest: AudioNode, when: number, freq: number, ratio: number, len: number, gain: number, type: OscillatorType = 'sine') {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, when);
    o.frequency.exponentialRampToValueAtTime(freq * ratio, when + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, when + len);
    o.connect(g).connect(dest);
    o.start(when);
    o.stop(when + len + 0.02);
  }

  // ---- Around the room --------------------------------------------------------------------------

  /** Where your ears are: in the office, where thunder is muffled by the glass, in the garage, or out in it. */
  private where(): 'office' | 'garage' | 'out' {
    const { x, y, z } = this.listener;
    const under = (m: number) => x > FLOOR.minX - m && x < FLOOR.maxX + m && z > FLOOR.minZ - m && z < FLOOR.maxZ + m;
    if (under(0) && y > -0.5) return 'office';
    return under(0.3) ? 'garage' : 'out';
  }

  /** Thunder, `delay` seconds after the flash: a crack when it's close, then a long low rumble. */
  thunder(delay: number, loud: number) {
    const ctx = this.ctx;
    if (ctx?.state !== 'running') return;
    this.count('thunder');
    const t0 = ctx.currentTime + delay;
    const peak = 0.45 * loud * (this.where() === 'office' ? 0.6 : 1);
    const src = this.noise(this.buf.brown, true);
    const tone = biquad(ctx, 'lowpass', 700, 0.7);
    tone.frequency.setValueAtTime(700, t0);
    tone.frequency.exponentialRampToValueAtTime(110, t0 + 3.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.08 + (1 - loud) * 0.5);
    g.gain.exponentialRampToValueAtTime(peak * 0.35, t0 + 1.3);
    g.gain.exponentialRampToValueAtTime(peak * 0.6, t0 + 1.9);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 4 + loud * 2.5);
    src.connect(tone).connect(g).connect(this.ambience);
    src.start(t0, rand(0, 5));
    src.stop(t0 + 7);
    if (delay < 1) {
      const crack = this.noise(this.buf.white);
      const cg = ctx.createGain();
      envelope(cg.gain, t0, [
        [0.01, peak * 0.5],
        [0.25, 0],
      ]);
      crack
        .connect(biquad(ctx, 'bandpass', 1800, 0.6))
        .connect(cg)
        .connect(this.ambience);
      crack.start(t0);
      crack.stop(t0 + 0.3);
    }
  }

  // ---- The gong ----------------------------------------------------------------------------------

  /**
   * The gong by the PR board rings: someone hit it, or a pull request merged (a harder stroke). From
   * where it hangs, so you hear which way it is.
   */
  gong(why: GongWhy) {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();
    this.count(`gong.${why}`);
    // Someone banging it is the room; a merge is news for the whole floor (and from another tab too,
    // like the dings), so it carries further.
    const out = why === 'hit' ? this.panner(GONG_AT, 4, 0.6) : this.panner(GONG_AT, 8, 0.45);
    out.connect(why === 'hit' ? this.ambience : this.alerts);
    const t0 = ctx.currentTime + 0.03;
    this.strike(out, t0, why === 'merged' ? 1 : rand(0.6, 0.8));
  }

  /** One stroke of the mallet: a felt thump, the metal ringing, and a bright wash that blooms after. */
  private strike(out: AudioNode, t0: number, strength: number) {
    const ctx = this.ctx!;
    const f0 = 118 * rand(0.98, 1.02);
    const ring = ctx.createGain();
    ring.gain.value = 0.3 * strength;
    ring.connect(out);
    const long = 0.6 + 0.4 * strength;
    for (const [ratio, amp, decay] of GONG_PARTIALS) {
      const f = f0 * ratio;
      const end = t0 + decay * long;
      // Two of each a few cents apart, so the tone shimmers as it rings.
      for (const cents of [-1, 1]) {
        const o = ctx.createOscillator();
        // Struck hard, a gong starts a touch sharp and settles.
        o.frequency.setValueAtTime(f * (1 + 0.012 * strength), t0);
        o.frequency.exponentialRampToValueAtTime(f, t0 + 1.2);
        o.detune.value = cents * rand(2, 5);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(amp * 0.5, t0 + 0.01 + ratio * 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, end);
        o.connect(g).connect(ring);
        o.start(t0);
        o.stop(end + 0.05);
      }
    }
    const thump = this.noise(this.buf.white);
    const thumpG = ctx.createGain();
    thumpG.gain.setValueAtTime(0.0001, t0);
    thumpG.gain.exponentialRampToValueAtTime(0.45 * strength, t0 + 0.005);
    thumpG.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
    thump
      .connect(biquad(ctx, 'lowpass', 420, 0.8))
      .connect(thumpG)
      .connect(out);
    thump.start(t0);
    thump.stop(t0 + 0.15);
    const wash = this.noise(this.buf.white, true);
    const washG = ctx.createGain();
    washG.gain.setValueAtTime(0, t0);
    washG.gain.linearRampToValueAtTime(0.03 * strength, t0 + 0.45);
    washG.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.5 * long);
    wash
      .connect(biquad(ctx, 'bandpass', 3200, 1.2))
      .connect(washG)
      .connect(out);
    wash.start(t0);
    wash.stop(t0 + 3.5 * long + 0.05);
  }

  // ---- The .44 Magnum ----------------------------------------------------------------------------

  /** A held charge, through the usual volume bus. Canceling fades and stops every voice. */
  sidearmCharge(wand: boolean): () => void {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx) return () => {};
    this.count(wand ? 'wandChargeHold' : 'gunChargeHold');
    const bus = ctx.createGain();
    const now = ctx.currentTime;
    bus.gain.setValueAtTime(0, now);
    bus.gain.linearRampToValueAtTime(1, now + 0.08);
    bus.connect(this.ambience);
    const voices: AudioScheduledSourceNode[] = [];
    for (const ratio of [1, wand ? 2.005 : 1.012]) {
      const tone = ctx.createOscillator();
      tone.type = wand ? 'sine' : 'triangle';
      tone.frequency.setValueAtTime((wand ? 220 : 65) * ratio, now);
      tone.frequency.exponentialRampToValueAtTime((wand ? 880 : 130) * ratio, now + 0.63);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.012, now);
      gain.gain.linearRampToValueAtTime(wand ? 0.045 : 0.035, now + 0.63);
      tone.connect(gain).connect(bus);
      tone.start(now);
      // A safety cap also frees audio if the page disappears without delivering a release.
      tone.stop(now + 30);
      voices.push(tone);
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      bus.gain.cancelScheduledValues(ctx.currentTime);
      bus.gain.setValueAtTime(bus.gain.value, ctx.currentTime);
      bus.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.035);
      for (const voice of voices) voice.stop(ctx.currentTime + 0.04);
    };
  }

  /** A normal crack, or a heavy round's dry attack, pressure slap, sub-bass body and steel tail. */
  gunshot(superShot = false) {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();
    this.count(superShot ? 'gunSuperShot' : 'gunshot');
    const t0 = ctx.currentTime + 0.005;
    // The crack: white noise through a wide band, gone in a blink.
    const crack = this.noise(this.buf.white);
    const cg = ctx.createGain();
    envelope(cg.gain, t0, [
      [superShot ? 0.002 : 0.008, superShot ? 0.75 : 0.9],
      [0.09, superShot ? 0.3 : 0.25],
      [superShot ? 0.22 : 0.3, 0],
    ]);
    crack
      .connect(biquad(ctx, 'bandpass', superShot ? 1100 : 1600, 0.5))
      .connect(cg)
      .connect(this.ambience);
    crack.start(t0);
    crack.stop(t0 + 0.35);
    // The boom under it: low noise swelling and rolling off.
    const boom = this.noise(this.buf.brown, true);
    const tone = biquad(ctx, 'lowpass', 420, 0.6);
    tone.frequency.setValueAtTime(superShot ? 300 : 420, t0);
    tone.frequency.exponentialRampToValueAtTime(superShot ? 55 : 90, t0 + (superShot ? 0.7 : 0.5));
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, t0);
    bg.gain.exponentialRampToValueAtTime(superShot ? 0.8 : 0.7, t0 + 0.015);
    bg.gain.exponentialRampToValueAtTime(0.0001, t0 + (superShot ? 0.95 : 0.7));
    boom.connect(tone).connect(bg).connect(this.ambience);
    boom.start(t0);
    boom.stop(t0 + (superShot ? 1 : 0.75));
    if (superShot) {
      // Not two reports: a single pressure front followed by the barrel/frame ringing down.
      this.blip(this.ambience, t0, 92, 0.42, 0.38, 0.22, 'sine');
      this.swish(t0 + 0.025, 0.08, 1800, 420, 0.2, 0.6);
      this.blip(this.ambience, t0 + 0.04, 2140, 0.94, 0.22, 0.025, 'triangle');
      this.click(t0 + 0.26, 2600, 0.07);
    }
  }

  /**
   * The gun's moves (world/gun-motion.ts): out of the leather and into it, spins whirring past,
   * the slap of a catch, the hammer back, the cylinder swinging out, ratcheting round and slammed
   * shut, a breath over the muzzle. All yours, so none of it is positional.
   */
  gunCue(cue: GunCue) {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime + 0.005;
    switch (cue) {
      case 'draw':
        // Steel sliding out of leather: a rising swish over a low creak.
        this.count('gunDraw');
        this.swish(t0, 0.2, 500, 2600, 0.22, 1.1);
        this.play(pick(this.buf.steps), { gain: 0.3, rate: 1.6, when: t0 });
        break;
      case 'holster':
        // Back into the leather: a falling swish and a soft, heavy slap.
        this.count('gunHolster');
        this.swish(t0 - 0.08, 0.14, 2200, 600, 0.12, 1.1);
        this.play(pick(this.buf.steps), { gain: 0.5, rate: 0.9, when: t0 });
        this.click(t0 + 0.03, 1900, 0.05);
        break;
      case 'whoosh':
        this.count('gunWhoosh');
        this.swish(t0, 0.15, rand(700, 1000), rand(1500, 2100), 0.2, 2.2);
        break;
      case 'swap':
        this.count('gunSwap');
        this.swish(t0, 0.09, 1800, 700, 0.16, 1.4);
        this.play(this.buf.rustle, { gain: 0.18, rate: 2.4, when: t0 });
        break;
      case 'catch': {
        // The grip landing in a gloved palm.
        this.count('gunCatch');
        this.play(pick(this.buf.steps), { gain: 0.55, rate: 1.9, when: t0 });
        const slap = this.noise(this.buf.white);
        const g = ctx.createGain();
        envelope(g.gain, t0, [
          [0.003, 0.28],
          [0.04, 0],
        ]);
        slap
          .connect(biquad(ctx, 'bandpass', 1300, 0.9))
          .connect(g)
          .connect(this.ambience);
        slap.start(t0);
        slap.stop(t0 + 0.06);
        break;
      }
      case 'cock':
        // The hammer back, then the cylinder locking on a chamber.
        this.count('gunCock');
        this.click(t0, 3300, 0.07);
        this.click(t0 + 0.075, 2400, 0.12);
        break;
      case 'handle':
        this.count('gunHandle');
        this.play(this.buf.rustle, { gain: 0.22, rate: rand(1.4, 1.7), when: t0 });
        break;
      case 'open':
        // The crane unlatching and the cylinder falling out against its stop, ringing a little.
        this.count('gunOpen');
        this.click(t0, 2800, 0.08);
        this.click(t0 + 0.06, 2100, 0.1);
        this.blip(this.ambience, t0 + 0.06, 1750, 0.99, 0.28, 0.025, 'triangle');
        break;
      case 'ratchet': {
        // The pawl ticking past each chamber, slowing as the cylinder runs down.
        this.count('gunRatchet');
        let at = t0;
        let gap = 0.032;
        for (let i = 0; at < t0 + 1.05 && i < 40; i++) {
          this.click(at, rand(3600, 4200), 0.05 * Math.max(0.35, 1 - (at - t0) * 0.6));
          at += gap;
          gap *= 1.09;
        }
        break;
      }
      case 'shut':
        // Flicked shut: a hard steel clack with a ring and a thump through the frame.
        this.count('gunShut');
        this.click(t0, 2000, 0.2);
        this.click(t0 + 0.012, 3100, 0.12);
        this.blip(this.ambience, t0, 1380, 0.98, 0.35, 0.05, 'triangle');
        this.play(pick(this.buf.steps), { gain: 0.5, rate: 1.4, when: t0 });
        break;
      case 'blow': {
        // A breath across the muzzle.
        this.count('gunBlow');
        const breath = this.noise(this.buf.white);
        const tone = biquad(ctx, 'bandpass', 650, 0.8);
        tone.frequency.setValueAtTime(650, t0);
        tone.frequency.linearRampToValueAtTime(1050, t0 + 0.45);
        const g = ctx.createGain();
        envelope(g.gain, t0, [
          [0.09, 0.32],
          [0.3, 0.22],
          [0.55, 0],
        ]);
        breath.connect(tone).connect(g).connect(this.ambience);
        breath.start(t0);
        breath.stop(t0 + 0.6);
        break;
      }
      case 'puff':
        break;
    }
  }

  // ---- The magic wand ----------------------------------------------------------------------------

  /** Your spell: a bright rising zing over a quick run of chimes and a shimmer. Yours, so not positional. */
  wandZap() {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();
    this.count('wandZap');
    const t0 = ctx.currentTime + 0.005;
    this.blip(this.ambience, t0, 520, 3.2, 0.22, 0.16, 'triangle');
    [1319, 1568, 1976, 2637].forEach((f, i) => this.blip(this.ambience, t0 + 0.04 + i * 0.045, f, 1.01, 0.28, 0.07));
    this.shimmer(this.ambience, t0, 0.45, 0.06);
  }

  /** A spell landing on a worker, from where it hit: a soft "boing" down and a sprinkle of chimes. */
  spellHit(at: Pos, superShot = false) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.count(superShot ? 'superSpellHit' : 'spellHit');
    const out = this.panner(at, 3, 0.9);
    out.connect(this.ambience);
    const t0 = ctx.currentTime + 0.005;
    this.blip(out, t0, superShot ? 262 : 880, superShot ? 2 : 0.5, superShot ? 0.55 : 0.3, superShot ? 0.16 : 0.14, superShot ? 'triangle' : 'sine');
    (superShot ? [1047, 1568, 2093] : [2093, 2637, 3136]).forEach((f, i) => this.blip(out, t0 + 0.05 + i * 0.06, f, 1, superShot ? 0.6 : 0.22, 0.05));
    this.shimmer(out, t0, superShot ? 0.85 : 0.5, 0.05);
  }

  /** A spell fizzling out on a wall or the floor, from where it landed. */
  fizzle(at: Pos, superShot = false) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.count('fizzle');
    const out = this.panner(at, 3, 0.9);
    out.connect(this.ambience);
    const t0 = ctx.currentTime + 0.005;
    this.blip(out, t0, superShot ? 660 : 1400, superShot ? 0.25 : 0.6, superShot ? 0.35 : 0.16, superShot ? 0.09 : 0.06, 'triangle');
    this.shimmer(out, t0, superShot ? 0.55 : 0.3, 0.04);
  }

  /** A worker under the wand's spell drifting off on the floor: a soft bump and a sleepy three-note slide down. */
  doze(at: Pos) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.count('doze');
    const out = this.panner(at, 2.5, 1);
    out.connect(this.ambience);
    const t0 = ctx.currentTime + 0.005;
    this.play(pick(this.buf.steps), { gain: 0.18, rate: 0.6, when: t0, dest: out });
    [784, 659, 523].forEach((f, i) => this.blip(out, t0 + 0.12 + i * 0.22, f, 0.97, 0.3, 0.07));
  }

  /**
   * The wand's moves and spells (world/wand-motion.ts): a hum as the rotor spins up, a bright
   * run on the way out, a falling one on the way back, air for every swing, chimes where the magic
   * happens and a tick per lit segment of the build.
   */
  wandCue(cue: WandCue) {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime + 0.005;
    switch (cue) {
      case 'draw':
        this.count('wandDraw');
        this.swish(t0, 0.18, 600, 2400, 0.12, 1.1);
        [1047, 1319, 1568].forEach((f, i) => this.blip(this.ambience, t0 + 0.04 + i * 0.05, f, 1.01, 0.2, 0.05));
        break;
      case 'holster':
        this.count('wandHolster');
        this.swish(t0, 0.16, 2200, 700, 0.09, 1.1);
        [1568, 1319, 1047].forEach((f, i) => this.blip(this.ambience, t0 + i * 0.05, f, 0.99, 0.18, 0.045));
        this.blip(this.ambience, t0 + 0.12, 420, 0.4, 0.3, 0.05, 'triangle');
        break;
      case 'whoosh':
        this.gunCue('whoosh');
        break;
      case 'boot':
        // The rotor spinning up: a soft hum climbing an octave.
        this.count('wandBoot');
        this.blip(this.ambience, t0, 160, 2, 0.45, 0.06, 'sawtooth');
        this.blip(this.ambience, t0, 320, 2, 0.45, 0.04, 'triangle');
        break;
      case 'ready':
        this.count('wandReady');
        this.blip(this.ambience, t0, 1760, 1, 0.12, 0.05);
        this.blip(this.ambience, t0 + 0.07, 2637, 1, 0.18, 0.04);
        break;
      case 'charge':
        // Gathering: a glittering run that climbs.
        this.count('wandCharge');
        for (let i = 0; i < 6; i++) this.blip(this.ambience, t0 + i * 0.04, 880 * 2 ** (i / 4), 1.01, 0.12, 0.03);
        this.shimmer(this.ambience, t0, 0.3, 0.03);
        break;
      case 'release':
        this.wandZap();
        break;
      case 'superRelease':
        // A firm magical snap with a descending body and a luminous, suspended chord.
        this.count('wandSuperRelease');
        this.swish(t0, 0.14, 2800, 650, 0.2, 0.7);
        this.blip(this.ambience, t0, 196, 0.3, 0.22, 0.17, 'triangle');
        [1568, 2093, 3136].forEach((f, i) => this.blip(this.ambience, t0 + 0.025 + i * 0.035, f, 1.005, 0.55 - i * 0.07, 0.045 - i * 0.005));
        this.shimmer(this.ambience, t0 + 0.03, 0.65, 0.045);
        break;
      case 'lumos':
        // The tip catching light: a rising bell over a breath of glitter.
        this.count('wandLumos');
        this.blip(this.ambience, t0, 660, 2, 0.5, 0.08, 'triangle');
        [1319, 1976].forEach((f, i) => this.blip(this.ambience, t0 + 0.08 + i * 0.08, f, 1, 0.6, 0.05));
        this.shimmer(this.ambience, t0, 0.7, 0.04);
        break;
      case 'swish':
        this.count('wandSwish');
        this.swish(t0, 0.32, 500, 2800, 0.18, 1.6);
        break;
      case 'flick':
        this.count('wandFlick');
        this.swish(t0, 0.08, 2600, 5200, 0.16, 2.4);
        this.blip(this.ambience, t0 + 0.03, 1568, 1.5, 0.25, 0.08);
        this.shimmer(this.ambience, t0, 0.6, 0.05);
        break;
      case 'spark':
        // A sparkler fizzing: a few tiny crackles at random, over a breath of hiss.
        this.count('wandSpark');
        for (let i = 0; i < 3; i++) this.click(t0 + Math.random() * 0.06, rand(3200, 6400), 0.035);
        this.shimmer(this.ambience, t0, 0.09, 0.025);
        break;
      case 'confetti':
        // A party popper: a sharp pop, paper rushing out, and a bright little fanfare.
        this.count('wandConfetti');
        this.click(t0, 1800, 0.22);
        this.blip(this.ambience, t0, 320, 0.5, 0.08, 0.12, 'triangle');
        this.swish(t0 + 0.01, 0.4, 3500, 900, 0.1, 0.8);
        [784, 988, 1175, 1568].forEach((f, i) => this.blip(this.ambience, t0 + 0.06 + i * 0.06, f, 1, 0.3, 0.05));
        this.shimmer(this.ambience, t0 + 0.1, 0.8, 0.035);
        break;
      case 'tick':
        this.count('wandTick');
        this.blip(this.ambience, t0, rand(2300, 2500), 1, 0.04, 0.035, 'square');
        break;
      case 'done':
        // The build passing: a bright major arpeggio.
        this.count('wandDone');
        [1047, 1319, 1568, 2093].forEach((f, i) => this.blip(this.ambience, t0 + i * 0.07, f, 1, 0.35, 0.06));
        this.shimmer(this.ambience, t0 + 0.2, 0.6, 0.04);
        break;
    }
  }

  /** High, airy noise swelling and fading over `len` seconds: the glitter under a spell. */
  private shimmer(dest: AudioNode, when: number, len: number, gain: number) {
    const ctx = this.ctx!;
    const n = this.noise(this.buf.white);
    const g = ctx.createGain();
    envelope(g.gain, when, [
      [len * 0.2, gain],
      [len, 0],
    ]);
    n.connect(biquad(ctx, 'bandpass', 7000, 2))
      .connect(g)
      .connect(dest);
    n.start(when);
    n.stop(when + len + 0.02);
  }

  /** A short steel click: a tick of bright noise over a pinged tone at `freq`. */
  private click(when: number, freq: number, gain: number) {
    const ctx = this.ctx!;
    const n = this.noise(this.buf.white);
    const g = ctx.createGain();
    envelope(g.gain, when, [
      [0.001, gain],
      [0.018, 0],
    ]);
    n.connect(biquad(ctx, 'highpass', freq * 0.8, 0.7))
      .connect(g)
      .connect(this.ambience);
    n.start(when);
    n.stop(when + 0.03);
    this.blip(this.ambience, when, freq, 0.94, 0.035, gain * 0.5, 'square');
  }

  /** Air moving past fast: noise through a band swept from `from` to `to` Hz over `len` seconds. */
  private swish(when: number, len: number, from: number, to: number, gain: number, q: number) {
    const ctx = this.ctx!;
    const start = Math.max(when, ctx.currentTime);
    const n = this.noise(this.buf.white);
    const band = biquad(ctx, 'bandpass', from, q);
    band.frequency.setValueAtTime(from, start);
    band.frequency.exponentialRampToValueAtTime(to, start + len);
    const g = ctx.createGain();
    envelope(g.gain, start, [
      [len * 0.45, gain],
      [len, 0],
    ]);
    n.connect(band).connect(g).connect(this.ambience);
    n.start(start);
    n.stop(start + len + 0.02);
  }

  /** A body landing on the floorboards, from where it fell. */
  thud(at: Pos) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.count('thud');
    const out = this.panner(at, 2.5, 1);
    out.connect(this.ambience);
    const t0 = ctx.currentTime + 0.005;
    const n = this.noise(this.buf.brown);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.6, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
    n.connect(biquad(ctx, 'lowpass', 260, 0.7))
      .connect(g)
      .connect(out);
    n.start(t0);
    n.stop(t0 + 0.35);
    this.play(pick(this.buf.steps), { gain: 0.3, rate: 0.55, when: t0, dest: out });
  }

  /** A bullet striking a worker, from where it went in: a short wet smack over a dull thump. */
  hit(at: Pos) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.count('hit');
    const out = this.panner(at, 3, 0.9);
    out.connect(this.ambience);
    const t0 = ctx.currentTime + 0.005;
    const smack = this.noise(this.buf.white);
    const sg = ctx.createGain();
    envelope(sg.gain, t0, [
      [0.004, 0.55],
      [0.04, 0.12],
      [0.12, 0],
    ]);
    smack
      .connect(biquad(ctx, 'bandpass', 900, 1.1))
      .connect(sg)
      .connect(out);
    smack.start(t0);
    smack.stop(t0 + 0.14);
    const thump = this.noise(this.buf.brown);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, t0);
    tg.gain.exponentialRampToValueAtTime(0.5, t0 + 0.012);
    tg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
    thump
      .connect(biquad(ctx, 'lowpass', 180, 0.8))
      .connect(tg)
      .connect(out);
    thump.start(t0);
    thump.stop(t0 + 0.22);
  }

  /** A missed shot cracking into the wall or floor, from where it hit. */
  impact(at: Pos) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.count('impact');
    const out = this.panner(at, 3, 0.9);
    out.connect(this.ambience);
    const t0 = ctx.currentTime + 0.005;
    const n = this.noise(this.buf.white);
    const g = ctx.createGain();
    envelope(g.gain, t0, [
      [0.006, 0.4],
      [0.05, 0.15],
      [0.16, 0],
    ]);
    n.connect(biquad(ctx, 'highpass', 2000, 0.7))
      .connect(g)
      .connect(out);
    n.start(t0);
    n.stop(t0 + 0.2);
  }

  // ---- Alerts ----------------------------------------------------------------------------------

  /**
   * A short tone, different for each reason: needs input rises, done is two notes up, an error
   * falls. They stay audible in a background tab. The alert mute drops them; the office mute does
   * too, since they share its volume.
   */
  ding(kind: AlertKind) {
    this.unlock();
    if (!this.ctx || this.alertsMuted) return;
    this.count(kind);
    this.tone(kind, this.dings);
  }

  /** The elevator arriving: the done tone, on the office volume, so the alert mute doesn't cover it. */
  floorChime() {
    this.unlock();
    if (!this.ctx) return;
    this.count('floor');
    this.tone('done', this.master);
  }

  /** The three tones in order, on one clock, so they don't pile up. Nothing while they're muted. */
  previewAlerts() {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx || this.alertsMuted) return;
    const t0 = ctx.currentTime;
    (['needs_input', 'done', 'error'] as const).forEach((kind, i) => {
      this.count(kind);
      this.tone(kind, this.dings, t0 + i * 0.32);
    });
  }

  private tone(kind: AlertKind, dest: AudioNode, at?: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const base = at ?? ctx.currentTime;
    for (const n of ALERTS[kind]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = n.type;
      o.frequency.value = n.freq;
      const t0 = base + n.at;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(n.gain, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.len);
      o.connect(g).connect(dest);
      o.start(t0);
      o.stop(t0 + n.len + 0.02);
    }
  }

  // ---- The jukebox ------------------------------------------------------------------------------

  /** What the office-wide jukebox plays, or null for nothing. It starts once the browser allows audio. */
  setJukebox(play: JukeboxPlay | null) {
    const was = this.jukebox;
    this.jukebox = play;
    // The same play, sent again after a reconnect or timed better once the clocks are compared: carry on
    // (a tune lines itself up again as it goes; an audio file jumps to the right spot).
    if (was && play && was.startedAt === play.startedAt && was.track === play.track && was.url === play.url) {
      if (this.stream && Math.abs(was.since - play.since) > 250) this.seekStream(this.stream);
      return;
    }
    this.applyJukebox(true);
  }

  /** Your own jukebox volume, 0–1, apart from the office sounds'. */
  setMusicVolume(volume: number, muted: boolean) {
    this.musicVolume = Math.max(0, Math.min(1, volume));
    this.musicMuted = muted;
    this.applyMusicVolume();
  }

  /** 1 on each beat of the tune, falling to 0 before the next, for the jukebox's lights. */
  beat(): number {
    if (this.tune) return this.tune.beat(this.musicAt());
    if (this.soundcloud?.playing) return 0.35 + 0.25 * Math.sin(performance.now() / 320);
    if (this.stream && !this.stream.paused) return 0.35 + 0.25 * Math.sin(performance.now() / 320);
    return 0;
  }

  /** How far into the jukebox's track it is now, in seconds. */
  private musicAt(): number {
    return this.jukebox ? Math.max(0, (performance.now() - this.jukebox.since) / 1000) : 0;
  }

  private applyMusicVolume() {
    if (!this.ctx) return;
    this.musicBus.gain.setTargetAtTime(this.musicGain(), this.ctx.currentTime, 0.04);
    this.hearStream();
  }

  private musicGain(): number {
    return this.musicMuted ? 0 : this.musicVolume * this.musicVolume;
  }

  /** Starts what the jukebox plays now, once there's audio; `changed` puts it on again from the top. */
  private applyJukebox(changed = false) {
    const ctx = this.ctx;
    if (!ctx || (!changed && (this.tune || this.stream || this.soundcloud))) return;
    this.tune?.stop();
    this.tune = null;
    this.soundcloud?.dispose();
    this.soundcloud = null;
    if (this.stream) {
      this.stream.pause();
      this.stream.removeAttribute('src');
      this.stream.load();
      this.stream = null;
    }
    clearInterval(this.musicTimer);
    const j = this.jukebox;
    if (!j) return;
    if (j.track === STREAM && j.url) return this.startStream(j.url);
    const tune = (this.tune = new TunePlayer(ctx, this.musicIn, j.track));
    this.count('tune');
    // On a timer rather than every frame, so it carries on in a background tab.
    const tick = () => tune.tick(this.musicAt());
    tick();
    this.musicTimer = window.setInterval(tick, 150);
  }

  private startStream(url: string) {
    const sc = soundCloudUrl(url);
    if (sc) {
      this.soundcloud = new SoundCloudPlayer(sc, (text) => this.onMusicError?.(text));
      this.hearStream();
      this.count('soundcloud');
      return;
    }
    const a = new Audio();
    a.preload = 'auto';
    a.loop = true;
    a.src = url;
    a.addEventListener('loadedmetadata', () => this.seekStream(a));
    a.addEventListener('error', () => {
      if (this.stream === a) this.onMusicError?.("📻 The jukebox can't play that stream in your browser");
    });
    this.stream = a;
    this.hearStream();
    void a.play().catch(() => {});
    this.count('stream');
  }

  /** An audio file (not live radio) picks up where everyone else is. */
  private seekStream(a: HTMLAudioElement) {
    if (Number.isFinite(a.duration) && a.duration > 0) a.currentTime = this.musicAt() % a.duration;
  }

  /** Muffles the jukebox the further you are from it. */
  private hearJukebox(now: number) {
    const d = this.jukeboxDistance();
    const cutoff = d < 5 ? 16000 : Math.max(1600, 16000 * (5 / d) ** 1.5);
    if (Math.abs(cutoff - this.musicCutoff) > this.musicCutoff * 0.02) {
      this.musicCutoff = cutoff;
      this.musicTone.frequency.setTargetAtTime(cutoff, now, 0.1);
    }
    this.hearStream();
  }

  /** A stream plays outside Web Audio (most don't allow that), so it gets quieter with distance by hand. */
  private hearStream() {
    if (!this.stream && !this.soundcloud) return;
    const d = Math.max(MUSIC_REF, this.jukeboxDistance());
    const volume = Math.min(1, this.musicGain() * (MUSIC_REF / (MUSIC_REF + MUSIC_ROLLOFF * (d - MUSIC_REF))));
    if (this.stream) this.stream.volume = volume;
    this.soundcloud?.setVolume(volume);
  }

  private jukeboxDistance(): number {
    const l = this.listener;
    return Math.hypot(l.x - JUKEBOX.x, l.y - JUKEBOX.y, l.z - JUKEBOX.z);
  }

  // ---- Plumbing --------------------------------------------------------------------------------

  private panner(p: Pos, ref = 1.5, rolloff = 1.2): PannerNode {
    const pn = this.ctx!.createPanner();
    pn.panningModel = 'equalpower';
    pn.distanceModel = 'inverse';
    pn.refDistance = ref;
    pn.rolloffFactor = rolloff;
    place(pn, p.x, p.y, p.z);
    return pn;
  }

  private noise(buffer: AudioBuffer, loop = false): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = buffer;
    s.loop = loop;
    return s;
  }

  private play(buffer: AudioBuffer, o: { at?: Pos; when?: number; gain?: number; rate?: number; dest?: AudioNode; ref?: number; rolloff?: number }) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = o.rate ?? 1;
    const g = ctx.createGain();
    g.gain.value = o.gain ?? 1;
    src.connect(g);
    let out: AudioNode = g;
    if (o.at) out = g.connect(this.panner(o.at, o.ref, o.rolloff));
    out.connect(o.dest ?? this.ambience);
    src.start(o.when ?? ctx.currentTime);
  }
}

function rms(a: AnalyserNode): number {
  const d = new Float32Array(a.fftSize);
  a.getFloatTimeDomainData(d);
  let s = 0;
  for (const v of d) s += v * v;
  return Math.sqrt(s / d.length);
}

function place(pn: PannerNode, x: number, y: number, z: number) {
  if (pn.positionX) {
    pn.positionX.value = x;
    pn.positionY.value = y;
    pn.positionZ.value = z;
  } else pn.setPosition(x, y, z);
}

function biquad(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

/** Ramps `param` from 0 through [seconds after t0, value] points. */
function envelope(param: AudioParam, t0: number, points: [number, number][]) {
  param.setValueAtTime(0, t0);
  for (const [dt, v] of points) param.linearRampToValueAtTime(v, t0 + dt);
}

// ---- Sound samples, made once when audio starts -----------------------------------------------------

interface Buffers {
  keys: AudioBuffer[];
  spaces: AudioBuffer[];
  mouse: AudioBuffer;
  steps: AudioBuffer[];
  rustle: AudioBuffer;
  brown: AudioBuffer;
  white: AudioBuffer;
}

function makeBuffers(ctx: BaseAudioContext): Buffers {
  return {
    keys: [0, 1, 2, 3, 4, 5].map(() => keyClick(ctx, { body: rand(190, 300), bright: rand(0.7, 1), release: rand(0.06, 0.09), decay: 95, len: 0.12 })),
    spaces: [0, 1].map(() => keyClick(ctx, { body: rand(105, 130), bright: 0.55, release: rand(0.09, 0.12), decay: 55, len: 0.2 })),
    mouse: keyClick(ctx, { body: 900, bright: 1, release: 0.07, decay: 400, len: 0.1 }),
    steps: [0, 1, 2].map(() => footstep(ctx)),
    rustle: rustle(ctx),
    brown: loopable(ctx, 6, brownNoise()),
    white: sample(ctx, 5, () => Math.random() * 2 - 1),
  };
}

function sample(ctx: BaseAudioContext, seconds: number, next: (t: number) => number, peak?: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const b = ctx.createBuffer(1, Math.ceil(sr * seconds), sr);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = next(i / sr);
  if (peak) {
    let max = 0;
    for (const v of d) max = Math.max(max, Math.abs(v));
    if (max > 0) for (let i = 0; i < d.length; i++) d[i] *= peak / max;
  }
  return b;
}

/** A buffer whose end runs smoothly into its start, so it loops without a click. */
function loopable(ctx: BaseAudioContext, seconds: number, next: () => number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.ceil(sr * seconds);
  const fade = Math.floor(sr * 0.25);
  const raw = new Float32Array(n + fade);
  for (let i = 0; i < raw.length; i++) raw[i] = next();
  const b = ctx.createBuffer(1, n, sr);
  const d = b.getChannelData(0);
  d.set(raw.subarray(0, n));
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    d[i] = raw[i] * Math.sqrt(k) + raw[n + i] * Math.sqrt(1 - k);
  }
  return b;
}

function brownNoise(): () => number {
  let last = 0;
  return () => {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    return last * 3.5;
  };
}

/** A key bottoming out, a bright tick over a short woody thock, then a softer tick as it springs back. */
function keyClick(ctx: BaseAudioContext, o: { body: number; bright: number; release: number; decay: number; len: number }): AudioBuffer {
  let prev = 0;
  let hiss = 0;
  let low = 0;
  return sample(
    ctx,
    o.len,
    (t) => {
      const w = Math.random() * 2 - 1;
      hiss += (w - prev - hiss) * 0.5; // high-passed, then the harshest top taken off
      prev = w;
      low += (w - low) * 0.15;
      let v = hiss * Math.exp(-t * 700) * o.bright + (Math.sin(2 * Math.PI * o.body * t) * 0.5 + low) * Math.exp(-t * o.decay);
      const r = t - o.release;
      if (r > 0) v += hiss * Math.exp(-r * 900) * o.bright * 0.45;
      return v;
    },
    0.9,
  );
}

/** A soft shoe on carpet: a muffled thud and a little scuff. */
function footstep(ctx: BaseAudioContext): AudioBuffer {
  let low = 0;
  let prev = 0;
  const scuffAt = rand(0.025, 0.045);
  return sample(
    ctx,
    0.25,
    (t) => {
      const w = Math.random() * 2 - 1;
      low += (w - low) * 0.03;
      const attack = Math.min(1, t / 0.004);
      let v = (low * 3 + Math.sin(2 * Math.PI * 62 * t) * 0.5) * attack * Math.exp(-t * 30);
      const s = t - scuffAt;
      if (s > 0) v += (w - prev) * 0.06 * Math.exp(-s * 50);
      prev = w;
      return v;
    },
    0.9,
  );
}

/** Paper being shuffled: crackly mid-range noise in uneven bursts. */
function rustle(ctx: BaseAudioContext): AudioBuffer {
  const len = 0.8;
  let a = 0;
  let b = 0;
  let amp = 0;
  let target = 0;
  let hold = 0;
  const sr = ctx.sampleRate;
  return sample(
    ctx,
    len,
    (t) => {
      const w = Math.random() * 2 - 1;
      a += (w - a) * 0.5;
      b += (w - b) * 0.05;
      if (--hold <= 0) {
        target = Math.random() ** 3;
        hold = Math.floor(rand(0.008, 0.03) * sr);
      }
      amp += (target - amp) * 0.02;
      return (a - b) * amp * Math.sin((Math.PI * t) / len);
    },
    0.8,
  );
}
