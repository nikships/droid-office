import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HAIR_COLORS, HAIR_STYLES, SKIN_TONES, type Look } from '../../shared/avatar';
import { EMOTE_BY_ID, type Emote, type EmoteId } from '../../shared/emotes';
import type { CarriedIssue, WorkerAction, WorkerStatus, WorkerTask } from '../../shared/protocol';
import type { Drink } from '../../shared/rooftop';
import { isAsleep, type WorkerPr } from '../../shared/status';
import { HIPS } from '../player';
import { OpenBook } from './book';
import { HeldCard } from './card';
import { Muzzle, SPIN_AT, disposeGun, magnum, setCylinder } from './gun';
import type { GunPose } from './gun-motion';
import { glyphFlat } from './glyph3d';
import { cardSprite, disposeSprite, mesh, plainLabel, roundedBox, textSprite, toon, toonUnique } from './toon';

export type Pose = 'stand' | 'walk' | 'sit' | 'type';

/** Medic hands in the character's root space; feet stay planted while it crouches. */
export interface MedicPose {
  readonly left: THREE.Vector3;
  readonly right: THREE.Vector3;
  readonly crouch: number;
  readonly stride: number;
}

/** A two-piece limb, created only for medics. Its endpoint is the actual hand/boot mesh. */
class MedicLimb {
  private readonly direction = new THREE.Vector3();
  private readonly bend = new THREE.Vector3();
  private readonly elbow = new THREE.Vector3();
  private readonly upperMesh: THREE.Mesh;
  private readonly originalPosition: THREE.Vector3;
  private readonly originalScale: THREE.Vector3;
  readonly lower = new THREE.Group();

  constructor(
    private readonly upper: THREE.Object3D,
    readonly endpoint: THREE.Object3D,
    private readonly a: number,
    private readonly b: number,
    originalLength: number,
    geometry: THREE.BufferGeometry,
  ) {
    this.upperMesh = upper.children[0] as THREE.Mesh;
    this.originalPosition = this.upperMesh.position.clone();
    this.originalScale = this.upperMesh.scale.clone();
    this.upperMesh.scale.y = a / originalLength;
    this.upperMesh.position.y = -a / 2;
    const material = Array.isArray(this.upperMesh.material) ? this.upperMesh.material[0] : this.upperMesh.material;
    const lowerMesh = mesh(geometry, material, 0, -b / 2, 0, false);
    this.lower.add(lowerMesh, endpoint);
    endpoint.position.set(0, -b, 0);
    upper.parent!.add(this.lower);
  }

  /** The bend direction picks the elbow/knee plane, without changing the contact point. */
  pose(target: THREE.Vector3, bendX: number, bendZ: number) {
    const d = this.direction.subVectors(target, this.upper.position).length();
    this.direction.multiplyScalar(1 / Math.max(1e-6, d));
    const reach = THREE.MathUtils.clamp(d, Math.abs(this.a - this.b) + 0.001, this.a + this.b - 0.001);
    const along = (reach * reach + this.a * this.a - this.b * this.b) / (2 * reach);
    this.bend.set(bendX, 0, bendZ).addScaledVector(this.direction, -this.direction.dot(this.bend)).normalize();
    this.elbow
      .copy(this.upper.position)
      .addScaledVector(this.direction, along)
      .addScaledVector(this.bend, Math.sqrt(Math.max(0, this.a * this.a - along * along)));
    this.upper.quaternion.setFromUnitVectors(DOWN, this.bend.subVectors(this.elbow, this.upper.position).normalize());
    this.lower.position.copy(this.elbow);
    this.lower.quaternion.setFromUnitVectors(DOWN, this.bend.copy(this.upper.position).addScaledVector(this.direction, reach).sub(this.elbow).normalize());
  }

  restore(hand: boolean) {
    this.upperMesh.position.copy(this.originalPosition);
    this.upperMesh.scale.copy(this.originalScale);
    this.upper.rotation.set(0, 0, 0);
    if (hand) {
      this.upper.add(this.endpoint);
      this.endpoint.position.set(0, -0.38, 0);
      this.endpoint.name = '';
    }
    this.lower.removeFromParent();
  }
}

/** How long reaching out to use something takes, in seconds. */
export const REACH_TIME = 0.42;

/** 0 → 1 → 0 over a reach (p = 0..1): a quick jab out, a beat at full stretch, an easy return. */
export function reachCurve(p: number): number {
  if (p <= 0 || p >= 1) return 0;
  if (p < 0.28) return 1 - (1 - p / 0.28) ** 3;
  if (p < 0.5) return 1;
  const u = (p - 0.5) / 0.5;
  return 1 - u * u * (3 - 2 * u);
}

/** 0 → 1 → 0 over an emote `t` seconds into it: eased in quickly, out a little slower at the end. */
export function emoteEnvelope(t: number, seconds: number): number {
  const k = THREE.MathUtils.clamp(Math.min(t / 0.18, (seconds - t) / 0.3), 0, 1);
  return k * k * (3 - 2 * k);
}

/** Overshoots 1 a little on the way there (p = 0..1), for things that pop in. */
export function popCurve(p: number): number {
  const u = Math.min(1, p) - 1;
  return 1 + 2.7 * u * u * u + 1.7 * u * u;
}

/** How far round the club goes, from pointing down at the ball: back over the right shoulder, and on through to the finish. */
const BACKSWING = 2.4;
const FOLLOW = 2.5;
/** The swing's plane leans out from upright this far, down to the ball in front of the feet (world/golf.ts STANCE). */
const SWING_LEAN = 0.5;
/** Where the swing turns, high in the chest; the club's head is CLUB down from it. */
const SWING_AT = new THREE.Vector3(0, 0.95, 0.06);
const CLUB = 1.04;
/** Down through the ball, holding the finish, and back to the ball again, in seconds. */
const DOWNSWING = 0.14;
const FINISH = 1;
const SETTLE = 0.5;
/** A swing all on its own (someone else's) takes the club back for this long first. */
export const BACKSWING_TIME = 0.45;
/** How long after the downswing starts the club meets the ball. */
export const IMPACT = 0.08;
const DOWN = new THREE.Vector3(0, -1, 0);
const hands = new THREE.Vector3();
const armDir = new THREE.Vector3();

/** A golf club, hanging down from the hands (its grip at 0): a wrapped grip, a steel shaft and the head at the bottom, its face toward +x. */
function golfClub(): THREE.Group {
  const club = new THREE.Group();
  club.add(mesh(new THREE.CylinderGeometry(0.02, 0.017, 0.2, 8), toon('#2b2d42'), 0, -0.04, 0, false));
  club.add(mesh(new THREE.CylinderGeometry(0.011, 0.009, CLUB - 0.36 - 0.05, 6), toon('#ced4da'), 0, -(CLUB - 0.36) / 2 - 0.05, 0, false));
  club.add(mesh(new THREE.BoxGeometry(0.05, 0.05, 0.12), toon('#8d99ae'), 0.005, -(CLUB - 0.36), 0.03, false));
  return club;
}

/** A full mug of coffee standing on y = 0, with its handle on the -x side. */
export function coffeeMug(scale = 1): THREE.Group {
  const mug = new THREE.Group();
  const r = 0.05 * scale;
  const height = 0.1 * scale;
  const china = toon('#fffaf3');
  mug.add(mesh(new THREE.CylinderGeometry(r, r * 0.88, height, 16), china, 0, height / 2, 0, false));
  mug.add(mesh(new THREE.CylinderGeometry(r * 0.8, r * 0.8, height * 0.04, 16), toon('#6f4518'), 0, height, 0, false));
  mug.add(mesh(new THREE.TorusGeometry(height * 0.28, r * 0.2, 6, 12), china, -r, height / 2, 0, false));
  return mug;
}

/** Clear glass, faintly blue; no cartoon outline, so the drink inside shows through it. */
const GLASS = new THREE.MeshBasicMaterial({ color: '#e8f6ff', transparent: true, opacity: 0.38, depthWrite: false });
GLASS.userData.outlineParameters = { visible: false };

/** A drink from the rooftop bar in its glass, standing on y = 0. */
export function drinkGlass(d: Drink, scale = 1): THREE.Group {
  const g = new THREE.Group();
  const S = scale;
  const cyl = (rTop: number, rBottom: number, h: number, mat: THREE.Material, y: number, x = 0) => {
    g.add(mesh(new THREE.CylinderGeometry(rTop * S, rBottom * S, h * S, 14), mat, x * S, y * S, 0, false));
  };
  const liquid = toon(d.color);
  // A stem and a foot, for the glasses that have them.
  const stem = (h: number) => {
    cyl(0.032, 0.034, 0.006, GLASS, 0.003);
    cyl(0.005, 0.005, h, GLASS, h / 2);
  };
  switch (d.glass) {
    case 'pint':
      cyl(0.044, 0.036, 0.15, GLASS, 0.075);
      cyl(0.041, 0.034, 0.115, liquid, 0.06);
      cyl(0.043, 0.041, 0.022, toon('#fffaf0'), 0.128);
      break;
    case 'wine':
      stem(0.07);
      cyl(0.042, 0.03, 0.075, GLASS, 0.107);
      cyl(0.036, 0.028, 0.035, liquid, 0.088);
      break;
    case 'martini': {
      stem(0.075);
      cyl(0.065, 0.005, 0.07, GLASS, 0.11);
      cyl(0.052, 0.005, 0.055, liquid, 0.103);
      // An olive on a stick.
      const olive = mesh(new THREE.SphereGeometry(0.013 * S, 10, 8), toon('#7a9a3a'), 0.012 * S, 0.12 * S, 0, false);
      g.add(olive);
      const pick = mesh(new THREE.CylinderGeometry(0.002 * S, 0.002 * S, 0.09 * S, 6), toon('#c98b5a'), 0.02 * S, 0.14 * S, 0, false);
      pick.rotation.z = -0.35;
      g.add(pick);
      break;
    }
    case 'highball': {
      cyl(0.034, 0.032, 0.15, GLASS, 0.075);
      cyl(0.031, 0.029, 0.12, liquid, 0.062);
      // Ice, and a straw.
      for (const [x, y] of [
        [-0.01, 0.11],
        [0.012, 0.095],
      ]) {
        const cube = mesh(new THREE.BoxGeometry(0.02 * S, 0.02 * S, 0.02 * S), toon('#f4fbff'), x * S, y * S, 0.004 * S, false);
        cube.rotation.set(0.4, 0.6, 0.2);
        g.add(cube);
      }
      if (d.id !== 'water') {
        const straw = mesh(new THREE.CylinderGeometry(0.004 * S, 0.004 * S, 0.19 * S, 6), toon(d.id === 'maitai' ? '#ef476f' : '#06d6a0'), 0.012 * S, 0.13 * S, 0, false);
        straw.rotation.z = -0.22;
        g.add(straw);
      }
      if (d.id === 'maitai') {
        // A paper umbrella, and a wedge of pineapple on the rim.
        const umbrella = mesh(new THREE.ConeGeometry(0.035 * S, 0.018 * S, 10), toon('#ffd166'), -0.018 * S, 0.19 * S, 0, false);
        umbrella.rotation.z = 0.4;
        g.add(umbrella);
        g.add(mesh(new THREE.BoxGeometry(0.028 * S, 0.02 * S, 0.01 * S), toon('#ffd166'), 0.03 * S, 0.148 * S, 0, false));
      } else if (d.id === 'mojito') {
        for (const [x, z] of [
          [-0.012, 0.006],
          [0.006, -0.01],
          [0.01, 0.01],
        ])
          g.add(mesh(new THREE.SphereGeometry(0.009 * S, 6, 5), toon('#3f8f45'), x * S, 0.117 * S, z * S, false));
        g.add(mesh(new THREE.CylinderGeometry(0.018 * S, 0.018 * S, 0.006 * S, 10, 1, false, 0, Math.PI), toon('#9bc53d'), 0.022 * S, 0.15 * S, 0, false));
      }
      break;
    }
    case 'shot':
      cyl(0.026, 0.022, 0.06, GLASS, 0.03);
      cyl(0.023, 0.02, 0.042, liquid, 0.024);
      // A wedge of lime balanced on the rim.
      g.add(mesh(new THREE.CylinderGeometry(0.016 * S, 0.016 * S, 0.008 * S, 10, 1, false, 0, Math.PI), toon('#9bc53d'), 0.022 * S, 0.065 * S, 0, false));
      break;
  }
  return g;
}

/** Takes a glass from drinkGlass out of the hand holding it, and frees what it was made of (its materials are shared). */
export function putDownGlass(g: THREE.Group) {
  g.removeFromParent();
  g.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
}

/** On a smoke break, one drag every this many seconds. */
export const SMOKE_CYCLE = 6;
/** When, in a smoke cycle, the smoke is blown out. */
export const EXHALE_AT = 2.5;

/** How far the cigarette hand is up at the mouth (0..1), `c` seconds into a smoke cycle. */
export function dragCurve(c: number): number {
  const ease = (x: number) => x * x * (3 - 2 * x);
  if (c < 0.7) return ease(c / 0.7);
  if (c < 1.7) return 1;
  if (c < 2.3) return 1 - ease((c - 1.7) / 0.6);
  return 0;
}

