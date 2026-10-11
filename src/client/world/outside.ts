import * as THREE from 'three';
import { FLOOR, ROAD, SLAB, STREET_Y, WALL_T } from '../../shared/layout';
import { MONO, SANS } from '../fonts';
import { CAR, supercar, type CarKind } from './cars';
import { glyphFlat } from './glyph3d';
import type { Collider } from './office';
import { ANISOTROPY, TILE_SCALE, fitScale } from './texture-quality';
import { mergeByMaterial, mesh, textPlane, toon, toonUnique } from './toon';

const G = STREET_Y;
/** The building's footprint, walls included. */
const B = { minX: FLOOR.minX - WALL_T, maxX: FLOOR.maxX + WALL_T, minZ: FLOOR.minZ - WALL_T, maxZ: FLOOR.maxZ + WALL_T } as const;
/** Parking bays are this wide; the rows of them start at x = -16. */
const BAY = 3.2;

/** A light that throws a pool of light around it at night (see sky.ts): where, how far, and its color. */
export interface Lamp {
  x: number;
  y: number;
  z: number;
  reach: number;
  color: string;
  /** How bright, at the middle of the pool. */
  power: number;
  /** Down by the street (a street lamp, the one over the exit): it's further down the higher your floor is. */
  ground?: boolean;
}

/** Everything that changes between day and night and with the weather, for the sky to drive. */
export interface NightParts {
  /** Bulbs whose glow goes from `day` (emissive intensity by day) up to full at night. */
  bulbs: { mat: THREE.MeshToonMaterial; day: number }[];
  /** Where each bulb's soft halo goes at night, and its color; `ground` as for a Lamp. */
  halos: { at: THREE.Vector3; size: number; color: string; ground?: boolean }[];
  lamps: Lamp[];
  /** How far below the floor you're on the street is (see streetBelow): what the `ground` lamps drop with. */
  street: number;
  /** The neighbours' walls, whose windows light up at night. */
  windows: THREE.MeshToonMaterial[];
  clouds: THREE.MeshToonMaterial;
  /** Rain running down the office windows. */
  wetGlass: THREE.MeshBasicMaterial;
}

/** A bulb that glows `day` much by day and fully at night. */
export function bulb(night: NightParts, color: string, day = 0): THREE.MeshToonMaterial {
  const mat = toonUnique(color);
  mat.emissive.set(color);
  mat.emissiveIntensity = day;
  night.bulbs.push({ mat, day });
  return mat;
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, scale = TILE_SCALE): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  const k = fitScale(w, h, scale);
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  const g = c.getContext('2d')!;
  g.scale(c.width / w, c.height / h);
  draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISOTROPY;
  return t;
}

/** A flat, textured toon plane lying on the ground. */
function groundPlane(w: number, d: number, x: number, y: number, z: number, map: THREE.Texture | null, color = '#ffffff'): THREE.Mesh {
  const mat = new THREE.MeshToonMaterial({ color, map, gradientMap: (toon('#fff') as THREE.MeshToonMaterial).gradientMap });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, y, z);
  m.receiveShadow = true;
  return m;
}

/** Polished concrete with painted bays along the back wall and along the front. */
function garageFloorTexture(): THREE.CanvasTexture {
  const w = B.maxX - B.minX;
  const d = B.maxZ - B.minZ;
  const px = 32; // pixels per meter
  return canvasTexture(Math.round(w * px), Math.round(d * px), (g) => {
    g.fillStyle = '#2c2c2c';
    g.fillRect(0, 0, w * px, d * px);
    // A few darker blotches, so it isn't a flat slab.
    for (let i = 0; i < 70; i++) {
      g.fillStyle = `rgba(0, 0, 0, ${0.04 + Math.random() * 0.06})`;
      g.beginPath();
      g.ellipse(Math.random() * w * px, Math.random() * d * px, 10 + Math.random() * 30, 6 + Math.random() * 20, Math.random() * 3, 0, Math.PI * 2);
      g.fill();
    }
    const X = (x: number) => (x - B.minX) * px;
    const Z = (z: number) => (z - B.minZ) * px;
    g.fillStyle = '#9a9a9a';
    for (const [z0, z1] of [
      [B.minZ + 0.3, B.minZ + 5.8],
      [B.maxZ - 5.8, B.maxZ - 0.3],
    ]) {
      for (let x = -16; x <= 16.01; x += BAY) g.fillRect(X(x) - 2, Z(z0), 4, (z1 - z0) * px);
    }
    // Arrows down the aisle, pointing out to the street.
    g.fillStyle = '#ee6018';
    for (const x of [-8, 8]) {
      const cx = X(x);
      const cz = Z(0);
      g.fillRect(cx - 5, cz - 60, 10, 90);
      g.beginPath();
      g.moveTo(cx - 22, cz + 30);
      g.lineTo(cx + 22, cz + 30);
      g.lineTo(cx, cz + 62);
      g.closePath();
      g.fill();
    }
  });
}

