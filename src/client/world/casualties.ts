import * as THREE from 'three';
import { ELEVATOR, ELEVATOR_FRONT } from '../../shared/layout';
import { nearestWalkable, route, type Pt } from '../../shared/nav';
import { Person, type Worker } from './character';
import type { Laptop } from './laptop';
import type { DeskView } from './office';
import { mesh, toon } from './toon';

/** Seconds to tumble out of the chair and land. */
export const FALL_TIME = 0.7;
/** Seconds for the blood pool to spread all the way out. */
export const POOL_TIME = 6;
/** Seconds to load the body onto the stretcher (the pool drains as it lifts). */
export const LOAD_TIME = 1.5;
/** Seconds to shrink away once the stretcher is in the elevator. */
export const GONE_TIME = 0.6;
/** Seconds for a shut laptop to shrink away. */
const LAPTOP_GONE = 0.3;
/** How fast the medics walk, in m/s: brisk, but it's not an emergency any more. */
const PACE = 2.6;
/** How high the origin rides while lying flat (times its scale): the body clears the floor. */
const LYING = 0.26;
/** The pool at its widest, in meters across. */
const POOL_WIDE = 1.7;
/** How close the medics come before they set the stretcher down. */
const LOAD_REACH = 1.15;
/** The stretcher rides this high while it's carried. */
const CARRY_HIGH = 0.72;

const GASPS = ['😵 …', '😵 x_x', '😵 💀', '😵 oof', '😵 tell my PR…'];

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

/** How far the blood pool has spread `t` seconds after the shot, 0 → 1 (it starts as a splat). */
export function poolSpread(t: number): number {
  if (t <= 0) return 0.18;
  const p = Math.min(1, t / POOL_TIME);
  return 0.18 + 0.82 * (1 - (1 - p) * (1 - p));
}

/** How far the fall has come `t` seconds in, 0 → 1. */
export function fallProgress(t: number): number {
  return Math.min(1, Math.max(0, t / FALL_TIME));
}

/** A seeded shuffle, so every pool has its own ragged edge. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A pool of blood: a dark ragged-edged spread with a glossier middle, lying flat on y = 0.
 * Unlit, so it stays blood-dark however the room is lit.
 */
function bloodPool(): { group: THREE.Group; mats: THREE.Material[] } {
  const group = new THREE.Group();
  const mats: THREE.Material[] = [];
  const blob = (radius: number, color: string, y: number, seed: number) => {
    const geo = new THREE.CircleGeometry(radius, 28);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const rnd = mulberry(seed);
    const edge = 0.7 + rnd() * 0.15;
    for (let i = 1; i < pos.count; i++) {
      const x = pos.getX(i);
      const y0 = pos.getY(i);
      const d = Math.hypot(x, y0) / radius;
      if (d > edge) {
        const k = 0.72 + rnd() * 0.5;
        pos.setXY(i, x * k, y0 * k);
      }
    }
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color });
    mats.push(mat);
    const m = mesh(geo, mat, 0, y, 0, false);
    m.receiveShadow = false;
    group.add(m);
  };
  const seed = Math.floor(Math.random() * 2 ** 31);
  blob(POOL_WIDE / 2, '#5f0808', 0.004, seed);
  blob(POOL_WIDE * 0.3, '#a31616', 0.007, seed + 1);
  group.scale.setScalar(0.18);
  return { group, mats };
}

/** A stretcher: orange canvas on poles with little legs, `CARRY_HIGH` under the handles. */
function stretcher(): THREE.Group {
  const g = new THREE.Group();
  const canvas = toon('#e8632a');
  const pole = toon('#8d99ae');
  g.add(mesh(new THREE.BoxGeometry(0.62, 0.05, 1.25), canvas, 0, 0, 0, false));
  for (const sx of [-1, 1]) {
    const rail = mesh(new THREE.CylinderGeometry(0.022, 0.022, 1.7, 8).rotateX(Math.PI / 2), pole, sx * 0.36, 0.02, 0, false);
    g.add(rail);
    for (const sz of [-1, 1]) g.add(mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.3, 6), pole, sx * 0.3, -0.17, sz * 0.45, false));
  }
  return g;
}

/** One casualty's phases: tumbling down, bleeding out, the medics coming, loaded up, carried out. */
export type CasualtyPhase = 'fall' | 'bleed' | 'fetch' | 'load' | 'carry' | 'out';