/** A cigarette, lit end toward +z, and the material of its glowing tip. */
export function cigarette(): { group: THREE.Group; ember: THREE.MeshToonMaterial } {
  const group = new THREE.Group();
  group.add(mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.12, 8).rotateX(Math.PI / 2), toon('#fffaf3'), 0, 0, 0.01, false));
  group.add(mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.045, 8).rotateX(Math.PI / 2), toon('#e9a03b'), 0, 0, -0.07, false));
  const ember = toonUnique('#ff6a2b');
  ember.emissive = new THREE.Color('#ff3b00');
  ember.emissiveIntensity = 0.3;
  group.add(mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.02, 8).rotateX(Math.PI / 2), ember, 0, 0, 0.078, false));
  return { group, ember };
}

/**
 * An open cardboard box with someone's desk things in it: a plant, a photo, a mug, a rubber duck and
 * some papers. It stands on y = 0 with its front toward +z.
 */
export function boxOfStuff(): THREE.Group {
  const g = new THREE.Group();
  const W = 0.52;
  const H = 0.26;
  const D = 0.3;
  const T = 0.02;
  const card = toon('#c8955c');
  g.add(mesh(new THREE.BoxGeometry(W, T, D), card, 0, T / 2, 0));
  for (const s of [-1, 1]) {
    g.add(mesh(new THREE.BoxGeometry(W, H, T), card, 0, H / 2, (s * (D - T)) / 2));
    g.add(mesh(new THREE.BoxGeometry(T, H, D - 2 * T), card, (s * (W - T)) / 2, H / 2, 0));
  }
  // Full to the brim.
  g.add(mesh(new THREE.BoxGeometry(W - 2 * T, 0.01, D - 2 * T), toon('#8b6a47'), 0, H * 0.7, 0, false));
  // Flaps: the front one hangs down over the front, the side ones stick up and out.
  const flapMat = toon('#b5824c');
  const front = new THREE.Group();
  front.position.set(0, H, D / 2);
  front.rotation.x = 1.2;
  front.add(mesh(new THREE.BoxGeometry(W, T, 0.14), flapMat, 0, 0, 0.07));
  g.add(front);
  for (const s of [-1, 1]) {
    const flap = new THREE.Group();
    flap.position.set((s * W) / 2, H, 0);
    flap.rotation.z = s * 0.95;
    flap.add(mesh(new THREE.BoxGeometry(0.13, T, D), flapMat, s * 0.065, 0, 0));
    g.add(flap);
  }

  // A potted plant in the back corner.
  g.add(mesh(new THREE.CylinderGeometry(0.06, 0.045, 0.11, 10), toon('#e76f51'), -0.15, H - 0.03, -0.04, false));
  for (const [x, y, z, r, c] of [
    [-0.15, 0.1, -0.04, 0.07, '#5fb760'],
    [-0.2, 0.07, 0.0, 0.05, '#3f8f45'],
    [-0.11, 0.15, -0.07, 0.05, '#6fcf6a'],
  ] as const)
    g.add(mesh(new THREE.SphereGeometry(r, 10, 8), toon(c), x, H + y, z, false));
  // Papers sticking up at the back.
  for (const [x, rz] of [
    [-0.01, 0.16],
    [0.05, -0.1],
  ]) {
    const paper = mesh(new THREE.BoxGeometry(0.17, 0.22, 0.004), toon('#fffaf3'), x, H - 0.01, -0.1, false);
    paper.rotation.set(-0.1, 0, rz);
    g.add(paper);
  }
  // A framed photo, leaning back.
  const photo = new THREE.Group();
  photo.add(mesh(new THREE.BoxGeometry(0.16, 0.13, 0.02), toon('#2b2d42'), 0, 0, 0, false));
  photo.add(mesh(new THREE.BoxGeometry(0.12, 0.09, 0.005), toon('#8ecae6'), 0, 0, 0.011, false));
  photo.add(mesh(new THREE.SphereGeometry(0.018, 8, 6), toon('#ffd166'), 0.03, 0.02, 0.014, false));
  photo.position.set(0.1, H + 0.04, -0.05);
  photo.rotation.set(-0.3, 0, -0.12);
  g.add(photo);
  // A mug and the rubber duck, up front.
  const mug = coffeeMug(0.9);
  mug.position.set(0.0, H - 0.07, 0.07);
  g.add(mug);
  const duck = new THREE.Group();
  const duckBody = mesh(new THREE.SphereGeometry(0.05, 10, 8), toon('#ffd166'), 0, 0, 0, false);
  duckBody.scale.y = 0.8;
  duck.add(duckBody);
  duck.add(mesh(new THREE.SphereGeometry(0.032, 10, 8), toon('#ffd166'), 0, 0.055, 0.02, false));
  duck.add(mesh(new THREE.ConeGeometry(0.014, 0.03, 6).rotateX(Math.PI / 2), toon('#f4a261'), 0, 0.05, 0.06, false));
  duck.position.set(0.16, H + 0.01, 0.06);
  duck.rotation.y = -0.4;
  g.add(duck);
  return g;
}

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const q1 = new THREE.Quaternion();
/** Where a person's fist holds the gun's grip, at the end of the arm. */
const PERSON_GUN_MOUNT = new THREE.Vector3(0, -0.38, 0);

// ---- Factory crew kit ---------------------------------------------------------------------------
// Everyone in the building is Factory crew: an orange lanyard and an ID card, a pinwheel patch on
// the chest and a pinwheel printed on the back. Each kit is a single vertex-colored mesh, built once
// and shared, so a room full of workers wears it for one draw call apiece.

const CREW = {
  black: '#121212',
  graphite: '#2a2a2a',
  steel: '#3a3a3a',
  light: '#eeeeee',
  orange: '#ee6018',
} as const;

/** A capsule body to dress: its middle `y`, half the straight part's height, and its radius. */
interface Capsule {
  readonly y: number;
  readonly half: number;
  readonly r: number;
}
/** The worker's bean (see Worker) and a person's torso (see Person). */
const BEAN: Capsule = { y: 0.55, half: 0.15, r: 0.28 };
const TORSO: Capsule = { y: 0.72, half: 0.14, r: 0.26 };

/** The point on `c` at height `y`, `a` round from the front (+z; +x is positive), `out` off its surface, into `at`; returns the outward normal. */
function onCapsule(c: Capsule, y: number, a: number, out: number, at: THREE.Vector3): THREE.Vector3 {
  const dy = y - THREE.MathUtils.clamp(y, c.y - c.half, c.y + c.half);
  const rr = Math.sqrt(Math.max(1e-6, c.r * c.r - dy * dy));
  const normal = new THREE.Vector3(Math.sin(a) * rr, dy, Math.cos(a) * rr).normalize();
  at.set(Math.sin(a) * rr, y, Math.cos(a) * rr).addScaledVector(normal, out);
  return normal;
}

/**
 * A flat piece (built facing +z around 0,0,0) bent over `c` with its middle at (y, a), `out` off
 * the surface, in `color`. Its x runs round the body and its y up it, so it hugs the curve
 * instead of cutting into it at the edges.
 */
function hug(c: Capsule, geo: THREE.BufferGeometry, color: string, y: number, a: number, out: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const normals = new Float32Array(pos.count * 3);
  const at = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const py = y + pos.getY(i);
    const ring = Math.sqrt(Math.max(1e-6, c.r * c.r - (py - THREE.MathUtils.clamp(py, c.y - c.half, c.y + c.half)) ** 2));
    const n = onCapsule(c, py, a + pos.getX(i) / ring, out + pos.getZ(i), at);
    pos.setXYZ(i, at.x, at.y, at.z);
    normals.set([n.x, n.y, n.z], i * 3);
  }
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return tint(g, color);
}

/** Paints every vertex of `geo` (plain triangles with normals) one color, ready to merge into a kit. */
function tint(geo: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) rgb.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  g.userData.signal = color === CREW.orange;
  return g;
}

/**
 * A lanyard round `c`, high at the back (`back`) and down to a V at the front (`front`), where the
 * card hangs; `steep` under 1 lifts the straps off the front sooner.
 */
function lanyard(c: Capsule, front: number, back: number, steep: number, color: string): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const y = front + (back - front) * (Math.min(a, Math.PI * 2 - a) / Math.PI) ** steep;
    const p = new THREE.Vector3();
    onCapsule(c, y, a, 0.01, p);
    pts.push(p);
  }
  return tint(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 24, 0.009, 3, true), color);
}

/** An ID card on its clip, `w` by `h`, centered on 0,0 and facing +z: an orange band across the top, a photo and two lines. */
function idCard(c: Capsule, y: number, w: number, h: number): THREE.BufferGeometry[] {
  const at = (geo: THREE.BufferGeometry, x: number, dy: number, z: number) => geo.translate(x, dy, z);
  return [
    hug(c, new THREE.BoxGeometry(w, h, 0.006), CREW.light, y, 0, 0.006),
    hug(c, at(new THREE.PlaneGeometry(w, h * 0.22), 0, h * 0.39, 0.0035), CREW.orange, y, 0, 0.006),
    hug(c, at(new THREE.PlaneGeometry(w * 0.34, w * 0.34), -w * 0.22, -h * 0.06, 0.0035), CREW.graphite, y, 0, 0.006),
    hug(c, at(new THREE.PlaneGeometry(w * 0.34, w * 0.07), w * 0.2, 0, 0.0035), CREW.steel, y, 0, 0.006),
    hug(c, at(new THREE.PlaneGeometry(w * 0.26, w * 0.07), w * 0.16, -h * 0.13, 0.0035), CREW.steel, y, 0, 0.006),
    hug(c, at(new THREE.BoxGeometry(w * 0.3, h * 0.12, 0.01), 0, h * 0.53, 0), CREW.steel, y, 0, 0.006),
  ];
}

/** A pinwheel patch `size` across sewn on at (y, a): an orange pinwheel on a dark square. */
function patch(c: Capsule, y: number, a: number, size: number): THREE.BufferGeometry[] {
  return [hug(c, new THREE.PlaneGeometry(size, size), CREW.black, y, a, 0.004), hug(c, glyphFlat(size * 0.72, 1).translate(0, 0, 0.002), CREW.orange, y, a, 0.004)];
}

let kitMats: { plain: THREE.MeshToonMaterial; signal: THREE.MeshToonMaterial } | null = null;
/**
 * What every crew kit draws with, each piece's color in its vertices: plain for the card and
 * patches, and a lit one for the orange (lanyard, stripes, pinwheels), which reads like safety
 * tape against a dark floor. Both are too small for the cartoon outline.
 */
function kitMaterials(): { plain: THREE.MeshToonMaterial; signal: THREE.MeshToonMaterial } {
  if (!kitMats) {
    const make = (emissive: string) => {
      const m = toonUnique('#ffffff');
      m.vertexColors = true;
      m.emissive.set(emissive);
      m.userData.outlineParameters = { visible: false };
      return m;
    };
    kitMats = { plain: make('#000000'), signal: make('#5e2208') };
  }
  return kitMats;
}

const kits = new Map<string, { plain: THREE.BufferGeometry; signal: THREE.BufferGeometry }>();
const sharedGeometry = new WeakSet<THREE.BufferGeometry>();
/** Whether `geo` is worn by everyone (a crew kit), so whoever frees a person's meshes must leave it be. */
export function isSharedGeometry(geo: THREE.BufferGeometry): boolean {
  return sharedGeometry.has(geo);
}
/** The kit `key` names, built by `make` the first time anyone wears one and shared after that: two meshes, plain and signal orange. */
function kit(key: string, make: () => THREE.BufferGeometry[]): THREE.Group {
  let geo = kits.get(key);
  if (!geo) {
    const parts = make();
    geo = { plain: mergeGeometries(parts.filter((p) => !p.userData.signal))!, signal: mergeGeometries(parts.filter((p) => p.userData.signal))! };
    sharedGeometry.add(geo.plain);
    sharedGeometry.add(geo.signal);
    kits.set(key, geo);
  }
  const mats = kitMaterials();
  const g = new THREE.Group();
  g.name = 'crew-kit';
  g.add(mesh(geo.plain, mats.plain, 0, 0, 0, false), mesh(geo.signal, mats.signal, 0, 0, 0, false));
  return g;
}

/** A person's crew kit: lanyard, ID card, chest patch and the pinwheel on the back. */
function personKit(): THREE.Group {
  return kit('person', () => [lanyard(TORSO, 0.86, 1.05, 0.6, CREW.orange), ...idCard(TORSO, 0.775, 0.095, 0.13), ...patch(TORSO, 0.83, 0.74, 0.085), hug(TORSO, glyphFlat(0.22, 2), CREW.orange, 0.78, Math.PI, 0.004)]);
}

/** A worker's crew kit, under its headset: the lanyard runs below its ear cups, the card hangs below its eyes. */
function workerKit(): THREE.Group {
  return kit('worker', () => [lanyard(BEAN, 0.49, 0.8, 0.75, CREW.orange), ...idCard(BEAN, 0.425, 0.095, 0.125), ...patch(BEAN, 0.47, 0.76, 0.07), hug(BEAN, glyphFlat(0.17, 2), CREW.orange, 0.58, Math.PI, 0.004)]);
}

