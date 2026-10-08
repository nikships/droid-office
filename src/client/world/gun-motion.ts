// The .44 Magnum's moves: drawing it, holstering it, and the tricks you do with it out (1–6, in
// place of the emotes). Each move is a few keyframed channels sampled over time, so your hands in
// first person (hands.ts) and your character in third (character.ts) read one pose and stay in
// step. Pure numbers: no three.js, DOM or WebGL, so tests load it in Node.

/** The tricks, in key order (1–6) and round the wheel (G). */
export const GUN_TRICKS = [
  { id: 'twirl', emoji: '🤠', label: 'Twirl' },
  { id: 'inspect', emoji: '🔍', label: 'Inspect' },
  { id: 'cylinder', emoji: '🎰', label: 'Spin the cylinder' },
  { id: 'yy', emoji: '⚡', label: 'YY' },
  { id: 'smoke', emoji: '💨', label: 'Blow the smoke off' },
  { id: 'toss', emoji: '🪙', label: 'Flip it' },
] as const;

export type GunTrickId = (typeof GUN_TRICKS)[number]['id'];
export type GunMoveId = 'draw' | 'holster' | GunTrickId;

/**
 * What a move sounds like, and when the smoke comes off the muzzle: main.ts turns these into
 * sound (sound.ts gunCue) and smoke.
 */
export type GunCue = 'draw' | 'holster' | 'whoosh' | 'catch' | 'cock' | 'handle' | 'open' | 'ratchet' | 'shut' | 'swap' | 'blow' | 'puff';

export const GUN_CHANNELS = ['out', 'x', 'y', 'z', 'pitch', 'yaw', 'roll', 'spin', 'turn', 'tilt', 'lift', 'crane', 'cylinder', 'finger', 'left', 'palm', 'kick'] as const;
export type GunChannel = (typeof GUN_CHANNELS)[number];

/**
 * A pose of the gun and the hand holding it, relative to the ready pose (all zeros, `out` 1).
 *
 * - `out`: 1 up in the hand at the ready, 0 down in the holster at the hip. Each holder maps it to
 *   its own arm (off the bottom of the screen in first person, down at the side in third).
 * - `x`, `y`, `z`: the hand moved right, up and back toward your eyes, in meters as first person
 *   sees it. Third person turns these into the arm swinging across and up.
 * - `pitch`, `yaw`, `roll`: the hand turned muzzle up, muzzle to your left, and canted top-left.
 * - `spin`: the gun round the trigger finger, + muzzle down and forward over (a gunslinger spin).
 * - `turn`, `tilt`: the gun turned in the hand, muzzle to its left, and rolled about its barrel.
 * - `lift`: meters straight up out of the hand (tossed).
 * - `crane`: the cylinder 0 shut … 1 swung out; `cylinder` its turn about its own axis.
 * - `finger`: 1 with the trigger finger through the guard (spinning), 0 a fist round the grip.
 * - `left`: the left hand in at the cylinder (0 away … 1 there), and `palm` its swipe down it (-1 … 1).
 * - `kick`: a shot's recoil, 1 the moment it fires.
 */
export type GunPose = Record<GunChannel, number>;

/** Angle channels, and how far round brings each back to where it started (a chamber, for the cylinder). */
const PERIOD: Partial<Record<GunChannel, number>> = { spin: Math.PI * 2, turn: Math.PI * 2, tilt: Math.PI * 2, cylinder: Math.PI / 3 };

const rest = (out: number): GunPose => {
  const p = {} as GunPose;
  for (const c of GUN_CHANNELS) p[c] = 0;
  p.out = out;
  return p;
};
/** Up in the hand, aimed at the crosshair. */
export const READY: Readonly<GunPose> = Object.freeze(rest(1));
/** In the holster. */
export const HOLSTERED: Readonly<GunPose> = Object.freeze(rest(0));

/** How a key is reached from the one before it. */
type Ease = 'linear' | 'in' | 'out' | 'inOut' | 'back' | 'snap';
/** [seconds into the move, value, how it gets there from the key before]. */
type Key = readonly [number, number, Ease?];

export interface GunMove {
  seconds: number;
  /** Channels a move leaves out stay where the ready pose has them. */
  tracks: Partial<Record<GunChannel, readonly Key[]>>;
  /** [seconds into the move, cue], in order. */
  cues: readonly (readonly [number, GunCue])[];
}

const TAU = Math.PI * 2;

