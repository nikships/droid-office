import { ticketColumns, ticketPrompt, type JiraComment, type JiraTicket, type JiraTicketDetail } from '../../shared/jira';
import type { AgentEffort, AgentProvider, ServerMsg } from '../../shared/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, timeAgo } from './dom';
import { markdown } from './markdown';
import { providerPicker } from './provider';

// The Jira tab of a floor's issue board: its epic's direct children in the columns of the project's
// Jira board, and the window behind each card, where people move, comment on and assign the ticket,
// or hand it to a worker who keeps it up to date with office-jira.

export interface JiraActions {
  /** Start a worker on the ticket's prompt (shown for editing first); `ticket` goes with it. */
  assignTicket(prompt: string, title: string, ticket: string): void;
  /** Put the ticket on the 📋 task queue. */
  queueTicket(prompt: string, title: string, ticket: string, provider?: AgentProvider, model?: string, effort?: AgentEffort): void;
}

const doneWaiters = new Map<string, (msg: Extract<ServerMsg, { t: 'jira.done' }>) => void>();
type SetupMsg = Extract<ServerMsg, { t: 'jira.setup' }>;
const setupWaiters = new Set<(msg: SetupMsg) => void>();

/** Main feeds server messages through here so an open ticket window or the settings hear how their request went. */
export function routeJiraMessage(msg: ServerMsg) {
  if (msg.t === 'jira.done') doneWaiters.get(msg.key)?.(msg);
  if (msg.t === 'jira.setup') for (const fn of setupWaiters) fn(msg);
}

/** Hears the answers to connecting Jira and setting the floor's epic; returns the unlisten. */
export function onJiraSetup(fn: (msg: SetupMsg) => void): () => void {
  setupWaiters.add(fn);
  return () => setupWaiters.delete(fn);
}

async function ticketDetail(key: string): Promise<JiraTicketDetail> {
  const floor = store.floor ? `&floor=${encodeURIComponent(store.floor)}` : '';
  const r = await fetch(`/api/jira/ticket?key=${encodeURIComponent(key)}${floor}`, { credentials: 'same-origin' });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
  return r.json() as Promise<JiraTicketDetail>;
}

const CATEGORY_CLASS: Record<JiraTicket['category'], string> = { new: 'idle', indeterminate: 'working', done: 'done' };

/** Where a ticket stands on the 📋 queue, for its card. */
function queueChip(key: string): Node | '' {
  const t = store.taskForTicket(key);
  if (!t) return '';
  if (t.status === 'queued') return h('span.qchip', {}, '📋 queued');
  if (t.status === 'running') return h('span.qchip.running', {}, `🤖 ${t.workerName ?? 'a worker'}`);
  return t.pr ? h('span.qchip.done', {}, `🔀 #${t.pr.number}`) : '';
}

/** The worker at a desk that holds this ticket, if one does. */
function workerOn(key: string) {
  for (const w of store.workers.values()) if (w.ticket === key) return w;
  return undefined;
}

function ticketCard(t: JiraTicket, onclick: () => void) {
  const w = workerOn(t.key);
  const meta: (Node | string)[] = [
    t.type ? h('span.jira-type', {}, t.type) : '',
    t.priority ? `⚑ ${t.priority}` : '',
    w ? h('span.desk-link', { style: `--dot:${w.color}`, title: `${w.name} has this ticket` }, `🪑 ${w.name}`) : '',
    queueChip(t.key),
    t.assignee ? `👤 ${t.assignee}` : 'unassigned',
    h('span.pill', { class: CATEGORY_CLASS[t.category] }, t.status),
    t.updated ? timeAgo(t.updated) : '',
  ];
  return h(
    'li.card',
    { tabindex: 0, onclick, onkeydown: ((e: KeyboardEvent) => e.key === 'Enter' && onclick()) as EventListener },
    h('div.num', {}, h('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer', onclick: ((e: Event) => e.stopPropagation()) as EventListener, title: 'Open in Jira' }, t.key)),
    h('div.ttl', {}, t.summary),
    h('div.meta', {}, ...meta.filter((m) => m !== '').map((m) => (typeof m === 'string' ? h('span', {}, m) : m))),
  );
}