let headsetGeo: THREE.BufferGeometry | null = null;
/** A worker's headset in graphite: the band (front to back, under the antenna), the ear cups and a boom out to its mic. */
function headset(): THREE.BufferGeometry {
  let geo = headsetGeo;
  if (!geo) {
    const band = new THREE.TorusGeometry(0.29, 0.025, 6, 20, Math.PI).translate(0, 0.72, 0).rotateY(Math.PI / 2);
    const parts: THREE.BufferGeometry[] = [band];
    for (const sx of [-1, 1]) parts.push(new THREE.SphereGeometry(0.07, 10, 8).translate(sx * 0.29, 0.72, 0));
    const boom = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0.3, 0.7, 0.04), new THREE.Vector3(0.37, 0.6, 0.2), MIC);
    parts.push(new THREE.TubeGeometry(boom, 8, 0.012, 5, false));
    geo = mergeGeometries(parts.map((p) => tint(p, CREW.graphite)))!;
    geo.deleteAttribute('color');
    headsetGeo = geo;
  }
  return geo;
}
/** The tip of a worker's mic boom, where its orange LED is. */
const MIC = new THREE.Vector3(0.17, 0.565, 0.255);
let ledMat: THREE.MeshToonMaterial | null = null;
/** The LED's lit orange, without the cartoon outline that would swallow something so small. */
function ledMaterial(): THREE.MeshToonMaterial {
  if (!ledMat) {
    ledMat = toonUnique(CREW.orange);
    ledMat.emissive.set(CREW.orange);
    ledMat.userData.outlineParameters = { visible: false };
  }
  return ledMat;
}

let bootGeo: THREE.BufferGeometry | null = null;
/** A person's black work boot, at the end of a leg (see Person's legs, whose pivot is the hip). */
function boot(): THREE.Mesh {
  bootGeo ??= roundedBox(0.17, 0.1, 0.25, 0.05);
  const m = mesh(bootGeo, toon(CREW.black), 0, -0.335, 0.035);
  m.name = 'crew-boot';
  return m;
}

/** A chibi cartoon person — used for every human in the office. Forward is +z. */
export class Person {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private legL: THREE.Object3D;
  private legR: THREE.Object3D;
  private armL: THREE.Object3D;
  private armR: THREE.Object3D;
  private shirt: THREE.MeshToonMaterial;
  private skin: THREE.MeshToonMaterial;
  private hairMat: THREE.MeshToonMaterial;
  private hair = new THREE.Group();
  /** Their Factory crew kit (lanyard, card, patches) and work boots, off while they wear a medic's uniform. */
  private crew: THREE.Group;
  private boots: THREE.Mesh[];
  private look: Look;
  private label: THREE.Sprite | null = null;
  private head: THREE.Group;
  private walkPhase = 0;
  private reachT = -1;
  /** Held in the left hand, kept upright however the arm swings: a mug of coffee or a drink. */
  private mug = new THREE.Group();
  private cup: THREE.Group;
  private wantsMug = false;
  /** A drink from the rooftop bar, in the mug's place. */
  private glass: { id: string; group: THREE.Group } | null = null;
  /** An issue card off the board, held out in front in both hands. */
  private card: HeldCard;
  private cardHolder = new THREE.Group();
  /** A book off the bookshelf, open in both hands while they read (see read). */
  private book: OpenBook | null = null;
  private bookHolder = new THREE.Group();
  /** The basketball in both hands (the ball itself is the floor's, see world/hoop.ts), and seconds into a shot, or -1. */
  private ball = false;
  private shootT = -1;
  pose: Pose = 'stand';
  private cig: THREE.Group;
  private ember: THREE.MeshToonMaterial;
  /** Seconds into a smoke break, or -1 when not on one. */
  private smokeT = -1;
  private wispIn = 0;
  /** Where smoke comes off: the lit end (a wisp) or the mouth, blowing it out along `dir`. */
  onSmoke: ((kind: 'wisp' | 'exhale', at: THREE.Vector3, dir: THREE.Vector3) => void) | null = null;
  /** The emote being played, how far into it (seconds), and its emoji over their head. */
  private emoting: { emote: Emote; t: number; pop: THREE.Sprite; size: THREE.Vector2 } | null = null;
  /** A thumb up and a pointing finger on the right hand, out only for those emotes. */
  private thumb: THREE.Mesh;
  private finger: THREE.Mesh;
  /** How much higher (meters) an emote's emoji pops up, to clear a bubble over their head. */
  emojiLift = 0;
  /** Hips this high above the feet while sitting (on the seat), or null on their feet. */
  private hips: number | null = null;
  /** The last seat's, so getting up eases back down from it. */
  private seatHips = HIPS;
  /** 0 standing … 1 sitting, eased between so sitting down and getting up take a moment. */
  private sitK = 0;
  /** Holding on to the ladder or a fire pole (see setGrip). */
  private grip: 'ladder' | 'pole' | null = null;
  /**
   * At the golf tee with a club (see setGolf): the club's swing, how far back it's been taken (and
   * `want`, where it's going), and a swing under way (`swingT` seconds in, from `top`), or -1.
   * `autoT` is a whole swing playing by itself (golfSwing), taken back to `power`.
   */
  private golf: { swing: THREE.Group; back: number; want: number; top: number; swingT: number; autoT: number; power: number } | null = null;
  /**
   * A .44 Magnum in the right fist (see setGunPose): where the fist holds it, the pivot it spins
   * round on the trigger finger, the prop and its muzzle flash, and the pose it's in.
   */
  private gun: { mount: THREE.Group; wrist: THREE.Group; pivot: THREE.Group; prop: THREE.Group; muzzle: Muzzle; pose: Readonly<GunPose> } | null = null;
  private medicRig: { limbs: MedicLimb[]; geometries: THREE.BufferGeometry[]; uniform: THREE.Object3D[]; labelVisible: boolean; inverse: THREE.Quaternion; target: THREE.Vector3 } | null = null;

