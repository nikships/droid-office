// Debug-only staging for headset captures: window.__office.stageShot and stageHaul in a debuggable
// native build (the Android host reports BuildConfig.DEBUG; a release build never enables them).
//
// A scripted controller stands in for one hand inside NativeControls. For a shot it grips the back
// holster, raises the gun to a pose aimed at a worker from a chosen distance and angle, and pulls
// the trigger. For a haul it grips a worker lying on the floor and lifts it back up. The draw, the
// trigger, the grip, the shot, the casualty and the effects therefore run through exactly the code
// a held controller drives. Only the input samples are scripted; the head stays the headset's own.
// A staged gun is drawn at its scripted world pose, because no real controller grip is under it.
// No DOM or WebGL at import time, so tests load it in Node.

import * as THREE from 'three';
import { MUZZLE_AT } from '../world/gun';
import type { PlayerController } from '../player';
import type { NativeHand, Pose7 } from './input';
import { placeAvatar } from './locomotion';

/** The shared model's +Z bore along the OpenXR aim pose's -Z (native/physical.ts MODEL_TO_AIM). */
const MODEL_TO_AIM = new THREE.Quaternion(0, 1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);

export interface StageAimOptions {
  /** The point on the worker the bore runs through. */
  target: THREE.Vector3;
  /** The worker's own subtree: the bore's surface point is found on its rendered meshes. */
  body: THREE.Object3D;
  /** Which way the worker faces (any length; only its horizontal part is used). */
  facing: THREE.Vector3;
  /** Radians around the worker from straight in front of it, positive toward its left. */
  angle: number;
  /** Radians the shot slopes down (negative: up). */
  pitch: number;
  /** Meters from the muzzle to the body's surface along the bore; negative presses it in. */
  gap: number;
  /** Horizontal meters from the shooter's feet to the gun's fist. */
  reach?: number;
}

/** A staged shot in world space: where the gun is held and where the shooter stands. */
export interface StageAim {
  /** The gun's fist (its model origin) and rotation (+Z along the bore). */
  grip: THREE.Vector3;
  rotation: THREE.Quaternion;
  muzzle: THREE.Vector3;
  direction: THREE.Vector3;
  /** Where the bore meets the body from outside. */
  surface: THREE.Vector3;
  /** The shooter's feet, and its heading in the avatar's atan2(x, z) convention. */
  stand: THREE.Vector3;
  facing: number;
}

/** Where to hold a gun so its muzzle is `gap` meters off the worker's surface, aimed through `target`. */
export function stageAim(o: StageAimOptions): StageAim {
  const toward = new THREE.Vector3(o.facing.x, 0, o.facing.z);
  if (toward.lengthSq() < 1e-8) toward.set(0, 0, 1);
  toward.normalize().applyAxisAngle(UP, o.angle);
  // The shooter is out along `toward`; the bullet travels back toward the worker and down by `pitch`.
  const direction = toward.clone().negate().multiplyScalar(Math.cos(o.pitch)).setY(-Math.sin(o.pitch)).normalize();
  const meshes: THREE.Mesh[] = [];
  o.body.updateWorldMatrix(true, true);
  o.body.traverseVisible((m) => {
    if (m instanceof THREE.Mesh) meshes.push(m);
  });
  const ray = new THREE.Raycaster(o.target.clone().addScaledVector(direction, -4), direction);
  const surface = ray.intersectObjects(meshes, false)[0]?.point ?? o.target.clone();
  const muzzle = surface.clone().addScaledVector(direction, -o.gap);
  const x = new THREE.Vector3().crossVectors(UP, direction);
  if (x.lengthSq() < 1e-8) x.set(1, 0, 0);
  x.normalize();
  const y = new THREE.Vector3().crossVectors(direction, x);
  const rotation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, direction));
  const grip = muzzle.clone().sub(MUZZLE_AT.clone().applyQuaternion(rotation));
  const flat = new THREE.Vector3(direction.x, 0, direction.z).normalize();
  const stand = grip.clone().addScaledVector(flat, -(o.reach ?? 0.42));
  return { grip, rotation, muzzle, direction, surface, stand, facing: Math.atan2(flat.x, flat.z) };
}

