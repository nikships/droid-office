// One mark on a Whiteboard card, shared by the window and the renderer. Where it sits (its anchor's
// point plus its box), the bounds of a canvas for a margin the caller passes, the operations a place,
// drag, reply or delete returns, and the change list. The list is the pieces `changesFor` already
// found, described once. No DOM and no three.js: Node runs it too.
//
// The window fits a canvas with 80 pixels of room and the renderer captures one with 48. Those stay
// two numbers; both call `canvasBounds` / `boundsOf` with the margin they mean.

import {
  CANONICAL_WIDTH,
  OWNER,
  changesFor,
  findCard,
  parseStatePathKey,
  statePathKey,
  type Anchor,
  type Author,
  type Board,
  type Box,
  type Card,
  type FileRef,
  type Op,
  type PieceKind,
  type PieceRef,
  type Point,
  type Stamp,
  type StickyColor,
} from './whiteboard.js';

/** A mark's anchor as someone placed it: the page point, and whether that point is a fallback. */
export interface MarkSpot {
  point: Point;
  detached: boolean;
}

/**
 * Where one mark is drawn, in canonical px. A sticky or picture is its point plus its box. A thread
 * is its point (a 1×1) unless `pin` is set, in which case it is a square of that size centered on
 * the point (the renderer's comment pin).
 */
export interface PlacedMark {
  id: string;
  kind: 'thread' | 'sticky' | 'picture';
  x: number;
  y: number;
  w: number;
  h: number;
  detached: boolean;
}

const DRAG_MIN = 40;

/** The blank canvas the window fits when a card has no marks yet (the renderer passes its own frame). */
export const WINDOW_CANVAS_EMPTY: Box = { x: 0, y: 0, w: CANONICAL_WIDTH, h: 720 };

/** One mark's top-left and size. `pin` centers a thread on its point; otherwise a thread is that point. */
export function placeMark(kind: PlacedMark['kind'], id: string, spot: MarkSpot, box?: Box, pin = 0): PlacedMark {
  if (kind === 'thread') {
    const size = pin > 0 ? pin : 1;
    const shift = pin > 0 ? pin / 2 : 0;
    return { id, kind, x: spot.point.x - shift, y: spot.point.y - shift, w: size, h: size, detached: spot.detached };
  }
  const b = box ?? { x: 0, y: 0, w: 0, h: 0 };
  return { id, kind, x: spot.point.x + b.x, y: spot.point.y + b.y, w: b.w, h: b.h, detached: spot.detached };
}

/**
 * Every mark on a card, pictures under stickies under threads (the order the renderer paints).
 * `at` defaults to each anchor's own point. `pin` is the renderer's pin diameter; the window omits it.
 */
export function placeMarks(card: Pick<Card, 'threads' | 'stickies' | 'pictures'>, at: (id: string, anchor: Anchor) => MarkSpot = (_id, anchor) => ({ point: anchor.point, detached: false }), pin = 0): PlacedMark[] {
  const out: PlacedMark[] = [];
  for (const p of card.pictures) out.push(placeMark('picture', p.id, at(p.id, p.anchor), p.box, pin));
  for (const s of card.stickies) out.push(placeMark('sticky', s.id, at(s.id, s.anchor), s.box, pin));
  for (const t of card.threads) out.push(placeMark('thread', t.id, at(t.id, t.anchor), undefined, pin));
  return out;
}

/** The union of `boxes`, outset by `margin`. No boxes is `empty`, margin and all. */
export function boundsOf(boxes: readonly { x: number; y: number; w: number; h: number }[], margin: number, empty: Box): Box {
  if (!boxes.length) return empty;
  const x0 = Math.min(...boxes.map((b) => b.x)) - margin;
  const y0 = Math.min(...boxes.map((b) => b.y)) - margin;
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + margin;
  const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + margin;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The bounds of what's on a canvas: each mark from `placeMarks` (a comment is its point), plus
 * `margin`. A blank canvas is `empty` (one window, by default). The window passes 80; the renderer
 * passes 48 and its own empty frame, and it places threads as pins before measuring.
 */
export function canvasBounds(card: Pick<Card, 'threads' | 'stickies' | 'pictures'>, margin: number, empty: Box = WINDOW_CANVAS_EMPTY): Box {
  return boundsOf(placeMarks(card), margin, empty);
}

/** A drag from `a` to `b` (canonical px) as a sticky's top-left and size; a short drag gets the default size. */
export function dragBox(a: Point, b: Point, fallback: { w: number; h: number }, min = DRAG_MIN): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  if (w < min && h < min) return { x: a.x, y: a.y, w: fallback.w, h: fallback.h };
  return { x, y, w: Math.max(min, Math.round(w)), h: Math.max(min, Math.round(h)) };
}

