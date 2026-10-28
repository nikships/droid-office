import * as THREE from 'three';
import {
  BALCONY,
  BALCONY_DOOR,
  BEANBAGS,
  BOARDS,
  BOOKSHELF,
  COMPUTE_WALL,
  DESK_LAPTOP,
  DESK_SIZE,
  DESKS,
  DROID_RACK,
  ELEVATOR,
  ELEVATOR_FRONT,
  EXIT_DOOR,
  FLOOR,
  GLASS_ROOM,
  GLASS_ROOM_CHAIRS,
  GLASS_ROOM_TABLE,
  GONG,
  JUKEBOX,
  KIOSK,
  LADDER,
  LOFT,
  STATION_AGENT,
  STATIONS,
  TV,
  WALL_T,
  WINDOWS,
  deskSeat,
  type DeskDef,
  type Opening,
  type Side,
} from '../../shared/layout';
import type { FloorPalette } from '../../shared/floors';
import { MONO } from '../fonts';
import { installAgentKiosks } from './agent-kiosk';
import { installBalconyBench } from './balcony-bench';
import { installBalconyStools } from './balcony-stool';
import { installBalconyTable } from './balcony-table';
import { installConferenceTable } from './conference-table';
import { installDroidRack } from './droid-rack';
import { installExecutiveDesk } from './executive-desk';
import { toonifyProp } from './factory-props';
import { installLoftCouch } from './loft-couch';
import { installLoftStairs } from './loft-stairs';
import { buildLoungeBeanbag, installLoungeBeanbags } from './lounge-beanbag';
import { installLoungeSofa } from './lounge-sofa';
import { installLoungeTable } from './lounge-table';
import { prop, propScene } from './props';
import { installTaskChairs } from './task-chair';
import { ANISOTROPY } from './texture-quality';
import { beveledBox, mergeByMaterial, mesh, roundedBox, textPlane, toon, toonUnique } from './toon';
import { installWorkbenches } from './workbench';

/**
 * The web companion's office map: one floor of the office as a dollhouse seen from above. Everything
 * stands where `layout.ts` puts it in the 3D office (the same desks, seats, kiosks, lounge, loft and
 * balcony, from the same prop GLBs), with the outside walls cut down to waist height so the camera
 * sees in. Workers and their laptops are added by office-map.ts at each seat's anchors.
 */

/** How high the cutaway walls stand. Windows and doors show as glass and gaps in them. */
export const CUT = 1.15;

/** A seat on the map: where its worker and laptop go, and the box a click on it lands in. */
export interface MapSeat {
  def: DeskDef;
  group: THREE.Group;
  /** Where the laptop goes, placed, turned and sized for the seat (none at a kiosk). */
  laptopAnchor: THREE.Object3D | null;
  /** Where the worker goes. */
  seatAnchor: THREE.Object3D;
  /** The desk chair, turned to the desk while someone sits in it. */
  chair: THREE.Group | null;
  /** An invisible box round the seat and its desk, for picking. */
  hit: THREE.Mesh;
}

export interface FloorMap {
  group: THREE.Group;
  seats: Map<string, MapSeat>;
  /** What a click can land on: every seat's hit box (put-away bean bags and git-only kiosks are hidden). */
  hits: THREE.Mesh[];
  /** Paints the walls, trim and slab in a floor's colors. */
  setLook(p: FloorPalette): void;
  /** A plain folder has no git boards and no board agents. */
  setPlain(plain: boolean): void;
  /** Only the bottom floor has its exit door. */
  setBottom(bottom: boolean): void;
  setBeanbags(out: Set<string>): void;
  /** The floor's name, on the elevator's roof. */
  setName(name: string): void;
  /** Swaps the stand-ins for the prop GLBs once they're cached (see props.ts). */
  installProps(): void;
  update(t: number, dt: number): void;
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const ACCENT = '#ee6018';
/** Lit greys picked for how they render under the map's lights, like the office's own (see office.ts PALETTE). */
const DESK_TOP = '#5a5a5a';
const STEEL = '#8a8a8a';
const INK = '#2e2e2e';
const CHAIRS = ['#505050', '#575757', '#4a4a4a', '#5c5c5c', '#4e4e4e', '#545454'];

/** Unlit, for glass, screens and decals. */
function basic(color: THREE.ColorRepresentation, opacity = 1, extra: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1, ...extra });
}

function glow(color: THREE.ColorRepresentation, intensity = 1): THREE.MeshBasicMaterial {
  const c = new THREE.Color(color).multiplyScalar(intensity);
  return new THREE.MeshBasicMaterial({ color: c, toneMapped: false });
}

function shade(hex: string, k: number): string {
  return `#${new THREE.Color(hex).multiplyScalar(k).getHexString()}`;
}

// ---- The slab's top: a polished pour with a scored grid, work cells and stencils ----------------

const PX = 56;
const W = Math.round((FLOOR.maxX - FLOOR.minX) * PX);
const H = Math.round((FLOOR.maxZ - FLOOR.minZ) * PX);
const fx = (x: number) => (x - FLOOR.minX) * PX;
const fz = (z: number) => (z - FLOOR.minZ) * PX;

/** The desk pods' work cells: each cluster of four desks and the chairs round it, with a margin. */
function workCellBoxes(): { minX: number; maxX: number; minZ: number; maxZ: number }[] {
  const cells = new Map<string, DeskDef[]>();
  for (const d of DESKS) {
    const key = `${d.x < -6 ? 'w' : 'e'}${d.z < 0 ? 'n' : 's'}`;
    cells.set(key, [...(cells.get(key) ?? []), d]);
  }
  return [...cells.values()].map((ds) => ({
    minX: Math.min(...ds.map((d) => d.x)) - DESK_SIZE.width / 2 - 0.45,
    maxX: Math.max(...ds.map((d) => d.x)) + DESK_SIZE.width / 2 + 0.45,
    minZ: Math.min(...ds.map((d) => d.z)) - DESK_SIZE.depth / 2 - 1.35,
    maxZ: Math.max(...ds.map((d) => d.z)) + DESK_SIZE.depth / 2 + 1.35,
  }));
}

