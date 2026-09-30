/**
 * The office on a headset's panel (`/?native=1`): the headset app draws the 3D office itself, and
 * the page's DOM (the top bar, the ☰ menu, every window) shows on a flat panel in front of you.
 *
 * initNativeUi hides what only makes sense over the page's own 3D view (the canvas, crosshair,
 * hints, waiting pins), makes the controls big enough to aim at with a controller, starts terminals at a size
 * readable in the headset, and adds two things the desktop doesn't need:
 * - a home screen on the panel: the floor, the workers, and every ☰ menu action as a large tile;
 * - a keyboard docked on the panel for controller input (native/keyboard.ts).
 *
 * The panel is "open" while it has something to show: the home screen, any window or the ☰ menu,
 * the floor list, or a focused text field (the chat). The headset app reads panelState() and hears
 * changes through onPanelChange (or the `droid-office:native-panel` window event).
 */

import './native.css';
import { STATUS_LABEL, closeAllModals, h, modalOpen, onModalChange } from '../ui/dom';
import { actionIcon, actionLabel, actionOffered, hudActions, onHudRender, type HudAction } from '../ui/menu';
import { closeFloorMenu, floorMenuOpen } from '../ui/floormenu';
import { openTerminalSink } from '../ui/terminal';
import { useNativeTermFont } from '../ui/term-font';
import { providerLabel } from '../ui/provider';
import { store, type Topic } from '../state';
import { DESK_BY_ID, nextFreeSeat } from '../../shared/layout';
import { isAsleep, isBusy } from '../../shared/status';
import { ROOF, ROOF_NAME } from '../../shared/rooftop';
import type { CarriedIssue, WorkerInfo } from '../../shared/protocol';
import { mountKeyboard, type PanelKeyboard } from './keyboard';
import { isNativeSearch } from './mode';
import { nativePerformanceLabel } from './performance';
import { openNativeGraphicsSettings } from './graphics';
import { mountNativeTooltips } from './tooltips';

export { isNativeSearch };

/** The page was opened for a headset's panel. */
export function isNativeMode(): boolean {
  return isNativeSearch(location.search);
}

export interface NativePanelState {
  /** Whether the panel has something to show (any of the below). */
  open: boolean;
  /** The home screen is up. */
  home: boolean;
  /** A window or the ☰ menu is open. */
  modal: boolean;
  /** The floor list under the project name is open. */
  floorMenu: boolean;
  /** A text field has focus (the chat, a window's field). */
  typing: boolean;
  /** The panel's keyboard is showing. */
  keyboard: boolean;
  /** The worker whose terminal is open, if any. */
  terminal: string | null;
  /** The original shared board card carried by this player. */
  carrying: CarriedIssue | null;
}

/** These callbacks use main.ts's original desktop helpers and their confirmations. */
export interface NativeWorkerActions {
  prompt?(workerId: string): void;
  resume?(workerId: string): void;
  changes?(workerId: string): void;
  pullRequest?(workerId: string): void;
  sendHome?(workerId: string): void;
}

export interface NativeUiOptions {
  /** Opens a worker's terminal the way the desktop does (waking it if it's asleep): main.ts's openWorkerTerminal. */
  openWorker?: (workerId: string) => void;
  /** Whether the home screen shows at start (default true). */
  home?: boolean;
  workerActions?: NativeWorkerActions;
  hireAtDesk?(deskId: string): void;
  openShell?(deskId: string): void;
  putBack?(): void;
}

export interface NativeUi {
  panelState(): NativePanelState;
  /** Hears every change of panelState; returns the unlisten. */
  onPanelChange(fn: (state: NativePanelState) => void): () => void;
  /** Shows the home screen, or with false clears the panel: every window, the menu, the floor list and the keyboard. */
  setPanelOpen(open: boolean): void;
  togglePanel(): void;
  showHome(on: boolean): void;
  keyboard: PanelKeyboard;
  toggleKeyboard(): void;
  /** Refreshes the home status from native measurements; unavailable data stays hidden. */
  updatePerformance(metrics: unknown): void;
  setCarrying(card: CarriedIssue | null): void;
}

export const PANEL_EVENT = 'droid-office:native-panel';

/** ☰ menu actions the headset's panel leaves off its home screen: WebXR is the page's own headset mode. */
const NOT_ON_PANEL = new Set(['entervr']);

