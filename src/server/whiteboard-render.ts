// The Whiteboard's renderer (docs/whiteboard.md, "Rendering"): turns pinned cards into PNGs with the
// pinned headless Chromium in whiteboard-browser.ts. One RenderEngine serves the whole office; each
// floor's store gets its own FloorRenderer view of it (`engine.floor(id, hooks)`), which is the
// WhiteboardRenderer the store calls.
//
// One render:
//   - A fresh isolated context (whiteboard-browser.ts: no permissions, no service workers, no
//     downloads), with the office's own addresses blocked. Its one permission is local network
//     access for the harness, so a card reaches the owner's network as it does in the window.
//   - A harness page on an internal origin (HARNESS_ORIGIN, answered by route interception, never the
//     network) that loads the card exactly as the window does: `<iframe sandbox="${CARD_SANDBOX}"
//     allow="">` on the card's page, served byte for byte by `pin.serve(rel)` with CARD_HEADERS, so the
//     frame's origin is opaque. The harness speaks the bridge as host (source and nonce checked):
//     init with rendering: true, the snapshot's state, mode 'use', width CANONICAL_WIDTH.
//   - Settling: the SDK's ready, the frame's fonts, network quiet and a quiet period of DOM
//     mutations, each bounded by the settle limit. Then the frame grows to the page's height.
//   - Marks: `locate` for every anchor, then the card module's placement records (point plus box;
//     a comment is a pin centered on its point) drawn over the frame. A canvas card has no frame:
//     its marks are drawn at those records' bounds plus CANVAS_MARGIN (48; the window fits with 80).
//   - Capture: TILE_HEIGHT-tall PNG tiles top to bottom, at most MAX_TILES (the cap), and a thumb of
//     the top THUMB_SOURCE region at half size, all at device scale 1.
//
// The whole render has a hard timeout. One that fails or times out keeps the card's last good image
// and records the error. A finished image becomes the card's latest only if nothing newer (by board
// revision) finished first.

import { randomBytes } from 'node:crypto';
import type { Browser, BrowserContext, Frame, Page, Route } from 'playwright-core';
import type { WhiteboardRendererStatus } from '../shared/protocol.js';
import { BRIDGE_CHANNEL, parseFrameMsg } from '../shared/whiteboard-bridge.js';
import { boundsOf, placeMarks } from '../shared/whiteboard-marks.js';
import { CANONICAL_WIDTH, STICKY_COLORS, type Anchor, type Card, type Point } from '../shared/whiteboard.js';
import { BrowserError, browserStatus, classifyLaunchError, closeBrowser, ensureBrowser, installCommand, launchBrowser, newIsolatedContext, type BrowserStatus, type EnsureOptions, type InstallProgress } from './whiteboard-browser.js';
import { CARD_HEADERS, CARD_SANDBOX, sameKey, type CardRenders, type DrawnMark, type PinnedCard, type RenderImage, type RenderKey, type RenderOutcome, type WhiteboardRenderer } from './whiteboard.js';

/** Each PNG tile's height (px). A tile is CANONICAL_WIDTH wide. */
export const TILE_HEIGHT = 2048;
/** The most tiles a render captures: a page taller than TILE_HEIGHT × MAX_TILES is cut off there. */
export const MAX_TILES = 8;
/** The frame's height while the page first lays out (a laptop window); it then grows to the page. */
export const FRAME_HEIGHT = 800;
/** The thumbnail shows the top THUMB_SOURCE region of a page, scaled down to THUMB_WIDTH wide. */
export const THUMB_SOURCE = { w: CANONICAL_WIDTH, h: 800 } as const;
export const THUMB_WIDTH = 640;
/** Space around a canvas card's marks. */
export const CANVAS_MARGIN = 48;
/** A canvas wider than this is scaled down to it. */
export const MAX_CANVAS_WIDTH = 4096;
/** A comment pin's diameter (px), centered on its point. */
export const PIN_SIZE = 28;

/** Changes after which a card is rendered again wait this long for the next one. */
export const DEBOUNCE_MS = 400;
/** Background renders running at once, across every floor. */
export const CONCURRENCY = 2;
/** Cards waiting for a background render, across every floor; the oldest gives way. */
export const MAX_QUEUE = 64;
/** A background render's hard timeout. A read's comes with the read. */
export const RENDER_TIMEOUT_MS = 45_000;
/** The longest a render waits for a page to settle before it captures it as it is. */
export const SETTLE_MS = 10_000;
const NET_QUIET_MS = 500;
const DOM_QUIET_MS = 300;
/** A request in flight longer than this is long-lived (a stream, a long poll) and doesn't hold settling up. */
const LONG_REQUEST_MS = 5000;
/** After a failed download, the next render doesn't start another for this long. */
const DOWNLOAD_RETRY_MS = 10 * 60_000;
/** While the browser can't start, status() tries again in the background this often. */
const PROBE_MS = 60_000;

/** The harness page's origin: answered by route interception only, never resolved or reached. */
export const HARNESS_ORIGIN = 'https://render.droid-office.invalid';
const HARNESS_HOST = new URL(HARNESS_ORIGIN).host;

/** What one capture produced, before it becomes a RenderImage. */
export interface Capture {
  width: number;
  height: number;
  tiles: Buffer[];
  tileHeight: number;
  capped?: { capPx: number };
  thumb?: Buffer;
  origin?: Point;
  scale?: number;
  marks: DrawnMark[];
  /** Which element-anchored marks `locate` could place, for `marks.resolve`. */
  verdicts: { id: string; detached: boolean }[];
}

export interface CaptureOptions {
  signal: AbortSignal;
  settleMs: number;
  tileHeight: number;
  maxTiles: number;
  /** Requests the card must never reach (the office's own addresses). */
  blocked?: (url: URL) => boolean;
}

/** Per floor: who hears about renders, and where detached verdicts go. */
export interface FloorHooks {
  /** A card got a new latest image, or a failed render was recorded. */
  onRendered?: (cardId: string) => void;
  /** A render found marks whose anchors it could (or couldn't) place, unlike their flags (see WhiteboardStore.resolveMarks). */
  resolveMarks?: (cardId: string, key: RenderKey, marks: { id: string; detached: boolean }[]) => void;
}

