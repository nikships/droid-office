import * as THREE from 'three';
import { ELEVATOR, ELEVATOR_FRONT } from '../../shared/layout';
import { nearestWalkable, route, type Pt } from '../../shared/nav';
import { WORKER_REVIVE_MS } from '../../shared/protocol';
import type { MedicPose } from './character';

/**
 * Workers shot with the .44 Magnum. The server owns their revival deadlines; this class renders
 * the shared downed state and the medic pickup after dismissal.
 *
 * One shot, one scene: the worker tumbles out of its chair onto the floor with a thud, and a blood
 * pool spreads under it while its session keeps running (see shoot). Each body on the floor has
 * its own scene, so several can be down at once. Pressing E nearby (in the headset, the use
 * action with a hand at the body: see rouse) stands it back up in its seat with its session
 * untouched, or expiry calls in two paramedics with a stretcher (see confirm): they walk in from
 * the elevator, lower and open the scoop stretcher, support and settle the body, close the bed and
 * lift together, then carry it back to the elevator and fade, and the laptop shuts and shrinks as
 * on a send-home. Every client on the floor sees the same lifecycle.
 *
 * In the headset the body also tells the time left in the server's revival window, in the world
 * (hooks.left): a heartbeat that slows and fades, felt in a hand near it; its status light (the lamp
 * on its seat's nameplate in the headset app) glowing red with each beat, dimmer as it goes; and a
 * pool that creeps out to full size at the deadline. Once the window closes the heart stops and the
 * light goes dark.
 *
 * No DOM or WebGL at import time, so tests can load this in Node.
 */

/** Seconds tumbling out of the chair onto the floor. */
export const FALL_TIME = 0.75;
/** Seconds for the blood pool to spread to full size under the body. */
export const BLEED_TIME = 6;
/** How wide the blood pool gets, in meters. */
export const POOL_R = 0.9;
/** Seconds lowering, stabilizing, loading and lifting together. */
export const LOAD_TIME = 4.8;
/** How fast the medics walk the stretcher in and out, in m/s. */
export const MEDIC_PACE = 1.6;
/** Seconds fading away at the elevator with the body. */
export const FADE_TIME = 0.7;
/** Seconds for the team to appear at full size at the elevator. */
const TEAM_IN = 0.65;
/** Seconds for a shut laptop to shrink away. */
const LAPTOP_GONE = 0.3;
/** A worker's feet are this far above its origin. */
const FEET = 0.07;
/** How high the stretcher's bed is. */
const BED_Y = 0.72;
const LOW_BED = 0.16;
const HANDLE_Z = 1.04;
const MEDIC_Z = 1.3;
const LOWER_END = 0.85;
const SUPPORT_END = 1.8;
const SETTLE_END = 2.9;
const LIFT_END = 4.3;
/** How far out of its seat the shot worker lands. */
const TUMBLE = 0.65;
/** The hit itself, before the fall takes over: how far the body is shoved and leans along the bullet. */
const KNOCK = 0.12;
const KICK = 0.42;
/** Seconds the server's revival window lasts (shared/protocol.ts). */
export const REVIVE_WINDOW = WORKER_REVIVE_MS / 1000;
/** Seconds a revived body takes to get back up into its chair, when it doesn't go straight back (hooks.riseTime). */
export const RISE_TIME = 0.7;
/** Roused by a hand but not yet confirmed by the server: it stirs this far up, for at most ROUSE_WAIT seconds. */
const STIR = 0.3;
const ROUSE_WAIT = 2.5;
/** How fast a body that was stirring slumps back down: the whole way in about a third of a second. */
const SLUMP = 3;
/** A body that drops back from this far up lands with a thud. */
const SLUMP_THUD = 0.25;
/** The heartbeat of a body on the floor: its first beat after it lands, then the gap between beats as the window runs out. */
const FIRST_BEAT = 0.45;
const BEAT_FAST = 0.75;
const BEAT_SLOW = 2;
/** How fast each beat's glow and swell die away, per second. */
const BEAT_FADE = 6;
/** A body's reachable length, from its feet: a hand anywhere along it within reach is at it. */
const BODY_FROM = 0.12;
const BODY_TO = 1.0;

/** How much of the hit's shove is in the body `t` seconds after it: at once, then easing into the fall. */
export function jolt(t: number): number {
  if (!(t >= 0)) return 0;
  return t < 0.07 ? Math.sin((t / 0.07) * (Math.PI / 2)) : Math.exp(-(t - 0.07) / 0.09);
}

/** Where the medics come from: out of the elevator, on every floor. */
const MEDIC_FROM: Pt = [ELEVATOR.x, ELEVATOR_FRONT + 0.5];

/** Falling, bled out waiting for revival, medics on the way, loading, carrying out, gone. */
export type CasualtyPhase = 'fall' | 'bled' | 'fetch' | 'load' | 'carry' | 'fade';

/** What a casualty needs of a worker's model (see world/character.ts Worker). */
export interface CasualtyModel {
  readonly root: THREE.Group;
  update(dt: number, t: number): void;
  /** Light out, face slack, bubble gone. */
  die(): void;
  /** Back on its feet: light and bubble as its status says. */
  revive(): void;
  /**
   * Down, in the headset: `beat` (0 → 1) of a heartbeat's glow and swell right now, and `life`
   * (1 → 0) of its revival window left. Its light shows both; (0, 0) puts it out.
   */
  pulse?(beat: number, life: number): void;
  dispose(): void;
}

/** Seconds between a downed body's heartbeats, `bleed` (0 → 1) of the way through its revival window. */
export function beatGap(bleed: number): number {
  const b = THREE.MathUtils.clamp(bleed, 0, 1);
  // Slow at first, then dragging out toward the end.
  return BEAT_FAST + (BEAT_SLOW - BEAT_FAST) * b * b;
}

