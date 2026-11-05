import type { AgentEffort } from './protocol.js';

/**
 * The effort dial every client draws beside a worker's model: a half-circle gauge whose arc and needle
 * sweep a fifth further for each step from Low to Max. Its colour steps from white at Low to Factory
 * orange at Max, evenly in OKLab so neighbouring levels look equally far apart. Android keeps the same
 * numbers in core/EffortDial.kt (tests/effort-dial.test.ts compares them).
 */
export const EFFORT_COLOR: Record<AgentEffort, string> = {
  low: '#ffffff',
  medium: '#ffdacb',
  high: '#fdb497',
  xhigh: '#f78c61',
  max: '#ee6018',
};

const STEP: Record<AgentEffort, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
const STEPS = 5;

/** The dial's drawing box: a 22×12.5 viewBox starting at x −1, the gauge centred on (10, 11). */
export const DIAL_VIEWBOX = [-1, 0, 22, 12.5] as const;
const CX = 10;
const CY = 11;
const R = 8;
const NEEDLE = 5;
const TICK_IN = 9.6;
const TICK_OUT = 10.6;

export interface DialGeometry {
  color: string;
  /** The whole half circle, drawn dim under the arc. */
  track: string;
  /** The filled part, from the left end to the needle. */
  arc: string;
  needle: { x1: number; y1: number; x2: number; y2: number };
  hub: { cx: number; cy: number; r: number };
  /** Six marks at Low's start and each step's end. */
  ticks: { x1: number; y1: number; x2: number; y2: number }[];
}

const round = (n: number) => Math.round(n * 100) / 100;
/** The point `r` from the centre at `deg`, clockwise from the left end (180°) over the top to the right (360°). */
function at(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [round(CX + r * Math.cos(a)), round(CY + r * Math.sin(a))];
}
const arcPath = (from: number, to: number) => {
  const [x0, y0] = at(from, R);
  const [x1, y1] = at(to, R);
  return `M${x0} ${y0}A${R} ${R} 0 0 1 ${x1} ${y1}`;
};

/** How far round the dial an effort sits, 0.2 (Low) to 1 (Max). */
export function effortFraction(effort: AgentEffort): number {
  return STEP[effort] / STEPS;
}

export function dialGeometry(effort: AgentEffort): DialGeometry {
  const end = 180 + effortFraction(effort) * 180;
  const [x2, y2] = at(end, NEEDLE);
  return {
    color: EFFORT_COLOR[effort],
    track: arcPath(180, 360),
    arc: arcPath(180, end),
    needle: { x1: CX, y1: CY, x2, y2 },
    hub: { cx: CX, cy: CY, r: 1.5 },
    ticks: Array.from({ length: STEPS + 1 }, (_, k) => {
      const [tx1, ty1] = at(180 + (k * 180) / STEPS, TICK_IN);
      const [tx2, ty2] = at(180 + (k * 180) / STEPS, TICK_OUT);
      return { x1: tx1, y1: ty1, x2: tx2, y2: ty2 };
    }),
  };
}