/** A picture's size on the page: its own, scaled down to fit `max` canonical px on its longer side. */
export function pictureSize(natural: { w: number; h: number }, max = 480): { w: number; h: number } {
  const w = Math.max(1, natural.w);
  const h = Math.max(1, natural.h);
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(16, Math.round(w * s)), h: Math.max(16, Math.round(h * s)) };
}

/** Where a sticky or picture is drawn while its drag is in progress (canonical px, not yet rounded). */
export function dragPreview(origin: Point, box: Box, dx: number, dy: number, what: 'move' | 'resize'): Box {
  if (what === 'move') return { x: origin.x + box.x + dx, y: origin.y + box.y + dy, w: box.w, h: box.h };
  return { x: origin.x + box.x, y: origin.y + box.y, w: Math.max(DRAG_MIN, box.w + dx), h: Math.max(DRAG_MIN, box.h + dy) };
}

function moveOp(kind: 'sticky' | 'picture', card: string, id: string, box: Partial<Box>): Op {
  return kind === 'sticky' ? { op: 'sticky.move', card, id, box } : { op: 'picture.move', card, id, box };
}

function reattachOne(kind: 'sticky' | 'picture', card: string, id: string, anchor: Anchor): Op {
  return kind === 'sticky' ? { op: 'sticky.reattach', card, id, anchor } : { op: 'picture.reattach', card, id, anchor };
}

/**
 * The operations a finished drag sends. A resize writes the new size. A move on a canvas or a point
 * anchor writes the box offset. A move on an element anchor (pass `anchor`, the spot it was dropped
 * on) reattaches there and clears a leftover offset.
 */
export function dragMarkOps(o: { card: string; kind: 'sticky' | 'picture'; id: string; what: 'move' | 'resize'; box: Box; dx: number; dy: number; anchor?: Anchor }): Op[] {
  if (o.what === 'resize') return [moveOp(o.kind, o.card, o.id, { w: Math.round(Math.max(DRAG_MIN, o.box.w + o.dx)), h: Math.round(Math.max(DRAG_MIN, o.box.h + o.dy)) })];
  if (!o.anchor) return [moveOp(o.kind, o.card, o.id, { x: Math.round(o.box.x + o.dx), y: Math.round(o.box.y + o.dy) })];
  const ops: Op[] = [reattachOne(o.kind, o.card, o.id, o.anchor)];
  if (o.box.x !== 0 || o.box.y !== 0) ops.push(moveOp(o.kind, o.card, o.id, { x: 0, y: 0 }));
  return ops;
}

/** The operations that put a mark back on a spot the owner clicked. A sticky or picture with an offset is zeroed so it sits on that spot. */
export function reattachMarkOps(o: { card: string; kind: 'thread' | 'sticky' | 'picture'; id: string; anchor: Anchor; box?: Box }): Op[] {
  if (o.kind === 'thread') return [{ op: 'comment.reattach', card: o.card, thread: o.id, anchor: o.anchor }];
  const ops: Op[] = [reattachOne(o.kind, o.card, o.id, o.anchor)];
  if (o.box && (o.box.x !== 0 || o.box.y !== 0)) ops.push(moveOp(o.kind, o.card, o.id, { x: 0, y: 0 }));
  return ops;
}

