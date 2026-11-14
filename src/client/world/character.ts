import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HAIR_COLORS, HAIR_STYLES, SKIN_TONES, type Look } from '../../shared/avatar';
import { EMOTE_BY_ID, type Emote, type EmoteId } from '../../shared/emotes';
import { DESK_MOMENT_FX, isWorkerMicroReaction, isWorkerVibePosture, MICRO_REACTION_FX, type WorkerMicroReaction, type WorkerVibePosture, type WorkerVibeState } from '../../shared/gemini-vibes';
import type { CarriedIssue, TeamBadge, TodoProgress, WorkerAction, WorkerStatus, WorkerTask } from '../../shared/protocol';
import { isAsleep, type WorkerPr } from '../../shared/status';
import { todoCount, todoFraction, todoLine } from '../../shared/todos';
import { HIPS } from '../player';
import { OpenBook } from './book';
import { HeldCard } from './card';
import { Muzzle, SPIN_AT, disposeGun, magnum, setCylinder } from './gun';
import type { GunPose } from './gun-motion';
import { glyphFlat } from './glyph3d';
import { isTeamKitGeometry, setTeamKitModel, TeamKit } from './team-kit';
import { ANISOTROPY } from './texture-quality';
import { beveledBox, cardSprite, disposeSprite, mesh, plainLabel, roundedBox, textSprite, toon, toonUnique } from './toon';
import { mergeWorkerPaint, type WorkerPart } from './worker-parts';

/** A one-shot reaction a worker acts out: one Gemini judged, or opening a pull request (which the office knows for itself). */
export type ReactionPose = WorkerMicroReaction | 'shipped';
const REACTION_SECONDS: Partial<Record<ReactionPose, number>> = { breakthrough: 2.8, shipped: 2.8, puzzled: 2.6, eureka: 2.6, frustrated: 2.6, rabbit_hole: 2.6, risky_move: 2.5, corner_cut: 2.5 };
const reactionHex = (kind: ReactionPose) => (kind === 'shipped' ? DESK_MOMENT_FX.shipped.hex : MICRO_REACTION_FX[kind].hex);

export type Pose = 'stand' | 'walk' | 'sit' | 'type';

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

/** A full mug of coffee standing on y = 0, with its handle on the -x side. */
export function coffeeMug(scale = 1): THREE.Group {
  const mug = new THREE.Group();
  const r = 0.05 * scale;
  const height = 0.1 * scale;
  const china = toon('#fffaf3');
  mug.add(mesh(new THREE.CylinderGeometry(r, r * 0.88, height, 16), china, 0, height / 2, 0));
  mug.add(mesh(new THREE.CylinderGeometry(r * 0.8, r * 0.8, height * 0.04, 16), toon('#6f4518'), 0, height, 0));
  mug.add(mesh(new THREE.TorusGeometry(height * 0.28, r * 0.2, 6, 12), china, -r, height / 2, 0));
  return mug;
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
  g.add(mesh(new THREE.BoxGeometry(W - 2 * T, 0.01, D - 2 * T), toon('#8b6a47'), 0, H * 0.7, 0));
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
  g.add(mesh(new THREE.CylinderGeometry(0.06, 0.045, 0.11, 10), toon('#e76f51'), -0.15, H - 0.03, -0.04));
  for (const [x, y, z, r, c] of [
    [-0.15, 0.1, -0.04, 0.07, '#5fb760'],
    [-0.2, 0.07, 0.0, 0.05, '#3f8f45'],
    [-0.11, 0.15, -0.07, 0.05, '#6fcf6a'],
  ] as const)
    g.add(mesh(new THREE.SphereGeometry(r, 10, 8), toon(c), x, H + y, z));
  // Papers sticking up at the back.
  for (const [x, rz] of [
    [-0.01, 0.16],
    [0.05, -0.1],
  ]) {
    const paper = mesh(new THREE.BoxGeometry(0.17, 0.22, 0.004), toon('#fffaf3'), x, H - 0.01, -0.1);
    paper.rotation.set(-0.1, 0, rz);
    g.add(paper);
  }
  // A framed photo, leaning back.
  const photo = new THREE.Group();
  photo.add(mesh(new THREE.BoxGeometry(0.16, 0.13, 0.02), toon('#2b2d42'), 0, 0, 0));
  photo.add(mesh(new THREE.BoxGeometry(0.12, 0.09, 0.005), toon('#8ecae6'), 0, 0, 0.011));
  photo.add(mesh(new THREE.SphereGeometry(0.018, 8, 6), toon('#ffd166'), 0.03, 0.02, 0.014));
  photo.position.set(0.1, H + 0.04, -0.05);
  photo.rotation.set(-0.3, 0, -0.12);
  g.add(photo);
  // A mug and the rubber duck, up front.
  const mug = coffeeMug(0.9);
  mug.position.set(0.0, H - 0.07, 0.07);
  g.add(mug);
  const duck = new THREE.Group();
  const duckBody = mesh(new THREE.SphereGeometry(0.05, 10, 8), toon('#ffd166'), 0, 0, 0);
  duckBody.scale.y = 0.8;
  duck.add(duckBody);
  duck.add(mesh(new THREE.SphereGeometry(0.032, 10, 8), toon('#ffd166'), 0, 0.055, 0.02));
  duck.add(mesh(new THREE.ConeGeometry(0.014, 0.03, 6).rotateX(Math.PI / 2), toon('#f4a261'), 0, 0.05, 0.06));
  duck.position.set(0.16, H + 0.01, 0.06);
  duck.rotation.y = -0.4;
  g.add(duck);
  return g;
}

const v1 = new THREE.Vector3();
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
/** A person's torso (see Person). */
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
  return sharedGeometry.has(geo) || isTeamKitGeometry(geo);
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
  g.add(mesh(geo.plain, mats.plain, 0, 0, 0), mesh(geo.signal, mats.signal, 0, 0, 0));
  return g;
}

/** A person's crew kit: lanyard, ID card, chest patch and the pinwheel on the back. */
function personKit(): THREE.Group {
  return kit('person', () => [lanyard(TORSO, 0.86, 1.05, 0.6, CREW.orange), ...idCard(TORSO, 0.775, 0.095, 0.13), ...patch(TORSO, 0.83, 0.74, 0.085), hug(TORSO, glyphFlat(0.22, 2), CREW.orange, 0.78, Math.PI, 0.004)]);
}

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
  /** Their Factory crew kit (lanyard, card, patches) and work boots. */
  private crew: THREE.Group;
  private boots: THREE.Mesh[];
  private look: Look;
  private label: THREE.Sprite | null = null;
  private head: THREE.Group;
  private walkPhase = 0;
  private reachT = -1;
  /** An issue card off the board, held out in front in both hands. */
  private card: HeldCard;
  private cardHolder = new THREE.Group();
  /** A book off the bookshelf, open in both hands while they read (see read). */
  private book: OpenBook | null = null;
  private bookHolder = new THREE.Group();
  pose: Pose = 'stand';
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
  /** Holding on to the ladder (see setGrip). */
  private grip: 'ladder' | null = null;
  /**
   * A .44 Magnum or the wand in the right fist (see setGunPose): where the fist holds it, the pivot
   * it spins round on the trigger finger, the prop and its muzzle flash, and the pose it's in.
   */
  private gun: { mount: THREE.Group; wrist: THREE.Group; pivot: THREE.Group; prop: THREE.Group; muzzle: Muzzle; pose: Readonly<GunPose> } | null = null;

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
      head.add(mesh(new THREE.SphereGeometry(0.055, 10, 8), ink, sx * 0.12, 0.02, 0.3));
      head.add(mesh(new THREE.SphereGeometry(0.05, 10, 8), toon('#ff9f9f'), sx * 0.2, -0.08, 0.27));
    }
    const smile = mesh(new THREE.TorusGeometry(0.06, 0.015, 6, 12, Math.PI), ink, 0, -0.08, 0.32);
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
    this.thumb = mesh(new THREE.CapsuleGeometry(0.035, 0.07, 4, 8).rotateX(Math.PI / 2), skin, 0, -0.38, 0.1);
    this.finger = mesh(new THREE.CapsuleGeometry(0.03, 0.09, 4, 8), skin, 0, -0.5, 0.02);
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

  /** Carries an issue card in both hands, or puts it down (null). */
  carry(card: CarriedIssue | null | undefined) {
    this.card.set(card);
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
  }

  /** Turns a page of the book they're reading now. */
  turnPage() {
    this.book?.turn();
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
   * Poses the emote over whatever the arms were doing (walking, sitting),
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

  /** Sits down with the hips `hips` above the feet, on a couch or a chair, or gets up (null). */
  sit(hips: number | null) {
    this.hips = hips;
    if (hips !== null) this.seatHips = hips;
    this.pose = hips === null ? 'stand' : 'sit';
  }

  /**
   * On the ladder, hand over hand as they climb, or neither.
   */
  setGrip(grip: 'ladder' | null) {
    this.grip = grip;
  }

  /** Takes it out of the scene and frees its sprites (its materials are shared). */
  dispose() {
    this.root.removeFromParent();
    if (this.label) disposeSprite(this.label);
    this.endEmote();
  }

  /**
   * A .44 Magnum in the right fist, posed (see GunMotion: drawn, holstered,
   * mid-trick), or away in its holster (null). The arm swings up to aim as it draws.
   */
  setGunPose(pose: Readonly<GunPose> | null) {
    if (this.gun && !pose) {
      disposeGun(this.gun.prop);
      this.gun.mount.removeFromParent();
      this.gun = null;
      if (!pose) {
        this.armL.rotation.set(0, 0, 0);
        this.finger.visible = this.emoting?.emote.id === 'point';
      }
    }
    if (!pose) return;
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
    const muzzle = new Muzzle();
    prop.position.copy(SPIN_AT).negate();
    prop.add(muzzle.group);
    pivot.add(prop);
    wrist.add(pivot);
    mount.add(wrist);
    this.armL.add(mount);
    this.gun = { mount, wrist, pivot, prop, muzzle, pose };
  }

  /** Fires it: a flash at the muzzle (the recoil is the pose's kick). */
  fire(superShot = false) {
    this.gun?.muzzle.fire(superShot);
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
      // Legs out over the edge of the seat, hands in the lap.
      for (const leg of [this.legL, this.legR]) leg.rotation.x = THREE.MathUtils.lerp(leg.rotation.x, -1.35, sit);
      for (const arm of [this.armL, this.armR]) arm.rotation.x = THREE.MathUtils.lerp(arm.rotation.x, -0.55, sit);
    }
    if (this.book) {
      // Both arms out in front, hands under the book's bottom corners.
      this.armL.rotation.set(-1.5, 0, 0.32);
      this.armR.rotation.set(-1.5, 0, -0.32);
      this.book.update(dt);
    } else if (this.card.held) {
      // Both arms out in front, hands on the card's edges: they don't swing while they walk.
      this.armL.rotation.set(-1.25, 0, 0.3);
      this.armR.rotation.set(-1.25, 0, -0.3);
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
    }
    this.body.position.y = moving && !airborne ? Math.abs(Math.sin(this.walkPhase)) * 0.06 : 0;
    // Down onto (or up onto) the seat: the hips go where it puts them.
    if (sit) this.body.position.y = THREE.MathUtils.lerp(this.body.position.y, this.seatHips - HIPS, sit);

    // Reading, they look down into the book.
    this.head.rotation.x = this.book ? 0.32 : 0;
    this.head.rotation.y = this.head.rotation.z = 0;
    this.body.rotation.y = this.body.rotation.z = 0;
    if (this.emoting) this.emoteStep(dt, moving || airborne ? 0 : 1 - sit);
    if (this.gun) this.gunStep(dt);
  }
}

// -----------------------------------------------------------------------------------------------

