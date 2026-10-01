// Debug-only capture puppet (`window.__office.puppet` in the headset app): synthetic motion
// controllers for headless captures.
//
// Physical controllers are not tracked while nobody holds them, so a headset lying on a desk shows
// no controllers, no held gun and no hand at a button. The page describes puppet hands here and
// sends them with its control packet; the native host (native/android/.../capture_puppet.h) fills
// each controller slot the runtime reports as untracked with them, in the display loop, before the
// controller models, rays, button animation, attachments and the page's own input samples read the
// frame. So the game sees tracked controllers and every interaction (drawing and firing the gun,
// grabbing, buttons, climbing) runs through the real input paths. A tracked controller always wins.
//
// Only debug builds accept it: native needs its OFFICE_CAPTURE_PUPPET build and the Java host's
// BuildConfig.DEBUG, and says so in the frame events (`puppet: true`). Until then the API reports
// `available: false` and refuses to stage anything. Captures that use it are synthetic input.

import * as THREE from 'three';
import type { Pose7 } from './input';

/**
 * Where a hand's poses are given. `local` is the native LOCAL_FLOOR space; `head` is relative to
 * the current head pose (x right, y up, -z ahead of the eyes); `heading` is relative to the head
 * position and its horizontal heading only (gravity up), for poses such as a back holster that head
 * pitch must not move; `world` is office world space, kept at that world point when the rig moves.
 * Native composes `head` and `heading` with each display frame's head pose.
 */
export type PuppetSpace = 'local' | 'head' | 'heading' | 'world';
type WireSpace = 'local' | 'head' | 'heading';

const SPACES: readonly PuppetSpace[] = ['local', 'head', 'heading', 'world'];

/**
 * The controller's grip -Z points this far (radians, about the aim's +X) above its pointing ray: the
 * pitch that reproduced the worn capture's upward gun barrel (docs/vr-native-controller-interactions.md).
 * A hand given only an aim gets grip = aim · rotateX(GRIP_PITCH), and the other way round.
 */
export const GRIP_PITCH = 1.15;
/** Limits that match the native parser (bridge_state.cpp). */
const MAX_COORD = 1000;

/** One hand as the caller describes it. Every field is optional in update() and script steps. */
export interface PuppetHandSpec {
  space?: PuppetSpace;
  /** Grip position [x, y, z], or a full pose [x, y, z, qx, qy, qz, qw], in `space`. */
  grip?: readonly number[];
  /** Aim (pointing ray) position, or a full pose, in `space`. Its position defaults to the grip's. */
  aim?: readonly number[];
  /** A point in `space` the aim ray (-Z) points at. */
  aimAt?: readonly number[];
  /** 0..1 */
  trigger?: number;
  /** 0..1 (grip button) */
  squeeze?: number;
  /** OpenXR convention: +x right, +y forward; -1..1. */
  stick?: readonly number[];
  /** A on the right controller, X on the left. */
  a?: boolean;
  /** B on the right controller, Y on the left. */
  b?: boolean;
  /** Left Menu toggles the workspace; the right one belongs to Android XR. */
  menu?: boolean;
  stickClick?: boolean;
}

/** A resolved hand: both poses in `space`, every input explicit. */
export interface PuppetHand {
  space: PuppetSpace;
  grip: Pose7;
  aim: Pose7;
  trigger: number;
  squeeze: number;
  stick: [number, number];
  a: boolean;
  b: boolean;
  menu: boolean;
  stickClick: boolean;
}

/** One hand of the control packet's `puppet` field, which native reads (bridge_state.cpp). */
export interface PuppetWireHand extends Omit<PuppetHand, 'space'> {
  space: WireSpace;
}

export interface PuppetPacket {
  v: 1;
  hands: [PuppetWireHand | null, PuppetWireHand | null];
}

export interface PuppetHands {
  /** A spec stages that hand, null removes it, undefined leaves it as it is (update and steps). */
  left?: PuppetHandSpec | null;
  right?: PuppetHandSpec | null;
}

export interface PuppetStep extends PuppetHands {
  /** Milliseconds after the script started. */
  at?: number;
  /** Milliseconds after the previous step (default 0). Ignored when `at` is given. */
  after?: number;
  /** Move the poses (and trigger, squeeze, stick) from where they are to this step's over this many ms. */
  over?: number;
  /** Runs right before the step applies: true continues; false or a reason stops the script there. */
  check?: () => boolean | string;
  label?: string;
}

