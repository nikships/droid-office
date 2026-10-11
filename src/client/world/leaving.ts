import * as THREE from 'three';
import { BALCONY, PARACHUTE } from '../../shared/layout';
import { walkOff, wayHome, wayToBalcony, type Pt } from '../../shared/nav';
import type { Worker } from './character';
import type { Laptop } from './laptop';
import type { DeskView } from './office';
import { mesh, toonUnique } from './toon';

/** Walking pace on the way out, in m/s: no hurry any more. */
const PACE = 2.3;
/** Seconds sat at the desk while its things go in the box and the laptop shuts. */
const PACK = 0.9;
/** Seconds hopping down off the chair (or the bean bag). */
const HOP = 0.55;
/** A worker's feet are this far above its origin, so standing on something its origin is this far below the top. */
const FEET = 0.07;
/** Seconds to shrink away once it's off down the sidewalk. */
const GONE = 0.6;
/** Seconds for a shut laptop to shrink away. */
const LAPTOP_GONE = 0.3;

const FAREWELLS = ['😢 bye, everyone', '🥲 it was fun', '📦 welp', '😞 cleaning out my desk', '🥺 but my PR…', '😶 security is walking me out'];

// Leaving a floor with no exit door, by parachute off the balcony.
/** Seconds climbing up onto the railing, then teetering on it. */
const CLIMB = 0.6;
const TEETER = 0.8;
/** Seconds falling before the chute opens, and how hard it jumped out (m/s, out and up). */
const FREEFALL = 0.7;
const LEAP = { out: 2.6, up: 2.4 };
const GRAVITY = 9.8;
/** How fast it sinks under the chute (m/s): quicker while it's a long way up, gently at the end. */
const SINK = { min: 2.2, max: 9, per: 4 };
/** How fast it circles down onto the spot it lands on (rad/s). */
const TURN = 1.2;
/** Seconds for the chute to pop open, and to crumple on the ground once it's down. */
const POP = 0.45;
const CRUMPLE = 1.3;
const JUMPS = ['🪂 geronimo!', '🪂 see ya!', '🪂 wheee!', '🪂 bye bye!', '🪂 I quit!'];
const CANOPIES = ['#ef476f', '#ffd166', '#06d6a0', '#118ab2', '#8338ec', '#ff8a5b'];

/** Seen from below too, so both sides of the fabric. */
const fabric = new Map<string, THREE.MeshToonMaterial>();
function cloth(color: string): THREE.MeshToonMaterial {
  let m = fabric.get(color);
  if (!m) {
    m = toonUnique(color);
    m.side = THREE.DoubleSide;
    fabric.set(color, m);
  }
  return m;
}
const CORD = new THREE.LineBasicMaterial({ color: '#2b2d42' });

/**
 * A parachute, to hang from a worker's shoulders: striped gores in a dome over its head, and the
 * cords down to it. Its origin is where it's strapped on, so it pops open (and crumples) from there.
 */
function parachute(color: string): { group: THREE.Group; dome: THREE.Group } {
  const group = new THREE.Group();
  group.position.y = 0.88;
  const dome = new THREE.Group();
  const R = 1.35;
  const rim = 1.15;
  const gores = 10;
  for (let i = 0; i < gores; i++) {
    const geo = new THREE.SphereGeometry(R, 3, 5, (i / gores) * Math.PI * 2, (Math.PI * 2) / gores, 0, rim);
    dome.add(mesh(geo, cloth(i % 2 ? '#fffaf3' : color), 0, 0, 0, false));
  }
  dome.scale.y = 0.62;
  dome.position.y = 1.25;
  group.add(dome);
  // A cord from each seam at the rim down to a shoulder.
  const ends: number[] = [];
  const rimY = 1.25 + R * Math.cos(rim) * 0.62;
  for (let i = 0; i < gores; i++) {
    const a = (i / gores) * Math.PI * 2;
    const x = Math.sin(a) * R * Math.sin(rim);
    const z = Math.cos(a) * R * Math.sin(rim);
    ends.push(x, rimY, z, x < 0 ? -0.24 : 0.24, 0, 0.02);
  }
  const cords = new THREE.BufferGeometry();
  cords.setAttribute('position', new THREE.Float32BufferAttribute(ends, 3));
  group.add(new THREE.LineSegments(cords, CORD));
  return { group, dome };
}