/** How strong a downed body's heartbeat is, `bleed` (0 → 1) of the way through its revival window. */
export function beatStrength(bleed: number): number {
  return 1 - 0.75 * THREE.MathUtils.clamp(bleed, 0, 1);
}

/**
 * How wide the pool under a body is (its scale), `t` seconds after it landed and `bleed` (0 → 1)
 * of the way through a revival window the headset can see: a quick first spread, then creeping out
 * to full size right at the deadline. Without the window (the desktop) it spreads in BLEED_TIME.
 */
export function poolSize(t: number, bleed: number, timed: boolean): number {
  if (!timed) return Math.max(0.05, POOL_R * easeOut(THREE.MathUtils.clamp(bleed, 0, 1)));
  return Math.max(0.05, POOL_R * (0.4 * easeOut(THREE.MathUtils.clamp(t / 2, 0, 1)) + 0.6 * THREE.MathUtils.clamp(bleed, 0, 1)));
}

/** What a casualty needs of a medic (see world/character.ts Person). */
export interface Medic {
  readonly root: THREE.Group;
  update(dt: number, t: number, moving: boolean, airborne: boolean): void;
  dispose(): void;
  /** Optional articulated contact pose, applied after ordinary character animation. */
  medicPose?(pose: MedicPose | null): void;
}

/** What a casualty needs of a laptop (see world/laptop.ts Laptop). */
export interface CasualtyLaptop {
  readonly root: THREE.Object3D;
  /** Shuts the lid; true once it's shut. */
  shut(dt: number): boolean;
  dispose(): void;
}

export interface CasualtyHooks {
  /** A paramedic in whites, by name. */
  spawnMedic(name: string): Medic;
  /** The thud as the body lands, and the siren sting as the medics come in. */
  onLand(at: THREE.Vector3): void;
  onSiren(at: THREE.Vector3): void;
  /** Each heartbeat of a body lying on the floor with its session still running, at its chest; `strength` fades as its window runs out. */
  onBeat?(at: THREE.Vector3, strength: number): void;
  /** Seconds left in worker `id`'s server-owned revival window, or null when it isn't known (yet). */
  left?(id: string): number | null;
  /** Worker `id` is back in its seat with its session untouched; `head` is where its head is. */
  onBack?(id: string, head: THREE.Vector3): void;
  /** Seconds a revived body takes to get back up into its chair; without it, it is put straight back. */
  riseTime?: number;
}

let poolGeo: THREE.CircleGeometry | null = null;
let poolMat: THREE.MeshBasicMaterial | null = null;
let poolDark: THREE.MeshBasicMaterial | null = null;

/** The blood pool: a spreading circle, darker at its heart, with a lobe off to one side. */
function bloodPool(): THREE.Group {
  poolGeo ??= new THREE.CircleGeometry(1, 28);
  poolMat ??= new THREE.MeshBasicMaterial({ color: '#a31621', transparent: true, opacity: 0.88, depthWrite: false });
  poolDark ??= new THREE.MeshBasicMaterial({ color: '#630d14', transparent: true, opacity: 0.92, depthWrite: false });
  const pool = new THREE.Group();
  const main = new THREE.Mesh(poolGeo, poolMat);
  main.rotation.x = -Math.PI / 2;
  pool.add(main);
  const heart = new THREE.Mesh(poolGeo, poolDark);
  heart.rotation.x = -Math.PI / 2;
  heart.position.y = 0.001;
  heart.scale.setScalar(0.55);
  pool.add(heart);
  const lobe = new THREE.Mesh(poolGeo, poolMat);
  lobe.rotation.x = -Math.PI / 2;
  lobe.position.set(0.55, 0.001, 0.35);
  lobe.scale.setScalar(0.55);
  pool.add(lobe);
  pool.scale.setScalar(0.05);
  return pool;
}

/** A split scoop bed with padded head support and handles the medics can actually hold. */
function stretcher(): { root: THREE.Group; halves: THREE.Group[]; geometries: THREE.BufferGeometry[] } {
  const root = new THREE.Group();
  root.name = 'medic-stretcher';
  const box = new THREE.BoxGeometry(1, 1, 1);
  const pole = new THREE.CylinderGeometry(0.025, 0.025, 2.18, 8).rotateX(Math.PI / 2);
  const steel = new THREE.MeshToonMaterial({ color: '#ced9df' });
  const canvas = new THREE.MeshToonMaterial({ color: '#ed833b' });
  const cushion = new THREE.MeshToonMaterial({ color: '#163b50' });
  const halves = [-1, 1].map((side) => {
    const half = new THREE.Group();
    half.name = side < 0 ? 'stretcher-left' : 'stretcher-right';
    const rail = new THREE.Mesh(pole, steel);
    rail.position.x = side * 0.35;
    half.add(rail);
    const bed = new THREE.Mesh(box, canvas);
    bed.scale.set(0.34, 0.055, 1.65);
    bed.position.x = side * 0.17;
    bed.castShadow = bed.receiveShadow = true;
    half.add(bed);
    const pad = new THREE.Mesh(box, cushion);
    pad.scale.set(0.32, 0.07, 0.3);
    pad.position.set(side * 0.17, 0.055, -0.38);
    pad.receiveShadow = true;
    half.add(pad);
    root.add(half);
    return half;
  });
  root.position.y = BED_Y;
  return { root, halves, geometries: [box, pole] };
}