export interface PuppetScriptResult {
  ok: boolean;
  /** Why the script stopped early: a check's reason, 'cancelled', 'timeout' or 'unavailable'. */
  reason?: string;
  /** The step that stopped it. */
  step?: number;
  /** When each step actually applied (ms after the script started; the page sends at about 30 Hz). */
  applied: { step: number; label?: string; atMs: number }[];
}

/** Who staged the puppet: a capture is labelled with every staging since the puppet appeared. */
export interface PuppetStaging {
  /** E.g. `scene.mjs puppet hold-gun-right`; `__office.puppet.update` when the caller gave none. */
  label: string;
  /** ISO time of the call. */
  at: string;
}

/** Optional on set, update and script: what is staging the puppet, for capture labels. */
export interface PuppetCallOptions {
  label?: string;
}

/** The most staging calls a report keeps (the first one and the latest ones). */
const MAX_STAGINGS = 12;
const MAX_LABEL = 120;

export interface PuppetReport {
  /** The native host accepts a puppet (a debug build). */
  available: boolean;
  /** Some hand is staged. Every capture taken now shows synthetic input. */
  active: boolean;
  /** The latest staging call's label, or null while nothing is staged. */
  label: string | null;
  /** Every staging call since the puppet appeared, oldest first (at most MAX_STAGINGS). */
  staging: PuppetStaging[];
  hands: { left: PuppetHand | null; right: PuppetHand | null };
  /** Which slots native reported as driven by the puppet in its latest sample (a tracked controller wins). */
  driven: { left: boolean; right: boolean };
  script: { step: number; of: number; label?: string } | null;
  /** When the current staging began (ISO time), for labelling captures. */
  since: string | null;
}

/** The page's view of the rig and the head, from NativeControls. */
export interface PuppetEnv {
  /** The latest native head pose in LOCAL_FLOOR, or null before the first sample. */
  head(): Pose7 | null;
  /** World from LOCAL_FLOOR (the rig's world matrix), or null while native controls are off. */
  rig(): THREE.Matrix4 | null;
}

export interface PuppetApi {
  readonly available: boolean;
  /** Replaces the whole puppet: hands not given are removed. Stops a running script. */
  set(hands: PuppetHands, options?: PuppetCallOptions): PuppetReport;
  /** Changes only what is given, e.g. `update({ right: { trigger: 1 } })`. A running script keeps going. */
  update(hands: PuppetHands, options?: PuppetCallOptions): PuppetReport;
  /** Removes both hands and stops a running script: the controllers go back to the runtime's. */
  clear(): PuppetReport;
  /** Plays timed steps; resolves when the last one has been sent (and its `over` move finished). */
  script(steps: readonly PuppetStep[], options?: PuppetCallOptions & { timeoutMs?: number }): Promise<PuppetScriptResult>;
  state(): PuppetReport;
}

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _r = new THREE.Quaternion();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const GRIP_FROM_AIM = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), GRIP_PITCH);
const AIM_FROM_GRIP = GRIP_FROM_AIM.clone().invert();

function fail(message: string): never {
  throw new Error(`capture puppet: ${message}`);
}

/** The caller's label, or `fallback` (the API call) when it gave none. */
function stagingLabel(options: PuppetCallOptions | undefined, fallback: string): string {
  const label = options?.label;
  if (label === undefined) return fallback;
  if (typeof label !== 'string' || !label.trim()) fail('label must be a non-empty string');
  return label.trim().slice(0, MAX_LABEL);
}

function num(v: unknown, what: string, limit = MAX_COORD): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > limit) fail(`${what} must be a finite number within ±${limit}`);
  return v;
}

function vec3(v: readonly number[], what: string): THREE.Vector3 {
  if (!Array.isArray(v) || (v.length !== 3 && v.length !== 7)) fail(`${what} must be [x, y, z] or [x, y, z, qx, qy, qz, qw]`);
  return new THREE.Vector3(num(v[0], what), num(v[1], what), num(v[2], what));
}

function quatOf(v: readonly number[], what: string): THREE.Quaternion | null {
  if (v.length !== 7) return null;
  const q = new THREE.Quaternion(num(v[3], what, 2), num(v[4], what, 2), num(v[5], what, 2), num(v[6], what, 2));
  if (q.length() < 0.5 || q.length() > 1.5) fail(`${what} orientation must be a unit quaternion`);
  return q.normalize();
}

