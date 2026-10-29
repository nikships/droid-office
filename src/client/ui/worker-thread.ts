import type { ClientMsg, ServerMsg, WorkerInfo } from '../../shared/protocol';
import { isAsleep, isBusy } from '../../shared/status';
import { presentThread, threadArguments, type ThreadRow } from '../../shared/thread-presentation';
import { CLEAR_DROID_QUEUE, readDroidQueue } from '../../shared/droid-queue';
import { slashCommands, slashOf, slashRefusal, slashSuggestions, type DroidSlashCommand, type SlashCommand } from '../../shared/slash-commands';
import { ThreadQueue } from '../../shared/thread-queue';
import type { Net, TerminalHold } from '../net';
import { ThreadHistory } from '../thread-history';
import { SubmittedDrafts, type SubmittedDraft } from '../draft-ack';
import { TeamThread, TeamThreadPaint, teamThreadBudget, teamThreadVisible, threadReadInterval } from '../team-thread';
import { h, STATUS_LABEL } from './dom';
import { colorDot } from './kit';
import { markdown } from './markdown';
import { forgetAllStagedImages, promptImages } from './images';
import { modelBadgeNode } from './models';
import { copy as copyText } from './clipboard';
import { withToken } from '../token';

/** What the owner typed and the pictures chosen for it, not sent yet. Same shape as CompanionDraft. */
export interface ThreadDraft {
  text: string;
  /** Opaque local handles, valid in this page only. */
  attachments: string[];
}

export interface WorkerThread {
  element: HTMLElement;
  entries(): readonly import('../../shared/worker-thread').ThreadEntry[];
  update(worker: WorkerInfo, connected: boolean): void;
  activate(active: boolean): void;
  /** The pane the owner is in reads every second and reads Team activity; others read less often. Default true. */
  focus(focused: boolean): void;
  getDraft(): ThreadDraft;
  /** Empties the composer and takes its pictures out on the office. Nothing is sent. */
  resetDraft(): void;
  dispose(): void;
}

export interface ThreadOptions {
  worker: WorkerInfo;
  controls: HTMLElement;
  question: HTMLElement;
  queueKey: string;
  draft: string;
  onDraft(text: string): void;
  /** The kept draft's pictures, as the opaque local handles onAttachments gave, put back under the box. */
  attachments?: readonly string[];
  /**
   * The pictures changed: opaque local handles, uploads still going included. With this, the caller
   * keeps the draft's pictures: disposing the view keeps them, and the caller takes them out
   * (forgetStagedImages, or forgetAllStagedImages on connection loss) when it drops the draft.
   */
  onAttachments?(handles: string[]): void;
  /** The connection was lost and the composer cleared itself (text and pictures). */
  onDraftReset?(): void;
  /**
   * A send succeeded: exactly the text (as kept in the draft) and picture handles it took. Fires even
   * when the view was disposed while the send was out, and then nothing else does: no onDraft('') and
   * no onAttachments. Apply it with acknowledgeDraft, which keeps anything added or edited since.
   */
  onSubmitted?(sent: SubmittedDraft): void;
  /** The floor the view was opened on, where its pictures are staged. */
  floor?: string;
  send(msg: ClientMsg): Promise<string | undefined>;
  raw(): void;
  /** The worker's terminal as text, one string per row, or undefined before it has drawn one. */
  screen?(): readonly string[] | undefined;
  onEntries?(): void;
  /** Current floor only; return no workers once the mounted floor is no longer current. */
  team?(): readonly WorkerInfo[];
  /** Open this child's Thread view, without starting or resuming a worker. */
  openWorker?(id: string): void;
}

const localQueues = new Map<string, ThreadQueue>();
const submittedDrafts = new SubmittedDrafts();
/** Mounted views reading their own conversation now, which share the server reader's cache with team reads. */
const pollingViews = new Set<object>();