/** What makes per-floor renderers: the office's RenderEngine, shared by every floor. */
export interface WhiteboardRenderers {
  floor(floorId: string, hooks?: FloorHooks): WhiteboardRenderer;
}

export interface RenderEngineOptions {
  /** The renderer became available or not, or a download moved on. */
  onStatus?: (status: WhiteboardRendererStatus) => void;
  /** Download Chromium on the first render when it's missing (the office's backstop). Default true. */
  download?: boolean;
  /** The office's own addresses, which a card's requests never reach from the renderer. */
  office?: () => { hosts: string[]; ports: number[] };
  debounceMs?: number;
  concurrency?: number;
  maxQueue?: number;
  timeoutMs?: number;
  settleMs?: number;
  tileHeight?: number;
  maxTiles?: number;
  now?: () => number;
  /** Tests: stand-ins for the browser module. */
  browserStatus?: () => Pick<BrowserStatus, 'installed' | 'path' | 'revision'>;
  ensure?: (o: EnsureOptions) => Promise<unknown>;
  launch?: () => Promise<Browser>;
  /** Tests: a capture that needs no browser at all. */
  capture?: (pin: PinnedCard, o: CaptureOptions) => Promise<Capture>;
}

interface Failure {
  kind: string;
  summary: string;
  fix: string;
  at: number;
}

interface Slot {
  id: string;
  image?: RenderImage;
  error?: CardRenders['error'];
  /** The key the card last changed to, and how to pin it. */
  wanted?: RenderKey;
  pin?: () => PinnedCard | undefined;
  timer?: NodeJS.Timeout;
  queued: boolean;
  running: boolean;
  /** It changed again while its background render ran. */
  dirty: boolean;
}

interface Job {
  floor: FloorRenderer;
  slot: Slot;
}

/** Renders every floor's cards with one browser, one queue and one status. */
export class RenderEngine implements WhiteboardRenderers {
  private readonly floors = new Set<FloorRenderer>();
  private readonly queue: Job[] = [];
  private active = 0;
  private installing?: { percent?: number; message: string };
  private failure?: Failure;
  private downloadFailedAt = 0;
  private probing = false;
  private lastProbe = 0;
  private lastStatus = '';
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly opts: RenderEngineOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  floor(floorId: string, hooks: FloorHooks = {}): FloorRenderer {
    const f = new FloorRenderer(this, floorId, hooks);
    this.floors.add(f);
    return f;
  }

  /** Whether renders can happen, and why not: never throws. */
  status(): WhiteboardRendererStatus {
    if (this.installing) {
      return {
        available: false,
        reason: 'Chromium is downloading for the Whiteboard (about 100 MB, the first time only). Cards render as soon as it is done.',
        installing: { ...this.installing },
      };
    }
    if (this.opts.capture) return this.failure ? { available: false, reason: failureText(this.failure) } : { available: true };
    const b = this.browser();
    if (this.failure && !(this.failure.kind === 'not-installed' && b.installed)) {
      this.probe();
      return { available: false, reason: failureText(this.failure) };
    }
    if (!b.installed) {
      return {
        available: false,
        reason:
          this.opts.download === false
            ? `Chromium isn't downloaded, so cards can't be rendered. Download it (about 100 MB, no admin rights needed) with: ${installCommand()}`
            : `Chromium isn't downloaded yet. The office downloads it (about 100 MB, no admin rights needed) the first time it renders a card; to do it now, run: ${installCommand()}`,
      };
    }
    return { available: true };
  }

  /** Stops every floor's renders and the browser. */
  async close(): Promise<void> {
    this.closed = true;
    for (const f of [...this.floors]) f.stop();
    this.queue.length = 0;
    if (!this.opts.launch && !this.opts.capture) await closeBrowser();
  }

  // ---- For FloorRenderer ----

