import * as THREE from 'three';
import { SANS, fontRevision } from '../fonts';
import { fillGlyphText, measureGlyphText, withGlyph } from './glyph';
import { ANISOTROPY } from './texture-quality';
import { mesh, roundedBox, toon, wrapText } from './toon';

/**
 * Nameplates: in the headset app (`/?native=1`, see native/mode.ts floatingTagsShown) nobody floats
 * text over their head. A worker's name, engine and state are printed on its seat instead: a
 * three-sided sign standing on its desk, a plate on the back of its meeting chair or bean bag, or
 * the counter display of a board agent's kiosk. A lamp on the plate glows in its status color,
 * breathing while it works and blinking while it waits on you, like the bulb on its antenna.
 */

/** How a seat carries its nameplate (DeskView.plate). The plate's face looks along the anchor's +z. */
export interface PlateMount {
  anchor: THREE.Object3D;
  /**
   * `prism`: a three-sided sign standing on a desk, one face toward the chair and the other two
   * angled to the front corners, so it reads from behind the worker and from the aisle beside it.
   * `panel`: one flat face (a chair back, a bean bag, a kiosk's counter display), centered on the anchor.
   */
  shape: 'prism' | 'panel';
  /** One face, in meters. */
  width: number;
  height: number;
}

/** Steady; breathing while it works; blinking while it waits on you. */
export type LampPulse = 'steady' | 'busy' | 'call';

/** What a nameplate says. */
export interface PlateText {
  /** Who sits here: "Pixel 🐚", "Issues agent". */
  name: string;
  /** What it is: its engine ("Claude Code · Opus 4.1 · High"), "Shell", or a kiosk agent's board ("Issues board", then its model once hired); '' for none. */
  role: string;
  /** Its state as a pill: text, pill color, ink. */
  chip: readonly [string, string, string];
  /** What it's on, on one line; '' for nothing. */
  line: string;
  /** Its own color, down the plate's left edge. */
  color: string;
  /** The lamp's color, or null when it's out (shot, or leaving). */
  lamp: string | null;
  pulse: LampPulse;
}

/** A board agent's pitch, shown on its counter display only once you start talking to it. */
export interface PlatePitch {
  /** Who's talking: "📌 Issues agent". */
  heading: string;
  /** "Ask me about issues". */
  title: string;
  /** "I file, find, triage, label and close them". */
  body: string;
}

/** Canvas pixels per meter of face. */
const PX_PER_M = 1500;
const INK = '#111318';
const PAPER = '#f4f4f6';
const MUTED = '#a6a9b8';
/** How long one blink of a lamp calling for you takes, on and off, in seconds. */
const BLINK = 0.6;

