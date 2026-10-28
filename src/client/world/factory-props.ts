import * as THREE from 'three';
import { SCREEN_BLACK, screenMaterial } from './screen';
import { DROID_RACK } from '../../shared/layout';
import { MONO } from '../fonts';
import type { Dressing, DressingKit } from './factory-floor';
import { prop, propReady } from './props';
import { ANISOTROPY } from './texture-quality';
import { mergeByMaterial, mesh, roundedBox, toon } from './toon';

// The hero props come from tools/props/generate.py. main.ts preloads every GLB in the manifest;
// each piece here drops in the first frame its GLB is cached, so building the office (and the
// Node tests, which never load one) touches no fetch, DOM or WebGL.

/** What one of the rack's cubes shows for a real Droid Computer: its readout lines and how its LED goes. */
export interface RackCube {
  cpu?: number;
  mem?: string;
  dsk?: string;
  /** on: active; busy: provisioning or waking (it blinks); dim: asleep; error: red; off: no computer for this cube. */
  led: 'on' | 'busy' | 'dim' | 'error' | 'off';
}

/** The cubes as the Droid Computers are, or null to show the rack's idle demo (Factory isn't connected). */
let rackFeed: RackCube[] | null = null;
let rackFed = 0;
/** Hands the rack its cubes: the first three managed Droid Computers. */
export function setRackCubes(cubes: RackCube[] | null) {
  if (JSON.stringify(cubes) === JSON.stringify(rackFeed)) return;
  rackFeed = cubes;
  rackFed++;
}

const ORANGE = '#ee6018';
const GREEN = '#3ccf91';
const RED = '#ef4444';

const flat = <M extends THREE.Material>(m: M): M => {
  m.userData.outlineParameters = { visible: false };
  return m;
};

function canvas(w: number, h: number): { tex: THREE.CanvasTexture; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = ANISOTROPY;
  return { tex, ctx };
}

/** Letter-spaced text, the way Factory sets its mono labels. */
function tracked(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, spacing: number, align: 'left' | 'right' | 'center' = 'left') {
  const widths = [...text].map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * Math.max(0, text.length - 1);
  let at = align === 'left' ? x : align === 'right' ? x - total : x - total / 2;
  ctx.textAlign = 'left';
  [...text].forEach((ch, i) => {
    ctx.fillText(ch, at, y);
    at += widths[i] + spacing;
  });
  return total;
}

/** A transparent label plane facing +z, painted once. */
function labelPlane(w: number, h: number, px: number, paint: (ctx: CanvasRenderingContext2D, cw: number, ch: number) => void): THREE.Mesh {
  const ch = Math.round(px);
  const cw = Math.round((px * w) / h);
  const { tex, ctx } = canvas(cw, ch);
  paint(ctx, cw, ch);
  tex.needsUpdate = true;
  const mat = flat(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
}

const gradient = () => (toon('#ffffff') as THREE.MeshToonMaterial).gradientMap;

/**
 * The office is toon-shaded: a GLB's palette atlas becomes the map of a toon material, one per source
 * material. Its emission atlas comes along, so the signal orange still reads in the dim room.
 */
const toonOf = new Map<string, THREE.MeshToonMaterial>();
/** Turns a GLB clone's standard materials into the toon ones `placeFactoryProps` will reuse, keyed by the source material. */
export function toonifyProp(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.material || Array.isArray(m.material)) return;
    const src = m.material as THREE.MeshStandardMaterial;
    let out = toonOf.get(src.uuid);
    if (!out) {
      out = new THREE.MeshToonMaterial({
        color: src.map ? '#ffffff' : src.color,
        map: src.map ?? null,
        emissive: src.emissiveMap ? '#ffffff' : '#000000',
        emissiveMap: src.emissiveMap ?? null,
        gradientMap: gradient(),
      });
      toonOf.set(src.uuid, out);
    }
    m.material = out;
  });
}

/** Fine horizontal streaks for the Droid Computer's brushed aluminium. */
let brushed: THREE.MeshToonMaterial | null = null;
function brushedShell(): THREE.MeshToonMaterial {
  if (brushed) return brushed;
  const { tex, ctx } = canvas(256, 256);
  ctx.fillStyle = '#d4d4d4';
  ctx.fillRect(0, 0, 256, 256);
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 900; i++) {
    const v = Math.round(180 + rand() * 75);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(rand() * 256 - 40, Math.floor(rand() * 256), 30 + rand() * 160, 1);
  }
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  brushed = new THREE.MeshToonMaterial({ color: '#5c5e63', map: tex, gradientMap: gradient() });
  return brushed;
}