/** When each step of the scripted draw happens, in sample-clock milliseconds from its first sample. */
export const STAGE_TIMING = {
  /** Squeeze in the back holster. */
  grip: 60,
  /** Start raising the drawn gun. */
  raise: 140,
  /** It arrives at the aim, and holds still. */
  aimed: 460,
  /** The trigger pull, and how long it stays pulled. */
  fire: 760,
  pull: 120,
} as const;

/**
 * The scripted controller: back-holster draw, a raise to the staged aim, one trigger pull, then
 * holding the aim for `holdMs` (until ShotStage ends it, by default). sample() returns null once
 * the script is over.
 */
export class ShotScript {
  private start: number | null = null;
  private holster = new THREE.Vector3();
  private holsterSet = false;
  private local = new THREE.Vector3();
  private rigRotation = new THREE.Quaternion();
  private aimLocal = new THREE.Quaternion();
  private scratch = new THREE.Quaternion();
  private inverse = new THREE.Matrix4();

  constructor(
    readonly hand: 0 | 1,
    private aim: StageAim,
    private holdMs = Infinity,
  ) {}

  /** Sample-clock time of the scripted trigger pull, once the script has started. */
  get fireTime(): number | null {
    return this.start === null ? null : this.start + STAGE_TIMING.fire;
  }

  /** The controller this sample, from the real head (native LOCAL_FLOOR) and the rig's world matrix. */
  sample(time: number, head: Pose7, rig: THREE.Matrix4): NativeHand | null {
    this.start ??= time;
    const t = time - this.start;
    if (t > STAGE_TIMING.fire + this.holdMs) return null;
    if (!this.holsterSet) {
      // Behind the back at the start, wherever the head is then (native/physical.ts inBackHolster).
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.scratch.set(head[3], head[4], head[5], head[6]));
      forward.y = 0;
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
      forward.normalize();
      this.holster.set(head[0], head[1] - 0.75, head[2]).addScaledVector(forward, -0.3);
      this.holsterSet = true;
    }
    // World → native space: the grip pose is the rig's inverse applied to the staged world pose.
    this.inverse.copy(rig).invert();
    this.local.copy(this.aim.grip).applyMatrix4(this.inverse);
    rig.decompose(_p, this.rigRotation, _s);
    // physical.ts draws the model at grip · grip⁻¹ · aim · MODEL_TO_AIM, so aim = rig⁻¹ · model · MODEL_TO_AIM⁻¹.
    this.aimLocal.copy(this.rigRotation).invert().multiply(this.aim.rotation).multiply(MODEL_TO_AIM);
    const k = THREE.MathUtils.clamp((t - STAGE_TIMING.raise) / (STAGE_TIMING.aimed - STAGE_TIMING.raise), 0, 1);
    const eased = k * k * (3 - 2 * k);
    _p.lerpVectors(this.holster, this.local, eased);
    const pose: Pose7 = [_p.x, _p.y, _p.z, this.aimLocal.x, this.aimLocal.y, this.aimLocal.z, this.aimLocal.w];
    const pulled = t >= STAGE_TIMING.fire && t < STAGE_TIMING.fire + STAGE_TIMING.pull;
    return {
      active: true,
      aim: pose,
      grip: [...pose],
      gripTracked: true,
      trigger: pulled ? 1 : 0,
      squeeze: t >= STAGE_TIMING.grip ? 1 : 0,
      stick: [0, 0],
      a: false,
      b: false,
      menu: false,
      ui: false,
      stickClick: false,
    };
  }
}

const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * What a shot did: missed every worker, dropped one out of its chair, struck one already down, or
 * finished one off (its kill sent).
 */
export type ShotOutcome = 'miss' | 'down' | 'hit' | 'finished';

/** What main.ts's shot resolution reports for each shot (see resolveGunShot). */
export interface ShotReport {
  workerId: string | null;
  outcome: ShotOutcome;
  /** The struck mesh's name or geometry type, if anything was struck. */
  solid: string | null;
  /** Meters from the muzzle to the strike. */
  distance: number | null;
}

