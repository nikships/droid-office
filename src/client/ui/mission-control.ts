import { ORCHESTRATOR_ID, ORCHESTRATOR_NAME, type MissionTeamMember } from '../../shared/mission-control';
import { isBusy } from '../../shared/status';
import { ORCHESTRATOR_PITCH } from '../mission';
import { lastUsedWords, missionTeamLine, orchestratorPhase } from '../mission-office';
import { newOrchestratorConversation } from './orchestrator';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, STATUS_LABEL, toast } from './dom';
import { colorDot, emptyState, windowHeader } from './kit';
import { openPrompt } from './prompt';

// The windows of Mission Control's building agents: the Orchestrator's prompt box (with its terminal, Stop
// and New conversation), what to do while it's off or can't start, and an external bot's card.

export interface OrchestratorActions {
  /** Its terminal, from any floor. */
  terminal(): void;
  settings(): void;
}

/** What the Orchestrator is for, where nothing else says. */
const ABOUT = ORCHESTRATOR_PITCH;

/** E at the Orchestrator, M, the ☰ menu or the palette: talk to it, or say why you can't and how to fix it. */
export function openOrchestrator(net: Net, actions: OrchestratorActions) {
  const state = store.missionControl;
  if (!state) {
    toast('🛰️ This office has no Orchestrator yet: update it to get one', 'warn');
    return;
  }
  const o = state.orchestrator;
  const phase = orchestratorPhase(state);
  if (phase === 'off') return orchestratorOff(net, actions);
  if (phase === 'blocked') return orchestratorBlocked(o.blocked ?? '', actions);
  const w = o.agent?.worker;
  const busy = !!w && isBusy(w.status);
  const terminal = w ? h('button.btn.sm', { type: 'button', title: 'Its terminal and conversation (O at the Orchestrator)', onclick: () => actions.terminal() }, 'Terminal') : null;
  const stop = busy
    ? h(
        'button.btn.sm',
        {
          type: 'button',
          title: 'Stop its turn (X at the Orchestrator)',
          onclick: () => {
            if (net.send({ t: 'orchestrator.interrupt' })) toast(`✋ Stopping ${w.name}`);
          },
        },
        'Stop',
      )
    : null;
  const fresh = w
    ? h(
        'button.btn.sm.ghost',
        {
          type: 'button',
          title: 'Start its conversation over. Its team stays its team.',
          onclick: () => newOrchestratorConversation(net),
        },
        'New conversation',
      )
    : null;
  openPrompt({
    title: `🛰️ ${w?.name ?? ORCHESTRATOR_NAME}`,
    subtitle: !w ? ABOUT : busy ? `${STATUS_LABEL[w.status] ?? w.status}${w.task?.name ? ` · ${w.task.name}` : ''}. Send steers its turn; Queue waits until it's over.` : (w.task?.name ?? ABOUT),
    warning: w?.status === 'needs_input' ? `${w.name} is waiting on an answer: open its terminal to reply.` : undefined,
    placeholder: 'What do you want done? It can hire and direct workers on any floor',
    imagesOption: true,
    workerId: ORCHESTRATOR_ID,
    queueOption: busy,
    actions: [terminal, stop, fresh],
    onSubmit: (text, opts) => net.send({ t: 'orchestrator.prompt', prompt: text, images: opts.images.length ? opts.images : undefined, queue: opts.queue || undefined }),
  });
}

function orchestratorOff(net: Net, actions: OrchestratorActions) {
  const on = h('button.btn.accent', { type: 'button' }, 'Turn it on');
  const settings = h('button.btn.ghost', { type: 'button' }, 'Settings');
  const el = h(
    'div.modal',
    { role: 'dialog', 'aria-label': 'The Orchestrator is off' },
    windowHeader('🛰️ The Orchestrator is off', 'Mission Control'),
    h('div.body.stack', {}, h('p', {}, ABOUT), h('p.note.info', {}, 'While it is off, its team carries on working and reports to nobody until it is back.')),
    h('footer', {}, h('span.grow'), settings, on),
  );
  const modal = openModal(el, { size: 'sm' });
  settings.addEventListener('click', () => {
    modal.close();
    actions.settings();
  });
  on.addEventListener('click', () => {
    const settingsNow = store.missionControl?.orchestrator.settings;
    if (!net.send({ t: 'orchestrator.set', settings: { ...settingsNow, on: true } })) {
      toast('Disconnected. The Orchestrator is still off.', 'error');
      return;
    }
    modal.close();
    toast('🛰️ The Orchestrator is on. Press E at it, or M anywhere, to talk to it');
  });
  setTimeout(() => on.focus(), 30);
}

