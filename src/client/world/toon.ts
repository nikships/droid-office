import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MONO, SANS } from '../fonts';
import { FACTORY_GLYPH_PATH, FACTORY_GLYPH_VIEWBOX, fillGlyphText, measureGlyphText as measure, withGlyph } from './glyph';
import { ANISOTROPY, LABEL_SCALE } from './texture-quality';

let gradient: THREE.DataTexture | null = null;

/** Three-step ramp that gives MeshToonMaterial its flat cartoon banding. */
function gradientMap(): THREE.DataTexture {
  if (gradient) return gradient;
  const data = new Uint8Array([90, 90, 90, 255, 185, 185, 185, 255, 255, 255, 255, 255]);
  gradient = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.needsUpdate = true;
  return gradient;
}

const cache = new Map<string, THREE.MeshToonMaterial>();

export function toon(color: THREE.ColorRepresentation, opts: { emissive?: THREE.ColorRepresentation; transparent?: boolean; opacity?: number } = {}): THREE.MeshToonMaterial {
  const key = `${new THREE.Color(color).getHexString()}|${opts.emissive ?? ''}|${opts.opacity ?? 1}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const m = new THREE.MeshToonMaterial({ color, gradientMap: gradientMap() });
  if (opts.emissive !== undefined) m.emissive = new THREE.Color(opts.emissive);
  if (opts.transparent || (opts.opacity ?? 1) < 1) {
    m.transparent = true;
    m.opacity = opts.opacity ?? 1;
  }
  cache.set(key, m);
  return m;
}

/** A fresh (uncached) toon material, for things whose color animates. */
export function toonUnique(color: THREE.ColorRepresentation): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color, gradientMap: gradientMap() });
}

export function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, shadow = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

export function roundedBox(w: number, h: number, d: number, r = 0.06): THREE.BufferGeometry {
  // Cheap rounded box: an extruded rounded rectangle, centered.
  const shape = new THREE.Shape();
  const x = -w / 2;
  const y = -d / 2;
  r = Math.min(r, w / 2, d / 2);
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + d - r);
  shape.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  shape.lineTo(x + r, y + d);
  shape.quadraticCurveTo(x, y + d, x, y + d - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 4 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -h / 2, 0);
  geo.computeVertexNormals();
  return geo;
}

export type TextOpts = {
  color?: string;
  bg?: string;
  size?: number;
  border?: string;
  /**
   * A numbered eyebrow before a sign's words, in Factory orange ("01" in "01 TRIAGE"). A sign whose
   * text starts with a two-digit index from 01 to 09 and a space gets one without asking.
   */
  index?: string;
  /** A word between the index and the words, in secondary gray ("FLOOR" in "▲ FLOOR PROJECT"). */
  kicker?: string;
  /** Keep the words' own case: a sign on a plate is otherwise set in uppercase. */
  keepCase?: boolean;
};
const TEXT_SCALE = 0.0055;

/** Factory's signal orange and secondary gray, as signs and labels print them. */
export const SIGNAL = '#ee6018';
export const SECONDARY = '#8c8c8c';
/** A plate's hairline, when the caller doesn't name one. */
const HAIRLINE = 'rgba(255, 255, 255, .18)';
/** How a sign's mono type is set, as fractions of its `size`: smaller than the old bold sans, with wide tracking. */
const SIGN_TYPE = 0.74;
const SIGN_TRACK = 0.14;
const SIGN_INDEX_GAP = 0.6;

/**
 * A label's words without emoji, as a plate or card chip prints them: "💬 READY" reads "READY",
 * and "🪜 ⬆ floor-beta" reads "↑ floor-beta", its arrow kept as a plain one.
 */
export function plainLabel(label: string): string {
  return label
    .replace(/\u2B06\uFE0F?/gu, '\u2191')
    .replace(/\u2B07\uFE0F?/gu, '\u2193')
    .replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every text label drawn so far, so they can be repainted once the bundled fonts finish loading. */
const textLabels = new Set<() => void>();

/** Repaints every text label made by textPlane/textSprite, e.g. after the fonts have loaded. */
export function redrawText(): void {
  for (const redraw of textLabels) redraw();
}

/** A sign's leading two-digit index ("01 TRIAGE"), split from its words. */
function splitIndex(text: string): [string, string] | null {
  const m = /^(0[1-9])\s+(\S.*)$/su.exec(text);
  return m ? [m[1], m[2]] : null;
}

/**
 * Sets `ctx`'s letter tracking where the canvas supports it. Tracking adds its space after the
 * last letter too; `measureTracked` takes that back off.
 */
export function track(ctx: CanvasRenderingContext2D, px: number) {
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${px}px`;
}

