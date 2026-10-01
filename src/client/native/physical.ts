// Physical controller gestures use the sampled grip poses, independently of the pointing ray.
// Positions used for climbing are LOCAL_FLOOR deltas: moving the rig must never feed back into a pull.
import * as THREE from 'three';
import { FLOOR, LADDER, POLE, WALL_HEIGHT, type PoleSpot } from '../../shared/layout';
import type { PlayerController } from '../player';
import { GONG_TOUCH } from '../world/gong';
import { type Bore, boreOf, magnum, Muzzle } from '../world/gun';
import { LOST_MS, type NativeInputFrame } from './input';

type Hand = 0 | 1;
type Hold = 'ladder' | 'pole' | 'gun' | null;

export interface PhysicalClimber {
  readonly active: boolean;
  readonly physical: boolean;
  readonly grip: 'ladder' | 'pole' | null;
  pullLadder(meters: number): boolean;
  turnPole(radians: number): boolean;
  pausePhysical(paused: boolean): void;
  letGoPhysical(): void;
}

export interface NativePhysicalHooks {
  player: PlayerController;
  climber: PhysicalClimber;
  gong: THREE.Object3D;
  strikeGong(): void;
  ladderAvailable(): boolean;
  poles(): readonly PoleSpot[];
  grabLadder(): void;
  grabPole(spot: PoleSpot): void;
  canDraw(): boolean;
  /** False while a shot body still waits for its dialog: one casualty at a time. */
  canFire?(): boolean;
  gunChanged(held: boolean, quiet: boolean): void;
  /** The shot leaves along the held gun's whole bore (see world/gun.ts traceShot). */
  fireGun(bore: Bore): void;
}

interface Motion {
  valid: boolean;
  stable: boolean;
  time: number;
  local: THREE.Vector3;
  world: THREE.Vector3;
  contact: THREE.Vector3;
  /** Model rotation within the grip: the controller's pointing pose may have a different pitch. */
  gunRotation: THREE.Quaternion;
  armed: boolean;
  hold: Hold;
  lost: number | null;
}

const MAX_STEP = 0.35;
const MAX_SAMPLE_GAP = 80;
const CONTACT_OFFSET = new THREE.Vector3(0, 0.025, -0.075);
/** The shared model's +Z bore points along the OpenXR aim pose's -Z. */
const MODEL_TO_AIM = new THREE.Quaternion(0, 1, 0, 0);
const HANDS = [0, 1] as const;
/** Recoil: the muzzle flips up about the fist and the frame slides back, recovering in RECOIL_MS. */
const RECOIL_MS = 240;
const RECOIL_PITCH = 0.3;
const RECOIL_BACK = 0.04;
const MODEL_X = new THREE.Vector3(1, 0, 0);

/** How much of the kick is left `ms` after a shot (sample clock): all of it at once, easing home. */
export function recoilAt(ms: number): number {
  if (!(ms >= 0) || ms >= RECOIL_MS) return 0;
  const u = 1 - ms / RECOIL_MS;
  return u * u * u;
}

/** A swept front or rear contact, including a quick punch that crosses the whole disc in one sample. */
export function gongContact(from: THREE.Vector3, to: THREE.Vector3, seconds: number): boolean {
  if (seconds <= 0 || seconds > MAX_SAMPLE_GAP / 1000) return false;
  const distance = from.distanceTo(to);
  if (distance > MAX_STEP || distance < 0.006) return false;
  const dz = to.z - from.z;
  if (Math.abs(dz) / seconds < 0.25) return false;
  const plane = dz < 0 ? GONG_TOUCH.maxZ : GONG_TOUCH.minZ;
  const k = (plane - from.z) / dz;
  if (k < 0 || k > 1) return false;
  const x = from.x + (to.x - from.x) * k;
  const y = from.y + (to.y - from.y) * k - GONG_TOUCH.y;
  return x * x + y * y <= GONG_TOUCH.radius ** 2;
}