let instance: NativeUi | null = null;

/** Sets up the headset panel's presentation. Call once, early, only on `/?native=1` (see isNativeMode). Calling it again returns the same one. */
export function initNativeUi(opts: NativeUiOptions = {}): NativeUi {
  if (instance) return instance;
  document.documentElement.classList.add('native-xr');
  document.body.classList.add('native-xr');
  useNativeTermFont();
  noPointerLock();
  mountNativeTooltips();
  document.getElementById('chat-input')?.setAttribute('placeholder', 'Chat with the office');

  const listeners = new Set<(s: NativePanelState) => void>();
  let homeOn = opts.home ?? true;
  let lastKey = '';
  let carrying: CarriedIssue | null = null;

  const typingNow = () => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el.closest('.native-kb')) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
  };
  const panelState = (): NativePanelState => {
    const modal = modalOpen();
    const floorMenu = floorMenuOpen();
    const typing = typingNow();
    return { open: homeOn || modal || floorMenu || typing, home: homeOn, modal, floorMenu, typing, keyboard: keyboard?.shown() ?? false, terminal: openTerminalSink()?.workerId ?? null, carrying };
  };
  const notify = () => {
    decorateNativeMenu();
    const s = panelState();
    const key = JSON.stringify(s);
    if (key === lastKey) return;
    lastKey = key;
    document.body.classList.toggle('native-home-on', s.home);
    document.body.classList.toggle('native-workspace-closed', !s.open);
    for (const fn of listeners) fn(s);
    window.dispatchEvent(new CustomEvent(PANEL_EVENT, { detail: s }));
  };
  // Listeners run after the change they hear about has settled (a window closing, focus moving on).
  let queued = false;
  const soon = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      notify();
    });
  };

  const keyboard: PanelKeyboard = mountKeyboard({ terminal: openTerminalSink, storageKey: 'droid-office.native-keyboard', onVisibility: soon });

  const home = buildHome({
    openWorker: (id) => (opts.openWorker ? opts.openWorker(id) : openFromHud(id)),
    close: () => setPanelOpen(false),
    toggleKeyboard: () => keyboard.toggle(),
    workerActions: opts.workerActions,
    hireAtDesk: opts.hireAtDesk,
    openShell: opts.openShell,
    putBack: opts.putBack,
  });

  function showHome(on: boolean) {
    homeOn = on;
    home.el.classList.toggle('hidden', !on);
    if (on) home.render();
    soon();
  }

  function setPanelOpen(open: boolean) {
    if (open) return showHome(true);
    closeAllModals();
    if (floorMenuOpen()) closeFloorMenu();
    (document.activeElement as HTMLElement | null)?.blur?.();
    keyboard.show(false);
    showHome(false);
  }

  onModalChange(soon);
  // A field (or a terminal) taking focus brings the keyboard up, as a phone's does; Hide puts it away.
  document.addEventListener('focusin', (e) => {
    const el = e.target as HTMLElement;
    if (el.closest('.native-kb')) return;
    const editable = el.tagName === 'TEXTAREA' || el.isContentEditable || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button', 'submit', 'color', 'file'].includes(el.type));
    if (editable && !el.hasAttribute('readonly') && !keyboard.shown()) keyboard.show(true);
  });
  document.addEventListener('focusin', soon);
  document.addEventListener('focusout', soon);
  // The floor list and the ☰ menu come and go as elements, without a store topic.
  new MutationObserver(soon).observe(document.body, { childList: true });
  new MutationObserver(soon).observe(document.getElementById('modal-root') ?? document.body, { childList: true });

  const repaint = () => {
    if (homeOn) home.render();
  };
  onHudRender(repaint);
  for (const t of ['workers', 'floors', 'floor', 'project', 'peers', 'me'] as Topic[]) store.on(t, repaint);
  showHome(homeOn);

  instance = {
    panelState,
    onPanelChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    setPanelOpen,
    togglePanel: () => setPanelOpen(!panelState().open),
    showHome,
    keyboard,
    toggleKeyboard: () => keyboard.toggle(),
    updatePerformance: (metrics) => home.updatePerformance(metrics),
    setCarrying(card) {
      if ((carrying?.issue ?? 0) === (card?.issue ?? 0) && (carrying?.title ?? '') === (card?.title ?? '')) return;
      carrying = card ? { issue: card.issue, title: card.title } : null;
      home.setCarrying(carrying);
      soon();
    },
  };
  return instance;
}