function stencil(ctx: CanvasRenderingContext2D, text: string, x: number, z: number, sizeM: number, alpha = 0.34, rotate = 0) {
  const m = /^(0[1-9])\s+(.*)$/.exec(text);
  const px = sizeM * PX;
  ctx.save();
  ctx.translate(fx(x), fz(z));
  ctx.rotate(rotate);
  ctx.font = `500 ${px}px ${MONO}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${px * 0.18}px`;
  ctx.textBaseline = 'middle';
  const words = m ? m[2] : text;
  const index = m ? m[1] : '';
  const gap = px * 0.7;
  const wi = index ? ctx.measureText(index).width + gap : 0;
  const ww = ctx.measureText(words).width;
  let left = -(wi + ww) / 2;
  if (index) {
    ctx.fillStyle = `rgba(238, 96, 24, ${Math.min(1, alpha * 2.2)})`;
    ctx.fillText(index, left, 0);
    left += wi;
  }
  ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
  ctx.fillText(words, left, 0);
  ctx.restore();
}

function paintFloor(ctx: CanvasRenderingContext2D, p: FloorPalette, bottom: boolean) {
  const base = shade(p.floor, 0.36);
  const alt = shade(p.floorAlt, 0.36);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);
  // Every other six-metre pour a shade off, like the slab in the room.
  ctx.fillStyle = alt;
  for (let x = FLOOR.minX; x < FLOOR.maxX; x += 12) ctx.fillRect(fx(x + 6), 0, 6 * PX, H);
  // A soft sheen across the polish, brightest under the windows to the south and west.
  const sheen = ctx.createRadialGradient(fx(-8), fz(9), 0, fx(-8), fz(9), 26 * PX);
  sheen.addColorStop(0, 'rgba(255, 244, 230, .07)');
  sheen.addColorStop(1, 'rgba(255, 244, 230, 0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, W, H);

  // The hairline grid a metre apart, a heavier line at every pour joint.
  const seam = new THREE.Color(p.seam);
  const seamRgb = `${Math.round(seam.r * 255)}, ${Math.round(seam.g * 255)}, ${Math.round(seam.b * 255)}`;
  for (let x = Math.ceil(FLOOR.minX); x <= FLOOR.maxX; x++) {
    const joint = (x - FLOOR.minX) % 6 === 0;
    ctx.fillStyle = `rgba(${seamRgb}, ${joint ? 0.16 : 0.07})`;
    ctx.fillRect(Math.round(fx(x)) - (joint ? 1 : 0), 0, joint ? 2 : 1, H);
  }
  for (let z = Math.ceil(FLOOR.minZ); z <= FLOOR.maxZ; z++) {
    const joint = (z - FLOOR.minZ) % 6 === 0;
    ctx.fillStyle = `rgba(${seamRgb}, ${joint ? 0.16 : 0.07})`;
    ctx.fillRect(0, Math.round(fz(z)) - (joint ? 1 : 0), W, joint ? 2 : 1);
  }

  // The work cells: a darker pad with a hairline edge and orange corner brackets.
  for (const c of workCellBoxes()) {
    const x0 = fx(c.minX);
    const z0 = fz(c.minZ);
    const w = (c.maxX - c.minX) * PX;
    const h = (c.maxZ - c.minZ) * PX;
    ctx.fillStyle = 'rgba(0, 0, 0, .28)';
    ctx.fillRect(x0, z0, w, h);
    ctx.strokeStyle = 'rgba(255, 255, 255, .1)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x0 + 1, z0 + 1, w - 2, h - 2);
    ctx.strokeStyle = 'rgba(238, 96, 24, .85)';
    ctx.lineWidth = 4;
    const arm = 0.7 * PX;
    for (const [cx, cz, sx, sz] of [
      [x0, z0, 1, 1],
      [x0 + w, z0, -1, 1],
      [x0, z0 + h, 1, -1],
      [x0 + w, z0 + h, -1, -1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(cx + sx * arm, cz + sz * 2);
      ctx.lineTo(cx + sx * 2, cz + sz * 2);
      ctx.lineTo(cx + sx * 2, cz + sz * arm);
      ctx.stroke();
    }
  }
  // Each desk's number on the floor at the chair's end of it, like a parking bay.
  for (const d of DESKS) {
    const s = deskSeat(d, 1.62);
    stencil(ctx, d.label.replace('Desk ', 'D'), s.x, s.z, 0.2, 0.2);
  }

  // Walkways: dashed lanes along the aisles between the pods and out to the lounge.
  ctx.strokeStyle = 'rgba(255, 255, 255, .09)';
  ctx.lineWidth = 3;
  ctx.setLineDash([0.6 * PX, 0.45 * PX]);
  for (const [x0, z0, x1, z1] of [
    [-6, -8.6, -6, 8.4],
    [-16.6, 0, 7.6, 0],
    [-15.8, -7.4, 7.2, -7.4],
    [-15.8, 7.4, 7.2, 7.4],
  ]) {
    ctx.beginPath();
    ctx.moveTo(fx(x0), fz(z0));
    ctx.lineTo(fx(x1), fz(z1));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // The lounge rug.
  ctx.fillStyle = 'rgba(0, 0, 0, .3)';
  ctx.fillRect(fx(9.9), fz(-3.5), 7 * PX, 7 * PX);
  ctx.strokeStyle = 'rgba(255, 255, 255, .14)';
  ctx.lineWidth = 2;
  ctx.strokeRect(fx(10), fz(-3.4), 6.8 * PX, 6.8 * PX);

  // Hazard stripes at the elevator doors.
  {
    const x0 = fx(ELEVATOR.x - ELEVATOR.width / 2);
    const z0 = fz(ELEVATOR_FRONT);
    const w = ELEVATOR.width * PX;
    const h = 0.55 * PX;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, z0, w, h);
    ctx.clip();
    ctx.fillStyle = 'rgba(10, 10, 10, .9)';
    ctx.fillRect(x0, z0, w, h);
    ctx.fillStyle = 'rgba(238, 96, 24, .75)';
    for (let i = -h; i < w; i += 28) {
      ctx.beginPath();
      ctx.moveTo(x0 + i, z0 + h);
      ctx.lineTo(x0 + i + 14, z0 + h);
      ctx.lineTo(x0 + i + 14 + h, z0);
      ctx.lineTo(x0 + i + h, z0);
      ctx.fill();
    }
    ctx.restore();
  }
  // The ladder's hatch by the west wall.
  ctx.fillStyle = 'rgba(0, 0, 0, .8)';
  ctx.fillRect(fx(LADDER.hatch.minX), fz(LADDER.hatch.minZ), (LADDER.hatch.maxX - LADDER.hatch.minX) * PX, (LADDER.hatch.maxZ - LADDER.hatch.minZ) * PX);

  // Where the boards are, stencilled in front of them.
  for (const key of ['issues', 'actions', 'pulls'] as const) stencil(ctx, BOARDS[key].label, BOARDS[key].x, FLOOR.minZ + 2.15, 0.36);
  stencil(ctx, 'FACTORY CI', BOARDS.ci.x - 0.2, FLOOR.minZ + 2.15, 0.26, 0.26);
  stencil(ctx, 'WHITEBOARD', FLOOR.maxX - 2.6, BOARDS.whiteboard.z, 0.3, 0.3);
  stencil(ctx, 'LOUNGE', 15.6, 2.7, 0.34, 0.28);
  stencil(ctx, 'COMPUTE', FLOOR.minX + 2.2, COMPUTE_WALL.z - 1.2, 0.24, 0.22);
  stencil(ctx, 'ELEVATOR', ELEVATOR.x, ELEVATOR_FRONT + 1.05, 0.24, 0.3);
  stencil(ctx, '04 TEAM', STATIONS[3].x - 2.1, STATIONS[3].z, 0.26, 0.26);
  if (bottom) stencil(ctx, 'EXIT', FLOOR.minX + 1.2, EXIT_DOOR.u, 0.3, 0.42);
}

// ---- Walls ---------------------------------------------------------------------------------------

interface WallSpan {
  u0: number;
  u1: number;
  kind: 'solid' | 'glass' | 'door';
}

/** Along one wall, which stretches are wall, window glass or doorway. */
function spans(side: Side, openings: Opening[]): WallSpan[] {
  const horizontal = side === 'north' || side === 'south';
  const lo = (horizontal ? FLOOR.minX : FLOOR.minZ) - WALL_T;
  const hi = (horizontal ? FLOOR.maxX : FLOOR.maxZ) + WALL_T;
  const holes = openings
    .filter((o) => o.wall === side)
    .map((o) => ({ u0: o.u - o.width / 2, u1: o.u + o.width / 2, kind: o.y0 > 0.2 ? ('glass' as const) : ('door' as const) }))
    .sort((a, b) => a.u0 - b.u0);
  const out: WallSpan[] = [];
  let at = lo;
  for (const h of holes) {
    if (h.u0 > at) out.push({ u0: at, u1: h.u0, kind: 'solid' });
    out.push(h);
    at = h.u1;
  }
  if (at < hi) out.push({ u0: at, u1: hi, kind: 'solid' });
  return out;
}

function placeOnWall(m: THREE.Object3D, side: Side, u: number, y: number) {
  const off = WALL_T / 2;
  if (side === 'north') m.position.set(u, y, FLOOR.minZ - off);
  else if (side === 'south') m.position.set(u, y, FLOOR.maxZ + off);
  else if (side === 'west') {
    m.position.set(FLOOR.minX - off, y, u);
    m.rotation.y = Math.PI / 2;
  } else {
    m.position.set(FLOOR.maxX + off, y, u);
    m.rotation.y = Math.PI / 2;
  }
}

/** A wall-mounted screen or board as the map shows it: a lit plate lying on top of the cut wall, its title on it. */
function wallPlate(text: string, color: string, length: number): THREE.Group {
  const g = new THREE.Group();
  const c = document.createElement('canvas');
  const scale = 96;
  c.width = Math.round(length * scale);
  c.height = Math.round(0.5 * scale);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#0b0b0b';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, 5);
  ctx.globalAlpha = 0.18;
  ctx.fillRect(0, 5, c.width, c.height - 5);
  ctx.globalAlpha = 1;
  if (text) {
    const px = c.height * 0.42;
    ctx.font = `500 ${px}px ${MONO}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${px * 0.2}px`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f2f2f2';
    ctx.fillText(text, c.width / 2, c.height / 2 + 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = ANISOTROPY;
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(length, WALL_T + 0.24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  plate.position.y = 0.032;
  g.add(plate);
  // Its edge glows into the room, the way a lit board washes the wall under it.
  const edge = mesh(box(length, 0.05, 0.02), glow(color, 1.4), 0, -0.03, (WALL_T + 0.24) / 2);
  g.add(edge);
  return g;
}

// ---- Seats -----------------------------------------------------------------------------------------

/** A stand-in task chair until task-chair.glb lands: seat, back, post and a five-star base. */
function chairStandIn(color: string): THREE.Group {
  const g = new THREE.Group();
  const mat = toon(color);
  g.add(mesh(beveledBox(0.6, 0.1, 0.56, 0.025), mat, 0, 0.5, 0));
  const back = mesh(beveledBox(0.58, 0.09, 0.6, 0.025), mat, 0, 0.86, 0.27);
  back.rotation.x = Math.PI / 2 - 0.12;
  g.add(back);
  const steel = toon(STEEL, { finish: 'metal' });
  g.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.42, 6), steel, 0, 0.26, 0));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const leg = mesh(box(0.045, 0.035, 0.32), steel, Math.sin(a) * 0.15, 0.05, Math.cos(a) * 0.15);
    leg.rotation.y = a;
    g.add(leg);
  }
  return mergeByMaterial(g);
}

function hitBox(w: number, d: number, h: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(box(w, h, d), new THREE.MeshBasicMaterial({ visible: false }));
  m.position.set(0, h / 2, z);
  return m;
}

function buildDesk(def: DeskDef, i: number): MapSeat {
  const group = new THREE.Group();
  group.position.set(def.x, 0, def.z);
  group.rotation.y = def.rotY;
  const { width, depth, height } = DESK_SIZE;
  const body = new THREE.Group();
  const top = 0.05;
  body.add(mesh(beveledBox(width - 0.06, top, depth - 0.04), toon(DESK_TOP, { finish: 'paint' }), 0, height - top / 2, 0));
  const frame = toon('#404040', { finish: 'paint' });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) body.add(mesh(box(0.05, height - top, 0.05), frame, sx * (width / 2 - 0.1), (height - top) / 2, sz * (depth / 2 - 0.08)));
  body.add(mesh(box(width - 0.3, 0.32, 0.02), toon('#3c3c3c'), 0, height - 0.26, -depth / 2 + 0.07));
  const workbench = mergeByMaterial(body);
  workbench.name = 'workbench';
  group.add(workbench);
  const laptopAnchor = new THREE.Object3D();
  laptopAnchor.position.set(0, height, DESK_LAPTOP.z);
  laptopAnchor.scale.setScalar(DESK_LAPTOP.scale);
  group.add(laptopAnchor);
  const seatAnchor = new THREE.Object3D();
  seatAnchor.position.set(0, 0.4, 0.93);
  seatAnchor.rotation.y = Math.PI;
  seatAnchor.scale.setScalar(0.82);
  group.add(seatAnchor);
  const chair = new THREE.Group();
  chair.add(chairStandIn(CHAIRS[i % CHAIRS.length]));
  chair.position.set(0, 0, 0.9);
  group.add(chair);
  const hit = hitBox(width + 0.2, depth + 1.7, 1.7, 0.55);
  hit.userData.deskId = def.id;
  group.add(hit);
  return { def, group, laptopAnchor, seatAnchor, chair, hit };
}

