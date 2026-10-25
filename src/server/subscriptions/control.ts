import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The client of DroidProxy's control API (version 1, docs/subscriptions.md): the office is its only
 * caller. The token comes from ~/.droidproxy/control.json, which DroidProxy rewrites at every launch,
 * so it is read before each call and again after a 401. It never leaves this module: not in a
 * message, a log line or an error.
 */

/** DroidProxy's default port, used when control.json doesn't say (an older DroidProxy writes none). */
export const DROIDPROXY_PORT = 8317;
const STATUS_TIMEOUT_MS = 5000;
const ACTION_TIMEOUT_MS = 15_000;

export interface ControlFile {
  api: number;
  port: number;
  token: string;
  version?: string;
  pid?: number;
}

/** Connecting, as /status and POST /connect give it. */
export interface RawConnecting {
  started_at?: string | null;
  user_code?: string | null;
  verification_uri?: string | null;
  error?: string | null;
}

export interface RawAccount {
  id: string;
  label?: string;
  expired?: boolean;
  disabled?: boolean;
}

export interface RawProvider {
  key: string;
  name?: string;
  enabled?: boolean;
  connect?: string;
  accounts?: RawAccount[];
  connecting?: RawConnecting | null;
}

export interface RawStatus {
  api?: number;
  version?: string;
  backend?: { running?: boolean };
  providers?: RawProvider[];
  factory?: { installed?: number; available?: number; stale?: boolean };
}

export type RawAvailability = { state: 'ok' } | { state: 'exhausted'; until?: string | null; window?: string; account?: string | null } | { state: 'signed-out' } | { state: 'disabled' } | { state: 'unknown' };

export interface RawModel {
  id: string;
  name?: string;
  provider?: string;
  availability?: RawAvailability;
}

export interface RawModels {
  generated_at?: string;
  models?: RawModel[];
}

/** GET /droidproxy/usage, which every DroidProxy that has it serves without a token. */
export interface RawUsage {
  generated_at?: string;
  accounts?: {
    id?: string;
    account?: string | null;
    provider?: string;
    as_of?: string;
    error?: string | null;
    windows?: { name?: string; used_percent?: number; remaining_percent?: number; resets_at?: string | null; resets_in_seconds?: number | null }[];
  }[];
}

/**
 * Why a call failed.
 * - no-file: there is no control.json (DroidProxy never ran, or is too old to write one)
 * - refused: nothing answers on its port: it isn't running
 * - timeout: it didn't answer in time
 * - unauthorized: it turned the token down, even after reading control.json again
 * - no-api: it answered, but has no control API (404): it is too old
 * - http: any other answer that isn't 2xx
 * - bad: an answer that isn't the JSON it should be
 */
export type ControlErrorKind = 'no-file' | 'refused' | 'timeout' | 'unauthorized' | 'no-api' | 'http' | 'bad';

export class ControlError extends Error {
  constructor(
    readonly kind: ControlErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ControlError';
  }
}

export interface ControlOptions {
  /** The home folder whose .droidproxy/control.json to read. */
  home: string;
  fetchImpl?: typeof fetch;
}

export interface ControlClient {
  /** control.json as it is now; undefined when there is none or it can't be read. */
  file(): Promise<ControlFile | undefined>;
  status(): Promise<RawStatus>;
  models(): Promise<RawModels>;
  /** The account windows (/droidproxy/usage), from any DroidProxy that serves them. */
  usage(): Promise<RawUsage>;
  connect(provider: string): Promise<{ connecting?: RawConnecting }>;
  cancelConnect(provider: string): Promise<void>;
  removeAccount(provider: string, account: string): Promise<RawStatus>;
  setProvider(provider: string, enabled: boolean): Promise<RawStatus>;
  factoryModels(): Promise<{ installed?: number; backup?: string | null }>;
  open(): Promise<void>;
}

/** Strips `secret` from text that may have come from elsewhere (an error body, an exception). */
function scrub(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join('…') : text;
}

function isControlFile(v: unknown): v is ControlFile {
  const o = v as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && typeof o.token === 'string' && o.token.length > 0 && typeof o.port === 'number' && Number.isInteger(o.port) && o.port > 0 && o.port < 65536;
}

