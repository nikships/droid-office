import type { WorkerInfo } from '../shared/protocol';
import { statusWord } from '../shared/guests';
import { isAsleep, isBusy } from '../shared/status';
import { shortDuration, workedFor } from './dashboard-workspace';
import { workerDot, workingBars, WORKER_MIME } from './dashboard-pane';
import { teamCounts, workerTeams } from './dashboard-teams';
import { doingLine, workerKind } from './worker-words';
import { h, STATUS_LABEL } from './ui/dom';
import { icon } from './ui/icons';
import { modelBadge } from './ui/models';

/** Keep nodes in place on status ticks: focus, drags and entry animations must survive updates. */
export function reconcileChildren(parent: HTMLElement, children: HTMLElement[]) {
  const keep = new Set(children);
  for (const child of Array.from(parent.children)) if (!keep.has(child as HTMLElement)) child.remove();
  children.forEach((child, index) => {
    if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] ?? null);
  });
}

interface RosterState {
  floor: string;
  workers: WorkerInfo[];
  focused: string;
  live: boolean;
  pane(id: string): number;
}
interface Row {
  wrap: HTMLElement;
  open: HTMLButtonElement;
  split: HTMLButtonElement;
  key: string;
}
interface Group {
  el: HTMLElement;
  toggle: HTMLButtonElement;
  children: HTMLElement;
}

