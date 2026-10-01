import * as THREE from 'three';
import { SANS, fontRevision } from '../fonts';
import { fillGlyphText, measureGlyphText, withGlyph } from './glyph';
import { ANISOTROPY } from './texture-quality';
import { mesh, plainLabel, printedMaterial, roundedBox, toon, wrapText } from './toon';

/**
 * Nameplates: in the headset app (`/?native=1`, see native/mode.ts floatingTagsShown) nothing
 * floats over anyone's head, not even the bulb on a worker's antenna. Who sits where is engraved on
 * the seat, as in an office: a brass plate on each sloped face of a wooden name block lying on its
 * desk, or a brass plate on the back of its meeting chair or bean bag, lit by the room like the desk
 * or the chair. A board agent's kiosk has a screen set into its front instead. A status lamp beside
 * the plate, a lit dome in a steel collar, glows in the worker's status color, breathing while it
 * works and blinking while it waits on you; its laptop's screen says the rest (world/laptop.ts
 * setTitle).
 */

/** How a seat carries its nameplate (DeskView.plate). The plate's face looks along the anchor's +z. */
export interface PlateMount {
  anchor: THREE.Object3D;
  /**
   * `block`: a wooden name block lying on a desk, its length along x, with a brass plate on each of
   * its two sloped faces, one toward +z (the chair, and the aisle behind it) and one toward -z.
   * `plate`: a brass plate on a backing, centered on the anchor (a chair back, a bean bag).
   * `screen`: a display in a bezel, centered on the anchor (the screen in a kiosk's front): it also
   * shows how its agent is doing, and its pitch once you greet it.
   */
  shape: 'block' | 'plate' | 'screen';
  /** One face, in meters: a block's sloped face is `height` from its foot to the ridge. */
  width: number;
  height: number;
  /**
   * Where its status lamp stands, in the anchor's space, domed up its +y, and the dome's radius in
   * meters. By default it stands on the desk in front of a block's end, or on a plate's top edge.
   */
  lamp?: { at: readonly [number, number, number]; radius: number };
}

/** Steady; breathing while it works; blinking while it waits on you. */
export type LampPulse = 'steady' | 'busy' | 'call';

/** What a nameplate says. */
export interface PlateText {
  /** Who sits here: "Pixel 🐚", "Issues agent". An engraved plate says it without the emoji. */
  name: string;
  /** What it is: its engine ("Claude Code · Opus 4.1 · High"), "Shell", or a kiosk agent's board ("Issues board", then its model once hired); '' for none. */
  role: string;
  /** Its state, as its status light reads: a word ("READY", "PR #12 MERGED") and its color. A kiosk's screen and a laptop's title bar show it; an engraved plate leaves it to its lamp. */
  state: readonly [string, string];
  /** What it's on, on one line; '' for nothing. */
  line: string;
  /** Its own color, down a screen's left edge. */
  color: string;
  /** The lamp's color, or null when it's out (shot, or leaving). */
  lamp: string | null;
  pulse: LampPulse;
}

/** A board agent's pitch, shown on its kiosk's screen only once you start talking to it. */
export interface PlatePitch {
  /** Who's talking: "📌 Issues agent". */
  heading: string;
  /** "Ask me about issues". */
  title: string;
  /** "I file, find, triage, label and close them". */
  body: string;
}

/** Canvas pixels per meter of a screen's face, and of an engraved plate's (finer: its letters are small). */
const PX_PER_M = 1500;
const PRINT_PX_PER_M = 2400;
const INK = '#111318';
const PAPER = '#f4f4f6';
const MUTED = '#a6a9b8';
/** An engraved plate: brushed brass, lighter at the top, and the dark of its cut letters. */
const BRASS_TOP = '#e2c77e';
const BRASS_FOOT = '#b08d42';
const ENGRAVED = '#2a2215';
const ENGRAVED_SOFT = '#4a3c22';
/** How much of its own light an engraved plate gives off: lit by the room, readable in the dark. */
const PLATE_GLOW = 0.28;
/** The wooden name block, the backing behind a plate, a screen's bezel, and a lamp's steel collar. */
const BLOCK_WOOD = '#9c6644';
const PLATE_BACKING = '#6b4f2a';
const BEZEL = '#23252e';
const COLLAR = '#8d99ae';
/** How long one blink of a lamp calling for you takes, on and off, in seconds. */
const BLINK = 0.6;
/** An unlit lamp, and the red a shot owner's heartbeat flashes it (see Nameplate.heartbeat). */
const LAMP_OFF = new THREE.Color('#2b2d42');
const BEAT_RED = new THREE.Color('#ff1f2d');