  constructor(name: string, color: string, look: Look) {
    this.look = { ...look };
    this.shirt = toonUnique(color);
    const skin = (this.skin = toonUnique(SKIN_TONES[look.skin]));
    this.hairMat = toonUnique(HAIR_COLORS[look.hair]);
    this.hairMat.side = THREE.DoubleSide;
    const pants = toon('#1e1e1e');
    const ink = toon('#1d1d1d');

    this.root.add(this.body);
    // Torso
    this.body.add(mesh(new THREE.CapsuleGeometry(0.26, 0.28, 6, 12), this.shirt, 0, 0.72, 0));
    this.crew = personKit();
    this.body.add(this.crew);
    // Head
    const head = (this.head = new THREE.Group());
    head.position.y = 1.32;
    head.add(mesh(new THREE.SphereGeometry(0.34, 20, 16), skin));
    head.add(this.hair);
    this.buildHair();
    for (const sx of [-1, 1]) {
      head.add(mesh(new THREE.SphereGeometry(0.055, 10, 8), ink, sx * 0.12, 0.02, 0.3, false));
      head.add(mesh(new THREE.SphereGeometry(0.05, 10, 8), toon('#ff9f9f'), sx * 0.2, -0.08, 0.27, false));
    }
    const smile = mesh(new THREE.TorusGeometry(0.06, 0.015, 6, 12, Math.PI), ink, 0, -0.08, 0.32, false);
    smile.rotation.z = Math.PI;
    head.add(smile);
    this.body.add(head);

    const limb = (len: number, r: number, mat: THREE.Material, x: number, y: number) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      pivot.add(mesh(new THREE.CapsuleGeometry(r, len, 4, 8), mat, 0, -len / 2 - r / 2, 0));
      this.body.add(pivot);
      return pivot;
    };
    this.legL = limb(0.22, 0.1, pants, -0.12, HIPS);
    this.legR = limb(0.22, 0.1, pants, 0.12, HIPS);
    this.boots = [boot(), boot()];
    this.legL.add(this.boots[0]);
    this.legR.add(this.boots[1]);
    this.armL = limb(0.24, 0.08, this.shirt, -0.33, 0.9);
    this.armR = limb(0.24, 0.08, this.shirt, 0.33, 0.9);
    for (const arm of [this.armL, this.armR]) arm.add(mesh(new THREE.SphereGeometry(0.085, 12, 10), skin, 0, -0.38, 0));
    // Forward is +z, so the character's left arm is the one on +x. The handle faces the hand.
    const cup = (this.cup = coffeeMug(1.4));
    cup.position.set(0.02, -0.08, 0.1);
    cup.rotation.y = -Math.PI / 2;
    this.mug.add(cup);
    this.mug.position.set(0, -0.38, 0);
    this.mug.visible = false;
    this.armR.add(this.mug);
    // For smoke breaks: a cigarette sticking out of the right fist (the arm on -x, see reach), lit end
    // pointing down at your side and up and away when it's at your mouth.
    const cig = cigarette();
    this.cig = cig.group;
    this.ember = cig.ember;
    const along = new THREE.Vector3(0, -0.9, -0.44).normalize();
    this.cig.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), along);
    this.cig.position.set(0, -0.38, 0).addScaledVector(along, 0.07);
    this.cig.visible = false;
    this.armL.add(this.cig);
    // Between the hands when both arms are out in front (see update), its front to whoever they walk up to.
    const holder = this.cardHolder;
    holder.position.set(0, 0.8, 0.36);
    holder.rotation.x = -0.1;
    this.body.add(holder);
    this.card = new HeldCard(holder, 0.46);
    // Held out at chest height, turned round and tipped up so the pages face their eyes, top edge
    // away from them, with the hands on its bottom corners.
    this.bookHolder.position.set(0, 1, 0.48);
    this.bookHolder.rotation.set(0.85, Math.PI, 0);
    this.bookHolder.scale.setScalar(1.25);
    this.body.add(this.bookHolder);
    // Along the arm (the fist's -y) the finger points; the thumb sticks out of the front of the fist,
    // which is up once the arm is out in front.
    this.thumb = mesh(new THREE.CapsuleGeometry(0.035, 0.07, 4, 8).rotateX(Math.PI / 2), skin, 0, -0.38, 0.1, false);
    this.finger = mesh(new THREE.CapsuleGeometry(0.03, 0.09, 4, 8), skin, 0, -0.5, 0.02, false);
    for (const m of [this.thumb, this.finger]) {
      m.visible = false;
      this.armL.add(m);
    }

    this.setLabel(name);
  }

  setColor(color: string) {
    this.shirt.color.set(color);
  }

  get skinColor(): string {
    return SKIN_TONES[this.look.skin];
  }

  setLook(look: Look) {
    const restyle = look.style !== this.look.style;
    this.look = { ...look };
    this.hairMat.color.set(HAIR_COLORS[look.hair]);
    if (restyle) this.buildHair();
    this.dress();
  }

  /** The skin and hair. */
  private dress() {
    this.skin.color.set(SKIN_TONES[this.look.skin]);
    this.hair.visible = true;
  }

  /** Hair is a set of shapes on the head (whose center is 0,0,0; the face looks down +z). */
  private buildHair() {
    for (const o of this.hair.children) (o as THREE.Mesh).geometry.dispose();
    this.hair.clear();
    const m = this.hairMat;
    const add = (geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, rz = 0) => {
      const part = mesh(geo, m, x, y, z);
      part.rotation.set(rx, 0, rz);
      this.hair.add(part);
      return part;
    };
    const cap = () => add(new THREE.SphereGeometry(0.355, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.45), 0, 0.02, -0.02, -0.25);
    switch (HAIR_STYLES[this.look.style]) {
      case 'Short':
        cap();
        break;
      case 'Long': {
        cap();
        // A curtain down the back, open at the front so the face shows.
        // Around the head from ear to ear the back way, leaving the face open (phi = π/2 is the face).
        const back = add(new THREE.SphereGeometry(0.37, 20, 14, Math.PI * 0.93, Math.PI * 1.14, Math.PI * 0.3, Math.PI * 0.5), 0, -0.06, -0.03);
        back.scale.set(1.02, 1.35, 1);
        break;
      }
      case 'Bun':
        cap();
        add(new THREE.SphereGeometry(0.14, 14, 12), 0, 0.3, -0.2);
        break;
      case 'Spiky':
        cap();
        // Two rows of spikes fanned out over the crown.
        for (const [row, n, z, tilt] of [
          [0, 5, 0.08, 0.35],
          [1, 4, -0.12, -0.3],
        ] as const) {
          for (let i = 0; i < n; i++) {
            const a = -0.85 + (i / (n - 1)) * 1.7;
            const spike = add(new THREE.ConeGeometry(0.1, 0.3, 8), Math.sin(a) * 0.24, 0.33 - Math.abs(a) * 0.08 - row * 0.02, z);
            spike.rotation.set(tilt, 0, -a * 0.9);
          }
        }
        break;
      case 'Curly': {
        // Little puffs spread over the top and back of the head, leaving the face clear.
        const n = 70;
        for (let i = 0; i < n; i++) {
          const y = 1 - (i / (n - 1)) * 2;
          const r = Math.sqrt(1 - y * y);
          const th = i * 2.39996;
          const px = Math.cos(th) * r;
          const pz = Math.sin(th) * r;
          if (y < -0.15 || (pz > 0.35 && y < 0.55)) continue;
          add(new THREE.SphereGeometry(0.1, 8, 6), px * 0.36, y * 0.36 + 0.04, pz * 0.36 - 0.02);
        }
        break;
      }
      case 'Ponytail': {
        cap();
        add(new THREE.SphereGeometry(0.075, 10, 8), 0, 0.12, -0.34);
        const tail = add(new THREE.CapsuleGeometry(0.085, 0.3, 6, 10), 0, -0.1, -0.42, 0.35);
        tail.scale.set(1, 1, 0.8);
        break;
      }
      case 'Bald':
        break;
    }
    this.hair.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  }

  setLabel(name: string) {
    if (this.label) {
      this.root.remove(this.label);
      disposeSprite(this.label);
    }
    this.label = textSprite(name, { bg: '#0a0a0a', color: '#eeeeee', border: '#2f2f2f', size: 40 });
    this.label.position.y = 2.0;
    this.root.add(this.label);
  }

  showLabel(v: boolean) {
    if (this.label) this.label.visible = v;
  }

  /** Reach out with the right hand, as if pressing or grabbing something in front of you. */
  reach() {
    this.reachT = 0;
  }

  /** A mug of coffee in the left hand, or not. */
  holdMug(on: boolean) {
    this.wantsMug = on;
    this.cup.visible = !this.glass;
    this.mug.visible = (on || !!this.glass) && !this.card.held && !this.book && !this.ball;
  }

  /** A drink from the rooftop bar in the left hand (in place of a mug), or none (null). */
  holdDrink(d: Drink | null) {
    if ((d?.id ?? null) === (this.glass?.id ?? null)) return;
    if (this.glass) {
      putDownGlass(this.glass.group);
      this.glass = null;
    }
    if (d) {
      const group = drinkGlass(d, 1.4);
      group.position.set(0.02, -0.08, 0.1);
      this.mug.add(group);
      this.glass = { id: d.id, group };
    }
    this.holdMug(this.wantsMug);
  }

  /** Carries an issue card in both hands, or puts it down (null). The mug waits while the hands are full. */
  carry(card: CarriedIssue | null | undefined) {
    this.card.set(card);
    this.holdMug(this.wantsMug);
  }

  /** Opens a book in both hands and reads it, turning the pages (or closes it). A card they carry waits. */
  read(on: boolean) {
    if (on === !!this.book) return;
    if (on) {
      this.book = new OpenBook();
      this.bookHolder.add(this.book.group);
    } else if (this.book) {
      this.bookHolder.remove(this.book.group);
      this.book.dispose();
      this.book = null;
    }
    this.cardHolder.visible = !on;
    this.holdMug(this.wantsMug);
  }

  /** Turns a page of the book they're reading now. */
  turnPage() {
    this.book?.turn();
  }

  /** Holds the basketball out in front in both hands, or not. */
  holdBall(on: boolean) {
    if (on === this.ball) return;
    this.ball = on;
    this.holdMug(this.wantsMug);
  }

  /** Shoots: both arms up over the head and after the ball. */
  shoot() {
    this.shootT = 0;
  }

  /** Waves, gives a thumbs up, claps…: the gesture, with its emoji popping up over their head. */
  emote(id: EmoteId) {
    const emote = EMOTE_BY_ID.get(id);
    if (!emote) return;
    this.endEmote();
    const pop = textSprite(emote.emoji, { size: 72 });
    const size = new THREE.Vector2(pop.scale.x, pop.scale.y);
    pop.scale.set(0.001, 0.001, 1);
    this.root.add(pop);
    this.emoting = { emote, t: 0, pop, size };
    this.thumb.visible = id === 'thumbs';
    this.finger.visible = id === 'point';
  }

  /** The emote playing now, if any. */
  get emoteId(): EmoteId | null {
    return this.emoting?.emote.id ?? null;
  }

  private endEmote() {
    const e = this.emoting;
    if (!e) return;
    this.root.remove(e.pop);
    disposeSprite(e.pop);
    this.emoting = null;
    this.thumb.visible = this.finger.visible = false;
  }

  /**
   * Poses the emote over whatever the arms were doing (walking, sitting, a drag on a cigarette),
   * `k` of the way. The dance's bounce and steps only happen with both feet on the floor (`still`).
   */
  private emoteStep(dt: number, still: number) {
    const e = this.emoting!;
    e.t += dt;
    const { seconds, id } = e.emote;
    if (e.t >= seconds) return this.endEmote();
    const k = emoteEnvelope(e.t, seconds);
    const u = e.t;
    const pose = (arm: THREE.Object3D, x: number, z: number) => {
      arm.rotation.x = THREE.MathUtils.lerp(arm.rotation.x, x, k);
      arm.rotation.z = THREE.MathUtils.lerp(arm.rotation.z, z, k);
    };
    // Forward is +z, so the character's right arm is the one on -x (armL), as in reach.
    switch (id) {
      case 'wave':
        pose(this.armL, -0.35, -2.55 + Math.sin(u * 12) * 0.35);
        this.head.rotation.z = -0.1 * k;
        break;
      case 'thumbs':
        // Out in front, with a little pump that settles.
        pose(this.armL, -1.75 - Math.exp(-u * 3) * Math.sin(u * 14) * 0.25, 0.2);
        this.head.rotation.z = -0.08 * k;
        break;
      case 'clap': {
        // Both hands out in front, meeting in the middle about three times a second.
        const c = 0.5 - 0.5 * Math.cos(u * 19);
        pose(this.armL, -1.25, 0.3 + 0.42 * c);
        pose(this.armR, -1.25, -0.3 - 0.42 * c);
        this.body.position.y += Math.abs(Math.sin(u * 9.5)) * 0.02 * k * still;
        break;
      }
      case 'dance': {
        // Two beats a second: arms up by turns, a hop on every beat, hips swaying, a knee up.
        const b = u * Math.PI * 2;
        const s = Math.sin(b);
        pose(this.armL, -0.3, THREE.MathUtils.lerp(-0.35, -2.7, (s + 1) / 2));
        pose(this.armR, -0.3, THREE.MathUtils.lerp(0.35, 2.7, (1 - s) / 2));
        const m = k * still;
        this.body.position.y += Math.abs(Math.sin(b)) * 0.08 * m;
        this.body.rotation.z = s * 0.12 * m;
        this.body.rotation.y = Math.sin(b / 2) * 0.45 * m;
        this.legL.rotation.x = THREE.MathUtils.lerp(this.legL.rotation.x, -Math.max(0, s) * 0.7, m);
        this.legR.rotation.x = THREE.MathUtils.lerp(this.legR.rotation.x, -Math.max(0, -s) * 0.7, m);
        this.head.rotation.z = -s * 0.1 * k;
        break;
      }
      case 'point':
        // Arm straight out at whatever you face, with a jab to start.
        pose(this.armL, -1.6 - Math.exp(-u * 4) * Math.sin(u * 16) * 0.15, 0.05);
        break;
      case 'facepalm':
        // Hand to the face, head down and shaking slowly.
        pose(this.armL, -2.4, 0.62);
        this.body.rotation.x += 0.1 * k;
        this.head.rotation.x += 0.3 * k;
        this.head.rotation.y = Math.sin(u * 5) * 0.15 * k;
        break;
    }
    // The emoji pops in over their head, rises a little, wobbles, and fades at the end.
    const pop = popCurve(u / 0.3);
    e.pop.scale.set(e.size.x * pop, e.size.y * pop, 1);
    e.pop.position.y = 2.42 + this.emojiLift + Math.min(u, 1.5) * 0.12;
    e.pop.material.rotation = Math.sin(u * 7) * 0.12;
    e.pop.material.opacity = THREE.MathUtils.clamp((seconds - u) / 0.4, 0, 1);
  }

  get smoking(): boolean {
    return this.smokeT >= 0;
  }

  /** Lights a cigarette (or puts it out): it's in their right hand, and they take a drag every few seconds. */
  setSmoking(on: boolean) {
    if (on === this.smoking) return;
    this.smokeT = on ? 0 : -1;
    this.cig.visible = on;
  }

  /** A drag: up to the mouth, hold while the tip glows, back down, then blow the smoke out. */
  private smokeStep(dt: number, walking: boolean, airborne: boolean) {
    const prev = this.smokeT % SMOKE_CYCLE;
    this.smokeT += dt;
    const c = this.smokeT % SMOKE_CYCLE;
    const k = walking || airborne ? 0 : dragCurve(c);
    if (!airborne) {
      this.armL.rotation.x = THREE.MathUtils.lerp(-0.9, -2.6, k);
      this.armL.rotation.z = THREE.MathUtils.lerp(0.15, 0.6, k);
    }
    const glow = k > 0.9 ? 1.4 : 0.3;
    this.ember.emissiveIntensity += (glow - this.ember.emissiveIntensity) * Math.min(1, dt * 6);
    if (!this.onSmoke) return;
    this.wispIn -= dt;
    const exhale = prev < EXHALE_AT && c >= EXHALE_AT;
    if (this.wispIn > 0 && !exhale) return;
    this.root.updateMatrixWorld(true);
    if (this.wispIn <= 0) {
      this.wispIn = 0.16 + Math.random() * 0.12;
      this.onSmoke('wisp', this.cig.localToWorld(v1.set(0, 0, 0.09)), v2.set(0, 1, 0));
    }
    if (exhale) {
      const dir = v2.set(0, 0.25, 1).applyQuaternion(this.root.quaternion).normalize();
      this.onSmoke('exhale', this.head.localToWorld(v1.set(0, -0.1, 0.36)), dir);
    }
  }

  /** Sits down with the hips `hips` above the feet, on a couch or a chair, or gets up (null). */
  sit(hips: number | null) {
    this.hips = hips;
    if (hips !== null) this.seatHips = hips;
    this.pose = hips === null ? 'stand' : 'sit';
  }

  /**
   * On the ladder (hand over hand, as they climb) or a fire pole (hanging on with both arms up, legs
   * wrapped round it: it's on their left, the +x side), or neither.
   */
  setGrip(grip: 'ladder' | 'pole' | null) {
    this.grip = grip;
  }

  /** At the golf tee with a club in both hands, over the ball (the ball in front of their feet, the hole off to their left), or not. */
  setGolf(on: boolean) {
    if (on === !!this.golf) return;
    if (!on) {
      const { swing } = this.golf!;
      this.body.remove(swing);
      swing.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      this.golf = null;
      // The swing turned the arms and legs every which way; standing, they only swing back and forth.
      for (const limb of [this.armL, this.armR, this.legL, this.legR]) limb.rotation.set(0, 0, 0);
      return;
    }
    const swing = new THREE.Group();
    swing.position.copy(SWING_AT);
    const club = golfClub();
    club.position.y = -0.36;
    swing.add(club);
    this.body.add(swing);
    this.golf = { swing, back: 0, want: 0, top: 0, swingT: -1, autoT: -1, power: 0 };
  }

  /** Taking the club back, `k` of the way (0 at the ball, 1 as far as it goes), the harder to hit it. */
  golfBack(k: number) {
    const g = this.golf;
    if (g && g.swingT < 0) g.want = THREE.MathUtils.clamp(k, 0, 1);
  }

  /** Down through the ball from wherever it was taken back to, up into the finish, and back to the ball. */
  golfHit() {
    const g = this.golf;
    if (!g) return;
    g.top = g.back;
    g.swingT = 0;
    g.autoT = -1;
  }

  /** A whole swing, all by itself: back `power` of the way over BACKSWING_TIME, then through (someone else's shot). */
  golfSwing(power: number) {
    const g = this.golf;
    if (!g) return;
    g.swingT = -1;
    g.autoT = 0;
    g.power = THREE.MathUtils.clamp(power, 0, 1);
  }

  /** The golf swing, over whatever the arms and legs were doing. */
  private golfStep(dt: number) {
    const g = this.golf!;
    if (g.autoT >= 0) {
      g.autoT += dt;
      g.want = g.power * Math.min(1, g.autoT / BACKSWING_TIME);
      if (g.autoT >= BACKSWING_TIME) this.golfHit();
    }
    let phi: number;
    let finish = 0;
    if (g.swingT >= 0) {
      const s = (g.swingT += dt);
      if (s < DOWNSWING) {
        // Faster and faster down through the ball.
        const u = (s / DOWNSWING) ** 2;
        phi = THREE.MathUtils.lerp(-g.top * BACKSWING, FOLLOW, u);
        finish = Math.max(0, phi / FOLLOW);
      } else if (s < DOWNSWING + FINISH) {
        phi = FOLLOW;
        finish = 1;
      } else if (s < DOWNSWING + FINISH + SETTLE) {
        const u = (s - DOWNSWING - FINISH) / SETTLE;
        finish = 1 - u * u * (3 - 2 * u);
        phi = FOLLOW * finish;
      } else {
        g.swingT = -1;
        g.back = g.want = 0;
        phi = 0;
      }
      if (g.swingT >= 0) g.back = 0;
    } else {
      g.back += (g.want - g.back) * Math.min(1, dt * 12);
      phi = -g.back * BACKSWING;
    }
    g.swing.rotation.set(-SWING_LEAN, 0, phi);
    // Both hands on the grip, wherever the swing has it.
    const r = 0.36;
    const down = -Math.cos(phi) * r;
    hands.set(SWING_AT.x + Math.sin(phi) * r, SWING_AT.y + down * Math.cos(SWING_LEAN), SWING_AT.z - down * Math.sin(SWING_LEAN));
    for (const [arm, sx] of [
      [this.armL, -0.33],
      [this.armR, 0.33],
    ] as const) {
      armDir.set(hands.x - sx, hands.y - 0.9, hands.z).normalize();
      arm.quaternion.setFromUnitVectors(DOWN, armDir);
    }
    // Shoulders turned away on the way back, round to the hole at the finish; eyes on the ball until it's gone.
    const coil = Math.min(0, phi) / BACKSWING;
    this.body.rotation.y = coil * 0.45 + finish * 0.5;
    this.head.rotation.x = 0.4 * (1 - finish) + 0.05;
    this.head.rotation.y = -coil * 0.35 + finish * 0.6;
    this.legL.rotation.set(0, 0, -0.1);
    this.legR.rotation.set(0, 0, 0.1);
  }

  /** Takes it out of the scene and frees its sprites (its materials are shared). */
  dispose() {
    this.medicPose(null);
    this.root.removeFromParent();
    if (this.label) disposeSprite(this.label);
    this.endEmote();
  }

  /** Overrides ordinary animation for a medic carrying a stretcher. Null restores normal limbs. */
  medicPose(pose: MedicPose | null) {
    if (!pose) {
      if (!this.medicRig) return;
      this.medicRig.limbs.forEach((limb, i) => limb.restore(i < 2));
      for (const item of this.medicRig.uniform) item.removeFromParent();
      for (const geometry of this.medicRig.geometries) geometry.dispose();
      for (const o of [this.crew, ...this.boots]) o.visible = true;
      const tag = this.label;
      if (tag) tag.visible = this.medicRig.labelVisible;
      this.medicRig = null;
      this.body.position.set(0, 0, 0);
      this.body.rotation.set(0, 0, 0);
      this.head.rotation.set(0, 0, 0);
      return;
    }
    if (!this.medicRig) {
      const forearm = new THREE.CapsuleGeometry(0.075, 0.14, 3, 8);
      const shin = new THREE.CapsuleGeometry(0.09, 0.04, 3, 8);
      const boot = new THREE.BoxGeometry(0.16, 0.09, 0.23);
      const patch = new THREE.BoxGeometry(1, 1, 1);
      const cap = new THREE.CylinderGeometry(0.34, 0.35, 0.12, 12);
      const limbs: MedicLimb[] = [];
      for (const [i, arm] of [this.armL, this.armR].entries()) {
        const hand = arm.children[1];
        hand.name = i ? 'medic-right-hand' : 'medic-left-hand';
        limbs.push(new MedicLimb(arm, hand, 0.29, 0.29, 0.4, forearm));
      }
      for (const [i, leg] of [this.legL, this.legR].entries()) {
        const foot = mesh(boot, toon('#202936'), 0, 0, 0, false);
        foot.name = i ? 'medic-right-foot' : 'medic-left-foot';
        limbs.push(new MedicLimb(leg, foot, 0.22, 0.22, 0.42, shin));
      }
      const hat = mesh(cap, this.shirt, 0, 0.39, 0, false);
      this.head.add(hat);
      const uniform: THREE.Object3D[] = [hat];
      for (const [w, h] of [
        [0.16, 0.045],
        [0.045, 0.16],
      ]) {
        const cross = mesh(patch, toon('#d84a45'), 0, 0.77, 0.265, false);
        cross.scale.set(w, h, 0.015);
        this.body.add(cross);
        uniform.push(cross);
      }
      for (const o of [this.crew, ...this.boots]) o.visible = false;
      this.medicRig = { limbs, geometries: [forearm, shin, boot, patch, cap], uniform, labelVisible: this.label?.visible ?? false, inverse: new THREE.Quaternion(), target: new THREE.Vector3() };
    }
    const rig = this.medicRig;
    // A medic on the job shows no name: its red cross takes the place of a badge.
    const tag = this.label;
    if (tag) tag.visible = false;
    this.body.position.set(0, -0.24 * pose.crouch, 0);
    this.body.rotation.set(0.4 * pose.crouch, 0, 0);
    rig.inverse.copy(this.body.quaternion).invert();
    rig.target.copy(pose.left).sub(this.body.position).applyQuaternion(rig.inverse);
    rig.limbs[0].pose(rig.target, -1, 0.2);
    rig.target.copy(pose.right).sub(this.body.position).applyQuaternion(rig.inverse);
    rig.limbs[1].pose(rig.target, 1, 0.2);
    for (let i = 0; i < 2; i++) {
      const step = Math.sin(pose.stride + i * Math.PI) * (1 - pose.crouch);
      rig.target
        .set(i ? 0.13 : -0.13, 0.115 + Math.max(0, step) * 0.055, step * 0.12)
        .sub(this.body.position)
        .applyQuaternion(rig.inverse);
      const limb = rig.limbs[i + 2];
      limb.pose(rig.target, 0, 1);
      limb.endpoint.quaternion.copy(limb.lower.quaternion).invert().multiply(rig.inverse);
    }
    this.head.rotation.set(0.15 * pose.crouch, 0, 0);
  }

  /**
   * A .44 Magnum in the right fist, posed (see GunMotion: drawn, holstered, mid-trick), or away in
   * its holster (null). The arm swings up to aim as it draws.
   */
  setGunPose(pose: Readonly<GunPose> | null) {
    if (!pose) {
      if (!this.gun) return;
      disposeGun(this.gun.prop);
      this.gun.mount.removeFromParent();
      this.gun = null;
      this.armL.rotation.set(0, 0, 0);
      this.finger.visible = this.emoting?.emote.id === 'point';
      return;
    }
    if (this.gun) {
      this.gun.pose = pose;
      return;
    }
    const mount = new THREE.Group();
    mount.position.copy(PERSON_GUN_MOUNT);
    // The muzzle down the arm, out of the fist: aiming the arm aims the gun.
    mount.rotation.x = Math.PI / 2;
    // The wrist turns the gun round the grip; the pivot spins it on the trigger finger.
    const wrist = new THREE.Group();
    const pivot = new THREE.Group();
    pivot.position.copy(SPIN_AT);
    const prop = magnum();
    prop.position.copy(SPIN_AT).negate();
    const muzzle = new Muzzle();
    prop.add(muzzle.group);
    pivot.add(prop);
    wrist.add(pivot);
    mount.add(wrist);
    this.armL.add(mount);
    this.gun = { mount, wrist, pivot, prop, muzzle, pose };
  }

  /** Fires it: a flash at the muzzle (the recoil is the pose's kick). */
  fire() {
    this.gun?.muzzle.fire();
  }

  /** Where the gun's muzzle is, or null with the gun holstered. */
  muzzleTip(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.gun) return null;
    return this.gun.muzzle.group.localToWorld(out.set(0, 0, 0.12));
  }

  /**
   * The gun's pose over whatever the right arm was doing: the hand's place swings the arm (up,
   * and across the body), its turn is the wrist's, and the gun spins, turns and flies off the
   * fist as in first person. Holstered, the arm hangs and the gun slips into the hip.
   */
  private gunStep(dt: number) {
    const g = this.gun!;
    const p = g.pose;
    const out = p.out;
    const lerp = THREE.MathUtils.lerp;
    // Forward is +z, so the character's right arm is the one on -x (armL), as in reach.
    const arm = this.armL;
    arm.rotation.x = lerp(arm.rotation.x, -1.55 - p.y * 2.6 - p.z * 1.6 - p.kick * 0.55, out);
    arm.rotation.z = lerp(arm.rotation.z, 0.12 - p.x * 2.4 + p.z * 1.8, out);
    arm.rotation.y = 0;
    g.prop.scale.setScalar(THREE.MathUtils.smoothstep(out, 0.02, 0.3) || 0.001);
    g.wrist.rotation.set(-p.pitch, p.yaw, -p.roll);
    g.mount.position.copy(PERSON_GUN_MOUNT);
    g.mount.position.y -= 0.035 * p.finger;
    if (p.lift) g.mount.position.add(v1.set(0, p.lift * 1.7, 0).applyQuaternion(q1.copy(arm.quaternion).invert()));
    g.pivot.rotation.set(p.spin, p.turn, p.tilt);
    setCylinder(g.prop, p.crane, p.cylinder);
    this.finger.visible = p.finger > 0.5;
    // The other hand comes over to spin the cylinder.
    if (p.left > 0) {
      this.armR.rotation.x = lerp(this.armR.rotation.x, -1.45 - p.palm * 0.12, p.left);
      this.armR.rotation.z = lerp(this.armR.rotation.z, -0.6, p.left);
    }
    // Looking down at it while it's brought in close.
    const look = THREE.MathUtils.clamp(p.z / 0.1, 0, 1.6);
    this.head.rotation.x += 0.22 * look;
    this.head.rotation.y -= 0.3 * look;
    g.muzzle.update(dt);
  }

  /** `pace` speeds up the walk cycle for someone walking faster than usual. */
  update(dt: number, _t: number, moving: boolean, airborne: boolean, pace = 1) {
    const target = moving ? 1 : 0;
    this.walkPhase += dt * 11 * target * pace;
    const swing = Math.sin(this.walkPhase) * 0.7 * target;
    if (airborne) {
      this.legL.rotation.x = -0.5;
      this.legR.rotation.x = 0.3;
      this.armL.rotation.z = -2.4;
      this.armR.rotation.z = 2.4;
      this.armL.rotation.x = this.armR.rotation.x = 0;
    } else {
      this.legL.rotation.x = swing;
      this.legR.rotation.x = -swing;
      this.armL.rotation.x = -swing;
      this.armR.rotation.x = swing;
      this.armL.rotation.z = THREE.MathUtils.lerp(this.armL.rotation.z, -0.1, 0.3);
      this.armR.rotation.z = THREE.MathUtils.lerp(this.armR.rotation.z, 0.1, 0.3);
    }
    this.sitK += ((this.hips === null ? 0 : 1) - this.sitK) * Math.min(1, dt * 10);
    const sit = this.sitK > 0.001 ? this.sitK : 0;
    if (sit) {
      // Legs out over the edge of the seat, hands in the lap (a cigarette still comes up for a drag).
      for (const leg of [this.legL, this.legR]) leg.rotation.x = THREE.MathUtils.lerp(leg.rotation.x, -1.35, sit);
      for (const arm of [this.armL, this.armR]) arm.rotation.x = THREE.MathUtils.lerp(arm.rotation.x, -0.55, sit);
    }
    if (this.smokeT >= 0) this.smokeStep(dt, moving, airborne);
    if (this.book) {
      // Both arms out in front, hands under the book's bottom corners.
      this.armL.rotation.set(-1.5, 0, 0.32);
      this.armR.rotation.set(-1.5, 0, -0.32);
      this.book.update(dt);
    } else if (this.card.held || this.ball) {
      // Both arms out in front, hands on the card's edges (or either side of the ball): they don't swing while they walk.
      this.armL.rotation.set(-1.25, 0, 0.3);
      this.armR.rotation.set(-1.25, 0, -0.3);
    }
    if (this.shootT >= 0) {
      this.shootT += dt;
      const k = reachCurve(this.shootT / 0.5);
      for (const [arm, side] of [
        [this.armL, 1],
        [this.armR, -1],
      ] as const) {
        arm.rotation.x = THREE.MathUtils.lerp(arm.rotation.x, -2.75, k);
        arm.rotation.z = THREE.MathUtils.lerp(arm.rotation.z, side * 0.12, k);
      }
      if (this.shootT >= 0.5) this.shootT = -1;
    }
    let reach = 0;
    if (this.reachT >= 0) {
      this.reachT += dt;
      reach = reachCurve(this.reachT / REACH_TIME);
      // Forward is +z, so the character's right arm is the one on -x.
      this.armL.rotation.x = THREE.MathUtils.lerp(this.armL.rotation.x, -1.65, reach);
      this.armL.rotation.z = THREE.MathUtils.lerp(this.armL.rotation.z, 0.22, reach);
      if (this.reachT >= REACH_TIME) this.reachT = -1;
    }
    // Lean into the reach a little.
    this.body.rotation.x = reach * 0.12;
    this.body.rotation.z = 0;
    if (this.grip === 'ladder') {
      const c = Math.sin(this.walkPhase);
      this.armL.rotation.set(-2.55 + c * 0.35, 0, -0.12);
      this.armR.rotation.set(-2.55 - c * 0.35, 0, 0.12);
      this.legL.rotation.set(-0.55 - c * 0.45, 0, 0);
      this.legR.rotation.set(-0.55 + c * 0.45, 0, 0);
      this.body.rotation.x = -0.08;
    } else if (this.grip === 'pole') {
      this.armL.rotation.set(0, 0, 2.95);
      this.armR.rotation.set(0, 0, 2.45);
      this.legL.rotation.set(-0.35, 0, 0.25);
      this.legR.rotation.set(-1.15, 0, 0.35);
      this.body.rotation.z = -0.16;
    }
    if (this.mug.visible) this.mug.quaternion.copy(this.armR.quaternion).invert();
    this.body.position.y = moving && !airborne ? Math.abs(Math.sin(this.walkPhase)) * 0.06 : 0;
    // Down onto (or up onto) the seat: the hips go where it puts them.
    if (sit) this.body.position.y = THREE.MathUtils.lerp(this.body.position.y, this.seatHips - HIPS, sit);

    // Reading, they look down into the book.
    this.head.rotation.x = this.book ? 0.32 : 0;
    this.head.rotation.y = this.head.rotation.z = 0;
    this.body.rotation.y = this.body.rotation.z = 0;
    if (this.emoting) this.emoteStep(dt, moving || airborne ? 0 : 1 - sit);
    if (this.golf && !sit && !airborne) this.golfStep(dt);
    if (this.gun) this.gunStep(dt);
  }
}

