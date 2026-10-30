// The web companion's workspace: which workers are open in which of up to eight panes, the layout
// they sit in and where its dividers are. No DOM, so it is tested on its own (tests/dashboard-workspace.test.ts).

import type { WorkerInfo } from '../shared/protocol';
import { isBusy } from '../shared/status';

export type LayoutMode = 'single' | 'split' | 'triple' | 'grid' | 'five' | 'six' | 'seven' | 'eight';
export type PaneView = 'thread' | 'terminal';
/** A pane's box as fractions of the workspace: left, top, width, height. */
export type Rect = readonly [x: number, y: number, w: number, h: number];

export const LAYOUT_ORDER: readonly LayoutMode[] = ['single', 'split', 'triple', 'grid', 'five', 'six', 'seven', 'eight'];
export const SLOT_COUNT: Record<LayoutMode, number> = { single: 1, split: 2, triple: 3, grid: 4, five: 5, six: 6, seven: 7, eight: 8 };
export const LAYOUT_LABEL: Record<LayoutMode, string> = {
  single: 'One pane',
  split: 'Side by side',
  triple: 'One plus two',
  grid: 'Grid of four',
  five: 'One plus four',
  six: 'Grid of six',
  seven: 'One plus six',
  eight: 'Grid of eight',
};
/** Which layouts have a divider to drag: `col` sizes a full-height first column, `row` splits it in two. */
export const LAYOUT_DIVIDERS: Record<LayoutMode, { col: boolean; row: boolean }> = {
  single: { col: false, row: false },
  split: { col: true, row: false },
  triple: { col: true, row: true },
  grid: { col: true, row: true },
  five: { col: true, row: false },
  six: { col: false, row: false },
  seven: { col: true, row: false },
  eight: { col: false, row: false },
};
export const MAX_SLOTS = 8;
export const FULL_RECT: Rect = [0, 0, 1, 1];
/** How far a divider may go towards either edge, so no pane gets too thin to use. */
export const RATIO_MIN = 0.22;
export const RATIO_MAX = 0.78;

export interface Workspace {
  layout: LayoutMode;
  /** Explicit layout choices stay fixed until Auto is selected again. */
  auto: boolean;
  /** Always MAX_SLOTS long. Slots past the layout's count keep their worker for when the layout grows again. */
  slots: (string | null)[];
  focused: number;
  maximized: number | null;
  /** Where the vertical divider is, as a fraction of the width. */
  col: number;
  /** Where the horizontal divider is, as a fraction of the height. */
  row: number;
  /** Thread or Raw TTY, per worker, including the default chosen when it first opened. */
  views: Record<string, PaneView>;
}

export function clampRatio(v: number): number {
  return Number.isFinite(v) ? Math.min(RATIO_MAX, Math.max(RATIO_MIN, v)) : 0.5;
}

export function emptyWorkspace(layout: LayoutMode = 'triple'): Workspace {
  return { layout, auto: true, slots: Array(MAX_SLOTS).fill(null), focused: 0, maximized: null, col: 0.56, row: 0.5, views: {} };
}

/** The panes the layout shows now, in order. */
export function visibleSlots(ws: Workspace): (string | null)[] {
  return ws.slots.slice(0, SLOT_COUNT[ws.layout]);
}

/** Release moved/hidden workers as a batch before rendering any replacement pane. */
export function releaseChangedPanes<T extends { workerId(): string; dispose(): void }>(panes: (T | undefined)[], shown: readonly (string | null)[]) {
  for (let i = 0; i < panes.length; i++) {
    if (i >= shown.length || panes[i]?.workerId() !== (shown[i] ?? '')) {
      panes[i]?.dispose();
      panes[i] = undefined;
    }
  }
}

/** The pane a worker is open in, or -1. */
export function paneOf(ws: Workspace, id: string): number {
  return visibleSlots(ws).indexOf(id);
}

export function focusedWorker(ws: Workspace): string | null {
  return ws.slots[ws.focused] ?? null;
}

/** Changing the default for future workers must not change a worker that's already open. */
export function workerView(ws: Workspace, id: string, fallback: PaneView): PaneView {
  return (ws.views[id] ??= fallback);
}

/** Panes of a `cols`-by-`rows` grid of even boxes, left to right, top to bottom. */
function evenGrid(cols: number, rows: number): Rect[] {
  const rects: Rect[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) rects.push([col / cols, row / rows, 1 / cols, 1 / rows]);
  return rects;
}

/** A full-height pane on the left sized by `c`, and an even `cols`-by-`rows` block to its right. */
function mainPlusRight(c: number, cols: number, rows: number): Rect[] {
  const w = (1 - c) / cols;
  const h = 1 / rows;
  const right: Rect[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) right.push([c + col * w, row * h, w, h]);
  return [[0, 0, c, 1], ...right];
}