/** Draws the Jira tab into `body`: the board's columns, left to right. */
export function renderJiraBoard(body: HTMLElement, net: Net, actions: JiraActions) {
  const st = store.jiraBoard;
  const scrolled = [...body.querySelectorAll('.column > ul')].map((ul) => ul.scrollTop);
  body.replaceChildren();
  if (!st) return;
  if (st.error && !st.items.length) {
    body.append(h('div.board-error', {}, `Couldn't load ${st.epic} from Jira: ${st.error}`));
    return;
  }
  if (!st.fetchedAt && st.loading) {
    body.append(h('div.board-error', {}, `Loading ${st.epic} from Jira…`));
    return;
  }
  for (const col of ticketColumns(st.columns, st.items)) {
    const ul = h('ul');
    for (const t of col.items) ul.append(ticketCard(t, () => openTicket(t, net, actions)));
    if (!col.items.length) ul.append(h('li.empty', {}, 'Nothing here'));
    body.append(h('section.column', {}, h('h4', {}, col.name, h('span', {}, String(col.items.length))), ul));
  }
  body.querySelectorAll('.column > ul').forEach((ul, i) => (ul.scrollTop = scrolled[i] ?? 0));
}

function commentCard(c: JiraComment) {
  return h('article.gh-card', {}, h('header', {}, h('b', {}, c.author), h('span', {}, 'commented'), h('span.when', { title: c.created ? new Date(c.created).toLocaleString() : '' }, c.created ? timeAgo(c.created) : '')), markdown(c.body));
}