/** The moves. Each trick starts and ends on the ready pose (angles may end whole turns round). */
export const GUN_MOVES: Record<GunMoveId, GunMove> = {
  // Up out of the holster with one flip back over the trigger finger, caught at the ready with the hammer back.
  draw: {
    seconds: 0.62,
    tracks: {
      out: [
        [0, 0],
        [0.26, 1, 'out'],
      ],
      y: [
        [0, 0],
        [0.26, 0.04, 'out'],
        [0.44, -0.012],
        [0.62, 0],
      ],
      pitch: [
        [0, 0],
        [0.26, 0.3, 'out'],
        [0.44, -0.08],
        [0.62, 0],
      ],
      roll: [
        [0, 0.35],
        [0.3, -0.12],
        [0.62, 0],
      ],
      spin: [
        [0.06, 0],
        [0.4, -TAU, 'inOut'],
      ],
      finger: [
        [0, 1],
        [0.38, 1],
        [0.42, 0, 'linear'],
      ],
    },
    cues: [
      [0, 'draw'],
      [0.12, 'whoosh'],
      [0.4, 'catch'],
      [0.47, 'cock'],
    ],
  },
  // A last spin forward and down, off the bottom of the view into the holster.
  holster: {
    seconds: 0.55,
    tracks: {
      out: [
        [0, 1],
        [0.2, 1],
        [0.55, 0, 'in'],
      ],
      y: [
        [0, 0],
        [0.1, 0.035, 'out'],
        [0.55, 0],
      ],
      roll: [
        [0, 0],
        [0.22, 0.22],
        [0.55, 0.35],
      ],
      spin: [
        [0.04, 0],
        [0.44, TAU, 'inOut'],
      ],
      finger: [
        [0, 0],
        [0.06, 1, 'linear'],
      ],
    },
    cues: [
      [0.04, 'whoosh'],
      [0.24, 'whoosh'],
      [0.48, 'holster'],
    ],
  },
  // Ocelot: turned side-on, three spins forward faster and faster, a stop, one back the other way, and caught.
  twirl: {
    seconds: 1.75,
    tracks: {
      x: [
        [0, 0],
        [0.18, -0.05, 'out'],
        [1.48, -0.05],
        [1.75, 0, 'inOut'],
      ],
      y: [
        [0, 0],
        [0.18, 0.05, 'out'],
        [1.46, 0.05],
        [1.54, 0.02, 'out'],
        [1.75, 0, 'inOut'],
      ],
      z: [
        [0, 0],
        [0.18, -0.1, 'out'],
        [1.46, -0.1],
        [1.75, 0, 'inOut'],
      ],
      yaw: [
        [0, 0],
        [0.18, 0.75, 'out'],
        [1.46, 0.75],
        [1.75, 0, 'inOut'],
      ],
      roll: [
        [0, 0],
        [0.18, -0.15, 'out'],
        [1.0, -0.2],
        [1.12, 0.1, 'out'],
        [1.46, -0.15],
        [1.75, 0, 'inOut'],
      ],
      pitch: [
        [0, 0],
        [1.46, 0],
        [1.53, -0.16, 'out'],
        [1.75, 0, 'inOut'],
      ],
      spin: [
        [0.14, 0],
        [0.56, TAU, 'in'],
        [1.0, TAU * 3, 'linear'],
        [1.12, TAU * 3 + 0.7, 'out'],
        [1.46, TAU * 2, 'inOut'],
      ],
      finger: [
        [0, 0],
        [0.1, 1, 'linear'],
        [1.44, 1],
        [1.48, 0, 'linear'],
      ],
    },
    cues: [
      [0.02, 'handle'],
      [0.36, 'whoosh'],
      [0.62, 'whoosh'],
      [0.8, 'whoosh'],
      [0.96, 'whoosh'],
      [1.26, 'whoosh'],
      [1.46, 'catch'],
      [1.6, 'cock'],
    ],
  },
  // Counter-Strike: brought in to show its left side, the wrist rolled right over to show the other
  // (and the back of the glove), and back. The fist never lets go, so it's all wrist: no tilt.
  inspect: {
    seconds: 2.8,
    tracks: {
      x: [
        [0, 0],
        [0.38, -0.16, 'inOut'],
        [2.42, -0.16],
        [2.8, 0, 'inOut'],
      ],
      // Up higher while it's rolled over, the gun hanging under the fist.
      y: [
        [0, 0],
        [0.38, 0.1, 'inOut'],
        [1.0, 0.115],
        [1.5, 0.2, 'inOut'],
        [1.95, 0.19],
        [2.42, 0.1, 'inOut'],
        [2.8, 0, 'inOut'],
      ],
      z: [
        [0, 0],
        [0.38, 0.1, 'inOut'],
        [2.42, 0.1],
        [2.8, 0, 'inOut'],
      ],
      yaw: [
        [0, 0],
        [0.38, 1.2, 'inOut'],
        [0.95, 1.3],
        [1.45, 1.0],
        [2.0, 0.95],
        [2.42, 0.55],
        [2.8, 0, 'inOut'],
      ],
      pitch: [
        [0, 0],
        [0.38, 0.18, 'inOut'],
        [0.95, 0.06],
        [1.45, 0.14],
        [2.0, 0.22],
        [2.3, 0.5],
        [2.8, 0, 'inOut'],
      ],
      roll: [
        [0, 0],
        [0.38, -0.2, 'inOut'],
        [1.0, -0.28],
        [1.5, 2.55, 'inOut'],
        [1.95, 2.4],
        [2.4, 0.15, 'inOut'],
        [2.8, 0, 'inOut'],
      ],
    },
    cues: [
      [0.02, 'handle'],
      [1.0, 'handle'],
      [1.95, 'handle'],
      [2.6, 'cock'],
    ],
  },
  // Canted over so the cylinder falls out, a palm down it to spin it, and a flick of the wrist to slam it shut.
  cylinder: {
    seconds: 2.5,
    tracks: {
      x: [
        [0, 0],
        [0.3, -0.12, 'inOut'],
        [1.64, -0.12],
        [1.78, -0.08, 'snap'],
        [2.5, 0, 'inOut'],
      ],
      y: [
        [0, 0],
        [0.3, 0.075, 'inOut'],
        [1.64, 0.075],
        [1.78, 0.11, 'snap'],
        [2.5, 0, 'inOut'],
      ],
      z: [
        [0, 0],
        [0.3, 0.06, 'inOut'],
        [1.64, 0.06],
        [2.5, 0, 'inOut'],
      ],
      yaw: [
        [0, 0],
        [0.3, 0.8, 'inOut'],
        [1.64, 0.8],
        [1.78, 0.45, 'snap'],
        [2.5, 0, 'inOut'],
      ],
      pitch: [
        [0, 0],
        [0.3, 0.12, 'inOut'],
        [1.64, 0.12],
        [1.78, 0.32, 'snap'],
        [2.5, 0, 'inOut'],
      ],
      roll: [
        [0, 0],
        [0.3, 0.6, 'inOut'],
        [1.62, 0.6],
        [1.77, -0.4, 'snap'],
        [2.1, 0.06, 'inOut'],
        [2.5, 0, 'inOut'],
      ],
      crane: [
        [0.32, 0],
        [0.48, 1, 'back'],
        [1.66, 1],
        [1.75, 0, 'in'],
      ],
      cylinder: [
        [0.56, 0],
        [0.64, 1.4, 'linear'],
        [1.58, TAU * 3, 'out'],
      ],
      left: [
        [0.28, 0],
        [0.48, 1, 'out'],
        [0.68, 1],
        [0.9, 0, 'inOut'],
      ],
      palm: [
        [0.3, 0],
        [0.48, 1, 'out'],
        [0.66, -1, 'out'],
        [0.9, 0],
      ],
    },
    cues: [
      [0.02, 'handle'],
      [0.4, 'open'],
      [0.58, 'ratchet'],
      [1.74, 'shut'],
      [2.2, 'cock'],
    ],
  },
  // MW2's yy: two weapon swaps cancelled straight back, a snap down and up, and again.
  yy: {
    seconds: 0.72,
    tracks: {
      out: [
        [0, 1],
        [0.09, 0.42, 'out'],
        [0.19, 1, 'out'],
        [0.28, 0.42, 'out'],
        [0.4, 1, 'out'],
      ],
      pitch: [
        [0, 0],
        [0.09, -0.35, 'out'],
        [0.19, 0.14, 'out'],
        [0.28, -0.35, 'out'],
        [0.4, 0.18, 'out'],
        [0.72, 0, 'inOut'],
      ],
      roll: [
        [0, 0],
        [0.09, 0.4, 'out'],
        [0.19, -0.1, 'out'],
        [0.28, -0.4, 'out'],
        [0.4, 0.1, 'out'],
        [0.72, 0, 'inOut'],
      ],
      y: [
        [0.4, 0],
        [0.48, 0.02, 'out'],
        [0.72, 0, 'inOut'],
      ],
    },
    cues: [
      [0, 'swap'],
      [0.17, 'cock'],
      [0.19, 'swap'],
      [0.38, 'cock'],
    ],
  },
  // Muzzle up by your face, the smoke blown off it, and a spin back down to the ready.
  smoke: {
    seconds: 2.3,
    tracks: {
      x: [
        [0, 0],
        [0.4, -0.1, 'inOut'],
        [1.32, -0.1],
        [1.72, 0, 'inOut'],
      ],
      y: [
        [0, 0],
        [0.4, 0.03, 'inOut'],
        [1.32, 0.04],
        [1.72, 0, 'inOut'],
      ],
      z: [
        [0, 0],
        [0.4, 0.02, 'inOut'],
        [1.32, 0.02],
        [1.72, 0, 'inOut'],
      ],
      pitch: [
        [0, 0],
        [0.4, 0.95, 'inOut'],
        [1.32, 0.9],
        [1.72, 0, 'inOut'],
        [1.84, -0.12, 'out'],
        [2.3, 0, 'inOut'],
      ],
      yaw: [
        [0, 0],
        [0.4, 0.45, 'inOut'],
        [1.32, 0.45],
        [1.72, 0, 'inOut'],
      ],
      roll: [
        [0, 0],
        [0.4, 0.2, 'inOut'],
        [1.32, 0.2],
        [1.72, 0, 'inOut'],
      ],
      spin: [
        [1.3, 0],
        [1.74, -TAU, 'inOut'],
      ],
      finger: [
        [1.26, 0],
        [1.3, 1, 'linear'],
        [1.72, 1],
        [1.76, 0, 'linear'],
      ],
    },
    cues: [
      [0.02, 'handle'],
      [0.6, 'blow'],
      [0.64, 'puff'],
      [0.74, 'puff'],
      [0.86, 'puff'],
      [1.0, 'puff'],
      [1.42, 'whoosh'],
      [1.76, 'catch'],
      [1.96, 'cock'],
    ],
  },
  // Rolled onto the trigger finger, flicked up off the end of it end over end, twice round, and
  // caught back on it.
  toss: {
    seconds: 1.9,
    tracks: {
      x: [
        [0, 0],
        [0.16, -0.05, 'inOut'],
        [1.5, -0.05],
        [1.9, 0, 'inOut'],
      ],
      y: [
        [0, 0],
        [0.16, -0.05, 'inOut'],
        [0.26, 0.04, 'snap'],
        [0.5, 0, 'inOut'],
        [1.2, 0],
        [1.28, -0.06, 'out'],
        [1.6, 0, 'inOut'],
      ],
      pitch: [
        [0, 0],
        [0.16, -0.22, 'inOut'],
        [0.26, 0.38, 'snap'],
        [0.5, 0.1, 'inOut'],
        [1.2, 0.1],
        [1.3, -0.16, 'out'],
        [1.62, 0, 'inOut'],
      ],
      lift: [
        [0.24, 0],
        [0.72, 0.34, 'out'],
        [1.2, 0, 'in'],
      ],
      // Spinning only once it's off the finger, and done before it slides back on.
      spin: [
        [0.3, 0],
        [1.14, -TAU * 2, 'inOut'],
      ],
      finger: [
        [0.02, 0],
        [0.1, 1, 'linear'],
        [1.3, 1],
        [1.36, 0, 'linear'],
      ],
    },
    cues: [
      [0.22, 'whoosh'],
      [0.56, 'whoosh'],
      [0.88, 'whoosh'],
      [1.2, 'catch'],
      [1.46, 'cock'],
    ],
  },
};