/** Only a disposable worker named like this may be finished off by a staged shot. */
export const DISPOSABLE = /^target\b/i;

export interface StageShotOptions {
  /** A worker's name (any case) or id. */
  worker: string;
  /** Meters from the muzzle to the body's surface along the bore. Default 1.2 (0.6 at a body on the floor). */
  gap?: number;
  /**
   * Degrees around the worker from straight in front of it, positive toward its left. Default 70.
   * For a worker already down, around its body from the open floor beside it; default 0.
   */
  angle?: number;
  /**
   * Shoot a worker that is already down, which finishes it off once it has lain still long enough
   * (its kill is sent and the medics come). Refused unless its name starts with "Target".
   */
  finish?: boolean;
  /** Degrees the shot slopes down. By default, so the gun sits just below the headset's eye line (55 at a body on the floor). */
  pitch?: number;
  /** Horizontal meters from the shooter's feet (under the headset) back from the gun's fist. Default 0.42. */
  reach?: number;
  /** Where on a seated worker to aim, in meters up its own body. Default 0.62 (its middle). */
  height?: number;
  /** Which controller is scripted. Default right. */
  hand?: 'left' | 'right';
  /** Freeze gameplay this many milliseconds after the shot, for a still capture, until release(). */
  freezeMs?: number;
  /** How long the scripted hand keeps aiming after the shot. Default 1500. */
  holdMs?: number;
  /** Give up after this many milliseconds without a shot. Default 8000. */
  timeoutMs?: number;
}

export interface StageShotResult {
  ok: boolean;
  /** Why nothing was staged or fired. */
  reason?: string;
  /** The shot struck the named worker. */
  hit?: boolean;
  worker?: string;
  workerId?: string;
  /** What the bullet struck, by worker id; null for furniture, walls or nothing. */
  struck?: string | null;
  outcome?: ShotOutcome;
  solid?: string | null;
  distance?: number | null;
  gap?: number;
  angle?: number;
  pitch?: number;
  /** Milliseconds between the shot and the frozen frame, when freezeMs was given. */
  frozenAfterMs?: number | null;
  muzzle?: [number, number, number];
  surface?: [number, number, number];
}

export interface StageHaulOptions {
  /** A worker's name (any case) or id, lying on the floor with its session running. */
  worker: string;
  /** Which controller is scripted. Default left (the gun hand is usually the right). */
  hand?: 'left' | 'right';
  /** Meters the hand rises after it grips the body. Default 0.5 (all the way back into its chair). */
  lift?: number;
  /** Milliseconds the rise takes. Default 700. */
  riseMs?: number;
  /** Milliseconds the hand keeps its grip at the top before letting go. Default 300. */
  holdMs?: number;
  /** Freeze gameplay this many milliseconds after the grip closes, for a still capture, until release(). */
  freezeMs?: number;
  /** Give up after this many milliseconds. Default 8000. */
  timeoutMs?: number;
}

export interface StageHaulResult {
  ok: boolean;
  reason?: string;
  worker?: string;
  workerId?: string;
  /** The worker is back in its chair. */
  revived?: boolean;
  /** Milliseconds between the grip closing and the frozen frame, when freezeMs was given. */
  frozenAfterMs?: number | null;
  chest?: [number, number, number];
}

/** A worker shot down, as main.ts sees it (casualties plus the kills it has sent). */
export interface DownedState {
  /** Still tumbling out of its chair, lying on the floor with its session running, or finished off. */
  state: 'falling' | 'lying' | 'finished';
  chest: THREE.Vector3;
  /** Horizontal, from the chair it fell out of toward where it lies: the open floor beside it. */
  open: THREE.Vector3;
}

