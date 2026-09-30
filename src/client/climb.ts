import * as THREE from 'three';
import { LADDER, POLE, STOREY, WALL_HEIGHT, type PoleSpot } from '../shared/layout';
import type { PlayerController } from './player';

// Getting between the floors without the elevator: up and down the ladder by the west wall, and down
// a fire pole. Either one takes hold of you (PlayerController.rig) until you're off it again.

/** Up the floor above (+1) or down to the one below (-1). */
export type Way = 1 | -1;
/** What you're holding on to. */
export type Grip = 'ladder' | 'pole';

/** How fast you go up and down the ladder, in meters a second. */
const CLIMB = 1.9;
/** Up this far on the ladder your head's through the hatch: on up to the floor above. */
const LADDER_TOP = WALL_HEIGHT - 1.15;
/** Down this far you're through the floor (your eyes just under it): on down to the floor below. */
const LADDER_BOTTOM = -1.5;
/** Where you stand once you're off the ladder: on the floor in front of its hatch. */
const OFF_X = LADDER.hatch.maxX + 0.4;
/** Stepping off takes this long, in seconds. */
const STEP_OFF = 0.45;
/** Down a pole's hole this far, your eyes go under the floor: on to the floor below. */
const POLE_BOTTOM = -1.5;
/** Sliding down: gravity, less what your hands take off it. */
const SLIDE_G = 12;
const SLIDE_MAX = 6.5;
/** How fast you come out of the ceiling onto the floor below: the dark in between takes some of it off. */
const SLIDE_IN = 3.5;
/** A twirl round a pole that doesn't go anywhere (on the bottom floor). */
const TWIRL = 1.15;
/** Swinging off a pole onto a floor it goes on down through: how long, and how far out from it you end up (past the railing). */
const SWING_OFF = 0.55;
const OFF_POLE = POLE.rail + 0.4;
/**
 * Held with real hands: the most one pull (or one tick's queued pulls) moves you up or down the ladder,
 * and the most one turn (or one tick's queued turns) takes you round a pole. Anything past that is a
 * tracking glitch, not a hand, and is clipped rather than flinging you through the building.
 */
const MAX_PULL = 0.35;
const MAX_PENDING_PULL = 0.6;
const MAX_TURN = Math.PI / 3;
const MAX_PENDING_TURN = Math.PI / 2;
/** Moves smaller than this, in meters or radians, are a still hand's tremor. */
const STILL = 1e-4;

/** Where you arrive on the other floor: the same spot in the office, on the other side of the ceiling. */
export interface Arrival {
  x: number;
  y: number;
  z: number;
  rotY: number;
}

export interface ClimbHooks {
  /** The name of the floor that way, if there's one. */
  floorThere(way: Way): string | undefined;
  /** Go there, arriving at `at`; `arrived` or `abort` follows. */
  travel(way: Way, how: Grip, at: Arrival): void;
  /** Something to hear: a rung under your hands, the rush of a slide, a landing (how fast), the top of the ladder. */
  sound(kind: 'grab' | 'rung' | 'slide' | 'land' | 'bonk' | 'twirl', speed?: number): void;
  /** You're off the ladder or the pole, back on your feet. */
  done(how: Grip, landed: boolean): void;
}