/** How it gets down from a floor with no exit door, and how far along it is. */
interface Chute {
  /** Walking out to the railing, up on it, over it, under the open chute, down on the ground, then off. */
  phase: 'walk' | 'climb' | 'teeter' | 'fall' | 'glide' | 'down' | 'off';
  /** Seconds into the phase. */
  t: number;
  color: string;
  /** Once it's open. */
  canopy: { group: THREE.Group; dome: THREE.Group } | null;
  from: THREE.Vector3;
  vel: THREE.Vector3;
  /** Where it lands (its origin's height there), the way round to it now, how wide it circles, and from how high. */
  land: THREE.Vector3;
  angle: number;
  radius: number;
  height: number;
}

interface Leaver {
  model: Worker;
  deskId: string;
  way: Pt[];
  /** The point on `way` it's walking to; 0 until it has hopped down. */
  next: number;
  /** Seconds since it was sent home. */
  t: number;
  /** Where it sat. */
  seat: THREE.Vector3;
  /** The way it's walking (rotation around y; 0 is +z). */
  heading: number;
  /** The desk chair it got up from, spinning after it (null for a bean bag, or once someone new sits there). */
  chair: THREE.Object3D | null;
  spin: number;
  scale: number;
  /** 0 → 1 as it shrinks away at the end. */
  gone: number;
  /** Off a floor with no exit door: out over the balcony railing by parachute. */
  chute: Chute | null;
}

interface Closing {
  laptop: Laptop;
  deskId: string;
  /** 0 → 1 as it shrinks away, once the lid is shut. */
  gone: number;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

/**
 * Workers who've been sent home. Each one packs its things into a cardboard box while its laptop
 * shuts, hops down off its chair, and walks out of the building with the box (see wayHome): out the
 * exit door, down the steps and off along the sidewalk, where it's gone. Only the bottom floor has
 * an exit door, so from the floors above it goes out onto the balcony instead, climbs up on the
 * railing and jumps, and its parachute brings it down onto the lot out front, box and all.
 */
export class Departures {
  private leavers: Leaver[] = [];
  private laptops: Closing[] = [];

  constructor(
    private parent: THREE.Object3D,
    /** The top of whatever is underfoot at (x, z) for feet at `y`: the floor, a step, the street. */
    private ground: (x: number, z: number, y: number) => number,
    /** It has got up from `deskId`, so the seat is free to see. */
    private onUp: (deskId: string) => void,
    /** Whether this floor is above the bottom one, with no exit door: the way out is off the balcony. */
    private upstairs: () => boolean,
  ) {}

  /** Takes over a worker's model and laptop the moment it's sent home from `desk`. */
  add(model: Worker, laptop: Laptop, desk: DeskView) {
    // Off the desk first if it was up there dancing: it packs up in its seat.
    model.stopDancing();
    const seat = model.root.getWorldPosition(new THREE.Vector3());
    const scale = model.root.getWorldScale(new THREE.Vector3()).x;
    this.parent.add(model.root);
    model.root.position.copy(seat);
    // On the seat it faces the desk: the seat anchor is turned round from the desk's own rotation.
    model.root.rotation.set(0, desk.def.rotY + Math.PI, 0);
    model.root.scale.setScalar(scale);
    model.leave(pick(FAREWELLS));
    const chair = desk.def.beanbag ? null : desk.chair;
    const up = this.upstairs();
    const chute: Chute | null = up ? { phase: 'walk', t: 0, color: pick(CANOPIES), canopy: null, from: new THREE.Vector3(), vel: new THREE.Vector3(), land: new THREE.Vector3(), angle: 0, radius: 0, height: 1 } : null;
    const way = up ? wayToBalcony(desk.def) : wayHome(desk.def);
    this.leavers.push({ model, deskId: desk.def.id, way, next: 0, t: 0, seat, heading: model.root.rotation.y, chair, spin: 0, scale, gone: 0, chute });
    this.laptops.push({ laptop, deskId: desk.def.id, gone: 0 });
  }

  /** Whether someone sent home from `deskId` is still sitting there, packing up. */
  seated(deskId: string): boolean {
    return this.leavers.some((l) => l.deskId === deskId && l.next === 0);
  }

  /** Someone new sat down at `deskId`: the old laptop goes at once, and whoever was packing there gets up. */
  vacate(deskId: string) {
    for (const c of this.laptops) if (c.deskId === deskId) this.dropLaptop(c);
    this.laptops = this.laptops.filter((c) => c.deskId !== deskId);
    for (const l of this.leavers) {
      if (l.deskId !== deskId) continue;
      l.t = Math.max(l.t, PACK + HOP);
      l.chair = null;
    }
  }