function buildBeanbag(def: DeskDef, i: number): MapSeat {
  const group = new THREE.Group();
  group.position.set(def.x, 0, def.z);
  group.rotation.y = def.rotY;
  const cloth = toon(['#3c3c3c', '#464646', '#383838', '#4c4c4c'][i % 4]);
  const seat = mesh(new THREE.SphereGeometry(0.62, 16, 10), cloth, 0, 0.3, 0);
  seat.scale.set(1, 0.52, 1);
  const back = mesh(new THREE.SphereGeometry(0.5, 14, 10), cloth, 0, 0.6, 0.32);
  back.scale.set(1.05, 0.95, 0.7);
  group.add(seat, back);
  const tray = new THREE.Group();
  tray.add(mesh(roundedBox(0.95, 0.04, 0.6, 0.02), toon(DESK_TOP), 0, 0.42, 0));
  for (const sx of [-1, 1]) tray.add(mesh(box(0.04, 0.4, 0.5), toon('#404040'), sx * 0.4, 0.2, 0));
  tray.position.z = -0.8;
  group.add(tray);
  const laptopAnchor = new THREE.Object3D();
  laptopAnchor.position.set(0, 0.445, -0.8);
  laptopAnchor.scale.setScalar(1.615);
  group.add(laptopAnchor);
  const seatAnchor = new THREE.Object3D();
  seatAnchor.position.set(0, 0.32, 0.04);
  seatAnchor.rotation.y = Math.PI;
  seatAnchor.scale.setScalar(0.82);
  group.add(seatAnchor);
  const hit = hitBox(1.5, 2.2, 1.4, -0.3);
  hit.userData.deskId = def.id;
  group.add(hit);
  group.visible = false;
  return { def, group, laptopAnchor, seatAnchor, chair: null, hit };
}