function pose7(p: THREE.Vector3, q: THREE.Quaternion): Pose7 {
  return [p.x, p.y, p.z, q.x, q.y, q.z, q.w];
}

function position(p: Pose7): THREE.Vector3 {
  return new THREE.Vector3(p[0], p[1], p[2]);
}

function rotation(p: Pose7): THREE.Quaternion {
  return new THREE.Quaternion(p[3], p[4], p[5], p[6]);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** An orientation whose -Z points from `from` at `to` (+Y up where possible). */
export function lookRotation(from: THREE.Vector3, to: THREE.Vector3): THREE.Quaternion {
  if (from.distanceToSquared(to) < 1e-8) fail('aimAt must be away from the aim position');
  return new THREE.Quaternion().setFromRotationMatrix(_m.lookAt(from, to, UP));
}

/** The head's horizontal heading as a yaw-only rotation (native headingPose, capture_puppet.h). */
export function headingRotation(head: THREE.Quaternion): THREE.Quaternion {
  const forward = _v.set(0, 0, -1).applyQuaternion(head);
  if (forward.x * forward.x + forward.z * forward.z < 0.0025) {
    const up = _w.set(0, 1, 0).applyQuaternion(head);
    forward.copy(forward.y < 0 ? up : up.negate());
  }
  return new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(-forward.x, -forward.z));
}

/** Merges a spec into a hand (or makes a new one). Throws on anything native would reject. */
export function resolveHand(spec: PuppetHandSpec, previous: PuppetHand | null): PuppetHand {
  if (!spec || typeof spec !== 'object') fail('a hand must be an object');
  const space = spec.space ?? previous?.space ?? 'head';
  if (!SPACES.includes(space)) fail(`space must be one of ${SPACES.join(', ')}`);
  const posed = spec.grip !== undefined || spec.aim !== undefined || spec.aimAt !== undefined;
  if (previous && previous.space !== space && !posed) fail(`moving a hand to ${space} space needs its grip, aim or aimAt in that space`);
  const base = previous && previous.space === space ? previous : null;
  const gripGiven = spec.grip !== undefined ? vec3(spec.grip, 'grip') : null;
  const aimGiven = spec.aim !== undefined ? vec3(spec.aim, 'aim') : null;
  const gripPos = gripGiven ?? aimGiven ?? (base ? position(base.grip) : null);
  if (!gripPos) fail('a new hand needs grip: [x, y, z] (or a full aim pose)');
  // The aim keeps its offset from the grip unless it is given.
  const aimPos = aimGiven ?? (base ? gripPos.clone().add(position(base.aim).sub(position(base.grip))) : gripPos.clone());
  const gripQ = spec.grip !== undefined ? quatOf(spec.grip, 'grip') : null;
  const aimQ = spec.aim !== undefined ? quatOf(spec.aim, 'aim') : null;
  const target = spec.aimAt !== undefined ? vec3(spec.aimAt, 'aimAt') : null;
  const aim = aimQ ?? (target ? lookRotation(aimPos, target) : gripQ ? gripQ.clone().multiply(AIM_FROM_GRIP) : base ? rotation(base.aim) : new THREE.Quaternion());
  const grip = gripQ ?? (aimQ || target || !base ? aim.clone().multiply(GRIP_FROM_AIM) : rotation(base.grip));
  const prev = previous;
  const unit = (v: number | undefined, was: number | undefined, what: string) => (v === undefined ? (was ?? 0) : clamp(num(v, what, 10), 0, 1));
  const flag = (v: boolean | undefined, was: boolean | undefined, what: string) => {
    if (v !== undefined && typeof v !== 'boolean') fail(`${what} must be true or false`);
    return v ?? was ?? false;
  };
  let stick: [number, number] = prev ? [prev.stick[0], prev.stick[1]] : [0, 0];
  if (spec.stick !== undefined) {
    if (!Array.isArray(spec.stick) || spec.stick.length !== 2) fail('stick must be [x, y]');
    stick = [clamp(num(spec.stick[0], 'stick', 10), -1, 1), clamp(num(spec.stick[1], 'stick', 10), -1, 1)];
  }
  return {
    space,
    grip: pose7(gripPos, grip),
    aim: pose7(aimPos, aim),
    trigger: unit(spec.trigger, prev?.trigger, 'trigger'),
    squeeze: unit(spec.squeeze, prev?.squeeze, 'squeeze'),
    stick,
    a: flag(spec.a, prev?.a, 'a'),
    b: flag(spec.b, prev?.b, 'b'),
    menu: flag(spec.menu, prev?.menu, 'menu'),
    stickClick: flag(spec.stickClick, prev?.stickClick, 'stickClick'),
  };
}

