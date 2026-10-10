import * as THREE from 'three';
import { EMOTE_BY_ID, type Emote, type EmoteId } from '../../shared/emotes';
import type { CarriedIssue } from '../../shared/protocol';
import type { Drink } from '../../shared/rooftop';
import { OpenBook } from './book';
import { HeldCard } from './card';
import { REACH_TIME, SMOKE_CYCLE, cigarette, coffeeMug, dragCurve, drinkGlass, emoteEnvelope, putDownGlass, reachCurve } from './character';
import { Muzzle, SPIN_AT, disposeGun, magnum, setCylinder } from './gun';
import type { GunPose } from './gun-motion';
import { Glove, gunHand, type HandShape, SHAPES, WAND_GRIP_AT, WAND_GRIP_AXIS } from './glove';
import { mesh, toonUnique } from './toon';
import { Wand, Ward } from './wand';
import type { WandPose } from './wand-motion';

export interface HandsInput {
  yaw: number;
  pitch: number;
  walkPhase: number;
  walking: boolean;
  airborne: boolean;
  /** 0 (steady) to 1: one coffee too many. */
  jitter: number;
  /** Holding on to the ladder (hand over hand, in time with walkPhase) or a fire pole (both hands on it, off to the left). */
  grip?: 'ladder' | 'pole' | null;
}

/** Factory work gloves: black, with graphite steel at the cuff and knuckles. */
const GLOVE = '#1a1a1a';
const CUFF = '#3a3a3a';

/**
 * How far a tossed gun slides along its own left off the end of the trigger finger through its
 * guard, in meters of the pose's `lift`, before it goes up.
 */
const TOSS_SLIDE = 0.06;

/** Lifting the mug for a sip and lowering it again, in seconds. */
const SIP_TIME = 1.1;

const lift = new THREE.Vector3();
const handTurn = new THREE.Quaternion();
const away = new THREE.Vector3();
const along = new THREE.Vector3();
/** The glove's +z (its wrist) laid back along the gun, toward its hammer. */
const back = new THREE.Vector3(0, 0, -1);
const scale = new THREE.Vector3();
const palmAt = new THREE.Matrix4();
/** From the cylinder's axis to the middle of the left glove pressed flat on it: its radius and half the palm's thickness. */
const CYLINDER_PALM = 0.024 + 0.0235;

/**
 * The wand at the ready, in camera space, raised the way a wizard holds one: the fist low on the
 * right with the thumb on top and the knuckles in a line up and down, the wand standing up out of
 * it and leaning forward (the grip's slant in SHAPES.wand) and a little in toward the middle, and
 * the forearm running back toward you. `grip` is where the grip sits, `dir` the way the wand
 * points, `palm` the way the palm faces (in toward the middle: it keeps the knuckles up and down
 * whichever way the wand points), and `spin` how far the wand is turned on its own axis in the
 * fist (so its progress bar faces you).
 */
export const WAND_HOLD = {
  grip: new THREE.Vector3(0.2, -0.2, -0.5),
  dir: new THREE.Vector3(-0.14, 0.84, -0.52).normalize(),
  palm: new THREE.Vector3(-1, 0, -0.12).normalize(),
  spin: 0.35 + Math.PI,
};
/**
 * How much of the wand's pitch the wrist takes, bending the fist toward the little finger (or the
 * thumb) so the forearm hardly moves, and how far a wrist bends each way, in radians.
 */
const WRIST = 0.9;
const WRIST_FORWARD = 0.7;
const WRIST_BACK = 0.35;
/** The wrist in the arm's frame: where the glove bends from. */
const WRIST_AT = new THREE.Vector3(0, 0, 0.05);
const wristTurned = new THREE.Vector3();
/** How Lumos's light comes up and goes out, per second. */
const LUMOS_RATE = 5;
const aimDir = new THREE.Vector3();
const palmDir = new THREE.Vector3();
const palmInArm = new THREE.Vector3();
const wandAxis = new THREE.Vector3();
const gripInArm = new THREE.Vector3();
const basisA = new THREE.Matrix4();
const basisB = new THREE.Matrix4();
const turnQ = new THREE.Quaternion();
const sideAxis = new THREE.Vector3();
const upAxis = new THREE.Vector3(0, 1, 0);
const camX = new THREE.Vector3(1, 0, 0);

interface Arm {
  group: THREE.Group;
  base: THREE.Vector3;
  baseRot: THREE.Euler;
  side: 1 | -1;
  /** The glove: palm, fingers and thumb, posed each frame. */
  glove: Glove;
}