/**
 * Downstairs: the open garage under the office's floor slab (see world/stack.ts): concrete
 * walls at the back and on the west side, columns along the open front and east side, strip
 * lights, and a row of Lambos and a row of Ferraris.
 */
export function buildGarage(group: THREE.Group, colliders: Collider[]) {
  const w = B.maxX - B.minX;
  const d = B.maxZ - B.minZ;
  const cx = (B.minX + B.maxX) / 2;
  const cz = (B.minZ + B.maxZ) / 2;
  const ceiling = -SLAB;
  const concrete = toon('#3a3a3a');
  // The slab over it, which is the office's floor, is world/stack.ts's: holes go through it to the floor below.

  group.add(groundPlane(w, d, cx, G + 0.004, cz, garageFloorTexture()));

  // The back and west walls, with an orange line along them, and the columns and lights: all merged at the end.
  const parts = new THREE.Group();
  const wallH = ceiling - G;
  const yellow = toon('#ee6018');
  const plinth = toon('#141414');
  const walls: [number, number, number, number][] = [
    [B.minX, B.maxX, B.minZ, B.minZ + WALL_T],
    [B.minX, B.minX + WALL_T, B.minZ, B.maxZ],
  ];
  for (const [x0, x1, z0, z1] of walls) {
    parts.add(mesh(box(x1 - x0, wallH, z1 - z0), concrete, (x0 + x1) / 2, G + wallH / 2, (z0 + z1) / 2));
    parts.add(mesh(box(x1 - x0 + 0.02, 0.06, z1 - z0 + 0.02), yellow, (x0 + x1) / 2, G + 1.1, (z0 + z1) / 2, false));
    parts.add(mesh(box(x1 - x0 + 0.02, 0.5, z1 - z0 + 0.02), plinth, (x0 + x1) / 2, G + 0.25, (z0 + z1) / 2, false));
    colliders.push({ minX: x0, maxX: x1, minZ: z0, maxZ: z1, bottom: G, top: ceiling });
  }
  const sign = textPlane('P1  GARAGE', { bg: '#0a0a0a', color: '#eeeeee', size: 64, border: '#2f2f2f' });
  sign.scale.multiplyScalar(1.6);
  sign.position.set(0, G + 2.3, B.minZ + WALL_T + 0.02);
  group.add(sign);

  // Columns holding up the office, along the open sides and down the middle.
  const cols: [number, number][] = [];
  for (const x of [B.maxX - 0.25, -9.6, 0, 9.6]) cols.push([x, B.maxZ - 0.25], [x, 0]);
  cols.push([B.maxX - 0.25, -6.5], [B.maxX - 0.25, 6.5], [B.maxX - 0.25, B.minZ + 0.25]);
  const colMat = toon('#2a2a2a');
  for (const [x, z] of cols) {
    parts.add(mesh(box(0.5, wallH, 0.5), colMat, x, G + wallH / 2, z));
    parts.add(mesh(box(0.52, 0.5, 0.52), plinth, x, G + 0.25, z, false));
    parts.add(mesh(box(0.53, 0.05, 0.53), yellow, x, G + 0.52, z, false));
    colliders.push({ minX: x - 0.25, maxX: x + 0.25, minZ: z - 0.25, maxZ: z + 0.25, bottom: G, top: ceiling });
  }

  // Strip lights on the ceiling.
  const light = toon('#ffffff', { emissive: '#f4ecdc' });
  for (const x of [-13, -4.8, 4.8, 13]) for (const z of [-4.5, 4.5]) parts.add(mesh(box(2.6, 0.07, 0.22), light, x, ceiling - 0.04, z, false));
  group.add(mergeByMaterial(parts));

  // The cars: Lambos nose-in along the back wall, Ferraris backed in facing the street.
  const cars: [CarKind, string, number, number][] = [
    ['lambo', '#e6e6e6', -14.4, -1],
    ['lambo', '#161616', -8, -1],
    ['lambo', '#8c8c8c', 1.6, -1],
    ['lambo', '#2a2a2a', 11.2, -1],
    ['ferrari', '#0c0c0c', -14.4, 1],
    ['ferrari', '#3a3a3a', -4.8, 1],
    ['ferrari', '#d8d8d8', 4.8, 1],
    ['ferrari', '#1c1c1c', 14.4, 1],
  ];
  const lot = new THREE.Group();
  for (const [kind, color, x, face] of cars) {
    const z = face < 0 ? B.minZ + WALL_T + 0.4 + CAR.length / 2 : B.maxZ - 0.5 - CAR.length / 2;
    park(lot, colliders, kind, color, x, z, face < 0 ? Math.PI : 0);
  }
  // One left out front, for everyone upstairs to look at.
  park(lot, colliders, 'lambo', '#ee6018', 9, 18.2, Math.PI / 2);
  group.add(mergeByMaterial(lot));
}

