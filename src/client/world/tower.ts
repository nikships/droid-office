import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BALCONY, BALCONY_DOOR, ELEVATOR, ELEVATOR_FRONT, EXIT_DOOR, FLOOR, ROOF_BAR, SLAB, STAGE, STOREY, WALL_HEIGHT, WALL_T, WINDOWS, type Opening, type Side } from '../../shared/layout';
import { glyphGeometry } from './glyph3d';
import type { Collider } from './office';
import { bulb, type NightParts } from './outside';
import { Steam } from './smoke';
import { ANISOTROPY, TILE_SCALE, fitScale } from './texture-quality';
import { mergeByMaterial, mesh, toon, toonUnique } from './toon';

// The rest of the building, from outside: a floor per project, stacked into a tower. Only the floor
// you're on is really there; the others are its outside (walls, windows, a balcony off each, a
// parapet round the top and the rooftop bar over it, roughly), rebuilt whenever floors come and go or
// you change floors. Up on the roof it's every floor, under your feet.
//
// The building is Factory's software factory: black standing-seam cladding (the floor you're on gets
// it too, just off its own walls), slim black steel window frames, a hairline of light at every slab,
// the FACTORY sign on the top floor facing the street, a canopy over the way in, and the stack on the roof.

/** The building, walls included. */
const B = { minX: FLOOR.minX - WALL_T, maxX: FLOOR.maxX + WALL_T, minZ: FLOOR.minZ - WALL_T, maxZ: FLOOR.maxZ + WALL_T } as const;
/** The outside's planes stand this far off the walls, so they never fight the floor you're on for a pixel. */
const OFF = 0.01;
/** The cladding over the floor you're on stands a little further off its walls, for the same reason from far away. */
const OWN_OFF = 0.025;
/** From one standing seam of the cladding to the next, in meters. */
const SEAM = 0.5;

/** The stack on the roof: where it stands, how wide at the foot, and how tall above the deck. */
export const STACK = { x: -14, z: -10.4, r: 0.72, height: 11, plinth: 2.6 } as const;

export interface Tower {
  group: THREE.Group;
  /**
   * Builds the outside of every floor but `index`, of `count` stacked from the bottom one (0). An
   * `index` of `count` is the roof: every floor, below it, and no top (the roof is its own).
   */
  set(index: number, count: number): void;
}

/** Each side of the building: where along it things are (u, from corner to corner, where it meets the next side's plane), and its plane. */
const FACES: Record<Side, { u0: number; u1: number; at: (u: number, y: number, off?: number) => THREE.Vector3; rotY: number; dir: number }> = {
  north: { u0: B.minX - OFF, u1: B.maxX + OFF, at: (u, y, off = OFF) => new THREE.Vector3(u, y, B.minZ - off), rotY: Math.PI, dir: -1 },
  south: { u0: B.minX - OFF, u1: B.maxX + OFF, at: (u, y, off = OFF) => new THREE.Vector3(u, y, B.maxZ + off), rotY: 0, dir: 1 },
  west: { u0: B.minZ - OFF, u1: B.maxZ + OFF, at: (u, y, off = OFF) => new THREE.Vector3(B.minX - off, y, u), rotY: -Math.PI / 2, dir: 1 },
  east: { u0: B.minZ - OFF, u1: B.maxZ + OFF, at: (u, y, off = OFF) => new THREE.Vector3(B.maxX + off, y, u), rotY: Math.PI / 2, dir: -1 },
};

/** A wall-built group (along x, outdoors toward +z) turned onto `side`, `u` along it. */
function onFace(g: THREE.Object3D, side: Side, u: number): THREE.Object3D {
  const f = FACES[side];
  g.position.copy(f.at(u, 0));
  g.rotation.y = f.rotY;
  return g;
}

