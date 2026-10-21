// The Whiteboard's model (docs/whiteboard.md): one board per floor, its cards and their marks, the
// operations that change it, and the one pure reducer the server and the client both run. The server
// applies every accepted batch with `applyOps` and sends the same batch to the windows as a patch, so
// a window that applies it to the board it has lands on exactly the server's board.
//
// Only the current state is kept. "Changed since you last looked" comes from stamps: each
// independently editable piece carries the revision and the author of its last change, each reader
// has a read point per card, and removals leave a tombstone until every reader has seen them.

/** The layout width every artifact is laid out at, and the coordinate system its marks use (CSS px). */
export const CANONICAL_WIDTH = 1280;

/** A tombstone goes after this long even if a reader never saw it. */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const KB = 1024;
const MB = 1024 * KB;

// Limits. A write over one is refused, naming the limit.
export const MAX_CARDS = 200;
export const MAX_TITLE_LENGTH = 120;
/** A card's entry HTML file. */
export const MAX_HTML_BYTES = 2 * MB;
/** Any other file: an asset of a card's content, or a picture. */
export const MAX_ASSET_BYTES = 100 * MB;
/** Everything one card holds: its content's files and its pictures, each distinct file counted once. */
export const MAX_CARD_BYTES = 100 * MB;
/** Every distinct file on the floor's board. */
export const MAX_FLOOR_BYTES = 1024 * MB;
export const MAX_FILES_PER_CARD = 500;
/** A card's state, as UTF-8 JSON. */
export const MAX_STATE_BYTES = 256 * KB;
/** How deep a card's state may nest, and so the longest state path. */
export const MAX_STATE_DEPTH = 32;
export const MAX_STATE_KEY_LENGTH = 200;
export const MAX_ACTION_NAME_LENGTH = 100;
export const MAX_COMMENT_LENGTH = 10_000;
export const MAX_STICKY_TEXT_LENGTH = 2_000;
export const MAX_THREADS_PER_CARD = 300;
export const MAX_MESSAGES_PER_THREAD = 200;
export const MAX_STICKIES_PER_CARD = 300;
export const MAX_PICTURES_PER_CARD = 100;
export const MAX_OPS_PER_BATCH = 1000;
/** How far from the page's origin a point or box may be, in canonical px. */
export const MAX_COORD = 1_000_000;
/** The smallest and largest side of a sticky or picture, in canonical px. */
export const MIN_MARK_SIZE = 16;
export const MAX_MARK_SIZE = 8192;

/** The colors a sticky comes in, by name; the board stores the name. */
export const STICKY_COLORS = {
  yellow: '#ffd866',
  pink: '#ff9fc6',
  blue: '#8fd3ff',
  green: '#a6e3a1',
  orange: '#ffb070',
  purple: '#cdb4ff',
} as const;
export type StickyColor = keyof typeof STICKY_COLORS;
export const STICKY_SIZE = { w: 200, h: 160 } as const;

export const PICTURE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/** Where the office saves plain form fields in a card's state, by field name or id. */
export const FIELDS_KEY = 'fields';
/** Where `whiteboard.action(name, data)` records the last press of each action, by name. */
export const ACTIONS_KEY = 'actions';

/** A reader is the owner or a worker, by worker id. */
export type ReaderId = string;
export const OWNER: ReaderId = 'owner';

/** Who did something, as they were when they did it, so a dismissed worker's work still says whose it is. */
export type Author = { kind: 'owner' } | { kind: 'worker'; id: string; name: string; color: string };
export const OWNER_AUTHOR: Author = { kind: 'owner' };

export function readerOf(author: Author): ReaderId {
  return author.kind === 'owner' ? OWNER : author.id;
}

/** The revision and the author of a piece's last change. */
export interface Stamp {
  rev: number;
  author: Author;
}

export interface Point {
  x: number;
  y: number;
}

/** A sticky's or picture's top-left, as an offset from its anchor's point, and its size (canonical px). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a mark is attached. On a canvas card, always a point. On an artifact, usually an element: its
 * `data-wb-id` when it has one, else a CSS selector plus a quote of its text to find it again after
 * the page changes, with the mark's offset from the element's top-left. `point` is the canonical page
 * coordinate the mark was placed at, which a mark falls back to when its element can't be found.
 */
export type Anchor = PointAnchor | ElementAnchor;
export interface PointAnchor {
  kind: 'point';
  point: Point;
}
export interface ElementAnchor {
  kind: 'element';
  wbId?: string;
  selector?: string;
  quote?: string;
  offset: Point;
  point: Point;
}

/** A file the board holds: a content-addressed blob in the floor's store (`blobs/<hash>`). */
export interface FileRef {
  /** sha256 of the bytes, lowercase hex. */
  hash: string;
  size: number;
  mime: string;
}

/** An artifact's files: its entry page, and every file by its path relative to the card's folder. */
export interface CardContent {
  entry: string;
  files: Record<string, FileRef>;
  /** References in the page that couldn't be collected (outside the folder, too large, missing). */
  missing?: { ref: string; reason: string }[];
}

/**
 * A card linked to a file in a worktree, which the office watches. Server-owned metadata: setting it
 * is never a change anyone reads as one. `author` is who linked it, and authors the content updates
 * the watcher makes.
 */
