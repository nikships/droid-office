import { linearColumns, linearPromptVars, linkUrl, PRIORITY_NAMES, type LinearComment, type LinearTicket, type LinearTicketDetail } from '../../shared/linear';
import type { ClientMsg, ServerMsg } from '../../shared/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { withToken } from '../token';
import { h, openModal, timeAgo, toast } from './dom';
import { markdown } from './markdown';
import { card, workerChip } from './boards';
import { emptyState, field } from './kit';
import { labelChip } from './pull';
import { officePrompt } from './prompts';

// The Linear tab of a floor's issue board: the floor's team's tickets in Backlog, Todo, In Progress and
// Done, the window behind each card, and the form the owner writes new tickets in. Workers move the
// tickets themselves (server/linear.ts and the Office MCP's linear_* tools); this is the owner's view.

export interface LinearActions {
  /** Start a worker on a ready-made prompt (shown for editing first); the worker takes `identifier`. */
  assign(prompt: string, title: string, issue?: number, linear?: string): void;
  /** Walks you to a worker's desk. */
  goToDesk(deskId: string): void;
}

type SetupMsg = Extract<ServerMsg, { t: 'linear.setup' }>;
const setupWaiters = new Set<(msg: SetupMsg) => void>();

/** Main feeds server messages through here so Settings and the new-ticket form hear how their changes went. */
export function routeLinearMessage(msg: ServerMsg) {
  if (msg.t === 'linear.setup') for (const fn of setupWaiters) fn(msg);
}

/** Hears the answers to connecting Linear, setting the floor's team or autopilot, and writing a ticket; returns the unlisten. */
export function onLinearSetup(fn: (msg: SetupMsg) => void): () => void {
  setupWaiters.add(fn);
  return () => setupWaiters.delete(fn);
}

async function ticketDetail(id: string): Promise<LinearTicketDetail> {
  const floor = store.floor ? `&floor=${encodeURIComponent(store.floor)}` : '';
  const r = await fetch(withToken(`/api/linear/issue?id=${encodeURIComponent(id)}${floor}`), { credentials: 'same-origin' });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
  return r.json() as Promise<LinearTicketDetail>;
}

/** Bars for low, medium and high, a filled mark for urgent: the way Linear draws priorities. */
const PRIORITY_MARK = ['', '!', '▮▮▮', '▮▮▯', '▮▯▯'];

export function priorityChip(p: number) {
  if (p < 1 || p > 4) return '';
  return h('span.linear-prio', { class: p === 1 ? 'urgent' : '', title: `${PRIORITY_NAMES[p]} priority` }, h('span.linear-prio-mark', { 'aria-hidden': 'true' }, PRIORITY_MARK[p]), PRIORITY_NAMES[p]);
}

/** The ticket's state, with the dot in the team's own color for it. */
export function stateChip(t: Pick<LinearTicket, 'state'>) {
  const chip = h('span.linear-state', { class: t.state.type }, t.state.name);
  chip.style.setProperty('--dot', t.state.color || '#95a2b3');
  return chip;
}

/** The chip for the worker holding a ticket: its desk when it's on this floor. */
function holderChip(t: LinearTicket) {
  if (!t.worker) return '';
  const w = store.workers.get(t.worker.id);
  return w ? workerChip(w, `${w.name} is working on ${t.identifier}`) : h('span.desk-link', { title: `${t.worker.name} took ${t.identifier}` }, t.worker.name);
}

function ticketCard(t: LinearTicket, onclick: () => void) {
  return card(
    h('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer', onclick: ((e: Event) => e.stopPropagation()) as EventListener, title: 'Open in Linear' }, t.identifier),
    t.title,
    [stateChip(t), holderChip(t), ...t.labels.slice(0, 3).map(labelChip)],
    [priorityChip(t.priority), t.assignee ? `👤 ${t.assignee}` : 'unassigned', t.estimate ? h('span', { title: 'Estimate' }, `◷ ${t.estimate}`) : ''],
    timeAgo(t.updatedAt),
    onclick,
  );
}

/** The newest done tickets the Done column shows. */
const DONE_SHOWN = 40;

