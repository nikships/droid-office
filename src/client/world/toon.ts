import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SANS } from '../fonts';
import { signsPrinted } from '../native/mode';
import { fillGlyphText, measureGlyphText as measure, withGlyph } from './glyph';
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
  /** A printed sign's own light in the headset app (see printedMaterial): PRINT_GLOW unless it's lit from inside, as an EXIT sign is. */
  glow?: number;
  /** A printed sign's board color in the headset app: by default its face's color, toward brushed steel. */
  board?: string;
};
const TEXT_SCALE = 0.0055;

/**
 * A label's words without emoji, as a printed sign or plate says them: "💬 READY" reads "READY",
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

/** How much of its own light a printed sign gives off in the dark office, on top of the light that falls on it: enough to read it, not a glow. */
export const PRINT_GLOW = 0.32;

/**
 * What a printed sign or plate is drawn with in the headset app: a toon surface lit by the room
 * like the wall or desk it's fixed to, giving off `glow` of its own print so it still reads in the
 * dark office without shining like a screen. `cutout` keeps only the print (ink on a surface).
 */
export function printedMaterial(map: THREE.Texture, glow = PRINT_GLOW, cutout = false): THREE.MeshToonMaterial {
  const m = new THREE.MeshToonMaterial({ map, gradientMap: gradientMap(), emissive: '#ffffff', emissiveMap: map, emissiveIntensity: glow });
  if (cutout) {
    m.transparent = true;
    m.alphaTest = 0.05;
  }
  return m;
}

/** A printed sign's board in the headset app, before the sign is scaled: how thick it is, and how far its edge shows round the face (meters). */
const BOARD_DEPTH = 0.03;
const BOARD_RIM = 0.018;
/**
 * How far behind its face a printed sign's board reaches in the headset app, in meters before the
 * sign is scaled: a sign fixed flat to a wall or a bar has its face this far (times its scale) out from it.
 */
export const SIGN_BACK = BOARD_DEPTH + 0.002;
/** The brushed steel a sign's board leans toward, and how much light of its own its edge gives off, so it shows round the face in the dark. */
const BOARD_STEEL = new THREE.Color('#8d99ae');
const BOARD_GLOW = 0.16;
/** A printed sign's white enamel face, the dark ink of its words, and the fine rule round them. */
const ENAMEL = '#e6e8ec';
const ENAMEL_INK = '#1d2027';
const ENAMEL_RULE = '#59606c';

/**
 * A label's colors as a printed sign's in the headset app. A dark label (white words on black, as
 * a tag floating over the desktop office is) becomes white enamel, which shows the room's light and
 * shade the way a black face can't: its words in dark ink, or in their own color when they have
 * one (a fire pole's red), on a steel board. Every other label keeps its colors.
 */
export function enamel(opts: TextOpts): TextOpts {
  if (!opts.bg) return opts;
  const hsl = { h: 0, s: 0, l: 0 };
  if (new THREE.Color(opts.bg).getHSL(hsl, THREE.SRGBColorSpace).l > 0.2) return opts;
  const plain = new THREE.Color(opts.color ?? ENAMEL_INK).getHSL(hsl, THREE.SRGBColorSpace).s < 0.25;
  return { ...opts, bg: ENAMEL, color: plain ? ENAMEL_INK : opts.color, border: ENAMEL_RULE, board: opts.board ?? `#${BOARD_STEEL.getHexString()}` };
}

/** Every text label drawn so far, so they can be repainted once the bundled fonts finish loading. */
const textLabels = new Set<() => void>();

/** Repaints every text label made by textPlane/textSprite, e.g. after the fonts have loaded. */
export function redrawText(): void {
  for (const redraw of textLabels) redraw();
}

/**
 * A near-square text label drawn to a texture; `w`/`h` are the canvas size in pixels. A `printed`
 * sign's face fills the whole canvas, framed by a fine line just inside its edge, where a label
 * is a rounded pill.
 */
function textTexture(text: string, opts: TextOpts, printed = false) {
  const size = opts.size ?? 48;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = `700 ${size}px ${SANS}`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + size;
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
    if (opts.bg && printed) {
      ctx.fillStyle = opts.bg;
      ctx.fillRect(0, 0, w, h);
      ctx.lineWidth = 3;
      ctx.strokeStyle = opts.border ?? '#0a0a0a';
      ctx.strokeRect(7, 7, w - 14, h - 14);
    } else if (opts.bg) {
      ctx.fillStyle = opts.bg;
      ctx.beginPath();
      ctx.roundRect(3, 3, w - 6, h - 6, 8);
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = opts.border ?? '#0a0a0a';
      ctx.stroke();
    }
    ctx.fillStyle = opts.color ?? '#2b2d42';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + size * 0.05);
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

/**
 * A flat text sign facing +Z, for mounting on a wall (a sprite would swing into the wall). In the
 * headset app (signsPrinted) it is a printed sign: its face lit by the room (printedMaterial), its
 * words without emoji (plainLabel), a dark label in white enamel (enamel), and, when it has a
 * background, a board behind it whose edge
 * shows round the face and reaches back BOARD_DEPTH, to the wall it's mounted on. Disposing the
 * face's geometry disposes the board's.
 */
export function textPlane(text: string, opts: TextOpts = {}): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial | THREE.MeshToonMaterial> {
  const printed = signsPrinted();
  if (printed) opts = enamel(opts);
  const { tex, w, h } = textTexture(printed ? plainLabel(text) : text, opts, printed);
  const face = new THREE.PlaneGeometry(w * TEXT_SCALE, h * TEXT_SCALE);
  if (!printed) return new THREE.Mesh(face, new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.05 }));
  const sign = new THREE.Mesh(face, printedMaterial(tex, opts.glow ?? PRINT_GLOW, !opts.bg));
  if (opts.bg) {
    const board = new THREE.BoxGeometry(w * TEXT_SCALE + 2 * BOARD_RIM, h * TEXT_SCALE + 2 * BOARD_RIM, BOARD_DEPTH);
    const color = opts.board ?? `#${new THREE.Color(opts.bg).lerp(BOARD_STEEL, 0.5).getHexString()}`;
    const back = mesh(board, toon(color, { emissive: `#${new THREE.Color(color).multiplyScalar(BOARD_GLOW).getHexString()}` }), 0, 0, BOARD_DEPTH / 2 - SIGN_BACK, false);
    back.name = 'sign-board';
    sign.add(back);
    face.addEventListener('dispose', () => board.dispose());
  }
  return sign;
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
  const lw = 5 * R;
  const tail = 14 * R;
  const chipFont = `800 ${19 * R}px ${FONT}`;
  const chipH = 30 * R;
  const titlePx = 30 * R;
  const titleFont = `800 ${titlePx}px ${FONT}`;
  const titleLH = 36 * R;
  const bodyPx = 23 * R;
  const bodyFont = `700 ${bodyPx}px ${FONT}`;
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
  const r = 18 * R;
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
  ctx.lineJoin = 'round';
  ctx.strokeStyle = o.border ?? INK;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (o.chip) {
    ctx.beginPath();
    ctx.roundRect(cx - chipW / 2, lw / 2, chipW, chipH, chipH / 2);
    ctx.fillStyle = o.chip.bg;
    ctx.fill();
    ctx.lineWidth = 4 * R;
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
