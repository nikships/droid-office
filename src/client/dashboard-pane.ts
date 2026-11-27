// One pane of the web companion's workspace (dashboard.ts): a worker's live terminal or thread, what
// the office knows of one with no local terminal, or a picker when the pane is empty.

import type { ClientMsg, WorkerInfo, WorkerStatus } from '../shared/protocol';
import { canAnswer, sameMenu, workerMenu, type Menu } from '../shared/asks';
import { pendingQuestions, questionPresentation, replySummary } from '../shared/ask-question';
import { isAsleep, isBusy, needsOwnerInput, STATUS_MARK_WORD, statusMark, type StatusMark, workerActivity } from '../shared/status';
import { sessionWebUrl } from '../shared/factory-sessions';
import { forkRefusal } from '../shared/worker-fork';
import { draftKey } from './browser-session';
import type { Net } from './net';
import { previewRows } from './screen-preview';
import { doingLine, workerKind as kind } from './worker-words';
import { store } from './state';
import { h, STATUS_LABEL, timeAgo, toast } from './ui/dom';
import { colorDot } from './ui/kit';
import { grokBotLogo, icon, orchestratorIcon, type IconName } from './ui/icons';
import { modelBadgeLabel, modelBadgeNode } from './ui/models';
import { mountWorkerThread, type WorkerThread } from './ui/worker-thread';
import type { QuestionDraft, QuestionReply, openQuestionWorkspace } from './ui/question-workspace';
import type { InlineTerminalHandle } from './ui/terminal';
import type { PaneView } from './dashboard-workspace';
import { workerTeams } from '../shared/team';
import { missionAgent, ORCHESTRATOR_ID, type MissionAgent, type MissionControlState, type MissionTeamMember } from '../shared/mission-control';
import type { SettingsPane } from '../shared/settings-nav';
import { botLine, buildingAgent, missionLead, ORCHESTRATOR_EXAMPLES, ORCHESTRATOR_PITCH, orchestratorBlocked, orchestratorLine, orchestratorMessage, orchestratorSettingsPane, orchestratorStarted } from './mission';
import { orchestratorBlockedFor } from './dashboard-guest';
import { orchestratorAwake } from './mission-office';

/** What a sidebar row carries when it's dragged onto a pane. */
export const WORKER_MIME = 'application/x-droid-worker';
/** What a pane's number carries when it's dragged onto another pane. */
const SLOT_MIME = 'application/x-droid-slot';
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
  /** A worker on this floor, or a building agent (the Orchestrator, an external bot). */
  worker(id: string): WorkerInfo | undefined;
  /** Mission Control as the office last sent it. */
  mission(): MissionControlState | undefined;
  /** Opens a worker on its own floor: here at once, or once the page has gone there. */
  openAcross(id: string, floor: string): void;
  /** Asks, then starts the Orchestrator's conversation over. */
  resetOrchestrator(): void;
  settings(pane?: SettingsPane): void;
  /** Opens a worker's Changes window. */
  changes?(id: string): void;
  /** Puts a file from a worker's workspace on this floor's Whiteboard. */
  toWhiteboard?(workerId: string, path: string, intendedFloor: string): void;
  /** False on a view-only share link: the pane only watches. Absent means true. */
  work?(): boolean;
  /** False on a share link: Settings and other owner-only surfaces are left out. Absent means true. */
  owner?(): boolean;
  /** True on a single-worker share link: the pane can't be closed, swapped or pointed at a teammate. */
  pinned?(): boolean;
  /** False on a share link: workers open in their Thread, with no terminal. Absent means true. */
  tty?(): boolean;
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
  move(index: number): void;
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

/** A worker's colour, ringed and pulsing by status; `plain` beside a status icon, which says that itself. */
export function workerDot(w: WorkerInfo, plain = false) {
  return statusDot(w.status, w.color, plain);
}

/** A status dot in a colour: for a building agent's subagent, which may sit on another floor, its lead's. */
export function statusDot(status: WorkerStatus, color: string, plain = false) {
  const el = h(plain ? 'span.dash-dot.plain' : 'span.dash-dot', { 'data-status': status, 'aria-hidden': 'true' });
  el.style.setProperty('--who', color);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag: string, attrs: Record<string, string | number> = {}, ...children: SVGElement[]) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}