/** Parks a car at (x, z) turned by `rotY` (a multiple of 90°), with colliders you can hop up on. */
function park(group: THREE.Group, colliders: Collider[], kind: CarKind, color: string, x: number, z: number, rotY: number) {
  const car = supercar(kind, color);
  car.position.set(x, G, z);
  car.rotation.y = rotY;
  group.add(car);
  // A rectangle in the car's own frame (x across, z nose-ward), in the world.
  const c = Math.round(Math.cos(rotY));
  const sn = Math.round(Math.sin(rotY));
  const rect = (x0: number, x1: number, z0: number, z1: number, top: number) => {
    const xs = [x0 * c + z0 * sn, x1 * c + z1 * sn];
    const zs = [-x0 * sn + z0 * c, -x1 * sn + z1 * c];
    colliders.push({ minX: x + Math.min(...xs), maxX: x + Math.max(...xs), minZ: z + Math.min(...zs), maxZ: z + Math.max(...zs), bottom: G, top: G + top });
  };
  rect(-CAR.width / 2 + 0.08, CAR.width / 2 - 0.08, -CAR.length / 2 + 0.08, CAR.length / 2 - 0.08, CAR.body);
  rect(-0.6, 0.6, -1.3, 0.1, CAR.roof);
}

export function tree(scale: number): THREE.Group {
  const t = new THREE.Group();
  t.add(mesh(new THREE.CylinderGeometry(0.22, 0.3, 2.2, 8), toon('#3b3029'), 0, 1.1, 0));
  t.add(mesh(new THREE.SphereGeometry(1.6, 12, 10), toon('#3d6b45'), 0, 3.2, 0));
  t.add(mesh(new THREE.SphereGeometry(1.1, 12, 10), toon('#2d5537'), 0.8, 3.9, 0.4));
  t.add(mesh(new THREE.SphereGeometry(1.0, 12, 10), toon('#4a7a50'), -0.7, 3.8, -0.3));
  t.scale.setScalar(scale);
  return t;
}