// -----------------------------------------------------------------------------------------------

const STATUS_BULB: Record<string, string> = {
  starting: '#8c8c8c',
  idle: '#5aa9e6',
  working: '#f2b84b',
  needs_input: '#ef4444',
  done: '#3ccf91',
  exited: '#6c757d',
  offline: '#6c757d',
};

/** Status pill on a worker's task card: [text, background, text color]. */
const TASK_CHIP: Record<string, [string, string, string]> = {
  starting: ['STARTING', STATUS_BULB.starting, '#2b2d42'],
  idle: ['READY', STATUS_BULB.idle, '#2b2d42'],
  working: ['WORKING', STATUS_BULB.working, '#2b2d42'],
  needs_input: ['NEEDS YOU', STATUS_BULB.needs_input, '#ffffff'],
  done: ['DONE', STATUS_BULB.done, '#2b2d42'],
  exited: ['ASLEEP', STATUS_BULB.exited, '#ffffff'],
  offline: ['ASLEEP', STATUS_BULB.offline, '#ffffff'],
};

/** Card chips are drawn like the DOM's status pills: the status color as ink on a dark pill. */
const CHIP_BG = '#101010';

/** A worker's pull request as its bubble shows it: open or merged, and the words to label it with ("🎉 MR !12 merged"). */
export interface PrBadge {
  state: WorkerPr['state'];
  label: string;
}