interface Team {
  group: THREE.Group;
  medics: Medic[];
  bed: ReturnType<typeof stretcher>;
  /** Only private material copies fade; character and worker materials may be shared elsewhere. */
  materials: Map<THREE.Material, THREE.Material>;
  way: Pt[];
  next: number;
  heading: number;
  pickupHeading: number;
  speed: number;
  moving: boolean;
  stride: number;
  left: THREE.Vector3;
  right: THREE.Vector3;
  pose: { left: THREE.Vector3; right: THREE.Vector3; crouch: number; stride: number };
  pickupAt: THREE.Vector3;
  withdrawal: THREE.Vector3;
  bodyFrom: THREE.Vector3;
  bodyRotation: THREE.Quaternion;
  bodyTo: THREE.Vector3;
  bodyTargetRotation: THREE.Quaternion;
  scratch: THREE.Vector3;
  inverse: THREE.Quaternion;
}

/**
 * In the headset, a hand's use action at a body: 'roused' stirs it while the server is asked,
 * 'up' gets it back up into its chair once the server has revived it.
 */
type Rouse = 'none' | 'roused' | 'up';

interface Casualty {
  id: string;
  model: CasualtyModel;
  /** The seat anchor it fell out of (and goes back to on Revive). */
  seat: THREE.Object3D;
  scale: number;
  phase: CasualtyPhase;
  /** Seconds into the phase. */
  t: number;
  /** 0 → 1 as the pool spreads. */
  bleed: number;
  /** Where it sat, and the way it faced. */
  from: THREE.Vector3;
  yaw: number;
  /** Which way it tips over, and how far; and the turn that lays its length flat along the floor. */
  tip: number;
  lean: number;
  level: THREE.Quaternion;
  /** The top of the floor under it. */
  ground: number;
  /** Which side it sprawls out on. */
  side: number;
  /** The latest bullet's horizontal direction, and the axis it leans the body about; null without one. */
  push: THREE.Vector3 | null;
  axis: THREE.Vector3;
  /** Seconds since the bullet. */
  jt: number;
  /** Where it lands on the floor, and how it lies there; and how it sat, to get back up into. */
  floor: THREE.Vector3;
  lying: THREE.Quaternion;
  seated: THREE.Quaternion;
  /** 0 lying → 1 back in its chair: stirring while roused, all the way once revived. */
  lift: number;
  rouse: Rouse;
  /** Seconds since it was roused. */
  rouseT: number;
  /** How far up it got before it slumped back, for the thud when it lands again. */
  peak: number;
  /** Its revival window has closed (or the medics have it): no more heartbeat, and no hand can rouse it. */
  finished: boolean;
  /** Seconds to its next heartbeat, and how much of the last beat's glow and swell is left. */
  beat: number;
  pulse: number;
  pool: THREE.Group;
  laptop: CasualtyLaptop | null;
  /** 0 → 1 as the shut laptop shrinks away. */
  lgone: number;
  team: Team | null;
  /** Confirmed: the model and laptop are this class's to dispose. Before that they're the office's. */
  owned: boolean;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const easeOut = (p: number) => 1 - (1 - p) * (1 - p);
const smooth = (p: number) => {
  const u = THREE.MathUtils.clamp(p, 0, 1);
  return u * u * (3 - 2 * u);
};
const SUPINE = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const IDENTITY = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const _lean = new THREE.Quaternion();
const _fix = new THREE.Quaternion();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _pose = new THREE.Matrix4();
const _inverse = new THREE.Matrix4();
const _scale = new THREE.Vector3();

/** The tumble `e` (0 → 1) of the way through: tipped over by `tip`, turned by `lean` and `side`, rolled onto that side. */
function sprawl(tip: number, yaw: number, lean: number, side: number, e: number, out: THREE.Quaternion): THREE.Quaternion {
  return out.setFromEuler(_e.set(tip * e, yaw + (lean + side * 0.9) * e, (lean * 0.6 + side * 0.35) * e));
}

/** The turn that lays a body posed `q` flat: its length (local +Y) swung onto the horizontal, its roll kept. */
function levelling(q: THREE.Quaternion): THREE.Quaternion {
  const along = UP.clone().applyQuaternion(q);
  const flat = new THREE.Vector3(along.x, 0, along.z);
  if (flat.lengthSq() < 1e-8) return new THREE.Quaternion();
  return new THREE.Quaternion().setFromUnitVectors(along, flat.normalize());
}

/**
 * How far below its origin the lowest point of `root`'s visible meshes reaches when it is turned
 * `rotation` at `scale` (0 when nothing does): raising it that much rests it on the floor.
 */
function depthBelow(root: THREE.Object3D, rotation: THREE.Quaternion, scale: number): number {
  root.updateWorldMatrix(true, true);
  _inverse.copy(root.matrixWorld).invert();
  _pose.compose(_v.set(0, 0, 0), rotation, _scale.setScalar(scale));
  let low = 0;
  root.traverseVisible((object) => {
    const mesh = object as THREE.Mesh;
    const at = mesh.isMesh ? mesh.geometry?.attributes.position : undefined;
    if (!at) return;
    _m.multiplyMatrices(_pose, _m.multiplyMatrices(_inverse, mesh.matrixWorld));
    for (let i = 0; i < at.count; i++) low = Math.min(low, _v.fromBufferAttribute(at, i).applyMatrix4(_m).y);
  });
  return -low;
}
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _line = new THREE.Line3();
const _on = new THREE.Vector3();

export class Casualties {
  private all = new Map<string, Casualty>();

  constructor(
    private parent: THREE.Object3D,
    /** The top of whatever is underfoot at (x, z) for feet at `y`. */
    private ground: (x: number, z: number, y: number) => number,
    private hooks: CasualtyHooks,
  ) {}