/**
 * The panel's pointer is the controller's ray, never a mouse to capture. A pointer lock
 * taken on the hidden 3D view (the desktop takes one when a window closes) would send every tap
 * after it to the view, as a click at its crosshair, and none to the panel. Without
 * requestPointerLock the player's canLock is false, so it stops asking.
 */
function noPointerLock() {
  const scene = document.getElementById('scene');
  if (scene) Object.defineProperty(scene, 'requestPointerLock', { configurable: true, value: undefined });
  const release = () => {
    if (document.pointerLockElement) document.exitPointerLock();
  };
  document.addEventListener('pointerlockchange', release);
  release();
}

/**
 * Opens a worker's terminal through the Workers panel's own row (main.ts wires those rows to open
 * the terminal and wake a sleeping worker). Its rows are in hiring order, like the home screen's.
 */
function openFromHud(workerId: string) {
  const order = sortedWorkers().map((w) => w.id);
  const i = order.indexOf(workerId);
  const row = document.querySelectorAll<HTMLElement>('#workers > li:not(.empty)')[i];
  row?.click();
}

function sortedWorkers(): WorkerInfo[] {
  return [...store.workers.values()].sort((a, b) => a.createdAt - b.createdAt);
}

interface HomeActions {
  openWorker(id: string): void;
  close(): void;
  toggleKeyboard(): void;
  workerActions?: NativeWorkerActions;
  hireAtDesk?(deskId: string): void;
  openShell?(deskId: string): void;
  putBack?(): void;
}

