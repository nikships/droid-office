import { BALCONY, DESK_BY_ID, FLOOR, KIOSK, deskSeat, type DeskDef } from '../shared/layout';

/**
 * The web companion's office map (office-map.ts) as plain numbers: where each seat's worker is, how
 * far back the camera stands to show the whole floor, and which worker the arrow keys go to next.
 * Nothing here touches the DOM or WebGL, so tests load it in Node.
 */

/** Where the camera looks from: the point on the floor it aims at, how far back it is, and its angles. */
export interface MapView {
  x: number;
  z: number;
  /** Metres from the target to the camera. */
  distance: number;
  /** Turned around +y from looking north (the camera south of its target, the way the office's boards face). */
  yaw: number;
  /** Up from the horizon: π/2 looks straight down. */
  pitch: number;
}

/** The whole floor and its balcony, the box the home view frames. */
export const MAP_BOUNDS = { minX: FLOOR.minX - 0.6, maxX: FLOOR.maxX + 0.6, minZ: FLOOR.minZ - 0.6, maxZ: BALCONY.maxZ + 0.4 } as const;
/** A three-quarter view from the south, a little to the west: the boards at the back, the desks facing you. */
export const HOME_PITCH = 0.98;
export const HOME_YAW = -0.16;
export const MAP_FOV = 30;
/** How close the camera may come, and how far back it may go, as a multiple of the home distance. */
export const MIN_DISTANCE = 4.5;
export const MAX_ZOOM_OUT = 1.6;
/** Flying in to a worker: how far back, and how steeply. */
export const FOCUS_DISTANCE = 6.2;
export const FOCUS_PITCH = 0.82;

/** Where a seat's worker is, and how high its head is above the floor. */
export interface SeatSpot {
  x: number;
  z: number;
  head: number;
  kind: 'desk' | 'beanbag' | 'station';
}

/** Where the worker at `deskId` sits (or stands, at a kiosk), the way the 3D office seats it. */
export function seatSpot(deskId: string): SeatSpot | undefined {
  const def = DESK_BY_ID.get(deskId);
  return def ? spotOf(def) : undefined;
}

function spotOf(def: DeskDef): SeatSpot {
  if (def.beanbag) return { x: def.x, z: def.z, head: 1.15, kind: 'beanbag' };
  if (def.station) {
    const p = deskSeat(def, KIOSK.stand);
    return { x: p.x, z: p.z, head: 1.3, kind: 'station' };
  }
  const p = deskSeat(def, 0.93);
  return { x: p.x, z: p.z, head: 1.4, kind: 'desk' };
}

/** Where `p` lands on screen for a camera at `view` (fov MAP_FOV, `aspect`): -1..1 across and up, like three's NDC; `depth` is metres in front of the camera. */
export function projectPoint(view: MapView, aspect: number, p: { x: number; y: number; z: number }): { x: number; y: number; depth: number } {
  const cam = cameraAt(view);
  // The camera's forward, right and up, from its yaw and pitch.
  const f = { x: -Math.sin(view.yaw) * Math.cos(view.pitch), y: -Math.sin(view.pitch), z: -Math.cos(view.yaw) * Math.cos(view.pitch) };
  const r = { x: Math.cos(view.yaw), y: 0, z: -Math.sin(view.yaw) };
  const u = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x };
  const d = { x: p.x - cam.x, y: p.y - cam.y, z: p.z - cam.z };
  const depth = d.x * f.x + d.y * f.y + d.z * f.z;
  const tanV = Math.tan((MAP_FOV * Math.PI) / 360);
  return { x: (d.x * r.x + d.z * r.z) / depth / (tanV * aspect), y: (d.x * u.x + d.y * u.y + d.z * u.z) / depth / tanV, depth };
}

/** How tall the box `frameView` fits is: the walls' cut-away tops and the workers' heads stay in frame. */
const FRAME_HEIGHT = 1.5;

/**
 * The view at `yaw` and `pitch` that fits the floor box `bounds` (and FRAME_HEIGHT above it) on a
 * screen of `aspect`, centred, with `margin` to spare (1.06 leaves 6% round the edge).
 */
export function frameView(bounds: { minX: number; maxX: number; minZ: number; maxZ: number }, aspect: number, yaw = HOME_YAW, pitch = HOME_PITCH, margin = 1.06): MapView {
  const corners: { x: number; y: number; z: number }[] = [];
  for (const x of [bounds.minX, bounds.maxX]) for (const z of [bounds.minZ, bounds.maxZ]) for (const y of [0, FRAME_HEIGHT]) corners.push({ x, y, z });
  const tanV = Math.tan((MAP_FOV * Math.PI) / 360);
  const v: MapView = { x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2, distance: Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) * 1.5, yaw, pitch };
  // Re-aim at the middle of what's on screen and scale the distance to the extent, until it settles.
  for (let i = 0; i < 60; i++) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const c of corners) {
      const p = projectPoint(v, aspect, c);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const across = cx * v.distance * tanV * aspect;
    const along = (cy * v.distance * tanV) / Math.sin(pitch);
    v.x += Math.cos(yaw) * across - Math.sin(yaw) * along;
    v.z += -Math.sin(yaw) * across - Math.cos(yaw) * along;
    v.distance *= Math.max((maxX - minX) / 2, (maxY - minY) / 2) * margin;
  }
  return v;
}

/** The view that shows the whole floor in a viewport of `aspect`. */
export function homeView(aspect: number): MapView {
  return frameView(MAP_BOUNDS, Math.max(0.2, aspect));
}

