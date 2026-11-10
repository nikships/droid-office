// Mission Control at the top of the companion's sidebar, the same on every floor (docs/mission-control.md):
// the Orchestrator, then each external bot, each with its subagents beneath it across floors, tagged
// with their floor.

import { missionAgentNeedsOwner, ORCHESTRATOR_ID, type MissionAgent, type MissionControlState, type MissionTeamMember } from '../shared/mission-control';
import type { WorkerInfo, WorkerStatus } from '../shared/protocol';
import { isBusy } from '../shared/status';
import { teamCounts } from '../shared/team';
import { workerDot, workingBars, WORKER_MIME } from './dashboard-pane';
import { reconcileChildren, todoMeter } from './dashboard-roster';
import { botLine, orchestratorLine, orchestratorWorker } from './mission';
import { h, STATUS_LABEL, timeAgo } from './ui/dom';
import { icon } from './ui/icons';
import { modelBadgeLabel, modelBadgeNode } from './ui/models';

export interface MissionRosterState {
  mission: MissionControlState | undefined;
  /** The floor this page is on: members elsewhere open by going there. */
  floor: string;
  focused: string;
  live: boolean;
  pane(id: string): number;
  /** A worker on this floor, for its colour. */
  here(id: string): WorkerInfo | undefined;
  /** The Orchestrator's shortcut, shown on its row. */
  shortcut?: string;
}

export interface MissionRosterHost {
  /** Opens the Orchestrator or a bot in the workspace. */
  open(id: string): void;
  split(id: string): void;
  /** Opens a subagent, on its own floor. */
  member(m: MissionTeamMember): void;
  /** Settings → Orchestrator, from the row that says it's off. */
  settings(): void;
}

interface Row {
  wrap: HTMLElement;
  open: HTMLButtonElement;
  split?: HTMLButtonElement;
  key: string;
}

interface Block {
  el: HTMLElement;
  toggle: HTMLButtonElement;
  children: HTMLElement;
}

