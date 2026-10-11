// A floor's Whiteboard store (docs/whiteboard.md): the board as it is now, in the floor checkout's
// .droid-office/whiteboard/, every change applied with the shared reducer (applyOps) and broadcast as
// the same batch, so a window that replays it with applyPatch lands on exactly this board.
//
// On disk:
//   board.json       { v: 1, board, record } — the board, and the operation record of each recent
//                    client epoch's highest applied sequence number, committed in the same write.
//   blobs/<sha256>   every file the board holds (a card's HTML and assets, each picture), written once
//                    and never overwritten.
//   key              this floor's secret for epochs and card capabilities (mode 600).
//
// A commit writes its new blobs and fsyncs them and blobs/, then board.json through a temp file, an
// fsync and a rename, then fsyncs the folder. A crash anywhere leaves the old board or the new one,
// each with every file it references. A batch is acknowledged only after that.
//
// URLs (served by server.ts):
//
//   GET|HEAD /whiteboard/c/<cap>/<path>
//       A card's files. <cap> is the card's capability (`cardCap`, sent to the window as `caps` on the
//       `whiteboard` message), or a pinned snapshot's (`PinnedCard.entryUrl`, for the renderer). It is
//       the only credential: no office token, no hook token, and no other route accepts it. The page
//       is <entry> (content.entry), served from the card's folder so relative references work; the
//       office's SDK script is injected into it. Every answer carries CARD_HEADERS: a CSP sandbox with
//       the iframe's flags, nosniff, no referrer, and Access-Control-Allow-Origin: * (no credentials).
//       A capability reaches its own card's files only.
//       The window's frame: `<iframe sandbox="${CARD_SANDBOX}" allow="" src="/whiteboard/c/<cap>/<entry>#wb=<nonce>">`.
//
//   GET /api/whiteboard/render?floor=<floor>&card=<card>[&size=full|thumb][&tile=<n>]
//       The card's latest render as image/png, with x-whiteboard-rev (the board revision it shows),
//       x-whiteboard-rendered-at (ms), x-whiteboard-age-ms, x-whiteboard-current (1 when it matches the
//       card as it is now) and x-whiteboard-tiles. 503 + JSON { available: false, reason } without a
//       renderer; 404 + JSON { error, status } when there is no image yet. The office's normal auth.
//   GET /api/whiteboard/render/status?floor=<floor>&card=<card>
//       JSON RenderStatus: whether renders are available (and why not), the latest image's revision,
//       time, age, size and whether it's current, and the last error.
//   GET /api/whiteboard/file?floor=<floor>&card=<card>&hash=<sha256>
//       A file a card holds (a picture, say) for the window to show, by hash. The office's normal auth.
//   POST /api/whiteboard/blob?floor=<floor>&mime=<type>
//       The office's own page uploads a file (a picture, an uploaded folder's files) before the batch
//       that uses it; answers with its FileRef. Held for STAGE_TTL_MS for that batch.
//
//   POST http://127.0.0.1:<hook port>/office/whiteboard?worker=<id>   (Authorization: Bearer <hook token>)
//       For office-whiteboard (see whiteboard-agent.ts): hello, read, apply.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, watch, writeFileSync, writeSync, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { WhiteboardRendererStatus } from '../shared/protocol.js';
import {
  OWNER,
  OWNER_AUTHOR,
  applyOps,
  emptyBoard,
  findCard,
  isServerOnly,
  jsonEqual,
  pruneTombstones,
  type Author,
  type Board,
  type BoardPatch,
  type Card,
  type CardContent,
  type CardLink,
  type FileRef,
  type Op,
  type OpEnvelope,
  type OpError,
  type ReaderId,
} from '../shared/whiteboard.js';
import { LoadError, fileRef, loadImageCard, loadPackage, loadPage, loadPicture, pageFromText, type Loaded } from './whiteboard-assets.js';
import { SDK_SCRIPT, SDK_VERSION } from './whiteboard-sdk.js';

const DAY = 24 * 60 * 60 * 1000;
/** An epoch the record hasn't heard from in this long is dropped from it. */
export const EPOCH_TTL_MS = 14 * DAY;
/** The most epochs the record keeps; the least recently used go first. */
export const EPOCH_MAX = 1000;
/** How long a file the window uploaded waits for the batch that uses it. */
export const STAGE_TTL_MS = 60 * 60 * 1000;
/** How often a linked file is looked at, besides the watcher (which can miss a folder being deleted). */
export const LINK_POLL_MS = 2000;
const LINK_DEBOUNCE_MS = 150;

/** The iframe's sandbox flags, which the card routes' CSP repeats: never allow-same-origin. */
export const CARD_SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
/** The card routes' prefix: `/whiteboard/c/<cap>/<path>`. */
export const CARD_ROUTE = '/whiteboard/c/';

/**
 * Every card route answer's headers, apart from its content type: so a card opened directly in a tab
 * still runs sandboxed on an opaque origin, its capability never leaks in a Referer, nothing grants it
 * device permissions, and an opaque-origin page can load its own module scripts, fonts and fetches.
 */
export const CARD_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': `sandbox ${CARD_SANDBOX}`,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), display-capture=(), geolocation=(), clipboard-read=(), usb=(), serial=(), hid=(), bluetooth=(), payment=()',
  'access-control-allow-origin': '*',
  'cache-control': 'no-cache',
};

/** A card route's answer: what the server writes, and what the renderer serves byte for byte. */
export interface CardResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * The office's SDK script, inline at the top of an artifact's page so it runs before any of the
 * artifact's own scripts (after the doctype, so the page keeps its rendering mode).
 */
