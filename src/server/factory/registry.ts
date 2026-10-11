import { emptyFactoryState, type FactoryConnection, type FactoryFeatureId, type FactoryState } from '../../shared/factory.js';
import { FactoryError, type FactoryApi } from './api.js';
import { FactoryDownload, HttpError, badRequest, httpErrorOf, keyRejected, matchPath, notConnected, type FactoryFeature, type FactoryRoute, type FeatureHost } from './feature.js';

/** How often the registry looks for a feature that's due. */
const TICK_MS = 1000;
/** Features start this far apart after connecting, so they don't all ask Factory at once. */
const STAGGER_MS = 1500;
/** Slice changes within this long go out as one broadcast. */
const BROADCAST_MS = 250;
/** A state that differs only in its poll times still goes out this often, so the ages browsers show stay right. */
export const HEARTBEAT_MS = 60_000;
/** The longest a failing feature waits before trying again. */
export const MAX_BACKOFF_MS = 15 * 60_000;
/** After a 429 without a Retry-After, at least this long (doubling with each one in a row). */
const RATE_LIMIT_MS = 60_000;
/** The biggest JSON body a route reads. */
const BODY_MAX = 256 * 1024;

/** What the registry needs from the connection (office.ts). */
export interface FactoryLink {
  connection(): FactoryConnection;
  /** The API as the key, while connected and not rejected. */
  client(): FactoryApi | undefined;
  /** Factory answered 401 for the saved key. */
  rejected(err: FactoryError): void;
}

export interface RegistryOptions {
  link: FactoryLink;
  broadcast(state: FactoryState): void;
  toast(text: string, level?: 'info' | 'warn' | 'error'): void;
  now?: () => number;
  broadcastMs?: number;
}

/**
 * FactoryState as broadcasts compare it: every `fetchedAt` (a slice's, a computer's metrics') only
 * says whether it has been read, since a poll that read the same data still moves it.
 */
export function sameness(state: FactoryState): string {
  return JSON.stringify(state, (key, value) => (key === 'fetchedAt' ? !!value : value));
}

interface Run {
  feature: FactoryFeature;
  running: boolean;
  /** When the last poll ended, 0 for never since connecting. */
  lastAt: number;
  /** When the first poll since connecting may start. */
  firstAt: number;
  /** Not before this, after failures. */
  backoffUntil: number;
  failures: number;
  /** Poll now, past the interval and the backoff. */
  forced: boolean;
}

/** What a route answered: a status and a JSON body, or a file to download. */
export interface FactoryHttpReply {
  status: number;
  body: unknown;
  download?: FactoryDownload;
}

/**
 * Every Factory feature of the office: runs their pollers while the office is connected, keeps the
 * browsers' watches, broadcasts FactoryState and dispatches /api/factory/<feature>/… to the
 * feature's routes. See docs/factory.md.
 */
export class FactoryRegistry {
  private runs = new Map<FactoryFeatureId, Run>();
  private watchers = new Map<FactoryFeatureId, Set<string>>();
  private timer?: ReturnType<typeof setInterval>;
  private flushTimer?: ReturnType<typeof setTimeout>;
  /** Bumped on every connection change: a poll or route in flight then is abandoned, and gets no more answers (FactoryApi.scoped). */
  private generation = 0;
  /** Ends the wait of every poll and route in flight, when the generation moves on. */
  private abandon = new Set<() => void>();
  private wasActive = false;
  private wasConnected = false;
  /** sameness() of the last broadcast, and when it went out. */
  private sent?: string;
  private sentAt = 0;
  /** A flush was skipped as the same: the next heartbeat sends it. */
  private stale = false;
  private now: () => number;

