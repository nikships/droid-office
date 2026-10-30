import type { ClientMsg, WorkerInfo } from '../shared/protocol';
import { cardsNewestFirst, cardChanged, OWNER } from '../shared/whiteboard';
import { ROOF } from '../shared/rooftop';
import { DESK_BY_ID } from '../shared/layout';
import { originKind, type OriginKind } from '../shared/devices';
import { BROWSER_KEY, DASHBOARD_FLOOR_KEY, browserCredential, draftKey, forgetBrowserCredential, isBrowserCredential, saveBrowserCredential, type BrowserCredential } from './browser-session';
import { Net } from './net';
import { connectWhiteboard, store } from './state';
import { setBrowserAuth, withToken } from './token';
import { $, closeAllModals, h, modalOpen, openModal, toast } from './ui/dom';
import { windowHeader } from './ui/kit';
import { icon, type IconName } from './ui/icons';
import { confirmDialog, openPrompt, routeWorktreeMessage, sendHomeDialog } from './ui/prompt';
import { openFloorOrder } from './ui/floor-reorder';
import { openSubscriptionsStatus } from './ui/subscriptions-status';
import { onTermFontSize, setTermFontSize, stepTermFont, termFontSize, TERM_FONT_MAX, TERM_FONT_MIN } from './ui/term-font';
import { parseWorkerLink } from './worker-link';
import { DashboardWorkerLink } from './dashboard-worker-link';
import { adjacentFloor, WORKSPACE_KEY_HINTS, workspaceShortcut } from './dashboard-shortcuts';
import {
  assign,
  clampRatio,
  closeSlot,
  emptyWorkspace,
  fillPanes,
  FULL_RECT,
  focusedWorker,
  LAYOUT_DIVIDERS,
  LAYOUT_LABEL,
  LAYOUT_ORDER,
  type LayoutMode,
  openInSplit,
  openWorker,
  paneOf,
  parseWorkspace,
  prune,
  type Rect,
  rectsFor,
  releaseChangedPanes,
  seedWorkspace,
  serializeWorkspace,
  setLayout,
  SLOT_COUNT,
  swap,
  syncWorkspace,
  toggleMax,
  visibleSlots,
  workerView,
  type Workspace,
} from './dashboard-workspace';
import { createPane, type Pane, type PaneHost, VIEW_KEY } from './dashboard-pane';
import { createWorkerRoster } from './dashboard-roster';
import { workersByTeam } from '../shared/team';
const read = (key: string) => {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};
const remember = (key: string, value: string) => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* Drafts stay in this view if storage is blocked. */
  }
};
let credential = (() => {
  try {
    return browserCredential(localStorage);
  } catch {
    return undefined;
  }
})();
let bootstrap = new URLSearchParams(location.search).get('t') ?? '';
const workerLink = new DashboardWorkerLink(parseWorkerLink(location.hash));
const arrivedWithLink = !!bootstrap;
const nativeCompanion = /Macintosh/.test(navigator.userAgent) && /Electron\//.test(navigator.userAgent);
// Remove credentials before loading a card or navigating anywhere else.
if (location.search || workerLink.pending) history.replaceState(null, '', location.pathname);
const auth = () => setBrowserAuth(credential?.token ?? '', credential ? '' : bootstrap);
auth();

/** How this page reached the office, which decides what pairing means here. */
const where: OriginKind = originKind(location.hostname);
const WHERE: Record<OriginKind, { icon: IconName; label: string; line: string }> = {
  local: { icon: 'monitor', label: 'This computer', line: 'You are on the computer that runs the office. It always opens here: there is nothing to pair.' },
  lan: { icon: 'wifi', label: 'Wi-Fi', line: 'You reached the office over the local network (Wi-Fi or Ethernet). This works while this computer is on the same network as the office.' },
  tailscale: { icon: 'globe', label: 'Tailscale', line: 'You reached the office over Tailscale. This works from anywhere, while this computer is signed in to the same tailnet.' },
};

/** Why the office isn't showing: still connecting, unreachable, no access, unpaired, or turned off. */
type Gate = 'connecting' | 'unreachable' | 'access' | 'revoked' | 'off';
let gate: Gate = 'connecting';
let authorized = false;
let fresh = false;
let switching = false;
let floor = '';
let officeName = 'Droid Office';
let version = '';
/** A one-off line for the banner (the office updated, a floor went away). Dismissed with its ✕. */
let notice = '';
let pairing = false;
let persisted = true;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let terminal: typeof import('./ui/terminal') | undefined;
let whiteboard: typeof import('./ui/whiteboard') | undefined;
const busy = new Set<string>();

function defaultBrowserName() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  // Each address pairs on its own, so the network tells two pairings of one browser apart in the list.
  const name = os ? `${browser} on ${os}` : browser;
  return where === 'local' ? name : `${name} · ${WHERE[where].label}`;
}

// --- The page's frame -----------------------------------------------------------------------------

const live$ = h('span.dash-sr', { role: 'status', 'aria-live': 'polite' });
const title = h('h1.dash-office', {}, officeName);
const linkDot = h('span.dash-link', { role: 'img', 'aria-label': 'Connecting' });
const brand = h('div.dash-brand', {}, h('img', { src: '/factory-glyph.svg', alt: '', width: 18, height: 18 }), h('span.dash-brand-text', {}, h('span.eyebrow', {}, 'Web companion'), h('span.dash-brand-name', {}, title, linkDot)));
const floors = h('nav.dash-floor-strip', { 'aria-label': 'Floors' });
const reorderFloors = h('button.btn.icon.sm.ghost', { type: 'button', 'aria-label': 'Reorder floors', title: 'Reorder floors', onclick: () => openFloorOrder(net) }, '⠿');
const floorPicker = h('div.dash-floor', {}, floors, reorderFloors);
const boardCount = h('span.dash-count.hidden');
const board = h('button.btn.dash-top-btn.dash-board', { type: 'button', title: 'The floor’s Whiteboard (⌘ B)', onclick: () => void openBoard() }, icon('board', 14), h('span.dash-top-label', {}, 'Whiteboard'), boardCount);
const subscriptions = h('button.btn.ghost.dash-top-btn', { type: 'button', title: 'Subscriptions and account usage', onclick: () => openSubscriptionsStatus() }, icon('key', 14), h('span.dash-top-label', {}, 'Subscriptions'));
const top = h('header.dash-top', {}, brand, floorPicker, h('div.dash-top-end', {}, subscriptions, board));