/** A material whose texture is the black standing-seam cladding, a seam every SEAM meters. */
let cladding: THREE.MeshToonMaterial | null = null;
function claddingMaterial(): THREE.MeshToonMaterial {
  if (cladding) return cladding;
  const W = 32;
  const H = 8;
  const c = document.createElement('canvas');
  const k = fitScale(W, H, TILE_SCALE);
  c.width = Math.round(W * k);
  c.height = Math.round(H * k);
  const g = c.getContext('2d')!;
  g.scale(c.width / W, c.height / H);
  // The pan, a little darker toward each seam, and the seam standing proud: lit edge, then its shadow.
  g.fillStyle = '#242424';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#1d1d1d';
  g.fillRect(0, 0, 5, H);
  g.fillRect(W - 7, 0, 7, H);
  g.fillStyle = '#4c4c4c';
  g.fillRect(W / 2 - 1.5, 0, 1.5, H);
  g.fillStyle = '#363636';
  g.fillRect(W / 2, 0, 1.5, H);
  g.fillStyle = '#0c0c0c';
  g.fillRect(W / 2 + 1.5, 0, 2, H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = ANISOTROPY;
  cladding = new THREE.MeshToonMaterial({ color: '#ffffff', map: t, gradientMap: (toon('#fff') as THREE.MeshToonMaterial).gradientMap });
  cladding.userData.outlineParameters = { visible: false };
  return cladding;
}

// ---- Pixel letters ---------------------------------------------------------------------------------

/** A square-pixel face (after Geist Pixel Square), 5 across and 7 up, for the signs on the building. */
const PIXELS: Record<string, string> = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#',
  B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '.####|#....|#....|#....|#....|#....|.####',
  D: '####.|#...#|#...#|#...#|#...#|#...#|####.',
  F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.####|#....|#....|#.###|#...#|#...#|.###.',
  I: '#####|..#..|..#..|..#..|..#..|..#..|#####',
  L: '#....|#....|#....|#....|#....|#....|#####',
  N: '#...#|##..#|#.#.#|#..##|#...#|#...#|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..',
  '0': '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.',
  '1': '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  ' ': '.....|.....|.....|.....|.....|.....|.....',
};

/** How wide `text` is in pixel letters `p` meters a pixel, a pixel between letters. */
export function pixelWidth(text: string, p: number): number {
  return (text.length * 6 - 1) * p;
}

/**
 * `text` in pixel letters, `p` meters a pixel and `depth` deep, as one geometry: from x = 0 to its
 * width (pixelWidth), y = 0 to 7p, its face toward +z.
 */
export function pixelText(text: string, p: number, depth: number): THREE.BufferGeometry {
  const cubes: THREE.BufferGeometry[] = [];
  const s = p * 0.86;
  [...text.toUpperCase()].forEach((ch, n) => {
    const rows = (PIXELS[ch] ?? PIXELS[' ']).split('|');
    rows.forEach((row, r) => {
      for (let c = 0; c < 5; c++) {
        if (row[c] !== '#') continue;
        cubes.push(new THREE.BoxGeometry(s, s, depth).translate((n * 6 + c + 0.5) * p, (6 - r + 0.5) * p, 0));
      }
    });
  });
  const geo = cubes.length ? mergeGeometries(cubes)! : new THREE.BufferGeometry();
  for (const c of cubes) c.dispose();
  return geo;
}

// ---- The stack ------------------------------------------------------------------------------------

/**
 * The factory's stack on the roof, standing on the deck at y = 0 round (STACK.x, STACK.z): a steel
 * plinth, the stack itself in black steel with banding and a ladder up its side, and a hairline of
 * orange under its lip. Returns its parts (to merge) and the mouth, where the steam comes from and
 * the beacon goes.
 */