  /** Off to another floor: nobody from this one is left walking out. */
  clear() {
    const [laptops, leavers] = [this.laptops, this.leavers];
    this.laptops = [];
    this.leavers = [];
    for (const c of laptops) this.dropLaptop(c);
    for (const l of leavers) this.drop(l);
  }

  /** Where each of them is, for the doors to open. */
  positions(): THREE.Vector3[] {
    return this.leavers.map((l) => l.model.root.position);
  }

  update(dt: number, t: number) {
    this.laptops = this.laptops.filter((c) => {
      if (!c.laptop.shut(dt)) return true;
      c.gone = Math.min(1, c.gone + dt / LAPTOP_GONE);
      c.laptop.root.scale.setScalar(Math.max(0.001, 1 - c.gone * c.gone));
      if (c.gone < 1) return true;
      this.dropLaptop(c);
      return false;
    });
    this.leavers = this.leavers.filter((l) => {
      const here = this.step(l, dt);
      l.model.update(dt, t);
      if (!here) this.drop(l);
      return here;
    });
  }

  /** Moves one along; false once it's gone. */
  private step(l: Leaver, dt: number): boolean {
    l.t += dt;
    const { root } = l.model;
    const pos = root.position;
    l.model.walking = false;
    if (l.chair && l.spin) {
      l.chair.rotation.y += l.spin * dt;
      l.spin *= Math.exp(-dt * 1.4);
      if (Math.abs(l.spin) < 0.05) l.spin = 0;
    }
    if (l.t < PACK) return true;
    const [x0, z0] = l.way[0];
    if (l.next === 0) {
      const floor = this.ground(x0, z0, l.seat.y) - FEET;
      if (l.t < PACK + HOP) {
        // Down off the seat in a little arc, turning round on the way to face where it's going.
        const p = (l.t - PACK) / HOP;
        if (l.chair && !l.spin) l.spin = (Math.random() < 0.5 ? -1 : 1) * (5 + Math.random() * 3);
        pos.set(THREE.MathUtils.lerp(l.seat.x, x0, p), THREE.MathUtils.lerp(l.seat.y, floor, p) + Math.sin(p * Math.PI) * 0.35, THREE.MathUtils.lerp(l.seat.z, z0, p));
        const [x1, z1] = l.way[1];
        root.rotation.y += wrap(Math.atan2(x1 - x0, z1 - z0) - root.rotation.y) * Math.min(1, dt * 7);
        return true;
      }
      pos.set(x0, floor, z0);
      l.next = 1;
      this.onUp(l.deskId);
    }
    const c = l.chute;
    if (c && c.phase !== 'walk' && c.phase !== 'off') return this.jump(l, c, dt);
    let move = PACE * dt;
    while (move > 0 && l.next < l.way.length) {
      const [x, z] = l.way[l.next];
      const dx = x - pos.x;
      const dz = z - pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4) l.heading = Math.atan2(dx, dz);
      if (d <= move) {
        pos.x = x;
        pos.z = z;
        move -= d;
        l.next++;
      } else {
        pos.x += (dx / d) * move;
        pos.z += (dz / d) * move;
        move = 0;
      }
    }
    // Down the steps a stair at a time.
    const g = this.ground(pos.x, pos.z, pos.y + FEET) - FEET;
    pos.y += (g - pos.y) * Math.min(1, dt * 14);
    root.rotation.y += wrap(l.heading - root.rotation.y) * Math.min(1, dt * 8);
    if (l.next < l.way.length) {
      l.model.walking = true;
      return true;
    }
    if (c?.phase === 'walk') {
      // At the railing: up and over it.
      c.phase = 'climb';
      c.t = 0;
      c.from.copy(pos);
      return true;
    }
    // Off down the sidewalk: gone.
    l.gone = Math.min(1, l.gone + dt / GONE);
    root.scale.setScalar(Math.max(0.001, l.scale * (1 - l.gone * l.gone)));
    return l.gone < 1;
  }