/** The shapes of each mark on a 24-unit grid, animated by style.css `.dash-status`. */
function markShapes(mark: StatusMark): SVGElement[] {
  switch (mark) {
    case 'working':
      return [3.1, 10, 16.9].map((x) => svg('rect', { x, y: 2, width: 4, height: 19, rx: 2 }));
    case 'starting':
      return [svg('path', { d: 'M12 3.4a8.6 8.6 0 1 1-8.6 8.6' })];
    case 'ready':
      return [svg('path', { d: 'm3.4 6.2 6.2 5.8-6.2 5.8' }), svg('path', { class: 'caret', d: 'M13 18.2h7.6' })];
    case 'needs_you':
    case 'blocked':
      return [svg('g', {}, svg('path', { d: 'M12 3.8v10', 'stroke-width': 3.3 }), svg('circle', { cx: 12, cy: 19.7, r: 2 }))];
    case 'done':
    case 'done_new':
      return [svg('path', { d: 'm3.4 12.5 6 6 11.2-12', pathLength: 1 })];
    case 'asleep':
      return [svg('path', { d: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z', 'stroke-width': 2 })];
  }
}

/** A status as a bare animated mark in its colour, read and hovered as its word. */
export function statusIcon(mark: StatusMark, size = 14) {
  const word = STATUS_MARK_WORD[mark];
  const title = svg('title');
  title.textContent = word;
  return svg('svg', { class: 'dash-status', 'data-mark': mark, viewBox: '0 0 24 24', width: size, height: size, role: 'img', 'aria-label': word }, title, ...markShapes(mark));
}

/** A worker's status icon: an Orchestrator that can't start says so with a still `!`. */
export function workerStatusIcon(w: Pick<WorkerInfo, 'status' | 'acked'>, size?: number, blocked = false) {
  return statusIcon(statusMark(w.status, w.acked, blocked), size);
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
          if (!r.color && !r.background && !r.bold && !r.dim && !r.italic && !r.decoration && r.cols === undefined) return r.text;
          const span = h(
            'span',
            { class: [r.bold && 'b', r.dim && 'd', r.italic && 'i', (r.cols !== undefined || r.decoration || r.background) && 'dash-preview-cell', r.cols !== undefined && 'fixed-width', r.decoration].filter(Boolean).join(' ') },
            r.text,
          );
          if (r.color) span.style.color = r.color;
          if (r.background) span.style.background = r.background;
          if (r.cols !== undefined) span.style.width = `${r.cols}ch`;
          return span;
        }),
      ),
    ),
  );
}