export interface CardLink {
  path: string;
  /** A folder package (`--dir`), not a single file. */
  dir?: boolean;
  status: 'ok' | 'broken';
  reason?: string;
  author: Author;
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type StateObject = { [key: string]: Json };

export interface Message {
  id: string;
  /** Who wrote it. */
  author: Author;
  text: string;
  at: number;
  stamp: Stamp;
}

export interface Thread {
  id: string;
  anchor: Anchor;
  /** Set by anchor resolution when the anchor can't be placed on the page as it is now. */
  detached?: boolean;
  resolved: boolean;
  messages: Message[];
  stamps: { resolved: Stamp; anchor: Stamp };
}

export interface Sticky {
  id: string;
  text: string;
  color: StickyColor;
  anchor: Anchor;
  box: Box;
  detached?: boolean;
  stamps: { text: Stamp; color: Stamp; box: Stamp; anchor: Stamp };
}

export interface Picture {
  id: string;
  file: FileRef;
  anchor: Anchor;
  box: Box;
  detached?: boolean;
  stamps: { file: Stamp; box: Stamp; anchor: Stamp };
}

/** The region of a card the owner last looked at in the window (canonical px), which the wall shows. */
export interface CardView {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CardKind = 'html' | 'canvas';

export interface Card {
  id: string;
  kind: CardKind;
  title: string;
  /** Who made it. */
  author: Author;
  createdAt: number;
  /** When a stamped piece of it last changed or was removed. */
  updatedAt: number;
  /** An html card's files; a canvas card has none. */
  content?: CardContent;
  link?: CardLink;
  state: StateObject;
  view?: CardView;
  threads: Thread[];
  stickies: Sticky[];
  pictures: Picture[];
  /** `state` has one stamp per leaf, keyed by `statePathKey` of the leaf's path. */
  stamps: { title: Stamp; content?: Stamp; state: Record<string, Stamp> };
  /** The last revision each part of the render changed at (pieces, removals and detached flags), the render cache's key. */
  revs: { content: number; state: number; marks: number };
}

/** What the wall shows: the grid, or one card. */
export type Selection = { kind: 'grid' } | { kind: 'card'; id: string };

export type PieceKind = 'card' | 'thread' | 'message' | 'sticky' | 'picture' | 'state';

/** A removed piece, with no content, so its removal still reads as a change. */
export interface Tombstone {
  kind: PieceKind;
  /** The piece's id; a state leaf's `statePathKey`. */
  id: string;
  /** The card it was on (a removed card's own id). */
  card: string;
  /** A message's thread. */
  parent?: string;
  rev: number;
  author: Author;
  at: number;
}

export interface Board {
  v: 1;
  rev: number;
  /** In the order they were made. */
  cards: Card[];
  selection: Selection;
  /** Each reader's read point per card: they have seen every change up to that revision. */
  reads: Record<ReaderId, Record<string, number>>;
  tombstones: Tombstone[];
}

export function emptyBoard(): Board {
  return { v: 1, rev: 0, cards: [], selection: { kind: 'grid' }, reads: {}, tombstones: [] };
}

export function findCard(board: Board, id: string): Card | undefined {
  return board.cards.find((c) => c.id === id);
}

export function cardsNewestFirst(board: Board): Card[] {
  // Reversed first, so the stable sort puts the later of two cards made in the same millisecond first.
  return board.cards
    .slice()
    .reverse()
    .sort((a, b) => b.createdAt - a.createdAt);
}

// ---- Operations ----

/**
 * Everything that changes a board. New pieces carry their ids, made by whoever sends the operation,
 * so a queued batch can refer to a card or mark it made before the server saw it. Files are referenced
 * by blob hash: the server writes the blobs before it applies the batch.
 */
export type Op =
  // Cards.
  | { op: 'card.create'; card: string; kind: CardKind; title: string; content?: CardContent }
  | { op: 'card.title'; card: string; title: string }
  /** Replaces an html card's files. Refused on a linked card unless `viaLink` (server-only: the watcher's update). */
  | { op: 'card.content'; card: string; content: CardContent; viaLink?: boolean }
  | { op: 'card.rm'; card: string }
  /** Server-only: link status, or null to unlink. */
  | { op: 'card.link'; card: string; link: CardLink | null }
  | { op: 'card.view'; card: string; view: CardView | null }
  // State. `path` is a list of keys; [] is the whole state.
  | { op: 'state.set'; card: string; path: string[]; value: Json }
  | { op: 'state.merge'; card: string; path: string[]; value: StateObject }
  | { op: 'state.del'; card: string; path: string[] }
  /** The last press of a named action: sets `state.actions[name]` to `{ name, data, at }`. */
  | { op: 'state.action'; card: string; name: string; data?: Json }
  // Comment threads.
  | { op: 'comment.add'; card: string; thread: string; message: string; anchor: Anchor; text: string }
  | { op: 'comment.reply'; card: string; thread: string; message: string; text: string }
  | { op: 'comment.edit'; card: string; thread: string; message: string; text: string }
  | { op: 'comment.resolve'; card: string; thread: string }
  | { op: 'comment.reopen'; card: string; thread: string }
  /** Moves a thread's pin, which is also how a detached thread is reattached. */
  | { op: 'comment.reattach'; card: string; thread: string; anchor: Anchor }
  /** Removes a thread, or one message (the thread goes with its last one). */
  | { op: 'comment.rm'; card: string; thread: string; message?: string }
  // Stickies.
  | { op: 'sticky.add'; card: string; id: string; anchor: Anchor; box?: Partial<Box>; text?: string; color?: StickyColor }
  | { op: 'sticky.edit'; card: string; id: string; text?: string; color?: StickyColor }
  | { op: 'sticky.move'; card: string; id: string; box: Partial<Box> }
  | { op: 'sticky.reattach'; card: string; id: string; anchor: Anchor }
  | { op: 'sticky.rm'; card: string; id: string }
  // Pictures.
  | { op: 'picture.add'; card: string; id: string; file: FileRef; anchor: Anchor; box: Partial<Box> & { w: number; h: number } }
  | { op: 'picture.file'; card: string; id: string; file: FileRef }
  | { op: 'picture.move'; card: string; id: string; box: Partial<Box> }
  | { op: 'picture.reattach'; card: string; id: string; anchor: Anchor }
  | { op: 'picture.rm'; card: string; id: string }
  // The wall.
  | { op: 'show'; selection: Selection }
  /** Anchor resolution's verdict on marks (threads, stickies, pictures) by id; unknown ids are skipped. */
  | { op: 'marks.resolve'; card: string; marks: { id: string; detached: boolean }[] }
  /** Moves the actor's read point for these cards to a snapshot revision (never backwards). */
  | { op: 'read'; cards: string[]; rev: number }
  /** Server-only: drops tombstones every reader has seen, or that are older than the TTL. */
  | { op: 'prune'; readers?: ReaderId[] }
  /** Server-only: forgets a reader's read points (a dismissed worker), so it no longer holds tombstones. */
  | { op: 'reader.forget'; reader: ReaderId };

export type OpName = Op['op'];

export const OP_NAMES: readonly OpName[] = [
  'card.create',
  'card.title',
  'card.content',
  'card.rm',
  'card.link',
  'card.view',
  'state.set',
  'state.merge',
  'state.del',
  'state.action',
  'comment.add',
  'comment.reply',
  'comment.edit',
  'comment.resolve',
  'comment.reopen',
  'comment.reattach',
  'comment.rm',
  'sticky.add',
  'sticky.edit',
  'sticky.move',
  'sticky.reattach',
  'sticky.rm',
  'picture.add',
  'picture.file',
  'picture.move',
  'picture.reattach',
  'picture.rm',
  'show',
  'marks.resolve',
  'read',
  'prune',
  'reader.forget',
];

/** Operations only the office itself applies: the server refuses them from a window or an agent. */
export function isServerOnly(op: Op): boolean {
  return op.op === 'card.link' || op.op === 'prune' || op.op === 'reader.forget' || (op.op === 'card.content' && !!op.viaLink);
}

export interface OpError {
  /** The failing operation's index in the batch, or -1 when the batch as a whole was refused. */
  index: number;
  op?: string;
  /** Why, on its own. */
  reason: string;
  /** Which operation failed and why, for people and agents. */
  message: string;
}

export type ApplyResult = { ok: true; board: Board } | { ok: false; error: OpError };

/**
 * Applies a batch, all of it or none of it. The whole batch is one revision: every piece it changes is
 * stamped `{ rev, author: actor }`, and the board's revision becomes `rev`, which must be after the
 * board's. `now` is the time the server accepted it (ms), for times on cards, messages, actions and
 * tombstones, so replaying a patch gives the same board. A failure names the operation and changes
 * nothing. The board passed in is never modified.
 */
export function applyOps(board: Board, ops: readonly Op[], actor: Author, rev: number, now: number): ApplyResult {
  const batch = (reason: string): ApplyResult => ({ ok: false, error: { index: -1, reason, message: reason } });
  if (!isAuthor(actor)) return batch('The actor must be the owner or a worker with an id, a name and a color');
  if (!Number.isSafeInteger(rev) || rev <= board.rev) return batch(`Revision ${rev} must be after the board's revision ${board.rev}`);
  if (!Number.isFinite(now)) return batch('The batch needs the time it was accepted');
  if (!Array.isArray(ops) || ops.length === 0) return batch('There are no operations to apply');
  if (ops.length > MAX_OPS_PER_BATCH) return batch(`A batch holds at most ${MAX_OPS_PER_BATCH} operations (got ${ops.length})`);
  const tx = new Tx(board, actor, rev, now);
  for (let i = 0; i < ops.length; i++) {
    try {
      tx.apply(ops[i]);
    } catch (e) {
      if (!(e instanceof OpFail)) throw e;
      const name = isObject(ops[i]) && typeof ops[i].op === 'string' ? ops[i].op : undefined;
      return { ok: false, error: { index: i, op: name, reason: e.message, message: `Operation ${i}${name ? ` (${name})` : ''} failed: ${e.message}. Nothing was changed.` } };
    }
  }
  return { ok: true, board: tx.finish() };
}

/** Applies a patch the server sent: the same batch, actor, revision and time the server applied. */
export function applyPatch(board: Board, patch: BoardPatch): ApplyResult {
  return applyOps(board, patch.ops, patch.actor, patch.rev, patch.at);
}

// ---- State paths ----

/** The key a state leaf's stamp and tombstone are kept under. */
export function statePathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

export function parseStatePathKey(key: string): string[] {
  return JSON.parse(key);
}

/** A dotted path as an agent types it (`fields.email`); '' is the root. Use a key list for keys with dots. */
export function parseStatePath(s: string): string[] {
  return s === '' ? [] : s.split('.');
}

/** The value at a path, or undefined. */
export function stateAt(state: StateObject, path: readonly string[]): Json | undefined {
  let cur: Json | undefined = state;
  for (const k of path) {
    if (!isPlainJsonObject(cur) || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Every leaf of a state: each value that isn't an object with keys (arrays are leaves, replaced whole). */
export function stateLeaves(state: StateObject): Map<string, Json> {
  const out = new Map<string, Json>();
  const walk = (obj: StateObject, prefix: string[]) => {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const p = [...prefix, k];
      if (isPlainJsonObject(v) && Object.keys(v).length > 0) walk(v, p);
      else out.set(statePathKey(p), v);
    }
  };
  walk(state, []);
  return out;
}

// ---- Reading: changed marks ----

export type PieceRef =
  | { kind: 'title' }
  | { kind: 'content' }
  | { kind: 'state'; path: string[] }
  | { kind: 'thread'; id: string; field: 'resolved' | 'anchor' }
  | { kind: 'message'; thread: string; id: string }
  | { kind: 'sticky'; id: string; field: 'text' | 'color' | 'box' | 'anchor' }
  | { kind: 'picture'; id: string; field: 'file' | 'box' | 'anchor' };

/** Every stamped piece of a card. */
export function cardPieces(card: Card): { ref: PieceRef; stamp: Stamp }[] {
  const out: { ref: PieceRef; stamp: Stamp }[] = [{ ref: { kind: 'title' }, stamp: card.stamps.title }];
  if (card.stamps.content) out.push({ ref: { kind: 'content' }, stamp: card.stamps.content });
  for (const [key, stamp] of Object.entries(card.stamps.state)) out.push({ ref: { kind: 'state', path: parseStatePathKey(key) }, stamp });
  for (const t of card.threads) {
    out.push({ ref: { kind: 'thread', id: t.id, field: 'resolved' }, stamp: t.stamps.resolved }, { ref: { kind: 'thread', id: t.id, field: 'anchor' }, stamp: t.stamps.anchor });
    for (const m of t.messages) out.push({ ref: { kind: 'message', thread: t.id, id: m.id }, stamp: m.stamp });
  }
  for (const s of card.stickies) for (const field of ['text', 'color', 'box', 'anchor'] as const) out.push({ ref: { kind: 'sticky', id: s.id, field }, stamp: s.stamps[field] });
  for (const p of card.pictures) for (const field of ['file', 'box', 'anchor'] as const) out.push({ ref: { kind: 'picture', id: p.id, field }, stamp: p.stamps[field] });
  return out;
}

/** A reader's read point for a card; 0 for one they never read. */
export function readPoint(board: Board, reader: ReaderId, card: string): number {
  const mine = Object.hasOwn(board.reads, reader) ? board.reads[reader] : undefined;
  return mine && Object.hasOwn(mine, card) ? mine[card] : 0;
}

/** Changed for a reader: after their read point, by someone else. */
export function isChanged(stamp: Pick<Stamp, 'rev' | 'author'>, reader: ReaderId, since: number): boolean {
  return stamp.rev > since && readerOf(stamp.author) !== reader;
}

export interface CardChanges {
  changed: boolean;
  pieces: PieceRef[];
  /** Removals the reader hasn't seen; for a removed card, its own tombstone. */
  removed: Tombstone[];
}

/** What changed on a card (or a removed card) for a reader since they last read it. */
export function changesFor(board: Board, reader: ReaderId, cardId: string): CardChanges {
  const since = readPoint(board, reader, cardId);
  const card = findCard(board, cardId);
  const pieces = card ? cardPieces(card).filter((p) => isChanged(p.stamp, reader, since)) : [];
  const removed = board.tombstones.filter((t) => t.card === cardId && isChanged(t, reader, since));
  return { changed: pieces.length > 0 || removed.length > 0, pieces: pieces.map((p) => p.ref), removed };
}

export function cardChanged(board: Board, reader: ReaderId, cardId: string): boolean {
  return changesFor(board, reader, cardId).changed;
}

/** The board's changes for a reader: the cards on it that changed, and the cards removed since they last read them. */
export function boardChanges(board: Board, reader: ReaderId): { cards: string[]; removed: Tombstone[] } {
  const cards = board.cards.filter((c) => cardChanged(board, reader, c.id)).map((c) => c.id);
  const removed = board.tombstones.filter((t) => t.kind === 'card' && isChanged(t, reader, readPoint(board, reader, t.card)));
  return { cards, removed };
}

/**
 * Moves a reader's read point for each of these cards to `rev` (a snapshot revision no later than the
 * board's), never backwards. Cards neither on the board nor tombstoned are skipped. The board passed in
 * is never modified; the revision doesn't change. The `read` operation does the same inside a batch.
 */
export function advanceReads(board: Board, reader: ReaderId, cardIds: readonly string[], rev: number): Board {
  return { ...board, reads: advanced(board, board.reads, reader, cardIds, rev) };
}

function advanced(board: Board, reads: Board['reads'], reader: ReaderId, cardIds: readonly string[], rev: number): Board['reads'] {
  const known = (id: string) => board.cards.some((c) => c.id === id) || board.tombstones.some((t) => t.kind === 'card' && t.id === id);
  const mine = { ...(Object.hasOwn(reads, reader) ? reads[reader] : {}) };
  let moved = false;
  for (const id of cardIds) {
    if (!known(id) || (Object.hasOwn(mine, id) && mine[id] >= rev)) continue;
    mine[id] = rev;
    moved = true;
  }
  return moved ? { ...reads, [reader]: mine } : reads;
}

/**
 * Drops tombstones every reader other than its author has read past, and any older than the TTL, then
 * read points for cards that are gone for good. `readers` are the readers that count (the owner and
 * the floor's workers); by default the owner and everyone with a read point.
 */
export function pruneTombstones(board: Board, now: number, readers?: readonly ReaderId[]): Board {
  const who = readers ?? [OWNER, ...Object.keys(board.reads).filter((r) => r !== OWNER)];
  const tombstones = board.tombstones.filter((t) => now - t.at < TOMBSTONE_TTL_MS && who.some((r) => r !== readerOf(t.author) && readPoint(board, r, t.card) < t.rev));
  const live = new Set([...board.cards.map((c) => c.id), ...tombstones.filter((t) => t.kind === 'card').map((t) => t.id)]);
  const reads = Object.fromEntries(Object.entries(board.reads).map(([reader, points]) => [reader, Object.fromEntries(Object.entries(points).filter(([id]) => live.has(id)))]));
  return { ...board, tombstones, reads };
}

// ---- Wire types (wrapped by the `whiteboard` messages in protocol.ts) ----

/** A batch the server applied, sent to every window so it can apply the same batch with `applyPatch`. */
export interface BoardPatch {
  rev: number;
  at: number;
  actor: Author;
  ops: Op[];
}

/**
 * What a client (an office tab, or one `office-whiteboard` run) sends: its server-issued epoch and the
 * batch's sequence number in that epoch, which make a retry recognisable and applied once.
 */
export interface OpEnvelope {
  epoch: string;
  seq: number;
  ops: Op[];
}

export type WhiteboardUpdate =
  /** The whole board, on connect and on resync, with the epoch this connection numbers its batches in. */
  | { kind: 'snapshot'; board: Board; epoch: string }
  | { kind: 'patch'; patch: BoardPatch }
  /** The batch is committed, at this revision (also sent for a retry that was already applied). */
  | { kind: 'ack'; epoch: string; seq: number; rev: number }
  /** The batch failed validation and changed nothing. */
  | { kind: 'rejected'; epoch: string; seq: number; reason: 'invalid'; error: OpError }
  /** The epoch is no longer in the server's record, so the batch can't be proved new: keep it as a draft. */
  | { kind: 'rejected'; epoch: string; seq: number; reason: 'expired' };

/** An envelope from untrusted input, or why it isn't one. The operations themselves are checked by `applyOps`. */
export function parseEnvelope(v: unknown): OpEnvelope | string {
  if (!isObject(v)) return 'The envelope must be an object';
  if (typeof v.epoch !== 'string' || !v.epoch || v.epoch.length > 100) return 'The envelope needs its epoch';
  if (!Number.isSafeInteger(v.seq) || (v.seq as number) < 1) return 'The envelope needs a sequence number from 1';
  if (!Array.isArray(v.ops)) return 'The envelope needs a list of operations';
  return { epoch: v.epoch, seq: v.seq as number, ops: v.ops };
}

// ---- Validation ----

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HASH = /^[0-9a-f]{64}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;.*)?$/i;

/** Card, mark and message ids: 1-64 letters, digits, `_` or `-`, starting with a letter or digit. */
export function isPieceId(v: unknown): v is string {
  return typeof v === 'string' && ID.test(v);
}

export function isAuthor(v: unknown): v is Author {
  if (!isObject(v)) return false;
  if (v.kind === 'owner') return true;
  return v.kind === 'worker' && isPieceId(v.id) && v.id !== OWNER && typeof v.name === 'string' && v.name.length > 0 && v.name.length <= 100 && typeof v.color === 'string' && v.color.length <= 32;
}

function copyAuthor(a: Author): Author {
  return a.kind === 'owner' ? { kind: 'owner' } : { kind: 'worker', id: a.id, name: a.name, color: a.color };
}

/** A path inside a card's folder: relative, `/`-separated, no `.` or `..` segments, no drive or control characters. */
export function isContentPath(p: string): boolean {
  if (p.length === 0 || p.length > 512 || p === '__proto__' || p.startsWith('/') || p.includes('\\') || /[\u0000-\u001f]/.test(p) || /^[A-Za-z]:/.test(p)) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPlainJsonObject(v: unknown): v is StateObject {
  return isObject(v);
}

class OpFail extends Error {}

function fail(reason: string): never {
  throw new OpFail(reason);
}

function text(v: unknown, what: string, max: number, opts: { empty?: boolean } = {}): string {
  if (typeof v !== 'string') fail(`${what} must be a string`);
  if (!opts.empty && v.trim() === '') fail(`${what} can't be empty`);
  if (v.length > max) fail(`${what} is ${v.length} characters; the limit is ${max}`);
  return v;
}

function pieceId(v: unknown, what: string): string {
  if (!isPieceId(v)) fail(`${what} must be an id of 1-64 letters, digits, "_" or "-"`);
  return v;
}

function coord(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > MAX_COORD) fail(`${what} must be a number within ±${MAX_COORD}`);
  return v;
}

function size(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < MIN_MARK_SIZE || v > MAX_MARK_SIZE) fail(`${what} must be between ${MIN_MARK_SIZE} and ${MAX_MARK_SIZE}`);
  return v;
}

function point(v: unknown, what: string): Point {
  if (!isObject(v)) fail(`${what} must be a point { x, y }`);
  return { x: coord(v.x, `${what}.x`), y: coord(v.y, `${what}.y`) };
}

function anchorOf(v: unknown, kind: CardKind): Anchor {
  if (!isObject(v)) fail('anchor must be an object');
  if (v.kind === 'point') return { kind: 'point', point: point(v.point, 'anchor.point') };
  if (v.kind !== 'element') fail('anchor.kind must be "point" or "element"');
  if (kind === 'canvas') fail('A canvas card anchors marks to points only');
  const a: ElementAnchor = { kind: 'element', offset: v.offset === undefined ? { x: 0, y: 0 } : point(v.offset, 'anchor.offset'), point: point(v.point, 'anchor.point') };
  if (v.wbId !== undefined) a.wbId = text(v.wbId, 'anchor.wbId', 200);
  if (v.selector !== undefined) a.selector = text(v.selector, 'anchor.selector', 2000);
  if (v.quote !== undefined) a.quote = text(v.quote, 'anchor.quote', 500);
  if (!a.wbId && !a.selector) fail('An element anchor needs a wbId or a selector');
  return a;
}

function boxOf(v: unknown, base: Box): Box {
  if (!isObject(v)) fail('box must be an object { x, y, w, h }');
  if (v.x === undefined && v.y === undefined && v.w === undefined && v.h === undefined) fail('box must set at least one of x, y, w and h');
  return {
    x: v.x === undefined ? base.x : coord(v.x, 'box.x'),
    y: v.y === undefined ? base.y : coord(v.y, 'box.y'),
    w: v.w === undefined ? base.w : size(v.w, 'box.w'),
    h: v.h === undefined ? base.h : size(v.h, 'box.h'),
  };
}

function fileOf(v: unknown, what: string): FileRef {
  if (!isObject(v)) fail(`${what} must be a file { hash, size, mime }`);
  if (typeof v.hash !== 'string' || !HASH.test(v.hash)) fail(`${what}.hash must be a lowercase sha256 hex digest`);
  if (!Number.isSafeInteger(v.size) || v.size < 0) fail(`${what}.size must be a whole number of bytes`);
  if (typeof v.mime !== 'string' || v.mime.length > 200 || !MIME.test(v.mime)) fail(`${what}.mime must be a media type like text/html`);
  return { hash: v.hash, size: v.size, mime: v.mime };
}

function pictureFile(v: unknown): FileRef {
  const f = fileOf(v, 'file');
  if (!(PICTURE_MIMES as readonly string[]).includes(f.mime)) fail(`A picture must be ${PICTURE_MIMES.join(', ')} (got ${f.mime})`);
  if (f.size > MAX_ASSET_BYTES) fail(`The picture is ${bytes(f.size)}; the limit per file is ${bytes(MAX_ASSET_BYTES)}`);
  return f;
}

function contentOf(v: unknown): CardContent {
  if (!isObject(v)) fail('content must be an object { entry, files }');
  if (!isObject(v.files)) fail('content.files must map relative paths to files');
  const paths = Object.keys(v.files);
  if (paths.length === 0) fail('content.files is empty');
  if (paths.length > MAX_FILES_PER_CARD) fail(`The content has ${paths.length} files; the limit per card is ${MAX_FILES_PER_CARD}`);
  const files: Record<string, FileRef> = {};
  for (const p of paths) {
    if (!isContentPath(p)) fail(`The content path "${p}" must be relative and inside the card's folder`);
    files[p] = fileOf(v.files[p], `content.files["${p}"]`);
  }
  if (typeof v.entry !== 'string' || !Object.hasOwn(files, v.entry)) fail('content.entry must be one of content.files');
  const entry = files[v.entry];
  if (!/^text\/html\b/i.test(entry.mime)) fail(`The entry page ${v.entry} must be text/html (got ${entry.mime})`);
  if (entry.size > MAX_HTML_BYTES) fail(`The HTML is ${bytes(entry.size)}; the limit per card is ${bytes(MAX_HTML_BYTES)}`);
  for (const p of paths) {
    if (p !== v.entry && files[p].size > MAX_ASSET_BYTES) fail(`The asset ${p} is ${bytes(files[p].size)}; the limit per file is ${bytes(MAX_ASSET_BYTES)}`);
  }
  const content: CardContent = { entry: v.entry, files };
  if (v.missing !== undefined) {
    if (!Array.isArray(v.missing) || v.missing.length > 500) fail('content.missing must be a list of at most 500 references');
    content.missing = v.missing.map((m: unknown, i: number) => {
      if (!isObject(m)) fail(`content.missing[${i}] must be { ref, reason }`);
      return { ref: text(m.ref, `content.missing[${i}].ref`, 2000), reason: text(m.reason, `content.missing[${i}].reason`, 500) };
    });
  }
  return content;
}

function linkOf(v: unknown): CardLink {
  if (!isObject(v)) fail('link must be an object { path, status, author }');
  if (v.status !== 'ok' && v.status !== 'broken') fail('link.status must be "ok" or "broken"');
  if (!isAuthor(v.author)) fail('link.author must be who linked it');
  const link: CardLink = { path: text(v.path, 'link.path', 4096), status: v.status, author: copyAuthor(v.author) };
  if (v.dir) link.dir = true;
  if (v.reason !== undefined) link.reason = text(v.reason, 'link.reason', 500);
  return link;
}

function statePath(v: unknown, opts: { root: boolean }): string[] {
  if (!Array.isArray(v)) fail('path must be a list of keys ([] for the whole state)');
  if (!opts.root && v.length === 0) fail('path must name at least one key');
  if (v.length > MAX_STATE_DEPTH) fail(`path is ${v.length} keys deep; the limit is ${MAX_STATE_DEPTH}`);
  for (const k of v) stateKey(k, 'Each key of path');
  return v.slice();
}

function stateKey(k: unknown, what: string): void {
  if (typeof k !== 'string' || k === '') fail(`${what} must be a non-empty string`);
  if (k.length > MAX_STATE_KEY_LENGTH) fail(`The state key "${k.slice(0, 40)}…" is ${k.length} characters; the limit is ${MAX_STATE_KEY_LENGTH}`);
  if (k === '__proto__') fail('"__proto__" can\'t be a state key');
}

/** A JSON value (plain objects, arrays, finite numbers, strings, booleans, null), copied. */
function jsonOf(v: unknown, what: string, depth = 0): Json {
  if (depth > MAX_STATE_DEPTH) fail(`${what} nests deeper than ${MAX_STATE_DEPTH} levels`);
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail(`${what} holds a number JSON can't store`);
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => jsonOf(x, what, depth + 1));
  if (isObject(v)) {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) fail(`${what} must be plain JSON`);
    const out: StateObject = {};
    for (const k of Object.keys(v)) {
      stateKey(k, `A key in ${what}`);
      out[k] = jsonOf(v[k], what, depth + 1);
    }
    return out;
  }
  fail(`${what} must be JSON`);
}

