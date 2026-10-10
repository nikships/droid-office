// The droid wand's moves: drawing it, putting it away, casting, and the six spells on 1–6 (in
// place of the emotes). Each move is a few keyframed channels sampled over time, the way the
// .44 Magnum's are (gun-motion.ts), but on the wand's own channels: a wand is aimed, flicked and
// waved, not spun on a trigger finger. Your hands in first person (hands.ts) read the pose, and
// main.ts turns the cues into sound and spell effects. Pure numbers: no three.js, DOM or WebGL,
// so tests load it in Node.

import { type Key, sampleTrack } from './gun-motion';

/** The spells, in key order (1–6) and round the wheel (G). */
export const WAND_SPELLS = [
  { id: 'lumos', emoji: '💡', label: 'Lumos' },
  { id: 'leviosa', emoji: '🪶', label: 'Swish and flick' },
  { id: 'flare', emoji: '🎆', label: 'Flare' },
  { id: 'twirl', emoji: '🌀', label: 'Twirl' },
  { id: 'build', emoji: '🔨', label: 'Run the build' },
  { id: 'protego', emoji: '🛡️', label: 'Protego' },
] as const;

export type WandSpellId = (typeof WAND_SPELLS)[number]['id'];
export type WandMoveId = 'draw' | 'holster' | 'cast' | WandSpellId;

/**
 * What a move sounds like and when its magic happens. main.ts turns these into sound (sound.ts
 * wandCue) and into the spell's effect: `release` sends a cast's bolt off the tip, `lumos` turns
 * the light at the tip on or off, `flick` and `flare` and `shield` set off their spells, and
 * `tick` is one segment of the progress bar lighting up.
 */
export type WandCue = 'draw' | 'holster' | 'whoosh' | 'boot' | 'ready' | 'charge' | 'release' | 'lumos' | 'swish' | 'flick' | 'flare' | 'catch' | 'tick' | 'done' | 'shield';

export const WAND_CHANNELS = ['out', 'x', 'y', 'z', 'pitch', 'yaw', 'roll', 'twirl', 'spin', 'glow', 'charge', 'trail'] as const;
export type WandChannel = (typeof WAND_CHANNELS)[number];

/**
 * A pose of the wand and the hand holding it, relative to the ready pose (all zeros, `out` 1),
 * where the wand points from the bottom right of the view at the crosshair.
 *
 * - `out`: 1 up in the hand at the ready, 0 down out of view.
 * - `x`, `y`, `z`: the hand moved right, up and back toward your eyes, in meters.
 * - `pitch`, `yaw`, `roll`: the wand tipped up, swung to your left, and the wrist rolled
 *   clockwise as you see it, in radians.
 * - `twirl`: the wand turned end over end in the fingers round the grip, in radians.
 * - `spin`: the rotor at the tip spun up, 0 idling … 1 flat out.
 * - `glow`: the emitter in front of the rotor lit, 0 … 1.
 * - `charge`: how much of the progress bar along the shaft is lit, 0 … 1.
 * - `trail`: 0 … 1, how thick a trail of light the tip leaves behind it.
 */
export type WandPose = Record<WandChannel, number>;

/** Angle channels, and how far round brings each back to where it started. */
const PERIOD: Partial<Record<WandChannel, number>> = { twirl: Math.PI * 2 };

const rest = (out: number): WandPose => {
  const p = {} as WandPose;
  for (const c of WAND_CHANNELS) p[c] = 0;
  p.out = out;
  return p;
};
/** Up in the hand, aimed at the crosshair. */
export const WAND_READY: Readonly<WandPose> = Object.freeze(rest(1));
/** Put away. */
export const WAND_AWAY: Readonly<WandPose> = Object.freeze(rest(0));

export interface WandMove {
  seconds: number;
  /** Channels a move leaves out stay where the ready pose has them. */
  tracks: Partial<Record<WandChannel, readonly Key[]>>;
  /** [seconds into the move, cue], in order. */
  cues: readonly (readonly [number, WandCue])[];
}

const TAU = Math.PI * 2;

