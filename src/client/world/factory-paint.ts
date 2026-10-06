import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loadFonts, MONO, SANS } from '../fonts';
import { ANISOTROPY, fitScale } from './texture-quality';

// Canvas painting for the Factory wayfinding: the brand's palette and type, a sign atlas that puts
// every small plate on one texture, and the LED ticker's dot matrix.

export const INK = '#0a0a0a';
export const BASE = '#020202';
export const LIGHT = '#eeeeee';
export const MUTED = '#8c8c8c';
export const HAIR = '#2e2e2e';
export const HAIR_SOFT = '#171717';
export const ORANGE = '#ee6018';
export const ORANGE_BRIGHT = '#ef6f2e';
export const GREEN = '#3ccf91';

export const mono = (px: number, weight = 500) => `${weight} ${px}px ${MONO}`;
export const sans = (px: number, weight = 600) => `${weight} ${px}px ${SANS}`;

/** Whatever has been painted, to paint again once the bundled fonts arrive (they load after the office is built). */
const repaints: (() => void)[] = [];
let fontsHooked = false;

function onFonts(repaint: () => void) {
  repaints.push(repaint);
  if (fontsHooked) return;
  fontsHooked = true;
  // Node tests build the office with a stubbed document that may not load fonts at all.
  if (typeof document === 'undefined' || typeof document.fonts?.load !== 'function') return;
  void loadFonts().then(() => {
    for (const r of repaints) r();
  });
}

/**
 * `text` drawn from `x` with `track` pixels between letters (canvas letterSpacing isn't everywhere),
 * aligned on `x` by `align`. Returns how wide it drew.
 */
export function tracked(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, track: number, align: 'left' | 'center' | 'right' = 'left'): number {
  const chars = [...text];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const width = widths.reduce((a, b) => a + b, 0) + track * Math.max(0, chars.length - 1);
  let at = align === 'left' ? x : align === 'center' ? x - width / 2 : x - width;
  const was = ctx.textAlign;
  ctx.textAlign = 'left';
  chars.forEach((c, i) => {
    ctx.fillText(c, at, y);
    at += widths[i] + track;
  });
  ctx.textAlign = was;
  return width;
}

/** How wide `tracked` would draw `text`. */
export function trackedWidth(ctx: CanvasRenderingContext2D, text: string, track: number): number {
  const chars = [...text];
  return chars.reduce((w, c) => w + ctx.measureText(c).width, 0) + track * Math.max(0, chars.length - 1);
}

/** A plate's face: ink, with a hairline just inside its edge. */
export function plateFace(ctx: CanvasRenderingContext2D, w: number, h: number, inset = 5, line = 1.5) {
  ctx.fillStyle = INK;
  ctx.fillRect(-4, -4, w + 8, h + 8);
  ctx.strokeStyle = HAIR;
  ctx.lineWidth = line;
  ctx.strokeRect(inset, inset, w - 2 * inset, h - 2 * inset);
}

/** A numbered eyebrow, "01 LABEL": the index in orange, the label in `color`. Returns how wide it drew. */
export function eyebrow(ctx: CanvasRenderingContext2D, index: string, label: string, x: number, y: number, px: number, color = MUTED, weight = 500): number {
  ctx.font = mono(px, weight);
  ctx.textBaseline = 'middle';
  const track = px * 0.12;
  let w = 0;
  if (index) {
    ctx.fillStyle = ORANGE_BRIGHT;
    w = tracked(ctx, index, x, y, track) + px * 0.9;
  }
  ctx.fillStyle = color;
  return w + tracked(ctx, label, x + w, y, track);
}

/** A canvas texture `w` by `h` (pixels at `scale` 1) painted by `paint`, painted again once the fonts load. */
export function paintedTexture(w: number, h: number, scale: number, paint: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  const k = fitScale(w, h, scale);
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  const ctx = canvas.getContext('2d')!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = ANISOTROPY;
  const draw = () => {
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, w, h);
    paint(ctx);
    tex.needsUpdate = true;
  };
  draw();
  onFonts(draw);
  return tex;
}

export interface AtlasRegion {
  /** Its size in meters, as it shows in the world. */
  width: number;
  height: number;
  x: number;
  y: number;
  w: number;
  h: number;
  paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
}

/**
 * Many small signs painted on one texture, so they draw as one mesh: `add` each (meters, painted
 * at `pxPerM`), `finish` once to pack and paint them, then `plane` gives a face showing one region.
 */
export class SignAtlas {
  private regions: AtlasRegion[] = [];
  private W = 0;
  private H = 0;
  texture: THREE.CanvasTexture | null = null;

  constructor(
    private readonly pxPerM: number,
    private readonly scale: number,
    private readonly maxWidth = 1024,
  ) {}

  add(width: number, height: number, paint: AtlasRegion['paint']): AtlasRegion {
    const r: AtlasRegion = { width, height, x: 0, y: 0, w: Math.round(width * this.pxPerM), h: Math.round(height * this.pxPerM), paint };
    this.regions.push(r);
    return r;
  }

