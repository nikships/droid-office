import * as THREE from 'three';
import { COMPUTE_WALL, FLOOR } from '../../shared/layout';
import { MONO } from '../fonts';
import type { Dressing, DressingKit } from './factory-floor';
import { glyphFlat } from './glyph3d';
import { prop, propReady } from './props';
import { ANISOTROPY } from './texture-quality';
import { mergeByMaterial, mesh, roundedBox, toon } from './toon';

// The hero props come from tools/props/generate.py. main.ts preloads every GLB in the manifest;
// each piece here drops in the first frame its GLB is cached, so building the office (and the
// Node tests, which never load one) touches no fetch, DOM or WebGL.

/** Where along the west wall the compute wall's Droid Computers screen is centered (its right-hand part, seen from the room). */
const FLEET_Z = COMPUTE_WALL.z - (COMPUTE_WALL.width - (COMPUTE_WALL.width - COMPUTE_WALL.machineWidth - COMPUTE_WALL.gap)) / 2;
/** The Droid Computer rack: a low plinth against the west wall, under the compute wall's Droid Computers screen. */
export const DROID_RACK = { minX: FLOOR.minX, maxX: FLOOR.minX + 0.7, minZ: FLEET_Z - 1.15, maxZ: FLEET_Z + 1.15, top: 0.62 } as const;

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
/** The robot cell: an arm between two conveyors, out on the open floor between the desks and the elevator. */
export const ROBOT_CELL = { x: 5, z: -6, width: 3, depth: 2.5, top: 1.6 } as const;

const ORANGE = '#ee6018';
const GREEN = '#3ccf91';
const RED = '#ef4444';