/** When a cast's bolt leaves the tip: the bottom of the flick, a tenth of a second after the click. */
export const RELEASE_AT = 0.11;

/** Each segment's tick as Run the build fills the progress bar, from the first to the tenth. */
const BUILD_FROM = 0.45;
const BUILD_STEP = 0.13;
const BUILD_TICKS = Array.from({ length: 10 }, (_, i) => [BUILD_FROM + 0.02 + i * BUILD_STEP, 'tick'] as const);

/** The moves. Each starts and ends on the ready pose (the twirl may end whole turns round). */
export const WAND_MOVES: Record<WandMoveId, WandMove> = {
  // Up from below with one twirl through the fingers, the rotor spinning up and the progress bar
  // sweeping along as it boots, caught at the ready with the emitter blinking on.
  draw: {
    seconds: 0.72,
    tracks: {
      out: [
        [0, 0],
        [0.32, 1, 'out'],
      ],
      y: [
        [0, 0],
        [0.32, 0.03, 'out'],
        [0.5, -0.008],
        [0.72, 0],
      ],
      pitch: [
        [0, -0.6],
        [0.32, 0.22, 'out'],
        [0.52, -0.05],
        [0.72, 0],
      ],
      roll: [
        [0, 0.5],
        [0.36, -0.15],
        [0.72, 0],
      ],
      twirl: [
        [0.04, -TAU],
        [0.42, 0, 'inOut'],
      ],
      spin: [
        [0, 0],
        [0.25, 1],
        [0.72, 0],
      ],
      charge: [
        [0.18, 0],
        [0.48, 1, 'linear'],
        [0.6, 1],
        [0.72, 0],
      ],
      glow: [
        [0.46, 0],
        [0.52, 1, 'snap'],
        [0.72, 0],
      ],
      trail: [
        [0.08, 0],
        [0.16, 0.6],
        [0.4, 0.6],
        [0.46, 0],
      ],
    },
    cues: [
      [0, 'draw'],
      [0.1, 'whoosh'],
      [0.2, 'boot'],
      [0.5, 'ready'],
    ],
  },
  // Down out of view with the rotor spinning down.
  holster: {
    seconds: 0.45,
    tracks: {
      out: [
        [0, 1],
        [0.12, 1],
        [0.45, 0, 'in'],
      ],
      pitch: [
        [0, 0],
        [0.1, 0.12],
        [0.45, -0.7],
      ],
      roll: [
        [0, 0],
        [0.45, 0.4],
      ],
    },
    cues: [[0, 'holster']],
  },
  // A flick at the crosshair, all in the wrist: the tip drawn back a touch as the progress bar
  // charges, then snapped forward and down at the target with a short thrust of the fist, sending
  // the bolt off (RELEASE_AT). It holds on the target a beat, then settles back up to the ready.
  // The fist barely travels, so the arm stays down out of the view.
  cast: {
    seconds: 0.46,
    tracks: {
      pitch: [
        [0, 0],
        [0.06, 0.14, 'out'],
        [RELEASE_AT, -0.74, 'snap'],
        [0.19, -0.7],
        [0.46, 0, 'inOut'],
      ],
      z: [
        [0, 0],
        [0.06, 0.012],
        [RELEASE_AT, -0.07, 'snap'],
        [0.19, -0.062],
        [0.46, 0, 'inOut'],
      ],
      y: [
        [0, 0],
        [0.06, 0.008],
        [RELEASE_AT, -0.05, 'snap'],
        [0.19, -0.046],
        [0.46, 0, 'inOut'],
      ],
      x: [
        [0, 0],
        [RELEASE_AT, -0.015, 'snap'],
        [0.19, -0.013],
        [0.46, 0, 'inOut'],
      ],
      spin: [
        [0, 0],
        [0.06, 1, 'out'],
        [0.46, 0],
      ],
      charge: [
        [0, 0],
        [0.07, 1, 'linear'],
        [0.18, 1],
        [0.46, 0],
      ],
      glow: [
        [0, 0.2],
        [RELEASE_AT, 1, 'snap'],
        [0.46, 0],
      ],
      trail: [
        [0.05, 0],
        [0.08, 1],
        [0.15, 1],
        [0.24, 0],
      ],
    },
    cues: [
      [0, 'charge'],
      [RELEASE_AT, 'release'],
    ],
  },
  // Up and a twist of the wrist: the emitter lights the room, or goes out.
  lumos: {
    seconds: 0.7,
    tracks: {
      pitch: [
        [0, 0],
        [0.22, 0.22, 'out'],
        [0.7, 0],
      ],
      y: [
        [0, 0],
        [0.22, 0.04, 'out'],
        [0.7, 0],
      ],
      roll: [
        [0, 0],
        [0.18, -0.5],
        [0.3, 0.1],
        [0.7, 0],
      ],
      spin: [
        [0, 0],
        [0.25, 1],
        [0.7, 0],
      ],
      charge: [
        [0, 0],
        [0.25, 1, 'linear'],
        [0.4, 1],
        [0.7, 0],
      ],
      glow: [
        [0.2, 0],
        [0.27, 1, 'snap'],
        [0.7, 0],
      ],
    },
    cues: [
      [0, 'whoosh'],
      [0.26, 'lumos'],
    ],
  },
  // Swish and flick: a loop to the left and up, round to the right, and a sharp flick down that
  // lets the sparks off.
  leviosa: {
    seconds: 1.1,
    tracks: {
      x: [
        [0, 0],
        [0.2, -0.06],
        [0.4, -0.02],
        [0.6, 0.05],
        [0.72, 0.03],
        [0.8, -0.01, 'snap'],
        [1.1, 0],
      ],
      y: [
        [0, 0],
        [0.2, 0.03],
        [0.4, 0.07],
        [0.6, 0.04],
        [0.72, 0.06],
        [0.8, -0.02, 'snap'],
        [1.1, 0],
      ],
      pitch: [
        [0, 0],
        [0.4, 0.15],
        [0.72, 0.22],
        [0.8, -0.7, 'snap'],
        [1.1, 0],
      ],
      yaw: [
        [0, 0],
        [0.2, 0.25],
        [0.45, 0.05],
        [0.6, -0.25],
        [0.75, -0.05],
        [1.1, 0],
      ],
      roll: [
        [0, 0],
        [0.3, -0.25],
        [0.6, 0.2],
        [1.1, 0],
      ],
      spin: [
        [0, 0],
        [0.3, 0.6],
        [0.8, 1],
        [1.1, 0],
      ],
      trail: [
        [0, 0],
        [0.06, 1],
        [0.82, 1],
        [0.95, 0],
      ],
      glow: [
        [0.72, 0],
        [0.8, 1, 'snap'],
        [1.1, 0],
      ],
      charge: [
        [0, 0],
        [0.75, 1, 'linear'],
        [0.85, 1],
        [1.1, 0],
      ],
    },
    cues: [
      [0.02, 'swish'],
      [0.78, 'flick'],
    ],
  },
  // Straight up over your head and a flare off the tip, bursting under the ceiling.
  flare: {
    seconds: 0.95,
    tracks: {
      pitch: [
        [0, 0],
        [0.25, 0.55, 'out'],
        [0.38, 0.62],
        [0.43, 0.42, 'snap'],
        [0.95, 0],
      ],
      y: [
        [0, 0],
        [0.25, 0.07, 'out'],
        [0.43, 0.05],
        [0.95, 0],
      ],
      x: [
        [0, 0],
        [0.25, -0.03],
        [0.95, 0],
      ],
      z: [
        [0, 0],
        [0.25, 0.02],
        [0.43, -0.015, 'snap'],
        [0.95, 0],
      ],
      spin: [
        [0, 0],
        [0.3, 1],
        [0.95, 0],
      ],
      charge: [
        [0.05, 0],
        [0.36, 1, 'linear'],
        [0.5, 1],
        [0.95, 0],
      ],
      glow: [
        [0.3, 0],
        [0.4, 1, 'snap'],
        [0.95, 0],
      ],
      trail: [
        [0.38, 0],
        [0.42, 1],
        [0.5, 0],
      ],
    },
    cues: [
      [0, 'whoosh'],
      [0.1, 'charge'],
      [0.4, 'flare'],
    ],
  },
  // Twice end over end through the fingers, light trailing off the tip, and caught at the ready.
  twirl: {
    seconds: 0.9,
    tracks: {
      twirl: [
        [0.05, 0],
        [0.8, TAU * 2, 'inOut'],
      ],
      y: [
        [0, 0],
        [0.3, 0.03],
        [0.9, 0],
      ],
      x: [
        [0, 0],
        [0.3, -0.02],
        [0.9, 0],
      ],
      roll: [
        [0, 0],
        [0.4, 0.3],
        [0.9, 0],
      ],
      spin: [
        [0, 0],
        [0.3, 0.8],
        [0.9, 0],
      ],
      trail: [
        [0.1, 0],
        [0.2, 0.7],
        [0.7, 0.7],
        [0.8, 0],
      ],
    },
    cues: [
      [0.12, 'whoosh'],
      [0.45, 'whoosh'],
      [0.8, 'catch'],
    ],
  },
  // Up close and turned to the light, the rotor ticking over while the progress bar fills one
  // segment at a time, then a blink of the emitter when the build goes green.
  build: {
    seconds: 2.4,
    tracks: {
      x: [
        [0, 0],
        [0.4, -0.07],
        [2.0, -0.07],
        [2.4, 0],
      ],
      y: [
        [0, 0],
        [0.4, 0.02],
        [2.0, 0.02],
        [2.4, 0],
      ],
      z: [
        [0, 0],
        [0.4, 0.05],
        [2.0, 0.05],
        [2.4, 0],
      ],
      yaw: [
        [0, 0],
        [0.4, 0.45],
        [1.2, 0.6],
        [2.0, 0.4],
        [2.4, 0],
      ],
      pitch: [
        [0, 0],
        [0.4, -0.55],
        [2.0, -0.6],
        [2.4, 0],
      ],
      roll: [
        [0, 0],
        [0.4, -0.5],
        [1.2, 0.3],
        [2.0, -0.2],
        [2.4, 0],
      ],
      charge: [
        [BUILD_FROM, 0],
        [BUILD_FROM + BUILD_STEP * 10, 1, 'linear'],
        [2.05, 1],
        [2.2, 0],
      ],
      glow: [
        [1.75, 0],
        [1.8, 1, 'snap'],
        [2.2, 0],
      ],
      spin: [
        [0, 0],
        [0.5, 0.3],
        [1.75, 0.3],
        [1.85, 1],
        [2.4, 0],
      ],
    },
    cues: [[0, 'whoosh'], ...BUILD_TICKS, [1.78, 'done'], [2.05, 'whoosh']],
  },
  // Raised across you, the ward flaring up in front and holding a moment before it fades.
  protego: {
    seconds: 1.4,
    tracks: {
      x: [
        [0, 0],
        [0.22, -0.06, 'out'],
        [1.1, -0.06],
        [1.4, 0],
      ],
      y: [
        [0, 0],
        [0.22, 0.05, 'out'],
        [1.1, 0.05],
        [1.4, 0],
      ],
      yaw: [
        [0, 0],
        [0.22, 0.45, 'out'],
        [1.1, 0.4],
        [1.4, 0],
      ],
      roll: [
        [0, 0],
        [0.22, 0.65, 'out'],
        [1.1, 0.6],
        [1.4, 0],
      ],
      pitch: [
        [0, 0],
        [0.22, 0.06, 'out'],
        [1.1, 0.04],
        [1.4, 0],
      ],
      spin: [
        [0, 0],
        [0.25, 1],
        [1.1, 0.6],
        [1.4, 0],
      ],
      charge: [
        [0, 0],
        [0.22, 1, 'linear'],
        [1.1, 1],
        [1.4, 0],
      ],
      glow: [
        [0.2, 0],
        [0.26, 1, 'snap'],
        [1.1, 0.6],
        [1.4, 0],
      ],
    },
    cues: [
      [0, 'whoosh'],
      [0.24, 'shield'],
    ],
  },
};