  /** Whether `id` is down on the floor and can still be revived (not already getting back up). */
  dying(id: string): boolean {
    const c = this.all.get(id);
    return !!c && (c.phase === 'fall' || c.phase === 'bled') && c.rouse !== 'up';
  }

  /** The closest revivable body within walking reach, on this storey. */
  nearby(at: { x: number; y: number; z: number }, radius = 2.4): string | null {
    let nearest: string | null = null;
    let distance = radius;
    for (const [id, c] of this.all) {
      if (!this.dying(id) || Math.abs(c.ground - at.y) > 1.5) continue;
      const d = Math.hypot(c.floor.x - at.x, c.floor.z - at.z);
      if (d < distance) {
        nearest = id;
        distance = d;
      }
    }
    return nearest;
  }

  /** Seconds `id` has lain still on the floor since it landed; null while it falls or when it isn't down. */
  lyingFor(id: string): number | null {
    const c = this.all.get(id);
    return c?.phase === 'bled' && c.rouse !== 'up' ? c.t : null;
  }

  /** The phase `id` is in, if it has a scene running. */
  phaseOf(id: string): CasualtyPhase | null {
    return this.all.get(id)?.phase ?? null;
  }

  /**
   * Shoots the worker: it tumbles out of `seat` onto the floor, landing with a thud, and bleeds
   * out under a spreading pool. With the bullet's `direction`, the hit visibly shoves it that way
   * at once and it sprawls out on the side away from the shooter. False when it already has a
   * scene running (a body still getting back up into its chair is put there first).
   */
  shoot(id: string, model: CasualtyModel, seat: THREE.Object3D, direction?: THREE.Vector3): boolean {
    const was = this.all.get(id);
    if (was?.rouse === 'up') this.back(was);
    else if (was) return false;
    // Off the desk first if it was up there dancing: it falls out of its seat.
    model.die();
    const from = model.root.getWorldPosition(new THREE.Vector3());
    const quat = model.root.getWorldQuaternion(new THREE.Quaternion());
    const yaw = new THREE.Euler().setFromQuaternion(quat, 'YXZ').y;
    const scale = model.root.getWorldScale(new THREE.Vector3()).x;
    const local = model.root.scale.x;
    this.parent.add(model.root);
    model.root.position.copy(from);
    model.root.quaternion.copy(quat);
    model.root.scale.setScalar(scale);
    let push = direction ? new THREE.Vector3(direction.x, 0, direction.z) : null;
    if (push && push.lengthSq() < 1e-6) push = null;
    push?.normalize();
    // Sideways out of the chair, into the open: forward would put it under the desk. A shot
    // knocks it out on the side the bullet was travelling toward.
    const across = push ? push.x * Math.cos(yaw) - push.z * Math.sin(yaw) : 0;
    const side = Math.abs(across) > 0.05 ? Math.sign(across) : Math.random() < 0.5 ? -1 : 1;
    const floor = new THREE.Vector3(from.x + Math.cos(yaw) * side * TUMBLE, 0, from.z - Math.sin(yaw) * side * TUMBLE);
    const ground = this.ground(floor.x, floor.z, from.y);
    const tip = (Math.random() < 0.5 ? -1 : 1) * (1.35 + Math.random() * 0.25);
    const lean = (Math.random() - 0.5) * 0.5;
    // How it ends up: tipped over, turned and rolled onto one side, its length flat along the
    // floor, and resting on it rather than sunk into it.
    const level = levelling(sprawl(tip, yaw, lean, side, 1, _q));
    const lying = _q.premultiply(level).clone();
    floor.y = ground + depthBelow(model.root, lying, scale);
    const pool = bloodPool();
    // On top of whatever is underfoot (the rugs under the desks stand 0.021 proud of the floorboards).
    pool.position.set(floor.x, ground + 0.03, floor.z);
    pool.rotation.y = Math.random() * Math.PI * 2;
    this.parent.add(pool);
    this.all.set(id, {
      id,
      model,
      seat,
      scale: local,
      phase: 'fall',
      t: 0,
      bleed: 0,
      from,
      yaw,
      tip,
      lean,
      level,
      ground,
      side,
      push,
      axis: push ? new THREE.Vector3(0, 1, 0).cross(push).normalize() : new THREE.Vector3(),
      jt: 0,
      floor,
      lying,
      seated: quat.clone(),
      lift: 0,
      rouse: 'none',
      rouseT: 0,
      peak: 0,
      finished: false,
      beat: FIRST_BEAT,
      pulse: 0,
      pool,
      laptop: null,
      lgone: 0,
      team: null,
      owned: false,
    });
    return true;
  }

  /**
   * The body lying on the floor (with its revival window open) that a hand at `point` is at: the
   * nearest one with any part of it within `radius` meters. Null when none is in reach.
   */
  reach(point: THREE.Vector3, radius: number): string | null {
    let best: string | null = null;
    let nearest = radius;
    for (const [id, c] of this.all) {
      if (!this.rousable(c)) continue;
      this.length(c);
      const d = _line.closestPointToPoint(point, true, _on).distanceTo(point);
      if (d <= nearest) {
        nearest = d;
        best = id;
      }
    }
    return best;
  }

  /**
   * The body lying on the floor (with its revival window open) that `ray` points at: the first one
   * whose length it passes within `radius` meters of, no further than `range` meters along it.
   */
  along(ray: THREE.Ray, range: number, radius: number): string | null {
    let best: string | null = null;
    let first = range;
    for (const [id, c] of this.all) {
      if (!this.rousable(c)) continue;
      this.length(c);
      const d = ray.distanceSqToSegment(_line.start, _line.end, _on);
      const t = _on.sub(ray.origin).dot(ray.direction);
      if (d > radius * radius || t < 0 || t > first) continue;
      first = t;
      best = id;
    }
    return best;
  }