  /** Over the balcony railing and down by parachute, then onto its feet on the lot out front. */
  private jump(l: Leaver, c: Chute, dt: number): boolean {
    c.t += dt;
    const { root } = l.model;
    const pos = root.position;
    const turn = (to: number, rate: number) => (root.rotation.y += wrap(to - root.rotation.y) * Math.min(1, dt * rate));
    if (c.phase === 'climb') {
      // Up onto the top rail in a little hop, turning to face out over the street.
      const p = Math.min(1, c.t / CLIMB);
      const e = p * p * (3 - 2 * p);
      pos.set(c.from.x, THREE.MathUtils.lerp(c.from.y, PARACHUTE.railTop - FEET, e) + Math.sin(p * Math.PI) * 0.35, THREE.MathUtils.lerp(c.from.z, BALCONY.maxZ - 0.06, e));
      turn(0, 8);
      if (p < 1) return true;
      c.phase = 'teeter';
      c.t = 0;
      l.model.say(pick(JUMPS));
      return true;
    }
    if (c.phase === 'teeter') {
      // A wobble up there, then the leap.
      root.rotation.z = Math.sin(c.t * 11) * 0.1 * (1 - c.t / TEETER);
      turn(0, 8);
      if (c.t < TEETER) return true;
      root.rotation.z = 0;
      c.phase = 'fall';
      c.t = 0;
      c.vel.set(0, LEAP.up, LEAP.out);
      return true;
    }
    if (c.phase === 'fall') {
      c.vel.y -= GRAVITY * dt;
      pos.addScaledVector(c.vel, dt);
      // Tumbling forward a little on the way down.
      root.rotation.x = Math.min(0.6, c.t * 0.9);
      if (c.t < FREEFALL) return true;
      // The chute pops open, and it'll circle down onto a spot out on the lot.
      const chute = parachute(c.color);
      chute.group.scale.setScalar(0.05);
      root.add(chute.group);
      c.canopy = chute;
      const [e0, e1] = PARACHUTE.east;
      const x = pos.x + e0 + Math.random() * (e1 - e0);
      const z = pos.z + PARACHUTE.out;
      c.land.set(x, this.ground(x, z, pos.y) - FEET, z);
      c.radius = Math.hypot(pos.x - x, pos.z - z);
      c.angle = Math.atan2(pos.x - x, pos.z - z);
      c.height = Math.max(0.1, pos.y - c.land.y);
      c.phase = 'glide';
      c.t = 0;
      return true;
    }
    const canopy = c.canopy!;
    if (c.phase === 'glide') {
      // Open with a pop that overshoots a little, then swaying under it on the way down.
      const p = Math.min(1, c.t / POP);
      const u = p - 1;
      canopy.group.scale.setScalar(Math.max(0.05, 1 + 2.7 * u * u * u + 1.7 * u * u));
      canopy.group.rotation.z = Math.sin(c.t * 1.9) * 0.08;
      root.rotation.x *= Math.exp(-dt * 4);
      const h = pos.y - c.land.y;
      const sink = THREE.MathUtils.clamp(h / SINK.per, SINK.min, SINK.max);
      c.vel.y += (-sink - c.vel.y) * Math.min(1, dt * 4);
      pos.y += c.vel.y * dt;
      // Round and round, closing in on the spot as it gets lower.
      c.angle += TURN * dt;
      const r = c.radius * THREE.MathUtils.clamp(h / c.height, 0, 1);
      const x = c.land.x + Math.sin(c.angle) * r;
      const z = c.land.z + Math.cos(c.angle) * r;
      const k = Math.min(1, dt * 3);
      const dx = (x - pos.x) * k;
      const dz = (z - pos.z) * k;
      pos.x += dx;
      pos.z += dz;
      if (Math.hypot(dx, dz) > 1e-4) l.heading = Math.atan2(dx, dz);
      turn(l.heading, 3);
      if (pos.y > c.land.y) return true;
      // Down.
      pos.y = c.land.y;
      root.rotation.x = 0;
      c.phase = 'down';
      c.t = 0;
      return true;
    }
    // On the ground: the chute sags down behind it and is bundled away, and off it goes.
    const p = Math.min(1, c.t / CRUMPLE);
    canopy.group.rotation.set(-1.35 * Math.min(1, p * 1.6), 0, 0);
    canopy.dome.scale.y = 0.62 * (1 - 0.65 * p);
    canopy.group.scale.setScalar(Math.max(0.001, 1 - Math.max(0, (p - 0.55) / 0.45) ** 2));
    if (p < 1) return true;
    this.dropChute(c);
    c.phase = 'off';
    l.way = walkOff([pos.x, pos.z]);
    l.next = 1;
    return true;
  }

  private dropChute(c: Chute) {
    if (!c.canopy) return;
    c.canopy.group.removeFromParent();
    c.canopy.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    c.canopy = null;
  }

  private drop(l: Leaver) {
    if (l.next === 0) this.onUp(l.deskId);
    if (l.chute) this.dropChute(l.chute);
    l.model.root.removeFromParent();
    l.model.dispose();
  }

  private dropLaptop(c: Closing) {
    c.laptop.root.removeFromParent();
    c.laptop.dispose();
  }
}
