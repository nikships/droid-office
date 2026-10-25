// Where a visiting worker is along its walk, as plain numbers (see visitors.ts for the scene side and
// shared/visits.ts for the route and the timing the server keeps).

import { VISIT_HOP_MS, VISIT_WALK_SPEED, type VisitPhase } from '../../shared/visits';

export { routeLength } from '../../shared/visits';

type Pt = readonly [number, number];

/**
 * A visitor's progress is one number: -1 in its own seat, -1..0 getting up (or sitting back down)
 * beside it, and 0..length metres along its route to the host's desk, `length` being on its spot.
 */
export const SEATED = -1;

/** How much faster than walking pace a visitor may go to catch up with where the server's clock says it is. */
export const CATCH_UP = 1.5;

const HOP_S = VISIT_HOP_MS / 1000;

/**
 * Where the server's timing puts a visitor `elapsedMs` into `phase` on a route `length` metres long:
 * getting up then walking over, standing on its spot, or walking back then sitting down. No visit
 * (null) is back in its seat.
 */
export function visitProgress(phase: VisitPhase | null, elapsedMs: number, length: number): number {
  const s = Math.max(0, elapsedMs) / 1000;
  switch (phase) {
    case 'walking':
      if (s < HOP_S) return SEATED + s / HOP_S;
      return Math.min(length, (s - HOP_S) * VISIT_WALK_SPEED);
    case 'reading':
    case 'talking':
    case 'waiting':
      return length;
    case 'returning': {
      const walked = s * VISIT_WALK_SPEED;
      if (walked < length) return length - walked;
      return Math.max(SEATED, -(s - length / VISIT_WALK_SPEED) / HOP_S);
    }
    default:
      return SEATED;
  }
}

/**
 * Moves progress `u` toward `target` for `dt` seconds, no faster than CATCH_UP times the walk (and the
 * hop), so it never jumps: along the route, then on or off the seat.
 */
export function stepProgress(u: number, target: number, dt: number, length: number): number {
  let left = Math.max(0, dt);
  for (let guard = 0; guard < 3 && left > 0 && u !== target; guard++) {
    const down = target < u;
    const hop = u < 0 || (u === 0 && down);
    // In the hop, a unit of progress is the whole hop; on the route it's a metre.
    const rate = hop ? CATCH_UP / HOP_S : CATCH_UP * VISIT_WALK_SPEED;
    const end = hop ? (down ? Math.max(target, SEATED) : Math.min(target, 0)) : down ? Math.max(target, 0) : Math.min(target, length);
    const need = Math.abs(end - u) / rate;
    if (need <= left) {
      u = end;
      left -= need;
    } else {
      u += (down ? -1 : 1) * rate * left;
      left = 0;
    }
  }
  return u;
}

/** A point on a route and the way along it there (rotation round y, 0 facing +z, as a worker's model faces). */
export interface RoutePoint {
  x: number;
  z: number;
  heading: number;
}

/** Writes the point `s` metres along `path` into `out`, clamped to its ends. */
export function pointAlong(path: readonly Pt[], s: number, out: RoutePoint): RoutePoint {
  if (!path.length) {
    out.x = out.z = 0;
    return out;
  }
  let left = Math.max(0, s);
  for (let i = 1; i < path.length; i++) {
    const [x0, z0] = path[i - 1];
    const [x1, z1] = path[i];
    const d = Math.hypot(x1 - x0, z1 - z0);
    if (d < 1e-9) continue;
    out.heading = Math.atan2(x1 - x0, z1 - z0);
    if (left <= d) {
      out.x = x0 + (x1 - x0) * (left / d);
      out.z = z0 + (z1 - z0) * (left / d);
      return out;
    }
    left -= d;
  }
  const [x, z] = path[path.length - 1];
  out.x = x;
  out.z = z;
  return out;
}

/** Longest a line said on a visit gets over a worker's head, in characters. */
export const SAY_MAX = 140;

const ESC = 0x1b;
const BEL = 0x07;

/** `text` with terminal escape sequences dropped and every other control character turned into a space. */
function printable(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === ESC) {
      const kind = text[i + 1];
      i++;
      if (kind === '[') {
        // CSI: parameters, then one final byte from @ to ~.
        while (i + 1 < text.length && !/[@-~]/.test(text[i + 1])) i++;
        i++;
      } else if (kind === ']') {
        // OSC: up to BEL or ESC \.
        while (i + 1 < text.length && text.charCodeAt(i + 1) !== BEL && text.charCodeAt(i + 1) !== ESC) i++;
        if (text.charCodeAt(i + 1) === BEL) i++;
        else if (text.charCodeAt(i + 1) === ESC && text[i + 2] === '\\') i += 2;
      }
      continue;
    }
    out += c < 0x20 || c === 0x7f ? ' ' : text[i];
  }
  return out;
}

/**
 * A line said on a visit, as its speech card shows it: on one line, with escape codes and control
 * characters out, and cut at a word near `max` characters with "…".
 */
export function trimSay(text: string, max = SAY_MAX): string {
  const flat = printable(text).replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  const kept = space > cut.length * 0.6 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s,.;:—-]+$/u, '')}…`;
}

/** How long a line stays up, in seconds: long enough to read, and no longer than a few breaths. */
export function sayFor(text: string): number {
  return Math.min(9, 2.5 + Array.from(text).length * 0.05);
}