function buildKiosk(def: DeskDef): MapSeat {
  const group = new THREE.Group();
  group.position.set(def.x, 0, def.z);
  group.rotation.y = def.rotY;
  const { width, depth, height } = KIOSK;
  const body = new THREE.Group();
  body.add(mesh(roundedBox(width - 0.16, height - 0.1, depth - 0.12, 0.02), toon('#4a4a4a'), 0, (height - 0.1) / 2 + 0.04, 0));
  body.add(mesh(roundedBox(width, 0.05, depth, 0.02), toon(STEEL), 0, height - 0.025, 0));
  body.add(mesh(box(width - 0.24, 0.014, 0.01), glow(ACCENT), 0, height - 0.08, -(depth - 0.12) / 2 - 0.004));
  const kiosk = mergeByMaterial(body);
  kiosk.name = 'agent-kiosk';
  group.add(kiosk);
  // Its agent's color, on a puck at its foot, so the empty kiosk still says whose it is.
  const color = STATION_AGENT[def.station!].color;
  group.add(mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.02, 24), glow(color, 0.9), 0, 0.01, -depth / 2 - 0.35));
  const seatAnchor = new THREE.Object3D();
  seatAnchor.position.set(0, 0, KIOSK.stand);
  seatAnchor.rotation.y = Math.PI;
  seatAnchor.scale.setScalar(0.82);
  group.add(seatAnchor);
  const hit = hitBox(1.4, 2, 1.7, KIOSK.stand / 2);
  hit.userData.deskId = def.id;
  group.add(hit);
  return { def, group, laptopAnchor: null, seatAnchor, chair: null, hit };
}

// ---- Rooms and furniture ------------------------------------------------------------------------

function glassWall(length: number, height: number): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(box(length, height, 0.03), basic('#9cc2ff', 0.13, { side: THREE.DoubleSide }), 0, height / 2, 0));
  g.add(mesh(box(length, 0.035, 0.06), toon('#9a9a9a', { finish: 'metal' }), 0, height, 0));
  g.add(mesh(box(length, 0.05, 0.06), toon(INK), 0, 0.025, 0));
  return g;
}