/** The warm wash each cube throws on the backboard behind it: brightest just under the cube's centre (`centre`, over the floor). */
/** How high the backboard behind the cubes stands. */
const BOARD_TOP = 0.86;
const GLOW = { width: 1, centre: 0.36, radius: 0.48 } as const;
let glowMat: THREE.MeshBasicMaterial | null = null;
function backGlow(): THREE.MeshBasicMaterial {
  if (glowMat) return glowMat;
  const { tex, ctx } = canvas(256, Math.round((256 * BOARD_TOP) / GLOW.width));
  const { width: w, height: h } = ctx.canvas;
  const px = w / GLOW.width;
  const g = ctx.createRadialGradient(w / 2, h - GLOW.centre * px, 0, w / 2, h - GLOW.centre * px, GLOW.radius * px);
  g.addColorStop(0, 'rgba(238, 96, 24, 0.85)');
  g.addColorStop(0.35, 'rgba(177, 74, 18, 0.5)');
  g.addColorStop(0.7, 'rgba(92, 36, 10, 0.18)');
  g.addColorStop(1, 'rgba(42, 18, 6, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  tex.needsUpdate = true;
  glowMat = flat(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
  return glowMat;
}

interface Waiting {
  name: string;
  install: (model: THREE.Object3D) => void;
}

/** The Factory hero props (GLBs from tools/props/generate.py), placed around the office. */
export function placeFactoryProps(kit: DressingKit): Dressing {
  const waiting: Waiting[] = [];
  const updates: ((t: number, dt: number) => void)[] = [];
  const rack = buildRack(kit, waiting, updates);
  kit.group.add(rack);
  return {
    update(t, dt) {
      for (let i = waiting.length - 1; i >= 0; i--) {
        const w = waiting[i];
        if (!propReady(w.name)) continue;
        waiting.splice(i, 1);
        const model = prop(w.name);
        if (!model) continue;
        toonifyProp(model);
        w.install(model);
      }
      for (const u of updates) u(t, dt);
    },
  };
}

// ---- The Droid Computer rack ---------------------------------------------------------------------

/** Where each cube stands along the plinth, and what its readout says. */
const COMPUTERS = [
  { dz: -0.78, cpu: 2.7, mem: '333.4MB/8GB', dsk: '3.2MB/60GB', blink: false },
  { dz: 0, cpu: 41.3, mem: '5.1GB/8GB', dsk: '18.4GB/60GB', blink: true },
  { dz: 0.78, cpu: 7.9, mem: '1.2GB/8GB', dsk: '9.6GB/60GB', blink: false },
];
const PLINTH_H = 0.14;
/** The LED and readout on a cube's front, in its GLB's space (see build_droid_computer). */
const LED = { x: 0.145, y: 0.387, z: 0.229, r: 0.011 };
const READOUT = { x: 0.085, y: 0.092, z: 0.2272, w: 0.15, h: 0.058 };

function buildRack(kit: DressingKit, waiting: Waiting[], updates: ((t: number, dt: number) => void)[]): THREE.Group {
  const { minX, maxX, minZ, maxZ } = DROID_RACK;
  const cz = (minZ + maxZ) / 2;
  const length = maxZ - minZ;
  const depth = maxX - minX;
  const root = new THREE.Group();

  const stat = new THREE.Group();
  stat.add(mesh(roundedBox(depth, PLINTH_H - 0.01, length, 0.02), toon('#141414'), minX + depth / 2, (PLINTH_H - 0.01) / 2, cz));
  stat.add(mesh(roundedBox(depth + 0.01, 0.012, length + 0.01, 0.02), toon('#2a2a2a'), minX + depth / 2, PLINTH_H - 0.006, cz));
  // A shadow gap along the foot of the plinth, so it reads as standing off the floor.
  stat.add(mesh(new THREE.BoxGeometry(0.02, 0.025, length - 0.04), toon('#020202'), maxX - 0.006, 0.0125, cz));
  // The backboard the cubes' glow washes onto, against the wall.
  stat.add(mesh(new THREE.BoxGeometry(0.02, BOARD_TOP, length), toon('#0e0e0e'), minX + 0.01, BOARD_TOP / 2, cz));
  stat.add(mesh(new THREE.BoxGeometry(0.024, 0.012, length + 0.004), toon('#2a2a2a'), minX + 0.012, BOARD_TOP, cz));
  const frame = mergeByMaterial(stat);
  frame.name = 'droid-rack-frame';
  root.add(frame);

  kit.colliders.push({ ...DROID_RACK });
  kit.fixture('west', cz, BOARD_TOP / 2, length + 0.1, BOARD_TOP + 0.05);

  const cubeX = minX + 0.38;
  const leds: { mat: THREE.MeshBasicMaterial; blink: boolean; phase: number; shown?: string }[] = [];
  const readouts: { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; data: (typeof COMPUTERS)[number]; cpu: number }[] = [];

  COMPUTERS.forEach((c, i) => {
    waiting.push({
      name: 'droid-computer',
      install(model) {
        model.position.set(cubeX, PLINTH_H, cz + c.dz);
        // Its front (+z in the GLB) faces into the room.
        model.rotation.y = Math.PI / 2;
        const wash = new THREE.Mesh(new THREE.PlaneGeometry(GLOW.width, BOARD_TOP), backGlow());
        wash.rotation.y = Math.PI / 2;
        wash.position.set(minX + 0.021, BOARD_TOP / 2, cz + c.dz);
        wash.renderOrder = 1;
        root.add(wash);
        const shell = model.getObjectByName('Shell') as THREE.Mesh | undefined;
        if (shell?.isMesh) shell.material = brushedShell();
        const ledMat = flat(new THREE.MeshBasicMaterial({ color: GREEN, toneMapped: false }));
        const led = new THREE.Mesh(new THREE.CircleGeometry(LED.r, 16), ledMat);
        led.position.set(LED.x, LED.y, LED.z + 0.0005);
        model.add(led);
        leds.push({ mat: ledMat, blink: c.blink, phase: i * 1.7 });

        const { tex, ctx } = canvas(384, 148);
        const screen = new THREE.Mesh(new THREE.PlaneGeometry(READOUT.w, READOUT.h), flat(screenMaterial({ map: tex })));
        screen.position.set(READOUT.x, READOUT.y, READOUT.z + 0.0004);
        model.add(screen);
        const r = { ctx, tex, data: c, cpu: c.cpu };
        paintReadout(r.ctx, r.cpu, c.mem, c.dsk);
        tex.needsUpdate = true;
        readouts.push(r);
        root.add(model);

        if (i === 0) root.add(rackLabel(maxX, cz));
      },
    });
  });

  let nextPaint = 0;
  let painted = -1;
  updates.push((t) => {
    for (let i = 0; i < leds.length; i++) {
      const l = leds[i];
      const live = rackFeed?.[i];
      const led = live?.led ?? (rackFeed ? 'off' : l.blink ? 'busy' : 'on');
      // An idle machine holds steady green; a busy one flickers twice, quickly, every few seconds.
      const k = led === 'busy' ? (t + l.phase) % 2.6 : 1;
      const flick = (k > 0.1 && k < 0.18) || (k > 0.3 && k < 0.38);
      const color = led === 'error' ? RED : led === 'dim' ? '#0f3a28' : led === 'off' ? '#111111' : led === 'busy' && live ? (flick ? '#3a1608' : ORANGE) : flick ? '#0f3a28' : GREEN;
      if (l.shown !== color) {
        l.shown = color;
        l.mat.color.set(color);
      }
    }
    if (!readouts.length) return;
    if (rackFeed) {
      // Real computers: painted when what they say changes.
      if (painted === rackFed) return;
      painted = rackFed;
      readouts.forEach((r, i) => {
        const c = rackFeed?.[i];
        paintReadout(r.ctx, c?.cpu, c?.mem ?? '—', c?.dsk ?? '—');
        r.tex.needsUpdate = true;
      });
      return;
    }
    if (t < nextPaint && painted === -1) return;
    painted = -1;
    nextPaint = t + 3;
    for (const r of readouts) {
      const swing = r.data.blink ? 9 : 1.2;
      r.cpu = Math.max(0.4, Math.min(99, r.data.cpu + (Math.sin(t * 0.37 + r.data.dz * 5) + Math.sin(t * 0.11)) * swing * 0.5));
      paintReadout(r.ctx, r.cpu, r.data.mem, r.data.dsk);
      r.tex.needsUpdate = true;
    }
  });
  return root;
}

function paintReadout(ctx: CanvasRenderingContext2D, cpu: number | undefined, mem: string, dsk: string) {
  const { width: w, height: h } = ctx.canvas;
  ctx.fillStyle = SCREEN_BLACK;
  ctx.fillRect(0, 0, w, h);
  ctx.font = `500 30px ${MONO}`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e6e6e6';
  const rows: [string, string][] = [
    ['CPU', cpu === undefined ? '—' : `${cpu.toFixed(1)}%`],
    ['MEM', mem],
    ['DSK', dsk],
  ];
  rows.forEach(([k, v], i) => {
    const y = 26 + i * 48;
    tracked(ctx, k, 12, y, 1);
    tracked(ctx, v, w - 12, y, 0.5, 'right');
  });
}

/** The plinth's front edge: each machine's index in orange and its name in grey. */
function rackLabel(frontX: number, cz: number): THREE.Mesh {
  const length = DROID_RACK.maxZ - DROID_RACK.minZ - 0.06;
  const label = labelPlane(length, 0.05, 48, (ctx, w, h) => {
    ctx.font = `500 26px ${MONO}`;
    ctx.textBaseline = 'middle';
    COMPUTERS.forEach((c, i) => {
      const x = ((c.dz + length / 2) / length) * w - 120;
      ctx.fillStyle = ORANGE;
      const n = tracked(ctx, `0${i + 1}`, x, h / 2, 3);
      ctx.fillStyle = '#8c8c8c';
      tracked(ctx, 'DROID COMPUTER', x + n + 14, h / 2, 3);
    });
  });
  label.rotation.y = Math.PI / 2;
  label.position.set(frontX + 0.001, PLINTH_H / 2, cz);
  return label;
}
