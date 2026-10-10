import * as THREE from 'three';
import { glyphFlat } from './glyph3d';
import { SPIN_AT } from './gun';

// Your Factory work gloves in first person (hands.ts): a palm, four fingers of three joints each and
// a thumb, posed by HandShape. No DOM or WebGL at import time, so tests can load it in Node.
//
// A glove's frame: the fingers point down -z, the back of the hand is +y, the wrist is +z, and the
// palm's middle is the origin. The right glove's thumb is on its -x side; the left glove is its mirror.

/** A finger's two big joints, in radians toward the palm: the knuckle, then the middle joint (the last one follows it). */
export type Bend = readonly [knuckle: number, middle: number];

export interface HandShape {
  /** Index, middle, ring and little finger. */
  fingers: readonly [Bend, Bend, Bend, Bend];
  /** Fingers fanned apart: 0 side by side, 1 spread wide. */
  spread: number;
  /** The thumb: -1 straight out from the side of the hand (a thumbs up), 0 resting by the index, 1 across under the palm. */
  thumbIn: number;
  /** Its two outer joints: 0 straight, 1 bent round. */
  thumbBend: number;
  /** The hand turned at the wrist: 0 palm down, 1 palm in with the thumb up, -1 palm up. */
  roll: number;
  /** The thumb's root turned just so (about y, x and z, in radians, for the right hand), in place of where thumbIn puts it. */
  thumbRoot?: readonly [number, number, number];
}

const shape = (fingers: HandShape['fingers'], spread: number, thumbIn: number, thumbBend: number, roll = 0, thumbRoot?: HandShape['thumbRoot']): HandShape =>
  Object.freeze(thumbRoot ? { fingers, spread, thumbIn, thumbBend, roll, thumbRoot } : { fingers, spread, thumbIn, thumbBend, roll });
const all = (b: Bend): HandShape['fingers'] => [b, b, b, b];

/** The shapes a hand makes. */
export const SHAPES = {
  /** Hanging loose: each finger a little more bent than the one before. */
  relaxed: shape(
    [
      [0.22, 0.32],
      [0.3, 0.4],
      [0.36, 0.48],
      [0.44, 0.56],
    ],
    0.15,
    0.05,
    0.25,
  ),
  /** Flat and spread, for a wave or a clap. */
  open: shape(all([0.04, 0.05]), 0.75, -0.1, 0.15),
  /** Flat with the fingers together, palm toward what it's pressing on. */
  flat: shape(all([0.02, 0.04]), 0.1, 0.55, 0.05),
  /** Flat with the thumb held out to the side, so it clears the revolver's cylinder the palm is on. */
  cylinder: shape(all([0.02, 0.04]), 0.1, -0.3, 0.1),
  /** Reaching to press or take something: the index finger leading, the rest loosely bent. */
  press: shape(
    [
      [0.08, 0.1],
      [0.45, 0.6],
      [0.6, 0.75],
      [0.7, 0.85],
    ],
    0.2,
    0.3,
    0.3,
  ),
  /** A tight fist, thumb over the fingers. */
  fist: shape(all([1.5, 1.75]), 0, 0.9, 0.9),
  /** A fist with the index finger out. */
  point: shape(
    [
      [0.05, 0.05],
      [1.5, 1.75],
      [1.5, 1.75],
      [1.5, 1.75],
    ],
    0.1,
    0.8,
    0.75,
  ),
  /** A fist, turned palm in, with the thumb straight up. */
  thumbsUp: shape(all([1.5, 1.75]), 0, -1, 0, 1),
  /**
   * Palm in round the gun's grip: the index finger through the guard onto the trigger, the other
   * three round the front strap onto the grip's far side, and the thumb round the backstrap.
   * Fitted to magnum.glb's grip (tests/gun-grip.test.ts checks every bone clears it, through every trick).
   */
  grip: shape(
    [
      [0, 1.3],
      [1.19, 1.07],
      [1.185, 0.97],
      [1.2, 0.6],
    ],
    0,
    1,
    0.853,
    1,
    [1.745, -1.026, 0.412],
  ),
  /**
   * Palm in, the gun spinning on the index finger stuck straight through its guard, the other
   * fingers and the thumb held out flat, clear of everything the spinning gun sweeps past.
   */
  spin: shape(
    [
      [1.571, 0],
      [0.075, 0.291],
      [0.079, 0.315],
      [0.113, 0.321],
    ],
    0,
    0.3,
    0.133,
    1,
    [0.816, 0.641, 0.481],
  ),
  /**
   * Round the droid wand's grip (WAND_GRIP_AXIS): its axis across the palm under the knuckles,
   * slanted forward on the thumb side so the shaft comes out between the thumb and the index
   * finger and the pommel out past the little finger. Each finger wraps until it meets the grip,
   * the index furthest round toward the shaft; the thumb closes under it from the other side.
   * Fitted to the grip (tests/wand.test.ts checks every bone touches it without passing through).
   */
  wand: shape(
    [
      [0.65, 1.475],
      [1.225, 1.5],
      [1.6, 1.275],
      [1.675, 0.85],
    ],
    0,
    0.5,
    0.8,
    1,
    [0, 0, -0.2],
  ),
  /** Palm in, two fingers through a mug's handle, the thumb on top of it. */
  mug: shape(
    [
      [1.05, 1.3],
      [1.15, 1.4],
      [1.45, 1.7],
      [1.5, 1.7],
    ],
    0,
    0.35,
    0.5,
    1,
  ),
  /** Palm in round a glass. */
  glass: shape(all([0.95, 0.95]), 0.15, 0.6, 0.5, 1),
  /** A card or a book's corner between the thumb and fingers. */
  pinch: shape(
    [
      [0.55, 0.55],
      [0.6, 0.6],
      [0.68, 0.7],
      [0.76, 0.8],
    ],
    0.15,
    0.7,
    0.3,
  ),
  /** Round a ladder rung. */
  rung: shape(all([1.25, 1.45]), 0, 0.85, 0.7),
  /** Round a fire pole, palm in. */
  pole: shape(all([1.25, 1.45]), 0, 0.85, 0.7, 1),
} as const satisfies Record<string, HandShape>;