interface Casualty {
  workerId: string;
  name: string;
  model: Worker;
  desk: DeskView;
  phase: CasualtyPhase;
  /** Seconds into the phase (bleed counts the whole bleed-out, for the pool). */
  t: number;
  scale: number;
  /** Where it lands, and which way it faces lying there. */
  spot: THREE.Vector3;
  yaw: number;
  /** The fall's start, and how far round it spins on the way down. */
  from: THREE.Vector3;
  spin: number;
  pool: THREE.Group;
  poolMats: THREE.Material[];
  /** On a confirmed kill: the laptop, shutting and shrinking away. */
  laptop: { laptop: Laptop; gone: number } | null;
  medics: [Person, Person] | null;
  carrier: THREE.Group | null;
  /** The medics' way in (reversed on the way out) and the point they're walking to. */
  way: Pt[];
  next: number;
  heading: number;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Shot workers. Each one tumbles out of its chair and bleeds out on the floor while its fate is
 * decided (see shoot, revive). On a confirmed kill the laptop shuts and two paramedics come in
 * from the elevator with a stretcher, load the body up and carry it out (see collect). On revive
 * it's back in its seat like nothing happened.
 */
export class Casualties {
  private casualties: Casualty[] = [];

  constructor(
    private parent: THREE.Object3D,
    /** The top of whatever is underfoot at (x, z) for feet at `y`. */
    private ground: (x: number, z: number, y: number) => number,
    /** The body just hit the floor at `at`. */
    private onLand: (at: THREE.Vector3) => void,
  ) {}

  /** Whether a shot worker is still waiting on its fate (only one at a time). */
  get unresolved(): Casualty | undefined {
    return this.casualties.find((c) => c.phase === 'fall' || c.phase === 'bleed');
  }

  /** Shoots the worker: it tumbles out of its seat and starts bleeding out. False when one's already dying. */
  shoot(workerId: string, name: string, model: Worker, desk: DeskView): boolean {
    if (this.unresolved) return false;
    model.die(pick(GASPS));
    const seat = model.root.getWorldPosition(new THREE.Vector3());
    const scale = model.root.getWorldScale(new THREE.Vector3()).x;
    this.parent.add(model.root);
    model.root.position.copy(seat);
    model.root.scale.setScalar(scale);
    // Outward from the desk, onto the floor beside the chair.
    const deskAt = desk.group.getWorldPosition(new THREE.Vector3());
    const out = new THREE.Vector3(seat.x - deskAt.x, 0, seat.z - deskAt.z);
    if (out.lengthSq() < 1e-4) out.set(0, 0, 1);
    out.normalize();
    const spot = new THREE.Vector3(seat.x + out.x * 0.9, 0, seat.z + out.z * 0.9);
    spot.y = this.ground(spot.x, spot.z, seat.y) + LYING * scale;
    const { group, mats } = bloodPool();
    group.position.set(spot.x, spot.y - LYING * scale + 0.002, spot.z);
    this.parent.add(group);
    this.casualties.push({
      workerId,
      name,
      model,
      desk,
      phase: 'fall',
      t: 0,
      scale,
      spot,
      yaw: Math.atan2(out.x, out.z) + (Math.random() - 0.5) * 1.2,
      from: seat,
      spin: (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 2),
      pool: group,
      poolMats: mats,
      laptop: null,
      medics: null,
      carrier: null,
      way: [],
      next: 0,
      heading: 0,
    });
    return true;
  }

  /**
   * Back in its seat, like nothing happened: the pool goes and the worker works on. False when
   * it's past deciding (already collected) or not dying at all.
   */
  revive(workerId: string): boolean {
    const c = this.casualties.find((x) => x.workerId === workerId && (x.phase === 'fall' || x.phase === 'bleed'));
    if (!c) return false;
    c.desk.seatAnchor.add(c.model.root);
    c.model.root.position.set(0, 0, 0);
    c.model.root.rotation.set(0, 0, 0);
    c.model.root.scale.setScalar(1);
    c.model.revive();
    this.dropPool(c);
    this.casualties = this.casualties.filter((x) => x !== c);
    return true;
  }

  /**
   * The kill is confirmed: its laptop shuts and the medics come in from the elevator for it.
   * Whoever calls this has taken the worker out of the world already (worker.remove), so the
   * casualty owns the model from here on.
   */
  collect(workerId: string, laptop: Laptop) {
    const c = this.casualties.find((x) => x.workerId === workerId && (x.phase === 'fall' || x.phase === 'bleed'));
    if (!c) return;
    c.phase = 'fetch';
    c.t = 0;
    c.laptop = { laptop, gone: 0 };
    const carrier = stretcher();
    this.parent.add(carrier);
    c.carrier = carrier;
    const medics: [Person, Person] = [new Person('🚑 Medic', '#f1faee', { skin: 2, hair: 5, style: 0 }), new Person('🚑 Medic', '#f1faee', { skin: 5, hair: 0, style: 6 })];
    for (const m of medics) {
      m.showLabel(false);
      m.setCostume(null);
      this.parent.add(m.root);
    }
    c.medics = medics;
    const from: Pt = [ELEVATOR.x, ELEVATOR_FRONT + 0.6];
    const stand = nearestWalkable([c.spot.x, c.spot.z]);
    c.way = route(from, stand);
    c.next = 1;
    c.heading = Math.atan2(stand[0] - from[0], stand[1] - from[1]);
    carrier.position.set(from[0], this.ground(from[0], from[1], c.spot.y) + CARRY_HIGH, from[1]);
    this.placeCarrier(c);
  }

