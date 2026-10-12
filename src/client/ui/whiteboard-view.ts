// The Whiteboard window's pure pieces (docs/whiteboard.md, "The window"): the zoom and pan math for
// an artifact laid out at CANONICAL_WIDTH and for a canvas, the CardView the wall shows, the "changed
// since you looked" list, the Ping a worker picker's rows and the Copy for agent line. No DOM here:
// tests/whiteboard-window.test.ts runs it in Node.

import type { WorkerInfo } from '../../shared/protocol';
import { pingEligibility, type PingHow } from '../../shared/whiteboard-ping';
import { CANONICAL_WIDTH, OWNER, changesFor, findCard, isChanged, readPoint, type Author, type Board, type Box, type Card, type CardView, type PieceKind, type Point, type Stamp } from '../../shared/whiteboard';

// ---- Zoom and pan ----

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
/** Where zoom in and zoom out stop. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4] as const;
/** Room left round a canvas's marks when it's fit to the window (canonical px). */
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

/** The bounds of what's on a canvas (each mark at its anchor's point plus its box), with a margin; a blank canvas is one window's worth at the origin. */
export function canvasBounds(card: Pick<Card, 'threads' | 'stickies' | 'pictures'>, margin = CANVAS_MARGIN): Box {
  const boxes: Box[] = [];
  for (const t of card.threads) boxes.push({ x: t.anchor.point.x, y: t.anchor.point.y, w: 1, h: 1 });
  for (const m of [...card.stickies, ...card.pictures]) boxes.push({ x: m.anchor.point.x + m.box.x, y: m.anchor.point.y + m.box.y, w: m.box.w, h: m.box.h });
  if (!boxes.length) return { x: 0, y: 0, w: CANONICAL_WIDTH, h: 720 };
  const x0 = Math.min(...boxes.map((b) => b.x)) - margin;
  const y0 = Math.min(...boxes.map((b) => b.y)) - margin;
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + margin;
  const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + margin;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
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

/** A drag from `a` to `b` (canonical px) as a sticky's top-left and size; a short drag gets the default size. */
export function dragBox(a: Point, b: Point, fallback: Size, min = 40): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  if (w < min && h < min) return { x: a.x, y: a.y, w: fallback.w, h: fallback.h };
  return { x, y, w: Math.max(min, Math.round(w)), h: Math.max(min, Math.round(h)) };
}

/** A picture's size on the page: its own, scaled down to fit `max` canonical px on its longer side. */
export function pictureSize(natural: Size, max = 480): Size {
  const w = Math.max(1, natural.w);
  const h = Math.max(1, natural.h);
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(16, Math.round(w * s)), h: Math.max(16, Math.round(h * s)) };
}

// ---- Who ----

export function authorName(a: Author): string {
  return a.kind === 'owner' ? 'You' : a.name;
}

export function authorColor(a: Author): string {
  return a.kind === 'owner' ? '#eeeeee' : a.color;
}

// ---- Changed since you looked ----

export type ChangeVerb = 'renamed' | 'content' | 'state' | 'commented' | 'replied' | 'resolved' | 'reopened' | 'moved-pin' | 'added' | 'edited' | 'recolored' | 'moved' | 'reattached' | 'replaced' | 'removed';

export interface ChangeItem {
  /** Stable for a list key. */
  key: string;
  verb: ChangeVerb;
  /** What it's about, for the side panel: "Renamed it to …", "Added a sticky". */
  text: string;
  author: Author;
  rev: number;
  /** The mark it's about, to find it on the page. */
  mark?: { kind: 'thread' | 'sticky' | 'picture'; id: string };
}

/**
 * What changed on a card for the owner since revision `since` (their read point when they opened it),
 * newest first: one line per thing someone else did, not per stamped piece.
 */