/** Equal as JSON, ignoring key order. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (isObject(a) && isObject(b) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

/** UTF-8 length without TextEncoder, which isn't ES2022. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

function bytes(n: number): string {
  if (n >= MB) return `${Math.round((n / MB) * 10) / 10} MB`;
  if (n >= KB) return `${Math.round((n / KB) * 10) / 10} KB`;
  return `${n} bytes`;
}

/** Distinct files by hash, and their total size. */
function distinctBytes(files: Iterable<FileRef>, seen = new Map<string, number>()): number {
  for (const f of files) if (!seen.has(f.hash)) seen.set(f.hash, f.size);
  let total = 0;
  for (const n of seen.values()) total += n;
  return total;
}

function cardFiles(card: Card): FileRef[] {
  return [...Object.values(card.content?.files ?? {}), ...card.pictures.map((p) => p.file)];
}

// ---- The reducer ----

/** One batch in progress: cards it touches are copied first, so the board it started from is never changed. */
class Tx {
  private readonly cards: Card[];
  private readonly copied = new Set<string>();
  private tombstones: Tombstone[];
  private reads: Board['reads'];
  private selection: Selection;
  private readonly actor: Author;

  constructor(
    private readonly base: Board,
    actor: Author,
    private readonly rev: number,
    private readonly now: number,
  ) {
    this.actor = copyAuthor(actor);
    this.cards = base.cards.slice();
    this.tombstones = base.tombstones.slice();
    this.reads = base.reads;
    this.selection = base.selection;
  }