/** How a shape turns the thumb's root: [about y, x, z] for the right hand (the left mirrors y and z). */
function thumbRoot(t: HandShape): [number, number, number] {
  if (t.thumbRoot) return [...t.thumbRoot];
  const ti = t.thumbIn;
  // Out from the side of the hand, forward, then down and in under the palm.
  return [0.95 - 0.7 * ti, -(0.2 + 0.6 * Math.max(0, ti)) + 0.25 * Math.min(0, ti), 0.55 + 0.7 * Math.max(0, ti)];
}

/**
 * Letting go of the grip to spin the gun on the trigger finger (gunHand, gunMount), in even steps
 * from the fist (SHAPES.grip) to the spin (SHAPES.spin): the hand, and where on the gun (gun.ts)
 * the middle of the trigger finger's middle bone is. The fingers let go of the grip before the
 * gun slides out along the trigger finger, and the middle finger swings out under the guard
 * while the gun rides up on it. Fitted like the grip, so nothing passes through the gun.
 */
const LET_GO: readonly { hand: HandShape; trigger: readonly [number, number, number] }[] = [
  { hand: SHAPES.grip, trigger: [-0.0239, -0.0047, 0.0572] },
  {
    hand: shape(
      [
        [0.368, 0.687],
        [0.856, 0.155],
        [0.868, 0.811],
        [0.934, 0.476],
      ],
      0,
      1,
      0.618,
      1,
      [1.76, -0.494, 0.458],
    ),
    trigger: [-0.0213, -0.0087, 0.0527],
  },
  {
    hand: shape(
      [
        [0.851, 0.316],
        [0.343, -0.265],
        [0.578, 0.655],
        [0.667, 0.383],
      ],
      0,
      1,
      0.415,
      1,
      [1.63, -0.026, 0.489],
    ),
    trigger: [-0.017, -0.008, 0.0525],
  },
  {
    hand: shape(
      [
        [1.239, 0.12],
        [0.137, -0.141],
        [0.32, 0.489],
        [0.389, 0.331],
      ],
      0,
      1,
      0.262,
      1,
      [1.277, 0.337, 0.499],
    ),
    trigger: [-0.0093, -0.0069, 0.0527],
  },
  { hand: SHAPES.spin, trigger: [SPIN_AT.x, SPIN_AT.y, SPIN_AT.z] },
];
/** Where the middle of the trigger finger's middle bone is on the gun (gun.ts) in the fist round its grip. */
export const GRIP_TRIGGER = new THREE.Vector3(...LET_GO[0].trigger);