export function buildStack(night: NightParts): { parts: THREE.Group; mouth: THREE.Vector3 } {
  const parts = new THREE.Group();
  const steel = toon('#2a2a2a');
  const black = toon('#121212');
  const light = toon('#8c8c8c');
  const { x, z, r, height: H, plinth: P } = STACK;
  parts.add(mesh(new THREE.BoxGeometry(P, 0.9, P), steel, x, 0.45, z));
  parts.add(mesh(new THREE.BoxGeometry(P + 0.12, 0.08, P + 0.12), light, x, 0.94, z, false));
  parts.add(mesh(new THREE.CylinderGeometry(r * 0.82, r, H - 0.9, 20), black, x, 0.9 + (H - 0.9) / 2, z));
  for (const y of [3.2, 6.4, 9.2]) parts.add(mesh(new THREE.CylinderGeometry(r * (1 - (y / H) * 0.18) + 0.05, r * (1 - (y / H) * 0.18) + 0.05, 0.16, 20), steel, x, y, z, false));
  const lipR = r * 0.82 + 0.08;
  parts.add(mesh(new THREE.CylinderGeometry(lipR, lipR, 0.4, 20), steel, x, H - 0.1, z, false));
  const ring = bulb(night, '#ee6018', 0.6);
  ring.userData.outlineParameters = { visible: false };
  parts.add(mesh(new THREE.CylinderGeometry(lipR + 0.01, lipR + 0.01, 0.06, 20), ring, x, H - 0.36, z, false));
  // A ladder up the side facing the street.
  const lz = z + r + 0.12;
  for (const sx of [-0.22, 0.22]) parts.add(mesh(new THREE.BoxGeometry(0.04, H - 1.6, 0.04), light, x + sx, 1 + (H - 1.6) / 2, lz, false));
  for (let y = 1.3; y < H - 0.6; y += 0.4) parts.add(mesh(new THREE.BoxGeometry(0.44, 0.03, 0.03), light, x, y, lz, false));
  return { parts, mouth: new THREE.Vector3(x, H + 0.15, z) };
}

/** The orange light on top of the stack, flashing as an aviation beacon does: a short blink every second and a half. */
export function stackBeacon(mouth: THREE.Vector3): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({ color: '#ee6018' });
  mat.toneMapped = false;
  mat.userData.outlineParameters = { visible: false };
  const on = new THREE.Color('#ef6f2e');
  const off = new THREE.Color('#3a1a08');
  const m = mesh(new THREE.BoxGeometry(0.36, 0.26, 0.36), mat, mouth.x + STACK.r * 0.82 + 0.05, mouth.y + 0.12, mouth.z, false);
  m.onBeforeRender = () => {
    const t = (performance.now() / 1000) % 1.5;
    mat.color.copy(t < 0.28 ? on : off);
  };
  return m;
}