/** Must match ARM and CONVEYOR in tools/props/generate.py. */
const ARM = { pedestal: 0.44, shoulder: 0.26, upper: 0.62, fore: 0.55, wrist: 0.12, tool: 0.1125 };
const BELT_Y = 0.52;
const CRATE_H = 0.2;
/** The conveyors run along x either side of the arm, this far out from it. */
const LANE = 0.8;
/** How far a conveyor indexes each cycle: the spacing of the crates on it. */
const SLOT = 0.55;
/** One pick-and-place, in seconds. */
const PERIOD = 7;
/** Crates in play at once: three in, one in hand, three out. */
const POOL = 7;
const FIRST_PR = 1287;

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
function toonify(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
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
  const cell = buildCell(kit, waiting, updates);
  kit.group.add(rack, cell);
  return {
    update(t, dt) {
      for (let i = waiting.length - 1; i >= 0; i--) {
        const w = waiting[i];
        if (!propReady(w.name)) continue;
        waiting.splice(i, 1);
        const model = prop(w.name);
        if (!model) continue;
        toonify(model);
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
  stat.add(mesh(new THREE.BoxGeometry(0.02, 0.025, length - 0.04), toon('#020202'), maxX - 0.006, 0.0125, cz, false));
  // The backboard the cubes' glow washes onto, against the wall.
  stat.add(mesh(new THREE.BoxGeometry(0.02, BOARD_TOP, length), toon('#0e0e0e'), minX + 0.01, BOARD_TOP / 2, cz, false));
  stat.add(mesh(new THREE.BoxGeometry(0.024, 0.012, length + 0.004), toon('#2a2a2a'), minX + 0.012, BOARD_TOP, cz, false));
  root.add(mergeByMaterial(stat));

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
        const screen = new THREE.Mesh(new THREE.PlaneGeometry(READOUT.w, READOUT.h), flat(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false })));
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
  ctx.clearRect(0, 0, w, h);
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

// ---- The robot cell ------------------------------------------------------------------------------

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const ease = (v: number) => {
  const s = clamp01(v);
  return s * s * (3 - 2 * s);
};
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const seg = (u: number, a: number, b: number) => ease((u - a) / (b - a));

/** Where the tool's cups are, as the arm's yaw, reach out from its axis and height over the floor. */
interface Reach {
  yaw: number;
  r: number;
  y: number;
}

const PICK_Y = BELT_Y + CRATE_H;
const LIFT_Y = 1.0;
/** When the vacuum holds the crate (it is picked up and set down inside the dwells). */
const HOLD = [0.85, 4.35] as const;

/** One cycle: down onto the crate at the end of the in-feed, up, across to the out-feed, down, back. */
function reachAt(u: number, out: Reach): Reach {
  out.r = LANE;
  if (u < 0.7) Object.assign(out, { yaw: Math.PI, y: lerp(LIFT_Y, PICK_Y, seg(u, 0, 0.7)) });
  else if (u < 1) Object.assign(out, { yaw: Math.PI, y: PICK_Y });
  else if (u < 1.7) Object.assign(out, { yaw: Math.PI, y: lerp(PICK_Y, LIFT_Y, seg(u, 1, 1.7)) });
  else if (u < 3.5) swing(seg(u, 1.7, 3.5), Math.PI, 0, out);
  else if (u < 4.2) Object.assign(out, { yaw: 0, y: lerp(LIFT_Y, PICK_Y, seg(u, 3.5, 4.2)) });
  else if (u < 4.5) Object.assign(out, { yaw: 0, y: PICK_Y });
  else if (u < 5.2) Object.assign(out, { yaw: 0, y: lerp(PICK_Y, LIFT_Y, seg(u, 4.5, 5.2)) });
  else swing(seg(u, 5.2, PERIOD), 0, Math.PI, out);
  return out;
}

/** Across from one lane to the other over the +x side, tucking in and rising a little on the way. */
function swing(e: number, from: number, to: number, out: Reach) {
  out.yaw = lerp(from, to, e);
  out.r = LANE - 0.22 * Math.sin(Math.PI * e);
  out.y = LIFT_Y + 0.1 * Math.sin(Math.PI * e);
}

interface Joints {
  yaw: THREE.Object3D;
  shoulder: THREE.Object3D;
  elbow: THREE.Object3D;
  wrist: THREE.Object3D;
  roll: THREE.Object3D;
}

/** Two-link IK, elbow up, with the tool held straight down and turned to keep the crate square. */
function pose(j: Joints, reach: Reach) {
  const L1 = ARM.upper;
  const L2 = ARM.fore;
  const h = reach.y + ARM.wrist + ARM.tool - (ARM.pedestal + ARM.shoulder);
  const r = reach.r;
  const c2 = Math.max(-1, Math.min(1, (r * r + h * h - L1 * L1 - L2 * L2) / (2 * L1 * L2)));
  const elbow = Math.acos(c2);
  const shoulder = Math.atan2(r, h) - Math.atan2(L2 * Math.sin(elbow), L1 + L2 * c2);
  j.yaw.rotation.y = reach.yaw;
  j.shoulder.rotation.x = shoulder;
  j.elbow.rotation.x = elbow;
  j.wrist.rotation.x = Math.PI - shoulder - elbow;
  j.roll.rotation.y = reach.yaw - Math.PI;
}

interface Crate {
  root: THREE.Object3D;
  status: THREE.Mesh | null;
  label: { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture };
  n: number;
}

function buildCell(kit: DressingKit, waiting: Waiting[], updates: ((t: number, dt: number) => void)[]): THREE.Group {
  const { x, z, width, depth } = ROBOT_CELL;
  const cell = new THREE.Group();
  cell.position.set(x, 0, z);

  // The safety floor: a dark plate with an orange edge, and a bollard at each corner.
  const stat = new THREE.Group();
  stat.add(mesh(roundedBox(width, 0.02, depth, 0.03), toon('#0a0a0a'), 0, 0.01, 0, false));
  const edge = toon(ORANGE, { emissive: '#4a1a04' });
  const e = 0.035;
  for (const s of [-1, 1]) {
    stat.add(mesh(new THREE.BoxGeometry(width - 0.04, 0.004, e), edge, 0, 0.022, s * (depth / 2 - 0.02 - e / 2), false));
    stat.add(mesh(new THREE.BoxGeometry(e, 0.004, depth - 0.04 - 2 * e), edge, s * (width / 2 - 0.02 - e / 2), 0.022, 0, false));
  }
  const post = toon('#1c1c1c');
  const band = toon(ORANGE, { emissive: '#4a1a04' });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = sx * (width / 2 - 0.12);
      const pz = sz * (depth / 2 - 0.12);
      stat.add(mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.82, 12), post, px, 0.43, pz));
      stat.add(mesh(new THREE.CylinderGeometry(0.041, 0.041, 0.05, 12), band, px, 0.78, pz));
      stat.add(mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.03, 12), toon('#2a2a2a'), px, 0.855, pz));
    }
  }
  cell.add(mergeByMaterial(stat));
  kit.colliders.push({ minX: x - width / 2, maxX: x + width / 2, minZ: z - depth / 2, maxZ: z + depth / 2, top: ROBOT_CELL.top, fence: true });

  // The conveyors: crates come in from code review on the far lane and leave shipped on the near one.
  const belts: THREE.Texture[] = [];
  const beacons: THREE.MeshBasicMaterial[] = [];
  for (const lane of [-1, 1]) {
    waiting.push({
      name: 'conveyor',
      install(model) {
        model.position.set(0, 0, lane * LANE);
        // Its hood is at its +x end: the in-feed turns round so crates come out of it.
        if (lane < 0) model.rotation.y = Math.PI;
        cell.add(model);
        const tex = beltTexture();
        belts[lane < 0 ? 0 : 1] = tex;
        const belt = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 0.36), flat(new THREE.MeshToonMaterial({ map: tex, gradientMap: gradient() })));
        belt.rotation.x = -Math.PI / 2;
        belt.position.set(0, BELT_Y + 0.0015, lane * LANE);
        belt.receiveShadow = true;
        cell.add(belt);
        const hx = lane * 1.05;
        const lamp = flat(new THREE.MeshBasicMaterial({ color: '#2a1206', toneMapped: false }));
        beacons[lane < 0 ? 0 : 1] = lamp;
        cell.add(mesh(new THREE.CylinderGeometry(0.022, 0.024, 0.04, 12), lamp, hx, 0.93, lane * LANE, false));
        const text = lane < 0 ? ['03', 'CODE REVIEW'] : ['\u2192', 'SHIPPED'];
        for (const side of [-1, 1]) {
          const plaque = hoodLabel(text[0], text[1]);
          plaque.position.set(hx, 0.79, lane * LANE + side * 0.2465);
          if (side < 0) plaque.rotation.y = Math.PI;
          cell.add(plaque);
        }
      },
    });
  }

  // The arm, nested joint by joint from its GLB's loose parts (see build_robot_arm).
  let joints: Joints | null = null;
  waiting.push({
    name: 'robot-arm',
    install(model) {
      const part = (name: string) => model.getObjectByName(name) ?? new THREE.Group();
      const yaw = new THREE.Group();
      yaw.position.y = ARM.pedestal;
      const shoulder = new THREE.Group();
      shoulder.position.y = ARM.shoulder;
      const elbow = new THREE.Group();
      elbow.position.y = ARM.upper;
      const wrist = new THREE.Group();
      wrist.position.y = ARM.fore;
      const roll = new THREE.Group();
      roll.position.y = ARM.wrist;
      const chain: [THREE.Object3D, string][] = [
        [yaw, 'Turret'],
        [shoulder, 'UpperArm'],
        [elbow, 'Forearm'],
        [wrist, 'Wrist'],
        [roll, 'Tool'],
      ];
      let parent: THREE.Object3D = model;
      for (const [joint, name] of chain) {
        joint.add(part(name));
        parent.add(joint);
        parent = joint;
      }
      // The pinwheel on the pedestal's two faces toward the room.
      const mark = toon(ORANGE, { emissive: '#5a2006' });
      const geo = glyphFlat(0.17, 5);
      for (const face of [0, Math.PI / 2]) {
        const g = new THREE.Mesh(geo, mark);
        g.material.userData.outlineParameters = { visible: false };
        g.rotation.y = face;
        g.position.set(Math.sin(face) * 0.2125, 0.235, Math.cos(face) * 0.2125);
        model.add(g);
      }
      cell.add(model);
      joints = { yaw, shoulder, elbow, wrist, roll };
    },
  });

  const crates: Crate[] = [];
  for (let i = 0; i < POOL; i++) {
    waiting.push({
      name: 'pr-crate',
      install(model) {
        const status = (model.getObjectByName('Status') as THREE.Mesh | undefined) ?? null;
        const { tex, ctx } = canvas(256, 112);
        const label = new THREE.Mesh(crateLabelGeometry(), flat(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false })));
        model.add(label);
        model.visible = false;
        cell.add(model);
        crates.push({ root: model, status, label: { ctx, tex }, n: Number.NaN });
      },
    });
  }

  // The plate's stencil is painted once the arm is in, so it never reads over an empty cell.
  let stencilled = false;

  const reach: Reach = { yaw: Math.PI, r: LANE, y: LIFT_Y };
  const review = toon(ORANGE, { emissive: ORANGE });
  const shipped = toon(GREEN, { emissive: GREEN });
  updates.push((t) => {
    if (!stencilled && joints) {
      stencilled = true;
      cell.add(plateStencil(depth));
    }
    const c = Math.floor(t / PERIOD);
    const u = t - c * PERIOD;
    if (joints) pose(joints, reachAt(u, reach));
    const pIn = seg(u, 1.8, 3.3);
    const pOut = seg(u, 4.6, 6.6);
    if (belts[0]) belts[0].offset.x = -(((c + pIn) * SLOT) / 0.1) % 1;
    if (belts[1]) belts[1].offset.x = -(((c + pOut) * SLOT) / 0.1) % 1;
    if (beacons[0]) beacons[0].color.set(pIn > 0 && pIn < 1 ? ORANGE : '#3a1608');
    if (beacons[1]) beacons[1].color.set(pOut > 0.45 && pOut < 0.9 ? GREEN : '#0d2a1d');
    if (crates.length < POOL) return;
    for (let n = c - 3; n <= c + 3; n++) {
      const crate = crates[((n % POOL) + POOL) % POOL];
      if (crate.n !== n) {
        crate.n = n;
        paintCrate(crate.label.ctx, FIRST_PR + n);
        crate.label.tex.needsUpdate = true;
      }
      const o = crate.root;
      let done = n < c;
      let cx: number;
      let cz: number;
      let cy = BELT_Y;
      if (n > c) {
        cx = -(n - c - pIn) * SLOT;
        cz = -LANE;
      } else if (n < c) {
        cx = (c - n + pOut) * SLOT;
        cz = LANE;
      } else if (u < HOLD[0]) {
        cx = 0;
        cz = -LANE;
      } else if (u < HOLD[1]) {
        cx = Math.sin(reach.yaw) * reach.r;
        cz = Math.cos(reach.yaw) * reach.r;
        cy = reach.y - CRATE_H;
      } else {
        cx = pOut * SLOT;
        cz = LANE;
        done = true;
      }
      o.position.set(cx, cy, cz);
      o.visible = cx > -1.2 && cx < 1.2;
      if (crate.status) crate.status.material = done ? shipped : review;
    }
  });
  return cell;
}