/**
 * Your own hands in first person. They live in their own small scene, drawn over the world with
 * a cleared depth buffer, so they never poke through desks or walls. Camera space: -z is forward.
 */
export class Hands {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.01, 5);
  private sleeve: THREE.MeshToonMaterial;
  private skin: THREE.MeshToonMaterial;
  /** Your Factory work gloves and their steel cuffs. */
  private glove: THREE.MeshToonMaterial;
  private cuffMat: THREE.MeshToonMaterial;
  private pinwheel: THREE.MeshToonMaterial;
  private right: Arm;
  private left: Arm;
  private reachT = -1;
  private mug: THREE.Group;
  private wantsMug = false;
  /** A drink from the rooftop bar, held where the mug goes (and in its place). */
  private glass: { id: string; group: THREE.Group } | null = null;
  /** An issue card off the board, held low in front of you in both hands. */
  private holder = new THREE.Group();
  private card: HeldCard;
  /** A book off the bookshelf, open in both hands while you read (see read). */
  private bookHolder = new THREE.Group();
  private book: OpenBook | null = null;
  /** 0 → 1 as the card (or the book) comes up into view and the hands close in on it. */
  private carryK = 0;
  /** Seconds into a sip (negative while it waits for the reach to finish), or null. */
  private sipT: number | null = null;
  private sway = new THREE.Vector2();
  private last: { yaw: number; pitch: number } | null = null;
  private air = 0;
  private walk = 0;
  private ladderK = 0;
  private poleK = 0;
  private cig: THREE.Group;
  private ember: THREE.MeshToonMaterial;
  /** Each light, and how bright it is where it's brightest. */
  private lights: [THREE.Light, number][] = [];
  private lightLevel = 1;
  /** Seconds into a smoke break, or -1. Runs in step with your character's (see Person.setSmoking). */
  private smokeT = -1;
  /** The emote your character is doing, and how far into it (see Person.emote). */
  private emoting: { emote: Emote; t: number } | null = null;
  /** Your shirt and skin. */
  private shirt: string;
  private skinTone: string;
  /**
   * A .44 Magnum in the right fist (see setGunPose): where the fist holds it, the pivot it spins
   * round on the trigger finger, the prop and its muzzle flash, the pose it's in, and how far it has
   * gone over from the fist onto the trigger finger (the pose's `finger`, eased).
   */
  private gun: { mount: THREE.Group; pivot: THREE.Group; prop: THREE.Group; muzzle: Muzzle; pose: Readonly<GunPose>; onFinger: number } | null = null;
  /**
   * The droid wand in the right fist (see setWandPose): its mount on the glove round the grip, the
   * pivot it twirls on in the fingers, the wand, and the pose it's in.
   */
  private wand: { mount: THREE.Group; twirl: THREE.Group; item: Wand; pose: Readonly<WandPose> } | null = null;
  /** Lumos: wanted on, and how far it has come up (0 … 1). */
  private lumosOn = false;
  private lumosK = 0;
  /** Protego's wards in front of your eyes, until each has faded. */
  private wards: Ward[] = [];

  constructor(shirt: string, skin: string) {
    this.shirt = shirt;
    this.skinTone = skin;
    this.sleeve = toonUnique(shirt);
    this.skin = toonUnique(skin);
    this.glove = toonUnique(GLOVE);
    this.cuffMat = toonUnique(CUFF);
    this.pinwheel = toonUnique('#ee6018');
    this.pinwheel.emissive.set('#5a2408');
    // A cartoon outline would swallow its thin blades.
    this.pinwheel.userData.outlineParameters = { visible: false };
    const sun = new THREE.DirectionalLight('#fff1d6', 2);
    sun.position.set(-0.6, 1.4, 0.9);
    for (const l of [new THREE.HemisphereLight('#fff5e6', '#c9a27a', 1.5), new THREE.AmbientLight('#ffffff', 0.5), sun]) {
      this.scene.add(l);
      this.lights.push([l, l.intensity]);
    }
    this.right = this.arm(1);
    this.left = this.arm(-1);
    // In the left hand, handle in the palm, standing upright however the arm is turned.
    this.mug = coffeeMug();
    this.mug.position.set(0.09, -0.035, -0.03);
    this.mug.quaternion.setFromEuler(this.left.baseRot).invert();
    this.mug.visible = false;
    this.left.group.add(this.mug);
    // Between the first two fingers of the right hand, filter on the palm side, lit end up past the knuckles.
    const cig = cigarette();
    this.cig = cig.group;
    this.ember = cig.ember;
    this.cig.scale.setScalar(0.45);
    this.cig.rotation.set(-1.1, 0, 0);
    this.cig.visible = false;
    this.right.glove.twoFingers.add(this.cig);
    // Tipped back, so you look down onto its front.
    this.holder.rotation.x = -0.35;
    this.scene.add(this.holder);
    this.card = new HeldCard(this.holder, 0.24);
    // Tipped further back than a card, so you look down into its pages.
    this.bookHolder.rotation.x = -0.8;
    this.bookHolder.scale.setScalar(0.7);
    this.scene.add(this.bookHolder);
  }

  /** Puts a lit cigarette in your right hand, or takes it away. */
  setSmoking(on: boolean) {
    if (on === this.smokeT >= 0) return;
    this.smokeT = on ? 0 : -1;
    this.cig.visible = on;
  }

  /** Where the cigarette's lit end is, in camera space (the hands' camera sits where the real one is). */
  cigTip(out: THREE.Vector3): THREE.Vector3 {
    this.right.group.updateMatrixWorld(true);
    return this.cig.localToWorld(out.set(0, 0, 0.09));
  }

  /** Where the wand's tip is, in camera space, or null with the wand away. */
  wandTip(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.wand) return null;
    this.right.group.updateMatrixWorld(true);
    return this.wand.item.tip.getWorldPosition(out);
  }

  /** Which way the wand points, in camera space, or null with it away. */
  wandDir(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.wand) return null;
    this.right.group.updateMatrixWorld(true);
    return out.set(0, 0, 1).transformDirection(this.wand.item.group.matrixWorld);
  }

  /** Lumos: the emitter lit bright enough to see by, or out. */
  setLumos(on: boolean) {
    this.lumosOn = on;
  }

  /** How far Lumos has come up, 0 (out) … 1 (lit). */
  get lumos(): number {
    return this.lumosK;
  }

  /** Protego: a ward flares up in front of your eyes. */
  ward() {
    const w = new Ward();
    this.scene.add(w.group);
    this.wards.push(w);
  }

  /** Where the gun's muzzle is, in camera space, or null with the gun holstered. */
  muzzleTip(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.gun) return null;
    this.right.group.updateMatrixWorld(true);
    return this.gun.muzzle.group.localToWorld(out.set(0, 0, 0.12));
  }

  setColor(shirt: string) {
    this.shirt = shirt;
    this.paint();
  }

  setSkin(skin: string) {
    this.skinTone = skin;
    this.paint();
  }

  private paint() {
    this.sleeve.color.set(this.shirt);
    this.skin.color.set(this.skinTone);
    this.glove.color.set(GLOVE);
    this.cuffMat.color.set(CUFF);
  }

  /** How lit it is where you stand, 0–1 (see Sky.lightAt): your hands go dark out on a night street. */
  setLight(level: number) {
    const k = 0.25 + 0.75 * level;
    if (Math.abs(k - this.lightLevel) < 0.01) return;
    this.lightLevel = k;
    for (const [l, full] of this.lights) l.intensity = full * k;
  }

  setAspect(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Reach out with the right hand. */
  reach() {
    this.reachT = 0;
  }

  /** A mug of coffee in the left hand, or not. */
  holdMug(on: boolean) {
    this.wantsMug = on;
    const full = this.card.held || !!this.book;
    this.mug.visible = on && !full && !this.glass;
    if (this.glass) this.glass.group.visible = !full;
  }

  /** A drink from the rooftop bar in the left hand, or none (null). */
  holdDrink(d: Drink | null) {
    if ((d?.id ?? null) === (this.glass?.id ?? null)) return;
    if (this.glass) {
      putDownGlass(this.glass.group);
      this.glass = null;
    }
    if (d) {
      const group = drinkGlass(d);
      group.position.set(0.09, -0.035, -0.03);
      group.quaternion.setFromEuler(this.left.baseRot).invert();
      this.left.group.add(group);
      this.glass = { id: d.id, group };
    }
    this.holdMug(this.wantsMug);
  }

  /** An issue card in both hands, or none (null). The mug waits while the hands are full. */
  carry(card: CarriedIssue | null) {
    const was = this.card.held;
    this.card.set(card);
    if (!was) this.carryK = 0;
    this.holdMug(this.wantsMug);
  }

  /** An open book in both hands, its pages turning, or none. A card you carry waits. */
  read(on: boolean) {
    if (on === !!this.book) return;
    if (on) {
      this.book = new OpenBook();
      this.bookHolder.add(this.book.group);
      this.carryK = 0;
    } else if (this.book) {
      this.bookHolder.remove(this.book.group);
      this.book.dispose();
      this.book = null;
    }
    this.holder.visible = !on;
    this.holdMug(this.wantsMug);
  }

  /** Turns a page of the book you're reading now. */
  turnPage() {
    this.book?.turn();
  }

  /** Your hands' half of an emote: a wave, a thumbs up, a clap… in front of your eyes. */
  emote(id: EmoteId) {
    const emote = EMOTE_BY_ID.get(id);
    this.emoting = emote ? { emote, t: 0 } : null;
  }

  /** Raise the mug for a sip, once the right hand is back from the coffee machine. */
  sip() {
    this.sipT = -REACH_TIME * 0.6;
  }

  /**
   * The .44 Magnum in the right fist, posed (see GunMotion: drawn, holstered, mid-trick), or away
   * in its holster (null). The left hand keeps what it holds.
   */
  setGunPose(pose: Readonly<GunPose> | null) {
    if (this.gun && !pose) {
      disposeGun(this.gun.prop);
      this.gun.mount.removeFromParent();
      this.gun = null;
    }
    if (!pose) return;
    if (this.gun) {
      this.gun.pose = pose;
      return;
    }
    const mount = new THREE.Group();
    // The muzzle down the arm's -z. The glove turns palm in round the grip at once: the gun comes up
    // out of the holster below the view, and the fist has to fit it from the first frame.
    mount.rotation.y = Math.PI;
    this.right.glove.shape(gunHand(pose.finger), true);
    const pivot = new THREE.Group();
    pivot.position.copy(SPIN_AT);
    const prop = magnum();
    const muzzle = new Muzzle();
    prop.position.copy(SPIN_AT).negate();
    prop.add(muzzle.group);
    pivot.add(prop);
    mount.add(pivot);
    this.right.group.add(mount);
    this.gun = { mount, pivot, prop, muzzle, pose, onFinger: pose.finger };
  }

  /**
   * The droid wand in the right fist, posed (see WandMotion: drawn, put away, casting, mid-spell),
   * or away (null). It sits on the glove itself, round the grip SHAPES.wand closes on, so it turns
   * with the hand. Putting it away puts Lumos out.
   */
  setWandPose(pose: Readonly<WandPose> | null) {
    if (this.wand && !pose) {
      this.wand.item.dispose();
      this.wand.mount.removeFromParent();
      this.wand = null;
      this.right.glove.group.rotation.y = 0;
      this.right.glove.group.position.set(0, 0, 0);
      this.lumosOn = false;
      this.lumosK = 0;
    }
    if (!pose) return;
    if (this.wand) {
      this.wand.pose = pose;
      return;
    }
    const glove = this.right.glove;
    glove.shape(SHAPES.wand, true);
    // The wand's +Z down the grip's axis and out past the thumb, its +Y (the progress bar) toward
    // the back of the hand, then turned on its axis so the bar faces you.
    const mount = new THREE.Group();
    mount.name = 'wand-mount';
    mount.position.copy(WAND_GRIP_AT);
    const z = WAND_GRIP_AXIS.clone().normalize();
    const y = new THREE.Vector3(0, 1, 0);
    const x = new THREE.Vector3().crossVectors(y, z).normalize();
    mount.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    // Twirled end over end in the fingers: round the palm's normal, through the grip.
    const twirl = new THREE.Group();
    const item = new Wand();
    item.group.rotation.z = WAND_HOLD.spin;
    twirl.add(item.group);
    mount.add(twirl);
    glove.group.add(mount);
    this.wand = { mount, twirl, item, pose };
  }

  /** Fires it: a flash at the muzzle (the recoil is the pose's kick). */
  fireGun() {
    this.gun?.muzzle.fire();
  }

  private arm(side: 1 | -1): Arm {
    const group = new THREE.Group();
    // Sleeve runs from the wrist back past the camera, so its far end is always off screen.
    group.add(mesh(new THREE.CapsuleGeometry(0.058, 0.42, 6, 14).rotateX(Math.PI / 2), this.sleeve, 0, 0, 0.34, false));
    group.add(mesh(new THREE.CylinderGeometry(0.06, 0.056, 0.05, 18).rotateX(Math.PI / 2), this.cuffMat, 0, 0, 0.078, false));
    const glove = new Glove(side, { glove: this.glove, steel: this.cuffMat, pinwheel: this.pinwheel });
    group.add(glove.group);
    const base = new THREE.Vector3(side * 0.25, -0.185, -0.44);
    const baseRot = new THREE.Euler(0.2, side * 0.22, side * -0.25);
    group.position.copy(base);
    group.rotation.copy(baseRot);
    this.scene.add(group);
    return { group, base, baseRot, side, glove };
  }

  update(dt: number, t: number, s: HandsInput) {
    // Hands lag a touch behind quick turns of the head.
    if (this.last && dt > 0) {
      const dyaw = Math.atan2(Math.sin(s.yaw - this.last.yaw), Math.cos(s.yaw - this.last.yaw));
      const dpitch = s.pitch - this.last.pitch;
      const tx = THREE.MathUtils.clamp((dyaw / dt) * 0.012, -0.05, 0.05);
      const ty = THREE.MathUtils.clamp((-dpitch / dt) * 0.01, -0.04, 0.04);
      this.sway.x += (tx - this.sway.x) * Math.min(1, dt * 10);
      this.sway.y += (ty - this.sway.y) * Math.min(1, dt * 10);
    }
    this.last = { yaw: s.yaw, pitch: s.pitch };
    this.air += ((s.airborne && !s.grip ? 1 : 0) - this.air) * Math.min(1, dt * 8);
    this.ladderK += ((s.grip === 'ladder' ? 1 : 0) - this.ladderK) * Math.min(1, dt * 10);
    this.poleK += ((s.grip === 'pole' ? 1 : 0) - this.poleK) * Math.min(1, dt * 10);
    this.walk += ((s.walking ? 1 : 0) - this.walk) * Math.min(1, dt * 8);

    const breathe = Math.sin(t * 1.7) * 0.004;
    const step = Math.sin(s.walkPhase) * this.walk;
    const bounce = Math.sin(s.walkPhase * 2) * 0.006 * this.walk;
    const k = this.reachT >= 0 ? reachCurve(this.reachT / REACH_TIME) : 0;
    if (this.reachT >= 0) {
      this.reachT += dt;
      if (this.reachT >= REACH_TIME) this.reachT = -1;
    }
    let sip = 0;
    if (this.sipT !== null) {
      this.sipT += dt;
      sip = reachCurve(this.sipT / SIP_TIME);
      if (this.sipT >= SIP_TIME) this.sipT = null;
    }
    const shake = s.jitter * 0.004;
    this.carryK += ((this.card.held || this.book ? 1 : 0) - this.carryK) * Math.min(1, dt * 7);
    const carry = this.carryK;

    for (const [arm, side] of [
      [this.right, 1],
      [this.left, -1],
    ] as const) {
      const p = arm.group.position.copy(arm.base);
      p.x += this.sway.x + side * this.air * 0.03 + step * 0.008;
      p.y += this.sway.y + breathe + bounce + this.air * 0.05;
      // Arms swing opposite each other while walking.
      p.z += side * step * 0.025;
      p.x += shake * Math.sin(t * 97 + side);
      p.y += shake * Math.sin(t * 131 + side * 2);
      arm.group.rotation.copy(arm.baseRot);
      arm.group.rotation.x += this.air * 0.2;
      // Holding the card: both hands in on its bottom corners, palms turned toward it, so the title shows.
      p.x -= side * 0.08 * carry;
      p.z -= 0.03 * carry;
      arm.group.rotation.z += side * 0.35 * carry;
    }
    // Up the ladder, hand over hand; round a pole, both hands on it, one over the other.
    const climb = Math.sin(s.walkPhase);
    for (const [arm, side] of [
      [this.right, 1],
      [this.left, -1],
    ] as const) {
      const g = arm.group;
      const lk = this.ladderK;
      g.position.x += (side * 0.19 - g.position.x) * lk;
      g.position.y += (0.06 + side * climb * 0.09 - g.position.y) * lk;
      g.position.z += (-0.46 - g.position.z) * lk;
      g.rotation.x += -0.55 * lk;
      // The pole's a little to your left: the left hand on it, the right reaching across to it from
      // below, its sleeve angled away so it doesn't cross your view.
      const pk = this.poleK;
      g.position.x += ((side > 0 ? 0.03 : -0.18) - g.position.x) * pk;
      g.position.y += ((side > 0 ? 0.02 : -0.04) - g.position.y) * pk;
      g.position.z += ((side > 0 ? -0.56 : -0.47) - g.position.z) * pk;
      g.rotation.x += (side > 0 ? 0.45 : 0.25) * pk;
      g.rotation.y += (side > 0 ? 0.55 : 0) * pk;
    }
    // The card rides along with the hands, coming up from below as you take it; so does the book.
    this.holder.position.set(this.sway.x + step * 0.008, this.sway.y + breathe + bounce + this.air * 0.05 - 0.115 - 0.3 * (1 - carry), -0.5);
    if (this.book) {
      this.bookHolder.position.set(this.holder.position.x, this.holder.position.y, -0.48);
      this.book.update(dt);
    }
    // The reach: the right hand jabs out toward the crosshair, the left pulls back a little.
    const r = this.right.group;
    r.position.x -= 0.16 * k;
    r.position.y += 0.09 * k;
    r.position.z -= 0.2 * k;
    r.rotation.x += 0.3 * k;
    r.rotation.y += 0.15 * k;
    r.rotation.z += 0.22 * k;
    this.left.group.position.y -= 0.025 * k;
    this.left.group.position.z += 0.03 * k;
    // The sip: the mug comes up to your mouth and tips toward you.
    const l = this.left.group;
    l.position.x += 0.17 * sip;
    l.position.y += 0.13 * sip;
    l.position.z += 0.14 * sip;
    l.rotation.x += 0.7 * sip;
    this.right.glove.shape(this.rightShape(k));
    this.left.glove.shape(this.leftShape());
    this.right.glove.update(dt);
    this.left.glove.update(dt);
    if (this.gun) this.gunStep(dt, r, l);
    if (this.wand) this.wandStep(dt, r, l);
    for (let i = this.wards.length - 1; i >= 0; i--) {
      if (this.wards[i].update(dt)) continue;
      this.wards[i].dispose();
      this.wards.splice(i, 1);
    }
    // A drag: the cigarette hand comes up to your mouth, just under the camera, and back down.
    if (this.smokeT >= 0) {
      this.smokeT += dt;
      // Not mid-aim: the hand holding the gun stays on the crosshair.
      const d = s.walking || s.airborne || this.gun || this.wand ? 0 : dragCurve(this.smokeT % SMOKE_CYCLE);
      r.position.x -= 0.2 * d;
      r.position.y += 0.02 * d;
      r.position.z += 0.3 * d;
      r.rotation.x += 0.5 * d;
      this.ember.emissiveIntensity += ((d > 0.9 ? 1.4 : 0.3) - this.ember.emissiveIntensity) * Math.min(1, dt * 6);
    }
    if (this.emoting) this.emoteStep(dt, l);
  }

  /** What the right hand is doing with its fingers, by what it holds and what it's up to. */
  private rightShape(reach: number): HandShape {
    const g = this.gun;
    if (g) return gunHand(g.onFinger);
    if (this.wand) return SHAPES.wand;
    const both = this.bothShape();
    if (both) return both;
    switch (this.emoting?.emote.id) {
      case 'wave':
      case 'facepalm':
        return SHAPES.open;
      case 'thumbs':
        return SHAPES.thumbsUp;
      case 'clap':
        return SHAPES.flat;
      case 'dance':
        return SHAPES.fist;
      case 'point':
        return SHAPES.point;
    }
    if (reach > 0.05) return SHAPES.press;
    if (this.smokeT >= 0) return SHAPES.cigarette;
    return SHAPES.relaxed;
  }

  /** What the left hand is doing with its fingers. */
  private leftShape(): HandShape {
    const both = this.bothShape();
    if (both) return both;
    const g = this.gun;
    if (g && g.pose.left > 0.25 && !this.wantsMug && !this.glass) return SHAPES.cylinder;
    const id = this.emoting?.emote.id;
    if (id === 'clap') return SHAPES.flat;
    if (id === 'dance') return SHAPES.fist;
    if (this.glass?.group.visible) return SHAPES.glass;
    if (this.mug.visible) return SHAPES.mug;
    return SHAPES.relaxed;
  }

  /** Both hands on one thing (a rung, a pole, a card or a book), or null. */
  private bothShape(): HandShape | null {
    if (this.ladderK > 0.5) return SHAPES.rung;
    if (this.poleK > 0.5) return SHAPES.pole;
    if (this.card.held || this.book) return SHAPES.pinch;
    return null;
  }

  /**
   * The gun's pose on the hands already placed for this frame. At the ready it's a low, right-hand
   * hip-fire pose; holstered (`out` 0) the hand is down off the bottom of the view, muzzle down.
   */
  private gunStep(dt: number, r: THREE.Group, l: THREE.Group) {
    const g = this.gun!;
    const p = g.pose;
    const down = 1 - p.out;
    r.position.x += 0.05 + p.x + 0.06 * down;
    r.position.y += -0.035 + p.y - 0.4 * down + p.kick * 0.09;
    r.position.z += -0.06 + p.z + 0.12 * down + p.kick * 0.06;
    // Show the barrel's side above the wrist without stretching the sleeve across the view.
    r.rotation.set(0.25 + p.pitch - 1.1 * down + p.kick * 0.18, 0.3 + p.yaw - 0.25 * down, -0.08 + p.roll);
    r.updateMatrixWorld(true);
    // In the fist round its grip, or hung by its guard on the trigger finger to spin.
    g.onFinger += (p.finger - g.onFinger) * (1 - Math.exp(-dt * 30));
    // The hand moves in step with the gun (gunMount), so no finger passes through it on the way.
    this.right.glove.shape(gunHand(g.onFinger), true);
    this.right.glove.gunMount(g.onFinger, g.mount.position);
    // Tossed off the trigger finger: slid off the end of it (the gun's +x, the mount's -x), then
    // straight up the screen, whichever way the hand is turned.
    if (p.lift) {
      g.mount.position.x -= Math.min(p.lift, TOSS_SLIDE);
      const up = p.lift - TOSS_SLIDE;
      if (up > 0) g.mount.position.add(lift.set(0, up, 0).applyQuaternion(handTurn.copy(r.quaternion).invert()));
    }
    g.pivot.rotation.set(p.spin, p.turn, p.tilt);
    setCylinder(g.prop, p.crane, p.cylinder);
    const free = !this.wantsMug && !this.glass;
    if (free) l.position.y -= 0.2 * p.out;
    // The left hand in at the cylinder as it swings out: in the gun's own frame, the palm flat on
    // its far side, the fingers along it toward the muzzle and the thumb up, sweeping round it
    // (`palm`) to spin it.
    if (free && p.left > 0) {
      const prop = g.prop;
      prop.updateMatrixWorld(true);
      const drum = prop.worldToLocal(prop.getObjectByName('gun-drum')!.getWorldPosition(lift));
      const hinge = prop.worldToLocal(prop.getObjectByName('gun-crane')!.getWorldPosition(away));
      away.set(drum.x - hinge.x, drum.y - hinge.y, 0).normalize();
      along.set(-away.y, away.x, 0);
      drum.addScaledVector(away, CYLINDER_PALM).addScaledVector(along, -p.palm * 0.03);
      palmAt.makeBasis(along, away, back).setPosition(drum).premultiply(prop.matrixWorld);
      palmAt.decompose(lift, handTurn, scale);
      l.position.lerp(lift, p.left);
      l.quaternion.slerp(handTurn, p.left);
    }
    g.muzzle.update(dt);
  }

  /**
   * The wand's pose on the hands already placed for this frame. At the ready the fist is low on
   * the right, thumb up, with the wand raised out of it (WAND_HOLD); the pose's pitch and yaw
   * swing the wand (most of the pitch in the wrist, so the forearm stays down), its roll turns the
   * fist round the wand, and put away (`out` 0) the hand is down off the bottom of the view with
   * the tip dropped. The arm is turned so the wand runs where it points and the palm faces in.
   */
  private wandStep(dt: number, r: THREE.Group, l: THREE.Group) {
    const w = this.wand!;
    const p = w.pose;
    const down = 1 - p.out;
    const glove = this.right.glove;
    glove.shape(SHAPES.wand, true);
    // The wrist bent toward the little finger as the wand tips forward (back toward the thumb as it
    // tips back), round the palm's normal: after the roll, so in the glove's own frame.
    glove.group.rotation.order = 'ZYX';
    glove.group.rotation.y = THREE.MathUtils.clamp(p.pitch * WRIST, -WRIST_FORWARD, WRIST_BACK);
    glove.group.updateMatrix();
    wristTurned.copy(WRIST_AT).applyQuaternion(glove.group.quaternion);
    glove.group.position.copy(WRIST_AT).sub(wristTurned);
    // Lumos comes up and goes out over a fifth of a second.
    this.lumosK += ((this.lumosOn ? 1 : 0) - this.lumosK) * Math.min(1, dt * LUMOS_RATE);
    // Where the grip goes, and where it aims from there: the ready, moved by the pose.
    const sway = r.position.clone().sub(this.right.base);
    const grip = lift.copy(WAND_HOLD.grip).add(sway);
    grip.x += p.x + 0.06 * down;
    grip.y += p.y - 0.42 * down;
    grip.z += p.z + 0.12 * down;
    aimDir.copy(WAND_HOLD.dir);
    aimDir.applyAxisAngle(camX, p.pitch - 1.1 * down);
    sideAxis.copy(upAxis);
    aimDir.applyAxisAngle(sideAxis, p.yaw);
    palmDir.copy(WAND_HOLD.palm).applyAxisAngle(sideAxis, p.yaw);
    // Roll: the fist turned round the wand's line, clockwise as you see it.
    palmDir.applyAxisAngle(aimDir, -p.roll);
    // In the arm's frame: the wand's axis out of the fist and the way the palm faces, square to it.
    glove.group.updateMatrix();
    wandAxis.copy(WAND_GRIP_AXIS).applyQuaternion(glove.group.quaternion).normalize();
    palmInArm.set(0, -1, 0).applyQuaternion(glove.group.quaternion);
    turnQ.setFromRotationMatrix(frame(basisA, wandAxis, palmInArm)).invert();
    r.quaternion.setFromRotationMatrix(frame(basisB, aimDir, palmDir)).multiply(turnQ);
    // Then the arm placed so the grip lands where it goes.
    gripInArm.copy(WAND_GRIP_AT).applyMatrix4(glove.group.matrix).applyQuaternion(r.quaternion);
    r.position.copy(grip).sub(gripInArm);
    r.updateMatrixWorld(true);
    w.twirl.rotation.y = p.twirl;
    // The left hand drops away out of view while the right one works.
    if (!this.wantsMug && !this.glass) l.position.y -= 0.2 * p.out;
    w.item.update(dt, { spin: p.spin, glow: p.glow, charge: p.charge, lumos: this.lumosK });
  }

  /** Moves the hands (already placed for this frame) through the emote. */
  private emoteStep(dt: number, l: THREE.Group) {
    const e = this.emoting!;
    e.t += dt;
    const u = e.t;
    const { seconds, id } = e.emote;
    if (u >= seconds) {
      this.emoting = null;
      return;
    }
    const k = emoteEnvelope(u, seconds);
    const r = this.right.group;
    switch (id) {
      case 'wave':
        // Up in front of your shoulder (in from the edge, clear of the sidebar), rocking side to side.
        r.position.x += (-0.09 + Math.sin(u * 12) * 0.035) * k;
        r.position.y += 0.2 * k;
        r.rotation.x += 0.9 * k;
        r.rotation.z += Math.sin(u * 12) * 0.35 * k;
        break;
      case 'thumbs':
        // Up in front of you, fist level and thumb up, with a little pump.
        r.position.x -= 0.13 * k;
        r.position.y += (0.12 + Math.exp(-u * 3) * Math.sin(u * 14) * 0.03) * k;
        r.rotation.z += 0.25 * k;
        break;
      case 'clap': {
        const c = 0.5 - 0.5 * Math.cos(u * 19);
        for (const [g, side] of [
          [r, 1],
          [l, -1],
        ] as const) {
          g.position.x -= side * (0.1 + 0.085 * c) * k;
          g.position.y += 0.06 * k;
          g.rotation.z += side * 0.9 * k;
        }
        break;
      }
      case 'dance': {
        // Up and down by turns, two beats a second.
        const s = Math.sin(u * Math.PI * 2);
        r.position.y += (0.1 + 0.1 * s) * k;
        l.position.y += (0.1 - 0.1 * s) * k;
        r.position.x += s * 0.03 * k;
        l.position.x += s * 0.03 * k;
        break;
      }
      case 'point': {
        // Out toward the crosshair, like a reach you hold.
        const jab = 1 + Math.exp(-u * 4) * Math.sin(u * 16) * 0.15;
        r.position.x -= 0.16 * k;
        r.position.y += 0.09 * k;
        r.position.z -= 0.2 * k * jab;
        r.rotation.x += 0.3 * k;
        r.rotation.y += 0.15 * k;
        break;
      }
      case 'facepalm':
        // Palm up to your face, covering a corner of the view.
        r.position.x -= 0.12 * k;
        r.position.y += (0.17 + Math.sin(u * 5) * 0.01) * k;
        r.position.z += 0.2 * k;
        r.rotation.x += 0.9 * k;
        break;
    }
  }
}

/**
 * A rotation whose x axis is `a` and whose y axis is `b` made square to it: two of these turn one
 * pair of directions onto another.
 */
function frame(out: THREE.Matrix4, a: THREE.Vector3, b: THREE.Vector3): THREE.Matrix4 {
  const x = a.clone().normalize();
  const y = b.clone().addScaledVector(x, -b.dot(x)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return out.makeBasis(x, y, z);
}