/** The chip (or bubble) of a worker whose worktree was deleted outside the office. */
const LOST_CHIP: [string, string, string] = ['WORKTREE DELETED', '#ffb703', '#2b2d42'];

/** The outline of a worker's bubble, and its pill, once it has a pull request: GitHub's open green, or the PR board's merged purple. */
const PR_INK: Record<WorkerPr['state'], string> = { open: '#2da44e', merged: '#9d4edd' };

/** Not working on or waiting for something more: its pull request in place of ready / done / asleep. */
function prShown(status: WorkerStatus, pr: PrBadge | undefined): PrBadge | undefined {
  return pr && status !== 'working' && status !== 'needs_input' && status !== 'starting' ? pr : undefined;
}

/** The pill on a worker's task card: [text, background, text color]. */
function cardChip(status: WorkerStatus, pr: PrBadge | undefined, lost: boolean): readonly [string, string, string] {
  if (lost) return LOST_CHIP;
  const shown = prShown(status, pr);
  if (shown) return [plainLabel(shown.label).toUpperCase(), PR_INK[shown.state], '#ffffff'];
  return TASK_CHIP[status] ?? TASK_CHIP.idle;
}

/**
 * What a worker's body is doing: resting, arms up for joy, arms crossed waiting on you, typing, or
 * acting out its latest tool call.
 */
type Act = 'rest' | 'up' | 'waiting' | 'type' | WorkerAction;

/** One way of holding itself, blended into the next over a moment (see Worker.update). */
interface Stance {
  /** Arms swung forward (x below 0 reaches toward the desk, -2.6 is straight up) and in toward the middle (z). The left arm is the one on -x. */
  armLx: number;
  armRx: number;
  armLz: number;
  armRz: number;
  /** 0..1: shoulders brought forward and in, for arms that wrap round the front (crossed, or holding its head). */
  reach: number;
  /** Shoulders lowered, so crossed arms sit on its belly and not under its eyes. */
  drop: number;
  /** Leaning toward the desk (+) or back (-), turned, tipped to the side, bobbing up. */
  lean: number;
  turn: number;
  roll: number;
  lift: number;
  /** How far its right foot is lifted, tapping, and both feet stretched out in front. */
  tap: number;
  kick: number;
  /** Eyes open (1) or narrowed, and looking up (+) or down (-). */
  lid: number;
  look: number;
}

const STANCE_KEYS = ['armLx', 'armRx', 'armLz', 'armRz', 'reach', 'drop', 'lean', 'turn', 'roll', 'lift', 'tap', 'kick', 'lid', 'look'] as const;

function stanceOf(act: Act, t: number, s: Stance): Stance {
  s.armLx = s.armRx = -0.3;
  s.armLz = s.armRz = s.reach = s.drop = s.lean = s.turn = s.roll = s.tap = s.kick = s.look = 0;
  s.lift = Math.sin(t * 2) * 0.015;
  s.lid = 1;
  switch (act) {
    case 'up':
      s.armLx = s.armRx = -2.6;
      s.lift = 0;
      break;
    case 'type':
      s.armLx = -1.2 + Math.sin(t * 22) * 0.25;
      s.armRx = -1.2 + Math.sin(t * 22 + 1.7) * 0.25;
      s.lift = Math.abs(Math.sin(t * 11)) * 0.02;
      break;
    case 'edit':
      // Hunched over the keys, typing flat out.
      s.armLx = -1.25 + Math.sin(t * 34) * 0.34;
      s.armRx = -1.25 + Math.sin(t * 34 + 1.9) * 0.34;
      s.lean = 0.16;
      s.lift = Math.abs(Math.sin(t * 17)) * 0.035;
      s.look = -0.02;
      break;
    case 'read':
      // The papers held up in front, eyes running down the page.
      s.armLx = s.armRx = -2.05;
      s.armLz = 0.3;
      s.armRz = -0.3;
      s.lean = -0.06;
      s.look = -0.01 - ((t * 0.9) % 1) * 0.03;
      break;
    case 'test':
      // Leaning back, hands behind its head, feet out: waiting on the run.
      s.armLx = s.armRx = -3.3;
      s.armLz = 0.55;
      s.armRz = -0.55;
      s.lean = -0.32;
      s.roll = Math.sin(t * 1.3) * 0.04;
      s.kick = 0.08;
      s.look = 0.025;
      s.lift = 0;
      break;
    case 'web':
      // Scrolling with one hand, looking up at the globe.
      s.armLx = -1.2 + Math.sin(t * 9) * 0.15;
      s.armRx = -0.8;
      s.lean = -0.1;
      s.look = 0.03;
      break;
    case 'failing':
      // Head in its hands, shaking it slowly.
      s.armLx = s.armRx = -2;
      s.armLz = 0.45;
      s.armRz = -0.45;
      s.reach = 1;
      s.lean = 0.38;
      s.turn = Math.sin(t * 2.4) * 0.16;
      s.lid = 0.55;
      s.look = -0.035;
      s.lift = 0;
      break;
    case 'waiting': {
      // Arms crossed, hip cocked, tapping a foot.
      const tap = Math.max(0, Math.sin(t * 16));
      s.armLx = -1.05;
      s.armRx = -1.2;
      s.armLz = 1;
      s.armRz = -1;
      s.reach = 1;
      s.drop = 0.11;
      s.roll = 0.07;
      s.tap = tap;
      s.lift = tap * 0.012;
      s.lid = 0.6;
      break;
    }
  }
  return s;
}

/** How long a worker keeps acting something out before the next thing, so quick tool calls don't flicker. */
const ACT_MIN = 1.2;
/** Head in its hands lasts at least this long, so you catch it. */
const DESPAIR_MIN = 4;
/** Waiting on you: it jumps this long (seconds), then taps its foot with its arms crossed until the cycle comes round. */
const WAIT_HOPS = 2;
const WAIT_CYCLE = 4.6;
/** A full spin when it finishes, this long. */
const TWIRL_TIME = 0.9;

const ease = (x: number) => x * x * (3 - 2 * x);
/** 0 → 1 with a little overshoot, for props popping in. */
const popIn = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 + 2.7 * (x - 1) ** 3 + 1.7 * (x - 1) ** 2);

/** A stack of papers held up to read, bound at the top; its top sheet flips over. The sheets face -z. */
function papers(): { group: THREE.Group; page: THREE.Group } {
  const group = new THREE.Group();
  const W = 0.34;
  const H = 0.44;
  const paper = toon('#fffaf3');
  const ink = toon('#8d99ae');
  ['#f1ece2', '#f7f3ea', '#fffaf3'].forEach((c, i) => {
    const sheet = mesh(new THREE.BoxGeometry(W, H, 0.008), toon(c), (i - 1) * 0.012, -H / 2 - i * 0.006, 0.02 - i * 0.012, false);
    sheet.rotation.z = (i - 1) * 0.04;
    group.add(sheet);
  });
  const lines = (on: THREE.Object3D, z: number) => {
    for (let i = 0; i < 6; i++) {
      const short = i % 3 === 2;
      on.add(mesh(new THREE.BoxGeometry(W * (short ? 0.45 : 0.72), 0.018, 0.004), ink, short ? -W * 0.135 : 0, -0.07 - i * 0.055, z, false));
    }
  };
  lines(group, -0.01);
  // The top sheet hangs from the binding, so it flips up over the top.
  const page = new THREE.Group();
  page.add(mesh(new THREE.BoxGeometry(W, H, 0.008), paper, 0, -H / 2, -0.016, false));
  lines(page, -0.022);
  group.add(page);
  group.add(mesh(new THREE.BoxGeometry(W * 0.5, 0.05, 0.05), toon('#adb5bd'), 0, 0, 0, false));
  return { group, page };
}

/** A little globe: blue sea, green blobs of land and a gold ring round its middle. */
function globe(): { group: THREE.Group; ball: THREE.Group; ring: THREE.Mesh } {
  const group = new THREE.Group();
  const ball = new THREE.Group();
  const r = 0.26;
  ball.add(mesh(new THREE.SphereGeometry(r, 20, 14), toon('#4cc9f0'), 0, 0, 0, false));
  const land = toon('#6fcf6a');
  for (const [lat, lon, size] of [
    [0.5, 0.2, 0.5],
    [0.1, 0.9, 0.4],
    [-0.4, 0.5, 0.45],
    [0.3, 2.4, 0.6],
    [-0.2, 3.3, 0.4],
    [0.6, 4.4, 0.45],
    [-0.5, 5.2, 0.35],
  ]) {
    const blob = mesh(new THREE.SphereGeometry(size * r, 10, 8), land, Math.cos(lat) * Math.sin(lon) * r * 0.86, Math.sin(lat) * r * 0.86, Math.cos(lat) * Math.cos(lon) * r * 0.86, false);
    blob.scale.set(1.2, 0.8, 1.2);
    ball.add(blob);
  }
  ball.rotation.z = 0.41;
  group.add(ball);
  const ring = mesh(new THREE.TorusGeometry(r * 1.35, 0.016, 6, 32), toon('#ffd166', { emissive: '#7a5b00' }), 0, 0, 0, false);
  ring.rotation.x = Math.PI / 2 - 0.2;
  group.add(ring);
  return { group, ball, ring };
}

/** Where a worker climbs up to dance, in the frame of the seat it sits in (see DeskView.stage). */
export interface Stage {
  pos: THREE.Vector3;
  /** Which way it faces up there, turned from the way it faces in its seat. */
  yaw: number;
}

/** Seconds a beat: a quick 140 to the minute. */
const BEAT = 60 / 140;
/** A dance's parts, in seconds: the hop up on to the desk, eight beats of moves, the hop back down. */
const DANCE = { up: 0.5, moves: 8 * BEAT, down: 0.5 } as const;
/** How high a hop between the seat and the desk goes, over the straight line. */
const HOP = 0.5;

/** The little Droid worker that sits at a desk. Forward is +z. */
export class Worker {
  readonly root = new THREE.Group();
  private body = new THREE.Group();