function ease(kind: Ease, p: number): number {
  switch (kind) {
    case 'linear':
      return p;
    case 'in':
      return p * p;
    case 'out':
      return 1 - (1 - p) * (1 - p);
    case 'inOut':
      return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
    case 'back': {
      const u = p - 1;
      return 1 + 2.70158 * u * u * u + 1.70158 * u * u;
    }
    case 'snap':
      return 1 - (1 - p) ** 5;
  }
}

function sampleTrack(keys: readonly Key[], t: number): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [tb, vb, e = 'inOut'] = keys[i];
    if (t < tb) {
      const [ta, va] = keys[i - 1];
      return va + (vb - va) * ease(e, (t - ta) / (tb - ta));
    }
  }
  return keys[keys.length - 1][1];
}

/** The pose `t` seconds into a move, into `out` (a fresh one if not given). */
export function sampleMove(move: GunMove, t: number, out: GunPose = rest(1)): GunPose {
  for (const c of GUN_CHANNELS) {
    const keys = move.tracks[c];
    out[c] = keys ? sampleTrack(keys, t) : READY[c];
  }
  return out;
}

/** How long a new move takes to take over from wherever the gun was. */
const BLEND = 0.12;
/** A shot snaps back to the ready from a trick quicker than that. */
const FIRE_BLEND = 0.07;
/** How long one shell of recoil lasts. */
const KICK_TIME = 0.22;
/** Back to the ready: nothing but the blend. */
const RECOVER: GunMove = { seconds: FIRE_BLEND, tracks: {}, cues: [] };