function buildHome(actions: HomeActions) {
  const floorName = h('h2.nh-floor');
  const floorMeta = h('p.nh-meta');
  const performance = h('p.nh-performance.hidden', { role: 'status', 'aria-live': 'polite' });
  const carriedText = h('span');
  const putBack = h('button.btn', { type: 'button', onclick: () => actions.putBack?.() }, 'Put back');
  putBack.classList.toggle('hidden', !actions.putBack);
  const carried = h('div.nh-carried.hidden', { role: 'status' }, carriedText, putBack);
  const workersEl = h('ul.nh-workers', { 'aria-label': 'Workers' });
  const workersCount = h('span.count');
  const tilesEl = h('div.nh-tiles', { role: 'group', 'aria-label': 'Office' });
  const freeSeat = () => (store.floor && store.floor !== ROOF ? nextFreeSeat((id) => !!store.workerAtDesk(id)) : undefined);
  const hireBtn = h(
    'button.btn',
    {
      type: 'button',
      onclick: () => {
        const desk = freeSeat();
        if (desk) actions.hireAtDesk?.(desk.id);
      },
    },
    'Hire a worker',
  );
  const shellBtn = h(
    'button.btn',
    {
      type: 'button',
      onclick: () => {
        const desk = freeSeat();
        if (desk) actions.openShell?.(desk.id);
      },
    },
    'Open a shell',
  );
  const hireRow = h('div.nh-hire', { role: 'group', 'aria-label': 'New worker' }, hireBtn, shellBtn);
  hireRow.classList.toggle('hidden', !actions.hireAtDesk && !actions.openShell);
  hireBtn.classList.toggle('hidden', !actions.hireAtDesk);
  shellBtn.classList.toggle('hidden', !actions.openShell);
  const kbBtn = h('button.btn.nh-kb', { type: 'button', onclick: () => actions.toggleKeyboard() }, '⌨️ Keyboard');
  const closeBtn = h('button.btn.nh-close', { type: 'button', title: 'Hide the panel and go back to the office', onclick: () => actions.close() }, 'Back to the office');
  const el = h(
    'section.native-home.hidden',
    { 'aria-label': 'Home' },
    h('header.nh-head', {}, h('div.nh-where', {}, floorName, floorMeta, performance), kbBtn, closeBtn),
    carried,
    h('div.nh-body', {}, h('section.nh-col.nh-workers-col', {}, h('h3', {}, h('span.no', {}, '01'), 'Workers', workersCount), hireRow, workersEl), h('section.nh-col', {}, h('h3', {}, h('span.no', {}, '02'), 'Office'), tilesEl)),
  );
  document.getElementById('hud')?.prepend(el);

  const tile = (a: HudAction) => {
    const blocked = a.blocked?.();
    const n = a.count?.();
    return h(
      'button.btn.nh-tile',
      {
        type: 'button',
        class: [a.on?.() && 'on', a.tone?.(), blocked && 'dim'].filter(Boolean).join(' '),
        title: blocked ?? a.title?.() ?? actionLabel(a),
        'data-action': a.id,
        onclick: () => a.run(),
      },
      h('span.nh-icon', { 'aria-hidden': 'true' }, actionIcon(a)),
      h('span.nh-label', {}, actionLabel(a)),
      n ? h('span.svc-count', {}, String(n)) : null,
    );
  };

  // One row per worker for as long as it's hired, its insides redrawn in place: a worker's activity
  // changes every second or so, and a row swapped out between press and release loses the tap.
  const rows = new Map<string, { li: HTMLElement; btn: HTMLElement; actions: Map<keyof NativeWorkerActions, HTMLButtonElement>; key: string }>();
  const emptyRow = h('li.empty', {}, 'No workers on this floor yet. Hire a worker here or walk up to a desk.');
  const workerRow = (w: WorkerInfo) => {
    const agent = w.kind === 'agent' ? providerLabel(w.provider, store.project) : 'Shell';
    const desk = DESK_BY_ID.get(w.deskId)?.label;
    const sub = [agent, desk, w.worktree && `🌿 ${w.worktree.branch}`, w.task?.name ?? w.title ?? w.activity].filter(Boolean).join(' · ');
    const status = STATUS_LABEL[w.status] ?? w.status;
    const key = [w.name, w.color, w.status, status, sub].join('\n');
    let row = rows.get(w.id);
    if (!row) {
      const btn = h('button.nh-worker', { type: 'button', onclick: () => actions.openWorker(w.id) });
      const buttons = new Map<keyof NativeWorkerActions, HTMLButtonElement>();
      const group = h('div.nh-worker-actions', { role: 'group', 'aria-label': `Actions for ${w.name}` });
      for (const [action, label] of [
        ['prompt', 'Prompt'],
        ['resume', 'Resume'],
        ['changes', 'Changes'],
        ['pullRequest', 'Pull request'],
        ['sendHome', 'Send home'],
      ] as const) {
        const run = actions.workerActions?.[action];
        if (!run) continue;
        const button = h(
          'button.btn',
          {
            type: 'button',
            'data-worker-action': action,
            onclick: () => {
              if (store.workers.has(w.id)) run(w.id);
            },
          },
          label,
        );
        buttons.set(action, button);
        group.append(button);
      }
      row = { li: h('li', {}, btn, group), btn, actions: buttons, key: '' };
      rows.set(w.id, row);
    }
    const asleep = isAsleep(w.status);
    const station = !!DESK_BY_ID.get(w.deskId)?.station;
    const prompt = row.actions.get('prompt');
    prompt?.toggleAttribute('disabled', asleep && !station);
    prompt?.setAttribute('title', asleep && !station ? 'Resume this worker before sending a prompt' : `Send a prompt to ${w.name}`);
    row.actions.get('resume')?.classList.toggle('hidden', !asleep);
    const pr = row.actions.get('pullRequest');
    pr?.classList.toggle('hidden', station || (!w.pr && !w.worktree));
    pr?.toggleAttribute('disabled', !w.pr && (isBusy(w.status) || !!w.prOpening));
    if (pr) pr.textContent = w.pr ? 'View pull request' : 'Open pull request';
    row.li.querySelector('.nh-worker-actions')?.setAttribute('aria-label', `Actions for ${w.name}`);
    if (row.key !== key) {
      row.key = key;
      row.btn.title = `Open ${w.name}'s terminal · ${sub}`;
      row.btn.replaceChildren(h('span.dot', { style: `background:${w.color}` }), h('span.nh-name', {}, w.name, h('span.sub', {}, sub)), h('span.pill', { class: w.status }, status));
    }
    return row.li;
  };
  const sameChildren = (el: Element, next: Element[]) => el.children.length === next.length && next.every((c, i) => el.children[i] === c);

  let tilesKey = '';
  const render = () => {
    const p = store.project;
    if (store.floor === ROOF) {
      floorName.textContent = ROOF_NAME;
      floorMeta.textContent = `On top of ${store.floors.length} floor${store.floors.length === 1 ? '' : 's'}`;
    } else if (!p) {
      floorName.textContent = 'Droid Office';
      floorMeta.textContent = store.floors.length ? 'Take the elevator to a floor' : 'No floors yet: add a project in the elevator';
    } else {
      const n = store.floors.findIndex((f) => f.id === store.floor);
      floorName.textContent = p.name;
      floorMeta.textContent = [n >= 0 && `Floor ${n + 1} of ${store.floors.length}`, p.branch && `⎇ ${p.branch}`].filter(Boolean).join(' · ');
    }
    const seat = freeSeat();
    for (const button of [hireBtn, shellBtn]) {
      button.toggleAttribute('disabled', !seat);
      button.title = seat ? `At ${seat.label}` : store.floor === ROOF ? 'Return to an office floor to hire' : 'No free desk or bean bag on this floor';
    }
    const workers = sortedWorkers();
    workersCount.textContent = workers.length ? String(workers.length) : '';
    const ids = new Set(workers.map((w) => w.id));
    for (const id of rows.keys()) if (!ids.has(id)) rows.delete(id);
    const list = workers.length ? workers.map(workerRow) : [emptyRow];
    if (!sameChildren(workersEl, list)) workersEl.replaceChildren(...list);
    const shown = [...hudActions().filter((a) => actionOffered(a) && !NOT_ON_PANEL.has(a.id)), NATIVE_GRAPHICS_ACTION];
    const tiles = shown.map(tile);
    // Rebuilt only when they look different, so a busy floor's updates don't swap a tile out from under a tap.
    const key = tiles.map((t) => t.outerHTML).join('');
    if (key !== tilesKey) {
      tilesKey = key;
      tilesEl.replaceChildren(...tiles);
    }
  };
  const updatePerformance = (metrics: unknown) => {
    const status = nativePerformanceLabel(metrics);
    performance.classList.toggle('hidden', !status);
    performance.classList.toggle('warning', status?.warning ?? false);
    const text = status?.text ?? '';
    if (performance.textContent !== text) performance.textContent = text;
  };
  const setCarrying = (card: CarriedIssue | null) => {
    carried.classList.toggle('hidden', !card);
    carriedText.textContent = card ? `Holding #${card.issue} · ${card.title}. Aim at a desk or the queue and press the trigger to place it.` : '';
  };
  return { el, render, updatePerformance, setCarrying };
}

