/**
 * The Remastered renderer's settings: what each one is, its range, the presets, and how a saved copy is read back.
 * The Graphics Lab panel is built from REMASTER_SECTIONS, so a setting added here shows up there by itself.
 * Nothing here touches the DOM or WebGL; localStorage is only read inside try.
 */

export type ToneMap = 'neutral' | 'agx' | 'aces' | 'reinhard' | 'cineon' | 'linear';
export type AAMode = 'msaa' | 'msaa-smaa' | 'smaa' | 'fxaa' | 'off';
export type ShadowFilter = 'pcf' | 'vsm';
export type ShadowMapSize = '1024' | '2048' | '4096' | '8192';
export type ToonRamp = 'classic' | 'bands5' | 'soft' | 'smooth';
export type GiDensity = 'low' | 'medium' | 'high';
export type DebugView = 'final' | 'ao' | 'depth' | 'hdr' | 'gi';
export type PaceMode = 'adaptive' | 'full';
export type AoSamples = '8' | '16' | '24' | '32';
export type AoResolution = 'half' | 'full';

export interface RemasterSettings {
  enabled: boolean;
  preset: string;
  // Image
  renderScale: number;
  aa: AAMode;
  sharpen: number;
  // HDR and tone
  hdr: boolean;
  hdrPeak: number;
  paperWhite: number;
  toneMap: ToneMap;
  exposure: number;
  // Bloom
  bloom: boolean;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  bloomLevels: number;
  // Ambient occlusion
  ao: boolean;
  aoRadius: number;
  aoIntensity: number;
  aoThickness: number;
  aoBlend: number;
  aoSamples: AoSamples;
  aoResolution: AoResolution;
  // Global illumination
  gi: boolean;
  giIntensity: number;
  giGlow: number;
  giDensity: GiDensity;
  giRolling: boolean;
  giSpeed: number;
  giBounces: number;
  // Moon light shafts
  shafts: boolean;
  shaftsIntensity: number;
  shaftsDecay: number;
  shaftsLength: number;
  // Color
  saturation: number;
  vibrance: number;
  contrast: number;
  temperature: number;
  tint: number;
  // Lights
  moon: number;
  skyFill: number;
  ambientFill: number;
  officeFill: number;
  screenLight: number;
  lampLight: number;
  emissive: number;
  screenGlow: number;
  // Shadows
  shadowFilter: ShadowFilter;
  shadowMapSize: ShadowMapSize;
  shadowSoftness: number;
  // Look
  toonRamp: ToonRamp;
  outlines: boolean;
  outlineThickness: number;
  outlineOpacity: number;
  // Diagnostics
  debug: DebugView;
  pace: PaceMode;
}

export type RemasterKey = keyof RemasterSettings;

interface Base<K extends RemasterKey> {
  key: K;
  label: string;
  hint: string;
  /** Greyed out unless this is true (its master switch). */
  needs?: RemasterKey;
}
export type RangeControl = Base<RemasterKey> & { kind: 'range'; min: number; max: number; step: number; unit?: '%' | '×' | 'px' | 'm' | 'K' | ''; percent?: boolean };
export type ToggleControl = Base<RemasterKey> & { kind: 'toggle' };
export type SelectControl = Base<RemasterKey> & { kind: 'select'; options: readonly (readonly [string, string])[] };
export type RemasterControl = RangeControl | ToggleControl | SelectControl;

export interface RemasterSection {
  id: string;
  title: string;
  icon: string;
  note?: string;
  controls: RemasterControl[];
}

export const REMASTER_DEFAULTS: RemasterSettings = {
  enabled: true,
  preset: 'crisp',
  renderScale: 1,
  aa: 'msaa',
  sharpen: 0.25,
  hdr: true,
  hdrPeak: 4,
  paperWhite: 1,
  toneMap: 'neutral',
  exposure: 1,
  bloom: true,
  bloomStrength: 0.35,
  bloomRadius: 0.35,
  bloomThreshold: 0.9,
  bloomLevels: 3,
  ao: true,
  aoRadius: 0.6,
  aoIntensity: 1,
  aoThickness: 1,
  aoBlend: 0.8,
  aoSamples: '16',
  aoResolution: 'half',
  gi: true,
  giIntensity: 0.6,
  giGlow: 0.15,
  giDensity: 'medium',
  giRolling: true,
  giSpeed: 30,
  giBounces: 1,
  shafts: false,
  shaftsIntensity: 0.6,
  shaftsDecay: 0.96,
  shaftsLength: 0.75,
  saturation: 1.05,
  vibrance: 0.1,
  contrast: 1.04,
  temperature: 0,
  tint: 0,
  moon: 1,
  skyFill: 1,
  ambientFill: 1,
  officeFill: 1,
  screenLight: 1.15,
  lampLight: 1.1,
  emissive: 1.4,
  screenGlow: 1.6,
  shadowFilter: 'pcf',
  shadowMapSize: '4096',
  shadowSoftness: 1.5,
  toonRamp: 'classic',
  outlines: true,
  outlineThickness: 1.8,
  outlineOpacity: 1,
  debug: 'final',
  pace: 'adaptive',
};