  /**
   * In the headset, a hand's use action at a body asks the server to revive it: the body stirs
   * and starts to sit up while it waits. If no revival follows (the window closed under it, the
   * office went away) it slumps back down. False when it can't be roused.
   */
  rouse(id: string): boolean {
    const c = this.all.get(id);
    if (!c || !this.rousable(c)) return false;
    c.rouse = 'roused';
    c.rouseT = 0;
    return true;
  }

  /** Whether a hand already roused `id` and it is waiting on its revival. */
  roused(id: string): boolean {
    return this.all.get(id)?.rouse === 'roused';
  }

  /** Where `id`'s chest is while it is down, for staging a hand or a shot at it. */
  chest(id: string, out = new THREE.Vector3()): THREE.Vector3 | null {
    const c = this.all.get(id);
    if (!c || (c.phase !== 'fall' && c.phase !== 'bled')) return null;
    c.model.root.updateWorldMatrix(true, false);
    return c.model.root.localToWorld(out.set(0, 0.55, 0));
  }

  /**
   * Revive stands the worker back up in its seat with its session untouched, blood gone: at once,
   * or in the headset (hooks.riseTime) getting back up into its chair from wherever it lies.
   * False when there's nothing (left) to revive, or it is already getting up.
   */
  revive(id: string): boolean {
    const c = this.all.get(id);
    if (!c || !this.dying(id)) return false;
    if (this.hooks.riseTime && c.phase === 'bled') {
      c.rouse = 'up';
      c.finished = false;
      c.jt = Infinity;
      c.model.pulse?.(0, 1);
      return true;
    }
    this.back(c);
    return true;
  }

  /** A body still getting back up into its chair is put straight there. */
  settle(id: string): void {
    const c = this.all.get(id);
    if (c?.rouse === 'up') this.back(c);
  }

  /**
   * Confirms the kill: two paramedics walk in from the elevator with a stretcher, load the body
   * with a supported scoop pickup, carry it back to the elevator and fade. The laptop
   * shuts and shrinks as on a send-home. False when there's no body to collect.
   */
  confirm(id: string, laptop: CasualtyLaptop): boolean {
    const c = this.all.get(id);
    if (!c || !this.dying(id)) return false;
    if (c.phase === 'fall') this.land(c);
    // Its heart has stopped and its light is out; a body that was stirring slumps back (see step).
    c.finished = true;
    c.rouse = 'none';
    c.jt = Infinity;
    c.model.pulse?.(0, 0);
    this.lie(c);
    c.owned = true;
    c.laptop = laptop;
    c.phase = 'fetch';
    c.t = 0;
    const group = new THREE.Group();
    group.name = 'medic-team';
    const medics = [this.hooks.spawnMedic('🚑 Medic'), this.hooks.spawnMedic('🚑 Medic')];
    const bed = stretcher();
    const left = new THREE.Vector3(-0.35, BED_Y, 0.26);
    const right = new THREE.Vector3(0.35, BED_Y, 0.26);
    const pose = { left, right, crouch: 0, stride: 0 };
    medics.forEach((medic, i) => {
      medic.root.position.set(0, 0, i ? -MEDIC_Z : MEDIC_Z);
      medic.root.rotation.y = i ? 0 : Math.PI;
      medic.medicPose?.(pose);
      group.add(medic.root);
    });
    group.add(bed.root);
    this.parent.add(group);
    // The worker origin is at its feet. Approach the torso center, not the chair-side origin.
    const torso = c.model.root.localToWorld(new THREE.Vector3(0, 0.55, 0));
    const body: Pt = [torso.x, torso.z];
    const way = route(MEDIC_FROM, nearestWalkable(body));
    way.push(body);
    group.position.set(way[0][0], this.ground(way[0][0], way[0][1], c.ground) - FEET, way[0][1]);
    const heading = way.length > 1 ? Math.atan2(way[1][0] - way[0][0], way[1][1] - way[0][1]) : c.yaw;
    group.rotation.y = heading;
    const team: Team = {
      group,
      medics,
      bed,
      materials: new Map(),
      way,
      next: 1,
      heading,
      pickupHeading: Math.atan2(c.floor.x - torso.x, c.floor.z - torso.z),
      speed: 0,
      moving: false,
      stride: 0,
      left,
      right,
      pose,
      pickupAt: new THREE.Vector3(),
      withdrawal: new THREE.Vector3(c.floor.x - c.from.x, 0, c.floor.z - c.from.z).normalize().multiplyScalar(0.55),
      bodyFrom: new THREE.Vector3(),
      bodyRotation: new THREE.Quaternion(),
      bodyTo: new THREE.Vector3(),
      bodyTargetRotation: new THREE.Quaternion(),
      scratch: new THREE.Vector3(),
      inverse: new THREE.Quaternion(),
    };
    c.team = team;
    this.copyMaterials(team, group);
    this.opacity(team, 0);
    c.model.root.traverse((object) => {
      if ((object as THREE.Sprite).isSprite) object.visible = false;
    });
    this.hooks.onSiren(group.position);
    return true;
  }

  /** Off to another floor, or gone: every scene ends, models back in their seats unless collected. */
  clear() {
    for (const c of this.all.values()) {
      if (c.owned) {
        this.dropModel(c);
      } else this.reseat(c);
      this.dropTeam(c);
      this.dropPool(c);
      this.dropLaptop(c);
    }
    this.all.clear();
  }

  /** Where the medic teams are, for the doors to open. */
  positions(): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (const c of this.all.values()) if (c.team) out.push(c.team.group.position);
    return out;
  }