export function injectSdk(html: string, script = SDK_SCRIPT): string {
  const tag = `<script data-droid-office-whiteboard>${script.replace(/<\/script/gi, '<\\/script')}</script>`;
  const doctype = /^\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i.exec(html);
  const head = /<head\b[^>]*>/i.exec(html);
  const firstScript = html.search(/<script\b/i);
  if (head && (firstScript < 0 || firstScript > head.index)) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const at = doctype ? doctype.index + doctype[0].length : 0;
  return html.slice(0, at) + tag + html.slice(at);
}

/**
 * The answer for `rel` (a path inside the card's folder, '' for its page) from a card's files, served
 * the same way by the card route and the renderer.
 */
export function cardResponse(content: CardContent | undefined, rel: string, blob: (hash: string) => Buffer | undefined, opts: { method?: string; ifNoneMatch?: string } = {}): CardResponse {
  const fail = (status: number, text: string): CardResponse => ({ status, headers: { ...CARD_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: Buffer.from(text) });
  if (opts.method && opts.method !== 'GET' && opts.method !== 'HEAD') return { ...fail(405, 'GET or HEAD'), headers: { ...fail(405, '').headers, allow: 'GET, HEAD' } };
  if (!content) return fail(404, 'This card has no files');
  const name = rel === '' ? content.entry : rel;
  const ref = Object.hasOwn(content.files, name) ? content.files[name] : undefined;
  if (!ref) return fail(404, 'Not found');
  const page = name === content.entry;
  const etag = `"${ref.hash.slice(0, 32)}${page ? `-${SDK_VERSION}` : ''}"`;
  const headers = { ...CARD_HEADERS, 'content-type': ref.mime, etag };
  if (opts.ifNoneMatch === etag) return { status: 304, headers, body: Buffer.alloc(0) };
  const bytes = blob(ref.hash);
  if (!bytes) return fail(404, 'Not found');
  const body = page && /^text\/html\b/i.test(ref.mime) ? Buffer.from(injectSdk(bytes.toString('utf8'))) : bytes;
  return { status: 200, headers: { ...headers, 'content-length': String(body.length) }, body: opts.method === 'HEAD' ? Buffer.alloc(0) : body };
}

// ---- The renderer, plugged in ----

/** What a render shows: a card's content, state and marks revisions, at a layout width. Equal keys, same image. */
export interface RenderKey {
  card: string;
  content: number;
  state: number;
  marks: number;
  width: number;
}

/**
 * A card frozen at one board revision, with a lease on every file it names: while it's held, those
 * blobs stay on disk and `entryUrl` serves exactly these files, whatever happens to the live card
 * (an update, a deletion). Whoever pins one calls `release()` once done with it.
 */
export interface PinnedCard {
  /** The card as of `rev`: its title, kind, content, state, threads, stickies and pictures. Don't change it. */
  readonly card: Card;
  /** The board revision this snapshot was taken at. */
  readonly rev: number;
  readonly key: RenderKey;
  /** The content's path-to-blob map; empty for a canvas card. */
  readonly files: Readonly<Record<string, FileRef>>;
  /** The page's URL path on the office's own address, serving this snapshot's files; undefined for a canvas. */
  readonly entryUrl?: string;
  /** What the card route answers for `rel` in this snapshot, byte for byte. */
  serve(rel: string, opts?: { method?: string; ifNoneMatch?: string }): CardResponse;
  /** A blob this snapshot holds (a picture's file, say), by hash. */
  blob(hash: string): Buffer | undefined;
  release(): void;
}

/** One finished render: the full page as PNG tiles, top to bottom, and the revision it shows. */
export interface RenderImage {
  key: RenderKey;
  /** The board revision of the snapshot it was rendered from. */
  rev: number;
  /** When it finished (ms). */
  at: number;
  /** The page's size in canonical px, and how much of it the tiles cover (tall pages are capped). */
  width: number;
  height: number;
  tiles: Buffer[];
  tileHeight: number;
  /** The page was taller than the renderer's cap; `capPx` says where it stopped. */
  capped?: { capPx: number };
  /** A small PNG of the top of the page, for grid thumbnails. */
  thumb?: Buffer;
}

export type RenderOutcome = { ok: true; image: RenderImage } | { ok: false; error: string };

/** A card's latest good image and last error, kept by the renderer until `forget`. */
export interface CardRenders {
  image?: RenderImage;
  error?: { message: string; at: number; rev: number };
}

/**
 * Turns cards into images (docs/whiteboard.md, "Rendering"). The store calls it; it never changes the
 * board. One renderer serves every floor's store.
 *
 * Contract:
 * - `status()` says whether renders can happen at all, and why not (no browser, missing libraries…),
 *   in words the board shows as is.
 * - `render(card)` renders exactly that pinned snapshot (a read's `--png`), within `timeoutMs`: its
 *   page from `card.entryUrl` (or `card.serve`), its state and its marks drawn on top, at the key's
 *   width, full page. It resolves, never rejects. A success also becomes the card's latest image if
 *   nothing newer finished first; a failure is recorded as the card's last error, keeping the last
 *   good image. The store releases `card` after.
 * - `changed(cardId, key, pin)` says the card now renders differently: re-render in the background,
 *   debounced, through a bounded queue. `pin()` gives a fresh snapshot when it's time (undefined when
 *   the card is gone); the renderer releases what it pins.
 * - `latest(cardId)` is the last good image and the last error. A slow old render never overwrites a
 *   newer image (compare `image.rev`).
 * - `forget(cardId)` drops a deleted card's images; `stop()` stops everything (a floor closing).
 */
export interface WhiteboardRenderer {
  status(): WhiteboardRendererStatus;
  render(card: PinnedCard, opts: { timeoutMs: number }): Promise<RenderOutcome>;
  changed(cardId: string, key: RenderKey, pin: () => PinnedCard | undefined): void;
  latest(cardId: string): CardRenders;
  forget(cardId: string): void;
  stop(): void;
}

/** What `/api/whiteboard/render/status` and a read's renders say about a card's images. */
export interface RenderStatus extends WhiteboardRendererStatus {
  image?: { rev: number; at: number; ageMs: number; width: number; height: number; tiles: number; current: boolean; capped?: { capPx: number } };
  error?: { message: string; at: number; rev: number };
}

export const NO_RENDERER_REASON = 'Cards are not rendered to images in this office yet: it has no renderer (a headless Chromium) set up, so there are no PNGs, thumbnails or wall images. Everything else on the board works.';

/** The renderer an office has until a real one is plugged in: renders are unavailable, and it says why. */
export class NoRenderer implements WhiteboardRenderer {
  constructor(private reason = NO_RENDERER_REASON) {}
  status(): WhiteboardRendererStatus {
    return { available: false, reason: this.reason };
  }
  async render(): Promise<RenderOutcome> {
    return { ok: false, error: this.reason };
  }
  changed() {}
  latest(): CardRenders {
    return {};
  }
  forget() {}
  stop() {}
}

export function renderKey(card: Card, width = 1280): RenderKey {
  return { card: card.id, content: card.revs.content, state: card.revs.state, marks: card.revs.marks, width };
}

export function sameKey(a: RenderKey, b: RenderKey): boolean {
  return a.card === b.card && a.content === b.content && a.state === b.state && a.marks === b.marks && a.width === b.width;
}

/** A card's render status for the window, the wall and a read. */
export function renderStatus(renderer: WhiteboardRenderer, card: Card | undefined, cardId: string, now = Date.now()): RenderStatus {
  const s = renderer.status();
  const out: RenderStatus = { ...s };
  const last = renderer.latest(cardId);
  if (last.image) {
    const i = last.image;
    out.image = { rev: i.rev, at: i.at, ageMs: Math.max(0, now - i.at), width: i.width, height: i.height, tiles: i.tiles.length, current: !!card && sameKey(i.key, renderKey(card, i.key.width)), ...(i.capped ? { capped: i.capped } : {}) };
  }
  if (last.error) out.error = last.error;
  return out;
}

// ---- The store ----

interface EpochEntry {
  /** The highest sequence number applied. */
  seq: number;
  /** The revision it was applied at. */
  rev: number;
  /** When the record last heard from it, and when it was issued (ms). */
  at: number;
  issued: number;
}

interface OpRecord {
  epochs: Record<string, EpochEntry>;
  /** No epoch issued at or before this time can be proved new: one like it was dropped from the record. */
  horizon: number;
}

interface Saved {
  v: 1;
  board: Board;
  record: OpRecord;
}

export type ApplyOutcome = { kind: 'ack'; rev: number; duplicate?: true } | { kind: 'rejected'; reason: 'invalid'; error: OpError } | { kind: 'rejected'; reason: 'expired' };

/** Where a commit can be cut short (tests simulate a crash there). */
export type CrashPoint = 'blobs' | 'temp' | 'rename';

/** Who sent a batch: the owner's window, an agent's office-whiteboard, or the office itself. */
export type ApplySource = 'window' | 'agent' | 'office';

export interface WhiteboardOptions {
  /** The readers that count for pruning tombstones: the owner and the floor's workers. Default: everyone with a read point. */
  readers?: () => ReaderId[];
  /** A committed batch, for the floor's windows; `origin` is the envelope it came in, `caps` the new cards' capabilities. */
  onPatch?: (patch: BoardPatch, info: { origin?: { epoch: string; seq: number }; caps: Record<string, string> }) => void;
  renderer?: WhiteboardRenderer;
  now?: () => number;
  epochTtlMs?: number;
  epochMax?: number;
  linkPollMs?: number;
  linkDebounceMs?: number;
  /** Tests: called at each commit point, where throwing simulates the office dying there. */
  crash?: (point: CrashPoint) => void;
}

interface Lease {
  hashes: string[];
  until?: number;
}

/** The files a link watches and what they looked like, so a poll can tell when they changed. */
interface LinkWatch {
  card: string;
  link: CardLink;
  files: string[];
  sig: string;
  watchers: FSWatcher[];
  timer?: NodeJS.Timeout;
}

/** A source for a card's content in an agent's batch (`content: { load }`), read by the office from this machine. */
export type LoadSpec = { html: string } | { file: string } | { dir: string; entry?: string } | { image: string; title?: string };

export class WhiteboardStore {
  readonly dir: string;
  private readonly blobDir: string;
  private readonly file: string;
  private readonly secret: Buffer;
  private current: Board;
  private record: OpRecord;
  private readonly leases = new Map<number, Lease>();
  private leaseSeq = 0;
  private readonly snapshots = new Map<string, PinnedCard>();
  private caps = new Map<string, string>();
  private readonly links = new Map<string, LinkWatch>();
  private poll?: NodeJS.Timeout;
  private stopped = false;
  readonly renderer: WhiteboardRenderer;
  private readonly now: () => number;

  /** `checkout` is the floor's checkout; the store lives in its .droid-office/whiteboard. */
  constructor(
    checkout: string,
    private readonly opts: WhiteboardOptions = {},
  ) {
    this.dir = path.join(checkout, '.droid-office', 'whiteboard');
    this.blobDir = path.join(this.dir, 'blobs');
    this.file = path.join(this.dir, 'board.json');
    this.now = opts.now ?? Date.now;
    this.renderer = opts.renderer ?? new NoRenderer();
    mkdirSync(this.blobDir, { recursive: true, mode: 0o700 });
    this.secret = this.loadKey();
    const saved = this.load();
    this.current = saved.board;
    this.record = saved.record;
    this.indexCaps();
    // Leftovers of a commit that never finished.
    rmSync(`${this.file}.tmp`, { force: true });
    for (const name of readdirSync(this.blobDir)) if (name.endsWith('.tmp')) rmSync(path.join(this.blobDir, name), { force: true });
    this.collectBlobs();
  }

  /** The board as it is now. Never change it: every change is a batch. */
  get board(): Board {
    return this.current;
  }

  /**
   * Starts the links' watchers (which pick up what changed while the office was down) and prunes
   * tombstones every reader has seen. Called once the floor's workers are back at their desks.
   */
  start() {
    if (this.stopped) return;
    this.syncLinks(true);
    const ms = this.opts.linkPollMs ?? LINK_POLL_MS;
    this.poll = setInterval(() => this.pollLinks(), ms);
    this.poll.unref?.();
    this.prune();
  }

  /** The floor closed: watchers and timers stop. Nothing is deleted. */
  stop() {
    this.stopped = true;
    clearInterval(this.poll);
    for (const w of this.links.values()) this.unwatch(w);
    this.links.clear();
  }

  // ---- Epochs ----

  /** A new epoch for a client (an office tab's connection, or one office-whiteboard run). Nothing is written. */
  issueEpoch(): string {
    const body = `${this.now().toString(36)}.${randomBytes(9).toString('base64url')}`;
    return `${body}.${this.mac(`epoch:${body}`).slice(0, 16)}`;
  }

  /** When a server-issued epoch was issued; undefined for one this store didn't sign. */
  private epochIssued(epoch: string): number | undefined {
    const m = /^([0-9a-z]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{16})$/.exec(epoch);
    if (!m) return undefined;
    const want = Buffer.from(this.mac(`epoch:${m[1]}.${m[2]}`).slice(0, 16));
    const got = Buffer.from(m[3]);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
    return Number.parseInt(m[1], 36);
  }

  // ---- Capabilities ----

  /** The card's capability for its routes (`/whiteboard/c/<cap>/…`): unguessable, and the same across restarts. */
  cardCap(cardId: string): string {
    return `k${this.mac(`card:${cardId}`).slice(0, 40)}`;
  }

  /** Every card's capability, by card id. */
  allCaps(): Record<string, string> {
    return Object.fromEntries(this.current.cards.map((c) => [c.id, this.cardCap(c.id)]));
  }

  /** What a card route answers for a capability of this store, or undefined when it isn't one of its. */
  serve(cap: string, rel: string, opts: { method?: string; ifNoneMatch?: string } = {}): CardResponse | undefined {
    const pinned = this.snapshots.get(cap);
    if (pinned) return pinned.serve(rel, opts);
    const id = this.caps.get(cap);
    if (!id) return undefined;
    const card = findCard(this.current, id);
    if (!card) return undefined;
    return cardResponse(card.content, rel, (h) => this.readBlob(h), opts);
  }

  /** A file a card holds (content or picture), by hash, for the window. */
  cardFile(cardId: string, hash: string): { ref: FileRef; body: Buffer } | undefined {
    const card = findCard(this.current, cardId);
    if (!card) return undefined;
    const ref = [...Object.values(card.content?.files ?? {}), ...card.pictures.map((p) => p.file)].find((f) => f.hash === hash);
    const body = ref && this.readBlob(ref.hash);
    return ref && body ? { ref, body } : undefined;
  }

  private indexCaps() {
    this.caps = new Map(this.current.cards.map((c) => [this.cardCap(c.id), c.id]));
  }

  // ---- Snapshots and leases ----

  /** Pins a card as it is now (or as it is in `board`), with a lease on its files, until `release()`. */
  pin(cardId: string, board: Board = this.current): PinnedCard | undefined {
    const card = findCard(board, cardId);
    if (!card) return undefined;
    const frozen: Card = JSON.parse(JSON.stringify(card));
    const files = frozen.content?.files ?? {};
    const lease = this.lease([...Object.values(files), ...frozen.pictures.map((p) => p.file)].map((f) => f.hash));
    const cap = `s${randomBytes(24).toString('base64url')}`;
    let released = false;
    const pinned: PinnedCard = {
      card: frozen,
      rev: board.rev,
      key: renderKey(frozen),
      files,
      ...(frozen.content ? { entryUrl: `${CARD_ROUTE}${cap}/${encodePath(frozen.content.entry)}` } : {}),
      serve: (rel, o) => cardResponse(frozen.content, rel, (h) => this.readBlob(h), o),
      blob: (hash) => (lease.hashes.includes(hash) ? this.readBlob(hash) : undefined),
      release: () => {
        if (released) return;
        released = true;
        this.snapshots.delete(cap);
        this.leases.delete(lease.id);
      },
    };
    this.snapshots.set(cap, pinned);
    return pinned;
  }

  private lease(hashes: string[], until?: number): Lease & { id: number } {
    const id = ++this.leaseSeq;
    const l = { hashes, ...(until ? { until } : {}) };
    this.leases.set(id, l);
    return { ...l, id };
  }

  /**
   * Keeps a file the window uploaded for the batch that will use it (a picture, an uploaded folder's
   * file). It's written now, and held for STAGE_TTL_MS.
   */
  stage(bytes: Buffer, mime: string): FileRef {
    const ref = fileRef(bytes, mime);
    this.writeBlobs(new Map([[ref.hash, bytes]]));
    this.lease([ref.hash], this.now() + STAGE_TTL_MS);
    return ref;
  }

  // ---- Applying ----

  /**
   * Applies a client's batch, once. A retry of a batch the record holds is acknowledged again without
   * applying it; one whose epoch the record no longer holds is rejected as expired, never reapplied.
   * An agent's batch may load content and pictures from files (`{ load }`) and link cards. Throws only
   * when the commit can't be written; the board is then as it was.
   */
  apply(env: OpEnvelope, actor: Author, source: Exclude<ApplySource, 'office'>): ApplyOutcome {
    const issued = this.epochIssued(env.epoch);
    if (issued === undefined) return { kind: 'rejected', reason: 'expired' };
    const known = Object.hasOwn(this.record.epochs, env.epoch) ? this.record.epochs[env.epoch] : undefined;
    if (known && env.seq <= known.seq) return { kind: 'ack', rev: known.rev, duplicate: true };
    if (!known && issued <= this.record.horizon) return { kind: 'rejected', reason: 'expired' };
    if (!Array.isArray(env.ops)) return invalid(-1, undefined, 'The envelope needs a list of operations');
    for (let i = 0; i < env.ops.length; i++) {
      const op = env.ops[i] as unknown;
      if (op && typeof op === 'object' && !Array.isArray(op) && isServerOnly(op as Op)) return invalid(i, (op as Op).op, "only the office itself makes this change (it's how links, pruning and dismissed workers are kept)");
    }
    if (source !== 'agent') return this.commitBatch(env.ops, actor, new Map(), { epoch: env.epoch, seq: env.seq, issued });
    let expanded: ReturnType<WhiteboardStore['expand']>;
    try {
      expanded = this.expand(env.ops, actor);
    } catch (e) {
      if (e instanceof ExpandError) return invalid(e.index, e.op, e.message);
      throw e;
    }
    const out = this.commitBatch(expanded.ops, actor, expanded.blobs, { epoch: env.epoch, seq: env.seq, issued });
    // An expanded batch can be longer than the one sent: name the operation the agent wrote.
    if (out.kind === 'rejected' && out.reason === 'invalid' && out.error.index >= 0) {
      const i = expanded.from[out.error.index] ?? out.error.index;
      const sent = env.ops[i] as unknown;
      const name = sent && typeof sent === 'object' && typeof (sent as Op).op === 'string' ? (sent as Op).op : out.error.op;
      return invalid(i, name, out.error.reason);
    }
    return out;
  }

  /** The office's own change (a link's update, pruning, a dismissed reader): applied now, no envelope. */
  applyOffice(ops: Op[], actor: Author = OWNER_AUTHOR, blobs = new Map<string, Buffer>()): ApplyOutcome {
    return this.commitBatch(ops, actor, blobs);
  }

  /** Forgets a dismissed worker's read points, so it no longer holds tombstones. */
  forgetReader(reader: ReaderId) {
    if (reader === OWNER || !Object.hasOwn(this.current.reads, reader)) return;
    this.applyOffice([{ op: 'reader.forget', reader }]);
  }

  private commitBatch(ops: Op[], actor: Author, blobs: Map<string, Buffer>, origin?: { epoch: string; seq: number; issued: number }): ApplyOutcome {
    const bad = this.checkFiles(ops, blobs);
    if (bad) return { kind: 'rejected', reason: 'invalid', error: bad };
    const now = this.now();
    const rev = this.current.rev + 1;
    const result = applyOps(this.current, ops, actor, rev, now);
    if (!result.ok) return { kind: 'rejected', reason: 'invalid', error: result.error };
    const record = this.nextRecord(now, origin && { ...origin, rev });
    const before = this.current;
    this.commit(result.board, record, blobs);
    this.current = result.board;
    this.record = record;
    const fresh = result.board.cards.filter((c) => !findCard(before, c.id)).map((c) => c.id);
    if (fresh.length || result.board.cards.length !== before.cards.length) this.indexCaps();
    this.opts.onPatch?.({ rev, at: now, actor, ops }, { ...(origin ? { origin: { epoch: origin.epoch, seq: origin.seq } } : {}), caps: Object.fromEntries(fresh.map((id) => [id, this.cardCap(id)])) });
    this.afterCommit(before, ops);
    return { kind: 'ack', rev };
  }

  /** The record after a commit: this batch's epoch moved up, and epochs too old or too many dropped. */
  private nextRecord(now: number, applied?: { epoch: string; seq: number; issued: number; rev: number }): OpRecord {
    const epochs = { ...this.record.epochs };
    let horizon = this.record.horizon;
    if (applied) epochs[applied.epoch] = { seq: applied.seq, rev: applied.rev, at: now, issued: applied.issued };
    const ttl = this.opts.epochTtlMs ?? EPOCH_TTL_MS;
    const max = this.opts.epochMax ?? EPOCH_MAX;
    const drop = (id: string) => {
      horizon = Math.max(horizon, epochs[id].issued);
      delete epochs[id];
    };
    for (const id of Object.keys(epochs)) if (now - epochs[id].at > ttl) drop(id);
    const ids = Object.keys(epochs).sort((a, b) => epochs[a].at - epochs[b].at);
    while (ids.length > max) drop(ids.shift()!);
    return { epochs, horizon };
  }

  /** After a commit: links follow the board, renders hear about changed cards, and what nobody needs goes. */
  private afterCommit(before: Board, ops: Op[]) {
    if (ops.some((o) => o.op === 'card.link' || o.op === 'card.rm' || o.op === 'card.create')) this.syncLinks(false);
    for (const card of this.current.cards) {
      const was = findCard(before, card.id);
      if (was && was.revs.content === card.revs.content && was.revs.state === card.revs.state && was.revs.marks === card.revs.marks) continue;
      this.renderer.changed(card.id, renderKey(card), () => this.pin(card.id));
    }
    for (const card of before.cards) if (!findCard(this.current, card.id)) this.renderer.forget(card.id);
    if (!ops.every((o) => o.op === 'prune')) this.prune();
    this.collectBlobs();
  }

  /** Drops tombstones every reader has read past (or past their TTL), as a batch of its own when there are any. */
  prune() {
    const readers = this.opts.readers?.();
    const pruned = pruneTombstones(this.current, this.now(), readers);
    if (pruned.tombstones.length === this.current.tombstones.length && jsonEqual(pruned.reads, this.current.reads)) return;
    this.applyOffice([readers ? { op: 'prune', readers } : { op: 'prune' }]);
  }

  /**
   * Every file a batch names is a blob the store has, the size the batch says: the reducer counts the
   * limits by those sizes, so they're checked against the real bytes here.
   */
  private checkFiles(ops: Op[], blobs: Map<string, Buffer>): OpError | undefined {
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i] as Record<string, any>;
      if (!o || typeof o !== 'object') continue;
      const refs: { ref: unknown; what: string }[] = [];
      if ((o.op === 'card.create' || o.op === 'card.content') && o.content && typeof o.content === 'object' && o.content.files && typeof o.content.files === 'object') {
        for (const [p, ref] of Object.entries(o.content.files)) refs.push({ ref, what: `content.files["${p}"]` });
      }
      if ((o.op === 'picture.add' || o.op === 'picture.file') && o.file) refs.push({ ref: o.file, what: 'file' });
      for (const { ref, what } of refs) {
        if (!ref || typeof ref !== 'object') continue;
        const { hash, size } = ref as { hash?: unknown; size?: unknown };
        if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) continue;
        const pending = blobs.get(hash);
        const real = pending ? pending.length : this.blobSize(hash);
        if (real === undefined)
          return {
            index: i,
            op: o.op,
            reason: `${what} (${hash.slice(0, 12)}…) isn't a file the board holds; upload it first`,
            message: `Operation ${i} (${o.op}) failed: ${what} (${hash.slice(0, 12)}…) isn't a file the board holds; upload it first. Nothing was changed.`,
          };
        if (real !== size) return { index: i, op: o.op, reason: `${what} is ${real} bytes, not ${String(size)}`, message: `Operation ${i} (${o.op}) failed: ${what} is ${real} bytes, not ${String(size)}. Nothing was changed.` };
      }
    }
    return undefined;
  }

  // ---- An agent's loads and links ----

  /**
   * An agent's batch, with `{ load }` contents and pictures read from files and its link operations
   * (`card.linkTo`, `card.unlink`) made into the office's own: the content the link has now, and the
   * link itself. Every file read goes into the batch's blobs.
   */
  private expand(raw: unknown[], actor: Author): { ops: Op[]; blobs: Map<string, Buffer>; from: number[] } {
    const blobs = new Map<string, Buffer>();
    const ops: Op[] = [];
    const from: number[] = [];
    const take = (l: Loaded) => {
      for (const [h, b] of l.blobs) blobs.set(h, b);
      return l.content;
    };
    raw.forEach((value, i) => {
      const before = ops.length;
      this.expandOne(value, i, actor, ops, blobs, take);
      for (let k = before; k < ops.length; k++) from.push(i);
    });
    return { ops, blobs, from };
  }

  private expandOne(value: unknown, i: number, actor: Author, ops: Op[], blobs: Map<string, Buffer>, take: (l: Loaded) => CardContent) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      ops.push(value as Op);
      return;
    }
    const o = { ...(value as Record<string, any>) };
    const name = typeof o.op === 'string' ? o.op : undefined;
    try {
      // A new card linked from the start: `content: { load: { link, entry? } }`.
      if (o.op === 'card.create' && o.content?.load && typeof o.content.load === 'object' && 'link' in o.content.load) {
        const { content, link } = this.linked(o.content.load.link, o.content.load.entry, actor, take, o.content.load.dir === true);
        ops.push({ ...(o as Op & { op: 'card.create' }), content }, { op: 'card.link', card: o.card, link });
        return;
      }
      if ((o.op === 'card.create' || o.op === 'card.content') && o.content && typeof o.content === 'object' && 'load' in o.content) {
        o.content = take(loadSpec(o.content.load, typeof o.title === 'string' ? o.title : 'Image'));
      }
      if ((o.op === 'picture.add' || o.op === 'picture.file') && o.file && typeof o.file === 'object' && 'load' in o.file) {
        if (typeof o.file.load !== 'string') throw new LoadError('file.load must be the path of a picture');
        const pic = loadPicture(o.file.load);
        blobs.set(pic.ref.hash, pic.bytes);
        o.file = pic.ref;
        if (o.op === 'picture.add') o.box = pictureBox(o.box, pic.size);
      }
      if (o.op === 'card.linkTo') {
        const { content, link } = this.linked(o.path, o.entry, actor, take, o.dir === true);
        ops.push({ op: 'card.content', card: o.card, content, viaLink: true }, { op: 'card.link', card: o.card, link });
        return;
      }
      if (o.op === 'card.unlink') {
        ops.push({ op: 'card.link', card: o.card, link: null });
        return;
      }
    } catch (e) {
      if (e instanceof LoadError) throw new ExpandError(i, name, e.message);
      throw e;
    }
    ops.push(o as Op);
  }

  /** A link's first content and the link itself: a file and its assets, or a whole folder. */
  private linked(target: unknown, entry: unknown, actor: Author, take: (l: Loaded) => CardContent, dir = false): { content: CardContent; link: CardLink } {
    if (typeof target !== 'string' || !target) throw new LoadError('A link needs the path of the file or folder to link');
    const abs = path.resolve(target);
    const isDir = dir || (existsSync(abs) && statSync(abs).isDirectory());
    // A folder's page is the content's entry from then on, which the watcher reads it by.
    const content = take(isDir ? loadPackage(abs, typeof entry === 'string' ? entry : undefined) : loadPage(abs));
    return { content, link: { path: abs, status: 'ok', author: actor, ...(isDir ? { dir: true } : {}) } };
  }

  // ---- Links ----

  /** Watchers for every linked card on the board, and none for the rest. `check`: look at each file now. */
  private syncLinks(check: boolean) {
    if (this.stopped) return;
    const linked = new Map(this.current.cards.filter((c) => c.link).map((c) => [c.id, c]));
    for (const [id, w] of this.links) {
      const card = linked.get(id);
      if (!card || card.link!.path !== w.link.path || !!card.link!.dir !== !!w.link.dir) {
        this.unwatch(w);
        this.links.delete(id);
      } else w.link = card.link!;
    }
    for (const [id, card] of linked) {
      if (this.links.has(id)) continue;
      const w: LinkWatch = { card: id, link: card.link!, files: [], sig: '', watchers: [] };
      this.links.set(id, w);
      if (check) this.checkLink(w);
      else {
        w.files = this.linkFiles(w);
        w.sig = this.signature(w);
        this.rewatch(w);
      }
    }
  }

  /** The files a link reads: a page and its collected assets, or a whole folder. */
  private linkFiles(w: LinkWatch): string[] {
    if (w.link.dir) return [w.link.path];
    const card = findCard(this.current, w.card);
    const root = path.dirname(w.link.path);
    const assets = Object.keys(card?.content?.files ?? {}).map((rel) => path.join(root, ...rel.split('/')));
    return [w.link.path, ...assets.filter((f) => f !== w.link.path)];
  }

  /** What the linked files look like now, cheaply: sizes, times and inodes (a folder link walks the folder). */
  private signature(w: LinkWatch): string {
    const parts: string[] = [];
    const stat = (f: string) => {
      try {
        const s = statSync(f);
        return `${s.size}:${s.mtimeMs}:${s.ino}`;
      } catch {
        return '-';
      }
    };
    if (w.link.dir) {
      const walk = (d: string, depth: number) => {
        let names: string[];
        try {
          names = readdirSync(d).sort();
        } catch {
          parts.push(`${d}:-`);
          return;
        }
        for (const n of names) {
          if (n.startsWith('.') || n === 'node_modules') continue;
          const f = path.join(d, n);
          parts.push(`${f}:${stat(f)}`);
          if (depth < 8 && parts.length < 2000) {
            try {
              if (statSync(f).isDirectory()) walk(f, depth + 1);
            } catch {
              // gone meanwhile
            }
          }
        }
      };
      walk(w.link.path, 0);
    } else for (const f of w.files) parts.push(`${f}:${stat(f)}`);
    return parts.join('|');
  }

  private pollLinks() {
    for (const w of this.links.values()) {
      if (this.signature(w) !== w.sig) this.schedule(w);
    }
  }

  private schedule(w: LinkWatch) {
    clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      w.timer = undefined;
      if (this.links.get(w.card) === w) this.checkLink(w);
    }, this.opts.linkDebounceMs ?? LINK_DEBOUNCE_MS);
    w.timer.unref?.();
  }

  /** Reads a link's files again: its card takes what changed, or shows the link broken (and recovers by itself). */
  private checkLink(w: LinkWatch) {
    const card = findCard(this.current, w.card);
    if (!card?.link) return;
    const link = card.link;
    let loaded: Loaded | undefined;
    let why: string | undefined;
    try {
      loaded = link.dir ? loadPackage(link.path, card.content?.entry ?? 'index.html') : loadPage(link.path);
    } catch (e) {
      why = e instanceof LoadError ? e.message : `${link.path} can't be read: ${(e as Error).message}`;
    }
    if (loaded) {
      const ops: Op[] = [];
      if (!card.content || !jsonEqual(card.content, loaded.content)) ops.push({ op: 'card.content', card: card.id, content: loaded.content, viaLink: true });
      if (link.status !== 'ok') ops.push({ op: 'card.link', card: card.id, link: { path: link.path, status: 'ok', author: link.author, ...(link.dir ? { dir: true } : {}) } });
      if (ops.length) {
        const r = this.applyOffice(ops, link.author, loaded.blobs);
        if (r.kind === 'rejected' && r.reason === 'invalid') why = `the file changed, but the card can't take it: ${r.error.reason}`;
      }
    }
    if (why && (link.status !== 'broken' || link.reason !== why)) this.applyOffice([{ op: 'card.link', card: card.id, link: { ...link, status: 'broken', reason: why.slice(0, 500) } }], link.author);
    const now = this.links.get(card.id);
    if (now !== w) return;
    w.link = findCard(this.current, card.id)?.link ?? link;
    w.files = loaded ? loaded.files : this.linkFiles(w);
    w.sig = this.signature(w);
    this.rewatch(w);
  }

  /** fs watchers on the folders a link's files are in, so a save (or an atomic rename) is seen at once. */
  private rewatch(w: LinkWatch) {
    this.unwatch(w);
    const dirs = w.link.dir ? [w.link.path] : [...new Set(w.files.map((f) => path.dirname(f)))];
    for (const d of dirs) {
      try {
        const watcher = watch(d, { persistent: false, recursive: !!w.link.dir }, () => this.schedule(w));
        watcher.on('error', () => watcher.close());
        w.watchers.push(watcher);
      } catch {
        // the folder is gone: the poll notices when it's back
      }
    }
  }

  private unwatch(w: LinkWatch) {
    clearTimeout(w.timer);
    for (const x of w.watchers) x.close();
    w.watchers = [];
  }

  // ---- Disk ----

  private mac(text: string): string {
    return createHmac('sha256', this.secret).update(text).digest('base64url');
  }

  private loadKey(): Buffer {
    const file = path.join(this.dir, 'key');
    try {
      const k = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
      if (k.length === 32) return k;
    } catch {
      // first start
    }
    const k = randomBytes(32);
    writeFileSync(file, k.toString('hex'), { mode: 0o600 });
    return k;
  }

  private load(): Saved {
    const fresh: Saved = { v: 1, board: emptyBoard(), record: { epochs: {}, horizon: 0 } };
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return fresh;
    }
    try {
      const s = JSON.parse(text) as Saved;
      if (s?.v !== 1 || !s.board || !Array.isArray(s.board.cards) || !s.record || typeof s.record.epochs !== 'object') throw new Error('not a Whiteboard file');
      return s;
    } catch (err) {
      const aside = `${this.file}.unreadable-${Date.now()}`;
      console.error(`droid-office: the Whiteboard in ${this.file} can't be read (${(err as Error).message}); it was moved to ${aside} and the board starts empty`);
      renameSync(this.file, aside);
      return fresh;
    }
  }

  private blobPath(hash: string): string {
    return path.join(this.blobDir, hash);
  }

  private blobSize(hash: string): number | undefined {
    try {
      return statSync(this.blobPath(hash)).size;
    } catch {
      return undefined;
    }
  }

  /** A blob's bytes, or undefined when the store doesn't have it. */
  readBlob(hash: string): Buffer | undefined {
    if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
    try {
      return readFileSync(this.blobPath(hash));
    } catch {
      return undefined;
    }
  }

  /** Where a blob is on disk, for an agent to open (a picture, say). */
  blobFile(hash: string): string {
    return this.blobPath(hash);
  }

  /** Writes new blobs, each through a temp file and an fsync, then fsyncs the folder. */
  private writeBlobs(blobs: Map<string, Buffer>) {
    let wrote = false;
    for (const [hash, body] of blobs) {
      const dest = this.blobPath(hash);
      if (existsSync(dest)) continue;
      const tmp = path.join(this.blobDir, `.${hash}.${randomBytes(4).toString('hex')}.tmp`);
      writeDurable(tmp, body);
      renameSync(tmp, dest);
      wrote = true;
    }
    if (wrote) fsyncDir(this.blobDir);
  }

  /** One commit: the blobs, then board.json through a temp file, an fsync and a rename, then the folder. */
  private commit(board: Board, record: OpRecord, blobs: Map<string, Buffer>) {
    const crash = this.opts.crash;
    this.writeBlobs(blobs);
    crash?.('blobs');
    const tmp = `${this.file}.tmp`;
    writeDurable(tmp, Buffer.from(JSON.stringify({ v: 1, board, record } satisfies Saved)));
    crash?.('temp');
    renameSync(tmp, this.file);
    fsyncDir(this.dir);
    crash?.('rename');
  }

  /** Deletes blobs neither the board nor a lease (a pinned snapshot, a staged upload) names. */
  private collectBlobs() {
    const keep = new Set<string>();
    for (const c of this.current.cards) {
      for (const f of Object.values(c.content?.files ?? {})) keep.add(f.hash);
      for (const p of c.pictures) keep.add(p.file.hash);
    }
    const now = this.now();
    for (const [id, l] of this.leases) {
      if (l.until !== undefined && l.until <= now) this.leases.delete(id);
      else for (const h of l.hashes) keep.add(h);
    }
    let names: string[];
    try {
      names = readdirSync(this.blobDir);
    } catch {
      return;
    }
    for (const name of names) if (/^[0-9a-f]{64}$/.test(name) && !keep.has(name)) rmSync(this.blobPath(name), { force: true });
  }
}

