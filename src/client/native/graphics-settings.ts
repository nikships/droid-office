export type NativeFoveation = 'balanced' | 'clarity' | 'performance';

export interface NativeGraphicsSettings {
  v: 1;
  renderScale: number;
  foveation: NativeFoveation;
  peripheralDensity: number;
  fps: boolean;
  sharpScreens: boolean;
}

export const DEFAULT_NATIVE_GRAPHICS: Readonly<NativeGraphicsSettings> = { v: 1, renderScale: 1, foveation: 'balanced', peripheralDensity: 0.25, fps: false, sharpScreens: true };

/** Stored settings may come from an older app or an interrupted write. */
export function readNativeGraphics(value: unknown): NativeGraphicsSettings {
  const m = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const bounded = (key: string, min: number, max: number, fallback: number) => (typeof m[key] === 'number' && Number.isFinite(m[key]) ? Math.max(min, Math.min(max, m[key] as number)) : fallback);
  return {
    v: 1,
    renderScale: bounded('renderScale', 0.75, 1, 1),
    foveation: m.foveation === 'clarity' || m.foveation === 'performance' ? m.foveation : 'balanced',
    peripheralDensity: bounded('peripheralDensity', 0.25, 1, 0.25),
    fps: m.fps === true,
    sharpScreens: m.sharpScreens !== false,
  };
}