type State =
  | {
      kind: 'ladder';
      /** Carrying on by itself the rest of the way, after a floor change: up (1) or down (-1) to the floor. */
      auto: 0 | Way;
      /** Waiting on the floor you're going to (the lights are down). */
      waiting: boolean;
      /** The rung your hands were on last, for its clank. */
      rung: number;
      /** Stepping off: seconds in, from where, and which way you end up facing. */
      off: { t: number; x: number; y: number; yaw: number; toYaw: number; facing: number } | null;
      bonked: boolean;
      /** Held with real hands: moved only by pullLadder, never by keys or the stick. */
      physical: boolean;
      /** Tracking dropped out for a moment: hold still where you are. */
      paused: boolean;
      /** Signed meters pulled since the last tick, applied once on the next one. */
      pending: number;
    }
  | {
      kind: 'pole';
      spot: PoleSpot;
      stage: 'hop' | 'slide' | 'wait' | 'twirl' | 'off';
      /** Where you are round the pole (0 = +z of it) and how fast you're going down. */
      angle: number;
      v: number;
      t: number;
      from: { x: number; y: number; z: number };
      /** Come down through the ceiling onto the floor below: the next stop is the mat, or off the pole beside its hole. */
      through: boolean;
      /**
       * Swinging off: round the pole from a0 to a1, out from r0 to r1, at height y, and whether it's a
       * landing (off a slide, onto a floor) or just letting go of a twirl.
       */
      off: { a0: number; a1: number; r0: number; r1: number; y: number; land: boolean } | null;
      /** Held with real hands: no canned spin, no camera moves, and round the pole only by turnPole. */
      physical: boolean;
      paused: boolean;
      /** Let go of a physical slide: you fall the rest of the way and step off, still on the rig. */
      released: boolean;
      /** Signed radians turned round the pole since the last tick, applied once on the next one. */
      turn: number;
    };

type LadderState = Extract<State, { kind: 'ladder' }>;
type PoleState = Extract<State, { kind: 'pole' }>;

