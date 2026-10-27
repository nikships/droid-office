import type { ClientMsg, ServerMsg, WorkerInfo } from '../../shared/protocol';
import { isAsleep, isBusy } from '../../shared/status';
import { presentThread, threadArguments, type ThreadRow } from '../../shared/thread-presentation';
import { ThreadQueue } from '../../shared/thread-queue';
import type { Net } from '../net';
import { ThreadHistory } from '../thread-history';
import { h, STATUS_LABEL } from './dom';
import { colorDot, toggle } from './kit';
import { markdown } from './markdown';
import { promptImages } from './images';
import { modelBadgeNode } from './models';
import { copy as copyText } from './clipboard';

export interface WorkerThread {
  element: HTMLElement;
  update(worker: WorkerInfo, connected: boolean): void;
  activate(active: boolean): void;
  dispose(): void;
}

interface ThreadOptions {
  worker: WorkerInfo;
  controls: HTMLElement;
  question: HTMLElement;
  queueKey: string;
  draft: string;
  onDraft(text: string): void;
  send(msg: ClientMsg): Promise<string | undefined>;
  raw(): void;
}

const localQueues = new Map<string, ThreadQueue>();

/** Local sessions only. This view reads JSONL and uses the existing worker actions, never a second Droid. */
export function mountWorkerThread(net: Net, opts: ThreadOptions): WorkerThread {
  let worker = opts.worker;
  let connected = false;
  let active = false;
  let disposed = false;
  let sending = false;
  let received = false;
  let error = '';
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
  const scroll = h('div.wt-scroll', { tabindex: 0, 'aria-label': 'Conversation history' }, earlier, list, empty, opts.question);
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
  const queuedNotice = h('div.wt-queued', { role: 'status', hidden: true });
  let queueKey = '';
  const paintQueue = () => {
    const messages = queued.sync(worker.sessionId, history.entries);
    if (messages.length) localQueues.set(opts.queueKey, queued);
    else localQueues.delete(opts.queueKey);
    try {
      if (messages.length) sessionStorage.setItem(opts.queueKey, JSON.stringify(queued));
      else sessionStorage.removeItem(opts.queueKey);
    } catch {}
    const busy = isBusy(worker.status);
    const key = JSON.stringify([messages, connected, busy]);
    if (key === queueKey) return;
    queueKey = key;
    queuedNotice.hidden = !messages.length;
    queuedNotice.replaceChildren(...messages.map((message) => h('p', {}, `Sent to Droid’s queue · ${message.text || 'Image attached'}`)));
    if (messages.length && !busy)
      queuedNotice.append(
        h('p', {}, 'Not yet in the conversation. It may have been cleared elsewhere.'),
        h('p', {}, 'Dismissing this receipt only hides it here. Droid’s queue is unchanged.'),
        h(
          'div.row.wrap',
          {},
          h('button.btn.sm', { type: 'button', disabled: !connected, onclick: opts.raw }, 'Check queue in Raw TTY'),
          h(
            'button.btn.sm.ghost',
            {
              type: 'button',
              onclick: () => {
                queued.clear();
                paintQueue();
              },
            },
            'Dismiss receipt',
          ),
        ),
      );
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
  const input = h('textarea.input.wt-input', { rows: 1, maxlength: 20000, placeholder: `Reply to ${worker.name}…`, 'aria-label': 'Message to worker' });
  input.value = opts.draft;
  input.addEventListener('input', () => {
    opts.onDraft(input.value);
    updateControls();
  });
  const images = promptImages(input);
  const file = h('input.hidden', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, 'aria-label': 'Choose pictures' });
  file.addEventListener('change', () => {
    images.add([...(file.files ?? [])]);
    file.value = '';
  });
  const attach = h('button.btn.sm.ghost', { type: 'button', onclick: () => file.click() }, 'Attach pictures');
  const queue = toggle({ label: 'Queue after this turn', checked: false });
  const send = h('button.btn.primary', { type: 'submit' }, 'Send');
  const stop = h('button.btn.wt-stop', { type: 'button', 'aria-label': 'Stop turn', title: 'Stop turn', onclick: () => void stopTurn() }, h('span.wt-stop-label', {}, 'Stop'), h('span.wt-stop-symbol', { 'aria-hidden': true }, '■'));
  const hint = h('span.wt-send-hint', {}, 'Enter to send · Shift+Enter for a new line');
  const form = h('form.wt-composer', {}, images.element, file, h('div.wt-compose-input', {}, input, h('div.wt-send-buttons', {}, stop, send)), h('div.wt-compose-actions', {}, attach, queue, hint));
  const element = h('section.worker-thread', { 'aria-label': `${worker.name} thread` }, head, scroll, latestAnchor, queuedNotice, h('div.wt-feedback', {}, notice, retry, raw), form);
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
  const updateClamps = () => {
    for (const text of list.querySelectorAll<HTMLElement>('.wt-user-content')) {
      const button = text.parentElement?.nextElementSibling?.querySelector<HTMLButtonElement>('.wt-message-more');
      if (button instanceof HTMLButtonElement) button.hidden = text.classList.contains('clamped') && text.scrollHeight <= text.clientHeight + 1;
    }
    for (const frame of list.querySelectorAll<HTMLElement>('.wt-code-scroll')) updateCode(frame);
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
  list.addEventListener('click', (event) => {
    const summary = event.target instanceof Element ? event.target.closest('summary') : null;
    const details = summary?.parentElement;
    if (details instanceof HTMLDetailsElement && !details.open)
      requestAnimationFrame(() => {
        if (details.open) details.scrollIntoView({ block: 'nearest' });
      });
  });
  list.addEventListener(
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
  const render = (row: ThreadRow) => {
    const node = h('article.wt-entry', { 'data-entry': row.id });
    if (row.kind === 'activity') {
      node.classList.add('activity');
      const details = h(
        'details.wt-activity',
        { class: row.state, 'data-disclosure': row.id },
        h(
          'summary',
          {},
          h('span.wt-activity-mark', { 'aria-hidden': true }),
          h('span.wt-activity-label', {}, `${row.live ? 'Working · ' : ''}${row.label}`),
          row.failed.length || row.cancelled || row.noResult
            ? h('span.wt-activity-status', {}, [row.failed.length ? `${row.failed.length} failed` : '', row.cancelled ? `${row.cancelled} cancelled` : '', row.noResult ? `${row.noResult} no result` : ''].filter(Boolean).join(' · '))
            : null,
          h('span.wt-chevron', { 'aria-hidden': true }, '›'),
        ),
      );
      const body = h('div.wt-activity-body');
      for (const item of row.items) {
        if (item.type === 'thought') {
          body.append(
            h(
              'details.wt-thinking',
              { 'data-disclosure': item.entry.id },
              h('summary', {}, h('span', {}, 'Thought'), h('span.wt-thought-preview', {}, item.preview), h('span.wt-chevron', { 'aria-hidden': true }, '›')),
              h('div.wt-thinking-text', {}, item.entry.text ?? ''),
            ),
          );
          continue;
        }
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
      if (row.live && !row.failed.length && current) node.append(h('p.wt-running', { role: 'status' }, current.title));
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
      if (entry.role === 'assistant' && row.startsTurn) node.append(h('div.wt-who', {}, worker.name));
      const actions = h('div.wt-message-actions');
      if (entry.role === 'user') {
        const text = h('div.wt-user-content', { id: `wt-message-${entry.id}`, class: expandedMessages.has(entry.id) ? '' : 'clamped' }, entry.text ?? '');
        const more = h(
          'button.btn.sm.ghost.wt-message-more',
          {
            type: 'button',
            'aria-expanded': String(expandedMessages.has(entry.id)),
            'aria-controls': text.id,
            onclick: () => {
              const expanded = !expandedMessages.has(entry.id);
              if (expanded) expandedMessages.add(entry.id);
              else expandedMessages.delete(entry.id);
              text.classList.toggle('clamped', !expanded);
              more.setAttribute('aria-expanded', String(expanded));
              more.textContent = expanded ? 'Show less' : 'Show all';
              updateClamps();
            },
          },
          expandedMessages.has(entry.id) ? 'Show less' : 'Show all',
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
    for (const row of rows) {
      const key = JSON.stringify(row);
      let had = nodes.get(row.id);
      if (!had || had.key !== key) {
        const node = render(row);
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
    empty.textContent = received ? 'No conversation messages yet. Send a prompt to get started.' : 'Reading the conversation…';
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
    send.disabled = input.disabled;
    queue.input.disabled = input.disabled;
    stop.hidden = !isBusy(worker.status) && !waiting;
    stop.disabled = !allowed || sending;
    send.textContent = sending ? 'Sending…' : queue.input.checked ? 'Queue' : 'Send';
    earlier.disabled = !!pending || !connected;
    retry.classList.toggle('hidden', !error || error.startsWith('Slash commands'));
    retry.disabled = !connected || !!pending;
    empty.classList.toggle('error', !!error && !history.entries.length);
    if (!history.entries.length)
      empty.textContent = error ? 'Conversation unavailable. Retry below, or open Raw TTY.' : received ? 'Start a conversation. Your messages and the worker’s replies will appear here.' : 'Reading the conversation…';
    notice.textContent = connected ? error || (isAsleep(worker.status) ? 'Resume this worker to send another message.' : '') : '';
    raw.classList.toggle('hidden', !connected || (!error && !isAsleep(worker.status)));
    element.classList.toggle('has-feedback', !!notice.textContent);
    paintQueue();
  };
  const read = (before?: number) => {
    if (!active || !connected || disposed || document.hidden || pending) return;
    if (before === undefined && history.historical) return;
    if (before === undefined && Date.now() - lastReadAt < 1000) return;
    const request = `thread-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    if (net.send({ t: 'thread.read', workerId: worker.id, request, ...(before !== undefined ? { before } : {}) })) {
      lastReadAt = Date.now();
      pending = { request, before, at: lastReadAt };
    }
    updateControls();
  };
  const receive = (msg: ServerMsg) => {
    if (msg.t !== 'thread.snapshot' || !active || !pending || msg.workerId !== worker.id || msg.request !== pending.request) return;
    const older = pending.before !== undefined;
    pending = undefined;
    error = msg.error ?? '';
    if (!error) {
      if (worker.sessionId && msg.sessionId !== worker.sessionId) return;
      history.apply(msg);
      paintEntries(older);
      received = true;
    }
    updateControls();
  };
  const submit = async () => {
    if (input.disabled || sending) return;
    if (input.value.trimStart().startsWith('/')) {
      error = 'Slash commands open CLI dialogs. Your draft is kept; run this command in Raw TTY.';
      updateControls();
      return;
    }
    const text = input.value.trim();
    if (!text && !images.ids().length && !images.busy()) return input.focus();
    sending = true;
    updateControls();
    await images.settled();
    if (disposed || !active || !connected || worker.status === 'needs_input') {
      sending = false;
      updateControls();
      return;
    }
    const queueSend = queue.input.checked;
    const after = queued.sequence;
    const hasImage = images.ids().length > 0;
    const result = await opts.send({ t: 'worker.prompt', workerId: worker.id, prompt: text, images: images.ids(), queue: queueSend });
    sending = false;
    if (!result) {
      if (queueSend) queued.sent(text, hasImage, after);
      images.take();
      input.value = '';
      opts.onDraft('');
      queue.input.checked = false;
      if (history.historical) history.clear(worker.sessionId);
      follow();
      read();
    }
    error = result ?? '';
    updateControls();
  };
  const stopTurn = async () => {
    if (stop.disabled) return;
    // Escape is the CLI's own cancel path, and requires the normal worker attachment.
    const result = await opts.send({ t: 'term.input', workerId: worker.id, data: '\u001b' });
    error = result ?? '';
    updateControls();
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  });
  queue.input.addEventListener('change', updateControls);
  const off = net.onMessage(receive);
  const timer = setInterval(() => {
    if (!active || !connected || document.hidden) return;
    if (pending && Date.now() - pending.at > 8000) {
      pending = undefined;
      error = 'The office did not return this conversation. Retry, or use Raw TTY on an older office.';
      updateControls();
    }
    if (!error) read();
  }, 1000);
  const visibility = () => {
    if (!document.hidden && active) read();
  };
  document.addEventListener('visibilitychange', visibility);
  return {
    element,
    update(next, online) {
      if (online && !connected && active) net.send({ t: 'worker.attach', workerId: next.id });
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
      status.className = `pill ${worker.status}`;
      status.textContent = isAsleep(worker.status) ? 'Asleep' : (STATUS_LABEL[worker.status] ?? worker.status);
      const badge = modelBadgeNode(worker.activeModel ?? worker.model, worker.activeEffort ?? worker.effort);
      model.replaceChildren(...(badge ? [badge] : []));
      if (active) head.append(opts.controls);
      if (received) paintEntries(false);
      updateControls();
      read();
    },
    activate(on) {
      if (active === on) return;
      active = on;
      pending = undefined;
      if (on) {
        net.send({ t: 'worker.attach', workerId: worker.id });
        head.append(opts.controls);
        read();
      } else net.send({ t: 'worker.detach', workerId: worker.id });
      updateControls();
    },
    dispose() {
      if (disposed) return;
      if (active) net.send({ t: 'worker.detach', workerId: worker.id });
      disposed = true;
      active = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
      off();
      resize.disconnect();
      questionChanges.disconnect();
      images.discard();
    },
  };
}