/** Reach the actual rails or one of the 30 cm spaced rungs, rather than the ladder's walk-up point. */
export function onLadder(point: THREE.Vector3): boolean {
  const x = FLOOR.minX + 0.16;
  const z = point.z - LADDER.z;
  if (Math.abs(point.x - x) > 0.15 || point.y < -0.8 || point.y > WALL_HEIGHT + 0.15) return false;
  if (Math.abs(Math.abs(z) - LADDER.width / 2) <= 0.12) return true;
  return Math.abs(z) <= LADDER.width / 2 + 0.08 && Math.abs(point.y - Math.round(point.y / 0.3) * 0.3) <= 0.1;
}

/** A back holster follows the head's horizontal heading; head pitch never moves it in front. */
export function inBackHolster(grip: THREE.Vector3, head: THREE.Vector3, orientation: THREE.Quaternion): boolean {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(orientation);
  forward.y = 0;
  if (forward.lengthSq() < 0.05) return false;
  forward.normalize();
  const dx = grip.x - head.x;
  const dz = grip.z - head.z;
  const back = -(dx * forward.x + dz * forward.z);
  const side = dx * -forward.z + dz * forward.x;
  const y = grip.y - head.y;
  return back >= 0.12 && back <= 0.62 && Math.abs(side) <= 0.55 && y >= -1.25 && y <= -0.25;
}

export class NativePhysical {
  private motion: [Motion, Motion] = [this.slot(), this.slot()];
  private allowed = false;
  private headValid = false;
  private head = new THREE.Vector3();
  private headRotation = new THREE.Quaternion();
  private position = new THREE.Vector3();
  private local = new THREE.Vector3();
  private contact = new THREE.Vector3();
  private aimRotation = new THREE.Quaternion();
  private delta = new THREE.Vector3();
  private gongInverse = new THREE.Matrix4();
  private pole: PoleSpot | null = null;
  private gun: THREE.Group | null = null;
  private muzzle: Muzzle | null = null;
  private gunHand: Hand | null = null;
  /** Debug staging: this hand's samples are scripted, with no real controller grip under them. */
  private scripted: Hand | null = null;
  private lastShot = -Infinity;
  private kick = new THREE.Quaternion();
  private bore: Bore = { breech: new THREE.Vector3(), muzzle: new THREE.Vector3(), direction: new THREE.Vector3() };
  private lastStrike = -Infinity;
  private dropped = false;
  private dropTime = 0;
  private landed = false;
  private velocity = new THREE.Vector3();

  constructor(
    private scene: THREE.Scene,
    private anchors: [THREE.Group, THREE.Group],
    private hooks: NativePhysicalHooks,
    private pulse: (hand: Hand, strength: number, ms: number) => void,
  ) {}

  private slot(): Motion {
    return { valid: false, stable: false, time: 0, local: new THREE.Vector3(), world: new THREE.Vector3(), contact: new THREE.Vector3(), gunRotation: new THREE.Quaternion(), armed: false, hold: null, lost: null };
  }

  owns(hand: Hand): boolean {
    return this.motion[hand].hold !== null;
  }

  get holdingGun(): boolean {
    return this.gunHand !== null;
  }

  get hint(): string | null {
    if (this.gunHand !== null) return 'Hold grip · trigger to fire · release behind your back to holster';
    if (!this.hooks.climber.physical) return null;
    return this.hooks.climber.grip === 'ladder' ? 'Hold a rung or rail · pull down to climb · release both grips to let go' : 'Hold grip on the pole · move sideways to turn · release both grips to step off';
  }

  /** Forget velocities on a recenter or rig jump; a held grip remains held. */
  reanchor(): void {
    for (const m of this.motion) {
      m.valid = false;
      m.stable = false;
      m.armed = false;
    }
  }

  /** A floor change keeps the existing climb journey, but never carries a weapon from the old scene. */
  worldChanged(): void {
    this.cancelGun();
    this.reanchor();
  }

