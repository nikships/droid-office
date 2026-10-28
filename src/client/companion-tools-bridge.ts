import { isAllowedToolRequest, TOOL_JSON_MAX, TOOL_UPLOAD_MAX, type NativeToTools, type ToolsToNative } from '../shared/companion-tools';

// The Android Management page's HTTP and links, through the app (companion-tools-host.ts). No DOM
// beyond fetch's own types, so tests load it in Node.

type HttpRequest = Extract<ToolsToNative, { t: 'http' }>;
type HttpResult = Extract<NativeToTools, { t: 'http.result' }>;

export interface BridgeHttp {
  /** officeFetch over the app: allowlisted, sized, never sent on a connection that is down or changed. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** An `http.result` from the app. */
  result(m: HttpResult): void;
  /** The app's socket went up or down; down fails every request in flight. */
  setUp(up: boolean): void;
}

/** Statuses whose responses have no body, which `new Response` refuses one for. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function createBridgeHttp(post: ((m: HttpRequest) => void) | null, timeoutMs = 60_000): BridgeHttp {
  let up = false;
  /** Bumped whenever the socket goes down: a request started before it never sends or delivers after it. */
  let connection = 0;
  let seq = 0;
  const waiting = new Map<number, { resolve(r: Response): void; reject(e: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  const aborted = () => new DOMException('Aborted', 'AbortError');

  async function fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const q = path.indexOf('?');
    const bare = q < 0 ? path : path.slice(0, q);
    const query = q < 0 ? undefined : path.slice(q + 1);
    if (!isAllowedToolRequest(method, bare)) throw new TypeError(`${method} ${bare} is only available on the office’s own computer.`);
    if (!post) throw new TypeError('This page only works inside Droid Office for Android.');
    const signal = init.signal;
    // The window that asked belongs to the page state of this connection: nothing goes out for it later.
    const conn = connection;
    const stale = () => (signal?.aborted ? aborted() : !up || conn !== connection ? new TypeError('Not connected to the office.') : undefined);
    const early = stale();
    if (early) throw early;
    const headers = new Headers(init.headers);
    let body: string | undefined;
    let base64 = false;
    const raw = init.body;
    if (typeof raw === 'string') {
      if (raw.length > TOOL_JSON_MAX) throw new TypeError('That is too much to send at once.');
      body = raw;
    } else if (raw instanceof Blob) {
      if (raw.size > TOOL_UPLOAD_MAX) throw new TypeError('That file is too large to send from here (25 MB at most).');
      body = toBase64(new Uint8Array(await raw.arrayBuffer()));
      base64 = true;
      if (!headers.has('content-type') && raw.type) headers.set('content-type', raw.type);
    } else if (raw != null) throw new TypeError('This kind of request body cannot be sent from here.');
    const late = stale();
    if (late) throw late;
    const id = ++seq;
    const contentType = headers.get('content-type');
    const send = post;
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new TypeError('The office did not answer in time.'));
      }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      signal?.addEventListener('abort', () => {
        const w = waiting.get(id);
        if (!w) return;
        waiting.delete(id);
        clearTimeout(w.timer);
        reject(aborted());
      });
      send({ t: 'http', id, method, path: bare, ...(query ? { query } : {}), ...(contentType ? { contentType } : {}), ...(body !== undefined ? { body, base64 } : {}) });
    });
  }

  function result(m: HttpResult) {
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    clearTimeout(w.timer);
    if (m.error) return w.reject(new TypeError(m.error));
    try {
      const bytes = NULL_BODY.has(m.status) || m.body === undefined ? null : m.base64 ? fromBase64(m.body) : m.body;
      w.resolve(new Response(bytes, { status: m.status, headers: m.contentType ? { 'content-type': m.contentType } : {} }));
    } catch (e) {
      w.reject(new TypeError(`The office sent an answer this page cannot read (${e instanceof Error ? e.message : String(e)}).`));
    }
  }

  function setUp(next: boolean) {
    if (next === up) return;
    up = next;
    if (up) return;
    connection++;
    for (const [id, w] of [...waiting]) {
      waiting.delete(id);
      clearTimeout(w.timer);
      w.reject(new TypeError('The connection to the office was lost before it answered.'));
    }
  }

  return { fetch, result, setUp };
}

/**
 * What a click on a link in the page does, judged by the URL the browser resolved (it reads `/\host`
 * as `//host`), never the attribute text: `stay` lets an in-page anchor or a download of the office's
 * own file proceed, `block` stops it, `external` hands an https URL to the app.
 */
export function linkAction(rawHref: string, resolved: string, pageOrigin: string, download: boolean): { do: 'stay' } | { do: 'block' } | { do: 'external'; url: string } {
  if (rawHref.startsWith('#')) return { do: 'stay' };
  let target: URL;
  try {
    target = new URL(resolved);
  } catch {
    return { do: 'block' };
  }
  // The page itself never navigates; a download of the office's own file goes through the app's passthrough.
  if (target.origin === pageOrigin) return download ? { do: 'stay' } : { do: 'block' };
  return { do: 'external', url: target.href };
}