function orchestratorBlocked(why: string, actions: OrchestratorActions) {
  const settings = h('button.btn.primary', { type: 'button' }, 'Open Settings');
  const close = h('button.btn.ghost', { type: 'button' }, 'Close');
  const el = h(
    'div.modal',
    { role: 'alertdialog', 'aria-label': "The Orchestrator can't start" },
    windowHeader("🛰️ The Orchestrator can't start", 'Mission Control'),
    h('div.body.stack', {}, h('p.note.bad', { role: 'alert' }, why || 'Something stops it starting.'), h('p', {}, 'Fix that and it starts on your next prompt.')),
    h('footer', {}, h('span.grow'), close, settings),
  );
  const modal = openModal(el, { size: 'sm' });
  close.addEventListener('click', () => modal.close());
  settings.addEventListener('click', () => {
    modal.close();
    actions.settings();
  });
  setTimeout(() => settings.focus(), 30);
}

export interface BotActions {
  /** One of its subagents, here or on its floor. */
  openMember(m: MissionTeamMember): void;
}

/** E at a bot at the table: it runs elsewhere, so this says what it last reported and who is on its team. */
export function openBot(id: string, actions: BotActions) {
  const bot = () => store.missionControl?.bots.find((b) => b.worker.id === id);
  const first = bot();
  if (!first) return;
  const body = h('div.body.stack');
  const sub = h('p.sub');
  const paint = () => {
    const b = bot();
    if (!b) {
      modal.close();
      return;
    }
    const w = b.worker;
    sub.textContent = `Runs externally · last used ${lastUsedWords(b.lastUsedAt, Date.now())}`;
    const status = h('div.row', {}, h('span.pill', { class: w.status }, STATUS_LABEL[w.status] ?? w.status), h('span.grow', {}, w.activity ?? w.task?.name ?? (w.status === 'offline' ? 'Nothing reported since the office started' : '')));
    const team = b.team.length
      ? h(
          'ul.list.boxed',
          { 'aria-label': `${w.name}'s team` },
          ...b.team.map((m) =>
            h(
              'li',
              {},
              h(
                'button.list-row',
                { type: 'button', title: m.floor === store.floor ? `Open ${m.name}'s terminal` : `Go to the ${m.floorName} floor and open ${m.name}'s terminal`, onclick: () => actions.openMember(m) },
                h('span.list-main', {}, h('span.list-title', {}, m.name), h('span.list-meta', {}, [m.floorName, m.activity ?? m.title].filter(Boolean).join(' · '))),
                h('span.list-end', {}, h('span.pill', { class: m.status }, STATUS_LABEL[m.status] ?? m.status)),
              ),
            ),
          ),
        )
      : emptyState('🧭', 'No team', 'Subagents it hires show here, with their floors.');
    body.replaceChildren(
      status,
      h('p.note.info', {}, 'This bot runs elsewhere and reaches the office over Tailscale MCP. It has no terminal or conversation here: messages reach it through its inbox.'),
      h('div.section', {}, h('div.eyebrow', {}, missionTeamLine(b.team) ?? 'Team'), team),
    );
  };
  const el = h('div.modal', { role: 'dialog', 'aria-label': first.worker.name }, h('header', {}, colorDot(first.worker.color), h('div.titles', {}, h('h2', {}, first.worker.name), sub)), body);
  const unsubscribe = store.on('missionControl', paint);
  const modal = openModal(el, { onClose: unsubscribe });
  paint();
}