export function rectsFor(layout: LayoutMode, c: number, r: number): Rect[] {
  switch (layout) {
    case 'single':
      return [FULL_RECT];
    case 'split':
      return [
        [0, 0, c, 1],
        [c, 0, 1 - c, 1],
      ];
    case 'triple':
      return [
        [0, 0, c, 1],
        [c, 0, 1 - c, r],
        [c, r, 1 - c, 1 - r],
      ];
    case 'grid':
      return [
        [0, 0, c, r],
        [c, 0, 1 - c, r],
        [0, r, c, 1 - r],
        [c, r, 1 - c, 1 - r],
      ];
    case 'five':
      return mainPlusRight(c, 2, 2);
    case 'six':
      return evenGrid(3, 2);
    case 'seven':
      return mainPlusRight(c, 2, 3);
    case 'eight':
      return evenGrid(4, 2);
  }
}

export function setLayout(ws: Workspace, layout: LayoutMode) {
  ws.layout = layout;
  ws.auto = false;
  ws.maximized = null;
  ws.focused = Math.min(ws.focused, SLOT_COUNT[layout] - 1);
}

/**
 * Fills the layout's empty panes with the given workers, in order, skipping the ones already shown.
 * Only the supplied workers are eligible, including any parked beyond the visible layout.
 * Returns whether a pane changed.
 */
export function fillPanes(ws: Workspace, ids: readonly string[]): boolean {
  const count = SLOT_COUNT[ws.layout];
  const shown = new Set(ws.slots.slice(0, count).filter((id): id is string => !!id));
  const queue = [...new Set(ids.filter((id) => id && !shown.has(id)))];
  let filled = false;
  for (let slot = 0; slot < count && queue.length; slot++) {
    if (ws.slots[slot]) continue;
    const id = queue.shift() ?? '';
    if (!id) break;
    const at = ws.slots.indexOf(id, count);
    if (at >= 0) ws.slots[at] = null;
    ws.slots[slot] = id;
    filled = true;
  }
  return filled;
}

type LayoutWorker = Pick<WorkerInfo, 'id' | 'lead' | 'status' | 'createdAt'>;

/** Active mains, mains needing input, active subagents, resting mains, then resting subagents. */
export function panePriority(w: LayoutWorker): number {
  if (w.lead) return isBusy(w.status) ? 2 : 4;
  if (w.status === 'working' || w.status === 'starting') return 0;
  return w.status === 'needs_input' ? 1 : 3;
}