/** `s` on one line at `px` in the current alignment, shrunk as far as `min` px to fit `width`, and cut short with "…" past that. */
function fitLine(ctx: CanvasRenderingContext2D, s: string, px: number, weight: number, color: string, x: number, y: number, width: number, min = px * 0.7) {
  const glyphs = withGlyph(s);
  ctx.font = `${weight} ${px}px ${SANS}`;
  const full = measureGlyphText(ctx, glyphs, px);
  const size = full > width ? Math.max(min, (px * width) / full) : px;
  ctx.font = `${weight} ${size}px ${SANS}`;
  ctx.fillStyle = color;
  fillGlyphText(ctx, wrapText(ctx, glyphs, width, 1, size)[0] ?? '', x, y, size);
}

/** A kiosk's screen, laid out on a `w` by `h` canvas: who stands there and how it's doing, or its pitch. */
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
  if (pitch) {
    const headPx = h * 0.12;
    const titlePx = h * 0.2;
    const bodyPx = h * 0.13;
    fitLine(ctx, pitch.heading, headPx, 700, MUTED, x, pad + headPx * 0.6, maxW);
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
  const statePx = h * 0.15;
  const stateH = h * 0.2;
  const rows = text.role ? namePx + rolePx * 1.3 + stateH : namePx + stateH;
  const gap = (h - 2 * pad - rows) / (text.role ? 2 : 1);
  let y = pad + namePx / 2;
  fitLine(ctx, text.name, namePx, 800, PAPER, x, y, maxW, namePx * 0.6);
  y += namePx / 2 + gap;
  if (text.role) {
    fitLine(ctx, text.role, rolePx, 600, MUTED, x, y + rolePx * 0.6, maxW);
    y += rolePx * 1.3 + gap;
  }
  // Its state as a device's status light reads, a lit dot and a word in its color, then what it's on.
  const [word, color] = text.state;
  const mid = y + stateH / 2;
  const dot = statePx * 0.38;
  ctx.beginPath();
  ctx.arc(x + dot, mid, dot, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  const wordX = x + dot * 2 + statePx * 0.45;
  ctx.font = `800 ${statePx}px ${SANS}`;
  const wordW = Math.min(maxW - (wordX - x), ctx.measureText(word).width);
  fitLine(ctx, word, statePx, 800, color, wordX, mid + statePx * 0.05, wordW);
  if (text.line) fitLine(ctx, text.line, rolePx, 600, '#e6e6ee', wordX + wordW + pad * 0.8, mid, maxW - (wordX - x) - wordW - pad);
}

/**
 * An engraved brass plate, laid out on a `w` by `h` canvas: the name without its emoji, and under it
 * what it is, in the dark of cut letters, inside a fine engraved border. How it's doing is its
 * lamp's to show, as on a real desk: a plate doesn't change its words.
 */
export function paintEngraved(ctx: CanvasRenderingContext2D, w: number, h: number, text: PlateText | null) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const brass = ctx.createLinearGradient(0, 0, 0, h);
  brass.addColorStop(0, BRASS_TOP);
  brass.addColorStop(1, BRASS_FOOT);
  ctx.fillStyle = brass;
  ctx.fillRect(0, 0, w, h);
  const inset = h * 0.08;
  ctx.lineWidth = Math.max(1, h * 0.02);
  ctx.strokeStyle = ENGRAVED_SOFT;
  ctx.strokeRect(inset, inset, w - 2 * inset, h - 2 * inset);
  if (!text) return;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const maxW = w - 4 * inset;
  const name = plainLabel(text.name);
  if (!text.role) {
    fitLine(ctx, name, h * 0.48, 800, ENGRAVED, w / 2, h * 0.52, maxW, h * 0.3);
    return;
  }
  fitLine(ctx, name, h * 0.4, 800, ENGRAVED, w / 2, h * 0.42, maxW, h * 0.26);
  fitLine(ctx, plainLabel(text.role), h * 0.17, 600, ENGRAVED_SOFT, w / 2, h * 0.75, maxW, h * 0.12);
}