export const STATUS_BULB: Record<string, string> = {
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
 * What a worker's body is doing: resting, arms up for joy, arms crossed waiting on you, typing,
 * acting out its latest tool call, or holding a continuous Gemini Decision 1 desk posture.
 */
type VibeAct = 'vibe_flow' | 'vibe_investigating' | 'vibe_struggling' | 'vibe_deliberating';
type Act = 'rest' | 'up' | 'waiting' | 'type' | WorkerAction | VisitPose | VibeAct;

/** How it holds itself on a visit to another worker's desk (see visitors.ts): on its feet, or talking with a hand out. */
export type VisitPose = 'stand' | 'talk';

/** What seat or plinth a worker occupies when at its station (`null` stands with origin at `y = 0`). */
export type WorkerSeat = 'chair' | 'beanbag' | 'plinth' | null;

/** One way of holding itself, blended into the next over a moment (see Worker.update). */
interface Stance {
  /** Upper arms swung forward (x < 0 reaches ahead, -2.65 is straight up) and out/in (z). Left arm is on -x. */
  armLx: number;
  armRx: number;
  armLz: number;
  armRz: number;
  /** Forearms bent at the elbow (x < 0 bends forward/up) and angled inward (z) toward the keyboard or chest. */
  forearmLx: number;
  forearmRx: number;
  forearmLz: number;
  forearmRz: number;
  /** 0..1: shoulders brought forward and in, for arms that wrap round the front (crossed, or holding its head). */
  reach: number;
  /** Shoulders lowered slightly for crossed-arm stances. */
  drop: number;
  /** Torso leaning toward the desk (+) or back (-), turned, tipped to the side, bobbing up. */
  lean: number;
  turn: number;
  roll: number;
  lift: number;
  /** Articulated pod head pitch (+ down, - up), yaw, and cute curious roll tilt. */
  headX: number;
  headY: number;
  headZ: number;
  /** Right foot/ankle tap (0..1) and relaxed leg extension in front (0..1). */
  tap: number;
  kick: number;
  /** Eyes open (1) or narrowed, and pupil gaze offset horizontally (`lookX`) and vertically (`look`). */
  lid: number;
  look: number;
  lookX: number;
  /** Expressive brow height offset, symmetric brow angle (+ furrowed, - worried/sad), mouth scale and frown flip (0..1). */
  browLift: number;
  browTilt: number;
  mouthW: number;
  mouthH: number;
  frown: number;
}

const STANCE_KEYS = [
  'armLx',
  'armRx',
  'armLz',
  'armRz',
  'forearmLx',
  'forearmRx',
  'forearmLz',
  'forearmRz',
  'reach',
  'drop',
  'lean',
  'turn',
  'roll',
  'lift',
  'headX',
  'headY',
  'headZ',
  'tap',
  'kick',
  'lid',
  'look',
  'lookX',
  'browLift',
  'browTilt',
  'mouthW',
  'mouthH',
  'frown',
] as const;

function stanceOf(act: Act, t: number, seated: boolean, s: Stance): Stance {
  s.armLx = s.armRx = seated ? -0.98 : -0.18;
  s.armLz = seated ? -0.06 : -0.05;
  s.armRz = seated ? 0.06 : 0.05;
  s.forearmLx = s.forearmRx = seated ? -0.78 : -0.22;
  s.forearmLz = seated ? 0.16 : 0.04;
  s.forearmRz = seated ? -0.16 : -0.04;
  s.reach = s.drop = s.lean = s.turn = s.roll = s.headX = s.headY = s.headZ = s.tap = s.kick = s.look = s.lookX = s.browLift = s.browTilt = s.frown = 0;
  s.lift = Math.sin(t * 2.1) * 0.01;
  s.lid = 1;
  s.mouthW = 1;
  s.mouthH = 1;
  switch (act) {
    case 'rest':
      s.headY = Math.sin(t * 0.7) * 0.04;
      s.headZ = Math.sin(t * 0.5 + 0.8) * 0.025;
      s.browLift = 0.002;
      break;
    case 'up':
      // Joyful victory V-pose with beaming smile.
      s.armLx = s.armRx = -2.62;
      s.armLz = -0.26;
      s.armRz = 0.26;
      s.forearmLx = s.forearmRx = -0.22;
      s.forearmLz = s.forearmRz = 0;
      s.headX = -0.1;
      s.browLift = 0.008;
      s.browTilt = -0.1;
      s.mouthW = 1.32;
      s.mouthH = 1.45;
      s.lift = 0;
      break;
    case 'type':
      // Elbows clear behind the desk edge, forearms angled onto the MacBook home row with crisp keystrokes.
      s.armLx = -1.18 + Math.sin(t * 11) * 0.04;
      s.armRx = -1.18 + Math.sin(t * 11 + 1.6) * 0.04;
      s.armLz = -0.02;
      s.armRz = 0.02;
      s.forearmLx = -0.66 + Math.sin(t * 22) * 0.14;
      s.forearmRx = -0.66 + Math.sin(t * 22 + 1.9) * 0.14;
      s.forearmLz = 0.34;
      s.forearmRz = -0.34;
      s.reach = 0.38;
      s.lean = 0.06;
      s.headX = 0.05;
      s.headY = Math.sin(t * 1.8) * 0.05;
      s.lookX = Math.sin(t * 3.2) * 0.007;
      s.look = -0.004;
      s.browLift = -0.002;
      s.browTilt = 0.12;
      s.mouthW = 0.82;
      s.mouthH = 0.72;
      s.lift = Math.abs(Math.sin(t * 11)) * 0.012;
      break;
    case 'edit':
      // Locked-in flow state: leaning forward, rapid alternating keystrokes, determined focused brows.
      s.armLx = -1.24 + Math.sin(t * 17) * 0.06;
      s.armRx = -1.24 + Math.sin(t * 17 + 1.8) * 0.06;
      s.armLz = -0.02;
      s.armRz = 0.02;
      s.forearmLx = -0.7 + Math.sin(t * 34) * 0.2;
      s.forearmRx = -0.7 + Math.sin(t * 34 + 2.1) * 0.2;
      s.forearmLz = 0.36;
      s.forearmRz = -0.36;
      s.reach = 0.44;
      s.lean = 0.13;
      s.headX = 0.08;
      s.headY = Math.sin(t * 2.6) * 0.06;
      s.headZ = Math.sin(t * 1.3) * 0.04;
      s.lid = 0.88;
      s.look = -0.008;
      s.lookX = Math.sin(t * 5.2) * 0.009;
      s.browLift = -0.005;
      s.browTilt = 0.22;
      s.mouthW = 0.68;
      s.mouthH = 0.55;
      s.lift = Math.abs(Math.sin(t * 17)) * 0.02;
      break;
    case 'read': {
      // Both hands pinching the sides of the clipboard notepad below visor height, pupils scanning across each line.
      const lineFrac = (t * 0.85) % 1;
      s.armLx = s.armRx = -0.88;
      s.armLz = 0.13;
      s.armRz = -0.13;
      s.forearmLx = s.forearmRx = -1.16;
      s.forearmLz = 0.28;
      s.forearmRz = -0.28;
      s.reach = 0.15;
      s.lean = -0.05;
      s.headX = 0.19;
      s.headZ = -0.04;
      s.lookX = (0.5 - lineFrac) * 0.014;
      s.look = -0.008 - Math.floor((t * 0.85) % 4) * 0.004;
      s.browLift = 0.006;
      s.mouthW = 0.78;
      s.mouthH = 0.68;
      break;
    }
    case 'test':
      // Leaning back into the backrest, elbows wide with hands clasped behind its helmet, legs kicked out relaxed.
      s.armLx = s.armRx = -2.78;
      s.armLz = -0.52;
      s.armRz = 0.52;
      s.forearmLx = s.forearmRx = -1.35;
      s.forearmLz = 0.98;
      s.forearmRz = -0.98;
      s.lean = -0.22;
      s.roll = Math.sin(t * 1.3) * 0.035;
      s.headX = -0.12;
      s.headZ = Math.sin(t * 1.3) * 0.06;
      s.kick = 1;
      s.look = 0.012;
      s.browLift = 0.005;
      s.mouthW = 1.15;
      s.mouthH = 1.1;
      s.lift = 0;
      break;
    case 'web':
      // Right hand scrolling, gazing up curiously at the spinning holographic globe.
      s.armLx = seated ? -0.92 : -0.3;
      s.forearmLx = seated ? -0.64 : -0.28;
      s.armRx = -1.18;
      s.forearmRx = -0.66 + Math.sin(t * 8.5) * 0.14;
      s.forearmRz = -0.3;
      s.reach = 0.25;
      s.lean = -0.07;
      s.headX = -0.18;
      s.headY = -0.26 + Math.sin(t * 1.4) * 0.05;
      s.headZ = 0.08;
      s.lid = 1.06;
      s.look = 0.014;
      s.lookX = -0.01;
      s.browLift = 0.008;
      s.mouthW = 0.88;
      s.mouthH = 1.15;
      break;
    case 'failing':
      // Both hands cradling the sides of its helmet in dismay, shaking its head slowly while keeping the visor visible.
      s.armLx = s.armRx = -1.76;
      s.armLz = -0.22;
      s.armRz = 0.22;
      s.forearmLx = s.forearmRx = -1.78;
      s.forearmLz = 0.18;
      s.forearmRz = -0.18;
      s.reach = 0.22;
      s.lean = 0.22;
      s.headX = 0.18;
      s.headY = Math.sin(t * 3.1) * 0.2;
      s.lid = 0.62;
      s.look = -0.016;
      s.browLift = 0.006;
      s.browTilt = -0.32;
      s.mouthW = 0.95;
      s.mouthH = 0.9;
      s.frown = 1;
      s.lift = 0;
      break;
    case 'stand':
      // Standing attentively at a teammate's desk, hands relaxed at its sides.
      s.armLx = s.armRx = -0.16;
      s.armLz = -0.07;
      s.armRz = 0.07;
      s.forearmLx = s.forearmRx = -0.24;
      s.forearmLz = 0.05;
      s.forearmRz = -0.05;
      s.headZ = Math.sin(t * 0.9) * 0.04;
      break;
    case 'talk':
      // Animated conversation at a host desk: expressive hand gestures and friendly head nods.
      s.armLx = -0.32 + Math.sin(t * 3.4) * 0.1;
      s.forearmLx = -0.45;
      s.armRx = -0.92 + Math.sin(t * 5.5) * 0.22;
      s.armRz = -0.14 + Math.sin(t * 3.1) * 0.1;
      s.forearmRx = -0.68 + Math.sin(t * 5.5 + 0.8) * 0.24;
      s.lean = 0.05;
      s.turn = Math.sin(t * 1.7) * 0.08;
      s.headX = Math.sin(t * 5.5) * 0.06;
      s.headZ = Math.sin(t * 2.3) * 0.06;
      s.browLift = 0.005;
      s.mouthW = 0.95 + Math.sin(t * 7) * 0.15;
      s.mouthH = 0.55 + Math.abs(Math.sin(t * 12)) * 0.95;
      s.lift = Math.abs(Math.sin(t * 5.5)) * 0.012;
      break;
    case 'waiting': {
      // Arms folded horizontally across its chest, head cocked impatiently, tapping its right sneaker-boot.
      const tap = Math.max(0, Math.sin(t * 16));
      s.armLx = -0.72;
      s.armRx = -0.78;
      s.armLz = 0.36;
      s.armRz = -0.36;
      s.forearmLx = -0.22;
      s.forearmRx = -0.28;
      s.forearmLz = 1.48;
      s.forearmRz = -1.48;
      s.reach = 0.85;
      s.drop = 0.03;
      s.roll = 0.05;
      s.headZ = 0.09;
      s.headY = -0.06;
      s.tap = tap;
      s.lift = tap * 0.01;
      s.lid = 0.72;
      s.browLift = -0.003;
      s.browTilt = 0.22;
      s.mouthW = 0.76;
      s.mouthH = 0.5;
      s.frown = 0.6;
      break;
    }
    case 'vibe_flow': {
      // Locked-in flow state: brisk rhythmic cadence, forward lean, subtle musical head-nod groove.
      s.armLx = -1.26 + Math.sin(t * 18) * 0.065;
      s.armRx = -1.26 + Math.sin(t * 18 + 1.7) * 0.065;
      s.armLz = -0.02;
      s.armRz = 0.02;
      s.forearmLx = -0.72 + Math.sin(t * 36) * 0.21;
      s.forearmRx = -0.72 + Math.sin(t * 36 + 2.0) * 0.21;
      s.forearmLz = 0.36;
      s.forearmRz = -0.36;
      s.reach = 0.46;
      s.lean = 0.16;
      s.headX = 0.09 + Math.sin(t * 4.6) * 0.045;
      s.headY = Math.sin(t * 2.3) * 0.05;
      s.headZ = Math.sin(t * 2.3 + 0.8) * 0.035;
      s.lid = 0.86;
      s.look = -0.008;
      s.lookX = Math.sin(t * 5.4) * 0.009;
      s.browLift = -0.005;
      s.browTilt = 0.24;
      s.mouthW = 0.72;
      s.mouthH = 0.6;
      s.lift = Math.abs(Math.sin(t * 18)) * 0.022;
      break;
    }
    case 'vibe_investigating': {
      // Thoughtful investigation: leaning back in the task chair, right hand at chin, eyes scanning wide output.
      s.armLx = seated ? -0.96 : -0.28;
      s.armLz = -0.06;
      s.forearmLx = seated ? -0.68 : -0.26;
      s.forearmLz = 0.24;
      s.armRx = -1.48;
      s.armRz = -0.14;
      s.forearmRx = -1.56 + Math.sin(t * 2.2) * 0.04;
      s.forearmRz = -0.44;
      s.reach = 0.22;
      s.lean = -0.12;
      s.headX = 0.04 + Math.sin(t * 1.4) * 0.03;
      s.headY = Math.sin(t * 1.1) * 0.14;
      s.headZ = -0.07;
      s.lid = 1.04;
      s.lookX = Math.sin(t * 2.2) * 0.015;
      s.look = -0.004 + Math.cos(t * 1.5) * 0.006;
      s.browLift = 0.007;
      s.browTilt = -0.06;
      s.mouthW = 0.78;
      s.mouthH = 0.68;
      break;
    }
    case 'vibe_struggling': {
      // Its approach isn't working: hunched in close, one hand raking the back of its head, foot jittering.
      const tap = Math.max(0, Math.sin(t * 18));
      s.armLx = -1.2;
      s.armLz = -0.02;
      s.forearmLx = -0.68;
      s.forearmLz = 0.34;
      s.armRx = -2.2 + Math.sin(t * 5) * 0.08;
      s.armRz = 0.2;
      s.forearmRx = -1.85 + Math.sin(t * 10) * 0.14;
      s.forearmRz = -0.5;
      s.reach = 0.42;
      s.lean = 0.19;
      s.headX = 0.12;
      s.headY = Math.sin(t * 2.0) * 0.05;
      s.headZ = 0.14;
      s.tap = tap * 0.85;
      s.lid = 0.72;
      s.look = -0.01;
      s.lookX = Math.sin(t * 6.0) * 0.011;
      s.browLift = -0.004;
      s.browTilt = 0.28;
      s.mouthW = 0.7;
      s.mouthH = 0.52;
      s.frown = 0.35;
      s.lift = tap * 0.008;
      break;
    }
    case 'vibe_deliberating': {
      // Weighing options: leaning back, gaze up and away, head tipping from one side to the other.
      s.armLx = seated ? -0.88 : -0.22;
      s.armRx = seated ? -0.88 : -0.22;
      s.armLz = -0.14 + Math.sin(t * 1.6) * 0.04;
      s.armRz = 0.14 - Math.sin(t * 1.6) * 0.04;
      s.forearmLx = seated ? -0.56 : -0.22;
      s.forearmRx = seated ? -0.56 : -0.22;
      s.forearmLz = 0.22;
      s.forearmRz = -0.22;
      s.drop = (Math.sin(t * 2.1) + 1) * 0.012;
      s.lean = -0.15;
      s.roll = Math.sin(t * 1.3) * 0.04;
      s.headX = -0.15;
      s.headY = Math.sin(t * 0.7) * 0.24;
      s.headZ = Math.sin(t * 0.7) * 0.12;
      s.kick = 0.65;
      s.look = 0.012;
      s.lookX = 0.008;
      s.browLift = 0.005;
      s.mouthW = 1.08;
      s.mouthH = 1.05;
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

let notepadMats: {
  board: THREE.MeshToonMaterial;
  edge: THREE.MeshToonMaterial;
  print: THREE.MeshToonMaterial;
  clip: THREE.MeshToonMaterial;
  tab: THREE.MeshToonMaterial;
} | null = null;

/** Shared materials for the worker's clipboard notepad, with a crisp ruled sheet drawn once onto a canvas texture. */
function notepadMaterials() {
  if (notepadMats) return notepadMats;
  const W = 256;
  const H = 320;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#fbf7ec';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#efe9da';
  g.fillRect(0, 0, W, 28);
  g.fillStyle = '#d4ccba';
  g.fillRect(0, 27, W, 2);
  g.fillStyle = '#e3ddd0';
  for (let y = 60; y < H - 14; y += 22) g.fillRect(14, y, W - 28, 2);
  g.fillStyle = '#eb8c7f';
  g.fillRect(40, 29, 2, H - 41);
  g.fillStyle = '#ee6018';
  g.fillRect(18, 41, 14, 12);
  g.fillStyle = '#252830';
  g.fillRect(48, 42, 114, 10);
  let seed = 19;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let row = 0, y = 73; y < H - 22; row++, y += 22) {
    if (row === 4) continue;
    const end = row === 3 || row === 8 ? 110 + rand() * 55 : W - 22 - rand() * 24;
    g.fillStyle = row === 0 || row === 5 ? '#ee6018' : '#8a93a6';
    g.fillRect(22, y + 1, 8, 6);
    g.fillStyle = row % 3 === 0 ? '#353b48' : '#586070';
    for (let x = 48; x < end - 8; ) {
      const w = Math.min(14 + rand() * 32, end - x);
      g.fillRect(x, y, w, 7);
      x += w + 7;
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = ANISOTROPY;
  const print = toonUnique('#ffffff');
  print.map = tex;
  print.emissive = new THREE.Color('#46433c');
  print.userData.outlineParameters = { visible: false };
  const edge = toonUnique('#e8e1d3');
  edge.emissive = new THREE.Color('#2a2824');
  edge.userData.outlineParameters = { visible: false };
  const tab = toonUnique('#d8dee6');
  tab.userData.outlineParameters = { visible: false };
  notepadMats = {
    board: toon('#b58050'),
    edge,
    print,
    clip: toon('#b8c0c8'),
    tab,
  };
  return notepadMats;
}

/** A clipboard notepad held in both hands: hardboard backing (+z), ruled paper pad (-z, facing the visor), and top steel clip. */
function papers(): { group: THREE.Group } {
  const group = new THREE.Group();
  group.name = 'worker-notepad';
  const BW = 0.22;
  const BH = 0.264;
  const { board, edge, print, clip, tab } = notepadMaterials();
  group.add(mesh(beveledBox(BW, BH, 0.006, 0.0025), board, 0, 0, 0.003));
  // Box faces go +x, -x, +y, -y, +z, -z: the printed sheet faces -z toward the worker's visor.
  const pad = new THREE.Mesh(new THREE.BoxGeometry(BW - 0.022, BH - 0.022, 0.005), [edge, edge, edge, edge, edge, print]);
  pad.position.set(0, -0.003, -0.0025);
  group.add(pad);
  group.add(mesh(beveledBox(0.088, 0.024, 0.015, 0.0025), clip, 0, BH / 2 - 0.012, 0.0005));
  group.add(mesh(beveledBox(0.034, 0.013, 0.01, 0.002), tab, 0, BH / 2 + 0.003, 0.001));
  return { group };
}

/** A little globe: blue sea, green blobs of land and a gold ring round its middle. */
function globe(): { group: THREE.Group; ball: THREE.Group; ring: THREE.Mesh } {
  const group = new THREE.Group();
  const ball = new THREE.Group();
  const r = 0.26;
  ball.add(mesh(new THREE.SphereGeometry(r, 20, 14), toon('#4cc9f0'), 0, 0, 0));
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
    const blob = mesh(new THREE.SphereGeometry(size * r, 10, 8), land, Math.cos(lat) * Math.sin(lon) * r * 0.86, Math.sin(lat) * r * 0.86, Math.cos(lat) * Math.cos(lon) * r * 0.86);
    blob.scale.set(1.2, 0.8, 1.2);
    ball.add(blob);
  }
  ball.rotation.z = 0.41;
  group.add(ball);
  const ring = mesh(new THREE.TorusGeometry(r * 1.35, 0.016, 6, 32), toon('#ffd166', { emissive: '#7a5b00' }), 0, 0, 0);
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

/** Task cards are drawn this much smaller than other labels: at full size one is wider than the desk under it. */
const CARD_SCALE = 0.55;
/** A line said on a visit is read in passing, so it's drawn a little larger than a task card. */
const SPEECH_SCALE = 0.68;
/** Over a worker's head, its card and name tag are gone this close to your eyes (metres) and fully shown from FADE_FAR. */
export const FADE_NEAR = 1.4;
export const FADE_FAR = 6.4;
export const LEVITATE_TIME = 3;
export const LEVITATE_HEIGHT = 1.4;

/** How opaque a worker's card and name tag are, `d` metres from your eyes: looking over its shoulder, they're out of the way. */
export function labelFade(d: number): number {
  const u = Math.min(1, Math.max(0, (d - FADE_NEAR) / (FADE_FAR - FADE_NEAR)));
  return u * u * (3 - 2 * u);
}

/** Articulated joint pivots of `droid-worker.glb`, matching `DROID_WORKER` in `tools/props/generate.py`. */
export const WORKER_PIVOTS = {
  neck: new THREE.Vector3(0, 0.98, 0.005),
  rotor: new THREE.Vector3(0.036, 0.858, 0.146),
  armL: new THREE.Vector3(-0.232, 0.912, 0.005),
  armR: new THREE.Vector3(0.232, 0.912, 0.005),
  forearmL: new THREE.Vector3(-0.24, 0.708, 0.005),
  forearmR: new THREE.Vector3(0.24, 0.708, 0.005),
  thighL: new THREE.Vector3(-0.118, 0.678, 0.032),
  thighR: new THREE.Vector3(0.118, 0.678, 0.032),
  shinL: new THREE.Vector3(-0.118, 0.378, 0.024),
  shinR: new THREE.Vector3(0.118, 0.378, 0.024),
  footL: new THREE.Vector3(-0.118, 0.165, 0.015),
  footR: new THREE.Vector3(0.118, 0.165, 0.015),
  eyeL: new THREE.Vector3(-0.084, 1.106, 0.167),
  eyeR: new THREE.Vector3(0.084, 1.106, 0.167),
  pupilL: new THREE.Vector3(-0.084, 1.106, 0.172),
  pupilR: new THREE.Vector3(0.084, 1.106, 0.172),
  browL: new THREE.Vector3(-0.088, 1.168, 0.169),
  browR: new THREE.Vector3(0.088, 1.168, 0.169),
  mouth: new THREE.Vector3(0, 1.057, 0.17),
  bulb: new THREE.Vector3(0, 1.356, -0.005),
} as const;

interface WorkerModel {
  skin: THREE.BufferGeometry;
  body: WorkerPart[];
  rotor: WorkerPart[];
  head: WorkerPart[];
  armL: WorkerPart[];
  armR: WorkerPart[];
  forearmL: WorkerPart[];
  forearmR: WorkerPart[];
  thighL: WorkerPart[];
  thighR: WorkerPart[];
  shinL: WorkerPart[];
  shinR: WorkerPart[];
  footL: WorkerPart[];
  footR: WorkerPart[];
  eyeL: THREE.BufferGeometry;
  eyeR: THREE.BufferGeometry;
  pupilL: WorkerPart[];
  pupilR: WorkerPart[];
  browL: THREE.BufferGeometry;
  browR: THREE.BufferGeometry;
  mouth: THREE.BufferGeometry;
  bulb: THREE.BufferGeometry;
}

let workerModel: WorkerModel | null = null;
const waitingWorkers = new Set<Worker>();
let workerMats: Record<string, THREE.MeshToonMaterial> | null = null;

function getWorkerMats(): Record<string, THREE.MeshToonMaterial> {
  if (workerMats) return workerMats;
  const noOutline = (m: THREE.MeshToonMaterial) => {
    m.userData.outlineParameters = { visible: false };
    return m;
  };
  workerMats = {
    DroidBlack: toon('#161618'),
    DroidGraphite: toon('#2a2b30'),
    DroidSteel: toon('#52545c'),
    DroidLight: noOutline(toon('#eceeef')),
    DroidOrange: ledMaterial(),
    DroidVisor: noOutline(toon('#070709')),
    DroidRubber: toon('#101012'),
    DroidEye: noOutline(toon('#f4f7fa', { emissive: '#4a4e54' })),
    DroidPupil: noOutline(toon('#0d0e12')),
    DroidBlush: noOutline(toon('#ff7b9c', { emissive: '#6e2038' })),
  };
  return workerMats;
}

/**
 * Takes `droid-worker.glb`'s scene (as GLTFLoader gives it) as the model every worker is made from,
 * centering each articulated limb/optic around its joint pivot in `WORKER_PIVOTS` and upgrading any
 * worker built before the GLB arrived.
 */
export function setWorkerModel(scene: THREE.Object3D) {
  const mats = getWorkerMats();
  const centered = (geo: THREE.BufferGeometry, pivot?: THREE.Vector3): THREE.BufferGeometry => {
    const g = geo.clone();
    if (pivot) g.translate(-pivot.x, -pivot.y, -pivot.z);
    return g;
  };
  const part = (m: THREE.Mesh, pivot?: THREE.Vector3): WorkerPart => {
    const matName = (m.material as THREE.Material)?.name ?? '';
    return {
      geo: centered(m.geometry, pivot),
      mat: matName === 'DroidSkin' ? 'skin' : (mats[matName] ?? mats.DroidGraphite),
    };
  };
  const next: Partial<WorkerModel> = {
    body: [],
    rotor: [],
    head: [],
    armL: [],
    armR: [],
    forearmL: [],
    forearmR: [],
    thighL: [],
    thighR: [],
    shinL: [],
    shinR: [],
    footL: [],
    footR: [],
    pupilL: [],
    pupilR: [],
  };
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const node = o.parent?.name && o.parent.name !== 'Scene' ? o.parent.name : o.name;
    switch (node) {
      case 'DroidSkin':
        next.skin = centered(o.geometry);
        break;
      case 'DroidRotor':
        next.rotor!.push(part(o, WORKER_PIVOTS.rotor));
        break;
      case 'DroidHead':
        next.head!.push(part(o, WORKER_PIVOTS.neck));
        break;
      case 'DroidArmL':
        next.armL!.push(part(o, WORKER_PIVOTS.armL));
        break;
      case 'DroidArmR':
        next.armR!.push(part(o, WORKER_PIVOTS.armR));
        break;
      case 'DroidForearmL':
        next.forearmL!.push(part(o, WORKER_PIVOTS.forearmL));
        break;
      case 'DroidForearmR':
        next.forearmR!.push(part(o, WORKER_PIVOTS.forearmR));
        break;
      case 'DroidThighL':
        next.thighL!.push(part(o, WORKER_PIVOTS.thighL));
        break;
      case 'DroidThighR':
        next.thighR!.push(part(o, WORKER_PIVOTS.thighR));
        break;
      case 'DroidShinL':
        next.shinL!.push(part(o, WORKER_PIVOTS.shinL));
        break;
      case 'DroidShinR':
        next.shinR!.push(part(o, WORKER_PIVOTS.shinR));
        break;
      case 'DroidFootL':
        next.footL!.push(part(o, WORKER_PIVOTS.footL));
        break;
      case 'DroidFootR':
        next.footR!.push(part(o, WORKER_PIVOTS.footR));
        break;
      case 'EyeL':
        next.eyeL = centered(o.geometry, WORKER_PIVOTS.eyeL);
        break;
      case 'EyeR':
        next.eyeR = centered(o.geometry, WORKER_PIVOTS.eyeR);
        break;
      case 'PupilL':
        next.pupilL!.push(part(o, WORKER_PIVOTS.pupilL));
        break;
      case 'PupilR':
        next.pupilR!.push(part(o, WORKER_PIVOTS.pupilR));
        break;
      case 'BrowL':
        next.browL = centered(o.geometry, WORKER_PIVOTS.browL);
        break;
      case 'BrowR':
        next.browR = centered(o.geometry, WORKER_PIVOTS.browR);
        break;
      case 'Mouth':
        next.mouth = centered(o.geometry, WORKER_PIVOTS.mouth);
        break;
      case 'Bulb':
        next.bulb = centered(o.geometry, WORKER_PIVOTS.bulb);
        break;
      default:
        next.body!.push(part(o));
        break;
    }
  });
  if (next.skin && next.eyeL && next.eyeR && next.pupilL?.length && next.pupilR?.length && next.browL && next.browR && next.mouth && next.bulb) {
    for (const joint of ['body', 'rotor', 'head', 'armL', 'armR', 'forearmL', 'forearmR', 'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR', 'pupilL', 'pupilR'] as const) {
      next[joint] = mergeWorkerPaint(next[joint]!);
    }
    workerModel = next as WorkerModel;
    for (const w of waitingWorkers) w.fillModel();
    waitingWorkers.clear();
  }
}

/** Parses `droid-worker.glb` from its bytes (tests read it off disk; the office loads it with the props). */
export function parseWorker(glb: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(
      glb,
      '',
      (gltf) => {
        setWorkerModel(gltf.scene);
        resolve();
      },
      reject,
    );
  });
}

/** Takes `droid-team-kit.glb`'s scene as the team markings workers wear (see team-kit.ts), framed in the droid's own materials. */
export function setTeamKit(scene: THREE.Object3D) {
  setTeamKitModel(scene, getWorkerMats(), WORKER_PIVOTS.neck);
}

/** True once `droid-worker.glb` has been registered via `setWorkerModel`. */
export function workerReady(): boolean {
  return workerModel !== null;
}

/** Procedural stand-in for the worker's colored armor plates before `droid-worker.glb` lands. */
function proceduralWorkerSkin(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    parts.push(new THREE.BoxGeometry(0.08, 0.16, 0.22).translate(sx * 0.145, 0.86, 0.005));
    parts.push(new THREE.BoxGeometry(0.08, 0.03, 0.22).translate(sx * 0.12, 0.7, 0.01));
  }
  return mergeGeometries(parts)!;
}

