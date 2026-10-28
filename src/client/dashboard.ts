import type { ClientMsg, WorkerInfo } from '../shared/protocol';
import { canAnswer, menuTakesText, readMenu, sameMenu, type Menu } from '../shared/asks';
import { isAsleep, isBusy } from '../shared/status';
import { statusWord } from '../shared/guests';
import { cardsNewestFirst, cardChanged, OWNER } from '../shared/whiteboard';
import { ROOF } from '../shared/rooftop';
import { DESK_BY_ID } from '../shared/layout';
import { sessionWebUrl } from '../shared/factory-sessions';
import { originKind, type OriginKind } from '../shared/devices';
import { BROWSER_KEY, DASHBOARD_FLOOR_KEY, browserCredential, draftKey, forgetBrowserCredential, isBrowserCredential, saveBrowserCredential, type BrowserCredential } from './browser-session';
import { Net } from './net';
import { previewRows } from './screen-preview';
import { doingLine, workerKind as kind } from './worker-words';
import { connectWhiteboard, store } from './state';
import { setBrowserAuth, withToken } from './token';
import { $, closeAllModals, h, modalOpen, openModal, STATUS_LABEL, toast } from './ui/dom';
import { emptyState, windowHeader } from './ui/kit';
import { icon, type IconName } from './ui/icons';
import { confirmDialog, openPrompt, routeWorktreeMessage, sendHomeDialog } from './ui/prompt';
import { modelBadge, modelBadgeNode } from './ui/models';
import { openFloorOrder } from './ui/floor-reorder';
import { openSubscriptionsStatus } from './ui/subscriptions-status';
import { mountWorkerThread, type WorkerThread } from './ui/worker-thread';
import type { MapDirection } from './office-map-view';
import type { MapFloor, OfficeMap, OfficeMapHooks } from './office-map';
import { parseWorkerLink } from './worker-link';
import { DashboardWorkerLink } from './dashboard-worker-link';

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
const subscriptions = h('button.btn.dash-top-btn', { type: 'button', title: 'Subscriptions and account usage', onclick: () => openSubscriptionsStatus() }, icon('key'), h('span', {}, 'Subscriptions'));
const accessLabel = h('span', {}, WHERE[where].label);
const access = h('button.btn.ghost.dash-top-btn', { type: 'button', title: 'How this browser reaches the office, and its pairing', onclick: () => accessDialog() }, icon(WHERE[where].icon), accessLabel);
const top = h('header.dash-top', {}, brand, conn, subscriptions, board, access, floorPicker);

const bannerIcon = h('span.dash-banner-icon');
const bannerText = h('p.dash-banner-text');
const bannerActions = h('div.dash-banner-actions');
const banner = h('div.dash-banner', { hidden: true }, bannerIcon, bannerText, bannerActions);

const authPanel = h('section.dash-gate', { hidden: true });

const agentBtn = h('button.btn.accent.dash-hire', { type: 'button', title: 'Hire a Droid on this floor (N)', onclick: () => hire('agent') }, icon('plus'), h('span', {}, 'Hire Droid'));
const shellBtn = h('button.btn.dash-hire', { type: 'button', title: 'Open a plain shell at a desk', onclick: () => hire('shell') }, icon('terminal'), h('span', {}, 'Shell'));
const overviewRow = h('button.dash-nav', { type: 'button', title: 'Back to the floor (Esc)', onclick: () => select('') }, icon('cube'), h('span.grow', {}, 'Overview'), h('span.dash-nav-count'));
const workerList = h('nav.dash-workers', { 'aria-label': 'Workers' });
const side = h(
  'aside.dash-side',
  {},
  h('div.dash-side-hire', {}, agentBtn, shellBtn),
  overviewRow,
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
const content = h('div.dash-body', { hidden: true }, side, mainEl);

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
    if (floor && floor !== msg.floor) {
      selected = '';
      closeAllModals();
    }
    floor = msg.floor ?? '';
    remember(DASHBOARD_FLOOR_KEY, floor);
    if (msg.arrival?.removed) notice = 'The floor you were on was removed. This is the office’s current floor.';
  }
  store.apply(msg);
  terminal?.routeTerminalMessage(msg);
  whiteboard?.routeWhiteboardMessage(msg);
  routeWorktreeMessage(msg);
  if (entering) {
    const open = terminal?.openTerminalFor();
    if (open && store.workers.has(open)) net.send({ t: 'worker.attach', workerId: open });
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
  paintQuestion();
  schedulePreviews();
});
function goFloor(id: string) {
  if (!live() || id === store.floor) return;
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
  if (result.link.view === 'thread') workerView = 'thread';
  select(result.link.worker);
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
  if (hired) void enter(hired);
}
function say(text: string) {
  live$.textContent = text;
}

// --- Painting ----------------------------------------------------------------------------------------