/** Which step of LET_GO `onFinger` is in, and how far along it. */
function letGo(onFinger: number): [number, number] {
  const at = THREE.MathUtils.clamp(onFinger, 0, 1) * (LET_GO.length - 1);
  const i = Math.min(LET_GO.length - 2, Math.floor(at));
  return [i, at - i];
}

/** A HandShape that blend() can write into. */
export type WritableShape = HandShape & { fingers: [number, number][]; thumbRoot: [number, number, number] };
/** A shape to write into, for blend(). */
export const newShape = (): WritableShape => ({
  fingers: [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ],
  spread: 0,
  thumbIn: 0,
  thumbBend: 0,
  roll: 0,
  thumbRoot: [0, 0, 0],
});

/** The shape `k` of the way from `a` to `b`, written into `out`. */
export function blend(a: HandShape, b: HandShape, k: number, out: WritableShape = newShape()): HandShape {
  const mix = (from: number, to: number) => from + (to - from) * k;
  for (let f = 0; f < 4; f++) {
    out.fingers[f][0] = mix(a.fingers[f][0], b.fingers[f][0]);
    out.fingers[f][1] = mix(a.fingers[f][1], b.fingers[f][1]);
  }
  const ra = thumbRoot(a);
  const rb = thumbRoot(b);
  for (let j = 0; j < 3; j++) out.thumbRoot[j] = mix(ra[j], rb[j]);
  out.thumbIn = mix(a.thumbIn, b.thumbIn);
  out.thumbBend = mix(a.thumbBend, b.thumbBend);
  out.spread = mix(a.spread, b.spread);
  out.roll = mix(a.roll, b.roll);
  return out;
}

const held = newShape();

/**
 * The right hand on the gun, from the fist round its grip (0) to hanging it on the trigger finger
 * to spin (1), for gunMount to place the gun in. The shape it returns is reused by the next call.
 */
export function gunHand(onFinger: number): HandShape {
  const [i, k] = letGo(onFinger);
  return blend(LET_GO[i].hand, LET_GO[i + 1].hand, k, held);
}

/** Palm: half its width, thickness and length; how high the knuckles sit; and each finger. */
const PALM = { w: 0.044, h: 0.02, l: 0.05 };
const KNUCKLE_Y = -0.003;
const FINGERS = [
  // Across from the thumb side, where the knuckle sits, how thick, its three bones, and how it fans.
  { x: 0.031, z: -0.046, r: 0.0098, bones: [0.04, 0.024, 0.019], fan: 0.06 },
  { x: 0.0105, z: -0.05, r: 0.0102, bones: [0.044, 0.027, 0.02], fan: 0.015 },
  { x: -0.0105, z: -0.047, r: 0.0097, bones: [0.041, 0.026, 0.019], fan: -0.03 },
  { x: -0.03, z: -0.04, r: 0.0088, bones: [0.033, 0.02, 0.017], fan: -0.075 },
] as const;
const THUMB = { x: 0.03, y: -0.008, z: 0.02, r: 0.0118, bones: [0.03, 0.024, 0.02] } as const;
/** How far round the last joint goes for the middle one: they move together. */
const LAST = 0.65;

/**
 * Where the right glove, closed round the magnum's grip (SHAPES.grip), holds the gun's origin: the
 * palm flat on the grip's right panel, the knuckles by its front strap and the index finger level
 * with the trigger.
 */
export const GRIP_AT = new THREE.Vector3(-0.037, -0.0385, -0.032);

/**
 * The droid wand's grip in the right glove's own frame (palm down, before its roll), closed round
 * by SHAPES.wand: a point on its axis under the middle of the palm, and the way the shaft runs
 * out of the fist (toward the thumb, slanted 32° forward). The left glove mirrors x.
 */
export const WAND_GRIP_AT = new THREE.Vector3(0, -0.031, -0.03);
export const WAND_GRIP_AXIS = new THREE.Vector3(-Math.cos((32 * Math.PI) / 180), 0, -Math.sin((32 * Math.PI) / 180));
const spun = new THREE.Vector3();
const onGun = new THREE.Vector3();
const between = new THREE.Vector3();