const TONE_MAPS = [
  ['neutral', 'Neutral (Khronos PBR)'],
  ['agx', 'AgX (filmic)'],
  ['aces', 'ACES filmic'],
  ['reinhard', 'Reinhard'],
  ['cineon', 'Cineon'],
  ['linear', 'Linear (clip)'],
] as const;

export const REMASTER_SECTIONS: RemasterSection[] = [
  {
    id: 'image',
    title: 'Image',
    icon: '🖥️',
    controls: [
      { key: 'enabled', kind: 'toggle', label: 'Remastered renderer', hint: 'Off draws the office exactly the way Droid Office does, with the classic Graphics settings.' },
      { key: 'renderScale', kind: 'range', min: 0.5, max: 2, step: 0.05, percent: true, label: 'Render scale', hint: 'Below 100% upscales; above 100% supersamples for the cleanest edges and text.', needs: 'enabled' },
      {
        key: 'aa',
        kind: 'select',
        label: 'Anti-aliasing',
        hint: 'MSAA is the sharpest. SMAA catches edges MSAA misses, like the outlines. FXAA is cheapest and softest.',
        needs: 'enabled',
        options: [
          ['msaa', '4× MSAA'],
          ['msaa-smaa', '4× MSAA + SMAA'],
          ['smaa', 'SMAA'],
          ['fxaa', 'FXAA'],
          ['off', 'Off'],
        ],
      },
      { key: 'sharpen', kind: 'range', min: 0, max: 1, step: 0.05, percent: true, label: 'Sharpening (CAS)', hint: 'Contrast-adaptive sharpening on the final image.', needs: 'enabled' },
    ],
  },
  {
    id: 'hdr',
    title: 'HDR and tone',
    icon: '☀️',
    note: 'Native HDR draws highlights brighter than white on an EDR display such as the MacBook Pro’s XDR panel. Everything at or below white looks as it does in SDR.',
    controls: [
      { key: 'hdr', kind: 'toggle', label: 'Native HDR (EDR)', hint: 'Extended-range output through a float16 WebGPU canvas. Falls back to SDR where the display or browser can’t.', needs: 'enabled' },
      { key: 'hdrPeak', kind: 'range', min: 1, max: 16, step: 0.25, unit: '×', label: 'HDR peak', hint: 'How many times brighter than white the brightest highlight may go. The XDR panel shows up to about 16× in a dim room.', needs: 'hdr' },
      { key: 'paperWhite', kind: 'range', min: 0.5, max: 2, step: 0.05, unit: '×', label: 'Paper white', hint: 'Brightness of everything that isn’t a highlight, relative to the desktop’s white.', needs: 'hdr' },
      { key: 'toneMap', kind: 'select', label: 'Tone mapping', hint: 'How highlights roll off to the display’s peak. Neutral leaves colors below the knee untouched.', needs: 'enabled', options: TONE_MAPS },
      { key: 'exposure', kind: 'range', min: 0.25, max: 4, step: 0.05, unit: '×', label: 'Exposure', hint: 'Scene brightness before tone mapping.', needs: 'enabled' },
    ],
  },
  {
    id: 'bloom',
    title: 'Bloom',
    icon: '✨',
    controls: [
      { key: 'bloom', kind: 'toggle', label: 'Bloom', hint: 'Light bleeding off screens, signs and lamps.', needs: 'enabled' },
      { key: 'bloomStrength', kind: 'range', min: 0, max: 2, step: 0.05, label: 'Strength', hint: 'How much glow is added.', needs: 'bloom' },
      { key: 'bloomRadius', kind: 'range', min: 0, max: 1, step: 0.05, label: 'Radius', hint: 'Tight halo (0) to wide haze (1).', needs: 'bloom' },
      { key: 'bloomThreshold', kind: 'range', min: 0, max: 3, step: 0.05, label: 'Threshold', hint: 'Only light brighter than this blooms. Above 1 keeps it to true highlights.', needs: 'bloom' },
      {
        key: 'bloomLevels',
        kind: 'range',
        min: 1,
        max: 5,
        step: 1,
        label: 'Spread levels',
        hint: 'Blur levels, each half the size of the last. More reach further across the room; on Apple GPUs each level past the second costs about 1 ms.',
        needs: 'bloom',
      },
    ],
  },
  {
    id: 'ao',
    title: 'Ambient occlusion',
    icon: '🌑',
    controls: [
      { key: 'ao', kind: 'toggle', label: 'Ambient occlusion (GTAO)', hint: 'Contact shadows where things meet: under desks, chairs, people and in corners.', needs: 'enabled' },
      { key: 'aoRadius', kind: 'range', min: 0.1, max: 2, step: 0.05, unit: 'm', label: 'Radius', hint: 'How far each pixel looks for occluders.', needs: 'ao' },
      { key: 'aoIntensity', kind: 'range', min: 0.25, max: 3, step: 0.05, unit: '×', label: 'Intensity', hint: 'How dark the occlusion gets.', needs: 'ao' },
      { key: 'aoThickness', kind: 'range', min: 0.1, max: 4, step: 0.05, unit: 'm', label: 'Thickness', hint: 'How thick an occluder is assumed to be. Lower stops halos round thin things.', needs: 'ao' },
      { key: 'aoBlend', kind: 'range', min: 0, max: 1, step: 0.05, percent: true, label: 'Blend', hint: 'How much of the AO reaches the final image.', needs: 'ao' },
      {
        key: 'aoSamples',
        kind: 'select',
        label: 'Samples',
        hint: 'More samples, less noise, more GPU.',
        needs: 'ao',
        options: [
          ['8', '8'],
          ['16', '16'],
          ['24', '24'],
          ['32', '32'],
        ],
      },
      {
        key: 'aoResolution',
        kind: 'select',
        label: 'Resolution',
        hint: 'Half works the AO out for a quarter of the pixels and scales it up: most of the look for about a third of the GPU.',
        needs: 'ao',
        options: [
          ['half', 'Half'],
          ['full', 'Full'],
        ],
      },
    ],
  },
  {
    id: 'gi',
    title: 'Global illumination',
    icon: '💡',
    note: 'A grid of light probes through the floor captures the light bouncing off every surface (the orange of the laptop screens, the lamps, the moon) and lights the room with it.',
    controls: [
      { key: 'gi', kind: 'toggle', label: 'Probe GI', hint: 'Diffuse bounce light from a baked light-probe grid.', needs: 'enabled' },
      { key: 'giIntensity', kind: 'range', min: 0, max: 3, step: 0.05, unit: '×', label: 'Intensity', hint: 'How strong the bounce light is.', needs: 'gi' },
      {
        key: 'giGlow',
        kind: 'range',
        min: 0,
        max: 1,
        step: 0.05,
        percent: true,
        label: 'Glowing surfaces as light',
        hint: 'How much screens, signs, ceiling tubes and lit windows light the room through the probes. In the classic office they light nothing; at 100% the tubes flood it. Takes effect as probes rebake.',
        needs: 'gi',
      },
      {
        key: 'giDensity',
        kind: 'select',
        label: 'Probe density',
        hint: 'Probes every 3 m, 2 m or 1.4 m. Denser catches smaller pools of light; a rebake takes longer.',
        needs: 'gi',
        options: [
          ['low', 'Low (3 m)'],
          ['medium', 'Medium (2 m)'],
          ['high', 'High (1.4 m)'],
        ],
      },
      { key: 'giBounces', kind: 'range', min: 0, max: 3, step: 1, label: 'Extra bounces', hint: 'Light that bounced off one surface lights the next. Each one is another bake pass.', needs: 'gi' },
      { key: 'giRolling', kind: 'toggle', label: 'Live GI', hint: 'Keeps re-baking a few probes every frame, so screens, people and weather show up in the bounce light.', needs: 'gi' },
      {
        key: 'giSpeed',
        kind: 'range',
        min: 5,
        max: 600,
        step: 5,
        label: 'Live probes per second',
        hint: 'How many probes are re-baked each second while Live GI is on, spread over the frames. Each one draws the office six more times.',
        needs: 'giRolling',
      },
    ],
  },
  {
    id: 'shafts',
    title: 'Light shafts',
    icon: '🌙',
    controls: [
      { key: 'shafts', kind: 'toggle', label: 'Moonlight shafts', hint: 'Rays of moonlight past the window frames, walls and skyline.', needs: 'enabled' },
      { key: 'shaftsIntensity', kind: 'range', min: 0, max: 3, step: 0.05, unit: '×', label: 'Intensity', hint: 'How bright the rays are.', needs: 'shafts' },
      { key: 'shaftsDecay', kind: 'range', min: 0.85, max: 1, step: 0.005, label: 'Decay', hint: 'How quickly a ray fades away from the moon.', needs: 'shafts' },
      { key: 'shaftsLength', kind: 'range', min: 0.2, max: 1.5, step: 0.05, label: 'Length', hint: 'How far across the screen the rays reach.', needs: 'shafts' },
    ],
  },
  {
    id: 'color',
    title: 'Color',
    icon: '🎨',
    controls: [
      { key: 'saturation', kind: 'range', min: 0, max: 2, step: 0.01, unit: '×', label: 'Saturation', hint: 'Every color, evenly.', needs: 'enabled' },
      { key: 'vibrance', kind: 'range', min: -1, max: 1, step: 0.01, label: 'Vibrance', hint: 'Lifts the muted colors more than the vivid ones.', needs: 'enabled' },
      { key: 'contrast', kind: 'range', min: 0.5, max: 1.5, step: 0.01, unit: '×', label: 'Contrast', hint: 'Around middle grey, before tone mapping.', needs: 'enabled' },
      { key: 'temperature', kind: 'range', min: -1, max: 1, step: 0.01, label: 'Temperature', hint: 'Cooler (blue) to warmer (amber).', needs: 'enabled' },
      { key: 'tint', kind: 'range', min: -1, max: 1, step: 0.01, label: 'Tint', hint: 'Green to magenta.', needs: 'enabled' },
    ],
  },
  {
    id: 'lights',
    title: 'Lights',
    icon: '🔦',
    controls: [
      { key: 'moon', kind: 'range', min: 0, max: 4, step: 0.05, unit: '×', label: 'Moonlight', hint: 'The moon, the one light that casts shadows.', needs: 'enabled' },
      { key: 'skyFill', kind: 'range', min: 0, max: 3, step: 0.05, unit: '×', label: 'Sky fill', hint: 'Light from the night sky above and the ground below.', needs: 'enabled' },
      { key: 'ambientFill', kind: 'range', min: 0, max: 3, step: 0.05, unit: '×', label: 'Ambient', hint: 'Flat light everywhere.', needs: 'enabled' },
      { key: 'officeFill', kind: 'range', min: 0, max: 3, step: 0.05, unit: '×', label: 'Office fill', hint: 'The neon fill inside the office and the garage.', needs: 'enabled' },
      { key: 'screenLight', kind: 'range', min: 0, max: 4, step: 0.05, unit: '×', label: 'Laptop screen light', hint: 'The pools of light the laptop screens throw over the desks.', needs: 'enabled' },
      { key: 'lampLight', kind: 'range', min: 0, max: 4, step: 0.05, unit: '×', label: 'Street lamps', hint: 'The lamps and string lights outside.', needs: 'enabled' },
      { key: 'emissive', kind: 'range', min: 0, max: 4, step: 0.05, unit: '×', label: 'Emissive surfaces', hint: 'Lit windows across the city, bulbs and glowing trim.', needs: 'enabled' },
      { key: 'screenGlow', kind: 'range', min: 0.5, max: 4, step: 0.05, unit: '×', label: 'Screen and sign brightness', hint: 'Laptop screens, signs and LEDs. Above 1 they glow past white in HDR and catch the bloom.', needs: 'enabled' },
    ],
  },
  {
    id: 'shadows',
    title: 'Shadows',
    icon: '🌗',
    controls: [
      {
        key: 'shadowMapSize',
        kind: 'select',
        label: 'Shadow resolution',
        hint: 'The moon’s shadow map. Smart shadows only redraw it when a caster moves, so a big one costs little.',
        needs: 'enabled',
        options: [
          ['1024', '1024²'],
          ['2048', '2048²'],
          ['4096', '4096²'],
          ['8192', '8192²'],
        ],
      },
      {
        key: 'shadowFilter',
        kind: 'select',
        label: 'Filter',
        hint: 'PCF is crisp. VSM is soft and smooth but can leak light where shadows overlap.',
        needs: 'enabled',
        options: [
          ['pcf', 'PCF'],
          ['vsm', 'VSM'],
        ],
      },
      { key: 'shadowSoftness', kind: 'range', min: 0, max: 8, step: 0.25, label: 'Softness', hint: 'Blur radius at the edge of a shadow.', needs: 'enabled' },
    ],
  },
  {
    id: 'look',
    title: 'Look',
    icon: '🖍️',
    controls: [
      {
        key: 'toonRamp',
        kind: 'select',
        label: 'Shading',
        hint: 'The cartoon light bands on every surface.',
        needs: 'enabled',
        options: [
          ['classic', 'Toon, 3 bands'],
          ['bands5', 'Toon, 5 bands'],
          ['soft', 'Toon, soft bands'],
          ['smooth', 'Smooth'],
        ],
      },
      { key: 'outlines', kind: 'toggle', label: 'Ink outlines', hint: 'The cartoon outline round every solid.', needs: 'enabled' },
      { key: 'outlineThickness', kind: 'range', min: 0.5, max: 5, step: 0.1, label: 'Outline thickness', hint: 'How thick the ink line is.', needs: 'outlines' },
      { key: 'outlineOpacity', kind: 'range', min: 0, max: 1, step: 0.05, percent: true, label: 'Outline opacity', hint: 'How dark the ink line is.', needs: 'outlines' },
    ],
  },
  {
    id: 'debug',
    title: 'Diagnostics',
    icon: '🧪',
    controls: [
      {
        key: 'debug',
        kind: 'select',
        label: 'View',
        hint: 'Look at one stage of the pipeline. HDR heatmap: grey is SDR, blue to red is 1× to 8× white.',
        needs: 'enabled',
        options: [
          ['final', 'Final image'],
          ['ao', 'Ambient occlusion'],
          ['gi', 'GI only'],
          ['depth', 'Depth'],
          ['hdr', 'HDR heatmap'],
        ],
      },
      {
        key: 'pace',
        kind: 'select',
        label: 'Render pace',
        hint: 'Adaptive drops to a few frames a second after 30 s of stillness. Always full keeps every frame, so FPS and GPU readings stay comparable.',
        options: [
          ['adaptive', 'Adaptive'],
          ['full', 'Always full rate'],
        ],
      },
    ],
  },
];

