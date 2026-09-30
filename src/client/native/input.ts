/**
 * The native app's input packet: what the OpenXR side samples at the display rate and the
 * Java bridge hands to NativeControls.consume in batches. Pure data and validation, no THREE,
 * so the tests and the bridge can share it.
 *
 * Every pose is in the native LOCAL_FLOOR space (meters, floor at y = 0). hands[0] is always
 * the left controller and hands[1] the right one. Motion controllers are the only native input:
 * a slot that reports a tracked hand reads as inactive.
 */

/** Position and unit quaternion: [x, y, z, qx, qy, qz, qw]. */
export type Pose7 = [number, number, number, number, number, number, number];

export interface NativeHand {
  /** A motion controller is tracked in this slot this sample. */
  active: boolean;
  aim: Pose7;
  grip: Pose7;
  /** Controller trigger (0..1). */
  trigger: number;
  /** Controller squeeze (0..1). */
  squeeze: number;
  /** OpenXR convention: +x right, +y forward. */
  stick: [number, number];
  a: boolean;
  b: boolean;
  /** The menu button. Native binds it on the left controller only. */
  menu: boolean;
  /** The ray is on a compositor panel: native owns the pointer, the world yields. */
  ui: boolean;
  stickClick?: boolean;
}

export interface NativeInputFrame {
  /** Monotonic milliseconds; must increase from one sample to the next. */
  time: number;
  head: Pose7;
  /** False while the headset has lost tracking: the last head pose stays. */
  headTracked?: boolean;
  hands: [NativeHand, NativeHand];
}

/** Controller trigger and squeeze: pressed at ON, released below OFF, so a resting finger never chatters. */
export const TRIGGER_ON = 0.75;
export const TRIGGER_OFF = 0.6;
export const SQUEEZE_ON = 0.75;
export const SQUEEZE_OFF = 0.6;
/** At most one second of 90 Hz samples waits for the 30 Hz brain; older ones are dropped. */
export const MAX_QUEUE = 90;
/** No sample for this long (JS clock) counts as every input source gone. */
export const STALE_MS = 500;
/**
 * A controller missing for less than this (sample clock) is a tracking blip: its held buttons,
 * grab and carried card stay with it. Longer counts as a disconnect.
 */
export const LOST_MS = 400;

/** One trigger or squeeze with hysteresis. */
export function pressLatch(wasDown: boolean, value: number, on: number, off: number): boolean {
  return wasDown ? value >= off : value >= on;
}

/**
 * The OpenXR stick in the WebXR gamepad convention the VR session logic uses: WebXR axes put
 * forward at -y, OpenXR at +y.
 */
export function webStick(stick: readonly [number, number]): { x: number; y: number } {
  return { x: stick[0], y: -stick[1] };
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function readPose(v: unknown): Pose7 | null {
  if (!Array.isArray(v) || v.length !== 7 || !v.every(finite)) return null;
  const q = Math.hypot(v[3], v[4], v[5], v[6]);
  if (q < 0.5 || q > 1.5) return null;
  return [v[0], v[1], v[2], v[3] / q, v[4] / q, v[5] / q, v[6] / q];
}

const IDENTITY: Pose7 = [0, 0, 0, 0, 0, 0, 1];

function inactive(): NativeHand {
  return { active: false, aim: [...IDENTITY], grip: [...IDENTITY], trigger: 0, squeeze: 0, stick: [0, 0], a: false, b: false, menu: false, ui: false };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function readHand(v: unknown): NativeHand | null {
  if (!v || typeof v !== 'object') return null;
  const h = v as Record<string, unknown>;
  if (typeof h.active !== 'boolean') return null;
  // Hand tracking is not a native input: a tracked hand is the same as no controller.
  if (!h.active || h.hand === true) return inactive();
  const aim = readPose(h.aim);
  const grip = readPose(h.grip);
  if (!aim || !grip) return null;
  if (!finite(h.trigger) || !finite(h.squeeze)) return null;
  const stick = Array.isArray(h.stick) && h.stick.length === 2 && h.stick.every(finite) ? (h.stick as [number, number]) : null;
  if (!stick) return null;
  return {
    active: true,
    aim,
    grip,
    trigger: clamp01(h.trigger),
    squeeze: clamp01(h.squeeze),
    stick: [Math.max(-1, Math.min(1, stick[0])), Math.max(-1, Math.min(1, stick[1]))],
    a: h.a === true,
    b: h.b === true,
    menu: h.menu === true,
    ui: h.ui === true,
    stickClick: h.stickClick === true,
  };
}

/** A validated copy of one sample, or null when any part of it is malformed. */
export function readFrame(v: unknown): NativeInputFrame | null {
  if (!v || typeof v !== 'object') return null;
  const f = v as Record<string, unknown>;
  if (!finite(f.time)) return null;
  const head = readPose(f.head);
  if (!head) return null;
  if (!Array.isArray(f.hands) || f.hands.length !== 2) return null;
  const left = readHand(f.hands[0]);
  const right = readHand(f.hands[1]);
  if (!left || !right) return null;
  return { time: f.time, head, headTracked: f.headTracked !== false, hands: [left, right] };
}