/** What ShotStage needs from main.ts and NativeControls. */
export interface ShotStageHooks {
  controls: {
    readonly active: boolean;
    readonly holdingGun: boolean;
    readonly staging: boolean;
    stage(script: ShotScript | HaulScript | null): void;
    cancelGun(): void;
    recenter(): void;
  };
  player: Pick<PlayerController, 'pos' | 'facing' | 'vy' | 'grounded' | 'stepOffset' | 'street' | 'groundBelow' | 'blockedAt' | 'seat' | 'stand'>;
  /** A worker by name (any case) or id, with its model's root. */
  worker(key: string): { id: string; name: string; root: THREE.Object3D } | null;
  /** The worker shot down, or null when it is up (or gone). */
  downed(id: string): DownedState | null;
  /** Whether a bullet from `muzzle` along `direction` would strike worker `id` first. */
  lineOfFire?(muzzle: THREE.Vector3, direction: THREE.Vector3, id: string): boolean;
  /** Why world input is unavailable (on the roof, mid-trip, climbing...), or null. */
  blocked(): string | null;
  /** Where the headset's eyes are in the world, if known (the page camera follows them). */
  eye(): THREE.Vector3 | null;
  /** Shuts the workspace and its windows so world input is live. */
  clearPanel(): void;
  /** Quietly stands a worker shot down back up in its seat; nothing when it was finished off. */
  revive(id: string): void;
  now(): number;
}

/**
 * The worker a staged shot names: its id, its name in any case, its name without emoji and
 * punctuation ("Pixel" for "Pixel 🐚"), or the only name that starts with those words.
 */
export function matchWorker<T extends { id: string; name: string }>(key: string, workers: Iterable<T>): T | null {
  const plain = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const list = [...workers];
  const lower = key.toLowerCase();
  const words = plain(key);
  const exact = list.find((w) => w.id === key) ?? list.find((w) => w.name.toLowerCase() === lower) ?? (words ? list.find((w) => plain(w.name) === words) : undefined);
  if (exact || !words) return exact ?? null;
  const starts = list.filter((w) => plain(w.name).startsWith(`${words} `));
  return starts.length === 1 ? starts[0] : null;
}

const round = (v: THREE.Vector3): [number, number, number] => [Math.round(v.x * 1000) / 1000, Math.round(v.y * 1000) / 1000, Math.round(v.z * 1000) / 1000];

/** When each step of a scripted haul happens, in sample-clock milliseconds from its first sample. */
export const HAUL_TIMING = {
  /** The hand rests on the body, then its grip closes. */
  grip: 150,
  /** It starts to lift. */
  rise: 300,
  /** Released this long before the script hands the controller back. */
  after: 150,
} as const;

/**
 * The scripted hand for a haul: it rests on the body's chest, grips, rises `lift` meters over
 * `riseMs`, keeps its grip `holdMs`, and lets go. sample() returns null once it is over.
 */
export class HaulScript {
  private start: number | null = null;
  private local = new THREE.Vector3();
  private inverse = new THREE.Matrix4();

  constructor(
    readonly hand: 0 | 1,
    private at: THREE.Vector3,
    private lift: number,
    private riseMs: number,
    private holdMs: number,
  ) {}

  /** Whether the grip has closed on the body. */
  gripped(time: number | null): boolean {
    return this.start !== null && time !== null && time - this.start >= HAUL_TIMING.grip;
  }

  /** The last sample time seen, for gripped(). */
  last: number | null = null;

  sample(time: number, _head: Pose7, rig: THREE.Matrix4): NativeHand | null {
    this.start ??= time;
    this.last = time;
    const t = time - this.start;
    const letGo = HAUL_TIMING.rise + this.riseMs + this.holdMs;
    if (t > letGo + HAUL_TIMING.after) return null;
    const k = THREE.MathUtils.clamp((t - HAUL_TIMING.rise) / this.riseMs, 0, 1);
    this.inverse.copy(rig).invert();
    this.local.copy(this.at).applyMatrix4(this.inverse);
    // The rig only turns about the vertical and moves, so a native-space rise is a world rise.
    this.local.y += this.lift * k * k * (3 - 2 * k);
    const pose: Pose7 = [this.local.x, this.local.y, this.local.z, 0, 0, 0, 1];
    return {
      active: true,
      aim: pose,
      grip: [...pose],
      gripTracked: true,
      trigger: 0,
      squeeze: t >= HAUL_TIMING.grip && t < letGo ? 1 : 0,
      stick: [0, 0],
      a: false,
      b: false,
      menu: false,
      ui: false,
      stickClick: false,
    };
  }
}