  update(dt: number, t: number) {
    for (const [id, c] of this.all) {
      this.step(c, dt);
      // Back in its seat: the office animates it from here.
      if (!this.all.has(id)) continue;
      c.model.update(dt, t);
      if (c.team) this.poseTeam(c, dt, t);
      if (c.laptop && !this.closeLaptop(c, dt)) c.laptop = null;
      if (c.phase === 'fade' && c.t >= FADE_TIME) {
        this.dropTeam(c);
        this.dropPool(c);
        this.dropLaptop(c);
        this.dropModel(c);
        this.all.delete(id);
      }
    }
  }

  private step(c: Casualty, dt: number) {
    c.t += dt;
    c.jt += dt;
    const { root } = c.model;
    switch (c.phase) {
      case 'fall': {
        const p = Math.min(1, c.t / FALL_TIME);
        const e = easeOut(p);
        root.position.set(THREE.MathUtils.lerp(c.from.x, c.floor.x, e), THREE.MathUtils.lerp(c.from.y, c.floor.y, e) + Math.sin(p * Math.PI) * 0.3, THREE.MathUtils.lerp(c.from.z, c.floor.z, e));
        sprawl(c.tip, c.yaw, c.lean, c.side, e, root.quaternion).premultiply(_fix.slerpQuaternions(IDENTITY, c.level, e));
        this.shove(c);
        if (p >= 1) this.land(c);
        return;
      }
      case 'bled': {
        // The headset knows the server's deadline: the pool and the heart keep its time.
        const left = this.hooks.left?.(c.id) ?? null;
        if (left === null) c.bleed = Math.min(1, c.bleed + dt / BLEED_TIME);
        else {
          c.bleed = THREE.MathUtils.clamp(1 - left / REVIVE_WINDOW, 0, 1);
          if (left <= 0 && c.rouse !== 'up' && !c.finished) {
            // The window has closed: the heart stops and the light goes out. The medics are coming.
            c.finished = true;
            c.model.pulse?.(0, 0);
          }
        }
        c.pool.scale.setScalar(poolSize(c.t, c.bleed, left !== null));
        if (this.rise(c, dt)) return;
        this.lie(c);
        this.shove(c);
        this.heart(c, dt);
        return;
      }
      case 'fetch': {
        const team = c.team!;
        // A body that was stirring when its window closed slumps back down before they reach it.
        if (c.lift > 0) {
          this.slump(c, dt);
          this.lie(c);
        }
        this.opacity(team, smooth(c.t / TEAM_IN));
        if (this.walk(team, dt, team.pickupHeading)) {
          c.phase = 'load';
          c.t = 0;
          team.pickupAt.copy(team.group.position);
          team.bodyFrom.copy(root.position);
          team.bodyRotation.copy(root.quaternion);
          team.bodyTargetRotation.copy(team.group.quaternion).multiply(SUPINE);
          team.scratch.set(0, LOW_BED + 0.31 * root.scale.x, 0.58 * root.scale.x);
          team.group.localToWorld(team.scratch);
          team.bodyTo.copy(team.scratch);
          team.moving = false;
        }
        return;
      }
      case 'load': {
        const team = c.team!;
        const lower = smooth(c.t / LOWER_END);
        const settle = smooth((c.t - LOWER_END) / (SETTLE_END - LOWER_END));
        const lift = smooth((c.t - SETTLE_END) / (LIFT_END - SETTLE_END));
        // Split the scoop around the body while lowering. Support it before closing the bed.
        const open = lower * (1 - smooth((c.t - SUPPORT_END) / (SETTLE_END - SUPPORT_END)));
        team.bed.halves[0].position.x = -open * 0.2;
        team.bed.halves[1].position.x = open * 0.2;
        team.bed.root.position.y = THREE.MathUtils.lerp(BED_Y, LOW_BED, lower) + (BED_Y - LOW_BED) * lift;
        if (root.parent !== team.group) {
          root.position.lerpVectors(team.bodyFrom, team.bodyTo, settle);
          root.position.y += (BED_Y - LOW_BED) * lift;
          root.quaternion.slerpQuaternions(team.bodyRotation, team.bodyTargetRotation, settle);
          if (settle >= 1) {
            // Keep the body fixed to its support during the shared rise and withdrawal.
            team.group.attach(root);
            this.copyMaterials(team, root);
          }
        }
        if (root.parent === team.group) root.position.y = team.bed.root.position.y + 0.31 * root.scale.x;
        const withdraw = smooth((c.t - LIFT_END) / (LOAD_TIME - LIFT_END));
        const x = team.pickupAt.x + team.withdrawal.x * withdraw;
        const z = team.pickupAt.z + team.withdrawal.z * withdraw;
        const move = Math.hypot(x - team.group.position.x, z - team.group.position.z);
        team.group.position.x = x;
        team.group.position.z = z;
        team.moving = move > 1e-5;
        team.stride += move * 7;
        c.pool.scale.setScalar(Math.max(0.001, Math.max(0.05, POOL_R * easeOut(c.bleed)) * (1 - settle)));
        if (c.t < LOAD_TIME) return;
        const here: Pt = [team.group.position.x, team.group.position.z];
        team.way = [here, ...route(nearestWalkable(here), MEDIC_FROM)];
        team.next = 1;
        team.speed = 0;
        c.phase = 'carry';
        c.t = 0;
        return;
      }
      case 'carry':
        if (this.walk(c.team!, dt)) {
          c.phase = 'fade';
          c.t = 0;
        }
        return;
      case 'fade':
        this.opacity(c.team!, 1 - smooth(c.t / FADE_TIME));
        return;
    }
  }

  /** Down: it lands with a thud and starts bleeding out. */
  private land(c: Casualty) {
    c.model.root.position.copy(c.floor);
    c.model.root.quaternion.copy(c.lying);
    c.phase = 'bled';
    c.t = 0;
    this.hooks.onLand(c.floor);
  }

