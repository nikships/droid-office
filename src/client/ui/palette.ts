import { rankItems, type PaletteItem, type PaletteMatch } from '../../shared/palette';
import { h, openModal, type Modal } from './dom';

// The command palette (Ctrl+K, ⌘K on a Mac): a few letters find a worker, an issue, a pull request,
// a board or an action, and Enter opens it the way clicking it in the office does.
// Shift+Enter walks you over to it first. What there is to find comes from main.ts.

export interface PaletteEntry extends PaletteItem {
  icon: string;
  /** What kind of thing it is, shown on the right: "Worker", "PR", "Action". */
  kind: string;
  /** Opens it, as clicking it (or E in front of it) in the office does. */
  open(): void;
  /** Walks you over to it and then opens it; missing for things that aren't anywhere in the room. */
  walk?: () => void;
}

let current: Modal | null = null;

export function paletteOpen(): boolean {
  return !!current;
}

/** Opens the palette over `entries`, or puts it away if it's open already. */
export function togglePalette(entries: () => PaletteEntry[]) {
  if (current) return current.close();
  const all = entries();
  const input = h('input', {
    type: 'text',
    placeholder: 'Find a worker, issue, PR, board or action…',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Find anything in the office',
    role: 'combobox',
    'aria-controls': 'palette-list',
    'aria-expanded': 'true',
  });
  input.classList.add('palette-input');
  const list = h('ul.list.palette-list', { id: 'palette-list', role: 'listbox' });
  const empty = h('div.empty-state.palette-empty', {}, h('span.empty-icon', { 'aria-hidden': 'true' }, '🔎'), h('b', {}, 'Nothing here matches that'), h('p', {}, 'Try a worker’s name, an issue number or a board.'));
  const hintKey = (key: string, what: string) => h('span.palette-hint', {}, h('span.key', {}, key), what);
  const hint = h('footer', {}, h('span.grow.palette-hints', {}, hintKey('↵', 'open'), hintKey('⇧↵', 'walk there first'), hintKey('↑↓', 'choose'), hintKey('Esc', 'close')));
  const el = h('div.modal.palette', { role: 'dialog', 'aria-label': 'Command palette' }, h('div.palette-find', {}, h('span.palette-glass', { 'aria-hidden': 'true' }, '⌕'), input), list, empty, hint);

  let found: PaletteMatch<PaletteEntry>[] = [];
  /** The result rows, in `found`'s order (the list also holds the group headings). */
  let rows: HTMLElement[] = [];
  let at = 0;

  const select = (i: number) => {
    rows[at]?.classList.remove('on');
    rows[at]?.setAttribute('aria-selected', 'false');
    at = found.length ? (i + found.length) % found.length : 0;
    const row = rows[at];
    if (!row) return input.removeAttribute('aria-activedescendant');
    row.classList.add('on');
    row.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', row.id);
    row.scrollIntoView({ block: 'nearest' });
  };

  const go = (i: number, walk: boolean) => {
    const e = found[i]?.item;
    if (!e) return;
    modal.close();
    if (walk && e.walk) e.walk();
    else e.open();
  };

  const render = () => {
    found = groupByKind(rankItems(input.value, all));
    const items: HTMLElement[] = [];
    rows = found.map((m, i) => {
      const e = m.item;
      if (e.kind !== found[i - 1]?.item.kind) items.push(h('li.palette-group.eyebrow', { role: 'presentation' }, plural(e.kind)));
      const row = h(
        'li.list-row.palette-row',
        { id: `palette-${i}`, role: 'option', 'aria-selected': 'false', title: e.walk ? 'Enter opens it · Shift+Enter walks you there first' : 'Enter opens it' },
        h('span.list-icon', { 'aria-hidden': 'true' }, e.icon),
        h('span.list-main', {}, h('span.list-title', {}, ...marked(e.title, m.field === 'title' ? m.hits : [])), e.detail ? h('span.list-meta', {}, ...marked(e.detail, m.field === 'detail' ? m.hits : [])) : null),
        h('span.list-end', {}, h('span.key.palette-enter', { 'aria-hidden': 'true' }, '↵')),
      );
      row.addEventListener('mousemove', () => at !== i && select(i));
      // Before the input loses focus to it.
      row.addEventListener('mousedown', (ev) => ev.preventDefault());
      row.addEventListener('click', (ev) => go(i, ev.shiftKey));
      items.push(row);
      return row;
    });
    list.replaceChildren(...items);
    empty.classList.toggle('hidden', found.length > 0);
    list.classList.toggle('hidden', !found.length);
    select(0);
  };

  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      select(at + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      select(Math.max(0, Math.min(found.length - 1, at + (e.key === 'PageDown' ? 8 : -8))));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(at, e.shiftKey);
    }
  });

  const modal = openModal(el, { closeButton: false, onClose: () => (current = null) });
  current = modal;
  render();
  input.focus();
}

/**
 * The matches with each kind's together, the kinds in the order their best match ranks. Within a kind
 * the ranking stands, so the best match of all is still first and Enter opens it.
 */
function groupByKind<T extends PaletteEntry>(found: PaletteMatch<T>[]): PaletteMatch<T>[] {
  const kinds = new Map<string, PaletteMatch<T>[]>();
  for (const m of found) {
    const run = kinds.get(m.item.kind);
    if (run) run.push(m);
    else kinds.set(m.item.kind, [m]);
  }
  return [...kinds.values()].flat();
}

/** A kind as a group heading: "Worker" heads "Workers". */
const plural = (kind: string) => (/s$/i.test(kind) ? kind : `${kind}s`);

/** `text` with the characters at `hits` marked. */
function marked(text: string, hits: number[]): (string | HTMLElement)[] {
  if (!hits.length) return [text];
  const on = new Set(hits);
  const out: (string | HTMLElement)[] = [];
  let run = '';
  let inHit = false;
  for (let i = 0; i <= text.length; i++) {
    const hit = i < text.length && on.has(i);
    if (i === text.length || hit !== inHit) {
      if (run) out.push(inHit ? h('mark', {}, run) : run);
      run = '';
      inHit = hit;
    }
    if (i < text.length) run += text[i];
  }
  return out;
}
