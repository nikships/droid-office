// Debug-only staging for headset captures: window.__office.stageShot and stageRevive in a
// debuggable native build (the Android host reports BuildConfig.DEBUG; a release build never
// enables them).
//
// A scripted controller stands in for one hand inside NativeControls. For a shot it grips the back
// holster, raises the gun to a pose aimed at a worker from a chosen distance and angle, and pulls
// the trigger. For a revival it reaches a free hand to a worker lying on the floor (touching it, or
// pointing at it from a step away) and pulls the trigger: the use action. The draw, the trigger,
// the grip, the shot, the casualty, the server's downed state and the effects therefore run through
// exactly the code a held controller drives. Only the input samples are scripted; the head stays
// the headset's own. A staged gun is drawn at its scripted world pose, because no real controller
// grip is under it.
//
// Every shot now starts the server's 30-second revival window, after which the worker is dismissed
// and its worktrees deleted: staged shots are refused for anyone but a practice target (a shell the
// office hired as "Target <n>", see shared/targets.ts), and release() asks the server to revive the
// staged worker. window.__office.stageTarget hires one through the office, and dismissTarget sends
// only such a worker home again.
//
// No DOM or WebGL at import time, so tests load it in Node.

import * as THREE from 'three';
import { DESK_BY_ID, DESKS } from '../../shared/layout';
import type { WorkerKind } from '../../shared/protocol';
import { isPracticeTarget } from '../../shared/targets';
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

/** What a shot did: missed every worker, shot one down (worker.shoot sent), or struck one already down. */
export type ShotOutcome = 'miss' | 'down' | 'hit';

/** What main.ts's shot resolution reports for each shot (see resolveGunShot). */
export interface ShotReport {
  workerId: string | null;
  outcome: ShotOutcome;
  /** The struck mesh's name or geometry type, if anything was struck. */
  solid: string | null;
  /** Meters from the muzzle to the strike. */
  distance: number | null;
}

export interface StageShotOptions {
  /** A worker's name (any case) or id. */
  worker: string;
  /** Meters from the muzzle to the body's surface along the bore. Default 1.2. */
  gap?: number;
  /** Degrees around the worker from straight in front of it, positive toward its left. Default 70. */
  angle?: number;
  /** Degrees the shot slopes down. By default, so the gun sits just below the headset's eye line. */
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

export interface StageReviveOptions {
  /** A worker's name (any case) or id, lying on the floor with its revival window open. */
  worker: string;
  /** Which controller is scripted. Default left (the gun hand is usually the right). */
  hand?: 'left' | 'right';
  /** Touch the body with the hand (default), or point at it from `distance` meters away. */
  how?: 'touch' | 'point';
  /** Meters from the hand to the chest when pointing. Default 1.4. */
  distance?: number;
  /** Freeze gameplay this many milliseconds after the trigger, for a still capture, until release(). */
  freezeMs?: number;
  /** How long the hand stays at the body after the trigger. Default 1200. */
  holdMs?: number;
  /** Give up after this many milliseconds. Default 8000. */
  timeoutMs?: number;
}

export interface StageReviveResult {
  ok: boolean;
  reason?: string;
  worker?: string;
  workerId?: string;
  /** The use action landed on the body: it stirred and worker.revive went out. */
  roused?: boolean;
  /** It is back up (or on its way back into its chair) by the time the script ended. */
  revived?: boolean;
  /** Milliseconds between the trigger and the frozen frame, when freezeMs was given. */
  frozenAfterMs?: number | null;
  chest?: [number, number, number];
}

/** A worker shot down, as main.ts sees it (casualties plus the server's revival window). */
export interface DownedState {
  /** Still tumbling out of its chair, lying on the floor, stirring after a hand roused it, or its window closed (the medics are coming). */
  state: 'falling' | 'lying' | 'roused' | 'closed';
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
    stage(script: ShotScript | ReviveScript | null): void;
    cancelGun(): void;
    recenter(): void;
  };
  player: Pick<PlayerController, 'pos' | 'facing' | 'vy' | 'grounded' | 'stepOffset' | 'street' | 'groundBelow' | 'blockedAt' | 'seat' | 'stand'>;
  /** A worker by name (any case) or id, with its model's root and what the office says it is. */
  worker(key: string): { id: string; name: string; root: THREE.Object3D; kind?: WorkerKind; worktree?: unknown; repos?: readonly unknown[]; meeting?: string } | null;
  /** The worker shot down, or null when it is up, getting back up, or gone. */
  downed(id: string): DownedState | null;
  /** Whether a bullet from `muzzle` along `direction` would strike worker `id` first. */
  lineOfFire?(muzzle: THREE.Vector3, direction: THREE.Vector3, id: string): boolean;
  /** Why world input is unavailable (on the roof, mid-trip, climbing...), or null. */
  blocked(): string | null;
  /** Where the headset's eyes are in the world, if known (the page camera follows them). */
  eye(): THREE.Vector3 | null;
  /** Shuts the workspace and its windows so world input is live. */
  clearPanel(): void;
  /** Asks the server to revive a worker shot down (worker.revive), while its window is open. */
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

/** When each step of a scripted revival happens, in sample-clock milliseconds from its first sample. */
export const REVIVE_TIMING = {
  /** The hand arrives at the body (or its aim), and holds still. */
  reach: 300,
  /** The trigger pull, and how long it stays pulled. */
  fire: 600,
  pull: 120,
} as const;

/**
 * The scripted free hand for a revival: it moves to `at` (world) pointing at `target`, pulls the
 * trigger, stays `holdMs`, and is handed back. sample() returns null once it is over.
 */
export class ReviveScript {
  private start: number | null = null;
  private from = new THREE.Vector3();
  private local = new THREE.Vector3();
  private aimLocal = new THREE.Quaternion();
  private inverse = new THREE.Matrix4();