function buildGlassRoomAndLoft(group: THREE.Group, chairs: THREE.Group[]) {
  const R = GLASS_ROOM;
  const height = CUT;
  // The west side, and the north side with its door toward the lounge.
  const west = glassWall(R.maxZ - R.minZ, height);
  west.rotation.y = Math.PI / 2;
  west.position.set(R.minX, 0, (R.minZ + R.maxZ) / 2);
  group.add(west);
  for (const [a, b] of [
    [R.minX, R.door.x0],
    [R.door.x1, R.maxX],
  ]) {
    const w = glassWall(b - a, height);
    w.position.set((a + b) / 2, 0, R.minZ);
    group.add(w);
  }
  const table = new THREE.Group();
  table.name = 'conference-table';
  const T = GLASS_ROOM_TABLE;
  table.add(mesh(roundedBox(T.width, 0.06, T.depth, 0.02), toon('#4a4a4a'), 0, T.height - 0.03, 0));
  table.position.set(T.x, 0, T.z);
  group.add(table);
  GLASS_ROOM_CHAIRS.forEach((c, i) => {
    const p = deskSeat(c, 0.42);
    const ch = new THREE.Group();
    ch.add(chairStandIn(CHAIRS[(i + 2) % CHAIRS.length]));
    ch.position.set(p.x, 0, p.z);
    ch.rotation.y = c.rotY;
    group.add(ch);
    chairs.push(ch);
  });

  // The boss's loft over it: a glass deck on four posts, its furniture on top.
  const L = LOFT;
  const loft = new THREE.Group();
  const deckW = L.maxX - L.minX;
  const deckD = L.maxZ - L.minZ;
  loft.add(mesh(box(deckW, 0.1, deckD), basic('#b9d3ff', 0.16), (L.minX + L.maxX) / 2, L.y - 0.05, (L.minZ + L.maxZ) / 2));
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box(deckW, 0.1, deckD)), new THREE.LineBasicMaterial({ color: '#c9d6e8', transparent: true, opacity: 0.5 }));
  edges.position.set((L.minX + L.maxX) / 2, L.y - 0.05, (L.minZ + L.maxZ) / 2);
  loft.add(edges);
  for (const [x, z] of [
    [L.minX + 0.12, L.minZ + 0.12],
    [L.maxX - 0.12, L.minZ + 0.12],
    [L.minX + 0.12, L.maxZ - 0.12],
  ])
    loft.add(mesh(new THREE.CylinderGeometry(0.06, 0.06, L.y, 10), toon('#6e6e6e', { finish: 'metal' }), x, L.y / 2, z));
  const rail = glassWall(deckW, 0.95);
  rail.position.set((L.minX + L.maxX) / 2, L.y, L.minZ);
  loft.add(rail);
  const railW = glassWall(deckD, 0.95);
  railW.rotation.y = Math.PI / 2;
  railW.position.set(L.minX, L.y, (L.minZ + L.maxZ) / 2);
  loft.add(railW);
  const cx = (L.minX + L.maxX) / 2;
  const cz = (L.minZ + L.maxZ) / 2;
  const boss = new THREE.Group();
  const exec = new THREE.Group();
  exec.name = 'executive-desk';
  exec.add(mesh(roundedBox(2.6, 0.08, 1.2, 0.02), toon('#3a3a3a'), 0, 0.79, 0));
  boss.add(exec);
  boss.add(mesh(new THREE.PlaneGeometry(0.8, 0.45), basic('#0d0f12'), 0, 1.18, -0.165));
  const bossChair = new THREE.Group();
  bossChair.add(chairStandIn('#3a3a3a'));
  bossChair.scale.setScalar(1.2);
  bossChair.position.set(0, 0, 1.0);
  boss.add(bossChair);
  chairs.push(bossChair);
  boss.position.set(cx + 0.5, L.y, cz - 0.3);
  loft.add(boss);
  const couch = new THREE.Group();
  couch.name = 'loft-couch';
  couch.add(mesh(roundedBox(1, 0.34, 2.4, 0.04), toon('#4a4a4a'), 0, 0.33, 0));
  couch.position.set(L.maxX - 0.65, L.y, cz);
  loft.add(couch);
  loft.add(mesh(box(4.6, 0.008, 3.2), toon('#3b3b3b'), cx + 0.2, L.y + 0.01, cz + 0.1));
  const stairs = new THREE.Group();
  stairs.name = 'loft-stairs';
  loft.add(stairs);
  group.add(loft);
}

function buildLounge(group: THREE.Group) {
  const sofa = new THREE.Group();
  sofa.name = 'lounge-sofa';
  sofa.add(mesh(roundedBox(1, 0.34, 4.2, 0.04), toon('#4a4a4a'), 0, 0.33, 0));
  sofa.add(mesh(roundedBox(0.3, 0.86, 4.2, 0.04), toon('#4a4a4a'), -0.45, 0.55, 0));
  sofa.position.set(10.5, 0, 0);
  group.add(sofa);
  const table = new THREE.Group();
  table.name = 'lounge-table';
  table.add(mesh(box(1.5, 0.06, 1.5), toon('#4a4a4a'), 0, 0.43, 0));
  table.position.set(13, 0, 0);
  group.add(table);
  group.add(buildLoungeBeanbag('lounge-beanbag-1', '#4c4c4c'), buildLoungeBeanbag('lounge-beanbag-2', '#5a3a2c'));
}

