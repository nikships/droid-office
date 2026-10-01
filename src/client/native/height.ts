// Player height for the headset. The runtime's floor can be wrong (an unworn Galaxy XR has reported the
// eyes 1.3 m above where they are), which spawns the player giant. The player sets their own height and
// calibrates once standing up straight; the rig origin then sits that much lower for rendering and logic alike.

const STORAGE_KEY = 'droid-office.native-height.v1';
/** Eyes sit about this far below the top of the head. */
const EYES_BELOW_TOP = 0.11;
const MIN_HEIGHT_CM = 120;
const MAX_HEIGHT_CM = 220;
/** Floor corrections beyond this are a broken reading, not a body. */
const MAX_OFFSET = 2.5;

export interface NativeHeight {
  v: 1;
  /** The player's own height, in centimetres. */
  heightCm: number;
  /** Metres the headset's floor is above the real floor; the rig origin is lowered by this. */
  floorOffset: number;
}

export const DEFAULT_NATIVE_HEIGHT: Readonly<NativeHeight> = { v: 1, heightCm: 175, floorOffset: 0 };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A stored height, with anything malformed replaced by its default. */
export function readNativeHeight(raw: unknown): NativeHeight {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const heightCm = typeof value.heightCm === 'number' && Number.isFinite(value.heightCm) ? clamp(Math.round(value.heightCm), MIN_HEIGHT_CM, MAX_HEIGHT_CM) : DEFAULT_NATIVE_HEIGHT.heightCm;
  const floorOffset = typeof value.floorOffset === 'number' && Number.isFinite(value.floorOffset) ? clamp(value.floorOffset, -MAX_OFFSET, MAX_OFFSET) : 0;
  return { v: 1, heightCm, floorOffset };
}

/** Eye height for a player of this height, in metres. */
export function eyeHeightFor(heightCm: number): number {
  return heightCm / 100 - EYES_BELOW_TOP;
}

/** The floor correction that puts eyes reported at `headY` at the eye height of a `heightCm` player. */
export function floorOffsetFor(headY: number, heightCm: number): number {
  return clamp(headY - eyeHeightFor(heightCm), -MAX_OFFSET, MAX_OFFSET);
}

let current: NativeHeight | null = null;
let headHeight: () => number | null = () => null;

export function nativeHeight(): NativeHeight {
  if (!current) {
    try {
      current = readNativeHeight(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
    } catch {
      current = { ...DEFAULT_NATIVE_HEIGHT };
    }
  }
  return current;
}

/** Metres to lower the rig origin by. */
export function nativeFloorOffset(): number {
  return nativeHeight().floorOffset;
}

export function setNativeHeight(patch: Partial<NativeHeight>): NativeHeight {
  current = readNativeHeight({ ...nativeHeight(), ...patch });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // The height still applies for this session when storage is unavailable.
  }
  return current;
}

/** The native controls report the tracked head height above the headset's floor (null while untracked). */
export function registerNativeHeadHeight(read: () => number | null): void {
  headHeight = read;
}

/** Eye height above the corrected floor right now, or null while the head is untracked. */
export function nativeEyeHeightNow(): number | null {
  const y = headHeight();
  return y === null || !Number.isFinite(y) ? null : y - nativeFloorOffset();
}

/** Calibrates the floor from the current head height, assuming the player stands up straight. */
export function calibrateNativeHeight(): { ok: boolean; offset: number } {
  const y = headHeight();
  if (y === null || !Number.isFinite(y)) return { ok: false, offset: nativeFloorOffset() };
  const offset = floorOffsetFor(y, nativeHeight().heightCm);
  setNativeHeight({ floorOffset: offset });
  return { ok: true, offset };
}
