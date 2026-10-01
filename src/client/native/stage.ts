// Debug-only shot staging for headset captures: window.__office.stageShot in a debuggable native
// build (the Android host reports BuildConfig.DEBUG; a release build never enables it).
//
// A scripted controller stands in for one hand inside NativeControls: it grips the back holster,
// raises the gun to a pose aimed at a worker from a chosen distance and angle, and pulls the
// trigger. The draw, the trigger, the shot trace, the casualty and the effects therefore run
// through exactly the code a held controller drives. Only the input samples are scripted; the
// head stays the headset's own. The staged gun is drawn at its scripted world pose, because no
// real controller grip is under it. No DOM or WebGL at import time, so tests load it in Node.

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

/** What main.ts's shot resolution reports for each shot (see resolveGunShot). */
export interface ShotReport {
  workerId: string | null;
  buried: boolean;
  /** The struck mesh's name or geometry type, if anything was struck. */
  solid: string | null;
  /** Meters along the traced bore to the strike. */
  distance: number | null;
}

export interface StageShotOptions {
  /** A worker's name (any case) or id. */
  worker: string;
  /** Meters from the muzzle to the body's surface along the bore; negative presses it in. Default 0.03. */
  gap?: number;
  /** Degrees around the worker from straight in front of it, positive toward its left. Default 70. */
  angle?: number;
  /** Degrees the shot slopes down. By default, so the gun sits just below the headset's eye line. */
  pitch?: number;
  /** Horizontal meters from the shooter's feet (under the headset) back from the gun's fist. Default 0.42. */
  reach?: number;
  /** Where on the worker to aim, in meters up its own body. Default 0.62 (its middle). */
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
  buried?: boolean;
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

/** What ShotStage needs from main.ts and NativeControls. */
export interface ShotStageHooks {
  controls: {
    readonly active: boolean;
    readonly holdingGun: boolean;
    readonly staging: boolean;
    stage(script: ShotScript | null): void;
    cancelGun(): void;
    recenter(): void;
  };
  player: Pick<PlayerController, 'pos' | 'facing' | 'vy' | 'grounded' | 'stepOffset' | 'street' | 'groundBelow' | 'blockedAt' | 'seat' | 'stand'>;
  /** A worker by name (any case) or id, with its model's root. */
  worker(key: string): { id: string; name: string; root: THREE.Object3D } | null;
  /** Why world input is unavailable (on the roof, mid-trip, a body awaiting its dialog...), or null. */
  blocked(): string | null;
  /** Where the headset's eyes are in the world, if known (the page camera follows them). */
  eye(): THREE.Vector3 | null;
  /** Shuts the workspace and its windows so world input is live. */
  clearPanel(): void;
  /** Quietly stands a shot worker back up in its seat, closing its dialog. */
  revive(): void;
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

/**
 * window.__office.stageShot's engine: one staged shot at a time. The page reports every shot
 * (shot()) and each gameplay poll (tick()); a frozen stage tells the page to stop advancing
 * gameplay, so the headset keeps drawing that instant until release().
 */
export class ShotStage {
  /** Set from the Android host's frame call; a release build never sets it. */
  debuggable = false;
  frozen = false;
  private script: ShotScript | null = null;
  private opts: Required<Omit<StageShotOptions, 'freezeMs'>> & { freezeMs: number | null } = { worker: '', gap: 0, angle: 0, pitch: 0, reach: 0, height: 0, hand: 'right', holdMs: 0, timeoutMs: 0, freezeMs: null };
  private result: StageShotResult = { ok: false };
  private shotAt: number | null = null;
  private done: ((r: StageShotResult) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private hooks: ShotStageHooks) {}