/** The window behind a ticket's card. */
export function openTicket(first: JiraTicket, net: Net, actions: JiraActions) {
  let it: JiraTicket = first;
  let detail: JiraTicketDetail | null = null;
  let error = '';
  let busy = '';
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const pill = h('span.pill');
  const meta = h('div.gh-meta');
  const thread = h('div.gh-items');
  const result = h('div.gh-merge-result.error.hidden');
  const moveSelect = h('select.provider-select', { 'aria-label': 'Move to' }) as HTMLSelectElement;
  const moveBtn = h('button.btn', { type: 'button' }, 'Move') as HTMLButtonElement;
  const assignBtn = h('button.btn', { type: 'button' }, 'Assign to the office') as HTMLButtonElement;
  const ta = h('textarea', { rows: 3, placeholder: 'Comment on the ticket. ⌘/Ctrl+Enter posts it.', 'aria-label': 'Comment' }) as HTMLTextAreaElement;
  const post = h('button.btn.primary', { type: 'button' }, 'Comment') as HTMLButtonElement;
  const who = h('span.grow');
  const queueProvider = providerPicker(store.project, `ticket-provider-${it.key}`, 'Queue provider');
  const queueBtn = h('button.btn', { type: 'button' }) as HTMLButtonElement;
  const handBtn = h('button.btn.primary', { type: 'button' }, 'Hand to a worker') as HTMLButtonElement;
  const prompt = () => ticketPrompt({ key: it.key, summary: it.summary, description: detail?.description, url: it.url }, store.project?.forge);

  const el = h(
    'div.modal.gh-window.issue.jira-ticket',
    { role: 'dialog', 'aria-label': `Jira ticket ${it.key}` },
    h('header', {}, pill, h('h2', { title: it.summary }, `${it.key} ${it.summary}`), close),
    meta,
    h(
      'div.gh-body',
      {},
      h(
        'div.gh-conv',
        {},
        h(
          'div.gh-col',
          {},
          thread,
          h(
            'article.gh-card.gh-compose',
            {},
            h('header', {}, h('b', {}, 'Update the ticket')),
            h('div.seg', { style: 'padding:8px 12px' }, moveSelect, moveBtn, assignBtn),
            h('div.gh-compose-body', {}, ta),
            result,
            h('div.gh-compose-foot', {}, who, post),
          ),
        ),
      ),
    ),
    h('footer', {}, h('a.grow', { href: it.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Jira ↗'), queueProvider.element, queueBtn, handBtn),
  );

  const fail = (text: string) => {
    result.textContent = text;
    result.classList.toggle('hidden', !text);
  };
  const renderControls = () => {
    const ts = detail?.transitions ?? [];
    const was = moveSelect.value;
    moveSelect.replaceChildren(...(ts.length ? ts.map((t) => h('option', { value: t.id }, t.name === t.to ? t.to : `${t.to} (${t.name})`)) : [h('option', { value: '' }, detail ? 'No moves from here' : 'Loading…')]));
    if (ts.some((t) => t.id === was)) moveSelect.value = was;
    moveSelect.disabled = !!busy || !ts.length;
    moveBtn.disabled = !!busy || !ts.length;
    moveBtn.textContent = busy === 'transition' ? 'Moving…' : 'Move';
    assignBtn.disabled = !!busy;
    assignBtn.textContent = busy === 'assign' ? 'Assigning…' : `Assign to ${store.jira.connection?.name ?? 'the office'}`;
    post.disabled = !!busy || !ta.value.trim();
    post.textContent = busy === 'comment' ? 'Posting…' : 'Comment';
    ta.readOnly = busy === 'comment';
    who.textContent = `Everything here goes to Jira as ${store.jira.connection?.name ?? "the office's account"}`;
    const task = store.taskForTicket(it.key);
    const onQueue = !!task && task.status !== 'done';
    const done = it.category === 'done';
    queueProvider.element.classList.toggle('hidden', onQueue || done);
    queueBtn.classList.toggle('hidden', done);
    queueBtn.disabled = onQueue;
    queueBtn.textContent = onQueue ? (task!.status === 'running' ? `${task!.workerName ?? 'A worker'} is on it` : 'On the queue') : 'Add to queue';
    handBtn.classList.toggle('hidden', done);
  };
  const renderFrame = () => {
    pill.className = `pill ${CATEGORY_CLASS[it.category]}`;
    pill.textContent = it.status;
    meta.replaceChildren(
      h('span.jira-type', {}, it.type || 'Ticket'),
      it.priority ? h('span', {}, `⚑ ${it.priority}`) : '',
      h('span', {}, it.assignee ? `👤 ${it.assignee}` : 'unassigned'),
      detail?.reporter ? h('span', {}, `· reported by ${detail.reporter}${detail.created ? ` ${timeAgo(detail.created)}` : ''}`) : '',
      store.jira.epic ? h('span', {}, `· in ${store.jira.epic.key}`) : '',
    );
    renderControls();
  };
  const render = () => {
    thread.replaceChildren(h('article.gh-card', {}, h('header', {}, h('b', {}, 'Description')), detail ? markdown(detail.description) : h('p.gh-quiet', {}, error ? '' : 'Loading…')));
    if (error) thread.append(h('div.gh-error', {}, `Couldn't load ${it.key} from Jira: ${error}`, h('button.btn', { type: 'button', onclick: () => load() }, 'Try again')));
    else if (detail && !detail.comments.length) thread.append(h('p.gh-quiet', {}, 'No comments yet.'));
    else if (detail) thread.append(...detail.comments.map(commentCard));
  };
  let generation = 0;
  function load() {
    const g = ++generation;
    error = '';
    render();
    ticketDetail(it.key)
      .then((d) => {
        if (g !== generation) return;
        detail = d;
        it = { ...it, ...d };
      })
      .catch((err) => g === generation && (error = (err as Error).message))
      .finally(() => g === generation && (renderFrame(), render()));
  }

  doneWaiters.set(it.key, (msg) => {
    busy = '';
    fail(msg.error ?? '');
    if (!msg.error && msg.action === 'comment') {
      ta.value = '';
      if (detail && msg.comment) detail.comments.push(msg.comment);
      render();
    }
    if (!msg.error && msg.action !== 'comment') load();
    renderControls();
  });
  moveBtn.addEventListener('click', () => {
    if (!moveSelect.value || busy) return;
    busy = 'transition';
    fail('');
    net.send({ t: 'jira.transition', key: it.key, transition: moveSelect.value });
    renderControls();
  });
  assignBtn.addEventListener('click', () => {
    if (busy) return;
    busy = 'assign';
    fail('');
    net.send({ t: 'jira.assign', key: it.key });
    renderControls();
  });
  const send = () => {
    const body = ta.value.trim();
    if (!body || busy) return;
    busy = 'comment';
    fail('');
    net.send({ t: 'jira.comment', key: it.key, body });
    renderControls();
  };
  post.addEventListener('click', send);
  ta.addEventListener('input', renderControls);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  });
  queueBtn.addEventListener('click', () => {
    if (!queueProvider.valid()) return;
    modal.close();
    actions.queueTicket(prompt(), `${it.key} ${it.summary}`, it.key, queueProvider.value(), queueProvider.model(), queueProvider.effort());
  });
  handBtn.addEventListener('click', () => {
    modal.close();
    actions.assignTicket(prompt(), `Hand ${it.key} to a worker`, it.key);
  });

  const unsubs = [
    store.on('jiraBoard', () => {
      const fresh = store.jiraBoard?.items.find((t) => t.key === it.key);
      if (!fresh) return;
      it = { ...it, ...fresh };
      renderFrame();
    }),
    store.on('queue', renderControls),
    store.on('jira', renderControls),
  ];
  const modal = openModal(el, {
    doing: `🎫 reading ${it.key}`,
    onClose: () => {
      doneWaiters.delete(first.key);
      unsubs.forEach((u) => u());
    },
  });
  close.addEventListener('click', () => modal.close());
  renderFrame();
  load();
}