/** One face's text, laid out on a `w` by `h` canvas. */
export function paintPlate(ctx: CanvasRenderingContext2D, w: number, h: number, text: PlateText | null, pitch: PlatePitch | null) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, w, h);
  const bar = Math.round(h * 0.07);
  ctx.fillStyle = text?.color ?? MUTED;
  ctx.fillRect(0, 0, bar, h);
  const pad = h * 0.1;
  const x = bar + pad;
  const maxW = w - x - pad;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  /** `s` on one line at `px`, shrunk as far as `min` px to fit `width`, and cut short with "…" past that. */
  const line = (s: string, px: number, weight: number, color: string, y: number, width = maxW, at = x, min = px * 0.7) => {
    const glyphs = withGlyph(s);
    ctx.font = `${weight} ${px}px ${SANS}`;
    const full = measureGlyphText(ctx, glyphs, px);
    const size = full > width ? Math.max(min, (px * width) / full) : px;
    ctx.font = `${weight} ${size}px ${SANS}`;
    ctx.fillStyle = color;
    fillGlyphText(ctx, wrapText(ctx, glyphs, width, 1, size)[0] ?? '', at, y, size);
  };
  if (pitch) {
    const headPx = h * 0.12;
    const titlePx = h * 0.2;
    const bodyPx = h * 0.13;
    line(pitch.heading, headPx, 700, MUTED, pad + headPx * 0.6);
    ctx.font = `800 ${titlePx}px ${SANS}`;
    const title = wrapText(ctx, withGlyph(pitch.title), maxW, 2, titlePx);
    let y = pad + headPx * 1.3 + titlePx * 0.65;
    ctx.fillStyle = PAPER;
    for (const l of title) {
      fillGlyphText(ctx, l, x, y, titlePx);
      y += titlePx * 1.12;
    }
    ctx.font = `600 ${bodyPx}px ${SANS}`;
    ctx.fillStyle = '#d6d8e2';
    y += bodyPx * 0.1;
    for (const l of wrapText(ctx, withGlyph(pitch.body), maxW, 2, bodyPx)) {
      fillGlyphText(ctx, l, x, y, bodyPx);
      y += bodyPx * 1.2;
    }
    return;
  }
  if (!text) return;
  const namePx = h * 0.3;
  const rolePx = h * 0.13;
  const chipPx = h * 0.12;
  const chipH = h * 0.2;
  const rows = text.role ? namePx + rolePx * 1.3 + chipH : namePx + chipH;
  const gap = (h - 2 * pad - rows) / (text.role ? 2 : 1);
  let y = pad + namePx / 2;
  line(text.name, namePx, 800, PAPER, y, maxW, x, namePx * 0.6);
  y += namePx / 2 + gap;
  if (text.role) {
    line(text.role, rolePx, 600, MUTED, y + rolePx * 0.6);
    y += rolePx * 1.3 + gap;
  }
  // The state pill, then what it's on.
  const [label, bg, ink] = text.chip;
  ctx.font = `800 ${chipPx}px ${SANS}`;
  const chipW = Math.min(maxW, ctx.measureText(label).width + chipPx * 1.6);
  ctx.beginPath();
  ctx.roundRect(x, y, chipW, chipH, chipH / 2);
  ctx.fillStyle = bg;
  ctx.fill();
  line(label, chipPx, 800, ink, y + chipH / 2 + chipPx * 0.05, chipW - chipPx * 1.2, x + chipPx * 0.6);
  if (text.line) line(text.line, rolePx, 600, '#e6e6ee', y + chipH / 2, maxW - chipW - pad, x + chipW + pad * 0.8);
}

/** Geometry every nameplate of a size shares (the native scene uploads each once). */
const shared = new Map<string, THREE.BufferGeometry>();
function geometry(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = shared.get(key);
  if (!g) shared.set(key, (g = make()));
  return g;
}

/** A seat's nameplate: see the top of this file. */
export class Nameplate {
  readonly root = new THREE.Group();
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly face: THREE.MeshBasicMaterial;
  private readonly lamp: THREE.Mesh;
  private readonly lampMat: THREE.MeshBasicMaterial;
  /** The lamp's radius, in meters. */
  private readonly lampSize: number;
  /** Whoever's text it shows (a worker, or the board agent waiting at a kiosk): only it may change or clear it. */
  private owner: unknown = null;
  private text: PlateText | null = null;
  private pitchText: PlatePitch | null = null;
  private drawn = '';
  private drawnFonts = -1;
  private t = 0;