  /** @internal */
  dropFloor(f: FloorRenderer) {
    this.floors.delete(f);
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i].floor === f) this.queue.splice(i, 1);
  }

  /** @internal */
  dequeue(f: FloorRenderer, slot: Slot) {
    const i = this.queue.findIndex((j) => j.floor === f && j.slot === slot);
    if (i >= 0) this.queue.splice(i, 1);
    slot.queued = false;
  }

  /** @internal A card changed: render it again once it has been quiet for the debounce. */
  changed(f: FloorRenderer, slot: Slot, key: RenderKey, pin: () => PinnedCard | undefined) {
    slot.wanted = key;
    slot.pin = pin;
    clearTimeout(slot.timer);
    slot.timer = undefined;
    if (slot.image && sameKey(slot.image.key, key)) return;
    slot.timer = setTimeout(() => {
      slot.timer = undefined;
      this.enqueue(f, slot);
    }, this.opts.debounceMs ?? DEBOUNCE_MS);
    slot.timer.unref?.();
  }

  /** @internal A read's render of exactly this snapshot (or the cached image of exactly it). */
  async renderRead(f: FloorRenderer, slot: Slot, pin: PinnedCard, timeoutMs: number): Promise<RenderOutcome> {
    if (slot.image && sameKey(slot.image.key, pin.key)) return { ok: true, image: slot.image };
    const start = this.now();
    try {
      const ready = await within(this.prepare(), timeoutMs);
      if (ready === TIMEOUT) return this.settle(f, slot, pin, { ok: false, error: this.status().reason ?? `Chromium wasn't ready within ${seconds(timeoutMs)}` });
    } catch (err) {
      return this.settle(f, slot, pin, { ok: false, error: errorText(err) });
    }
    return this.run(f, slot, pin, Math.max(1000, timeoutMs - (this.now() - start)));
  }

  private enqueue(f: FloorRenderer, slot: Slot) {
    if (this.closed || f.stopped || f.slot(slot.id, false) !== slot) return;
    if (slot.running) {
      slot.dirty = true;
      return;
    }
    if (slot.queued) return;
    slot.queued = true;
    this.queue.push({ floor: f, slot });
    const max = this.opts.maxQueue ?? MAX_QUEUE;
    while (this.queue.length > max) {
      const old = this.queue.shift()!;
      old.slot.queued = false;
      // It renders again on its next change; until then it says why it's behind.
      old.slot.error = { message: `The renderer had more than ${max} cards waiting, so this one was skipped; it renders again on its next change.`, at: this.now(), rev: old.slot.image?.rev ?? 0 };
      old.floor.hooks.onRendered?.(old.slot.id);
    }
    this.pump();
  }

  private pump() {
    const max = this.opts.concurrency ?? CONCURRENCY;
    while (!this.closed && this.active < max && this.queue.length) {
      const job = this.queue.shift()!;
      job.slot.queued = false;
      void this.background(job);
    }
  }

  private async background({ floor: f, slot }: Job) {
    this.active++;
    slot.running = true;
    let pin: PinnedCard | undefined;
    try {
      let unavailable: string | undefined;
      try {
        await this.prepare();
      } catch (err) {
        unavailable = errorText(err);
      }
      // Pinned only now, so a render that waited for the download shows the card as it is.
      if (this.closed || f.stopped || f.slot(slot.id, false) !== slot) return;
      pin = slot.pin?.();
      if (!pin) return;
      if (slot.image && sameKey(slot.image.key, pin.key)) return;
      if (unavailable) this.settle(f, slot, pin, { ok: false, error: unavailable });
      else await this.run(f, slot, pin, this.opts.timeoutMs ?? RENDER_TIMEOUT_MS);
    } catch (err) {
      if (pin) this.settle(f, slot, pin, { ok: false, error: errorText(err) });
    } finally {
      pin?.release();
      this.active--;
      slot.running = false;
      if (slot.dirty) {
        slot.dirty = false;
        this.enqueue(f, slot);
      }
      this.pump();
    }
  }

  /** One render of `pin` with a hard timeout; whatever comes of it is settled into the card's slot. */
  private async run(f: FloorRenderer, slot: Slot, pin: PinnedCard, timeoutMs: number): Promise<RenderOutcome> {
    const ac = new AbortController();
    const o: CaptureOptions = {
      signal: ac.signal,
      settleMs: Math.min(this.opts.settleMs ?? SETTLE_MS, Math.max(500, timeoutMs / 2)),
      tileHeight: this.opts.tileHeight ?? TILE_HEIGHT,
      maxTiles: this.opts.maxTiles ?? MAX_TILES,
      blocked: this.blocker(),
    };
    const work = (async () => {
      const browser = this.opts.capture ? undefined : await this.prepare();
      return this.opts.capture ? this.opts.capture(pin, o) : capture(browser as Browser, pin, o);
    })();
    let cap: Capture | typeof TIMEOUT;
    try {
      cap = await within(work, timeoutMs);
    } catch (err) {
      ac.abort();
      return this.settle(f, slot, pin, { ok: false, error: `The card couldn't be rendered: ${errorText(err)}` });
    }
    if (cap === TIMEOUT) {
      ac.abort();
      return this.settle(f, slot, pin, { ok: false, error: `The card didn't finish rendering within ${seconds(timeoutMs)} (its page kept loading or running scripts). The last good image is kept.` });
    }
    const image: RenderImage = {
      key: pin.key,
      rev: pin.rev,
      at: this.now(),
      width: cap.width,
      height: cap.height,
      tiles: cap.tiles,
      tileHeight: cap.tileHeight,
      ...(cap.capped ? { capped: cap.capped } : {}),
      ...(cap.thumb ? { thumb: cap.thumb } : {}),
      ...(cap.origin && (cap.origin.x || cap.origin.y) ? { origin: cap.origin } : {}),
      ...(cap.scale !== undefined && cap.scale !== 1 ? { scale: cap.scale } : {}),
      marks: cap.marks,
    };
    const out = this.settle(f, slot, pin, { ok: true, image });
    const live = (id: string) => [...pin.card.threads, ...pin.card.stickies, ...pin.card.pictures].find((m) => m.id === id);
    const differ = cap.verdicts.filter((v) => {
      const m = live(v.id);
      return !!m && !!m.detached !== v.detached;
    });
    if (differ.length && !f.stopped) {
      try {
        f.hooks.resolveMarks?.(pin.card.id, pin.key, differ);
      } catch (err) {
        console.error(`droid-office: the Whiteboard couldn't record which marks are detached: ${(err as Error).message}`);
      }
    }
    return out;
  }

  /**
   * Keeps what a render came to, if it's the newest thing known about the card: a success becomes the
   * latest image unless a newer one finished first; a failure is the last error unless something newer
   * finished, and the last good image stays.
   */
  private settle(f: FloorRenderer, slot: Slot, pin: PinnedCard, out: RenderOutcome): RenderOutcome {
    if (this.closed || f.stopped || f.slot(slot.id, false) !== slot) return out;
    if (out.ok) {
      if (slot.image && slot.image.rev >= out.image.rev) return out;
      slot.image = out.image;
      if (slot.error && slot.error.rev <= out.image.rev) slot.error = undefined;
    } else {
      if (slot.image && slot.image.rev >= pin.rev) return out;
      if (slot.error && slot.error.rev > pin.rev) return out;
      slot.error = { message: out.error, at: this.now(), rev: pin.rev };
    }
    try {
      f.hooks.onRendered?.(slot.id);
    } catch (err) {
      console.error(`droid-office: a Whiteboard render couldn't be announced: ${(err as Error).message}`);
    }
    return out;
  }

  // ---- The browser ----

  private browser() {
    try {
      return (this.opts.browserStatus ?? browserStatus)();
    } catch {
      return { installed: false, path: '', revision: '' };
    }
  }

  /**
   * The browser, downloaded first if it's missing and downloads are on, and started. Rejects with
   * what's wrong (kept for status()), never throws past a render.
   */
  private async prepare(): Promise<Browser> {
    if (this.closed) throw new Error('The office is closing');
    const b = this.browser();
    if (!b.installed) {
      if (this.opts.download === false) throw this.fail(new BrowserError(classifyLaunchError(`Executable doesn't exist in ${b.path} (chromium-headless-shell ${b.revision} is not downloaded)`)));
      if (this.failure?.kind === 'download-failed' && this.now() - this.downloadFailedAt < DOWNLOAD_RETRY_MS) throw new Error(failureText(this.failure));
      this.installing ??= { message: 'Starting the Chromium download' };
      this.emit();
      try {
        await (this.opts.ensure ?? ensureBrowser)({
          onProgress: (p: InstallProgress) => {
            if (p.phase === 'done' || !this.installing) return;
            this.installing = { ...(p.percent !== undefined ? { percent: p.percent } : {}), message: p.message };
            this.emit();
          },
        });
      } catch (err) {
        this.installing = undefined;
        this.downloadFailedAt = this.now();
        throw this.fail(err);
      }
      this.installing = undefined;
      this.emit();
    }
    try {
      const browser = await (this.opts.launch ?? launchBrowser)();
      if (this.failure) {
        this.failure = undefined;
        this.emit();
        this.retryWaiting();
      }
      return browser;
    } catch (err) {
      throw this.fail(err);
    }
  }

  private fail(err: unknown): Error {
    const e = err instanceof Error ? err : new Error(String(err));
    this.failure =
      e instanceof BrowserError ? { kind: e.kind, summary: e.summary, fix: e.fix || e.detail.split('\n').slice(-3).join(' '), at: this.now() } : { kind: 'other', summary: 'Chromium did not start.', fix: e.message, at: this.now() };
    // status() would otherwise try again at once.
    this.lastProbe = this.now();
    this.emit();
    return e;
  }

  /** While the browser can't start, try again now and then, so fixing the host brings renders back by itself. */
  private probe() {
    if (this.probing || this.closed || this.now() - this.lastProbe < PROBE_MS) return;
    if (this.failure?.kind === 'download-failed' && this.now() - this.downloadFailedAt < DOWNLOAD_RETRY_MS) return;
    this.probing = true;
    this.lastProbe = this.now();
    void this.prepare()
      .catch(() => {})
      .finally(() => {
        this.probing = false;
      });
  }

  /** Renders that failed while the browser was down go again once it's up. */
  private retryWaiting() {
    for (const f of this.floors) {
      for (const slot of f.slots()) {
        if (slot.pin && slot.wanted && (!slot.image || !sameKey(slot.image.key, slot.wanted))) this.enqueue(f, slot);
      }
    }
  }

  private emit() {
    const s = this.status();
    const json = JSON.stringify(s);
    if (json === this.lastStatus) return;
    this.lastStatus = json;
    try {
      this.opts.onStatus?.(s);
    } catch (err) {
      console.error(`droid-office: the renderer's status couldn't be announced: ${(err as Error).message}`);
    }
  }

  private blocker(): ((url: URL) => boolean) | undefined {
    const office = this.opts.office?.();
    if (!office) return undefined;
    const hosts = new Set(office.hosts.map((h) => h.toLowerCase().replace(/^\[|\]$/g, '')));
    const ports = new Set(office.ports);
    return (url) => {
      const port = Number(url.port) || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80);
      if (!ports.has(port)) return false;
      const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      return hosts.has(host) || host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '::1' || host === '0.0.0.0';
    };
  }
}