function buildElevator(group: THREE.Group): { setName(name: string): void } {
  const { x, width, depth } = ELEVATOR;
  const height = CUT + 0.55;
  const shaft = new THREE.Group();
  shaft.add(mesh(roundedBox(width, height, depth, 0.03), toon('#2a2a2a', { finish: 'metal' }), 0, height / 2, 0));
  // The doors, shut, a hairline between them, and the floor light over them.
  for (const s of [-1, 1]) shaft.add(mesh(box(0.68, 1.15, 0.03), toon('#7a7a7a', { finish: 'metal' }), s * 0.345, 0.6, depth / 2 + 0.012));
  shaft.add(mesh(box(1.5, 0.05, 0.03), glow(ACCENT, 1.3), 0, 1.28, depth / 2 + 0.02));
  shaft.position.set(x, 0, FLOOR.minZ + depth / 2);
  group.add(shaft);
  let plate: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;
  return {
    setName(name: string) {
      if (plate) {
        shaft.remove(plate);
        plate.geometry.dispose();
        plate.material.map?.dispose();
        plate.material.dispose();
      }
      const p = textPlane(name || 'Floor', { bg: '#0a0a0a', color: '#eeeeee', border: '#ee6018', size: 64, kicker: 'FLOOR' });
      const fit = Math.min(1, (width - 0.3) / (p.geometry.parameters.width || 1));
      p.scale.setScalar(fit);
      p.rotation.x = -Math.PI / 2;
      p.position.set(0, height + 0.005, 0.1);
      shaft.add(p);
      plate = p;
    },
  };
}

function buildBalcony(group: THREE.Group) {
  const B = BALCONY;
  const w = B.maxX - B.minX;
  const d = B.maxZ - B.minZ;
  const cx = (B.minX + B.maxX) / 2;
  const cz = (B.minZ + B.maxZ) / 2;
  // Decking: dark planks running east-west.
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = Math.round((1024 * d) / w);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#2b2622';
  ctx.fillRect(0, 0, c.width, c.height);
  const plank = c.height / 16;
  for (let i = 0; i < 16; i++) {
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,.025)' : 'rgba(0,0,0,.12)';
    ctx.fillRect(0, i * plank, c.width, plank - 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const deck = new THREE.MeshToonMaterial({ map: tex, gradientMap: (toon('#fff') as THREE.MeshToonMaterial).gradientMap });
  const top = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), deck);
  top.position.set(cx, 0.002, cz);
  top.receiveShadow = true;
  group.add(top);
  group.add(mesh(box(w, 0.3, d), toon('#141414'), cx, -0.15, cz));
  for (const [len, x, z, rot] of [
    [w, cx, B.maxZ - 0.03, 0],
    [d, B.minX + 0.03, cz, Math.PI / 2],
    [d, B.maxX - 0.03, cz, Math.PI / 2],
  ] as const) {
    const r = glassWall(len, 1.05);
    r.position.set(x, 0, z);
    r.rotation.y = rot;
    group.add(r);
  }
  // Festoon bulbs along the railing, warm white with an orange one now and then.
  const warm = glow('#ffd9a0', 1.6);
  const orange = glow('#ef6f2e', 1.6);
  const bulb = new THREE.SphereGeometry(0.05, 8, 6);
  for (let i = 0; i <= 26; i++) {
    const x = B.minX + 0.2 + ((w - 0.4) * i) / 26;
    group.add(mesh(bulb, i % 4 === 3 ? orange : warm, x, 1.16 + Math.sin((i / 26) * Math.PI * 6) * 0.03, B.maxZ - 0.03));
  }
  const bench = new THREE.Group();
  bench.name = 'balcony-bench';
  bench.add(mesh(roundedBox(2, 0.08, 0.46, 0.05), toon('#3a3a3a'), 0, 0.45, 0));
  bench.position.set(-9, 0, B.minZ + 0.3);
  group.add(bench);
  const tx = 0.2;
  const tz = cz + 0.2;
  const table = new THREE.Group();
  table.name = 'balcony-table';
  table.add(mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.04, 20), toon('#3a3a3a'), 0, 0.74, 0));
  table.position.set(tx, 0, tz);
  group.add(table);
  for (const sx of [-1, 1]) {
    const stool = new THREE.Group();
    stool.name = sx < 0 ? 'balcony-stool-1' : 'balcony-stool-2';
    stool.userData.seatColor = sx < 0 ? '#505050' : ACCENT;
    stool.add(mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.06, 16), toon('#505050'), 0, 0.46, 0));
    stool.position.set(tx + sx * 0.8, 0, tz);
    group.add(stool);
  }
}

/** Glass floor-to-cut panes in a window's opening, with a mullion either side. */
function windowPane(width: number): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(box(width, CUT, 0.04), basic('#8fb8ff', 0.16, { side: THREE.DoubleSide })));
  g.children[0].position.y = CUT / 2;
  for (const s of [-1, 1]) g.add(mesh(box(0.08, CUT + 0.02, WALL_T + 0.02), toon('#2a2a2a'), (s * width) / 2, (CUT + 0.02) / 2, 0));
  // A pale sill line, catching the sky.
  g.add(mesh(box(width, 0.03, WALL_T * 0.6), glow('#cfe0ff', 0.55), 0, CUT, 0));
  return g;
}

