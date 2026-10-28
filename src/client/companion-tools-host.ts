import './style.css';
import './companion-tools.css';
import { isAllowedToolRequest, isExternalUrl, isToolId, parseNativeToTools, TOOL_JSON_MAX, TOOL_UPLOAD_MAX, type NativeToTools, type ToolArgs, type ToolsToNative } from '../shared/companion-tools';
import type { ClientMsg, ServerMsg } from '../shared/protocol';
import { createCompanionTools } from './companion-tools';
import { Net, type NetTransport } from './net';
import { setOfficeHttp } from './office-http';
import { store } from './state';
import { h, toast } from './ui/dom';
import { randomLook } from '../shared/avatar';

// The Android app's Management view: one shared management tool at a time, in a WebView that loads
// this page from the APK (tools/android-companion-tools.mjs builds it). The page has no address or
// credential: native owns the socket and the device token, forwards allowlisted HTTP
// (isAllowedToolRequest) and serves the passthrough paths (pictures, fonts, card frames) itself.
// Page → native goes through the origin-restricted `DroidOfficeTools` WebMessageListener; native → page
// arrives on that object's onmessage, or through `droidOfficeTools.receive(obj)`.

interface NativePort {
  postMessage(data: string): void;
  onmessage?: ((event: { data: unknown }) => void) | null;
}

declare global {
  interface Window {
    DroidOfficeTools?: NativePort;
    droidOfficeTools?: { receive(value: unknown): void };
  }
}

const port = window.DroidOfficeTools;
const post = (msg: ToolsToNative) => port?.postMessage(JSON.stringify(msg));

// ---- The socket, through native ---------------------------------------------------------------------

let up = false;
const messageFns = new Set<(msg: ServerMsg) => void>();
const statusFns = new Set<(up: boolean) => void>();
const setUp = (next: boolean) => {
  if (next === up) return;
  up = next;
  for (const fn of statusFns) fn(up);
};
const transport: NetTransport = {
  connect: () => post({ t: 'connect' }),
  close: () => {},
  send(msg: ClientMsg) {
    // The connection belongs to the app's workspace too: this page never moves it to another floor.
    if (!up || msg.t === 'floor.go') return false;
    post({ t: 'send', msg });
    return true;
  },
  onMessage(fn) {
    messageFns.add(fn);
    return () => messageFns.delete(fn);
  },
  onStatus(fn) {
    statusFns.add(fn);
    return () => statusFns.delete(fn);
  },
};

const profile = { name: 'Owner', color: '#161616', look: randomLook() };
const net = new Net(
  () => profile,
  () => null,
  { transport },
);

// ---- HTTP, through native ---------------------------------------------------------------------------

let httpSeq = 0;
const waiting = new Map<number, { resolve(r: Response): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();

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

async function bridgeFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const q = path.indexOf('?');
  const bare = q < 0 ? path : path.slice(0, q);
  const query = q < 0 ? undefined : path.slice(q + 1);
  if (!isAllowedToolRequest(method, bare)) return Promise.reject(new TypeError(`${method} ${bare} is only available on the office’s own computer.`));
  if (!port) return Promise.reject(new TypeError('This page only works inside Droid Office for Android.'));
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
  const id = ++httpSeq;
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new TypeError('The office did not answer in time.'));
    }, 60_000);
    waiting.set(id, { resolve, reject, timer });
    init.signal?.addEventListener('abort', () => {
      if (!waiting.delete(id)) return;
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    });
    post({ t: 'http', id, method, path: bare, ...(query ? { query } : {}), ...(headers.get('content-type') ? { contentType: headers.get('content-type')! } : {}), ...(body !== undefined ? { body, base64 } : {}) });
  });
}

function httpResult(m: Extract<NativeToTools, { t: 'http.result' }>) {
  const w = waiting.get(m.id);
  if (!w) return;
  waiting.delete(m.id);
  clearTimeout(w.timer);
  if (m.error) return w.reject(new TypeError(m.error));
  const bytes = m.body === undefined ? null : m.base64 ? fromBase64(m.body) : m.body;
  w.resolve(new Response(m.status === 204 || m.status === 304 ? null : bytes, { status: m.status, headers: m.contentType ? { 'content-type': m.contentType } : {} }));
}

