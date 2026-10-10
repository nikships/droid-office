import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { glyphFlat } from './glyph3d';
import { toonUnique } from './toon';

/**
 * The droid wand: what `7` puts in your hand unless you opted into the .44 Magnum (Settings → You).
 * A vibe-coding wizard's wand built like a Factory tool, from `wand.glb` (tools/props/generate.py):
 * a steel pommel with the pinwheel inlaid in its end, an orange signal ring, a grooved octagonal
 * graphite grip, a telescoping graphite shaft with a ten-segment orange progress bar along it,
 * and at the tip the pinwheel itself as a ducted rotor, with an orange emitter crystal in front.
 *
 * Wand space, in meters: the origin is the middle of the grip, where the fist closes; the shaft
 * runs out along +Z and +Y is up (the progress bar is on top). The rotor spins, the emitter
 * lights and the progress bar fills while you hold it (Wand.update).
 *
 * Also here: the spells' effects in the world (SpellBolt, SpellImpact, TipTrail, Sparkles)
 * and the Protego ward in front of your eyes (Ward). Factory's palette: orange, white and steel.
 * No DOM or WebGL at import time, so tests can load it in Node.
 */

/** What `7` puts in your hand: the wand (the default) or the original .44 Magnum. */
export type Sidearm = 'wand' | 'magnum';

// These must match WAND in tools/props/generate.py.
/** The point of the emitter crystal, where a spell leaves the wand. */
export const WAND_TIP = new THREE.Vector3(0, 0, 0.284);
/** The middle of the emitter crystal. */
export const CORE_AT = new THREE.Vector3(0, 0, 0.2782);
/** The rotor's hub, on the shaft's axis. */
export const ROTOR_AT = new THREE.Vector3(0, 0, 0.2745);
/** The back of the pommel. */
export const WAND_BACK = -0.064;
/** The grip's radius to a corner of its octagon, and where it runs, back to front. */
export const GRIP_R = 0.0093;
export const GRIP_Z: readonly [number, number] = [-0.0486, 0.037];
/** How many segments the progress bar has. */
export const WAND_SEGMENTS = 10;

/** Factory's orange, its bright hover and deep variants, and the off-white the glyph is drawn in. */
const ORANGE = '#ee6018';
const ORANGE_HOT = '#ff8a4a';
const ORANGE_DEEP = '#d15010';
const WHITE = '#eeeeee';
/** An unlit segment of the progress bar: the orange, dark. */
const SEGMENT_OFF = '#3d1605';

/** How fast the rotor turns, idling and flat out, in radians a second. */
const ROTOR_IDLE = 2.2;
const ROTOR_FULL = 46;

/** What each part of wand.glb is called in a wand, by its material in the generator. */
const PARTS: Record<string, string> = {
  WandGraphite: 'wand-shaft',
  WandGrip: 'wand-grip',
  WandSteel: 'wand-steel',
  WandLight: 'wand-inlay',
  WandOrange: 'wand-rings',
};

/** wand.glb's meshes, toon-shaded, which every wand shares. Segments get their own material per wand. */
interface Model {
  body: THREE.Mesh[];
  rotor: THREE.Mesh[];
  core: THREE.Mesh[];
  segments: THREE.Mesh[];
}
let model: Model | null = null;
/** What the shared model is made of: Wand.dispose leaves it for the next wand. */
const shared = new WeakSet<object>();
/** Wands made before the model arrived, filled in when it does. */
const waiting = new Set<Wand>();

/**
 * Takes wand.glb's scene (as GLTFLoader gives it) as the model every wand is made from, and fills
 * in any wand made before it arrived. Its materials become toon ones of the same colors; the
 * orange ones glow a little, the way the office's own orange trim does.
 */