/** The order of the sidebar's groups, and which workers fall in each. */
const GROUPS: { title: string; has: (w: WorkerInfo) => boolean }[] = [
  { title: 'Needs you', has: (w) => w.status === 'needs_input' },
  { title: 'Working', has: (w) => isBusy(w.status) },
  { title: 'Ready', has: (w) => !isBusy(w.status) && !isAsleep(w.status) },
  { title: 'Asleep', has: (w) => isAsleep(w.status) },
];
function grouped(): { title: string; workers: WorkerInfo[] }[] {
  const all = [...store.workers.values()].sort((a, b) => a.createdAt - b.createdAt);
  const left = new Set(all);
  return GROUPS.map((g) => {
    const workers = [...left].filter(g.has);
    for (const w of workers) left.delete(w);
    return { title: g.title, workers };
  }).filter((g) => g.workers.length);
}
/** Workers in the order the sidebar lists them, for the arrow keys. */
const ordered = () => grouped().flatMap((g) => g.workers);

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
  agentBtn.disabled = shellBtn.disabled = dockAgent.disabled = dockShell.disabled = !up || !here || busy.has('hire');
  board.disabled = !up || !here;
  subscriptions.disabled = !up;
  content.classList.toggle('dash-stale', !up);
  content.hidden = !authorized;
  authPanel.hidden = authorized;
  floorPicker.hidden = !authorized;
  board.hidden = !authorized;
  accessLabel.textContent = credential && where !== 'local' ? `${WHERE[where].label} · paired` : WHERE[where].label;
  paintBanner();
  if (!authorized) {
    officeMap?.stop();
    thread?.activate(false);
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
  paintSide();
  if (selected && !store.workers.has(selected) && detailId === selected) {
    toast('That worker has left the floor.', 'info');
    selected = '';
  }
  const overviewing = !selected || !store.workers.get(selected);
  content.classList.toggle('dash-overviewing', overviewing);
  if (overviewing) {
    thread?.activate(false);
    paintOverview();
  } else paintWorker(store.workers.get(selected) as WorkerInfo);
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

type Rows = Map<string, { el: HTMLButtonElement; key: string }>;
/** Sidebar rows are kept per worker, so hover, focus and the selection survive repaints. */
const rows: Rows = new Map();

/** Fills `into` with the floor's workers in their groups, one row each from `cache`, lighting `lit`. */
function paintRows(into: HTMLElement, cache: Rows, lit: string, open: (id: string) => void, empty: HTMLElement[], made?: (el: HTMLButtonElement, id: string) => void) {
  const seen = new Set<string>();
  const children: HTMLElement[] = [];
  for (const g of grouped()) {
    children.push(h('div.dash-group', { class: g.title === 'Needs you' ? 'attn' : undefined }, h('span', {}, g.title), h('span.dash-group-count', {}, String(g.workers.length))));
    for (const w of g.workers) {
      seen.add(w.id);
      const key = JSON.stringify([w.name, w.color, w.status, doingLine(w), statusWord(w, STATUS_LABEL)]);
      let row = cache.get(w.id);
      if (!row || row.key !== key) {
        let el = row?.el;
        if (!el) {
          el = h('button.dash-row', { type: 'button', 'data-worker': w.id, onclick: () => open(w.id) }) as HTMLButtonElement;
          made?.(el, w.id);
        }
        el.classList.toggle('attn', w.status === 'needs_input');
        el.classList.toggle('asleep', isAsleep(w.status));
        el.title = `${w.name} · ${kind(w)}`;
        el.replaceChildren(avatar(w), h('span.dash-row-main', {}, h('span.dash-row-name', {}, w.name), h('span.dash-row-meta', {}, doingLine(w))), pill(w));
        row = { el, key };
        cache.set(w.id, row);
      }
      children.push(row.el);
    }
  }
  for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id);
  if (!seen.size) children.push(...empty);
  const focused = document.activeElement;
  const had = focused instanceof HTMLElement && into.contains(focused) ? focused.dataset.worker : undefined;
  into.replaceChildren(...children);
  if (had && document.activeElement !== cache.get(had)?.el) cache.get(had)?.el.focus({ preventScroll: true });
  lightRows(cache, lit);
}
function lightRows(cache: Rows, lit: string) {
  for (const [id, { el }] of cache) {
    el.classList.toggle('on', id === lit);
    if (cache === rows) el.setAttribute('aria-current', id === lit ? 'true' : 'false');
  }
}

function paintSide() {
  const total = store.workers.size;
  overviewRow.classList.toggle('on', !selected);
  overviewRow.setAttribute('aria-current', !selected ? 'page' : 'false');
  (overviewRow.lastElementChild as HTMLElement).textContent = total ? String(total) : '';
  paintRows(workerList, rows, selected, select, [h('p.dash-side-empty', {}, live() ? 'Nobody on this floor yet.' : 'Waiting for the office…')]);
}

function select(id: string) {
  if (selected === id) {
    if (id) rows.get(id)?.el.focus({ preventScroll: true });
    return;
  }
  if (!id && selected) leaving = selected;
  selected = id;
  paint();
  if (id) rows.get(id)?.el.scrollIntoView({ block: 'nearest' });
}

/** Opens worker `id`: on the map, the camera flies in to its desk first. */
async function enter(id: string) {
  if (flying) return;
  if (view === 'overview' && officeMap && mapShown && store.workers.has(id)) {
    flying = true;
    try {
      await officeMap.flyTo(id);
    } finally {
      flying = false;
    }
    if (view !== 'overview' || !store.workers.has(id)) return;
  }
  select(id);
}

// --- The overview: the floor in 3D (or every worker's screen in a grid) -----------------------------