  finish(): Board {
    return { v: 1, rev: this.rev, cards: this.cards, selection: this.selection, reads: this.reads, tombstones: this.tombstones };
  }

  private stamp(): Stamp {
    return { rev: this.rev, author: this.actor };
  }

  /** A card this batch may change. */
  private card(id: unknown): Card {
    const i = this.cards.findIndex((c) => c.id === id);
    if (i < 0) fail(typeof id === 'string' ? `There is no card "${id}" on the board` : 'card must be a card id');
    if (!this.copied.has(this.cards[i].id)) {
      this.cards[i] = JSON.parse(JSON.stringify(this.cards[i]));
      this.copied.add(this.cards[i].id);
    }
    return this.cards[i];
  }

  /** A stamped piece changed or went: the card was updated, and so was this part of its render. */
  private touch(card: Card, part: keyof Card['revs']) {
    card.updatedAt = this.now;
    card.revs[part] = this.rev;
  }

  private bury(card: string, kind: PieceKind, id: string, parent?: string) {
    this.unbury(card, kind, id);
    const t: Tombstone = { kind, id, card, rev: this.rev, author: this.actor, at: this.now };
    if (parent) t.parent = parent;
    this.tombstones.push(t);
  }

  private unbury(card: string, kind: PieceKind, id: string) {
    this.tombstones = this.tombstones.filter((t) => !(t.card === card && t.kind === kind && t.id === id));
  }