  reset(): void {
    this.cancelGun();
    if (this.motion.some((m) => m.hold === 'ladder' || m.hold === 'pole')) this.hooks.climber.letGoPhysical();
    for (const m of this.motion) {
      m.hold = null;
      m.lost = null;
    }
    this.pole = null;
    this.allowed = false;
    this.reanchor();
  }

  /** Replay at the native sample rate, including motion between bridge ticks. */
  sample(frame: NativeInputFrame, head: THREE.Vector3, rotation: THREE.Quaternion, allowed: boolean, occupied: (hand: Hand) => boolean): void {
    this.head.copy(head);
    this.headRotation.copy(rotation);
    this.headValid = frame.headTracked !== false;
    this.allowed = allowed && this.headValid;
    if (!this.hooks.climber.active) {
      for (const m of this.motion) if (m.hold === 'ladder' || m.hold === 'pole') m.hold = null;
      this.pole = null;
    }
    this.hooks.gong.updateWorldMatrix(true, false);
    this.gongInverse.copy(this.hooks.gong.matrixWorld).invert();
    let pull = 0;
    let turn = 0;
    let hands = 0;
    let climbing = 0;
    for (const hand of HANDS) {
      const m = this.motion[hand];
      const input = frame.hands[hand];
      const tracked = input.active && input.gripTracked !== false && this.headValid;
      if (!tracked) {
        m.valid = false;
        m.stable = false;
        m.armed = false;
        m.lost ??= frame.time;
        if (frame.time - m.lost >= LOST_MS) this.cancelHand(hand);
        if (m.hold === 'gun' && this.gun) this.gun.visible = false;
        continue;
      }
      m.lost = null;
      this.local.set(input.grip[0], input.grip[1], input.grip[2]);
      // Keep the fist-centred origin at the grip, but align the bore with the pointing pose.
      // This is a controller-local offset; native rendering still follows the live display-frame
      // grip, without moving the gun from a lower-rate world-space pose.
      this.aimRotation.set(input.aim[3], input.aim[4], input.aim[5], input.aim[6]);
      m.gunRotation.set(input.grip[3], input.grip[4], input.grip[5], input.grip[6]).invert().multiply(this.aimRotation).multiply(MODEL_TO_AIM);
      this.anchors[hand].getWorldPosition(this.position);
      this.contact.copy(CONTACT_OFFSET).applyMatrix4(this.anchors[hand].matrixWorld).applyMatrix4(this.gongInverse);
      const seconds = (frame.time - m.time) / 1000;
      const continuous = m.valid && seconds > 0 && seconds <= MAX_SAMPLE_GAP / 1000 && this.local.distanceTo(m.local) <= MAX_STEP && this.position.distanceTo(m.world) <= MAX_STEP;
      m.stable = continuous;
      const handSpeed = seconds > 0 ? this.local.distanceTo(m.local) / seconds : 0;
      if (this.allowed && continuous && handSpeed >= 0.25 && !occupied(hand) && !m.hold && m.armed && frame.time - this.lastStrike >= 500 && gongContact(m.contact, this.contact, seconds)) {
        this.hooks.strikeGong();
        this.lastStrike = frame.time;
        this.pulse(hand, 0.7, 45);
        m.armed = false;
      }
      const away = this.contact.z > GONG_TOUCH.maxZ + 0.18 || this.contact.z < GONG_TOUCH.minZ - 0.18 || Math.hypot(this.contact.x, this.contact.y - GONG_TOUCH.y) > GONG_TOUCH.radius + 0.18;
      if (!this.allowed || occupied(hand) || m.hold) m.armed = false;
      else if (away) m.armed = true;
      if (m.hold === 'ladder' || m.hold === 'pole') {
        climbing++;
        if (this.allowed && continuous) {
          this.delta.subVectors(this.local, m.local);
          if (m.hold === 'ladder') pull -= this.delta.y;
          else if (this.pole) {
            // Counter-motion along the body's tangent moves the body round the pole.
            this.delta.transformDirection(this.anchors[hand].parent!.matrixWorld).multiplyScalar(this.local.distanceTo(m.local));
            const p = this.hooks.player.pos;
            const angle = Math.atan2(p.x - this.pole.x, p.z - this.pole.z);
            turn -= (this.delta.x * Math.cos(angle) - this.delta.z * Math.sin(angle)) / POLE.grip;
          }
          hands++;
        }
      }
      m.time = frame.time;
      m.local.copy(this.local);
      m.world.copy(this.position);
      m.contact.copy(this.contact);
      m.valid = true;
      if (m.hold === 'gun' && this.gun) {
        this.presentGun(m, frame.time - this.lastShot);
        this.gun.visible = true;
      }
    }
    this.hooks.climber.pausePhysical(!this.allowed || climbing === 0);
    if (hands && this.allowed) {
      this.hooks.climber.pullLadder(pull / hands);
      this.hooks.climber.turnPole(turn / hands);
    }
  }

