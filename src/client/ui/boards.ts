import { columnCards } from '../../shared/board-filter';
import { DESK_BY_ID } from '../../shared/layout';
import type { AgentEffort, GhIssue, GhLabel, GhPull, WorkerInfo } from '../../shared/protocol';
import type { Net } from '../net';
import { store, words, workerForPull } from '../state';
import { h, openModal, timeAgo } from './dom';
import { labelChip, openIssue, openLabels, openPull } from './pull';
import type { MeetingPreset } from './meeting';
import { renderJiraBoard } from './jira';
import { officePrompt } from './prompts';
import { issuePromptVars } from '../../shared/prompts';

export interface BoardActions {
  /** Start a worker on a ready-made prompt (shown for editing first). */
  assign(prompt: string, title: string): void;
  /** Your own prompt about an issue or PR; `context` goes first so the worker knows which. */
  ask(context: string, title: string): void;
  /** Walks you to the desk a pull request came from. */
  goToDesk(deskId: string): void;
  /** Put an issue on the 📋 task queue; a worker is seated for it when there's room. */
  queue(prompt: string, title: string, issue: number, model?: string, effort?: AgentEffort): void;
  /** Take the issue's card off the board, to carry to a desk or the queue. */
  pickUp(issue: GhIssue): void;
  /** Call a meeting about it: the meeting room's form, filled in. */
  meeting(preset: MeetingPreset): void;
}

/** The task a worker gets for an issue, from the board, a carried card or the queue (the 'issue.work' prompt). */
export function issuePrompt(it: Pick<GhIssue, 'number' | 'title'> & { url?: string }): string {
  return officePrompt('issue.work', issueVars(it));
}

/** What an issue's prompts fill in on this floor. A carried card has no URL, but the board usually knows it. */
export function issueVars(it: Pick<GhIssue, 'number' | 'title'> & { url?: string }) {
  return issuePromptVars(store.project?.forge, { ...it, url: it.url ?? store.issues.items.find((i) => i.number === it.number)?.url ?? '' });
}

interface Column<T> {
  /** Names the column in your saved label filters. */
  key: string;
  title: string;
  items: T[];
  /** Shows at most this many (after the label and title filters). */
  max?: number;
}

const byUpdated = (a: { updatedAt: string }, b: { updatedAt: string }) => b.updatedAt.localeCompare(a.updatedAt);

function issueColumns(items: GhIssue[]): Column<GhIssue>[] {
  const open = items.filter((i) => i.state === 'OPEN');
  const inProgress = open.filter((i) => i.assignees.length > 0 || i.labels.some((l) => /progress|doing|wip|started/i.test(l.name)) || store.taskForIssue(i.number)?.status === 'running');
  const todo = open.filter((i) => !inProgress.includes(i));
  return [
    { key: 'open', title: 'Open', items: todo },
    { key: 'progress', title: 'In progress', items: inProgress },
    { key: 'closed', title: 'Closed', items: items.filter((i) => i.state !== 'OPEN').sort(byUpdated), max: 40 },
  ];
}

function pullColumns(items: GhPull[]): Column<GhPull>[] {
  const open = items.filter((p) => p.state === 'OPEN');
  return [
    { key: 'draft', title: 'Draft', items: open.filter((p) => p.isDraft) },
    { key: 'review', title: 'In review', items: open.filter((p) => !p.isDraft && p.reviewDecision !== 'APPROVED') },
    { key: 'approved', title: 'Approved', items: open.filter((p) => !p.isDraft && p.reviewDecision === 'APPROVED') },
    { key: 'merged', title: 'Merged', items: items.filter((p) => p.state === 'MERGED').sort(byUpdated), max: 30 },
    { key: 'closed', title: 'Closed', items: items.filter((p) => p.state === 'CLOSED').sort(byUpdated), max: 20 },
  ];
}

/** The labels each column is filtered to (column key → label names), per floor and board, kept in this browser. */
type LabelFilters = Record<string, string[]>;