  /** Mark and message ids are unique within a card, and never reuse one whose tombstone is still there. */
  private freshMarkId(card: Card, v: unknown, what: string): string {
    const id = pieceId(v, what);
    const taken =
      card.threads.some((t) => t.id === id || t.messages.some((m) => m.id === id)) ||
      card.stickies.some((s) => s.id === id) ||
      card.pictures.some((p) => p.id === id) ||
      this.tombstones.some((t) => t.card === card.id && t.kind !== 'card' && t.kind !== 'state' && t.id === id);
    if (taken) fail(`The id "${id}" is already used on card "${card.id}"`);
    return id;
  }

  private thread(card: Card, id: unknown): Thread {
    const t = card.threads.find((x) => x.id === id);
    if (!t) fail(`There is no comment thread "${String(id)}" on card "${card.id}"`);
    return t;
  }

  private sticky(card: Card, id: unknown): Sticky {
    const s = card.stickies.find((x) => x.id === id);
    if (!s) fail(`There is no sticky "${String(id)}" on card "${card.id}"`);
    return s;
  }

  private picture(card: Card, id: unknown): Picture {
    const p = card.pictures.find((x) => x.id === id);
    if (!p) fail(`There is no picture "${String(id)}" on card "${card.id}"`);
    return p;
  }