export function setWandModel(scene: THREE.Object3D) {
  const toons = new Map<string, THREE.MeshToonMaterial>();
  const part = (source: THREE.Mesh, name?: string): THREE.Mesh => {
    const from = source.material as THREE.MeshStandardMaterial;
    let material = toons.get(from.name);
    if (!material) {
      material = toonUnique(from.color);
      material.name = from.name;
      if (from.name === 'WandOrange') material.emissive.set(ORANGE_DEEP).multiplyScalar(0.55);
      toons.set(from.name, material);
      shared.add(material);
    }
    const mesh = new THREE.Mesh(source.geometry, material);
    mesh.name = name ?? PARTS[from.name] ?? from.name;
    shared.add(source.geometry);
    return mesh;
  };
  const next: Model = { body: [], rotor: [], core: [], segments: [] };
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    // A node's mesh may come as its own object or, with one material, as the node itself.
    const node = o.name.startsWith('wand-') ? o.name : (o.parent?.name ?? '');
    if (node === 'wand-rotor') next.rotor.push(part(o, 'wand-rotor'));
    else if (node === 'wand-core') next.core.push(part(o, 'wand-core'));
    else if (node.startsWith('wand-segment-')) next.segments[Number(node.slice('wand-segment-'.length))] = part(o, node);
    else next.body.push(part(o));
  });
  model = next;
  for (const w of waiting) w.fill();
  waiting.clear();
}

/** Loads wand.glb from its bytes (tests read it off disk; the office loads it with the props). */
export function parseWand(glb: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(
      glb,
      '',
      (gltf) => {
        setWandModel(gltf.scene);
        resolve();
      },
      reject,
    );
  });
}

/** True once the model is in, so a new Wand comes back whole. */
export function wandReady(): boolean {
  return model !== null;
}

let glowTex: THREE.DataTexture | null = null;

/**
 * A soft round spot, white in the middle and falling off to nothing at the edge, for the light
 * at the tip and the spells' heads. Built from numbers, so it needs no canvas.
 */
export function glowTexture(): THREE.DataTexture {
  if (glowTex) return glowTex;
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
      const a = Math.max(0, 1 - d) ** 2.2;
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  glowTex = new THREE.DataTexture(data, n, n);
  glowTex.needsUpdate = true;
  return glowTex;
}

/** An additive glow in `color`, `size` meters across, facing the camera. */
function glowSprite(color: THREE.ColorRepresentation, size: number, opacity = 1): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
  s.scale.setScalar(size);
  return s;
}

/** What drives a wand each frame: the pose's spin, glow and charge, and Lumos (0 out … 1 lit). */
export interface WandDrive {
  spin: number;
  glow: number;
  charge: number;
  lumos: number;
}

/**
 * One wand in a hand. The body, the rotor on its hub, the emitter and the ten segments of the
 * progress bar, each segment with its own material so it can light on its own; a glow at the tip
 * and a light that throws it on the glove holding it. update() turns the rotor and lights the rest.
 */
export class Wand {
  readonly group = new THREE.Group();
  /** The rotor's hub, turned about +Z. */
  readonly rotor = new THREE.Group();
  /** The point of the emitter: spells leave from here. */
  readonly tip = new THREE.Object3D();
  private core = new THREE.Group();
  private segments: THREE.MeshToonMaterial[] = [];
  private coreMat: THREE.MeshToonMaterial | null = null;
  private halo: THREE.Sprite;
  private spark: THREE.Sprite;
  private light: THREE.PointLight;
  private t = Math.random() * 10;

  constructor() {
    this.group.name = 'wand';
    this.rotor.name = 'wand-rotor-hub';
    this.rotor.position.copy(ROTOR_AT);
    this.core.position.copy(CORE_AT);
    this.tip.position.copy(WAND_TIP);
    this.group.add(this.rotor, this.core, this.tip);
    // The emitter's glow: a soft orange bloom round it, a hot white point in its middle.
    this.halo = glowSprite(ORANGE, 0.05, 0);
    this.spark = glowSprite('#fff4ea', 0.018, 0);
    this.halo.position.copy(CORE_AT);
    this.spark.position.copy(CORE_AT);
    this.group.add(this.halo, this.spark);
    this.light = new THREE.PointLight('#ffb27a', 0, 0.8, 2);
    this.light.position.copy(WAND_TIP);
    this.group.add(this.light);
    if (model) this.fill();
    else waiting.add(this);
  }

