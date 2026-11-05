import type { WorkerInfo } from '../shared/protocol';
import { isAsleep, isBusy } from '../shared/status';
import { forkRefusal } from '../shared/worker-fork';
import { h, STATUS_LABEL } from './ui/dom';
import { icon, type IconName } from './ui/icons';

export type WorkerMenuAction = 'open' | 'split' | 'close' | 'resume' | 'interrupt' | 'fork' | 'pr' | 'copy-name' | 'copy-branch' | 'home';
export interface WorkerMenuState {
  worker: WorkerInfo;
  floor: string;
  pane: number;
  live: boolean;
  busy: boolean;
  native: boolean;
}
interface Item {
  action: WorkerMenuAction;
  label: string;
  icon: IconName;
  section: 'Workspace' | 'Worker' | 'Copy' | '';
  disabled?: boolean;
  shortcut?: string;
  reason?: string;
}

export function workerMenuItems(s: WorkerMenuState): Item[] {
  const w = s.worker;
  const open = s.pane >= 0;
  const local = !w.cloud && !w.remote;
  const asleep = isAsleep(w.status);
  const items: Item[] = [
    { action: 'open', label: open ? 'Focus its pane' : 'Open', icon: 'external', section: 'Workspace' },
    { action: 'split', label: 'Open in new pane', icon: 'paneAdd', section: 'Workspace', disabled: open },
  ];
  if (open) items.push({ action: 'close', label: 'Close pane', icon: 'x', section: 'Workspace', shortcut: s.native ? '⌘W' : undefined });
  if (asleep && !w.remote) items.push({ action: 'resume', label: w.kind === 'shell' ? 'Restart' : 'Resume', icon: 'play', section: 'Worker', disabled: !!w.lost });
  if (!w.remote && w.kind === 'agent' && isBusy(w.status)) items.push({ action: 'interrupt', label: 'Stop turn', icon: 'power', section: 'Worker' });
  if (local && w.kind === 'agent') {
    const reason = forkRefusal(w);
    items.push({ action: 'fork', label: 'Fork…', icon: 'fork', section: 'Worker', disabled: !!reason, reason });
  }
  if (w.pr || (local && w.worktree)) items.push({ action: 'pr', label: w.pr ? 'View PR' : 'Open PR', icon: 'pr', section: 'Worker', disabled: !w.pr && (!!w.lost || !!w.prOpening || isBusy(w.status)) });
  items.push({ action: 'copy-name', label: 'Name', icon: 'copy', section: 'Copy' });
  if (w.worktree?.branch) items.push({ action: 'copy-branch', label: 'Branch', icon: 'branch', section: 'Copy' });
  items.push({ action: 'home', label: 'Send home…', icon: 'home', section: '', shortcut: s.native ? '⇧⌘W' : undefined });
  return items.map((item) => ({ ...item, disabled: !!item.disabled || !s.live || (s.busy && item.section === 'Worker') || (s.busy && item.action === 'home') }));
}

export function createWorkerMenu(host: { state(id: string): WorkerMenuState | undefined; run(action: WorkerMenuAction, state: WorkerMenuState): void }) {
  let shown: { el: HTMLElement; anchor: HTMLElement; id: string; key: string; release(): void } | undefined;
  const stateKey = (s: WorkerMenuState) => JSON.stringify([s.floor, s.worker.name, s.worker.color, s.worker.status, s.worker.worktree?.branch, s.pane, workerMenuItems(s)]);
  function close(refocus = false): boolean {
    if (!shown) return false;
    const { el, anchor, release } = shown;
    shown = undefined;
    release();
    el.remove();
    anchor.removeAttribute('aria-expanded');
    if (refocus && anchor.isConnected) anchor.focus({ preventScroll: true });
    return true;
  }
  function refresh() {
    if (!shown) return;
    const s = host.state(shown.id);
    if (!s?.live || stateKey(s) !== shown.key) close();
  }
  function open(id: string, event: MouseEvent | KeyboardEvent, anchor: HTMLElement) {
    close();
    const state = host.state(id);
    if (!state?.live) return;
    event.preventDefault();
    event.stopPropagation();
    const w = state.worker;
    const dot = h('span.dash-dot', { 'data-status': w.status, 'aria-hidden': 'true' });
    dot.style.setProperty('--who', w.color);
    const el = h('div.dash-worker-menu', { role: 'menu', 'aria-label': `${w.name} actions` }, h('div.dash-worker-menu-head', {}, dot, h('b', {}, w.name), h('small', {}, STATUS_LABEL[w.status] ?? w.status)));
    let section = '';
    const buttons: HTMLButtonElement[] = [];
    for (const item of workerMenuItems(state)) {
      if (item.section !== section) {
        section = item.section;
        el.append(section ? h('div.dash-worker-menu-section', { role: 'presentation' }, section) : h('div.dash-worker-menu-sep', { role: 'separator' }));
      }
      const b = h(
        'button.dash-worker-menu-item',
        { type: 'button', role: 'menuitem', class: item.action === 'home' ? 'danger' : '', disabled: item.disabled, title: item.reason },
        icon(item.icon, 14),
        h('span', {}, item.label),
        item.shortcut ? h('kbd', {}, item.shortcut) : null,
      );
      b.addEventListener('click', () => {
        const current = host.state(id);
        const allowed = current?.floor === state.floor && workerMenuItems(current).some((i) => i.action === item.action && !i.disabled);
        close(true);
        if (current && allowed) host.run(item.action, current);
      });
      if (!item.disabled) buttons.push(b);
      el.append(b);
    }
    const outside = (e: Event) => {
      if (e.target instanceof Node && !el.contains(e.target)) close();
    };
    const dismiss = () => close();
    const scroll = (e: Event) => {
      // Output scrolling in a terminal or thread must not interrupt a sidebar menu.
      if (e.target instanceof Node && e.target.contains(anchor)) close();
    };
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        close(true);
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
      e.stopImmediatePropagation();
    };
    document.body.append(el);
    const box = anchor.getBoundingClientRect();
    const mouse = event instanceof MouseEvent && (event.clientX !== 0 || event.clientY !== 0);
    el.style.left = `${Math.max(8, Math.min(mouse ? event.clientX : box.left, window.innerWidth - el.offsetWidth - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(mouse ? event.clientY : box.bottom, window.innerHeight - el.offsetHeight - 8))}px`;
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    el.addEventListener('keydown', keydown);
    anchor.setAttribute('aria-expanded', 'true');
    shown = {
      el,
      anchor,
      id,
      key: stateKey(state),
      release() {
        document.removeEventListener('pointerdown', outside, true);
        document.removeEventListener('focusin', outside, true);
        document.removeEventListener('scroll', scroll, true);
        window.removeEventListener('blur', dismiss);
        window.removeEventListener('resize', dismiss);
      },
    };
    buttons[0]?.focus({ preventScroll: true });
  }
  return { open, close, refresh, isOpen: () => !!shown };
}