  gripPress(hand: Hand): boolean {
    const m = this.motion[hand];
    if (!this.allowed || !m.valid || !m.stable || m.hold) return false;
    const p = this.hooks.player;
    const climbing = this.hooks.climber;
    const nearLadder = Math.abs(p.pos.x - LADDER.x) < 1.05 && Math.abs(p.pos.z - LADDER.z) < 0.9 && Math.abs(m.world.y - p.pos.y) < 2.4;
    if (this.hooks.ladderAvailable() && nearLadder && onLadder(m.world) && (!climbing.active || (climbing.physical && climbing.grip === 'ladder'))) {
      if (!climbing.active) this.hooks.grabLadder();
      if (climbing.physical && climbing.grip === 'ladder') {
        m.hold = 'ladder';
        this.reanchor();
        this.pulse(hand, 0.45, 22);
        return true;
      }
    }
    for (const spot of this.hooks.poles()) {
      const reach = Math.hypot(m.world.x - spot.x, m.world.z - spot.z);
      if (reach > POLE.radius + 0.14 || Math.hypot(p.pos.x - spot.x, p.pos.z - spot.z) > 1.1 || Math.abs(m.world.y - p.pos.y) > 2.4 || m.world.y < -0.7 || m.world.y > WALL_HEIGHT + 0.2) continue;
      if (climbing.active && (!climbing.physical || climbing.grip !== 'pole' || this.pole !== spot)) continue;
      if (!climbing.active) this.hooks.grabPole(spot);
      if (climbing.physical && climbing.grip === 'pole') {
        this.pole = spot;
        m.hold = 'pole';
        this.reanchor();
        this.pulse(hand, 0.45, 22);
        return true;
      }
    }
    if (this.gunHand === null && this.hooks.canDraw() && inBackHolster(m.world, this.head, this.headRotation)) {
      this.drawGun(hand);
      return true;
    }
    return false;
  }

  gripRelease(hand: Hand): boolean {
    const m = this.motion[hand];
    const held = m.hold;
    if (!held) return false;
    m.hold = null;
    if (held === 'gun') {
      if (m.valid && this.headValid && inBackHolster(m.world, this.head, this.headRotation)) this.cancelGun(false);
      else if (m.valid) this.dropGun();
      else this.cancelGun();
    } else {
      this.reanchor();
      if (!this.motion.some((other) => other.hold === 'ladder' || other.hold === 'pole')) this.hooks.climber.letGoPhysical();
    }
    return true;
  }

  /** Returns true for held tools even when firing is suppressed, so a gun trigger never also clicks a desk. */
  trigger(hand: Hand, time: number): boolean {
    const m = this.motion[hand];
    if (!m.hold) return false;
    if (m.hold !== 'gun' || !m.valid || !m.stable || !this.allowed || time - this.lastShot < 350 || !this.gun || this.hooks.canFire?.() === false) return true;
    this.lastShot = time;
    // The bullet leaves along the bore as aimed, before this shot's kick moves the model.
    this.presentGun(m, Infinity);
    this.hooks.fireGun(boreOf(this.gun, this.bore));
    this.muzzle?.fire();
    this.pulse(hand, 1, 70);
    // The kick shows in this very update, rather than a sample later.
    this.presentGun(m, 0);
    return true;
  }