function filtersKey(kind: 'issues' | 'pulls'): string {
  return `droid-office.board-labels.${store.floor ?? ''}.${kind}`;
}

function loadFilters(kind: 'issues' | 'pulls'): LabelFilters {
  const out: LabelFilters = {};
  try {
    const saved = JSON.parse(localStorage.getItem(filtersKey(kind)) ?? 'null');
    if (saved && typeof saved === 'object') {
      for (const [k, v] of Object.entries(saved)) if (Array.isArray(v) && v.length) out[k] = v.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    // storage blocked or garbled
  }
  return out;
}

function saveFilters(kind: 'issues' | 'pulls', filters: LabelFilters) {
  try {
    localStorage.setItem(filtersKey(kind), JSON.stringify(filters));
  } catch {
    // storage blocked
  }
}

/** Every label on the board's cards, by name, for the column filters. */
function boardLabels(items: { labels: GhLabel[] }[]): Map<string, string> {
  const all = new Map<string, string>();
  for (const it of items) for (const l of it.labels) if (!all.has(l.name)) all.set(l.name, l.color);
  return all;
}

function labelChips(labels: GhLabel[]) {
  return labels.slice(0, 4).map(labelChip);
}

const CHECK_WORD: Record<GhPull['checks'], string> = { pass: 'Checks passed', fail: 'Checks failing', pending: 'Checks running', none: '' };

/** A chip naming a worker and desk, color-coded to match the worker back on the floor. */
function workerChip(w: WorkerInfo, title: string) {
  const chip = h('span.desk-link', { title }, `${w.name} · ${DESK_BY_ID.get(w.deskId)?.label ?? 'a desk'}`);
  chip.style.setProperty('--dot', w.color);
  return chip;
}

/** A chip naming the worker and desk a pull request came from. */
export function deskChip(w: WorkerInfo) {
  return workerChip(w, `Opened from ${w.name}'s desk (${w.worktree?.branch ?? 'its branch'})`);
}

/** Where an issue stands on the 📋 queue, for its card. */
function queueChip(issue: number): Node | '' {
  const t = store.taskForIssue(issue);
  if (!t) return '';
  if (t.status === 'queued') return h('span.qchip', { title: 'On the task queue' }, store.queue.tasks.find((x) => x.status === 'queued') === t ? 'up next' : 'queued');
  if (t.status === 'running') {
    const w = t.workerId ? store.workers.get(t.workerId) : undefined;
    if (w) return workerChip(w, `${w.name} is working on this at ${DESK_BY_ID.get(w.deskId)?.label ?? 'a desk'}`);
    return h('span.qchip.running', {}, t.workerName ?? 'a worker');
  }
  return t.pr ? h('span.qchip.done', {}, `${words().pr} ${words().ref(t.pr.number)}`) : '';
}

type Piece = Node | string;

/** The pieces of a card's meta row that are there, as nodes. */
function pieces(xs: Piece[]): Node[] {
  return xs.filter((m) => m !== '').map((m) => (typeof m === 'string' ? h('span', {}, m) : m));
}

/**
 * A board card: its number, title, a row of chips (labels, desk, queue) and an aligned meta row
 * that ends with how long ago it changed.
 */
export function card(ref: Piece, title: string, chips: Piece[], meta: Piece[], when: string, onclick: () => void, onLabels?: () => void) {
  const tags = pieces(chips);
  return h(
    'li.card',
    { tabindex: 0, onclick, onkeydown: ((e: KeyboardEvent) => e.key === 'Enter' && e.target === e.currentTarget && onclick()) as EventListener },
    h(
      'div.card-top',
      {},
      h('span.num', {}, ref),
      onLabels
        ? h(
            'button.card-labels',
            { type: 'button', title: 'Change the labels', 'aria-label': `Change the labels on ${typeof ref === 'string' ? ref : ref.textContent}`, onclick: ((e: Event) => (e.stopPropagation(), onLabels())) as EventListener },
            'Labels',
          )
        : null,
    ),
    h('div.ttl', {}, title),
    tags.length ? h('div.card-tags', {}, ...tags) : null,
    h('div.meta', {}, ...pieces(meta), when ? h('span.card-when', {}, when) : null),
  );
}

/** The +/- line counts of a pull request. */
function lineCounts(it: GhPull) {
  return h('span.gh-pm', {}, h('span.add', {}, `+${it.additions}`), ' ', h('span.del', {}, `−${it.deletions}`));
}

function checksDot(state: GhPull['checks']): Piece {
  return state === 'none' ? '' : h('span.ci-dot', { class: state, title: CHECK_WORD[state], 'aria-label': CHECK_WORD[state] });
}

/** `startTab` is the tab the issues board opens on: the one the wall board is showing. */
export function openBoard(kind: 'issues' | 'pulls', net: Net, actions: BoardActions, startTab: 'issues' | 'jira' = 'issues') {
  const body = h('div.body.board-body');
  const status = h('p.sub.board-status');
  /** On the issues board of a floor with a Jira epic: which tab is showing. */
  let tab: 'issues' | 'jira' = kind === 'issues' ? startTab : 'issues';
  const onJira = () => kind === 'issues' && tab === 'jira' && !!store.jiraBoard;
  const refresh = h('button.btn', { type: 'button', onclick: () => net.send(onJira() ? { t: 'jira.refresh' } : { t: 'gh.refresh' }) }, 'Refresh');
  const close = h('button.btn.icon.close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, '✕');
  const pulls = words().cli === 'glab' ? 'Merge requests' : 'Pull requests';
  const tabIssues = h('button.tab', { type: 'button', role: 'tab' }, 'Issues');
  const tabJira = h('button.tab', { type: 'button', role: 'tab' });
  const tabs = h('nav.tabs.board-tabs', { role: 'tablist' }, tabIssues, tabJira);
  const el = h(
    'div.modal.full.board',
    { role: 'dialog', 'aria-label': kind === 'issues' ? 'Issues board' : `${pulls} board` },
    h('header', {}, h('div.titles', {}, h('h2', {}, kind === 'issues' ? 'Issues' : pulls), status), h('div.actions', {}, refresh), close),
    tabs,
    body,
  );
  const setTab = (t: typeof tab) => {
    if (t === tab) return;
    tab = t;
    body.replaceChildren();
    render();
  };
  tabIssues.addEventListener('click', () => setTab('issues'));
  tabJira.addEventListener('click', () => setTab('jira'));

  const filters = loadFilters(kind);
  /** What each column's title box holds (column key → text), for as long as the board is open. */
  const queries: Record<string, string> = {};
  /** The column whose label picker is open, if any. */
  let picking: string | null = null;
  const setFilter = (key: string, labels: string[]) => {
    if (labels.length) filters[key] = labels;
    else delete filters[key];
    saveFilters(kind, filters);
    render();
  };

  /** Toggles for every label on the board; the column shows cards with any of the ones picked. */
  const labelPicker = <T extends GhIssue | GhPull>(col: Column<T>, all: Map<string, string>, picked: string[]) => {
    const names = [...new Set([...all.keys(), ...picked])].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const list = h('div.col-labels');
    for (const name of names) {
      const on = picked.includes(name);
      const n = col.items.filter((it) => it.labels.some((l) => l.name === name)).length;
      list.append(
        h(
          'button.label-pick',
          { type: 'button', 'aria-pressed': String(on), 'data-focus': `${col.key}:${name}`, title: `${n} in ${col.title}`, onclick: () => setFilter(col.key, on ? picked.filter((x) => x !== name) : [...picked, name]) },
          labelChip({ name, color: all.get(name) ?? '#888888' }),
          h('small', {}, String(n)),
        ),
      );
    }
    if (!names.length) list.append(h('small', {}, 'No labels on this board yet.'));
    const hint = picked.length ? 'Showing cards with any of these labels' : 'Pick labels to show only their cards';
    return h('div.col-filter', {}, list, h('div.col-filter-foot', {}, h('small', {}, hint), picked.length ? h('button.btn.sm.ghost', { type: 'button', onclick: () => setFilter(col.key, []) }, 'Clear') : null));
  };

  /** A column of cards. Type in its box to narrow it by title; click its header to filter it by label. */
  const column = <T extends GhIssue | GhPull>(col: Column<T>, all: Map<string, string>, cardOf: (it: T) => HTMLElement) => {
    const picked = filters[col.key] ?? [];
    const ul = h('ul');
    const count = h('span.col-n');
    const search = h('input.input', {
      type: 'text',
      value: queries[col.key] ?? '',
      placeholder: 'Filter by title…',
      'aria-label': `Filter ${col.title} by title`,
      'data-focus': `search:${col.key}`,
      spellcheck: 'false',
      autocomplete: 'off',
    }) as HTMLInputElement;
    const clear = h('button.col-search-clear', { type: 'button', 'aria-label': 'Clear the title filter', title: 'Clear' }, '✕');
    const section = h('section.column');
    /** Deals the cards that match both filters. Typing only redoes this column's list, so the box keeps focus. */
    const fill = () => {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      const shown = columnCards(col.items, picked, search.value, col.max);
      ul.replaceChildren(...shown.map((it) => cardOf(it)));
      if (!shown.length) ul.append(h('li.col-empty', {}, words.length ? `No titles match “${search.value.trim()}”${picked.length ? ' with those labels' : ''}` : picked.length ? 'Nothing here with those labels' : 'Nothing here'));
      count.textContent = picked.length || words.length ? `${shown.length} / ${col.items.slice(0, col.max).length}` : String(shown.length);
      clear.classList.toggle('hidden', !search.value);
      section.classList.toggle('filtered', picked.length > 0 || words.length > 0);
    };
    search.addEventListener('input', () => {
      queries[col.key] = search.value;
      ul.scrollTop = 0;
      fill();
    });
    clear.addEventListener('click', () => {
      search.value = queries[col.key] = '';
      fill();
      search.focus();
    });
    const open = picking === col.key;
    const head = h(
      'button.col-head',
      {
        type: 'button',
        'aria-expanded': String(open),
        'data-focus': col.key,
        title: picked.length ? `Only cards labeled ${picked.join(' or ')}. Click to change.` : 'Filter by label',
        onclick: () => {
          picking = open ? null : col.key;
          render();
        },
      },
      h('span.col-title', {}, col.title),
      h('span.col-count', {}, count, h('span.col-caret', { 'aria-hidden': 'true' }, open ? '▴' : '▾')),
    );
    section.append(h('h4.col-h', {}, head), h('div.col-search', {}, search, clear));
    if (open) section.append(labelPicker(col, all, picked));
    else if (picked.length) {
      section.append(
        h(
          'div.col-active',
          {},
          ...picked.map((name) => labelChip({ name, color: all.get(name) ?? '#888888' })),
          h('button.col-clear', { type: 'button', 'aria-label': 'Clear label filter', title: 'Show every card', onclick: () => setFilter(col.key, []) }, '✕'),
        ),
      );
    }
    section.append(ul);
    fill();
    return section;
  };

  const statusText = () => {
    const st = onJira() ? store.jiraBoard! : kind === 'issues' ? store.issues : store.pulls;
    status.textContent = st.loading ? 'Refreshing…' : st.fetchedAt ? `Updated ${timeAgo(st.fetchedAt)}` : '';
  };
  const render = () => {
    // Floors without a Jira epic have no tabs at all, just as before.
    const jira = kind === 'issues' ? store.jiraBoard : null;
    if (!jira && tab === 'jira') tab = 'issues';
    tabs.classList.toggle('hidden', !jira);
    tabIssues.classList.toggle('on', tab === 'issues');
    tabJira.classList.toggle('on', tab === 'jira');
    tabIssues.setAttribute('aria-selected', String(tab === 'issues'));
    tabJira.setAttribute('aria-selected', String(tab === 'jira'));
    tabIssues.textContent = `${words().site} issues`;
    tabJira.textContent = jira ? `Jira · ${jira.epic}` : 'Jira';
    refresh.title = onJira() ? 'Refresh from Jira' : `Refresh from ${words().site}`;
    statusText();
    if (onJira()) {
      const { scrollLeft } = body;
      renderJiraBoard(body, actions);
      body.scrollLeft = scrollLeft;
      return;
    }
    const st = kind === 'issues' ? store.issues : store.pulls;
    // Every refresh rebuilds the columns, so note how far each was scrolled and put it back afterwards,
    // and keep focus (and the caret, in a title box) on the header, label toggle or box it was on.
    const scrolled = [...body.querySelectorAll('.column > ul')].map((ul) => ul.scrollTop);
    const { scrollLeft, scrollTop } = body;
    const active = document.activeElement;
    const focused = active && body.contains(active) ? active.getAttribute('data-focus') : null;
    const caret = active instanceof HTMLInputElement ? ([active.selectionStart, active.selectionEnd] as const) : null;
    body.replaceChildren();
    if (st.error && !st.items.length) {
      const w = words();
      body.append(
        h(
          'div.empty-state.board-error',
          {},
          h('span.empty-icon', { 'aria-hidden': 'true' }, '⚠️'),
          h('b', {}, `Couldn't load from ${w.site}`),
          h('p', {}, st.error),
          h('p', {}, 'The server runs ', h('code', {}, w.cli), ' in the project directory. Make sure it is installed and signed in (', h('code', {}, `${w.cli} auth login`), ').'),
        ),
      );
      return;
    }
    const all = boardLabels(st.items);
    if (kind === 'issues') {
      for (const col of issueColumns(store.issues.items)) {
        body.append(
          column(col, all, (it) =>
            card(
              `#${it.number}`,
              it.title,
              [...labelChips(it.labels), queueChip(it.number)],
              [
                it.assignees.length ? h('span', { title: 'Assigned' }, `👤 ${it.assignees.join(', ')}`) : `by ${it.author}`,
                it.comments ? h('span.card-comments', { title: `${it.comments} comment${it.comments === 1 ? '' : 's'}` }, `💬 ${it.comments}`) : '',
              ],
              timeAgo(it.updatedAt),
              () => openIssue(it, net, actions),
              () => openLabels('issue', it, net),
            ),
          ),
        );
      }
    } else {
      for (const col of pullColumns(store.pulls.items)) {
        body.append(
          column(col, all, (it) => {
            const w = workerForPull(store.workers.values(), it);
            return card(
              words().ref(it.number),
              it.title,
              [w ? deskChip(w) : '', ...labelChips(it.labels), it.reviewDecision === 'CHANGES_REQUESTED' ? h('span.qchip.bad', {}, 'changes requested') : ''],
              [checksDot(it.checks), `by ${it.author}`, lineCounts(it)],
              timeAgo(it.updatedAt),
              () => openPull(it, net, actions),
              () => openLabels('pull', it, net),
            );
          }),
        );
      }
    }
    body.querySelectorAll('.column > ul').forEach((ul, i) => (ul.scrollTop = scrolled[i] ?? 0));
    body.scrollLeft = scrollLeft;
    body.scrollTop = scrollTop;
    const again = focused === null ? undefined : [...body.querySelectorAll<HTMLElement>('[data-focus]')].find((b) => b.dataset.focus === focused);
    again?.focus();
    if (caret && again instanceof HTMLInputElement) again.setSelectionRange(caret[0], caret[1]);
  };

  const unsubs = [store.on(kind, render), store.on('queue', render)];
  if (kind === 'issues') unsubs.push(store.on('jiraBoard', render));
  // Which desk a PR came from can change (a worker sent home, a PR opened from a desk).
  if (kind === 'pulls') unsubs.push(store.on('workers', render));
  const timer = setInterval(statusText, 15000);
  const modal = openModal(el, {
    doing: kind === 'issues' ? '📋 at the issues board' : `🔀 at the ${words().pr} board`,
    onClose: () => {
      unsubs.forEach((u) => u());
      clearInterval(timer);
    },
  });
  close.addEventListener('click', () => modal.close());
  render();
}
