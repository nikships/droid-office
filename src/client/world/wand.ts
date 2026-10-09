import * as THREE from 'three';
import { type FlashLight, Muzzle, magnum } from './gun';
import { GUN_TRICKS } from './gun-motion';
import { toonUnique } from './toon';

/**
 * The magic wand: the PG stand-in for the .44 Magnum (Settings → You). It sits in the same frame
 * as magnum(), so every holder and every move in gun-motion.ts works on it unchanged: the fist
 * closes round a carved handle at the origin (hidden in the glove, where the magnum's grip is) and
 * the shaft runs out along +Z, +Y up, to a glowing star at its tip. Built from primitives, nothing
 * loaded, and nothing in it is shared, so disposeGun frees all of it.
 * No DOM or WebGL at import time, so tests can load it in Node.
 */

/** What `7` puts in your hand: the wand (the default) or the original .44 Magnum. */
export type Sidearm = 'wand' | 'magnum';

/** The wand's star tip, where a spell leaves it. */
export const WAND_TIP = new THREE.Vector3(0, 0.046, 0.33);
/** How far the shaft runs, back from the tip, before it goes into the fist. */
const SHAFT_FROM = -0.012;
/** Where the shaft's centre line sits, level with the top of the fist. */
const SHAFT_Y = 0.046;

/** A spell lighting up the room round the tip: softer and further reaching than a muzzle flash. */
const WAND_FLASH: FlashLight = { color: '#c79bff', intensity: 9, distance: 6, decay: 2, ahead: 0.05 };
const WAND_FLASH_COLORS = { core: '#ffffff', star: '#c77dff' };

/** The wand's tricks: the gun's moves (same ids and keys), named for a wand. */
const WAND_TRICK_NAMES: Record<(typeof GUN_TRICKS)[number]['id'], { emoji: string; label: string }> = {
  twirl: { emoji: '🌀', label: 'Twirl' },
  inspect: { emoji: '🔍', label: 'Admire it' },
  cylinder: { emoji: '✨', label: 'Charge it up' },
  yy: { emoji: '⚡', label: 'Flourish' },
  smoke: { emoji: '💨', label: 'Blow out the sparkles' },
  toss: { emoji: '🪙', label: 'Flip it' },
};
export const WAND_TRICKS = GUN_TRICKS.map((t) => ({ id: t.id, ...WAND_TRICK_NAMES[t.id] }));

/** The tricks for what's in your hand, in key order (1–6) and round the wheel. */
export function tricksFor(sidearm: Sidearm): readonly { id: (typeof GUN_TRICKS)[number]['id']; emoji: string; label: string }[] {
  return sidearm === 'wand' ? WAND_TRICKS : GUN_TRICKS;
}

/** A five-pointed star in the XY plane, facing +Z, `r` from its middle to a point. */
function starShape(r: number): THREE.Shape {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 5;
    const d = i % 2 ? r * 0.45 : r;
    if (i) s.lineTo(Math.cos(a) * d, Math.sin(a) * d);
    else s.moveTo(Math.cos(a) * d, Math.sin(a) * d);
  }
  s.closePath();
  return s;
}

/** A wand: carved handle, purple shaft with gold bands, and a glowing star on the end. */
export function wand(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'wand';
  const wood = toonUnique('#3b2416');
  const shaftMat = toonUnique('#6a3fb0');
  const gold = toonUnique('#e5b84b');
  // Inside the fist, slanted like the magnum's grip, so the glove closes round something.
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.017, 0.11, 12), wood);
  handle.name = 'wand-handle';
  handle.position.set(0, -0.03, -0.016);
  handle.rotation.x = 0.12;
  group.add(handle);
  const length = WAND_TIP.z - SHAFT_FROM;
  // Cylinders stand along +Y; laid along +Z, their top (the thin end) ends up at the tip.
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.0095, length, 10).rotateX(Math.PI / 2), shaftMat);
  shaft.name = 'wand-shaft';
  shaft.position.set(0, SHAFT_Y, SHAFT_FROM + length / 2);
  group.add(shaft);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.016, 14).rotateX(Math.PI / 2), gold);
  collar.name = 'wand-collar';
  collar.position.set(0, SHAFT_Y, 0.012);
  group.add(collar);
  for (const [i, z] of [0.09, 0.17, 0.25].entries()) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.0092 - i * 0.0015, 0.0092 - i * 0.0015, 0.006, 10).rotateX(Math.PI / 2), gold);
    band.name = 'wand-band';
    band.position.set(0, SHAFT_Y, z);
    group.add(band);
  }
  const star = new THREE.Mesh(new THREE.ExtrudeGeometry(starShape(0.03), { depth: 0.008, bevelEnabled: false }).translate(0, 0, -0.004), new THREE.MeshBasicMaterial({ color: '#ffe680' }));
  star.name = 'wand-star';
  star.position.copy(WAND_TIP);
  group.add(star);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 10), new THREE.MeshBasicMaterial({ color: '#c77dff', transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }));
  halo.name = 'wand-halo';
  halo.position.copy(WAND_TIP);
  group.add(halo);
  return group;
}