/** The pose `t` seconds into a move, into `out` (a fresh one if not given). */
export function sampleWandMove(move: WandMove, t: number, out: WandPose = rest(1)): WandPose {
  for (const c of WAND_CHANNELS) {
    const keys = move.tracks[c];
    out[c] = keys ? sampleTrack(keys, t) : WAND_READY[c];
  }
  return out;
}

/** How long a new move takes to take over from wherever the wand was. */
const BLEND = 0.1;
/** A cast takes over from a spell quicker than that: a click always answers at once. */
const CAST_BLEND = 0.05;

const wrap = (a: number, period: number) => a - period * Math.round(a / period);

/**
 * Your wand's moves, one at a time. Anything new (a spell, a cast, putting it away, drawing it
 * again on its way down) takes over at once from wherever the wand is, blending in over a few
 * frames. update() moves it on and says which cues just passed; `pose` is null once it's away.
 */
export class WandMotion {
  private wanted = false;
  private move: { id: WandMoveId; spec: WandMove; t: number; from: WandPose | null; blend: number; cue: number } | null = null;
  private current: WandPose | null = null;

  /** The wand and the hand holding it now, or null with it put away. Read it fresh each frame. */
  get pose(): Readonly<WandPose> | null {
    return this.current;
  }

  /** Drawn, or on its way up: not away, and not on its way down. */
  get drawn(): boolean {
    return this.wanted;
  }