const LAYOUT_KEY = 'droid-office.dashboard-layout';
let view: 'overview' | 'worker' | '' = '';
/** How the overview shows the floor: the 3D map, or the grid of screens. */
let layout: 'map' | 'grid' = read(LAYOUT_KEY) === 'grid' ? 'grid' : 'map';
let officeMap: OfficeMap | undefined;
let mapLoading = false;
/** The map can't be drawn here (no WebGL, its code failed to load, or the GPU gave up). */
let mapBroken = false;
let mapShown = false;
/** The worker whose terminal was just closed, for the map to pull back out of. */
let leaving = '';
let flying = false;
/** Who the map has lit up, mirrored in the roster. */
let mapLit = '';
let webgl: boolean | undefined;
const mapUsable = () => {
  webgl ??= (() => {
    try {
      return !!document.createElement('canvas').getContext('webgl2');
    } catch {
      return false;
    }
  })();
  return webgl && !mapBroken;
};

const cards = new Map<string, { el: HTMLElement; preview: HTMLElement; key: string }>();
const stats = h('div.dash-stats');
const grid = h('div.dash-grid');
const overviewTitle = h('h2', {});
const overviewSub = h('p.dash-overview-sub');
const overviewHead = h('header.dash-overview-head', {}, h('div.dash-overview-titles', {}, h('span.eyebrow', {}, 'Floor'), overviewTitle, overviewSub), stats);
const gridWrap = h('div.dash-grid-wrap', {}, grid);

const mapStage = h('div.dash-map', {}, h('div.dash-map-wait', {}, h('div.spinner'), h('span', {}, 'Building the floor…')));
const crew: Rows = new Map();
const rosterList = h('nav.dash-roster-list', { 'aria-label': 'Workers on this floor' });
const roster = h('aside.dash-roster', {}, rosterList);

const dockAgent = h('button.btn.accent.dash-hire', { type: 'button', title: 'Hire a Droid (N), or click a free desk to seat it there', onclick: () => hire('agent') }, icon('plus', 14), h('span', {}, 'Hire Droid'));
const dockShell = h('button.btn.dash-hire', { type: 'button', title: 'Open a plain shell at a desk', onclick: () => hire('shell') }, icon('terminal', 14), h('span', {}, 'Shell'));
const homeBtn = h('button.btn.icon.ghost', { type: 'button', 'aria-label': 'Whole floor', title: 'Whole floor (0)', onclick: () => void officeMap?.home() }, icon('frame', 15));
const zoomOut = h('button.btn.icon.ghost', { type: 'button', 'aria-label': 'Zoom out', title: 'Zoom out (−)', onclick: () => void officeMap?.zoom(1.3) }, icon('minus', 15));
const zoomIn = h('button.btn.icon.ghost', { type: 'button', 'aria-label': 'Zoom in', title: 'Zoom in (+)', onclick: () => void officeMap?.zoom(0.75) }, icon('plus', 15));
const mapTools = h('div.dash-dock-group', { role: 'group', 'aria-label': 'Camera' }, homeBtn, zoomOut, zoomIn);
const mapBtn = h('button.btn.sm', { type: 'button', title: 'The floor in 3D (G)', onclick: () => setLayout('map') }, icon('cube', 14), h('span', {}, 'Floor'));
const gridBtn = h('button.btn.sm', { type: 'button', title: 'Every screen in a grid (G)', onclick: () => setLayout('grid') }, icon('grid', 14), h('span', {}, 'Grid'));
const layoutSeg = h('div.seg.dash-layout', { role: 'group', 'aria-label': 'Layout' }, mapBtn, gridBtn);
const dockKeys = h('div.dash-dock-keys', { 'aria-hidden': 'true' });
const dock = h('div.dash-dock', { role: 'toolbar', 'aria-label': 'Overview' }, h('div.dash-dock-group', {}, dockAgent, dockShell), mapTools, h('div.dash-dock-group', {}, layoutSeg), dockKeys);
const overview = h('section.dash-overview', {}, mapStage, roster, gridWrap, dock);

/** Tells the map how much of it the roster and the dock cover, so it frames the floor beside them. */
function mapInsets() {
  if (!officeMap || !mapShown) return;
  const box = mapStage.getBoundingClientRect();
  const r = roster.getBoundingClientRect();
  const d = dock.getBoundingClientRect();
  // A roster down the left side insets the left; one docked along the bottom (narrow screens) insets the bottom.
  const beside = r.height > box.height * 0.45 || r.top < box.top + box.height * 0.4;
  const top = Math.min(d.top, beside ? Infinity : r.top);
  officeMap.setInsets(beside ? r.right - box.left : 0, box.bottom - top);
}
const insetWatch = typeof ResizeObserver === 'function' ? new ResizeObserver(() => mapInsets()) : undefined;
for (const el of [overview, roster, dock]) insetWatch?.observe(el);

function setLayout(next: 'map' | 'grid') {
  if (next === 'map' && !mapUsable()) return toast('This browser can’t draw the 3D floor (WebGL 2 is off or unavailable).', 'warn');
  if (layout === next) return;
  layout = next;
  remember(LAYOUT_KEY, next === 'grid' ? 'grid' : '');
  say(next === 'map' ? 'Showing the floor in 3D.' : 'Showing every screen in a grid.');
  paint();
}

function stat(label: string, value: number, tone = '') {
  return h('div.dash-stat', { class: tone }, h('b', {}, String(value)), h('span', {}, label));
}