  constructor(mount: Pick<PlateMount, 'shape' | 'width' | 'height'>) {
    const { shape, width, height } = mount;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(width * PX_PER_M);
    this.canvas.height = Math.round(height * PX_PER_M);
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = ANISOTROPY;
    this.face = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false });
    this.lampMat = new THREE.MeshBasicMaterial({ color: '#2b2d42', toneMapped: false });
    const body = toon('#23252e');
    const faceGeo = geometry(`face|${width}|${height}`, () => new THREE.PlaneGeometry(width, height));
    const lampGeo = geometry('lamp', () => new THREE.SphereGeometry(1, 14, 10));
    if (shape === 'prism') {
      // Three faces round a dark block: one toward +z, the others 120° either side of it.
      const tall = height + 0.02;
      const apothem = width / (2 * Math.sqrt(3));
      const block = mesh(
        geometry(`prism|${width}|${tall}`, () => new THREE.CylinderGeometry(width / Math.sqrt(3), width / Math.sqrt(3), tall, 3, 1, false, Math.PI / 3)),
        body,
        0,
        tall / 2,
        0,
      );
      this.root.add(block);
      for (let i = 0; i < 3; i++) {
        const side = new THREE.Group();
        side.rotation.y = (i * 2 * Math.PI) / 3;
        const plate = new THREE.Mesh(faceGeo, this.face);
        plate.position.set(0, tall / 2, apothem + 0.002);
        side.add(plate);
        this.root.add(side);
      }
      this.lampSize = 0.026;
      this.lamp = new THREE.Mesh(lampGeo, this.lampMat);
      this.lamp.position.set(0, tall + 0.022, 0);
    } else {
      const bezel = mesh(
        geometry(`bezel|${width}|${height}`, () => roundedBox(width + 0.03, 0.018, height + 0.03, 0.012)),
        body,
        0,
        0,
        0,
        false,
      );
      bezel.rotation.x = Math.PI / 2;
      this.root.add(bezel);
      const plate = new THREE.Mesh(faceGeo, this.face);
      plate.position.z = 0.0105;
      this.root.add(plate);
      // On the bezel's top corner, as big as the plate is tall allows: a kiosk's shows across the room.
      this.lampSize = Math.max(0.016, height * 0.1);
      this.lamp = new THREE.Mesh(lampGeo, this.lampMat);
      this.lamp.position.set(width / 2 - this.lampSize, height / 2 + this.lampSize, 0.006);
    }
    this.lamp.scale.setScalar(this.lampSize);
    this.root.add(this.lamp);
    this.root.visible = false;
  }

  /** Puts `owner`'s text on it (see show); whoever had it before can no longer change it. */
  claim(owner: unknown) {
    this.owner = owner;
  }

  /** `owner` is done with it: it goes blank and out of sight, unless someone else has claimed it since. */
  release(owner: unknown) {
    if (this.owner !== owner) return;
    this.owner = null;
    this.text = null;
    this.pitchText = null;
    this.root.visible = false;
  }

  /** What `owner` (who claimed it last) has to say. */
  show(owner: unknown, text: PlateText) {
    if (this.owner !== owner) return;
    this.text = text;
    this.root.visible = true;
    this.paint();
  }

  /** A board agent's pitch in place of its plate while you're talking to it; null goes back to the plate. */
  pitch(pitch: PlatePitch | null) {
    this.pitchText = pitch;
    this.paint();
  }

  /** What it shows right now: the pitch while there is one, else the plate. */
  get showing(): { text: PlateText | null; pitch: PlatePitch | null } {
    return { text: this.text, pitch: this.pitchText };
  }

  /** The lamp's breathing and blinking, and a repaint once the bundled fonts land. */
  update(dt: number) {
    if (!this.root.visible) return;
    if (fontRevision() !== this.drawnFonts) this.paint(true);
    this.t += dt;
    const pulse = this.text?.lamp ? this.text.pulse : 'steady';
    this.lamp.visible = pulse !== 'call' || this.t % BLINK < BLINK * 0.6;
    this.lamp.scale.setScalar(pulse === 'busy' ? this.lampSize * (1 + 0.22 * Math.sin(this.t * 5)) : this.lampSize);
  }

  private paint(force = false) {
    const key = JSON.stringify([this.text, this.pitchText]);
    if (!force && key === this.drawn) return;
    this.drawn = key;
    this.drawnFonts = fontRevision();
    paintPlate(this.ctx, this.canvas.width, this.canvas.height, this.text, this.pitchText);
    this.texture.needsUpdate = true;
    this.lampMat.color.set(this.text?.lamp ?? '#2b2d42');
  }

  dispose() {
    this.root.removeFromParent();
    this.texture.dispose();
    this.face.dispose();
    this.lampMat.dispose();
  }
}

/**
 * A teammate's name badge, clipped to the front of their shirt: a white card with a dark band, in
 * the headset app, where nobody's name floats over their head. Faces +z, `width` meters across.
 */
export function nameBadge(name: string, width = 0.24, height = 0.08): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * PX_PER_M * 2);
  canvas.height = Math.round(height * PX_PER_M * 2);
  const ctx = canvas.getContext('2d')!;
  const { width: w, height: h } = canvas;
  ctx.fillStyle = '#fafafa';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#2b2d42';
  ctx.fillRect(0, 0, w, h * 0.22);
  const px = h * 0.46;
  ctx.font = `800 ${px}px ${SANS}`;
  ctx.fillStyle = '#16171d';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const fitted = wrapText(ctx, withGlyph(name), w * 0.9, 1, px)[0] ?? '';
  fillGlyphText(ctx, fitted, w / 2, h * 0.62, px);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = ANISOTROPY;
  const badge = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
  badge.name = 'name-badge';
  return badge;
}

/** Frees a badge made by nameBadge. */
export function disposeBadge(badge: THREE.Mesh) {
  badge.removeFromParent();
  badge.geometry.dispose();
  const mat = badge.material as THREE.MeshBasicMaterial;
  mat.map?.dispose();
  mat.dispose();
}