/** Rebalance without moving surviving panes unnecessarily or losing their focus, views or ratios. */
export function autoLayout(ws: Workspace, workers: readonly LayoutWorker[]): boolean {
  const before = serializeWorkspace(ws);
  const focused = focusedWorker(ws);
  const maximized = ws.maximized === null ? null : ws.slots[ws.maximized];
  const visible = new Set(visibleSlots(ws));
  const mains = workers.filter((w) => !w.lead).length;
  // A busy floor must not become denser just because an orchestrator hires a team.
  const count = Math.max(1, Math.min(MAX_SLOTS, mains >= 5 ? mains : workers.length));
  const ranked = [...workers].sort((a, b) => panePriority(a) - panePriority(b) || Number(visible.has(b.id)) - Number(visible.has(a.id)) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const selected = new Set(ranked.slice(0, count).map((w) => w.id));
  const slots = ws.slots.slice(0, count).map((id) => (id && selected.has(id) ? id : null));
  const queue = ranked.filter((w) => selected.has(w.id) && !slots.includes(w.id)).map((w) => w.id);
  for (let i = 0; i < count; i++) if (!slots[i]) slots[i] = queue.shift() ?? null;
  const present = new Set(workers.map((w) => w.id));
  const parked = ws.slots.filter((id): id is string => !!id && present.has(id) && !selected.has(id));
  ws.slots = [...slots, ...parked, ...Array(MAX_SLOTS).fill(null)].slice(0, MAX_SLOTS);
  ws.layout = LAYOUT_ORDER[count - 1];
  ws.auto = true;
  const focusAt = focused ? slots.indexOf(focused) : -1;
  ws.focused = focusAt >= 0 ? focusAt : Math.min(ws.focused, count - 1);
  const maxAt = maximized ? slots.indexOf(maximized) : -1;
  ws.maximized = count > 1 && maxAt >= 0 ? maxAt : null;
  return before !== serializeWorkspace(ws);
}

/** Rebalance Auto only on membership/priority changes, not on typing, focus or ordinary status ticks. */
export function syncWorkspace(ws: Workspace, workers: readonly LayoutWorker[], previous: Map<string, number>) {
  const present = new Map(workers.map((w) => [w.id, panePriority(w)]));
  const arrivals = workers.filter((w) => !previous.has(w.id)).map((w) => w.id);
  const changed = present.size !== previous.size || workers.some((w) => previous.get(w.id) !== panePriority(w));
  const gone = prune(ws, (id) => present.has(id));
  previous.clear();
  for (const [id, priority] of present) previous.set(id, priority);
  return { gone, filled: ws.auto ? changed && autoLayout(ws, workers) : fillPanes(ws, arrivals) };
}

/** Puts a worker in a pane. If it was open in another one, the two panes trade places. */
export function assign(ws: Workspace, slot: number, id: string) {
  const old = ws.slots.indexOf(id);
  if (old !== slot) {
    if (old >= 0) ws.slots[old] = ws.slots[slot] ?? null;
    ws.slots[slot] = id;
  }
  ws.focused = slot;
}

export function swap(ws: Workspace, a: number, b: number) {
  if (a === b) return;
  [ws.slots[a], ws.slots[b]] = [ws.slots[b] ?? null, ws.slots[a] ?? null];
  ws.focused = b;
}

/** An explicit empty target wins; otherwise focus the worker, fill an empty pane, or take focus. */
export function openWorker(ws: Workspace, id: string, targetPane?: number) {
  const shown = visibleSlots(ws);
  // A hire can reach the floor and be auto-placed before its confirmation arrives.
  if (targetPane !== undefined && shown[targetPane] === null) {
    assign(ws, targetPane, id);
    if (ws.maximized !== null) ws.maximized = targetPane;
    return;
  }
  const at = shown.indexOf(id);
  if (at >= 0) {
    ws.focused = at;
    if (ws.maximized !== null) ws.maximized = at;
    return;
  }
  const empty = shown.indexOf(null);
  const slot = empty >= 0 ? empty : ws.focused;
  assign(ws, slot, id);
  if (ws.maximized !== null) ws.maximized = slot;
}

/** Opens a worker beside the others: an empty pane, else the next bigger layout, else the focused pane. */
export function openInSplit(ws: Workspace, id: string) {
  const shown = visibleSlots(ws);
  if (shown.includes(id) || shown.includes(null)) return openWorker(ws, id);
  const next = LAYOUT_ORDER[LAYOUT_ORDER.indexOf(ws.layout) + 1];
  if (!next) return openWorker(ws, id);
  setLayout(ws, next);
  // The slot the bigger layout adds may still hold a worker from before; it moves out of sight.
  assign(ws, SLOT_COUNT[next] - 1, id);
}

export function closeSlot(ws: Workspace, slot: number) {
  ws.auto = false;
  ws.slots[slot] = null;
  if (ws.maximized === slot) ws.maximized = null;
}

export function toggleMax(ws: Workspace, slot: number) {
  if (SLOT_COUNT[ws.layout] < 2) return;
  ws.focused = slot;
  ws.maximized = ws.maximized === slot ? null : slot;
}

/** Empties the panes of workers that are no longer on the floor; returns the ids that left. */
export function prune(ws: Workspace, has: (id: string) => boolean): string[] {
  const gone: string[] = [];
  ws.slots = ws.slots.map((id) => {
    if (id && !has(id)) {
      gone.push(id);
      return null;
    }
    return id;
  });
  for (const id of Object.keys(ws.views)) if (!has(id)) delete ws.views[id];
  if (ws.maximized !== null && !ws.slots[ws.maximized]) ws.maximized = null;
  return gone;
}

/** A first workspace for a floor: the smallest layout that shows everyone, the workers in its panes. */
export function seedWorkspace(ids: readonly string[]): Workspace {
  const layout = LAYOUT_ORDER.find((mode) => SLOT_COUNT[mode] >= ids.length) ?? 'eight';
  const ws = emptyWorkspace(layout);
  fillPanes(ws, ids);
  return ws;
}

export function serializeWorkspace(ws: Workspace): string {
  return JSON.stringify(ws);
}

/** A saved workspace, or undefined when it is missing or malformed. */
export function parseWorkspace(raw: string | null | undefined): Workspace | undefined {
  if (!raw) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const layout = LAYOUT_ORDER.includes(o.layout as LayoutMode) ? (o.layout as LayoutMode) : undefined;
  if (!layout || !Array.isArray(o.slots)) return undefined;
  const ws = emptyWorkspace(layout);
  ws.auto = o.auto !== false;
  const seen = new Set<string>();
  ws.slots = ws.slots.map((_, i) => {
    const id = (o.slots as unknown[])[i];
    if (typeof id !== 'string' || !id || seen.has(id)) return null;
    seen.add(id);
    return id;
  });
  const slot = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < SLOT_COUNT[layout] ? n : undefined);
  ws.focused = slot(o.focused) ?? 0;
  ws.maximized = SLOT_COUNT[layout] > 1 ? (slot(o.maximized) ?? null) : null;
  if (typeof o.col === 'number') ws.col = clampRatio(o.col);
  if (typeof o.row === 'number') ws.row = clampRatio(o.row);
  if (o.views && typeof o.views === 'object') for (const [id, view] of Object.entries(o.views as Record<string, unknown>)) if (view === 'thread' || view === 'terminal') ws.views[id] = view;
  return ws;
}

/** How long a worker has worked, from its finished stretches and the one it's in now. */
export function workedFor(workedMs: number | undefined, workingSince: number | undefined, now: number): number {
  return Math.max(0, (workedMs ?? 0) + (workingSince ? now - workingSince : 0));
}

/** 31s, 12m, 2h 14m. */
export function shortDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const hours = Math.floor(m / 60);
  return m % 60 ? `${hours}h ${m % 60}m` : `${hours}h`;
}