const EYE_LOCAL_L = WORKER_PIVOTS.eyeL.clone().sub(WORKER_PIVOTS.neck);
const EYE_LOCAL_R = WORKER_PIVOTS.eyeR.clone().sub(WORKER_PIVOTS.neck);
const PUPIL_LOCAL_L = WORKER_PIVOTS.pupilL.clone().sub(WORKER_PIVOTS.neck);
const PUPIL_LOCAL_R = WORKER_PIVOTS.pupilR.clone().sub(WORKER_PIVOTS.neck);
const BROW_LOCAL_L = WORKER_PIVOTS.browL.clone().sub(WORKER_PIVOTS.neck);
const BROW_LOCAL_R = WORKER_PIVOTS.browR.clone().sub(WORKER_PIVOTS.neck);
const MOUTH_LOCAL = WORKER_PIVOTS.mouth.clone().sub(WORKER_PIVOTS.neck);
const BULB_LOCAL = WORKER_PIVOTS.bulb.clone().sub(WORKER_PIVOTS.neck);
const FOREARM_LOCAL_L = WORKER_PIVOTS.forearmL.clone().sub(WORKER_PIVOTS.armL);
const FOREARM_LOCAL_R = WORKER_PIVOTS.forearmR.clone().sub(WORKER_PIVOTS.armR);
const SHIN_LOCAL_L = WORKER_PIVOTS.shinL.clone().sub(WORKER_PIVOTS.thighL);
const SHIN_LOCAL_R = WORKER_PIVOTS.shinR.clone().sub(WORKER_PIVOTS.thighR);
const FOOT_LOCAL_L = WORKER_PIVOTS.footL.clone().sub(WORKER_PIVOTS.shinL);
const FOOT_LOCAL_R = WORKER_PIVOTS.footR.clone().sub(WORKER_PIVOTS.shinR);