  /** Off to another floor: the pools and the medics go with this floor's dead (their models go with the views, unless already collected). */
  clear() {
    for (const c of this.casualties) {
      const collected = c.phase !== 'fall' && c.phase !== 'bleed';
      this.dropPool(c);
      this.dropMedics(c);
      if (c.laptop) {
        c.laptop.laptop.root.removeFromParent();
        c.laptop.laptop.dispose();
      }
      if (collected) {
        c.model.root.removeFromParent();
        c.model.dispose();
      }
    }
    this.casualties = [];
  }

  /** Where the bodies and the medics are, for the doors to open. */
  positions(): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (const c of this.casualties) {
      out.push(c.model.root.position);
      if (c.medics) for (const m of c.medics) out.push(m.root.position);
    }
    return out;
  }

  update(dt: number, t: number) {
    this.casualties = this.casualties.filter((c) => {
      if (c.laptop && !this.shutLaptop(c, dt)) {
        // Still shutting; the medics don't wait for it.
      }
      const here = this.step(c, dt);
      c.model.update(dt, t);
      if (c.medics) for (const m of c.medics) m.update(dt, t, c.phase === 'fetch' || c.phase === 'carry', false);
      if (!here) this.drop(c);
      return here;
    });
  }

  /** Folds the laptop shut and shrinks it away; false while it's still going. */
  private shutLaptop(c: Casualty, dt: number): boolean {
    const l = c.laptop!;
    if (!l.laptop.shut(dt)) return false;
    l.gone = Math.min(1, l.gone + dt / LAPTOP_GONE);
    l.laptop.root.scale.setScalar(Math.max(0.001, 1 - l.gone * l.gone));
    if (l.gone < 1) return false;
    l.laptop.root.removeFromParent();
    l.laptop.dispose();
    c.laptop = null;
    return true;
  }

  /** Moves one along; false once it's carried out. */
  private step(c: Casualty, dt: number): boolean {
    c.t += dt;
    const { root } = c.model;
    if (c.phase === 'fall') {
      const p = fallProgress(c.t);
      const e = p * p * (3 - 2 * p);
      root.position.lerpVectors(c.from, c.spot, e);
      root.position.y += Math.sin(p * Math.PI) * 0.25;
      // Tipping over backward, spinning round on the way down.
      root.rotation.set((-Math.PI / 2) * e, c.yaw * e + c.spin * e * (1 - e) * 2, 0.12 * e);
      if (p < 1) return true;
      root.position.copy(c.spot);
      root.rotation.set(-Math.PI / 2, c.yaw, 0.12);
      c.phase = 'bleed';
      c.t = 0;
      this.onLand(c.spot);
      return true;
    }
    if (c.phase === 'bleed') {
      c.pool.scale.setScalar(poolSpread(c.t));
      return true;
    }
    if (!c.medics || !c.carrier) return true;
    if (c.phase === 'fetch') {
      c.pool.scale.setScalar(poolSpread(POOL_TIME));
      if (this.walkMedics(c, dt, LOAD_REACH)) return true;
      c.phase = 'load';
      c.t = 0;
      return true;
    }
    if (c.phase === 'load') {
      const p = Math.min(1, c.t / LOAD_TIME);
      const e = p * p * (3 - 2 * p);
      // The stretcher slides under it as it lifts: the pool drains away underneath.
      const top = c.carrier.position.y + 0.03 + LYING * c.scale;
      root.position.set(THREE.MathUtils.lerp(c.spot.x, c.carrier.position.x, e), THREE.MathUtils.lerp(c.spot.y, top, e), THREE.MathUtils.lerp(c.spot.z, c.carrier.position.z, e));
      c.pool.scale.setScalar(Math.max(0.001, 1 - e));
      if (p < 1) return true;
      this.dropPool(c);
      // Onto the stretcher: from here on it rides along.
      c.carrier.attach(root);
      c.phase = 'carry';
      c.t = 0;
      c.way = [...c.way].reverse();
      c.next = 1;
      return true;
    }
    if (c.phase === 'carry') {
      if (this.walkMedics(c, dt, 0)) return true;
      c.phase = 'out';
      c.t = 0;
      return true;
    }
    // Into the elevator: gone.
    const p = Math.min(1, c.t / GONE_TIME);
    const k = Math.max(0.001, 1 - p * p);
    c.carrier.scale.setScalar(k);
    for (const m of c.medics) m.root.scale.setScalar(k);
    return p < 1;
  }

