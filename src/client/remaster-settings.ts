/**
 * The Remastered renderer's settings, laid out the way a game's graphics menu is: an overall quality from Low to Ultra,
 * a level for each setting that costs the GPU, a few picture choices that only change the look, and the render
 * resolution. `resolveRemaster` turns them into the numbers the renderer draws with. The Graphics Lab is built from the
 * setting lists here, so a setting added to one shows up there by itself.
 * Nothing here touches the DOM or WebGL; localStorage is only read inside try.
 */

export const LEVELS = ['low', 'medium', 'high', 'veryHigh', 'ultra'] as const;
export type Level = (typeof LEVELS)[number];
/** The overall quality: the preset every quality setting matches, or Custom when they match none. */
export type Quality = Level | 'custom';
export const LEVEL_LABELS: Record<Level, string> = { low: 'Low', medium: 'Medium', high: 'High', veryHigh: 'Very High', ultra: 'Ultra' };

export type Brightness = 'darker' | 'dark' | 'normal' | 'bright' | 'brighter';
export type ColorLook = 'natural' | 'rich' | 'vivid' | 'warm' | 'cool';
export type LightLook = 'subtle' | 'normal' | 'strong' | 'neon';
export type ArtStyle = 'smooth' | 'soft' | 'toon';
export type Sharpness = 'off' | 'low' | 'medium' | 'high';
export type HdrHighlights = 'subtle' | 'normal' | 'bright' | 'max';
export type DebugView = 'final' | 'hdr' | 'gi';
export type PaceMode = 'adaptive' | 'full';

export interface RemasterSettings {
  /** Off draws the office the classic way; the same switch as Settings → Graphics → Renderer. */
  enabled: boolean;
  /** The scene's render resolution as a share of the screen's: below 1 it is upscaled, above 1 supersampled. */
  resolution: number;
  antiAliasing: Level;
  shadowQuality: Level;
  giQuality: Level;
  liveGi: Level;
  brightness: Brightness;
  color: ColorLook;
  lights: LightLook;
  style: ArtStyle;
  sharpness: Sharpness;
  hdr: boolean;
  hdrHighlights: HdrHighlights;
  debug: DebugView;
  pace: PaceMode;
}

export type QualityKey = 'antiAliasing' | 'shadowQuality' | 'giQuality' | 'liveGi';
/** Every setting picked from a list (everything but the resolution). Booleans are listed as 'on' and 'off'. */
export type ChoiceKey = Exclude<keyof RemasterSettings, 'resolution'>;
/** What a setting costs the GPU, shown beside its description. */
export type Impact = 'none' | 'low' | 'medium' | 'high';

export interface ChoiceOption {
  value: string;
  label: string;
  /** What this choice draws, in a sentence. */
  detail: string;
}

export interface ChoiceSetting {
  key: ChoiceKey;
  label: string;
  hint: string;
  impact: Impact;
  options: readonly ChoiceOption[];
  /** Greyed out unless this holds, for a setting that depends on another. */
  needs?: (s: RemasterSettings) => boolean;
}

export const RESOLUTION_MIN = 0.5;
export const RESOLUTION_MAX = 1.5;
export const RESOLUTION_STEP = 0.1;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A resolution scale snapped to a tenth and clamped to 0.5–1.5, so 0.7 is saved as 0.7 and not 0.7000000000000001. */
export function snapResolution(v: number): number {
  return clamp(Math.round(v * 10) / 10, RESOLUTION_MIN, RESOLUTION_MAX);
}

const level = (value: Level, detail: string): ChoiceOption => ({ value, label: LEVEL_LABELS[value], detail });

