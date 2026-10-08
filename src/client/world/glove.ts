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
}

const shape = (fingers: HandShape['fingers'], spread: number, thumbIn: number, thumbBend: number, roll = 0): HandShape => Object.freeze({ fingers, spread, thumbIn, thumbBend, roll });
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
  /** Palm in round the gun's grip: the index finger crooked on the trigger, the thumb along the far side of the frame. */
  grip: shape(
    [
      [0.32, 1.25],
      [1.42, 1.55],
      [1.5, 1.6],
      [1.6, 1.6],
    ],
    0,
    0.75,
    0.35,
    1,
  ),
  /** Palm in, the gun spinning on a hooked index finger through its guard; the rest a fist out of its way. */
  spin: shape(
    [
      [0.15, 0.55],
      [1.5, 1.75],
      [1.5, 1.75],
      [1.5, 1.75],
    ],
    0,
    0.85,
    0.8,
    1,
  ),
  /** Open and waiting for the gun to come down out of the air. */
  catch: shape(all([0.45, 0.5]), 0.35, 0.3, 0.3, 1),
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
  /** A cigarette between the first two fingers, the other two tucked in. */
  cigarette: shape(
    [
      [0.18, 0.22],
      [0.22, 0.26],
      [1.1, 1.5],
      [1.2, 1.5],
    ],
    0,
    0.25,
    0.25,
  ),
} as const satisfies Record<string, HandShape>;

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
 * Where the right glove, closed round the magnum's grip (SHAPES.grip), holds the gun's origin: up
 * in the fist under the web of the thumb, with the palm against the grip's right side.
 */
export const GRIP_AT = new THREE.Vector3(-0.037, -0.02, -0.016);
const spun = new THREE.Vector3();

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
  /** Between the first two fingers at their middle joints, where a cigarette is held. */
  readonly twoFingers = new THREE.Object3D();
  private fingers: Finger[] = [];
  private thumb: [THREE.Group, THREE.Group, THREE.Group];
  private target: HandShape = SHAPES.relaxed;
  private now: { fingers: [number, number][]; spread: number; thumbIn: number; thumbBend: number; roll: number };

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
    this.fingers[0].joints[1].add(this.twoFingers);
    this.twoFingers.position.set(s * (FINGERS[0].x - FINGERS[1].x) * 0.5, 0, -0.006);
    this.thumb = digit('glove-thumb', new THREE.Vector3(-s * THUMB.x, THUMB.y, THUMB.z), THUMB.bones, THUMB.r, 0.07);

    const t = this.target;
    this.now = { fingers: t.fingers.map((b) => [b[0], b[1]]), spread: t.spread, thumbIn: t.thumbIn, thumbBend: t.thumbBend, roll: t.roll };
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
    n.thumbIn += (t.thumbIn - n.thumbIn) * k;
    n.thumbBend += (t.thumbBend - n.thumbBend) * k;
    n.roll += (t.roll - n.roll) * k;
    this.apply();
  }

  /**
   * Where a magnum aimed down the arm's -z (turned half round y) puts its origin, in the arm's frame,
   * to sit in this fist round its grip (`out` 0) or hang by its guard on the trigger finger (1).
   * The arm's world matrix must be current.
   */
  gunMount(onFinger: number, out: THREE.Vector3): THREE.Vector3 {
    const arm = this.group.parent!;
    this.group.updateMatrixWorld(true);
    out.copy(GRIP_AT).applyMatrix4(this.group.matrix);
    if (onFinger <= 0) return out;
    // The gun turned half round y puts its spin point at (-x, y, -z) from its origin.
    arm.worldToLocal(this.trigger.getWorldPosition(spun));
    spun.x += SPIN_AT.x;
    spun.y -= SPIN_AT.y;
    spun.z += SPIN_AT.z;
    return out.lerp(spun, THREE.MathUtils.smoothstep(onFinger, 0, 1));
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
    const ti = n.thumbIn;
    // Out from the side of the hand, forward, then down and in under the palm.
    root.rotation.y = s * (0.95 - 0.7 * ti);
    root.rotation.x = -(0.2 + 0.6 * Math.max(0, ti)) + 0.25 * Math.min(0, ti);
    root.rotation.z = s * (0.55 + 0.7 * Math.max(0, ti));
    mid.rotation.x = -n.thumbBend * 0.85;
    tip.rotation.x = -n.thumbBend * 1.05;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }
}