const wrap = (a: number, period: number) => a - period * Math.round(a / period);

/**
 * Your gun's moves, one at a time. Anything new (a trick, holstering, drawing it again halfway into
 * the holster) takes over at once from wherever the gun is, blending in over a few frames: mash 7
 * or a trick key and every press answers. update() moves it on and says which cues just passed;
 * `pose` is null once it's away in the holster.
 */
export class GunMotion {
  private wanted = false;
  private move: { id: GunMoveId | 'recover'; spec: GunMove; t: number; from: GunPose | null; blend: number; cue: number } | null = null;
  private current: GunPose | null = null;
  private kickT = -1;

  /** The gun and the hand holding it now, or null with it in its holster. Read it fresh each frame. */
  get pose(): Readonly<GunPose> | null {
    return this.current;
  }

  /** Drawn, or on its way out: not holstered, and not on its way back in. */
  get drawn(): boolean {
    return this.wanted;
  }

  /** The move playing now (null at the ready, or away). */
  get doing(): GunMoveId | null {
    const id = this.move?.id;
    return id && id !== 'recover' ? id : null;
  }

  /** Out of the holster, or back up out of it if it's on its way in. */
  draw() {
    if (this.wanted) return;
    this.wanted = true;
    this.start('draw', GUN_MOVES.draw);
  }