export const QUALITY_SETTINGS: readonly ChoiceSetting[] = [
  {
    key: 'antiAliasing',
    label: 'Anti-aliasing',
    hint: 'Smooths the jagged, stair-stepped edges of everything drawn.',
    impact: 'high',
    options: [level('low', 'Off. Edges are jagged; nothing extra is drawn.'), level('medium', '2× MSAA: two samples at every edge pixel.'), level('high', '4× MSAA: four samples at every edge pixel, the smoothest edges.')],
  },
  {
    key: 'shadowQuality',
    label: 'Shadows',
    hint: 'How much detail the moon’s shadows have. The shadow map is only redrawn when something that casts a shadow moves.',
    impact: 'low',
    options: [
      level('low', '1024² shadow map. Small things cast blocky shadows.'),
      level('medium', '2048² shadow map.'),
      level('high', '3072² shadow map: desks, chairs and people cast clean shadows.'),
      level('veryHigh', '4096² shadow map: chair legs and cables cast crisp shadows.'),
      level('ultra', '8192² shadow map, 256 MB of video memory. The slowest to redraw while workers walk about.'),
    ],
  },
  {
    key: 'giQuality',
    label: 'Global illumination',
    hint: 'Bounce light: the glow of the screens, lamps and moon carried across the room by a grid of light probes, baked when you arrive on a floor.',
    impact: 'medium',
    options: [
      level('low', 'Off. Direct light only: flatter, with darker corners.'),
      level('medium', 'A probe every 3 m; light bounces once.'),
      level('high', 'A probe every 2 m, with one extra bounce.'),
      level('veryHigh', 'A probe every 1.4 m, with one extra bounce: small pools of light under every desk.'),
      level('ultra', 'A probe every 1.4 m, with two extra bounces. The longest bake.'),
    ],
  },
  {
    key: 'liveGi',
    label: 'Live global illumination',
    hint: 'Keeps re-baking light probes, so people walking past and screens changing show up in the bounce light. Needs global illumination.',
    impact: 'high',
    needs: (s) => s.giQuality !== 'low',
    options: [
      level('low', 'Off. The bounce light is baked once when you arrive on a floor.'),
      level('medium', '15 probes re-baked a second.'),
      level('high', '30 probes re-baked a second.'),
      level('veryHigh', '60 probes re-baked a second.'),
      level('ultra', '120 probes re-baked a second. Each probe draws the office six more times.'),
    ],
  },
];

export const DISPLAY_SETTINGS: readonly ChoiceSetting[] = [
  {
    key: 'enabled',
    label: 'Renderer',
    hint: 'Remastered draws in high dynamic range, lit by global illumination. Classic is the office as it always drew, with its own settings in Settings → Graphics.',
    impact: 'none',
    options: [
      { value: 'on', label: 'Remastered', detail: 'Everything in this panel applies.' },
      { value: 'off', label: 'Classic', detail: 'Toon shading and ink outlines, with the resolution and anti-aliasing in Settings → Graphics.' },
    ],
  },
  {
    key: 'hdr',
    label: 'HDR',
    hint: 'Highlights brighter than white on an EDR display such as the MacBook Pro’s XDR panel. Everything at or below white looks as it does in SDR.',
    impact: 'low',
    options: [
      { value: 'off', label: 'Off', detail: 'Standard dynamic range.' },
      { value: 'on', label: 'On', detail: 'Extended-range output through a float16 WebGPU canvas. Stays SDR where the display or browser can’t.' },
    ],
  },
  {
    key: 'hdrHighlights',
    label: 'HDR highlights',
    hint: 'How far past white the brightest screens, signs and lamps may go.',
    impact: 'none',
    needs: (s) => s.hdr,
    options: [
      { value: 'subtle', label: 'Subtle', detail: 'Up to 2× white.' },
      { value: 'normal', label: 'Normal', detail: 'Up to 4× white.' },
      { value: 'bright', label: 'Bright', detail: 'Up to 8× white.' },
      { value: 'max', label: 'Max', detail: 'Up to 16× white, about what the XDR panel shows in a dim room.' },
    ],
  },
];