class ExpandError extends Error {
  constructor(
    readonly index: number,
    readonly op: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

function invalid(index: number, op: string | undefined, reason: string): ApplyOutcome {
  const message = index < 0 ? reason : `Operation ${index}${op ? ` (${op})` : ''} failed: ${reason}. Nothing was changed.`;
  return { kind: 'rejected', reason: 'invalid', error: { index, ...(op ? { op } : {}), reason, message } };
}

function loadSpec(spec: unknown, title: string): Loaded {
  if (!spec || typeof spec !== 'object') throw new LoadError('content.load must say where the content comes from: { html }, { file }, { dir } or { image }');
  const s = spec as Record<string, unknown>;
  if (typeof s.html === 'string') return pageFromText(s.html);
  if (typeof s.file === 'string') return loadPage(s.file);
  if (typeof s.dir === 'string') return loadPackage(s.dir, typeof s.entry === 'string' ? s.entry : undefined);
  if (typeof s.image === 'string') return loadImageCard(s.image, typeof s.title === 'string' ? s.title : title);
  throw new LoadError('content.load must be { html }, { file }, { dir } or { image }');
}

/** A picture's box when the agent left its size out: the image's own size, at most 480 px wide. */
function pictureBox(box: unknown, size?: { w: number; h: number }): unknown {
  const b = box && typeof box === 'object' ? (box as Record<string, unknown>) : {};
  if (b.w !== undefined && b.h !== undefined) return box;
  const w0 = size?.w || 320;
  const h0 = size?.h || 240;
  const scale = Math.min(1, 480 / w0);
  const w = Math.max(16, Math.round(w0 * scale));
  const h = Math.max(16, Math.round(h0 * scale));
  return { ...b, w: b.w ?? w, h: b.h ?? (b.w !== undefined ? Math.max(16, Math.round((h0 / w0) * Number(b.w))) : h) };
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

function writeDurable(file: string, body: Buffer) {
  const fd = openSync(file, 'w', 0o600);
  try {
    let off = 0;
    while (off < body.length) off += writeSync(fd, body, off, body.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(dir: string) {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Windows can't open a folder to fsync it; its renames are durable without it.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