/** A building across the street or out back: a painted block with rows of windows and a roof cap. */
function building(w: number, h: number, d: number, color: string, lit: THREE.MeshToonMaterial[]): THREE.Group {
  const g = new THREE.Group();
  // Where the windows go across a floor (in 256ths): each column's middle half, 70 to 190 up.
  const face = (n: number) =>
    canvasTexture(256, 256, (c) => {
      c.fillStyle = color;
      c.fillRect(0, 0, 256, 256);
      // A slab line across each floor, then the windows, dark glass in a black frame.
      c.fillStyle = 'rgba(255,255,255,0.05)';
      c.fillRect(0, 250, 256, 6);
      c.fillStyle = '#0a0a0a';
      for (let i = 0; i < n; i++) c.fillRect(((i + 0.25) / n) * 256 - 4, 66, (0.5 / n) * 256 + 8, 128);
      c.fillStyle = '#1d2126';
      for (let i = 0; i < n; i++) c.fillRect(((i + 0.25) / n) * 256, 70, (0.5 / n) * 256, 120);
      c.fillStyle = 'rgba(255,255,255,0.08)';
      for (let i = 0; i < n; i++) c.fillRect(((i + 0.25) / n) * 256, 70, (0.12 / n) * 256, 120);
    });
  // At night about half of them are lit: lamps, a ceiling light, the odd TV.
  const lights = (n: number, floors: number) =>
    canvasTexture(64, 64 * floors, (c) => {
      c.fillStyle = '#000000';
      c.fillRect(0, 0, 64, 64 * floors);
      for (let f = 0; f < floors; f++) {
        for (let i = 0; i < n; i++) {
          if (Math.random() < 0.45) continue;
          c.fillStyle = Math.random() < 0.4 ? '#e9d3ac' : Math.random() < 0.5 ? '#f1e6d2' : '#d8c4a0';
          c.fillRect(((i + 0.25) / n) * 64, f * 64 + (70 / 256) * 64, (0.5 / n) * 64, (120 / 256) * 64);
        }
      }
    });
  const floors = Math.max(1, Math.round(h / 3.2));
  const walls = (span: number) => {
    const n = Math.max(1, Math.round(span / 2.6));
    const t = face(n);
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1, floors);
    const m = new THREE.MeshToonMaterial({ map: t, emissive: '#ffffff', emissiveMap: lights(n, floors), emissiveIntensity: 0, gradientMap: (toon('#fff') as THREE.MeshToonMaterial).gradientMap });
    lit.push(m);
    return m;
  };
  const sides = walls(d);
  const fronts = walls(w);
  const mats = [sides, sides, toon(color), toon(color), fronts, fronts];
  g.add(new THREE.Mesh(box(w, h, d), mats));
  (g.children[0] as THREE.Mesh).position.y = h / 2;
  (g.children[0] as THREE.Mesh).castShadow = true;
  g.add(mesh(box(w + 0.4, 0.4, d + 0.4), toon('#121212'), 0, h + 0.2, 0));
  return g;
}

/** What a billboard says: an eyebrow with its index in orange, then a headline, or a command line in mono. */
export interface BillboardCopy {
  index: string;
  eyebrow: string;
  lines: string[];
  mono?: boolean;
}

/**
 * Paints `draw` on a canvas `w` by `h` (in its own units) and paints it again once the office's
 * fonts have loaded, since a sign painted before then would keep the fallback face.
 */
function signTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, scale = 2): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  const k = fitScale(w, h, scale);
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  const g = c.getContext('2d')!;
  const paint = () => {
    g.setTransform(c.width / w, 0, 0, c.height / h, 0, 0);
    draw(g);
  };
  paint();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISOTROPY;
  document.fonts?.ready?.then(() => {
    paint();
    t.needsUpdate = true;
  });
  return t;
}