/**
 * window.__office.stageShot's and stageHaul's engine: one staged act at a time. The page reports
 * every shot (shot()) and each gameplay poll (tick()); a frozen stage tells the page to stop
 * advancing gameplay, so the headset keeps drawing that instant until release().
 */
export class ShotStage {
  /** Set from the Android host's frame call; a release build never sets it. */
  debuggable = false;
  frozen = false;
  private script: ShotScript | HaulScript | null = null;
  /** The worker the latest staged act was at, stood back up by release(). */
  private target: string | null = null;
  private freezeMs: number | null = null;
  private holdMs = 0;
  private result: (StageShotResult & StageHaulResult) | null = null;
  /** performance-clock time of the staged shot, or of the staged grip closing. */
  private actAt: number | null = null;
  private done: ((r: StageShotResult & StageHaulResult) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private hooks: ShotStageHooks) {}

  /** Stages, fires and reports one shot; resolves once it has fired (and frozen, with freezeMs). */
  run(options: StageShotOptions): Promise<StageShotResult> {
    const refused = this.begin();
    if (refused) return Promise.resolve({ ok: false, reason: refused });
    const w = this.hooks.worker(String(options.worker ?? ''));
    if (!w) return Promise.resolve({ ok: false, reason: `no worker named ${JSON.stringify(options.worker)} on this floor` });
    const down = this.hooks.downed(w.id);
    if (down?.state === 'falling') return Promise.resolve({ ok: false, reason: `${w.name} is still falling` });
    if (down?.state === 'finished') return Promise.resolve({ ok: false, reason: `${w.name} was already finished off: the medics are coming` });
    if (down && options.finish !== true) return Promise.resolve({ ok: false, reason: `${w.name} is down: pass finish: true to finish it off (disposable Target workers only), or stageHaul to revive it` });
    if (options.finish === true && !DISPOSABLE.test(w.name)) return Promise.resolve({ ok: false, reason: `staged shots finish off only disposable workers named "Target …", not ${w.name}` });
    if (options.finish === true && !down) return Promise.resolve({ ok: false, reason: `${w.name} is not down: shoot it once first` });
    const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    const gap = num(options.gap, down ? 0.6 : 1.2);
    const reach = THREE.MathUtils.clamp(num(options.reach, 0.42), 0.2, 3);
    const height = num(options.height, 0.62);
    w.root.updateWorldMatrix(true, true);
    const target = down ? down.chest.clone() : w.root.localToWorld(new THREE.Vector3(0, height, 0));
    // A seated worker is circled from its face; one on the floor from the open floor beside it.
    const facing = down ? down.open.clone() : new THREE.Vector3(0, 0, 1).transformDirection(w.root.matrixWorld);
    // Slope the shot so the gun rides just under the headset's eye line, whatever its real height.
    const eye = this.hooks.eye();
    const level = eye ? THREE.MathUtils.radToDeg(Math.atan2(eye.y - 0.18 - target.y, reach + MUZZLE_AT.z + Math.max(gap, 0) + 0.2)) : 15;
    // Without an asked angle or slope, the first approach with a clear line to the worker: a
    // body on the floor is shot from over it, around it from the open floor beside it.
    const angles = typeof options.angle === 'number' && Number.isFinite(options.angle) ? [options.angle] : down ? [0, 35, -35, 70, -70, 110, -110, 180] : [70, 40, 100, -70, -40, -100, 15];
    const pitches = typeof options.pitch === 'number' && Number.isFinite(options.pitch) ? [options.pitch] : down ? [55, 70, 40] : [Math.round(THREE.MathUtils.clamp(level, -10, 60))];
    const aimAt = (angle: number, pitch: number) => stageAim({ target, body: w.root, facing, angle: THREE.MathUtils.degToRad(angle), pitch: THREE.MathUtils.degToRad(pitch), gap, reach });
    let angle = angles[0];
    let pitch = pitches[0];
    let aim = aimAt(angle, pitch);
    search: for (const a of angles)
      for (const p of pitches) {
        const tried = aimAt(a, p);
        if (!this.hooks.lineOfFire || this.hooks.lineOfFire(tried.muzzle, tried.direction, w.id)) {
          [angle, pitch, aim] = [a, p, tried];
          break search;
        }
      }
    this.freezeMs = typeof options.freezeMs === 'number' && Number.isFinite(options.freezeMs) ? Math.max(0, options.freezeMs) : null;
    this.holdMs = Math.max(0, num(options.holdMs, 1500));
    this.hooks.clearPanel();
    this.standAt(aim.stand, aim.direction, aim.facing);
    this.target = w.id;
    this.script = new ShotScript(options.hand === 'left' ? 0 : 1, aim);
    this.hooks.controls.stage(this.script);
    this.actAt = null;
    this.result = { ok: true, worker: w.name, workerId: w.id, gap, angle, pitch, muzzle: round(aim.muzzle), surface: round(aim.surface) };
    return this.await(Math.max(1000, num(options.timeoutMs, 8000)));
  }