  /** The last sample time seen. */
  last: number | null = null;

  constructor(
    readonly hand: 0 | 1,
    private at: THREE.Vector3,
    private target: THREE.Vector3,
    private holdMs: number,
  ) {}

  /** Sample-clock time of the scripted trigger pull, once the script has started. */
  get fireTime(): number | null {
    return this.start === null ? null : this.start + REVIVE_TIMING.fire;
  }

  sample(time: number, head: Pose7, rig: THREE.Matrix4): NativeHand | null {
    if (this.start === null) {
      this.start = time;
      // From a relaxed spot in front of the chest, wherever the head is then.
      this.from.set(head[0], head[1] - 0.45, head[2]);
    }
    this.last = time;
    const t = time - this.start;
    if (t > REVIVE_TIMING.fire + REVIVE_TIMING.pull + this.holdMs) return null;
    this.inverse.copy(rig).invert();
    this.local.copy(this.at).applyMatrix4(this.inverse);
    const k = THREE.MathUtils.clamp(t / REVIVE_TIMING.reach, 0, 1);
    _p.lerpVectors(this.from, this.local, k * k * (3 - 2 * k));
    // The pointing ray (-Z) runs from the hand to the target.
    _v.copy(this.target).applyMatrix4(this.inverse).sub(this.local);
    if (_v.lengthSq() < 1e-8) _v.set(0, -1, 0);
    _v.normalize();
    _m.lookAt(_o.set(0, 0, 0), _v, Math.abs(_v.y) > 0.99 ? _z : UP);
    this.aimLocal.setFromRotationMatrix(_m);
    const pose: Pose7 = [_p.x, _p.y, _p.z, this.aimLocal.x, this.aimLocal.y, this.aimLocal.z, this.aimLocal.w];
    const pulled = t >= REVIVE_TIMING.fire && t < REVIVE_TIMING.fire + REVIVE_TIMING.pull;
    return {
      active: true,
      aim: pose,
      grip: [...pose],
      gripTracked: true,
      trigger: pulled ? 1 : 0,
      squeeze: 0,
      stick: [0, 0],
      a: false,
      b: false,
      menu: false,
      ui: false,
      stickClick: false,
    };
  }
}

const _v = new THREE.Vector3();
const _o = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _m = new THREE.Matrix4();

/**
 * window.__office.stageShot's and stageRevive's engine: one staged act at a time. The page reports
 * every shot (shot()) and each gameplay poll (tick()); a frozen stage tells the page to stop
 * advancing gameplay, so the headset keeps drawing that instant until release(). The server's
 * revival window keeps running meanwhile, so a forgotten freeze releases itself (and asks for the
 * revival) well inside it.
 */
export class ShotStage {
  /** Set from the Android host's frame call; a release build never sets it. */
  debuggable = false;
  frozen = false;
  private script: ShotScript | ReviveScript | null = null;
  /** The worker the latest staged act was at, revived by release(). */
  private target: string | null = null;
  private freezeMs: number | null = null;
  private holdMs = 0;
  private result: (StageShotResult & StageReviveResult) | null = null;
  /** performance-clock time of the staged shot, or of the staged revival's trigger. */
  private actAt: number | null = null;
  private done: ((r: StageShotResult & StageReviveResult) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private hooks: ShotStageHooks) {}

