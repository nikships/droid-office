// The Whiteboard window's view (docs/whiteboard.md, "The window"): the zoom and pan math for an
// artifact laid out at CANONICAL_WIDTH and for a canvas, the CardView the wall shows, who made a
// mark, and the Copy for agent line. Where a mark sits and what changed are
// src/shared/whiteboard-marks.ts. Ping rows and folder uploads are whiteboard-picker.ts. No DOM
// here: tests/whiteboard-window.test.ts runs it in Node.

import { CANONICAL_WIDTH, OWNER, cardChanged, cardFormat, cardsNewestFirst, changesFor, readPoint, type Author, type Board, type Box, type Card, type CardFormat, type CardView, type Op, type Point } from '../../shared/whiteboard';

// ---- Zoom and pan ----

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
/** Where zoom in and zoom out stop. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4] as const;
/** Room left round a canvas's marks when the window fits them (canonical px). The renderer uses 48; pass this into canvasBounds. */
export const CANVAS_MARGIN = 80;

export interface Size {
  w: number;
  h: number;
}

/** How a card is shown: fit to the window, or at a zoom. */
export type ZoomMode = { fit: true } | { fit: false; zoom: number };

export function clampZoom(z: number): number {
  if (!Number.isFinite(z) || z <= 0) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** The zoom that fits a page `contentW` wide into a viewport `viewportW` wide. */
export function fitZoom(viewportW: number, contentW = CANONICAL_WIDTH): number {
  if (!(viewportW > 0) || !(contentW > 0)) return 1;
  return clampZoom(viewportW / contentW);
}

/** The next zoom step in (1) or out (-1) from `z`. */
export function stepZoom(z: number, dir: 1 | -1): number {
  const eps = 0.005;
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z + eps) ?? ZOOM_MAX;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < z - eps) return ZOOM_STEPS[i];
  return ZOOM_MIN;
}

export function zoomLabel(z: number): string {
  return `${Math.round(z * 100)}%`;
}

/** Normalize device deltas without scaling pixel-based trackpad input by the artifact's zoom. */
export function wheelNavigation(dx: number, dy: number, deltaMode: number, shift: boolean, zoom: boolean, viewportH: number): { x: number; y: number; factor: number } {
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? viewportH : 1;
  if (zoom) return { x: 0, y: 0, factor: Math.exp(-Math.max(-240, Math.min(240, dy * unit)) * 0.01) };
  return { x: (shift && !dx ? dy : dx) * unit, y: (shift && !dx ? 0 : dy) * unit, factor: 1 };
}

/**
 * An artifact's view: the frame is CANONICAL_WIDTH wide and as tall as the viewport at this zoom, and
 * scrolls itself vertically (its `scrollY`); `panX` is how far its left edge is scrolled out of view
 * (canonical px) when it's wider than the viewport.
 */
export interface ArtifactView {
  zoom: number;
  panX: number;
  scrollY: number;
}

/** Where the frame sits in the viewport: its height in canonical px, its left offset on screen, and the pan clamped to the page. */
export function artifactLayout(viewport: Size, zoom: number, panX: number): { frameH: number; left: number; panX: number } {
  const shown = CANONICAL_WIDTH * zoom;
  const frameH = Math.max(1, Math.ceil(viewport.h / zoom));
  if (shown <= viewport.w) return { frameH, left: (viewport.w - shown) / 2, panX: 0 };
  const max = CANONICAL_WIDTH - viewport.w / zoom;
  const x = Math.min(max, Math.max(0, panX));
  return { frameH, left: -x * zoom, panX: x };
}

/** A new zoom for an artifact, keeping the page point under the screen x `atX` (viewport px) where it is. */
export function zoomArtifact(v: ArtifactView, viewport: Size, zoom: number, at: Point = { x: viewport.w / 2, y: viewport.h / 2 }): ArtifactView {
  const next = clampZoom(zoom);
  const before = artifactLayout(viewport, v.zoom, v.panX);
  const pageX = (at.x - before.left) / v.zoom;
  const pageY = v.scrollY + at.y / v.zoom;
  const panX = pageX - at.x / next;
  return { zoom: next, panX: artifactLayout(viewport, next, panX).panX, scrollY: Math.max(0, pageY - at.y / next) };
}

