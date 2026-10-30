// One pane of the web companion's workspace (dashboard.ts): a worker's live terminal or thread, what
// the office knows of one with no local terminal, or a picker when the pane is empty.

import type { ClientMsg, WorkerInfo } from '../shared/protocol';
import { canAnswer, readMenu, sameMenu, type Menu } from '../shared/asks';
import { questionPresentation } from '../shared/ask-question';
import { isAsleep, isBusy, workerActivity } from '../shared/status';
import { statusWord } from '../shared/guests';
import { sessionWebUrl } from '../shared/factory-sessions';
import { forkRefusal } from '../shared/worker-fork';
import { draftKey } from './browser-session';
import type { Net } from './net';
import { previewRows } from './screen-preview';
import { doingLine, workerKind as kind } from './worker-words';
import { store } from './state';
import { h, STATUS_LABEL, toast } from './ui/dom';
import { colorDot } from './ui/kit';
import { icon, type IconName } from './ui/icons';
import { modelBadge, modelBadgeNode } from './ui/models';
import { openForkWorker } from './ui/fork-worker';
import { mountWorkerThread, type WorkerThread } from './ui/worker-thread';
import { openQuestionWorkspace, type QuestionDraft, type QuestionReply } from './ui/question-workspace';
import type { InlineTerminalHandle } from './ui/terminal';
import type { PaneView } from './dashboard-workspace';
import { workerTeams } from './dashboard-teams';

/** What a sidebar row carries when it's dragged onto a pane. */
export const WORKER_MIME = 'application/x-droid-worker';
/** What a pane's grip carries when it's dragged onto another pane. */
export const SLOT_MIME = 'application/x-droid-slot';
export const VIEW_KEY = 'droid-office.companion-view';

export type PaneMode = 'empty' | 'terminal' | 'thread' | 'info';

/** What a pane needs from the page around it. */
export interface PaneHost {
  net: Net;
  live(): boolean;
  floor(): string;
  busy(id: string): boolean;
  action(msg: ClientMsg, id: string, intendedFloor: string, done?: string): Promise<string | undefined>;
  usable(id: string, intendedFloor: string): boolean;
  read(key: string): string;
  remember(key: string, value: string): void;
  terminal(): Promise<typeof import('./ui/terminal')>;
  setView(id: string, view: PaneView): void;
  focus(index: number): void;
  close(index: number): void;
  toggleMax(index: number): void;
  assign(index: number, id: string): void;
  swap(from: number, to: number): void;
  /** Opens a teammate beside this pane. */
  openBeside(id: string): void;
  sendHome(w: WorkerInfo): void;
  hire(index: number): void;
}

export interface PaneState {
  worker?: WorkerInfo;
  view: PaneView;
  focused: boolean;
  maximized: boolean;
  canMaximize: boolean;
  /** Covered by another pane that is maximized. */
  covered: boolean;
  /** Workers on the floor not open in any pane, for an empty one to offer. */
  candidates: readonly WorkerInfo[];
  /** Whether the floor has anyone at all. */
  anyone: boolean;
  /** Whether a terminal opened now takes the keyboard. */
  takeFocus: boolean;
}