export const PICTURE_SETTINGS: readonly ChoiceSetting[] = [
  {
    key: 'brightness',
    label: 'Brightness',
    hint: 'How bright the whole picture is.',
    impact: 'none',
    options: [
      { value: 'darker', label: 'Darker', detail: 'A dim, late-night office.' },
      { value: 'dark', label: 'Dark', detail: 'A little darker than normal.' },
      { value: 'normal', label: 'Normal', detail: 'The office as it is meant to look.' },
      { value: 'bright', label: 'Bright', detail: 'A little brighter than normal.' },
      { value: 'brighter', label: 'Brighter', detail: 'For a bright room or a dim screen.' },
    ],
  },
  {
    key: 'color',
    label: 'Color',
    hint: 'The color grade over the whole picture.',
    impact: 'none',
    options: [
      { value: 'natural', label: 'Natural', detail: 'No grade: the colors as they are lit.' },
      { value: 'rich', label: 'Rich', detail: 'A touch more contrast, and the muted colors lifted.' },
      { value: 'vivid', label: 'Vivid', detail: 'Saturated neon and punchy contrast.' },
      { value: 'warm', label: 'Warm', detail: 'Rich, leaning amber.' },
      { value: 'cool', label: 'Cool', detail: 'Rich, leaning moonlit blue.' },
    ],
  },
  {
    key: 'lights',
    label: 'Light sources',
    hint: 'How strongly the laptop screens, lamps, signs and lit windows glow and light what is around them.',
    impact: 'none',
    options: [
      { value: 'subtle', label: 'Subtle', detail: 'Soft screens and lamps; the night stays dark.' },
      { value: 'normal', label: 'Normal', detail: 'Screens throw pools of light over the desks.' },
      { value: 'strong', label: 'Strong', detail: 'Brighter screens, lamps and windows.' },
      { value: 'neon', label: 'Neon', detail: 'Everything that glows, glows hard.' },
    ],
  },
  {
    key: 'style',
    label: 'Art style',
    hint: 'How light falls across every surface.',
    impact: 'none',
    options: [
      { value: 'smooth', label: 'Smooth', detail: 'Smooth shading, no outlines.' },
      { value: 'soft', label: 'Soft toon', detail: 'Three soft cartoon light bands, no outlines.' },
      { value: 'toon', label: 'Toon', detail: 'Three hard cartoon bands and ink outlines, like the Classic renderer. The outlines draw the office a second time.' },
    ],
  },
  {
    key: 'sharpness',
    label: 'Sharpness',
    hint: 'Contrast-adaptive sharpening on the final image, to win back what a lower resolution softens.',
    impact: 'low',
    options: [
      { value: 'off', label: 'Off', detail: 'No sharpening, and one pass fewer at 1.0× resolution.' },
      { value: 'low', label: 'Low', detail: 'A light touch.' },
      { value: 'medium', label: 'Medium', detail: 'Crisper edges and text.' },
      { value: 'high', label: 'High', detail: 'The crispest; can look gritty at 1.0×.' },
    ],
  },
];

export const ADVANCED_SETTINGS: readonly ChoiceSetting[] = [
  {
    key: 'debug',
    label: 'Debug view',
    hint: 'Look at one stage of the pipeline.',
    impact: 'none',
    options: [
      { value: 'final', label: 'Final image', detail: 'The picture as it is shown.' },
      { value: 'gi', label: 'GI only', detail: 'Only the bounce light from the probes.' },
      { value: 'hdr', label: 'HDR heatmap', detail: 'Grey is SDR; blue to red is 1× to 8× white.' },
    ],
  },
  {
    key: 'pace',
    label: 'Render pace',
    hint: 'How often the office draws while nothing moves.',
    impact: 'none',
    options: [
      { value: 'adaptive', label: 'Adaptive', detail: 'Drops to a few frames a second after 30 s of stillness.' },
      { value: 'full', label: 'Always full', detail: 'Every frame, so FPS and GPU readings stay comparable.' },
    ],
  },
];

export const CHOICE_SETTINGS: readonly ChoiceSetting[] = [...DISPLAY_SETTINGS, ...QUALITY_SETTINGS, ...PICTURE_SETTINGS, ...ADVANCED_SETTINGS];

/**
 * Each overall quality's settings. They are not one level across the board: what is cheap for what it shows (baked
 * GI, a bigger shadow map, which is only redrawn when something moves) climbs first, and what costs every frame (4×
 * MSAA, live GI) comes in last. Ultra leaves the 8192² shadow map and 120 live probes a second for Custom.
 */
export const QUALITY_PRESETS: Record<Level, Record<QualityKey, Level>> = {
  low: { antiAliasing: 'low', shadowQuality: 'low', giQuality: 'medium', liveGi: 'low' },
  medium: { antiAliasing: 'medium', shadowQuality: 'medium', giQuality: 'high', liveGi: 'low' },
  high: { antiAliasing: 'medium', shadowQuality: 'high', giQuality: 'veryHigh', liveGi: 'low' },
  veryHigh: { antiAliasing: 'high', shadowQuality: 'veryHigh', giQuality: 'veryHigh', liveGi: 'medium' },
  ultra: { antiAliasing: 'high', shadowQuality: 'veryHigh', giQuality: 'ultra', liveGi: 'veryHigh' },
};