  /** Sets a stamped field, keeping its stamp when the value doesn't change. True when it changed. */
  private setPiece<T extends object, K extends keyof T & string>(target: T, stamps: Partial<Record<K, Stamp>>, field: K, value: T[K]): boolean {
    if (jsonEqual(target[field], value)) return false;
    target[field] = value;
    stamps[field] = this.stamp();
    return true;
  }

  private checkCardBytes(card: Card) {
    const total = distinctBytes(cardFiles(card));
    if (total > MAX_CARD_BYTES) fail(`Card "${card.id}" would hold ${bytes(total)}; the limit per card is ${bytes(MAX_CARD_BYTES)}`);
    const seen = new Map<string, number>();
    for (const c of this.cards) distinctBytes(cardFiles(c), seen);
    const floor = distinctBytes([], seen);
    if (floor > MAX_FLOOR_BYTES) fail(`The board would hold ${bytes(floor)}; the limit per floor is ${bytes(MAX_FLOOR_BYTES)}`);
  }

  apply(raw: Op) {
    if (!isObject(raw)) fail('An operation must be an object');
    const o = raw as Record<string, any>;
    switch (o.op as OpName) {
      case 'card.create': {
        const id = pieceId(o.card, 'card');
        if (this.cards.some((c) => c.id === id) || this.tombstones.some((t) => t.kind === 'card' && t.id === id)) fail(`The card id "${id}" is already used`);
        if (this.cards.length >= MAX_CARDS) fail(`The board already has ${MAX_CARDS} cards, its limit; remove one first`);
        if (o.kind !== 'html' && o.kind !== 'canvas') fail('kind must be "html" or "canvas"');
        const title = text(o.title, 'title', MAX_TITLE_LENGTH).trim();
        const card: Card = {
          id,
          kind: o.kind,
          title,
          author: this.actor,
          createdAt: this.now,
          updatedAt: this.now,
          state: {},
          threads: [],
          stickies: [],
          pictures: [],
          stamps: { title: this.stamp(), state: {} },
          revs: { content: this.rev, state: this.rev, marks: this.rev },
        };
        if (o.kind === 'html') {
          if (o.content === undefined) fail('An html card needs its content');
          card.content = contentOf(o.content);
          card.stamps.content = this.stamp();
        } else if (o.content !== undefined) fail("A canvas card has no content; it's a blank surface for marks");
        this.cards.push(card);
        this.copied.add(id);
        this.checkCardBytes(card);
        return;
      }
      case 'card.title': {
        const card = this.card(o.card);
        if (this.setPiece(card, card.stamps, 'title', text(o.title, 'title', MAX_TITLE_LENGTH).trim())) card.updatedAt = this.now;
        return;
      }
      case 'card.content': {
        const card = this.card(o.card);
        if (card.kind !== 'html') fail(`Card "${card.id}" is a canvas; it has no content`);
        if (card.link && !o.viaLink) fail(`Card "${card.id}" is linked to ${card.link.path}; edit that file, or unlink the card first`);
        if (this.setPiece(card, card.stamps, 'content', contentOf(o.content))) this.touch(card, 'content');
        this.checkCardBytes(card);
        return;
      }
      case 'card.rm': {
        const card = this.card(o.card);
        this.cards.splice(this.cards.indexOf(card), 1);
        this.tombstones = this.tombstones.filter((t) => t.card !== card.id);
        this.bury(card.id, 'card', card.id);
        if (this.selection.kind === 'card' && this.selection.id === card.id) this.selection = { kind: 'grid' };
        return;
      }
      case 'card.link': {
        const card = this.card(o.card);
        if (card.kind !== 'html') fail(`Card "${card.id}" is a canvas; only an html card can be linked`);
        if (o.link === null) delete card.link;
        else card.link = linkOf(o.link);
        return;
      }
      case 'card.view': {
        const card = this.card(o.card);
        if (o.view === null) delete card.view;
        else {
          if (!isObject(o.view)) fail('view must be a region { x, y, w, h } or null');
          const v = o.view;
          const side = (n: unknown, what: string) => {
            if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > MAX_COORD) fail(`${what} must be a positive number`);
            return n;
          };
          card.view = { x: coord(v.x, 'view.x'), y: coord(v.y, 'view.y'), w: side(v.w, 'view.w'), h: side(v.h, 'view.h') };
        }
        return;
      }
      case 'state.set': {
        const card = this.card(o.card);
        const path = statePath(o.path, { root: true });
        const value = jsonOf(o.value, 'value');
        if (path.length === 0 && !isPlainJsonObject(value)) fail('The whole state must be an object');
        this.writeState(card, (state) => {
          if (path.length === 0) return value as StateObject;
          walk(state, path.slice(0, -1))[path[path.length - 1]] = value;
          return state;
        });
        return;
      }
      case 'state.merge': {
        const card = this.card(o.card);
        const path = statePath(o.path, { root: true });
        const value = jsonOf(o.value, 'value');
        if (!isPlainJsonObject(value)) fail('merge takes an object');
        this.writeState(card, (state) => {
          let target = state;
          if (path.length > 0) {
            const parent = walk(state, path.slice(0, -1));
            const k = path[path.length - 1];
            if (!isPlainJsonObject(parent[k])) parent[k] = {};
            target = parent[k] as StateObject;
          }
          mergeInto(target, value);
          return state;
        });
        return;
      }
      case 'state.del': {
        const card = this.card(o.card);
        const path = statePath(o.path, { root: false });
        this.writeState(card, (state) => {
          const parent = stateAt(state, path.slice(0, -1));
          if (isPlainJsonObject(parent)) delete parent[path[path.length - 1]];
          return state;
        });
        return;
      }
      case 'state.action': {
        const card = this.card(o.card);
        const name = text(o.name, 'name', MAX_ACTION_NAME_LENGTH);
        stateKey(name, 'name');
        const data = o.data === undefined ? null : jsonOf(o.data, 'data');
        this.writeState(card, (state) => {
          walk(state, [ACTIONS_KEY])[name] = { name, data, at: this.now };
          return state;
        });
        return;
      }
      case 'comment.add': {
        const card = this.card(o.card);
        if (card.threads.length >= MAX_THREADS_PER_CARD) fail(`Card "${card.id}" already has ${MAX_THREADS_PER_CARD} comment threads, its limit`);
        const id = this.freshMarkId(card, o.thread, 'thread');
        const anchor = anchorOf(o.anchor, card.kind);
        const message = this.message(card, o.message, o.text);
        card.threads.push({ id, anchor, resolved: false, messages: [message], stamps: { resolved: this.stamp(), anchor: this.stamp() } });
        this.touch(card, 'marks');
        return;
      }
      case 'comment.reply': {
        const card = this.card(o.card);
        const t = this.thread(card, o.thread);
        if (t.messages.length >= MAX_MESSAGES_PER_THREAD) fail(`Thread "${t.id}" already has ${MAX_MESSAGES_PER_THREAD} messages, its limit`);
        t.messages.push(this.message(card, o.message, o.text));
        this.touch(card, 'marks');
        return;
      }
      case 'comment.edit': {
        const card = this.card(o.card);
        const t = this.thread(card, o.thread);
        const m = t.messages.find((x) => x.id === o.message);
        if (!m) fail(`There is no message "${String(o.message)}" in thread "${t.id}"`);
        const body = text(o.text, 'text', MAX_COMMENT_LENGTH);
        if (m.text !== body) {
          m.text = body;
          m.stamp = this.stamp();
          this.touch(card, 'marks');
        }
        return;
      }
      case 'comment.resolve':
      case 'comment.reopen': {
        const card = this.card(o.card);
        const t = this.thread(card, o.thread);
        if (this.setPiece(t, t.stamps, 'resolved', o.op === 'comment.resolve')) this.touch(card, 'marks');
        return;
      }
      case 'comment.reattach': {
        const card = this.card(o.card);
        this.reattach(card, this.thread(card, o.thread), o.anchor);
        return;
      }
      case 'comment.rm': {
        const card = this.card(o.card);
        const t = this.thread(card, o.thread);
        if (o.message !== undefined) {
          const i = t.messages.findIndex((m) => m.id === o.message);
          if (i < 0) fail(`There is no message "${String(o.message)}" in thread "${t.id}"`);
          t.messages.splice(i, 1);
          this.touch(card, 'marks');
          if (t.messages.length > 0) {
            this.bury(card.id, 'message', String(o.message), t.id);
            return;
          }
        }
        card.threads.splice(card.threads.indexOf(t), 1);
        this.tombstones = this.tombstones.filter((x) => !(x.card === card.id && x.kind === 'message' && x.parent === t.id));
        this.bury(card.id, 'thread', t.id);
        this.touch(card, 'marks');
        return;
      }
      case 'sticky.add': {
        const card = this.card(o.card);
        if (card.stickies.length >= MAX_STICKIES_PER_CARD) fail(`Card "${card.id}" already has ${MAX_STICKIES_PER_CARD} stickies, its limit`);
        const id = this.freshMarkId(card, o.id, 'id');
        const anchor = anchorOf(o.anchor, card.kind);
        const base = { x: 0, y: 0, ...STICKY_SIZE };
        const box = o.box === undefined ? base : boxOf(o.box, base);
        const body = o.text === undefined ? '' : text(o.text, 'text', MAX_STICKY_TEXT_LENGTH, { empty: true });
        const color = o.color === undefined ? 'yellow' : stickyColor(o.color);
        const s = this.stamp();
        card.stickies.push({ id, text: body, color, anchor, box, stamps: { text: s, color: s, box: s, anchor: s } });
        this.touch(card, 'marks');
        return;
      }
      case 'sticky.edit': {
        const card = this.card(o.card);
        const s = this.sticky(card, o.id);
        if (o.text === undefined && o.color === undefined) fail('sticky.edit needs text or color');
        let changed = false;
        if (o.text !== undefined) changed = this.setPiece(s, s.stamps, 'text', text(o.text, 'text', MAX_STICKY_TEXT_LENGTH, { empty: true })) || changed;
        if (o.color !== undefined) changed = this.setPiece(s, s.stamps, 'color', stickyColor(o.color)) || changed;
        if (changed) this.touch(card, 'marks');
        return;
      }
      case 'sticky.move':
      case 'picture.move': {
        const card = this.card(o.card);
        const mark = o.op === 'sticky.move' ? this.sticky(card, o.id) : this.picture(card, o.id);
        if (this.setPiece(mark as Sticky, mark.stamps, 'box', boxOf(o.box, mark.box))) this.touch(card, 'marks');
        return;
      }
      case 'sticky.reattach': {
        const card = this.card(o.card);
        this.reattach(card, this.sticky(card, o.id), o.anchor);
        return;
      }
      case 'picture.reattach': {
        const card = this.card(o.card);
        this.reattach(card, this.picture(card, o.id), o.anchor);
        return;
      }
      case 'sticky.rm':
      case 'picture.rm': {
        const card = this.card(o.card);
        const kind = o.op === 'sticky.rm' ? 'sticky' : 'picture';
        const list: { id: string }[] = kind === 'sticky' ? card.stickies : card.pictures;
        const mark = kind === 'sticky' ? this.sticky(card, o.id) : this.picture(card, o.id);
        list.splice(list.indexOf(mark), 1);
        this.bury(card.id, kind, mark.id);
        this.touch(card, 'marks');
        return;
      }
      case 'picture.add': {
        const card = this.card(o.card);
        if (card.pictures.length >= MAX_PICTURES_PER_CARD) fail(`Card "${card.id}" already has ${MAX_PICTURES_PER_CARD} pictures, its limit`);
        const id = this.freshMarkId(card, o.id, 'id');
        const file = pictureFile(o.file);
        const anchor = anchorOf(o.anchor, card.kind);
        if (!isObject(o.box) || o.box.w === undefined || o.box.h === undefined) fail('A picture needs its size: box { w, h }');
        const box = boxOf(o.box, { x: 0, y: 0, w: 0, h: 0 });
        const s = this.stamp();
        card.pictures.push({ id, file, anchor, box, stamps: { file: s, box: s, anchor: s } });
        this.touch(card, 'marks');
        this.checkCardBytes(card);
        return;
      }
      case 'picture.file': {
        const card = this.card(o.card);
        const p = this.picture(card, o.id);
        if (this.setPiece(p, p.stamps, 'file', pictureFile(o.file))) this.touch(card, 'marks');
        this.checkCardBytes(card);
        return;
      }
      case 'show': {
        const sel = o.selection;
        if (isObject(sel) && sel.kind === 'grid') this.selection = { kind: 'grid' };
        else if (isObject(sel) && sel.kind === 'card') {
          if (!this.cards.some((c) => c.id === sel.id)) fail(`There is no card "${String(sel.id)}" to show`);
          this.selection = { kind: 'card', id: sel.id };
        } else fail('selection must be { kind: "grid" } or { kind: "card", id }');
        return;
      }
      case 'marks.resolve': {
        const card = this.card(o.card);
        if (!Array.isArray(o.marks)) fail('marks must be a list of { id, detached }');
        let changed = false;
        for (const m of o.marks) {
          if (!isObject(m) || typeof m.detached !== 'boolean') fail('Each of marks must be { id, detached }');
          const mark = card.threads.find((t) => t.id === m.id) ?? card.stickies.find((s) => s.id === m.id) ?? card.pictures.find((p) => p.id === m.id);
          if (!mark || !!mark.detached === m.detached) continue;
          if (m.detached) mark.detached = true;
          else delete mark.detached;
          changed = true;
        }
        if (changed) card.revs.marks = this.rev;
        return;
      }
      case 'read': {
        if (!Array.isArray(o.cards) || !o.cards.every((c: unknown) => typeof c === 'string')) fail('cards must be a list of card ids');
        if (!Number.isSafeInteger(o.rev) || o.rev < 0 || o.rev > this.base.rev) fail(`rev must be a snapshot revision no later than ${this.base.rev}`);
        this.reads = advanced({ ...this.base, cards: this.cards, tombstones: this.tombstones }, this.reads, readerOf(this.actor), o.cards, o.rev);
        return;
      }
      case 'prune': {
        if (o.readers !== undefined && !(Array.isArray(o.readers) && o.readers.every((r: unknown) => typeof r === 'string'))) fail('readers must be a list of reader ids');
        const pruned = pruneTombstones({ ...this.finish() }, this.now, o.readers);
        this.tombstones = pruned.tombstones;
        this.reads = pruned.reads;
        return;
      }
      case 'reader.forget': {
        if (typeof o.reader !== 'string') fail('reader must be a reader id');
        if (Object.hasOwn(this.reads, o.reader)) {
          this.reads = { ...this.reads };
          delete this.reads[o.reader];
        }
        return;
      }
      default:
        fail(`Unknown operation "${String(o.op)}"; it must be one of ${OP_NAMES.join(', ')}`);
    }
  }

  private message(card: Card, id: unknown, body: unknown): Message {
    return { id: this.freshMarkId(card, id, 'message'), author: this.actor, text: text(body, 'text', MAX_COMMENT_LENGTH), at: this.now, stamp: this.stamp() };
  }

  private reattach(card: Card, mark: Thread | Sticky | Picture, anchor: unknown) {
    const changed = this.setPiece(mark as Sticky, mark.stamps, 'anchor', anchorOf(anchor, card.kind));
    if (mark.detached) {
      delete mark.detached;
      card.revs.marks = this.rev;
    }
    if (changed) this.touch(card, 'marks');
  }

  /**
   * Runs a write on a card's state, then stamps what it did leaf by leaf: a new or changed leaf takes
   * this batch's stamp, an unchanged one keeps its own, and a leaf that's gone leaves a tombstone.
   */
  private writeState(card: Card, write: (state: StateObject) => StateObject) {
    const before = stateLeaves(card.state);
    card.state = write(card.state);
    const size = utf8Length(JSON.stringify(card.state));
    if (size > MAX_STATE_BYTES) fail(`Card "${card.id}"'s state would be ${bytes(size)}; the limit is ${bytes(MAX_STATE_BYTES)}`);
    const after = stateLeaves(card.state);
    const old = card.stamps.state;
    const stamps: Record<string, Stamp> = {};
    let changed = false;
    for (const [key, value] of after) {
      if (before.has(key) && Object.hasOwn(old, key) && jsonEqual(before.get(key), value)) stamps[key] = old[key];
      else {
        stamps[key] = this.stamp();
        this.unbury(card.id, 'state', key);
        changed = true;
      }
    }
    for (const key of before.keys()) {
      if (after.has(key)) continue;
      this.bury(card.id, 'state', key);
      changed = true;
    }
    card.stamps.state = stamps;
    if (changed) this.touch(card, 'state');
  }
}

function stickyColor(v: unknown): StickyColor {
  if (typeof v !== 'string' || !Object.hasOwn(STICKY_COLORS, v)) fail(`color must be one of ${Object.keys(STICKY_COLORS).join(', ')}`);
  return v as StickyColor;
}

/** The object at a path, making each step one: a leaf in the way (an array included) is replaced. */
function walk(state: StateObject, path: readonly string[]): StateObject {
  let cur = state;
  for (const k of path) {
    if (!isPlainJsonObject(cur[k])) cur[k] = {};
    cur = cur[k] as StateObject;
  }
  return cur;
}

/** Sets each leaf of `src` in `target`, recursing into objects and replacing arrays whole. */
function mergeInto(target: StateObject, src: StateObject) {
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (isPlainJsonObject(v)) {
      if (!isPlainJsonObject(target[k])) target[k] = {};
      mergeInto(target[k] as StateObject, v);
    } else target[k] = v;
  }
}