  /** Back into the holster, with a spin. */
  holster() {
    if (!this.wanted) return;
    if (!this.current) return this.stow();
    this.wanted = false;
    this.start('holster', GUN_MOVES.holster);
  }

  /** Straight into the holster with no move: your hands are needed for something else. */
  stow() {
    this.wanted = false;
    this.move = null;
    this.current = null;
    this.kickT = -1;
  }

  /** Plays a trick from the top, even over itself. False with the gun away. */
  trick(id: GunTrickId): boolean {
    if (!this.wanted) return false;
    this.start(id, GUN_MOVES[id]);
    return true;
  }

  /** A shot: a trick (or the draw) gives way to the ready at once, and the recoil kicks it up. */
  fire() {
    if (!this.wanted) return;
    this.kickT = 0;
    if (this.move && this.move.id !== 'recover') this.start('recover', RECOVER, FIRE_BLEND);
  }

  update(dt: number): GunCue[] {
    const cues: GunCue[] = [];
    const m = this.move;
    if (m) {
      m.t += dt;
      while (m.cue < m.spec.cues.length && m.spec.cues[m.cue][0] <= m.t) cues.push(m.spec.cues[m.cue++][1]);
      if (m.t >= m.spec.seconds) this.move = null;
    }
    if (!this.wanted && !this.move) {
      this.current = null;
      this.kickT = -1;
      return cues;
    }
    const pose = (this.current ??= rest(1));
    const live = this.move;
    if (live) sampleMove(live.spec, live.t, pose);
    else Object.assign(pose, READY);
    if (live?.from && live.t < live.blend) {
      const p = live.t / live.blend;
      const w = p * p * (3 - 2 * p);
      for (const c of GUN_CHANNELS) pose[c] = live.from[c] + (pose[c] - live.from[c]) * w;
    }
    pose.kick = 0;
    if (this.kickT >= 0) {
      pose.kick = Math.max(0, 1 - this.kickT / KICK_TIME);
      this.kickT += dt;
      if (this.kickT >= KICK_TIME) this.kickT = -1;
    }
    return cues;
  }

  private start(id: GunMoveId | 'recover', spec: GunMove, blend = BLEND) {
    let from: GunPose | null = null;
    if (this.current) {
      from = { ...this.current, kick: 0 };
      // Angles the short way round to where the new move starts: half a spin, not two and a half.
      const first = sampleMove(spec, 0);
      for (const [c, period] of Object.entries(PERIOD) as [GunChannel, number][]) from[c] = first[c] + wrap(from[c] - first[c], period);
    }
    this.move = { id, spec, t: 0, from, blend, cue: 0 };
  }
}
