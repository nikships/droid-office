// The Whiteboard for agents: what `office-whiteboard` (bin/office-whiteboard.js) talks to, a POST to
// the hook server's /office/whiteboard?worker=<id> with the worker's own hook token, and the action in
// a JSON body:
//
//   { action: 'hello' }
//       A new epoch for this run of the command, who the agent is, and the board's revision.
//   { action: 'read', cards?: string[], png?: boolean, timeoutMs?: number }
//       The board (or the cards named) as of one snapshot revision, as this agent sees it: each card's
//       metadata, stored HTML, files (with where each is on disk), link, state, marks and `changed`
//       pieces, and with `png` a render of each card at that snapshot. Moves nothing: the command
//       sends a `read` operation for what it returned once it has all of it.
//   { action: 'apply', envelope: { epoch, seq, ops } }
//       A batch in the run's epoch. 200 { ok, rev, duplicate? }, 422 { reason: 'invalid', error } (which
//       operation and why; nothing changed), 409 { reason: 'expired' }.

import type { WorkerInfo } from '../shared/protocol.js';
import { OWNER, changesFor, findCard, parseEnvelope, readPoint, readerOf, type Author, type Board, type Card, type FileRef, type PieceRef, type Tombstone } from '../shared/whiteboard.js';
import { type PinnedCard, type RenderImage, type RenderStatus, type WhiteboardStore, renderKey, renderStatus, sameKey } from './whiteboard.js';

/** How long a read's `--png` waits on each card's render by default. */
export const READ_RENDER_TIMEOUT_MS = 30_000;
const MAX_RENDER_TIMEOUT_MS = 120_000;
/** The page is sent as text in a read when it is HTML of at most this many bytes; otherwise read its file. */
const HTML_INLINE_MAX = 2 * 1024 * 1024;

export interface AgentReply {
  status: number;
  body: unknown;
}

export function workerAuthor(w: WorkerInfo): Author {
  return { kind: 'worker', id: w.id, name: w.name, color: w.color };
}

/** A file in a read: its ref and where its blob is on this machine, to open as is (never write to it). */
export type FileOut = FileRef & { file: string };

/** A rendered card in a read: PNG tiles as base64, top to bottom, and how fresh the image is. */
export type PngOut =
  | { ok: true; rev: number; at: number; ageMs: number; current: boolean; width: number; height: number; tileHeight: number; tiles: string[]; capped?: { capPx: number }; cached: boolean }
  | { ok: false; error: string; last?: RenderStatus['image'] };

export interface CardOut {
  id: string;
  kind: Card['kind'];
  title: string;
  author: Author;
  createdAt: number;
  updatedAt: number;
  /** This agent's read point for the card before this read. */
  since: number;
  changed: boolean;
  /** The pieces someone else changed since `since`, and what they removed. */
  changes: PieceRef[];
  removed: Tombstone[];
  content?: { entry: string; html?: string; files: Record<string, FileOut>; missing?: { ref: string; reason: string }[] };
  link?: Card['link'];
  state: Card['state'];
  view?: Card['view'];
  threads: Card['threads'];
  stickies: Card['stickies'];
  pictures: (Omit<Card['pictures'][number], 'file'> & { file: FileOut })[];
  render: RenderStatus;
  png?: PngOut;
}

export interface ReadOut {
  rev: number;
  floor: { id: string; name: string };
  selection: Board['selection'];
  renderer: ReturnType<WhiteboardStore['renderer']['status']>;
  cards: CardOut[];
  /** Cards removed since this agent last read them (or the named ones that were removed). */
  removed: Tombstone[];
  /** Named cards that are neither on the board nor removed recently. */
  unknown: string[];
  /** Every card id the read returned, on the board or removed: what the `read` operation moves. */
  returned: string[];
}

/** One request to /office/whiteboard from `worker` on the floor whose board is `store`. */
export async function handleAgent(store: WhiteboardStore, worker: WorkerInfo, floor: { id: string; name: string }, body: unknown): Promise<AgentReply> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const author = workerAuthor(worker);
  switch (b.action) {
    case 'hello':
      return {
        status: 200,
        body: {
          epoch: store.issueEpoch(),
          worker: { id: worker.id, name: worker.name, color: worker.color },
          floor,
          rev: store.board.rev,
          cards: store.board.cards.length,
          renderer: store.renderer.status(),
        },
      };
    case 'read': {
      const cards = b.cards === undefined ? undefined : Array.isArray(b.cards) && b.cards.every((c) => typeof c === 'string') ? (b.cards as string[]) : null;
      if (cards === null) return { status: 400, body: { error: 'cards must be a list of card ids' } };
      const timeoutMs = Number.isFinite(b.timeoutMs) ? Math.min(MAX_RENDER_TIMEOUT_MS, Math.max(1000, b.timeoutMs as number)) : READ_RENDER_TIMEOUT_MS;
      return { status: 200, body: await readBoard(store, readerOf(author), floor, { cards, png: b.png === true, timeoutMs }) };
    }
    case 'apply': {
      const env = parseEnvelope(b.envelope);
      if (typeof env === 'string') return { status: 400, body: { error: env } };
      const out = store.apply(env, author, 'agent');
      if (out.kind === 'ack') return { status: 200, body: { ok: true, rev: out.rev, ...(out.duplicate ? { duplicate: true } : {}) } };
      if (out.reason === 'expired')
        return {
          status: 409,
          body: {
            ok: false,
            reason: 'expired',
            error: "This run's epoch isn't in the board's record any more, so the office can't tell whether this batch was applied already. Nothing was applied: read the board and send it again in a new run.",
          },
        };
      return { status: 422, body: { ok: false, reason: 'invalid', error: out.error } };
    }
    default:
      return { status: 400, body: { error: 'Send {"action": "hello" | "read" | "apply"}' } };
  }
}