  /** Stages, fires and reports one shot; resolves once it has fired (and frozen, with freezeMs). */
  run(options: StageShotOptions): Promise<StageShotResult> {
    const refused = this.begin();
    if (refused) return Promise.resolve({ ok: false, reason: refused });
    const w = this.hooks.worker(String(options.worker ?? ''));
    if (!w) return Promise.resolve({ ok: false, reason: `no worker named ${JSON.stringify(options.worker)} on this floor` });
    // Every shot starts the server's dismissal clock: only practice targets may be staged.
    if (!isPracticeTarget(w)) return Promise.resolve({ ok: false, reason: `staged shots hit only practice targets (stageTarget hires one), not ${w.name}: a shot dismisses a worker and deletes its worktrees 30 s later unless revived` });
    if (this.hooks.downed(w.id)) return Promise.resolve({ ok: false, reason: `${w.name} is already down: stageRevive revives it` });
    const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    const gap = num(options.gap, 1.2);
    const reach = THREE.MathUtils.clamp(num(options.reach, 0.42), 0.2, 3);
    const height = num(options.height, 0.62);
    w.root.updateWorldMatrix(true, true);
    const target = w.root.localToWorld(new THREE.Vector3(0, height, 0));
    // A seated worker is circled from its face.
    const facing = new THREE.Vector3(0, 0, 1).transformDirection(w.root.matrixWorld);
    // Slope the shot so the gun rides just under the headset's eye line, whatever its real height.
    const eye = this.hooks.eye();
    const level = eye ? THREE.MathUtils.radToDeg(Math.atan2(eye.y - 0.18 - target.y, reach + MUZZLE_AT.z + Math.max(gap, 0) + 0.2)) : 15;
    // Without an asked angle or slope, the first approach with a clear line to the worker.
    const angles = typeof options.angle === 'number' && Number.isFinite(options.angle) ? [options.angle] : [70, 40, 100, -70, -40, -100, 15];
    const pitches = typeof options.pitch === 'number' && Number.isFinite(options.pitch) ? [options.pitch] : [Math.round(THREE.MathUtils.clamp(level, -10, 60))];
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
   * Stages one revival: a scripted free hand reaches a worker lying on the floor (touching its
   * chest, or pointing at it from a step away) and pulls the trigger, through the same use action
   * a held controller drives. Resolves once the hand is handed back (or once frozen, with
   * freezeMs), saying whether it roused the body and whether the worker is back up.
   */
  revive(options: StageReviveOptions): Promise<StageReviveResult> {
    const refused = this.begin();
    if (refused) return Promise.resolve({ ok: false, reason: refused });
    const w = this.hooks.worker(String(options.worker ?? ''));
    if (!w) return Promise.resolve({ ok: false, reason: `no worker named ${JSON.stringify(options.worker)} on this floor` });
    const down = this.hooks.downed(w.id);
    if (down?.state !== 'lying')
      return Promise.resolve({ ok: false, reason: down ? `${w.name} is ${down.state === 'falling' ? 'still falling' : down.state === 'roused' ? 'already stirring' : 'past its revival window'}` : `${w.name} is not down` });
    const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    this.freezeMs = typeof options.freezeMs === 'number' && Number.isFinite(options.freezeMs) ? Math.max(0, options.freezeMs) : null;
    this.hooks.clearPanel();
    const chest = down.chest;
    const away = down.open.clone().setY(0);
    if (away.lengthSq() < 1e-6) away.set(0, 0, 1);
    away.normalize();
    const point = options.how === 'point';
    // Stand on the open floor beside it, looking down at it: close enough to touch, or a step back to point.
    const distance = THREE.MathUtils.clamp(num(options.distance, 1.4), 0.5, 2.2);
    const stand = chest.clone().addScaledVector(away, point ? distance + 0.25 : 0.55);
    this.standAt(stand, away.clone().negate(), Math.atan2(-away.x, -away.z));
    this.target = w.id;
    const hand = chest.clone().addScaledVector(away, point ? distance : 0.05);
    hand.y = point ? Math.max(chest.y + 0.75, 0.9) : chest.y + 0.08;
    this.script = new ReviveScript(options.hand === 'right' ? 1 : 0, hand, chest, Math.max(0, num(options.holdMs, 1200)));
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
    if (script instanceof ReviveScript) {
      const fired = script.fireTime;
      if (this.actAt === null && fired !== null && script.last !== null && script.last >= fired) this.actAt = this.hooks.now();
      if (!this.hooks.controls.staging) {
        // The hand has been handed back.
        this.script = null;
        this.wait(null);
        this.finish({ ...this.revived(), frozenAfterMs: null });
        return;
      }
    }
    if (this.actAt === null) return;
    const since = this.hooks.now() - this.actAt;
    if (this.freezeMs !== null && since >= this.freezeMs) {
      this.frozen = true;
      // A forgotten freeze cannot strand the headset, or let the revival window close under it.
      this.wait(() => this.release(true), 15_000);
      this.finish({ frozenAfterMs: Math.round(since), ...(script instanceof ReviveScript ? this.revived() : {}) });
    } else if (script instanceof ShotScript && this.freezeMs === null && since >= this.holdMs) this.endScript();
  }

  /** Unfreezes, hands the controller back, and (by default) asks the server to revive the staged worker if it is still down. */
  release(revive = true): { ok: true } {
    this.wait(null);
    this.frozen = false;
    this.endScript();
    const down = this.target === null ? null : this.hooks.downed(this.target);
    if (revive && down && down.state !== 'closed') this.hooks.revive(this.target!);
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

  private await(timeoutMs: number): Promise<StageShotResult & StageReviveResult> {
    return new Promise((resolve) => {
      this.done = resolve;
      this.wait(() => this.timeout(), timeoutMs);
    });
  }

  /** Whether the staged revival roused its worker, and whether it is no longer down. */
  private revived(): { roused: boolean; revived: boolean } {
    const down = this.target === null ? null : this.hooks.downed(this.target);
    return { roused: down === null || down.state === 'roused', revived: down === null };
  }

  private endScript(): void {
    const script = this.script;
    if (!script) return;
    this.script = null;
    // Only a staged gun goes away: a revival never touches a gun held in the other hand.
    if (script instanceof ShotScript) this.hooks.controls.cancelGun();
    this.hooks.controls.stage(null);
  }

  /** One pending timer at a time: the act's timeout, then a freeze's automatic release. */
  private wait(fn: (() => void) | null, ms = 0): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = fn ? setTimeout(fn, ms) : null;
  }

  private finish(extra: Partial<StageShotResult & StageReviveResult>): void {
    const done = this.done;
    const result = this.result;
    this.done = null;
    if (done) done({ ...(result ?? { ok: false }), ...extra });
  }

  private timeout(): void {
    if (!this.done || !this.result) return;
    const script = this.script;
    const started = script !== null && script.fireTime !== null;
    const reason = !started
      ? 'no controller samples reached the page: is the headset awake, focused and tracking?'
      : script instanceof ReviveScript
        ? 'the revival did not finish: world input blocked (workspace, fade or lost head tracking)'
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

/** A worker on this floor, as the office describes it (WorkerInfo). */
export interface CrewMember {
  id: string;
  name: string;
  kind: WorkerKind;
  deskId: string;
  worktree?: unknown;
  repos?: readonly unknown[];
  meeting?: string;
  /** The office's revival deadline (office-clock ms), while it is shot down. */
  downedUntil?: number;
}

/** What TargetStage needs from main.ts: the floor's workers, the office's answers and two messages to it. */
export interface TargetStageHooks {
  /** Every worker on this floor. */
  crew(): readonly CrewMember[];
  /** Whether a seat is in use: a worker there, or one sent home still packing up there. */
  taken(deskId: string): boolean;
  /** Where you stand on this floor. */
  you(): { x: number; z: number };
  /** Whether the worker's figure is in the scene, so a staged shot can find it. */
  present(id: string): boolean;
  /** Asks the office for a practice target at a desk (worker.spawn with kind shell and target). */
  hire(deskId: string): void;
  /** Asks the office to send a worker home (worker.kill). */
  sendHome(id: string): void;
  /** The office's clock, for revival deadlines. */
  officeNow(): number;
  /** The latest message the office showed, to say why it refused. */
  lastToast(): string;
}

export interface StageTargetOptions {
  /** The free desk (or bean bag) to seat it at. Default: the free desk farthest from every other worker on the floor. */
  desk?: string;
  /** Give up after this many milliseconds. Default 8000. */
  timeoutMs?: number;
}

export interface StageTargetResult {
  ok: boolean;
  reason?: string;
  /** Its name, as the office gave it ("Target 1 🐚"). */
  worker?: string;
  workerId?: string;
  desk?: string;
  /** Meters to the nearest other worker on the floor (null: nobody else is here). */
  clearance?: number | null;
}

export interface StageDismissResult {
  ok: boolean;
  reason?: string;
  worker?: string;
  workerId?: string;
  /** The office has taken it off the floor. */
  gone?: boolean;
}

/**
 * The free desk for a practice target: the one farthest from every other worker on the floor, so
 * a bore aimed at it crosses nobody else; between equally clear desks, the one nearest you.
 */
export function pickTargetDesk(free: readonly { id: string; x: number; z: number }[], others: readonly { x: number; z: number }[], you: { x: number; z: number }): { id: string; clearance: number | null } | null {
  let best: { id: string; clearance: number; near: number } | null = null;
  for (const d of free) {
    // With nobody else on the floor every desk is as clear as the next.
    const clearance = others.length ? Math.min(...others.map((o) => Math.hypot(o.x - d.x, o.z - d.z))) : 0;
    const near = Math.hypot(you.x - d.x, you.z - d.z);
    if (best === null || clearance > best.clearance + 0.01 || (clearance > best.clearance - 0.01 && near < best.near)) best = { id: d.id, clearance, near };
  }
  return best && { id: best.id, clearance: others.length ? Math.round(best.clearance * 100) / 100 : null };
}

/**
 * window.__office.stageTarget's and dismissTarget's engine (debuggable builds only): hires a
 * practice target through the office for a staged shot, and sends one home again afterwards. It
 * never sends anyone else home, and never one lying shot within its revival window.
 */
export class TargetStage {
  /** Set from the Android host's frame call; a release build never sets it. */
  debuggable = false;

  constructor(
    private hooks: TargetStageHooks,
    private pollMs = 100,
  ) {}

  /** Hires a practice target at a free desk and resolves once it sits there, ready to be shot. */
  hire(options: StageTargetOptions = {}): Promise<StageTargetResult> {
    if (!this.debuggable) return Promise.resolve({ ok: false, reason: 'staging needs a debuggable native build' });
    const crew = this.hooks.crew();
    let free = DESKS.filter((d) => !this.hooks.taken(d.id));
    if (options.desk !== undefined) {
      const seat = DESK_BY_ID.get(String(options.desk));
      if (!seat || seat.station || seat.room) return Promise.resolve({ ok: false, reason: `${JSON.stringify(options.desk)} is not a desk or a bean bag` });
      if (this.hooks.taken(seat.id)) return Promise.resolve({ ok: false, reason: `${seat.id} is taken` });
      free = [seat];
    }
    const others = crew.flatMap((w) => DESK_BY_ID.get(w.deskId) ?? []);
    const picked = pickTargetDesk(free, others, this.hooks.you());
    if (!picked) return Promise.resolve({ ok: false, reason: 'every desk on this floor is taken' });
    const { id: desk, clearance } = picked;
    const before = new Set(crew.map((w) => w.id));
    const toast = this.hooks.lastToast();
    this.hooks.hire(desk);
    return this.until<StageTargetResult>(
      options.timeoutMs,
      () => {
        const there = this.hooks.crew().find((w) => w.deskId === desk && !before.has(w.id));
        if (!there) return null;
        if (!isPracticeTarget(there)) return { ok: false, reason: `${there.name} took ${desk} first` };
        if (!this.hooks.present(there.id)) return null;
        return { ok: true, worker: there.name, workerId: there.id, desk, clearance };
      },
      () => {
        const said = this.hooks.lastToast();
        return { ok: false, desk, reason: `the office did not seat a practice target at ${desk}${said && said !== toast ? `: ${said}` : ''}` };
      },
    );
  }

  /** Sends a practice target home, and resolves once the office has taken it off the floor. */
  dismiss(key: string, options: { timeoutMs?: number } = {}): Promise<StageDismissResult> {
    if (!this.debuggable) return Promise.resolve({ ok: false, reason: 'staging needs a debuggable native build' });
    const w = matchWorker(String(key ?? ''), this.hooks.crew());
    if (!w) return Promise.resolve({ ok: false, reason: `no worker named ${JSON.stringify(key)} on this floor` });
    if (!isPracticeTarget(w)) return Promise.resolve({ ok: false, reason: `dismissTarget sends home only practice targets, not ${w.name}` });
    const named = { worker: w.name, workerId: w.id };
    if (w.downedUntil !== undefined) {
      if (w.downedUntil > this.hooks.officeNow()) return Promise.resolve({ ok: false, ...named, reason: `${w.name} is shot down with its revival window open: revive it first (releaseShot() or stageRevive)` });
      // Its window has closed: the office is dismissing it already, and the medics collect it.
      return this.until<StageDismissResult>(
        options.timeoutMs,
        () => (this.hooks.crew().some((c) => c.id === w.id) ? null : { ok: true, ...named, gone: true }),
        () => ({ ok: false, ...named, reason: 'its revival window closed and the office is still dismissing it' }),
      );
    }
    this.hooks.sendHome(w.id);
    return this.until<StageDismissResult>(
      options.timeoutMs,
      () => (this.hooks.crew().some((c) => c.id === w.id) ? null : { ok: true, ...named, gone: true }),
      () => ({ ok: false, ...named, reason: `the office has not sent ${w.name} home yet: ${this.hooks.lastToast()}` }),
    );
  }

  /** Polls `check` until it answers or the time is up. */
  private until<R>(timeoutMs: number | undefined, check: () => R | null, timedOut: () => R): Promise<R> {
    const limit = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? Math.max(500, timeoutMs) : 8000;
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const answer = check();
        if (answer === null && Date.now() - started < limit) return;
        clearInterval(timer);
        resolve(answer ?? timedOut());
      }, this.pollMs);
    });
  }
}