function measureTracked(ctx: CanvasRenderingContext2D, text: string, trackPx: number): number {
  return text ? Math.max(0, ctx.measureText(text).width - ('letterSpacing' in ctx ? trackPx : 0)) : 0;
}

/**
 * A text label drawn to a texture; `w`/`h` are its size in pixels. A `sign` with a background is a
 * Factory plate: a flat face with a hairline edge and square corners, its words in tracked
 * uppercase mono after an orange index and a gray kicker when it has them. A label that floats (a
 * sprite) is the same plate in its words' own case.
 */
function textTexture(text: string, opts: TextOpts, sign = false) {
  const size = opts.size ?? 48;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const plate = !!opts.bg;
  const split = plate && sign && opts.index === undefined ? splitIndex(text) : null;
  const index = plate && sign ? (opts.index ?? split?.[0] ?? '') : '';
  const kicker = plate && sign ? (opts.kicker ?? '') : '';
  let words = split ? split[1] : text;
  if (plate && sign && !opts.keepCase) words = words.toUpperCase();
  const typePx = plate ? Math.round(size * (sign ? SIGN_TYPE : 0.86)) : size;
  const trackPx = plate ? typePx * (sign ? SIGN_TRACK : 0.02) : 0;
  const font = plate ? `${sign ? 500 : 600} ${typePx}px ${MONO}` : `700 ${size}px ${SANS}`;
  const gap = typePx * SIGN_INDEX_GAP;
  ctx.font = font;
  track(ctx, trackPx);
  const indexW = measureTracked(ctx, index, trackPx);
  const kickerW = measureTracked(ctx, kicker, trackPx);
  const wordsW = plate ? measureTracked(ctx, words, trackPx) : ctx.measureText(words).width;
  const lead = (index ? indexW + gap : 0) + (kicker ? kickerW + gap : 0);
  const w = Math.ceil(lead + wordsW) + (plate && sign ? Math.round(size * 1.1) : size);
  const h = Math.ceil(size * 1.6);
  canvas.width = w * LABEL_SCALE;
  canvas.height = h * LABEL_SCALE;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = ANISOTROPY;
  const draw = () => {
    ctx.setTransform(LABEL_SCALE, 0, 0, LABEL_SCALE, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = font;
    track(ctx, trackPx);
    if (opts.bg) {
      // Square corners, drawn as paths like the rounded labels were (canvas stubs in tests draw paths only).
      ctx.fillStyle = opts.bg;
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, 0);
      ctx.fill();
      const line = Math.max(1.5, size / 32);
      ctx.lineWidth = line;
      ctx.strokeStyle = opts.border ?? HAIRLINE;
      ctx.beginPath();
      ctx.roundRect(line / 2, line / 2, w - line, h - line, 0);
      ctx.stroke();
    }
    ctx.textBaseline = 'middle';
    const y = h / 2 + size * (plate ? 0.03 : 0.05);
    if (index || kicker) {
      ctx.textAlign = 'left';
      let x = (w - lead - wordsW) / 2;
      if (index) {
        ctx.fillStyle = SIGNAL;
        ctx.fillText(index, x, y);
        x += indexW + gap;
      }
      if (kicker) {
        ctx.fillStyle = SECONDARY;
        ctx.fillText(kicker, x, y);
        x += kickerW + gap;
      }
      ctx.fillStyle = opts.color ?? '#2b2d42';
      ctx.fillText(words, x, y);
    } else {
      ctx.fillStyle = opts.color ?? '#2b2d42';
      ctx.textAlign = 'center';
      // Tracking pads the right of the line: shift by half of it to keep the words centered.
      ctx.fillText(words, w / 2 + ('letterSpacing' in ctx ? trackPx / 2 : 0), y);
    }
    tex.needsUpdate = true;
  };
  draw();
  textLabels.add(draw);
  tex.addEventListener('dispose', () => textLabels.delete(draw));
  return { tex, w, h };
}

