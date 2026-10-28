import type { ClientMsg, WorkerInfo } from '../shared/protocol';
import { canAnswer, menuTakesText, readMenu, sameMenu } from '../shared/asks';
import { isAsleep, isBusy } from '../shared/status';
import { statusWord } from '../shared/guests';
import { cardsNewestFirst, cardChanged, OWNER } from '../shared/whiteboard';
import { ROOF } from '../shared/rooftop';
import { DESK_BY_ID } from '../shared/layout';
import { sessionWebUrl } from '../shared/factory-sessions';
import { slashOf, slashRefusal } from '../shared/slash-commands';
import { originKind, type OriginKind } from '../shared/devices';
import { BROWSER_KEY, DASHBOARD_FLOOR_KEY, DASHBOARD_WORKSPACE_KEY, clearBrowserDrafts, browserCredential, draftKey, forgetBrowserCredential, isBrowserCredential, saveBrowserCredential, type BrowserCredential } from './browser-session';
import { Net } from './net';
import { doingLine, workerKind as kind } from './worker-words';
import { store } from './state';
import { setBrowserAuth, withToken } from './token';
import { $, closeAllModals, h, modalOpen, openModal, STATUS_LABEL, toast } from './ui/dom';
import { emptyState, windowHeader } from './ui/kit';
import { icon, type IconName } from './ui/icons';
import { confirmDialog, openPrompt, sendHomeDialog } from './ui/prompt';
import { modelBadge } from './ui/models';
import { openFloorOrder } from './ui/floor-reorder';
import { createCompanionTools } from './companion-tools';
import './companion-tools.css';
import { mountWorkerThread, type WorkerThread } from './ui/worker-thread';
import { forgetAllStagedImages, forgetStagedImages } from './ui/images';
import type { WorkerStatus } from '../shared/protocol';
import { companionCapabilities, companionRoster, companionView, companionWorkedMs, type RosterFilter } from '../shared/companion-roster';
import {
  companionFloorWorkspace,
  companionWorkspaceLayout,
  createCompanionWorkspace,
  restoreCompanionWorkspace,
  reduceCompanionWorkspace,
  type CompanionPane,
  type CompanionWorkspace,
  type WorkspaceAction,
} from '../shared/companion-workspace';
import type { TerminalPane } from './ui/terminal';
import { parseWorkerLink } from './worker-link';
import { DashboardWorkerLink } from './dashboard-worker-link';
import { acknowledgeDraft } from './draft-ack';
import { DashboardQuestion } from './dashboard-question';
import { retainFocus } from './dashboard-focus';