  /**
   * Stages one haul: a scripted hand grips a worker lying on the floor and lifts it, through the
   * same grip and haul code a held controller drives. Resolves once the hand has let go (or once
   * frozen, with freezeMs), saying whether the worker is back in its chair.
   */
  haul(options: StageHaulOptions): Promise<StageHaulResult> {
    const refused = this.begin();
    if (refused) return Promise.resolve({ ok: false, reason: refused });
    const w = this.hooks.worker(String(options.worker ?? ''));
    if (!w) return Promise.resolve({ ok: false, reason: `no worker named ${JSON.stringify(options.worker)} on this floor` });
    const down = this.hooks.downed(w.id);
    if (down?.state !== 'lying') return Promise.resolve({ ok: false, reason: down ? `${w.name} is ${down.state === 'falling' ? 'still falling' : 'finished off'}` : `${w.name} is not down` });
    const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    this.freezeMs = typeof options.freezeMs === 'number' && Number.isFinite(options.freezeMs) ? Math.max(0, options.freezeMs) : null;
    this.hooks.clearPanel();
    // Stand half a meter off its chest on the open floor beside it, looking down at it.
    const chest = down.chest;
    const away = down.open.clone().setY(0);
    if (away.lengthSq() < 1e-6) away.set(0, 0, 1);
    away.normalize();
    const stand = chest.clone().addScaledVector(away, 0.55);
    this.standAt(stand, away.clone().negate(), Math.atan2(-away.x, -away.z));
    this.target = w.id;
    const hold = chest.clone().addScaledVector(away, 0.05);
    hold.y += 0.06;
    this.script = new HaulScript(options.hand === 'right' ? 1 : 0, hold, Math.max(0, num(options.lift, 0.5)), Math.max(50, num(options.riseMs, 700)), Math.max(0, num(options.holdMs, 300)));
    this.hooks.controls.stage(this.script);
    this.actAt = null;
    this.result = { ok: true, worker: w.name, workerId: w.id, chest: round(chest) };
    return this.await(Math.max(1000, num(options.timeoutMs, 8000)));
  }

  /** Every shot the page resolves; only the staged one is recorded. */
  shot(report: ShotReport): void {
    if (!(this.script instanceof ShotScript) || this.actAt !== null || !this.result) return;
    this.actAt = this.hooks.now();
    Object.assign(this.result, { hit: report.workerId === this.result.workerId, struck: report.workerId, outcome: report.outcome, solid: report.solid, distance: report.distance });
    if (this.freezeMs !== null) return;
    this.wait(null);
    this.finish({ frozenAfterMs: null });
  }