export function changesSince(board: Board, cardId: string, since: number): ChangeItem[] {
  const card = findCard(board, cardId);
  const view: Board = { ...board, reads: { ...board.reads, [OWNER]: { ...(board.reads[OWNER] ?? {}), [cardId]: since } } };
  const ch = changesFor(view, OWNER, cardId);
  if (!ch.changed) return [];
  const out: ChangeItem[] = [];
  const add = (key: string, verb: ChangeVerb, text: string, stamp: Pick<Stamp, 'rev' | 'author'>, mark?: ChangeItem['mark']) => out.push({ key, verb, text, author: stamp.author, rev: stamp.rev, ...(mark ? { mark } : {}) });
  const fresh = (s: Stamp) => isChanged(s, OWNER, since);
  if (card) {
    // Never opened: the card itself is the news, not its title and page.
    if (since === 0 && card.author.kind !== 'owner') add('new', 'added', card.kind === 'canvas' ? 'Made this canvas' : 'Put this card up', { rev: card.stamps.title.rev, author: card.author });
    else {
      if (fresh(card.stamps.title)) add('title', 'renamed', `Renamed it to “${card.title}”`, card.stamps.title);
      if (card.stamps.content && fresh(card.stamps.content)) add('content', 'content', 'Changed the page', card.stamps.content);
    }
    const leaves = Object.entries(card.stamps.state).filter(([, s]) => fresh(s));
    if (leaves.length) {
      const latest = leaves.reduce((a, b) => (b[1].rev > a[1].rev ? b : a));
      const names = leaves.map(([k]) => JSON.parse(k).join('.'));
      add('state', 'state', leaves.length === 1 ? `Set ${names[0]}` : `Set ${leaves.length} values: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`, latest[1]);
    }
    for (const t of card.threads) {
      const mark = { kind: 'thread' as const, id: t.id };
      const first = t.messages[0];
      const isNew = first && fresh(first.stamp) && t.stamps.anchor.rev === first.stamp.rev;
      if (isNew) add(`t:${t.id}`, 'commented', `Commented: “${clipText(first.text)}”`, first.stamp, mark);
      for (const m of t.messages.slice(isNew ? 1 : 0)) if (fresh(m.stamp)) add(`m:${m.id}`, 'replied', `Replied: “${clipText(m.text)}”`, m.stamp, mark);
      if (!isNew && fresh(t.stamps.resolved)) add(`r:${t.id}`, t.resolved ? 'resolved' : 'reopened', t.resolved ? 'Resolved a comment' : 'Reopened a comment', t.stamps.resolved, mark);
      if (!isNew && fresh(t.stamps.anchor)) add(`a:${t.id}`, 'moved-pin', 'Moved a comment pin', t.stamps.anchor, mark);
    }
    for (const s of card.stickies) {
      const mark = { kind: 'sticky' as const, id: s.id };
      const st = s.stamps;
      if (fresh(st.anchor) && st.anchor.rev === st.text.rev && st.text.rev === st.color.rev && st.color.rev === st.box.rev) {
        add(`s:${s.id}`, 'added', s.text ? `Added a sticky: “${clipText(s.text)}”` : 'Added a sticky', st.anchor, mark);
        continue;
      }
      if (fresh(st.text)) add(`st:${s.id}`, 'edited', `Edited a sticky: “${clipText(s.text)}”`, st.text, mark);
      if (fresh(st.color)) add(`sc:${s.id}`, 'recolored', 'Recolored a sticky', st.color, mark);
      if (fresh(st.box)) add(`sb:${s.id}`, 'moved', 'Moved or resized a sticky', st.box, mark);
      if (fresh(st.anchor)) add(`sa:${s.id}`, 'reattached', 'Reattached a sticky', st.anchor, mark);
    }
    for (const p of card.pictures) {
      const mark = { kind: 'picture' as const, id: p.id };
      const st = p.stamps;
      if (fresh(st.anchor) && st.anchor.rev === st.file.rev && st.file.rev === st.box.rev) {
        add(`p:${p.id}`, 'added', 'Added a picture', st.anchor, mark);
        continue;
      }
      if (fresh(st.file)) add(`pf:${p.id}`, 'replaced', 'Replaced a picture', st.file, mark);
      if (fresh(st.box)) add(`pb:${p.id}`, 'moved', 'Moved or resized a picture', st.box, mark);
      if (fresh(st.anchor)) add(`pa:${p.id}`, 'reattached', 'Reattached a picture', st.anchor, mark);
    }
  }
  const gone: Partial<Record<PieceKind, string>> = { thread: 'a comment thread', message: 'a comment', sticky: 'a sticky', picture: 'a picture', state: 'a value', card: 'the card' };
  for (const t of ch.removed) add(`x:${t.kind}:${t.id}`, 'removed', t.kind === 'state' ? `Removed ${JSON.parse(t.id).join('.')}` : `Removed ${gone[t.kind] ?? 'something'}`, t);
  return out.sort((a, b) => b.rev - a.rev);
}