/** Geometry every nameplate of a size shares (the native scene uploads each once). */
const shared = new Map<string, THREE.BufferGeometry>();
function geometry(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = shared.get(key);
  if (!g) shared.set(key, (g = make()));
  return g;
}

/**
 * A wooden name block's body: an equilateral prism lying on one face, `length` along x, its two
 * other faces sloping up to the ridge, each `face` meters from foot to ridge.
 */
function blockGeometry(length: number, face: number): THREE.BufferGeometry {
  const ridge = (face * Math.sqrt(3)) / 2;
  const shape = new THREE.Shape([new THREE.Vector2(-face / 2, 0), new THREE.Vector2(face / 2, 0), new THREE.Vector2(0, ridge)]);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false });
  geo.translate(0, 0, -length / 2);
  // The extrusion runs along x, and the triangle stands across z.
  geo.rotateY(Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

/** A seat's nameplate: see the top of this file. */
export class Nameplate {
  readonly root = new THREE.Group();
  /** A kiosk's screen, which shows its agent's state and pitch; else an engraved plate, which shows who sits there. */
  private readonly screen: boolean;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly face: THREE.MeshBasicMaterial | THREE.MeshToonMaterial;
  /** The status lamp's lit dome. */
  private readonly lamp: THREE.Mesh;
  private readonly lampMat: THREE.MeshBasicMaterial;
  /** Whoever's text it shows (a worker, or the board agent waiting at a kiosk): only it may change or clear it. */
  private owner: unknown = null;
  private text: PlateText | null = null;
  private pitchText: PlatePitch | null = null;
  private drawn = '';
  private drawnFonts = -1;
  private t = 0;
  /** A shot owner's heartbeat on the lamp, or null while it shows the owner's status. */
  private beat: { glow: number; swell: number } | null = null;

  constructor(mount: Omit<PlateMount, 'anchor'>) {
    const { shape, width, height } = mount;
    this.screen = shape === 'screen';
    const density = this.screen ? PX_PER_M : PRINT_PX_PER_M;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(width * density);
    this.canvas.height = Math.round(height * density);
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = ANISOTROPY;
    // A screen lights itself; brass is lit by the room, like the desk or chair it's fixed to.
    this.face = this.screen ? new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false }) : printedMaterial(this.texture, PLATE_GLOW);
    this.lampMat = new THREE.MeshBasicMaterial({ color: LAMP_OFF, toneMapped: false });
    const faceGeo = geometry(`face|${width}|${height}`, () => new THREE.PlaneGeometry(width, height));
    /** Where the lamp stands and how big its dome is (meters), unless the mount says. */
    let lampAt: readonly [number, number, number];
    let radius: number;
    if (shape === 'block') {
      // A plate on each sloped face, tipped back 30 degrees from upright, just proud of the wood.
      const length = width + 0.05;
      const face = height / 0.82;
      const ridge = (face * Math.sqrt(3)) / 2;
      const block = geometry(`block|${length}|${face}`, () => blockGeometry(length, face));
      this.root.add(mesh(block, toon(BLOCK_WOOD)));
      for (const turn of [0, Math.PI]) {
        const side = new THREE.Group();
        side.rotation.y = turn;
        const plate = new THREE.Mesh(faceGeo, this.face);
        plate.position.set(0, ridge / 2 + 0.001, face / 4 + 0.0017);
        plate.rotation.x = -Math.PI / 6;
        side.add(plate);
        this.root.add(side);
      }
      // On the desk in front of the block's right end, as seen from the chair.
      radius = 0.024;
      lampAt = [width / 2 - radius * 1.2, 0, face / 2 + radius * 1.9];
    } else {
      const backing = mesh(
        geometry(`bezel|${width}|${height}`, () => roundedBox(width + 0.03, 0.018, height + 0.03, 0.012)),
        toon(this.screen ? BEZEL : PLATE_BACKING),
        0,
        0,
        0,
        false,
      );
      backing.rotation.x = Math.PI / 2;
      this.root.add(backing);
      const plate = new THREE.Mesh(faceGeo, this.face);
      plate.position.z = 0.0105;
      this.root.add(plate);
      // Standing on the backing's top edge, toward its corner.
      radius = Math.max(0.016, height * 0.1);
      lampAt = [width / 2 - radius * 1.6, height / 2 + 0.015, 0];
    }
    // A lit dome in a steel collar, standing where the mount says.
    const lamp = new THREE.Group();
    lamp.position.set(...(mount.lamp?.at ?? lampAt));
    lamp.scale.setScalar(mount.lamp?.radius ?? radius);
    const collar = mesh(
      geometry('lamp-collar', () => new THREE.CylinderGeometry(1.3, 1.45, 0.55, 18)),
      toon(COLLAR),
      0,
      0.275,
      0,
      false,
    );
    this.lamp = new THREE.Mesh(
      geometry('lamp-dome', () => new THREE.SphereGeometry(1, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2)),
      this.lampMat,
    );
    this.lamp.position.y = 0.55;
    lamp.add(collar, this.lamp);
    this.root.add(lamp);
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
    this.beat = null;
    this.root.visible = false;
  }

  /** What `owner` (who claimed it last) has to say. */
  show(owner: unknown, text: PlateText) {
    if (this.owner !== owner) return;
    this.text = text;
    this.root.visible = true;
    this.paint();
    this.paintLamp();
  }

  /**
   * `owner` lies shot (Worker.pulse): with no light over its head, the lamp on its seat flashes red
   * with each heartbeat, `glow` 0 (dark) to 1 (a full beat), swelling by `swell`, like a monitor by
   * the body. null puts the owner's status color back.
   */
  heartbeat(owner: unknown, glow: number | null, swell = 0) {
    if (this.owner !== owner) return;
    this.beat = glow === null ? null : { glow: THREE.MathUtils.clamp(glow, 0, 1), swell: THREE.MathUtils.clamp(swell, 0, 1) };
    this.paintLamp();
  }

  /** A board agent's pitch on its kiosk's screen while you're talking to it; null goes back to its nameplate. */
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
    const pulse = this.text?.lamp && !this.beat ? this.text.pulse : 'steady';
    this.lamp.visible = pulse !== 'call' || this.t % BLINK < BLINK * 0.6;
    this.lamp.scale.setScalar(this.beat ? 1 + 0.35 * this.beat.swell : pulse === 'busy' ? 1 + 0.22 * Math.sin(this.t * 5) : 1);
  }

  private paintLamp() {
    if (this.beat) this.lampMat.color.copy(LAMP_OFF).lerp(BEAT_RED, this.beat.glow);
    else this.lampMat.color.set(this.text?.lamp ?? LAMP_OFF);
  }

  /** Repaints its face when what it says has changed: all of it on a screen, only who it is on an engraved plate. */
  private paint(force = false) {
    const key = JSON.stringify(this.screen ? [this.text, this.pitchText] : [this.text?.name, this.text?.role]);
    if (!force && key === this.drawn) return;
    this.drawn = key;
    this.drawnFonts = fontRevision();
    if (this.screen) paintPlate(this.ctx, this.canvas.width, this.canvas.height, this.text, this.pitchText);
    else paintEngraved(this.ctx, this.canvas.width, this.canvas.height, this.text);
    this.texture.needsUpdate = true;
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