/** One floor's view of the engine: the WhiteboardRenderer its store calls. */
export class FloorRenderer implements WhiteboardRenderer {
  stopped = false;
  private readonly cards = new Map<string, Slot>();

  constructor(
    private readonly engine: RenderEngine,
    readonly floorId: string,
    readonly hooks: FloorHooks,
  ) {}

  status(): WhiteboardRendererStatus {
    return this.engine.status();
  }

  async render(pin: PinnedCard, opts: { timeoutMs: number }): Promise<RenderOutcome> {
    if (this.stopped) return { ok: false, error: 'This floor is closing' };
    try {
      return await this.engine.renderRead(this, this.slot(pin.card.id)!, pin, opts.timeoutMs);
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }

  changed(cardId: string, key: RenderKey, pin: () => PinnedCard | undefined): void {
    if (this.stopped) return;
    this.engine.changed(this, this.slot(cardId)!, key, pin);
  }

  latest(cardId: string): CardRenders {
    const s = this.cards.get(cardId);
    return { ...(s?.image ? { image: s.image } : {}), ...(s?.error ? { error: s.error } : {}) };
  }

  forget(cardId: string): void {
    const s = this.cards.get(cardId);
    if (!s) return;
    clearTimeout(s.timer);
    this.engine.dequeue(this, s);
    this.cards.delete(cardId);
  }

  stop(): void {
    if (this.stopped) return;
    for (const id of [...this.cards.keys()]) this.forget(id);
    this.stopped = true;
    this.engine.dropFloor(this);
  }

  /** @internal */
  slot(cardId: string, make = true): Slot | undefined {
    let s = this.cards.get(cardId);
    if (!s && make) {
      s = { id: cardId, queued: false, running: false, dirty: false };
      this.cards.set(cardId, s);
    }
    return s;
  }

  /** @internal */
  slots(): Slot[] {
    return [...this.cards.values()];
  }
}

// ---- One capture in Chromium ----

/** What the harness draws for a mark, in the harness page's px. */
interface Draw {
  id: string;
  kind: 'thread' | 'sticky' | 'picture';
  x: number;
  y: number;
  w: number;
  h: number;
  detached: boolean;
  color?: string;
  text?: string;
  src?: string;
  n?: number;
  resolved?: boolean;
}

/**
 * Renders a pinned card in a fresh isolated context of `browser`. Every pin it serves from is the
 * caller's; the context is closed whatever happens, including when `o.signal` aborts it.
 */
export async function capture(browser: Browser, pin: PinnedCard, o: CaptureOptions): Promise<Capture> {
  const canvas = pin.card.kind === 'canvas' || !pin.card.content;
  const plan = canvas ? canvasPlan(pin.card) : undefined;
  const viewportW = plan ? Math.max(1, Math.round(plan.w * plan.scale)) : CANONICAL_WIDTH;
  const context = await newIsolatedContext(browser, { viewport: { width: viewportW, height: o.tileHeight }, deviceScaleFactor: 1, colorScheme: 'light' });
  const close = () => void context.close().catch(() => {});
  o.signal.addEventListener('abort', close, { once: true });
  try {
    const nonce = randomBytes(18).toString('base64url');
    const net = watchNetwork(context);
    // Chromium treats the routed harness as a public page, so without this a card couldn't reach
    // the owner's localhost or LAN as it can in the window (the office's page is local itself).
    // The office's own addresses stay blocked below.
    await context.grantPermissions(['local-network-access'], { origin: HARNESS_ORIGIN });
    await context.route(
      (u) => u.host === HARNESS_HOST,
      (route) => answer(route, pin, harnessPage(pin, nonce, plan)),
    );
    if (o.blocked) {
      const blocked = o.blocked;
      await context.route(
        (u) => u.host !== HARNESS_HOST && blocked(u),
        (route) => route.abort('blockedbyclient'),
      );
      await context.routeWebSocket(
        (u) => blocked(u),
        (ws) => ws.close(),
      );
    }
    const page = await context.newPage();
    // allow-popups lets a card open windows; a render has no use for them.
    context.on('page', (p) => {
      if (p !== page) void p.close().catch(() => {});
    });
    aborted(o.signal);
    await page.goto(`${HARNESS_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: o.settleMs + 5000 });
    let marks: Draw[];
    let verdicts: Capture['verdicts'] = [];
    let height: number;
    if (plan) {
      marks = plan.marks;
      height = plan.h;
    } else {
      const settled = await settle(page, net, o);
      const located = settled.sdk ? await locate(page, pin.card, nonce) : undefined;
      verdicts = located ? [...located.values()].filter((p) => p.element).map((p) => ({ id: p.id, detached: p.detached })) : [];
      height = await growFrame(page, o, settled.height);
      marks = drawsFor(pin.card, located);
    }
    aborted(o.signal);
    const scale = plan?.scale ?? 1;
    const bottom = Math.max(height, ...marks.map((m) => m.y + m.h));
    const total = Math.ceil(bottom * scale);
    const cap = o.tileHeight * o.maxTiles;
    const covered = Math.min(total, cap);
    const count = Math.max(1, Math.ceil(covered / o.tileHeight));
    await page.evaluate(([m, pad]) => (window as unknown as HarnessWindow).__wb.draw(m as Draw[], pad as number), [marks, count * o.tileHeight] as const);
    await within(
      page.evaluate(() => (window as unknown as HarnessWindow).__wb.images()),
      5000,
    );
    const tiles: Buffer[] = [];
    let thumb: Buffer | undefined;
    for (let i = 0; i < count; i++) {
      aborted(o.signal);
      const y = i * o.tileHeight;
      await within(
        page.evaluate((top) => (window as unknown as HarnessWindow).__wb.scrollTo(top), y),
        2000,
      );
      if (!plan) await quiet(net, NET_QUIET_MS, 1500);
      const h = Math.min(o.tileHeight, covered - y);
      if (i === 0) thumb = await thumbnail(page, viewportW, h);
      tiles.push(await page.screenshot({ clip: { x: 0, y: 0, width: viewportW, height: h }, caret: 'hide', timeout: 10_000 }));
    }
    return {
      width: plan ? plan.w : CANONICAL_WIDTH,
      height: plan ? plan.h : Math.ceil(bottom),
      tiles,
      tileHeight: o.tileHeight,
      ...(total > cap ? { capped: { capPx: plan ? Math.floor(cap / scale) : cap } } : {}),
      ...(thumb ? { thumb } : {}),
      ...(plan ? { origin: { x: plan.x, y: plan.y }, scale } : {}),
      marks: marks.map((m) => drawn(m, plan)),
      verdicts,
    };
  } finally {
    o.signal.removeEventListener('abort', close);
    await within(
      context.close().catch(() => {}),
      5000,
    );
  }
}

function aborted(signal: AbortSignal) {
  if (signal.aborted) throw new Error('the render was stopped');
}

/** A mark as RenderImage.marks says it: canonical px, a pin by its center. */
function drawn(m: Draw, plan?: { x: number; y: number }): DrawnMark {
  const x = m.x + (plan?.x ?? 0);
  const y = m.y + (plan?.y ?? 0);
  if (m.kind === 'thread') return { id: m.id, kind: m.kind, x: x + m.w / 2, y: y + m.h / 2, detached: m.detached };
  return { id: m.id, kind: m.kind, x, y, w: m.w, h: m.h, detached: m.detached };
}

/** The harness's answers: its page, the card's files from the pinned snapshot, and the snapshot's pictures. */
async function answer(route: Route, pin: PinnedCard, harness: string) {
  const req = route.request();
  const url = new URL(req.url());
  try {
    // Only the top page is the harness: a card navigating its own frame to it would nest harnesses.
    if (url.pathname === '/' && req.isNavigationRequest() && !req.frame().parentFrame()) {
      return await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: harness });
    }
    if (url.pathname.startsWith('/c/')) {
      let rel: string;
      try {
        rel = url.pathname.slice(3).split('/').map(decodeURIComponent).join('/');
      } catch {
        rel = '\0';
      }
      const h = req.headers();
      const out = pin.serve(rel, { method: req.method(), range: h.range, ifRange: h['if-range'] });
      return await route.fulfill({ status: out.status, headers: out.headers, body: out.body });
    }
    const pic = /^\/pic\/([0-9a-f]{64})$/.exec(url.pathname);
    const ref = pic && pin.card.pictures.find((p) => p.file.hash === pic[1])?.file;
    const bytes = ref && pin.blob(ref.hash);
    if (ref && bytes) return await route.fulfill({ status: 200, headers: { 'content-type': ref.mime, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }, body: bytes });
    return await route.fulfill({ status: 404, headers: { ...CARD_HEADERS, 'content-type': 'text/plain; charset=utf-8' }, body: 'Not found' });
  } catch {
    // The context closed under it (a timeout), or the request came from no frame.
    await route.abort().catch(() => {});
  }
}

/** The page a render loads first: the card's frame, as the window makes it, and the layer marks are drawn on. */
function harnessPage(pin: PinnedCard, nonce: string, plan?: CanvasPlan): string {
  const c = pin.card;
  const init = JSON.stringify({ nonce, width: CANONICAL_WIDTH, card: { id: c.id, title: c.title, author: c.author }, state: c.state }).replace(/</g, '\\u003c');
  const entry = c.content ? c.content.entry.split('/').map(encodeURIComponent).join('/') : '';
  const frame = plan ? '' : `<iframe id="wb-card" title="card" sandbox="${CARD_SANDBOX}" allow="" referrerpolicy="no-referrer" src="/c/${entry}#wb=${nonce}"></iframe>`;
  const stage = plan ? `width:${Math.round(plan.w)}px;height:${Math.round(plan.h)}px;transform:scale(${plan.scale});transform-origin:0 0;${CANVAS_BACKGROUND}` : `width:${CANONICAL_WIDTH}px`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>render</title>
<style>
html,body{margin:0;padding:0;background:#fff;overflow:hidden}
#stage{position:relative;${stage}}
#wb-card{display:block;border:0;margin:0;padding:0;width:${CANONICAL_WIDTH}px;height:${FRAME_HEIGHT}px;background:#fff}
#marks{position:absolute;left:0;top:0;width:0;height:0;overflow:visible}
.m{position:absolute;box-sizing:border-box}
.sticky{padding:10px 12px;font:15px/1.35 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1d1d1d;border-radius:3px;box-shadow:0 2px 8px rgba(0,0,0,.28);overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}
.picture{object-fit:fill;box-shadow:0 2px 8px rgba(0,0,0,.28);background:#fff}
.pin{border-radius:50%;background:#ef6f2e;color:#fff;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45);font:700 13px/24px -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;text-align:center}
.pin.resolved{background:#8a8a8a;opacity:.55}
.detached{opacity:.6;outline:2px dashed #d33;outline-offset:2px}
</style></head>
<body><div id="stage">${frame}<div id="marks"></div></div><div id="pad"></div>
<script type="application/json" id="wb-init">${init}</script>
<script>${HARNESS_SCRIPT}</script>
</body></html>`;
}

const CANVAS_BACKGROUND = 'background-color:#f7f6f2;background-image:radial-gradient(#d6d3cb 1px,transparent 1px);background-size:24px 24px';

/**
 * The harness's side of the bridge (shared/whiteboard-bridge.ts), as the window's: a message counts
 * only from the card frame's own window with this load's nonce. Writes and actions are dropped,
 * since a render never changes the board.
 */
const HARNESS_SCRIPT = `(function () {
  'use strict';
  var CHANNEL = ${JSON.stringify(BRIDGE_CHANNEL)};
  var cfg = JSON.parse(document.getElementById('wb-init').textContent);
  var frame = document.getElementById('wb-card');
  var st = { ready: false, loaded: !frame, height: 0 };
  var req = 0;
  var waiting = {};
  function post(msg) {
    msg.channel = CHANNEL;
    msg.nonce = cfg.nonce;
    frame.contentWindow.postMessage(msg, '*');
  }
  if (frame) frame.addEventListener('load', function () { st.loaded = true; });
  window.addEventListener('message', function (e) {
    if (!frame || e.source !== frame.contentWindow) return;
    var d = e.data;
    if (!d || typeof d !== 'object' || d.channel !== CHANNEL || d.nonce !== cfg.nonce) return;
    if (d.type === 'ready') {
      st.ready = true;
      post({ type: 'init', card: cfg.card, state: cfg.state, rendering: true, mode: 'use', width: cfg.width });
    } else if (d.type === 'layout') {
      if (typeof d.height === 'number' && isFinite(d.height)) st.height = d.height;
    } else if (d.type === 'positions') {
      var w = waiting[d.req];
      if (w) {
        delete waiting[d.req];
        w(d.positions);
      }
    }
  });
  window.__wb = {
    state: function () { return { ready: st.ready, loaded: st.loaded, height: st.height }; },
    locate: function (anchors) {
      return new Promise(function (resolve) {
        var r = ++req;
        waiting[r] = resolve;
        post({ type: 'locate', req: r, anchors: anchors });
        setTimeout(function () {
          if (waiting[r]) {
            delete waiting[r];
            resolve(null);
          }
        }, 3000);
      });
    },
    setHeight: function (h) { frame.style.height = h + 'px'; },
    // The marks, from plain data, pictures under stickies under pins; then the page is padded to whole tiles.
    draw: function (marks, padTo) {
      var layer = document.getElementById('marks');
      var order = { picture: 0, sticky: 1, thread: 2 };
      marks.slice().sort(function (a, b) { return order[a.kind] - order[b.kind]; }).forEach(function (m) {
        var el = document.createElement(m.kind === 'picture' ? 'img' : 'div');
        el.className = 'm ' + (m.kind === 'thread' ? 'pin' : m.kind) + (m.resolved ? ' resolved' : '') + (m.detached ? ' detached' : '');
        el.style.left = m.x + 'px';
        el.style.top = m.y + 'px';
        el.style.width = m.w + 'px';
        el.style.height = m.h + 'px';
        if (m.kind === 'sticky') {
          el.style.background = m.color || '#ffd866';
          el.textContent = m.text || '';
        } else if (m.kind === 'picture') el.src = m.src || '';
        else el.textContent = String(m.n || '');
        layer.appendChild(el);
      });
      var stage = document.getElementById('stage');
      document.getElementById('pad').style.height = Math.max(0, padTo - stage.getBoundingClientRect().height) + 'px';
    },
    images: function () {
      return Promise.all(Array.prototype.map.call(document.querySelectorAll('#marks img'), function (i) { return i.decode().catch(function () {}); }));
    },
    // Scrolls to a tile and waits two frames, so what's in it is painted.
    scrollTo: function (y) {
      window.scrollTo(0, y);
      return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(function () { r(true); }); }); });
    },
    shrink: function (b64, w, h) {
      var img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      return img.decode().then(function () {
        var c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        var g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, w, h);
        return c.toDataURL('image/png').slice('data:image/png;base64,'.length);
      });
    }
  };
})();`;

/** Run in the card's frame (strings, since tsx would wrap a function's inner names in a helper the page lacks). */
const FRAME_FONTS = 'document.fonts.ready.then(function () { return true; })';
const FRAME_TWO_FRAMES = 'new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(function () { r(true); }); }); })';
/** The page's full height (at least the frame's own height). */
const FRAME_HEIGHT_OF_PAGE = 'Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)';
/** When the card's DOM last changed. A card can lie about it, and only delays its own render. */
const FRAME_WATCH = `(function () {
  if (window.__wbQuietFor) return true;
  var last = performance.now();
  new MutationObserver(function () { last = performance.now(); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  window.__wbQuietFor = function () { return performance.now() - last; };
  return true;
})()`;
const FRAME_QUIET_FOR = "typeof window.__wbQuietFor === 'function' ? window.__wbQuietFor() : 1e9";

type Harness = {
  state(): { ready: boolean; loaded: boolean; height: number };
  locate(a: unknown): Promise<unknown>;
  setHeight(h: number): void;
  draw(marks: Draw[], padTo: number): void;
  images(): Promise<unknown>;
  scrollTo(y: number): Promise<boolean>;
  shrink(b64: string, w: number, h: number): Promise<string>;
};
type HarnessWindow = { __wb: Harness };

/** A small PNG of the top of the page: THUMB_SOURCE scaled to THUMB_WIDTH, drawn by the harness's own canvas. */
async function thumbnail(page: Page, width: number, tileH: number): Promise<Buffer | undefined> {
  const srcW = Math.min(width, THUMB_SOURCE.w);
  const srcH = Math.max(1, Math.min(tileH, Math.round((srcW * THUMB_SOURCE.h) / THUMB_SOURCE.w)));
  const top = await page.screenshot({ clip: { x: 0, y: 0, width: srcW, height: srcH }, caret: 'hide', timeout: 10_000 });
  const outW = Math.min(THUMB_WIDTH, srcW);
  const outH = Math.max(1, Math.round((srcH * outW) / srcW));
  if (outW === srcW) return top;
  const b64 = await within(
    page.evaluate(([b, w, h]) => (window as unknown as HarnessWindow).__wb.shrink(b as string, w as number, h as number), [top.toString('base64'), outW, outH] as const),
    5000,
  );
  return typeof b64 === 'string' ? Buffer.from(b64, 'base64') : undefined;
}

interface NetWatch {
  /** How long since a request that isn't long-lived started or ended; 0 while one is in flight. */
  quietFor(): number;
}

function watchNetwork(context: BrowserContext): NetWatch {
  const inflight = new Map<object, number>();
  let last = Date.now();
  const end = (r: object) => {
    inflight.delete(r);
    last = Date.now();
  };
  context.on('request', (r) => {
    if (r.url().startsWith('data:')) return;
    inflight.set(r, Date.now());
    last = Date.now();
  });
  context.on('requestfinished', end);
  context.on('requestfailed', end);
  return {
    quietFor() {
      const now = Date.now();
      for (const at of inflight.values()) if (now - at < LONG_REQUEST_MS) return 0;
      return now - last;
    },
  };
}

async function quiet(net: NetWatch, ms: number, limit: number) {
  const end = Date.now() + limit;
  while (Date.now() < end && net.quietFor() < ms) await sleep(50);
}

/** The card's frame, as Playwright reaches it (it may have navigated). */
async function cardFrame(page: Page): Promise<Frame | null> {
  const el = await page.$('#wb-card');
  return el ? el.contentFrame() : null;
}

/**
 * Waits for the page to settle, at most `o.settleMs`: the SDK said ready (or the frame loaded
 * without one), its fonts are in, nothing has been fetched for a while, and its DOM has stopped
 * changing. A page that never settles (a ticking clock) is captured as it is when the limit comes.
 */
async function settle(page: Page, net: NetWatch, o: CaptureOptions): Promise<{ sdk: boolean; height: number }> {
  const end = Date.now() + o.settleMs;
  const left = () => Math.max(0, end - Date.now());
  const state = () =>
    within(
      page.evaluate(() => (window as unknown as HarnessWindow).__wb.state()),
      2000,
    );
  let s = await state();
  while (left() > 0 && (s === TIMEOUT || !(s.ready || s.loaded))) {
    aborted(o.signal);
    await sleep(50);
    s = await state();
  }
  // The SDK says ready once the page has parsed, which can be just after the frame's load event.
  const wait = Date.now() + Math.min(500, left());
  while (Date.now() < wait && s !== TIMEOUT && !s.ready) {
    await sleep(50);
    s = await state();
  }
  let frame = await cardFrame(page);
  if (frame) await within(frame.evaluate(FRAME_FONTS), Math.min(left(), 5000));
  frame = await cardFrame(page);
  if (frame) await within(frame.evaluate(FRAME_WATCH), 2000);
  while (left() > 0) {
    aborted(o.signal);
    frame = await cardFrame(page);
    const dom = frame ? await within(frame.evaluate(FRAME_QUIET_FOR), 1000) : 1e9;
    const st = await state();
    const loaded = st !== TIMEOUT && st.loaded;
    if (loaded && typeof dom === 'number' && dom >= DOM_QUIET_MS && net.quietFor() >= NET_QUIET_MS) break;
    await sleep(100);
  }
  const fin = await state();
  return { sdk: fin !== TIMEOUT && fin.ready, height: fin !== TIMEOUT ? fin.height : 0 };
}

/**
 * Grows the frame to the page's height, up to the cap, so the whole page is laid out as one: a few
 * rounds, since a page that sizes itself by the frame (100vh) grows with it.
 */
async function growFrame(page: Page, o: CaptureOptions, reported: number): Promise<number> {
  const cap = o.tileHeight * o.maxTiles;
  const measure = async () => {
    const frame = await cardFrame(page);
    const h = frame ? await within(frame.evaluate(FRAME_HEIGHT_OF_PAGE), 2000) : TIMEOUT;
    return typeof h === 'number' && Number.isFinite(h) && h > 0 ? h : 0;
  };
  let height = Math.max(FRAME_HEIGHT, (await measure()) || reported || FRAME_HEIGHT);
  let frameH = FRAME_HEIGHT;
  for (let round = 0; round < 3 && height > frameH && frameH < cap; round++) {
    aborted(o.signal);
    frameH = Math.min(Math.ceil(height), cap);
    await page.evaluate((h) => (window as unknown as HarnessWindow).__wb.setHeight(h), frameH);
    const frame = await cardFrame(page);
    if (frame) await within(frame.evaluate(FRAME_TWO_FRAMES), 1000);
    const next = await measure();
    if (!next || next <= height) break;
    height = next;
  }
  return Math.max(height, frameH);
}

interface Located {
  id: string;
  point: Point | null;
  detached: boolean;
  element: boolean;
}

/** Where the SDK places each mark's anchor on the page as it is now (validated: it's the card's word). */
async function locate(page: Page, card: Card, nonce: string): Promise<Map<string, Located> | undefined> {
  const anchors = [...card.threads, ...card.stickies, ...card.pictures].map((m) => ({ id: m.id, anchor: m.anchor }));
  if (!anchors.length) return new Map();
  const raw = await within(
    page.evaluate((a) => (window as unknown as HarnessWindow).__wb.locate(a), anchors),
    4000,
  );
  if (raw === TIMEOUT || raw === null) return undefined;
  const msg = parseFrameMsg({ type: 'positions', req: 1, positions: raw, channel: BRIDGE_CHANNEL, nonce }, nonce);
  if (msg?.type !== 'positions') return undefined;
  const byId = new Map<string, Anchor>(anchors.map((a) => [a.id, a.anchor]));
  const out = new Map<string, Located>();
  for (const p of msg.positions) {
    const anchor = byId.get(p.id);
    if (!anchor || out.has(p.id)) continue;
    out.set(p.id, { id: p.id, point: p.point && Math.abs(p.point.x) < 1e7 && Math.abs(p.point.y) < 1e7 ? p.point : null, detached: p.detached || !p.point, element: anchor.kind === 'element' });
  }
  return out;
}

/** Where each mark goes: its anchor's located point (its own point when detached or unlocated) plus its box. */
function drawsFor(card: Card, located: Map<string, Located> | undefined): Draw[] {
  const at = (id: string, anchor: Anchor): { p: Point; detached: boolean } => {
    const l = located?.get(id);
    if (l?.point && !l.detached) return { p: l.point, detached: false };
    // Unlocated (no SDK answered): the flag the board already has.
    return { p: anchor.point, detached: l ? true : anchor.kind === 'element' && !!(card.threads.find((t) => t.id === id) ?? card.stickies.find((s) => s.id === id) ?? card.pictures.find((x) => x.id === id))?.detached };
  };
  return marksAt(card, at);
}

/** Paint records from the card module: the same point-plus-box the window uses, with a comment drawn as a pin. */
function marksAt(card: Card, at: (id: string, anchor: Anchor) => { p: Point; detached: boolean }): (Draw & { id: string })[] {
  const placed = placeMarks(
    card,
    (id, anchor) => {
      const spot = at(id, anchor);
      return { point: spot.p, detached: spot.detached };
    },
    PIN_SIZE,
  );
  const pictures = new Map(card.pictures.map((p) => [p.id, p]));
  const stickies = new Map(card.stickies.map((s) => [s.id, s]));
  const threads = new Map(card.threads.map((t, i) => [t.id, { t, n: i + 1 }]));
  return placed.map((m) => {
    if (m.kind === 'picture') {
      const p = pictures.get(m.id);
      return p ? { ...m, src: `/pic/${p.file.hash}` } : m;
    }
    if (m.kind === 'sticky') {
      const s = stickies.get(m.id);
      return s ? { ...m, color: STICKY_COLORS[s.color] ?? STICKY_COLORS.yellow, text: s.text } : m;
    }
    const t = threads.get(m.id);
    return t ? { ...m, n: t.n, resolved: t.t.resolved } : m;
  });
}

interface CanvasPlan {
  /** The bounds' top-left in canonical px, and their size with the margin. */
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
  /** The marks, relative to the bounds' top-left. */
  marks: (Draw & { id: string })[];
}

/** A canvas card's image: the card module's placement, outset by CANVAS_MARGIN (an empty canvas is one blank frame). */
export function canvasPlan(card: Card): CanvasPlan {
  const marks = marksAt(card, (_id, anchor) => ({ p: anchor.point, detached: false }));
  if (!marks.length) return { x: 0, y: 0, w: CANONICAL_WIDTH, h: FRAME_HEIGHT, scale: 1, marks };
  const bounds = boundsOf(marks, CANVAS_MARGIN, { x: 0, y: 0, w: CANONICAL_WIDTH, h: FRAME_HEIGHT });
  const x = Math.floor(bounds.x);
  const y = Math.floor(bounds.y);
  const w = Math.ceil(bounds.x + bounds.w - x);
  const h = Math.ceil(bounds.y + bounds.h - y);
  return { x, y, w, h, scale: Math.min(1, MAX_CANVAS_WIDTH / w), marks: marks.map((m) => ({ ...m, x: m.x - x, y: m.y - y })) };
}

// ---- Small helpers ----

const TIMEOUT = Symbol('timeout');

/** `p`, or TIMEOUT if it takes longer than `ms`. A rejection still rejects. */
function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), Math.max(0, ms));
  });
  p.catch(() => {});
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function seconds(ms: number) {
  return `${Math.round(ms / 100) / 10} s`;
}

function failureText(f: Failure): string {
  return [f.summary, f.fix].filter(Boolean).join(' ');
}

function errorText(err: unknown): string {
  if (err instanceof BrowserError) return [err.summary, err.fix].filter(Boolean).join(' ') || err.message;
  return err instanceof Error ? err.message : String(err);
}