export function createWorkerRoster(el: HTMLElement, open: (id: string) => void, split: (id: string) => void) {
  const rows = new Map<string, Row>();
  const groups = new Map<string, Group>();
  const collapsed = new Set<string>();
  const summary = h('div.dash-roster-summary');
  const empty = h('p.dash-side-empty');
  let state: RosterState | undefined;
  let floor = '';
  let wasLive = false;
  let known = new Set<string>();
  let visible: WorkerInfo[] = [];

  function update(next: RosterState) {
    const focused = document.activeElement instanceof HTMLElement && el.contains(document.activeElement) ? document.activeElement : undefined;
    const sameFloor = floor === next.floor;
    if (!sameFloor) {
      rows.clear();
      groups.clear();
      collapsed.clear();
      known.clear();
      floor = next.floor;
    }
    const animate = sameFloor && wasLive && next.live && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const arrivals: HTMLElement[] = [];
    state = next;
    const teams = workerTeams(next.workers);
    const counts = teamCounts(next.workers);
    const subworkers = teams.reduce((n, team) => n + team.children.length, 0);
    const mainCount = next.workers.length - subworkers;
    summary.replaceChildren(
      h('div.dash-roster-heading', {}, h('span', {}, 'Workers'), h('span.dash-roster-total', {}, String(next.workers.length).padStart(2, '0'))),
      h(
        'div.dash-roster-caption',
        {},
        `${mainCount} main${subworkers ? ` · ${subworkers} subworker${subworkers === 1 ? '' : 's'}` : ''}`,
        counts.attention ? h('span.dash-team-attention', {}, `${counts.attention} need you`) : counts.working ? h('span', {}, `${counts.working} working`) : null,
      ),
    );
    const content: HTMLElement[] = [summary];
    const seen = new Set<string>();
    const groupIds = new Set<string>();
    visible = [];

    function row(w: WorkerInfo, parent?: WorkerInfo, hasChildren = false) {
      seen.add(w.id);
      let r = rows.get(w.id);
      if (!r) {
        const button = h('button.dash-row-open', { type: 'button', 'data-worker': w.id, draggable: 'true', onclick: () => open(w.id) }) as HTMLButtonElement;
        button.addEventListener('dragstart', (e) => {
          e.dataTransfer?.setData(WORKER_MIME, w.id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove';
        });
        const beside = h('button.btn.icon.sm.ghost.dash-row-split', { type: 'button', title: 'Open in a new pane', 'aria-label': `Open ${w.name} in a new pane`, onclick: () => split(w.id) }, icon('columns', 13)) as HTMLButtonElement;
        r = { wrap: h('div.dash-row', {}, button, beside), open: button, split: beside, key: '' };
        rows.set(w.id, r);
      }
      r.wrap.classList.toggle('dash-subworker', !!parent);
      r.wrap.classList.toggle('on', w.id === next.focused);
      r.wrap.classList.toggle('attn', w.status === 'needs_input');
      r.wrap.classList.toggle('asleep', isAsleep(w.status));
      r.open.setAttribute('aria-current', String(w.id === next.focused));
      r.open.disabled = !next.live;
      r.split.disabled = !next.live;
      const worked = workedFor(w.workedMs, w.workingSince, Date.now());
      const meta = [w.kind === 'agent' && !w.guest ? modelBadge(w.activeModel ?? w.model, w.activeEffort ?? w.effort) : workerKind(w), worked >= 1000 ? shortDuration(worked) : ''].filter(Boolean).join(' · ');
      const relationship = parent ? `Subworker of ${parent.name}` : w.lead ? 'Lead unavailable' : hasChildren ? 'Main worker' : '';
      const key = JSON.stringify([w.name, w.color, w.status, w.acked, doingLine(w), meta, relationship, next.pane(w.id)]);
      if (key !== r.key) {
        r.key = key;
        const status = statusWord(w, STATUS_LABEL);
        r.open.title = [w.name, relationship, status, doingLine(w), meta].filter(Boolean).join(' · ');
        r.open.setAttribute('aria-label', `Open ${w.name}${relationship ? `, ${relationship}` : ''}, ${status}: ${doingLine(w)}`);
        r.split.setAttribute('aria-label', `Open ${w.name} in a new pane`);
        r.open.replaceChildren(
          workerDot(w),
          h(
            'span.dash-row-main',
            {},
            h(
              'span.dash-row-top',
              {},
              h('span.dash-row-name', {}, w.name),
              hasChildren ? h('span.dash-row-role', {}, 'Lead') : null,
              next.pane(w.id) >= 0 ? h('span.dash-row-pane', { title: `In pane ${next.pane(w.id) + 1}` }, `P${next.pane(w.id) + 1}`) : null,
              h('span.dash-row-state', {}, w.status === 'needs_input' || (w.status === 'done' && !w.acked) ? h('span.pill', { class: w.status }, status) : isBusy(w.status) ? workingBars(status) : null),
            ),
            h('span.dash-row-doing', {}, doingLine(w)),
            h('span.dash-row-meta', {}, w.lead && !parent ? 'Lead unavailable' : meta),
          ),
        );
      }
      return r.wrap;
    }

    for (const team of teams) {
      const { lead, children } = team;
      const root = row(lead, undefined, children.length > 0);
      visible.push(lead);
      if (!children.length) {
        content.push(root);
        if (animate && !known.has(lead.id)) arrivals.push(root);
        continue;
      }
      groupIds.add(lead.id);
      let group = groups.get(lead.id);
      if (!group) {
        const list = h('div.dash-team-children', { id: `dash-team-${lead.id}`, role: 'group', 'aria-label': `${lead.name} subworkers` });
        const toggle = h('button.dash-team-toggle', {
          type: 'button',
          'aria-controls': list.id,
          onclick: () => {
            if (collapsed.has(lead.id)) collapsed.delete(lead.id);
            else collapsed.add(lead.id);
            if (state) update(state);
          },
        }) as HTMLButtonElement;
        group = { el: h('section.dash-worker-team'), toggle, children: list };
        groups.set(lead.id, group);
      }
      group.el.setAttribute('aria-label', `${lead.name}'s team`);
      group.children.setAttribute('aria-label', `${lead.name} subworkers`);
      group.el.classList.toggle(
        'has-focus',
        [lead, ...children].some((w) => w.id === next.focused),
      );
      const expanded = !collapsed.has(lead.id);
      const activity = teamCounts(children);
      group.toggle.setAttribute('aria-expanded', String(expanded));
      group.toggle.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${lead.name}'s ${children.length} subworkers`);
      group.toggle.replaceChildren(
        h('span.dash-team-chevron', { 'aria-hidden': 'true' }, '›'),
        h('span', {}, `${children.length} subworker${children.length === 1 ? '' : 's'}`),
        h('span.dash-team-activity', { class: activity.attention ? 'dash-team-attention' : '' }, activity.attention ? `${activity.attention} need you` : `${activity.working} working`),
      );
      group.children.hidden = !expanded;
      const childRows = children.map((w) => {
        const child = row(w, lead);
        if (expanded) {
          visible.push(w);
          if (animate && !known.has(w.id)) arrivals.push(child);
        }
        return child;
      });
      reconcileChildren(group.children, childRows);
      reconcileChildren(group.el, [root, group.toggle, group.children]);
      content.push(group.el);
      if (animate && !known.has(lead.id)) arrivals.push(root);
    }
    for (const id of rows.keys()) if (!seen.has(id)) rows.delete(id);
    for (const id of groups.keys())
      if (!groupIds.has(id)) {
        groups.delete(id);
        collapsed.delete(id);
      }
    if (!next.workers.length) {
      empty.textContent = next.live ? 'Nobody on this floor yet.' : 'Waiting for the office…';
      content.push(empty);
    }
    reconcileChildren(el, content);
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
    arrivals.forEach((node, i) =>
      node.animate(
        [
          { opacity: 0, transform: 'translateY(-5px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        { duration: 220, delay: Math.min(i * 30, 120), easing: 'cubic-bezier(.23, 1, .32, 1)', fill: 'backwards' },
      ),
    );
    known = new Set(next.workers.map((w) => w.id));
    wasLive = next.live;
  }

  return {
    update,
    visible: () => visible,
    reveal(id: string) {
      const w = state?.workers.find((w) => w.id === id);
      if (w?.lead && collapsed.delete(w.lead) && state) update(state);
    },
    scrollTo(id: string) {
      rows.get(id)?.wrap.scrollIntoView({ block: 'nearest' });
    },
    button(id: string) {
      return rows.get(id)?.open;
    },
  };
}