  /** After each gameplay poll: freeze at the asked instant, and end the scripted hold. */
  tick(): void {
    const script = this.script;
    if (!script || this.frozen) return;
    if (script instanceof HaulScript) {
      if (this.actAt === null && script.gripped(script.last)) this.actAt = this.hooks.now();
      if (!this.hooks.controls.staging) {
        // The hand has let go and handed the controller back.
        this.script = null;
        this.wait(null);
        this.finish({ revived: this.revived(), frozenAfterMs: null });
        return;
      }
    }
    if (this.actAt === null) return;
    const since = this.hooks.now() - this.actAt;
    if (this.freezeMs !== null && since >= this.freezeMs) {
      this.frozen = true;
      // A forgotten freeze cannot strand the headset.
      this.wait(() => this.release(true), 30_000);
      this.finish({ frozenAfterMs: Math.round(since), ...(script instanceof HaulScript ? { revived: this.revived() } : {}) });
    } else if (script instanceof ShotScript && this.freezeMs === null && since >= this.holdMs) this.endScript();
  }

  /** Unfreezes, hands the controller back, and (by default) stands the staged worker back up if it is still down. */
  release(revive = true): { ok: true } {
    this.wait(null);
    this.frozen = false;
    this.endScript();
    const down = this.target === null ? null : this.hooks.downed(this.target);
    if (revive && down && down.state !== 'finished') this.hooks.revive(this.target!);
    this.finish({});
    return { ok: true };
  }

  /** Why nothing can be staged now, or null; otherwise ends anything staged before (its worker stays as it is). */
  private begin(): string | null {
    if (!this.debuggable) return 'staging needs a debuggable native build';
    if (!this.hooks.controls.active) return 'native controls are not running yet';
    this.wait(null);
    this.frozen = false;
    this.endScript();
    this.finish({});
    return this.hooks.blocked();
  }

  private await(timeoutMs: number): Promise<StageShotResult & StageHaulResult> {
    return new Promise((resolve) => {
      this.done = resolve;
      this.wait(() => this.timeout(), timeoutMs);
    });
  }

  private revived(): boolean {
    return this.target !== null && this.hooks.downed(this.target) === null;
  }

  private endScript(): void {
    const script = this.script;
    if (!script) return;
    this.script = null;
    // Only a staged gun goes away: a haul never touches a gun held in the other hand.
    if (script instanceof ShotScript) this.hooks.controls.cancelGun();
    this.hooks.controls.stage(null);
  }

  /** One pending timer at a time: the act's timeout, then a freeze's automatic release. */
  private wait(fn: (() => void) | null, ms = 0): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = fn ? setTimeout(fn, ms) : null;
  }

  private finish(extra: Partial<StageShotResult & StageHaulResult>): void {
    const done = this.done;
    const result = this.result;
    this.done = null;
    if (done) done({ ...(result ?? { ok: false }), ...extra });
  }

  private timeout(): void {
    if (!this.done || !this.result) return;
    const script = this.script;
    const started = script instanceof ShotScript ? script.fireTime !== null : script !== null && script.last !== null;
    const reason = !started
      ? 'no controller samples reached the page: is the headset awake, focused and tracking?'
      : script instanceof HaulScript
        ? 'the haul did not finish: world input blocked (workspace, fade or lost head tracking)'
        : !this.hooks.controls.holdingGun
          ? 'the scripted draw did not take: world input blocked (workspace, dialog, fade or lost head tracking)'
          : 'the trigger did not fire: world input blocked or the gun was not ready';
    this.result = { ...this.result, ok: false, reason };
    this.endScript();
    this.finish({});
  }

  /** Puts your feet on clear floor at `spot`, stepping back from it along `back` while it is blocked, facing `facing`. */
  private standAt(spot: THREE.Vector3, direction: THREE.Vector3, facing: number): void {
    const { player } = this.hooks;
    if (player.seat) player.stand();
    const back = new THREE.Vector3(direction.x, 0, direction.z).normalize().negate();
    const at = spot.clone();
    at.y = player.pos.y;
    for (let i = 0; i < 20 && player.blockedAt(at.x, at.z, at.y + 0.05); i++) at.addScaledVector(back, 0.1);
    placeAvatar(player, at);
    player.facing = facing;
    this.hooks.controls.recenter();
  }
}
