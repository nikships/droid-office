import type { FactoryFeatureId, FactoryState } from '../../shared/factory.js';
import { FactoryError, type FactoryApi } from './api.js';

// The contract a Factory feature module implements (docs/factory.md). The registry (registry.ts)
// polls it while the office is connected, broadcasts its slice, and serves its HTTP routes under
// /api/factory/<key>/…

/** What the registry gives a feature when it makes it. */
export interface FeatureHost {
  /** The feature's slice changed: every browser hears about it (coalesced, a few times a second at most). */
  changed(): void;
  /** Poll this feature again as soon as it can, past its interval and any backoff (after an action, say). */
  pollSoon(): void;
  /** The API as the office's key, or undefined while it isn't connected or the key was rejected. */
  api(): FactoryApi | undefined;
  /** A toast for everyone in the office. */
  toast(text: string, level?: 'info' | 'warn' | 'error'): void;
}

/** One HTTP route of a feature: `path` is under /api/factory/<key>, with `:name` segments, '' for the root. */
export interface FactoryRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  /** The biggest request body it reads, in bytes (256 KB unless it says; a message with pictures needs more). */
  bodyMax?: number;
  /** Resolves to the JSON to answer with (200). Throw an HttpError (badRequest…) or let a FactoryError through for anything else. */
  handle(req: FactoryRequest): unknown;
}

export interface FactoryRequest {
  method: string;
  /** The path under /api/factory/<key>, like `/abc/restart` ('' for the root). */
  path: string;
  /** The `:name` segments of the route's path. */
  params: Record<string, string>;
  query: URLSearchParams;
  /** The request body as JSON; a 400 when it isn't. */
  json<T = unknown>(): Promise<T>;
  /** The API as the office's key (a route only runs while the office is connected). */
  api: FactoryApi;
  /** Who's asking, for toasts and logs (the page's player name), or "Someone". */
  by: string;
}

/**
 * A Factory feature: one slice of FactoryState, a poller that fills it, and its routes. The
 * registry runs `poll` every `interval` ms while connected, every `fastInterval` while a browser
 * watches the feature (factory.watch) or `busy()` says something is in flight, never two at once,
 * and backs off after errors.
 */
export interface FactoryFeature<K extends FactoryFeatureId = FactoryFeatureId> {
  readonly key: K;
  readonly interval: number;
  readonly fastInterval: number;
  /** The slice as browsers get it now. */
  state(): FactoryState[K];
  /** Reads Factory and updates the slice (calling host.changed()). Throws when the read failed. */
  poll(api: FactoryApi): Promise<void>;
  /** Something in flight that should be watched closely (a computer provisioning, a cloud session running). */
  busy?(): boolean;
  /** The last poll threw: keep the last good data and say why. */
  failed(err: Error): void;
  /** Disconnected (or another key): forget everything. */
  reset(): void;
  readonly routes?: readonly FactoryRoute[];
}

type Slice<K extends FactoryFeatureId> = FactoryState[K];

/** The usual way to hold a slice: `set` replaces fields and tells the registry, `failed` keeps the data with the error. */
export abstract class SliceFeature<K extends FactoryFeatureId> implements FactoryFeature<K> {
  abstract readonly interval: number;
  abstract readonly fastInterval: number;
  protected slice: Slice<K>;

  constructor(
    readonly key: K,
    protected host: FeatureHost,
    private empty: () => Slice<K>,
  ) {
    this.slice = empty();
  }

  abstract poll(api: FactoryApi): Promise<void>;

  state(): Slice<K> {
    return this.slice;
  }

  protected set(patch: Partial<Slice<K>>) {
    this.slice = { ...this.slice, ...patch };
    this.host.changed();
  }

  failed(err: Error) {
    if ((this.slice as { error?: string }).error === err.message) return;
    this.set({ error: err.message } as Partial<Slice<K>>);
  }

  reset() {
    this.slice = this.empty();
    this.host.changed();
  }
}

// ---- HTTP helpers for routes -------------------------------------------------------------------

/** An answer other than 200, with the message the browser shows. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message = 'Not found') => new HttpError(404, message);
export const notConnected = () => new HttpError(409, 'The office isn’t connected to Factory. Connect it in ⚙️ Settings → Factory.');
export const keyRejected = (why: string) => new HttpError(409, `Factory rejected the office’s API key (${why}). Check it again or replace it in ⚙️ Settings → Factory.`);

/** The status and message to answer a failed route with. */
export function httpErrorOf(err: unknown): { status: number; error: string } {
  if (err instanceof HttpError) return { status: err.status, error: err.message };
  if (err instanceof FactoryError) {
    // A 401 from Factory is about the office's key, not the browser's access to the office.
    if (err.status === 401) return { status: 502, error: err.message };
    if (err.status === 0) return { status: err.timedOut ? 504 : 502, error: err.message };
    if ([400, 402, 403, 404, 409, 422, 429].includes(err.status)) return { status: err.status, error: err.message };
    return { status: 502, error: err.message };
  }
  return { status: 500, error: 'Something went wrong talking to Factory.' };
}

/** The `:name` segments of `pattern` in `path`, or undefined when it doesn't match. */
export function matchPath(pattern: string, path: string): Record<string, string> | undefined {
  const split = (p: string) => p.split('/').filter(Boolean);
  const want = split(pattern);
  const got = split(path);
  if (want.length !== got.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) {
      let v: string;
      try {
        v = decodeURIComponent(got[i]);
      } catch {
        return undefined;
      }
      params[want[i].slice(1)] = v;
    } else if (want[i] !== got[i]) return undefined;
  }
  return params;
}

/** A string from a JSON body, trimmed and capped; '' for anything else. */
export const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
