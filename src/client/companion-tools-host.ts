import './style.css';
import './companion-tools.css';
import { isExternalUrl, isToolId, parseNativeToTools, type ToolArgs, type ToolsToNative } from '../shared/companion-tools';
import type { ClientMsg, ServerMsg } from '../shared/protocol';
import { createCompanionTools } from './companion-tools';
import { createBridgeHttp, linkAction } from './companion-tools-bridge';
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
  http.setUp(up);
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

const http = createBridgeHttp(port ? (m) => post(m) : null);
// Pictures, fonts and card frames load from this page's own origin; native serves those paths.
setOfficeHttp({ fetch: http.fetch, url: (path) => path });

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
    const act = linkAction(a.getAttribute('href') ?? '', a.href, location.origin, a.hasAttribute('download'));
    if (act.do === 'stay') return;
    e.preventDefault();
    if (act.do === 'external') external(act.url);
  },
  true,
);

// ---- The tool --------------------------------------------------------------------------------------

const mount = document.getElementById('tools')!;
const notice = h('div.cth-notice', { role: 'status' });
let want: { tool: string; floor: string; args: ToolArgs } | null = null;

const tools = createCompanionTools({
  net,
  mount,
  switchFloor: (floor) => post({ t: 'switch-floor', floor }),
  openWorker: (workerId, view) => post({ t: 'open-worker', workerId, view }),
  openExternal: external,
  onChange: () => queueMicrotask(paint),
  // Only the tool's own ✕ or its finishing: a close for a lost connection or a floor change opens
  // again by itself once the office is ready.
  onClosed: () => post({ t: 'closed' }),
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
  if (tools.current()) return notice.remove();
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
      tools.close();
      paint();
      break;
    case 'http.result':
      http.result(m);
      break;
  }
}

if (port) port.onmessage = (event) => receive(event.data);
window.droidOfficeTools = { receive };
paint();
void net.connect();
