import type { SearchResults, TerminalHit } from '../../shared/protocol';
import { SEARCH_MAX, SEARCH_MIN, searchKey } from '../../shared/search';
import { store } from '../state';
import { withToken } from '../token';
import { h, openModal } from './dom';
import { colorDot, type TerminalFind } from './terminal';

// The search window: words in every worker's terminal, including what they showed before the office
// last restarted. A terminal line opens that terminal right at it.

/** What was searched last, so the window opens where you left it. */
let lastQuery = '';

export async function search(q: string): Promise<SearchResults> {
  // The terminals searched are the workers on your floor.
  const floor = store.floor ? `&floor=${encodeURIComponent(store.floor)}` : '';
  const r = await fetch(withToken(`/api/search?q=${encodeURIComponent(q)}${floor}`), { credentials: 'same-origin' });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
  return r.json() as Promise<SearchResults>;
}

/** `text` with every match of `needle` (a searchKey) marked. */
function highlight(text: string, needle: string): (string | HTMLElement)[] {
  const flat = text.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  // Lowercasing can change a string's length (rare scripts); then just show it plain.
  if (lower.length !== flat.length) return [flat];
  const out: (string | HTMLElement)[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0 && needle; at = lower.indexOf(needle, from)) {
    out.push(flat.slice(from, at), h('mark', {}, flat.slice(at, at + needle.length)));
    from = at + needle.length;
  }
  out.push(flat.slice(from));
  return out;
}

export function openSearch(openTerminal: (workerId: string, find: TerminalFind) => void) {
  const input = h('input', {
    type: 'text',
    placeholder: 'Search every terminal…',
    maxlength: SEARCH_MAX,
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Search every terminal',
  });
  input.value = lastQuery;
  const status = h('p.search-status', { role: 'status' });
  const results = h('div.search-results');
  const close = h('button.btn.icon.close', { 'aria-label': 'Close' }, '✕');
  const el = h(
    'div.modal.lg.search',
    { role: 'dialog', 'aria-label': 'Search' },
    h('header', {}, h('div.titles', {}, h('h2', {}, 'Search'), h('p.sub', {}, "Every worker's terminal on this floor")), close),
    h('div.search-find', {}, h('span.search-icon', { 'aria-hidden': 'true' }, '🔎'), input),
    h('div.body', {}, status, results),
  );

  let found: SearchResults | null = null;
  let error = '';
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    clearTimeout(timer);
    const q = input.value;
    lastQuery = q;
    const mine = ++seq;
    if (searchKey(q).length < SEARCH_MIN) {
      found = null;
      error = '';
      return render();
    }
    status.textContent = 'Searching…';
    try {
      const r = await search(q);
      if (mine !== seq) return;
      found = r;
      error = '';
    } catch (err) {
      if (mine !== seq) return;
      error = (err as Error).message;
    }
    render();
  };

  const jump = (hit: TerminalHit, needle: string) => {
    modal.close();
    openTerminal(hit.workerId, { needle, fromEnd: hit.rows - hit.row });
  };

  const termRow = (hit: TerminalHit, needle: string) => {
    const li = h('li.list-row.search-hit.term', { tabindex: 0, role: 'button', title: 'Open the terminal at this line' }, h('code.list-main', {}, ...highlight(hit.text, needle)));
    li.addEventListener('click', () => jump(hit, needle));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        jump(hit, needle);
      }
    });
    return li;
  };

  const render = () => {
    if (error) {
      status.textContent = '';
      results.replaceChildren(h('p.note.bad', {}, `Couldn't search: ${error}`));
      return;
    }
    if (!found) {
      status.textContent = '';
      results.replaceChildren(h('div.empty-state', {}, h('div.empty-icon', {}, '🔎'), h('b', {}, 'Search every terminal'), h('p', {}, "Finds words in every worker's terminal, including what they showed before the office restarted.")));
      return;
    }
    const needle = searchKey(found.q);
    // Workers sent home since the search ran have nothing left to open.
    const byWorker = new Map<string, TerminalHit[]>();
    for (const hit of found.terminals) {
      if (!store.workers.has(hit.workerId)) continue;
      let list = byWorker.get(hit.workerId);
      if (!list) byWorker.set(hit.workerId, (list = []));
      list.push(hit);
    }
    const count = [...byWorker.values()].reduce((n, l) => n + l.length, 0);
    if (!count) {
      status.textContent = '';
      results.replaceChildren(h('div.empty-state', {}, h('div.empty-icon', {}, '🔎'), h('b', {}, `Nothing in any terminal matches “${found.q.trim()}”`), h('p', {}, 'Try fewer or different words.')));
      return;
    }
    status.textContent = `${count} ${count === 1 ? 'line' : 'lines'}, newest first${found.more ? ' (only the newest are shown; add words to narrow it down)' : ''}.`;
    const groups: HTMLElement[] = [];
    for (const [workerId, hits] of byWorker) {
      const w = store.workers.get(workerId)!;
      groups.push(
        h(
          'section.section.search-group',
          {},
          h('div.eyebrow.search-group-head', {}, colorDot(w.color), h('span', {}, w.name), w.worktree ? h('span.search-branch', { title: w.worktree.branch }, `🌿 ${w.worktree.branch}`) : null),
          h('ul.list.boxed', {}, ...hits.map((hit) => termRow(hit, needle))),
        ),
      );
    }
    results.replaceChildren(...groups);
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), 200);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void run();
    } else if (e.key === 'ArrowDown') {
      // Down from the box steps into the terminal lines, which Enter opens.
      const first = results.querySelector<HTMLElement>('.search-hit.term');
      if (first) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  results.addEventListener('keydown', (e) => {
    const at = (e.target as HTMLElement).closest<HTMLElement>('.search-hit.term');
    if (!at || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const all = [...results.querySelectorAll<HTMLElement>('.search-hit.term')];
    const next = all[all.indexOf(at) + (e.key === 'ArrowDown' ? 1 : -1)];
    (next ?? (e.key === 'ArrowUp' ? input : at)).focus();
  });

  const modal = openModal(el, { doing: '🔎 searching the office', onClose: () => clearTimeout(timer) });
  close.addEventListener('click', () => modal.close());
  render();
  void run();
  // Right away, so the first keys typed after / land in the box.
  input.focus();
  input.select();
}