export const QUALITY_HINTS: Record<Level, string> = {
  low: 'For integrated graphics: no anti-aliasing, a small shadow map and sparse bounce light.',
  medium: '2× MSAA, 2048² shadows and bounce light every 2 m.',
  high: '2× MSAA, 3072² shadows and dense bounce light with an extra bounce.',
  veryHigh: '4× MSAA, 4096² shadows, dense bounce light kept slowly live.',
  ultra: '4× MSAA, 4096² shadows, two extra bounces and live bounce light at 60 probes a second.',
};

/** The classic renderer until Remastered is turned on; then High, Normal brightness, Rich color, at 1.0×. */
export const REMASTER_DEFAULTS: RemasterSettings = {
  enabled: false,
  resolution: 1,
  ...QUALITY_PRESETS.high,
  brightness: 'normal',
  color: 'rich',
  lights: 'normal',
  style: 'smooth',
  sharpness: 'low',
  hdr: false,
  hdrHighlights: 'normal',
  debug: 'final',
  pace: 'adaptive',
};

/** A setting's value as its options list it: booleans as 'on' and 'off'. */
export function choiceValue(s: RemasterSettings, key: ChoiceKey): string {
  const v = s[key];
  return typeof v === 'boolean' ? (v ? 'on' : 'off') : v;
}

/** `s` with one setting changed. A value its options don't list leaves it as it was. */
export function withChoice(s: RemasterSettings, key: ChoiceKey, value: string): RemasterSettings {
  const c = CHOICE_SETTINGS.find((x) => x.key === key);
  if (!c?.options.some((o) => o.value === value)) return s;
  return { ...s, [key]: typeof REMASTER_DEFAULTS[key] === 'boolean' ? value === 'on' : value };
}

/** Whether a setting does anything right now. */
export function choiceLive(c: ChoiceSetting, s: RemasterSettings): boolean {
  return c.needs ? c.needs(s) : true;
}

/** The overall quality the settings add up to: the preset they all match, or Custom. */
export function qualityOf(s: RemasterSettings): Quality {
  for (const lv of LEVELS) {
    const p = QUALITY_PRESETS[lv];
    if ((Object.keys(p) as QualityKey[]).every((k) => s[k] === p[k])) return lv;
  }
  return 'custom';
}

/** `s` at an overall quality, with Remastered on. The picture, display and resolution settings are yours, not the preset's. */
export function applyQuality(lv: Level, s: RemasterSettings): RemasterSettings {
  return { ...s, ...QUALITY_PRESETS[lv], enabled: true };
}

/** Everything back to the defaults, with the renderer left as it is. */
export function resetRemaster(current: RemasterSettings): RemasterSettings {
  return { ...REMASTER_DEFAULTS, enabled: current.enabled };
}

/** Settings saved before the levels, when each dial was its own number: their preset becomes the nearest quality. */
function fromOldPreset(s: Record<string, unknown>): Partial<RemasterSettings> {
  const preset = s.preset;
  if (preset === 'performance') return QUALITY_PRESETS.medium;
  if (preset === 'ultra') return QUALITY_PRESETS.ultra;
  if (preset === 'toon') return { style: 'toon' };
  return {};
}

/** Saved settings, with anything missing, of the wrong type or not among its options back at its default. */
export function normalizeRemaster(saved: unknown): RemasterSettings {
  const out: RemasterSettings = { ...REMASTER_DEFAULTS };
  if (!saved || typeof saved !== 'object') return out;
  const s = saved as Record<string, unknown>;
  if (!('shadowQuality' in s) && typeof s.preset === 'string') Object.assign(out, fromOldPreset(s));
  for (const c of CHOICE_SETTINGS) {
    const v = s[c.key];
    const want = typeof REMASTER_DEFAULTS[c.key] === 'boolean' ? (typeof v === 'boolean' ? (v ? 'on' : 'off') : null) : v;
    if (typeof want === 'string' && c.options.some((o) => o.value === want)) Object.assign(out, withChoice(out, c.key, want));
  }
  if (typeof s.resolution === 'number' && Number.isFinite(s.resolution)) out.resolution = snapResolution(s.resolution);
  return out;
}

