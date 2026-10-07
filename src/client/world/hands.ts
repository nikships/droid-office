import * as THREE from 'three';
import { EMOTE_BY_ID, type Emote, type EmoteId } from '../../shared/emotes';
import type { CarriedIssue } from '../../shared/protocol';
import type { Drink } from '../../shared/rooftop';
import { OpenBook } from './book';
import { HeldCard } from './card';
import { REACH_TIME, SMOKE_CYCLE, cigarette, coffeeMug, dragCurve, drinkGlass, emoteEnvelope, putDownGlass, reachCurve } from './character';
import { Muzzle, SPIN_AT, disposeGun, magnum, setCylinder } from './gun';
import type { GunPose } from './gun-motion';
import { glyphFlat } from './glyph3d';
import { mesh, toonUnique } from './toon';
import { ballMesh } from './hoop';

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

/** Lifting the mug for a sip and lowering it again, in seconds. */
const SIP_TIME = 1.1;

/** Where the fist holds the gun's grip, in the right hand. */
const GUN_MOUNT = new THREE.Vector3(0, -0.01, -0.06);
const lift = new THREE.Vector3();
const handTurn = new THREE.Quaternion();

interface Arm {
  group: THREE.Group;
  base: THREE.Vector3;
  baseRot: THREE.Euler;
  side: 1 | -1;
  /** The steel cuff at the wrist. */
  cuff: THREE.Mesh;
  /** The gloved hand: palm, thumb, and on the right hand the pointing finger. */
  mitten: THREE.Mesh[];
  finger: THREE.Mesh | null;
  /** The glove's knuckle guard and the pinwheel on its back. */
  crew: THREE.Mesh[];
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
  /** The basketball, held low in front of you in both hands (see holdBall). */
  private ball: THREE.Mesh;
  private wantsBall = false;
  /** 0 → 1 as the ball comes up into your hands. */
  private ballK = 0;
  /** How far into winding up a shot (0–1), and seconds into the follow-through after one (or -1). */
  private wind = 0;
  private shootT = -1;
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
  /** Sticks up out of the right fist for a thumbs up. */
  private thumbUp: THREE.Mesh;
  /** Your shirt and skin. */
  private shirt: string;
  private skinTone: string;
  /**
   * A .44 Magnum in the right fist (see setGunPose): where the fist holds it, the pivot it spins
   * round on the trigger finger, the prop and its muzzle flash, and the pose it's in.
   */
  private gun: { mount: THREE.Group; pivot: THREE.Group; prop: THREE.Group; muzzle: Muzzle; pose: Readonly<GunPose> } | null = null;

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
    // Held between the fingers of the right hand, lit end out past the knuckles.
    const cig = cigarette();
    this.cig = cig.group;
    this.ember = cig.ember;
    this.cig.scale.setScalar(0.55);
    this.cig.rotation.set(0.35, Math.PI + 0.5, 0);
    this.cig.position.set(-0.035, 0.03, -0.075);
    this.cig.visible = false;
    this.right.group.add(this.cig);
    this.thumbUp = mesh(new THREE.CapsuleGeometry(0.027, 0.035, 4, 10), this.glove, -0.035, 0.065, -0.005, false);
    this.thumbUp.rotation.z = 0.3;
    this.thumbUp.visible = false;
    this.right.group.add(this.thumbUp);
    // Tipped back, so you look down onto its front.
    this.holder.rotation.x = -0.35;
    this.scene.add(this.holder);
    this.card = new HeldCard(this.holder, 0.24);
    // Tipped further back than a card, so you look down into its pages.
    this.bookHolder.rotation.x = -0.8;
    this.bookHolder.scale.setScalar(0.7);
    this.scene.add(this.bookHolder);
    this.ball = ballMesh();
    this.ball.visible = false;
    this.scene.add(this.ball);
  }

  /** The basketball in both hands, or not. The mug waits while your hands are full. */
  holdBall(on: boolean) {
    if (on === this.wantsBall) return;
    this.wantsBall = on;
    if (on) this.ballK = 0;
    this.holdMug(this.wantsMug);
  }

  /** Winding up a shot, 0 (not yet) to 1 (as hard as you throw): the ball comes down and in, ready to go. */
  windUp(k: number) {
    this.wind = k;
  }

  /** The shot: both hands up and out after the ball. */
  shoot() {
    this.shootT = 0;
    this.wind = 0;
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
    const full = this.card.held || !!this.book || this.wantsBall;
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
    this.thumbUp.visible = id === 'thumbs';
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
    if (!pose) {
      if (!this.gun) return;
      disposeGun(this.gun.prop);
      this.gun.mount.removeFromParent();
      this.gun = null;
      if (this.right.finger) this.right.finger.visible = true;
      return;
    }
    if (this.gun) {
      this.gun.pose = pose;
      return;
    }
    const mount = new THREE.Group();
    mount.position.copy(GUN_MOUNT);
    // The muzzle down the hand's local -z.
    mount.rotation.y = Math.PI;
    const pivot = new THREE.Group();
    pivot.position.copy(SPIN_AT);
    const prop = magnum();
    prop.position.copy(SPIN_AT).negate();
    const muzzle = new Muzzle();
    prop.add(muzzle.group);
    pivot.add(prop);
    mount.add(pivot);
    this.right.group.add(mount);
    this.gun = { mount, pivot, prop, muzzle, pose };
  }

  /** Fires it: a flash at the muzzle (the recoil is the pose's kick). */
  fireGun() {
    this.gun?.muzzle.fire();
  }

  private arm(side: 1 | -1): Arm {
    const group = new THREE.Group();
    // Sleeve runs from the wrist back past the camera, so its far end is always off screen.
    group.add(mesh(new THREE.CapsuleGeometry(0.058, 0.42, 6, 14).rotateX(Math.PI / 2), this.sleeve, 0, 0, 0.34, false));
    const cuff = mesh(new THREE.CylinderGeometry(0.068, 0.068, 0.045, 18).rotateX(Math.PI / 2), this.cuffMat, 0, 0, 0.075, false);
    group.add(cuff);
    // A Factory work glove: a chunky palm, a thumb on the inside, and a pointing finger on the right hand.
    const palm = mesh(new THREE.SphereGeometry(0.062, 18, 14), this.glove, 0, 0, 0, false);
    palm.scale.set(1, 0.78, 1.18);
    group.add(palm);
    const thumb = mesh(new THREE.CapsuleGeometry(0.02, 0.03, 4, 10).rotateX(Math.PI / 2), this.glove, -side * 0.05, 0.014, -0.02, false);
    thumb.rotation.y = side * 0.55;
    group.add(thumb);
    const finger = side === 1 ? mesh(new THREE.CapsuleGeometry(0.019, 0.05, 4, 10).rotateX(Math.PI / 2), this.glove, -0.016, 0.022, -0.085, false) : null;
    if (finger) group.add(finger);
    // A graphite knuckle guard, and the pinwheel on the back of the hand (the palm's top is y 0.048).
    const guard = mesh(new THREE.CapsuleGeometry(0.012, 0.062, 3, 8).rotateZ(Math.PI / 2), this.cuffMat, 0, 0.03, -0.048, false);
    guard.rotation.x = -0.55;
    group.add(guard);
    const badge = mesh(glyphFlat(0.046, 4).rotateX(-Math.PI / 2), this.pinwheel, 0, 0.0478, 0.016, false);
    // Laid along the back of the hand where it starts to slope down to the wrist, toward your eye.
    badge.rotation.x = 0.2;
    group.add(badge);
    const base = new THREE.Vector3(side * 0.25, -0.185, -0.44);
    const baseRot = new THREE.Euler(0.2, side * 0.22, side * -0.25);
    group.position.copy(base);
    group.rotation.copy(baseRot);
    this.scene.add(group);
    return { group, base, baseRot, side, cuff, mitten: [palm, thumb, ...(finger ? [finger] : [])], finger, crew: [guard, badge] };
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
    this.ballK += ((this.wantsBall ? 1 : 0) - this.ballK) * Math.min(1, dt * 9);
    const held = this.ballK;
    let throwK = 0;
    if (this.shootT >= 0) {
      this.shootT += dt;
      throwK = reachCurve(this.shootT / 0.45);
      if (this.shootT >= 0.45) this.shootT = -1;
    }

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
      // Holding the ball: a hand on either side of it, palms in, lower and closer as the shot winds up.
      p.x -= side * 0.1 * held;
      p.y -= (0.09 + 0.06 * this.wind) * held;
      p.z += (-0.08 + 0.05 * this.wind) * held;
      arm.group.rotation.z += side * 0.7 * held;
      // The follow-through: up and out after it.
      p.x -= side * 0.06 * throwK;
      p.y += 0.22 * throwK;
      p.z -= 0.16 * throwK;
      arm.group.rotation.x += 0.9 * throwK;
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
    // The ball rides between them, coming up from below as you pick it up.
    this.ball.visible = this.wantsBall && held > 0.02;
    this.ball.position.set(this.sway.x + step * 0.008, this.sway.y + breathe + bounce + this.air * 0.05 - 0.28 - 0.06 * this.wind - 0.3 * (1 - held), -0.54 + 0.05 * this.wind);
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
    if (this.gun) this.gunStep(dt, r, l);
    // A drag: the cigarette hand comes up to your mouth, just under the camera, and back down.
    if (this.smokeT >= 0) {
      this.smokeT += dt;
      // Not mid-aim: the hand holding the gun stays on the crosshair.
      const d = s.walking || s.airborne || this.gun ? 0 : dragCurve(this.smokeT % SMOKE_CYCLE);
      r.position.x -= 0.2 * d;
      r.position.y += 0.02 * d;
      r.position.z += 0.3 * d;
      r.rotation.x += 0.5 * d;
      this.ember.emissiveIntensity += ((d > 0.9 ? 1.4 : 0.3) - this.ember.emissiveIntensity) * Math.min(1, dt * 6);
    }
    if (this.emoting) this.emoteStep(dt, l);
  }

  /**
   * The gun's pose on the hands already placed for this frame. At the ready it's a low, right-hand
   * hip-fire pose; holstered (`out` 0) the hand is down off the bottom of the view, muzzle down.
   */
  private gunStep(dt: number, r: THREE.Group, l: THREE.Group) {
    const g = this.gun!;
    const p = g.pose;
    const down = 1 - p.out;
    r.position.x += 0.07 + p.x + 0.06 * down;
    r.position.y += -0.035 + p.y - 0.4 * down + p.kick * 0.09;
    r.position.z += -0.06 + p.z + 0.12 * down + p.kick * 0.06;
    // Show the barrel's side above the wrist without stretching the sleeve across the view.
    r.rotation.set(0.25 + p.pitch - 1.1 * down + p.kick * 0.18, 0.3 + p.yaw - 0.25 * down, -0.08 + p.roll);
    // Spinning on the trigger finger, it turns a little ahead of the fist so the grip clears the glove.
    g.mount.position.copy(GUN_MOUNT);
    g.mount.position.y -= 0.012 * p.finger;
    g.mount.position.z -= 0.035 * p.finger;
    // Tossed: straight up the screen, whichever way the hand is turned.
    if (p.lift) g.mount.position.add(lift.set(0, p.lift, 0).applyQuaternion(handTurn.copy(r.quaternion).invert()));
    g.pivot.rotation.set(p.spin, p.turn, p.tilt);
    setCylinder(g.prop, p.crane, p.cylinder);
    if (this.right.finger) this.right.finger.visible = p.finger > 0.5;
    const free = !this.wantsMug && !this.glass;
    if (free) l.position.y -= 0.2 * p.out;
    // The left hand in at the cylinder, swung out, palm against it, sweeping down it to spin it.
    if (free && p.left > 0) {
      r.updateMatrixWorld(true);
      g.prop.getObjectByName('gun-drum')!.getWorldPosition(lift);
      lift.x -= 0.075;
      lift.y += 0.01 + p.palm * 0.035;
      lift.z += 0.03;
      l.position.lerp(lift, p.left);
      l.rotation.z += (1.35 - l.rotation.z) * p.left;
      l.rotation.y += (0.35 - l.rotation.y) * p.left;
    }
    g.muzzle.update(dt);
  }

  /** Moves the hands (already placed for this frame) through the emote. */
  private emoteStep(dt: number, l: THREE.Group) {
    const e = this.emoting!;
    e.t += dt;
    const u = e.t;
    const { seconds, id } = e.emote;
    if (u >= seconds) {
      this.emoting = null;
      this.thumbUp.visible = false;
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
