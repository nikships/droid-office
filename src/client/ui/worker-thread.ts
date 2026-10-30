import type { ClientMsg, ServerMsg, WorkerInfo } from '../../shared/protocol';
import { isAsleep, isBusy } from '../../shared/status';
import { threadArgumentsText, type ThreadBlock, type ThreadModelAction, type ThreadRow } from '../../shared/thread-presentation';
import type { ThreadEntry } from '../../shared/worker-thread';
import { CLEAR_DROID_QUEUE, readDroidQueue } from '../../shared/droid-queue';
import { slashCommands, slashOf, slashRefusal, slashSuggestions, type DroidSlashCommand, type SlashCommand } from '../../shared/slash-commands';
import { ThreadQueue } from '../../shared/thread-queue';
import type { Net } from '../net';
import { ThreadHistory } from '../thread-history';
import { threadSnapshotError, threadStarting } from '../thread-startup';
import { TeamThread, TeamThreadPaint, teamThreadVisible } from '../team-thread';
import { h, STATUS_LABEL } from './dom';
import { icon } from './icons';
import { markdown } from './markdown';
import { promptImages } from './images';
import { withToken } from '../token';

export interface WorkerThread {
  element: HTMLElement;
  entries(): readonly ThreadEntry[];
  update(worker: WorkerInfo, connected: boolean): void;
  activate(active: boolean): void;
  dispose(): void;
}