/** A camera-facing text label. */
export function textSprite(text: string, opts: TextOpts = {}): THREE.Sprite {
  const { tex, w, h } = textTexture(text, opts);
  const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(w * TEXT_SCALE, h * TEXT_SCALE, 1);
  sprite.renderOrder = 10;
  return sprite;
}

/** A flat text sign facing +Z, for mounting on a wall. */
export function textPlane(text: string, opts: TextOpts = {}): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  const { tex, w, h } = textTexture(text, opts, true);
  return new THREE.Mesh(new THREE.PlaneGeometry(w * TEXT_SCALE, h * TEXT_SCALE), new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.05 }));
}

export interface CardOpts {
  /** A small pill across the top edge, e.g. "⌨️ WORKING". */
  chip?: { text: string; bg: string; color: string };
  title: string;
  body?: string;
  bg: string;
  /** The outline's color, when it isn't the usual ink. */
  border?: string;
  /** Title ink, when it isn't the usual dark ink (a light color on a dark card). */
  color?: string;
  /** Body ink, when it isn't the usual muted ink. */
  muted?: string;
  /** Widest a line of text may get, in textSprite `size` pixels. */
  maxWidth?: number;
}

/** Cards draw their text in smaller type than other labels, so they get a density of their own. */
const CARD_RES = LABEL_SCALE;
const INK = '#2b2d42';
const FONT = SANS;

/**
 * A speech-bubble card: status pill, bold title (up to 2 lines) and a smaller body (up to 3), with a
 * tail pointing down. Its position is the tip of the tail, so it sits right on top of what it's about.
 */
export function cardSprite(o: CardOpts): THREE.Sprite {
  const R = CARD_RES;
  const maxW = (o.maxWidth ?? 400) * R;
  const pad = 16 * R;
  const lw = 3 * R;
  const tail = 12 * R;
  const chipFont = `600 ${18 * R}px ${MONO}`;
  const chipH = 30 * R;
  const titlePx = 30 * R;
  const titleFont = `700 ${titlePx}px ${FONT}`;
  const titleLH = 36 * R;
  const bodyPx = 23 * R;
  const bodyFont = `500 ${bodyPx}px ${FONT}`;
  const bodyLH = 29 * R;

  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.font = titleFont;
  const title = wrapText(ctx, withGlyph(o.title), maxW, 2, titlePx);
  const titleW = Math.max(...title.map((l) => measure(ctx, l, titlePx)));
  ctx.font = bodyFont;
  const body = o.body ? wrapText(ctx, withGlyph(o.body), maxW, 3, bodyPx) : [];
  const bodyW = body.length ? Math.max(...body.map((l) => measure(ctx, l, bodyPx))) : 0;
  ctx.font = chipFont;
  const chipW = o.chip ? ctx.measureText(o.chip.text).width + 24 * R : 0;

  const w = Math.ceil(Math.max(titleW, bodyW, chipW + 2 * pad) + 2 * pad);
  const top = o.chip ? chipH / 2 : lw;
  const titleY = top + (o.chip ? chipH / 2 + 6 * R : pad);
  const bodyY = titleY + title.length * titleLH + 4 * R;
  const bottom = bodyY + body.length * bodyLH + pad * 0.7;
  const h = Math.ceil(bottom + tail + lw);

  const canvas = ctx.canvas;
  canvas.width = w;
  canvas.height = h;
  // One outline for the card and its tail, so the border runs unbroken down the tail.
  const x0 = lw / 2;
  const x1 = w - lw / 2;
  const cx = w / 2;
  const r = 3 * R;
  ctx.beginPath();
  ctx.moveTo(x0 + r, top);
  ctx.arcTo(x1, top, x1, bottom, r);
  ctx.arcTo(x1, bottom, x0, bottom, r);
  ctx.lineTo(cx + tail, bottom);
  ctx.lineTo(cx, bottom + tail);
  ctx.lineTo(cx - tail, bottom);
  ctx.arcTo(x0, bottom, x0, top, r);
  ctx.arcTo(x0, top, x1, top, r);
  ctx.closePath();
  ctx.fillStyle = o.bg;
  ctx.fill();
  ctx.lineWidth = lw;
  ctx.lineJoin = 'miter';
  ctx.strokeStyle = o.border ?? INK;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (o.chip) {
    ctx.beginPath();
    ctx.roundRect(cx - chipW / 2, lw / 2, chipW, chipH, 2 * R);
    ctx.fillStyle = o.chip.bg;
    ctx.fill();
    ctx.lineWidth = 2 * R;
    ctx.stroke();
    ctx.font = chipFont;
    ctx.fillStyle = o.chip.color;
    ctx.fillText(o.chip.text, cx, lw / 2 + chipH / 2 + R);
  }
  ctx.font = titleFont;
  ctx.fillStyle = o.color ?? INK;
  title.forEach((l, i) => fillGlyphText(ctx, l, cx, titleY + (i + 0.5) * titleLH, titlePx));
  ctx.font = bodyFont;
  ctx.fillStyle = o.muted ?? '#5c5f77';
  body.forEach((l, i) => fillGlyphText(ctx, l, cx, bodyY + (i + 0.5) * bodyLH, bodyPx));

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = ANISOTROPY;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  sprite.scale.set((w / R) * TEXT_SCALE, (h / R) * TEXT_SCALE, 1);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 10;
  return sprite;
}