  /** The move playing now (null at the ready, or away). */
  get doing(): WandMoveId | null {
    return this.move?.id ?? null;
  }

  /** Up into your hand, or back up if it's on its way down. */
  draw() {
    if (this.wanted) return;
    this.wanted = true;
    this.start('draw', WAND_MOVES.draw);
  }

  /** Down out of view, the rotor spinning down. */
  holster() {
    if (!this.wanted) return;
    if (!this.current) return this.stow();
    this.wanted = false;
    this.start('holster', WAND_MOVES.holster);
  }

  /** Straight away with no move: your hands are needed for something else. */
  stow() {
    this.wanted = false;
    this.move = null;
    this.current = null;
  }

  /** Plays a spell from the top, even over itself. False with the wand away. */
  spell(id: WandSpellId): boolean {
    if (!this.wanted) return false;
    this.start(id, WAND_MOVES[id]);
    return true;
  }

  /** A cast at the crosshair: its `release` cue comes RELEASE_AT later. False with the wand away. */
  cast(): boolean {
    if (!this.wanted) return false;
    this.start('cast', WAND_MOVES.cast, CAST_BLEND);
    return true;
  }

  update(dt: number): WandCue[] {
    const cues: WandCue[] = [];
    const m = this.move;
    if (m) {
      m.t += dt;
      while (m.cue < m.spec.cues.length && m.spec.cues[m.cue][0] <= m.t) cues.push(m.spec.cues[m.cue++][1]);
      if (m.t >= m.spec.seconds) this.move = null;
    }
    if (!this.wanted && !this.move) {
      this.current = null;
      return cues;
    }
    const pose = (this.current ??= rest(1));
    const live = this.move;
    if (live) sampleWandMove(live.spec, live.t, pose);
    else Object.assign(pose, WAND_READY);
    if (live?.from && live.t < live.blend) {
      const p = live.t / live.blend;
      const w = p * p * (3 - 2 * p);
      for (const c of WAND_CHANNELS) pose[c] = live.from[c] + (pose[c] - live.from[c]) * w;
    }
    return cues;
  }

  private start(id: WandMoveId, spec: WandMove, blend = BLEND) {
    let from: WandPose | null = null;
    if (this.current) {
      from = { ...this.current };
      // Angles the short way round to where the new move starts.
      const first = sampleWandMove(spec, 0);
      for (const [c, period] of Object.entries(PERIOD) as [WandChannel, number][]) from[c] = first[c] + wrap(from[c] - first[c], period);
    }
    this.move = { id, spec, t: 0, from, blend, cue: 0 };
  }
}