export function createPane(host: PaneHost, index: number): Pane {
  const works = host.work?.() !== false;
  const owns = host.owner?.() !== false;
  const pinned = host.pinned?.() === true;
  const tty = host.tty?.() !== false;
  // The pane's number is its handle: drag it onto another pane to swap them.
  const badge = h('span.dash-pane-no', { title: 'Drag to swap panes' }, String(index + 1));
  const who = h('span.dash-pane-who');
  const name = h('span.dash-pane-name');
  const task = h('span.dash-pane-task');
  const model = h('span.dash-pane-model');
  const state = h('span.dash-pane-state');
  const views = h('div.seg.dash-pane-views', { role: 'group' });
  const flip = h('button.btn.icon.sm.ghost.dash-pane-flip', { type: 'button' });
  const actions = h('div.dash-pane-actions', { role: 'group', 'aria-label': 'Worker actions' });
  const findShortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘F' : 'Ctrl+Shift+F';
  const findLabel = `Find in terminal (${findShortcut})`;
  let pendingFind = false;
  const findBtn = h(
    'button.btn.icon.sm.ghost.dash-pane-find',
    {
      type: 'button',
      title: findLabel,
      'aria-label': findLabel,
      'aria-pressed': 'false',
      onclick: () => {
        if (term) term.toggleFind();
        else if (mode === 'terminal') pendingFind = !pendingFind;
      },
    },
    icon('search', 14),
  );
  const setFindOpen = (open: boolean) => {
    findBtn.classList.toggle('on', open);
    findBtn.setAttribute('aria-pressed', String(open));
  };
  const maxBtn = h('button.btn.icon.sm.ghost', { type: 'button', onclick: () => host.toggleMax(index) });
  const closeBtn = h('button.btn.icon.sm.ghost.dash-pane-close', { type: 'button', 'aria-label': 'Close pane', title: 'Close pane', onclick: () => host.close(index) }, icon('x', 14));
  const head = h('header.dash-pane-head', {}, badge, who, h('span.dash-pane-titles', {}, name, task, model), state, views, flip, actions, maxBtn, closeBtn);
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
  let info: { name: HTMLElement; meta: HTMLElement; activity: HTMLElement; who: HTMLElement; preview?: HTMLElement; team?: HTMLElement; key?: string } | undefined;
  /** What the Orchestrator's empty conversation shows, made once per pane. */
  let intro: HTMLElement | undefined;
  /** The Orchestrator session this pane's thread shows: a new conversation starts a new thread. */
  let orchestratorSession = '';

  let shownMenu: Menu | undefined;
  let questionKey = '';
  let questionDraft: QuestionDraft = { text: '' };
  let questionWorkspace: ReturnType<typeof openQuestionWorkspace> | undefined;
  /** What this pane sent for the questionnaire being asked, by position, for the workspace's step bar. */
  let series = { key: '', answers: {} as Record<number, string> };
  let answered = false;
  let questionReplying = false;
  let answerSettleTimer: number | undefined;

  // --- Focus and drag-and-drop ------------------------------------------------------------------
  let focusComposerOnClick = false;
  el.addEventListener(
    'pointerdown',
    (e) => {
      focusComposerOnClick = e.button === 0 && mode === 'thread' && !el.classList.contains('focused');
      host.focus(index);
    },
    true,
  );
  el.addEventListener('click', (e) => {
    const focusComposer = focusComposerOnClick;
    focusComposerOnClick = false;
    if (!focusComposer || !el.classList.contains('focused') || !(e.target instanceof Element)) return;
    if (e.target.closest('button, a, input, textarea, select, summary, [contenteditable], [role="button"], [draggable="true"]')) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && el.contains(selection.anchorNode)) return;
    pane.focusContent();
  });
  el.addEventListener('focusin', () => host.focus(index));
  badge.addEventListener('dragstart', (e) => {
    e.dataTransfer?.setData(SLOT_MIME, String(index));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  const accepts = (e: DragEvent) => !!e.dataTransfer && (e.dataTransfer.types.includes(WORKER_MIME) || e.dataTransfer.types.includes(SLOT_MIME));
  el.addEventListener('dragover', (e) => {
    if (pinned || !accepts(e) || !host.live()) return;
    e.preventDefault();
    el.classList.add('drop-over');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget as Node | null)) el.classList.remove('drop-over');
  });
  el.addEventListener('drop', (e) => {
    if (pinned || !accepts(e)) return;
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
    pendingFind = false;
    setFindOpen(false);
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
    series = { key: '', answers: {} };
    answered = false;
    questionReplying = false;
    clearTimeout(answerSettleTimer);
    answerSettleTimer = undefined;
    question.hidden = true;
    question.replaceChildren();
  }

  function modeFor(w: WorkerInfo | undefined, view: PaneView): PaneMode {
    if (!w) return 'empty';
    // An external bot runs elsewhere: its pane says what it is and who's on its team.
    if (w.remote) return 'info';
    // Before its first prompt, or asleep, the Orchestrator has no terminal: its Thread is where a prompt starts it.
    if (w.id === ORCHESTRATOR_ID) return tty && view === 'terminal' && orchestratorAwake(host.mission()) ? 'terminal' : 'thread';
    // A cloud worker has no terminal here: its Thread is its Factory session.
    if (w.cloud) return 'thread';
    if (w.kind === 'agent' && (view === 'thread' || !tty)) return 'thread';
    return tty && !isAsleep(w.status) ? 'terminal' : 'info';
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
      if (w.remote) {
        info.team = h('div.dash-bot-team');
        stage.replaceChildren(
          h(
            'div.dash-info.dash-bot',
            {},
            info.who,
            info.activity,
            h(
              'p.note.info.dash-bot-note',
              {},
              icon('globe', 15),
              h('span', {}, 'This bot runs externally and reaches the office over Tailscale MCP. It has no terminal or conversation here: it reads messages and its team’s reports from its MCP inbox.'),
            ),
            info.meta,
            info.team,
          ),
        );
        return;
      }
      const s = store.screens.get(w.id);
      info.preview = s ? h('pre.dash-preview.big', { 'aria-label': `${w.name}’s screen` }) : undefined;
      stage.replaceChildren(h('div.dash-info', {}, info.who, info.activity, info.preview ?? null, info.meta));
    } else if (next === 'thread') {
      const intended = host.floor();
      const orchestrator = w.id === ORCHESTRATOR_ID;
      // The Orchestrator's conversation is the same on every floor, and so is its draft.
      const key = draftKey(orchestrator ? 'mission' : intended, w.id);
      thread ??= mountWorkerThread(host.net, {
        worker: w,
        question,
        queueKey: `${key}:queue-receipts`,
        draft: host.read(key),
        onDraft: (text) => host.remember(key, text),
        onEntries: () => paintQuestion(),
        send: (msg) => host.action(orchestrator ? orchestratorMessage(msg) : msg, w.id, intended),
        screen: w.cloud ? undefined : () => lines(w.id),
        team: () => (host.floor() === intended ? [...store.workers.values()] : []),
        openWorker: (mate) => {
          if (!host.usable(mate, intended)) return;
          host.setView(mate, 'thread');
          host.openBeside(mate);
        },
        raw:
          w.cloud || !tty
            ? undefined
            : () => {
                if (!orchestrator || orchestratorAwake(host.mission())) host.setView(w.id, 'terminal');
              },
        ...(tty ? {} : { noTerminal: true }),
        floor: intended,
        ...(works ? {} : { readOnly: true }),
        ...(works && host.changes && !w.cloud ? { openChanges: (id: string) => host.changes?.(id) } : {}),
        ...(works && host.toWhiteboard && !w.cloud ? { sendToWhiteboard: (id: string, path: string) => host.toWhiteboard?.(id, path, intended) } : {}),
        ...(orchestrator
          ? {
              intro: () => (orchestratorStarted(host.mission()) ? undefined : (intro ??= orchestratorIntro())),
              blocked: () => orchestratorBlockedFor(orchestratorBlocked(host.mission()), owns),
              ...(owns ? { blockedAction: h('button.btn.sm', { type: 'button', onclick: () => host.settings(orchestratorSettingsPane(host.mission())) }, icon('settings', 13), 'Settings') } : {}),
              interrupt: true,
              promptWakes: true,
            }
          : {}),
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
    term = terminal.openTerminal(host.net, wid, undefined, undefined, {
      mount: stage,
      focus: takeFocus,
      hideTeam: true,
      readOnly: !works,
      externalFind: true,
      onFindChange: setFindOpen,
    });
    if (pendingFind) {
      pendingFind = false;
      term?.toggleFind();
    }
  }

  /** The Orchestrator's empty conversation: what it's for, and (for a page that can prompt it) prompts that fill the composer. */
  function orchestratorIntro() {
    const fill = (text: string) => {
      const input = thread?.element.querySelector<HTMLTextAreaElement>('textarea.wt-input');
      if (!input || input.disabled) return;
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      input.setSelectionRange(text.length, text.length);
    };
    const heroBus = svg(
      'svg',
      { class: 'orc-hero-bus', width: 180, height: 45, viewBox: '0 0 180 45', preserveAspectRatio: 'xMaxYMid meet', 'aria-hidden': 'true' },
      svg('path', { class: 'orc-bus-rail', d: 'M0 22.5h10M14 22.5h22.5V7.5h138M14 22.5h160.5M14 22.5h22.5v15h138' }),
      svg('rect', { class: 'orc-bus-junction', x: 10, y: 20.5, width: 4, height: 4, rx: 0.6 }),
      svg('rect', { class: 'orc-bus-pad', x: 174.5, y: 5, width: 5, height: 5, rx: 0.8 }),
      svg('rect', { class: 'orc-bus-pad', x: 174.5, y: 20, width: 5, height: 5, rx: 0.8 }),
      svg('rect', { class: 'orc-bus-pad', x: 174.5, y: 35, width: 5, height: 5, rx: 0.8 }),
      svg('rect', { class: 'orc-bus-packet', x: 42, y: 6.5, width: 10, height: 2, rx: 0.5 }),
      svg('rect', { class: 'orc-bus-packet orc-bus-packet-b', x: 22, y: 21.5, width: 10, height: 2, rx: 0.5 }),
      svg('rect', { class: 'orc-bus-packet orc-bus-packet-c', x: 42, y: 36.5, width: 10, height: 2, rx: 0.5 }),
    );
    return h(
      'div.orc-intro',
      {},
      h(
        'div.orc-hero',
        {},
        h('div.orc-hero-head', {}, h('span.eyebrow', {}, h('span.no', {}, '01'), 'Mission Control'), h('span.orc-hero-status', {}, h('span.orc-hero-dot', { 'aria-hidden': 'true' }), 'Building-wide agent')),
        h('div.orc-hero-stage', { 'aria-hidden': 'true' }, h('div.orc-hero-emblem', {}, orchestratorIcon(28)), h('span.orc-hero-trunk'), heroBus),
      ),
      h('h3', {}, works ? 'Point it at the building.' : 'Nothing dispatched yet.'),
      h('p.orc-intro-copy', {}, ORCHESTRATOR_PITCH),
      // Watch-only: the suggestions fill a composer this page doesn't have.
      ...(works
        ? [
            h('span.eyebrow.orc-examples-eyebrow', {}, h('span.no', {}, '02'), 'Suggested dispatches'),
            h(
              'div.orc-examples',
              { role: 'group', 'aria-label': 'Example prompts' },
              ...ORCHESTRATOR_EXAMPLES.map(({ tag, prompt }, i) =>
                h(
                  'button.orc-example',
                  { type: 'button', title: 'Put this in the message box', 'aria-label': `Use this prompt: ${prompt}`, onclick: () => fill(prompt) },
                  h('span.orc-example-head', {}, h('span.orc-example-tag', {}, h('span.no', {}, `0${i + 1}`), tag), icon('arrow', 13)),
                  h('span.orc-example-text', {}, prompt),
                ),
              ),
            ),
          ]
        : []),
      h('p.orc-intro-foot', {}, works ? 'Wakes only on your prompt or when its own crew reports back.' : 'It starts when the owner gives it a prompt. This view shows its work as it happens.'),
    );
  }

  // --- The header -------------------------------------------------------------------------------
  /** A building agent's team across floors: the agent first, then its subagents, each tagged with its floor when it's elsewhere. */
  function paintMissionTeam(w: WorkerInfo, agent: MissionAgent) {
    const members = agent.team;
    const here = host.floor();
    const lead = agent.worker;
    const key = JSON.stringify(['mission', w.id, host.live(), here, [lead.id, lead.name, lead.color, lead.status], members.map((m) => [m.id, m.name, m.status, m.floor, m.floorName, store.workers.get(m.id)?.color])]);
    if (key === teamKey) return;
    teamKey = key;
    teamNav.hidden = !members.length;
    if (!members.length) return teamNav.replaceChildren();
    const leadChip = h(
      'button.dash-team-chip',
      {
        type: 'button',
        'data-member': lead.id,
        'data-status': lead.status,
        'aria-current': String(lead.id === w.id),
        disabled: !host.live(),
        title: `${lead.name} · Mission Control`,
        'aria-label': `Open ${lead.name}, Mission Control`,
        onclick: () => host.assign(index, lead.id),
      },
      h('span.dash-team-chip-role', {}, lead.remote ? 'Bot' : 'Lead'),
      workerDot(lead),
      h('span.dash-team-chip-name', {}, lead.name),
    );
    const chip = (m: MissionTeamMember) => {
      const where = m.floor === here ? 'this floor' : `the ${m.floorName} floor`;
      return h(
        'button.dash-team-chip',
        {
          type: 'button',
          'data-member': m.id,
          'data-status': m.status,
          'aria-current': String(m.id === w.id),
          disabled: !host.live(),
          title: `${m.name} · Subagent of ${lead.name} on ${where} · ${STATUS_LABEL[m.status] ?? m.status}`,
          'aria-label': `Open ${m.name}, subagent on ${where}, ${STATUS_LABEL[m.status] ?? m.status}`,
          onclick: () => host.openAcross(m.id, m.floor),
        },
        statusDot(m.status, store.workers.get(m.id)?.color ?? lead.color),
        h('span.dash-team-chip-name', {}, m.name),
        m.floor === here ? null : h('span.dash-team-chip-floor', {}, m.floorName),
      );
    };
    fillTeamNav(leadChip, members.map(chip));
  }

  /** Fills the team strip, keeping the keyboard on the chip it was on and the members scrolled where they were. */
  function fillTeamNav(lead: HTMLElement, members: HTMLElement[]) {
    const focused = teamNav.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.member : undefined;
    const scroll = teamNav.querySelector('.dash-team-nav-members')?.scrollLeft ?? 0;
    teamNav.replaceChildren(lead, h('span.dash-team-nav-label', {}, icon('branch', 12), `${members.length}`), h('div.dash-team-nav-members', {}, ...members));
    const memberList = teamNav.querySelector('.dash-team-nav-members');
    if (memberList) memberList.scrollLeft = scroll;
    if (focused)
      Array.from(teamNav.querySelectorAll<HTMLButtonElement>('button'))
        .find((b) => b.dataset.member === focused)
        ?.focus({ preventScroll: true });
  }

  function paintTeam(w: WorkerInfo | undefined) {
    const mission = w && (buildingAgent(host.mission(), w.id) ?? missionLead(host.mission(), w.lead));
    // A bot's own pane lists its team in full, so only its subagents' panes get the strip.
    if (pinned) {
      teamNav.hidden = true;
      return;
    }
    if (w && mission && !(w.remote && w.id === mission.worker.id)) return paintMissionTeam(w, mission);
    if (w?.remote) {
      teamKey = '';
      teamNav.hidden = true;
      return teamNav.replaceChildren();
    }
    const team = w && workerTeams([...store.workers.values()]).find((t) => t.children.length && (t.lead.id === w.id || t.children.some((c) => c.id === w.id)));
    const members = team ? [team.lead, ...team.children] : [];
    const key = JSON.stringify([w?.id, host.live(), members.map((m) => [m.id, m.name, m.color, m.status, m.acked, m.lead])]);
    if (key === teamKey) return;
    teamKey = key;
    teamNav.hidden = !team;
    if (!team) {
      teamNav.replaceChildren();
      return;
    }
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
          title: `${m.name} · ${lead ? 'Main worker' : `Subworker of ${team.lead.name}`} · ${STATUS_LABEL[m.status] ?? m.status}`,
          'aria-label': `Open ${m.name}, ${lead ? 'main worker' : 'subworker'}, ${STATUS_LABEL[m.status] ?? m.status}`,
          onclick: () => {
            if (host.usable(m.id, intended)) host.assign(index, m.id);
          },
        },
        lead ? h('span.dash-team-chip-role', {}, 'Lead') : null,
        workerDot(m),
        h('span.dash-team-chip-name', {}, m.name),
      );
    fillTeamNav(
      chip(team.lead, true),
      team.children.map((m) => chip(m, false)),
    );
  }

  /** What the header says it's doing: building agents say it as their Mission Control row does. */
  function headLine(w: WorkerInfo) {
    // The pane says why it's blocked in place of its composer.
    if (w.id === ORCHESTRATOR_ID) return orchestratorBlocked(host.mission()) ? 'Can’t start yet' : orchestratorLine(host.mission());
    const bot = w.remote ? missionAgent(host.mission(), w.id) : undefined;
    if (bot) return botLine(bot);
    return w.task?.name ?? w.title ?? doingLine(w);
  }

  function paintHead(s: PaneState) {
    const w = s.worker;
    const local = !!w && !w.cloud && !w.remote;
    const threaded = mode === 'thread';
    // The Orchestrator has a terminal only while a session it started is awake.
    const bot = w?.remote ? missionAgent(host.mission(), w.id) : undefined;
    const blocked = w?.id === ORCHESTRATOR_ID && !!orchestratorBlocked(host.mission());
    const toggles = tty && local && w.kind === 'agent' && (w.id !== ORCHESTRATOR_ID || !!orchestratorAwake(host.mission()));
    const key = JSON.stringify([w && [w.id, w.name, w.color, w.status, w.acked, w.lead, bot?.grokBot, blocked, headLine(w), w.activeModel ?? w.model, w.activeEffort ?? w.effort], toggles, mode, s.maximized, s.canMaximize, host.live()]);
    if (key === headKey) return;
    headKey = key;
    el.setAttribute('aria-label', w ? `Pane ${index + 1}: ${w.name}` : `Pane ${index + 1}: empty`);
    badge.draggable = !!w && !pinned;
    badge.title = pinned ? '' : 'Drag to swap panes';
    closeBtn.hidden = !w || pinned;
    maxBtn.hidden = !s.canMaximize;
    maxBtn.replaceChildren(icon(s.maximized ? 'minimize' : 'maximize', 13));
    maxBtn.setAttribute('aria-label', s.maximized ? 'Restore layout' : 'Maximize pane');
    maxBtn.title = `${s.maximized ? 'Restore layout' : 'Maximize pane'} (⌘ ↵)`;
    if (!w) {
      who.replaceChildren();
      name.textContent = 'Empty pane';
      task.textContent = '';
      model.replaceChildren();
      state.replaceChildren();
      views.hidden = flip.hidden = true;
      return;
    }
    who.replaceChildren(
      w.id === ORCHESTRATOR_ID
        ? h('span.dash-mission-mark.sm', { 'data-status': blocked ? 'blocked' : w.status, 'aria-hidden': 'true' }, orchestratorIcon(11, { animated: !blocked }), workerDot(w, true))
        : bot?.grokBot
          ? h('span.dash-mission-mark.sm', { 'data-status': w.status, 'aria-hidden': 'true' }, grokBotLogo(16), workerDot(w, true))
          : workerDot(w, true),
    );
    name.textContent = w.name;
    name.title = `${w.name} · ${kind(w)}`;
    const doing = headLine(w);
    task.textContent = doing;
    task.title = doing;
    const engine = w.kind === 'agent' ? modelBadgeNode(w.activeModel ?? w.model, w.activeEffort ?? w.effort) : kind(w);
    model.replaceChildren(...(engine ? [engine] : []));
    state.replaceChildren(workerStatusIcon(w, 16, blocked));
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
    const started = orchestratorStarted(host.mission());
    const key = JSON.stringify(w ? [w.id, w.name, w.kind, w.status, w.cloud ? 1 : 0, w.remote ? 1 : 0, w.sessionId, w.pr, w.prOpening, w.worktree?.branch, w.lost ? 1 : 0, forkRefusal(w), mode, enabled, started] : null);
    if (key === actionsKey) return;
    actionsKey = key;
    if (!w) return actions.replaceChildren();
    const find = mode === 'terminal' ? [findBtn] : [];
    const btn = (label: string, glyph: IconName, ok: boolean, run: () => void, cls = '', tip = '') =>
      h('button.btn.icon.sm.ghost', { type: 'button', class: cls, title: tip || label, 'aria-label': label, disabled: !enabled || !ok, onclick: run }, icon(glyph, 14));
    // A building agent has no desk to send it home from, no branch to open a PR for, and nothing to fork.
    if (w.id === ORCHESTRATOR_ID)
      return actions.replaceChildren(
        ...find,
        ...(works ? [btn('New conversation', 'refresh', started, () => host.resetOrchestrator(), 'dash-orc-reset', started ? 'Start a new conversation' : 'No conversation yet')] : []),
        ...(owns ? [btn('Orchestrator settings', 'settings', true, () => host.settings('orchestrator'), 'dash-orc-settings', 'Settings → Orchestrator')] : []),
      );
    if (w.remote) return actions.replaceChildren();
    if (!works)
      return actions.replaceChildren(
        ...find,
        ...(w.pr ? [h('a.btn.sm.ghost.dash-pane-pr', { href: safeLink(w.pr.url), target: '_blank', rel: 'noopener noreferrer', title: `Pull request #${w.pr.number}` }, icon('pr', 13), h('span', {}, `#${w.pr.number}`))] : []),
      );
    const asleep = isAsleep(w.status);
    const local = !w.cloud;
    const intended = host.floor();
    const fork = local && w.kind === 'agent' ? forkRefusal(w) : 'none';
    actions.replaceChildren(
      ...find,
      ...(w.cloud && w.sessionId ? [h('a.btn.icon.sm.ghost', { href: sessionWebUrl(w.sessionId), target: '_blank', rel: 'noopener noreferrer', title: 'Factory session', 'aria-label': 'Factory session' }, icon('external', 14))] : []),
      ...(asleep
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
      ...(fork !== 'none'
        ? [
            btn(
              'Fork',
              'fork',
              !fork,
              () => {
                void import('./ui/fork-worker').then(({ openForkWorker }) => openForkWorker(host.net, w.id));
              },
              '',
              fork ?? 'Fork this conversation and its files into an independent worker',
            ),
          ]
        : []),
      btn('Send home', 'home', true, () => host.sendHome(w), 'dash-home', 'Send it home'),
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
            if (works && host.live() && e.target instanceof Element && !e.target.closest('button')) host.hire(index);
          },
        },
        h('div.dash-empty-icon', {}, icon('panes', 18)),
        h('h3', {}, s.anyone ? 'Open a worker here' : 'Nobody on this floor yet'),
        h(
          'p',
          {},
          s.anyone
            ? chips.length
              ? 'Pick someone from the floor, or drag them in from the list.'
              : 'Everyone on the floor is open in another pane.'
            : works
              ? 'Hire a Droid and its terminal opens here.'
              : 'Workers appear here when the owner hires them.',
        ),
        chips.length ? h('div.dash-picks', {}, ...chips) : null,
        // The floor's one orange call to action when nobody works here yet; beside other panes the sidebar's Hire is.
        works ? h(s.anyone ? 'button.btn' : 'button.btn.accent', { type: 'button', disabled: !host.live(), onclick: () => host.hire(index) }, icon('plus', 14), 'Hire Droid here') : null,
      ),
    );
  }

  // --- No local terminal: what the office knows -------------------------------------------------
  /** An external bot: what it last reported, when it last signed in, and its subagents across floors. */
  function paintBot(w: WorkerInfo) {
    if (!info?.team) return;
    const bot = missionAgent(host.mission(), w.id);
    const team = bot?.team ?? [];
    const here = host.floor();
    const lastUsed = bot?.lastUsedAt ? timeAgo(bot.lastUsedAt) : 'Not since it was added';
    const key = JSON.stringify([w.name, w.color, w.status, w.activity, w.title, lastUsed, bot?.grokBot, here, host.live(), team, team.map((m) => store.workers.get(m.id)?.color)]);
    if (key === info.key) return;
    info.key = key;
    info.who.replaceChildren(
      bot?.grokBot ? h('span.dash-mission-mark.lg', { 'data-status': w.status, 'aria-hidden': 'true' }, grokBotLogo(34), workerDot(w)) : workerDot(w),
      h('div', {}, h('div.dash-info-name', {}, info.name), h('div.dash-info-kind', {}, bot?.grokBot ? 'Grok Bot' : kind(w))),
    );
    info.name.textContent = w.name;
    info.activity.textContent = bot ? botLine(bot) : (w.activity ?? 'Hasn’t reported yet');
    // Offline, that line is what the Status row already says.
    info.activity.hidden = w.status === 'offline';
    const rows: [string, string | undefined][] = [
      ['Status', w.status === 'offline' ? 'Hasn’t reported since the office started' : (STATUS_LABEL[w.status] ?? w.status)],
      ['Doing', w.title],
      ['Delivery', bot?.grokBot ? 'Webhook push + inbox' : 'Polls its inbox'],
      ['Last used', lastUsed],
      ['Keys', 'Settings → Tailscale MCP'],
    ];
    info.meta.replaceChildren(...rows.filter(([, v]) => !!v).flatMap(([label, value]) => [h('dt', {}, label), h('dd', { title: value }, value)]));
    info.team.replaceChildren(
      h('span.eyebrow', {}, team.length ? `Team · ${team.length}` : 'Team'),
      team.length
        ? h(
            'div.list.boxed',
            {},
            ...team.map((m) => {
              const status = STATUS_LABEL[m.status] ?? m.status;
              return h(
                'button.list-row.dash-bot-member',
                { type: 'button', disabled: !host.live(), 'data-member': m.id, title: `${m.name} · ${m.floorName} · ${status}`, onclick: () => host.openAcross(m.id, m.floor) },
                h('span.list-icon', {}, statusDot(m.status, store.workers.get(m.id)?.color ?? w.color)),
                h('span.list-main', {}, h('span.list-title', {}, m.name), h('span.list-meta', {}, m.activity ?? m.title ?? status)),
                h('span.list-end', {}, h('span.dash-row-floor', {}, m.floor === here ? 'This floor' : m.floorName)),
              );
            }),
          )
        : h('p.dash-bot-empty', {}, 'No subagents. Workers it hires on any floor show here.'),
    );
  }

  function paintInfo(w: WorkerInfo) {
    if (!info) return;
    if (w.remote) return paintBot(w);
    info.who.replaceChildren(workerDot(w), h('div', {}, h('div.dash-info-name', {}, info.name), h('div.dash-info-kind', {}, kind(w))));
    info.name.textContent = w.name;
    info.activity.textContent = workerActivity(w) ?? w.prompt ?? 'Waiting for a task.';
    info.activity.hidden = false;
    const lead = w.lead && store.workers.get(w.lead);
    const team = store.teamOf(w.id);
    const rows: [string, string | undefined][] = [
      ['Model', w.kind === 'agent' ? modelBadgeLabel(w.activeModel ?? w.model, w.activeEffort ?? w.effort) : undefined],
      ['Task', w.task?.name ?? w.title],
      ['Branch', w.worktree?.branch ?? store.currentFloor()?.branch],
      ['Worktree', w.worktree?.path],
      [
        'Where',
        w.lost
          ? 'Its worktree is missing, so it can’t resume or take prompts.'
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
    info.meta.replaceChildren(
      ...rows.filter(([, v]) => !!v).flatMap(([label, value]) => [h('dt', {}, label), h('dd', { title: value }, label === 'Model' ? modelBadgeNode(w.activeModel ?? w.model, w.activeEffort ?? w.effort, { words: true }) : value)]),
    );
    if (info.preview) renderPreview(info.preview, w.id, 40);
  }

  // --- The worker's question --------------------------------------------------------------------
  function paintQuestion(review = false) {
    const w = id ? host.worker(id) : undefined;
    if (!w || mode === 'empty' || !mode) return;
    const settling = questionReplying || answerSettleTimer !== undefined;
    if (w.status !== 'needs_input' && question.hidden && !shownMenu && !questionWorkspace && !settling) return;
    const screen = lines(w.id);
    const next = canAnswer(w, screen) ? workerMenu(w, screen) : undefined;
    if (w.status !== 'needs_input') {
      shownMenu = undefined;
      answered = false;
    }
    // The workspace follows the questionnaire: after an answer, or when the owner hasn't started on the
    // shown question (it was answered in the terminal), the next menu replaces it. A started draft waits.
    const untouched = !questionDraft.text.trim() && questionDraft.choices === undefined;
    if ((!shownMenu && next) || review || (next && !questionReplying && !sameMenu(shownMenu, next) && (answered || untouched))) {
      shownMenu = next;
      answered = false;
      questionDraft.choices = undefined;
    }
    const current = sameMenu(shownMenu, next);
    const entries = thread?.entries() ?? [];
    const asked = JSON.stringify(pendingQuestions(entries, w.ask).map((q) => [q.question, q.options]));
    if (asked !== series.key) series = { key: asked, answers: {} };
    const display = shownMenu && questionPresentation(shownMenu, entries, w.ask);
    const supported = !shownMenu?.multiSelect || store.workerAnswerMultiSelect;
    const live = host.live();
    const enabled = live && supported && current && !host.busy(w.id) && !answered && !questionReplying;
    const qs = shownMenu && { menu: shownMenu, entries, ask: w.ask, answers: series.answers, hasReview: !w.cloud, enabled, supported, sending: questionReplying, answered, current, connected: live };
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
            h('b', {}, works ? `${w.name} needs you. ` : `${w.name} is waiting for an answer. `),
            !works
              ? 'The owner answers it.'
              : w.cloud
                ? 'The office can’t answer this one from here: open its Factory session.'
                : !tty
                  ? 'This CLI dialog can’t be answered from a shared view. The owner answers it in the terminal.'
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
      clearTimeout(answerSettleTimer);
      answerSettleTimer = undefined;
      if (error) {
        toast(error, 'warn');
      } else {
        const sent = questionPresentation(answerMenu, thread?.entries() ?? [], w.ask);
        if (sent.position) series.answers = { ...series.answers, [sent.position]: replySummary(sent, value) };
        answered = true;
        // The timer owns the settling window; the wall clock may not have reached its deadline.
        answerSettleTimer = window.setTimeout(() => {
          answerSettleTimer = undefined;
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
        h('div.dash-question-top', {}, h('span.eyebrow', {}, works ? `${w.name} needs your answer` : `${w.name} is asking`), answered ? h('span.pill.done', {}, 'Sent') : null),
        h('h3.dash-question-preview', {}, display?.question ?? menu.question ?? 'Choose an answer'),
        h(
          'div.dash-question-summary',
          {},
          menu.review
            ? 'Review and submit your answers to continue'
            : `${display?.position ? `Question ${display.position} of ${display.total} · ` : ''}${menu.multiSelect ? 'Select all that apply' : 'Select one answer'} · ${menu.choices.length} options`,
        ),
        !works
          ? h('p.note.info', {}, 'View only: the owner answers this one.')
          : h(
              'button.btn.accent',
              {
                type: 'button',
                disabled: !live || questionReplying,
                onclick: () => {
                  if (questionWorkspace || !qs) return;
                  void import('./ui/question-workspace').then(({ openQuestionWorkspace }) => {
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
                      // A cloud worker has no terminal to fall back on.
                      raw: w.cloud || !tty ? undefined : () => host.setView(w.id, 'terminal'),
                      onClose: () => {
                        questionWorkspace = undefined;
                      },
                    });
                  });
                },
              },
              answered ? 'View answer status' : menu.review ? 'Review answers' : 'Answer questions',
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
    get index() {
      return index;
    },
    move(next) {
      if (next === index) return;
      index = next;
      badge.textContent = String(index + 1);
      headKey = '';
      emptyKey = '';
    },
    el,
    workerId: () => id,
    mode: () => (mode || 'empty') as PaneMode,
    update(s) {
      if (disposed) return;
      const w = s.worker;
      el.classList.toggle('focused', s.focused);
      el.classList.toggle('maximized', s.maximized);
      el.classList.toggle('covered', s.covered);
      el.classList.toggle('attn', !!w && needsOwnerInput(w));
      el.toggleAttribute('inert', s.covered);
      badge.title = `Pane ${index + 1}`;
      if ((w?.id ?? '') !== id) reset(w?.id ?? '');
      const next = modeFor(w, s.view);
      if (w?.id === ORCHESTRATOR_ID) {
        // Its first session grows out of the empty thread; any later change of session is a new conversation.
        const session = w.sessionId ?? '';
        const ended = !!orchestratorSession && session !== orchestratorSession;
        orchestratorSession = session;
        if (ended && mode === 'thread') {
          thread?.dispose();
          thread = undefined;
          mode = '';
        }
      } else orchestratorSession = '';
      if (next !== mode) build(w, next);
      paintHead(s);
      paintTeam(w);
      paintActions(w);
      if (!w) return paintEmpty(s);
      if (mode === 'terminal') void openTerm(w.id, s.takeFocus);
      else if (mode === 'thread') {
        thread?.update(w, host.live());
        // An example can only fill a composer that's there to take it.
        const blocked = !!orchestratorBlocked(host.mission());
        const open = host.live() && !blocked;
        intro?.classList.toggle('blocked', blocked);
        for (const b of intro?.querySelectorAll<HTMLButtonElement>('.orc-example') ?? []) b.disabled = !open;
      } else paintInfo(w);
      paintQuestion();
    },
    paintQuestion,
    paintPreview() {
      const w = id ? host.worker(id) : undefined;
      if (w && mode === 'info' && info?.preview) renderPreview(info.preview, w.id, 40);
    },
    reattach() {
      term?.attach();
    },
    focusContent() {
      if (term) term.focus();
      else
        (mode === 'thread' ? (thread?.element.querySelector<HTMLElement>('textarea:not(:disabled)') ?? thread?.element.querySelector<HTMLElement>('.wt-scroll')) : stage.querySelector<HTMLElement>('button, [tabindex]'))?.focus({
          preventScroll: true,
        });
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