/** The palm's roundness: across and along it, and through it. */
const P = 3.2;
const Q = 2.6;
/** The heel of the hand a touch thicker than the knuckles. */
const heel = (w: number) => 1 + 0.18 * Math.max(0, w);

/** The glove's back, rounded like a mitt rather than an egg: a superellipsoid of the palm's size. */
function palmGeometry(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(1, 24, 16);
  const pos = geo.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const f = (Math.abs(v.x) ** P + Math.abs(v.z) ** P) ** (Q / P) + Math.abs(v.y) ** Q;
    v.multiplyScalar(f ** (-1 / Q));
    pos.setXYZ(i, v.x * PALM.w, v.y * PALM.h * heel(v.z), v.z * PALM.l);
  }
  geo.computeVertexNormals();
  return geo;
}

/** How high the back of the hand is at (x, z). */
function backY(x: number, z: number): number {
  const u = Math.abs(x / PALM.w);
  const w = z / PALM.l;
  const f = Math.min(1, (u ** P + Math.abs(w) ** P) ** (Q / P));
  return (1 - f) ** (1 / Q) * PALM.h * heel(w);
}

/** The pinwheel, `size` across, laid on the back of the hand at `z` so it follows its curve. */
function badgeGeometry(size: number, z: number): THREE.BufferGeometry {
  const geo = glyphFlat(size, 4)
    .rotateX(-Math.PI / 2)
    .translate(0, 0, z);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) pos.setY(i, backY(pos.getX(i), pos.getZ(i)) + 0.0009);
  geo.computeVertexNormals();
  return geo;
}

/** A bone `length` long from its joint out along -z, rounded at both ends. */
function bone(r: number, length: number): THREE.BufferGeometry {
  return new THREE.CapsuleGeometry(r, length, 4, 10).rotateX(Math.PI / 2).translate(0, 0, -length / 2);
}

interface Finger {
  joints: [THREE.Group, THREE.Group, THREE.Group];
  fan: number;
}

export interface GloveMaterials {
  glove: THREE.Material;
  steel: THREE.Material;
  pinwheel: THREE.Material;
}

/** One Factory work glove, posed by shape() and moved there by update(). */
export class Glove {
  readonly group = new THREE.Group();
  /** The middle of the index finger's middle bone: what the gun spins on. */
  readonly trigger = new THREE.Object3D();
  private fingers: Finger[] = [];
  private thumb: [THREE.Group, THREE.Group, THREE.Group];
  private target: HandShape = SHAPES.relaxed;
  private now: { fingers: [number, number][]; spread: number; thumb: [number, number, number]; thumbBend: number; roll: number };

  constructor(
    readonly side: 1 | -1,
    m: GloveMaterials,
  ) {
    const s = side;
    const palm = new THREE.Mesh(palmGeometry(), m.glove);
    this.group.add(palm);
    // A graphite guard over the knuckles, and the pinwheel on the back of the hand, lying on it.
    const guard = new THREE.Mesh(new THREE.CapsuleGeometry(0.0085, 0.056, 3, 8).rotateZ(Math.PI / 2), m.steel);
    guard.position.set(0, backY(0, -0.034) - 0.002, -0.034);
    guard.rotation.x = -0.25;
    this.group.add(guard);
    const badge = new THREE.Mesh(badgeGeometry(0.042, 0.008), m.pinwheel);
    badge.name = 'glove-pinwheel';
    this.group.add(badge);

    // A digit: three joints in a chain from its root, each holding the bone out to the next.
    const digit = (name: string, root: THREE.Vector3, bones: readonly number[], r: number, taper: number) => {
      const joints = [new THREE.Group(), new THREE.Group(), new THREE.Group()] as [THREE.Group, THREE.Group, THREE.Group];
      joints[0].position.copy(root);
      joints[0].rotation.order = 'YXZ';
      let parent: THREE.Object3D = this.group;
      bones.forEach((len, i) => {
        const j = joints[i];
        if (i > 0) j.position.z = -bones[i - 1];
        const b = new THREE.Mesh(bone(r * (1 - taper * i), len), m.glove);
        b.name = `${name}-${i}`;
        j.add(b);
        parent.add(j);
        parent = j;
      });
      return joints;
    };
    FINGERS.forEach((f, i) => {
      this.fingers.push({ joints: digit(`glove-finger-${i}`, new THREE.Vector3(-s * f.x, KNUCKLE_Y, f.z), f.bones, f.r, 0.06), fan: f.fan });
    });
    this.fingers[0].joints[1].add(this.trigger);
    this.trigger.position.z = -FINGERS[0].bones[1] / 2;
    this.thumb = digit('glove-thumb', new THREE.Vector3(-s * THUMB.x, THUMB.y, THUMB.z), THUMB.bones, THUMB.r, 0.07);

    const t = this.target;
    this.now = { fingers: t.fingers.map((b) => [b[0], b[1]]), spread: t.spread, thumb: thumbRoot(t), thumbBend: t.thumbBend, roll: t.roll };
    this.apply();
  }