// ---- What the renderer draws with --------------------------------------------------------------

export type ToneMap = 'neutral' | 'agx' | 'aces' | 'reinhard' | 'cineon' | 'linear';
export type ToonRamp = 'classic' | 'bands5' | 'soft' | 'smooth';

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
  /** Probes re-baked a second once the bake is done; 0 keeps the bake as it is. */
  giLive: number;
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
  shadowMapSize: number;
  /** PCF filter radius in shadow-map texels. */
  shadowSoftness: number;
  toonRamp: ToonRamp;
  outlines: boolean;
  outlineThickness: number;
  outlineOpacity: number;
  debug: DebugView;
  pace: PaceMode;
}

const MSAA: Record<Level, number> = { low: 0, medium: 2, high: 4, veryHigh: 4, ultra: 4 };
/** The filter radius grows with the map, so the shadow's soft edge stays the same width in the room. */
const SHADOWS: Record<Level, { size: number; softness: number }> = {
  low: { size: 1024, softness: 0.5 },
  medium: { size: 2048, softness: 1 },
  high: { size: 3072, softness: 1.5 },
  veryHigh: { size: 4096, softness: 2 },
  ultra: { size: 8192, softness: 4 },
};
const GI: Record<Level, { spacing: number; bounces: number } | null> = {
  low: null,
  medium: { spacing: 3, bounces: 0 },
  high: { spacing: 2, bounces: 1 },
  veryHigh: { spacing: 1.4, bounces: 1 },
  ultra: { spacing: 1.4, bounces: 2 },
};
const LIVE_GI: Record<Level, number> = { low: 0, medium: 15, high: 30, veryHigh: 60, ultra: 120 };
const EXPOSURE: Record<Brightness, number> = { darker: 0.9, dark: 1.05, normal: 1.25, bright: 1.45, brighter: 1.7 };
const GRADES: Record<ColorLook, Pick<RenderParams, 'saturation' | 'vibrance' | 'contrast' | 'temperature' | 'tint'>> = {
  natural: { saturation: 1, vibrance: 0, contrast: 1, temperature: 0, tint: 0 },
  rich: { saturation: 1.05, vibrance: 0.15, contrast: 1.06, temperature: 0, tint: 0 },
  vivid: { saturation: 1.2, vibrance: 0.3, contrast: 1.1, temperature: 0, tint: 0 },
  warm: { saturation: 1.05, vibrance: 0.15, contrast: 1.06, temperature: 0.25, tint: 0.05 },
  cool: { saturation: 1, vibrance: 0.1, contrast: 1.06, temperature: -0.25, tint: 0 },
};
const LIGHTS: Record<LightLook, Pick<RenderParams, 'officeFill' | 'screenLight' | 'lampLight' | 'emissive' | 'screenGlow' | 'giGlow'>> = {
  subtle: { officeFill: 0.95, screenLight: 1, lampLight: 0.9, emissive: 1, screenGlow: 1, giGlow: 0.25 },
  normal: { officeFill: 1.05, screenLight: 1.4, lampLight: 1.2, emissive: 1.4, screenGlow: 1, giGlow: 0.4 },
  strong: { officeFill: 1.1, screenLight: 1.9, lampLight: 1.6, emissive: 1.9, screenGlow: 1.25, giGlow: 0.55 },
  neon: { officeFill: 1.15, screenLight: 2.6, lampLight: 2.1, emissive: 2.6, screenGlow: 1.6, giGlow: 0.75 },
};
const STYLES: Record<ArtStyle, { toonRamp: ToonRamp; outlines: boolean }> = {
  smooth: { toonRamp: 'smooth', outlines: false },
  soft: { toonRamp: 'soft', outlines: false },
  toon: { toonRamp: 'classic', outlines: true },
};
const SHARPEN: Record<Sharpness, number> = { off: 0, low: 0.25, medium: 0.5, high: 0.8 };
const HDR_PEAK: Record<HdrHighlights, number> = { subtle: 2, normal: 4, bright: 8, max: 16 };
/** In HDR, screens and signs glow past white by this much more. */
const HDR_GLOW = 1.6;