export const REMASTER_CONTROLS: RemasterControl[] = REMASTER_SECTIONS.flatMap((s) => s.controls);

export interface RemasterPreset {
  id: string;
  label: string;
  hint: string;
  values: Partial<RemasterSettings>;
}

export const REMASTER_PRESETS: RemasterPreset[] = [
  { id: 'classic', label: 'Classic', hint: 'The normal Droid Office renderer.', values: { enabled: false } },
  {
    id: 'performance',
    label: 'Performance',
    hint: 'Most of the look for the least GPU.',
    values: { enabled: true, renderScale: 0.8, aa: 'fxaa', sharpen: 0.45, ao: false, gi: true, giDensity: 'low', giRolling: false, giBounces: 0, bloom: true, shafts: false, shadowMapSize: '2048', shadowFilter: 'pcf', shadowSoftness: 1 },
  },
  { id: 'crisp', label: 'Crisp', hint: 'Native resolution, MSAA, bloom, AO, GI and HDR. Nothing that blurs.', values: { ...REMASTER_DEFAULTS } },
  {
    id: 'cinematic',
    label: 'Cinematic',
    hint: 'Moonlight shafts, filmic tone, warmer glow.',
    values: {
      enabled: true,
      renderScale: 1,
      aa: 'msaa-smaa',
      toneMap: 'aces',
      exposure: 1.1,
      bloom: true,
      bloomStrength: 0.6,
      bloomRadius: 0.55,
      bloomThreshold: 0.75,
      bloomLevels: 5,
      shafts: true,
      gi: true,
      giIntensity: 0.6,
      giBounces: 2,
      screenGlow: 2.2,
      emissive: 1.8,
      contrast: 1.08,
      saturation: 1.1,
      temperature: 0.1,
      shadowSoftness: 2.5,
    },
  },
  {
    id: 'ultra',
    label: 'Ultra',
    hint: '150% supersampling, 8K shadows, dense GI, 32-sample AO.',
    values: {
      enabled: true,
      renderScale: 1.5,
      aa: 'msaa-smaa',
      sharpen: 0.15,
      ao: true,
      aoSamples: '32',
      aoResolution: 'full',
      gi: true,
      giDensity: 'high',
      giBounces: 2,
      giRolling: true,
      giSpeed: 120,
      shadowMapSize: '8192',
      shadowSoftness: 1.25,
      bloom: true,
      bloomLevels: 5,
    },
  },
  {
    id: 'nik',
    label: 'Nik',
    hint: 'Tuned for a 16" M5 Pro MacBook Pro at 3456×2168 and 120 Hz: native resolution, SMAA, HDR and bloom, the classic colors, and warmer screen light in place of GI and AO.',
    // Measured full screen on that machine: a steady 120 FPS in every spot tried, about 3 ms of GPU a frame. GI's
    // per-pixel probe lookups and AO each cost more than the HDR copy leaves room for at that size, and MSAA on the
    // float target does too. Linear keeps the dark room as the classic renderer draws it; Neutral's toe takes the grey
    // out of it, which only GI's extra light makes up for.
    values: {
      enabled: true,
      renderScale: 1,
      aa: 'smaa',
      sharpen: 0.25,
      hdr: true,
      hdrPeak: 4,
      toneMap: 'linear',
      bloom: true,
      bloomStrength: 0.45,
      bloomRadius: 0.4,
      bloomThreshold: 1,
      bloomLevels: 3,
      ao: false,
      gi: false,
      giRolling: false,
      shafts: false,
      saturation: 1.05,
      vibrance: 0.15,
      contrast: 1.06,
      screenLight: 1.4,
      lampLight: 1.2,
      emissive: 1.6,
      screenGlow: 2,
      shadowMapSize: '4096',
      shadowFilter: 'pcf',
      shadowSoftness: 1.5,
      outlines: true,
    },
  },
];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A range value snapped to its control's step and clamped to its range. */
export function snapRange(c: RangeControl, v: number): number {
  const snapped = c.min + Math.round((v - c.min) / c.step) * c.step;
  // Rounded to the step's decimals, so 0.35 is saved as 0.35 and not 0.35000000000000003.
  const decimals = Math.max(0, -Math.floor(Math.log10(c.step)) + 1);
  return clamp(Number(snapped.toFixed(decimals)), c.min, c.max);
}