export function buildFloorMap(): FloorMap {
  const group = new THREE.Group();
  group.name = 'floor-map';
  const seats = new Map<string, MapSeat>();
  const hits: THREE.Mesh[] = [];
  const updates: ((t: number, dt: number) => void)[] = [];
  let palette: FloorPalette | undefined;
  let bottom = true;

  // The slab, its polished top, and the building under it falling away into the dark.
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const floorTex = new THREE.CanvasTexture(canvas);
  floorTex.colorSpace = THREE.SRGBColorSpace;
  floorTex.anisotropy = ANISOTROPY;
  const floorMat = new THREE.MeshToonMaterial({ map: floorTex, gradientMap: (toon('#fff') as THREE.MeshToonMaterial).gradientMap });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR.maxX - FLOOR.minX, FLOOR.maxZ - FLOOR.minZ).rotateX(-Math.PI / 2), floorMat);
  floor.position.set((FLOOR.minX + FLOOR.maxX) / 2, 0, (FLOOR.minZ + FLOOR.maxZ) / 2);
  floor.receiveShadow = true;
  group.add(floor);
  const outW = FLOOR.maxX - FLOOR.minX + WALL_T * 2;
  const outD = FLOOR.maxZ - FLOOR.minZ + WALL_T * 2;
  const slabMat = toonUnique('#1a1a1a');
  // Its top stops just under the floor's plane, which would otherwise flicker against it.
  group.add(mesh(box(outW, 0.36, outD), slabMat, 0, -0.19, 0));
  // The storey below, dark glass and steel, fading into the void.
  const below = new THREE.Group();
  const towerGeo = box(outW - 0.4, 4.2, outD - 0.4);
  const colors: number[] = [];
  const pos = towerGeo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const k = THREE.MathUtils.clamp((pos.getY(i) + 2.1) / 4.2, 0, 1);
    const c = new THREE.Color('#030303').lerp(new THREE.Color('#141518'), k);
    colors.push(c.r, c.g, c.b);
  }
  towerGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  below.add(mesh(towerGeo, new THREE.MeshBasicMaterial({ vertexColors: true }), 0, -2.46, 0));
  group.add(below);
  // The glowing hairline round the slab's edge, in the floor's trim.
  const edgeMat = glow(ACCENT, 1);
  for (const [w, d, x, z] of [
    [outW, 0.03, 0, -outD / 2],
    [outW, 0.03, 0, outD / 2],
    [0.03, outD, -outW / 2, 0],
    [0.03, outD, outW / 2, 0],
  ])
    group.add(mesh(box(w, 0.025, d), edgeMat, x, -0.03, z));

  // Walls cut down to waist height: solid stretches, window glass and doorways.
  const wallMat = toonUnique('#3a3a3a');
  const capMat = toonUnique(ACCENT);
  const walls = new THREE.Group();
  const exitPlug = new THREE.Group();
  const exitGap = new THREE.Group();
  const openings = [...WINDOWS.filter((o) => o.y0 < LOFT.y), BALCONY_DOOR, EXIT_DOOR];
  for (const side of ['north', 'south', 'west', 'east'] as const) {
    for (const s of spans(side, openings)) {
      const len = s.u1 - s.u0;
      const u = (s.u0 + s.u1) / 2;
      const isExit = side === EXIT_DOOR.wall && Math.abs(u - EXIT_DOOR.u) < 0.01;
      if (s.kind === 'solid' || isExit) {
        const g = new THREE.Group();
        g.add(mesh(box(len, CUT, WALL_T), wallMat, 0, CUT / 2, 0));
        g.add(mesh(box(len, 0.045, WALL_T + 0.02), capMat, 0, CUT + 0.022, 0));
        placeOnWall(g, side, u, 0);
        (isExit ? exitPlug : walls).add(g);
      } else if (s.kind === 'glass') {
        const g = windowPane(len);
        placeOnWall(g, side, u, 0);
        walls.add(g);
      }
      if (isExit) {
        // The door frame and its EXIT light.
        const g = new THREE.Group();
        for (const sgn of [-1, 1]) g.add(mesh(box(0.1, CUT + 0.1, WALL_T + 0.04), toon('#2a2a2a'), (sgn * len) / 2, (CUT + 0.1) / 2, 0));
        g.add(mesh(box(len * 0.6, 0.06, 0.06), glow('#3ccf91', 1.4), 0, CUT + 0.08, 0));
        placeOnWall(g, side, u, 0);
        exitGap.add(g);
      }
    }
  }
  group.add(walls, exitPlug, exitGap);

  // The boards, screens and walls of light, as plates on top of the cut walls.
  const gitBoards: THREE.Object3D[] = [];
  const boardColors: Record<'issues' | 'actions' | 'pulls', string> = { issues: STATION_AGENT.issues.color, actions: STATION_AGENT.actions.color, pulls: STATION_AGENT.pulls.color };
  for (const key of ['issues', 'actions', 'pulls'] as const) {
    const b = BOARDS[key];
    const plate = wallPlate(b.label, boardColors[key], b.width);
    placeOnWall(plate, 'north', b.x, CUT + 0.045);
    plate.rotation.y = 0;
    group.add(plate);
    gitBoards.push(plate);
  }
  const ci = wallPlate('FACTORY CI', ACCENT, BOARDS.ci.width);
  placeOnWall(ci, 'north', BOARDS.ci.x, CUT + 0.045);
  group.add(ci);
  gitBoards.push(ci);
  for (const [text, color, length, z] of [
    ['WHITEBOARD', '#f2f2f2', BOARDS.whiteboard.width, BOARDS.whiteboard.z],
    ['TV', '#5aa9e6', TV.width, TV.z],
  ] as const) {
    const plate = wallPlate(text, color, length);
    placeOnWall(plate, 'east', z, CUT + 0.045);
    plate.rotation.y = Math.PI / 2;
    group.add(plate);
  }
  {
    const plate = wallPlate('COMPUTE', '#3ccf91', COMPUTE_WALL.width);
    placeOnWall(plate, 'west', COMPUTE_WALL.z, CUT + 0.045);
    plate.rotation.y = -Math.PI / 2;
    group.add(plate);
  }

  // Desks, bean bags and the board agents' kiosks.
  const desks: THREE.Group[] = [];
  const chairs: THREE.Group[] = [];
  DESKS.forEach((def, i) => {
    const s = buildDesk(def, i);
    seats.set(def.id, s);
    desks.push(s.group);
    if (s.chair) {
      chairs.push(s.chair);
      // An empty chair is pushed back and turned a little, the way people leave them.
      s.chair.rotation.y = (((i * 37) % 11) - 5) * 0.06;
    }
    group.add(s.group);
    hits.push(s.hit);
  });
  BEANBAGS.forEach((def, i) => {
    const s = buildBeanbag(def, i);
    seats.set(def.id, s);
    group.add(s.group);
    hits.push(s.hit);
  });
  const kiosks: THREE.Group[] = [];
  for (const def of STATIONS) {
    const s = buildKiosk(def);
    seats.set(def.id, s);
    kiosks.push(s.group);
    group.add(s.group);
    hits.push(s.hit);
    if (def.station !== 'lead') gitBoards.push(s.group);
  }

  buildLounge(group);
  buildGlassRoomAndLoft(group, chairs);
  const elevator = buildElevator(group);
  buildBalcony(group);

  {
    const ladder = new THREE.Group();
    const steel = toon('#7a7a7a', { finish: 'metal' });
    const tall = CUT + 0.7;
    for (const s of [-1, 1]) ladder.add(mesh(box(0.05, tall, 0.05), steel, 0, tall / 2, (s * LADDER.width) / 2));
    for (let y = 0.3; y < tall; y += 0.3) ladder.add(mesh(box(0.04, 0.03, LADDER.width), steel, 0, y, 0));
    ladder.position.set(FLOOR.minX + 0.12, 0, LADDER.z);
    group.add(mergeByMaterial(ladder));
  }

  // The Droid Computer rack, the gong, the bookshelf and the jukebox.
  const rack = new THREE.Group();
  rack.name = 'droid-rack-frame';
  rack.add(mesh(box(DROID_RACK.maxX - DROID_RACK.minX, 0.14, DROID_RACK.maxZ - DROID_RACK.minZ), toon('#1c1c1c'), (DROID_RACK.minX + DROID_RACK.maxX) / 2, 0.07, (DROID_RACK.minZ + DROID_RACK.maxZ) / 2));
  group.add(rack);
  const gong = new THREE.Group();
  gong.position.set(GONG.x, 0, GONG.z);
  gong.add(mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.06, 32).rotateX(Math.PI / 2), toon('#b8862d', { finish: 'metal' }), 0, 1.3, 0));
  group.add(gong);
  const shelf = new THREE.Group();
  shelf.position.set(BOOKSHELF.x, 0, BOOKSHELF.z);
  shelf.rotation.y = Math.PI;
  shelf.add(mesh(box(BOOKSHELF.width, BOOKSHELF.height * 0.6, BOOKSHELF.depth), toon('#262626'), 0, BOOKSHELF.height * 0.3, 0));
  group.add(shelf);
  const juke = new THREE.Group();
  juke.position.set(JUKEBOX.x, 0, JUKEBOX.z);
  juke.rotation.y = -Math.PI / 2;
  juke.add(mesh(roundedBox(JUKEBOX.width, JUKEBOX.height * 0.8, JUKEBOX.depth, 0.2), toon('#222222'), 0, JUKEBOX.height * 0.4, 0));
  juke.add(mesh(box(JUKEBOX.width * 0.7, 0.05, 0.03), glow(ACCENT, 1.6), 0, JUKEBOX.height * 0.6, JUKEBOX.depth / 2 + 0.02));
  group.add(juke);

  const paint = () => {
    if (!palette) return;
    paintFloor(ctx, palette, bottom);
    floorTex.needsUpdate = true;
  };

  const swapTo = (node: THREE.Group, name: string, place: { x?: number; z?: number; rotY?: number; scale?: number } = {}) => {
    const model = prop(name, { x: place.x, z: place.z, rotY: place.rotY, scale: place.scale });
    if (!model) return false;
    toonifyProp(model);
    node.clear();
    node.add(model);
    return true;
  };

  let installed = false;
  return {
    group,
    seats,
    hits,
    setLook(p) {
      if (palette?.name === p.name) return;
      palette = p;
      wallMat.color.set(shade(p.wall, 0.42));
      slabMat.color.set(shade(p.wall, 0.2));
      // The office's trim is the floor's one bright mark; the darker trims still read as a line on the cut.
      const trim = new THREE.Color(p.trim);
      capMat.color.copy(trim);
      capMat.emissive.copy(trim).multiplyScalar(0.25);
      edgeMat.color.copy(trim).multiplyScalar(p.trim === ACCENT ? 1 : 1.6);
      paint();
    },
    setPlain(plain) {
      for (const o of gitBoards) o.visible = !plain;
      for (const s of seats.values()) if (s.def.station && s.def.station !== 'lead') s.hit.visible = !plain;
    },
    setBottom(b) {
      if (b === bottom && palette) return;
      bottom = b;
      exitPlug.visible = !b;
      exitGap.visible = b;
      paint();
    },
    setBeanbags(out) {
      for (const def of BEANBAGS) {
        const s = seats.get(def.id)!;
        s.group.visible = out.has(def.id);
      }
    },
    setName(name) {
      elevator.setName(name);
    },
    installProps() {
      if (installed) return;
      const workbench = propScene('workbench');
      if (!workbench) return;
      installed = true;
      installWorkbenches(workbench, desks);
      const chair = propScene('task-chair');
      if (chair) installTaskChairs(chair, chairs);
      const kiosk = propScene('agent-kiosk');
      if (kiosk) installAgentKiosks(kiosk, kiosks);
      const steps: [string, (source: THREE.Object3D, office: THREE.Object3D) => unknown][] = [
        ['lounge-sofa', installLoungeSofa],
        ['lounge-table', installLoungeTable],
        ['lounge-beanbag', installLoungeBeanbags],
        ['conference-table', installConferenceTable],
        ['droid-rack', installDroidRack],
        ['balcony-bench', installBalconyBench],
        ['balcony-stool', installBalconyStools],
        ['balcony-table', installBalconyTable],
        ['loft-couch', installLoftCouch],
        ['executive-desk', installExecutiveDesk],
        ['loft-stairs', installLoftStairs],
      ];
      for (const [name, install] of steps) {
        const source = propScene(name);
        if (source) install(source, group);
      }
      swapTo(gong, 'merge-gong');
      swapTo(shelf, 'bookshelf');
      swapTo(juke, 'jukebox');
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || m === floor) return;
        const mat = Array.isArray(m.material) ? m.material[0] : m.material;
        if (mat instanceof THREE.MeshToonMaterial && !mat.transparent) {
          m.castShadow = true;
          m.receiveShadow = true;
        }
      });
    },
    update(t, dt) {
      for (const u of updates) u(t, dt);
    },
  };
}