const bannerIcon = h('span.dash-banner-icon');
const bannerText = h('p.dash-banner-text');
const bannerActions = h('div.dash-banner-actions');
const banner = h('div.dash-banner', { hidden: true }, bannerIcon, bannerText, bannerActions);

const authPanel = h('section.dash-gate', { hidden: true });

const sideTitle = h('h2.dash-side-title');
const sideSub = h('p.dash-side-sub');
const agentBtn = h('button.btn.accent.dash-hire', { type: 'button', title: 'Hire a Droid on this floor (⌘ N)', onclick: () => hire('agent') }, icon('plus', 14), h('span', {}, 'Hire Droid'));
const shellBtn = h('button.btn.dash-hire', { type: 'button', title: 'Open a plain shell at a desk', onclick: () => hire('shell') }, icon('terminal', 14), h('span', {}, 'Shell'));
const workerList = h('nav.dash-workers', { 'aria-label': 'Workers' });
const roster = createWorkerRoster(workerList, (id) => openHere(id, true), openBesideHere);
const side = h(
  'aside.dash-side',
  { 'aria-label': 'Floor' },
  h('div.dash-side-head', {}, sideTitle, sideSub),
  workerList,
  h('footer.dash-side-foot', {}, h('div.dash-side-hire', {}, agentBtn, shellBtn), h('div.dash-keys', { 'aria-hidden': 'true' }, ...keyHints(nativeCompanion ? [...WORKSPACE_KEY_HINTS, ['⌘ − +', 'floors']] : WORKSPACE_KEY_HINTS))),
);

/** The layout switcher's little pictures: the same boxes the layout puts its panes in. */
function layoutGlyph(mode: LayoutMode) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ width: '18', height: '14', viewBox: '0 0 18 14', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const rects = rectsFor(mode, 0.5, 0.5);
  const half = rects.length > 4 ? 0.5 : 0.75;
  rects.forEach(([x, y, w, hgt], i) => {
    const inset = (inner: boolean) => (inner ? half : 0);
    const rect = document.createElementNS(ns, 'rect');
    const box = {
      x: 1 + x * 16 + inset(x > 0.001),
      y: 1 + y * 12 + inset(y > 0.001),
      width: Math.max(1.5, w * 16 - inset(x > 0.001) - inset(x + w < 0.999)),
      height: Math.max(1.5, hgt * 12 - inset(y > 0.001) - inset(y + hgt < 0.999)),
      rx: 1.2,
    };
    for (const [k, v] of Object.entries(box)) rect.setAttribute(k, String(v));
    if (i === 0) rect.classList.add('lead');
    svg.append(rect);
  });
  return svg;
}