/** A new sticky: its anchor is the top-left, so the box offset starts at zero. */
export function stickyAddOp(card: string, id: string, anchor: Anchor, size: { w: number; h: number }, color: StickyColor = 'yellow'): Op {
  return { op: 'sticky.add', card, id, anchor, box: { x: 0, y: 0, w: size.w, h: size.h }, text: '', color };
}

/** A new picture, anchored at its top-left. */
export function pictureAddOp(card: string, id: string, file: FileRef, anchor: Anchor, size: { w: number; h: number }): Op {
  return { op: 'picture.add', card, id, file, anchor, box: { x: 0, y: 0, w: size.w, h: size.h } };
}

/** A new comment thread. */
export function commentAddOp(card: string, thread: string, message: string, anchor: Anchor, text: string): Op {
  return { op: 'comment.add', card, thread, message, anchor, text };
}

/** A sticky's text or color. */
export function stickyEditOp(card: string, id: string, patch: { text?: string; color?: StickyColor }): Op {
  return { op: 'sticky.edit', card, id, ...patch };
}

/** A reply on a thread. */
export function commentReplyOp(card: string, thread: string, message: string, text: string): Op {
  return { op: 'comment.reply', card, thread, message, text };
}

/** Resolve, or reopen, a thread. `resolved` is the state it should have after. */
export function commentResolveOp(card: string, thread: string, resolved: boolean): Op {
  return resolved ? { op: 'comment.resolve', card, thread } : { op: 'comment.reopen', card, thread };
}

/** Delete a sticky, a picture, a whole thread, or one message of a thread. */
export function markRemoveOp(card: string, kind: 'thread' | 'sticky' | 'picture', id: string, message?: string): Op {
  if (kind === 'thread') return message ? { op: 'comment.rm', card, thread: id, message } : { op: 'comment.rm', card, thread: id };
  if (kind === 'sticky') return { op: 'sticky.rm', card, id };
  return { op: 'picture.rm', card, id };
}

// ---- What changed, from the pieces changesFor already listed ----

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
 * newest first: one line per thing someone else did, not per stamped piece. Which pieces changed is
 * `changesFor`'s list; this only phrases those pieces. It does not walk the stamps again to decide.
 */