/** Sets letter tracking where the canvas has it (it's ignored elsewhere). */
function track(g: CanvasRenderingContext2D, px: number) {
  (g as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${px}px`;
}

/** A flat color that shows the same by day and by night, for the pinwheel on a lit sign. */
function flatColor(color: string): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color });
  m.userData.outlineParameters = { visible: false };
  return m;
}

/**
 * A rooftop billboard `w` by `h` meters in Factory's colors: near-black board, light type, the
 * index and the pinwheel in orange, standing on steel legs, its foot at y = 0 and its face toward +z.
 * Lit from within, so it reads at night.
 */
export function billboard(copy: BillboardCopy, w: number, h: number, wall = false): THREE.Group {
  const g = new THREE.Group();
  const W = 1024;
  const H = Math.round((W * h) / w);
  const tex = signTexture(W, H, (c) => {
    c.fillStyle = '#020202';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = '#2e2e2e';
    c.lineWidth = 2;
    c.strokeRect(14, 14, W - 28, H - 28);
    c.textBaseline = 'alphabetic';
    c.textAlign = 'left';
    const pad = 48;
    const room = W - pad * 2 - H * 0.5;
    c.font = `500 26px ${MONO}`;
    track(c, 4);
    c.fillStyle = '#ee6018';
    c.fillText(copy.index, pad, pad + 26);
    const iw = c.measureText(`${copy.index}  `).width;
    c.fillStyle = '#8c8c8c';
    c.fillText(copy.eyebrow.toUpperCase(), pad + iw, pad + 26);
    c.fillStyle = '#2e2e2e';
    c.fillRect(pad, pad + 46, room, 2);
    const size = copy.mono ? 40 : 66;
    const font = (px: number) => (copy.mono ? `500 ${px}px ${MONO}` : `600 ${px}px ${SANS}`);
    track(c, copy.mono ? 0 : -1);
    c.font = font(size);
    const widest = Math.max(...copy.lines.map((l) => c.measureText(l).width));
    const px = widest > room ? Math.floor((size * room) / widest) : size;
    c.font = font(px);
    const lead = px * 1.08;
    const top = H - pad - lead * (copy.lines.length - 1) - 6;
    copy.lines.forEach((line, i) => {
      const y = top + i * lead;
      if (copy.mono && line.startsWith('>')) {
        c.fillStyle = '#ee6018';
        c.fillText('>', pad, y);
        c.fillStyle = '#eeeeee';
        c.fillText(line.slice(1), pad + c.measureText('>').width, y);
        const end = pad + c.measureText(line).width + 10;
        c.fillRect(end, y - px * 0.78, px * 0.55, px * 0.92);
      } else {
        c.fillStyle = '#eeeeee';
        c.fillText(line, pad, y);
      }
    });
  });
  const face = new THREE.MeshBasicMaterial({ map: tex });
  face.userData.outlineParameters = { visible: false };
  const steel = toon('#2a2a2a');
  const frame = toon('#0a0a0a');
  // On a roof it stands on legs; on a wall it hangs straight on it, its foot at y = 0.
  const legH = wall ? 0 : 1.4;
  // Everything but the face merged (merging drops the face's texture coordinates).
  const rig = new THREE.Group();
  rig.add(mesh(box(w + 0.3, h + 0.3, 0.3), frame, 0, legH + h / 2, -0.16, false));
  rig.add(mesh(glyphFlat(h * 0.46, 5), flatColor('#ee6018'), w / 2 - h * 0.36, legH + h * 0.6, 0.012, false));
  if (!wall) {
    for (const sx of [-0.36, 0.36]) {
      rig.add(mesh(box(0.16, legH + h * 0.6, 0.16), steel, sx * w, (legH + h * 0.6) / 2, -0.4));
      rig.add(mesh(box(0.1, 0.1, 1.2), steel, sx * w, legH * 0.55, -0.4, false));
    }
    // A catwalk along the foot, as billboards have.
    rig.add(mesh(box(w, 0.06, 0.7), steel, 0, legH - 0.1, 0.25, false));
  }
  // The lamps over the top, on arms.
  for (let i = 0; i < 4; i++) {
    const x = -w * 0.375 + (i * w * 0.75) / 3;
    rig.add(mesh(box(0.05, 0.05, 0.6), steel, x, legH + h + 0.2, 0.15, false));
    rig.add(mesh(box(0.3, 0.1, 0.22), frame, x, legH + h + 0.2, 0.5, false));
  }
  g.add(mergeByMaterial(rig), mesh(new THREE.PlaneGeometry(w, h), face, 0, legH + h / 2, 0.001, false));
  return g;
}

/** The billboards on the roofs across the street, facing the office: which neighbour (in NEIGHBOURS) each stands on, and what it says. */
const BILLBOARDS: [number, BillboardCopy][] = [
  [2, { index: '01', eyebrow: 'Factory.ai', lines: ['MAKE YOUR SOFTWARE', 'IMPROVE ITSELF'] }],
  [1, { index: '02', eyebrow: 'Install Droid', lines: ['> curl -fsSL https://app.factory.ai/cli | sh'], mono: true }],
];

/** A street lamp on the sidewalk at (x, z), its arm reaching out over the road toward `toward` (±1 in z). */
export function streetLamp(parts: THREE.Group, night: NightParts, glass: THREE.MeshToonMaterial, colliders: Collider[], x: number, z: number, toward: number) {
  const ink = toon('#1c1c1c');
  const H = 5;
  parts.add(mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.5, 10), ink, x, G + 0.25, z));
  parts.add(mesh(new THREE.CylinderGeometry(0.07, 0.09, H, 8), ink, x, G + H / 2, z));
  parts.add(mesh(box(0.08, 0.08, 1.3), ink, x, G + H - 0.05, z + toward * 0.6));
  const hz = z + toward * 1.2;
  parts.add(mesh(new THREE.CylinderGeometry(0.12, 0.42, 0.26, 12), ink, x, G + H - 0.1, hz));
  parts.add(mesh(new THREE.SphereGeometry(0.22, 12, 8), glass, x, G + H - 0.3, hz, false));
  colliders.push({ minX: x - 0.2, maxX: x + 0.2, minZ: z - 0.2, maxZ: z + 0.2, bottom: G, top: G + H });
  night.halos.push({ at: new THREE.Vector3(x, G + H - 0.34, hz), size: 2.4, color: '#ffd89a', ground: true });
  night.lamps.push({ x, y: G + H - 0.6, z: hz, reach: 10, color: '#ffcf8a', power: 4, ground: true });
}

/**
 * How far the grass and the road go, end to end: from the top floor the haze is up to HAZE_MAX off
 * (see world/sky.ts), and their ends must be further than that even at the edge of the view.
 */
const REACH = 1200;

/**
 * The neighbours' buildings: [x, z, width, height, depth, paint], across the street and further out
 * behind and beside the office.
 */
const NEIGHBOURS: [number, number, number, number, number, string][] = [
  [-38, 45, 12, 10, 9, '#2a2a2a'],
  [-22, 46, 14, 16, 10, '#1c1c1c'],
  [12, 47, 16, 19, 12, '#242424'],
  [30, 45, 12, 9, 9, '#3a3a3a'],
  [-20, -42, 18, 14, 10, '#202020'],
  [8, -44, 16, 20, 12, '#2e2e2e'],
  [-48, -6, 10, 12, 16, '#1a1a1a'],
  [50, 4, 10, 15, 18, '#333333'],
];

/** Which way a neighbour at (x, z) is turned: its front to the office. */
const facing = (x: number, z: number) => (Math.abs(x) > 40 ? (x > 0 ? -Math.PI / 2 : Math.PI / 2) : z > 0 ? Math.PI : 0);

/** The neighbours' footprints, and how tall each stands (roof cap included) above the street. */
export function neighbourBoxes(): { minX: number; maxX: number; minZ: number; maxZ: number; top: number }[] {
  return NEIGHBOURS.map(([x, z, w, h, d]) => {
    // Turned a quarter, its width runs along z.
    const [hx, hz] = Math.abs(Math.sin(facing(x, z))) > 0.5 ? [d / 2, w / 2] : [w / 2, d / 2];
    return { minX: x - hx - 0.2, maxX: x + hx + 0.2, minZ: z - hz - 0.2, maxZ: z + hz + 0.2, top: h + 0.4 };
  });
}

/**
 * Everything outside, down on the street: grass, the lot in front of the garage, a road with
 * sidewalks and street lamps, trees and neighbours' buildings, and in `sky` some clouds.
 */
export function buildStreet(group: THREE.Group, colliders: Collider[], night: NightParts, sky: THREE.Group) {
  const lawn = new THREE.Mesh(new THREE.PlaneGeometry(REACH, REACH), toon('#58744f'));
  lawn.rotation.x = -Math.PI / 2;
  lawn.position.y = G - 0.03;
  lawn.receiveShadow = true;
  group.add(lawn);
  // What you stand on anywhere out there, the lot and the road and the grass alike.
  colliders.push({ minX: -200, maxX: 200, minZ: -200, maxZ: 200, bottom: G - 1, top: G });

  // The lot in front of the garage, out to the sidewalk.
  const lot = groundPlane(60, 21 - B.maxZ, 0, G - 0.01, (B.maxZ + 21) / 2, null, '#3c3c3c');
  group.add(lot);
  const sideways = groundPlane(12, B.maxZ - B.minZ + 6, B.maxX + 6, G - 0.012, (B.minZ + B.maxZ) / 2 + 1, null, '#3c3c3c');
  group.add(sideways);

  // The road: asphalt, white edge lines and a dashed yellow middle.
  const road = canvasTexture(256, 128, (g) => {
    g.fillStyle = '#2c2c2c';
    g.fillRect(0, 0, 256, 128);
    g.fillStyle = '#cfcfcf';
    g.fillRect(0, 6, 256, 4);
    g.fillRect(0, 118, 256, 4);
    g.fillStyle = '#c9a23e';
    g.fillRect(0, 61, 150, 6);
  });
  road.wrapS = THREE.RepeatWrapping;
  road.repeat.set(REACH / 8, 1);
  group.add(groundPlane(REACH, ROAD.maxZ - ROAD.minZ, 0, G - 0.008, (ROAD.minZ + ROAD.maxZ) / 2, road));
  for (const [z0, z1] of [
    [21, ROAD.minZ],
    [ROAD.maxZ, ROAD.maxZ + 2],
  ]) {
    group.add(mesh(box(REACH, 0.08, z1 - z0), toon('#6e6e6e'), 0, G, (z0 + z1) / 2));
  }
  const forest = new THREE.Group();

  // Trees along the sidewalks and around the building.
  const trees: [number, number, number][] = [
    [-34, 22, 1.1],
    [-22, 22, 1],
    [22, 22, 1.05],
    [34, 22, 0.95],
    [-40, 32.5, 1.1],
    [-12, 32.5, 1],
    [14, 32.5, 1.15],
    [42, 32.5, 1],
    [-27, -8, 1.2],
    [-29, 4, 1],
    [-26, 14, 0.9],
    [29, -6, 1.1],
    [30, 6, 1.25],
    [-12, -22, 1.2],
    [4, -24, 1],
    [18, -21, 1.1],
  ];
  for (const [x, z, s] of trees) {
    const t = tree(s);
    t.position.set(x, G, z);
    forest.add(t);
  }
  group.add(mergeByMaterial(forest));

  // Street lamps down both sidewalks, their arms out over the road.
  const lamps = new THREE.Group();
  const glass = bulb(night, '#fff3d6');
  for (const x of [-40, -28, -16, -4, 8, 16, 28, 40]) streetLamp(lamps, night, glass, colliders, x, 22.2, 1);
  for (const x of [-34, -22, -4, 8, 26, 36]) streetLamp(lamps, night, glass, colliders, x, 31.8, -1);
  group.add(mergeByMaterial(lamps));

  // The neighbours: across the street, and further out behind and beside the office.
  for (const [x, z, w, h, d, color] of NEIGHBOURS) {
    const b = building(w, h, d, color, night.windows);
    b.position.set(x, G, z);
    b.rotation.y = facing(x, z);
    group.add(b);
  }
  const boards = new THREE.Group();
  for (const [i, copy] of BILLBOARDS) {
    // Hung on the front wall, high enough to clear the street lamps, low enough to read from every floor.
    const [x, z, w, h, d] = NEIGHBOURS[i];
    const bw = w - 2.4;
    const bb = billboard(copy, bw, bw * 0.3, true);
    const turn = facing(x, z);
    bb.position.set(x + Math.sin(turn) * (d / 2 + 0.32), G + Math.min(h - bw * 0.3 - 1.2, 7.5), z + Math.cos(turn) * (d / 2 + 0.32));
    bb.rotation.y = turn;
    boards.add(bb);
  }
  group.add(boards);

  // Puffy clouds, too far off for the fog to hide.
  const cloud = night.clouds;
  cloud.fog = false;
  const puffs = new THREE.Group();
  for (const [x, y, z, s] of [
    [-70, 34, -60, 1.3],
    [-10, 40, -90, 1.6],
    [60, 36, -70, 1.2],
    [90, 30, 20, 1.4],
    [-95, 32, 30, 1.1],
    [30, 38, 95, 1.5],
    [-45, 36, 90, 1.2],
  ]) {
    const c = new THREE.Group();
    for (const [dx, dy, r] of [
      [0, 0, 5],
      [5.5, -1, 3.8],
      [-5.5, -1.2, 3.6],
      [2.5, 2.4, 3.4],
    ]) {
      const puff = mesh(new THREE.SphereGeometry(r, 14, 10), cloud, dx, dy, 0, false);
      puff.scale.y = 0.75;
      c.add(puff);
    }
    c.position.set(x, y, z);
    c.scale.setScalar(s);
    c.lookAt(0, y, 0);
    puffs.add(c);
  }
  sky.add(mergeByMaterial(puffs));
}