  /** The held gun in the fist: aimed along the pointing pose, plus what is left of a shot's kick `ms` after it. */
  private presentGun(m: Motion, ms: number): void {
    const gun = this.gun!;
    gun.quaternion.copy(m.gunRotation);
    gun.position.set(0, 0, 0);
    const k = recoilAt(ms);
    if (k > 0) {
      gun.quaternion.multiply(this.kick.setFromAxisAngle(MODEL_X, -RECOIL_PITCH * k));
      gun.position.set(0, 0, -RECOIL_BACK * k).applyQuaternion(m.gunRotation);
    }
  }

  /** Debug staging: which hand is scripted (see NativeControls.stage), or null. */
  script(hand: Hand | null): void {
    this.scripted = hand;
  }

  cancelHand(hand: Hand): void {
    const m = this.motion[hand];
    if (m.hold === 'gun') this.cancelGun();
    else if (m.hold) {
      m.hold = null;
      if (!this.motion.some((other) => other.hold === 'ladder' || other.hold === 'pole')) this.hooks.climber.letGoPhysical();
    }
    m.valid = false;
    m.armed = false;
  }

  cancelGun(quiet = true): void {
    const held = this.gunHand !== null;
    if (this.gunHand !== null) this.motion[this.gunHand].hold = null;
    this.gunHand = null;
    this.dropped = false;
    if (this.gun) {
      this.gun.visible = false;
      delete this.gun.userData.nativeControllerAttachment;
      this.gun.removeFromParent();
    }
    if (held) this.hooks.gunChanged(false, quiet);
  }

  private drawGun(hand: Hand): void {
    if (!this.gun) {
      this.gun = magnum();
      this.gun.name = 'native-held-magnum';
      this.muzzle = new Muzzle();
      this.gun.add(this.muzzle.group);
    }
    this.dropped = false;
    this.gunHand = hand;
    this.motion[hand].hold = 'gun';
    this.anchors[hand].add(this.gun);
    this.gun.position.set(0, 0, 0);
    this.gun.quaternion.copy(this.motion[hand].gunRotation);
    this.gun.scale.setScalar(1);
    this.gun.visible = true;
    // The native renderer draws an attachment on the live controller grip; a scripted hand has
    // none under it, so its gun is drawn where the script holds it instead.
    if (this.scripted === hand) delete this.gun.userData.nativeControllerAttachment;
    else this.gun.userData.nativeControllerAttachment = { hand, requiresGrip: true };
    this.hooks.gunChanged(true, false);
    this.pulse(hand, 0.4, 25);
  }

  private dropGun(): void {
    if (!this.gun) return;
    this.gun.updateWorldMatrix(true, true);
    this.scene.attach(this.gun);
    delete this.gun.userData.nativeControllerAttachment;
    this.gunHand = null;
    this.dropped = true;
    this.dropTime = 0;
    this.landed = false;
    this.velocity.set(0, -0.3, 0);
    this.hooks.gunChanged(false, true);
  }

  update(dt: number): void {
    this.muzzle?.update(dt);
    if (!this.dropped || !this.gun) return;
    this.dropTime += dt;
    if (!this.landed) {
      this.velocity.y -= 18 * dt;
      this.gun.position.addScaledVector(this.velocity, dt);
      const p = this.gun.position;
      const ground = Math.max(this.hooks.player.groundBelow(p.x, p.z, p.y + 0.3), this.hooks.player.street);
      if (p.y <= ground + 0.12) {
        p.y = ground + 0.12;
        this.gun.rotation.z = Math.PI / 2;
        this.landed = true;
        this.dropTime = 0;
      }
    }
    if ((this.landed && this.dropTime >= 0.4) || (!this.landed && this.dropTime >= 2)) this.cancelGun();
  }
}