function chip(w: WorkerInfo) {
  if (w.pr) return `#${w.pr.number}`;
  if (w.kind === 'agent') return modelBadge(w.activeModel ?? w.model, w.activeEffort ?? w.effort) || undefined;
  return w.worktree?.branch;
}

function mapFloor(): MapFloor | undefined {
  const here = store.currentFloor();
  if (!here) return undefined;
  return { id: here.id, name: here.name, palette: here.palette, plain: !!here.plain, bottom: store.floors[0]?.id === here.id };
}

const mapHooks: OfficeMapHooks = {
  open: (id) => void enter(id),
  hire: (deskId) => hire('agent', deskId),
  canHire: () => live() && !!store.currentFloor() && !busy.has('hire'),
  screen: (id) => store.screens.get(id),
  preview: (into, id) => renderPreview(into, id, 14),
  words: (w) => ({ status: statusWord(w, STATUS_LABEL), doing: doingLine(w), kind: kind(w), chip: chip(w) }),
  focused: (id) => {
    if (id === mapLit) return;
    mapLit = id;
    lightRows(crew, id);
  },
  lost: () => {
    mapBroken = true;
    toast('The 3D floor stopped: the browser’s graphics gave up. Showing the grid instead.', 'warn');
    paint();
  },
};

function paintOverview() {
  if (view !== 'overview') {
    terminal?.closeTerminal();
    detailId = '';
    stageMode = '';
    view = 'overview';
    mainEl.replaceChildren(overview);
  }
  const here = store.currentFloor();
  overviewTitle.textContent = store.floor === ROOF ? 'Rooftop' : (here?.name ?? 'No floor');
  overviewSub.textContent = here
    ? [here.repo ?? 'Not a git repository', here.branch && `on ${here.branch}`].filter(Boolean).join(' · ')
    : store.floors.length
      ? 'Choose a floor above.'
      : 'No floors yet. Add a project from the office itself.';
  const workers = ordered();
  const n = (f: (w: WorkerInfo) => boolean) => workers.filter(f).length;
  const needs = n((w) => w.status === 'needs_input');
  stats.replaceChildren(
    stat('Workers', workers.length),
    stat('Need you', needs, needs ? 'attn' : ''),
    stat(
      'Working',
      n((w) => w.status === 'working' || w.status === 'starting'),
    ),
    stat(
      'Asleep',
      n((w) => isAsleep(w.status)),
    ),
  );
  mapShown = layout === 'map' && mapUsable() && !!here;
  overview.dataset.layout = mapShown ? 'map' : 'grid';
  mapStage.hidden = roster.hidden = mapTools.hidden = !mapShown;
  gridWrap.hidden = mapShown;
  mapBtn.disabled = !mapUsable() || !here;
  for (const [b, on] of [
    [mapBtn, mapShown],
    [gridBtn, !mapShown],
  ] as const) {
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  dockKeys.replaceChildren(
    ...keyHints(
      mapShown
        ? [
            ['←↑↓→', 'move'],
            ['↵', 'open'],
            ['N', 'hire'],
            ['G', 'grid'],
          ]
        : [
            ['↑↓', 'open'],
            ['N', 'hire'],
            ['G', 'floor'],
          ],
    ),
  );
  const home = mapShown ? roster : gridWrap;
  if (overviewHead.parentElement !== home) home.prepend(overviewHead);
  if (mapShown) {
    paintRoster();
    void paintMap();
  } else {
    officeMap?.stop();
    leaving = '';
    paintGrid(workers);
  }
}

function paintRoster() {
  const hint = live() && store.currentFloor() ? 'Click any free desk on the floor to hire a Droid there, or press N.' : 'Waiting for the office…';
  paintRows(
    rosterList,
    crew,
    mapLit,
    (id) => void enter(id),
    [h('div.dash-roster-empty', {}, h('b', {}, 'Nobody on this floor yet'), h('p', {}, hint))],
    (el, id) => {
      el.addEventListener('pointerenter', () => officeMap?.setCursor(id, false));
      el.addEventListener('pointerleave', () => {
        if (document.activeElement !== el) officeMap?.setCursor('', false);
      });
      el.addEventListener('focus', () => {
        if (officeMap?.focusedId !== id) officeMap?.setCursor(id);
      });
    },
  );
}

async function paintMap() {
  if (!officeMap) {
    if (mapLoading) return;
    mapLoading = true;
    try {
      const { OfficeMap } = await import('./office-map');
      officeMap = new OfficeMap(mapHooks);
      mapStage.replaceChildren(officeMap.el);
    } catch (error) {
      console.warn('office map unavailable', error);
      mapBroken = true;
      toast('The 3D floor couldn’t load. Showing the grid instead.', 'warn');
    } finally {
      mapLoading = false;
    }
    // The page may have moved on while the map's code was loading.
    paint();
    return;
  }
  if (view !== 'overview' || !mapShown) return;
  // Drawing first, so the first look at a floor plays as a flight rather than a jump.
  mapInsets();
  officeMap.start();
  officeMap.sync(store.workers.values(), mapFloor());
  if (leaving) {
    const id = leaving;
    leaving = '';
    void officeMap.returnFrom(id);
  }
}

function paintGrid(workers: WorkerInfo[]) {
  const here = store.currentFloor();
  const seen = new Set<string>();
  const children: HTMLElement[] = [];
  for (const w of workers) {
    seen.add(w.id);
    const key = JSON.stringify([w.name, w.color, w.status, doingLine(w), kind(w), w.worktree?.branch, w.pr?.number, w.activeModel ?? w.model, statusWord(w, STATUS_LABEL)]);
    let card = cards.get(w.id);
    if (!card) {
      const preview = h('pre.dash-preview', { 'aria-hidden': 'true' });
      const el = h('button.dash-card', { type: 'button', 'data-worker': w.id, onclick: () => select(w.id) });
      card = { el, preview, key: '' };
      cards.set(w.id, card);
    }
    if (card.key !== key) {
      card.key = key;
      const model = w.kind === 'agent' ? modelBadge(w.activeModel ?? w.model, w.activeEffort ?? w.effort) : '';
      card.el.classList.toggle('attn', w.status === 'needs_input');
      card.el.classList.toggle('asleep', isAsleep(w.status));
      card.el.setAttribute('aria-label', `${w.name}, ${statusWord(w, STATUS_LABEL)}: ${doingLine(w)}`);
      card.el.replaceChildren(
        h(
          'span.dash-card-head',
          {},
          avatar(w),
          h('span.dash-card-titles', {}, h('span.dash-card-name', {}, w.name), h('span.dash-card-kind', {}, kind(w), model ? ' · ' : null, model ? modelBadgeNode(w.activeModel ?? w.model, w.activeEffort ?? w.effort) : null)),
          pill(w),
        ),
        card.preview,
        h(
          'span.dash-card-foot',
          {},
          h('span.dash-card-doing', { title: doingLine(w) }, doingLine(w)),
          w.pr ? h('span.dash-chip', {}, icon('pr', 12), `#${w.pr.number}`) : w.worktree ? h('span.dash-chip', { title: w.worktree.branch }, icon('pr', 12), w.worktree.branch) : null,
        ),
      );
    }
    children.push(card.el);
  }
  for (const id of [...cards.keys()]) if (!seen.has(id)) cards.delete(id);
  if (!workers.length) {
    const hireHere = h('button.btn.accent', { type: 'button', disabled: !live() || !here, onclick: () => hire('agent') }, icon('plus', 14), 'Hire Droid');
    children.push(
      h('div.dash-grid-empty', {}, emptyState('', here ? 'Nobody on this floor yet' : 'No floor to show', here ? 'Hire a Droid and its live terminal shows up here.' : 'Add a project in the office first.', here ? hireHere : undefined)),
    );
  }
  grid.replaceChildren(...children);
  paintPreviews();
}
let previewFrame = 0;
let previewAt = 0;
function schedulePreviews() {
  if ((view === 'worker' && stageMode === 'terminal') || (view === 'overview' && mapShown)) return;
  if (previewFrame) return;
  // Screens stream a few times a second per worker; a quarter second is plenty for a glance.
  const wait = Math.max(0, 250 - (performance.now() - previewAt));
  previewFrame = window.setTimeout(() => {
    previewFrame = 0;
    previewAt = performance.now();
    paintPreviews();
  }, wait);
}
function renderPreview(into: HTMLElement, id: string, max: number) {
  const s = store.screens.get(id);
  if (!s) {
    into.replaceChildren(h('span.dash-preview-none', {}, 'No screen yet'));
    return;
  }
  into.style.setProperty('--cols', String(Math.max(20, s.cols)));
  into.replaceChildren(
    ...previewRows(s.lines, s.rows, max).map((row) =>
      h(
        'span.dash-preview-row',
        {},
        ...row.map((r) => {
          if (!r.color && !r.background && !r.bold && !r.dim) return r.text;
          const span = h('span', { class: [r.bold ? 'b' : '', r.dim ? 'd' : ''].join(' ').trim() || undefined }, r.text);
          if (r.color) span.style.color = r.color;
          if (r.background) span.style.background = r.background;
          return span;
        }),
      ),
    ),
  );
}
function paintPreviews() {
  if (view === 'overview' && !mapShown) for (const [id, card] of cards) renderPreview(card.preview, id, 30);
  else if (view === 'worker' && stageMode === 'info' && infoPreview && detailId) renderPreview(infoPreview, detailId, 40);
}

// --- One worker: its terminal, with its controls on top --------------------------------------------

let detailId = '';
let stageMode = '';
let thread: WorkerThread | undefined;
let workerView = read('droid-office.companion-view') === 'thread' ? 'thread' : 'terminal';
let viewToggle: HTMLElement;
let stage: HTMLElement;
let controls: HTMLElement;
let question: HTMLElement;
let infoPreview: HTMLElement | undefined;
let infoName: HTMLElement;
let infoMeta: HTMLElement;
let infoActivity: HTMLElement;
let infoHead: HTMLElement;
let shownMenu: Menu | undefined;
let questionKey = '';
let questionDraft = '';
let answered = false;
let questionReplying = false;
let answerSettlesAt = 0;

function paintWorker(w: WorkerInfo) {
  if (view !== 'worker') officeMap?.stop();
  view = 'worker';
  if (detailId !== w.id) {
    thread?.dispose();
    thread = undefined;
    terminal?.closeTerminal();
    detailId = w.id;
    stageMode = '';
    shownMenu = undefined;
    questionKey = '';
    questionDraft = read(draftKey(floor, `${w.id}:answer`));
    answered = false;
    questionReplying = false;
    answerSettlesAt = 0;
    controls = h('div.dash-controls', { role: 'group', 'aria-label': 'Worker actions' });
    question = h('section.dash-question', { 'aria-label': 'Question requiring input', hidden: true });
    stage = h('div.dash-stage');
    viewToggle = h('div.seg.dash-view-toggle', { role: 'group', 'aria-label': 'Worker view' });
    mainEl.replaceChildren(h('div.dash-worker', {}, viewToggle, question, stage));
  }
  const local = !w.guest && !w.cloud;
  const threaded = local && w.kind === 'agent' && workerView === 'thread';
  viewToggle.hidden = !local || w.kind !== 'agent';
  viewToggle.replaceChildren(
    ...(threaded ? [h('button.btn.dash-thread-back', { type: 'button', onclick: () => select('') }, 'All workers')] : []),
    ...(['thread', 'terminal'] as const).map((value) =>
      h(
        'button',
        {
          type: 'button',
          class: `btn ${(threaded ? 'thread' : 'terminal') === value ? 'on' : ''}`,
          'aria-pressed': String((threaded ? 'thread' : 'terminal') === value),
          onclick: () => {
            workerView = value;
            remember('droid-office.companion-view', value);
            paint();
          },
        },
        value === 'thread' ? 'Thread' : 'Raw TTY',
      ),
    ),
  );
  // Anything without a local terminal to show (outside the office, in Factory, asleep) gets what the office knows of it.
  const mode = threaded ? 'thread' : local && !isAsleep(w.status) ? 'terminal' : 'info';
  if (mode !== stageMode) {
    stageMode = mode;
    thread?.activate(false);
    terminal?.closeTerminal();
    infoPreview = undefined;
    if (mode === 'info') {
      infoName = h('h2');
      infoActivity = h('p.dash-info-activity');
      infoMeta = h('dl.dash-meta');
      infoHead = h('div.dash-info-who');
      const s = store.screens.get(w.id);
      infoPreview = s ? h('pre.dash-preview.big', { 'aria-label': `${w.name}’s screen` }) : undefined;
      stage.replaceChildren(h('div.dash-info', {}, h('header.dash-info-head', {}, infoHead, controls), infoActivity, infoPreview ?? null, infoMeta));
    } else if (mode === 'thread') {
      const intended = floor;
      const key = draftKey(intended, w.id);
      thread ??= mountWorkerThread(net, {
        worker: w,
        controls,
        question,
        queueKey: `${key}:queue-receipts`,
        draft: read(key),
        onDraft: (text) => remember(key, text),
        send: (msg) => action(msg, w.id, intended),
        team: () => (floor === intended ? [...store.workers.values()] : []),
        openWorker: (id) => {
          if (!usable(id, intended)) return;
          workerView = 'thread';
          select(id);
        },
        raw: () => {
          workerView = 'terminal';
          remember('droid-office.companion-view', 'terminal');
          paint();
        },
      });
      stage.replaceChildren(thread.element);
      thread.activate(true);
    } else stage.replaceChildren(h('div.dash-stage-wait', {}, h('div.spinner'), h('span', {}, 'Opening the terminal…')));
  }
  if (mode !== 'thread') {
    if (question.nextElementSibling !== stage) stage.before(question);
  } else {
    const reading = thread?.element.querySelector('.wt-scroll');
    if (reading && question.parentElement !== reading) reading.append(question);
  }
  if (mode === 'terminal') void showTerminal(w.id, stage);
  else if (mode === 'thread') {
    thread?.activate(true);
    thread?.update(w, live());
  } else paintInfo(w);
  paintControls(w);
  paintQuestion();
}

function paintControls(w: WorkerInfo) {
  const enabled = live() && !busy.has(w.id);
  const btn = (label: string, glyph: IconName, ok: boolean, run: () => void, cls = '', tip = '') =>
    h('button.btn', { type: 'button', class: cls, title: tip || label, 'aria-label': label, disabled: !enabled || !ok, onclick: run }, icon(glyph, 14), h('span', {}, label));
  const asleep = isAsleep(w.status);
  const local = !w.guest && !w.cloud;
  controls.replaceChildren(
    ...(w.cloud && w.sessionId ? [h('a.btn', { href: sessionWebUrl(w.sessionId), target: '_blank', rel: 'noopener noreferrer' }, icon('external', 14), h('span', {}, 'Factory session'))] : []),
    asleep && !w.guest
      ? btn(w.kind === 'shell' ? 'Restart' : 'Resume', 'play', !w.lost, () => void action({ t: 'worker.resume', workerId: w.id }, w.id, floor, `${w.name} is waking up.`).then(warn), stageMode === 'thread' ? 'ghost dash-resume' : 'primary')
      : btn(w.kind === 'shell' ? 'Command' : 'Prompt', 'message', !w.guest && !w.lost, () => prompt(w), stageMode === 'thread' ? 'ghost' : 'primary', w.kind === 'shell' ? 'Send a command (P)' : 'Send a prompt (P)'),
    ...(w.pr
      ? [h('a.btn', { href: safeLink(w.pr.url), target: '_blank', rel: 'noopener noreferrer', title: `Pull request #${w.pr.number}` }, icon('pr', 14), h('span', {}, `#${w.pr.number}`))]
      : local && w.worktree
        ? [btn('Open PR', 'pr', !w.lost && !w.prOpening && !isBusy(w.status), () => void action({ t: 'worker.pr', workerId: w.id }, w.id, floor, 'Opening a pull request…').then(warn), '', 'Push its branch and open a pull request')]
        : []),
    btn('Send home', 'home', !w.guest, () => sendHome(w), 'ghost dash-home', 'Send it home'),
  );
}
const warn = (error: string | undefined) => {
  if (error) toast(error, 'warn');
};

function paintInfo(w: WorkerInfo) {
  infoHead.replaceChildren(avatar(w, 'lg'), h('div', {}, h('div.dash-info-name', {}, infoName, pill(w)), h('div.dash-info-kind', {}, kind(w))));
  infoName.textContent = w.name;
  infoActivity.textContent = w.activity ?? w.task?.summary ?? w.prompt ?? 'Waiting for a task.';
  const lead = w.lead && store.workers.get(w.lead);
  const team = store.teamOf(w.id);
  const info: [string, string | undefined][] = [
    ['Model', w.kind === 'agent' ? modelBadge(w.activeModel ?? w.model, w.activeEffort ?? w.effort) : undefined],
    ['Task', w.task?.name ?? w.title],
    ['Branch', w.worktree?.branch ?? store.currentFloor()?.branch],
    ['Worktree', w.worktree?.path],
    [
      'Where',
      w.lost
        ? 'Its worktree is missing, so it can’t resume or take prompts.'
        : w.guest
          ? 'Running outside the office. Use its own terminal.'
          : w.cloud
            ? `On Factory · ${w.cloud.computerName}. No local terminal.`
            : isAsleep(w.status)
              ? 'Asleep. Resume it to see its terminal and prompt it.'
              : 'A local terminal',
    ],
    ['Lead', lead ? lead.name : w.lead ? 'No longer on this floor' : undefined],
    ['Subagents', team.length ? team.map((s) => s.name).join(', ') : undefined],
    ['Other projects', w.repos?.map((r) => `${r.name} · ${r.branch}`).join(', ')],
  ];
  infoMeta.replaceChildren(...info.filter(([, v]) => !!v).flatMap(([label, value]) => [h('dt', {}, label), h('dd', { title: value }, label === 'Model' ? modelBadgeNode(w.activeModel ?? w.model, w.activeEffort ?? w.effort) : value)]));
  if (infoPreview) renderPreview(infoPreview, w.id, 40);
}

function safeLink(url: string) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '#';
  } catch {
    return '#';
  }
}
function lines(id: string) {
  const s = store.screens.get(id);
  return s && Array.from({ length: s.rows }, (_, i) => (s.lines[i] ?? []).map((r) => r[0]).join(''));
}
function paintQuestion(review = false) {
  const w = store.workers.get(detailId);
  if (!w || !question || view !== 'worker') return;
  const screen = lines(w.id);
  const next = screen && canAnswer(w, screen) ? readMenu(screen) : undefined;
  if (w.status !== 'needs_input') {
    shownMenu = undefined;
    answered = false;
  }
  if ((!shownMenu && next) || review) {
    shownMenu = next;
    answered = false;
  }
  const current = sameMenu(shownMenu, next);
  const settling = questionReplying || Date.now() < answerSettlesAt;
  const key = JSON.stringify([shownMenu, current, live(), busy.has(w.id), answered, questionReplying, settling, w.status]);
  if (key === questionKey) return;
  questionKey = key;
  question.hidden = !shownMenu && w.status !== 'needs_input';
  const enabled = live() && current && !busy.has(w.id) && !answered && !questionReplying;
  if (!shownMenu) {
    if (settling) {
      question.replaceChildren(h('div.dash-question-card.quiet', { role: 'status' }, h('p', {}, questionReplying ? 'Sending your answer…' : 'Answer sent. Waiting for the worker’s next move.')));
      return;
    }
    question.replaceChildren(
      h(
        'div.dash-question-card.quiet',
        {},
        h('span.dash-question-icon', {}, icon('alert', 16)),
        h(
          'p',
          {},
          h('b', {}, `${w.name} needs you. `),
          w.cloud
            ? 'There is no local menu to answer: open its Factory session.'
            : w.guest
              ? 'Answer it in its own terminal; the office won’t type for it.'
              : stageMode === 'thread'
                ? 'This CLI dialog cannot be answered safely here. Open Raw TTY to continue.'
                : 'Its screen has no menu the companion can answer safely. Answer it in the terminal below.',
        ),
      ),
    );
    return;
  }
  const menu = shownMenu;
  const text = h('textarea.input', { rows: 2, 'aria-label': 'Typed answer', placeholder: 'Type an answer…' });
  text.value = questionDraft;
  text.addEventListener('input', () => {
    questionDraft = text.value;
    remember(draftKey(floor, `${w.id}:answer`), questionDraft);
  });
  const reply = async (value: { choice?: number; text?: string }) => {
    questionReplying = true;
    questionKey = '';
    paintQuestion();
    const error = await action({ t: 'worker.answer', workerId: w.id, menu, ...value }, w.id, floor, 'Answer sent.');
    if (detailId !== w.id) return;
    questionReplying = false;
    if (error) {
      answerSettlesAt = 0;
      toast(error, 'warn');
    } else {
      answered = true;
      const until = Date.now() + 3000;
      answerSettlesAt = until;
      setTimeout(() => {
        if (detailId !== w.id || answerSettlesAt !== until) return;
        questionKey = '';
        paintQuestion();
      }, 3000);
      questionDraft = '';
      remember(draftKey(floor, `${w.id}:answer`), '');
    }
    questionKey = '';
    paintQuestion();
  };
  question.replaceChildren(
    h(
      'div.dash-question-card',
      {},
      h('div.dash-question-top', {}, h('span.eyebrow', {}, `${w.name} needs your answer`), answered ? h('span.pill.done', {}, 'Sent') : null),
      h('h3', {}, menu.question ?? 'Choose an answer'),
      h(
        'div.dash-choices',
        {},
        ...menu.choices.map((c) =>
          h(
            'button.dash-choice',
            { type: 'button', disabled: !enabled, onclick: () => void reply({ choice: c.number }) },
            h('span.key', {}, String(c.number)),
            h('span.dash-choice-text', {}, h('span', {}, c.label), c.description ? h('small', {}, c.description) : null),
          ),
        ),
      ),
      ...(menuTakesText(menu) ? [h('div.input-group.dash-answer', {}, text, h('button.btn.primary', { type: 'button', disabled: !enabled, onclick: () => void reply({ text: text.value }) }, 'Send'))] : []),
      questionReplying
        ? h('p.note.info', {}, 'Sending your answer…')
        : answered
          ? h('p.note.info', {}, 'Answer sent. Waiting for the worker’s next move.')
          : !current
            ? h('p.note.warn', {}, 'The question changed or was answered elsewhere. Your text is kept; look at the current question before sending anything.')
            : null,
      !current && next
        ? h(
            'button.btn',
            {
              type: 'button',
              onclick: () => {
                questionKey = '';
                paintQuestion(true);
              },
            },
            'Show the current question',
          )
        : null,
    ),
  );
}