/**
 * The board as one reader sees it at one snapshot revision. With `png`, every card returned is
 * rendered from that same snapshot (pinned, so later changes can't reach it), or the read says why not.
 */
export async function readBoard(store: WhiteboardStore, reader: string, floor: { id: string; name: string }, opts: { cards?: string[]; png?: boolean; timeoutMs?: number } = {}): Promise<ReadOut> {
  const board = store.board;
  const wanted = opts.cards ? [...new Set(opts.cards)] : undefined;
  const onBoard = wanted ? wanted.flatMap((id) => findCard(board, id) ?? []) : board.cards;
  const removedCards = board.tombstones.filter((t) => t.kind === 'card' && (wanted ? wanted.includes(t.id) : changesFor(board, reader, t.card).changed));
  const unknown = wanted ? wanted.filter((id) => !findCard(board, id) && !removedCards.some((t) => t.id === id)) : [];
  const pins = opts.png ? new Map(onBoard.map((c) => [c.id, store.pin(c.id, board)])) : undefined;
  try {
    const cards: CardOut[] = [];
    for (const card of onBoard) {
      const out = cardOut(store, board, reader, card);
      const pin = pins?.get(card.id);
      if (pin) out.png = await png(store, pin, opts.timeoutMs ?? READ_RENDER_TIMEOUT_MS);
      cards.push(out);
    }
    return {
      rev: board.rev,
      floor,
      selection: board.selection,
      renderer: store.renderer.status(),
      cards,
      removed: removedCards,
      unknown,
      returned: [...onBoard.map((c) => c.id), ...removedCards.map((t) => t.id)],
    };
  } finally {
    for (const p of pins?.values() ?? []) p?.release();
  }
}

function cardOut(store: WhiteboardStore, board: Board, reader: string, card: Card): CardOut {
  const ch = changesFor(board, reader, card.id);
  const file = (ref: FileRef): FileOut => ({ ...ref, file: store.blobFile(ref.hash) });
  let content: CardOut['content'];
  if (card.content) {
    const entry = card.content.files[card.content.entry];
    const page = entry && /^text\/html\b/i.test(entry.mime) && entry.size <= HTML_INLINE_MAX ? store.readBlob(entry.hash)?.toString('utf8') : undefined;
    content = {
      entry: card.content.entry,
      ...(page !== undefined ? { html: page } : {}),
      files: Object.fromEntries(Object.entries(card.content.files).map(([p, ref]) => [p, file(ref)])),
      ...(card.content.missing?.length ? { missing: card.content.missing } : {}),
    };
  }
  return {
    id: card.id,
    kind: card.kind,
    title: card.title,
    author: card.author,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    since: readPoint(board, reader, card.id),
    changed: ch.changed,
    changes: ch.pieces,
    removed: ch.removed,
    ...(content ? { content } : {}),
    ...(card.link ? { link: card.link } : {}),
    state: card.state,
    ...(card.view ? { view: card.view } : {}),
    threads: card.threads,
    stickies: card.stickies,
    pictures: card.pictures.map((p) => ({ ...p, file: file(p.file) })),
    render: renderStatus(store.renderer, card, card.id),
  };
}

/** The snapshot's image: the renderer's latest when it shows exactly this snapshot, else a render of it now. */
async function png(store: WhiteboardStore, pin: PinnedCard, timeoutMs: number): Promise<PngOut> {
  const r = store.renderer;
  const status = r.status();
  const last = renderStatus(r, pin.card, pin.card.id).image;
  if (!status.available) return { ok: false, error: status.reason ?? 'Cards are not rendered to images in this office', ...(last ? { last } : {}) };
  // Whether the card still looks like the snapshot once the image is in hand.
  const current = () => {
    const now = findCard(store.board, pin.card.id);
    return !!now && sameKey(renderKey(now, pin.key.width), pin.key);
  };
  const latest = r.latest(pin.card.id).image;
  if (latest && sameKey(latest.key, pin.key)) return pngOf(latest, true, current());
  const out = await r.render(pin, { timeoutMs });
  if (!out.ok) return { ok: false, error: out.error, ...(last ? { last } : {}) };
  if (!sameKey(out.image.key, pin.key)) return { ok: false, error: "The renderer returned an image of a different revision than this read's", ...(last ? { last } : {}) };
  return pngOf(out.image, false, current());
}

function pngOf(i: RenderImage, cached: boolean, current: boolean): PngOut {
  return {
    ok: true,
    rev: i.rev,
    at: i.at,
    ageMs: Math.max(0, Date.now() - i.at),
    current,
    width: i.width,
    height: i.height,
    tileHeight: i.tileHeight,
    tiles: i.tiles.map((t) => t.toString('base64')),
    ...(i.capped ? { capped: i.capped } : {}),
    cached,
  };
}

/** Whose read points count for pruning: the owner and the floor's own workers. */
export function boardReaders(workers: WorkerInfo[]): string[] {
  return [OWNER, ...workers.map((w) => w.id)];
}