/** The numbers the renderer draws with for these settings. */
export function resolveRemaster(s: RemasterSettings): RenderParams {
  const gi = GI[s.giQuality];
  const shadows = SHADOWS[s.shadowQuality];
  const lights = LIGHTS[s.lights];
  return {
    enabled: s.enabled,
    resolution: s.resolution,
    msaa: MSAA[s.antiAliasing],
    sharpen: SHARPEN[s.sharpness],
    hdr: s.hdr,
    hdrPeak: HDR_PEAK[s.hdrHighlights],
    paperWhite: 1,
    toneMap: 'linear',
    exposure: EXPOSURE[s.brightness],
    gi: !!gi,
    giIntensity: 0.25,
    giSpacing: gi?.spacing ?? 3,
    giBounces: gi?.bounces ?? 0,
    giLive: gi ? LIVE_GI[s.liveGi] : 0,
    ...GRADES[s.color],
    moon: 1,
    skyFill: 1,
    ambientFill: 0.95,
    ...lights,
    screenGlow: lights.screenGlow * (s.hdr ? HDR_GLOW : 1),
    shadowMapSize: shadows.size,
    shadowSoftness: shadows.softness,
    ...STYLES[s.style],
    outlineThickness: 1.8,
    outlineOpacity: 1,
    debug: s.debug,
    pace: s.pace,
  };
}

/** How many probes fit along a span at a spacing: at least 2, so the grid has two ends. */
export function probeCount(span: number, spacing: number): number {
  return Math.max(2, Math.round(span / spacing) + 1);
}

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

// ---- Auto ----------------------------------------------------------------------------------------

/** What Auto knows about the machine. */
export interface SystemProfile {
  /** WebGL's unmasked renderer string, e.g. "ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)". */
  gpu: string;
  /** Device pixels the scene covers at 1.0× resolution. */
  pixels: number;
  /** The frame rate limit it should hold. */
  fpsCap: number;
}

export interface GpuGuess {
  /** The GPU's name with the driver noise taken out. */
  name: string;
  /** Rough drawing speed, with an Apple M1's 8-core GPU as 1. */
  score: number;
}

export interface AutoPick {
  quality: Level;
  resolution: number;
  gpu: GpuGuess;
}