/** The region of the page an artifact's view shows (canonical px), for `card.view`. */
export function artifactCardView(viewport: Size, v: ArtifactView, pageH?: number): CardView {
  const lay = artifactLayout(viewport, v.zoom, v.panX);
  const w = Math.min(CANONICAL_WIDTH, viewport.w / v.zoom);
  const h = viewport.h / v.zoom;
  const y = pageH !== undefined ? Math.max(0, Math.min(v.scrollY, Math.max(0, pageH - h))) : Math.max(0, v.scrollY);
  return roundView({ x: lay.panX, y, w, h });
}

/** The view to open an artifact at from the region the owner last looked at. */
export function artifactFromCardView(viewport: Size, cv: CardView): { mode: ZoomMode; view: ArtifactView } {
  const fit = fitZoom(viewport.w);
  const zoom = cv.w >= CANONICAL_WIDTH - 1 ? fit : clampZoom(viewport.w / cv.w);
  const mode: ZoomMode = Math.abs(zoom - fit) < 0.01 ? { fit: true } : { fit: false, zoom };
  return { mode, view: { zoom, panX: artifactLayout(viewport, zoom, cv.x).panX, scrollY: Math.max(0, cv.y) } };
}

/** A canvas's view: the canonical point at the viewport's top-left, and the zoom. */
export interface CanvasView {
  zoom: number;
  x: number;
  y: number;
}

/** The view that fits `bounds` into the viewport, centred; never past 100%. */
export function canvasFit(bounds: Box, viewport: Size): CanvasView {
  const zoom = clampZoom(Math.min(1, viewport.w / bounds.w, viewport.h / bounds.h));
  return { zoom, x: bounds.x + bounds.w / 2 - viewport.w / zoom / 2, y: bounds.y + bounds.h / 2 - viewport.h / zoom / 2 };
}

/** A new zoom for a canvas, keeping the canonical point under `at` (viewport px) where it is. */
export function zoomCanvas(v: CanvasView, zoom: number, at: Point): CanvasView {
  const next = clampZoom(zoom);
  const px = v.x + at.x / v.zoom;
  const py = v.y + at.y / v.zoom;
  return { zoom: next, x: px - at.x / next, y: py - at.y / next };
}

export function canvasCardView(viewport: Size, v: CanvasView): CardView {
  return roundView({ x: v.x, y: v.y, w: viewport.w / v.zoom, h: viewport.h / v.zoom });
}

export function canvasFromCardView(viewport: Size, cv: CardView): CanvasView {
  const zoom = clampZoom(Math.min(viewport.w / cv.w, viewport.h / cv.h));
  return { zoom, x: cv.x + cv.w / 2 - viewport.w / zoom / 2, y: cv.y + cv.h / 2 - viewport.h / zoom / 2 };
}

/** Whether a view moved enough to be worth sending (a pixel of rounding is not). */
export function viewMoved(a: CardView | undefined, b: CardView): boolean {
  if (!a) return true;
  return Math.abs(a.x - b.x) > 2 || Math.abs(a.y - b.y) > 2 || Math.abs(a.w - b.w) > 2 || Math.abs(a.h - b.h) > 2;
}

function roundView(v: CardView): CardView {
  return { x: Math.round(v.x), y: Math.round(v.y), w: Math.max(1, Math.round(v.w)), h: Math.max(1, Math.round(v.h)) };
}

// ---- Who ----

export function authorName(a: Author): string {
  return a.kind === 'owner' ? 'You' : a.name;
}

export function authorColor(a: Author): string {
  return a.kind === 'owner' ? '#eeeeee' : a.color;
}

/** The cards on the board that changed for the owner since they last opened them. The lines themselves are `changesSince`. */
export function changedCount(board: Board | null): number {
  if (!board) return 0;
  return board.cards.filter((c) => changesFor(board, OWNER, c.id).changed).length;
}

/** The owner's read point for a card. */
export function ownerReadPoint(board: Board, cardId: string): number {
  return readPoint(board, OWNER, cardId);
}

// ---- Selecting cards ----

/** The selected ids that are still cards on the board, newest first, as the grid lists them. */
export function selectedOnBoard(board: Board, ids: ReadonlySet<string>): string[] {
  return cardsNewestFirst(board).flatMap((c) => (ids.has(c.id) ? [c.id] : []));
}

/** One batch that deletes every one of the cards. */
export function deleteOps(ids: readonly string[]): Op[] {
  return ids.map((card) => ({ op: 'card.rm', card }));
}

/** What the delete confirm says, for one card or several. */
export function deleteConfirmText(titles: readonly string[], shown = 5): { title: string; lead: string; more: string[] } {
  if (titles.length === 1) return { title: 'Delete this card?', lead: `“${titles[0]}” goes from the board with its comments, stickies and pictures. Workers see it as removed.`, more: [] };
  const list = titles.slice(0, shown).map((t) => `“${t}”`);
  if (titles.length > shown) list.push(`and ${titles.length - shown} more`);
  return { title: `Delete ${titles.length} cards?`, lead: `These ${titles.length} cards go from the board with their comments, stickies and pictures. Workers see them as removed.`, more: list };
}

