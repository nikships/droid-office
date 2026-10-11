/** How the office draws: the render resolution the scene is drawn at, how it is brought up to the screen's, and the overlay that says what that costs. */
export interface GraphicsSettings {
  /** The scene's render resolution as a share of the screen's, 0.5–1. Below 1 it is upscaled. */
  scale: number;
  /** Temporal anti-aliasing: jittered frames accumulated into a full-resolution history (TAAU when `scale` is below 1). */
  taa: boolean;
  /** How hard the upscaled or TAA image is sharpened, 0–1. Unused when the scene draws natively without TAA. */
  sharpen: number;
  /** The FPS, GPU time and render resolution readout in the bottom-right corner. */
  stats: boolean;
}

export const RENDER_SCALE_MIN = 0.5;
export const RENDER_SCALE_STEP = 0.05;

export const GRAPHICS_DEFAULTS: GraphicsSettings = { scale: 1, taa: false, sharpen: 0.5, stats: true };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function normalizeScale(v: number): number {
  // Snapped in whole percent, so 0.7 is saved as 0.7 and not 0.7000000000000001.
  const step = Math.round(RENDER_SCALE_STEP * 100);
  return clamp(Math.round((v * 100) / step) * step, RENDER_SCALE_MIN * 100, 100) / 100;
}

/** Saved graphics settings, with anything missing or out of range back at its default. */
export function normalizeGraphics(saved: unknown): GraphicsSettings {
  const g = { ...GRAPHICS_DEFAULTS };
  if (!saved || typeof saved !== 'object') return g;
  const s = saved as Record<string, unknown>;
  if (typeof s.scale === 'number' && Number.isFinite(s.scale)) g.scale = normalizeScale(s.scale);
  if (typeof s.taa === 'boolean') g.taa = s.taa;
  if (typeof s.sharpen === 'number' && Number.isFinite(s.sharpen)) g.sharpen = clamp(s.sharpen, 0, 1);
  if (typeof s.stats === 'boolean') g.stats = s.stats;
  return g;
}

/** The scene's render target for a drawing buffer of `width`×`height` at `scale`, at least 1×1. */
export function renderSize(width: number, height: number, scale: number): { width: number; height: number } {
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The radical inverse of `index` in `base`: the Halton sequence, in [0, 1). */
export function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/**
 * How many jitter positions TAA cycles through. Each output pixel needs about eight samples land in it, and an input
 * pixel covers 1/scale² output pixels, so a lower render resolution needs a longer cycle (FSR 2's rule).
 */
export function jitterPhases(scale: number): number {
  return Math.min(64, Math.max(8, Math.ceil(8 / (scale * scale))));
}

/** The sub-pixel offset of frame `frame`, in input pixels, each axis in [-0.5, 0.5). Index 0 of Halton is skipped: it is (0, 0) every cycle. */
export function jitterAt(frame: number, scale: number): { x: number; y: number } {
  const i = (frame % jitterPhases(scale)) + 1;
  return { x: halton(i, 2) - 0.5, y: halton(i, 3) - 0.5 };
}

/** The share of `windowMs` the GPU spent on `gpuMs` of the office's work, 0–1. */
export function gpuBusy(gpuMs: number, windowMs: number): number {
  return windowMs > 0 ? clamp(gpuMs / windowMs, 0, 1) : 0;
}

/** The corner readout: frame rate, the office's GPU time, the Mac's whole GPU, and what the scene is drawn at. */
export function statsText(s: {
  fps: number;
  frameMs: number;
  gpu: { ms: number; busy: number } | null;
  gpuNote?: string;
  system: number | null;
  render: { width: number; height: number };
  output: { width: number; height: number };
  scale: number;
  taa: boolean;
}): string {
  const lines = [`${Math.round(s.fps)} FPS · ${s.frameMs.toFixed(1)} ms`];
  if (s.gpu) lines.push(`GPU ${s.gpu.ms.toFixed(2)} ms/frame · ${Math.round(s.gpu.busy * 100)}% busy`);
  else if (s.gpuNote) lines.push(`GPU ${s.gpuNote}`);
  if (s.system !== null) lines.push(`Mac GPU ${Math.round(s.system)}%`);
  const mode = s.taa ? (s.scale < 1 ? 'TAAU' : 'TAA') : s.scale < 1 ? 'bilinear' : 'MSAA';
  lines.push(`${Math.round(s.scale * 100)}% ${s.render.width}×${s.render.height}${s.scale < 1 ? ` → ${s.output.width}×${s.output.height}` : ''} · ${mode}`);
  return lines.join('\n');
}