  /** True once the model's meshes are in. */
  get whole(): boolean {
    return this.segments.length > 0;
  }

  /** Puts the model's meshes in (now, or when the model arrives). */
  fill() {
    const m = model;
    if (!m || this.whole) return;
    const copy = (s: THREE.Mesh, material: THREE.Material = s.material as THREE.Material) => Object.assign(new THREE.Mesh(s.geometry, material), { name: s.name });
    this.group.add(...m.body.map((s) => copy(s)));
    this.rotor.add(...m.rotor.map((s) => copy(s)));
    this.coreMat = toonUnique(ORANGE);
    this.core.add(...m.core.map((s) => copy(s, this.coreMat!)));
    for (const s of m.segments) {
      const mat = toonUnique(SEGMENT_OFF);
      this.segments.push(mat);
      this.group.add(copy(s, mat));
    }
  }

  /** How many segments of the progress bar are lit for `charge` (0 … 1). */
  static litSegments(charge: number): number {
    return Math.round(THREE.MathUtils.clamp(charge, 0, 1) * WAND_SEGMENTS);
  }

  update(dt: number, d: WandDrive) {
    this.t += dt;
    this.rotor.rotation.z -= dt * (ROTOR_IDLE + (ROTOR_FULL - ROTOR_IDLE) * d.spin * d.spin + 9 * d.lumos);
    // The emitter breathes gently while idle, and burns bright with a spell or Lumos.
    const idle = 0.18 + 0.06 * Math.sin(this.t * 2.6);
    const lit = Math.min(1, Math.max(idle, d.glow, d.lumos * 0.85));
    if (this.coreMat) this.coreMat.emissive.set(ORANGE_HOT).multiplyScalar(0.25 + 1.4 * lit);
    this.halo.material.opacity = Math.min(1, 0.15 + lit * 0.9);
    this.halo.scale.setScalar(0.03 + 0.05 * d.glow + 0.07 * d.lumos);
    this.spark.material.opacity = Math.min(1, lit * 1.2);
    this.spark.scale.setScalar(0.012 + 0.02 * Math.max(d.glow, d.lumos));
    this.light.intensity = 0.02 + 0.5 * d.glow + 0.35 * d.lumos;
    this.light.distance = 0.6 + 0.6 * d.lumos;
    // The bar fills from the grip toward the tip; with the wand idle a single segment sweeps along it, like a build waiting.
    const on = Wand.litSegments(d.charge);
    const sweep = d.charge > 0.02 ? -1 : Math.floor(this.t * 6) % (WAND_SEGMENTS + 6);
    this.segments.forEach((mat, i) => {
      const live = i < on || i === sweep;
      mat.color.set(live ? ORANGE : SEGMENT_OFF);
      mat.emissive.set(live ? ORANGE_HOT : '#000000').multiplyScalar(live ? (i === sweep && i >= on ? 0.5 : 1.1) : 0);
    });
  }

  /** Where the tip is, in the frame of `of` (the hands' scene: camera space). */
  tipIn(out: THREE.Vector3): THREE.Vector3 {
    return this.tip.getWorldPosition(out);
  }

  /** Takes the wand out of the hand holding it and frees what's its own; the model stays. */
  dispose() {
    this.group.removeFromParent();
    waiting.delete(this);
    const freed = new Set<{ dispose(): void }>();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && !shared.has(m.geometry)) freed.add(m.geometry);
      for (const material of [m.material ?? []].flat()) if (!shared.has(material)) freed.add(material);
    });
    for (const r of freed) r.dispose();
  }
}