/** Draws the Linear tab into `body`: Backlog, Todo, In Progress and Done, left to right. */
export function renderLinearBoard(body: HTMLElement, actions: LinearActions, net: Net) {
  const st = store.linearBoard;
  const scrolled = [...body.querySelectorAll('.column > ul')].map((ul) => ul.scrollTop);
  body.replaceChildren();
  if (!st) return;
  if (st.error && !st.items.length) {
    body.append(emptyState('⚠️', `Couldn't load ${st.team} from Linear`, st.error, h('button.btn', { type: 'button', onclick: () => net.send({ t: 'linear.refresh' }) }, 'Try again')));
    return;
  }
  if (!st.fetchedAt) {
    body.append(h('div.empty-state', {}, h('span.spinner'), h('p', {}, `Loading ${st.team} from Linear…`)));
    return;
  }
  for (const col of linearColumns(st.items)) {
    const ul = h('ul');
    // A busy team finishes hundreds of tickets in the two weeks Done covers; the newest are what matter here.
    const shown = col.name === 'Done' ? col.items.slice(0, DONE_SHOWN) : col.items;
    for (const t of shown) ul.append(ticketCard(t, () => openLinearTicket(t, actions)));
    if (shown.length < col.items.length) ul.append(h('li.col-empty', {}, `And ${col.items.length - shown.length} more done in the last two weeks, in Linear`));
    if (!col.items.length) ul.append(h('li.col-empty', {}, col.name === 'Todo' ? 'Nothing waiting. Write a ticket and a worker can take it.' : 'Nothing here'));
    body.append(h('section.column', {}, h('h4', {}, h('span.col-title', {}, col.name), h('span.col-count', {}, h('span.col-n', {}, String(col.items.length)))), ul));
  }
  body.querySelectorAll('.column > ul').forEach((ul, i) => (ul.scrollTop = scrolled[i] ?? 0));
}

/** What the board's header says about autopilot, e.g. "Autopilot · 1 of 2 working". */
export function autopilotSummary(): string {
  const { autopilot, working } = store.linear;
  return autopilot.on ? `Autopilot on · ${working} of ${autopilot.max} working` : 'Autopilot off';
}

function commentCard(c: LinearComment) {
  return h('article.gh-card', {}, h('header', {}, h('b', {}, c.author), h('span', {}, 'commented'), h('span.when', { title: new Date(c.createdAt).toLocaleString() }, timeAgo(c.createdAt))), markdown(c.body));
}

/** The task a worker gets for a ticket: the "Linear ticket" prompt with its description. */
export function linearPrompt(t: { identifier: string; title: string; url: string; description?: string; branchName?: string }): string {
  return officePrompt('linear.work', linearPromptVars(t));
}