/** A status dot for a subagent, in its colour when it's on this floor. */
function memberDot(status: WorkerStatus, color: string) {
  const el = h('span.dash-dot', { 'data-status': status, 'aria-hidden': 'true' });
  el.style.setProperty('--who', color);
  return el;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export function createMissionRoster(el: HTMLElement, host: MissionRosterHost) {
  const rows = new Map<string, Row>();
  const blocks = new Map<string, Block>();
  const collapsed = new Set<string>();
  const head = h('div.dash-mission-head');
  const off = h(
    'button.dash-mission-off',
    { type: 'button', onclick: () => host.settings() },
    h('span.dash-mission-off-icon', { 'aria-hidden': 'true' }, icon('power', 13)),
    h('span.dash-mission-off-text', {}, h('b', {}, 'Orchestrator is off'), h('span', {}, 'Turn it on in Settings')),
    h('span.dash-mission-off-go', { 'aria-hidden': 'true' }, icon('chevron', 12)),
  ) as HTMLButtonElement;
  let state: MissionRosterState | undefined;
  let visible: string[] = [];

  function agentRow(id: string): Row {
    let r = rows.get(id);
    if (r) return r;
    const open = h('button.dash-row-open', { type: 'button', 'data-worker': id, draggable: 'true', onclick: () => host.open(id) }) as HTMLButtonElement;
    open.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData(WORKER_MIME, id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove';
    });
    const split = h('button.btn.icon.sm.ghost.dash-row-split', { type: 'button', title: 'Open in a new pane', onclick: () => host.split(id) }, icon('paneAdd', 13)) as HTMLButtonElement;
    r = { wrap: h('div.dash-row.dash-mission-row', {}, open, split), open, split, key: '' };
    rows.set(id, r);
    return r;
  }

  function memberRow(m: MissionTeamMember, agent: MissionAgent, s: MissionRosterState): HTMLElement {
    const id = `member:${m.id}`;
    let r = rows.get(id);
    if (!r) {
      const open = h('button.dash-row-open', { type: 'button', 'data-member': m.id }) as HTMLButtonElement;
      open.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData(WORKER_MIME, m.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove';
      });
      r = { wrap: h('div.dash-row.dash-subworker.dash-mission-member', {}, open), open, key: '' };
      rows.set(id, r);
    }
    const here = m.floor === s.floor ? s.here(m.id) : undefined;
    r.open.onclick = () => host.member(m);
    // Only a subagent on this floor can be dragged into a pane; one elsewhere opens by going to its floor.
    r.open.draggable = !!here;
    r.open.disabled = !s.live;
    r.wrap.classList.toggle('on', m.id === s.focused);
    r.wrap.classList.toggle('attn', m.status === 'needs_input');
    r.wrap.classList.toggle('elsewhere', m.floor !== s.floor);
    const status = STATUS_LABEL[m.status] ?? m.status;
    const doing = m.activity ?? m.title ?? status;
    const key = JSON.stringify([m, here?.color, s.pane(m.id), s.floor === m.floor, agent.worker.color]);
    if (key !== r.key) {
      r.key = key;
      const where = m.floor === s.floor ? `${m.floorName}, this floor` : `${m.floorName} floor`;
      r.open.title = [m.name, `Subagent of ${agent.worker.name}`, where, status, doing].join(' · ');
      r.open.setAttribute('aria-label', `Open ${m.name}, subagent of ${agent.worker.name} on the ${where}, ${status}: ${doing}`);
      r.open.replaceChildren(
        memberDot(m.status, here?.color ?? agent.worker.color),
        h(
          'span.dash-row-main',
          {},
          h(
            'span.dash-row-top',
            {},
            h('span.dash-row-name', {}, m.name),
            h('span.dash-row-floor', { title: where }, m.floorName),
            s.pane(m.id) >= 0 ? h('span.dash-row-pane', { title: `In pane ${s.pane(m.id) + 1}` }, `P${s.pane(m.id) + 1}`) : null,
            h('span.dash-row-state', {}, m.status === 'needs_input' ? h('span.pill', { class: m.status }, status) : isBusy(m.status) ? workingBars(status) : null),
          ),
          h('span.dash-row-doing', {}, doing),
        ),
      );
    }
    return r.wrap;
  }

  function paintAgent(agent: MissionAgent | undefined, w: WorkerInfo, s: MissionRosterState): HTMLElement {
    const orchestrator = w.id === ORCHESTRATOR_ID;
    const r = agentRow(w.id);
    const waits = orchestrator && missionAgentNeedsOwner(agent ?? { worker: w, team: [] });
    const blocked = orchestrator ? s.mission?.orchestrator.blocked : undefined;
    r.wrap.classList.toggle('on', w.id === s.focused);
    r.wrap.classList.toggle('attn', orchestrator && w.status === 'needs_input');
    r.wrap.classList.toggle('blocked', !!blocked);
    r.wrap.classList.toggle('dash-mission-bot', !orchestrator);
    r.open.setAttribute('aria-current', String(w.id === s.focused));
    r.open.disabled = !s.live;
    if (r.split) r.split.disabled = !s.live;
    const team = agent?.team ?? [];
    const model = w.activeModel ?? w.model;
    const effort = w.activeEffort ?? w.effort;
    const line = orchestrator ? orchestratorLine(s.mission) : botLine(agent ?? { worker: w, team: [] });
    const status = blocked ? 'blocked' : (STATUS_LABEL[w.status] ?? w.status);
    const lastUsed = !orchestrator && agent?.lastUsedAt ? `used ${timeAgo(agent.lastUsedAt)}` : '';
    const todos = orchestrator ? w.todos : undefined;
    const key = JSON.stringify([w.name, w.color, w.status, w.acked, line, status, model, effort, team.length, lastUsed, s.pane(w.id), todos, waits, s.shortcut]);
    if (key !== r.key) {
      r.key = key;
      const role = orchestrator ? 'Orchestrator' : 'External bot';
      const meta = orchestrator ? [modelBadgeLabel(model, effort) ?? 'Office default model', team.length ? plural(team.length, 'subagent') : ''] : ['Runs externally', lastUsed];
      r.open.title = [w.name, role, status, line, ...meta].filter(Boolean).join(' · ');
      r.open.setAttribute('aria-label', `Open ${w.name}, ${role}, ${status}: ${line}`);
      r.split?.setAttribute('aria-label', `Open ${w.name} in a new pane`);
      r.open.replaceChildren(
        h('span.dash-mission-mark', { 'data-status': blocked ? 'blocked' : w.status, 'aria-hidden': 'true' }, icon(orchestrator ? 'satellite' : 'bot', 13), workerDot(w)),
        h(
          'span.dash-row-main',
          {},
          h(
            'span.dash-row-top',
            {},
            h('span.dash-row-name', {}, w.name),
            orchestrator ? null : h('span.dash-row-role', {}, 'Bot'),
            s.pane(w.id) >= 0 ? h('span.dash-row-pane', { title: `In pane ${s.pane(w.id) + 1}` }, `P${s.pane(w.id) + 1}`) : null,
            orchestrator && s.shortcut && s.pane(w.id) < 0 && !waits && !blocked && !isBusy(w.status) ? h('span.key.dash-mission-key', { title: `Open the Orchestrator (${s.shortcut})` }, s.shortcut) : null,
            h(
              'span.dash-row-state',
              {},
              // Blocked and an offline bot say so in their line; a pill as well would squeeze the name.
              blocked ? null : waits ? h('span.pill', { class: w.status }, status) : isBusy(w.status) && w.status !== 'needs_input' ? workingBars(status) : null,
            ),
          ),
          h('span.dash-row-doing', {}, line),
          todos ? todoMeter(todos) : null,
          h(
            'span.dash-row-meta',
            {},
            ...(orchestrator
              ? [modelBadgeNode(model, effort) ?? 'Office default', ...(team.length ? [h('span.dash-row-meta-sep', { 'aria-hidden': 'true' }, '·'), plural(team.length, 'subagent')] : [])]
              : ['Runs externally', ...(lastUsed ? [h('span.dash-row-meta-sep', { 'aria-hidden': 'true' }, '·'), lastUsed] : [])]),
          ),
        ),
      );
    }
    visible.push(w.id);
    let block = blocks.get(w.id);
    if (!block) {
      const list = h('div.dash-team-children', { id: `dash-mission-team-${w.id}`, role: 'group' });
      const toggle = h('button.dash-team-toggle', {
        type: 'button',
        'aria-controls': list.id,
        onclick: () => {
          if (collapsed.has(w.id)) collapsed.delete(w.id);
          else collapsed.add(w.id);
          if (state) update(state);
        },
      }) as HTMLButtonElement;
      block = { el: h('section.dash-mission-agent'), toggle, children: list };
      blocks.set(w.id, block);
    }
    block.el.setAttribute('aria-label', orchestrator ? 'The Orchestrator and its team' : `${w.name} and its team`);
    block.el.classList.toggle('has-focus', w.id === s.focused || team.some((m) => m.id === s.focused));
    if (!team.length) {
      reconcileChildren(block.el, [r.wrap]);
      return block.el;
    }
    const expanded = !collapsed.has(w.id);
    const counts = teamCounts(team.map((m) => ({ status: m.status, acked: true, lead: w.id })));
    const floors = new Set(team.map((m) => m.floor)).size;
    block.children.setAttribute('aria-label', `${w.name}'s subagents`);
    block.children.hidden = !expanded;
    block.toggle.setAttribute('aria-expanded', String(expanded));
    block.toggle.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${w.name}'s ${plural(team.length, 'subagent')}`);
    block.toggle.replaceChildren(
      h('span.dash-team-chevron', { 'aria-hidden': 'true' }, icon('chevron', 12)),
      h('span', {}, `${plural(team.length, 'subagent')}${floors > 1 ? ` · ${floors} floors` : ''}`),
      h('span.dash-team-activity', { class: counts.attention ? 'dash-team-attention' : '' }, counts.attention ? `${counts.attention} need you` : `${counts.working} working`),
    );
    const children = team.map((m) => memberRow(m, agent!, s));
    if (expanded) for (const m of team) visible.push(m.id);
    reconcileChildren(block.children, children);
    reconcileChildren(block.el, [r.wrap, block.toggle, block.children]);
    return block.el;
  }

  function update(next: MissionRosterState) {
    state = next;
    const mc = next.mission;
    el.hidden = !mc;
    visible = [];
    if (!mc) {
      el.replaceChildren();
      rows.clear();
      blocks.clear();
      return;
    }
    const focused = document.activeElement instanceof HTMLElement && el.contains(document.activeElement) ? document.activeElement : undefined;
    const content: HTMLElement[] = [head];
    const seen = new Set<string>();
    const orchestrator = orchestratorWorker(mc);
    if (orchestrator) {
      content.push(paintAgent(mc.orchestrator.agent, orchestrator, next));
      seen.add(orchestrator.id);
    } else {
      off.disabled = !next.live;
      content.push(off);
    }
    for (const bot of mc.bots) {
      content.push(paintAgent(bot, bot.worker, next));
      seen.add(bot.worker.id);
    }
    const agents = [...(orchestrator ? [mc.orchestrator.agent] : []), ...mc.bots];
    const team = agents.flatMap((a) => a?.team ?? []);
    for (const m of team) seen.add(`member:${m.id}`);
    for (const id of rows.keys()) if (!seen.has(id)) rows.delete(id);
    for (const id of blocks.keys())
      if (!seen.has(id)) {
        blocks.delete(id);
        collapsed.delete(id);
      }
    const attention = (orchestrator && missionAgentNeedsOwner(mc.orchestrator.agent) ? 1 : 0) + team.filter((m) => m.status === 'needs_input').length;
    const working = agents.filter((a) => a && isBusy(a.worker.status)).length + team.filter((m) => isBusy(m.status) && m.status !== 'needs_input').length;
    head.replaceChildren(
      h('span.dash-mission-title', {}, icon('satellite', 12), h('span', {}, 'Mission Control')),
      h('span.dash-mission-caption', { class: attention ? 'dash-team-attention' : '' }, attention ? `${attention} need${attention === 1 ? 's' : ''} you` : working ? `${working} working` : 'Every floor'),
    );
    reconcileChildren(el, content);
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  }

  return {
    update,
    /** Each building agent, followed by its expanded team, in display order. */
    visible: () => visible,
    member(id: string) {
      const mc = state?.mission;
      return [mc?.orchestrator.agent, ...(mc?.bots ?? [])].flatMap((agent) => agent?.team ?? []).find((m) => m.id === id);
    },
    button(id: string) {
      return rows.get(id)?.open ?? rows.get(`member:${id}`)?.open;
    },
    scrollTo(id: string) {
      (rows.get(id) ?? rows.get(`member:${id}`))?.wrap.scrollIntoView({ block: 'nearest' });
    },
  };
}