export interface ThreadOptions {
  worker: WorkerInfo;
  question: HTMLElement;
  queueKey: string;
  draft: string;
  onDraft(text: string): void;
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

/** How many of a row's entries are loaded: its details can fill in once an earlier page brings the rest. */
const loadedCount = (row: ThreadRow, loaded: ReadonlyMap<string, ThreadEntry>) => (row.kind === 'activity' ? row.sourceIds.filter((id) => loaded.has(id)).length : +loaded.has(row.id));

const shortcut = (key: string, label: string) => h('span.wt-shortcut', {}, h('span.key', {}, key), label);

/** Local sessions only. This view reads JSONL and uses the existing worker actions, never a second Droid. */
export function mountWorkerThread(net: Net, opts: ThreadOptions): WorkerThread {
  let worker = opts.worker;
  let connected = false;
  let active = false;
  let disposed = false;
  let sending = false;
  let resuming = false;
  let received = false;
  // Start the grace clock on the first read, not during potentially long worktree setup.
  let startupReadUntil = threadStarting(worker) ? Infinity : 0;
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
  const typeKeys = (data: string) => net.send({ t: 'term.input', workerId: worker.id, data });
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
    const canClear = connected && !!droid?.length;
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
  const input = h('textarea.wt-input', { rows: 1, maxlength: 20000, placeholder: `Reply to ${worker.name}…`, 'aria-label': 'Message to worker' });
  input.value = opts.draft;
  input.addEventListener('input', () => {
    opts.onDraft(input.value);
    told = '';
    slashClosed = false;
    slashCursor = 0;
    if (input.value.trimStart().startsWith('/')) loadSlash();
    paintSlash();
    slashMenu.scrollTop = 0;
    updateControls();
  });
  const images = promptImages(input);
  const file = h('input.hidden', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, 'aria-label': 'Choose pictures' });
  file.addEventListener('change', () => {
    images.add([...(file.files ?? [])]);
    file.value = '';
  });
  const attach = h('button.btn.icon.sm.ghost.wt-attach', { type: 'button', 'aria-label': 'Attach pictures', title: 'Attach pictures', onclick: () => file.click() }, icon('paperclip', 15));
  // While a turn runs, Send steers it (Droid reads the message now) and Queue holds it for after the turn.
  const queue = h('button.btn.sm.wt-queue', { type: 'button', title: 'Send once this turn is over', onclick: () => void submit(true) }, 'Queue');
  const sendLabel = h('span', {}, 'Send');
  const send = h('button.btn.sm.primary.wt-send', { type: 'submit' }, sendLabel, icon('arrowUp', 14));
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
  const stop = h('button.btn.sm.wt-stop', { type: 'button', 'aria-label': 'Stop turn', title: 'Stop turn', onclick: () => stopTurn() }, h('span.wt-stop-symbol', { 'aria-hidden': true }), h('span.wt-stop-label', {}, 'Stop'));
  const hint = h('span.wt-send-hint');
  const box = h('div.wt-compose-box', {}, images.element, input, h('div.wt-compose-bar', {}, attach, hint, h('div.wt-send-buttons', {}, stop, queue, send)));
  box.addEventListener('click', (event) => {
    if (!input.disabled && event.target instanceof Element && !event.target.closest('button, .pimgs, textarea')) input.focus();
  });
  const form = h('form.wt-composer', {}, slashMenu, file, box);
  const element = h('section.worker-thread', { 'aria-label': `${worker.name} thread` }, teamSection, scroll, latestAnchor, h('div.wt-feedback', {}, notice, retry, raw, resume), form);
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
  const chevron = () => h('span.wt-chevron', { 'aria-hidden': true }, '›');
  const disclosure = <T extends HTMLDetailsElement>(details: T, open: boolean) => {
    details.open = open;
    return details;
  };
  const thought = (block: Extract<ThreadBlock, { kind: 'thought' }>, entry: ThreadEntry | undefined) =>
    disclosure(
      h(
        'details.wt-thinking',
        { 'data-disclosure': block.id },
        h('summary', {}, h('span.wt-thought-label', {}, 'Thought'), h('span.wt-thought-preview', {}, block.preview), chevron()),
        h('div.wt-thinking-text', {}, entry?.text ?? block.preview),
      ),
      block.open,
    );
  const action = (item: ThreadModelAction, entry: ThreadEntry | undefined) =>
    disclosure(
      h(
        'details.wt-tool',
        { class: item.state === 'failed' ? 'error' : item.state === 'complete' ? 'done' : 'pending', 'data-disclosure': item.id },
        h('summary', {}, h('span.wt-tool-main', {}, h('span.wt-tool-title', {}, item.title), item.detail ? h('span.wt-tool-detail', {}, item.detail) : null), h('span.wt-tool-state', {}, item.status), chevron()),
        ...(entry
          ? [
              item.arguments ? h('div.wt-detail-label', {}, item.arguments.label) : null,
              item.arguments ? h('pre.wt-code', {}, threadArgumentsText(entry.input, item.arguments)) : null,
              h('div.wt-detail-label', {}, item.result),
              h('pre.wt-code.wt-output', {}, entry.output ?? 'No result recorded in this session.'),
            ]
          : [h('p.wt-detail-missing', {}, 'Load earlier messages to see what this call was given and returned.')]),
      ),
      item.open,
    );
  const run = (block: Extract<ThreadBlock, { kind: 'tools' }>, loaded: ReadonlyMap<string, ThreadEntry>) => {
    const body = h('div.wt-run-body', {}, ...block.actions.map((item) => action(item, loaded.get(item.id))));
    if (block.plan) {
      body.append(
        h(
          'div.wt-plan',
          {},
          h('div.wt-detail-label', {}, 'Plan'),
          h('ol', {}, ...block.plan.map((step) => h('li', { class: step.done ? 'done' : step.active ? 'active' : '' }, h('span.wt-plan-state', {}, step.done ? 'Done' : step.active ? 'Now' : 'Next'), step.text))),
        ),
      );
    }
    return disclosure(h('details.wt-run', { class: block.state, 'data-disclosure': block.id }, h('summary', {}, h('span.wt-run-label', {}, block.label), chevron()), body), block.open);
  };
  // While the worker waits on the owner, its run isn't working: the question card says what it's on.
  const render = (row: ThreadRow, loaded: ReadonlyMap<string, ThreadEntry>, asking: boolean, author = worker, expanded = expandedMessages) => {
    const node = h('article.wt-entry', { 'data-entry': row.id });
    if (row.kind === 'activity') {
      node.classList.add('activity');
      const details = disclosure(
        h(
          'details.wt-activity',
          { class: row.state, 'data-disclosure': row.id },
          h(
            'summary',
            {},
            h('span.wt-activity-mark', { 'aria-hidden': true }),
            h('span.wt-activity-label', {}, `${row.live && !asking ? 'Working · ' : ''}${row.label}`),
            row.status ? h('span.wt-activity-status', {}, row.status) : null,
            chevron(),
          ),
          h('div.wt-activity-body', {}, ...row.blocks.map((block) => (block.kind === 'thought' ? thought(block, loaded.get(block.id)) : run(block, loaded)))),
        ),
        row.open,
      );
      node.append(details);
      if (row.live && !row.failed.length && row.running && row.running !== row.label) node.append(h('p.wt-running', { role: 'status' }, row.running));
      if (row.failed.length) node.append(h('div.wt-failures', {}, ...row.failed.map((failure) => h('div.wt-failure-preview', {}, h('span', {}, failure.title), h('p', {}, failure.preview)))));
      return node;
    }
    node.classList.add(row.role, row.kind === 'message' ? 'text' : 'notice');
    if (row.kind === 'notice') {
      node.append(h('p.wt-turn', { class: row.tone }, row.text));
      return node;
    }
    const text = loaded.get(row.id)?.text ?? '';
    if (row.role === 'assistant') {
      if (row.startsTurn) node.append(h('div.wt-who', {}, author.name));
      const body = markdown(text);
      prepareCode(body);
      node.append(body);
      return node;
    }
    const content = h('div.wt-user-content', { id: `wt-message-${author.id}-${row.id}`, class: expanded.has(row.id) ? '' : 'clamped' }, text);
    const more = h(
      'button.btn.sm.ghost.wt-message-more',
      {
        type: 'button',
        'aria-expanded': String(expanded.has(row.id)),
        'aria-controls': content.id,
        onclick: () => {
          const on = !expanded.has(row.id);
          if (on) expanded.add(row.id);
          else expanded.delete(row.id);
          content.classList.toggle('clamped', !on);
          more.setAttribute('aria-expanded', String(on));
          more.textContent = on ? 'Show less' : 'Show all';
          updateClamps();
        },
      },
      expanded.has(row.id) ? 'Show less' : 'Show all',
    );
    node.append(h('div.wt-user-text', {}, content));
    node.append(h('div.wt-message-actions', {}, more));
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
      const rows = member.history.rows.slice(-4);
      const loaded = new Map(member.history.entries.map((entry) => [entry.id, entry]));
      const last = rows.at(-1);
      const activity = child.activity || (last?.kind === 'activity' ? last.label : last?.kind === 'message' ? loaded.get(last.id)?.text : last?.text) || child.title || 'No recent activity';
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
        const key = JSON.stringify([row, child.status === 'needs_input', child.name, loadedCount(row, loaded)]);
        let had = card.rows.get(row.id);
        // Don't discard text while the owner is selecting a command or patch to copy.
        if (!had || (had.key !== key && (selection?.isCollapsed !== false || !had.node.contains(selection.anchorNode)))) {
          const focused = document.activeElement;
          const focus = focused instanceof HTMLElement && had?.node.contains(focused) ? focused : undefined;
          const disclosure = focus?.closest<HTMLDetailsElement>('details[data-disclosure]')?.dataset.disclosure;
          const control = focus?.matches('.wt-message-more') ? '.wt-message-more' : undefined;
          const node = render(row, loaded, child.status === 'needs_input', child, card.expanded);
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
    team.sync(`${opts.queueKey}:${worker.id}:${worker.sessionId ?? ''}`, worker.id, opts.team?.() ?? []);
    team.enable(teamThreadVisible(active && !disposed, connected, !document.hidden && element.isConnected, teamSection.open));
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
  let emptyKey = '';
  const paintEmpty = () => {
    const starting = threadStarting(worker);
    const key = JSON.stringify([error, received, starting, connected]);
    if (key === emptyKey) return;
    emptyKey = key;
    empty.setAttribute('aria-busy', String(connected && !error && !received));
    if (error) empty.textContent = 'Conversation unavailable. Retry below, or open Raw TTY.';
    else if (!connected) empty.textContent = 'Waiting for the office to reconnect…';
    else if (!received)
      empty.replaceChildren(
        h('span.spinner.wt-loading-spinner', { 'aria-hidden': true }),
        h('b', {}, starting ? 'Starting worker…' : 'Reading the conversation…'),
        h('p', {}, starting ? 'Preparing the workspace and starting Droid. This can take a moment.' : 'Messages will appear here as soon as they’re ready.'),
      );
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
    const rows = history.rows;
    const loaded = new Map(history.entries.map((entry) => [entry.id, entry]));
    const asking = worker.status === 'needs_input';
    for (const row of rows) {
      const key = JSON.stringify([row, asking, loadedCount(row, loaded)]);
      let had = nodes.get(row.id);
      if (!had || had.key !== key) {
        const node = render(row, loaded, asking);
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
    stop.disabled = !allowed || sending;
    sendLabel.textContent = sending ? 'Sending…' : busy ? 'Send now' : 'Send';
    send.title = busy ? `Steer ${worker.name}: it reads this now, during the turn` : '';
    input.placeholder = busy ? `Steer ${worker.name}, or queue for after this turn…` : `Reply to ${worker.name}…`;
    hint.replaceChildren(...(busy ? [shortcut('Enter', 'steer'), shortcut('Ctrl Enter', 'queue'), shortcut('⇧ Enter', 'new line')] : [shortcut('Enter', 'send'), shortcut('⇧ Enter', 'new line'), shortcut('/', 'commands')]));
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
    if (threadStarting(worker) && !worker.sessionId) return;
    if (before === undefined && history.historical) return;
    if (before === undefined && Date.now() - lastReadAt < 1000) return;
    const request = `thread-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    if (net.send({ t: 'thread.read', workerId: worker.id, request, ...(before !== undefined ? { before } : {}) })) {
      lastReadAt = Date.now();
      if (startupReadUntil === Infinity) startupReadUntil = lastReadAt + 8000;
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
    error = threadSnapshotError(worker, msg.error, !received && Date.now() < startupReadUntil);
    if (!msg.error) {
      if (worker.sessionId && msg.sessionId !== worker.sessionId) return;
      history.apply(msg);
      if (history.unsupported) error = 'This office sent a Thread this page can’t read. Reload the page, or open Raw TTY.';
      opts.onEntries?.();
      received = true;
      paintEntries(older);
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
    sending = true;
    updateControls();
    await images.settled();
    if (disposed || !active || !connected || worker.status === 'needs_input') {
      sending = false;
      updateControls();
      return;
    }
    const queueReceipt = queueSend && isBusy(worker.status);
    const after = queued.sequence;
    const hasImage = images.ids().length > 0;
    const result = await opts.send({ t: 'worker.prompt', workerId: worker.id, prompt: text, images: images.ids(), queue: queueSend });
    sending = false;
    if (!result) {
      if (queueReceipt) queued.sent(text, hasImage, after);
      images.take();
      input.value = '';
      opts.onDraft('');
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
        slashMenu.children[slashCursor]?.scrollIntoView({ block: 'nearest' });
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
  const timer = setInterval(() => {
    if (!active || !connected || document.hidden) return;
    readTeam();
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
      if (online && !connected && active) net.send({ t: 'worker.attach', workerId: next.id });
      if (next.sessionId !== worker.sessionId) {
        startupReadUntil = threadStarting(worker) || threadStarting(next) ? Infinity : 0;
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
        net.send({ t: 'worker.attach', workerId: worker.id });
        read();
        loadSlash();
      } else net.send({ t: 'worker.detach', workerId: worker.id });
      updateControls();
      readTeam();
    },
    dispose() {
      if (disposed) return;
      if (active) net.send({ t: 'worker.detach', workerId: worker.id });
      disposed = true;
      active = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
      teamSection.removeEventListener('toggle', teamDisclosure, true);
      teamSection.removeEventListener('focusout', teamFocus);
      document.removeEventListener('selectionchange', teamSelection);
      off();
      resize.disconnect();
      questionChanges.disconnect();
      images.discard();
      team.dispose();
      teamNodes.clear();
    },
  };
}