/** The window behind a ticket's card: description, sub-issues, links and comments, and who's on it. */
export function openLinearTicket(first: LinearTicket, actions: LinearActions) {
  let it: LinearTicket = first;
  let detail: LinearTicketDetail | null = null;
  let error = '';
  const close = h('button.btn.icon.close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, '✕');
  const state = h('span');
  const title = h('h3.gh-title');
  const meta = h('div.gh-meta');
  const thread = h('div.gh-items');
  const handBtn = h('button.btn.primary', { type: 'button' }, 'Hand to a worker') as HTMLButtonElement;
  const goBtn = h('button.btn', { type: 'button' }) as HTMLButtonElement;

  const el = h(
    'div.modal.xl.gh-window.issue.linear-ticket',
    { role: 'dialog', 'aria-label': `Linear ticket ${it.identifier}` },
    h('header', {}, state, h('div.titles', {}, h('h2', {}, `Linear ticket ${it.identifier}`)), close),
    h('div.gh-hero', {}, title, meta),
    h('div.gh-body', {}, h('div.gh-conv', {}, h('div.gh-detail.single', {}, h('div.gh-col', {}, thread)))),
    h('footer', {}, h('a.grow.gh-open', { href: it.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Linear ↗'), h('div.gh-actions', {}, h('div.gh-group', {}, goBtn, handBtn))),
  );

  const holder = () => (it.worker ? store.workers.get(it.worker.id) : undefined);
  const renderFrame = () => {
    state.replaceChildren(stateChip(it));
    title.title = it.title;
    title.replaceChildren(h('span.gh-ref', {}, it.identifier), ' ', it.title);
    meta.replaceChildren(
      priorityChip(it.priority) || h('span', {}, 'No priority'),
      h('span', {}, it.assignee ? `👤 ${it.assignee}` : 'unassigned'),
      ...it.labels.map(labelChip),
      it.project ? h('span', {}, `· ${it.project}`) : '',
      detail?.creator ? h('span', {}, `· written by ${detail.creator} ${timeAgo(detail.createdAt)}`) : '',
      detail?.parent ? h('span', { title: detail.parent.title }, `· sub-issue of ${detail.parent.identifier}`) : '',
    );
    const w = holder();
    goBtn.classList.toggle('hidden', !w);
    goBtn.textContent = w ? `Go to ${w.name}` : '';
    // A ticket a worker already has goes back to that worker, not to a second one.
    handBtn.classList.toggle('hidden', !!w || it.state.type === 'completed' || it.state.type === 'canceled');
  };
  const section = (label: string, rows: Node[]) => h('article.gh-card', {}, h('header', {}, h('b', {}, label)), h('ul.linear-list', {}, ...rows));
  const render = () => {
    thread.replaceChildren(h('article.gh-card', {}, h('header', {}, h('b', {}, 'Description')), detail ? markdown(detail.description || '_(No description.)_') : h('p.gh-quiet', {}, error ? '' : 'Loading…')));
    if (error) {
      thread.append(emptyState('⚠️', `Couldn't load ${it.identifier} from Linear`, error, h('button.btn', { type: 'button', onclick: () => load() }, 'Try again')));
      return;
    }
    if (!detail) return;
    if (detail.children.length)
      thread.append(
        section(
          'Sub-issues',
          detail.children.map((c) => h('li', {}, h('span.gh-ref', {}, c.identifier), ' ', c.title, h('small', {}, ` · ${c.state}`))),
        ),
      );
    if (detail.attachments.length)
      thread.append(
        section(
          'Links',
          detail.attachments.map((a) => {
            const href = linkUrl(a.url);
            return h('li', {}, href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, a.title || a.url) : a.title || a.url);
          }),
        ),
      );
    if (!detail.comments.length) thread.append(h('p.gh-quiet', {}, 'No comments.'));
    else thread.append(...detail.comments.map(commentCard));
  };
  let generation = 0;
  function load() {
    const g = ++generation;
    error = '';
    render();
    ticketDetail(it.id)
      .then((d) => {
        if (g !== generation) return;
        detail = d;
        it = { ...it, ...d };
      })
      .catch((err) => g === generation && (error = (err as Error).message))
      .finally(() => g === generation && (renderFrame(), render()));
  }

  handBtn.addEventListener('click', () => {
    modal.close();
    actions.assign(linearPrompt({ ...it, description: detail?.description, branchName: detail?.branchName }), `◆ Hand ${it.identifier} to a worker`, undefined, it.identifier);
  });
  goBtn.addEventListener('click', () => {
    const w = holder();
    if (!w) return;
    modal.close();
    actions.goToDesk(w.deskId);
  });

  const unsubs = [
    store.on('linearBoard', () => {
      const fresh = store.linearBoard?.items.find((t) => t.id === it.id);
      if (!fresh) return;
      it = { ...it, ...fresh, ...(fresh.worker ? {} : { worker: undefined }) };
      renderFrame();
    }),
    store.on('workers', renderFrame),
  ];
  const modal = openModal(el, { doing: `◆ reading ${it.identifier}`, onClose: () => unsubs.forEach((u) => u()) });
  close.addEventListener('click', () => modal.close());
  renderFrame();
  load();
}

/** The form for writing a ticket in the floor's team: title, description, priority, and Todo or Backlog. */
export function openNewLinearTicket(net: Net) {
  const board = store.linearBoard;
  const setup = store.linear.setup;
  if (!board || !setup) return toast('Pick a Linear team for this floor in Settings first', 'warn');
  const titleIn = h('input.input', { type: 'text', placeholder: 'What needs doing?', maxlength: 250, spellcheck: 'true', autocomplete: 'off' }) as HTMLInputElement;
  const descIn = h('textarea.input.linear-desc', { rows: 8, placeholder: 'Details, links, acceptance criteria… (Markdown)' }) as HTMLTextAreaElement;
  const prio = h('select.select', {}, ...[0, 1, 2, 3, 4].map((p) => h('option', { value: String(p) }, PRIORITY_NAMES[p]))) as HTMLSelectElement;
  let where: 'unstarted' | 'backlog' = 'unstarted';
  const todoBtn = h('button.btn.sm', { type: 'button' }, 'Todo');
  const backlogBtn = h('button.btn.sm', { type: 'button' }, 'Backlog');
  const seg = h('div.seg', { role: 'radiogroup', 'aria-label': 'Where the ticket starts' }, todoBtn, backlogBtn);
  const hint = h('p.field-hint');
  const fail = h('p.note.bad.hidden', { role: 'alert' });
  const submit = h('button.btn.primary', { type: 'button' }, 'Write ticket') as HTMLButtonElement;
  const cancel = h('button.btn.ghost', { type: 'button' }, 'Cancel');
  const another = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const close = h('button.btn.icon.close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, '✕');
  const el = h(
    'div.modal.linear-new',
    { role: 'dialog', 'aria-label': 'New Linear ticket' },
    h('header', {}, h('div.titles', {}, h('h2', {}, 'New Linear ticket'), h('p.sub', {}, `${setup.team.name}${setup.project ? ` · ${setup.project.name}` : ''}`)), close),
    h('div.body.stack', {}, field('Title', titleIn), field('Description', descIn), h('div.row.wrap', {}, field('Priority', prio), field('Starts in', seg)), hint, fail),
    h('footer', {}, h('label.grow.linear-another', {}, another, ' Write another after this'), cancel, submit),
  );
  const paint = () => {
    todoBtn.classList.toggle('on', where === 'unstarted');
    backlogBtn.classList.toggle('on', where === 'backlog');
    todoBtn.setAttribute('aria-checked', String(where === 'unstarted'));
    backlogBtn.setAttribute('aria-checked', String(where === 'backlog'));
    const { autopilot } = store.linear;
    hint.textContent =
      autopilot.on && autopilot.pickup.includes(where)
        ? `Autopilot is on: a worker of its own picks this up within a minute or two (${store.linear.working} of ${autopilot.max} busy).`
        : autopilot.on
          ? `Autopilot only takes tickets in ${autopilot.pickup.map((p) => (p === 'unstarted' ? 'Todo' : p === 'backlog' ? 'Backlog' : 'Triage')).join(' or ')}; this one waits for you to hand it to a worker.`
          : 'Hand it to a worker from its card, or turn on autopilot in Settings so every new ticket gets a worker of its own.';
  };
  todoBtn.setAttribute('role', 'radio');
  backlogBtn.setAttribute('role', 'radio');
  todoBtn.addEventListener('click', () => ((where = 'unstarted'), paint()));
  backlogBtn.addEventListener('click', () => ((where = 'backlog'), paint()));
  let busy = false;
  const send = () => {
    if (busy) return;
    if (!titleIn.value.trim()) return titleIn.focus();
    busy = true;
    submit.disabled = true;
    submit.textContent = 'Writing…';
    fail.classList.add('hidden');
    const msg: ClientMsg = { t: 'linear.create', title: titleIn.value.trim(), description: descIn.value, priority: Number(prio.value), state: where };
    if (!net.send(msg)) done({ t: 'linear.setup', step: 'create', ok: false, error: 'Not connected to the office' });
  };
  const done = (msg: SetupMsg) => {
    if (msg.step !== 'create' || !busy) return;
    busy = false;
    submit.disabled = false;
    submit.textContent = 'Write ticket';
    if (!msg.ok) {
      fail.textContent = msg.error ?? "Linear didn't take the ticket";
      fail.classList.remove('hidden');
      return;
    }
    toast(`◆ Wrote ${msg.identifier ?? 'the ticket'} in Linear`);
    if (!another.checked) return modal.close();
    titleIn.value = '';
    descIn.value = '';
    titleIn.focus();
  };
  const unsubs = [onLinearSetup(done), store.on('linear', paint)];
  submit.addEventListener('click', send);
  for (const input of [titleIn, descIn] as HTMLElement[]) {
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || input === titleIn)) {
        e.preventDefault();
        send();
      }
    });
  }
  const modal = openModal(el, { doing: '◆ writing a Linear ticket', onClose: () => unsubs.forEach((u) => u()) });
  close.addEventListener('click', () => modal.close());
  cancel.addEventListener('click', () => modal.close());
  paint();
  titleIn.focus();
}
