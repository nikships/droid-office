/**
 * The Remastered renderer's picture is fixed. Settings → Display only remembers whether it is on, and whether HDR is
 * on. `resolveRemaster` turns that into the numbers the renderer draws with: the screenshot's mix, not a menu.
 * Nothing here touches the DOM or WebGL; localStorage is only read inside try.
 */

export interface RemasterSettings {
  /** Off draws the office the classic way. The same switch as Settings → Display → Renderer. */
  enabled: boolean;
  /** Highlights past white on an EDR display. Settings → Display → HDR. Off until turned on. */
  hdr: boolean;
}

/** Classic, HDR off, until someone picks otherwise. The picture below does not change with the save. */
export const REMASTER_DEFAULTS: RemasterSettings = { enabled: false, hdr: false };

/**
 * Saved settings. Only `enabled` and `hdr` are kept. A Graphics Lab save (resolution, quality, picture, pace, debug,
 * an old preset) is discarded, so a custom mix cannot outlive the menu that set it.
 */
export function normalizeRemaster(saved: unknown): RemasterSettings {
  const out: RemasterSettings = { ...REMASTER_DEFAULTS };
  if (!saved || typeof saved !== 'object') return out;
  const s = saved as Record<string, unknown>;
  if (typeof s.enabled === 'boolean') out.enabled = s.enabled;
  if (typeof s.hdr === 'boolean') out.hdr = s.hdr;
  return out;
}

// ---- What the renderer draws with --------------------------------------------------------------

export type ToneMap = 'neutral' | 'agx' | 'aces' | 'reinhard' | 'cineon' | 'linear';
export type ToonRamp = 'classic' | 'bands5' | 'soft' | 'smooth';
export type DebugView = 'final' | 'hdr' | 'gi';
export type PaceMode = 'adaptive' | 'full';

/** The numbers `world/remaster.ts` draws with, worked out from the settings by resolveRemaster. */
export interface RenderParams {
  enabled: boolean;
  resolution: number;
  /** MSAA samples on the scene target: 0, 2 or 4. */
  msaa: number;
  sharpen: number;
  hdr: boolean;
  hdrPeak: number;
  paperWhite: number;
  toneMap: ToneMap;
  exposure: number;
  gi: boolean;
  giIntensity: number;
  giGlow: number;
  /** Meters between light probes. */
  giSpacing: number;
  giBounces: number;
  saturation: number;
  vibrance: number;
  contrast: number;
  temperature: number;
  tint: number;
  moon: number;
  skyFill: number;
  ambientFill: number;
  officeFill: number;
  screenLight: number;
  lampLight: number;
  emissive: number;
  screenGlow: number;
  toonRamp: ToonRamp;
  outlines: boolean;
  outlineThickness: number;
  outlineOpacity: number;
  debug: DebugView;
  pace: PaceMode;
}

/** In HDR, screens and signs glow past white by this much more. Highlights stay at 4× white. */
const HDR_GLOW = 1.6;
const HDR_PEAK = 4;

/**
 * The locked picture: 1.0×, 2× MSAA, ultra bounce light (a probe every 1.4 m, two extra bounces), normal brightness,
 * natural color, subtle light sources, smooth shading, no sharpening. HDR is the only part Settings can change, and
 * it does not move the highlight cap. Pace stays adaptive: a still office drops to a few frames a second.
 */
export function resolveRemaster(s: RemasterSettings): RenderParams {
  return {
    enabled: s.enabled,
    resolution: 1,
    msaa: 2,
    sharpen: 0,
    hdr: s.hdr,
    hdrPeak: HDR_PEAK,
    paperWhite: 1,
    toneMap: 'linear',
    exposure: 1.25,
    gi: true,
    giIntensity: 0.25,
    giSpacing: 1.4,
    giBounces: 2,
    saturation: 1,
    vibrance: 0,
    contrast: 1,
    temperature: 0,
    tint: 0,
    moon: 1,
    skyFill: 1,
    ambientFill: 0.95,
    officeFill: 0.95,
    screenLight: 1,
    lampLight: 0.9,
    emissive: 1,
    screenGlow: s.hdr ? HDR_GLOW : 1,
    giGlow: 0.25,
    toonRamp: 'smooth',
    outlines: false,
    outlineThickness: 1.8,
    outlineOpacity: 1,
    debug: 'final',
    pace: 'adaptive',
  };
}

/** Bumped when a change to how the probes bake makes saved bakes wrong in a way the other inputs don't show. */
export const BAKE_FORMAT = 2;

/**
 * Everything the baked bounce light depends on: the grid, the lights the probes see and the shading they see it with,
 * the ceiling lights' brightness (Settings → Display) and `build`: the hash of the scene's code and models
 * (`tools/scene-hash.mjs`), so an update that leaves the scene alone keeps its bake. A saved bake is used only under the
 * same key. '' (no GI, a build without a scene hash, or no welcome from the office yet) means nothing to bake.
 */
export function bakeKey(p: RenderParams, overhead: number, build: string): string {
  if (!p.enabled || !p.gi || !build) return '';
  const inputs = [p.giSpacing, p.giBounces, p.giIntensity, p.giGlow, p.moon, p.skyFill, p.ambientFill, p.officeFill, p.screenLight, p.lampLight, p.emissive, p.screenGlow, p.toonRamp, overhead];
  return `gi${BAKE_FORMAT}|${build}|${inputs.join('|')}`;
}

/** How many probes fit along a span at a spacing: at least 2, so the grid has two ends. */
export function probeCount(span: number, spacing: number): number {
  return Math.max(2, Math.round(span / spacing) + 1);
}

/** The most of each frame's main thread a GI bake slice takes, in ms, whatever the frame rate limit. */
export const BAKE_BUDGET_MAX_MS = 14;
/** The share of a frame a bake slice may take, leaving the rest for drawing the frame itself. */
export const BAKE_FRAME_SHARE = 0.5;

/**
 * How long a GI bake slice may take of each frame: half of what one frame has, at most 14 ms. A frame has the limit's
 * interval (`fpsCap`), or the display's refresh (`refreshMs`) when that is slower: a 120 FPS limit on 60 Hz has 16.7 ms.
 */
export function bakeBudget(fpsCap: number, refreshMs = 0): number {
  const interval = Math.max(fpsCap > 0 ? 1000 / fpsCap : 0, refreshMs > 0 ? refreshMs : 0);
  if (!(interval > 0)) return BAKE_BUDGET_MAX_MS;
  return Math.min(BAKE_BUDGET_MAX_MS, interval * BAKE_FRAME_SHARE);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The red/green/blue gain for a white balance: temperature -1 (cool) to 1 (warm), tint -1 (green) to 1 (magenta).
 * Normalized so the green channel keeps the overall brightness about the same.
 */
export function whiteBalance(temperature: number, tint: number): [number, number, number] {
  const t = clamp(temperature, -1, 1) * 0.25;
  const g = clamp(tint, -1, 1) * 0.15;
  const r = 1 + t;
  const b = 1 - t;
  const gg = 1 - g;
  const norm = 3 / (r + gg + b);
  return [r * norm, gg * norm, b * norm];
}

export const REMASTER_KEY = 'droid-office.remaster';

export function loadRemaster(): RemasterSettings {
  try {
    return normalizeRemaster(JSON.parse(localStorage.getItem(REMASTER_KEY) ?? 'null'));
  } catch {
    return { ...REMASTER_DEFAULTS };
  }
}

export function saveRemaster(s: RemasterSettings) {
  try {
    localStorage.setItem(REMASTER_KEY, JSON.stringify(s));
  } catch {
    // storage blocked
  }
}