/** Local sessions only. This view reads JSONL and uses the existing worker actions, never a second Droid. */
export function mountWorkerThread(net: Net, opts: ThreadOptions): WorkerThread {
  let worker = opts.worker;
  let connected = false;
  let active = false;
  let focused = true;
  let hold: TerminalHold | undefined;

  const self = {};
  let disposed = false;
  let sending = false;
  let resuming = false;
  let received = false;
  let error = '';
  /** Why the last thing the owner tried wasn't sent: shown until they change the draft. */
  let told = '';
  let pending: { request: string; before?: number; at: number } | undefined;
  let lastReadAt = 0;
  const history = new ThreadHistory();
  let savedQueue: unknown;
  try {
    savedQueue = JSON.parse(sessionStorage.getItem(opts.queueKey) ?? 'null');
  } catch {}
  const queued = localQueues.get(opts.queueKey) ?? new ThreadQueue(savedQueue);
  const title = h('h2', {}, worker.name);
  const status = h('span.pill');
  const model = h('div.wt-model');
  const head = h('header.wt-head', {}, colorDot(worker.color), h('div.titles', {}, h('div.row', {}, title, status), model), opts.controls);
  const earlier = h('button.btn.sm.wt-earlier.hidden', { type: 'button', onclick: () => read(history.entries[0]?.seq) }, 'Load earlier messages');
  const list = h('div.wt-list');
  const empty = h('div.wt-empty', { role: 'status' }, 'Reading the conversation…');
  const queuedBox = h('div.wt-queued', { hidden: true });
  const team = new TeamThread();
  const teamPaint = new TeamThreadPaint();
  const teamTitle = h('span', {}, 'Team activity');
  const teamBody = h('div.wt-team-body');
  const teamLimit = h('p.wt-team-note', { hidden: true });
  const teamSection = h('details.wt-team', { hidden: true }, h('summary', {}, teamTitle, h('span.wt-chevron', { 'aria-hidden': true }, '›')), teamBody, teamLimit);
  const scroll = h('div.wt-scroll', { tabindex: 0, 'aria-label': 'Conversation history' }, earlier, list, empty, queuedBox, opts.question);
  const latest = h(
    'button.btn.sm.wt-latest.hidden',
    {
      type: 'button',
      onclick: () => {
        if (history.historical) {
          history.clear(worker.sessionId);
          lastReadAt = 0;
          read();
        } else follow();
      },
    },
    'Jump to latest',
  );
  const latestAnchor = h('div.wt-latest-anchor', {}, latest);
  let queueKey = '';
  // Keys go straight to the attached terminal, as Raw TTY types them: an office before term.input
  // confirmations would answer a confirmed send with a refusal after typing the keys anyway.
  // Only once the office confirmed this floor and attached the worker on it: a key sent while leaving
  // the floor, or before the welcome, would reach a terminal this view no longer shows.
  const canTypeKeys = () => !!hold?.attached;
  const typeKeys = (data: string) => canTypeKeys() && net.send({ t: 'term.input', workerId: worker.id, data });
  const clearQueue = () => {
    const rows = opts.screen?.();
    if (!rows || !readDroidQueue(rows)?.length) {
      paintQueue();
      return;
    }
    if (!typeKeys(CLEAR_DROID_QUEUE)) told = 'Disconnected. Nothing was sent.';
    updateControls();
  };
  // Droid's own queue, read off its screen, is what waits: messages sent from here fill in the rows it cut short.
  const paintQueue = () => {
    queued.sync(worker.sessionId, history.entries);
    const rows = opts.screen?.();
    const droid = rows ? readDroidQueue(rows) : undefined;
    const shown = queued.shown(droid);
    if (queued.pending.length) localQueues.set(opts.queueKey, queued);
    else localQueues.delete(opts.queueKey);
    try {
      if (queued.pending.length) sessionStorage.setItem(opts.queueKey, JSON.stringify(queued));
      else sessionStorage.removeItem(opts.queueKey);
    } catch {}
    const canClear = connected && canTypeKeys() && !!droid?.length;
    const key = JSON.stringify([shown, canClear]);
    if (key === queueKey) return;
    queueKey = key;
    const stick = received && !inspecting && atBottom();
    queuedBox.hidden = !shown.length;
    queuedBox.replaceChildren(
      ...(shown.length
        ? [
            h('div.wt-queued-title', { 'aria-live': 'polite' }, h('span', {}, `Queued · ${shown.length}`)),
            ...shown.map((message) => {
              const more = message.more > 0 ? `${message.more} more line${message.more === 1 ? '' : 's'}` : message.preview ? 'Shortened' : message.hasImage && message.text ? 'Image attached' : '';
              return h('div.wt-entry.user.wt-queued-message', { 'data-queued': message.key }, h('div.wt-user-text', {}, message.text || 'Image attached'), more ? h('div.wt-queued-more', {}, more) : null);
            }),
            h(
              'div.wt-queued-foot',
              {},
              h('span', {}, shown.length === 1 ? 'Sent once this turn is over.' : 'Sent in order once this turn is over.'),
              canClear ? h('button.btn.sm.ghost', { type: 'button', onclick: clearQueue }, 'Clear queue') : null,
            ),
          ]
        : []),
    );
    if (stick) follow();
  };
  const notice = h('p.wt-notice', { role: 'status' });
  const retry = h(
    'button.btn.sm.hidden',
    {
      type: 'button',
      onclick: () => {
        error = '';
        read();
      },
    },
    'Retry',
  );
  const raw = h('button.btn.sm', { type: 'button', onclick: opts.raw }, 'Open Raw TTY');
  const resume = h(
    'button.btn.wt-resume',
    {
      type: 'button',
      onclick: async () => {
        if (resume.disabled) return;
        resuming = true;
        updateControls();
        error = (await opts.send({ t: 'worker.resume', workerId: worker.id })) ?? '';
        resuming = false;
        updateControls();
      },
    },
    'Resume',
  );
  const input = h('textarea.input.wt-input', { rows: 1, maxlength: 20000, placeholder: `Reply to ${worker.name}…`, 'aria-label': 'Message to worker' });
  input.value = opts.draft;
  input.addEventListener('input', () => {
    opts.onDraft(input.value);
    told = '';
    slashClosed = false;
    slashCursor = 0;
    if (input.value.trimStart().startsWith('/')) loadSlash();
    paintSlash();
    updateControls();
  });
  const images = promptImages(input, { floor: opts.floor });
  if (opts.attachments?.length) images.restore(opts.attachments);
  images.onChange(() => opts.onAttachments?.(images.handles()));
  const file = h('input.hidden', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, 'aria-label': 'Choose pictures' });
  file.addEventListener('change', () => {
    images.add([...(file.files ?? [])]);
    file.value = '';
  });
  const attach = h('button.btn.sm.ghost', { type: 'button', onclick: () => file.click() }, 'Attach pictures');
  // While a turn runs, Send steers it (Droid reads the message now) and Queue holds it for after the turn.
  const queue = h('button.btn.wt-queue', { type: 'button', title: 'Send once this turn is over', onclick: () => void submit(true) }, 'Queue');
  const send = h('button.btn.primary', { type: 'submit' }, 'Send');
  // Droid's slash commands, offered while a draft is a `/` and the start of a name.
  const slashMenu = h('div.wt-slash', { role: 'listbox', 'aria-label': 'Slash commands', hidden: true });
  let slashShown: SlashCommand[] = [];
  let slashCursor = 0;
  let slashClosed = false;
  // The built-in commands at once; the worker's skills and custom commands once its droid lists them.
  let slashList = slashCommands();
  let slashAsked = 0;
  const loadSlash = () => {
    if (worker.kind !== 'agent' || Date.now() - slashAsked < 60_000) return;
    slashAsked = Date.now();
    fetch(withToken(`/api/agents/droid/commands?worker=${encodeURIComponent(worker.id)}`), { credentials: 'same-origin', cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error('Could not load slash commands');
        return res.json() as Promise<{ commands?: unknown }>;
      })
      .then((body) => {
        if (disposed || !Array.isArray(body?.commands)) return;
        slashList = slashCommands(body.commands as DroidSlashCommand[]);
        paintSlash();
      })
      .catch(() => {
        slashAsked = 0;
      });
  };
  const pickSlash = (command: SlashCommand) => {
    input.value = `/${command.name} `;
    opts.onDraft(input.value);
    told = '';
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    paintSlash();
    updateControls();
  };
  const paintSlash = () => {
    slashShown = slashClosed || input.disabled ? [] : slashSuggestions(input.value, slashList);
    slashCursor = Math.min(slashCursor, Math.max(0, slashShown.length - 1));
    slashMenu.hidden = !slashShown.length;
    input.setAttribute('aria-expanded', String(!!slashShown.length));
    slashMenu.replaceChildren(
      ...slashShown.map((command, i) =>
        h(
          'button.wt-slash-item',
          {
            type: 'button',
            role: 'option',
            tabindex: -1,
            'aria-selected': String(i === slashCursor),
            onmousedown: (event: Event) => event.preventDefault(),
            onclick: () => pickSlash(command),
          },
          h('span.wt-slash-name', {}, `/${command.name}`),
          h('span.wt-slash-desc', { title: command.argumentHint ? `${command.description}\n/${command.name} ${command.argumentHint}` : command.description }, command.description),
          command.kind === 'tty' ? h('span.wt-slash-tag', { title: 'Opens one of Droid’s dialogs, in Raw TTY' }, 'Raw TTY') : null,
          command.source ? h('span.wt-slash-tag', { title: command.source === 'skill' ? 'One of this worker’s skills' : 'A custom command' }, command.source === 'skill' ? 'Skill' : 'Command') : null,
        ),
      ),
    );
  };
  const stop = h('button.btn.wt-stop', { type: 'button', 'aria-label': 'Stop turn', title: 'Stop turn', onclick: () => stopTurn() }, h('span.wt-stop-label', {}, 'Stop'), h('span.wt-stop-symbol', { 'aria-hidden': true }, '■'));
  const hint = h('span.wt-send-hint');
  const form = h('form.wt-composer', {}, slashMenu, images.element, file, h('div.wt-compose-input', {}, input, h('div.wt-send-buttons', {}, stop, queue, send)), h('div.wt-compose-actions', {}, attach, hint));
  const element = h('section.worker-thread', { 'aria-label': `${worker.name} thread` }, head, teamSection, scroll, latestAnchor, h('div.wt-feedback', {}, notice, retry, raw, resume), form);
  images.dropZone(form);
  const nodes = new Map<string, { key: string; node: HTMLElement; sourceIds: string[] }>();
  const expandedMessages = new Set<string>();
  const updateCode = (frame: HTMLElement) => {
    const pre = frame.querySelector<HTMLElement>('.wt-horizontal-content');
    const cue = frame.querySelector<HTMLElement>('.wt-code-cue');
    if (!pre || !cue) return;
    const overflowing = pre.scrollWidth > pre.clientWidth + 1;
    frame.classList.toggle('overflowing', overflowing);
    frame.classList.toggle('at-end', pre.scrollLeft + pre.clientWidth >= pre.scrollWidth - 1);
    cue.hidden = !overflowing;
  };
  const prepareCode = (body: HTMLElement) => {
    for (const pre of body.querySelectorAll<HTMLElement>('pre, table')) {
      const table = pre instanceof HTMLTableElement;
      const frame = h('div.wt-code-scroll');
      const cue = h('span.wt-code-cue', {}, 'Scroll horizontally ↔');
      pre.replaceWith(frame);
      const content = table ? h('div.wt-table-scroll', {}, pre) : pre;
      content.classList.add('wt-horizontal-content');
      frame.append(content, cue);
      content.tabIndex = 0;
      content.setAttribute('aria-label', `${table ? 'Table' : 'Code block'}, scroll horizontally`);
      content.addEventListener('scroll', () => updateCode(frame));
    }
  };
  const updateClamps = (within: HTMLElement = element) => {
    for (const text of within.querySelectorAll<HTMLElement>('.wt-user-content')) {
      const button = text.parentElement?.nextElementSibling?.querySelector<HTMLButtonElement>('.wt-message-more');
      if (button instanceof HTMLButtonElement) button.hidden = text.classList.contains('clamped') && text.scrollHeight <= text.clientHeight + 1;
    }
    for (const frame of within.querySelectorAll<HTMLElement>('.wt-code-scroll')) updateCode(frame);
  };
  let followingLayout = true;
  let viewportWidth = scroll.clientWidth;
  let viewportHeight = scroll.clientHeight;
  const resize = new ResizeObserver(() => {
    updateClamps();
    if (followingLayout && !inspecting && !history.historical) follow();
    viewportWidth = scroll.clientWidth;
    viewportHeight = scroll.clientHeight;
    updateLatest();
  });
  resize.observe(scroll);
  let inspecting = false;
  const atBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  const follow = () => {
    inspecting = false;
    followingLayout = true;
    scroll.scrollTop = scroll.scrollHeight;
    latest.classList.add('hidden');
  };
  const updateLatest = () => {
    latest.classList.toggle('hidden', !history.historical && !inspecting && atBottom());
    latest.textContent = inspecting && atBottom() ? 'Follow latest' : 'Jump to latest';
  };
  let questionContent = '';
  const questionChanges = new MutationObserver(() => {
    const content = opts.question.textContent ?? '';
    if (content === questionContent) return;
    questionContent = content;
    if (active && worker.status === 'needs_input' && !opts.question.hidden) requestAnimationFrame(() => opts.question.scrollIntoView({ block: 'nearest' }));
  });
  questionChanges.observe(opts.question, { childList: true, subtree: true });
  scroll.addEventListener('scroll', () => {
    if (viewportWidth === scroll.clientWidth && viewportHeight === scroll.clientHeight) followingLayout = atBottom();
    updateLatest();
  });
  scroll.addEventListener('click', (event) => {
    const summary = event.target instanceof Element ? event.target.closest('summary') : null;
    const details = summary?.parentElement;
    if (details instanceof HTMLDetailsElement && !details.open)
      requestAnimationFrame(() => {
        if (details.open) details.scrollIntoView({ block: 'nearest' });
      });
  });
  scroll.addEventListener(
    'toggle',
    (event) => {
      if (event.target instanceof HTMLDetailsElement && event.target.open) {
        inspecting = true;
        followingLayout = false;
        latest.classList.remove('hidden');
        latest.textContent = atBottom() ? 'Follow latest' : 'Jump to latest';
      }
    },
    true,
  );
  const thought = (id: string, text: string, preview: string) =>
    h(
      'details.wt-thinking',
      { 'data-disclosure': id },
      h('summary', {}, h('span.wt-thought-label', {}, 'Thought'), h('span.wt-thought-preview', {}, preview), h('span.wt-chevron', { 'aria-hidden': true }, '›')),
      h('div.wt-thinking-text', {}, text),
    );
  // While the worker waits on the owner, its run isn't working: the question card says what it's on.
  const render = (row: ThreadRow, asking: boolean, author = worker, expanded = expandedMessages) => {
    const node = h('article.wt-entry', { 'data-entry': row.id });
    if (row.kind === 'thought') {
      node.classList.add('thought');
      node.append(thought(row.id, row.entry.text ?? '', row.preview));
      return node;
    }
    if (row.kind === 'activity') {
      node.classList.add('activity');
      const details = h(
        'details.wt-activity',
        { class: row.state, 'data-disclosure': row.id },
        h(
          'summary',
          {},
          h('span.wt-activity-mark', { 'aria-hidden': true }),
          h('span.wt-activity-label', {}, `${row.live && !asking ? 'Working · ' : ''}${row.label}`),
          row.failed.length || row.cancelled || row.noResult
            ? h('span.wt-activity-status', {}, [row.failed.length ? `${row.failed.length} failed` : '', row.cancelled ? `${row.cancelled} cancelled` : '', row.noResult ? `${row.noResult} no result` : ''].filter(Boolean).join(' · '))
            : null,
          h('span.wt-chevron', { 'aria-hidden': true }, '›'),
        ),
      );
      const body = h('div.wt-activity-body');
      for (const item of row.items) {
        const action = item;
        const entry = action.entry;
        const state = action.state === 'cancelled' ? 'Cancelled' : action.state === 'failed' ? 'Failed' : action.state === 'working' ? 'Running' : action.state === 'incomplete' ? 'No result' : '';
        const args = threadArguments(entry);
        const detail = h(
          'details.wt-tool',
          { class: action.state === 'failed' ? 'error' : action.state === 'complete' ? 'done' : 'pending', 'data-disclosure': entry.id },
          h(
            'summary',
            {},
            h('span.wt-tool-main', {}, h('span.wt-tool-title', {}, action.title), action.detail ? h('span.wt-tool-detail', {}, action.detail) : null),
            h('span.wt-tool-state', {}, state),
            h('span.wt-chevron', { 'aria-hidden': true }, '›'),
          ),
          args ? h('div.wt-detail-label', {}, args.label) : null,
          args ? h('pre.wt-code', {}, args.text) : null,
          h('div.wt-detail-label', {}, action.state === 'cancelled' ? 'Cancelled' : entry.error ? 'Error' : 'Result'),
          h('pre.wt-code.wt-output', {}, entry.output ?? 'No result recorded in this session.'),
        );
        body.append(detail);
      }
      if (row.plan) {
        body.append(
          h(
            'div.wt-plan',
            {},
            h('div.wt-detail-label', {}, 'Plan'),
            h('ol', {}, ...row.plan.map((step) => h('li', { class: step.done ? 'done' : step.active ? 'active' : '' }, h('span.wt-plan-state', {}, step.done ? 'Done' : step.active ? 'Now' : 'Next'), step.text))),
          ),
        );
      }
      details.append(body);
      node.append(details);
      const current = row.actions.filter((action) => action.state === 'working').at(-1);
      if (row.live && !row.failed.length && current && current.title !== row.label) node.append(h('p.wt-running', { role: 'status' }, current.title));
      if (row.failed.length) {
        node.append(
          h(
            'div.wt-failures',
            {},
            ...row.failed.map((action) =>
              h(
                'div.wt-failure-preview',
                {},
                h('span', {}, action.title),
                h(
                  'p',
                  {},
                  action.entry.output
                    ?.split('\n')
                    .find((line) => line.trim())
                    ?.slice(0, 240) ?? 'No error details were recorded.',
                ),
              ),
            ),
          ),
        );
      }
      return node;
    }
    const entry = row.entry;
    node.classList.add(entry.role, entry.kind);
    if (row.kind === 'message') {
      if (entry.role === 'assistant' && row.startsTurn) node.append(h('div.wt-who', {}, author.name));
      const actions = h('div.wt-message-actions');
      if (entry.role === 'user') {
        const text = h('div.wt-user-content', { id: `wt-message-${author.id}-${entry.id}`, class: expanded.has(entry.id) ? '' : 'clamped' }, entry.text ?? '');
        const more = h(
          'button.btn.sm.ghost.wt-message-more',
          {
            type: 'button',
            'aria-expanded': String(expanded.has(entry.id)),
            'aria-controls': text.id,
            onclick: () => {
              const on = !expanded.has(entry.id);
              if (on) expanded.add(entry.id);
              else expanded.delete(entry.id);
              text.classList.toggle('clamped', !on);
              more.setAttribute('aria-expanded', String(on));
              more.textContent = on ? 'Show less' : 'Show all';
              updateClamps();
            },
          },
          expanded.has(entry.id) ? 'Show less' : 'Show all',
        );
        node.append(h('div.wt-user-text', {}, text));
        actions.append(more);
      } else {
        const body = markdown(entry.text ?? '');
        prepareCode(body);
        node.append(body);
      }
      const copy = h(
        'button.btn.sm.ghost.wt-copy',
        {
          type: 'button',
          'aria-label': 'Copy message',
          onclick: () =>
            void copyText(entry.text ?? '').then((ok) => {
              if (!ok) notice.textContent = 'Could not copy this message.';
            }),
        },
        'Copy',
      );
      actions.append(copy);
      node.append(actions);
    } else node.append(h('p.wt-turn', { class: row.tone }, row.text));
    return node;
  };
  const teamNodes = new Map<
    string,
    {
      sessionId?: string;
      element: HTMLDetailsElement;
      name: HTMLElement;
      status: HTMLElement;
      activity: HTMLElement;
      body: HTMLElement;
      note: HTMLElement;
      open: HTMLButtonElement;
      expanded: Set<string>;
      rows: Map<string, { key: string; node: HTMLElement }>;
    }
  >();
  const paintTeam = (force = false) => {
    if (disposed || !teamPaint.changed(team.revision, connected, teamSection.open, active && !document.hidden && element.isConnected, force)) return;
    // The rollup is a sibling of the conversation. Only a size change can affect its viewport.
    const height = teamSection.offsetHeight;
    const top = scroll.scrollTop;
    const teamTop = teamBody.scrollTop;
    teamSection.hidden = team.total === 0;
    teamTitle.textContent = `Team activity · ${team.total}`;
    teamLimit.hidden = team.total <= team.members.size;
    teamLimit.textContent = `Showing ${team.members.size} of ${team.total} workers. Open other threads from the worker list.`;
    for (const [id, card] of teamNodes) {
      const member = team.members.get(id);
      if (!member || member.worker.sessionId !== card.sessionId) {
        const focused = card.element.contains(document.activeElement);
        card.element.remove();
        teamNodes.delete(id);
        if (focused) teamSection.querySelector('summary')?.focus({ preventScroll: true });
      }
    }
    for (const [id, member] of team.members) {
      const child = member.worker;
      let card = teamNodes.get(id);
      if (!card) {
        const name = h('span.wt-team-name');
        const status = h('span.pill');
        const activity = h('span.wt-team-latest');
        const body = h('div.wt-team-entries');
        const note = h('p.wt-team-note');
        const open = h('button.btn.sm', { type: 'button', onclick: () => opts.openWorker?.(id) }, 'Open thread');
        const element = h(
          'details.wt-team-member',
          {},
          h('summary', {}, h('span.wt-team-who', {}, name, activity), status, h('span.wt-chevron', { 'aria-hidden': true }, '›')),
          h('div.wt-team-content', {}, h('div.wt-team-actions', {}, open), body, note),
        );
        card = { sessionId: child.sessionId, element, name, status, activity, body, note, open, expanded: new Set(), rows: new Map() };
        teamNodes.set(id, card);
        teamBody.append(element);
      }
      card.name.textContent = child.name;
      card.name.title = child.name;
      card.status.className = `pill ${child.status}`;
      card.status.hidden = !connected;
      card.status.textContent = isAsleep(child.status) ? 'Asleep' : (STATUS_LABEL[child.status] ?? child.status);
      card.open.disabled = !connected || !opts.openWorker;
      const rows = presentThread(member.history.entries, isBusy(child.status)).slice(-4);
      const last = rows.at(-1);
      const activity = child.activity || (last?.kind === 'activity' ? last.label : last?.kind === 'thought' ? last.preview : last?.kind === 'message' ? last.entry.text : last?.text) || child.title || 'No recent activity';
      card.activity.textContent = activity.split('\n')[0].slice(0, 200);
      card.activity.title = card.activity.textContent;
      card.note.textContent = member.error
        ? `Conversation unavailable: ${member.error}`
        : child.lost
          ? 'This worker’s checkout is unavailable.'
          : !child.sessionId
            ? 'Waiting for a local session…'
            : !member.received
              ? teamSection.open
                ? 'Reading the conversation…'
                : 'Expand Team activity to read recent messages and tools.'
              : rows.length
                ? 'Recent activity only. Open the worker thread for more messages and recorded patches.'
                : 'No conversation recorded yet.';
      const keep = new Set(rows.map((row) => row.id));
      const selection = document.getSelection();
      const pinned = new Set<string>();
      for (const [rowId, item] of card.rows) {
        if (!keep.has(rowId)) {
          if (item.node.contains(document.activeElement) || (selection?.isCollapsed === false && item.node.contains(selection.anchorNode))) {
            pinned.add(rowId);
            continue;
          }
          item.node.remove();
          card.rows.delete(rowId);
        }
      }
      const messageIds = new Set(member.history.entries.map((entry) => entry.id));
      for (const entryId of card.expanded) if (!messageIds.has(entryId)) card.expanded.delete(entryId);
      let at = card.body.firstElementChild;
      // At most one focused and one selected old row stay above the four newest rows.
      while (at && pinned.has(at.getAttribute('data-entry') ?? '')) at = at.nextElementSibling;
      for (const row of rows) {
        const key = JSON.stringify([row, child.status === 'needs_input', child.name]);
        let had = card.rows.get(row.id);
        // Don't discard text while the owner is selecting a command or patch to copy.
        if (!had || (had.key !== key && (selection?.isCollapsed !== false || !had.node.contains(selection.anchorNode)))) {
          const focused = document.activeElement;
          const focus = focused instanceof HTMLElement && had?.node.contains(focused) ? focused : undefined;
          const disclosure = focus?.closest<HTMLDetailsElement>('details[data-disclosure]')?.dataset.disclosure;
          const control = focus?.matches('.wt-copy') ? '.wt-copy' : focus?.matches('.wt-message-more') ? '.wt-message-more' : undefined;
          const node = render(row, child.status === 'needs_input', child, card.expanded);
          const opened = new Set([...(had?.node.querySelectorAll<HTMLDetailsElement>('details[open][data-disclosure]') ?? [])].map((details) => details.dataset.disclosure));
          for (const details of node.querySelectorAll<HTMLDetailsElement>('details[data-disclosure]')) details.open = opened.has(details.dataset.disclosure);
          const positions = [...(had?.node.querySelectorAll<HTMLElement>('pre, .wt-horizontal-content') ?? [])].map((content) => [content.scrollTop, content.scrollLeft]);
          had?.node.replaceWith(node);
          if (focus && !focus.isConnected) {
            const target = control
              ? node.querySelector<HTMLElement>(control)
              : [...node.querySelectorAll<HTMLDetailsElement>('details[data-disclosure]')].find((details) => details.dataset.disclosure === disclosure)?.querySelector('summary');
            target?.focus({ preventScroll: true });
          }
          [...node.querySelectorAll<HTMLElement>('pre, .wt-horizontal-content')].forEach((content, index) => {
            content.scrollTop = positions[index]?.[0] ?? 0;
            content.scrollLeft = positions[index]?.[1] ?? 0;
          });
          had = { key, node };
          card.rows.set(row.id, had);
          if (at?.getAttribute('data-entry') === row.id) at = node;
        }
        if (had.node === at) at = at.nextElementSibling;
        else card.body.insertBefore(had.node, at);
      }
    }
    if (teamSection.open) updateClamps(teamSection);
    if (teamBody.scrollTop !== teamTop) teamBody.scrollTop = teamTop;
    if (teamSection.offsetHeight !== height && scroll.scrollTop !== top) scroll.scrollTop = top;
  };
  const syncTeam = () => {
    team.sync(`${opts.queueKey}:${worker.id}:${worker.sessionId ?? ''}`, worker.id, opts.team?.() ?? [], teamThreadBudget(pollingViews.size));
    team.enable(teamThreadVisible(active && focused && !disposed, connected, !document.hidden && element.isConnected, teamSection.open));
  };
  const readTeam = () => {
    if (!opts.team || disposed) return;
    syncTeam();
    team.read(
      Date.now(),
      (msg) => net.send(msg),
      () => `team-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    );
    paintTeam();
  };
  const teamDisclosure = (event: Event) => {
    if (event.target === teamSection) readTeam();
    else paintTeam(true);
  };
  const teamFocus = () => queueMicrotask(() => paintTeam(true));
  let teamSelected = false;
  const teamSelection = () => {
    const selection = document.getSelection();
    const selected = selection?.isCollapsed === false && teamSection.contains(selection.anchorNode);
    if (selected || teamSelected) paintTeam(true);
    teamSelected = selected;
  };
  teamSection.addEventListener('toggle', teamDisclosure, true);
  teamSection.addEventListener('focusout', teamFocus);
  document.addEventListener('selectionchange', teamSelection);
  // The same words as the Android app: a heading and a line under it once there is nothing to read.
  const paintEmpty = () => {
    if (error) empty.textContent = 'Conversation unavailable. Retry below, or open Raw TTY.';
    else if (!received) empty.textContent = 'Reading the conversation…';
    else empty.replaceChildren(h('span.wt-empty-mark', { 'aria-hidden': true }), h('b', {}, 'Start a conversation'), h('p', {}, 'Your messages and the worker’s replies will appear here.'));
  };
  const paintEntries = (older: boolean) => {
    const stick = !received || (!older && !inspecting && atBottom());
    const top = scroll.scrollTop;
    const height = scroll.scrollHeight;
    const want: HTMLElement[] = [];
    const keep = new Set<string>();
    const opened = new Set([...list.querySelectorAll<HTMLDetailsElement>('details[open][data-disclosure]')].map((el) => el.dataset.disclosure));
    const openSources = new Set([...nodes.values()].filter((item) => item.node.querySelector<HTMLDetailsElement>('.wt-activity')?.open).flatMap((item) => item.sourceIds));
    const focused = document.activeElement;
    const focusedDisclosure = focused instanceof HTMLElement && focused.matches('summary') && list.contains(focused) ? focused.parentElement?.dataset.disclosure : undefined;
    const rows = presentThread(history.entries, isBusy(worker.status));
    const asking = worker.status === 'needs_input';
    for (const row of rows) {
      const key = JSON.stringify([row, asking]);
      let had = nodes.get(row.id);
      if (!had || had.key !== key) {
        const node = render(row, asking);
        for (const disclosure of node.querySelectorAll<HTMLDetailsElement>('details[data-disclosure]')) {
          if (opened.has(disclosure.dataset.disclosure)) disclosure.open = true;
        }
        if (row.kind === 'activity' && row.sourceIds.some((id) => openSources.has(id))) {
          const group = node.querySelector<HTMLDetailsElement>('.wt-activity');
          if (group) group.open = true;
        }
        had = { key, node, sourceIds: row.kind === 'activity' ? row.sourceIds : [] };
        nodes.set(row.id, had);
      }
      keep.add(row.id);
      want.push(had.node);
    }
    for (const id of nodes.keys()) if (!keep.has(id)) nodes.delete(id);
    for (const id of expandedMessages) if (!keep.has(id)) expandedMessages.delete(id);
    let at = list.firstElementChild;
    for (const node of want) {
      if (node === at) at = at.nextElementSibling;
      else list.insertBefore(node, at);
    }
    while (at) {
      const next = at.nextElementSibling;
      at.remove();
      at = next;
    }
    updateClamps();
    if (focusedDisclosure && focused && !focused.isConnected) {
      [...list.querySelectorAll<HTMLDetailsElement>('details[data-disclosure]')]
        .find((el) => el.dataset.disclosure === focusedDisclosure)
        ?.querySelector('summary')
        ?.focus({ preventScroll: true });
    }
    earlier.classList.toggle('hidden', !history.hasMore);
    latest.textContent = history.historical ? 'Back to the latest' : 'Jump to latest';
    empty.hidden = rows.length > 0;
    paintEmpty();
    if (stick) follow();
    else if (older) scroll.scrollTop = top + scroll.scrollHeight - height;
    else updateLatest();
    if (history.historical) latest.classList.remove('hidden');
  };
  let waitingShown = false;
  const updateControls = () => {
    const allowed = active && connected && !disposed && !isAsleep(worker.status) && !worker.lost;
    const waiting = worker.status === 'needs_input';
    form.hidden = waiting;
    if (waiting && !waitingShown) requestAnimationFrame(() => opts.question.scrollIntoView({ block: 'nearest' }));
    waitingShown = waiting;
    input.disabled = !allowed || sending || waiting;
    attach.disabled = input.disabled;
    const busy = isBusy(worker.status);
    send.disabled = input.disabled;
    queue.hidden = !busy;
    queue.disabled = input.disabled || !received || !!slashOf(input.value);
    stop.hidden = !busy && !waiting;
    stop.disabled = !allowed || sending || !canTypeKeys();
    send.textContent = sending ? 'Sending…' : busy ? 'Send now' : 'Send';
    send.title = busy ? `Steer ${worker.name}: it reads this now, during the turn` : '';
    input.placeholder = busy ? `Steer ${worker.name}, or queue for after this turn…` : `Reply to ${worker.name}…`;
    hint.replaceChildren(
      ...(busy
        ? [h('span.key', {}, 'Enter'), ' steer · ', h('span.key', {}, 'Ctrl Enter'), ' queue · ', h('span.key', {}, '⇧ Enter'), ' new line']
        : [h('span.key', {}, 'Enter'), ' send · ', h('span.key', {}, '⇧ Enter'), ' new line · ', h('span.key', {}, '/'), ' commands']),
    );
    earlier.disabled = !!pending || !connected;
    retry.classList.toggle('hidden', !error);
    retry.disabled = !connected || !!pending;
    empty.classList.toggle('error', !!error && !history.entries.length);
    if (!history.entries.length) paintEmpty();
    notice.textContent = connected ? error || told || (isAsleep(worker.status) ? 'Resume this worker to send another message.' : '') : '';
    raw.classList.toggle('hidden', !connected || !error);
    resume.hidden = !isAsleep(worker.status);
    resume.disabled = !active || !connected || !!worker.lost || resuming;
    resume.textContent = resuming ? 'Resuming…' : 'Resume';
    element.classList.toggle('has-feedback', !!notice.textContent);
    paintQueue();
  };
  const read = (before?: number) => {
    if (!active || !connected || disposed || document.hidden || pending) return;
    if (before === undefined && history.historical) return;
    if (before === undefined && Date.now() - lastReadAt < threadReadInterval(focused)) return;
    const request = `thread-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    if (net.send({ t: 'thread.read', workerId: worker.id, request, ...(before !== undefined ? { before } : {}) })) {
      lastReadAt = Date.now();
      pending = { request, before, at: lastReadAt };
    }
    updateControls();
  };
  const receive = (msg: ServerMsg) => {
    if (disposed) return;
    if (msg.t === 'floor.enter' || msg.t === 'welcome') {
      team.clear();
      team.enable(false);
      paintTeam();
      return;
    }
    if (msg.t === 'thread.snapshot' && msg.workerId !== worker.id) {
      syncTeam();
      if (team.receive(msg)) paintTeam();
      return;
    }
    if (msg.t !== 'thread.snapshot' || !active || !pending || msg.workerId !== worker.id || msg.request !== pending.request) return;
    const older = pending.before !== undefined;
    pending = undefined;
    error = msg.error ?? '';
    if (!error) {
      if (worker.sessionId && msg.sessionId !== worker.sessionId) return;
      history.apply(msg);
      opts.onEntries?.();
      paintEntries(older);
      received = true;
    }
    updateControls();
  };
  const submit = async (queueSend = false) => {
    if ((queueSend ? queue.disabled || queue.hidden : send.disabled) || sending) return;
    const text = input.value.trim();
    const refused = slashRefusal(text, worker.name, isBusy(worker.status));
    if (refused) {
      told = refused;
      updateControls();
      return;
    }
    if (!text && !images.ids().length && !images.busy()) return input.focus();
    // The draft as kept, so the acknowledgement can tell whether anyone changed it since.
    const draftText = input.value;
    sending = true;
    const stamp = net.stamp();
    updateControls();
    await images.settled();
    if (disposed || !active || !connected || !net.current(stamp) || worker.status === 'needs_input') {
      // Pictures finished going up after the connection or floor changed: that send is not made later.
      if (!disposed && !net.current(stamp)) told = 'The connection changed while pictures were uploading. Nothing was sent.';
      sending = false;
      updateControls();
      return;
    }
    const queueReceipt = queueSend && isBusy(worker.status);
    const after = queued.sequence;
    // Exactly what goes out: a picture added while the send is out stays for the next message.
    const outgoing = images.sendable();
    const hasImage = outgoing.ids.length > 0;
    const result = await opts.send({ t: 'worker.prompt', workerId: worker.id, prompt: text, images: outgoing.ids, queue: queueSend });
    sending = false;
    if (!result) {
      if (queueReceipt) queued.sent(text, hasImage, after);
      // Only what went: a newer view of this draft may have added pictures or changed the text since.
      const sent: SubmittedDraft = { text: draftText, attachments: outgoing.handles };
      images.take(outgoing.handles);
      if (!disposed) acknowledge(sent);
      submittedDrafts.emit(opts.queueKey, sent, acknowledge);
      opts.onSubmitted?.(sent);
      told = '';
      paintSlash();
      if (history.historical) history.clear(worker.sessionId);
      follow();
      read();
    }
    error = result ?? '';
    updateControls();
    // Droid answers most of its slash commands with a dialog, which only its terminal shows.
    if (!result && slashOf(text)?.command?.kind === 'tty') opts.raw();
  };
  const stopTurn = () => {
    if (stop.disabled) return;
    // Escape is the CLI's own cancel path, and requires the normal worker attachment.
    told = typeKeys('\u001b') ? '' : 'Disconnected. Nothing was sent.';
    updateControls();
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit();
  });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (slashShown.length) {
      const typed = slashOf(input.value)?.name;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        slashCursor = (slashCursor + (event.key === 'ArrowDown' ? 1 : slashShown.length - 1)) % slashShown.length;
        paintSlash();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        slashClosed = true;
        paintSlash();
        return;
      }
      // Tab, or Enter on a name only partly typed, completes it; Enter on a whole name sends it.
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && slashShown[slashCursor].name !== typed)) {
        event.preventDefault();
        pickSlash(slashShown[slashCursor]);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit((event.ctrlKey || event.metaKey) && isBusy(worker.status));
    }
  });
  const off = net.onMessage(receive);
  // This view's draft sent by another view of it (one disposed mid-send): drop the text only if unchanged.
  // Its pictures already left this box through the staging.
  const acknowledge = (sent: SubmittedDraft) => {
    if (disposed || input.value !== sent.text) return;
    input.value = '';
    opts.onDraft('');
    paintSlash();
    updateControls();
  };
  const offSubmitted = submittedDrafts.on(opts.queueKey, acknowledge);
  const offReady = net.onReady((ready) => {
    if (disposed) return;
    updateControls();
    if (ready) return;
    pending = undefined;
    team.clear();
    team.enable(false);
    paintTeam();
  });
  const clearDraft = () => {
    input.value = '';
    images.discard();
    opts.onDraft('');
    told = '';
    slashClosed = false;
    paintSlash();
    updateControls();
  };
  // Losing the connection drops unsent drafts everywhere; a floor switch keeps them.
  const offLost = net.onConnectionLost(() => {
    if (disposed) return;
    clearDraft();
    // Drafts kept for other panes and floors hold pictures too; the workspace drops their text.
    forgetAllStagedImages();
    opts.onDraftReset?.();
  });
  const timer = setInterval(() => {
    if (!active || !connected || document.hidden) return;
    if (focused) readTeam();
    paintQueue();
    if (pending && Date.now() - pending.at > 8000) {
      pending = undefined;
      error = 'The office did not return this conversation. Retry, or use Raw TTY on an older office.';
      updateControls();
    }
    if (!error) read();
  }, 1000);
  const visibility = () => {
    readTeam();
    if (!document.hidden && active) read();
  };
  document.addEventListener('visibilitychange', visibility);
  return {
    element,
    entries: () => history.entries,
    update(next, online) {
      if (next.sessionId !== worker.sessionId) {
        history.clear(next.sessionId);
        received = false;
        pending = undefined;
        error = '';
        nodes.clear();
        expandedMessages.clear();
        list.replaceChildren();
        paintEntries(false);
      }
      worker = next;
      connected = online;
      if (!online) {
        pending = undefined;
        error = '';
      }
      title.textContent = worker.name;
      // Out of reach, the last status the office sent may be long gone: the offline banner says so instead.
      status.hidden = !online;
      status.className = `pill ${worker.status}`;
      status.textContent = isAsleep(worker.status) ? 'Asleep' : (STATUS_LABEL[worker.status] ?? worker.status);
      const badge = modelBadgeNode(worker.activeModel ?? worker.model, worker.activeEffort ?? worker.effort);
      model.replaceChildren(...(badge ? [badge] : []));
      if (active) head.append(opts.controls);
      if (received) paintEntries(false);
      updateControls();
      read();
      readTeam();
    },
    activate(on) {
      if (active === on) return;
      active = on;
      pending = undefined;
      if (on) {
        // Typing keys (Stop, Clear queue) needs the attachment; the hold survives reconnects.
        hold ??= net.acquireTerminal(worker.id);
        pollingViews.add(self);
        head.append(opts.controls);
        read();
        loadSlash();
      } else {
        hold?.release();
        hold = undefined;
        pollingViews.delete(self);
      }
      updateControls();
      readTeam();
    },
    focus(on) {
      if (focused === on || disposed) return;
      focused = on;
      syncTeam();
      if (on) {
        readTeam();
        read();
      }
    },
    getDraft: () => ({ text: input.value, attachments: images.handles() }),
    resetDraft() {
      if (!disposed) clearDraft();
    },
    dispose() {
      if (disposed) return;
      hold?.release();
      hold = undefined;
      pollingViews.delete(self);
      disposed = true;
      active = false;
      offReady();
      offLost();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
      teamSection.removeEventListener('toggle', teamDisclosure, true);
      teamSection.removeEventListener('focusout', teamFocus);
      document.removeEventListener('selectionchange', teamSelection);
      off();
      resize.disconnect();
      questionChanges.disconnect();
      if (opts.onAttachments) images.detach();
      else images.discard();
      offSubmitted();
      team.dispose();
      teamNodes.clear();
    },
  };
}