// Pictures, fonts and card frames load from this page's own origin; native serves those paths.
setOfficeHttp({ fetch: bridgeFetch, url: (path) => path });

// ---- Links out ---------------------------------------------------------------------------------------

const external = (url: string) => {
  if (isExternalUrl(url)) post({ t: 'external', url });
  else toast('That link can only be opened on the office’s own computer.', 'warn');
};
window.open = ((url?: string | URL) => {
  if (url) external(String(url));
  return null;
}) as typeof window.open;
document.addEventListener(
  'click',
  (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!(a instanceof HTMLAnchorElement)) return;
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#')) return;
    // Downloads of the office's own files (a wiki export) stay with native's passthrough.
    if (href.startsWith('/') && !href.startsWith('//')) return;
    e.preventDefault();
    external(a.href);
  },
  true,
);

// ---- The tool --------------------------------------------------------------------------------------

const mount = document.getElementById('tools')!;
const notice = h('div.cth-notice', { role: 'status' });
let want: { tool: string; floor: string; args: ToolArgs } | null = null;
let wasOpen = false;

const tools = createCompanionTools({
  net,
  mount,
  switchFloor: (floor) => post({ t: 'switch-floor', floor }),
  openWorker: (workerId, view) => post({ t: 'open-worker', workerId, view }),
  openExternal: external,
  onChange: () => queueMicrotask(paint),
});

/** Opens what native asked for, once the shared connection is on that floor. */
function tryOpen() {
  if (!want || !net.ready) return paint();
  if (!isToolId(want.tool)) {
    const name = want.tool;
    want = null;
    return paint(`There is no tool called “${name}”.`);
  }
  if (net.floor !== want.floor) return paint('Waiting for the office to arrive on this floor…');
  const { tool, args } = want;
  want = null;
  const r = tools.open(tool, args);
  paint(r.ok ? undefined : r.reason);
}

function paint(reason?: string) {
  const open = !!tools.current();
  if (wasOpen && !open && !want) post({ t: 'closed' });
  wasOpen = open;
  if (open) return notice.remove();
  notice.textContent = reason ?? (!up ? 'Not connected to the office.' : !net.ready ? 'Connecting to the office…' : want ? 'Opening…' : 'Nothing open.');
  if (!notice.isConnected) mount.append(notice);
}

net.onMessage((msg) => {
  store.apply(msg);
  tools.route(msg);
  if (msg.t === 'toast') toast(msg.text, msg.level);
});
net.onStatus((next) => {
  store.whiteboard.status(next);
  paint();
});
net.onReady((ready) => {
  // The page joined a connection that already had its Whiteboard: ask for this page's own snapshot.
  if (ready && net.floor) net.send({ t: 'whiteboard.sync', floor: net.floor });
  if (ready) tryOpen();
  else paint();
});

function receive(value: unknown) {
  const m = parseNativeToTools(value);
  if (!m) return;
  switch (m.t) {
    case 'bootstrap':
      setUp(false);
      setUp(m.up);
      if (m.open) want = { tool: m.open.tool, floor: m.open.floor, args: m.open.args ?? {} };
      if (m.up) for (const msg of m.messages) for (const fn of messageFns) fn(msg);
      tryOpen();
      break;
    case 'status':
      setUp(m.up);
      break;
    case 'server':
      if (up) for (const fn of messageFns) fn(m.msg);
      break;
    case 'open':
      want = { tool: m.tool, floor: m.floor, args: m.args ?? {} };
      tryOpen();
      break;
    case 'close':
      want = null;
      wasOpen = false;
      tools.close();
      paint();
      break;
    case 'http.result':
      httpResult(m);
      break;
  }
}

if (port) port.onmessage = (event) => receive(event.data);
window.droidOfficeTools = { receive };
paint();
void net.connect();