/** The GPU's name out of a WebGL renderer string: ANGLE's wrapping, device ids, API names and (R)/(TM) taken out. */
export function gpuName(renderer: string): string {
  let n = renderer.replace(/\s+/g, ' ').trim();
  const angle = n.match(/^ANGLE \((.*)\)$/);
  if (angle) {
    const parts = angle[1].split(', ');
    n = parts[1] ?? parts[0];
  }
  return n
    .replace(/^ANGLE Metal Renderer: /, '')
    .replace(/\((R|TM)\)/gi, '')
    .replace(/ \(0x[0-9a-f]+\).*$/i, '')
    .replace(/ (Direct3D|OpenGL|Vulkan|vs_\d|ps_\d).*$/i, '')
    .replace(/\/PCIe.*$|\/SSE2.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const APPLE_GEN = [1, 1.25, 1.45, 1.7, 2.2];
const APPLE_VARIANT: Record<string, number> = { '': 1, pro: 2, max: 4, ultra: 8 };
const NVIDIA_GEN: Record<number, number> = { 9: 0.7, 10: 1, 16: 1.1, 20: 1.6, 30: 2.3, 40: 3.3, 50: 4.2 };
const NVIDIA_TIER: Record<number, number> = { 30: 0.6, 50: 1, 60: 1.6, 70: 2.4, 80: 3.2, 90: 4 };
const AMD_GEN: Record<number, number> = { 5: 1.4, 6: 2, 7: 2.8, 9: 3.6 };
const AMD_TIER: Record<number, number> = { 4: 0.6, 5: 0.8, 6: 1.2, 7: 1.8, 8: 2.6, 9: 3.4 };

function gpuScore(name: string): number {
  const n = name.toLowerCase();
  if (/swiftshader|llvmpipe|softpipe|software|basic render/.test(n)) return 0.05;
  const apple = n.match(/apple m(\d+)(?: (pro|max|ultra))?/);
  if (apple) {
    const gen = Number(apple[1]);
    const g = APPLE_GEN[gen - 1] ?? APPLE_GEN[APPLE_GEN.length - 1] * 1.25 ** (gen - APPLE_GEN.length);
    return g * APPLE_VARIANT[apple[2] ?? ''];
  }
  // Safari names every Apple GPU the same.
  if (n === 'apple gpu') return 1.5;
  const laptop = /laptop|max-q|mobile/.test(n) ? 0.65 : 1;
  const nv = n.match(/(?:gtx|rtx) ?(\d{1,2})(\d{2})\b/);
  if (nv) {
    const gen = Number(nv[1]);
    const genMul = NVIDIA_GEN[gen] ?? (gen > 50 ? NVIDIA_GEN[50] * 1.25 ** ((gen - 50) / 10) : 0.6);
    const tier = NVIDIA_TIER[Number(nv[2])] ?? 1;
    return genMul * tier * (/\bti\b|super/.test(n) ? 1.15 : 1) * laptop;
  }
  if (/rtx a\d{4}|quadro rtx/.test(n)) return 4 * laptop;
  if (/geforce mx/.test(n)) return 0.4;
  const rx = n.match(/rx ?(\d)(\d)\d0(m?)\b/);
  if (rx) {
    const genMul = AMD_GEN[Number(rx[1])] ?? 3.6;
    return genMul * (AMD_TIER[Number(rx[2])] ?? 1) * (/xtx?\b/.test(n) ? 1.1 : 1) * (rx[3] ? 0.7 : 1);
  }
  if (/rx ?5\d0\b/.test(n)) return 1.4;
  const apu = n.match(/radeon (\d{3})m\b/);
  if (apu) return ({ 890: 1.8, 880: 1.6, 780: 1.4, 760: 1.1, 680: 1.1, 660: 0.8 } as Record<string, number>)[apu[1]] ?? 0.6;
  if (/radeon|vega/.test(n)) return 0.6;
  const arc = n.match(/arc.* ([ab])(\d)\d0/);
  if (arc) return arc[1] === 'b' ? (arc[2] === '7' ? 4.5 : 3.8) : (({ 7: 3.5, 5: 2.5, 3: 1.2 } as Record<string, number>)[arc[2]] ?? 1.2);
  if (/\barc\b/.test(n)) return 1;
  if (/iris xe/.test(n)) return 0.5;
  if (/iris/.test(n)) return 0.35;
  if (/uhd/.test(n)) return 0.25;
  if (/intel/.test(n)) return 0.2;
  if (/adreno.*x1/.test(n)) return 1.5;
  if (/adreno|mali|powervr/.test(n)) return 0.25;
  return 1;
}

/** The GPU a WebGL renderer string names, and how fast it draws. Unknown GPUs count as an M1. */
export function gpuGuess(renderer: string): GpuGuess {
  const name = gpuName(renderer) || 'Unknown GPU';
  return { name, score: gpuScore(name) };
}

/**
 * How much of an M1's speed each overall quality needs to hold 60 FPS at 1080p. Each step asks for about half as much
 * again as the one below it. Below what Low needs, Auto lowers the resolution instead of the quality.
 */
export const AUTO_NEEDS: Record<Level, number> = { low: 0.35, medium: 0.55, high: 0.8, veryHigh: 1.15, ultra: 1.6 };
const FULL_HD = 1920 * 1080;

/**
 * The quality and resolution to start from on this machine, the way a game's auto-detect picks them: the GPU's
 * speed over the pixels and frames a second it has to draw. Below what Low needs, the resolution comes down instead,
 * to 0.5× at the least; it never goes above 1.0×.
 */
export function autoQuality(p: SystemProfile): AutoPick {
  const gpu = gpuGuess(p.gpu);
  const load = (Math.max(1, p.pixels) / FULL_HD) * (clamp(p.fpsCap, 30, 240) / 60);
  const speed = gpu.score / load;
  let quality: Level = 'low';
  for (const lv of LEVELS) if (speed >= AUTO_NEEDS[lv]) quality = lv;
  // Pixels go with the square of the resolution scale.
  const resolution = speed >= AUTO_NEEDS.low ? 1 : Math.max(RESOLUTION_MIN, Math.floor(Math.sqrt(speed / AUTO_NEEDS.low) * 10) / 10);
  return { quality, resolution, gpu };
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