  /**
   * Roused, it stirs and starts to sit up while the server is asked; revived, it gets all the way
   * back up into its chair, and true once it is there. Otherwise a stirring body slumps back.
   */
  private rise(c: Casualty, dt: number): boolean {
    const step = dt / (this.hooks.riseTime ?? RISE_TIME);
    if (c.rouse === 'up') {
      c.lift = Math.min(1, c.lift + step);
      if (c.lift < 1) return false;
      this.back(c);
      return true;
    }
    if (c.rouse === 'roused') {
      c.rouseT += dt;
      c.lift = Math.min(STIR, c.lift + step);
      if (c.rouseT >= ROUSE_WAIT || c.finished) c.rouse = 'none';
    } else this.slump(c, dt);
    c.peak = c.lift > 0 ? Math.max(c.peak, c.lift) : 0;
    return false;
  }

  /** Not held up: it sinks back to the floor, with a thud when it dropped from high enough. */
  private slump(c: Casualty, dt: number) {
    if (c.lift <= 0) return;
    c.lift = Math.max(0, c.lift - dt * SLUMP);
    if (c.lift === 0 && c.peak >= SLUMP_THUD) this.hooks.onLand(c.floor);
  }

  /**
   * In the headset (hooks.onBeat), its heart: a beat that slows and fades as the window runs out,
   * at its chest, and its light glowing red with each one, dimmer as it goes. Stopped once finished.
   */
  private heart(c: Casualty, dt: number) {
    if (!this.hooks.onBeat || c.finished || c.rouse === 'up') return;
    c.pulse = Math.max(0, c.pulse - dt * BEAT_FADE);
    if ((c.beat -= dt) <= 0) {
      c.beat += beatGap(c.bleed);
      c.pulse = 1;
      this.hooks.onBeat(c.model.root.localToWorld(_a.set(0, 0.55, 0)), beatStrength(c.bleed));
    }
    c.model.pulse?.(c.pulse * beatStrength(c.bleed), 1 - c.bleed);
  }

  /** Whether a hand can rouse it: lying still on the floor, its window open, not already roused. */
  private rousable(c: Casualty): boolean {
    return c.phase === 'bled' && !c.finished && c.rouse === 'none';
  }

  /** Its length along the floor, feet to head, into _line. */
  private length(c: Casualty) {
    const root = c.model.root;
    root.updateWorldMatrix(true, false);
    _line.set(root.localToWorld(_a.set(0, BODY_FROM, 0)), root.localToWorld(_b.set(0, BODY_TO, 0)));
  }

  /** Revived: back in its seat with its session untouched, the blood gone; the office is told. */
  private back(c: Casualty) {
    this.reseat(c);
    this.dropPool(c);
    this.all.delete(c.id);
    c.model.root.updateWorldMatrix(true, false);
    this.hooks.onBack?.(c.id, c.model.root.localToWorld(new THREE.Vector3(0, 0.9, 0)));
  }

  /** Where it lies, or as far back up into its chair as it has got. */
  private lie(c: Casualty) {
    const root = c.model.root;
    const e = smooth(c.lift);
    root.position.lerpVectors(c.floor, c.from, e);
    // Up off the floor in an arc, over the chair's edge, rather than through it.
    root.position.y += Math.sin(e * Math.PI) * 0.12;
    root.quaternion.slerpQuaternions(c.lying, c.seated, e);
  }

  /** The bullet's shove, on top of its pose: at once, leaning it away from the shooter about its feet. */
  private shove(c: Casualty) {
    const j = c.push ? jolt(c.jt) : 0;
    if (j <= 0.001) return;
    c.model.root.position.addScaledVector(c.push!, KNOCK * j);
    c.model.root.quaternion.premultiply(_lean.setFromAxisAngle(c.axis, KICK * j));
  }

  /** Slows for corners and arrival, turns before stepping, and accelerates without a lurch. */
  private walk(team: Team, dt: number, arrivalHeading?: number): boolean {
    const pos = team.group.position;
    while (team.next < team.way.length && Math.hypot(team.way[team.next][0] - pos.x, team.way[team.next][1] - pos.z) < 0.015) team.next++;
    if (team.next >= team.way.length) {
      team.speed = 0;
      team.moving = false;
      if (arrivalHeading === undefined) return true;
      const turn = wrap(arrivalHeading - team.group.rotation.y);
      team.group.rotation.y += THREE.MathUtils.clamp(turn, -dt * 1.6, dt * 1.6);
      return Math.abs(turn) < 0.01;
    }
    const [x, z] = team.way[team.next];
    const dx = x - pos.x;
    const dz = z - pos.z;
    const distance = Math.hypot(dx, dz);
    team.heading = Math.atan2(dx, dz);
    const turn = wrap(team.heading - team.group.rotation.y);
    team.group.rotation.y += THREE.MathUtils.clamp(turn, -dt * 1.6, dt * 1.6);
    const target = MEDIC_PACE * Math.max(0, 1 - Math.abs(turn) / 1.2) * Math.min(1, Math.sqrt(distance / 0.7));
    team.speed += THREE.MathUtils.clamp(target - team.speed, -dt * 3.5, dt * 2.4);
    const move = Math.min(distance, team.speed * dt);
    pos.x += (dx / distance) * move;
    pos.z += (dz / distance) * move;
    const g = this.ground(pos.x, pos.z, pos.y + FEET) - FEET;
    pos.y += (g - pos.y) * Math.min(1, dt * 14);
    team.moving = move > 1e-5;
    team.stride += move * 7;
    return false;
  }