/** The autonomous Factory Droid worker that sits at a desk. Forward is +z. */
export class Worker {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  private skinMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial>;
  private chassis = new THREE.Group();
  private rotor = new THREE.Group();
  readonly head = new THREE.Group();
  private headShell = new THREE.Group();

  /** Its crown beacon dome, lit in its status color so you can tell from across the room. */
  private bulb: { mat: THREE.MeshToonMaterial; mesh: THREE.Mesh };
  readonly armL = new THREE.Group();
  readonly armR = new THREE.Group();
  private upperArmL = new THREE.Group();
  private upperArmR = new THREE.Group();
  readonly forearmL = new THREE.Group();
  readonly forearmR = new THREE.Group();
  readonly thighL = new THREE.Group();
  readonly thighR = new THREE.Group();
  private upperLegL = new THREE.Group();
  private upperLegR = new THREE.Group();
  readonly shinL = new THREE.Group();
  readonly shinR = new THREE.Group();
  private lowerLegL = new THREE.Group();
  private lowerLegR = new THREE.Group();
  readonly footL = new THREE.Group();
  readonly footR = new THREE.Group();

  private bubble: THREE.Sprite | null = null;
  private bubbleKey = '';
  /** The bubble is a task card: it hangs from its tail instead of floating. */
  private bubbleIsCard = false;
  private task: WorkerTask | undefined;
  /** Its todo list's progress (WorkerInfo.todos): a bar on its card. */
  private todos: TodoProgress | undefined;
  /** Its pull request, open or merged: its bubble is outlined (and labelled, while it rests) to match. */
  private pr: PrBadge | undefined;
  /** Its worktree was deleted outside the office (WorkerInfo.lost): its bubble says so until it's fixed. */
  private lost = false;
  private nameTag: THREE.Sprite | null = null;
  /** Its team's crown or comms kit and shoulder panels (WorkerInfo.team), on its body. */
  private kit = new TeamKit();
  /** Its team's accent, which outlines its name tag. */
  private teamAccent: string | undefined;
  /** How opaque its card and name tag are (see seenFrom). */
  private labelAlpha = 1;
  private name = '';
  private eyeMeshes: [THREE.Mesh, THREE.Mesh];
  private pupilGroups: [THREE.Group, THREE.Group];
  private browMeshes: [THREE.Mesh, THREE.Mesh];
  private mouthMesh: THREE.Mesh;
  private blinkAt = Math.random() * 4;
  /** Down from the wand rather than the gun: eyes shut, asleep (see die). */
  private asleep = false;
  status: WorkerStatus = 'starting';
  bouncing = false;
  /** You're close enough to read its card: it lands the hop it's in and stands still until you walk away. */
  held = false;
  private bounceT = 0;
  private spawnT = 0;
  private split: { from: THREE.Vector3; t: number } | null = null;
  /** Seconds left jumping for joy (its pull request just merged). */
  private cheerT = 0;
  /** Up on its desk dancing (a pull request merged): where, and how many seconds in. */
  private dancing: { stage: Stage; t: number } | null = null;
  /** Swish and flick lifts it briefly without changing its task or status. */
  private levitating: number | null = null;
  /** Sent home: the box of its things in its arms, how long since sent home, and how far into its stride it is. */
  private leaving: { box: THREE.Group; boxT: number; elapsed: number; stride: number } | null = null;
  /** Shot: light out, face slack, flat where it fell while its session keeps running (see die). */
  private dead = false;
  /** Walking instead of standing, on its way out. */
  walking = false;
  /** Away from its seat on a visit (see visitors.ts): how it stands, in place of what its status acts out. */
  visitPose: VisitPose | null = null;
  /** What seat or plinth it occupies (`chair`, `beanbag`, `plinth`, or `null` for neutral standing). */
  private seat: WorkerSeat = null;
  /** 0 standing … 1 seated, eased smoothly as it hops off or back onto its chair. */
  private sitK = 0;
  /** A line it's saying on a visit, over its head in place of its card until `left` runs out. */
  private speech: { sprite: THREE.Sprite; text: string; visit: string; left: number } | null = null;
  /** Full-rate motion, rather than a hop enabled but held still beside its finished task card. */
  get animating(): boolean {
    if (this.dead) return false;
    return (
      this.walking ||
      this.visitPose !== null ||
      this.speech !== null ||
      this.stride > 0 ||
      this.spawnT < 1 ||
      this.split !== null ||
      !!this.dancing ||
      this.levitating !== null ||
      !!this.leaving ||
      this.cheerT > 0 ||
      this.twirlT >= 0 ||
      this.microReaction !== null ||
      Math.abs(this.wantSit() - this.sitK) > 1e-3 ||
      this.status === 'working' ||
      this.status === 'needs_input' ||
      this.acts.size > 1 ||
      (this.bouncing && (!this.held || this.bounceT > 0))
    );
  }
  /** What its latest tool call was (see setAction), and what it's acting out right now. */
  private nextAction: WorkerAction | undefined;
  private action: WorkerAction | undefined;
  private actionT = 0;
  /** Continuous posture and one-shot micro-reaction driven by Gemini Decision 1 on visible 3D floors. */
  private vibePosture: WorkerVibePosture = 'steady';
  private microReaction: { kind: ReactionPose; t: number; duration: number } | null = null;
  private lastReactionSeq = 0;
  /** How much is riding on its work (0–1, from Gemini Decision 1), and the clock its posture moves to: faster the higher the stakes. */
  private vibeStakes = 0.5;
  private vibeClock = 0;
  /** How much of each act is in its stance right now, blending from one to the next. */
  private acts = new Map<Act, number>();
  private stance = {} as Stance;
  private blend = {} as Stance;
  /** Seconds it has been waiting on you, for the jump / tap-its-foot cycle. */
  private waitT = 0;
  private turnY = 0;
  /** Seconds into its finishing spin, or -1. */
  private twirlT = -1;
  private papers: ReturnType<typeof papers>;
  private globe: ReturnType<typeof globe>;
  /** Beside its laptop, where the globe floats (see setPropSpot). */
  private spot = new THREE.Vector3(-1, 1.1, 1.3);
  private skin: THREE.MeshToonMaterial;
  /** How far through its stride it is, walking in. */
  private stride = 0;