  constructor(private opts: RegistryOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Adds a feature; `make` gets the host it talks to the office through. */
  register<K extends FactoryFeatureId>(make: (host: FeatureHost) => FactoryFeature<K>): FactoryFeature<K> {
    let feature: FactoryFeature<K> | undefined;
    const host: FeatureHost = {
      changed: () => this.changed(),
      pollSoon: () => {
        if (feature) this.refresh(feature.key);
      },
      api: () => this.opts.link.client(),
      toast: (text, level) => this.opts.toast(text, level),
    };
    feature = make(host);
    if (this.runs.has(feature.key)) throw new Error(`Factory feature ${feature.key} is registered twice`);
    this.runs.set(feature.key, { feature, running: false, lastAt: 0, firstAt: 0, backoffUntil: 0, failures: 0, forced: false });
    return feature;
  }

  feature<K extends FactoryFeatureId>(key: K): FactoryFeature<K> | undefined {
    return this.runs.get(key)?.feature as FactoryFeature<K> | undefined;
  }

  /** What every browser gets: the connection and each feature's slice. */
  state(): FactoryState {
    const state = emptyFactoryState();
    state.connection = this.opts.link.connection();
    for (const [key, run] of this.runs) (state as unknown as Record<string, unknown>)[key] = run.feature.state();
    return state;
  }

  /** Something in FactoryState changed: one broadcast for everything that changes within BROADCAST_MS. */
  changed() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), this.opts.broadcastMs ?? BROADCAST_MS);
    this.flushTimer.unref?.();
  }

  /**
   * Broadcasts now, unless the state is what browsers last got but for its poll times and the last
   * broadcast is under HEARTBEAT_MS old: boards redraw on every one.
   */
  flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const state = this.state();
    const same = sameness(state);
    const now = this.now();
    if (same === this.sent && now - this.sentAt < HEARTBEAT_MS) {
      this.stale = true;
      return;
    }
    this.sent = same;
    this.sentAt = now;
    this.stale = false;
    this.opts.broadcast(state);
  }

  start() {
    if (this.timer) return;
    this.connectionChanged();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  /** The key was connected, replaced, rejected, checked again or forgotten. */
  connectionChanged() {
    const conn = this.opts.link.connection();
    const active = !!this.opts.link.client();
    const fresh = active && !this.wasActive;
    if (this.wasConnected && !conn.connected) for (const run of this.runs.values()) run.feature.reset();
    if (fresh || !active) {
      this.nextGeneration();
      const now = this.now();
      let i = 0;
      for (const run of this.runs.values()) {
        Object.assign(run, { lastAt: 0, firstAt: now + i++ * STAGGER_MS, backoffUntil: 0, failures: 0, forced: false });
      }
    }
    this.wasActive = active;
    this.wasConnected = conn.connected;
    this.changed();
    if (fresh) void this.tick();
  }

  /** Abandons everything in flight: what it reads belongs to the connection before. */
  private nextGeneration() {
    this.generation++;
    for (const run of this.runs.values()) run.running = false;
    for (const end of this.abandon) end();
    this.abandon.clear();
  }

  /** What `work` resolves to, or undefined as soon as the connection changes while it runs. */
  private async whileCurrent<T>(work: Promise<T>): Promise<{ value: T } | undefined> {
    let end!: () => void;
    const moved = new Promise<undefined>((resolve) => {
      end = () => resolve(undefined);
    });
    this.abandon.add(end);
    try {
      return await Promise.race([work.then((value) => ({ value })), moved]);
    } finally {
      this.abandon.delete(end);
    }
  }

  /** Another key replaced the last one: every feature forgets the old account's data and starts over. */
  keyReplaced() {
    for (const run of this.runs.values()) run.feature.reset();
    this.wasActive = false;
    this.connectionChanged();
  }

  /** Poll one feature (or all of them) now. */
  refresh(key?: FactoryFeatureId) {
    for (const run of this.runs.values()) if (!key || run.feature.key === key) run.forced = true;
    void this.tick();
  }

  /** A browser (`client`) has a board or window of `key` open (`on`), or closed it. */
  watch(client: string, key: FactoryFeatureId, on: boolean) {
    let set = this.watchers.get(key);
    if (on) {
      if (!set) this.watchers.set(key, (set = new Set()));
      set.add(client);
      void this.tick();
    } else set?.delete(client);
  }

  /** A connection closed: its watches go with it. */
  drop(client: string) {
    for (const set of this.watchers.values()) set.delete(client);
  }

  watched(key: FactoryFeatureId): boolean {
    return (this.watchers.get(key)?.size ?? 0) > 0;
  }

  /** How long `key` waits between polls right now. */
  intervalOf(key: FactoryFeatureId): number {
    const f = this.runs.get(key)?.feature;
    if (!f) return 0;
    return this.watched(key) || f.busy?.() ? f.fastInterval : f.interval;
  }

  /** Starts every poll that's due; resolves once they've all ended. */
  async tick(): Promise<void> {
    const now = this.now();
    if (this.stale && !this.flushTimer && now - this.sentAt >= HEARTBEAT_MS) this.flush();
    const api = this.opts.link.client();
    if (!api) return;
    const started: Promise<void>[] = [];
    for (const run of this.runs.values()) {
      if (run.running) continue;
      const due = run.forced || (run.lastAt === 0 ? now >= run.firstAt : now >= Math.max(run.lastAt + this.intervalOf(run.feature.key), run.backoffUntil));
      if (due) started.push(this.poll(run, api));
    }
    await Promise.all(started);
  }

  private async poll(run: Run, api: FactoryApi) {
    const generation = this.generation;
    const stale = () => generation !== this.generation;
    run.running = true;
    run.forced = false;
    let failed = false;
    let error: unknown;
    const scoped = api.scoped(stale);
    const polled = (async () => run.feature.poll(scoped))().catch((err: unknown) => {
      failed = true;
      error = err;
    });
    // The connection changed while it ran: it's abandoned (nextGeneration), and the old
    // connection's answers never reach the feature, whichever account comes next.
    if (!(await this.whileCurrent(polled)) || stale()) {
      // What it set after a wait of its own (not a call to Factory) is undone if nothing replaced the connection.
      void polled.then(() => {
        if (!this.opts.link.connection().connected) run.feature.reset();
      });
      return;
    }
    run.running = false;
    const now = this.now();
    run.lastAt = now;
    if (!failed) {
      run.failures = 0;
      run.backoffUntil = 0;
    } else {
      run.failures++;
      const e = error instanceof Error ? error : new Error(String(error));
      run.feature.failed(e);
      if (e instanceof FactoryError && e.status === 401) this.opts.link.rejected(e);
      run.backoffUntil = now + this.backoff(run, e);
    }
    if (run.forced) void this.tick();
  }

  /** How long a feature waits after its `failures`-th failure in a row. */
  private backoff(run: Run, err: Error): number {
    const n = run.failures;
    if (err instanceof FactoryError && err.status === 429) {
      const doubled = RATE_LIMIT_MS * 2 ** (n - 1);
      return Math.min(MAX_BACKOFF_MS, Math.max((err.retryAfter ?? 0) * 1000, doubled));
    }
    const interval = this.intervalOf(run.feature.key);
    return Math.min(Math.max(MAX_BACKOFF_MS, interval), interval * 2 ** (n - 1));
  }

  /**
   * Answers /api/factory/<feature>/<rest>. `trusted` is whether the request is the office's own page
   * (or a paired phone): anything but a GET needs it, so a web page can't drive Factory through the
   * owner's loopback. `body` reads the request body.
   */
  async http(method: string, rest: string, query: URLSearchParams, body: (limit: number) => Promise<string>, opts: { trusted: boolean; by?: string }): Promise<FactoryHttpReply> {
    const [, key = '', ...tail] = rest.split('/');
    const run = this.runs.get(key as FactoryFeatureId);
    if (!run) return { status: 404, body: { error: 'No such Factory feature' } };
    const path = tail.length ? `/${tail.join('/')}` : '';
    let params: Record<string, string> | undefined;
    let route: FactoryRoute | undefined;
    let pathMatched = false;
    for (const r of run.feature.routes ?? []) {
      const p = matchPath(r.path, path);
      if (!p) continue;
      pathMatched = true;
      if (r.method === method) {
        route = r;
        params = p;
        break;
      }
    }
    if (!route || !params) return pathMatched ? { status: 405, body: { error: 'Method not allowed' } } : { status: 404, body: { error: 'Not found' } };
    if (method !== 'GET' && !opts.trusted) return { status: 403, body: { error: 'Use Factory from the office itself' } };
    const bodyMax = route.bodyMax ?? BODY_MAX;
    try {
      const conn = this.opts.link.connection();
      const api = this.opts.link.client();
      if (!conn.connected) throw notConnected();
      if (!api) throw keyRejected(conn.rejected ?? 'it answered 401');
      let parsed: unknown;
      let read = false;
      const generation = this.generation;
      const scoped = api.scoped(() => generation !== this.generation);
      const handled = (async () =>
        route.handle({
          method,
          path,
          params,
          query,
          api: scoped,
          by: opts.by || 'Someone',
          json: async <T>() => {
            if (!read) {
              read = true;
              let text: string;
              try {
                text = await body(bodyMax);
              } catch {
                throw new HttpError(413, 'That request is too big');
              }
              try {
                parsed = text.trim() ? JSON.parse(text) : {};
              } catch {
                throw badRequest('Send JSON');
              }
            }
            return parsed as T;
          },
        }))();
      const done = await this.whileCurrent(handled);
      // Its key was replaced, rejected or forgotten on the way: no answer from the old one gets through.
      if (!done) throw new HttpError(409, 'The office’s Factory connection changed while that was on its way. Try again.');
      const answer = done.value;
      if (answer instanceof FactoryDownload) return { status: 200, body: {}, download: answer };
      return { status: 200, body: answer ?? {} };
    } catch (err) {
      if (err instanceof FactoryError && err.status === 401) this.opts.link.rejected(err);
      const { status, error } = httpErrorOf(err);
      return { status, body: { error } };
    }
  }
}