/** Saved settings, with anything missing, of the wrong type or out of range back at its default. */
export function normalizeRemaster(saved: unknown): RemasterSettings {
  const out: RemasterSettings = { ...REMASTER_DEFAULTS };
  if (!saved || typeof saved !== 'object') return out;
  const s = saved as Record<string, unknown>;
  const o = out as unknown as Record<string, unknown>;
  for (const c of REMASTER_CONTROLS) {
    const v = s[c.key];
    if (c.kind === 'toggle' && typeof v === 'boolean') o[c.key] = v;
    else if (c.kind === 'range' && typeof v === 'number' && Number.isFinite(v)) o[c.key] = snapRange(c, v);
    else if (c.kind === 'select' && typeof v === 'string' && c.options.some(([value]) => value === v)) o[c.key] = v;
  }
  if (typeof s.preset === 'string' && (s.preset === 'custom' || REMASTER_PRESETS.some((p) => p.id === s.preset))) out.preset = s.preset;
  return out;
}

/** `settings` with a preset's values applied over the defaults. */
export function applyPreset(id: string, current: RemasterSettings): RemasterSettings {
  const preset = REMASTER_PRESETS.find((p) => p.id === id);
  if (!preset) return current;
  // Classic only turns the renderer off, so switching back on returns to what you had.
  if (id === 'classic') return { ...current, enabled: false, preset: id };
  // The diagnostics view and render pace are yours, not the preset's.
  return normalizeRemaster({ ...REMASTER_DEFAULTS, ...preset.values, debug: current.debug, pace: current.pace, preset: id });
}

/** Whether a control does anything right now: its master switch (and that one's) is on. */
export function controlLive(c: RemasterControl, s: RemasterSettings): boolean {
  let need = c.needs;
  const seen = new Set<RemasterKey>();
  while (need && !seen.has(need)) {
    if (!s[need]) return false;
    seen.add(need);
    need = REMASTER_CONTROLS.find((x) => x.key === need)?.needs;
  }
  return true;
}

/** How a range control shows its value. */
export function formatRange(c: RangeControl, v: number): string {
  if (c.percent) return `${Math.round(v * 100)}%`;
  const decimals = c.step >= 1 ? 0 : c.step >= 0.1 ? 1 : 2;
  const unit = c.unit === undefined ? '' : c.unit === '×' ? '×' : c.unit ? ` ${c.unit}` : '';
  return `${v.toFixed(decimals)}${unit}`;
}

/** Spacing between probes for a density, in meters. */
export const GI_SPACING: Record<GiDensity, number> = { low: 3, medium: 2, high: 1.4 };

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