export function buildTower(colliders: Collider[], night: NightParts): Tower {
  const group = new THREE.Group();
  const panel = claddingMaterial();
  const band = toon('#222222');
  const frame = toon('#0c0c0c');
  const sill = toon('#2a2a2a');
  const ink = toon('#0c0c0c');
  const railTop = toon('#3a3a3a');
  const deck = toon('#1c1c1c');
  const parapet = toon('#0e0e0e');
  const behind = toon('#050505');
  // A hairline of light along every slab, and an orange one under the parapet.
  const strip = bulb(night, '#efe8dc', 0.25);
  strip.userData.outlineParameters = { visible: false };
  const crownStrip = bulb(night, '#ee6018', 0.4);
  crownStrip.userData.outlineParameters = { visible: false };
  // Glass you can't see into; at night most of it glows warm, the factory running round the clock.
  const dark = toon('#1b1e23');
  const lit = ['#f3dcb2', '#efe5d3', '#e9d2a8'].map((glow) => {
    const m = toonUnique('#2a2a2a');
    m.emissive.set(glow);
    m.emissiveIntensity = 0;
    night.windows.push(m);
    return m;
  });
  const glint = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.1, depthWrite: false });
  const railGlass = new THREE.MeshBasicMaterial({ color: '#c9d2da', transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
  // The sign's letters, the pinwheel, and the canopy's underside.
  const letters = bulb(night, '#eeeeee', 0.75);
  letters.userData.outlineParameters = { visible: false };
  const orange = bulb(night, '#ee6018', 0.75);
  orange.userData.outlineParameters = { visible: false };
  const raceway = toon('#0a0a0a');
  const glyph = glyphGeometry(1, 1, 5);

  let built: THREE.Object3D[] = [];
  let steam: Steam[] = [];
  let mine: Collider[] = [];
  let seed = 1;
  /** The same windows light up each time a floor's outside is rebuilt. */
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  /** Cladding quads, seams running up them, gathered into one mesh (merging by material would drop their texture coordinates). */
  let clad: THREE.BufferGeometry[] = [];

  /** One floor's outside on `side`, `y0` up from the floor you're on: the band of its slab, then its wall round its windows and doors. */
  const facade = (parts: THREE.Group, side: Side, y0: number, holes: Opening[], off: number) => {
    const f = FACES[side];
    const quad = (u0: number, u1: number, y1: number, y2: number, mat: THREE.Material | null) => {
      if (u1 - u0 < 0.001 || y2 - y1 < 0.001) return;
      const geo = new THREE.PlaneGeometry(u1 - u0, y2 - y1);
      const mid = (u0 + u1) / 2;
      if (!mat) {
        // Seams stay put along the wall from one piece to the next: u from the face's own coordinate.
        const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
        const p = geo.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, (mid + f.dir * p.getX(i)) / SEAM, (p.getY(i) + (y1 + y2) / 2) / SEAM);
      }
      const m = new THREE.Mesh(geo, mat ?? panel);
      m.position.copy(f.at(mid, (y1 + y2) / 2, off));
      m.rotation.y = f.rotY;
      if (mat) {
        m.castShadow = false;
        parts.add(m);
      } else {
        m.updateMatrix();
        geo.applyMatrix4(m.matrix);
        clad.push(geo);
      }
    };
    quad(f.u0, f.u1, y0 - SLAB, y0, band);
    let u = f.u0;
    for (const o of [...holes].sort((a, b) => a.u - b.u)) {
      const h0 = o.u - o.width / 2;
      const h1 = o.u + o.width / 2;
      quad(u, h0, y0, y0 + WALL_HEIGHT, null);
      quad(h0, h1, y0, y0 + o.y0, null);
      quad(h0, h1, y0 + o.y1, y0 + WALL_HEIGHT, null);
      u = h1;
    }
    quad(u, f.u1, y0, y0 + WALL_HEIGHT, null);
  };

  /** The hairline of light round the building at the slab `y0` up. */
  const slabLine = (parts: THREE.Group, y: number, mat: THREE.Material, h = 0.035) => {
    const t = 0.03;
    parts.add(mesh(new THREE.BoxGeometry(B.maxX - B.minX + 2 * t, h, t), mat, 0, y, B.maxZ + OWN_OFF + t / 2, false));
    parts.add(mesh(new THREE.BoxGeometry(B.maxX - B.minX + 2 * t, h, t), mat, 0, y, B.minZ - OWN_OFF - t / 2, false));
    parts.add(mesh(new THREE.BoxGeometry(t, h, B.maxZ - B.minZ), mat, B.maxX + OWN_OFF + t / 2, y, (B.minZ + B.maxZ) / 2, false));
    parts.add(mesh(new THREE.BoxGeometry(t, h, B.maxZ - B.minZ), mat, B.minX - OWN_OFF - t / 2, y, (B.minZ + B.maxZ) / 2, false));
  };

  /** Glass in a hole: set back a little, with a slim black steel frame round it, a bar down the middle and a sill. */
  const glazing = (parts: THREE.Group, o: Opening, y0: number, door: boolean) => {
    const g = new THREE.Group();
    const w = o.width;
    const h = o.y1 - o.y0;
    const F = 0.06;
    const glass = random() < 0.62 ? lit[Math.floor(random() * lit.length)] : dark;
    const mid = y0 + (o.y0 + o.y1) / 2;
    g.add(mesh(new THREE.PlaneGeometry(w - 2 * F, h - 2 * F), glass, 0, mid, -0.06, false));
    const s = mesh(new THREE.PlaneGeometry(0.12, h * 0.5), glint, -w * 0.2, mid + h * 0.05, -0.05, false);
    s.rotation.z = -0.5;
    g.add(s);
    g.add(mesh(new THREE.BoxGeometry(w, F, 0.12), frame, 0, y0 + o.y1 - F / 2, -0.04, false));
    g.add(mesh(new THREE.BoxGeometry(w, F, 0.12), frame, 0, y0 + o.y0 + F / 2, -0.04, false));
    for (const sx of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(F, h, 0.12), frame, sx * (w / 2 - F / 2), mid, -0.04, false));
    g.add(mesh(new THREE.BoxGeometry(F * 0.6, h - 2 * F, 0.06), frame, 0, mid, -0.05, false));
    if (!door) {
      g.add(mesh(new THREE.BoxGeometry(F * 0.6, 0.04, 0.06), frame, 0, mid, -0.05, false));
      g.add(mesh(new THREE.BoxGeometry(w - 2 * F, 0.035, 0.06), frame, 0, y0 + o.y0 + h * 0.72, -0.05, false));
      g.add(mesh(new THREE.BoxGeometry(w + 0.12, 0.05, 0.14), sill, 0, y0 + o.y0 - 0.025, 0.05, false));
    }
    parts.add(onFace(g, o.wall, o.u));
  };

  /** The balcony off a floor `y0` up: its deck, and a railing with glass in it round the three open sides. */
  const balcony = (parts: THREE.Group, y0: number) => {
    const { minX, maxX, minZ, maxZ } = BALCONY;
    const w = maxX - minX;
    const d = maxZ - minZ;
    parts.add(mesh(new THREE.BoxGeometry(w, SLAB - 0.01, d), deck, (minX + maxX) / 2, y0 - SLAB / 2 - 0.005, (minZ + maxZ) / 2, false));
    parts.add(mesh(new THREE.BoxGeometry(w + 0.02, 0.03, 0.03), strip, (minX + maxX) / 2, y0 - SLAB / 2, maxZ + 0.01, false));
    const railH = 1.05;
    const inset = 0.06;
    const sides: [number, number, number, number][] = [
      [minX + inset, maxZ - inset, maxX - inset, maxZ - inset],
      [minX + inset, minZ, minX + inset, maxZ - inset],
      [maxX - inset, minZ, maxX - inset, maxZ - inset],
    ];
    for (const [x0, z0, x1, z1] of sides) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const alongX = z0 === z1;
      const n = Math.ceil(len / 1.6);
      for (let i = 0; i <= n; i++) parts.add(mesh(new THREE.BoxGeometry(0.05, railH, 0.05), ink, x0 + ((x1 - x0) * i) / n, y0 + railH / 2, z0 + ((z1 - z0) * i) / n, false));
      parts.add(mesh(alongX ? new THREE.BoxGeometry(len + 0.1, 0.05, 0.08) : new THREE.BoxGeometry(0.08, 0.05, len + 0.1), railTop, (x0 + x1) / 2, y0 + railH + 0.02, (z0 + z1) / 2, false));
      const pane = mesh(new THREE.PlaneGeometry(len - 0.1, railH - 0.2), railGlass, (x0 + x1) / 2, y0 + (railH - 0.2) / 2 + 0.08, (z0 + z1) / 2, false);
      pane.rotation.y = alongX ? 0 : Math.PI / 2;
      parts.add(pane);
    }
  };

  /** A parapet round the top of the building, `top` up: along each wall, and out past it at both corners so the four meet. */
  const crown = (parts: THREE.Group, top: number) => {
    const H = 0.5;
    const out = 0.12;
    for (const side of Object.keys(FACES) as Side[]) {
      const f = FACES[side];
      const g = new THREE.Group();
      const len = f.u1 - f.u0 + 2 * out;
      g.add(mesh(new THREE.BoxGeometry(len, H, WALL_T + out), parapet, 0, top + H / 2, out / 2 - WALL_T / 2 - OFF, false));
      parts.add(onFace(g, side, (f.u0 + f.u1) / 2));
    }
    slabLine(parts, top + 0.02, crownStrip, 0.03);
  };

  /**
   * FACTORY across the top floor's south face, `y0` up, over the balcony and clear of the loft's
   * window: the pinwheel in orange and the letters in light pixels on a black raceway, facing the street.
   */
  const sign = (parts: THREE.Group, y0: number) => {
    const p = 0.3;
    const word = 'FACTORY';
    const tall = 7 * p;
    const mark = tall * 1.18;
    const gap = p * 3;
    const width = mark + gap + pixelWidth(word, p);
    const x0 = -6.6 - width / 2;
    const yb = y0 + 3.95;
    const z = B.maxZ + OWN_OFF;
    parts.add(mesh(new THREE.BoxGeometry(width + 0.8, 0.14, 0.12), raceway, x0 + width / 2, yb - 0.25, z + 0.06, false));
    const g = pixelText(word, p, 0.1);
    g.translate(x0 + mark + gap, yb, z + 0.17);
    parts.add(new THREE.Mesh(g, letters));
    const pin = glyph.clone();
    pin.scale(mark, mark, 0.14);
    pin.translate(x0 + mark / 2, yb + tall / 2, z + 0.16);
    parts.add(new THREE.Mesh(pin, orange));
  };

  /**
   * Over the way in, the bottom floor's exit door (west side, `y0` up): a black canopy with a light
   * along its underside and BUILDING 01 on its fascia, the 01 in orange.
   */
  const canopy = (parts: THREE.Group, y0: number) => {
    const g = new THREE.Group();
    const D = 1.9;
    const W = 3.4;
    const y = y0 + EXIT_DOOR.y1 + 0.65;
    const T = 0.3;
    g.add(mesh(new THREE.BoxGeometry(W, T, D), raceway, 0, y + T / 2, OWN_OFF + D / 2, false));
    g.add(mesh(new THREE.BoxGeometry(W - 0.3, 0.02, 0.05), letters, 0, y - 0.005, OWN_OFF + D - 0.15, false));
    for (const sx of [-1, 1]) {
      const rod = mesh(new THREE.BoxGeometry(0.03, 0.03, Math.hypot(D - 0.1, 1.1)), sill, sx * (W / 2 - 0.15), y + T + 0.55, OWN_OFF + (D - 0.1) / 2, false);
      rod.rotation.x = Math.atan2(1.1, D - 0.1);
      g.add(rod);
    }
    const p = 0.03;
    const text = 'BUILDING 01';
    const tw = pixelWidth(text, p) + 0.34;
    const left = -tw / 2;
    const pin = glyph.clone();
    pin.scale(0.24, 0.24, 0.03);
    pin.translate(left + 0.12, y + T / 2, OWN_OFF + D + 0.02);
    g.add(new THREE.Mesh(pin, orange));
    const word = pixelText('BUILDING', p, 0.02);
    word.translate(left + 0.34, y + T / 2 - 3.5 * p, OWN_OFF + D + 0.012);
    g.add(new THREE.Mesh(word, letters));
    const num = pixelText('01', p, 0.02);
    num.translate(left + 0.34 + pixelWidth('BUILDING ', p) + p, y + T / 2 - 3.5 * p, OWN_OFF + D + 0.012);
    g.add(new THREE.Mesh(num, orange));
    parts.add(onFace(g, 'west', EXIT_DOOR.u));
  };

  // The rooftop bar, as it looks from down below (world/rooftop.ts has the real one).
  const curb = toon('#161616');
  const steel = toon('#3a3a3a');
  const steelDark = toon('#2a2a2a');
  const beacon = bulb(night, '#ee6018', 0.6);
  const stage = toon('#101010');
  const black = toon('#0a0a0a');
  const led = bulb(night, '#1c1c1c', 0.35);
  const truss = toon('#3a3a3a');
  const barBody = toon('#161616');
  const counter = toon('#cfcfcf');
  const shelf = toon('#101010');
  const pergola = toon('#1c1c1c');
  const parasol = toon('#141414');

  /**
   * The rooftop bar on the roof, `y` up, roughly: a curb round the edge with glass on it and a steel
   * rail along the top, the elevator's housing, the DJ's stage with the LED wall behind it and the
   * rig over it, the bar and its back bar under a pergola, the parasols along the south edge, and the stack.
   */
  const roofTop = (parts: THREE.Group, y: number) => {
    const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y0: number, z: number) => parts.add(mesh(new THREE.BoxGeometry(w, h, d), mat, x, y0 + h / 2, z, false));
    const edges: [number, number, number, number][] = [
      [B.minX, B.maxX, B.minZ, FLOOR.minZ],
      [B.minX, B.maxX, FLOOR.maxZ, B.maxZ],
      [B.minX, FLOOR.minX, B.minZ, B.maxZ],
      [FLOOR.maxX, B.maxX, B.minZ, B.maxZ],
    ];
    for (const [x0, x1, z0, z1] of edges) {
      const ex = (x0 + x1) / 2;
      const ez = (z0 + z1) / 2;
      const alongX = x1 - x0 > z1 - z0;
      const len = alongX ? x1 - x0 : z1 - z0;
      box(x1 - x0, 0.45, z1 - z0, curb, ex, y, ez);
      const pane = mesh(new THREE.PlaneGeometry(len, 0.72), railGlass, ex, y + 0.81, ez, false);
      if (!alongX) pane.rotation.y = Math.PI / 2;
      parts.add(pane);
      box(alongX ? len : 0.07, 0.07, alongX ? 0.07 : len, steel, ex, y + 1.155, ez);
      for (let a = 0; a <= len + 0.01; a += 2.4) box(0.06, 0.75, 0.06, steel, alongX ? x0 + a : ex, y + 0.425, alongX ? ez : z0 + a);
    }

    // The elevator's housing, as tall as a floor, with a light on top.
    const hz = (B.minZ + ELEVATOR_FRONT) / 2;
    box(ELEVATOR.width, WALL_HEIGHT, ELEVATOR_FRONT - B.minZ, steelDark, ELEVATOR.x, y, hz);
    box(ELEVATOR.width + 0.3, 0.3, ELEVATOR_FRONT - B.minZ + 0.2, black, ELEVATOR.x, y + WALL_HEIGHT, hz + 0.05);
    parts.add(mesh(new THREE.BoxGeometry(0.2, 0.16, 0.2), beacon, ELEVATOR.x, y + WALL_HEIGHT + 0.38, hz, false));

    // The stage, the LED wall behind the DJ, and the rig: a truss tower either side and a beam across.
    const sw = STAGE.maxX - STAGE.minX;
    const scx = (STAGE.minX + STAGE.maxX) / 2;
    box(sw, STAGE.height, STAGE.maxZ - STAGE.minZ, stage, scx, y, (STAGE.minZ + STAGE.maxZ) / 2);
    box(8.3, 4.3, 0.25, black, scx, y + STAGE.height + 0.2, STAGE.minZ + 0.06);
    parts.add(mesh(new THREE.PlaneGeometry(8, 4), led, scx, y + STAGE.height + 2.35, STAGE.minZ + 0.2, false));
    const rigZ = STAGE.maxZ - 0.15;
    const rigTop = 5.6;
    for (const x of [STAGE.minX + 0.2, STAGE.maxX - 0.2]) box(0.34, rigTop - STAGE.height, 0.34, truss, x, y + STAGE.height, rigZ);
    box(sw - 0.4, 0.34, 0.34, truss, scx, y + rigTop - 0.34, rigZ);

    // The bar along the east side, the shelves of bottles behind it, and the pergola over both.
    const blen = ROOF_BAR.maxZ - ROOF_BAR.minZ;
    const bz = (ROOF_BAR.minZ + ROOF_BAR.maxZ) / 2;
    const front = ROOF_BAR.x - ROOF_BAR.depth / 2;
    box(ROOF_BAR.depth, ROOF_BAR.height - 0.06, blen, barBody, ROOF_BAR.x, y, bz);
    box(ROOF_BAR.depth + 0.2, 0.06, blen + 0.2, counter, ROOF_BAR.x - 0.05, y + ROOF_BAR.height - 0.06, bz);
    box(0.6, 2.4, blen - 0.6, shelf, FLOOR.maxX - 0.35, y, bz);
    const p0 = { x: front - 0.9, z: ROOF_BAR.minZ - 0.8 };
    const p1 = { x: FLOOR.maxX - 0.1, z: ROOF_BAR.maxZ + 0.8 };
    const roofY = 3.3;
    for (const x of [p0.x, p1.x]) {
      for (const z of [p0.z, p1.z]) box(0.16, roofY, 0.16, pergola, x, y, z);
      box(0.16, 0.22, p1.z - p0.z + 0.3, pergola, x, y + roofY - 0.11, (p0.z + p1.z) / 2);
    }
    for (let z = p0.z; z <= p1.z + 0.01; z += 0.55) box(p1.x - p0.x + 0.4, 0.08, 0.1, pergola, (p0.x + p1.x) / 2, y + roofY + 0.11, z);

    // Parasols along the south edge, over the sun loungers.
    for (const x of [-0.8, 2]) {
      const z = FLOOR.maxZ - 1.1;
      box(0.06, 2.6, 0.06, steel, x, y, z);
      parts.add(mesh(new THREE.ConeGeometry(1.5, 0.4, 12), parasol, x, y + 2.6, z, false));
    }

    // The stack, and its steam and beacon (which move, so they aren't merged).
    const stack = buildStack(night);
    stack.parts.position.y = y;
    parts.add(stack.parts);
    const mouth = stack.mouth.clone();
    mouth.y += y;
    return mouth;
  };

  const set = (index: number, count: number) => {
    for (const o of built) {
      o.removeFromParent();
      o.traverse((m) => {
        if ((m as THREE.Mesh).isMesh) (m as THREE.Mesh).geometry.dispose();
      });
    }
    for (const s of steam) s.dispose();
    built = [];
    steam = [];
    clad = [];
    for (const c of mine) {
      const i = colliders.indexOf(c);
      if (i >= 0) colliders.splice(i, 1);
    }
    mine = [];
    seed = 20260927;

    const parts = new THREE.Group();
    for (let k = 0; k < count; k++) {
      const r = k - index;
      const y0 = r * STOREY;
      const own = r === 0;
      for (const side of Object.keys(FACES) as Side[]) {
        const holes: Opening[] = WINDOWS.filter((o) => o.wall === side);
        if (side === 'south') holes.push(BALCONY_DOOR);
        // Only the bottom floor has a way out on the west side; its door stands in the hole (see office.ts).
        if (side === 'west' && k === 0) holes.push(EXIT_DOOR);
        // The floor you're on has its own windows, doors and balcony: here it only gets its cladding.
        facade(parts, side, y0, holes, own ? OWN_OFF : OFF);
      }
      slabLine(parts, y0 - SLAB / 2, strip);
      if (k === count - 1) sign(parts, y0);
      if (k === 0) canopy(parts, y0);
      if (own) continue;
      for (const o of WINDOWS) glazing(parts, o, y0, false);
      glazing(parts, BALCONY_DOOR, y0, true);
      balcony(parts, y0);
      if (k === 0) {
        // Dark behind the exit door, through its porthole.
        const back = mesh(new THREE.PlaneGeometry(EXIT_DOOR.width, EXIT_DOOR.y1), behind, FLOOR.minX - 0.02, y0 + EXIT_DOOR.y1 / 2, EXIT_DOOR.u, false);
        back.rotation.y = -Math.PI / 2;
        parts.add(back);
      }
    }
    // On top, a parapet, and the rooftop bar over it; but up on the roof, it's the roof's own.
    const moving = new THREE.Group();
    if (index < count) {
      const top = (count - 1 - index) * STOREY + WALL_HEIGHT;
      crown(parts, top);
      const mouth = roofTop(parts, top + SLAB);
      const s = new Steam(mouth);
      steam.push(s);
      moving.add(s.group, stackBeacon(mouth));
    }
    // None of it casts a shadow (the sun lights the office through where its roof would be), and none
    // takes one from the floor you're on, which would fall on it as though nothing were in between.
    const merged = mergeByMaterial(parts);
    if (clad.length) {
      merged.add(new THREE.Mesh(mergeGeometries(clad)!, panel));
      for (const c of clad) c.dispose();
      clad = [];
    }
    merged.traverse((o) => {
      o.receiveShadow = false;
      o.castShadow = false;
    });
    group.add(merged, moving);
    built.push(merged, moving);

    // Below you, the outside walls down to the garage, which you can't walk into from the steps
    // outside the bottom floor's door, and the bottom floor's slab, which is the garage's ceiling.
    if (index > 0 && index < count) {
      const bottom = -index * STOREY - SLAB;
      const T = WALL_T;
      mine.push(
        { minX: B.minX, maxX: B.maxX, minZ: B.minZ, maxZ: B.minZ + T, bottom, top: -SLAB },
        { minX: B.minX, maxX: B.maxX, minZ: B.maxZ - T, maxZ: B.maxZ, bottom, top: -SLAB },
        { minX: B.minX, maxX: B.minX + T, minZ: B.minZ, maxZ: B.maxZ, bottom, top: -SLAB },
        { minX: B.maxX - T, maxX: B.maxX, minZ: B.minZ, maxZ: B.maxZ, bottom, top: -SLAB },
        { ...B, bottom, top: bottom + SLAB },
      );
      colliders.push(...mine);
    }
  };

  return { group, set };
}