  /** Packs the regions onto shelves, tallest first, with a gutter so mipmaps don't bleed between them. */
  finish(): THREE.CanvasTexture {
    const gutter = 6;
    const sorted = [...this.regions].sort((a, b) => b.h - a.h);
    let x = gutter;
    let y = gutter;
    let shelf = 0;
    let W = 0;
    for (const r of sorted) {
      if (x + r.w + gutter > this.maxWidth && x > gutter) {
        x = gutter;
        y += shelf + gutter;
        shelf = 0;
      }
      r.x = x;
      r.y = y;
      x += r.w + gutter;
      W = Math.max(W, x);
      shelf = Math.max(shelf, r.h);
    }
    this.W = W;
    this.H = y + shelf + gutter;
    this.texture = paintedTexture(this.W, this.H, this.scale, (ctx) => {
      for (const r of this.regions) {
        ctx.save();
        ctx.translate(r.x, r.y);
        ctx.beginPath();
        ctx.rect(-3, -3, r.w + 6, r.h + 6);
        ctx.clip();
        r.paint(ctx, r.w, r.h);
        ctx.restore();
      }
    });
    return this.texture;
  }

  /** A face showing `r`, its size in meters, facing +z. */
  plane(r: AtlasRegion): THREE.PlaneGeometry {
    const geo = new THREE.PlaneGeometry(r.width, r.height);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      uv.setXY(i, (r.x + u * r.w) / this.W, 1 - (r.y + (1 - v) * r.h) / this.H);
    }
    return geo;
  }
}

/** The faces `parts` (each a geometry and where it goes), as one geometry: they keep their UVs. */
export function mergeFaces(parts: { geo: THREE.BufferGeometry; at: THREE.Matrix4 }[]): THREE.BufferGeometry {
  const geos = parts.map(({ geo, at }) => {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.applyMatrix4(at);
    geo.dispose();
    return g;
  });
  const merged = mergeGeometries(geos)!;
  for (const g of geos) g.dispose();
  return merged;
}

/** How many rows of LEDs the ticker has, and the most pixels its texture gets along the loop. */
export const LED_ROWS = 16;
const MAX_TICKER_PX = 4096;

/**
 * The ticker's dot matrix: `segments` (text and its color) one after another in a loop, lit LEDs
 * on a dark board with the unlit ones faintly showing. Returns the texture and how many LED columns
 * the loop is. Its words are drawn small, cut to on or off, then blown up into dots.
 */
export function tickerTexture(segments: { text: string; color: string }[]): { tex: THREE.CanvasTexture; columns: number } {
  const lo = document.createElement('canvas');
  const lctx = lo.getContext('2d')!;
  const px = 13;
  lctx.font = mono(px, 600);
  const columns = Math.max(64, Math.ceil(segments.reduce((w, s) => w + trackedWidth(lctx, s.text, 1), 0)));
  lo.width = columns;
  lo.height = LED_ROWS;
  // Each LED a few pixels square, so it can be drawn as a round dot.
  const ledPx = Math.max(2, Math.min(4, Math.floor(MAX_TICKER_PX / columns)));
  const hi = document.createElement('canvas');
  hi.width = columns * ledPx;
  hi.height = LED_ROWS * ledPx;
  const hctx = hi.getContext('2d')!;
  const tex = new THREE.CanvasTexture(hi);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = ANISOTROPY;
  tex.wrapS = THREE.RepeatWrapping;

  const dots = (on: string | null, bg: string) => {
    const c = document.createElement('canvas');
    c.width = ledPx;
    c.height = ledPx;
    const g = c.getContext('2d')!;
    g.fillStyle = bg;
    g.fillRect(0, 0, ledPx, ledPx);
    if (on) {
      g.fillStyle = on;
      g.beginPath();
      g.arc(ledPx / 2, ledPx / 2, ledPx * 0.36, 0, Math.PI * 2);
      g.fill();
    }
    return c;
  };
  const lit = dots('#000', 'rgba(0,0,0,0)');
  const unlit = dots('#1d0d05', BASE);

  const draw = () => {
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, columns, LED_ROWS);
    lctx.font = mono(px, 600);
    lctx.textBaseline = 'alphabetic';
    // The loop's length is fixed when it's first painted; the bundled font, arriving later, is squeezed or spread to it.
    const now = segments.map((s) => trackedWidth(lctx, s.text, 1));
    const total = now.reduce((a, b) => a + b, 0);
    if (total > 0) lctx.setTransform(columns / total, 0, 0, 1, 0, 0);
    let x = 0;
    segments.forEach((s, i) => {
      lctx.fillStyle = s.color;
      tracked(lctx, s.text, x, 12.5, 1);
      x += now[i];
    });
    // Every LED all the way on or off, as a real board's are.
    try {
      const img = lctx.getImageData(0, 0, columns, LED_ROWS);
      const d = img.data;
      for (let i = 3; i < d.length; i += 4) d[i] = d[i] > 110 ? 255 : 0;
      lctx.putImageData(img, 0, 0);
    } catch {
      // A canvas that can't be read back keeps its soft edges.
    }
    hctx.setTransform(1, 0, 0, 1, 0, 0);
    hctx.globalCompositeOperation = 'source-over';
    hctx.clearRect(0, 0, hi.width, hi.height);
    hctx.imageSmoothingEnabled = false;
    hctx.drawImage(lo, 0, 0, hi.width, hi.height);
    hctx.globalCompositeOperation = 'destination-in';
    const litPattern = hctx.createPattern(lit, 'repeat');
    if (litPattern) {
      hctx.fillStyle = litPattern;
      hctx.fillRect(0, 0, hi.width, hi.height);
    }
    hctx.globalCompositeOperation = 'destination-over';
    const unlitPattern = hctx.createPattern(unlit, 'repeat');
    hctx.fillStyle = unlitPattern ?? BASE;
    hctx.fillRect(0, 0, hi.width, hi.height);
    hctx.globalCompositeOperation = 'source-over';
    tex.needsUpdate = true;
  };
  draw();
  onFonts(draw);
  return { tex, columns };
}