function clipText(s: string, max = 60): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The cards on the board that changed for the owner since they last opened them. */
export function changedCount(board: Board | null): number {
  if (!board) return 0;
  return board.cards.filter((c) => changesFor(board, OWNER, c.id).changed).length;
}

/** The owner's read point for a card. */
export function ownerReadPoint(board: Board, cardId: string): number {
  return readPoint(board, OWNER, cardId);
}

// ---- Ping a worker ----

export interface PingRow {
  id: string;
  name: string;
  color: string;
  /** The status word, as the rest of the office says it. */
  status: string;
  statusClass: string;
  ok: boolean;
  how?: PingHow;
  /** What pressing Ping does, or why it can't. */
  note: string;
  busy?: boolean;
  guest?: boolean;
}

const HOW_NOTE: Record<PingHow, string> = {
  type: 'Types the line into its terminal now',
  resume: 'Wakes it up with the line',
  queue: 'Queues the line behind its current turn',
};

/** The picker's rows: every worker on the floor with whether it can be pinged now and why not; the ones that can first, then A to Z. */
export function pingRows(workers: Iterable<WorkerInfo>, statusLabel: Record<string, string>, now = Date.now()): PingRow[] {
  const rows = [...workers].map((w): PingRow => {
    const e = pingEligibility(w, now);
    const down = w.downedUntil !== undefined && w.downedUntil > now;
    const status = w.guest ? 'guest' : down ? 'down' : (statusLabel[w.status] ?? w.status);
    const base = { id: w.id, name: w.name, color: w.color, status, statusClass: w.guest ? 'offline' : down ? 'needs_input' : w.status, ...(w.guest ? { guest: true } : {}) };
    return e.ok ? { ...base, ok: true, how: e.how, note: HOW_NOTE[e.how] } : { ...base, ok: false, note: e.reason, ...(e.busy ? { busy: true } : {}) };
  });
  const rank = (r: PingRow) => (r.ok ? 0 : r.busy ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** What a ping that went in did, for the row. */
export function pingedText(name: string, how: PingHow | undefined): string {
  if (how === 'queue') return `Queued for ${name} after its turn`;
  if (how === 'resume') return `Woke ${name} up with it`;
  return `Typed it into ${name}'s terminal`;
}

// ---- Copy for agent ----

/** One line to paste into a prompt that names the card and how to read it. */
export function copyForAgent(card: Pick<Card, 'id' | 'title' | 'kind'>): string {
  const title = card.title.replace(/\s+/g, ' ').trim();
  return `Whiteboard card ${card.id} “${title}” (${card.kind === 'canvas' ? 'canvas' : 'artifact'}): run \`office-whiteboard read ${card.id}\` to see it with my marks.`;
}

// ---- Ids ----

/** A fresh piece id with a prefix, made here so a queued batch can refer to it. */
export function newId(prefix: string, rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rand() * 36)];
  return `${prefix}-${s}`;
}

// ---- Uploads ----

const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
};

/** The media type a file of a folder upload is served as: from its extension, else what the browser said. */
export function mimeFor(name: string, browserType = ''): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || browserType || 'application/octet-stream';
}

/**
 * The files of an uploaded folder, by their path inside it (the folder's own name dropped), and the
 * page to open: index.html at the top if there is one, else the shallowest .html. Hidden files and
 * folders (.git, .DS_Store) and node_modules are left out.
 */
export function folderFiles<T extends { path: string }>(files: T[]): { files: { rel: string; file: T }[]; entry?: string; skipped: number } {
  const out: { rel: string; file: T }[] = [];
  let skipped = 0;
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    const rel = (parts.length > 1 ? parts.slice(1) : parts).join('/');
    if (!rel || rel.split('/').some((p) => p.startsWith('.') || p === 'node_modules')) {
      skipped++;
      continue;
    }
    out.push({ rel, file: f });
  }
  const pages = out.map((f) => f.rel).filter((r) => /\.html?$/i.test(r));
  const entry = pages.find((r) => /^index\.html?$/i.test(r)) ?? pages.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
  return { files: out, entry, skipped };
}