/** Sparks for a spell landing on a worker: white-hot, orange and pale peach. */
export const SPELL_HIT = ['#ffffff', ORANGE, ORANGE_HOT, '#ffd8c2', WHITE];
/** A spell fizzling out on a wall or the floor: orange, steel and white. */
export const SPELL_MISS = [ORANGE, '#8c8c8c', '#ffffff'];
/** Sparks shaken off the tip as it casts. */
export const SPELL_TIP = ['#ffffff', ORANGE_HOT, ORANGE];
/** Ship it's confetti: Factory's oranges, white and steel. */
export const SPELL_CONFETTI = [ORANGE, ORANGE_HOT, ORANGE_DEEP, WHITE, '#ffffff', '#8c8c8c'];

let sparkleGeo: THREE.OctahedronGeometry | null = null;

/**
 * A burst of glinting sparks at `at`, flung out along `out` (or every way) and drifting up as
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
    private o: { colors?: readonly string[]; count?: number; speed?: number; size?: number; seconds?: number; lift?: number } = {},
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

  /** Moves the sparks along; false once they've faded. */
  update(dt: number): boolean {
    this.t += dt;
    const p = Math.min(1, this.t / (this.o.seconds ?? 0.9));
    for (const b of this.bits) {
      b.mesh.position.addScaledVector(b.vel, dt);
      b.vel.multiplyScalar(Math.exp(-dt * 3.2));
      b.vel.y += dt * (this.o.lift ?? 0.6);
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

/** How fast a cast bolt flies, in meters a second, and the longest it takes to land. */
export const BOLT_SPEED = 30;
const BOLT_MAX = 0.6;
/** How long a bolt's tail takes to fade after it lands, in seconds. */
const BOLT_TAIL = 0.22;
/** How many glows make up a bolt's tail. */
const TAIL = 14;

/**
 * A cast bolt: a white-hot head in an orange bloom, flying from the tip to where it lands with a
 * comet's tail behind it and a thin streak back toward the wand. `onLand` runs once, the frame it
 * gets there; the tail then fades. update() returns false once it's gone.
 */
export class SpellBolt {
  readonly group = new THREE.Group();
  private t = 0;
  private landedAt = -1;
  private from: THREE.Vector3;
  private to: THREE.Vector3;
  private seconds: number;
  private head: THREE.Sprite;
  private bloom: THREE.Sprite;
  private tail: THREE.Sprite[] = [];
  private streak: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private dir: THREE.Vector3;
  private at = new THREE.Vector3();

  constructor(
    from: THREE.Vector3,
    to: THREE.Vector3,
    private onLand?: () => void,
  ) {
    this.from = from.clone();
    this.to = to.clone();
    const length = from.distanceTo(to);
    this.seconds = Math.min(BOLT_MAX, Math.max(0.03, length / BOLT_SPEED));
    this.dir = to.clone().sub(from).normalize();
    this.bloom = glowSprite(ORANGE, 0.16, 0.95);
    this.head = glowSprite('#ffffff', 0.055, 1);
    for (let i = 0; i < TAIL; i++) this.tail.push(glowSprite(i % 3 ? ORANGE : ORANGE_HOT, 0.09 * (1 - i / TAIL) + 0.012, 0.8 * (1 - i / TAIL)));
    this.streak = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0035, 0.0035, 1, 5).rotateX(Math.PI / 2).translate(0, 0, -0.5),
      new THREE.MeshBasicMaterial({ color: ORANGE_HOT, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.group.add(this.streak, ...this.tail, this.bloom, this.head);
    this.place(0);
  }

  /** Seconds from the tip to where it lands. */
  get flight(): number {
    return this.seconds;
  }

  get landed(): boolean {
    return this.landedAt >= 0;
  }

  update(dt: number): boolean {
    this.t += dt;
    if (this.landedAt < 0 && this.t >= this.seconds) {
      this.landedAt = this.t;
      this.onLand?.();
    }
    this.place(Math.min(1, this.t / this.seconds));
    if (this.landedAt < 0) return true;
    const k = Math.max(0, 1 - (this.t - this.landedAt) / BOLT_TAIL);
    this.head.material.opacity = 0;
    this.bloom.material.opacity = 0.95 * k * k;
    this.streak.material.opacity = 0.85 * k;
    for (const [i, s] of this.tail.entries()) s.material.opacity = 0.8 * (1 - i / TAIL) * k;
    return k > 0;
  }

  /** The head `p` of the way there, its tail strung out behind it toward the tip. */
  private place(p: number) {
    const length = this.from.distanceTo(this.to);
    const travelled = length * p;
    this.at.copy(this.from).addScaledVector(this.dir, travelled);
    this.head.position.copy(this.at);
    this.bloom.position.copy(this.at);
    this.bloom.material.rotation = this.t * 9;
    const tailLen = Math.min(travelled, 0.9);
    for (const [i, s] of this.tail.entries()) s.position.copy(this.at).addScaledVector(this.dir, -(tailLen * i) / TAIL);
    this.streak.position.copy(this.at);
    this.streak.lookAt(this.at.clone().add(this.dir));
    this.streak.scale.set(1, 1, Math.max(0.001, Math.min(travelled, 2.2)));
  }

  dispose() {
    this.streak.geometry.dispose();
    this.streak.material.dispose();
    for (const s of [this.head, this.bloom, ...this.tail]) s.material.dispose();
  }
}

let sigilGeo: THREE.BufferGeometry | null = null;
let ringGeo: THREE.RingGeometry | null = null;

/** How long a spell's mark stays where it landed, in seconds. */
const IMPACT_TIME = 0.6;

/**
 * Where a spell lands: the pinwheel flashing out flat on what it struck, spinning as it grows and
 * fades, inside a hairline ring racing outward, and sparks flung back off it. `hit` is a worker
 * (a bigger, brighter mark); otherwise it's a wall or the floor.
 */
export class SpellImpact {
  readonly group = new THREE.Group();
  private t = 0;
  private sigil: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private ring: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private flash: THREE.Sprite;
  private sparks: Sparkles;
  private size: number;

  constructor(at: THREE.Vector3, normal: THREE.Vector3 | null, hit: boolean) {
    this.size = hit ? 0.5 : 0.32;
    const face = (normal ?? new THREE.Vector3(0, 1, 0)).clone().normalize();
    const additive = (color: string, opacity: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.sigil = new THREE.Mesh((sigilGeo ??= glyphFlat(1, 6)), additive(ORANGE_HOT, 1));
    this.ring = new THREE.Mesh((ringGeo ??= new THREE.RingGeometry(0.96, 1, 48)), additive(WHITE, 0.9));
    const mark = new THREE.Group();
    mark.add(this.sigil, this.ring);
    // Flat on the surface, a hair off it so it doesn't flicker into it.
    mark.position.copy(at).addScaledVector(face, 0.006);
    mark.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), face);
    this.flash = glowSprite('#ffffff', hit ? 0.5 : 0.3, 1);
    this.flash.position.copy(at).addScaledVector(face, 0.03);
    this.sparks = new Sparkles(at, face, { colors: hit ? SPELL_HIT : SPELL_MISS, count: hit ? 22 : 11, speed: hit ? 1.8 : 1.1, size: hit ? 0.022 : 0.016, seconds: hit ? 0.95 : 0.6 });
    this.group.add(mark, this.flash, this.sparks.group);
    this.sparks.group.position.copy(at);
    this.place(0);
  }

  update(dt: number): boolean {
    this.t += dt;
    const sparks = this.sparks.update(dt);
    const p = Math.min(1, this.t / IMPACT_TIME);
    this.place(p);
    return p < 1 || sparks;
  }

  private place(p: number) {
    const grow = 1 - (1 - p) ** 3;
    this.sigil.scale.setScalar(this.size * (0.35 + 0.65 * grow));
    this.sigil.rotation.z = -p * 2.4;
    this.sigil.material.opacity = (1 - p) ** 1.5;
    this.ring.scale.setScalar(this.size * (0.3 + 1.1 * grow));
    this.ring.material.opacity = 0.9 * (1 - p) ** 2;
    this.flash.material.opacity = Math.max(0, 1 - p * 4);
  }

  dispose() {
    this.sigil.material.dispose();
    this.ring.material.dispose();
    this.flash.material.dispose();
    this.sparks.dispose();
  }
}

/** How many motes a trail can hold, and how long each lasts, in seconds. */
const TRAIL_SIZE = 220;
const TRAIL_LIFE = 0.5;

/**
 * The light the wand's tip leaves behind it as it moves through a spell: motes laid down along the
 * tip's path that hang where they were left, drift and fade, so a swish draws its arc in the air.
 * One per office; emit() as often as there's a tip to follow.
 */
export class TipTrail {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private age: Float32Array;
  private vel: Float32Array;
  private next = 0;
  private last: THREE.Vector3 | null = null;
  private live = 0;
  private hot = new THREE.Color(ORANGE_HOT);
  private white = new THREE.Color('#ffffff');

  constructor() {
    this.pos = new Float32Array(TRAIL_SIZE * 3);
    this.col = new Float32Array(TRAIL_SIZE * 3);
    this.vel = new Float32Array(TRAIL_SIZE * 3);
    this.age = new Float32Array(TRAIL_SIZE).fill(TRAIL_LIFE);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.03, map: glowTexture(), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
    this.points.frustumCulled = false;
    this.points.name = 'wand-trail';
  }

  /** Lays motes from where the tip was to `at`, `amount` (0 … 1) as thick as a full trail. */
  emit(at: THREE.Vector3, amount: number) {
    if (amount <= 0.02) {
      this.last = null;
      return;
    }
    const from = this.last ?? at;
    const n = Math.min(12, Math.max(1, Math.ceil(from.distanceTo(at) / 0.012))) * (amount > 0.5 ? 2 : 1);
    for (let i = 0; i < n; i++) {
      const k = (i + Math.random()) / n;
      const j = this.next;
      this.next = (this.next + 1) % TRAIL_SIZE;
      this.pos[j * 3] = from.x + (at.x - from.x) * k + (Math.random() - 0.5) * 0.006;
      this.pos[j * 3 + 1] = from.y + (at.y - from.y) * k + (Math.random() - 0.5) * 0.006;
      this.pos[j * 3 + 2] = from.z + (at.z - from.z) * k + (Math.random() - 0.5) * 0.006;
      this.vel[j * 3] = (Math.random() - 0.5) * 0.05;
      this.vel[j * 3 + 1] = 0.03 + Math.random() * 0.05;
      this.vel[j * 3 + 2] = (Math.random() - 0.5) * 0.05;
      this.age[j] = TRAIL_LIFE * (1 - amount) * 0.5;
    }
    this.last = (this.last ?? new THREE.Vector3()).copy(at);
  }

  update(dt: number) {
    let live = 0;
    for (let j = 0; j < TRAIL_SIZE; j++) {
      if (this.age[j] >= TRAIL_LIFE) {
        this.col[j * 3] = this.col[j * 3 + 1] = this.col[j * 3 + 2] = 0;
        continue;
      }
      live++;
      this.age[j] += dt;
      const q = Math.min(1, this.age[j] / TRAIL_LIFE);
      for (let c = 0; c < 3; c++) this.pos[j * 3 + c] += this.vel[j * 3 + c] * dt;
      // White-hot where the tip just was, cooling to orange, then out.
      const fade = (1 - q) ** 1.6;
      const r = this.white.r + (this.hot.r - this.white.r) * Math.min(1, q * 3);
      const g = this.white.g + (this.hot.g - this.white.g) * Math.min(1, q * 3);
      const b = this.white.b + (this.hot.b - this.white.b) * Math.min(1, q * 3);
      this.col[j * 3] = r * fade;
      this.col[j * 3 + 1] = g * fade;
      this.col[j * 3 + 2] = b * fade;
    }
    this.live = live;
    if (live || this.points.visible) {
      this.points.geometry.attributes.position.needsUpdate = true;
      this.points.geometry.attributes.color.needsUpdate = true;
    }
    this.points.visible = live > 0;
  }

  /** How many motes are still glowing. */
  get glowing(): number {
    return this.live;
  }
}

/** How long Protego's ward holds in front of you, from flaring up to gone, in seconds. */
export const WARD_TIME = 1.25;

/**
 * Protego: a ward of light in front of your eyes, drawn the Factory way in hairlines. An outer
 * rim and an inner ring, a hexagon between them and spokes out to the rim, a faint fill, and the
 * pinwheel in the middle. It snaps up, holds with a slow turn, and fades. Lives in the hands'
 * scene, so the world never cuts through it.
 */
export class Ward {
  readonly group = new THREE.Group();
  private t = 0;
  private mats: { m: THREE.MeshBasicMaterial; full: number }[] = [];
  private spin = new THREE.Group();

  constructor() {
    this.group.name = 'wand-ward';
    const additive = (color: string, opacity: number) => {
      const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      this.mats.push({ m, full: opacity });
      return m;
    };
    const R = 0.42;
    this.spin.add(new THREE.Mesh(new THREE.CircleGeometry(R, 64), additive(ORANGE, 0.07)));
    this.spin.add(new THREE.Mesh(new THREE.RingGeometry(R - 0.004, R, 96), additive(ORANGE_HOT, 0.95)));
    this.spin.add(new THREE.Mesh(new THREE.RingGeometry(R * 0.93 - 0.0015, R * 0.93, 96), additive(WHITE, 0.4)));
    this.spin.add(new THREE.Mesh(new THREE.RingGeometry(R * 0.36 - 0.003, R * 0.36, 64), additive(ORANGE_HOT, 0.8)));
    // The hexagon, and spokes from it to the rim: hairlines laid as thin flat bars.
    const bar = (len: number, width: number, opacity: number) => new THREE.Mesh(new THREE.PlaneGeometry(width, len), additive(WHITE, opacity));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const side = bar(R * 0.62, 0.0025, 0.55);
      const r = R * 0.62 * Math.cos(Math.PI / 6);
      side.position.set(Math.cos(a) * r, Math.sin(a) * r, 0);
      side.rotation.z = a;
      this.spin.add(side);
      const spoke = bar(R * 0.62, 0.0018, 0.35);
      const b = a + Math.PI / 6;
      spoke.position.set(Math.cos(b) * R * 0.66, Math.sin(b) * R * 0.66, 0);
      spoke.rotation.z = b - Math.PI / 2;
      this.spin.add(spoke);
    }
    const sigil = new THREE.Mesh((sigilGeo ??= glyphFlat(1, 6)), additive(ORANGE_HOT, 0.9));
    sigil.scale.setScalar(R * 0.5);
    this.spin.add(sigil);
    this.group.add(this.spin);
    this.group.position.set(0, 0.02, -0.95);
    this.show(0);
  }

  update(dt: number): boolean {
    this.t += dt;
    const u = this.t / WARD_TIME;
    // Snap up, hold, fade.
    const k = u < 0.12 ? 1 - (1 - u / 0.12) ** 3 : u < 0.7 ? 1 : Math.max(0, 1 - (u - 0.7) / 0.3);
    this.show(k);
    this.spin.rotation.z = -this.t * 0.9;
    this.group.scale.setScalar(0.82 + 0.18 * Math.min(1, u / 0.12) + 0.04 * Math.sin(this.t * 14) * (u < 0.7 ? 1 : 0));
    return u < 1;
  }

  private show(k: number) {
    for (const { m, full } of this.mats) m.opacity = full * k;
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && m.geometry !== sigilGeo) m.geometry.dispose();
    });
    for (const { m } of this.mats) m.dispose();
  }
}