/** What a holder puts in the fist for `sidearm`: the prop, and the flash (a spell or a muzzle flash) at its end. */
export function sidearmProp(sidearm: Sidearm): { prop: THREE.Group; muzzle: Muzzle } {
  if (sidearm === 'magnum') return { prop: magnum(), muzzle: new Muzzle() };
  return { prop: wand(), muzzle: new Muzzle(WAND_FLASH, WAND_TIP, WAND_FLASH_COLORS) };
}

/** Sparkles for a spell landing on a worker: pink, lilac, mint and gold. */
export const SPELL_HIT = ['#ffd6ff', '#c77dff', '#80ffdb', '#fff3b0', '#ff9ecd'];
/** A spell fizzling out on a wall or the floor. */
export const SPELL_MISS = ['#c77dff', '#9bf6ff', '#ffffff'];
/** Glitter off the wand's tip as it casts. */
export const SPELL_TIP = ['#fff3b0', '#ffd6ff', '#c77dff'];

let sparkleGeo: THREE.OctahedronGeometry | null = null;

/**
 * A burst of twinkling sparkles at `at`, flung out along `out` (or every way) and drifting up as
 * they fade. update() returns false once they're gone.
 */
export class Sparkles {
  readonly group = new THREE.Group();
  private t = 0;
  private bits: { mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>; vel: THREE.Vector3; size: number; phase: number; spin: number }[] = [];
  private shape = (sparkleGeo ??= new THREE.OctahedronGeometry(1, 0));

  constructor(
    at: THREE.Vector3,
    out: THREE.Vector3 | null,
    private o: { colors?: readonly string[]; count?: number; speed?: number; size?: number; seconds?: number } = {},
  ) {
    this.group.position.copy(at);
    const colors = o.colors ?? SPELL_HIT;
    const count = o.count ?? 14;
    const speed = o.speed ?? 1.4;
    const size = o.size ?? 0.022;
    const away = out?.clone().normalize() ?? null;
    for (let i = 0; i < count; i++) {
      const vel = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      if (away) vel.addScaledVector(away, speed * 0.7);
      const mesh = new THREE.Mesh(this.shape, new THREE.MeshBasicMaterial({ color: colors[i % colors.length], transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
      const s = size * (0.6 + Math.random() * 0.8);
      mesh.scale.set(s * 0.6, s, s * 0.6);
      this.group.add(mesh);
      this.bits.push({ mesh, vel, size: s, phase: Math.random() * Math.PI * 2, spin: (Math.random() - 0.5) * 12 });
    }
  }

  /** Moves the sparkles along; false once they've faded. */
  update(dt: number): boolean {
    this.t += dt;
    const p = Math.min(1, this.t / (this.o.seconds ?? 0.9));
    for (const b of this.bits) {
      b.mesh.position.addScaledVector(b.vel, dt);
      b.vel.multiplyScalar(Math.exp(-dt * 3.2));
      b.vel.y += dt * 0.6;
      b.mesh.rotation.y += b.spin * dt;
      const twinkle = 0.65 + 0.35 * Math.sin(this.t * 22 + b.phase);
      const s = b.size * twinkle * (1 - p * p);
      b.mesh.scale.set(Math.max(1e-4, s * 0.6), Math.max(1e-4, s), Math.max(1e-4, s * 0.6));
      b.mesh.material.opacity = 1 - p;
    }
    return p < 1;
  }

  /** Frees its materials; the shared shape stays for the next burst. */
  dispose() {
    for (const b of this.bits) b.mesh.material.dispose();
  }
}

/** How long a spell's streak hangs between the wand and where it landed, in seconds. */
const BOLT_TIME = 0.28;

/** The spell's streak from the wand's tip to where it landed, fading from the tip out. */
export class SpellBolt {
  readonly group = new THREE.Group();
  private t = 0;
  private core: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private glow: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

  constructor(from: THREE.Vector3, to: THREE.Vector3) {
    const length = Math.max(0.01, from.distanceTo(to));
    const additive = (color: string, opacity: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
    // Along +Z from the tip, then turned to face where it landed.
    this.core = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, length, 6).rotateX(Math.PI / 2).translate(0, 0, length / 2), additive('#ffffff', 0.95));
    this.glow = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, length, 8).rotateX(Math.PI / 2).translate(0, 0, length / 2), additive('#c77dff', 0.5));
    this.group.add(this.core, this.glow);
    this.group.position.copy(from);
    this.group.lookAt(to);
  }

  update(dt: number): boolean {
    this.t += dt;
    const k = Math.max(0, 1 - this.t / BOLT_TIME);
    this.core.material.opacity = 0.95 * k;
    this.glow.material.opacity = 0.5 * k;
    this.glow.scale.set(1 + (1 - k), 1 + (1 - k), 1);
    return k > 0;
  }

  dispose() {
    for (const m of [this.core, this.glow]) {
      m.geometry.dispose();
      m.material.dispose();
    }
  }
}