// --- Actions ------------------------------------------------------------------------------------------

function hire(kind: 'agent' | 'shell', deskId = 'auto') {
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
      const error = await action({ t: 'worker.spawn', deskId, kind, prompt: text, ...opts }, '', intended, kind === 'shell' ? 'Shell opened.' : 'Droid hired.');
      if (!error) remember(key, '');
      return error;
    },
  });
}
function prompt(w: WorkerInfo) {
  if (stageMode === 'thread' && w.status === 'needs_input') {
    toast('Answer the current question, or open Raw TTY for this CLI dialog.', 'warn');
    return;
  }
  const intended = floor;
  const key = draftKey(intended, w.id);
  openPrompt({
    title: w.kind === 'shell' ? `Command · ${w.name}` : `Prompt · ${w.name}`,
    initial: read(key),
    onDraft: (v) => remember(key, v),
    imagesOption: w.kind !== 'shell',
    recall: w.kind !== 'shell',
    queueOption: w.kind === 'agent',
    onSubmit: async (text, opts) => {
      if (stageMode === 'thread' && (store.workers.get(w.id)?.status === 'needs_input' || text.trimStart().startsWith('/'))) return 'Use Raw TTY for CLI dialogs and slash commands. Your draft is kept.';
      const error = await action({ t: 'worker.prompt', workerId: w.id, prompt: text, images: opts.images, queue: opts.queue }, w.id, intended, `Sent to ${w.name}.`);
      if (!error) remember(key, '');
      return error;
    },
  });
}
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
async function showTerminal(id: string, mount: HTMLElement) {
  const intended = floor;
  if (!terminal) {
    terminal = await import('./ui/terminal');
    terminal.onOpenTeammate((mate) => select(mate));
  }
  if (stageMode !== 'terminal' || terminal.openTerminalFor() === id || selected !== id || !mount.isConnected || !usable(id, intended)) return;
  terminal.openTerminal(net, id, undefined, undefined, { mount, actions: controls, onLeave: () => rows.get(id)?.el.focus() });
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
  if (view === 'overview' && officeMap && mapShown && mapKey(officeMap, k, t)) {
    e.preventDefault();
    return;
  }
  if (k === 'g' && view === 'overview') setLayout(layout === 'map' ? 'grid' : 'map');
  else if (k === 'ArrowDown' || k === 'j') go(at + 1);
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

const MAP_MOVES: Record<string, MapDirection> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', h: 'left', l: 'right', k: 'up', j: 'down' };
/** The overview's keys while the 3D floor is up; false for a key it doesn't use. */
function mapKey(map: OfficeMap, k: string, target: HTMLElement | null): boolean {
  const dir = MAP_MOVES[k];
  if (dir) {
    const id = map.move(dir);
    const w = id && store.workers.get(id);
    if (w) say(`${w.name}, ${statusWord(w, STATUS_LABEL)}: ${doingLine(w)}. Enter opens it.`);
  } else if (k === 'Enter' && !target?.closest('button, a')) {
    if (!map.focusedId) return false;
    void enter(map.focusedId);
  } else if (k === 'Escape' && map.focusedId) map.setCursor('', false);
  else if (k === '0' || k === 'Home') void map.home();
  else if (k === '+' || k === '=') void map.zoom(0.75);
  else if (k === '-' || k === '_') void map.zoom(1.3);
  else return false;
  return true;
}

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
