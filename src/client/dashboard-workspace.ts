// The web companion's workspace: which workers are open in which of up to four panes, the layout
// they sit in and where its dividers are. No DOM, so it is tested on its own (tests/dashboard-workspace.test.ts).

export type LayoutMode = 'single' | 'split' | 'triple' | 'grid';
export type PaneView = 'thread' | 'terminal';
/** A pane's box as fractions of the workspace: left, top, width, height. */
export type Rect = readonly [x: number, y: number, w: number, h: number];

export const LAYOUT_ORDER: readonly LayoutMode[] = ['single', 'split', 'triple', 'grid'];
export const SLOT_COUNT: Record<LayoutMode, number> = { single: 1, split: 2, triple: 3, grid: 4 };
export const LAYOUT_LABEL: Record<LayoutMode, string> = { single: 'One pane', split: 'Side by side', triple: 'One plus two', grid: 'Grid of four' };
export const MAX_SLOTS = 4;
export const FULL_RECT: Rect = [0, 0, 1, 1];
/** How far a divider may go towards either edge, so no pane gets too thin to use. */
export const RATIO_MIN = 0.22;
export const RATIO_MAX = 0.78;

export interface Workspace {
  layout: LayoutMode;
  /** Always MAX_SLOTS long. Slots past the layout's count keep their worker for when the layout grows again. */
  slots: (string | null)[];
  focused: number;
  maximized: number | null;
  /** Where the vertical divider is, as a fraction of the width. */
  col: number;
  /** Where the horizontal divider is, as a fraction of the height. */
  row: number;
  /** Thread or Raw TTY, per worker the owner switched. */
  views: Record<string, PaneView>;
}

export function clampRatio(v: number): number {
  return Number.isFinite(v) ? Math.min(RATIO_MAX, Math.max(RATIO_MIN, v)) : 0.5;
}

export function emptyWorkspace(layout: LayoutMode = 'triple'): Workspace {
  return { layout, slots: Array(MAX_SLOTS).fill(null), focused: 0, maximized: null, col: 0.56, row: 0.5, views: {} };
}

/** The panes the layout shows now, in order. */
export function visibleSlots(ws: Workspace): (string | null)[] {
  return ws.slots.slice(0, SLOT_COUNT[ws.layout]);
}

/** The pane a worker is open in, or -1. */
export function paneOf(ws: Workspace, id: string): number {
  return visibleSlots(ws).indexOf(id);
}

export function focusedWorker(ws: Workspace): string | null {
  return ws.slots[ws.focused] ?? null;
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
  }
}

export function setLayout(ws: Workspace, layout: LayoutMode) {
  ws.layout = layout;
  ws.maximized = null;
  ws.focused = Math.min(ws.focused, SLOT_COUNT[layout] - 1);
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

/** Shows a worker: focuses its pane if it's open, else fills an empty pane, else takes the focused one. */
export function openWorker(ws: Workspace, id: string) {
  const shown = visibleSlots(ws);
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
  const at = shown.indexOf(id);
  if (at >= 0) {
    ws.focused = at;
    return;
  }
  const empty = shown.indexOf(null);
  if (empty >= 0) return assign(ws, empty, id);
  const next = LAYOUT_ORDER[LAYOUT_ORDER.indexOf(ws.layout) + 1];
  if (!next) return assign(ws, ws.focused, id);
  setLayout(ws, next);
  // The slot the bigger layout adds may still hold a worker from before; it moves out of sight.
  assign(ws, SLOT_COUNT[next] - 1, id);
}

export function closeSlot(ws: Workspace, slot: number) {
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

/** A first workspace for a floor: a layout sized to the workers, the first ones in the panes. */
export function seedWorkspace(ids: readonly string[]): Workspace {
  const layout: LayoutMode = ids.length <= 1 ? 'single' : ids.length === 2 ? 'split' : 'triple';
  const ws = emptyWorkspace(layout);
  ids.slice(0, SLOT_COUNT[layout]).forEach((id, i) => {
    ws.slots[i] = id;
  });
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
