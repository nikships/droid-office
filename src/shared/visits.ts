// Workers visiting each other's desks (see server/visits.ts): who is where, and where a visitor stands
// and walks. The server times each phase by the same walk the client shows.

import { DESK_BY_ID, DESK_LAPTOP, KIOSK, type DeskDef } from './layout.js';
import { deskPoint, nearestWalkable, wayTo, walkable, type Pt } from './nav.js';

export type VisitKind = 'look' | 'tell' | 'ask' | 'handoff';

/**
 * walking: on its way to the host's desk. reading: leaning over the host's laptop. talking: standing at
 * the desk while its message is delivered. waiting: standing at the desk for an answer. returning: walking
 * back to its own desk. A visit leaves the list once it has walked back.
 */
export type VisitPhase = 'walking' | 'reading' | 'talking' | 'waiting' | 'returning';

export interface Visit {
  id: string;
  /** The visiting worker's id. */
  visitor: string;
  /** The visited worker's id. */
  host: string;
  kind: VisitKind;
  phase: VisitPhase;
  /** Its place among the visitors at the host's desk, 0 first, so two visitors never stand on one spot. */
  slot: number;
  /** When the current phase began (ms since epoch, the office's clock). */
  since: number;
  /** Returning after an interrupted outbound walk: time back to the seat from the turn-around point. */
  returnMs?: number;
}

export const VISIT_KINDS: readonly VisitKind[] = ['look', 'tell', 'ask', 'handoff'];
export const VISIT_PHASES: readonly VisitPhase[] = ['walking', 'reading', 'talking', 'waiting', 'returning'];

/** Walking speed in m/s, the server's timing and the client's walk alike: an errand, not a stroll. */
export const VISIT_WALK_SPEED = 1.6;
/** Getting up off the chair at the start of a walk, or sitting back down at the end of one. */
export const VISIT_HOP_MS = 550;

/**
 * Where visitors stand round each kind of seat, in the seat's own frame (`deskPoint`'s t along it, s
 * out toward the worker's side), slot by slot. The first two flank the worker, close enough to lean
 * over its laptop; the rest wait a step further back.
 */
const DESK_SPOTS: readonly Pt[] = [
  [0.85, 1.05],
  [-0.85, 1.05],
  [0.85, 1.75],
  [-0.85, 1.75],
];
const BEANBAG_SPOTS: readonly Pt[] = [
  [1.05, 0.1],
  [-1.05, 0.1],
  [1.05, 1.25],
  [-1.05, 1.25],
];
const KIOSK_SPOTS: readonly Pt[] = [
  [0.95, KIOSK.stand],
  [-0.95, KIOSK.stand],
  [0.95, -1],
  [-0.95, -1],
];
/** Past the spots above, each further visitor waits this much further back than the last pair. */
const QUEUE_STEP = 0.7;

function spotsFor(d: DeskDef): readonly Pt[] {
  return d.beanbag ? BEANBAG_SPOTS : d.station ? KIOSK_SPOTS : DESK_SPOTS;
}

/** What the visitor leans over: the laptop on a desk, the kiosk's top, the lap desk on a bean bag. */
function screenOf(d: DeskDef): Pt {
  if (d.station) return deskPoint(d, 0, 0);
  if (d.beanbag) return deskPoint(d, 0, -0.35);
  return deskPoint(d, 0, DESK_LAPTOP.z);
}

/** The heading that faces from `from` toward `to`, by the office's convention (rotY 0 faces -z). */
function facing(from: Pt, to: Pt): number {
  return Math.atan2(-(to[0] - from[0]), -(to[1] - from[1]));
}

/**
 * Where a visitor stands at the host's desk for its slot (beside the host, facing the laptop). Slots
 * past the seat's own spots queue further back, alternating sides. A spot something stands on (a seat
 * up against a wall) moves to the nearest open floor.
 */
export function visitSpot(hostDeskId: string, slot: number): { x: number; z: number; rotY: number } {
  const d = DESK_BY_ID.get(hostDeskId);
  if (!d) return { x: 0, z: 0, rotY: 0 };
  const n = Math.max(0, Math.floor(slot));
  // Each slot's spot depends on the ones before it, so a moved spot never lands on an earlier one.
  const taken: Pt[] = [];
  for (let i = 0; i <= n; i++) taken.push(openNear(seatSpot(d, i), taken));
  const p = taken[n];
  return { x: p[0], z: p[1], rotY: facing(p, screenOf(d)) };
}

/** Slot `n`'s spot round `d` as laid out, before checking anything stands there. */
function seatSpot(d: DeskDef, n: number): Pt {
  const spots = spotsFor(d);
  let [t, s] = spots[Math.min(n, spots.length - 1)];
  if (n >= spots.length) {
    // Alternating sides like the pairs before, a step further back for each pair.
    const extra = n - spots.length;
    t = spots[extra % 2][0];
    s += (Math.floor(extra / 2) + 1) * QUEUE_STEP * (d.station ? -1 : 1);
  }
  return deskPoint(d, t, s);
}

/** How far apart two visitors stand, at the least. */
const ELBOW_ROOM = 0.6;

/** `p`, or the nearest open floor to it that keeps ELBOW_ROOM from every spot in `taken`. */
function openNear(p: Pt, taken: readonly Pt[]): Pt {
  const free = (q: Pt) => walkable(q[0], q[1]) && taken.every((o) => Math.hypot(o[0] - q[0], o[1] - q[1]) >= ELBOW_ROOM);
  if (free(p)) return p;
  for (let ring = 1; ring <= 16; ring++) {
    const r = ring * 0.25;
    let best: Pt | undefined;
    let bestD = Infinity;
    for (let k = 0; k < 16; k++) {
      const q: Pt = [p[0] + Math.cos((k / 16) * Math.PI * 2) * r, p[1] + Math.sin((k / 16) * Math.PI * 2) * r];
      const dist = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (free(q) && dist < bestD) {
        best = q;
        bestD = dist;
      }
    }
    if (best) return best;
  }
  return nearestWalkable(p);
}

/**
 * The path a visitor walks from its own desk to its spot at the host's desk (via nav.route): off its
 * chair, round the furniture, and the last step onto the spot. Walking back is the same path reversed.
 */
export function visitRoute(visitorDeskId: string, hostDeskId: string, slot: number): [number, number][] {
  const from = DESK_BY_ID.get(visitorDeskId);
  const spot = visitSpot(hostDeskId, slot);
  const end: Pt = [spot.x, spot.z];
  if (!from) return [end];
  const pts = wayTo(from, end);
  const last = pts[pts.length - 1];
  if (!last || Math.hypot(last[0] - end[0], last[1] - end[1]) > 1e-6) pts.push(end);
  return pts;
}

/** How long a route is, in metres. */
export function routeLength(path: readonly (readonly [number, number])[]): number {
  let m = 0;
  for (let i = 1; i < path.length; i++) m += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  return m;
}

/** How long a route takes at VISIT_WALK_SPEED, with getting up (or sitting back down) at its end. */
export function visitWalkMs(path: readonly [number, number][]): number {
  return Math.round((routeLength(path) / VISIT_WALK_SPEED) * 1000) + VISIT_HOP_MS;
}