function finite(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function ease(x: number): number {
  return x * x * (3 - 2 * x);
}

export class Climber {
  private state: State | null = null;
  /** How fast you're sliding, 0–1, for the speed lines and the wider view. */
  rush = 0;

  constructor(
    private player: PlayerController,
    private hooks: ClimbHooks,
  ) {}

  get active(): boolean {
    return !!this.state;
  }

  get grip(): Grip | null {
    return this.state?.kind ?? null;
  }

  /** Held with real hands (grabLadder/slide/twirl with `physical`), rather than keys, the stick or a canned move. */
  get physical(): boolean {
    return !!this.state?.physical;
  }

  /** On the ladder, and where: how far up it you are, which way you can go, and whether you're between floors. */
  get ladder(): { y: number; waiting: boolean; auto: boolean } | null {
    const s = this.state;
    return s?.kind === 'ladder' ? { y: this.player.pos.y, waiting: s.waiting, auto: s.auto !== 0 || !!s.off } : null;
  }

  /** Sliding (or twirling) down a pole. */
  get sliding(): 'slide' | 'twirl' | null {
    const s = this.state;
    return s?.kind === 'pole' ? (s.stage === 'twirl' ? 'twirl' : 'slide') : null;
  }

  /**
   * Takes hold of the ladder, from the floor in front of it or wherever you are up it. With `physical`
   * only pullLadder moves you, and your head is left where it's looking.
   */
  grabLadder(physical = false) {
    if (this.state) return;
    const p = this.player;
    p.pos.y = THREE.MathUtils.clamp(p.pos.y, 0, LADDER_TOP);
    this.state = { kind: 'ladder', auto: 0, waiting: false, rung: Math.round(p.pos.y / 0.3), off: null, bonked: false, physical, paused: false, pending: 0 };
    p.facing = -Math.PI / 2;
    if (p.view === 'first' && !physical) {
      // Face the rungs, looking up them.
      p.camYaw = Math.PI / 2;
      p.lookPitch = 0.45;
    }
    p.moving = false;
    p.rig = (dt) => this.ladderStep(dt);
    this.hooks.sound('grab');
  }

  /**
   * Grabs the pole and slides down it, through its hole to the floor below. With `physical` you slide
   * while you hold on, round the pole only as far as turnPole takes you, and on down through each
   * floor until letGoPhysical, when you swing off at the next one.
   */
  slide(spot: PoleSpot, physical = false) {
    if (this.state) return;
    const p = this.player;
    const angle = Math.atan2(p.pos.x - spot.x, p.pos.z - spot.z);
    this.state = this.poleState(spot, 'hop', angle, physical);
    p.moving = false;
    p.rig = (dt) => this.poleStep(dt);
    this.hooks.sound('grab');
  }

  /**
   * Swings once round a pole that goes nowhere from here (the bottom floor's). With `physical` you go
   * round it only as far as turnPole takes you, until letGoPhysical steps you off it.
   */
  twirl(spot: PoleSpot, physical = false) {
    if (this.state) return;
    const p = this.player;
    const angle = Math.atan2(p.pos.x - spot.x, p.pos.z - spot.z);
    this.state = this.poleState(spot, 'twirl', angle, physical);
    if (physical) p.moving = false;
    p.rig = (dt) => this.poleStep(dt);
    this.hooks.sound(physical ? 'grab' : 'twirl');
  }

  /**
   * Hands on a physical ladder moved you this far: positive up, negative down, in meters. It's
   * applied once, on the next tick; several pulls before then add up. Ignored (false) unless you're
   * climbing a physical ladder by hand: not paused, not between floors, not carried on or stepping off.
   */
  pullLadder(signedMeters: number): boolean {
    const s = this.state;
    if (s?.kind !== 'ladder' || !s.physical || s.paused || s.waiting || s.auto || s.off) return false;
    const d = THREE.MathUtils.clamp(finite(signedMeters), -MAX_PULL, MAX_PULL);
    if (Math.abs(d) < STILL) return false;
    s.pending = THREE.MathUtils.clamp(s.pending + d, -MAX_PENDING_PULL, MAX_PENDING_PULL);
    return true;
  }

  /**
   * Hands on a physical pole took you this far round it, in radians: positive raises your angle round
   * it (atan2(dx, dz) from the pole, like PoleSpot.open). Applied once, on the next tick; several
   * turns before then add up. Ignored (false) unless you're holding a physical pole, not paused, and
   * not in the dark between floors or swinging off.
   */
  turnPole(signedRadians: number): boolean {
    const s = this.state;
    if (s?.kind !== 'pole' || !s.physical || s.paused || s.released) return false;
    if (s.stage !== 'hop' && s.stage !== 'slide' && s.stage !== 'twirl') return false;
    const d = THREE.MathUtils.clamp(finite(signedRadians), -MAX_TURN, MAX_TURN);
    if (Math.abs(d) < STILL) return false;
    s.turn = THREE.MathUtils.clamp(s.turn + d, -MAX_PENDING_TURN, MAX_PENDING_TURN);
    return true;
  }

  /**
   * Tracking dropped out for a moment (true) or came back (false). While paused, a physical ladder or
   * pole holds you still where you are and never sets off for another floor; what was queued is
   * dropped. Carrying on after a floor change, and stepping or swinging off, still finish.
   */
  pausePhysical(paused: boolean) {
    const s = this.state;
    if (!s?.physical) return;
    s.paused = paused === true;
    if (!s.paused) return;
    if (s.kind === 'ladder') s.pending = 0;
    else s.turn = 0;
  }

  /**
   * Hands off a physical ladder or pole. The ladder: off at the floor, drop from up it, back up
   * through the hatch and off if you're under the floor, and anything already under way (between
   * floors, carrying on, stepping off) finishes by itself. The pole: a twirl steps off it; a slide
   * carries on down to the next floor and swings you off there (or lands you on the mat).
   */
  letGoPhysical() {
    const s = this.state;
    if (!s?.physical) return;
    s.paused = false;
    if (s.kind === 'ladder') {
      s.pending = 0;
      if (s.waiting || s.auto || s.off) return;
      const p = this.player;
      if (p.pos.y < -0.05) {
        // Down the hatch: nothing to land on but the next floor, so back up onto this one.
        s.auto = 1;
        return;
      }
      if (p.pos.y < 0.4) {
        this.stepOff(s);
        return;
      }
      p.pos.x = LADDER.x + 0.3;
      this.release('ladder', false);
      return;
    }
    s.turn = 0;
    if (s.stage === 'twirl') {
      const p = this.player;
      const r = Math.hypot(p.pos.x - s.spot.x, p.pos.z - s.spot.z);
      const r0 = Math.hypot(s.from.x - s.spot.x, s.from.z - s.spot.z);
      s.off = { a0: s.angle, a1: s.angle, r0: r, r1: Math.max(r0, POLE.grip + 0.3), y: s.from.y, land: false };
      s.stage = 'off';
      s.t = 0;
      return;
    }
    if (s.stage !== 'off') s.released = true;
  }

  /** E on the ladder: off it at the floor, or let go and drop from wherever you are. */
  letGo() {
    const s = this.state;
    if (s?.kind !== 'ladder' || s.waiting || s.auto || s.off) return;
    const p = this.player;
    if (p.pos.y < -0.05) return; // down the hatch: nothing to land on but the next floor
    if (p.pos.y < 0.4) {
      this.stepOff(s);
      return;
    }
    // Drop off it: a little way out from the wall, and down you go.
    p.pos.x = LADDER.x + 0.3;
    this.release('ladder', false);
  }

  /** Now on the floor you were going to: carry on the rest of the way. */
  arrived() {
    const s = this.state;
    if (!s) return;
    const p = this.player;
    if (s.kind === 'ladder' && s.waiting) {
      // Your head was up in the hatch (or your feet down the one below): now that's this floor's.
      const way: Way = p.pos.y > 1 ? 1 : -1;
      p.pos.y += way > 0 ? -STOREY : STOREY;
      s.waiting = false;
      s.auto = way;
      s.rung = Math.round(p.pos.y / 0.3);
      s.pending = 0;
    } else if (s.kind === 'pole' && s.stage === 'wait') {
      p.pos.y += STOREY;
      s.stage = 'slide';
      s.through = true;
      s.v = Math.min(s.v, SLIDE_IN);
      s.turn = 0;
    }
  }

  /** The other floor never came: back onto this one's floor, off whatever you were on. */
  abort() {
    const s = this.state;
    if (!s) return;
    const p = this.player;
    if (s.kind === 'ladder') p.pos.set(OFF_X, 0, LADDER.z);
    else p.pos.set(s.from.x, 0, s.from.z);
    this.release(s.kind, false);
  }

  private poleState(spot: PoleSpot, stage: 'hop' | 'twirl', angle: number, physical: boolean): State {
    const p = this.player;
    return {
      kind: 'pole',
      spot,
      stage,
      angle,
      v: 0,
      t: 0,
      from: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
      through: false,
      off: null,
      physical,
      paused: false,
      released: false,
      turn: 0,
    };
  }

  private release(how: Grip, landed: boolean) {
    this.state = null;
    this.rush = 0;
    const p = this.player;
    p.rig = null;
    p.moving = false;
    p.vy = 0;
    this.hooks.done(how, landed);
  }

  private stepOff(s: LadderState) {
    const p = this.player;
    // Back off the ladder and turn round to the room.
    const toYaw = -Math.PI / 2;
    let yaw = p.camYaw;
    yaw = toYaw + Math.atan2(Math.sin(yaw - toYaw), Math.cos(yaw - toYaw));
    s.off = { t: 0, x: p.pos.x, y: p.pos.y, yaw, toYaw, facing: Math.PI / 2 };
    s.auto = 0;
    s.pending = 0;
  }

  private ladderStep(dt: number) {
    const s = this.state;
    if (s?.kind !== 'ladder') return;
    const p = this.player;
    if (s.off) {
      s.off.t += dt;
      const k = Math.min(1, s.off.t / STEP_OFF);
      const e = k * k * (3 - 2 * k);
      p.pos.x = THREE.MathUtils.lerp(s.off.x, OFF_X, e);
      p.pos.y = THREE.MathUtils.lerp(s.off.y, 0, e) + (s.physical ? 0 : Math.sin(Math.PI * k) * 0.12);
      p.pos.z += (LADDER.z - p.pos.z) * Math.min(1, dt * 12);
      p.facing = THREE.MathUtils.lerp(-Math.PI / 2, s.off.facing, e);
      if (p.view === 'first' && !s.physical) {
        p.camYaw = THREE.MathUtils.lerp(s.off.yaw, s.off.toYaw, e);
        p.lookPitch += (-0.08 - p.lookPitch) * Math.min(1, dt * 8);
      }
      p.moving = k < 1;
      if (k >= 1) {
        p.pos.y = 0;
        this.release('ladder', true);
      }
      return;
    }
    // Onto the rungs, facing the wall.
    p.pos.x += (LADDER.x - p.pos.x) * Math.min(1, dt * 12);
    p.pos.z += (LADDER.z - p.pos.z) * Math.min(1, dt * 12);
    p.facing = -Math.PI / 2;
    if (!s.physical && !s.auto && !s.waiting && p.pos.y >= 0 && p.holding('Space')) {
      // Jump off, back from the wall.
      p.pos.x = LADDER.x + 0.3;
      this.release('ladder', false);
      p.vy = 3.5;
      return;
    }
    let dir = 0;
    let dy = 0;
    if (s.waiting) dir = 0;
    else if (s.auto) dir = s.auto;
    else if (s.physical) {
      // What your hands pulled since the last tick, once: a still (or lost) hand holds you where you are.
      dy = s.paused ? 0 : s.pending;
      s.pending = 0;
      dir = Math.sign(dy);
    } else dir = (p.holding('KeyW', 'ArrowUp') ? 1 : 0) - (p.holding('KeyS', 'ArrowDown') ? 1 : 0);
    if (!dy) dy = dir * CLIMB * dt;
    const up = this.hooks.floorThere(1);
    const down = this.hooks.floorThere(-1);
    let y = p.pos.y + dy;
    // At the floor: off, unless you're on your way down through it.
    if (dir < 0 && y <= 0 && p.pos.y >= 0 && (s.auto === -1 || !down)) {
      p.pos.y = 0;
      this.stepOff(s);
      return;
    }
    // Climbing up out of the hatch onto a new floor: step off onto it.
    if (dir > 0 && s.auto === 1 && y >= 0) {
      p.pos.y = 0;
      this.stepOff(s);
      return;
    }
    if (dir > 0 && y > LADDER_TOP) {
      y = LADDER_TOP;
      if (!up) {
        if (!s.bonked) this.hooks.sound('bonk');
        s.bonked = true;
      } else this.go(s, 1, y);
    } else if (dir < 0) s.bonked = false;
    if (dir < 0 && y < LADDER_BOTTOM) {
      y = LADDER_BOTTOM;
      this.go(s, -1, y);
    }
    p.pos.y = y;
    p.moving = dir !== 0 && !s.waiting;
    if (s.physical && !s.auto) p.walkPhase += (Math.abs(dy) / CLIMB) * 7;
    else p.walkPhase += Math.abs(dir) * dt * 7;
    const rung = Math.round(y / 0.3);
    if (rung !== s.rung) {
      s.rung = rung;
      this.hooks.sound('rung');
    }
  }

  private go(s: LadderState, way: Way, y: number) {
    if (s.waiting) return;
    s.waiting = true;
    s.pending = 0;
    const p = this.player;
    this.hooks.travel(way, 'ladder', { x: p.pos.x, y: y + (way > 0 ? -STOREY : STOREY), z: p.pos.z, rotY: p.facing });
  }

  private place(s: PoleState, r: number) {
    const p = this.player;
    p.pos.x = s.spot.x + Math.sin(s.angle) * r;
    p.pos.z = s.spot.z + Math.cos(s.angle) * r;
  }

  /** A physical pole's queued turn, taken once. */
  private takeTurn(s: PoleState) {
    s.angle = wrap(s.angle + s.turn);
    s.turn = 0;
  }

  private poleStep(dt: number) {
    const s = this.state;
    if (s?.kind !== 'pole') return;
    const p = this.player;
    const { spot } = s;
    // Held by hands that tracking has lost for a moment: stay put, and don't set off anywhere. Once the
    // floor below has come (through), the slide onto it carries on by itself.
    const frozen = s.physical && s.paused && !s.released && (s.stage === 'hop' || s.stage === 'twirl' || (s.stage === 'slide' && !s.through));
    if (frozen) {
      p.moving = false;
      return;
    }
    s.t += dt;
    if (s.stage === 'twirl' && s.physical) {
      // Round the pole only as your hands take you, in close to it at the height you grabbed it.
      this.takeTurn(s);
      const r = Math.hypot(p.pos.x - spot.x, p.pos.z - spot.z);
      const want = POLE.grip + 0.1;
      this.place(s, Math.max(POLE.grip, r + (want - r) * Math.min(1, dt * 10)));
      p.pos.y = s.from.y;
      this.face(s, dt, 0);
      p.moving = false;
      return;
    }
    if (s.stage === 'twirl') {
      const k = Math.min(1, s.t / TWIRL);
      s.angle += dt * ((Math.PI * 2) / TWIRL) * Math.sin(Math.PI * k) * 1.57;
      const r = THREE.MathUtils.lerp(Math.hypot(s.from.x - spot.x, s.from.z - spot.z), POLE.grip + 0.1, Math.sin(Math.PI * k));
      this.place(s, Math.max(r, POLE.grip));
      p.pos.y = s.from.y + Math.sin(Math.PI * k) * 0.5;
      this.face(s, dt, 0.1);
      p.moving = false;
      if (k >= 1) {
        p.pos.y = s.from.y;
        this.release('pole', false);
      }
      return;
    }
    if (s.stage === 'hop') {
      // A hop onto the pole: in to it, and up a little (held by hand: in to it, no hop).
      if (s.physical) this.takeTurn(s);
      const k = Math.min(1, s.t / 0.28);
      const r0 = Math.hypot(s.from.x - spot.x, s.from.z - spot.z);
      this.place(s, THREE.MathUtils.lerp(r0, POLE.grip, k));
      p.pos.y = s.from.y + (s.physical ? 0 : Math.sin(Math.PI * k * 0.5) * 0.35);
      this.face(s, dt, 0);
      if (k >= 1) {
        s.stage = 'slide';
        this.hooks.sound('slide');
      }
      return;
    }
    if (s.stage === 'wait') {
      // In the dark under the floor, holding on, while the floor below comes.
      s.turn = 0;
      this.face(s, dt, -0.4);
      return;
    }
    if (s.stage === 'off') {
      const o = s.off;
      if (!o) return;
      // Round to the railing's gap, then out through it onto the floor with a little hop.
      const k = Math.min(1, s.t / SWING_OFF);
      const turn = ease(Math.min(1, k / 0.6));
      const out = ease(Math.max(0, (k - 0.4) / 0.6));
      s.angle = o.a0 + Math.atan2(Math.sin(o.a1 - o.a0), Math.cos(o.a1 - o.a0)) * turn;
      this.place(s, THREE.MathUtils.lerp(o.r0, o.r1, out));
      p.pos.y = o.y + (s.physical ? 0 : Math.sin(Math.PI * k) * 0.25);
      // From facing round the pole to facing out, away from it.
      const along = s.angle + Math.PI / 2;
      p.facing = along + Math.atan2(Math.sin(o.a1 - along), Math.cos(o.a1 - along)) * out;
      if (p.view === 'first' && !s.physical) {
        const yaw = p.facing - Math.PI;
        p.camYaw += Math.atan2(Math.sin(yaw - p.camYaw), Math.cos(yaw - p.camYaw)) * Math.min(1, dt * 10);
        p.lookPitch += (-0.08 - p.lookPitch) * Math.min(1, dt * 8);
      }
      p.moving = out > 0 && k < 1;
      this.rush = Math.max(0, this.rush - dt * 4);
      if (k >= 1) {
        p.pos.y = o.y;
        if (o.land) this.hooks.sound('land', s.v);
        this.release('pole', o.land);
      }
      return;
    }
    // Down you go, faster and faster, spinning round the pole; squeeze to slow down near the bottom.
    // Held by hand, you go round only as your hands take you, and on down through a floor with another below.
    const held = s.physical && !s.released;
    const braking = s.through && p.pos.y < 1 && (!held || !this.hooks.floorThere(-1));
    if (braking) s.v = Math.max(2, s.v - 26 * dt);
    else s.v = Math.min(SLIDE_MAX, s.v + SLIDE_G * dt);
    if (s.physical) {
      if (held) this.takeTurn(s);
      else s.turn = 0;
    } else s.angle += dt * (1.6 + s.v * 0.55);
    this.place(s, POLE.grip);
    p.pos.y -= s.v * dt;
    this.rush = Math.min(1, s.v / SLIDE_MAX);
    this.face(s, dt, braking ? -0.12 : -0.4);
    p.moving = false;
    p.walkPhase += dt * 4;
    if (p.pos.y <= POLE_BOTTOM && !s.through) {
      p.pos.y = POLE_BOTTOM;
      s.stage = 'wait';
      s.turn = 0;
      this.hooks.travel(-1, 'pole', { x: p.pos.x, y: POLE_BOTTOM + STOREY, z: p.pos.z, rotY: p.facing });
      return;
    }
    if (p.pos.y <= 0 && s.through) {
      if (held && this.hooks.floorThere(-1)) {
        if (s.paused) {
          // Hands lost for a moment: hang on at this floor rather than set off for the next one.
          p.pos.y = 0;
          s.v = 0;
          this.rush = 0;
          return;
        }
        // Still holding on: on down through this floor's hole to the next one.
        s.through = false;
        return;
      }
      p.pos.y = 0;
      if (this.hooks.floorThere(-1)) {
        // No mat here: the pole goes on down through a hole in this floor. Off it, beside the hole.
        s.stage = 'off';
        s.t = 0;
        s.off = { a0: s.angle, a1: spot.open, r0: POLE.grip, r1: OFF_POLE, y: 0, land: true };
        return;
      }
      const speed = s.v;
      // Knees bend as you land.
      p.stepOffset = -0.35;
      this.hooks.sound('land', speed);
      this.release('pole', true);
    }
  }

  /**
   * Swinging round the pole: you face the way you're going, the pole on your left. In first person
   * you look a little toward it (so it's in view, hands on it) and down a little. Held by hand, only
   * the body turns: your head looks wherever it does.
   */
  private face(s: PoleState, dt: number, pitch: number) {
    const p = this.player;
    const facing = s.angle + Math.PI / 2;
    p.facing = facing;
    if (p.view !== 'first' || s.physical) return;
    const yaw = facing + 1.25 - Math.PI;
    const d = Math.atan2(Math.sin(yaw - p.camYaw), Math.cos(yaw - p.camYaw));
    p.camYaw += d * Math.min(1, dt * 10);
    p.lookPitch += (pitch - p.lookPitch) * Math.min(1, dt * 6);
  }
}

/**
 * Whether someone at `p` is holding on to the ladder or a pole (someone else, going by where they
 * are): up off the floor, right where your hands would be.
 */
export function gripOf(p: { x: number; y: number; z: number }, poles: readonly PoleSpot[], ground: number): Grip | null {
  if (Math.abs(p.y - ground) < 0.05) return null;
  if (Math.abs(p.x - LADDER.x) < 0.12 && Math.abs(p.z - LADDER.z) < 0.15) return 'ladder';
  for (const s of poles) if (Math.abs(Math.hypot(p.x - s.x, p.z - s.z) - POLE.grip) < 0.12) return 'pole';
  return null;
}