  /** Its antenna bulb, lit in its status color so you can tell from across the room. */
  private bulb: { mat: THREE.MeshToonMaterial; mesh: THREE.Mesh };
  private armL: THREE.Object3D;
  private armR: THREE.Object3D;
  private bubble: THREE.Sprite | null = null;
  private bubbleKey = '';
  /** The bubble is a task card: it hangs from its tail instead of floating. */
  private bubbleIsCard = false;
  private task: WorkerTask | undefined;
  /** Its pull request, open or merged: its bubble is outlined (and labelled, while it rests) to match. */
  private pr: PrBadge | undefined;
  /** Its worktree was deleted outside the office (WorkerInfo.lost): its bubble says so until it's fixed. */
  private lost = false;
  private nameTag: THREE.Sprite | null = null;
  private name = '';
  private eyes: THREE.Mesh[] = [];
  private blinkAt = Math.random() * 4;
  status: WorkerStatus = 'starting';
  bouncing = false;
  /** You're close enough to read its card: it lands the hop it's in and stands still until you walk away. */
  held = false;
  private bounceT = 0;
  private spawnT = 0;
  /** Seconds left jumping for joy (its pull request just merged). */
  private cheerT = 0;
  /** Up on its desk dancing (a pull request merged): where, and how many seconds in. */
  private dancing: { stage: Stage; t: number } | null = null;
  private pupils: THREE.Mesh[] = [];
  private feet: THREE.Mesh[] = [];
  /** Sent home: the box of its things in its arms, and how far into its waddle it is. */
  private leaving: { box: THREE.Group; boxT: number; stride: number } | null = null;
  /** Shot: light out, face slack, flat where it fell while its session keeps running (see die). */
  private dead = false;
  /** On its way out (sent home) or in (called to a meeting): it waddles along instead of standing. */
  walking = false;
  /** What its latest tool call was (see setAction), and what it's acting out right now. */
  private nextAction: WorkerAction | undefined;
  private action: WorkerAction | undefined;
  private actionT = 0;
  /** How much of each act is in its stance right now, blending from one to the next. */
  private acts = new Map<Act, number>();
  private stance = {} as Stance;
  private blend = {} as Stance;
  /** Seconds it has been waiting on you, for the jump / tap-its-foot cycle. */
  private waitT = 0;
  private turnY = 0;
  /** Seconds into its finishing spin, or -1. */
  private twirlT = -1;
  private flipT = 0;
  private papers: ReturnType<typeof papers>;
  private globe: ReturnType<typeof globe>;
  /** Beside its laptop, where the globe floats (see setPropSpot). */
  private spot = new THREE.Vector3(-1, 1.1, 1.3);
  private skin: THREE.MeshToonMaterial;
  /** Its Factory crew kit: lanyard, ID card and pinwheel patches. */
  private crew: THREE.Group;
  /** How far through its stride it is, walking in. */
  private stride = 0;

