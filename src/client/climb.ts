import * as THREE from 'three';
import { LADDER, STOREY, WALL_HEIGHT } from '../shared/layout';
import type { PlayerController } from './player';

// Getting between floors on the ladder by the west wall.

/** Up the floor above (+1) or down to the one below (-1). */
export type Way = 1 | -1;
/** What you're holding on to. */
export type Grip = 'ladder';

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
  /** Something to hear: a rung under your hands, the top of the ladder. */
  sound(kind: 'grab' | 'rung' | 'bonk'): void;
  /** You're off the ladder, back on your feet. */
  done(how: Grip, landed: boolean): void;
}

type State = {
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
};

export class Climber {
  private state: State | null = null;
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

  /** On the ladder, and where: how far up it you are, which way you can go, and whether you're between floors. */
  get ladder(): { y: number; waiting: boolean; auto: boolean } | null {
    const s = this.state;
    return s?.kind === 'ladder' ? { y: this.player.pos.y, waiting: s.waiting, auto: s.auto !== 0 || !!s.off } : null;
  }

  /** Takes hold of the ladder, from the floor in front of it or wherever you are up it. */
  grabLadder() {
    if (this.state) return;
    const p = this.player;
    p.pos.y = THREE.MathUtils.clamp(p.pos.y, 0, LADDER_TOP);
    this.state = { kind: 'ladder', auto: 0, waiting: false, rung: Math.round(p.pos.y / 0.3), off: null, bonked: false };
    p.facing = -Math.PI / 2;
    // Face the rungs, looking up them.
    p.camYaw = Math.PI / 2;
    p.lookPitch = 0.45;
    p.moving = false;
    p.rig = (dt) => this.ladderStep(dt);
    this.hooks.sound('grab');
  }

  /** E on the ladder: off it at the floor, or let go and drop from wherever you are. Says why not when it can't. */
  letGo(): string | null {
    const s = this.state;
    if (!s) return 'not on the ladder';
    if (s.off) return null;
    if (s.waiting || s.auto) return 'climbing through the hatch to another floor';
    const p = this.player;
    if (p.pos.y < -0.05) return 'down the hatch, with nothing to land on but the next floor';
    if (p.pos.y < 0.4) {
      this.stepOff(s);
      return null;
    }
    // Drop off it: a little way out from the wall, and down you go.
    p.pos.x = LADDER.x + 0.3;
    this.release('ladder', false);
    return null;
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
    }
  }

  /** The other floor never came: back onto this one's floor, off whatever you were on. */
  abort() {
    const s = this.state;
    if (!s) return;
    const p = this.player;
    p.pos.set(OFF_X, 0, LADDER.z);
    this.release(s.kind, false);
  }

  private release(how: Grip, landed: boolean) {
    this.state = null;
    const p = this.player;
    p.rig = null;
    p.moving = false;
    p.vy = 0;
    this.hooks.done(how, landed);
  }

  private stepOff(s: Extract<State, { kind: 'ladder' }>) {
    const p = this.player;
    // Back off the ladder and turn round to the room.
    const toYaw = -Math.PI / 2;
    let yaw = p.camYaw;
    yaw = toYaw + Math.atan2(Math.sin(yaw - toYaw), Math.cos(yaw - toYaw));
    s.off = { t: 0, x: p.pos.x, y: p.pos.y, yaw, toYaw, facing: Math.PI / 2 };
    s.auto = 0;
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
      p.pos.y = THREE.MathUtils.lerp(s.off.y, 0, e) + Math.sin(Math.PI * k) * 0.12;
      p.pos.z += (LADDER.z - p.pos.z) * Math.min(1, dt * 12);
      p.facing = THREE.MathUtils.lerp(-Math.PI / 2, s.off.facing, e);
      p.camYaw = THREE.MathUtils.lerp(s.off.yaw, s.off.toYaw, e);
      p.lookPitch += (-0.08 - p.lookPitch) * Math.min(1, dt * 8);
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
    if (!s.auto && !s.waiting && p.pos.y >= 0 && p.holding('Space')) {
      // Jump off, back from the wall.
      p.pos.x = LADDER.x + 0.3;
      this.release('ladder', false);
      p.vy = 3.5;
      return;
    }
    let dir = 0;
    if (s.waiting) dir = 0;
    else if (s.auto) dir = s.auto;
    else dir = (p.holding('KeyW') ? 1 : 0) - (p.holding('KeyS') ? 1 : 0);
    const up = this.hooks.floorThere(1);
    const down = this.hooks.floorThere(-1);
    let y = p.pos.y + dir * CLIMB * dt;
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
    p.walkPhase += Math.abs(dir) * dt * 7;
    const rung = Math.round(y / 0.3);
    if (rung !== s.rung) {
      s.rung = rung;
      this.hooks.sound('rung');
    }
  }

  private go(s: Extract<State, { kind: 'ladder' }>, way: Way, y: number) {
    if (s.waiting) return;
    s.waiting = true;
    const p = this.player;
    this.hooks.travel(way, 'ladder', { x: p.pos.x, y: y + (way > 0 ? -STOREY : STOREY), z: p.pos.z, rotY: p.facing });
  }
}
