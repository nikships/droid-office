// The headset app's graphics choices (world resolution, foveation, the FPS counter, sharp screens),
// kept in this headset's storage and sent to the native renderer with every control packet. The VR
// settings menu (native/menus.ts) changes them; the latest native measurements say what applied.
import { DEFAULT_NATIVE_GRAPHICS, readNativeGraphics, type NativeGraphicsSettings } from './graphics-settings';

const STORAGE_KEY = 'droid-office.native-graphics.v1';
let settings: NativeGraphicsSettings | null = null;
let metrics: unknown;
const listeners = new Set<() => void>();

export function getNativeGraphicsSettings(): NativeGraphicsSettings {
  if (!settings) {
    try {
      // The diagnostic density view never survives a restart.
      settings = { ...readNativeGraphics(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')), foveationDebug: false };
    } catch {
      settings = { ...DEFAULT_NATIVE_GRAPHICS };
    }
  }
  return settings;
}

/** Changes some settings, as the settings menu does. The native page exposes this for headset checks. */
export function setNativeGraphicsSettings(patch: Partial<NativeGraphicsSettings>): NativeGraphicsSettings {
  settings = readNativeGraphics({ ...getNativeGraphicsSettings(), ...patch });
  try {
    // JSON leaves out the undefined diagnostic flag, which lasts only this session.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, foveationDebug: undefined }));
  } catch {
    // The settings still apply for this session when storage is unavailable.
  }
  for (const fn of listeners) fn();
  return settings;
}

/** The latest native measurements (render sizes, foveation support, frame timing). */
export function nativeGraphicsMetrics(): unknown {
  return metrics;
}

export function updateNativeGraphicsMetrics(next: unknown) {
  metrics = next;
}

/** Hears every settings change; returns the unlisten. */
export function onNativeGraphicsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