  constructor(
    name: string,
    private color: string,
  ) {
    const skin = (this.skin = toonUnique(color));
    const white = toon('#ffffff');
    const ink = toon('#1d1d1d');

    this.root.add(this.body);
    // Bean-shaped body
    const bean = mesh(new THREE.CapsuleGeometry(0.28, 0.3, 8, 16), skin, 0, 0.55, 0);
    this.body.add(bean);
    // Big cartoon eyes
    for (const sx of [-1, 1]) {
      const eye = mesh(new THREE.SphereGeometry(0.09, 12, 10), white, sx * 0.11, 0.7, 0.23, false);
      eye.scale.z = 0.6;
      this.body.add(eye);
      const pupil = mesh(new THREE.SphereGeometry(0.045, 10, 8), ink, sx * 0.11, 0.7, 0.29, false);
      this.body.add(pupil);
      this.eyes.push(eye, pupil);
      this.pupils.push(pupil);
    }
    // Headset: band, ear cups and a mic with Factory's orange LED on it.
    this.body.add(mesh(headset(), toon(CREW.graphite), 0, 0, 0, false));
    const led = mesh(new THREE.SphereGeometry(0.024, 8, 6), ledMaterial(), MIC.x, MIC.y, MIC.z, false);
    led.name = 'headset-led';
    this.body.add(led);
    // Its crew kit: lanyard, ID card and patches.
    this.crew = workerKit();
    this.body.add(this.crew);
    // Antenna with status bulb.
    this.body.add(mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.22, 6), toon(CREW.graphite), 0, 1.07, 0, false));
    const mat = toonUnique(STATUS_BULB.starting);
    mat.emissive = new THREE.Color(STATUS_BULB.starting).multiplyScalar(0.6);
    this.bulb = { mat, mesh: mesh(new THREE.SphereGeometry(0.075, 12, 10), mat, 0, 1.2, 0, false) };
    this.body.add(this.bulb.mesh);

    const arm = (x: number) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.55, 0.05);
      pivot.add(mesh(new THREE.CapsuleGeometry(0.055, 0.16, 4, 8), skin, 0, -0.12, 0));
      this.body.add(pivot);
      return pivot;
    };
    this.armL = arm(-0.3);
    this.armR = arm(0.3);
    // Black work boots.
    for (const sx of [-1, 1]) {
      const foot = mesh(new THREE.CapsuleGeometry(0.06, 0.1, 4, 8), toon(CREW.black), sx * 0.12, 0.2, 0.05);
      this.body.add(foot);
      this.feet.push(foot);
    }

    // What it acts out with: papers in its hands, and a globe beside its laptop.
    this.papers = papers();
    this.papers.group.position.set(0, 0.86, 0.4);
    this.papers.group.rotation.x = 0.35;
    this.body.add(this.papers.group);
    this.globe = globe();
    for (const prop of [this.papers.group, this.globe.group]) prop.visible = false;
    this.root.add(this.globe.group);

    this.setName(name);
  }

  /** Where the globe floats, in its own space: beside its laptop, where the card over its head doesn't hide it. */
  setPropSpot(at: THREE.Vector3) {
    this.spot.copy(at);
  }

  /** What its latest tool call was, to act out while it's working. */
  setAction(action: WorkerAction | undefined) {
    this.nextAction = action;
  }

  /** Just finished: a quick spin and a hop. */
  celebrate() {
    if (this.dead) return;
    this.twirlT = 0;
    this.cheer(1.2);
  }

  setName(name: string) {
    this.name = name;
    if (this.nameTag) {
      this.root.remove(this.nameTag);
      disposeSprite(this.nameTag);
    }
    this.nameTag = textSprite(name, { bg: '#0a0a0a', color: '#eeeeee', size: 36, border: '#2f2f2f' });
    this.nameTag.position.y = 1.55;
    this.root.add(this.nameTag);
  }

  setStatus(status: WorkerStatus, bounce: boolean) {
    this.status = status;
    // Down on the floor, the session runs on but the light stays out and the bubble stays gone.
    if (this.dead) {
      this.bouncing = false;
      return;
    }
    this.bouncing = bounce;
    if (!this.dancing) this.paintBulb();
    this.drawBubble();
  }

  private paintBulb() {
    const c = STATUS_BULB[this.status] ?? '#8c8c8c';
    this.bulb.mat.color.set(c);
    this.bulb.mat.emissive.set(c).multiplyScalar(0.7);
  }

  /** Light out: shot, or on its way home. */
  private bulbOut() {
    this.bulb.mat.color.set(STATUS_BULB.exited);
    this.bulb.mat.emissive.set('#000000');
  }

  /** The bulb's size, 1 at rest. */
  private bulbScale(scale: number) {
    this.bulb.mesh.scale.setScalar(scale);
  }

  /** Jumps for joy, arms up, for a few seconds. */
  cheer(seconds = 3) {
    this.cheerT = seconds;
  }

  /**
   * Hops up on to `stage` (its desk), dances for a few seconds with its light flashing like a disco
   * ball, and hops back down into its seat. Asked again mid-dance, it stays up and dances on.
   */
  dance(stage: Stage) {
    if (this.leaving || this.dead) return;
    const d = this.dancing;
    if (!d) {
      this.dancing = { stage, t: 0 };
      // The dance has a twirl of its own, so a finishing spin it cut into doesn't play after it.
      this.twirlT = -1;
    } else if (d.t > DANCE.up + DANCE.moves) {
      // On its way down: back up from wherever it is in the air.
      d.t = DANCE.up * (1 - (d.t - DANCE.up - DANCE.moves) / DANCE.down);
    } else d.t = Math.min(d.t, DANCE.up);
  }

  /** Back in its seat at once, mid-dance or not (it's being sent home). */
  stopDancing() {
    if (!this.dancing) return;
    this.dancing = null;
    this.settle();
  }

  /** What it's working on, shown on a card over its head in place of the status bubble. */
  setTask(task: WorkerTask | undefined) {
    this.task = task;
    this.drawBubble();
  }

  setPr(pr: PrBadge | undefined) {
    this.pr = pr;
    this.drawBubble();
  }

  setLost(lost: boolean) {
    this.lost = lost;
    this.drawBubble();
  }

  /** Sent home: its light goes out, its face falls, and its things pop into a box in its arms. `farewell` goes over its head. */
  leave(farewell: string) {
    if (this.leaving) return;
    this.bouncing = false;
    this.cheerT = 0;
    this.bounceT = 0;
    this.twirlT = -1;
    for (const prop of [this.papers.group, this.globe.group]) prop.visible = false;
    this.armL.position.set(-0.3, 0.55, 0.05);
    this.armR.position.set(0.3, 0.55, 0.05);
    this.feet.forEach((f, i) => f.position.set(i ? 0.12 : -0.12, 0.2, 0.05));
    for (const p of this.pupils) p.position.y = 0.7;
    this.bulbOut();
    if (this.bubble) {
      this.root.remove(this.bubble);
      disposeSprite(this.bubble);
      this.bubble = null;
    }
    this.bubbleKey = 'leaving';
    this.bubbleIsCard = false;
    this.bubble = textSprite(farewell, { bg: '#0a0a0a', color: '#eeeeee', border: '#2f2f2f', size: 34 });
    this.root.add(this.bubble);
    // Looking down, brows up in the middle.
    for (const p of this.pupils) p.position.y -= 0.035;
    for (const sx of [-1, 1]) {
      const brow = mesh(new THREE.CapsuleGeometry(0.014, 0.08, 4, 6), toon('#1d1d1d'), sx * 0.11, 0.83, 0.228, false);
      brow.rotation.z = Math.PI / 2 - sx * 0.4;
      this.body.add(brow);
    }
    // Hugged to its belly, the arms round the sides.
    const box = boxOfStuff();
    box.position.set(0, 0.22, 0.33);
    box.scale.setScalar(0.001);
    this.body.add(box);
    this.leaving = { box, boxT: 0, stride: 0 };
  }

  /** On its way out: says something else over its head in place of its farewell. */
  say(text: string) {
    if (!this.leaving) return;
    if (this.bubble) {
      this.root.remove(this.bubble);
      disposeSprite(this.bubble);
    }
    this.bubble = textSprite(text, { bg: '#0a0a0a', color: '#eeeeee', border: '#2f2f2f', size: 34 });
    this.root.add(this.bubble);
  }

  /** Shot: its light goes out, its face goes slack and its bubble goes away. Its session runs on. */
  die() {
    if (this.dead) return;
    this.dead = true;
    this.stopDancing();
    this.bouncing = false;
    this.cheerT = 0;
    this.bounceT = 0;
    this.twirlT = -1;
    for (const prop of [this.papers.group, this.globe.group]) prop.visible = false;
    this.armL.position.set(-0.3, 0.55, 0.05);
    this.armR.position.set(0.3, 0.55, 0.05);
    this.feet.forEach((f, i) => f.position.set(i ? 0.12 : -0.12, 0.2, 0.05));
    this.bulbOut();
    if (this.bubble) {
      this.root.remove(this.bubble);
      disposeSprite(this.bubble);
      this.bubble = null;
    }
    this.bubbleKey = 'dead';
    for (const p of this.pupils) p.position.y = 0.62;
  }

  /** Revived: back on its feet with its session untouched, light and bubble as its status says. */
  revive() {
    if (!this.dead) return;
    this.dead = false;
    for (const p of this.pupils) p.position.y = 0.7;
    for (const e of this.eyes) e.scale.y = 1;
    this.settle();
    this.bubbleKey = '';
    this.drawBubble();
  }

  private drawBubble() {
    if (this.leaving || this.dead) return;
    const { status, bouncing: bounce, task, pr, lost } = this;
    const hot = status === 'needs_input' || (status === 'done' && bounce);
    // Every card is a dark panel; what it needs from you shows in its outline, not a pastel fill.
    const signal = hot || status === 'working' ? STATUS_BULB[status] : undefined;
    const border = (pr && PR_INK[pr.state]) || signal;
    const prLabel = prShown(status, pr)?.label;
    const bubble = lost
      ? 'WORKTREE DELETED'
      : prLabel !== undefined
        ? plainLabel(prLabel).toUpperCase()
        : status === 'needs_input'
          ? '! NEEDS YOU'
          : status === 'done' && bounce
            ? '\u2713 DONE'
            : status === 'working'
              ? '\u25B8 WORKING'
              : isAsleep(status)
                ? 'ZZZ'
                : '';
    const key = `${lost}|${border}|${prLabel}|${task ? `${status}|${bounce}|${task.name}|${task.summary}` : bubble}`;
    if (key === this.bubbleKey) return;
    this.bubbleKey = key;
    if (this.bubble) {
      this.root.remove(this.bubble);
      disposeSprite(this.bubble);
      this.bubble = null;
    }
    this.bubbleIsCard = !!task;
    if (task) {
      const [text, ink] = cardChip(status, pr, lost);
      this.bubble = cardSprite({
        chip: { text, bg: CHIP_BG, color: ink },
        title: task.name,
        body: task.summary,
        bg: '#0a0a0a',
        border: border ?? '#eeeeee',
        color: '#ffffff',
        muted: '#a6a6a6',
      });
    } else if (bubble) this.bubble = textSprite(bubble, { bg: '#0a0a0a', color: lost ? LOST_CHIP[1] : (border ?? '#eeeeee'), border: border ?? (lost ? LOST_CHIP[1] : '#2f2f2f'), size: 38 });
    if (this.bubble) this.root.add(this.bubble);
  }

  update(dt: number, t: number) {
    if (this.leaving) return this.carry(this.leaving, dt, t);
    if (this.dancing) return this.boogie(this.dancing, dt, t);
    if (this.dead) return this.flatline(dt);
    this.cheerT = Math.max(0, this.cheerT - dt);
    // Waiting on you: a couple of seconds of jumping, then arms crossed and a tapping foot, and round again.
    this.waitT = this.status === 'needs_input' ? this.waitT + dt : 0;
    const tapping = this.status === 'needs_input' && (this.held || this.waitT % WAIT_CYCLE >= WAIT_HOPS);
    // Jump up and down when done / waiting on a human (except while held or tapping), or cheering.
    if (this.bouncing || this.cheerT > 0) {
      const landAt = Math.ceil(this.bounceT / Math.PI) * Math.PI;
      this.bounceT += dt * 7;
      if ((this.held || tapping) && !this.cheerT && this.bounceT >= landAt) this.bounceT = 0;
    } else this.bounceT = 0;
    const hopping = this.bounceT > 0;
    // Pop-in when hired
    this.spawnT = Math.min(1, this.spawnT + dt * 2.5);
    const pop = this.spawnT < 1 ? 1 + Math.sin(this.spawnT * Math.PI) * 0.35 : 1;

    this.actionT += dt;
    if (this.nextAction !== this.action && this.actionT >= (this.action === 'failing' ? DESPAIR_MIN : ACT_MIN)) {
      this.action = this.nextAction;
      this.actionT = 0;
    }
    const act: Act = hopping || (this.bouncing && this.status === 'done') ? 'up' : this.status === 'needs_input' ? 'waiting' : this.status === 'working' ? (this.action ?? 'type') : 'rest';
    const s = this.pose(act, dt, t);

    this.armL.rotation.set(s.armLx, 0, s.armLz);
    this.armR.rotation.set(s.armRx, 0, s.armRz);
    this.armL.position.set(-0.3 + s.reach * 0.07, 0.55 - s.drop, 0.05 + s.reach * 0.12);
    this.armR.position.set(0.3 - s.reach * 0.07, 0.55 - s.drop + s.reach * 0.04, 0.05 + s.reach * 0.14);
    this.feet.forEach((f, i) => f.position.set(i ? 0.12 : -0.12, 0.2 + (i ? s.tap * 0.07 : 0), 0.05 + s.kick + (i ? s.tap * 0.03 : 0)));
    for (const p of this.pupils) p.position.y = 0.7 + s.look;
    this.body.rotation.x = s.lean;
    let twirl = 0;
    if (this.twirlT >= 0) {
      this.twirlT += dt;
      twirl = ease(Math.min(1, this.twirlT / TWIRL_TIME)) * Math.PI * 2;
      if (this.twirlT >= TWIRL_TIME) this.twirlT = -1;
    }
    if (hopping) {
      const h = Math.abs(Math.sin(this.bounceT));
      this.body.position.y = h * 0.55;
      const squash = h < 0.15 ? 1 - (0.15 - h) * 1.6 : 1;
      this.body.scale.set(pop * (2 - squash), pop * squash, pop * (2 - squash));
      this.turnY = Math.sin(this.bounceT * 0.5) * 0.3;
    } else {
      this.body.position.y = s.lift;
      this.body.scale.setScalar(pop);
      this.turnY += (s.turn - this.turnY) * Math.min(1, dt * 6);
    }
    this.body.rotation.y = this.turnY + twirl;
    this.body.rotation.z = isAsleep(this.status) ? Math.sin(t * 1.5) * 0.08 : s.roll;
    this.props(dt, t);
    this.blink(dt, s.lid);
    this.bulbScale(this.status === 'needs_input' ? 1 + Math.abs(Math.sin(t * 8)) * 0.5 : 1);
    if (this.bubble) this.bubble.position.y = (this.bubbleIsCard ? 1.74 : 1.95) + (hopping ? this.body.position.y : 0) + Math.sin(t * 3) * 0.03;
    if (this.nameTag) this.nameTag.position.y = 1.55 + (hopping ? this.body.position.y : 0);
    // Walking in to a meeting: the same waddle as on the way out, without the box.
    if (this.walking || this.stride) {
      this.stride = this.walking ? this.stride + dt * 9 : 0;
      const s = Math.sin(this.stride);
      this.feet.forEach((f, i) => {
        const step = i ? -s : s;
        f.position.z = 0.05 + step * 0.08;
        f.position.y = 0.2 + Math.max(0, step) * 0.05;
      });
      this.body.position.y += Math.abs(s) * 0.05;
      this.body.rotation.z = s * 0.1;
    }
  }

  /** Eases toward `act`'s stance, out of whatever it was doing before. */
  private pose(act: Act, dt: number, t: number): Stance {
    const k = Math.min(1, dt * 8);
    // With nothing to ease out of, a first frame of zero length would leave the weights summing to 0
    // and the division below NaN; turnY keeps that NaN, so the body would never draw again.
    if (!this.acts.has(act)) this.acts.set(act, this.acts.size ? 0 : 1);
    const out = this.blend;
    for (const key of STANCE_KEYS) out[key] = 0;
    let total = 0;
    for (const [a, w0] of this.acts) {
      const w = w0 + ((a === act ? 1 : 0) - w0) * k;
      if (a !== act && w < 0.01) {
        this.acts.delete(a);
        continue;
      }
      this.acts.set(a, w);
      const s = stanceOf(a, t, this.stance);
      for (const key of STANCE_KEYS) out[key] += s[key] * w;
      total += w;
    }
    for (const key of STANCE_KEYS) out[key] /= total;
    return out;
  }

  /** The papers and the globe come and go with the act they belong to. */
  private props(dt: number, t: number) {
    const show = (prop: THREE.Object3D, act: Act) => {
      const w = this.acts.get(act) ?? 0;
      prop.visible = w > 0.02;
      if (prop.visible) prop.scale.setScalar(Math.max(0.001, popIn(w)));
      return prop.visible;
    };
    if (show(this.papers.group, 'read')) {
      // A page every second or so, flipped up and over the top.
      this.flipT = (this.flipT + dt) % 1.1;
      const f = Math.min(1, this.flipT / 0.45);
      this.papers.page.rotation.x = -ease(f) * Math.PI * 1.1;
      this.papers.page.visible = f < 1;
    }
    if (show(this.globe.group, 'web')) {
      this.globe.group.position.copy(this.spot).y += Math.sin(t * 2) * 0.03;
      this.globe.ball.rotation.y = t * 2.2;
      this.globe.ring.rotation.z = t * 0.6;
    }
  }

  /** Shot: flat where it fell, lids heavy, light out. Only the name tag stays up. */
  private flatline(dt: number) {
    this.blinkAt -= dt;
    if (this.blinkAt < 0) this.blinkAt = 4 + Math.random() * 4;
    const shut = this.blinkAt < 0.4;
    for (const e of this.eyes) e.scale.y = shut ? 0.1 : 0.4;
  }

  /** Sent home: head hung, the box in its arms, waddling along while `walking`. */
  private carry(l: NonNullable<Worker['leaving']>, dt: number, t: number) {
    // The box pops in, overshooting a little.
    l.boxT = Math.min(1, l.boxT + dt * 2.5);
    const u = l.boxT - 1;
    l.box.scale.setScalar(Math.max(0.001, 1 + 2.7 * u * u * u + 1.7 * u * u));
    const k = Math.min(1, dt * 10);
    this.armL.rotation.x += (-1 - this.armL.rotation.x) * k;
    this.armR.rotation.x += (-1 - this.armR.rotation.x) * k;
    this.armL.rotation.z += (0.12 - this.armL.rotation.z) * k;
    this.armR.rotation.z += (-0.12 - this.armR.rotation.z) * k;
    if (this.walking) l.stride += dt * 9;
    const s = this.walking ? Math.sin(l.stride) : 0;
    this.feet.forEach((f, i) => {
      const step = i ? -s : s;
      f.position.z = 0.05 + step * 0.08;
      f.position.y = 0.2 + Math.max(0, step) * 0.05;
    });
    this.body.position.y = Math.abs(s) * 0.05;
    this.body.rotation.z = s * 0.1;
    this.body.rotation.x += (0.15 - this.body.rotation.x) * Math.min(1, dt * 4);
    this.body.rotation.y += -this.body.rotation.y * k;
    this.body.scale.setScalar(1);
    this.bulbScale(1);
    this.blink(dt);
    if (this.bubble) this.bubble.position.y = 1.95 + Math.sin(t * 3) * 0.03;
    if (this.nameTag) this.nameTag.position.y = 1.55;
  }

  /** Up on the desk dancing: hop up, groove side to side, twirl, jump twice, hop back down. */
  private boogie(d: NonNullable<Worker['dancing']>, dt: number, t: number): void {
    d.t += dt;
    const { up, moves, down } = DANCE;
    if (d.t >= up + moves + down) {
      this.dancing = null;
      this.settle();
      this.update(0, t);
      return;
    }
    // Between the seat (0) and the stage (1), with a hop's arc over the line between them.
    let on = 1;
    let arc = 0;
    if (d.t < up || d.t > up + moves) {
      const u = d.t < up ? d.t / up : 1 - (d.t - up - moves) / down;
      on = u;
      arc = 4 * HOP * u * (1 - u);
    }
    const { pos, yaw } = d.stage;
    const e = on * on * (3 - 2 * on);
    this.root.position.set(pos.x * e, pos.y * on + arc, pos.z * e);
    this.root.rotation.y = yaw * e;

    // Arms and the body's sway head for these, so one move runs into the next.
    let armX = [-2.6, -2.6];
    let armZ = [0, 0];
    let lift = 0;
    let sway = 0;
    let twist = 0;
    let step = 0;
    const beat = on < 1 ? -1 : (d.t - up) / BEAT;
    if (beat >= 0 && beat < 4) {
      // Groove: a bounce on every beat, swaying side to side, raising the roof one arm at a time.
      const s = Math.sin(beat * Math.PI);
      const c = Math.cos(beat * Math.PI);
      lift = Math.abs(s) * 0.12;
      sway = s * 0.22;
      twist = s * 0.3;
      step = s;
      armX = [-1.6 - c * 1.2, -1.6 + c * 1.2];
      armZ = [-0.35, 0.35];
    } else if (beat >= 4 && beat < 6) {
      // A twirl on the spot, arms out wide.
      const u = (beat - 4) / 2;
      twist = u * u * (3 - 2 * u) * Math.PI * 2;
      lift = Math.sin(u * Math.PI) * 0.18;
      armX = [-0.3, -0.3];
      armZ = [-1.35, 1.35];
    } else if (beat >= 6) {
      // Two big jumps, arms up.
      lift = Math.abs(Math.sin((beat - 6) * Math.PI)) * 0.45;
      armZ = [-0.3, 0.3];
    }
    // Whatever it was acting out waits: shoulders back in place, eyes ahead, the papers and globe put away.
    this.armL.position.set(-0.3, 0.55, 0.05);
    this.armR.position.set(0.3, 0.55, 0.05);
    for (const p of this.pupils) p.position.y = 0.7;
    for (const prop of [this.papers.group, this.globe.group]) prop.visible = false;
    const k = 1 - Math.exp(-dt * 18);
    [this.armL, this.armR].forEach((a, i) => {
      a.rotation.x += (armX[i] - a.rotation.x) * k;
      a.rotation.z += (armZ[i] - a.rotation.z) * k;
    });
    this.body.position.set(sway * 0.3, lift, 0);
    this.body.rotation.set(0, twist, sway);
    // Squashed a little as it lands.
    const squash = beat >= 0 && lift < 0.03 ? 1 - (0.03 - lift) * 3 : 1;
    this.body.scale.set(2 - squash, squash, 2 - squash);
    this.feet.forEach((f, i) => {
      f.position.y = 0.2 + Math.max(0, i ? -step : step) * 0.07;
      f.position.z = 0.05;
    });
    // Its light flashes through the colors like a disco ball.
    this.bulb.mat.color.setHSL((t * 1.3) % 1, 1, 0.5);
    this.bulb.mat.emissive.copy(this.bulb.mat.color).multiplyScalar(0.5);
    this.bulbScale(1 + Math.abs(Math.sin(t * 12)) * 0.3);
    this.blink(dt);
    if (this.bubble) this.bubble.position.y = (this.bubbleIsCard ? 1.74 : 1.95) + lift + Math.sin(t * 3) * 0.03;
    if (this.nameTag) this.nameTag.position.y = 1.55 + lift;
  }

  /** Back in its seat, standing straight, its light showing its status again. */
  private settle() {
    this.root.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);
    this.body.position.set(0, 0, 0);
    this.body.rotation.set(0, 0, 0);
    this.body.scale.setScalar(1);
    for (const a of [this.armL, this.armR]) a.rotation.z = 0;
    for (const f of this.feet) f.position.set(f.position.x, 0.2, 0.05);
    this.bulbScale(1);
    this.paintBulb();
  }

  /** `lid` narrows the eyes (1 = wide open) between blinks. */
  private blink(dt: number, lid = 1) {
    this.blinkAt -= dt;
    const blinking = this.blinkAt < 0.12 && this.blinkAt > 0;
    if (this.blinkAt < 0) this.blinkAt = 2 + Math.random() * 4;
    for (const e of this.eyes) e.scale.y = blinking ? 0.1 : lid;
  }

  dispose() {
    if (this.bubble) disposeSprite(this.bubble);
    if (this.nameTag) disposeSprite(this.nameTag);
  }
}