  /** The shape to move to (at once with `snap`). */
  shape(to: HandShape, snap = false) {
    this.target = to;
    if (snap) this.update(Infinity);
  }

  /** Moves the hand toward its shape: quick enough to read as one motion, slow enough not to pop. */
  update(dt: number) {
    const k = 1 - Math.exp(-dt * 26);
    const n = this.now;
    const t = this.target;
    for (let i = 0; i < 4; i++) {
      n.fingers[i][0] += (t.fingers[i][0] - n.fingers[i][0]) * k;
      n.fingers[i][1] += (t.fingers[i][1] - n.fingers[i][1]) * k;
    }
    n.spread += (t.spread - n.spread) * k;
    const root = thumbRoot(t);
    for (let i = 0; i < 3; i++) n.thumb[i] += (root[i] - n.thumb[i]) * k;
    n.thumbBend += (t.thumbBend - n.thumbBend) * k;
    n.roll += (t.roll - n.roll) * k;
    this.apply();
  }

  /**
   * Where a magnum aimed down the arm's -z (turned half round y) puts its origin, in the arm's frame,
   * to sit in this fist round its grip (`onFinger` 0) or hang by its guard on the trigger finger (1),
   * with the hand shaped as gunHand(onFinger) has it.
   * The arm's world matrix must be current.
   */
  gunMount(onFinger: number, out: THREE.Vector3): THREE.Vector3 {
    const arm = this.group.parent!;
    this.group.updateMatrixWorld(true);
    out.copy(GRIP_AT).applyMatrix4(this.group.matrix);
    if (onFinger <= 0) return out;
    // Hung on the trigger finger: the point of the gun on it moves as LET_GO has it.
    arm.worldToLocal(this.trigger.getWorldPosition(spun));
    const [i, k] = letGo(onFinger);
    onGun.fromArray(LET_GO[i].trigger).lerp(between.fromArray(LET_GO[i + 1].trigger), k);
    // The gun turned half round y puts its point (x, y, z) at (-x, y, -z) from its origin.
    spun.x += onGun.x;
    spun.y -= onGun.y;
    spun.z += onGun.z;
    // Over the first step the fist hands the gun to the finger: the two agree in SHAPES.grip.
    return out.lerp(spun, THREE.MathUtils.smoothstep(onFinger, 0, 1 / (LET_GO.length - 1)));
  }

  private apply() {
    const s = this.side;
    const n = this.now;
    // Palm in turns the right hand's back out to the right, the left's out to the left.
    this.group.rotation.z = -s * n.roll * (Math.PI / 2);
    this.fingers.forEach((f, i) => {
      const [knuckle, middle] = n.fingers[i];
      const [a, b, c] = f.joints;
      // Positive x rotation would bend a -z finger up toward the back of the hand.
      a.rotation.x = -knuckle;
      a.rotation.y = s * f.fan * (0.5 + 2.2 * n.spread);
      b.rotation.x = -middle;
      c.rotation.x = -middle * LAST;
    });
    const [root, mid, tip] = this.thumb;
    root.rotation.set(n.thumb[1], s * n.thumb[0], s * n.thumb[2]);
    mid.rotation.x = -n.thumbBend * 0.85;
    tip.rotation.x = -n.thumbBend * 1.05;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }
}