// ---- Filtering, badges and card navigation ----

export type GridFilter = 'all' | 'changed' | 'open_comments' | 'markdown' | 'video' | 'html' | 'image' | 'canvas';

export const GRID_FILTERS: readonly { id: GridFilter; label: string; always?: boolean }[] = [
  { id: 'all', label: 'All', always: true },
  { id: 'changed', label: 'Changed' },
  { id: 'open_comments', label: 'Open comments' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'video', label: 'Video' },
  { id: 'html', label: 'HTML' },
  { id: 'image', label: 'Images' },
  { id: 'canvas', label: 'Canvas' },
];

export function cardFormatBadge(format: CardFormat): string {
  switch (format) {
    case 'markdown':
      return 'MD';
    case 'video':
      return 'VIDEO';
    case 'image':
      return 'IMG';
    case 'canvas':
      return 'CANVAS';
    case 'html':
      return 'HTML';
  }
}

export function cardMatchesFilter(board: Board, card: Card, filter: GridFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'changed':
      return cardChanged(board, OWNER, card.id);
    case 'open_comments':
      return card.threads.some((t) => !t.resolved);
    default:
      return cardFormat(card) === filter;
  }
}

/** Filters `cardsNewestFirst(board)` by chip filter and case-insensitive search across title, id, author, format, comments and stickies. */
export function filterCards(board: Board, opts: { query?: string; filter?: GridFilter } = {}): Card[] {
  const filter = opts.filter ?? 'all';
  const q = (opts.query ?? '').trim().toLowerCase();
  return cardsNewestFirst(board).filter((card) => {
    if (!cardMatchesFilter(board, card, filter)) return false;
    if (!q) return true;
    const fmt = cardFormat(card);
    if (card.title.toLowerCase().includes(q) || card.id.toLowerCase().includes(q) || authorName(card.author).toLowerCase().includes(q) || fmt.includes(q)) return true;
    if (card.threads.some((t) => t.messages.some((m) => m.text.toLowerCase().includes(q)))) return true;
    if (card.stickies.some((s) => s.text.toLowerCase().includes(q))) return true;
    return false;
  });
}

/** Counts matching cards per filter chip so empty optional chips stay hidden. */
export function filterCounts(board: Board): Record<GridFilter, number> {
  const counts: Record<GridFilter, number> = { all: board.cards.length, changed: 0, open_comments: 0, markdown: 0, video: 0, html: 0, image: 0, canvas: 0 };
  for (const card of board.cards) {
    if (cardChanged(board, OWNER, card.id)) counts.changed++;
    if (card.threads.some((t) => !t.resolved)) counts.open_comments++;
    counts[cardFormat(card)]++;
  }
  return counts;
}

/** The 1-based position of `currentId` in `cards`, plus adjacent card ids (`prev` = newer, `next` = older). */
export function cardNeighbors(cards: readonly Pick<Card, 'id'>[], currentId: string): { index: number; total: number; prev?: string; next?: string } | undefined {
  const idx = cards.findIndex((c) => c.id === currentId);
  if (idx < 0) return undefined;
  return {
    index: idx + 1,
    total: cards.length,
    ...(idx > 0 ? { prev: cards[idx - 1].id } : {}),
    ...(idx + 1 < cards.length ? { next: cards[idx + 1].id } : {}),
  };
}

// ---- Copy for agent ----

/** One line to paste into a prompt that names the card and how to read it. */
export function copyForAgent(card: Pick<Card, 'id' | 'title' | 'kind'> & { content?: Card['content'] }): string {
  const title = card.title.replace(/\s+/g, ' ').trim();
  const fmt = card.kind === 'canvas' ? 'canvas' : cardFormat({ kind: card.kind, content: card.content });
  const label = fmt === 'canvas' ? 'canvas' : fmt === 'html' ? 'artifact' : `${fmt} artifact`;
  return `Whiteboard card ${card.id} “${title}” (${label}): call \`whiteboard_read\` with cards: ["${card.id}"] to see it with my marks.`;
}

// ---- Ids ----

/** A fresh piece id with a prefix, made here so a queued batch can refer to it. */
export function newId(prefix: string, rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rand() * 36)];
  return `${prefix}-${s}`;
}
