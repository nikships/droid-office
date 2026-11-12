import type { BuildingFilter, BuildingWorkerRow } from './dashboard-building';
import { buildingCounts, filterBuildingRows, MISSION_FLOOR } from './dashboard-building';
import type { FloorInfo } from '../shared/protocol';
import { isAsleep } from '../shared/status';
import { reconcileChildren, todoMeter } from './dashboard-roster';
import { workerDot } from './dashboard-pane';
import { doingLine, workerKind } from './worker-words';
import { orchestratorBlocked, orchestratorLine } from './mission';
import type { MissionControlState } from '../shared/mission-control';
import { h } from './ui/dom';
import { icon } from './ui/icons';
import { modelBadgeNode } from './ui/models';

const FILTERS: readonly [BuildingFilter, string][] = [
  ['all', 'All workers'],
  ['needs_input', 'Needs you'],
  ['working', 'Working'],
  ['done', 'Done'],
  ['asleep', 'Asleep'],
];

interface BuildingViewState {
  rows: BuildingWorkerRow[];
  floors: FloorInfo[];
  live: boolean;
  canHire: boolean;
  mission?: MissionControlState;
}

/** A building-wide directory. Opening a row uses the workspace's existing cross-floor navigation. */
export function createBuildingView(host: { open(row: BuildingWorkerRow): void; workspace(): void; hire(): void }) {
  let state: BuildingViewState = { rows: [], floors: [], live: false, canHire: false };
  let filter: BuildingFilter = 'all';
  let optionsKey = '';
  const nodes = new Map<string, { button: HTMLButtonElement; key: string }>();
  const total = h('span.dash-building-total');
  const heading = h('h1', { id: 'all-workers-heading', tabindex: '-1' }, 'All workers ', total);
  const back = h('button.btn.ghost.sm', { type: 'button', onclick: host.workspace }, icon('back', 14), 'Workspace');
  const hire = h('button.btn.primary', { type: 'button', onclick: host.hire }, icon('plus', 14), 'Hire Droid');
  const search = h('input.input', { type: 'search', placeholder: 'Search workers, tasks, models…', 'aria-label': 'Search all workers', autocomplete: 'off' });
  const floor = h('select.select', { 'aria-label': 'Filter workers by floor' });
  const result = h('p.dash-building-result', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const list = h('div.dash-building-list', { role: 'list', 'aria-label': 'All workers' });
  const empty = h('div.empty-state.dash-building-empty');
  const clear = h('button.btn', { type: 'button', onclick: reset }, 'Clear filters');
  const filters = FILTERS.map(([value, label]) => {
    const count = h('span.dash-building-filter-count', {}, '0');
    const button = h(
      'button.dash-building-filter',
      {
        type: 'button',
        'aria-pressed': String(value === filter),
        onclick: () => {
          filter = value;
          paint();
        },
      },
      label,
      count,
    );
    return { value, label, button, count };
  });
  const el = h(
    'main.dash-building',
    { id: 'all-workers', 'aria-labelledby': 'all-workers-heading', hidden: true },
    h(
      'div.dash-building-inner',
      {},
      h('div.dash-building-back', {}, back),
      h(
        'header.dash-building-head',
        {},
        h('div', {}, h('p.eyebrow', {}, 'Across the building'), heading, h('p.dash-building-description', {}, 'Every floor and Mission Control, in one place. Open a worker to pick up where they are.')),
        hire,
      ),
      h('div.dash-building-tools', {}, h('div.dash-building-search', {}, icon('search', 16), search), floor),
      h('div.dash-building-filters', { role: 'group', 'aria-label': 'Filter workers by status' }, ...filters.map((f) => f.button)),
      result,
      h('div.dash-building-columns', { 'aria-hidden': 'true' }, h('span', {}, 'Worker / current work'), h('span', {}, 'Floor / repository'), h('span', {}, 'Model'), h('span', {}, 'Status'), h('span')),
      list,
      empty,
    ),
  );
  search.addEventListener('input', paint);
  floor.addEventListener('change', paint);
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !search.value) return;
    event.preventDefault();
    search.value = '';
    paint();
  });
  list.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const buttons = [...list.querySelectorAll<HTMLButtonElement>('button')];
    const at = buttons.indexOf(event.target as HTMLButtonElement);
    if (at < 0) return;
    const next = { ArrowDown: Math.min(at + 1, buttons.length - 1), ArrowUp: Math.max(at - 1, 0), Home: 0, End: buttons.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    buttons[next]?.focus();
  });

  function reset() {
    filter = 'all';
    search.value = '';
    floor.value = '';
    paint();
    search.focus();
  }

  function paint() {
    const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : undefined;
    const focusedIndex = focused ? [...list.querySelectorAll('button')].indexOf(focused as HTMLButtonElement) : -1;
    const counts = buildingCounts(state.rows);
    total.textContent = String(counts.all);
    hire.disabled = !state.live || !state.canHire;
    hire.title = state.canHire ? 'Hire a Droid on the current floor' : 'Choose a project floor above to hire a Droid';
    const key = JSON.stringify([state.floors.map((f) => [f.id, f.name]), state.rows.some((r) => r.floorId === MISSION_FLOOR)]);
    if (key !== optionsKey) {
      const selected = floor.value;
      floor.replaceChildren(
        h('option', { value: '' }, 'All floors'),
        ...(state.rows.some((r) => r.floorId === MISSION_FLOOR) ? [h('option', { value: MISSION_FLOOR }, 'Mission Control')] : []),
        ...state.floors.map((f) => h('option', { value: f.id }, f.name)),
      );
      floor.value = [...floor.options].some((o) => o.value === selected) ? selected : '';
      optionsKey = key;
    }
    for (const f of filters) {
      f.count.textContent = String(counts[f.value]);
      f.button.setAttribute('aria-pressed', String(filter === f.value));
      f.button.setAttribute('aria-label', `${f.label}, ${counts[f.value]}`);
    }
    const shown = filterBuildingRows(state.rows, search.value, floor.value, filter);
    const message = `${shown.length} of ${counts.all} worker${counts.all === 1 ? '' : 's'}${state.live ? ' · Live updates' : ' · Reconnecting, actions unavailable'}`;
    if (result.textContent !== message) result.textContent = message;
    const content: HTMLElement[] = [];
    for (const row of shown) {
      const w = row.worker;
      let node = nodes.get(w.id);
      if (!node) {
        const button = h('button.dash-building-worker', {
          type: 'button',
          'data-worker': w.id,
          onclick: () => {
            const current = state.rows.find((r) => r.worker.id === w.id);
            if (state.live && current) host.open(current);
          },
        });
        node = { button, key: '' };
        nodes.set(w.id, node);
      }
      const { button } = node;
      button.disabled = !state.live;
      button.classList.toggle('needs-you', row.kind !== 'bot' && w.status === 'needs_input');
      button.classList.toggle('asleep', isAsleep(w.status));
      button.classList.toggle('is-subworker', row.depth > 0);
      const blocked = row.kind === 'orchestrator' && !!orchestratorBlocked(state.mission);
      let status: string;
      if (blocked) status = 'Blocked';
      else if (row.kind === 'bot') status = isAsleep(w.status) ? 'Offline' : 'External bot';
      else if (isAsleep(w.status)) status = 'Asleep';
      else {
        switch (w.status) {
          case 'needs_input':
            status = 'Needs you';
            break;
          case 'done':
            status = !w.acked && !w.lead ? 'Done · new' : 'Done';
            break;
          case 'idle':
            status = 'Ready';
            break;
          case 'starting':
            status = 'Starting';
            break;
          default:
            status = 'Working';
        }
      }
      const detail = row.kind === 'orchestrator' ? orchestratorLine(state.mission) : doingLine(w);
      const model = w.activeModel ?? w.model;
      const effort = w.activeEffort ?? w.effort;
      const branch = w.worktree?.branch;
      const rowKey = JSON.stringify([w.name, w.color, w.status, status, detail, model, effort, w.kind, w.cloud?.computerName, w.todos, branch, row.floorName, row.repo, row.leadName, row.depth, row.kind]);
      if (rowKey !== node.key) {
        node.key = rowKey;
        button.setAttribute('aria-label', `Open ${w.name}, ${row.floorName}, ${status}${row.leadName ? `, subworker of ${row.leadName}` : ''}: ${detail}`);
        button.title = [w.name, row.floorName, row.repo, branch, detail].filter(Boolean).join(' · ');
        let sub = row.kind === 'desk' ? workerKind(w) : 'Mission Control';
        if (row.leadName) sub = `Subworker of ${row.leadName}`;
        let engine: HTMLElement | string | undefined;
        if (w.kind === 'shell') engine = 'Shell';
        else if (row.kind === 'bot') engine = 'Runs externally';
        else engine = modelBadgeNode(model, effort);
        let statusKind: string = w.status;
        if (row.kind === 'bot') statusKind = 'external';
        if (blocked) statusKind = 'blocked';
        button.replaceChildren(
          h(
            'span.dash-building-identity',
            {},
            workerDot(w),
            h(
              'span.dash-building-work',
              {},
              h('span.dash-building-name', {}, h('b', {}, w.name), h('span.dash-building-role', { title: sub }, sub)),
              h('span.dash-building-doing', { title: detail }, detail),
              w.kind !== 'shell' && w.todos?.total ? todoMeter(w.todos) : null,
            ),
          ),
          h('span.dash-building-place', {}, h('span', { title: row.floorName }, row.floorName), h('small', { title: [row.repo, branch].filter(Boolean).join(' · ') }, [row.repo, branch].filter(Boolean).join(' · ') || '—')),
          h('span.dash-building-model', {}, engine),
          h('span.dash-building-status', { 'data-status': statusKind }, status),
          h('span.dash-building-open', { 'aria-hidden': 'true' }, icon('arrow', 16)),
        );
      }
      const wrapper = button.parentElement?.getAttribute('role') === 'listitem' ? button.parentElement : h('div', { role: 'listitem' }, button);
      content.push(wrapper);
    }
    const ids = new Set(state.rows.map((r) => r.worker.id));
    for (const id of nodes.keys()) if (!ids.has(id)) nodes.delete(id);
    reconcileChildren(list, content);
    if (focused) {
      const kept = focused.isConnected && !(focused instanceof HTMLButtonElement && focused.disabled);
      const next = kept ? focused : (content[Math.min(focusedIndex, content.length - 1)]?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? search);
      if (document.activeElement !== next) next.focus({ preventScroll: true });
    }
    list.hidden = !shown.length;
    empty.hidden = !!shown.length;
    if (!shown.length) {
      const filtered = !!search.value.trim() || !!floor.value || filter !== 'all';
      let emptyTitle = 'Waiting for the office';
      let description = 'The roster will update when the office reconnects.';
      const actions: HTMLElement[] = [];
      if (filtered) {
        emptyTitle = 'No matching workers';
        description = 'Try another search, floor or status.';
        actions.push(clear);
      } else if (state.live) {
        emptyTitle = 'No workers in the building yet';
        description = state.canHire ? 'Hire a Droid on your current floor to get started. Workers from every floor appear here.' : 'Choose a project floor above to hire a Droid.';
        actions.push(h('button.btn.primary', { type: 'button', disabled: !state.canHire, onclick: host.hire }, icon('plus', 14), 'Hire Droid'));
      }
      empty.replaceChildren(h('img', { src: '/factory-glyph.svg', alt: '', width: 32, height: 32 }), h('b', {}, emptyTitle), h('p', {}, description), ...actions);
    }
  }
  return {
    el,
    update(next: BuildingViewState) {
      state = next;
      paint();
    },
    focus() {
      heading.focus({ preventScroll: true });
    },
  };
}