export function changesSince(board: Board, cardId: string, since: number): ChangeItem[] {
  const view: Board = { ...board, reads: { ...board.reads, [OWNER]: { ...(board.reads[OWNER] ?? {}), [cardId]: since } } };
  const ch = changesFor(view, OWNER, cardId);
  if (!ch.changed) return [];
  const fresh = new Set(ch.pieces.map(pieceKey));
  const has = (key: string) => fresh.has(key);
  const card = findCard(board, cardId);
  const out: ChangeItem[] = [];
  const add = (key: string, verb: ChangeVerb, text: string, stamp: Pick<Stamp, 'rev' | 'author'>, mark?: ChangeItem['mark']) => out.push({ key, verb, text, author: stamp.author, rev: stamp.rev, ...(mark ? { mark } : {}) });
  if (card) {
    // Never opened: the card itself is the news, not its title and page.
    if (since === 0 && card.author.kind !== 'owner') add('new', 'added', card.kind === 'canvas' ? 'Made this canvas' : 'Put this card up', { rev: card.stamps.title.rev, author: card.author });
    else {
      if (has('title')) add('title', 'renamed', `Renamed it to “${card.title}”`, card.stamps.title);
      if (card.stamps.content && has('content')) add('content', 'content', 'Changed the page', card.stamps.content);
    }
    const leaves = ch.pieces.filter((p): p is Extract<PieceRef, { kind: 'state' }> => p.kind === 'state');
    if (leaves.length) {
      const stamped = leaves.flatMap((p) => {
        const stamp = card.stamps.state[statePathKey(p.path)];
        return stamp ? [{ path: p.path, stamp }] : [];
      });
      if (stamped.length) {
        const latest = stamped.reduce((a, b) => (b.stamp.rev > a.stamp.rev ? b : a));
        const names = stamped.map((s) => s.path.join('.'));
        add('state', 'state', stamped.length === 1 ? `Set ${names[0]}` : `Set ${stamped.length} values: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`, latest.stamp);
      }
    }
    for (const t of card.threads) {
      const mark = { kind: 'thread' as const, id: t.id };
      const first = t.messages[0];
      const isNew = !!first && has(`msg:${t.id}:${first.id}`) && t.stamps.anchor.rev === first.stamp.rev;
      if (isNew && first) add(`t:${t.id}`, 'commented', `Commented: “${clipText(first.text)}”`, first.stamp, mark);
      for (const m of t.messages.slice(isNew ? 1 : 0)) if (has(`msg:${t.id}:${m.id}`)) add(`m:${m.id}`, 'replied', `Replied: “${clipText(m.text)}”`, m.stamp, mark);
      if (!isNew && has(`thread:${t.id}:resolved`)) add(`r:${t.id}`, t.resolved ? 'resolved' : 'reopened', t.resolved ? 'Resolved a comment' : 'Reopened a comment', t.stamps.resolved, mark);
      if (!isNew && has(`thread:${t.id}:anchor`)) add(`a:${t.id}`, 'moved-pin', 'Moved a comment pin', t.stamps.anchor, mark);
    }
    for (const s of card.stickies) {
      const mark = { kind: 'sticky' as const, id: s.id };
      const st = s.stamps;
      if (has(`sticky:${s.id}:anchor`) && st.anchor.rev === st.text.rev && st.text.rev === st.color.rev && st.color.rev === st.box.rev) {
        add(`s:${s.id}`, 'added', s.text ? `Added a sticky: “${clipText(s.text)}”` : 'Added a sticky', st.anchor, mark);
        continue;
      }
      if (has(`sticky:${s.id}:text`)) add(`st:${s.id}`, 'edited', `Edited a sticky: “${clipText(s.text)}”`, st.text, mark);
      if (has(`sticky:${s.id}:color`)) add(`sc:${s.id}`, 'recolored', 'Recolored a sticky', st.color, mark);
      if (has(`sticky:${s.id}:box`)) add(`sb:${s.id}`, 'moved', 'Moved or resized a sticky', st.box, mark);
      if (has(`sticky:${s.id}:anchor`)) add(`sa:${s.id}`, 'reattached', 'Reattached a sticky', st.anchor, mark);
    }
    for (const p of card.pictures) {
      const mark = { kind: 'picture' as const, id: p.id };
      const st = p.stamps;
      if (has(`picture:${p.id}:anchor`) && st.anchor.rev === st.file.rev && st.file.rev === st.box.rev) {
        add(`p:${p.id}`, 'added', 'Added a picture', st.anchor, mark);
        continue;
      }
      if (has(`picture:${p.id}:file`)) add(`pf:${p.id}`, 'replaced', 'Replaced a picture', st.file, mark);
      if (has(`picture:${p.id}:box`)) add(`pb:${p.id}`, 'moved', 'Moved or resized a picture', st.box, mark);
      if (has(`picture:${p.id}:anchor`)) add(`pa:${p.id}`, 'reattached', 'Reattached a picture', st.anchor, mark);
    }
  }
  const gone: Partial<Record<PieceKind, string>> = { thread: 'a comment thread', message: 'a comment', sticky: 'a sticky', picture: 'a picture', state: 'a value', card: 'the card' };
  for (const t of ch.removed) add(`x:${t.kind}:${t.id}`, 'removed', t.kind === 'state' ? `Removed ${parseStatePathKey(t.id).join('.')}` : `Removed ${gone[t.kind] ?? 'something'}`, t);
  return out.sort((a, b) => b.rev - a.rev);
}

function pieceKey(p: PieceRef): string {
  switch (p.kind) {
    case 'title':
      return 'title';
    case 'content':
      return 'content';
    case 'state':
      return `state:${statePathKey(p.path)}`;
    case 'thread':
      return `thread:${p.id}:${p.field}`;
    case 'message':
      return `msg:${p.thread}:${p.id}`;
    case 'sticky':
      return `sticky:${p.id}:${p.field}`;
    case 'picture':
      return `picture:${p.id}:${p.field}`;
  }
}

function clipText(s: string, max = 60): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