  /** Stages, fires and reports one shot; resolves once it has fired (and frozen, with freezeMs). */
  run(options: StageShotOptions): Promise<StageShotResult> {
    if (!this.debuggable) return Promise.resolve({ ok: false, reason: 'shot staging needs a debuggable native build' });
    const { controls } = this.hooks;
    if (!controls.active) return Promise.resolve({ ok: false, reason: 'native controls are not running yet' });
    this.release(true);
    const blocked = this.hooks.blocked();
    if (blocked) return Promise.resolve({ ok: false, reason: blocked });
    const w = this.hooks.worker(String(options.worker ?? ''));
    if (!w) return Promise.resolve({ ok: false, reason: `no worker named ${JSON.stringify(options.worker)} on this floor` });
    const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    const gap = num(options.gap, 0.03);
    const reach = THREE.MathUtils.clamp(num(options.reach, 0.42), 0.2, 3);
    const height = num(options.height, 0.62);
    w.root.updateWorldMatrix(true, true);
    const target = w.root.localToWorld(new THREE.Vector3(0, height, 0));
    // Slope the shot so the gun rides just under the headset's eye line, whatever its real height.
    const eye = this.hooks.eye();
    const level = eye ? THREE.MathUtils.radToDeg(Math.atan2(eye.y - 0.18 - target.y, reach + MUZZLE_AT.z + Math.max(gap, 0) + 0.2)) : 15;
    this.opts = {
      worker: w.name,
      gap,
      angle: num(options.angle, 70),
      pitch: num(options.pitch, Math.round(THREE.MathUtils.clamp(level, -10, 60))),
      reach,
      height,
      hand: options.hand === 'left' ? 'left' : 'right',
      holdMs: Math.max(0, num(options.holdMs, 1500)),
      timeoutMs: Math.max(1000, num(options.timeoutMs, 8000)),
      freezeMs: typeof options.freezeMs === 'number' && Number.isFinite(options.freezeMs) ? Math.max(0, options.freezeMs) : null,
    };
    this.hooks.clearPanel();
    const aim = stageAim({
      target,
      body: w.root,
      facing: new THREE.Vector3(0, 0, 1).transformDirection(w.root.matrixWorld),
      angle: THREE.MathUtils.degToRad(this.opts.angle),
      pitch: THREE.MathUtils.degToRad(this.opts.pitch),
      gap,
      reach,
    });
    this.standAt(aim);
    controls.recenter();
    this.script = new ShotScript(this.opts.hand === 'left' ? 0 : 1, aim);
    controls.stage(this.script);
    this.shotAt = null;
    this.result = { ok: true, worker: w.name, workerId: w.id, gap: this.opts.gap, angle: this.opts.angle, pitch: this.opts.pitch, muzzle: round(aim.muzzle), surface: round(aim.surface) };
    return new Promise((resolve) => {
      this.done = resolve;
      this.wait(() => this.timeout(), this.opts.timeoutMs);
    });
  }

  /** Every shot the page resolves; only the staged one is recorded. */
  shot(report: ShotReport): void {
    if (!this.script || this.shotAt !== null) return;
    this.shotAt = this.hooks.now();
    Object.assign(this.result, { hit: report.workerId === this.result.workerId, struck: report.workerId, buried: report.buried, solid: report.solid, distance: report.distance });
    if (this.opts.freezeMs !== null) return;
    this.wait(null);
    this.finish({ frozenAfterMs: null });
  }

  /** After each gameplay poll: freeze at the asked instant, and end the scripted hold. */
  tick(): void {
    if (!this.script || this.shotAt === null || this.frozen) return;
    const since = this.hooks.now() - this.shotAt;
    if (this.opts.freezeMs !== null && since >= this.opts.freezeMs) {
      this.frozen = true;
      // A forgotten freeze cannot strand the headset.
      this.wait(() => this.release(true), 30_000);
      this.finish({ frozenAfterMs: Math.round(since) });
    } else if (this.opts.freezeMs === null && since >= this.opts.holdMs) this.endScript();
  }

  /** Unfreezes, hands the controller back, and (by default) stands any shot worker back up. */
  release(revive = true): { ok: true } {
    this.wait(null);
    this.frozen = false;
    this.endScript();
    if (revive) this.hooks.revive();
    this.finish({});
    return { ok: true };
  }

  private endScript(): void {
    if (!this.script) return;
    this.script = null;
    this.hooks.controls.cancelGun();
    this.hooks.controls.stage(null);
  }

  /** One pending timer at a time: the shot's timeout, then a freeze's automatic release. */
  private wait(fn: (() => void) | null, ms = 0): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = fn ? setTimeout(fn, ms) : null;
  }

  private finish(extra: Partial<StageShotResult>): void {
    const done = this.done;
    this.done = null;
    done?.({ ...this.result, ...extra });
  }

  private timeout(): void {
    if (!this.done) return;
    const script = this.script;
    const reason =
      script?.fireTime === null
        ? 'no controller samples reached the page: is the headset awake, focused and tracking?'
        : !this.hooks.controls.holdingGun
          ? 'the scripted draw did not take: world input blocked (workspace, dialog, fade or lost head tracking)'
          : 'the trigger did not fire: world input blocked or the gun was not ready';
    this.result = { ...this.result, ok: false, reason };
    this.endScript();
    this.finish({});
  }

  /** Puts the shooter's feet on clear floor behind the staged gun, facing along the shot. */
  private standAt(aim: StageAim): void {
    const { player } = this.hooks;
    if (player.seat) player.stand();
    const back = new THREE.Vector3(aim.direction.x, 0, aim.direction.z).normalize().negate();
    const spot = aim.stand.clone();
    spot.y = player.pos.y;
    for (let i = 0; i < 20 && player.blockedAt(spot.x, spot.z, spot.y + 0.05); i++) spot.addScaledVector(back, 0.1);
    placeAvatar(player, spot);
    player.facing = aim.facing;
  }
}