const sideToggle = h('button.btn.icon.sm.ghost', { type: 'button', onclick: () => toggleSide() }, icon('panel', 15));
const wsSummary = h('span.dash-crumb-text');
const layoutButtons = LAYOUT_ORDER.map((mode, i) =>
  h('button.dash-layout', { type: 'button', role: 'radio', 'aria-label': LAYOUT_LABEL[mode], title: `${LAYOUT_LABEL[mode]} (⌘ ${i + 1})`, onclick: () => changeLayout(mode) }, layoutGlyph(mode)),
);
const layouts = h('div.dash-layouts', { role: 'radiogroup', 'aria-label': 'Pane layout' }, ...layoutButtons);
const smaller = h('button.btn.sm', { type: 'button', 'aria-label': 'Smaller terminal text', title: 'Smaller terminal text', onclick: () => zoom(-1) }, 'A−');
const bigger = h('button.btn.sm', { type: 'button', 'aria-label': 'Bigger terminal text', title: 'Bigger terminal text', onclick: () => zoom(1) }, 'A+');
const zoomSeg = h('div.seg.dash-zoom', { role: 'group', 'aria-label': 'Terminal text size' }, smaller, bigger);
const toolbar = h(
  'div.dash-toolbar',
  {},
  sideToggle,
  h('div.dash-crumb', {}, h('span.eyebrow', {}, 'Workspace'), h('span.dash-crumb-sep', { 'aria-hidden': 'true' }, '/'), wsSummary),
  h('div.dash-toolbar-end', {}, zoomSeg, h('span.dash-toolbar-sep'), layouts),
);
const colHandle = h('div.dash-handle.col', { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize columns', tabindex: 0, title: 'Drag to resize · double-click to even out' });
const rowHandle = h('div.dash-handle.row', { role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize rows', tabindex: 0, title: 'Drag to resize · double-click to even out' });
const workspaceEl = h('div.dash-workspace', {}, colHandle, rowHandle);
const mainEl = h('main.dash-main', { id: 'worker-detail', tabindex: '-1', 'aria-label': 'Workspace' }, toolbar, workspaceEl);
const content = h('div.dash-body', { hidden: true }, side, mainEl);

$('dashboard').replaceChildren(h('a.dash-skip', { href: '#worker-detail' }, 'Skip to the work'), top, banner, authPanel, content, live$);

function keyHints(pairs: [string, string][]) {
  return pairs.map(([k, label]) => h('span', {}, h('span.key', {}, k), label));
}

const SIDE_KEY = 'droid-office.companion-sidebar';
let sideOpen = read(SIDE_KEY) ? read(SIDE_KEY) === 'open' : window.innerWidth >= 1024;
function toggleSide() {
  sideOpen = !sideOpen;
  remember(SIDE_KEY, sideOpen ? 'open' : 'closed');
  paint();
}

function paintZoom() {
  const px = termFontSize();
  smaller.disabled = px <= TERM_FONT_MIN;
  bigger.disabled = px >= TERM_FONT_MAX;
  zoomSeg.title = `Terminal text ${px} px`;
}
function zoom(dir: 1 | -1) {
  setTermFontSize(stepTermFont(termFontSize(), dir));
}
onTermFontSize(paintZoom);
paintZoom();

// --- The workspace: which workers are open in which panes, saved per floor ---------------------------

const WS_KEY = 'droid-office.companion-workspace';
let ws: Workspace = emptyWorkspace();
/** The floor `ws` belongs to. Until the floor's first snapshot arrives it is still the last floor's. */
let wsFloor = '';
const panes: (Pane | undefined)[] = [];
/** Whether a terminal that opens now takes the keyboard (not while the arrow keys walk the list). */
let takeFocus = true;
/** Names of the workers seen, to say who left after they're gone from the store. */
const names = new Map<string, string>();
/** Who was on the floor at the last paint, so a worker arriving from anywhere fills an empty pane. */
const onFloor = new Set<string>();
/** Sidebar order, used when loading or explicitly changing the layout. */
const staff = () => ordered().map((w) => w.id);

function loadWorkspace(f: string) {
  disposePanes();
  wsFloor = f;
  ws = parseWorkspace(read(`${WS_KEY}:${f}`)) ?? seedWorkspace(staff());
  prune(ws, (id) => store.workers.has(id));
  fillPanes(ws, staff());
  onFloor.clear();
  for (const id of staff()) onFloor.add(id);
}
function saveWorkspace() {
  if (wsFloor) remember(`${WS_KEY}:${wsFloor}`, serializeWorkspace(ws));
}
function changed() {
  saveWorkspace();
  paint();
}
function disposePanes() {
  for (const p of panes) p?.dispose();
  panes.length = 0;
}
function viewOf(id: string) {
  return workerView(ws, id, read(VIEW_KEY) === 'thread' ? 'thread' : 'terminal');
}
function changeLayout(mode: LayoutMode) {
  setLayout(ws, mode);
  fillPanes(ws, staff());
  changed();
}
function toggleMaxPane(i: number) {
  toggleMax(ws, i);
  changed();
}
/** Opens a worker in the workspace; `focusIt` puts the keyboard in it as well. */
function openHere(id: string, focusIt = false, targetPane?: number) {
  if (!store.workers.has(id)) return;
  roster.reveal(id);
  openWorker(ws, id, targetPane);
  takeFocus = focusIt;
  changed();
  takeFocus = true;
  if (focusIt) panes[ws.focused]?.focusContent();
  roster.scrollTo(id);
}
function openBesideHere(id: string) {
  if (!store.workers.has(id)) return;
  openInSplit(ws, id);
  fillPanes(ws, staff());
  changed();
}
async function loadTerminal() {
  if (!terminal) {
    terminal = await import('./ui/terminal');
    terminal.onOpenTeammate((mate) => openBesideHere(mate));
  }
  return terminal;
}
const paneHost: PaneHost = {
  get net() {
    return net;
  },
  live: () => live(),
  floor: () => floor,
  busy: (id) => busy.has(id),
  action: (msg, id, intendedFloor, done) => action(msg, id, intendedFloor, done),
  usable: (id, intendedFloor) => usable(id, intendedFloor),
  read,
  remember,
  terminal: loadTerminal,
  setView(id, view) {
    ws.views[id] = view;
    remember(VIEW_KEY, view);
    changed();
  },
  focus(i) {
    if (ws.focused === i) return;
    ws.focused = i;
    changed();
  },
  close(i) {
    closeSlot(ws, i);
    changed();
  },
  toggleMax: (i) => toggleMaxPane(i),
  assign(i, id) {
    if (!usable(id, floor)) return;
    assign(ws, i, id);
    changed();
  },
  swap(from, to) {
    if (!Number.isInteger(from) || from < 0 || from >= SLOT_COUNT[ws.layout]) return;
    swap(ws, from, to);
    changed();
  },
  openBeside: (id) => openBesideHere(id),
  sendHome: (w) => sendHome(w),
  hire: (index) => hire('agent', 'auto', index),
};

/** Where a pane sits: its box, less half the 8px gap on every side that touches another pane. */
function place(el: HTMLElement, [x, y, w, hgt]: Rect) {
  const half = (inner: boolean) => (inner ? '4px' : '0px');
  const vars: Record<string, string> = {
    '--x': String(x),
    '--y': String(y),
    '--w': String(w),
    '--h': String(hgt),
    '--gl': half(x > 0.001),
    '--gr': half(x + w < 0.999),
    '--gt': half(y > 0.001),
    '--gb': half(y + hgt < 0.999),
  };
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
}

let dragAxis: 'col' | 'row' | '' = '';
for (const [handle, axis] of [
  [colHandle, 'col'],
  [rowHandle, 'row'],
] as const) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    dragAxis = axis;
    workspaceEl.classList.add('resizing');
  });
  handle.addEventListener('pointermove', (e) => {
    if (dragAxis !== axis) return;
    const r = workspaceEl.getBoundingClientRect();
    ws[axis] = clampRatio(axis === 'col' ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height);
    paintWorkspace();
  });
  const end = () => {
    if (dragAxis !== axis) return;
    dragAxis = '';
    workspaceEl.classList.remove('resizing');
    saveWorkspace();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('lostpointercapture', end);
  handle.addEventListener('dblclick', () => {
    ws[axis] = 0.5;
    changed();
  });
  handle.addEventListener('keydown', (e) => {
    const step = e.key === (axis === 'col' ? 'ArrowLeft' : 'ArrowUp') ? -0.03 : e.key === (axis === 'col' ? 'ArrowRight' : 'ArrowDown') ? 0.03 : 0;
    if (!step) return;
    e.preventDefault();
    ws[axis] = clampRatio(ws[axis] + step);
    changed();
  });
}
// --- The connection --------------------------------------------------------------------------------

const net = new Net(
  () => ({ ...store.profile, name: 'Owner · browser' }),
  () => null,
  {
    client: 'dashboard',
    device: () => credential?.token ?? '',
    floor: () => (store.floor ?? read(DASHBOARD_FLOOR_KEY)) || null,
    authorize: async (signal) => {
      let response: Response;
      try {
        response = await fetch(withToken('/api/mobile/hello?client=dashboard'), { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
      } catch (error) {
        if (!signal.aborted && !authorized) {
          gate = 'unreachable';
          paint();
        }
        throw error;
      }
      if (response.status === 401 || response.status === 403) {
        heard = await refusal(response);
        return false;
      }
      if (!response.ok) throw new Error('Office unavailable');
      const hello = (await response.json()) as { office?: { name: string; version: string } };
      if (signal.aborted) throw new Error('Access check cancelled');
      officeName = hello.office?.name ?? 'Droid Office';
      const next = hello.office?.version ?? '';
      if (version && version !== next) notice = 'The office was updated. Reload this page if something looks out of place.';
      version = next;
      authorized = true;
      return true;
    },
    unauthorized: () => {
      authorized = false;
      fresh = false;
      bootstrap = '';
      auth();
      closeAllModals();
      const why = heard;
      heard = undefined;
      if (why) locked(why);
      // The socket was closed on us (unpaired, or the companion turned off): ask the office which.
      else
        void fetch(withToken('/api/mobile/hello?client=dashboard'), { cache: 'no-store', credentials: 'same-origin' })
          .then((res) => (res.ok ? net.connect() : refusal(res).then(locked)))
          .catch(() => locked('unreachable'));
    },
  },
);
/** Why the last access check was refused, for `unauthorized` to show. */
let heard: Gate | undefined;
async function refusal(response: Response): Promise<Gate> {
  const body = (await response.json().catch(() => ({}))) as { companionOff?: boolean };
  return body.companionOff ? 'off' : credential ? 'revoked' : 'access';
}
function locked(why: Gate) {
  gate = why;
  clearTimeout(retryTimer);
  // Turned off, or out of reach, can end by itself: check back now and then. Off is one cheap check-in
  // on a reachable office, so it's asked often enough that switching it back on feels immediate.
  if (gate === 'off' || gate === 'unreachable') retryTimer = setTimeout(() => void net.connect(), gate === 'off' ? 3_000 : 10_000);
  paint();
}
connectWhiteboard((msg) => net.send(msg));
net.onStatus((up) => {
  store.whiteboard.status(up);
  if (!up) {
    fresh = false;
    switching = false;
    workerLink.arrive();
  }
  paint();
});
net.onMessage((msg) => {
  const entering = msg.t === 'welcome' || msg.t === 'floor.enter';
  if (entering) {
    fresh = true;
    switching = false;
    workerLink.arrive();
    if (floor && floor !== msg.floor) closeAllModals();
    floor = msg.floor ?? '';
    remember(DASHBOARD_FLOOR_KEY, floor);
    if (msg.arrival?.removed) notice = 'The floor you were on was removed. This is the office’s current floor.';
  }
  store.apply(msg);
  terminal?.routeTerminalMessage(msg);
  whiteboard?.routeWhiteboardMessage(msg);
  routeWorktreeMessage(msg);
  if (entering) {
    if (wsFloor !== floor) loadWorkspace(floor);
    else for (const p of panes) p?.reattach();
    paint();
  }
  if (msg.t === 'toast') {
    toast(msg.text, msg.level);
    if (switching && msg.level !== 'info') {
      workerLink.clear();
      switching = false;
      notice = msg.text;
      paint();
    }
  }
  if (entering || msg.t === 'floors' || msg.t === 'worker.update') followWorkerLink();
});
for (const topic of ['floors', 'workers', 'whiteboard', 'project'] as const) store.on(topic, paint);
store.on('screens', () => {
  for (const p of panes) p?.paintQuestion();
  schedulePreviews();
});
function goFloor(id: string) {
  if (!live() || id === store.floor) return;
  closeAllModals();
  switching = true;
  if (!net.send({ t: 'floor.go', floor: id })) {
    switching = false;
    toast('Disconnected. Nothing was sent.', 'warn');
  }
  paint();
}
floors.addEventListener('keydown', (event) => {
  const buttons = [...floors.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const at = buttons.indexOf(event.target as HTMLButtonElement);
  if (at < 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const targets: Record<string, number> = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: buttons.length - 1 };
  const next = targets[event.key];
  if (next === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  buttons[(next + buttons.length) % buttons.length]?.focus();
});
floors.addEventListener(
  'wheel',
  (event) => {
    if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || floors.scrollWidth <= floors.clientWidth) return;
    const before = floors.scrollLeft;
    const unit = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? floors.clientWidth : 1;
    floors.scrollLeft += event.deltaY * unit;
    if (floors.scrollLeft !== before) event.preventDefault();
  },
  { passive: false },
);
if (typeof ResizeObserver === 'function') new ResizeObserver(() => floors.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })).observe(floors);

function live() {
  return authorized && net.up && fresh && !switching;
}
function followWorkerLink() {
  if (!live()) return;
  const result = workerLink.follow({ floor: store.floor, hasWorker: (id) => store.workers.has(id), hasFloor: (id) => store.floors.some((f) => f.id === id) }, (floor) => net.send({ t: 'floor.go', floor }));
  if (result.step === 'go') {
    switching = true;
    paint();
    return;
  }
  if (result.step === 'wait') return;
  if (result.step === 'failed') {
    switching = false;
    notice = 'Disconnected. The worker link was not opened. Open it again after reconnecting.';
    toast(notice, 'warn');
    paint();
    return;
  }
  if (result.step === 'gone') return toast('That worker or floor is no longer available.', 'warn');
  if (result.link.view === 'thread') ws.views[result.link.worker] = 'thread';
  openHere(result.link.worker, true);
}
window.addEventListener('hashchange', () => {
  const next = parseWorkerLink(location.hash);
  if (!next) return;
  workerLink.set(next);
  history.replaceState(null, '', location.pathname);
  followWorkerLink();
});
function usable(id: string, intendedFloor: string) {
  return live() && floor === intendedFloor && store.workers.has(id);
}
async function action(msg: ClientMsg, id = '', intendedFloor = floor, done?: string, targetPane?: number): Promise<string | undefined> {
  if (!live() || floor !== intendedFloor || (id && !store.workers.has(id))) return 'The connection, floor or worker changed. Nothing was sent.';
  const key = id || 'hire';
  if (busy.has(key)) return 'An action for this worker is still waiting for confirmation.';
  busy.add(key);
  paint();
  let hired = '';
  try {
    const result = await net.request(msg);
    if (!result.ok) return result.error ?? 'The office refused this action.';
    if (done) say(done);
    if (msg.t === 'worker.spawn' && result.workerId && floor === intendedFloor) hired = result.workerId;
  } finally {
    busy.delete(key);
    paint();
  }
  if (hired) openHere(hired, true, targetPane);
}
function say(text: string) {
  live$.textContent = text;
}

// --- Painting ----------------------------------------------------------------------------------------

/** Workers in the order the sidebar lists them, for the arrow keys. */
const ordered = () => workersByTeam(store.workers.values());

let floorListKey = '';
let shownFloor: string | null | undefined;
function paintFloors(up: boolean) {
  const key = JSON.stringify([store.floor === ROOF, store.floor, store.floors.map((f) => [f.id, f.name, f.repo, f.waiting])]);
  const changedList = key !== floorListKey;
  if (changedList) {
    const focused = document.activeElement instanceof HTMLElement && floors.contains(document.activeElement) ? document.activeElement.dataset.floor : undefined;
    floors.replaceChildren(
      ...(store.floor === ROOF ? [h('span.dash-floor-roof', {}, 'Rooftop')] : []),
      ...store.floors.map((f, i) =>
        h(
          'button.dash-floor-chip',
          {
            type: 'button',
            'data-floor': f.id,
            title: `${f.name} — ${f.repo ?? 'no git'}${f.waiting ? ` · ${f.waiting} waiting` : ''}`,
            onclick: () => goFloor(f.id),
          },
          h('span.dash-floor-number', { 'aria-hidden': 'true' }, String(i + 1)),
          h('span.dash-floor-name', { class: f.home ? undefined : 'mono' }, f.name),
          f.waiting && f.id !== store.floor ? h('span.dash-floor-attn', { role: 'img', 'aria-label': `${f.waiting} waiting` }) : null,
        ),
      ),
    );
    floorListKey = key;
    if (focused) [...floors.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.dataset.floor === focused)?.focus({ preventScroll: true });
  }
  for (const button of floors.querySelectorAll<HTMLButtonElement>('button')) {
    button.disabled = !up;
    button.classList.toggle('on', button.dataset.floor === store.floor);
    if (button.dataset.floor === store.floor) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (changedList || shownFloor !== store.floor) floors.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  shownFloor = store.floor;
}

function paint() {
  title.textContent = officeName;
  const up = live();
  const here = store.currentFloor();
  reorderFloors.disabled = !up || store.floors.length < 2;
  agentBtn.disabled = shellBtn.disabled = !up || !here || busy.has('hire');
  board.disabled = !up || !here;
  subscriptions.disabled = !up;
  const link = up ? 'Connected' : authorized && !net.up ? 'Disconnected' : 'Connecting';
  linkDot.dataset.state = up ? 'up' : authorized && !net.up ? 'down' : 'wait';
  linkDot.setAttribute('aria-label', link);
  linkDot.title = link;
  content.classList.toggle('dash-stale', !up);
  content.classList.toggle('side-closed', !sideOpen);
  content.hidden = !authorized;
  authPanel.hidden = authorized;
  floorPicker.hidden = !authorized;
  board.hidden = !authorized;
  paintBanner();
  if (!authorized) {
    disposePanes();
    return paintGate();
  }
  paintFloors(up);
  const b = store.floor && store.whiteboard.board(store.floor);
  const unread = b ? cardsNewestFirst(b).filter((c) => cardChanged(b, OWNER, c.id)).length : 0;
  boardCount.textContent = String(unread);
  boardCount.classList.toggle('hidden', !unread);
  board.setAttribute('aria-label', unread ? `Whiteboard, ${unread} unread` : 'Whiteboard');
  const needs = [...store.workers.values()].filter((w) => w.status === 'needs_input').length;
  document.title = `${needs ? `(${needs}) ` : ''}${officeName} · Web companion`;
  if (fresh && wsFloor === floor) {
    const { gone, filled } = syncWorkspace(ws, staff(), onFloor);
    for (const id of gone) toast(`${names.get(id) ?? 'A worker'} has left the floor.`, 'info');
    if (gone.length || filled) saveWorkspace();
  }
  for (const w of store.workers.values()) names.set(w.id, w.name);
  paintSide();
  paintWorkspace();
}

function paintBanner() {
  let tone = '';
  let text = '';
  let glyph: IconName = 'alert';
  const actions: HTMLElement[] = [];
  if (authorized && !net.up) {
    tone = 'warn';
    text = navigator.onLine ? 'Disconnected from the office. What you see may be out of date, and nothing you type is queued. Reconnecting…' : 'This computer is offline. Worker actions and terminal input are off; nothing will be replayed.';
    actions.push(h('button.btn.sm', { type: 'button', onclick: () => void net.connect() }, icon('refresh', 14), 'Reconnect'));
  } else if (switching) {
    tone = 'info';
    glyph = 'refresh';
    text = 'Loading the floor…';
  } else if (notice) {
    tone = 'info';
    text = notice;
    actions.push(
      h(
        'button.btn.ghost.sm',
        {
          type: 'button',
          'aria-label': 'Dismiss',
          onclick: () => {
            notice = '';
            paint();
          },
        },
        '✕',
      ),
    );
  } else if (authorized && !credential && where !== 'local') {
    tone = 'accent';
    glyph = 'key';
    text = 'This browser is using the office’s link for this start. Pair it to keep access after the office restarts.';
    actions.push(h('button.btn.accent.sm', { type: 'button', onclick: () => accessDialog() }, 'Pair this browser'));
  }
  banner.hidden = !text;
  banner.dataset.tone = tone;
  bannerIcon.replaceChildren(icon(glyph, 16));
  bannerText.textContent = text;
  bannerActions.replaceChildren(...actions);
}

function paintGate() {
  const steps = (
    where === 'local'
      ? []
      : [
          h('span', {}, 'On the office’s computer, open ', h('b', {}, '⚙️ Settings → Phone & web → Web companion'), '.'),
          h('span', {}, 'Click ', h('b', {}, 'Copy pairing link'), ' beside Wi-Fi or Tailscale, then paste the complete link into this browser.'),
          h('span', {}, 'Choose ', h('b', {}, 'Pair this browser'), ' before refreshing, then bookmark the page.'),
        ]
  ).map((s, i) => h('li', {}, h('span.dash-step-no', {}, String(i + 1)), s));
  const whereChip = h('p.dash-where-chip', {}, icon(WHERE[where].icon, 14), h('span', {}, `${WHERE[where].label} · ${location.host}`));
  const forget = h('button.btn', { type: 'button', onclick: () => forgetHere('Saved access forgotten. Open a fresh link from the office to pair again.') }, 'Forget saved access');
  const retry = h(
    'button.btn.primary',
    {
      type: 'button',
      onclick: () => {
        gate = 'connecting';
        paint();
        void net.connect();
      },
    },
    icon('refresh', 14),
    'Try again',
  );
  const views: Record<Gate, () => HTMLElement[]> = {
    connecting: () => [h('div.spinner'), h('h2', {}, 'Connecting to the office…')],
    unreachable: () => [
      h('div.dash-gate-icon.warn', {}, icon('alert', 28)),
      h('h2', {}, 'Can’t reach the office'),
      h('p', {}, 'Retrying by itself. Check that:'),
      h(
        'ul.dash-checks',
        {},
        h('li', {}, icon('check', 14), 'The office’s computer is awake, with Droid Office running.'),
        where === 'tailscale'
          ? h('li', {}, icon('check', 14), 'Tailscale is connected on both computers, on the same tailnet.')
          : where === 'lan'
            ? h('li', {}, icon('check', 14), 'This computer is on the same network as the office.')
            : null,
      ),
      retry,
    ],
    access: () => [
      h('div.dash-gate-icon', {}, icon('lock', 28)),
      h('h2', {}, where === 'local' ? 'The office didn’t let this page in' : 'Open a pairing link to connect'),
      h(
        'p',
        {},
        arrivedWithLink
          ? 'That link is from an earlier start of the office, so it no longer opens it. Links change every time the office starts; a paired browser doesn’t need one.'
          : where === 'local'
            ? 'Try connecting again.'
            : 'You reached the office, but this browser has no access key. Typing the address alone won’t connect it or send an approval request to the office’s computer.',
      ),
      steps.length ? h('ol.dash-steps', {}, ...steps) : retry,
    ],
    revoked: () => [
      h('div.dash-gate-icon.warn', {}, icon('key', 28)),
      h('h2', {}, 'This browser isn’t paired any more'),
      h('p', {}, 'It was unpaired on the office, or its pairing expired. Forget the saved access here, then pair again with a fresh link.'),
      h('div.row.dash-gate-actions', {}, forget),
      h('ol.dash-steps', {}, ...steps),
    ],
    off: () => [
      h('div.dash-gate-icon', {}, icon('power', 28)),
      h('h2', {}, 'The web companion is off'),
      h('p', {}, 'It’s turned off on the office’s computer, in ', h('b', {}, '⚙️ Settings → Phone & web → Web companion'), '. Paired browsers stay paired, and this page opens by itself once it’s back on.'),
      h('div.row.dash-gate-actions', {}, retry),
    ],
  };
  authPanel.dataset.gate = gate;
  authPanel.replaceChildren(h('div.dash-gate-card', {}, ...views[gate](), whereChip));
}

function paintSide() {
  const here = store.currentFloor();
  sideTitle.textContent = store.floor === ROOF ? 'Rooftop' : (here?.name ?? 'No floor');
  sideTitle.title = sideTitle.textContent;
  const where = here ? [here.repo ?? 'Not a git repository', here.branch].filter(Boolean).join(' · ') : store.floors.length ? 'Choose a floor above.' : 'No floors yet. Add a project from the office itself.';
  sideSub.replaceChildren(icon('branch', 12), h('span', { title: where }, where));
  roster.update({ floor, workers: [...store.workers.values()], focused: focusedWorker(ws) ?? '', live: live(), pane: (id) => paneOf(ws, id) });
}

function paintWorkspace() {
  if (wsFloor !== floor) return;
  const count = SLOT_COUNT[ws.layout];
  const rects = rectsFor(ws.layout, ws.col, ws.row);
  const shown = visibleSlots(ws);
  const candidates = ordered().filter((w) => !shown.includes(w.id));
  // Attachments belong to the connection, not to a pane. Release every moved worker before any
  // replacement attaches it, or disposing its old Thread can detach the new one during a swap.
  releaseChangedPanes(panes, shown);
  for (let i = 0; i < count; i++) {
    const p = panes[i] ?? createPane(paneHost, i);
    panes[i] = p;
    if (p.el.parentElement !== workspaceEl) workspaceEl.insertBefore(p.el, colHandle);
    const max = ws.maximized === i;
    place(p.el, max ? FULL_RECT : (rects[i] ?? FULL_RECT));
    const id = ws.slots[i];
    const w = id ? store.workers.get(id) : undefined;
    p.update({
      worker: w,
      view: w ? viewOf(w.id) : 'terminal',
      focused: ws.focused === i,
      maximized: max,
      canMaximize: count > 1,
      covered: ws.maximized !== null && !max,
      candidates,
      anyone: store.workers.size > 0,
      takeFocus: takeFocus && ws.focused === i,
    });
  }
  workspaceEl.dataset.layout = ws.layout;
  const handles = ws.maximized === null;
  const dividers = LAYOUT_DIVIDERS[ws.layout];
  colHandle.hidden = !handles || !dividers.col;
  rowHandle.hidden = !handles || !dividers.row;
  colHandle.style.setProperty('--at', String(ws.col));
  rowHandle.style.setProperty('--at', String(ws.row));
  rowHandle.style.setProperty('--from', ws.layout === 'triple' ? String(ws.col) : '0');
  rowHandle.style.setProperty('--from-gap', ws.layout === 'triple' ? '4px' : '0px');
  colHandle.setAttribute('aria-valuenow', String(Math.round(ws.col * 100)));
  rowHandle.setAttribute('aria-valuenow', String(Math.round(ws.row * 100)));
  const open = shown.filter(Boolean).length;
  const fw = store.workers.get(focusedWorker(ws) ?? '');
  wsSummary.replaceChildren(`${open} of ${count} open`, ...(fw ? [h('span.dash-crumb-sep', {}, ' · '), 'focused on ', h('b', {}, fw.name)] : []));
  layoutButtons.forEach((b, i) => {
    b.setAttribute('aria-checked', String(LAYOUT_ORDER[i] === ws.layout));
  });
  sideToggle.setAttribute('aria-label', sideOpen ? 'Hide floor' : 'Show floor');
  sideToggle.setAttribute('aria-pressed', String(!sideOpen));
  sideToggle.title = `${sideOpen ? 'Hide floor' : 'Show floor'} (⌘ \\)`;
}

let previewFrame = 0;
let previewAt = 0;
function schedulePreviews() {
  if (previewFrame || !panes.some((p) => p?.mode() === 'info')) return;
  // Screens stream a few times a second per worker; a quarter second is plenty for a glance.
  const wait = Math.max(0, 250 - (performance.now() - previewAt));
  previewFrame = window.setTimeout(() => {
    previewFrame = 0;
    previewAt = performance.now();
    for (const p of panes) p?.paintPreview();
  }, wait);
}
// --- Actions ------------------------------------------------------------------------------------------

function hire(kind: 'agent' | 'shell', deskId = 'auto', targetPane?: number) {
  if (!live() || !store.currentFloor()) return;
  const intended = floor;
  const key = draftKey(intended, `hire:${kind}`);
  const desk = deskId === 'auto' ? undefined : DESK_BY_ID.get(deskId)?.label;
  openPrompt({
    title: kind === 'shell' ? 'Open a shell' : 'Hire Droid',
    subtitle: [store.currentFloor()?.name, desk].filter(Boolean).join(' · '),
    submitLabel: kind === 'shell' ? 'Open shell' : 'Hire Droid',
    allowEmpty: true,
    initial: read(key),
    onDraft: (v) => remember(key, v),
    modelOption: kind === 'agent',
    deskId: deskId === 'auto' ? undefined : deskId,
    imagesOption: kind === 'agent',
    recall: kind === 'agent',
    worktreeOption: !store.currentFloor()?.home && !store.currentFloor()?.plain && !!store.currentFloor()?.branch,
    onSubmit: async (text, opts) => {
      const error = await action({ t: 'worker.spawn', deskId, kind, prompt: text, ...opts }, '', intended, kind === 'shell' ? 'Shell opened.' : 'Droid hired.', targetPane);
      if (!error) remember(key, '');
      return error;
    },
  });
}
const warn = (error: string | undefined) => {
  if (error) toast(error, 'warn');
};
function sendHome(w: WorkerInfo) {
  const intended = floor;
  const confirm = (cleanup: 'keep' | 'worktree' | 'all' = 'keep') => void action({ t: 'worker.kill', workerId: w.id, cleanup, deleteSession: false }, w.id, intended, `${w.name} went home.`).then(warn);
  if (w.worktree && !w.cloud)
    sendHomeDialog({
      workerId: w.id,
      name: w.name,
      where: store.currentFloor()?.name ?? 'this floor',
      worktree: w.worktree,
      ask: () => {
        if (usable(w.id, intended)) net.send({ t: 'worker.worktree', workerId: w.id });
      },
      onConfirm: confirm,
    });
  else
    confirmDialog(
      `Send ${w.name} home?`,
      w.cloud ? 'This frees its desk. Its Factory session stays archived; a computer this worker made is deleted, as in the office.' : 'This stops its terminal for every window and frees its desk. Work in the checkout is kept.',
      'Send home',
      () => confirm(),
    );
}
async function openBoard() {
  const intended = floor;
  whiteboard ??= await import('./ui/whiteboard');
  if (live() && intended === floor && store.currentFloor()) whiteboard.openWhiteboard(net, { queueOffline: false });
}

// --- This browser's access ------------------------------------------------------------------------------

function forgetHere(text: string) {
  let removed = false;
  try {
    removed = forgetBrowserCredential(localStorage);
  } catch {
    /* blocked */
  }
  credential = undefined;
  bootstrap = '';
  auth();
  net.close();
  authorized = false;
  gate = 'access';
  closeAllModals();
  toast(removed ? text : 'Access closed, but this browser’s storage could not be cleared. Remove this site’s data before opening it again.', removed ? 'info' : 'warn');
  paint();
}

function accessDialog() {
  const info = WHERE[where];
  const note = h('p.note', { role: 'status', hidden: true });
  const fail = (text: string) => {
    note.hidden = false;
    note.className = 'note bad';
    note.textContent = text;
  };
  const whereCard = h('div.dash-where', { 'data-where': where }, h('span.dash-where-icon', {}, icon(info.icon, 20)), h('div.dash-where-text', {}, h('b', {}, info.label), h('code', {}, location.host), h('p', {}, info.line)));
  const footer = h('footer');
  const body = h('div.body.stack', {}, whereCard);
  const el = h('div.modal', { role: 'dialog', 'aria-label': 'Browser access' }, windowHeader('Browser access', officeName), body, footer);
  const modal = openModal(el);

  const deviceName = h('input.input', { value: defaultBrowserName(), maxlength: 64, 'aria-label': 'Name this browser' });
  const pair = h('button.btn.accent', { type: 'button', disabled: pairing }, icon('key', 14), 'Pair this browser');
  body.append(
    h(
      'p',
      {},
      'Pairing keeps this browser’s own access at ',
      h('code', {}, location.origin),
      ', so a bookmark opens the office after it restarts. It’s you, not a new account, and you can unpair it any time from the office’s Phone & web window.',
    ),
    h('div.field', {}, h('label', {}, 'Name'), deviceName, h('p.field-hint', {}, 'How the office lists it under Paired devices.')),
    h(
      'p.field-hint',
      {},
      `Each address pairs on its own: pairing ${location.host} doesn’t pair the office’s other addresses.${where === 'lan' ? ' Tailscale’s name works at home and away, so it’s the best one to bookmark on a laptop.' : ''}`,
    ),
    note,
  );
  footer.append(h('span.grow'), h('button.btn.ghost', { type: 'button', onclick: () => modal.close() }, 'Not now'), pair);
  const submit = () => {
    if (pairing || credential) return;
    pairing = true;
    pair.disabled = true;
    void (async () => {
      try {
        const res = await fetch(withToken('/api/mobile/pair'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: deviceName.value, kind: 'browser' }), signal: AbortSignal.timeout(8000) });
        let body: BrowserCredential & { error?: string };
        try {
          body = (await res.json()) as BrowserCredential & { error?: string };
        } catch {
          throw new Error('The browser could not be paired.');
        }
        if (!res.ok) throw new Error(body.error ?? 'The browser could not be paired.');
        if (!isBrowserCredential(body)) throw new Error('The browser could not be paired.');
        credential = body;
        try {
          persisted = saveBrowserCredential(localStorage, body);
        } catch {
          persisted = false;
        }
        bootstrap = '';
        auth();
        net.close();
        modal.close();
        toast(
          persisted ? 'Paired. Bookmark this page: it opens the office from now on.' : 'Paired for this page only: this browser blocks storage. Unpair it from the office’s Phone & web window so no unused pairing is left.',
          persisted ? 'info' : 'warn',
        );
        void net.connect();
        paint();
      } catch (error) {
        fail((error as Error).message);
      } finally {
        pairing = false;
        pair.disabled = !!credential;
      }
    })();
  };
  pair.addEventListener('click', submit);
  deviceName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  deviceName.select();
}

// --- Keys ------------------------------------------------------------------------------------------------

// Capture Command chords even inside terminals and composers. Other keys belong to their editor.
window.addEventListener(
  'keydown',
  (e) => {
    if (!live() || modalOpen()) return;
    workspaceShortcut(
      e,
      (command) => {
        switch (command.action) {
          case 'floor': {
            const next = adjacentFloor(store.floors, store.floor, command.direction);
            if (next) goFloor(next);
            break;
          }
          case 'layout':
            changeLayout(command.mode);
            panes[ws.focused]?.focusContent();
            break;
          case 'maximize':
            toggleMaxPane(ws.focused);
            panes[ws.focused]?.focusContent();
            break;
          case 'pane':
            ws.focused = (ws.focused + command.direction + SLOT_COUNT[ws.layout]) % SLOT_COUNT[ws.layout];
            if (ws.maximized !== null) ws.maximized = ws.focused;
            changed();
            panes[ws.focused]?.focusContent();
            break;
          case 'worker': {
            const list = ordered();
            const at = list.findIndex((w) => w.id === focusedWorker(ws));
            const next = at < 0 ? (command.direction > 0 ? 0 : list.length - 1) : (at + command.direction + list.length) % list.length;
            const w = list[next];
            if (w) openHere(w.id, true);
            break;
          }
          case 'hire':
            hire('agent', 'auto', ws.focused);
            break;
          case 'board':
            void openBoard();
            break;
          case 'sidebar':
            toggleSide();
            if (sideOpen) {
              roster.reveal(focusedWorker(ws) ?? '');
              (roster.button(focusedWorker(ws) ?? '') ?? agentBtn).focus({ preventScroll: true });
            } else panes[ws.focused]?.focusContent();
            break;
        }
      },
      nativeCompanion,
    );
  },
  true,
);

workerList.addEventListener('keydown', (e) => {
  if (!authorized || modalOpen() || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest('input, textarea, select, [contenteditable], .xterm, [role=separator], [role=radiogroup]')) return;
  const list = roster.visible();
  const at = list.findIndex((w) => w.id === focusedWorker(ws));
  const go = (i: number) => {
    const w = list[(i + list.length) % list.length];
    if (!w) return;
    openHere(w.id);
    roster.button(w.id)?.focus({ preventScroll: true });
  };
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === 'ArrowDown' || k === 'j') go(at + 1);
  else if (k === 'ArrowUp' || k === 'k') go(at < 0 ? list.length - 1 : at - 1);
  else return;
  e.preventDefault();
});
window.addEventListener('storage', (event) => {
  if (event.key !== BROWSER_KEY) return;
  net.close();
  closeAllModals();
  try {
    credential = browserCredential(localStorage);
  } catch {
    credential = undefined;
  }
  bootstrap = '';
  auth();
  authorized = false;
  fresh = false;
  gate = credential ? 'connecting' : 'access';
  toast('This browser’s access changed in another tab.', 'info');
  if (credential) void net.connect();
  paint();
});
window.addEventListener('online', () => {
  if (authorized) void net.connect();
  paint();
});
window.addEventListener('offline', () => {
  net.close();
  paint();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (authorized || gate === 'off')) void net.connect();
});
window.addEventListener('pagehide', () => net.close());
window.addEventListener('pageshow', (e) => {
  if (e.persisted) void net.connect();
});
paint();
void net.connect();
