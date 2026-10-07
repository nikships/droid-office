import { redact } from '../jira.js';

/** Factory's public API. Every path below is under `/api/v0`. */
export const FACTORY_API = 'https://api.factory.ai';
/** Most calls answer within a second or two; this is for a slow one. */
export const TIMEOUT_MS = 20_000;
/** GET /sessions (and sometimes /sessions/{id}) hangs 30-90 s on a cold call, then answers in about 1 s. */
export const SLOW_TIMEOUT_MS = 60_000;

type Fetch = typeof fetch;
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export type Query = Record<string, string | number | boolean | undefined>;

/**
 * What Factory (or the way to it) turned down, carrying the API's own `{status, title, detail}`.
 * `status` 0 means no answer at all: a timeout (`timedOut`) or a network error. Never carries the key.
 */
export class FactoryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly title = '',
    readonly detail = '',
    /** Seconds, from a 429's Retry-After. */
    readonly retryAfter?: number,
    readonly timedOut = false,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** ms; SLOW_TIMEOUT_MS for /sessions, else TIMEOUT_MS. */
  timeoutMs?: number;
  /** Try a GET once more after a timeout or network error (default true for GETs; never for writes). */
  retry?: boolean;
}

/** The key as browsers may see it: `fk-…a1b2`. */
export function fingerprint(key: string): string {
  const k = key.trim();
  const head = /^fk-/i.test(k) ? k.slice(0, 3) : '';
  return `${head}…${k.slice(-4)}`;
}

/** Why Factory said no, from its `{detail, title}` error body. */
function factorySays(body: unknown): { title: string; detail: string } {
  if (!body || typeof body !== 'object') return { title: '', detail: '' };
  const b = body as { title?: unknown; detail?: unknown; message?: unknown; error?: unknown };
  const text = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 400) : '');
  return { title: text(b.title), detail: text(b.detail) || text(b.message) || text(b.error) };
}

/** Whether a path is one of the slow sessions calls. */
const slow = (path: string) => path === '/sessions' || path.startsWith('/sessions/') || path.startsWith('/sessions?');

/**
 * Factory's REST API as the office's one key (Bearer). JSON in and out. Nothing here logs, and no
 * error message carries the key.
 */
export class FactoryApi {
  constructor(
    private key: string,
    private fetchImpl: Fetch = fetch,
    private base = FACTORY_API,
  ) {}

  private redact(text: string): string {
    return redact(text, [this.key]);
  }

  /** `path` is under /api/v0, like `/computers` or `/sessions/abc`. */
  async request<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
    const retry = method === 'GET' && opts.retry !== false;
    try {
      return await this.once<T>(method, path, opts);
    } catch (err) {
      if (retry && err instanceof FactoryError && err.status === 0) return this.once<T>(method, path, opts);
      throw err;
    }
  }

  private async once<T>(method: Method, path: string, opts: RequestOptions): Promise<T> {
    const url = new URL(`/api/v0${path}`, this.base);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const timeoutMs = opts.timeoutMs ?? (slow(path) ? SLOW_TIMEOUT_MS : TIMEOUT_MS);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${this.key}`, accept: 'application/json', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        redirect: 'error',
        signal: abort.signal,
      });
      text = await res.text();
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      const timedOut = abort.signal.aborted;
      const why = timedOut ? `it did not answer within ${Math.round(timeoutMs / 1000)}s` : (e.cause?.code ?? e.message);
      throw new FactoryError(this.redact(`Couldn't reach Factory (${why}).`), 0, '', '', undefined, timedOut);
    } finally {
      clearTimeout(timer);
    }
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (res.ok) return parsed as T;
    const { title, detail } = factorySays(parsed);
    const t = this.redact(title);
    const d = this.redact(detail);
    const said = d || t;
    const status = res.status;
    if (status === 401) throw new FactoryError(`Factory didn't accept the API key (401)${said ? `: ${said}` : ''}.`, 401, t, d);
    if (status === 402) throw new FactoryError(`That needs another Factory plan (402)${said ? `: ${said}` : ''}.`, 402, t, d);
    if (status === 403) throw new FactoryError(`The key's account isn't allowed to do that (403)${said ? `: ${said}` : ''}.`, 403, t, d);
    if (status === 429) {
      const after = Number(res.headers.get('retry-after'));
      throw new FactoryError('Factory is rate limiting the office (429). It tries again in a while.', 429, t, d, Number.isFinite(after) && after > 0 ? after : undefined);
    }
    throw new FactoryError(said ? `${said} (${status})` : `Factory answered ${status}.`, status, t, d);
  }

  get<T>(path: string, query?: Query, opts: Omit<RequestOptions, 'query' | 'body'> = {}): Promise<T> {
    return this.request<T>('GET', path, { ...opts, query });
  }

  post<T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    return this.request<T>('POST', path, { ...opts, body });
  }

  patch<T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    return this.request<T>('PATCH', path, { ...opts, body });
  }

  delete<T>(path: string, opts: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    return this.request<T>('DELETE', path, opts);
  }

  // ---- The reads the probe and the first pollers make. Raw answers: the features shape them. ----

  providers(): Promise<{ providers?: unknown[] }> {
    return this.get('/computers/providers');
  }

  computers(): Promise<{ computers?: unknown[] }> {
    return this.get('/computers');
  }

  /** 5-minute samples since `start` (400 for a BYOM computer). */
  metrics(computerId: string, start?: Date): Promise<unknown[]> {
    return this.get(`/computers/${encodeURIComponent(computerId)}/metrics`, { start: start?.toISOString() });
  }

  sessions(limit: number, cursor?: string): Promise<{ sessions?: unknown[]; pagination?: { hasMore?: boolean; nextCursor?: string | null } }> {
    return this.get('/sessions', { limit: Math.max(1, Math.min(100, Math.round(limit))), cursor });
  }

  ciOwners(): Promise<{ owners?: unknown[]; integration?: { connected?: boolean } }> {
    return this.get('/automations/ci/repository-owners');
  }

  ciScan(): Promise<{ workflows?: unknown[]; scannedAt?: number; integration?: { connected?: boolean } }> {
    return this.get('/automations/ci/scan');
  }

  ciRuns(): Promise<{ runs?: unknown[]; integration?: { connected?: boolean } }> {
    return this.get('/automations/ci/runs');
  }

  wikiRuns(): Promise<{ wikiRuns?: unknown[] }> {
    return this.get('/wiki');
  }

  users(): Promise<{ users?: unknown[]; pagination?: { hasMore?: boolean } }> {
    return this.get('/organization/users', { limit: 100 });
  }

  serviceAccounts(): Promise<unknown> {
    return this.get('/service-accounts');
  }
}
