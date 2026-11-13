/**
 * Which floors get a tab in the companions' floor strip. Every floor is scored for how much the owner
 * likely wants it now; the strip then fills, most relevant first, with full-width tabs until the next
 * one would not fit. Mirrored by Android's `core/FloorRelevance.kt`; both are pinned by
 * `android/app/src/test/resources/floor-relevance-golden.json`.
 */

/** What a floor's relevance is scored from. */
export interface FloorSignals {
  /** Workers waiting on the owner: a question, a permission, a finished turn nobody looked at. */
  needsInput: number;
  /** Finished workers the owner hasn't acknowledged yet. */
  unackedDone: number;
  /** Workers mid-turn. */
  busy: number;
  /** Workers on the floor now, at any status. */
  totalWorkers: number;
  /** When the owner last went to the floor. */
  lastVisitedAt?: number;
  /** When the floor last had a worker. */
  lastWorkerAt?: number;
  /** Workers ever hired there. */
  hires?: number;
}

const HOUR_MS = 3_600_000;
/** How long until a visit counts half as much (then a third, a quarter…: old visits still order floors). */
export const VISIT_HALF_LIFE_MS = 24 * HOUR_MS;
/** How long until a floor's last worker counts half as much. */
export const WORKER_HALF_LIFE_MS = 72 * HOUR_MS;

/** Counts past these add nothing more: ten waiting workers aren't twice as urgent as five. */
const CAP = { needsInput: 5, unackedDone: 5, busy: 5, totalWorkers: 5, hires: 1023 } as const;
const WEIGHT = { needsInput: 1000, unackedDone: 500, busy: 300, totalWorkers: 200, visit: 120, worker: 80, hires: 7 } as const;

function count(n: number | undefined, cap: number): number {
  return Number.isFinite(n) && (n as number) > 0 ? Math.min(Math.floor(n as number), cap) : 0;
}

/** 1 for now, ½ after `halfLife`, ⅓ after two…; 0 when never. */
function recency(at: number | undefined, now: number, halfLife: number): number {
  if (at === undefined || !Number.isFinite(at) || at <= 0) return 0;
  return 1 / (1 + Math.max(0, now - at) / halfLife);
}

/**
 * How relevant a floor is now: a blend where a worker waiting on the owner weighs most, then finished
 * and working ones, then any worker there at all, then history (a recent visit, then a recent worker,
 * then how many it ever hired, which together stay just under one idle worker's weight).
 * A staffed floor's last worker is now. Rounded so Android's port matches it exactly.
 */
export function floorRelevance(s: FloorSignals, now: number): number {
  const staffed = count(s.totalWorkers, CAP.totalWorkers);
  const score =
    count(s.needsInput, CAP.needsInput) * WEIGHT.needsInput +
    count(s.unackedDone, CAP.unackedDone) * WEIGHT.unackedDone +
    count(s.busy, CAP.busy) * WEIGHT.busy +
    staffed * WEIGHT.totalWorkers +
    recency(s.lastVisitedAt, now, VISIT_HALF_LIFE_MS) * WEIGHT.visit +
    (staffed > 0 ? 1 : recency(s.lastWorkerAt, now, WORKER_HALF_LIFE_MS)) * WEIGHT.worker +
    Math.log2(1 + count(s.hires, CAP.hires)) * WEIGHT.hires;
  return Math.round(score * 1000) / 1000;
}

/** Ids from most to least relevant; equal scores keep the building's order. */
export function rankFloors(floors: readonly ({ id: string } & FloorSignals)[], now: number): string[] {
  return floors
    .map((f, index) => ({ id: f.id, index, score: floorRelevance(f, now) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((f) => f.id);
}

export interface TabFit {
  /** Floors with a tab, in the order given (the building's). */
  shown: string[];
  /** Floors left for the "+N more" menu, most relevant first. */
  hidden: string[];
}

/**
 * Picks the tabs that fit `available` pixels. Every tab fitting needs no "+N more" button; otherwise
 * `more` pixels are kept for it, `current` always gets its tab, and the others are added most
 * relevant first until the next one would not fit. Tabs keep the order of `widths` on screen so
 * they don't trade places as statuses change.
 */
export function fitTabs(input: { widths: readonly { id: string; width: number }[]; ranked: readonly string[]; current: string | null; available: number; more: number }): TabFit {
  const { widths, ranked, current } = input;
  const width = new Map(widths.map((t) => [t.id, Math.max(0, t.width)]));
  const all = widths.reduce((sum, t) => sum + Math.max(0, t.width), 0);
  if (all <= input.available) return { shown: widths.map((t) => t.id), hidden: [] };
  const room = input.available - Math.max(0, input.more);
  const shown = new Set<string>();
  let used = 0;
  if (current !== null && width.has(current)) {
    shown.add(current);
    used += width.get(current) ?? 0;
  }
  const order = [...ranked.filter((id) => width.has(id)), ...widths.map((t) => t.id).filter((id) => !ranked.includes(id))];
  for (const id of order) {
    if (shown.has(id)) continue;
    const w = width.get(id) ?? 0;
    if (used + w > room) break;
    shown.add(id);
    used += w;
  }
  return { shown: widths.map((t) => t.id).filter((id) => shown.has(id)), hidden: order.filter((id) => !shown.has(id)) };
}