const drafts = new Map<string, string>();
try {
  clearBrowserDrafts(localStorage);
} catch {
  /* Storage may be blocked. */
}
const read = (key: string) => {
  if (key.startsWith('droid-office.dashboard-draft.')) return drafts.get(key) ?? '';
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};
const remember = (key: string, value: string) => {
  if (key.startsWith('droid-office.dashboard-draft.')) {
    if (value) drafts.set(key, value);
    else drafts.delete(key);
    return;
  }
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
let targetFloor: string | undefined;
let selected = '';
let floor = '';
let officeName = 'Droid Office';
let version = '';
/** A one-off line for the banner (the office updated, a floor went away). Dismissed with its ✕. */
let notice = '';
let pairing = false;
let persisted = true;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let terminal: typeof import('./ui/terminal') | undefined;
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
const brand = h(
  'button.dash-brand',
  { type: 'button', title: 'All workers (Esc)', onclick: () => select('') },
  h('img', { src: '/factory-glyph.svg', alt: '', width: 26, height: 26 }),
  h('span.dash-brand-text', {}, h('span.eyebrow', {}, 'Web companion'), title),
);
const floors = h('nav.dash-floor-strip', { 'aria-label': 'Floors' });
const reorderFloors = h('button.btn.icon.ghost', { type: 'button', 'aria-label': 'Reorder floors', title: 'Reorder floors', onclick: () => openFloorOrder(net) }, '⠿');
const floorPicker = h('div.dash-floor', {}, floors, reorderFloors);
const connDot = h('i.dash-conn-dot', { 'aria-hidden': 'true' });
const connText = h('span', {}, 'Connecting');
const conn = h('span.dash-conn', { 'data-state': 'loading' }, connDot, connText);
const boardCount = h('span.dash-count.hidden');
const board = h('button.btn.dash-top-btn', { type: 'button', title: 'The floor’s Whiteboard (B)', onclick: () => void openBoard() }, icon('board'), h('span', {}, 'Whiteboard'), boardCount);
const subscriptions = h('button.btn.dash-top-btn', { type: 'button', title: 'Subscriptions and account usage', onclick: () => openTool('subscriptions') }, icon('key'), h('span', {}, 'Subscriptions'));
const hostUpdate = h('button.btn.dash-top-btn', { type: 'button', title: 'Update the host Mac app', onclick: () => openTool('host-update') }, icon('monitor'), h('span', {}, 'Host app'));
const accessLabel = h('span', {}, WHERE[where].label);
const access = h('button.btn.ghost.dash-top-btn', { type: 'button', title: 'How this browser reaches the office, and its pairing', onclick: () => accessDialog() }, icon(WHERE[where].icon), accessLabel);
let showTools = false;
const toolsButton = h(
  'button.btn.dash-top-btn',
  {
    type: 'button',
    'aria-controls': 'companion-tools-nav',
    onclick: () => {
      if (!narrow.matches) return toolRail.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
      showTools = !showTools;
      paint();
    },
  },
  'Tools',
);
const top = h('header.dash-top', {}, brand, conn, toolsButton, hostUpdate, subscriptions, board, access, floorPicker);

const bannerIcon = h('span.dash-banner-icon');
const bannerText = h('p.dash-banner-text');
const bannerActions = h('div.dash-banner-actions');
const banner = h('div.dash-banner', { hidden: true }, bannerIcon, bannerText, bannerActions);

const authPanel = h('section.dash-gate', { hidden: true });

const agentBtn = h('button.btn.accent.dash-hire', { type: 'button', title: 'Hire a Droid on this floor (N)', onclick: () => hire('agent') }, icon('plus'), h('span', {}, 'Hire Droid'));
const shellBtn = h('button.btn.dash-hire', { type: 'button', title: 'Open a plain shell at a desk', onclick: () => hire('shell') }, icon('terminal'), h('span', {}, 'Shell'));
const overviewRow = h('button.dash-nav', { type: 'button', title: 'Back to the floor (Esc)', onclick: () => select('') }, icon('grid'), h('span.grow', {}, 'Workers'), h('span.dash-nav-count'));
const search = h('input.input', { type: 'search', placeholder: 'Filter workers', 'aria-label': 'Filter workers', oninput: () => paintSide() });
const statusFilter = h('select.select', { 'aria-label': 'Filter status', onchange: () => paintSide() }, h('option', { value: '' }, 'All statuses'), ...Object.entries(STATUS_LABEL).map(([value, label]) => h('option', { value }, label)));
const kindFilter = h(
  'select.select',
  { 'aria-label': 'Filter worker type', onchange: () => paintSide() },
  ...[
    ['', 'All types'],
    ['agent', 'Droid'],
    ['shell', 'Shell'],
    ['cloud', 'Cloud'],
    ['guest', 'Guest'],
  ].map(([value, label]) => h('option', { value }, label)),
);
const workerList = h('nav.dash-workers', { 'aria-label': 'Workers' });
const side = h(
  'aside.dash-side',
  {},
  h('div.dash-side-hire', {}, agentBtn, shellBtn),
  overviewRow,
  h('div.cw-filters', {}, search, statusFilter, kindFilter),
  workerList,
  h(
    'div.dash-keys',
    { 'aria-hidden': 'true' },
    ...keyHints([
      ['↑↓', 'workers'],
      ['Esc', 'floor'],
      ['N', 'hire'],
      ['P', 'prompt'],
      ['B', 'board'],
    ]),
  ),
);
const mainEl = h('main.dash-main', { id: 'worker-detail', tabindex: '-1', 'aria-label': 'Office' });
const toolRail = h('nav.cw-tool-rail', { id: 'companion-tools-nav', 'aria-label': 'Office tools' });
const toolMount = h('section.cw-tool-mount', { 'aria-label': 'Management tool' });
const toolStage = h('section.cw-tool-stage', { hidden: true }, h('button.btn.cw-tool-back', { type: 'button', onclick: () => tools.close() }, 'Back to workers'), toolMount);
const content = h('div.dash-body', { hidden: true }, toolRail, side, mainEl);

$('dashboard').replaceChildren(h('a.dash-skip', { href: '#worker-detail' }, 'Skip to the work'), top, banner, authPanel, content, live$);

function keyHints(pairs: [string, string][]) {
  return pairs.map(([k, label]) => h('span', {}, h('span.key', {}, k), label));
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
const tools = createCompanionTools({
  net,
  mount: toolMount,
  switchFloor: goFloor,
  openWorker: (worker, view) => {
    tools.close();
    select(worker);
    dispatch({ type: 'view', floor, workerId: worker, view: view === 'tty' ? 'terminal' : 'thread' });
    paint();
  },
  onChange: () => queueMicrotask(() => paint()),
});
net.onStatus((up) => {
  store.whiteboard.status(up);
  if (!up) {
    fresh = false;
    switching = false;
    workerLink.arrive();
  }
  paint();
});
net.onConnectionLost(() => {
  forgetAllStagedImages();
  dispatch({ type: 'disconnect' });
  disposePanes();
  closeAllModals();
  drafts.clear();
  try {
    clearBrowserDrafts(localStorage);
  } catch {
    /* Storage may be blocked. */
  }
});
net.onReady((ready) => {
  if (!ready) {
    switching = net.up;
    targetFloor = net.switchingTo;
    disposePanes();
    closeAllModals();
  } else {
    if (targetFloor && floor !== targetFloor) workerLink.clear();
    targetFloor = undefined;
    switching = false;
    fresh = true;
    dispatch({ type: 'reconcile', floor, workerIds: [...store.workers.keys()] });
    selected = currentWorkspace().active;
  }
  paint();
  if (ready) followWorkerLink();
});
net.onMessage((msg) => {
  const entering = msg.t === 'welcome' || msg.t === 'floor.enter';
  if (entering) {
    // Store listeners may paint before the arrival has replaced its worker list.
    fresh = false;
    switching = false;
    workerLink.arrive();
    if (floor && floor !== msg.floor) {
      disposePanes();
      selected = '';
      closeAllModals();
    }
    floor = msg.floor ?? '';
    remember(DASHBOARD_FLOOR_KEY, floor);
    if (msg.arrival?.removed) notice = 'The floor you were on was removed. This is the office’s current floor.';
  }
  store.apply(msg);
  tools.route(msg);
  terminal?.routeTerminalMessage(msg);
  if (entering) {
    fresh = true;
    dispatch({ type: 'reconcile', floor, workerIds: [...store.workers.keys()] });
    selected = currentWorkspace().active;
    paint();
  }
  if (msg.t === 'toast') {
    toast(msg.text, msg.level);
  }
  if (entering || msg.t === 'floors' || msg.t === 'worker.update') followWorkerLink();
});
for (const topic of ['floors', 'workers', 'whiteboard', 'project'] as const) store.on(topic, paint);
store.on('screens', () => {
  for (const pane of panes.values()) pane.paintQuestion();
});
function goFloor(id: string) {
  if (!live() || id === store.floor) return;
  disposePanes();
  closeAllModals();
  switching = true;
  selected = '';
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
  return authorized && net.ready && fresh && !switching;
}
function followWorkerLink() {
  if (!live()) return;
  const result = workerLink.follow({ floor: store.floor, hasWorker: (id) => store.workers.has(id), hasFloor: (id) => store.floors.some((f) => f.id === id) }, (floor) => {
    disposePanes();
    closeAllModals();
    return net.send({ t: 'floor.go', floor });
  });
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
  select(result.link.worker);
  if (result.link.view === 'thread') dispatch({ type: 'view', floor, workerId: result.link.worker, view: 'thread' });
  paint();
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
async function action(msg: ClientMsg, id = '', intendedFloor = floor, done?: string): Promise<string | undefined> {
  if (!live() || floor !== intendedFloor || (id && !store.workers.has(id))) return 'The connection, floor or worker changed. Nothing was sent.';
  const key = id || 'hire';
  if (busy.has(key)) return 'An action for this worker is still waiting for confirmation.';
  busy.add(key);
  const epoch = navigationEpoch;
  paint();
  let hired = '';
  try {
    const result = await net.request(msg);
    if (!result.ok) return result.error ?? 'The office refused this action.';
    if (done) say(done);
    if (msg.t === 'worker.spawn' && result.workerId && floor === intendedFloor && epoch === navigationEpoch) hired = result.workerId;
  } finally {
    busy.delete(key);
    paint();
  }
  if (hired) select(hired);
}
function say(text: string) {
  live$.textContent = text;
}

// --- Painting ----------------------------------------------------------------------------------------

function avatar(w: WorkerInfo, size = '') {
  const el = h('span.dash-avatar', { class: size, 'aria-hidden': 'true' }, w.kind === 'shell' ? '$' : (Array.from(w.name.trim())[0] ?? '?').toUpperCase());
  el.style.setProperty('--who', w.color);
  return el;
}
function pill(w: WorkerInfo) {
  return h('span.pill', { class: w.status }, statusWord(w, STATUS_LABEL));
}

let floorListKey = '';
let shownFloor: string | null | undefined;
function paintFloors(up: boolean) {
  const key = JSON.stringify([store.floor === ROOF, store.floors.map((f) => [f.id, f.name, f.repo])]);
  const changed = key !== floorListKey;
  if (changed) {
    const focused = document.activeElement instanceof HTMLElement && floors.contains(document.activeElement) ? document.activeElement.dataset.floor : undefined;
    floors.replaceChildren(
      ...(store.floor === ROOF ? [h('span.dash-floor-roof', {}, 'Rooftop')] : []),
      ...store.floors.map((f, i) =>
        h(
          'button.btn.dash-floor-chip',
          {
            type: 'button',
            'data-floor': f.id,
            title: `${f.name} — ${f.repo ?? 'no git'}`,
            onclick: () => goFloor(f.id),
          },
          h('span.dash-floor-number', { 'aria-hidden': 'true' }, `${i + 1} ·`),
          h('span.dash-floor-name', {}, f.name),
        ),
      ),
    );
    floorListKey = key;
    if (focused) [...floors.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.dataset.floor === focused)?.focus({ preventScroll: true });
  }
  for (const button of floors.querySelectorAll<HTMLButtonElement>('button')) {
    button.disabled = !up;
    button.classList.toggle('on', button.dataset.floor === store.floor);
    button.setAttribute('aria-pressed', String(button.dataset.floor === store.floor));
  }
  if (changed || shownFloor !== store.floor) floors.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  shownFloor = store.floor;
}

function paint() {
  title.textContent = officeName;
  const up = live();
  const state = up ? 'live' : switching || (authorized && net.up) ? 'loading' : authorized ? 'down' : 'locked';
  conn.dataset.state = state;
  connText.textContent = { live: 'Live', loading: 'Syncing', down: 'Offline', locked: 'Locked' }[state];
  const here = store.currentFloor();
  reorderFloors.disabled = !up || store.floors.length < 2;
  agentBtn.disabled = shellBtn.disabled = !up || !here || busy.has('hire');
  board.disabled = !up || !here;
  toolsButton.disabled = !up;
  toolsButton.setAttribute('aria-expanded', String(showTools || !narrow.matches));
  subscriptions.disabled = !up;
  hostUpdate.disabled = !up;
  content.classList.toggle('dash-stale', !up);
  content.hidden = !authorized;
  authPanel.hidden = authorized;
  floorPicker.hidden = !authorized;
  board.hidden = !authorized;
  accessLabel.textContent = credential && where !== 'local' ? `${WHERE[where].label} · paired` : WHERE[where].label;
  paintBanner();
  if (!authorized) {
    for (const pane of panes.values()) pane.thread?.activate(false);
    return paintGate();
  }
  paintFloors(up);
  const b = store.floor && store.whiteboard.board(store.floor);
  const changed = b ? cardsNewestFirst(b).filter((c) => cardChanged(b, OWNER, c.id)).length : 0;
  boardCount.textContent = String(changed);
  boardCount.classList.toggle('hidden', !changed);
  board.setAttribute('aria-label', changed ? `Whiteboard, ${changed} unread` : 'Whiteboard');
  const needs = [...store.workers.values()].filter((w) => w.status === 'needs_input').length;
  document.title = `${needs ? `(${needs}) ` : ''}${officeName} · Web companion`;
  if (fresh && !switching) {
    dispatch({ type: 'reconcile', floor, workerIds: [...store.workers.keys()] });
    selected = currentWorkspace().active;
  }
  paintSide();
  paintTools();
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

type Rows = Map<string, { el: HTMLButtonElement }>;
const rows: Rows = new Map();
const panes = new Map<string, WorkspacePane>();
let workspace = restoreWorkspace();
let savedLayout = JSON.stringify(companionWorkspaceLayout(workspace));
let navigationEpoch = 0;
const narrow = matchMedia('(max-width: 760px)');
const paneHost = h('div.cw-panes');
const emptyWorkspace = h('div.cw-empty', {}, emptyState('', 'Choose a worker', 'Open a worker from the roster. Pin up to four distinct workers side by side.'));
const quickSwitch = h('select.select.cw-switch', { 'aria-label': 'Switch worker', onchange: () => select(quickSwitch.value) });
const mobileNav = h(
  'nav.cw-mobile-nav',
  { 'aria-label': 'Conversation navigation' },
  h('button.btn', { type: 'button', onclick: () => select('') }, 'Workers'),
  h('button.btn', { type: 'button', 'aria-label': 'Previous worker', onclick: () => moveWorker(-1) }, 'Previous'),
  quickSwitch,
  h('button.btn', { type: 'button', 'aria-label': 'Next worker', onclick: () => moveWorker(1) }, 'Next'),
);
mainEl.replaceChildren(mobileNav, paneHost, emptyWorkspace, toolStage);
narrow.addEventListener('change', () => paintWorkspace());

function restoreWorkspace(): CompanionWorkspace {
  try {
    return restoreCompanionWorkspace(JSON.parse(read(DASHBOARD_WORKSPACE_KEY)));
  } catch {
    return createCompanionWorkspace();
  }
}
function dispatch(action: WorkspaceAction) {
  if (action.type === 'reconcile') {
    const valid = new Set(action.workerIds);
    for (const [workerId, draft] of Object.entries(companionFloorWorkspace(workspace, action.floor).drafts)) {
      if (!valid.has(workerId)) forgetStagedImages(draft.attachments);
    }
  }
  workspace = reduceCompanionWorkspace(workspace, action);
  if (action.type === 'draft' || action.type === 'disconnect') return;
  const layout = JSON.stringify(companionWorkspaceLayout(workspace));
  if (layout === savedLayout) return;
  savedLayout = layout;
  remember(DASHBOARD_WORKSPACE_KEY, layout);
}
function currentWorkspace() {
  return companionFloorWorkspace(workspace, floor);
}
function roster() {
  return companionRoster(
    [...store.workers.values()],
    { query: search.value, status: (statusFilter.value as WorkerStatus | undefined) || undefined, kind: (kindFilter.value as RosterFilter['kind']) || undefined },
    new Set(currentWorkspace().collapsed),
  );
}
const ordered = () =>
  roster()
    .filter((row) => row.matches)
    .map((row) => row.worker);

function paintSide() {
  const restoreFocus = retainFocus(workerList);
  overviewRow.classList.toggle('on', !selected);
  overviewRow.setAttribute('aria-current', !selected ? 'page' : 'false');
  (overviewRow.lastElementChild as HTMLElement).textContent = String(store.workers.size);
  const visible = roster();
  const seen = new Set<string>();
  const children: HTMLElement[] = [];
  for (const row of visible) {
    const w = row.worker;
    seen.add(w.id);
    let cached = rows.get(w.id);
    if (!cached) {
      cached = { el: h('button.dash-row', { type: 'button', 'data-worker': w.id, 'data-focus-key': `worker:${w.id}`, onclick: () => select(w.id) }) };
      rows.set(w.id, cached);
    }
    const el = cached.el;
    const parent = w.lead ? (store.workers.get(w.lead)?.name ?? 'Lead no longer on this floor') : 'Independent worker';
    el.title = `${w.name} · ${kind(w)} · ${parent}`;
    el.classList.toggle('on', selected === w.id);
    el.setAttribute('aria-current', String(selected === w.id));
    el.replaceChildren(
      avatar(w),
      h(
        'span.dash-row-main',
        {},
        h('span.dash-row-name', {}, w.name),
        h('span.dash-row-meta', {}, w.task?.name ?? w.title ?? kind(w)),
        h('span.dash-row-meta', {}, parent),
        h('span.dash-row-meta', {}, doingLine(w)),
        h('span.dash-row-meta', {}, modelBadge(w.activeModel ?? w.model, w.activeEffort ?? w.effort)),
        h('span.dash-row-meta', {}, `${Math.floor(companionWorkedMs(w, Date.now()) / 60_000)}m worked`),
      ),
      pill(w),
    );
    const collapse = h(
      'button.btn.sm.ghost',
      {
        type: 'button',
        'data-focus-key': `collapse:${w.id}`,
        disabled: !row.childCount,
        'aria-label': `${row.collapsed ? 'Expand' : 'Collapse'} ${w.name}'s children`,
        'aria-expanded': String(!row.collapsed),
        onclick: () => {
          dispatch({ type: 'collapse', floor, workerId: w.id });
          paintSide();
        },
      },
      row.childCount ? (row.collapsed ? '▸' : '▾') : '·',
    );
    const pin = h(
      'button.btn.sm',
      {
        type: 'button',
        'data-focus-key': `pin:${w.id}`,
        disabled: !live() || (currentWorkspace().panes.length >= 4 && !currentWorkspace().panes.some((p) => p.workerId === w.id)),
        'aria-label': `Pin ${w.name}`,
        onclick: () => select(w.id, true),
      },
      'Pin',
    );
    const item = h('div.cw-roster-item', {}, collapse, el, pin);
    item.style.setProperty('--depth', String(row.depth));
    children.push(item);
    if (row.childCount)
      children.push(
        h(
          'p.cw-child-counts',
          {},
          `${row.descendantCount} children · ${Object.entries(row.childStatuses)
            .map(([status, count]) => `${count} ${STATUS_LABEL[status as WorkerStatus]}`)
            .join(' · ')}`,
        ),
      );
  }
  for (const id of rows.keys()) if (!seen.has(id)) rows.delete(id);
  if (!children.length) children.push(h('p.dash-side-empty', {}, store.workers.size ? 'No workers match these filters.' : 'Nobody on this floor yet.'));
  workerList.replaceChildren(...children);
  restoreFocus();
  const value = selected;
  const choices = ordered();
  const chosen = store.workers.get(selected);
  if (chosen && !choices.some((w) => w.id === chosen.id)) choices.unshift(chosen);
  quickSwitch.replaceChildren(h('option', { value: '' }, 'Choose worker'), ...choices.map((w) => h('option', { value: w.id }, w.name)));
  quickSwitch.value = value;
}
function select(id: string, pin = false) {
  if (id && !store.workers.has(id)) return;
  const state = currentWorkspace();
  if (id && !state.active && state.panes.length >= 4 && !state.panes.some((p) => p.workerId === id)) return toast('Four panes are pinned. Close one or select a pane to replace.', 'warn');
  tools.close();
  showTools = false;
  if (id) dispatch({ type: 'open', floor, workerId: id, pin });
  else dispatch({ type: 'focus', floor, workerId: '' });
  selected = currentWorkspace().active;
  paint();
}
function moveWorker(step: number) {
  const all = ordered();
  if (!all.length) return;
  const index = all.findIndex((w) => w.id === selected);
  select(all[(index + step + all.length) % all.length]!.id);
}
function disposePanes() {
  navigationEpoch++;
  for (const pane of panes.values()) pane.dispose();
  panes.clear();
}
function paintWorkspace() {
  const state = currentWorkspace();
  const ready = !switching && fresh && net.ready;
  const managing = !!tools.current();
  content.classList.toggle('cw-conversation', (ready && !!selected) || managing);
  content.classList.toggle('cw-show-tools', showTools);
  emptyWorkspace.hidden = !ready || state.panes.length > 0 || managing;
  paneHost.hidden = !ready || state.panes.length === 0 || managing;
  mobileNav.hidden = !ready || !selected || managing;
  toolStage.hidden = !managing;
  if (!ready) return;
  for (const [id, pane] of panes) {
    if (pane.floor !== floor || !state.panes.some((p) => p.workerId === id) || !store.workers.has(id)) {
      pane.dispose();
      panes.delete(id);
    }
  }
  for (const spec of state.panes) {
    const worker = store.workers.get(spec.workerId);
    if (!worker) continue;
    let pane = panes.get(worker.id);
    if (!pane) {
      pane = new WorkspacePane(worker, floor);
      panes.set(worker.id, pane);
      paneHost.append(pane.element);
    }
    pane.update(worker, spec);
  }
}
class WorkspacePane {
  readonly element = h('section.cw-pane', { tabindex: -1 });
  readonly stage = h('div.cw-stage');
  readonly controls = h('div.dash-controls', { role: 'group', 'aria-label': 'Worker actions' });
  readonly question = h('section.dash-question', { 'aria-label': 'Question requiring input', hidden: true });
  readonly tabs = h('div.seg');
  readonly heading = h('h2');
  readonly meta = h('p.cw-pane-meta');
  thread?: WorkerThread;
  raw?: TerminalPane;
  mode = '';
  private loading = false;
  private disposed = false;
  private threadRevision = 0;
  private menuKey = '';
  private answerState = new DashboardQuestion();
  private questionDraft = '';
  private epoch: number;
  constructor(
    public worker: WorkerInfo,
    readonly floor: string,
  ) {
    this.epoch = workspace.epoch;
    this.questionDraft = read(draftKey(floor, `${worker.id}:answer`));
    const close = h(
      'button.btn.sm',
      {
        type: 'button',
        'aria-label': `Unpin ${worker.name}`,
        onclick: () => {
          dispatch({ type: 'close', floor, workerId: worker.id });
          selected = currentWorkspace().active;
          paint();
        },
      },
      'Close',
    );
    const resize = h('input.cw-resize', {
      type: 'range',
      min: 0.25,
      max: 4,
      step: 0.05,
      value: 1,
      'aria-label': `Resize ${worker.name} pane`,
      oninput: () => {
        dispatch({ type: 'resize', floor, workerId: worker.id, size: Number(resize.value) });
        paintWorkspace();
      },
    });
    this.element.append(h('header.cw-pane-head', {}, this.heading, this.tabs, close), this.meta, resize, this.controls, this.question, this.stage);
    this.element.addEventListener('pointerdown', () => this.focusPane());
    this.element.addEventListener('focusin', () => this.focusPane());
  }
  private focusPane() {
    if (selected === this.worker.id) return;
    dispatch({ type: 'focus', floor: this.floor, workerId: this.worker.id });
    selected = this.worker.id;
    paintSide();
    for (const pane of panes.values()) {
      const active = pane.worker.id === selected;
      pane.element.classList.toggle('active', active);
      pane.raw?.setActive(active && live());
      pane.thread?.focus(active);
    }
  }
  update(worker: WorkerInfo, spec: CompanionPane) {
    this.worker = worker;
    const active = selected === worker.id;
    const visible = (!narrow.matches || active) && !tools.current();
    this.element.hidden = !visible;
    this.element.classList.toggle('active', active);
    this.element.style.setProperty('--pane-size', String(spec.size));
    const resize = this.element.querySelector<HTMLInputElement>('.cw-resize');
    if (resize && document.activeElement !== resize) resize.value = String(spec.size);
    this.heading.textContent = worker.name;
    const parent = worker.lead ? (store.workers.get(worker.lead)?.name ?? 'departed lead') : 'Independent';
    this.meta.textContent = [
      worker.task?.name ?? worker.title,
      kind(worker),
      statusWord(worker, STATUS_LABEL),
      parent,
      modelBadge(worker.activeModel ?? worker.model, worker.activeEffort ?? worker.effort),
      `${Math.floor(companionWorkedMs(worker, Date.now()) / 60_000)}m worked`,
      worker.activity ?? worker.task?.summary ?? worker.prompt,
    ]
      .filter(Boolean)
      .join(' · ');
    const capability = companionCapabilities(worker);
    const mode = companionView(worker, spec.view);
    const restoreTabsFocus = retainFocus(this.tabs);
    this.tabs.replaceChildren(
      ...(['thread', 'terminal'] as const).map((view) =>
        h(
          'button.btn.sm',
          {
            type: 'button',
            'data-focus-key': view,
            class: mode === view ? 'on' : '',
            'aria-pressed': String(mode === view),
            disabled: view === 'terminal' ? !capability.terminal : !capability.thread,
            onclick: () => {
              dispatch({ type: 'view', floor: this.floor, workerId: worker.id, view });
              paintWorkspace();
            },
          },
          view === 'thread' ? 'Thread' : 'Raw TTY',
        ),
      ),
    );
    restoreTabsFocus();
    if (mode !== this.mode) {
      const revision = ++this.threadRevision;
      this.thread?.dispose();
      this.thread = undefined;
      this.raw?.dispose();
      this.raw = undefined;
      this.mode = mode;
      if (mode === 'thread') {
        const key = draftKey(this.floor, worker.id);
        this.thread ??= mountWorkerThread(net, {
          worker,
          controls: this.controls,
          question: this.question,
          queueKey: `${key}:queue-receipts`,
          draft: read(key),
          floor: this.floor,
          attachments: companionFloorWorkspace(workspace, this.floor).drafts[worker.id]?.attachments ?? [],
          onDraft: (value) => {
            if (this.epoch !== workspace.epoch || this.disposed || revision !== this.threadRevision) return;
            remember(key, value);
            const attachments = companionFloorWorkspace(workspace, this.floor).drafts[worker.id]?.attachments ?? [];
            dispatch({ type: 'draft', floor: this.floor, workerId: worker.id, draft: { text: value, attachments } });
          },
          onAttachments: (attachments) => {
            if (this.epoch !== workspace.epoch || this.disposed || revision !== this.threadRevision) return;
            dispatch({ type: 'draft', floor: this.floor, workerId: worker.id, draft: { text: read(key), attachments } });
          },
          onSubmitted: (sent) => {
            if (this.epoch !== workspace.epoch) return;
            const kept = companionFloorWorkspace(workspace, this.floor).drafts[worker.id];
            const next = acknowledgeDraft({ text: read(key), attachments: kept?.attachments ?? [] }, sent);
            remember(key, next.text);
            // A successful old view removes only what it sent, never a newer view's edits or pictures.
            if (kept) dispatch({ type: 'draft', floor: this.floor, workerId: worker.id, draft: next });
          },
          onDraftReset: () => {
            if (this.epoch !== workspace.epoch || this.disposed || revision !== this.threadRevision) return;
            remember(key, '');
            dispatch({ type: 'draft', floor: this.floor, workerId: worker.id, draft: { text: '', attachments: [] } });
          },
          send: (msg) => (this.valid() ? action(msg, worker.id, this.floor) : Promise.resolve('The connection or floor changed. Nothing was sent.')),
          screen: () => lines(worker.id),
          team: () => (this.valid() ? [...store.workers.values()] : []),
          openWorker: (id) => {
            if (this.valid()) select(id);
          },
          raw: () => {
            if (!this.valid() || revision !== this.threadRevision) return;
            dispatch({ type: 'view', floor: this.floor, workerId: worker.id, view: 'terminal' });
            paintWorkspace();
          },
        });
        this.stage.replaceChildren(this.thread.element);
      } else {
        this.element.insertBefore(this.controls, this.stage);
        this.element.insertBefore(this.question, this.stage);
        this.stage.replaceChildren(
          mode === 'terminal'
            ? h('p', {}, 'Opening terminal…')
            : h(
                'p.note',
                {},
                worker.guest
                  ? 'This worker runs outside the office. Use its own terminal.'
                  : worker.cloud || worker.kind === 'cloud'
                    ? 'This worker runs in Factory. Open its session to read the conversation.'
                    : worker.kind === 'shell'
                      ? 'Shells have no conversation transcript. Select Raw TTY.'
                      : 'Resume this worker to open its terminal.',
              ),
        );
      }
    }
    this.thread?.update(worker, live());
    this.thread?.focus(active);
    this.thread?.activate(visible && mode === 'thread' && live());
    if (mode === 'terminal' && visible && live()) void this.showRaw();
    this.raw?.setActive(visible && active && live());
    this.raw?.update();
    this.paintControls();
    this.paintQuestion();
  }
  private valid() {
    return !this.disposed && this.epoch === workspace.epoch && usable(this.worker.id, this.floor);
  }
  private async showRaw() {
    if (this.raw || this.loading) return;
    this.loading = true;
    const epoch = navigationEpoch;
    try {
      terminal ??= await import('./ui/terminal');
      if (!this.valid() || epoch !== navigationEpoch || this.mode !== 'terminal') return;
      this.stage.replaceChildren();
      this.raw = terminal.mountTerminal(net, this.worker.id, this.stage, {
        onLeave: () => rows.get(this.worker.id)?.el.focus(),
        onFocus: () => this.focusPane(),
        active: selected === this.worker.id && live(),
      });
    } catch (error) {
      if (this.valid()) this.stage.replaceChildren(h('p.note.bad', {}, `Could not open terminal: ${String(error)}`));
    } finally {
      this.loading = false;
    }
  }
  private paintControls() {
    const restoreFocus = retainFocus(this.controls);
    const w = this.worker;
    const enabled = this.valid() && !busy.has(w.id);
    const btn = (label: string, ok: boolean, run: () => void) => h('button.btn.sm', { type: 'button', 'data-focus-key': label, disabled: !enabled || !ok, onclick: run }, label);
    this.controls.replaceChildren(
      isAsleep(w.status) && !w.guest
        ? btn(w.kind === 'shell' ? 'Restart' : 'Resume', !w.lost, () => void action({ t: 'worker.resume', workerId: w.id }, w.id, this.floor).then(warn))
        : btn(w.kind === 'shell' ? 'Command' : 'Prompt', !w.guest && !w.lost, () => prompt(w)),
      ...(w.cloud && w.sessionId ? [h('a.btn.sm', { 'data-focus-key': 'session', href: sessionWebUrl(w.sessionId), target: '_blank', rel: 'noopener noreferrer' }, 'Factory session')] : []),
      ...(w.pr
        ? [h('a.btn.sm', { 'data-focus-key': 'pull', href: safeLink(w.pr.url), target: '_blank', rel: 'noopener noreferrer' }, `PR #${w.pr.number}`)]
        : w.worktree && !w.guest && !w.cloud
          ? [btn('Open PR', !w.lost && !w.prOpening && !isBusy(w.status), () => void action({ t: 'worker.pr', workerId: w.id }, w.id, this.floor).then(warn))]
          : []),
      btn('Manage', true, () => openWorkerActions(w.id)),
      btn('Send home', !w.guest, () => sendHome(w)),
    );
    restoreFocus();
  }
  paintQuestion() {
    const w = this.worker;
    const screen = lines(w.id);
    const menu = screen && canAnswer(w, screen) ? readMenu(screen) : undefined;
    const state = this.answerState;
    state.sync(menu, w.waitingSince);
    const revision = state.revision;
    const key = JSON.stringify([menu, w.status, w.waitingSince, this.valid(), busy.has(w.id), state.answering, state.answered]);
    if (key === this.menuKey) return;
    this.menuKey = key;
    const restoreFocus = retainFocus(this.question);
    this.question.hidden = w.status !== 'needs_input';
    if (this.question.hidden) return;
    if (!menu) {
      this.question.replaceChildren(h('p.note', {}, 'This question cannot be answered safely here. Use Raw TTY, or the worker’s own terminal.'));
      return;
    }
    const text = h('textarea.input', {
      rows: 2,
      'data-focus-key': 'answer-text',
      'aria-label': 'Typed answer',
      oninput: () => {
        this.questionDraft = text.value;
        remember(draftKey(this.floor, `${w.id}:answer`), text.value);
      },
    });
    text.value = this.questionDraft;
    const enabled = this.valid() && !busy.has(w.id) && !state.answering && !state.answered;
    text.disabled = !enabled;
    const reply = async (value: { choice?: number; text?: string }) => {
      if (state.answering || state.answered || busy.has(w.id)) return;
      const current = lines(w.id);
      if (!this.valid() || revision !== state.revision || w.waitingSince !== this.worker.waitingSince || !current || !canAnswer(this.worker, current) || !sameMenu(menu, readMenu(current)))
        return toast('The question changed. Review it before answering.', 'warn');
      state.answering = true;
      this.paintQuestion();
      const error = await action({ t: 'worker.answer', workerId: w.id, menu, ...value }, w.id, this.floor);
      if (!this.valid() || revision !== state.revision) return;
      state.answering = false;
      state.answered = !error;
      if (error) warn(error);
      else {
        this.questionDraft = '';
        remember(draftKey(this.floor, `${w.id}:answer`), '');
      }
      this.paintQuestion();
    };
    this.question.replaceChildren(
      h('h3', {}, menu.question ?? 'Choose an answer'),
      ...menu.choices.map((c) => h('button.btn', { type: 'button', 'data-focus-key': `choice:${c.number}`, disabled: !enabled, onclick: () => void reply({ choice: c.number }) }, `${c.number}. ${c.label}`)),
      ...(menuTakesText(menu) ? [text, h('button.btn', { type: 'button', 'data-focus-key': 'send-answer', disabled: !enabled, onclick: () => void reply({ text: text.value }) }, 'Send answer')] : []),
      ...(state.answering || state.answered ? [h('p.note', {}, state.answering ? 'Sending answer…' : 'Answer sent. Waiting for worker.')] : []),
    );
    restoreFocus();
  }
  dispose() {
    this.disposed = true;
    this.thread?.dispose();
    this.raw?.dispose();
    this.element.remove();
  }
}
function safeLink(url: string) {
  try {
    const value = new URL(url);
    return value.protocol === 'https:' || value.protocol === 'http:' ? value.href : '#';
  } catch {
    return '#';
  }
}
function lines(id: string) {
  const screen = store.screens.get(id);
  return screen && Array.from({ length: screen.rows }, (_, i) => (screen.lines[i] ?? []).map((run) => run[0]).join(''));
}
const warn = (error: string | undefined) => {
  if (error) toast(error, 'warn');
};
type ToolId = Parameters<ReturnType<typeof createCompanionTools>['open']>[0];
function openTool(id: ToolId) {
  if (!live()) return;
  showTools = false;
  void tools.open(id, selected ? { workerId: selected } : undefined);
  paint();
}
function paintTools() {
  const restoreFocus = retainFocus(toolRail);
  const nodes: HTMLElement[] = [];
  let group = '';
  for (const tool of tools.list()) {
    if (tool.group !== group) {
      group = tool.group;
      nodes.push(h('h3.eyebrow', {}, group));
    }
    nodes.push(
      h(
        'button.btn.ghost.cw-tool-entry',
        {
          type: 'button',
          'data-focus-key': tool.id,
          disabled: !live() || !tool.available,
          title: tool.reason || tool.label,
          onclick: () => openTool(tool.id),
        },
        tool.label,
        tool.count ? h('span.pill', {}, String(tool.count)) : null,
      ),
    );
    if (!tool.available && tool.reason) nodes.push(h('p.cw-tool-reason', {}, tool.reason));
  }
  toolRail.replaceChildren(...nodes);
  restoreFocus();
  content.classList.toggle('cw-show-tools', showTools);
}
function openWorkerActions(workerId: string) {
  if (!live()) return;
  const intended = floor;
  const epoch = navigationEpoch;
  const body = h('div.body.stack');
  const modal = openModal(h('div.modal', { role: 'dialog', 'aria-label': 'Worker management' }, windowHeader('Worker management', store.workers.get(workerId)?.name), body));
  for (const item of tools.workerActions(workerId)) {
    body.append(
      h(
        'button.btn',
        {
          type: 'button',
          disabled: !item.available,
          title: item.reason || item.label,
          onclick: () => {
            if (floor !== intended || epoch !== navigationEpoch || !live()) return;
            modal.close();
            void tools.runWorkerAction(workerId, item.id);
          },
        },
        item.label,
      ),
    );
    if (!item.available && item.reason) body.append(h('p.field-hint', {}, item.reason));
  }
}

// --- Actions ------------------------------------------------------------------------------------------

function hire(kind: 'agent' | 'shell', deskId = 'auto') {
  if (!live() || !store.currentFloor()) return;
  const intended = floor;
  const epoch = navigationEpoch;
  const key = draftKey(intended, `hire:${kind}`);
  const desk = deskId === 'auto' ? undefined : DESK_BY_ID.get(deskId)?.label;
  openPrompt({
    title: kind === 'shell' ? 'Open a shell' : 'Hire Droid',
    subtitle: [store.currentFloor()?.name, desk].filter(Boolean).join(' · '),
    submitLabel: kind === 'shell' ? 'Open shell' : 'Hire Droid',
    allowEmpty: true,
    initial: read(key),
    onDraft: (v) => {
      if (epoch === navigationEpoch) remember(key, v);
    },
    modelOption: kind === 'agent',
    deskId: deskId === 'auto' ? undefined : deskId,
    imagesOption: kind === 'agent',
    recall: kind === 'agent',
    worktreeOption: !store.currentFloor()?.home && !store.currentFloor()?.plain && !!store.currentFloor()?.branch,
    onSubmit: async (text, opts) => {
      if (epoch !== navigationEpoch) return 'The connection or floor changed. Nothing was sent.';
      const error = await action({ t: 'worker.spawn', deskId, kind, prompt: text, ...opts }, '', intended, kind === 'shell' ? 'Shell opened.' : 'Droid hired.');
      if (!error) remember(key, '');
      return error;
    },
  });
}
function prompt(w: WorkerInfo) {
  if (panes.get(w.id)?.mode === 'thread' && w.status === 'needs_input') {
    toast('Answer the current question, or open Raw TTY for this CLI dialog.', 'warn');
    return;
  }
  const thread = panes.get(w.id);
  if (thread?.mode === 'thread') {
    thread.element.querySelector<HTMLTextAreaElement>('.wt-input')?.focus();
    return;
  }
  const intended = floor;
  const epoch = navigationEpoch;
  const key = draftKey(intended, w.id);
  openPrompt({
    title: w.kind === 'shell' ? `Command · ${w.name}` : `Prompt · ${w.name}`,
    initial: read(key),
    onDraft: (v) => {
      if (epoch === navigationEpoch) remember(key, v);
    },
    imagesOption: w.kind !== 'shell',
    recall: w.kind !== 'shell',
    queueOption: w.kind === 'agent' && isBusy(w.status),
    onSubmit: async (text, opts) => {
      if (epoch !== navigationEpoch) return 'The connection or floor changed. Nothing was sent.';
      const now = store.workers.get(w.id) ?? w;
      if (panes.get(w.id)?.mode === 'thread' && now.status === 'needs_input') return 'Answer the current question, or open Raw TTY for this CLI dialog. Your draft is kept.';
      const refused = w.kind === 'agent' ? slashRefusal(text, w.name, isBusy(now.status)) : undefined;
      if (refused) return `${refused} Your draft is kept.`;
      const error = await action({ t: 'worker.prompt', workerId: w.id, prompt: text, images: opts.images, queue: opts.queue && isBusy(now.status) }, w.id, intended, `Sent to ${w.name}.`);
      if (!error) remember(key, '');
      // Droid answers most of its slash commands with a dialog, which only its terminal shows.
      if (!error && epoch === navigationEpoch && panes.get(w.id)?.mode === 'thread' && w.kind === 'agent' && slashOf(text)?.command?.kind === 'tty') {
        dispatch({ type: 'view', floor: intended, workerId: w.id, view: 'terminal' });
        paint();
      }
      return error;
    },
  });
}
function sendHome(w: WorkerInfo) {
  const intended = floor;
  const epoch = navigationEpoch;
  const confirm = (cleanup: 'keep' | 'worktree' | 'all' = 'keep') => {
    if (epoch !== navigationEpoch) return warn('The connection or floor changed. Nothing was sent.');
    void action({ t: 'worker.kill', workerId: w.id, cleanup, deleteSession: false }, w.id, intended, `${w.name} went home.`).then(warn);
  };
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
  openTool('whiteboard');
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

  if (where === 'local') {
    body.append(h('p.note.good', {}, 'Nothing to pair here. To open the office in a browser on another computer, use the links in ', h('b', {}, '⚙️ Settings → Phone & web → Web companion'), ' on this computer.'));
    footer.append(h('span.grow'), h('button.btn.primary', { type: 'button', onclick: () => modal.close() }, 'Done'));
  } else if (credential) {
    const saved = credential;
    body.append(
      h(
        'dl.dash-meta',
        {},
        h('dt', {}, 'Paired as'),
        h('dd', {}, saved.device.name),
        h('dt', {}, 'At'),
        h('dd', {}, location.origin),
        h('dt', {}, 'Kept'),
        h('dd', {}, persisted ? 'In this browser, across restarts' : 'For this page only: this browser blocks storage'),
      ),
      h('p.field-hint', {}, 'Forget only removes the saved access from this browser; the office still lists it until you unpair it. Unpair removes it on the office too and closes every tab using it.'),
      note,
    );
    const revoke = h('button.btn.danger', { type: 'button' }, 'Unpair…');
    revoke.addEventListener('click', () =>
      confirmDialog('Unpair this browser?', 'Its saved access stops working on the office, and every tab using it disconnects. Pairing again needs a fresh link from the office.', 'Unpair', () => {
        revoke.disabled = true;
        void fetch(withToken('/api/mobile/pair'), { method: 'DELETE' })
          .then((res) => {
            if (!res.ok) throw new Error('The office didn’t confirm. This browser is still paired.');
            forgetHere('This browser is unpaired, on the office and here.');
          })
          .catch((error: Error) => {
            fail(error.message);
            revoke.disabled = false;
          });
      }),
    );
    footer.append(
      h('span.grow', {}, revoke),
      h('button.btn', { type: 'button', onclick: () => forgetHere('Saved access forgotten in this browser. The office still lists it until you unpair it there.') }, 'Forget here'),
      h('button.btn.primary', { type: 'button', onclick: () => modal.close() }, 'Done'),
    );
  } else if (authorized) {
    const deviceName = h('input.input', { value: defaultBrowserName(), maxlength: 64, 'aria-label': 'Name this browser' });
    const pair = h('button.btn.accent', { type: 'button', disabled: pairing }, icon('key', 14), 'Pair this browser');
    body.append(
      h('p', {}, 'Pairing keeps this browser’s own access at ', h('code', {}, location.origin), ', so a bookmark opens the office after it restarts. It’s you, not a new account, and you can unpair it any time.'),
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
          toast(persisted ? 'Paired. Bookmark this page: it opens the office from now on.' : 'Paired for this page only: this browser blocks storage. Unpair it before closing so no unused pairing is left.', persisted ? 'info' : 'warn');
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
  } else {
    body.append(h('p.note.info', {}, 'Open a fresh link from ', h('b', {}, '⚙️ Settings → Phone & web → Web companion'), ' on the office’s computer, then pair from there.'));
    footer.append(h('span.grow'), h('button.btn.primary', { type: 'button', onclick: () => modal.close() }, 'Done'));
  }
}

// --- Keys ------------------------------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (!authorized || modalOpen() || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest('input, textarea, select, [contenteditable], .xterm')) return;
  const list = ordered();
  const at = list.findIndex((w) => w.id === selected);
  const go = (i: number) => {
    const w = list[(i + list.length) % list.length];
    if (!w) return;
    select(w.id);
    rows.get(w.id)?.el.focus({ preventScroll: true });
  };
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === 'ArrowDown' || k === 'j') go(at + 1);
  else if (k === 'ArrowUp' || k === 'k') go(at < 0 ? list.length - 1 : at - 1);
  else if (k === 'Escape' && selected) select('');
  else if (k === 'n') hire('agent');
  else if (k === 'b') void openBoard();
  else if (k === 'p' && selected) {
    const w = store.workers.get(selected);
    if (w && live() && !w.guest && !w.lost && !isAsleep(w.status)) prompt(w);
    else return;
  } else return;
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
