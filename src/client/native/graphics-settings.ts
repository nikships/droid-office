export type NativeFoveation = 'off' | 'balanced' | 'clarity' | 'performance';

export const MIN_NATIVE_RENDER_SCALE = 0.75;
export const MAX_NATIVE_RENDER_SCALE = 2;

export interface NativeGraphicsSettings {
  v: 1;
  renderScale: number;
  /** A runtime foveation profile: Off applies none, the others a runtime level (eye-tracked when available). */
  foveation: NativeFoveation;
  fps: boolean;
  sharpScreens: boolean;
  /** Diagnostic tint of the world's measured shading density. Never restored from storage. */
  foveationDebug: boolean;
}

export const DEFAULT_NATIVE_GRAPHICS: Readonly<NativeGraphicsSettings> = { v: 1, renderScale: 1, foveation: 'balanced', fps: false, sharpScreens: true, foveationDebug: false };

/** Native APKs up to v0.1.301 reject graphics without this field; later ones ignore it. */
const LEGACY_PERIPHERAL_DENSITY = 0.25;

/** The graphics object in the native control packet. */
export function nativeGraphicsPacket(settings: NativeGraphicsSettings): NativeGraphicsSettings & { peripheralDensity: number } {
  return { ...settings, peripheralDensity: LEGACY_PERIPHERAL_DENSITY };
}

/** Stored settings may come from an older app or an interrupted write. */
export function readNativeGraphics(value: unknown): NativeGraphicsSettings {
  const m = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const bounded = (key: string, min: number, max: number, fallback: number) => (typeof m[key] === 'number' && Number.isFinite(m[key]) ? Math.max(min, Math.min(max, m[key] as number)) : fallback);
  return {
    v: 1,
    renderScale: bounded('renderScale', MIN_NATIVE_RENDER_SCALE, MAX_NATIVE_RENDER_SCALE, 1),
    foveation: m.foveation === 'off' || m.foveation === 'clarity' || m.foveation === 'performance' ? m.foveation : 'balanced',
    fps: m.fps === true,
    sharpScreens: m.sharpScreens !== false,
    foveationDebug: m.foveationDebug === true,
  };
}

const FOVEATION_LEVELS: Record<string, string> = { none: 'Off', low: 'Low', medium: 'Medium', high: 'High' };

/** The foveation the native runtime actually applied, from its frame metrics; null before the first report. */
export function nativeFoveationStatus(metrics: unknown): string | null {
  const m = metrics && typeof metrics === 'object' ? (metrics as Record<string, unknown>) : {};
  const f = m.foveation && typeof m.foveation === 'object' ? (m.foveation as Record<string, unknown>) : null;
  if (!f || typeof f.level !== 'string') return typeof m.foveationEnabled === 'boolean' ? `Currently applied: ${m.foveationEnabled ? 'On' : 'Off'}.` : null;
  if (f.level === 'unfoveated') return 'Currently applied: full detail everywhere (no runtime foveation).';
  const level = FOVEATION_LEVELS[f.level] ?? f.level;
  if (f.level === 'none') return 'Currently applied: Off (full detail everywhere).';
  const tracked = f.eyeTracked === true ? 'follows your eyes' : 'fixed at the centre';
  const fallback = typeof f.fallback === 'string' && f.fallback ? ` Fallback: ${f.fallback}.` : '';
  return `Currently applied: ${level} runtime level, ${tracked}.${fallback}`;
}

export interface NativeEyeSize {
  width: number;
  height: number;
}

export interface NativeWorldResolution {
  recommended: NativeEyeSize | null;
  maximum: NativeEyeSize | null;
  applied: NativeEyeSize | null;
  selected: NativeEyeSize | null;
  maxScale: number;
  selectedScale: number;
  hasMaximum: boolean;
}

/** A saved multiplier stays relative to the recommendation; the runtime bounds the current device. */
export function nativeWorldResolution(metrics: unknown, renderScale: number): NativeWorldResolution {
  const m = metrics && typeof metrics === 'object' ? (metrics as Record<string, unknown>) : {};
  const size = (widthKey: string, heightKey: string): NativeEyeSize | null => {
    const width = m[widthKey];
    const height = m[heightKey];
    return typeof width === 'number' && Number.isFinite(width) && width >= 1 && typeof height === 'number' && Number.isFinite(height) && height >= 1 ? { width: Math.floor(width), height: Math.floor(height) } : null;
  };
  const recommended = size('worldRecommendedWidth', 'worldRecommendedHeight');
  const maximum = size('worldMaxWidth', 'worldMaxHeight');
  const reportedMax = typeof m.maxRenderScale === 'number' && Number.isFinite(m.maxRenderScale) && m.maxRenderScale >= MIN_NATIVE_RENDER_SCALE ? m.maxRenderScale : null;
  const dimensionMax = recommended && maximum ? Math.min(maximum.width / recommended.width, maximum.height / recommended.height) : null;
  const hasMaximum = reportedMax !== null || dimensionMax !== null;
  const maxScale = Math.max(MIN_NATIVE_RENDER_SCALE, Math.min(MAX_NATIVE_RENDER_SCALE, reportedMax ?? dimensionMax ?? 1, dimensionMax ?? MAX_NATIVE_RENDER_SCALE));
  const selectedScale = Math.max(MIN_NATIVE_RENDER_SCALE, Math.min(maxScale, Number.isFinite(renderScale) ? renderScale : 1));
  const scaledPixels = (pixels: number) => Math.max(2, Math.floor((pixels * selectedScale + 0.001) / 2) * 2);
  const selected = recommended ? { width: Math.min(maximum?.width ?? Infinity, scaledPixels(recommended.width)), height: Math.min(maximum?.height ?? Infinity, scaledPixels(recommended.height)) } : null;
  return { recommended, maximum, applied: size('worldWidth', 'worldHeight'), selected, maxScale, selectedScale, hasMaximum };
}

/** Whole-percent steps plus the exact runtime endpoint, which may fall between steps. */
export function stepNativeRenderScale(value: number, direction: -1 | 1, maxScale: number): number {
  const current = Math.max(MIN_NATIVE_RENDER_SCALE, Math.min(maxScale, value));
  const stepped = direction > 0 ? (Math.floor(current * 100 + 1e-8) + 1) / 100 : (Math.ceil(current * 100 - 1e-8) - 1) / 100;
  return Math.max(MIN_NATIVE_RENDER_SCALE, Math.min(maxScale, stepped));
}