const NATIVE_GRAPHICS_ACTION: HudAction = {
  id: 'native-graphics',
  icon: '⚡',
  label: 'Graphics & performance',
  section: 'Office',
  title: () => 'Foveated rendering, world resolution and the FPS counter',
  run: openNativeGraphicsSettings,
};

/** Adds headset choices to the original menu without replacing its shared action callbacks. */
function decorateNativeMenu() {
  const menu = document.querySelector<HTMLElement>('.hud-menu');
  if (!menu || menu.querySelector('.native-graphics-menu-entry')) return;
  const column = menu.querySelector('.menu-col:last-of-type');
  if (!column) return;
  column.append(
    h(
      'button.menu-item.native-graphics-menu-entry',
      {
        type: 'button',
        role: 'menuitem',
        title: NATIVE_GRAPHICS_ACTION.title?.(),
        onclick: () => {
          closeAllModals();
          openNativeGraphicsSettings();
        },
      },
      h('span.mi-icon', { 'aria-hidden': 'true' }, NATIVE_GRAPHICS_ACTION.icon as string),
      h('span.mi-label', {}, NATIVE_GRAPHICS_ACTION.label as string),
    ),
  );
  const browserVr = hudActions().find((action) => action.id === 'entervr');
  if (browserVr) {
    const label = actionLabel(browserVr);
    for (const item of menu.querySelectorAll('.menu-item')) {
      if (item.querySelector('.mi-label')?.textContent === label) item.closest('.menu-row')?.classList.add('hidden');
    }
  }
  const foot = menu.querySelector('.menu-foot');
  if (foot) foot.textContent = 'Pin an action to keep it on the top bar. Use the left controller’s Menu button to open or close the workspace.';
  // The desktop's T shortcut; on the panel, tap the chat field.
  for (const small of menu.querySelectorAll('.menu-toggle small')) {
    if (small.textContent === 'T opens it either way') small.textContent = 'Messages for everyone here';
  }
}