/** The frame a space's poses are relative to, in LOCAL_FLOOR, or null when it is not known yet. */
function spaceFrame(space: PuppetSpace, env: PuppetEnv): { p: THREE.Vector3; q: THREE.Quaternion } | null {
  if (space === 'local') return { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  if (space === 'world') {
    const rig = env.rig();
    if (!rig) return null;
    // LOCAL_FLOOR from world: the inverse of the rig (yaw and sway, no scale).
    _m.copy(rig).invert().decompose(_v, _q, _s);
    return { p: _v.clone(), q: _q.clone() };
  }
  const head = env.head();
  if (!head) return null;
  const q = rotation(head);
  return { p: position(head), q: space === 'heading' ? headingRotation(q) : q };
}

/** A pose in `space` expressed in LOCAL_FLOOR. */
function toLocal(pose: Pose7, frame: { p: THREE.Vector3; q: THREE.Quaternion }): Pose7 {
  const p = position(pose).applyQuaternion(frame.q).add(frame.p);
  return pose7(p, frame.q.clone().multiply(rotation(pose)));
}

function localHand(hand: PuppetHand, env: PuppetEnv): PuppetHand | null {
  if (hand.space === 'local') return hand;
  const frame = spaceFrame(hand.space, env);
  return frame ? { ...hand, space: 'local', grip: toLocal(hand.grip, frame), aim: toLocal(hand.aim, frame) } : null;
}

function blendPose(a: Pose7, b: Pose7, k: number): Pose7 {
  const p = position(a).lerp(position(b), k);
  return pose7(p, rotation(a).slerp(rotation(b), k));
}

/** `from` moving to `to`; k in 0..1. Poses in different spaces blend in LOCAL_FLOOR. */
export function blendHands(from: PuppetHand, to: PuppetHand, k: number, env: PuppetEnv): PuppetHand {
  if (k >= 1) return to;
  let a = from;
  let b = to;
  if (a.space !== b.space) {
    const la = localHand(a, env);
    const lb = localHand(b, env);
    if (!la || !lb) return to;
    a = la;
    b = lb;
  }
  const lerp = (x: number, y: number) => x + (y - x) * k;
  return {
    ...b,
    grip: blendPose(a.grip, b.grip, k),
    aim: blendPose(a.aim, b.aim, k),
    trigger: lerp(a.trigger, b.trigger),
    squeeze: lerp(a.squeeze, b.squeeze),
    stick: [lerp(a.stick[0], b.stick[0]), lerp(a.stick[1], b.stick[1])],
  };
}

interface Move {
  from: PuppetHand;
  start: number;
  duration: number;
}

interface Running {
  steps: readonly PuppetStep[];
  /** Each step's time after the start (ms). */
  times: number[];
  next: number;
  start: number;
  applied: PuppetScriptResult['applied'];
  resolve: (result: PuppetScriptResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** The script's staging label (PuppetCallOptions). */
  label: string;
}

const HANDS = ['left', 'right'] as const;
const posedSpec = (spec: PuppetHandSpec) => spec.grip !== undefined || spec.aim !== undefined || spec.aimAt !== undefined || spec.space !== undefined;

export class NativePuppet {
  private hands: [PuppetHand | null, PuppetHand | null] = [null, null];
  private moves: [Move | null, Move | null] = [null, null];
  private run: Running | null = null;
  private driven: [boolean, boolean] = [false, false];
  private supported = false;
  private since: string | null = null;
  private staging: PuppetStaging[] = [];
  readonly api: PuppetApi;

  constructor(
    private env: PuppetEnv,
    private clock: () => number = () => performance.now(),
  ) {
    const available = () => this.supported;
    this.api = {
      get available() {
        return available();
      },
      set: (hands, options) => this.set(hands, options),
      update: (hands, options) => this.update(hands, options),
      clear: () => this.clear(),
      script: (steps, options) => this.script(steps, options),
      state: () => this.state(),
    };
  }

  get available(): boolean {
    return this.supported;
  }

  get active(): boolean {
    return this.hands[0] !== null || this.hands[1] !== null;
  }

  /** The host's frame events say whether it accepts a puppet (debug builds only). */
  host(available: boolean): void {
    if (available === this.supported) return;
    this.supported = available;
    if (!available) this.stop('unavailable');
  }

  /** Native marks the slots it filled from the puppet in its samples. */
  observe(frames: unknown): void {
    if (!Array.isArray(frames) || frames.length === 0) return;
    const hands = (frames[frames.length - 1] as { hands?: unknown } | null)?.hands;
    if (!Array.isArray(hands)) return;
    this.driven = [hands[0]?.puppet === true, hands[1]?.puppet === true];
  }

  set(hands: PuppetHands, options: PuppetCallOptions = {}): PuppetReport {
    this.require();
    const label = stagingLabel(options, '__office.puppet.set');
    const next: [PuppetHand | null, PuppetHand | null] = [null, null];
    HANDS.forEach((name, i) => {
      const spec = hands?.[name];
      if (spec) next[i] = resolveHand(spec, null);
    });
    this.stopScript('cancelled');
    this.moves = [null, null];
    // set replaces every hand, so the staging record starts over with it.
    this.staging = [];
    this.commit(next);
    this.record(label);
    return this.state();
  }

  update(hands: PuppetHands, options: PuppetCallOptions = {}): PuppetReport {
    this.require();
    const label = stagingLabel(options, '__office.puppet.update');
    this.patch(hands, 0, this.clock());
    this.record(label);
    return this.state();
  }

  clear(): PuppetReport {
    this.stop('cancelled');
    return this.state();
  }

  script(steps: readonly PuppetStep[], options: PuppetCallOptions & { timeoutMs?: number } = {}): Promise<PuppetScriptResult> {
    this.require();
    const label = stagingLabel(options, '__office.puppet.script');
    if (!Array.isArray(steps) || steps.length === 0) fail('a script needs at least one step');
    const times: number[] = [];
    let t = 0;
    let longest = 0;
    // Dry run: every step must resolve against the state the steps before it leave.
    let dry: [PuppetHand | null, PuppetHand | null] = [this.hands[0], this.hands[1]];
    steps.forEach((step, i) => {
      if (!step || typeof step !== 'object') fail(`step ${i} must be an object`);
      const at = step.at !== undefined ? num(step.at, `step ${i} at`, 3_600_000) : t + (step.after !== undefined ? num(step.after, `step ${i} after`, 3_600_000) : 0);
      if (at < t || at < 0) fail(`step ${i} is earlier than the step before it`);
      const over = step.over !== undefined ? num(step.over, `step ${i} over`, 60_000) : 0;
      if (over < 0) fail(`step ${i} over must not be negative`);
      if (step.check !== undefined && typeof step.check !== 'function') fail(`step ${i} check must be a function`);
      times.push((t = at));
      longest = Math.max(longest, at + over);
      dry = HANDS.map((name, h) => {
        const spec = step[name];
        return spec === undefined ? dry[h] : spec === null ? null : resolveHand(spec, dry[h]);
      }) as [PuppetHand | null, PuppetHand | null];
    });
    this.stopScript('cancelled');
    const start = this.clock();
    return new Promise((resolve) => {
      const run: Running = { steps, times, next: 0, start, applied: [], resolve, timer: null, label };
      const timeout = options.timeoutMs ?? longest + 5000;
      run.timer = setTimeout(() => this.run === run && this.finish({ ok: false, reason: 'timeout' }), timeout);
      (run.timer as { unref?: () => void }).unref?.();
      this.run = run;
    });
  }

  state(): PuppetReport {
    const run = this.run;
    return {
      available: this.supported,
      active: this.active,
      label: this.active ? (this.staging[this.staging.length - 1]?.label ?? null) : null,
      staging: this.active ? this.staging.map((s) => ({ ...s })) : [],
      hands: { left: this.hands[0], right: this.hands[1] },
      driven: { left: this.driven[0], right: this.driven[1] },
      script: run ? { step: run.next, of: run.steps.length, label: run.steps[run.next]?.label } : null,
      since: this.since,
    };
  }

  /**
   * The control packet's `puppet` field for this tick, or null. Advances a running script by one
   * scheduled time per tick, so every step is sent at least once (about 33 ms apart).
   */
  packet(now = this.clock()): PuppetPacket | null {
    if (!this.supported) return null;
    this.advance(now);
    if (!this.active) return null;
    const hands = HANDS.map((_, h) => this.wire(h, now)) as [PuppetWireHand | null, PuppetWireHand | null];
    return hands[0] || hands[1] ? { v: 1, hands } : null;
  }

  private require(): void {
    if (!this.supported) fail('not available: it needs a debug build of the headset app (BuildConfig.DEBUG and the native OFFICE_CAPTURE_PUPPET build)');
  }

  private commit(next: [PuppetHand | null, PuppetHand | null]): void {
    const was = this.active;
    this.hands = next;
    if (!this.active) this.moves = [null, null];
    if (this.active && !was) this.since = new Date().toISOString();
    if (!this.active) {
      this.since = null;
      this.staging = [];
    }
  }

  /** Notes a staging call while the puppet is staged; keeps the first and the latest calls. */
  private record(label: string): void {
    if (!this.active) return;
    const last = this.staging[this.staging.length - 1];
    const at = new Date().toISOString();
    if (last && last.label === label) {
      last.at = at;
      return;
    }
    this.staging.push({ label, at });
    if (this.staging.length > MAX_STAGINGS) this.staging.splice(1, 1);
  }

  /** Applies one step's hands; `over` moves the poses from where they are shown now. */
  private patch(hands: PuppetHands, over: number, now: number): void {
    const next: [PuppetHand | null, PuppetHand | null] = [this.hands[0], this.hands[1]];
    const moves: [Move | null, Move | null] = [this.moves[0], this.moves[1]];
    HANDS.forEach((name, h) => {
      const spec = hands?.[name];
      if (spec === undefined) return;
      if (spec === null) {
        next[h] = null;
        moves[h] = null;
        return;
      }
      const resolved = resolveHand(spec, next[h]);
      const shown = this.shown(h, now);
      if (over > 0 && shown) moves[h] = { from: shown, start: now, duration: over };
      else if (posedSpec(spec)) moves[h] = null;
      else if (moves[h]) {
        // Buttons and analog values change at once, even while the poses are still moving.
        const m = moves[h]!;
        moves[h] = { ...m, from: { ...m.from, trigger: resolved.trigger, squeeze: resolved.squeeze, stick: resolved.stick } };
      }
      next[h] = resolved;
    });
    this.moves = moves;
    this.commit(next);
  }

  /** What a hand looks like at `now`, including a move in progress. */
  private shown(h: number, now: number): PuppetHand | null {
    const hand = this.hands[h];
    const move = this.moves[h];
    if (!hand || !move) return hand;
    const k = clamp((now - move.start) / move.duration, 0, 1);
    if (k >= 1) {
      this.moves[h] = null;
      return hand;
    }
    // Smoothstep: a hand starts and stops moving gently.
    return blendHands(move.from, hand, k * k * (3 - 2 * k), this.env);
  }

  private wire(h: number, now: number): PuppetWireHand | null {
    let hand = this.shown(h, now);
    if (!hand) return null;
    if (hand.space === 'world') {
      hand = localHand(hand, this.env);
      if (!hand) return null;
    }
    return { ...hand, space: hand.space as WireSpace, stick: [hand.stick[0], hand.stick[1]] };
  }

  private advance(now: number): void {
    const run = this.run;
    if (!run) return;
    const elapsed = now - run.start;
    if (run.next < run.steps.length && run.times[run.next] <= elapsed) {
      const due = run.times[run.next];
      while (run.next < run.steps.length && run.times[run.next] === due) {
        const i = run.next;
        const step = run.steps[i];
        const verdict = step.check ? step.check() : true;
        if (verdict !== true) {
          this.finish({ ok: false, reason: typeof verdict === 'string' && verdict ? verdict : 'check failed', step: i });
          return;
        }
        this.patch(step, step.over ?? 0, now);
        this.record(run.label);
        run.applied.push({ step: i, ...(step.label ? { label: step.label } : {}), atMs: Math.round(elapsed) });
        run.next++;
      }
    }
    if (run.next >= run.steps.length && !this.moves.some((m) => m && now - m.start < m.duration)) this.finish({ ok: true });
  }

  private finish(result: Omit<PuppetScriptResult, 'applied'>): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    if (run.timer) clearTimeout(run.timer);
    run.resolve({ ...result, applied: run.applied });
  }

  private stopScript(reason: string): void {
    if (this.run) this.finish({ ok: false, reason, step: this.run.next });
  }

  private stop(reason: string): void {
    this.stopScript(reason);
    this.commit([null, null]);
  }
}