export interface Pane {
  readonly index: number;
  readonly el: HTMLElement;
  workerId(): string;
  mode(): PaneMode;
  update(state: PaneState): void;
  paintQuestion(review?: boolean): void;
  paintPreview(): void;
  /** After a reconnect: ask for this pane's terminal again. */
  reattach(): void;
  /** Puts the keyboard in the terminal or thread. */
  focusContent(): void;
  dispose(): void;
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

/** A worker's colour, ringed and pulsing by status. */
export function workerDot(w: WorkerInfo) {
  const el = h('span.dash-dot', { 'data-status': w.status, 'aria-hidden': 'true' });
  el.style.setProperty('--who', w.color);
  return el;
}

/** Three bars that bob while a worker works. */
export function workingBars(label = '') {
  return h('span.dash-bars', label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
}

export function renderPreview(into: HTMLElement, id: string, max: number) {
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

export function createPane(host: PaneHost, index: number): Pane {
  const grip = h('span.dash-pane-grip', { draggable: 'true', title: 'Drag to swap panes', 'aria-hidden': 'true' }, icon('grip', 13));
  const badge = h('span.dash-pane-no', {}, String(index + 1));
  const who = h('span.dash-pane-who');
  const name = h('span.dash-pane-name');
  const task = h('span.dash-pane-task');
  const model = h('span.dash-pane-model');
  const pill = h('span.pill');
  const views = h('div.seg.dash-pane-views', { role: 'group' });
  const flip = h('button.btn.icon.sm.ghost.dash-pane-flip', { type: 'button' });
  const actions = h('div.dash-pane-actions', { role: 'group', 'aria-label': 'Worker actions' });
  const maxBtn = h('button.btn.icon.sm.ghost', { type: 'button', onclick: () => host.toggleMax(index) });
  const closeBtn = h('button.btn.icon.sm.ghost.dash-pane-close', { type: 'button', 'aria-label': 'Close pane', title: 'Close pane', onclick: () => host.close(index) }, icon('x', 14));
  const head = h('header.dash-pane-head', {}, grip, badge, who, h('span.dash-pane-titles', {}, name, task, model), pill, views, flip, actions, maxBtn, closeBtn);
  const teamNav = h('nav.dash-team-nav', { 'aria-label': 'Worker team', hidden: true });
  const question = h('section.dash-question', { 'aria-label': 'Question requiring input', hidden: true });
  const stage = h('div.dash-stage');
  const body = h('div.dash-pane-body', {}, question, stage);
  const drop = h('div.dash-pane-drop', { 'aria-hidden': 'true' }, h('span', {}, 'Drop to open here'));
  const el = h('section.dash-pane', {}, head, teamNav, body, drop);

  let id = '';
  let mode: PaneMode | '' = '';
  let term: InlineTerminalHandle | undefined;
  let opening = false;
  let thread: WorkerThread | undefined;
  let disposed = false;
  let headKey = '';
  let actionsKey = '';
  let emptyKey = '';
  let teamKey = '';
  let info: { name: HTMLElement; meta: HTMLElement; activity: HTMLElement; who: HTMLElement; preview?: HTMLElement } | undefined;

  let shownMenu: Menu | undefined;
  let questionKey = '';
  let questionDraft: QuestionDraft = { text: '' };
  let questionWorkspace: ReturnType<typeof openQuestionWorkspace> | undefined;
  let answered = false;
  let questionReplying = false;
  let answerSettlesAt = 0;

  // --- Focus and drag-and-drop ------------------------------------------------------------------
  el.addEventListener('pointerdown', () => host.focus(index), true);
  el.addEventListener('focusin', () => host.focus(index));
  grip.addEventListener('dragstart', (e) => {
    e.dataTransfer?.setData(SLOT_MIME, String(index));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  const accepts = (e: DragEvent) => !!e.dataTransfer && (e.dataTransfer.types.includes(WORKER_MIME) || e.dataTransfer.types.includes(SLOT_MIME));
  el.addEventListener('dragover', (e) => {
    if (!accepts(e) || !host.live()) return;
    e.preventDefault();
    el.classList.add('drop-over');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget as Node | null)) el.classList.remove('drop-over');
  });
  el.addEventListener('drop', (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    el.classList.remove('drop-over');
    const wid = e.dataTransfer?.getData(WORKER_MIME);
    const from = e.dataTransfer?.getData(SLOT_MIME);
    if (wid) host.assign(index, wid);
    else if (from) host.swap(Number(from), index);
  });

  // --- The body ---------------------------------------------------------------------------------
  function teardown(keepThread = false) {
    questionWorkspace?.close();
    if (keepThread) thread?.activate(false);
    else {
      thread?.dispose();
      thread = undefined;
    }
    term?.close();
    term = undefined;
    opening = false;
    info = undefined;
    emptyKey = '';
  }

  function reset(next: string) {
    teardown();
    id = next;
    mode = '';
    headKey = '';
    actionsKey = '';
    shownMenu = undefined;
    questionKey = '';
    questionDraft = { text: next ? host.read(draftKey(host.floor(), `${next}:answer`)) : '' };
    answered = false;
    questionReplying = false;
    answerSettlesAt = 0;
    question.hidden = true;
    question.replaceChildren();
  }

  function modeFor(w: WorkerInfo | undefined, view: PaneView): PaneMode {
    if (!w) return 'empty';
    const local = !w.guest && !w.cloud;
    if (local && w.kind === 'agent' && view === 'thread') return 'thread';
    return local && !isAsleep(w.status) ? 'terminal' : 'info';
  }

  function build(w: WorkerInfo | undefined, next: PaneMode) {
    teardown(!!w && next !== 'empty');
    mode = next;
    el.dataset.mode = next;
    if (next === 'empty' || !w) {
      stage.replaceChildren();
      return;
    }
    if (next === 'info') {
      info = { name: h('h2'), activity: h('p.dash-info-activity'), meta: h('dl.dash-meta'), who: h('div.dash-info-who') };
      const s = store.screens.get(w.id);
      info.preview = s ? h('pre.dash-preview.big', { 'aria-label': `${w.name}’s screen` }) : undefined;
      stage.replaceChildren(h('div.dash-info', {}, info.who, info.activity, info.preview ?? null, info.meta));
    } else if (next === 'thread') {
      const intended = host.floor();
      const key = draftKey(intended, w.id);
      thread ??= mountWorkerThread(host.net, {
        worker: w,
        question,
        queueKey: `${key}:queue-receipts`,
        draft: host.read(key),
        onDraft: (text) => host.remember(key, text),
        onEntries: () => paintQuestion(),
        send: (msg) => host.action(msg, w.id, intended),
        screen: () => lines(w.id),
        team: () => (host.floor() === intended ? [...store.workers.values()] : []),
        openWorker: (mate) => {
          if (!host.usable(mate, intended)) return;
          host.setView(mate, 'thread');
          host.openBeside(mate);
        },
        raw: () => host.setView(w.id, 'terminal'),
      });
      thread.element.querySelector('.wt-scroll')?.append(question);
      stage.replaceChildren(thread.element);
      thread.activate(true);
    } else stage.replaceChildren(h('div.dash-stage-wait', {}, h('div.spinner'), h('span', {}, 'Opening the terminal…')));
  }

  async function openTerm(wid: string, takeFocus: boolean) {
    if (term || opening) return;
    opening = true;
    const intended = host.floor();
    const terminal = await host.terminal();
    opening = false;
    if (disposed || mode !== 'terminal' || id !== wid || term || !stage.isConnected || !host.usable(wid, intended)) return;
    term = terminal.openTerminal(host.net, wid, undefined, undefined, { mount: stage, focus: takeFocus, hideTeam: true });
  }

  // --- The header -------------------------------------------------------------------------------
  function paintTeam(w: WorkerInfo | undefined) {
    const team = w && workerTeams([...store.workers.values()]).find((t) => t.children.length && (t.lead.id === w.id || t.children.some((c) => c.id === w.id)));
    const members = team ? [team.lead, ...team.children] : [];
    const key = JSON.stringify([w?.id, host.live(), members.map((m) => [m.id, m.name, m.color, m.status, m.acked])]);
    if (key === teamKey) return;
    teamKey = key;
    teamNav.hidden = !team;
    if (!team) {
      teamNav.replaceChildren();
      return;
    }
    const focused = teamNav.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.member : undefined;
    const scroll = teamNav.querySelector('.dash-team-nav-members')?.scrollLeft ?? 0;
    const intended = host.floor();
    const chip = (m: WorkerInfo, lead: boolean) =>
      h(
        'button.dash-team-chip',
        {
          type: 'button',
          'data-member': m.id,
          'data-status': m.status,
          'aria-current': String(m.id === w?.id),
          disabled: !host.live(),
          title: `${m.name} · ${lead ? 'Main worker' : `Subworker of ${team.lead.name}`} · ${statusWord(m, STATUS_LABEL)}`,
          'aria-label': `Open ${m.name}, ${lead ? 'main worker' : 'subworker'}, ${statusWord(m, STATUS_LABEL)}`,
          onclick: () => {
            if (host.usable(m.id, intended)) host.assign(index, m.id);
          },
        },
        lead ? h('span.dash-team-chip-role', {}, 'Lead') : null,
        workerDot(m),
        h('span.dash-team-chip-name', {}, m.name),
      );
    teamNav.replaceChildren(chip(team.lead, true), h('span.dash-team-nav-label', {}, icon('branch', 12), `${team.children.length}`), h('div.dash-team-nav-members', {}, ...team.children.map((m) => chip(m, false))));
    const memberList = teamNav.querySelector('.dash-team-nav-members');
    if (memberList) memberList.scrollLeft = scroll;
    if (focused)
      Array.from(teamNav.querySelectorAll<HTMLButtonElement>('button'))
        .find((b) => b.dataset.member === focused)
        ?.focus({ preventScroll: true });
  }

  function paintHead(s: PaneState) {
    const w = s.worker;
    const local = !!w && !w.guest && !w.cloud;
    const threaded = mode === 'thread';
    const key = JSON.stringify([w && [w.id, w.name, w.color, w.status, w.acked, doingLine(w), w.task?.name, w.title, w.activeModel ?? w.model, w.activeEffort ?? w.effort], mode, s.maximized, s.canMaximize, host.live()]);
    if (key === headKey) return;
    headKey = key;
    el.setAttribute('aria-label', w ? `Pane ${index + 1}: ${w.name}` : `Pane ${index + 1}: empty`);
    grip.hidden = !w;
    closeBtn.hidden = !w;
    maxBtn.hidden = !s.canMaximize;
    maxBtn.replaceChildren(icon(s.maximized ? 'minimize' : 'maximize', 13));
    maxBtn.setAttribute('aria-label', s.maximized ? 'Restore layout' : 'Maximize pane');
    maxBtn.title = `${s.maximized ? 'Restore layout' : 'Maximize pane'} (⌘ ↵)`;
    if (!w) {
      who.replaceChildren();
      name.textContent = 'Empty pane';
      task.textContent = '';
      model.textContent = '';
      pill.hidden = true;
      views.hidden = flip.hidden = true;
      return;
    }
    who.replaceChildren(workerDot(w));
    name.textContent = w.name;
    name.title = `${w.name} · ${kind(w)}`;
    const doing = w.task?.name ?? w.title ?? doingLine(w);
    task.textContent = doing;
    task.title = doing;
    model.textContent = (w.kind === 'agent' ? modelBadge(w.activeModel ?? w.model, w.activeEffort ?? w.effort) : kind(w)) ?? '';
    pill.hidden = false;
    pill.className = `pill ${w.status}`;
    pill.textContent = statusWord(w, STATUS_LABEL);
    const toggles = local && w.kind === 'agent';
    views.hidden = flip.hidden = !toggles;
    views.setAttribute('aria-label', `${w.name} view`);
    views.replaceChildren(
      ...(['thread', 'terminal'] as const).map((value) =>
        h(
          'button',
          {
            type: 'button',
            class: `btn sm ${(threaded ? 'thread' : 'terminal') === value ? 'on' : ''}`,
            'aria-pressed': String((threaded ? 'thread' : 'terminal') === value),
            onclick: () => host.setView(w.id, value),
          },
          value === 'thread' ? 'Thread' : 'TTY',
        ),
      ),
    );
    flip.replaceChildren(icon(threaded ? 'terminal' : 'message', 14));
    flip.setAttribute('aria-label', threaded ? 'Show raw terminal' : 'Show thread');
    flip.title = flip.getAttribute('aria-label') ?? '';
    flip.onclick = () => host.setView(w.id, threaded ? 'terminal' : 'thread');
  }

  function paintActions(w: WorkerInfo | undefined) {
    const enabled = !!w && host.live() && !host.busy(w.id);
    const key = JSON.stringify(w ? [w.id, w.name, w.kind, w.status, w.guest ? 1 : 0, w.cloud ? 1 : 0, w.sessionId, w.pr, w.prOpening, w.worktree?.branch, w.lost ? 1 : 0, forkRefusal(w), mode, enabled] : null);
    if (key === actionsKey) return;
    actionsKey = key;
    if (!w) return actions.replaceChildren();
    const btn = (label: string, glyph: IconName, ok: boolean, run: () => void, cls = '', tip = '') =>
      h('button.btn.icon.sm.ghost', { type: 'button', class: cls, title: tip || label, 'aria-label': label, disabled: !enabled || !ok, onclick: run }, icon(glyph, 14));
    const asleep = isAsleep(w.status);
    const local = !w.guest && !w.cloud;
    const intended = host.floor();
    const fork = local && w.kind === 'agent' ? forkRefusal(w) : 'none';
    actions.replaceChildren(
      ...(w.cloud && w.sessionId ? [h('a.btn.icon.sm.ghost', { href: sessionWebUrl(w.sessionId), target: '_blank', rel: 'noopener noreferrer', title: 'Factory session', 'aria-label': 'Factory session' }, icon('external', 14))] : []),
      ...(asleep && !w.guest
        ? [
            btn(
              w.kind === 'shell' ? 'Restart' : 'Resume',
              'play',
              !w.lost,
              () =>
                void host.action({ t: 'worker.resume', workerId: w.id }, w.id, intended, `${w.name} is waking up.`).then((error) => {
                  if (error) toast(error, 'warn');
                }),
              'dash-resume',
            ),
          ]
        : []),
      ...(w.pr
        ? [h('a.btn.sm.ghost.dash-pane-pr', { href: safeLink(w.pr.url), target: '_blank', rel: 'noopener noreferrer', title: `Pull request #${w.pr.number}` }, icon('pr', 13), h('span', {}, `#${w.pr.number}`))]
        : local && w.worktree
          ? [
              btn(
                'Open PR',
                'pr',
                !w.lost && !w.prOpening && !isBusy(w.status),
                () =>
                  void host.action({ t: 'worker.pr', workerId: w.id }, w.id, intended, 'Opening a pull request…').then((error) => {
                    if (error) toast(error, 'warn');
                  }),
                '',
                'Push its branch and open a pull request',
              ),
            ]
          : []),
      ...(fork !== 'none' ? [btn('Fork', 'fork', !fork, () => openForkWorker(host.net, w.id), '', fork ?? 'Fork this conversation and its files into an independent worker')] : []),
      btn('Send home', 'home', !w.guest, () => host.sendHome(w), 'dash-home', 'Send it home'),
    );
  }

  // --- An empty pane ----------------------------------------------------------------------------
  function paintEmpty(s: PaneState) {
    const key = JSON.stringify([s.candidates.map((w) => [w.id, w.name, w.color]), s.anyone, host.live()]);
    if (key === emptyKey) return;
    emptyKey = key;
    const chips = s.candidates.map((w) => {
      const chip = h('button.dash-pick', { type: 'button', disabled: !host.live(), onclick: () => host.assign(index, w.id) }, colorDot(w.color), h('span', {}, w.name));
      return chip;
    });
    stage.replaceChildren(
      h(
        'div.dash-empty',
        {
          'data-live': String(host.live()),
          onclick: (e) => {
            if (host.live() && e.target instanceof Element && !e.target.closest('button')) host.hire(index);
          },
        },
        h('div.dash-empty-icon', {}, icon('panes', 18)),
        h('h3', {}, s.anyone ? 'Open a worker here' : 'Nobody on this floor yet'),
        h('p', {}, s.anyone ? (chips.length ? 'Pick someone from the floor, or drag them in from the list.' : 'Everyone on the floor is open in another pane.') : 'Hire a Droid and its terminal opens here.'),
        chips.length ? h('div.dash-picks', {}, ...chips) : null,
        h('button.btn.accent', { type: 'button', disabled: !host.live(), onclick: () => host.hire(index) }, icon('plus', 14), 'Hire Droid here'),
      ),
    );
  }

  // --- No local terminal: what the office knows -------------------------------------------------
  function paintInfo(w: WorkerInfo) {
    if (!info) return;
    info.who.replaceChildren(workerDot(w), h('div', {}, h('div.dash-info-name', {}, info.name), h('div.dash-info-kind', {}, kind(w))));
    info.name.textContent = w.name;
    info.activity.textContent = workerActivity(w) ?? w.prompt ?? 'Waiting for a task.';
    const lead = w.lead && store.workers.get(w.lead);
    const team = store.teamOf(w.id);
    const rows: [string, string | undefined][] = [
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
      ['Subagents', team.length ? team.map((m) => m.name).join(', ') : undefined],
      ['Other projects', w.repos?.map((r) => `${r.name} · ${r.branch}`).join(', ')],
    ];
    info.meta.replaceChildren(...rows.filter(([, v]) => !!v).flatMap(([label, value]) => [h('dt', {}, label), h('dd', { title: value }, label === 'Model' ? modelBadgeNode(w.activeModel ?? w.model, w.activeEffort ?? w.effort) : value)]));
    if (info.preview) renderPreview(info.preview, w.id, 40);
  }

  // --- The worker's question --------------------------------------------------------------------
  function paintQuestion(review = false) {
    const w = id ? store.workers.get(id) : undefined;
    if (!w || mode === 'empty' || !mode) return;
    const screen = lines(w.id);
    const next = screen && canAnswer(w, screen) ? readMenu(screen) : undefined;
    if (w.status !== 'needs_input') {
      shownMenu = undefined;
      answered = false;
    }
    if ((!shownMenu && next) || review || (answered && next && !sameMenu(shownMenu, next))) {
      shownMenu = next;
      answered = false;
      questionDraft.choices = undefined;
    }
    const current = sameMenu(shownMenu, next);
    const settling = questionReplying || Date.now() < answerSettlesAt;
    const entries = thread?.entries() ?? [];
    const display = shownMenu && questionPresentation(shownMenu, entries);
    const supported = !shownMenu?.multiSelect || store.workerAnswerMultiSelect;
    const live = host.live();
    const enabled = live && supported && current && !host.busy(w.id) && !answered && !questionReplying;
    const qs = shownMenu && { menu: shownMenu, entries, enabled, supported, sending: questionReplying, answered, current, connected: live };
    if (qs) questionWorkspace?.update(qs);
    else if (questionWorkspace && !settling) questionWorkspace.close();
    const key = JSON.stringify([shownMenu, display, current, supported, live, host.busy(w.id), answered, questionReplying, settling, w.status, mode]);
    if (key === questionKey) return;
    questionKey = key;
    question.hidden = !shownMenu && w.status !== 'needs_input';
    if (mode !== 'thread' && question.nextElementSibling !== stage) stage.before(question);
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
                : mode === 'thread'
                  ? 'This CLI dialog cannot be answered safely here. Open TTY to continue.'
                  : 'Its screen has no menu the companion can answer safely. Answer it in the terminal below.',
          ),
        ),
      );
      return;
    }
    const menu = shownMenu;
    const intended = host.floor();
    const reply = async (value: QuestionReply, answerMenu: Menu) => {
      if (!host.live() || questionReplying || answered || !host.usable(w.id, intended)) return;
      questionReplying = true;
      questionKey = '';
      paintQuestion();
      const error = await host.action({ t: 'worker.answer', workerId: w.id, menu: answerMenu, ...value }, w.id, intended, 'Answer sent.');
      if (id !== w.id || host.floor() !== intended) return;
      questionReplying = false;
      if (error) {
        answerSettlesAt = 0;
        toast(error, 'warn');
      } else {
        answered = true;
        const until = Date.now() + 3000;
        answerSettlesAt = until;
        setTimeout(() => {
          if (id !== w.id || answerSettlesAt !== until) return;
          questionKey = '';
          paintQuestion();
        }, 3000);
        questionDraft.text = '';
        questionDraft.choices = undefined;
        host.remember(draftKey(intended, `${w.id}:answer`), '');
      }
      questionKey = '';
      paintQuestion();
    };
    question.replaceChildren(
      h(
        'div.dash-question-card',
        {},
        h('div.dash-question-top', {}, h('span.eyebrow', {}, `${w.name} needs your answer`), answered ? h('span.pill.done', {}, 'Sent') : null),
        h('h3.dash-question-preview', {}, display?.question ?? menu.question ?? 'Choose an answer'),
        h('div.dash-question-summary', {}, `${display?.position ? `Question ${display.position} of ${display.total} · ` : ''}${menu.multiSelect ? 'Select all that apply' : 'Select one answer'} · ${menu.choices.length} options`),
        h(
          'button.btn.accent',
          {
            type: 'button',
            disabled: !live || questionReplying,
            onclick: () => {
              if (questionWorkspace || !qs) return;
              questionWorkspace = openQuestionWorkspace({
                name: w.name,
                state: qs,
                draft: questionDraft,
                onDraft: () => host.remember(draftKey(intended, `${w.id}:answer`), questionDraft.text),
                reply,
                review: () => {
                  questionKey = '';
                  paintQuestion(true);
                },
                raw: () => host.setView(w.id, 'terminal'),
                onClose: () => {
                  questionWorkspace = undefined;
                },
              });
            },
          },
          answered ? 'View answer status' : 'Answer questions',
        ),
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

  const pane: Pane = {
    index,
    el,
    workerId: () => id,
    mode: () => (mode || 'empty') as PaneMode,
    update(s) {
      if (disposed) return;
      const w = s.worker;
      el.classList.toggle('focused', s.focused);
      el.classList.toggle('maximized', s.maximized);
      el.classList.toggle('covered', s.covered);
      el.classList.toggle('attn', w?.status === 'needs_input');
      el.toggleAttribute('inert', s.covered);
      badge.title = `Pane ${index + 1}`;
      if ((w?.id ?? '') !== id) reset(w?.id ?? '');
      const next = modeFor(w, s.view);
      if (next !== mode) build(w, next);
      paintHead(s);
      paintTeam(w);
      paintActions(w);
      if (!w) return paintEmpty(s);
      if (mode === 'terminal') void openTerm(w.id, s.takeFocus);
      else if (mode === 'thread') thread?.update(w, host.live());
      else paintInfo(w);
      paintQuestion();
    },
    paintQuestion,
    paintPreview() {
      const w = id ? store.workers.get(id) : undefined;
      if (w && mode === 'info' && info?.preview) renderPreview(info.preview, w.id, 40);
    },
    reattach() {
      term?.attach();
    },
    focusContent() {
      if (term) term.focus();
      else (mode === 'thread' ? thread?.element.querySelector<HTMLElement>('textarea, .wt-scroll') : stage.querySelector<HTMLElement>('button, [tabindex]'))?.focus({ preventScroll: true });
    },
    dispose() {
      if (disposed) return;
      teardown();
      disposed = true;
      el.remove();
    },
  };
  return pane;
}