  constructor(
    name: string,
    private color: string,
    /** A compact nameplate where wall panels already identify the worker (Mission Control). */
    private nameScale = 1,
  ) {
    const skin = (this.skin = toonUnique(color));
    const mats = getWorkerMats();

    this.root.add(this.body);
    // Keep the colored armor mesh at body.children[0] so casualties-ascent and tint checks find it.
    this.skinMesh = new THREE.Mesh(proceduralWorkerSkin(), skin);
    this.skinMesh.castShadow = true;
    this.body.add(this.skinMesh);
    this.body.add(this.chassis);

    // Procedural stand-in torso/pelvis (swapped for droid-worker.glb in fillModel once loaded).
    this.chassis.add(mesh(roundedBox(0.32, 0.22, 0.24, 0.03), mats.DroidBlack, 0, 0.85, 0.005));
    this.chassis.add(mesh(roundedBox(0.28, 0.1, 0.22, 0.024), mats.DroidGraphite, 0, 0.67, 0.01));

    // Chest pinwheel rotor.
    this.rotor.position.copy(WORKER_PIVOTS.rotor);
    this.rotor.add(mesh(glyphFlat(0.082, 2), mats.DroidLight, 0, 0, 0));
    this.body.add(this.rotor);

    // Articulated pod head + visor optics, pupils, arched brows, smile arc & crown beacon.
    this.head.position.copy(WORKER_PIVOTS.neck);
    this.head.add(this.headShell);
    this.headShell.add(mesh(roundedBox(0.42, 0.26, 0.29, 0.06), mats.DroidBlack, 0, 0.134, 0));
    this.headShell.add(mesh(roundedBox(0.33, 0.18, 0.02, 0.02), mats.DroidVisor, 0, 0.128, 0.155));

    const eyeL = mesh(new THREE.BoxGeometry(0.086, 0.098, 0.01), mats.DroidEye, EYE_LOCAL_L.x, EYE_LOCAL_L.y, EYE_LOCAL_L.z);
    const eyeR = mesh(new THREE.BoxGeometry(0.086, 0.098, 0.01), mats.DroidEye, EYE_LOCAL_R.x, EYE_LOCAL_R.y, EYE_LOCAL_R.z);
    const pupilL = new THREE.Group();
    pupilL.position.copy(PUPIL_LOCAL_L);
    pupilL.add(mesh(new THREE.BoxGeometry(0.066, 0.076, 0.008), mats.DroidPupil, 0, 0, 0));
    const pupilR = new THREE.Group();
    pupilR.position.copy(PUPIL_LOCAL_R);
    pupilR.add(mesh(new THREE.BoxGeometry(0.066, 0.076, 0.008), mats.DroidPupil, 0, 0, 0));
    this.eyeMeshes = [eyeL, eyeR];
    this.pupilGroups = [pupilL, pupilR];

    const browL = mesh(new THREE.BoxGeometry(0.064, 0.011, 0.008), skin, BROW_LOCAL_L.x, BROW_LOCAL_L.y, BROW_LOCAL_L.z);
    const browR = mesh(new THREE.BoxGeometry(0.064, 0.011, 0.008), skin, BROW_LOCAL_R.x, BROW_LOCAL_R.y, BROW_LOCAL_R.z);
    this.browMeshes = [browL, browR];

    this.mouthMesh = mesh(new THREE.BoxGeometry(0.044, 0.01, 0.006), mats.DroidEye, MOUTH_LOCAL.x, MOUTH_LOCAL.y, MOUTH_LOCAL.z);

    const bulbMat = toonUnique(STATUS_BULB.starting);
    bulbMat.emissive = new THREE.Color(STATUS_BULB.starting).multiplyScalar(0.6);
    this.bulb = {
      mat: bulbMat,
      mesh: mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.064, 10), bulbMat, BULB_LOCAL.x, BULB_LOCAL.y, BULB_LOCAL.z),
    };
    this.head.add(eyeL, eyeR, pupilL, pupilR, browL, browR, this.mouthMesh, this.bulb.mesh);
    this.body.add(this.head);

    // Two-segment articulated arms (Shoulder -> Elbow -> Forearm/Hand).
    const setupArm = (arm: THREE.Group, upper: THREE.Group, forearm: THREE.Group, shoulderPos: THREE.Vector3, forearmOff: THREE.Vector3, side: number) => {
      arm.position.copy(shoulderPos);
      upper.add(mesh(new THREE.BoxGeometry(0.07, 0.18, 0.07), mats.DroidBlack, side * 0.006, -0.1, 0));
      forearm.position.copy(forearmOff);
      forearm.add(mesh(new THREE.BoxGeometry(0.072, 0.2, 0.072), mats.DroidGraphite, 0, -0.11, 0.008));
      arm.add(upper, forearm);
      this.body.add(arm);
    };
    setupArm(this.armL, this.upperArmL, this.forearmL, WORKER_PIVOTS.armL, FOREARM_LOCAL_L, -1);
    setupArm(this.armR, this.upperArmR, this.forearmR, WORKER_PIVOTS.armR, FOREARM_LOCAL_R, 1);

    // Three-segment articulated legs (Hip -> Knee -> Sneaker-Boot).
    const setupLeg = (thigh: THREE.Group, upper: THREE.Group, shin: THREE.Group, lower: THREE.Group, foot: THREE.Group, hipPos: THREE.Vector3, shinOff: THREE.Vector3, footOff: THREE.Vector3) => {
      thigh.position.copy(hipPos);
      upper.add(mesh(new THREE.BoxGeometry(0.1, 0.26, 0.1), mats.DroidBlack, 0, -0.15, 0));
      shin.position.copy(shinOff);
      lower.add(mesh(new THREE.BoxGeometry(0.088, 0.19, 0.09), mats.DroidGraphite, 0, -0.1, 0));
      foot.position.copy(footOff);
      foot.add(mesh(new THREE.BoxGeometry(0.118, 0.075, 0.195), mats.DroidGraphite, 0, -0.042, 0.028));
      shin.add(lower, foot);
      thigh.add(upper, shin);
      this.body.add(thigh);
    };
    setupLeg(this.thighL, this.upperLegL, this.shinL, this.lowerLegL, this.footL, WORKER_PIVOTS.thighL, SHIN_LOCAL_L, FOOT_LOCAL_L);
    setupLeg(this.thighR, this.upperLegR, this.shinR, this.lowerLegR, this.footR, WORKER_PIVOTS.thighR, SHIN_LOCAL_R, FOOT_LOCAL_R);

    // What it acts out with: a clipboard notepad in its hands, and a globe beside its laptop.
    this.papers = papers();
    this.papers.group.position.set(0, 0.94, 0.364);
    this.papers.group.rotation.x = 0.54;
    this.body.add(this.papers.group);
    this.globe = globe();
    for (const prop of [this.papers.group, this.globe.group]) prop.visible = false;
    this.root.add(this.globe.group);

    this.body.add(this.kit.group);
    if (workerModel) this.fillModel();
    else waitingWorkers.add(this);

    this.setName(name);
  }

  /** Replaces the procedural stand-in meshes with the `droid-worker.glb` parts once loaded. */
  fillModel() {
    if (!workerModel) return;
    const replaceGroup = (group: THREE.Group, parts: WorkerPart[]) => {
      for (const child of group.children) {
        if ((child as THREE.Mesh).isMesh) (child as THREE.Mesh).geometry.dispose();
      }
      group.clear();
      for (const p of parts) {
        const m = new THREE.Mesh(p.geo.clone(), p.mat === 'skin' ? this.skin : p.mat);
        m.castShadow = true;
        group.add(m);
      }
    };
    this.skinMesh.geometry.dispose();
    this.skinMesh.geometry = workerModel.skin.clone();
    replaceGroup(this.chassis, workerModel.body);
    replaceGroup(this.rotor, workerModel.rotor);
    replaceGroup(this.headShell, workerModel.head);
    replaceGroup(this.upperArmL, workerModel.armL);
    replaceGroup(this.upperArmR, workerModel.armR);
    replaceGroup(this.forearmL, workerModel.forearmL);
    replaceGroup(this.forearmR, workerModel.forearmR);
    replaceGroup(this.upperLegL, workerModel.thighL);
    replaceGroup(this.upperLegR, workerModel.thighR);
    replaceGroup(this.lowerLegL, workerModel.shinL);
    replaceGroup(this.lowerLegR, workerModel.shinR);
    replaceGroup(this.footL, workerModel.footL);
    replaceGroup(this.footR, workerModel.footR);
    replaceGroup(this.pupilGroups[0], workerModel.pupilL);
    replaceGroup(this.pupilGroups[1], workerModel.pupilR);
    this.eyeMeshes[0].geometry.dispose();
    this.eyeMeshes[0].geometry = workerModel.eyeL.clone();
    this.eyeMeshes[1].geometry.dispose();
    this.eyeMeshes[1].geometry = workerModel.eyeR.clone();
    this.browMeshes[0].geometry.dispose();
    this.browMeshes[0].geometry = workerModel.browL.clone();
    this.browMeshes[1].geometry.dispose();
    this.browMeshes[1].geometry = workerModel.browR.clone();
    this.mouthMesh.geometry.dispose();
    this.mouthMesh.geometry = workerModel.mouth.clone();
    this.bulb.mesh.geometry.dispose();
    this.bulb.mesh.geometry = workerModel.bulb.clone();
  }

  /** Assigns the seat or plinth this worker occupies, snapping directly into posture on spawn. */
  setSeat(seat: WorkerSeat) {
    this.seat = seat;
    if (!this.walking && !this.visitPose && !this.dancing && !this.leaving && !this.dead) {
      this.sitK = this.wantSit();
    }
  }

  private wantSit(): number {
    if (this.dead || !this.seat || this.seat === 'plinth') return 0;
    if (this.walking || this.visitPose !== null || this.dancing !== null) return 0;
    if (this.leaving) return this.leaving.elapsed >= 0.85 ? 0 : 1;
    return 1;
  }

  /** Where the globe floats, in its own space: beside its laptop, where the card over its head doesn't hide it. */
  setPropSpot(at: THREE.Vector3) {
    this.spot.copy(at);
  }

  /** What its latest tool call was, to act out while it's working. */
  setAction(action: WorkerAction | undefined) {
    this.nextAction = action;
  }

  /** Applies continuous desk posture and any newly sequenced high-confidence micro-reaction. */
  applyVibe(vibe: WorkerVibeState | undefined, nowMs = Date.now()) {
    this.vibePosture = vibe && isWorkerVibePosture(vibe.posture) ? vibe.posture : 'steady';
    this.vibeStakes = typeof vibe?.stakes === 'number' && Number.isFinite(vibe.stakes) ? Math.max(0, Math.min(1, vibe.stakes)) : 0.5;
    const r = vibe?.reaction;
    if (r && r.seq > 0 && r.seq !== this.lastReactionSeq && isWorkerMicroReaction(r.kind)) {
      this.lastReactionSeq = r.seq;
      if (!this.microReaction && nowMs - r.at <= 10_000) this.triggerReaction(r.kind);
    }
  }

  /** Triggers a one-shot micro-reaction over a smooth ~2.5s envelope without snapping limbs. */
  triggerReaction(kind: ReactionPose) {
    if (this.dead || this.leaving || this.dancing) return;
    const duration = REACTION_SECONDS[kind] ?? 2.4;
    this.microReaction = { kind, t: 0, duration };
    // Shipping is a full spin in the chair.
    if (kind === 'shipped') this.twirlT = 0;
  }

  /** How much is riding on its work right now, 0–1. */
  get activeVibeStakes(): number {
    return this.vibeStakes;
  }

  get activeVibePosture(): WorkerVibePosture {
    return this.vibePosture;
  }

  get activeReaction(): ReactionPose | null {
    return this.microReaction?.kind ?? null;
  }

  /** A newly forked twin peels away from the source into its own seat. */
  splitFrom(from: THREE.Vector3) {
    this.split = { from: from.clone(), t: 0 };
    this.root.position.copy(from);
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
    this.nameTag = textSprite(name, { bg: '#0a0a0a', color: '#eeeeee', size: 36, border: this.teamAccent ?? '#2f2f2f' });
    this.nameTag.scale.multiplyScalar(this.nameScale);
    this.nameTag.position.y = 1.55;
    this.root.add(this.nameTag);
  }

  /** The team markings it wears: a crown for a lead, the comms kit for a subagent, shoulder panels for both. Its status never changes them. */
  setTeam(badge: TeamBadge | undefined) {
    this.kit.set(badge);
    this.kit.syncHead(this.head);
    if (badge?.accent === this.teamAccent) return;
    this.teamAccent = badge?.accent;
    this.setName(this.name);
  }

  /** What its markings show now: the crown, the comms kit, or none (also none until the kit's GLB has loaded). */
  get teamRole(): TeamBadge['role'] | undefined {
    return this.kit.role;
  }

  setStatus(status: WorkerStatus, bounce = false) {
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

  /** A harmless lift above its seat, easing up and back down at full size. */
  levitate(): boolean {
    if (this.dead || this.leaving || this.walking || this.visitPose || this.dancing || this.split || this.levitating !== null || isAsleep(this.status)) return false;
    this.levitating = 0;
    return true;
  }

  /**
   * Hops up on to `stage` (its desk), dances for a few seconds with its light flashing like a disco
   * ball, and hops back down into its seat. Asked again mid-dance, it stays up and dances on.
   */
  dance(stage: Stage) {
    if (this.leaving || this.dead || this.split || this.levitating !== null || this.visitPose) return;
    this.microReaction = null;
    this.paintBulb();
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

  /** Back in its seat at once, mid-dance, levitation or split (it's being sent home). */
  stopDancing() {
    if (!this.dancing && this.levitating === null && !this.split) return;
    this.dancing = null;
    this.levitating = null;
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

  setTodos(todos: TodoProgress | undefined) {
    this.todos = todos;
    this.drawBubble();
  }

  setLost(lost: boolean) {
    this.lost = lost;
    this.drawBubble();
  }

  private resetLimbs() {
    this.armL.position.copy(WORKER_PIVOTS.armL);
    this.armR.position.copy(WORKER_PIVOTS.armR);
    this.armL.rotation.set(0, 0, 0);
    this.armR.rotation.set(0, 0, 0);
    this.forearmL.rotation.set(0, 0, 0);
    this.forearmR.rotation.set(0, 0, 0);
    this.thighL.position.copy(WORKER_PIVOTS.thighL);
    this.thighR.position.copy(WORKER_PIVOTS.thighR);
    this.thighL.rotation.set(0, 0, 0);
    this.thighR.rotation.set(0, 0, 0);
    this.shinL.rotation.set(0, 0, 0);
    this.shinR.rotation.set(0, 0, 0);
    this.footL.rotation.set(0, 0, 0);
    this.footR.rotation.set(0, 0, 0);
    this.head.position.copy(WORKER_PIVOTS.neck);
    this.head.rotation.set(0, 0, 0);
    this.pupilGroups[0].position.copy(PUPIL_LOCAL_L);
    this.pupilGroups[1].position.copy(PUPIL_LOCAL_R);
    this.browMeshes[0].position.copy(BROW_LOCAL_L);
    this.browMeshes[1].position.copy(BROW_LOCAL_R);
    this.browMeshes[0].rotation.set(0, 0, 0);
    this.browMeshes[1].rotation.set(0, 0, 0);
    this.mouthMesh.position.copy(MOUTH_LOCAL);
    this.mouthMesh.rotation.set(0, 0, 0);
    this.mouthMesh.scale.set(1, 1, 1);
    this.kit.syncHead(this.head);
  }

  /** Sent home: its light goes out, its face falls, and its things pop into a box in its arms. `farewell` goes over its head. */
  leave(farewell: string) {
    if (this.leaving) return;
    this.microReaction = null;
    this.hush();
    this.visitPose = null;
    this.stopDancing();
    this.bouncing = false;
    this.cheerT = 0;
    this.bounceT = 0;
    this.twirlT = -1;
    for (const prop of [this.papers.group, this.globe.group]) prop.visible = false;
    this.resetLimbs();
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
    // Sad downturned gaze, worried brows and flipped frown.
    for (const p of this.pupilGroups) p.position.y -= 0.014;
    this.browMeshes[0].position.y += 0.006;
    this.browMeshes[1].position.y += 0.006;
    this.browMeshes[0].rotation.z = 0.34;
    this.browMeshes[1].rotation.z = -0.34;
    this.mouthMesh.rotation.z = Math.PI;
    // Hugged to its waist/chest, arms cradling the sides.
    const box = boxOfStuff();
    box.position.set(0, 0.64, 0.29);
    box.scale.setScalar(0.001);
    this.body.add(box);
    this.leaving = { box, boxT: 0, elapsed: 0, stride: 0 };
  }

  /**
   * Says `text` on visit `visit`: a speech card over its head for `seconds`, in place of its status
   * card and name tag, which come back once it's done. `chip` says who says it and how (BYTE ASKS).
   */
  speak(text: string, chip: string, visit: string, seconds: number) {
    if (this.leaving || this.dead) return;
    this.hush();
    const sprite = cardSprite({
      chip: { text: chip, bg: CHIP_BG, color: this.color },
      title: '',
      body: text,
      bodyLines: 4,
      maxWidth: 360,
      bg: '#0a0a0a',
      border: this.color,
      color: '#ffffff',
      muted: '#eeeeee',
    });
    sprite.scale.multiplyScalar(SPEECH_SCALE);
    this.root.add(sprite);
    this.speech = { sprite, text, visit, left: seconds };
  }

  /** Stops saying what it was saying (on `visit`, if one is given), and its card shows again. */
  hush(visit?: string) {
    const s = this.speech;
    if (!s || (visit !== undefined && s.visit !== visit)) return;
    this.root.remove(s.sprite);
    disposeSprite(s.sprite);
    this.speech = null;
  }

  /** What it's saying on a visit right now, if anything. */
  get saying(): string | null {
    return this.speech?.text ?? null;
  }

  /** How far its body leans forward (radians), for checks. */
  get lean(): number {
    return this.body.rotation.x;
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

  /**
   * Shot: its light goes out, its face goes slack and its bubble goes away. Its session runs on.
   * `asleep` (hit by the wand) shuts its eyes instead, fast asleep.
   */
  die(asleep = false) {
    if (this.dead) return;
    this.microReaction = null;
    this.hush();
    this.visitPose = null;
    this.dead = true;
    this.asleep = asleep;
    this.sitK = 0;
    this.stopDancing();
    this.bouncing = false;
    this.cheerT = 0;
    this.bounceT = 0;
    this.twirlT = -1;
    for (const prop of [this.papers.group, this.globe.group]) prop.visible = false;
    this.body.position.set(0, 0, 0);
    this.body.rotation.set(0, 0, 0);
    this.body.scale.setScalar(1);
    this.resetLimbs();
    this.bulbOut();
    if (this.bubble) {
      this.root.remove(this.bubble);
      disposeSprite(this.bubble);
      this.bubble = null;
    }
    this.bubbleKey = 'dead';
    for (const p of this.pupilGroups) p.position.y = PUPIL_LOCAL_L.y - 0.016;
    this.mouthMesh.rotation.z = asleep ? 0 : Math.PI;
    this.mouthMesh.scale.set(0.65, 0.5, 1);
  }

  private drawBubble() {
    if (this.leaving || this.dead) return;
    const { status, bouncing: bounce, task, pr, lost, todos } = this;
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
              ? `\u25B8 WORKING${todos ? ` ${todoCount(todos)}` : ''}`
              : isAsleep(status)
                ? 'ZZZ'
                : '';
    const key = `${lost}|${border}|${prLabel}|${task ? `${status}|${bounce}|${task.name}|${task.summary}|${todos ? todoLine(todos) : ''}` : bubble}`;
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
        ...(todos ? { progress: { label: todoLine(todos), fraction: todoFraction(todos), color: '#ee6018' } } : {}),
      });
      this.bubble.scale.multiplyScalar(CARD_SCALE);
    } else if (bubble) this.bubble = textSprite(bubble, { bg: '#0a0a0a', color: lost ? LOST_CHIP[1] : (border ?? '#eeeeee'), border: border ?? (lost ? LOST_CHIP[1] : '#2f2f2f'), size: 38 });
    if (this.bubble) this.root.add(this.bubble);
  }

  /** You're `d` metres from its head: its card and name tag fade out as you come up to it (see labelFade). */
  seenFrom(d: number) {
    this.labelAlpha = labelFade(d);
  }

  private sitPose = { y: 0, z: 0, lean: 0 };

  /**
   * Called every frame, since the card is redrawn whenever what it says changes. Opacity only:
   * `visible` belongs to whoever hides the labels outright (a heavenly ascent).
   */
  private fadeLabels() {
    // A line said on a visit stands in for the card and the name tag (its chip names who says it), and
    // stays readable from right beside it.
    const alpha = this.speech ? 0 : this.labelAlpha;
    if (this.bubble) this.bubble.material.opacity = alpha;
    if (this.nameTag) this.nameTag.material.opacity = alpha;
    if (this.speech) this.speech.sprite.material.opacity = Math.max(this.labelAlpha, 0.85);
  }

  private stepSit(dt: number): { y: number; z: number; lean: number } {
    const want = this.wantSit();
    this.sitK += (want - this.sitK) * Math.min(1, dt * 10);
    if (Math.abs(want - this.sitK) < 1e-3) this.sitK = want;
    const out = this.sitPose;
    if (this.seat === 'plinth') {
      out.y = -0.085;
      out.z = 0;
      out.lean = 0;
    } else if (this.seat === 'beanbag') {
      out.y = -0.44 * this.sitK;
      out.z = -0.02 * this.sitK;
      out.lean = -0.1 * this.sitK;
    } else {
      out.y = -0.436 * this.sitK;
      out.z = 0.025 * this.sitK;
      out.lean = 0;
    }
    return out;
  }

  private applyLegs(sit: number, tap: number, kick: number, hopStretch = 0) {
    const k = sit * (1 - hopStretch * 0.65);
    const bag = this.seat === 'beanbag';
    this.thighL.position.set(WORKER_PIVOTS.thighL.x, WORKER_PIVOTS.thighL.y, WORKER_PIVOTS.thighL.z + 0.048 * k);
    this.thighR.position.set(WORKER_PIVOTS.thighR.x, WORKER_PIVOTS.thighR.y, WORKER_PIVOTS.thighR.z + 0.048 * k);
    const hipBend = (bag ? -1.42 : -1.58) * k;
    const splay = (bag ? 0.22 : 0.06) * k;
    this.thighL.rotation.set(hipBend, 0, -splay);
    this.thighR.rotation.set(hipBend - tap * 0.06, 0, splay);
    const kneeBend = (bag ? 0.68 : 1.38) * k - kick * 0.72 * k;
    this.shinL.rotation.set(Math.max(0, kneeBend), 0, 0);
    this.shinR.rotation.set(Math.max(0, kneeBend + tap * 0.16), 0, 0);
    const ankle = 0.18 * k - kick * 0.25 * k;
    this.footL.rotation.set(ankle, 0, 0);
    this.footR.rotation.set(ankle + tap * 0.36, 0, 0);
  }

  private applyStride(phase: number) {
    const s = Math.sin(phase);
    this.thighL.rotation.x += s * 0.56;
    this.shinL.rotation.x += Math.max(0, -s) * 0.68 + 0.08;
    this.footL.rotation.x += s * 0.2;
    this.thighR.rotation.x -= s * 0.56;
    this.shinR.rotation.x += Math.max(0, s) * 0.68 + 0.08;
    this.footR.rotation.x -= s * 0.2;
  }

  update(dt: number, t: number) {
    this.fadeLabels();
    if (this.leaving) return this.carry(this.leaving, dt, t);
    if (this.dancing) return this.boogie(this.dancing, dt, t);
    if (this.dead) return this.flatline(dt);
    if (this.split) {
      this.split.t = Math.min(1, this.split.t + dt / 0.65);
      const p = this.split.t;
      this.root.position.copy(this.split.from).multiplyScalar(1 - p * p * (3 - 2 * p));
      this.root.position.y += Math.sin(p * Math.PI) * 0.35;
      if (p === 1) {
        this.root.position.set(0, 0, 0);
        this.split = null;
      }
    }
    if (this.levitating !== null) {
      this.levitating = Math.min(LEVITATE_TIME, this.levitating + dt);
      this.root.position.y = LEVITATE_HEIGHT * Math.sin((Math.PI * this.levitating) / LEVITATE_TIME) ** 2;
      if (this.levitating >= LEVITATE_TIME) {
        this.root.position.y = 0;
        this.levitating = null;
      }
    }
    const base = this.stepSit(dt);
    this.cheerT = Math.max(0, this.cheerT - dt);
    // Waiting on you: a couple of seconds of jumping, then arms crossed and a tapping foot, and round again.
    this.waitT = this.status === 'needs_input' ? this.waitT + dt : 0;
    const tapping = this.status === 'needs_input' && (this.held || this.waitT % WAIT_CYCLE >= WAIT_HOPS);
    // Jump up and down when done / waiting on a human (except while held or tapping), or cheering.
    if (!this.visitPose && (this.bouncing || this.cheerT > 0)) {
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
    const sleeping = isAsleep(this.status);
    this.vibeClock += dt * (0.7 + this.vibeStakes * 1.1);
    let workingAct: Act = this.action ?? 'type';
    if (this.vibePosture !== 'steady') {
      const propCameo = (this.action === 'web' || this.action === 'read') && this.actionT < 3.2;
      if (!propCameo) workingAct = `vibe_${this.vibePosture}`;
    }
    const act: Act = hopping ? 'up' : (this.visitPose ?? (this.bouncing && this.status === 'done' ? 'up' : this.status === 'needs_input' ? 'waiting' : this.status === 'working' ? workingAct : 'rest'));
    const s = this.pose(act, dt, t);
    let asymBrow = 0;
    let reactionBulbHex: string | null = null;
    if (this.microReaction) {
      const r = this.microReaction;
      r.t += dt;
      if (r.t >= r.duration || hopping || sleeping || this.visitPose) {
        this.microReaction = null;
        this.paintBulb();
      } else {
        const env = emoteEnvelope(r.t, r.duration);
        reactionBulbHex = reactionHex(r.kind);
        if (r.kind === 'breakthrough') {
          const pump = Math.sin(r.t * 14) * 0.34;
          s.armLx = THREE.MathUtils.lerp(s.armLx, -2.36 - pump, env);
          s.armRx = THREE.MathUtils.lerp(s.armRx, -2.36 + pump, env);
          s.armLz = THREE.MathUtils.lerp(s.armLz, -0.24, env);
          s.armRz = THREE.MathUtils.lerp(s.armRz, 0.24, env);
          s.forearmLx = THREE.MathUtils.lerp(s.forearmLx, -0.78, env);
          s.forearmRx = THREE.MathUtils.lerp(s.forearmRx, -0.78, env);
          s.lean -= 0.14 * env;
          s.lift += Math.abs(Math.sin(r.t * 8.5)) * 0.24 * env;
          s.roll = THREE.MathUtils.lerp(s.roll, Math.sin(r.t * 8.5) * 0.12, env);
          s.headX = THREE.MathUtils.lerp(s.headX, -0.16, env);
          s.browLift = THREE.MathUtils.lerp(s.browLift, 0.011, env);
          s.mouthW = THREE.MathUtils.lerp(s.mouthW, 1.45, env);
          s.mouthH = THREE.MathUtils.lerp(s.mouthH, 1.6, env);
          s.frown = THREE.MathUtils.lerp(s.frown, 0, env);
        } else if (r.kind === 'setback') {
          // Blend the double-take flinch into the facepalm instead of snapping at the phase boundary.
          const slump = THREE.MathUtils.smoothstep(r.t, 0.35, 0.55);
          s.lean = THREE.MathUtils.lerp(s.lean, THREE.MathUtils.lerp(-0.26, 0.3, slump), env);
          s.lid = THREE.MathUtils.lerp(s.lid, THREE.MathUtils.lerp(1.3, 0.6, slump), env);
          s.headY = THREE.MathUtils.lerp(s.headY, THREE.MathUtils.lerp(Math.sin(r.t * 26) * 0.24, Math.sin(r.t * 14) * 0.18, slump), env);
          s.lift += (1 - slump) * Math.exp(-r.t * 6) * 0.12 * env;
          s.armRx = THREE.MathUtils.lerp(s.armRx, -1.84, env * slump);
          s.armRz = THREE.MathUtils.lerp(s.armRz, -0.12, env * slump);
          s.forearmRx = THREE.MathUtils.lerp(s.forearmRx, -1.9, env * slump);
          s.forearmRz = THREE.MathUtils.lerp(s.forearmRz, -0.52, env * slump);
          s.headX = THREE.MathUtils.lerp(s.headX, 0.2, env * slump);
          s.browTilt = THREE.MathUtils.lerp(s.browTilt, -0.34, env);
          s.frown = THREE.MathUtils.lerp(s.frown, 1, env);
        } else if (r.kind === 'puzzled') {
          s.headZ = THREE.MathUtils.lerp(s.headZ, 0.34 + Math.sin(r.t * 3) * 0.06, env);
          s.headY = THREE.MathUtils.lerp(s.headY, -0.1, env);
          s.armRx = THREE.MathUtils.lerp(s.armRx, -1.96, env);
          s.armRz = THREE.MathUtils.lerp(s.armRz, 0.18, env);
          s.forearmRx = THREE.MathUtils.lerp(s.forearmRx, -1.62 + Math.sin(r.t * 18) * 0.18, env);
          s.forearmRz = THREE.MathUtils.lerp(s.forearmRz, -0.36, env);
          s.mouthW = THREE.MathUtils.lerp(s.mouthW, 0.68, env);
          s.mouthH = THREE.MathUtils.lerp(s.mouthH, 0.55, env);
          asymBrow = 0.011 * env;
        } else if (r.kind === 'pivot') {
          // Changing tack: a sharp swivel away and back, head snapping round, one hand flicking aside.
          const swing = Math.sin(Math.min(1, r.t / 1.1) * Math.PI);
          s.turn = THREE.MathUtils.lerp(s.turn, 0.7 * swing, env);
          s.headY = THREE.MathUtils.lerp(s.headY, -0.3 * swing, env);
          s.armRx = THREE.MathUtils.lerp(s.armRx, -1.5, env);
          s.armRz = THREE.MathUtils.lerp(s.armRz, 0.7 * swing, env);
          s.forearmRx = THREE.MathUtils.lerp(s.forearmRx, -0.5, env);
          s.lean = THREE.MathUtils.lerp(s.lean, -0.08, env);
          s.browLift = THREE.MathUtils.lerp(s.browLift, 0.008, env);
          s.mouthW = THREE.MathUtils.lerp(s.mouthW, 1.1, env);
          s.frown = THREE.MathUtils.lerp(s.frown, 0, env);
        } else if (r.kind === 'eureka') {
          // Aha: one hand shoots straight up, eyes wide, a jolt upright.
          s.armRx = THREE.MathUtils.lerp(s.armRx, -2.62 + Math.sin(r.t * 10) * 0.06, env);
          s.armRz = THREE.MathUtils.lerp(s.armRz, 0.1, env);
          s.forearmRx = THREE.MathUtils.lerp(s.forearmRx, -0.12, env);
          s.forearmRz = THREE.MathUtils.lerp(s.forearmRz, 0, env);
          s.headX = THREE.MathUtils.lerp(s.headX, -0.2, env);
          s.headY = THREE.MathUtils.lerp(s.headY, 0, env);
          s.lean = THREE.MathUtils.lerp(s.lean, -0.12, env);
          s.lift += Math.exp(-r.t * 4) * 0.2 * env;
          s.lid = THREE.MathUtils.lerp(s.lid, 1.32, env);
          s.browLift = THREE.MathUtils.lerp(s.browLift, 0.013, env);
          s.mouthW = THREE.MathUtils.lerp(s.mouthW, 0.9, env);
          s.mouthH = THREE.MathUtils.lerp(s.mouthH, 1.6, env);
          s.frown = THREE.MathUtils.lerp(s.frown, 0, env);
        } else if (r.kind === 'shipped') {
          // Both arms up in a V, bouncing through the spin.
          s.armLx = THREE.MathUtils.lerp(s.armLx, -2.5 + Math.sin(r.t * 12) * 0.12, env);
          s.armRx = THREE.MathUtils.lerp(s.armRx, -2.5 - Math.sin(r.t * 12) * 0.12, env);
          s.armLz = THREE.MathUtils.lerp(s.armLz, -0.52, env);
          s.armRz = THREE.MathUtils.lerp(s.armRz, 0.52, env);
          s.forearmLx = THREE.MathUtils.lerp(s.forearmLx, -0.2, env);
          s.forearmRx = THREE.MathUtils.lerp(s.forearmRx, -0.2, env);
          s.lift += Math.abs(Math.sin(r.t * 7)) * 0.22 * env;
          s.headX = THREE.MathUtils.lerp(s.headX, -0.18, env);
          s.mouthW = THREE.MathUtils.lerp(s.mouthW, 1.5, env);
          s.mouthH = THREE.MathUtils.lerp(s.mouthH, 1.55, env);
          s.frown = THREE.MathUtils.lerp(s.frown, 0, env);
          s.browLift = THREE.MathUtils.lerp(s.browLift, 0.01, env);
        } else if (r.kind === 'frustrated') {
          // Hands to the head, shaking it, brows down hard.
          s.armLx = THREE.MathUtils.lerp(s.armLx, -2.15, env);
          s.armRx = THREE.MathUtils.lerp(s.armRx, -2.15, env);
          s.armLz = THREE.MathUtils.lerp(s.armLz, -0.3, env);
          s.armRz = THREE.MathUtils.lerp(s.armRz, 0.3, env);
          s.forearmLx = THREE.MathUtils.lerp(s.forearmLx, -1.95, env);
          s.forearmRx = THREE.MathUtils.lerp(s.forearmRx, -1.95, env);
          s.forearmLz = THREE.MathUtils.lerp(s.forearmLz, 0.55, env);
          s.forearmRz = THREE.MathUtils.lerp(s.forearmRz, -0.55, env);
          s.headY = THREE.MathUtils.lerp(s.headY, Math.sin(r.t * 19) * 0.26, env);
          s.headX = THREE.MathUtils.lerp(s.headX, 0.14, env);
          s.lean = THREE.MathUtils.lerp(s.lean, 0.18, env);
          s.browTilt = THREE.MathUtils.lerp(s.browTilt, 0.42, env);
          s.browLift = THREE.MathUtils.lerp(s.browLift, -0.006, env);
          s.lid = THREE.MathUtils.lerp(s.lid, 0.66, env);
          s.frown = THREE.MathUtils.lerp(s.frown, 1, env);
          s.tap = Math.max(s.tap, Math.max(0, Math.sin(r.t * 22)) * env);
        } else if (r.kind === 'rabbit_hole') {
          // Wandering off: leaning back, gaze drifting round in a slow loop, head lolling with it.
          s.lean = THREE.MathUtils.lerp(s.lean, -0.2, env);
          s.headY = THREE.MathUtils.lerp(s.headY, Math.sin(r.t * 2.4) * 0.3, env);
          s.headZ = THREE.MathUtils.lerp(s.headZ, Math.cos(r.t * 2.4) * 0.16, env);
          s.lookX = THREE.MathUtils.lerp(s.lookX, Math.sin(r.t * 2.4) * 0.016, env);
          s.look = THREE.MathUtils.lerp(s.look, 0.006 + Math.cos(r.t * 2.4) * 0.008, env);
          s.armLx = THREE.MathUtils.lerp(s.armLx, -0.4, env);
          s.armRx = THREE.MathUtils.lerp(s.armRx, -0.4, env);
          s.forearmLx = THREE.MathUtils.lerp(s.forearmLx, -0.3, env);
          s.forearmRx = THREE.MathUtils.lerp(s.forearmRx, -0.3, env);
          s.lid = THREE.MathUtils.lerp(s.lid, 0.8, env);
          s.mouthW = THREE.MathUtils.lerp(s.mouthW, 0.8, env);
          s.mouthH = THREE.MathUtils.lerp(s.mouthH, 0.7, env);
        } else if (r.kind === 'corner_cut') {
          // Sneaky: hunched in over the keyboard, eyes darting left and right, a quick shifty grin.
          s.lean = THREE.MathUtils.lerp(s.lean, 0.26, env);
          s.drop += 0.03 * env;
          s.headX = THREE.MathUtils.lerp(s.headX, 0.18, env);
          // A soft square wave: the eyes snap to each side and hold there, without a one-frame jump.
          const dart = Math.tanh(Math.sin(r.t * 4) * 6);
          s.headY = THREE.MathUtils.lerp(s.headY, dart * 0.22, env);
          s.lookX = THREE.MathUtils.lerp(s.lookX, dart * 0.018, env);
          s.lid = THREE.MathUtils.lerp(s.lid, 0.62, env);
          s.forearmLx = THREE.MathUtils.lerp(s.forearmLx, -0.7 + Math.sin(r.t * 30) * 0.12, env);
          s.forearmRx = THREE.MathUtils.lerp(s.forearmRx, -0.7 + Math.sin(r.t * 30 + 1.6) * 0.12, env);
          s.mouthW = THREE.MathUtils.lerp(s.mouthW, 1.3, env);
          s.mouthH = THREE.MathUtils.lerp(s.mouthH, 0.5, env);
          s.browTilt = THREE.MathUtils.lerp(s.browTilt, -0.2, env);
          asymBrow = 0.009 * env;
        } else if (r.kind === 'risky_move') {
          // Bracing for impact: recoiling back, both hands up guarding its face, eyes wide.
          s.lean = THREE.MathUtils.lerp(s.lean, -0.3, env);
          s.lift += Math.exp(-r.t * 5) * 0.16 * env;
          s.armLx = THREE.MathUtils.lerp(s.armLx, -2.1, env);
          s.armRx = THREE.MathUtils.lerp(s.armRx, -2.1, env);
          s.armLz = THREE.MathUtils.lerp(s.armLz, -0.18, env);
          s.armRz = THREE.MathUtils.lerp(s.armRz, 0.18, env);
          s.forearmLx = THREE.MathUtils.lerp(s.forearmLx, -1.5 + Math.sin(r.t * 20) * 0.05, env);
          s.forearmRx = THREE.MathUtils.lerp(s.forearmRx, -1.5 - Math.sin(r.t * 20) * 0.05, env);
          s.headX = THREE.MathUtils.lerp(s.headX, -0.1, env);
          s.lid = THREE.MathUtils.lerp(s.lid, 1.35, env);
          s.browLift = THREE.MathUtils.lerp(s.browLift, 0.014, env);
          s.mouthW = THREE.MathUtils.lerp(s.mouthW, 0.7, env);
          s.mouthH = THREE.MathUtils.lerp(s.mouthH, 1.4, env);
          s.frown = THREE.MathUtils.lerp(s.frown, 0, env);
        }
      }
    }

    this.armL.rotation.set(s.armLx, 0, s.armLz);
    this.armR.rotation.set(s.armRx, 0, s.armRz);
    this.forearmL.rotation.set(s.forearmLx, 0, s.forearmLz);
    this.forearmR.rotation.set(s.forearmRx, 0, s.forearmRz);
    if (this.visitPose && this.walking) {
      // Two-joint arms swing naturally against the stride on the way over.
      const swing = Math.sin(this.stride) * 0.48;
      this.armL.rotation.x += swing;
      this.armR.rotation.x -= swing;
      this.forearmL.rotation.x -= Math.max(0, -swing) * 0.35;
      this.forearmR.rotation.x -= Math.max(0, swing) * 0.35;
    }
    this.armL.position.set(WORKER_PIVOTS.armL.x + s.reach * 0.045, WORKER_PIVOTS.armL.y - s.drop, WORKER_PIVOTS.armL.z + s.reach * 0.08);
    this.armR.position.set(WORKER_PIVOTS.armR.x - s.reach * 0.045, WORKER_PIVOTS.armR.y - s.drop + s.reach * 0.02, WORKER_PIVOTS.armR.z + s.reach * 0.09);

    const hopH = hopping ? Math.abs(Math.sin(this.bounceT)) : 0;
    this.applyLegs(this.sitK, s.tap, s.kick, hopH);

    // Head, pupils, brows and cute smile expression.
    const sleepNod = sleeping ? 0.22 : 0;
    this.head.position.copy(WORKER_PIVOTS.neck);
    this.head.rotation.set(s.headX + sleepNod, s.headY, sleeping ? Math.sin(t * 1.2) * 0.06 : s.headZ);
    this.pupilGroups[0].position.set(PUPIL_LOCAL_L.x + s.lookX, PUPIL_LOCAL_L.y + s.look, PUPIL_LOCAL_L.z);
    this.pupilGroups[1].position.set(PUPIL_LOCAL_R.x + s.lookX, PUPIL_LOCAL_R.y + s.look, PUPIL_LOCAL_R.z);
    this.browMeshes[0].position.set(BROW_LOCAL_L.x, BROW_LOCAL_L.y + s.browLift - asymBrow, BROW_LOCAL_L.z);
    this.browMeshes[1].position.set(BROW_LOCAL_R.x, BROW_LOCAL_R.y + s.browLift + asymBrow, BROW_LOCAL_R.z);
    this.browMeshes[0].rotation.z = -s.browTilt;
    this.browMeshes[1].rotation.z = s.browTilt;
    if (reactionBulbHex) {
      this.bulb.mat.color.set(reactionBulbHex);
      this.bulb.mat.emissive.set(reactionBulbHex).multiplyScalar(1.15);
    }
    const chattering = this.speech !== null && act !== 'talk';
    const mw = sleeping ? 0.5 : s.mouthW;
    const mh = sleeping ? 0.45 + Math.sin(t * 2) * 0.12 : chattering ? 0.55 + Math.abs(Math.sin(t * 13)) * 0.9 : s.mouthH;
    this.mouthMesh.scale.set(mw, mh, 1);
    this.mouthMesh.rotation.z = s.frown > 0.5 ? Math.PI : 0;
    this.kit.syncHead(this.head);

    if (!sleeping) {
      this.rotor.rotation.z -= dt * (this.status === 'working' ? 8.5 : 1.8);
    }
    this.body.rotation.x = base.lean + s.lean;
    let twirl = 0;
    if (this.twirlT >= 0) {
      this.twirlT += dt;
      twirl = ease(Math.min(1, this.twirlT / TWIRL_TIME)) * Math.PI * 2;
      if (this.twirlT >= TWIRL_TIME) this.twirlT = -1;
    }
    if (hopping) {
      this.body.position.set(0, base.y + hopH * 0.55, base.z);
      const squash = hopH < 0.15 ? 1 - (0.15 - hopH) * 1.4 : 1;
      this.body.scale.set(pop * (2 - squash), pop * squash, pop * (2 - squash));
      this.turnY = Math.sin(this.bounceT * 0.5) * 0.3;
    } else {
      this.body.position.set(0, base.y + (this.animating ? s.lift : 0), base.z);
      this.body.scale.setScalar(pop);
      this.turnY += (s.turn - this.turnY) * Math.min(1, dt * 6);
    }
    this.body.rotation.y = this.turnY + twirl;
    this.body.rotation.z = sleeping ? Math.sin(t * 1.5) * 0.05 : s.roll;
    this.props(t);
    this.blink(dt, sleeping ? 0.08 : s.lid);
    let bulbPulse = 1;
    if (this.status === 'needs_input') bulbPulse = 1 + Math.abs(Math.sin(t * 8)) * 0.45;
    else if (reactionBulbHex) bulbPulse = 1.05 + Math.abs(Math.sin(t * 9)) * 0.32;
    this.bulbScale(bulbPulse);
    const hopLift = hopping ? hopH * 0.55 : 0;
    if (this.bubble) this.bubble.position.y = (this.bubbleIsCard ? 1.74 : 1.95) + hopLift + Math.sin(t * 3) * 0.03;
    if (this.nameTag) this.nameTag.position.y = 1.55 + hopLift;
    const said = this.speech;
    if (said) {
      said.sprite.position.y = 1.74 + hopLift + Math.sin(t * 3) * 0.03;
      said.left -= dt;
      if (said.left <= 0) this.hush();
    }
    // Walking uses a full three-joint leg stride.
    if (this.walking || this.stride) {
      this.stride = this.walking ? this.stride + dt * 9.5 : 0;
      const strideS = Math.sin(this.stride);
      this.applyStride(this.stride);
      this.body.position.y += Math.abs(strideS) * 0.045;
      this.body.rotation.z = strideS * 0.07;
      this.head.rotation.z -= strideS * 0.05;
      this.kit.syncHead(this.head);
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
    const seated = this.sitK > 0.5;
    let total = 0;
    for (const [a, w0] of this.acts) {
      const w = w0 + ((a === act ? 1 : 0) - w0) * k;
      if (a !== act && w < 0.01) {
        this.acts.delete(a);
        continue;
      }
      this.acts.set(a, w);
      const s = stanceOf(a, a.startsWith('vibe_') ? this.vibeClock : t, seated, this.stance);
      for (const key of STANCE_KEYS) out[key] += s[key] * w;
      total += w;
    }
    for (const key of STANCE_KEYS) out[key] /= total;
    return out;
  }

  /** The papers and the globe come and go with the act they belong to. */
  private props(t: number) {
    const show = (prop: THREE.Object3D, act: Act) => {
      const w = this.acts.get(act) ?? 0;
      prop.visible = w > 0.02;
      if (prop.visible) prop.scale.setScalar(Math.max(0.001, popIn(w)));
      return prop.visible;
    };
    show(this.papers.group, 'read');
    if (show(this.globe.group, 'web')) {
      this.globe.group.position.copy(this.spot).y += Math.sin(t * 2) * 0.03;
      this.globe.ball.rotation.y = t * 2.2;
      this.globe.ring.rotation.z = t * 0.6;
    }
  }

  /** Shot: flat where it fell, lids heavy, light out. Only the name tag stays up. */
  private flatline(dt: number) {
    if (this.asleep) {
      this.setOpticScaleY(0.08);
      return;
    }
    this.blinkAt -= dt;
    if (this.blinkAt < 0) this.blinkAt = 4 + Math.random() * 4;
    const shut = this.blinkAt < 0.4;
    this.setOpticScaleY(shut ? 0.1 : 0.38);
  }

  /** Sent home: head hung, the box in its arms, striding out once off the chair. */
  private carry(l: NonNullable<Worker['leaving']>, dt: number, t: number) {
    l.elapsed += dt;
    const base = this.stepSit(dt);
    // The box pops in, overshooting a little.
    l.boxT = Math.min(1, l.boxT + dt * 2.5);
    const u = l.boxT - 1;
    l.box.scale.setScalar(Math.max(0.001, 1 + 2.7 * u * u * u + 1.7 * u * u));
    const k = Math.min(1, dt * 10);
    this.armL.rotation.x += (-0.98 - this.armL.rotation.x) * k;
    this.armR.rotation.x += (-0.98 - this.armR.rotation.x) * k;
    this.armL.rotation.z += (0.16 - this.armL.rotation.z) * k;
    this.armR.rotation.z += (-0.16 - this.armR.rotation.z) * k;
    this.forearmL.rotation.x += (-0.72 - this.forearmL.rotation.x) * k;
    this.forearmR.rotation.x += (-0.72 - this.forearmR.rotation.x) * k;
    this.forearmL.rotation.z += (0.22 - this.forearmL.rotation.z) * k;
    this.forearmR.rotation.z += (-0.22 - this.forearmR.rotation.z) * k;
    this.applyLegs(this.sitK, 0, 0);
    if (this.walking) {
      l.stride += dt * 9.5;
      this.applyStride(l.stride);
    }
    const s = this.walking ? Math.sin(l.stride) : 0;
    this.body.position.set(0, base.y + Math.abs(s) * 0.045, base.z);
    this.body.rotation.z = s * 0.08;
    this.body.rotation.x += (base.lean + 0.12 - this.body.rotation.x) * Math.min(1, dt * 4);
    this.body.rotation.y += -this.body.rotation.y * k;
    this.head.rotation.set(0.16, 0, -s * 0.05);
    this.kit.syncHead(this.head);
    this.body.scale.setScalar(1);
    this.bulbScale(1);
    this.blink(dt, 0.72);
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
    // Unfold legs smoothly onto the desk stage and fold back into the chair on the hop down.
    const seatSit = this.seat && this.seat !== 'plinth' ? 1 - e : 0;
    this.sitK = seatSit;
    const seatBaseY = (this.seat === 'beanbag' ? -0.44 : -0.436) * seatSit;
    const seatBaseZ = (this.seat === 'beanbag' ? -0.02 : 0.025) * seatSit;

    // Arms and the body's sway head for these, so one move runs into the next.
    let armXL = -2.55;
    let armXR = -2.55;
    let armZL = -0.25;
    let armZR = 0.25;
    let foreXL = -0.35;
    let foreXR = -0.35;
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
      sway = s * 0.2;
      twist = s * 0.3;
      step = s;
      armXL = -1.55 - c * 1.1;
      armXR = -1.55 + c * 1.1;
      foreXL = -0.55 + c * 0.3;
      foreXR = -0.55 - c * 0.3;
      armZL = -0.35;
      armZR = 0.35;
    } else if (beat >= 4 && beat < 6) {
      // A twirl on the spot, arms out wide.
      const u = (beat - 4) / 2;
      twist = u * u * (3 - 2 * u) * Math.PI * 2;
      lift = Math.sin(u * Math.PI) * 0.18;
      armXL = -0.3;
      armXR = -0.3;
      foreXL = -0.2;
      foreXR = -0.2;
      armZL = -1.35;
      armZR = 1.35;
    } else if (beat >= 6) {
      // Two big star jumps, arms high.
      lift = Math.abs(Math.sin((beat - 6) * Math.PI)) * 0.45;
      foreXL = -0.2;
      foreXR = -0.2;
      armZL = -0.35;
      armZR = 0.35;
    }
    this.armL.position.copy(WORKER_PIVOTS.armL);
    this.armR.position.copy(WORKER_PIVOTS.armR);
    this.rotor.rotation.z -= dt * 14;
    this.papers.group.visible = false;
    this.globe.group.visible = false;
    const k = 1 - Math.exp(-dt * 18);
    this.armL.rotation.x += (armXL - this.armL.rotation.x) * k;
    this.armL.rotation.z += (armZL - this.armL.rotation.z) * k;
    this.armR.rotation.x += (armXR - this.armR.rotation.x) * k;
    this.armR.rotation.z += (armZR - this.armR.rotation.z) * k;
    this.forearmL.rotation.x += (foreXL - this.forearmL.rotation.x) * k;
    this.forearmL.rotation.z += -this.forearmL.rotation.z * k;
    this.forearmR.rotation.x += (foreXR - this.forearmR.rotation.x) * k;
    this.forearmR.rotation.z += -this.forearmR.rotation.z * k;
    this.applyLegs(seatSit, 0, 0);
    if (beat >= 0) {
      const kneeL = Math.max(0, step) * 0.65;
      const kneeR = Math.max(0, -step) * 0.65;
      this.thighL.rotation.x -= kneeL * 0.85;
      this.shinL.rotation.x += kneeL * 1.1;
      this.thighR.rotation.x -= kneeR * 0.85;
      this.shinR.rotation.x += kneeR * 1.1;
    }
    this.head.position.copy(WORKER_PIVOTS.neck);
    this.head.rotation.set(-0.08, 0, -sway * 0.45);
    this.pupilGroups[0].position.copy(PUPIL_LOCAL_L);
    this.pupilGroups[1].position.copy(PUPIL_LOCAL_R);
    this.browMeshes[0].position.set(BROW_LOCAL_L.x, BROW_LOCAL_L.y + 0.008, BROW_LOCAL_L.z);
    this.browMeshes[1].position.set(BROW_LOCAL_R.x, BROW_LOCAL_R.y + 0.008, BROW_LOCAL_R.z);
    this.browMeshes[0].rotation.z = 0.1;
    this.browMeshes[1].rotation.z = -0.1;
    this.mouthMesh.rotation.z = 0;
    this.mouthMesh.scale.set(1.38, 1.5, 1);
    this.kit.syncHead(this.head);

    this.body.position.set(sway * 0.3, seatBaseY + lift, seatBaseZ);
    this.body.rotation.set(0, twist, sway);
    // Squashed a little as it lands.
    const squash = beat >= 0 && lift < 0.03 ? 1 - (0.03 - lift) * 3 : 1;
    this.body.scale.set(2 - squash, squash, 2 - squash);
    // Its light flashes through the colors like a disco ball.
    this.bulb.mat.color.setHSL((t * 1.3) % 1, 1, 0.5);
    this.bulb.mat.emissive.copy(this.bulb.mat.color).multiplyScalar(0.5);
    this.bulbScale(1 + Math.abs(Math.sin(t * 12)) * 0.3);
    this.blink(dt, 1.05);
    if (this.bubble) this.bubble.position.y = (this.bubbleIsCard ? 1.74 : 1.95) + lift + Math.sin(t * 3) * 0.03;
    if (this.nameTag) this.nameTag.position.y = 1.55 + lift;
  }

  /** Back in its seat, standing straight, its light showing its status again. */
  private settle() {
    this.split = null;
    this.sitK = this.wantSit();
    const base = this.stepSit(0);
    this.root.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);
    this.body.position.set(0, base.y, base.z);
    this.body.rotation.set(base.lean, 0, 0);
    this.body.scale.setScalar(1);
    this.resetLimbs();
    this.applyLegs(this.sitK, 0, 0);
    this.bulbScale(1);
    this.paintBulb();
  }

  private setOpticScaleY(sy: number) {
    for (const e of this.eyeMeshes) e.scale.y = sy;
    for (const p of this.pupilGroups) p.scale.y = sy;
  }

  /** `lid` narrows the eyes (1 = wide open) between blinks. */
  private blink(dt: number, lid = 1) {
    this.blinkAt -= dt;
    const blinking = this.blinkAt < 0.12 && this.blinkAt > 0;
    if (this.blinkAt < 0) this.blinkAt = 2 + Math.random() * 4;
    this.setOpticScaleY(blinking ? 0.08 : lid);
  }

  dispose() {
    this.hush();
    waitingWorkers.delete(this);
    this.kit.dispose();
    if (this.bubble) disposeSprite(this.bubble);
    if (this.nameTag) disposeSprite(this.nameTag);
  }
}