  /**
   * Walks the medics along their way with the stretcher between them; false once they're there
   * (or within `stopShort` meters of the body, for the pickup).
   */
  private walkMedics(c: Casualty, dt: number, stopShort: number): boolean {
    const mid = c.carrier!.position;
    let move = PACE * dt;
    while (move > 0 && c.next < c.way.length) {
      const [x, z] = c.way[c.next];
      const dx = x - mid.x;
      const dz = z - mid.z;
      const d = Math.hypot(dx, dz);
      if (stopShort > 0 && Math.hypot(c.spot.x - mid.x, c.spot.z - mid.z) <= stopShort) {
        this.faceBody(c);
        return false;
      }
      if (d > 1e-4) c.heading = Math.atan2(dx, dz);
      if (d <= move) {
        mid.x = x;
        mid.z = z;
        move -= d;
        c.next++;
      } else {
        mid.x += (dx / d) * move;
        mid.z += (dz / d) * move;
        move = 0;
      }
    }
    mid.y += (this.ground(mid.x, mid.z, mid.y) + CARRY_HIGH - mid.y) * Math.min(1, dt * 6);
    if (c.next < c.way.length) {
      this.placeCarrier(c);
      return true;
    }
    return false;
  }

  /** The stretcher between the medics, lengthways along where they're going. */
  private placeCarrier(c: Casualty) {
    const [front, back] = c.medics!;
    const mid = c.carrier!.position;
    c.carrier!.rotation.y = c.heading;
    const dx = Math.sin(c.heading);
    const dz = Math.cos(c.heading);
    front.root.position.set(mid.x + dx * 1.15, this.ground(mid.x + dx * 1.15, mid.z + dz * 1.15, mid.y), mid.z + dz * 1.15);
    back.root.position.set(mid.x - dx * 1.15, this.ground(mid.x - dx * 1.15, mid.z - dz * 1.15, mid.y), mid.z - dz * 1.15);
    for (const m of [front, back]) m.root.rotation.y = c.heading;
  }

  /** At the body: the stretcher down beside it, a medic at each end. */
  private faceBody(c: Casualty) {
    const [front, back] = c.medics!;
    const mid = c.carrier!.position;
    c.heading = Math.atan2(c.spot.x - mid.x, c.spot.z - mid.z);
    c.carrier!.rotation.y = c.heading + Math.PI / 2;
    // Down beside the body, ready to slide under it.
    const dx = Math.sin(c.heading);
    const dz = Math.cos(c.heading);
    mid.set(c.spot.x - dx * 0.15, this.ground(c.spot.x, c.spot.z, c.spot.y) + 0.1, c.spot.z - dz * 0.15);
    front.root.position.set(mid.x - dz * 1.05, this.ground(mid.x - dz * 1.05, mid.z + dx * 1.05, mid.y), mid.z + dx * 1.05);
    back.root.position.set(mid.x + dz * 1.05, this.ground(mid.x + dz * 1.05, mid.z - dx * 1.05, mid.y), mid.z - dx * 1.05);
    for (const m of [front, back]) m.root.rotation.y += wrap(Math.atan2(c.spot.x - m.root.position.x, c.spot.z - m.root.position.z) - m.root.rotation.y);
  }

  private dropPool(c: Casualty) {
    c.pool.removeFromParent();
    c.pool.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    for (const m of c.poolMats) m.dispose();
  }

  private dropMedics(c: Casualty) {
    if (c.medics) {
      for (const m of c.medics) {
        m.root.removeFromParent();
        m.dispose();
      }
      c.medics = null;
    }
    if (c.carrier) {
      c.carrier.removeFromParent();
      c.carrier.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      c.carrier = null;
    }
  }

  private drop(c: Casualty) {
    this.dropPool(c);
    this.dropMedics(c);
    if (c.laptop) {
      c.laptop.laptop.root.removeFromParent();
      c.laptop.laptop.dispose();
    }
    // The body rides the stretcher out (or never got collected): either way it's gone with it.
    c.model.root.removeFromParent();
    c.model.dispose();
  }
}