  /** Hands change between handles and support points; the endpoint meshes follow those targets. */
  private poseTeam(c: Casualty, dt: number, t: number) {
    const team = c.team!;
    const loading = c.phase === 'load';
    const lower = loading ? smooth(c.t / LOWER_END) : 0;
    const lift = loading ? smooth((c.t - SETTLE_END) / (LIFT_END - SETTLE_END)) : 1;
    const support = loading ? smooth((c.t - LOWER_END * 0.65) / 0.45) * (1 - smooth((c.t - SUPPORT_END) / (SETTLE_END - SUPPORT_END))) : 0;
    const crouch = lower * (1 - lift);
    // The same tiny vertical movement carries stretcher, body and both hands; feet remain on the floor.
    const bob = team.moving ? Math.sin(team.stride * 2) * 0.012 : 0;
    if (!loading || c.t > LIFT_END) team.bed.root.position.y = BED_Y + bob;
    if (c.model.root.parent === team.group) c.model.root.position.y = team.bed.root.position.y + 0.31 * c.model.root.scale.x;
    team.group.updateWorldMatrix(true, false);
    c.model.root.updateWorldMatrix(true, false);
    for (let i = 0; i < team.medics.length; i++) {
      const medic = team.medics[i];
      const end = i ? -1 : 1;
      medic.root.position.z = end * (MEDIC_Z - support * 0.27);
      medic.root.updateWorldMatrix(true, false);
      medic.update(dt, t, team.moving, false);
      team.inverse.copy(medic.root.quaternion).invert();
      for (let hand = 0; hand < 2; hand++) {
        const side = hand ? 1 : -1;
        const target = hand ? team.right : team.left;
        // Handles are expressed in the team frame, support points in the worker's own frame.
        target.set(side * (0.35 + Math.abs(team.bed.halves[0].position.x)), team.bed.root.position.y, end * HANDLE_Z);
        if (support) {
          team.scratch.set(0, i ? 1.02 : 0.12, 0);
          c.model.root.localToWorld(team.scratch);
          team.scratch.y = Math.max(team.scratch.y - 0.13, c.ground + 0.09);
          team.group.worldToLocal(team.scratch);
          team.scratch.x += side * 0.23;
          target.lerp(team.scratch, support);
        }
        target.sub(medic.root.position).applyQuaternion(team.inverse);
      }
      // Facing inward means the front medic walks backwards, maintaining sight of the patient.
      if (!i) {
        team.scratch.copy(team.left);
        team.left.copy(team.right);
        team.right.copy(team.scratch);
      }
      team.pose.crouch = crouch;
      team.pose.stride = team.moving ? team.stride : 0;
      medic.medicPose?.(team.pose);
    }
  }

  private copyMaterials(team: Team, root: THREE.Object3D) {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const clone = (original: THREE.Material) => {
        let material = team.materials.get(original);
        if (!material) {
          material = original.clone();
          team.materials.set(original, material);
        }
        return material;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(clone) : clone(mesh.material);
    });
  }

  private opacity(team: Team, value: number) {
    for (const [original, material] of team.materials) {
      material.opacity = original.opacity * value;
      const transparent = original.transparent || value < 1;
      if (material.transparent !== transparent) {
        material.transparent = transparent;
        material.needsUpdate = true;
      }
    }
  }

  /** Shuts the laptop and shrinks it away; false once it's gone. */
  private closeLaptop(c: Casualty, dt: number): boolean {
    const laptop = c.laptop!;
    if (!laptop.shut(dt)) return true;
    c.lgone = Math.min(1, c.lgone + dt / LAPTOP_GONE);
    laptop.root.scale.setScalar(Math.max(0.001, 1 - c.lgone * c.lgone));
    if (c.lgone < 1) return true;
    this.dropLaptop(c);
    c.laptop = null;
    return false;
  }

  /** Back in its seat at once, as if nothing happened: its session never stopped. */
  private reseat(c: Casualty) {
    c.seat.add(c.model.root);
    c.model.root.position.set(0, 0, 0);
    c.model.root.rotation.set(0, 0, 0);
    c.model.root.scale.setScalar(c.scale);
    c.model.revive();
  }

  private dropTeam(c: Casualty) {
    const team = c.team;
    if (!team) return;
    c.team = null;
    team.group.removeFromParent();
    // Medic helpers free their own geometry. Keep the worker's geometry out of team cleanup.
    const geometry = new Set(team.bed.geometries);
    for (const medic of team.medics) {
      medic.medicPose?.(null);
      medic.dispose();
      medic.root.traverse((object) => {
        if ((object as THREE.Mesh).isMesh) geometry.add((object as THREE.Mesh).geometry);
      });
    }
    for (const item of geometry) item.dispose();
    for (const material of team.materials.values()) material.dispose();
    // Stretcher materials were created for this team, unlike shared character materials.
    const bedMaterials = new Set<THREE.Material>();
    team.bed.root.traverse((object) => {
      const material = (object as THREE.Mesh).material;
      if (material && !Array.isArray(material)) bedMaterials.add(material);
    });
    for (const [original, material] of team.materials) if (bedMaterials.has(material)) original.dispose();
  }

  private dropModel(c: Casualty) {
    c.model.root.removeFromParent();
    const geometry = new Set<THREE.BufferGeometry>();
    c.model.root.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) geometry.add((object as THREE.Mesh).geometry);
    });
    c.model.dispose();
    for (const item of geometry) item.dispose();
  }

  private dropPool(c: Casualty) {
    c.pool.removeFromParent();
  }

  private dropLaptop(c: Casualty) {
    if (!c.laptop) return;
    c.laptop.root.removeFromParent();
    c.laptop.dispose();
    c.laptop = null;
  }
}