function beltTexture(): THREE.CanvasTexture {
  const { tex, ctx } = canvas(64, 16);
  ctx.fillStyle = '#121212';
  ctx.fillRect(0, 0, 64, 16);
  ctx.fillStyle = '#060606';
  ctx.fillRect(0, 0, 6, 16);
  ctx.fillStyle = '#242424';
  ctx.fillRect(6, 0, 2, 16);
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(25, 1);
  return tex;
}

function hoodLabel(index: string, name: string): THREE.Mesh {
  return labelPlane(0.4, 0.07, 56, (ctx, _w, h) => {
    ctx.font = `500 30px ${MONO}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = ORANGE;
    const n = tracked(ctx, index, 10, h / 2, 3);
    ctx.fillStyle = '#8c8c8c';
    tracked(ctx, name, 10 + n + 16, h / 2, 3);
  });
}

let crateGeo: THREE.BufferGeometry | null = null;
/** The stencil panels on a crate's two ±z faces, in one geometry. */
function crateLabelGeometry(): THREE.BufferGeometry {
  if (crateGeo) return crateGeo;
  const front = new THREE.PlaneGeometry(0.17, 0.075).translate(0, 0.095, 0.1225);
  const back = new THREE.PlaneGeometry(0.17, 0.075).rotateY(Math.PI).translate(0, 0.095, -0.1225);
  const pos = [...(front.attributes.position.array as Float32Array), ...(back.attributes.position.array as Float32Array)];
  const uv = [...(front.attributes.uv.array as Float32Array), ...(back.attributes.uv.array as Float32Array)];
  const idx = [...(front.index?.array ?? []), ...[...(back.index?.array ?? [])].map((i) => i + 4)];
  crateGeo = new THREE.BufferGeometry();
  crateGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  crateGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  crateGeo.setIndex(idx);
  front.dispose();
  back.dispose();
  return crateGeo;
}

function paintCrate(ctx: CanvasRenderingContext2D, pr: number) {
  const { width: w, height: h } = ctx.canvas;
  ctx.clearRect(0, 0, w, h);
  ctx.textBaseline = 'middle';
  ctx.font = `600 22px ${MONO}`;
  ctx.fillStyle = '#8c8c8c';
  tracked(ctx, 'PR', w / 2, 22, 4, 'center');
  ctx.font = `600 54px ${MONO}`;
  ctx.fillStyle = '#e6e6e6';
  tracked(ctx, `#${pr}`, w / 2, 72, 2, 'center');
}

/** "CELL 01 AUTOMATIONS" inside the plate's near edge, flat on the floor. */
function plateStencil(depth: number): THREE.Mesh {
  const label = labelPlane(1.4, 0.08, 64, (ctx, _w, h) => {
    ctx.font = `500 36px ${MONO}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = ORANGE;
    const n = tracked(ctx, 'CELL 01', 8, h / 2, 5);
    ctx.fillStyle = '#8c8c8c';
    tracked(ctx, 'AUTOMATIONS  \u00b7  KEEP CLEAR', 8 + n + 28, h / 2, 5);
  });
  label.rotation.x = -Math.PI / 2;
  label.position.set(-0.45, 0.0215, depth / 2 - 0.13);
  return label;
}