/** Greedy word wrap to at most `maxLines`, ending in "…" when the text doesn't fit. */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number, px: number): string[] {
  const fits = (s: string) => measure(ctx, s, px) <= maxW;
  const lines: string[] = [];
  let line = '';
  for (let word of text.split(/\s+/).filter(Boolean)) {
    // A word wider than a whole line gets cut where it has to be.
    while (!fits(word)) {
      let n = word.length - 1;
      while (n > 1 && !fits(word.slice(0, n))) n--;
      if (line) lines.push(line);
      lines.push(word.slice(0, n));
      line = '';
      word = word.slice(n);
    }
    const next = line ? `${line} ${word}` : word;
    if (fits(next)) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && !fits(`${last}…`)) last = last.slice(0, -1).trimEnd();
  kept[maxLines - 1] = `${last.replace(/[\s,.;:—-]+$/, '')}…`;
  return kept;
}

let pinwheel: Path2D | null = null;

/** The Factory pinwheel on a canvas, `size` px across, centered on (`cx`, `cy`), in the current fill. Draws nothing where there is no Path2D (Node). */
export function paintGlyph(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
  if (typeof Path2D === 'undefined') return;
  pinwheel ??= new Path2D(FACTORY_GLYPH_PATH);
  const [vx, vy, vw, vh] = FACTORY_GLYPH_VIEWBOX;
  const k = size / Math.max(vw, vh);
  ctx.save();
  ctx.translate(cx - (vw * k) / 2, cy - (vh * k) / 2);
  ctx.scale(k, k);
  ctx.translate(-vx, -vy);
  ctx.fill(pinwheel, 'evenodd');
  ctx.restore();
}

export function disposeSprite(s: THREE.Sprite) {
  s.material.map?.dispose();
  s.material.dispose();
}

/**
 * Merges every (untextured) mesh under `root` into one per material, keeping which ones cast
 * shadows: a few draw calls instead of dozens, for things that never move on their own.
 */
export function mergeByMaterial(root: THREE.Object3D): THREE.Group {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const byKey = new Map<string, { mat: THREE.Material; cast: boolean; geos: THREE.BufferGeometry[] }>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const geo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal') geo.deleteAttribute(k);
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    const mat = m.material as THREE.Material;
    const key = `${mat.uuid}${m.castShadow ? '+' : '-'}`;
    if (!byKey.has(key)) byKey.set(key, { mat, cast: m.castShadow, geos: [] });
    byKey.get(key)!.geos.push(geo);
  });
  const out = new THREE.Group();
  for (const { mat, cast, geos } of byKey.values()) {
    out.add(mesh(mergeGeometries(geos)!, mat, 0, 0, 0, cast));
    for (const geo of geos) geo.dispose();
  }
  return out;
}
