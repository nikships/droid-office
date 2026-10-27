import type { ClientMsg, ServerMsg, WorkerInfo } from '../../shared/protocol';
import type { ThreadEntry } from '../../shared/worker-thread';
import { isAsleep, isBusy } from '../../shared/status';
import { toolLine } from '../../shared/factory-sessions';
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
  draft: string;
  onDraft(text: string): void;
  send(msg: ClientMsg): Promise<string | undefined>;
  raw(): void;
}

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
  const title = h('h2', {}, worker.name);
  const status = h('span.pill');
  const model = h('div.wt-model');
  const head = h('header.wt-head', {}, colorDot(worker.color), h('div.titles', {}, h('div.row', {}, title, status), model), opts.controls);
  const earlier = h('button.btn.sm.wt-earlier.hidden', { type: 'button', onclick: () => read(history.entries[0]?.seq) }, 'Load earlier messages');
  const list = h('div.wt-list');
  const empty = h('div.wt-empty', { role: 'status' }, 'Reading the conversation…');
  const scroll = h('div.wt-scroll', { tabindex: 0, 'aria-label': 'Conversation history' }, earlier, list, empty);
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
  const raw = h('button.btn.sm.ghost', { type: 'button', onclick: opts.raw }, 'Open Raw TTY');
  const input = h('textarea.input.wt-input', { rows: 3, maxlength: 20000, placeholder: 'Send a message…', 'aria-label': 'Message to worker' });
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
  const stop = h('button.btn', { type: 'button', onclick: () => void stopTurn() }, 'Stop');
  const hint = h('span.wt-send-hint', {}, 'Enter to send · Shift+Enter for a new line');
  const form = h('form.wt-composer', {}, input, images.element, file, h('div.wt-compose-actions', {}, attach, queue, h('span.grow'), stop, send), hint);
  const element = h('section.worker-thread', { 'aria-label': `${worker.name} thread` }, head, scroll, latest, h('div.wt-feedback', {}, notice, retry, raw), form);
  images.dropZone(form);
  const nodes = new Map<string, { key: string; node: HTMLElement }>();
  const atBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  const follow = () => {
    scroll.scrollTop = scroll.scrollHeight;
    latest.classList.add('hidden');
  };
  scroll.addEventListener('scroll', () => latest.classList.toggle('hidden', !history.historical && atBottom()));
  const render = (entry: ThreadEntry) => {
    const node = h('article.wt-entry', { class: `${entry.role} ${entry.kind}`, 'data-entry': entry.id });
    if (entry.kind === 'tool') {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(entry.input ?? '{}');
      } catch {
        /* Older tool arguments can be plain text. */
      }
      const done = entry.output !== undefined;
      const state = entry.error ? 'Failed' : done ? 'Completed' : isBusy(worker.status) ? 'Running' : 'No result recorded';
      const details = h(
        'details.wt-tool',
        { class: entry.error ? 'error' : done ? 'done' : 'pending' },
        h('summary', {}, h('span.wt-tool-state', {}, state), h('span.wt-tool-title', {}, toolLine(entry.name ?? 'Tool', args))),
        entry.input ? h('pre.wt-code', {}, entry.input) : null,
        h('pre.wt-code.wt-output', {}, entry.output ?? 'A result has not been written to the session yet.'),
      );
      node.append(details);
    } else if (entry.kind === 'thinking') {
      node.append(h('details.wt-thinking', {}, h('summary', {}, 'Thinking'), h('div.wt-thinking-text', {}, entry.text ?? '')));
    } else if (entry.kind === 'text') {
      node.append(h('div.wt-who', {}, entry.role === 'user' ? 'You' : worker.name), entry.role === 'user' ? h('div.wt-user-text', {}, entry.text ?? '') : markdown(entry.text ?? ''));
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
      node.append(copy);
    } else if (entry.kind === 'todo') {
      node.append(h('details.wt-todos', {}, h('summary', {}, 'Task progress'), h('pre.wt-code', {}, entry.text ?? '')));
    } else node.append(h('p.wt-turn', {}, entry.text ?? ''));
    return node;
  };
  const paintEntries = (older: boolean) => {
    const stick = !received || (!older && atBottom());
    const top = scroll.scrollTop;
    const height = scroll.scrollHeight;
    const want: HTMLElement[] = [];
    const keep = new Set<string>();
    for (const entry of history.entries) {
      const key = JSON.stringify([entry, entry.kind === 'tool' && !entry.output ? isBusy(worker.status) : null]);
      let had = nodes.get(entry.id);
      if (!had || had.key !== key) {
        const opened = had?.node.querySelector('details')?.open;
        const node = render(entry);
        if (opened) node.querySelector('details')?.setAttribute('open', '');
        had = { key, node };
        nodes.set(entry.id, had);
      }
      keep.add(entry.id);
      want.push(had.node);
    }
    for (const id of nodes.keys()) if (!keep.has(id)) nodes.delete(id);
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
    earlier.classList.toggle('hidden', !history.hasMore);
    latest.textContent = history.historical ? 'Back to the latest' : 'Jump to latest';
    empty.hidden = history.entries.length > 0;
    empty.textContent = received ? 'No conversation messages yet. Send a prompt to get started.' : 'Reading the conversation…';
    if (stick) follow();
    else if (older) scroll.scrollTop = top + scroll.scrollHeight - height;
    else latest.classList.toggle('hidden', !history.historical && atBottom());
    if (history.historical) latest.classList.remove('hidden');
  };
  const updateControls = () => {
    const allowed = active && connected && !disposed && !isAsleep(worker.status) && !worker.lost;
    const waiting = worker.status === 'needs_input';
    input.disabled = !allowed || sending || waiting;
    attach.disabled = input.disabled;
    send.disabled = input.disabled;
    queue.input.disabled = input.disabled;
    stop.hidden = !isBusy(worker.status) && !waiting;
    stop.disabled = !allowed || sending;
    send.textContent = sending ? 'Sending…' : queue.input.checked ? 'Queue' : 'Send';
    earlier.disabled = !!pending || !connected;
    retry.classList.toggle('hidden', !error);
    retry.disabled = !connected || !!pending;
    if (!history.entries.length) empty.textContent = error ? 'Conversation unavailable. Retry or open Raw TTY.' : received ? 'No conversation messages yet. Send a prompt to get started.' : 'Reading the conversation…';
    notice.textContent = !connected
      ? 'Disconnected. Messages are kept here; nothing will be sent automatically.'
      : error ||
        (waiting
          ? 'Answer the question above. For other CLI dialogs, use Raw TTY.'
          : isAsleep(worker.status)
            ? 'Resume this worker to send another message.'
            : isBusy(worker.status)
              ? 'Working. Queue waits for this turn to finish. Stop cancels the current turn.'
              : 'Local session history · CLI-only dialogs and slash commands are available in Raw TTY.');
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
    const result = await opts.send({ t: 'worker.prompt', workerId: worker.id, prompt: text, images: images.ids(), queue: queue.input.checked });
    sending = false;
    if (!result) {
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
      status.textContent = STATUS_LABEL[worker.status] ?? worker.status;
      const badge = modelBadgeNode(worker.activeModel ?? worker.model, worker.activeEffort ?? worker.effort);
      model.replaceChildren(...(badge ? [badge] : []));
      if (active) head.append(opts.controls);
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
      images.discard();
    },
  };
}