/** Turns what fetch threw into words, and the kind of failure. */
function networkError(err: unknown, timeoutMs: number, token: string | undefined): ControlError {
  const e = err as { name?: string; code?: string; cause?: { code?: string }; message?: string };
  const code = e?.cause?.code ?? e?.code;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return new ControlError('timeout', `DroidProxy didn't answer in ${timeoutMs / 1000} s`);
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') return new ControlError('refused', "DroidProxy isn't running");
  return new ControlError('refused', `Couldn't reach DroidProxy (${scrub(String(code ?? e?.message ?? err), token)})`);
}

export function controlClient(opts: ControlOptions): ControlClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const file = path.join(opts.home, '.droidproxy', 'control.json');

  const readFileJson = async (): Promise<ControlFile | undefined> => {
    try {
      const v = JSON.parse(await readFile(file, 'utf8')) as unknown;
      return isControlFile(v) ? v : undefined;
    } catch {
      return undefined;
    }
  };

  const once = async (cf: ControlFile, method: 'GET' | 'POST', route: string, body: unknown, timeoutMs: number) => {
    let res: Response;
    try {
      res = await fetchImpl(`http://127.0.0.1:${cf.port}/droidproxy/control${route}`, {
        method,
        headers: { authorization: `Bearer ${cf.token}`, accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw networkError(err, timeoutMs, cf.token);
    }
    let text = '';
    try {
      text = await res.text();
    } catch (err) {
      throw networkError(err, timeoutMs, cf.token);
    }
    return { status: res.status, text };
  };

  const call = async <T>(method: 'GET' | 'POST', route: string, body?: unknown, timeoutMs = method === 'GET' ? STATUS_TIMEOUT_MS : ACTION_TIMEOUT_MS): Promise<T> => {
    let cf = await readFileJson();
    if (!cf) throw new ControlError('no-file', "DroidProxy hasn't written its control file: it isn't running, or it's too old for the office to drive");
    let res = await once(cf, method, route, body, timeoutMs);
    if (res.status === 401) {
      // DroidProxy relaunched since the file was read: it has a new token.
      const again = await readFileJson();
      if (again && again.token !== cf.token) {
        cf = again;
        res = await once(cf, method, route, body, timeoutMs);
      }
    }
    if (res.status === 401) throw new ControlError('unauthorized', "DroidProxy didn't accept the office's token: restart DroidProxy", 401);
    if (res.status === 404) throw new ControlError('no-api', 'This DroidProxy has no control API: update it', 404);
    let json: unknown;
    try {
      json = res.text ? JSON.parse(res.text) : {};
    } catch {
      throw new ControlError(res.status >= 200 && res.status < 300 ? 'bad' : 'http', `DroidProxy answered ${res.status} with something that isn't JSON`, res.status);
    }
    if (res.status < 200 || res.status >= 300) {
      const said = json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string' ? (json as { error: string }).error : '';
      throw new ControlError('http', said ? scrub(said, cf.token).slice(0, 300) : `DroidProxy answered ${res.status}`, res.status);
    }
    if (!json || typeof json !== 'object') throw new ControlError('bad', "DroidProxy's answer wasn't what the office expected", res.status);
    return json as T;
  };

  return {
    file: readFileJson,
    status: () => call<RawStatus>('GET', '/status'),
    models: () => call<RawModels>('GET', '/models'),
    async usage() {
      const port = (await readFileJson())?.port ?? DROIDPROXY_PORT;
      let res: Response;
      try {
        res = await fetchImpl(`http://127.0.0.1:${port}/droidproxy/usage`, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
      } catch (err) {
        throw networkError(err, STATUS_TIMEOUT_MS, undefined);
      }
      if (res.status === 404) throw new ControlError('no-api', 'This DroidProxy has no usage endpoint', 404);
      if (!res.ok) throw new ControlError('http', `DroidProxy answered ${res.status}`, res.status);
      try {
        const json = (await res.json()) as unknown;
        if (!json || typeof json !== 'object') throw new Error('not an object');
        return json as RawUsage;
      } catch {
        throw new ControlError('bad', "DroidProxy's usage wasn't JSON", res.status);
      }
    },
    connect: (provider) => call('POST', '/connect', { provider }),
    async cancelConnect(provider) {
      await call('POST', '/connect/cancel', { provider });
    },
    removeAccount: (provider, account) => call<RawStatus>('POST', '/accounts/remove', { provider, account }),
    setProvider: (provider, enabled) => call<RawStatus>('POST', '/providers', { provider, enabled }),
    factoryModels: () => call('POST', '/factory-models', {}),
    async open() {
      await call('POST', '/open', {});
    },
  };
}