/** Flying in to the worker at `spot`, keeping the way the camera faces now. */
export function focusView(spot: SeatSpot, yaw: number): MapView {
  // Aim past the seat, away from the camera: the worker's middle, a metre up, lands mid-screen.
  const back = 1 / Math.tan(FOCUS_PITCH);
  return { x: spot.x - Math.sin(yaw) * back, z: spot.z - Math.cos(yaw) * back, distance: FOCUS_DISTANCE, yaw, pitch: FOCUS_PITCH };
}

/** The camera's position for a view, in world space. */
export function cameraAt(view: MapView, targetY = 0): { x: number; y: number; z: number } {
  const flat = Math.cos(view.pitch) * view.distance;
  return { x: view.x + Math.sin(view.yaw) * flat, y: targetY + Math.sin(view.pitch) * view.distance, z: view.z + Math.cos(view.yaw) * flat };
}

/** The view a camera at `cam` aiming at `target` has. */
export function viewOf(cam: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }): MapView {
  const dx = cam.x - target.x;
  const dy = cam.y - target.y;
  const dz = cam.z - target.z;
  const distance = Math.hypot(dx, dy, dz);
  return { x: target.x, z: target.z, distance, yaw: Math.atan2(dx, dz), pitch: Math.asin(Math.min(1, Math.max(-1, dy / (distance || 1)))) };
}

/** The shortest way round from angle `a` to angle `b`. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Part way, `t` from 0 to 1, from one view to the next, turning the short way round. */
export function blendView(a: MapView, b: MapView, t: number): MapView {
  const lerp = (x: number, y: number) => x + (y - x) * t;
  return { x: lerp(a.x, b.x), z: lerp(a.z, b.z), distance: lerp(a.distance, b.distance), yaw: a.yaw + angleDelta(a.yaw, b.yaw) * t, pitch: lerp(a.pitch, b.pitch) };
}

/** Eases in and out, for camera flights. */
export function easeInOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2;
}

/** Eases out only, for an arrival that should settle softly. */
export function easeOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) ** 4;
}

/** Keeps the camera's aim on the floor (and its balcony), so a drag never loses the office. */
export function clampTarget(x: number, z: number): { x: number; z: number } {
  return { x: Math.min(MAP_BOUNDS.maxX, Math.max(MAP_BOUNDS.minX, x)), z: Math.min(MAP_BOUNDS.maxZ, Math.max(MAP_BOUNDS.minZ, z)) };
}

export type MapDirection = 'left' | 'right' | 'up' | 'down';

/**
 * The point nearest `from` in `dir` as the screen shows it (the camera turned `yaw`), or undefined
 * when there's nothing that way. Going straight that way counts more than drifting sideways.
 */
export function nearestInDirection<T extends { x: number; z: number }>(from: { x: number; z: number }, dir: MapDirection, points: readonly T[], yaw: number): T | undefined {
  // Screen up is the way the camera looks along the floor; screen right is a quarter turn clockwise of it.
  const up = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
  const axis = dir === 'up' ? up : dir === 'down' ? { x: -up.x, z: -up.z } : dir === 'right' ? right : { x: -right.x, z: -right.z };
  const side = dir === 'up' || dir === 'down' ? right : up;
  let best: T | undefined;
  let bestScore = Infinity;
  for (const p of points) {
    const dx = p.x - from.x;
    const dz = p.z - from.z;
    const along = dx * axis.x + dz * axis.z;
    if (along <= 0.25) continue;
    const across = Math.abs(dx * side.x + dz * side.z);
    const score = along + across * 2.2;
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/** How wide (px) a worker's name tag may be when a metre of floor is `pxPerMeter` across: about a desk's width, never too narrow for a name (tuckedTags settles overlaps). */
export function tagWidth(pxPerMeter: number): number {
  return Math.round(Math.min(220, Math.max(92, pxPerMeter * 2.4)));
}

/** Close enough that every worker's tag can show what it's doing, not just its name. */
export function tagsExpanded(pxPerMeter: number): boolean {
  return pxPerMeter >= 64;
}

/** So far out that only the lit and waiting workers keep their names; the rest show their status dot. */
export function tagsDotsOnly(pxPerMeter: number): boolean {
  return pxPerMeter < 16;
}

/** A name tag on screen: its anchor (bottom centre, px), its size, how far it is (smaller is nearer), and whether it must show. */
export interface TagBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  keep?: boolean;
}

/**
 * Which tags to shrink to their status dot so none covers another: the lit ones and the nearest
 * win, and a farther tag that would hide more than `overlap` of itself under one already shown tucks.
 */
export function tuckedTags(tags: readonly TagBox[], overlap = 0.25): Set<string> {
  const order = [...tags].sort((a, b) => Number(!!b.keep) - Number(!!a.keep) || a.depth - b.depth);
  const shown: TagBox[] = [];
  const tucked = new Set<string>();
  for (const t of order) {
    const l = t.x - t.w / 2;
    const r = t.x + t.w / 2;
    const top = t.y - t.h;
    const hidden = shown.some((o) => {
      const ox = Math.min(r, o.x + o.w / 2) - Math.max(l, o.x - o.w / 2);
      const oy = Math.min(t.y, o.y) - Math.max(top, o.y - o.h);
      return ox > 0 && oy > 0 && ox * oy > overlap * t.w * t.h;
    });
    if (hidden && !t.keep) tucked.add(t.id);
    else shown.push(t);
  }
  return tucked;
}
