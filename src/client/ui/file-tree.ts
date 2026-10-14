import { buildDocTree, compareNames, docTreeAncestors, docTreeDirPaths, docTreeRows, type DocFile, type DocGitStatus, type DocTreeDir, type DocTreeRow } from '../../shared/docs';
import { copy } from './clipboard';
import { claimEscape, h, toast } from './dom';
import { fileIcon, folderIcon, glyph, iconSvg } from './file-icons';

// The Bookshelf's project file tree (ui/bookshelf.ts), shaped after the IDE project views: folders
// first with compacted single-child chains, file-type icons, indent guides, git status colors, the
// open file highlighted and revealed, and full keyboard use (arrows, Home/End, Page keys, Enter,
// type to filter). A filter turns it into a ranked "go to file" list. Rows are virtualized, so a
// project with thousands of files scrolls as smoothly as a small one.

/** Row height in px; `.ft-row` in style.css is the same. */
export const ROW_H = 24;
/** Rows drawn above and below the visible ones. */
const OVERSCAN = 12;
/** A project at most this size opens with every folder expanded. */
const SMALL_PROJECT = 40;

/** A file that passes the filter: how well, and which letters of its title and path matched. */
export interface Hit {
  doc: DocFile;
  score: number;
  title: Set<number>;
  path: Set<number>;
}

const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Where the letters of `q` (lower case) turn up in `text`, in order: all together if they can be, else each as early as it can. */
function find(q: string, text: string): number[] | null {
  const lower = text.toLowerCase();
  const at = lower.indexOf(q);
  if (at >= 0) return Array.from(q, (_, i) => at + i);
  const out: number[] = [];
  for (let j = 0; j < lower.length && out.length < q.length; j++) if (lower[j] === q[out.length]) out.push(j);
  return out.length === q.length ? out : null;
}

/** How good a find is: together beats scattered, and the start of a word beats the middle of one. */
function rate(at: number[], text: string): number {
  let score = 0;
  for (let k = 0; k < at.length; k++) {
    const p = at[k];
    const prev = text[p - 1] ?? '';
    if (p === 0 || /[\s/_.-]/.test(prev) || (/[a-z]/.test(prev) && /[A-Z]/.test(text[p]))) score += 8;
    if (k > 0) score += at[k - 1] === p - 1 ? 5 : -Math.min(6, p - at[k - 1] - 1) * 0.5;
  }
  return score - at[0] * 0.05;
}

/** The project's own docs first (its README before the rest), then each folder's, in path order. */
export function shelfOrder(files: DocFile[]): DocFile[] {
  const rank = (p: string) => (p.includes('/') ? 2 : /^readme\./i.test(p) ? 0 : 1);
  return [...files].sort((a, b) => rank(a.path) - rank(b.path) || compareNames(a.path, b.path));
}

/** The files that match every word of `query`, best first; all of them, in shelf order, for none. */
export function filterDocs(files: DocFile[], query: string): Hit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return shelfOrder(files).map((doc) => ({ doc, score: 0, title: new Set(), path: new Set() }));
  const hits: Hit[] = [];
  for (const doc of files) {
    const name = nameOf(doc.path);
    const dir = doc.path.length - name.length;
    const hit: Hit = { doc, score: 0, title: new Set(), path: new Set() };
    let all = true;
    for (const w of words) {
      // The file's name counts most, then its title, then anywhere in its path.
      const inName = find(w, name);
      const inTitle = doc.title ? find(w, doc.title) : null;
      const inPath = inName ? null : find(w, doc.path);
      const options: [number, () => void][] = [];
      if (inName) options.push([rate(inName, name) + 20, () => inName.forEach((i) => hit.path.add(dir + i))]);
      if (inTitle) options.push([rate(inTitle, doc.title!) + 10, () => inTitle.forEach((i) => hit.title.add(i))]);
      if (inPath) options.push([rate(inPath, doc.path), () => inPath.forEach((i) => hit.path.add(i))]);
      if (!options.length) {
        all = false;
        break;
      }
      const best = options.reduce((a, b) => (b[0] > a[0] ? b : a));
      hit.score += best[0];
      best[1]();
    }
    if (all) hits.push(hit);
  }
  return hits.sort((a, b) => b.score - a.score || a.doc.path.length - b.doc.path.length || compareNames(a.doc.path, b.doc.path));
}

/** `text` with the letters at `at` marked; `offset` shifts `at` when `text` is a slice of what was matched. */
export function marked(text: string, at: ReadonlySet<number>, offset = 0): (string | HTMLElement)[] {
  if (!at.size) return [text];
  const out: (string | HTMLElement)[] = [];
  let run = '';
  let on = false;
  for (let i = 0; i <= text.length; i++) {
    const hit = at.has(i + offset);
    if (i === text.length || hit !== on) {
      if (run) out.push(on ? h('mark', {}, run) : run);
      run = '';
      on = hit;
    }
    if (i < text.length) run += text[i];
  }
  return out;
}

/** What each git status letter means, for a row's tooltip. */
export const GIT_LABEL: Record<DocGitStatus, string> = { M: 'Modified', A: 'Added', U: 'Untracked', R: 'Renamed', C: 'Conflict' };

/** One row of what the tree shows: a tree row, or a filter result. */
type ViewRow = DocTreeRow | { kind: 'hit'; hit: Hit };

export interface FileTreeOptions {
  /** Open a file (the tree does not switch on its own; the owner may ask about unsaved changes first). */
  onOpen(path: string): void;
  /** Where a file is on the forge, for "Open on GitHub" in the context menu. */
  forge?: { site: string; url(path: string): string };
  /** Where the expanded folders are remembered between visits. */
  storageKey: string;
  /** Said when nothing matches the filter, or there are no files. */
  empty(query: string): string;
}

export interface FileTree {
  /** The scrolling tree itself, to put in the sidebar. */
  readonly el: HTMLElement;
  /** Replace the files, keeping what's expanded. `key` names the set (a scope) for remembering what's expanded. */
  setFiles(files: DocFile[], key: string): void;
  setQuery(query: string): void;
  /** The file open in the reader, and whether it has unsaved changes. */
  setCurrent(path: string | null, dirty: boolean): void;
  /** Expand the folders that hold `path`, put the cursor on it and scroll it into view. */
  reveal(path: string): void;
  expandAll(): void;
  collapseAll(): void;
  /** Move the keyboard cursor (from the filter box, say). */
  moveCursor(by: number): void;
  /** Open the file under the cursor, or toggle the folder. */
  activateCursor(): void;
  focus(): void;
  /** How many files show (match the filter) and how many there are. */
  counts(): { shown: number; total: number; changed: number };
  dispose(): void;
}

function loadExpanded(storageKey: string, key: string): Set<string> | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}')[key];
    return Array.isArray(saved) ? new Set(saved.filter((x): x is string => typeof x === 'string')) : undefined;
  } catch {
    return undefined;
  }
}

function saveExpanded(storageKey: string, key: string, expanded: ReadonlySet<string>) {
  try {
    const all = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    all[key] = [...expanded];
    localStorage.setItem(storageKey, JSON.stringify(all));
  } catch {
    // Private mode, or storage is full: folders just won't stay open between visits.
  }
}

let treeIds = 0;

export function createFileTree(opts: FileTreeOptions): FileTree {
  const id = `ft${++treeIds}`;
  const canvas = h('div.ft-canvas', { role: 'presentation' });
  const emptyNote = h('div.ft-empty', { hidden: true });
  const el = h('div.ft', { role: 'tree', tabindex: 0, 'aria-label': 'Project files' }, canvas, emptyNote);

  let files: DocFile[] = [];
  let setKey = '';
  let tree: DocTreeDir = buildDocTree([]);
  let expanded = new Set<string>();
  let query = '';
  let hits: Hit[] = [];
  let rows: ViewRow[] = [];
  let cursor = 0;
  let current: string | null = null;
  let currentDirty = false;
  let frame = 0;
  let menu: { el: HTMLElement; release(): void } | null = null;

  const rowPath = (r: ViewRow | undefined) => (!r ? undefined : r.kind === 'dir' ? r.dir.path : r.kind === 'file' ? r.file.path : r.hit.doc.path);

  const persist = () => saveExpanded(opts.storageKey, setKey, expanded);

  /** Rebuild the rows from the tree or the filter, keeping the cursor on the same path when it's still there. */
  const rebuild = (keepPath = rowPath(rows[cursor])) => {
    rows = query ? hits.map((hit) => ({ kind: 'hit', hit })) : docTreeRows(tree, expanded);
    const at = keepPath === undefined ? -1 : rows.findIndex((r) => rowPath(r) === keepPath);
    cursor = at >= 0 ? at : Math.min(cursor, Math.max(0, rows.length - 1));
    canvas.style.setProperty('--rows', String(rows.length));
    emptyNote.hidden = rows.length > 0;
    emptyNote.textContent = rows.length ? '' : opts.empty(query);
    draw();
  };

  const gitMark = (status: DocGitStatus | undefined) => (status ? h('span.ft-git', { class: `git-${status}`, title: GIT_LABEL[status] }, status) : null);

  const renderRow = (r: ViewRow, i: number): HTMLElement => {
    const row = h('div.ft-row', { id: `${id}-${i}`, role: 'treeitem', 'aria-selected': String(i === cursor) });
    row.style.setProperty('--i', String(i));
    row.dataset.i = String(i);
    if (i === cursor) row.classList.add('is-cursor');
    if (r.kind === 'dir') {
      const { dir } = r;
      row.classList.add('is-dir');
      row.setAttribute('aria-expanded', String(r.expanded));
      row.setAttribute('aria-level', String(r.depth + 1));
      row.style.setProperty('--depth', String(r.depth));
      row.title = `${dir.path}/ · ${dir.count} file${dir.count === 1 ? '' : 's'}${dir.changed ? ` · ${dir.changed} changed` : ''}`;
      const chev = glyph('chevron', 'ft-chev');
      row.append(chev, iconSvg(folderIcon(dir.name), r.expanded), h('span.ft-name', {}, ...nameParts(dir.name)));
      if (dir.changed) row.append(h('span.ft-dot', { title: `${dir.changed} changed` }));
      return row;
    }
    const file = r.kind === 'file' ? r.file : r.hit.doc;
    const name = nameOf(file.path);
    row.setAttribute('aria-level', String(r.kind === 'file' ? r.depth + 1 : 1));
    if (r.kind === 'file') row.style.setProperty('--depth', String(r.depth));
    else row.classList.add('is-hit');
    if (file.path === current) row.classList.add('is-open');
    if (file.git) row.classList.add(`git-${file.git}`);
    row.title = [file.path, file.title && file.title !== name ? file.title : '', file.git ? GIT_LABEL[file.git] : ''].filter(Boolean).join(' · ');
    const nameEl = h('span.ft-name');
    if (r.kind === 'hit') {
      const dirLen = file.path.length - name.length;
      nameEl.append(...marked(name, r.hit.path, dirLen));
      row.append(iconSvg(fileIcon(file.path)), nameEl);
      if (dirLen) row.append(h('span.ft-dir', {}, ...marked(file.path.slice(0, dirLen - 1), r.hit.path)));
      else if (file.title && r.hit.title.size) row.append(h('span.ft-dir', {}, ...marked(file.title, r.hit.title)));
    } else {
      nameEl.textContent = name;
      row.append(h('span.ft-spacer'), iconSvg(fileIcon(file.path)), nameEl);
    }
    if (file.path === current && currentDirty) row.append(h('span.ft-unsaved', { title: 'Unsaved changes' }));
    row.append(gitMark(file.git) ?? '');
    return row;
  };

  /** A squashed folder chain's segments, with the slashes dimmed. */
  const nameParts = (name: string) => name.split('/').flatMap((part, i) => (i ? [h('span.ft-sep', {}, '/'), part] : [part]));

  function draw() {
    frame = 0;
    const top = el.scrollTop;
    const height = el.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(rows.length, Math.ceil((top + height) / ROW_H) + OVERSCAN);
    const out: HTMLElement[] = [];
    for (let i = first; i < last; i++) out.push(renderRow(rows[i], i));
    canvas.replaceChildren(...out);
    if (rows[cursor]) el.setAttribute('aria-activedescendant', `${id}-${cursor}`);
    else el.removeAttribute('aria-activedescendant');
  }

  const schedule = () => {
    frame ||= requestAnimationFrame(draw);
  };
  el.addEventListener('scroll', schedule, { passive: true });

  const scrollToCursor = () => {
    const top = cursor * ROW_H;
    const h0 = el.clientHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + h0) el.scrollTop = top + ROW_H - h0;
  };

  const setCursor = (i: number) => {
    if (!rows.length) return;
    cursor = Math.max(0, Math.min(rows.length - 1, i));
    scrollToCursor();
    draw();
  };

  const toggle = (dir: DocTreeDir, open = !expanded.has(dir.path), deep = false) => {
    const paths = deep ? docTreeDirPaths(dir) : [dir.path];
    for (const p of paths) {
      if (open) expanded.add(p);
      else expanded.delete(p);
    }
    persist();
    rebuild();
  };

  const activate = (i: number) => {
    const r = rows[i];
    if (!r) return;
    cursor = i;
    if (r.kind === 'dir') toggle(r.dir);
    else opts.onOpen(r.kind === 'file' ? r.file.path : r.hit.doc.path);
  };

  /** The index of the row's parent folder, walking up from `i`. */
  const parentOf = (i: number) => {
    const r = rows[i];
    if (!r || r.kind === 'hit') return -1;
    for (let j = i - 1; j >= 0; j--) {
      const p = rows[j];
      if (p.kind === 'dir' && p.depth < r.depth) return j;
    }
    return -1;
  };

  el.addEventListener('mousedown', (e) => {
    // Keep typing in the go-to box while you click its results; anywhere else, the click focuses the tree.
    if (e.button === 0 && query && document.activeElement?.tagName === 'INPUT') e.preventDefault();
  });
  el.addEventListener('click', (e) => {
    const row = (e.target as Element).closest<HTMLElement>('.ft-row');
    if (!row) return;
    const i = Number(row.dataset.i);
    const r = rows[i];
    if (r?.kind === 'dir' && e.altKey) {
      cursor = i;
      toggle(r.dir, !r.expanded, true);
      return;
    }
    activate(i);
  });
  el.addEventListener('contextmenu', (e) => {
    const row = (e.target as Element).closest<HTMLElement>('.ft-row');
    if (!row) return;
    e.preventDefault();
    cursor = Number(row.dataset.i);
    draw();
    openMenu(e.clientX, e.clientY);
  });

  el.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey) return;
    const r = rows[cursor];
    const page = Math.max(1, Math.floor(el.clientHeight / ROW_H) - 1);
    switch (e.key) {
      case 'ArrowDown':
        setCursor(cursor + 1);
        break;
      case 'ArrowUp':
        setCursor(cursor - 1);
        break;
      case 'PageDown':
        setCursor(cursor + page);
        break;
      case 'PageUp':
        setCursor(cursor - page);
        break;
      case 'Home':
        setCursor(0);
        break;
      case 'End':
        setCursor(rows.length - 1);
        break;
      case 'ArrowRight':
        if (r?.kind === 'dir' && !r.expanded) toggle(r.dir, true);
        else if (r?.kind === 'dir') setCursor(cursor + 1);
        else break;
        scrollToCursor();
        break;
      case 'ArrowLeft':
        if (r?.kind === 'dir' && r.expanded) toggle(r.dir, false);
        else {
          const p = parentOf(cursor);
          if (p >= 0) setCursor(p);
        }
        break;
      case 'Enter':
      case ' ':
        activate(cursor);
        break;
      case '*':
        if (r?.kind === 'dir') toggle(r.dir, true, true);
        break;
      case 'ContextMenu':
        openMenuAtCursor();
        break;
      case 'F10':
        if (!e.shiftKey) return;
        openMenuAtCursor();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  });

  const openMenuAtCursor = () => {
    scrollToCursor();
    draw();
    const row = canvas.querySelector<HTMLElement>('.ft-row.is-cursor');
    const box = (row ?? el).getBoundingClientRect();
    openMenu(box.left + 24, box.bottom);
  };

  const closeMenu = () => {
    if (!menu) return false;
    menu.release();
    menu.el.remove();
    menu = null;
    return true;
  };

  const copyText = (text: string, what: string) => {
    void copy(text).then((ok) => toast(ok ? `Copied ${what}` : `Couldn't copy ${what}`, ok ? 'info' : 'warn'));
  };

  function openMenu(x: number, y: number) {
    closeMenu();
    const r = rows[cursor];
    if (!r) return;
    const items: [string, (() => void) | null][] = [];
    if (r.kind === 'dir') {
      const { dir } = r;
      items.push([r.expanded ? 'Collapse' : 'Expand', () => toggle(dir)]);
      items.push(['Expand all below', () => toggle(dir, true, true)]);
      items.push(['Collapse all below', () => toggle(dir, false, true)]);
      items.push(['', null]);
      items.push(['Copy path', () => copyText(dir.path, dir.path)]);
      if (opts.forge) items.push([`Open on ${opts.forge.site} ↗`, () => window.open(opts.forge!.url(dir.path), '_blank', 'noopener,noreferrer')]);
    } else {
      const path = r.kind === 'file' ? r.file.path : r.hit.doc.path;
      items.push(['Open', () => opts.onOpen(path)]);
      if (r.kind === 'hit') items.push(['Reveal in tree', () => api.reveal(path)]);
      items.push(['', null]);
      items.push(['Copy path', () => copyText(path, path)]);
      items.push(['Copy name', () => copyText(nameOf(path), nameOf(path))]);
      if (opts.forge) items.push([`Open on ${opts.forge.site} ↗`, () => window.open(opts.forge!.url(path), '_blank', 'noopener,noreferrer')]);
    }
    const buttons: HTMLButtonElement[] = [];
    const m = h('div.ft-menu', { role: 'menu', 'aria-label': 'File actions' });
    for (const [label, run] of items) {
      if (!run) {
        m.append(h('div.ft-menu-sep', { role: 'separator' }));
        continue;
      }
      const b = h('button.ft-menu-item', { type: 'button', role: 'menuitem' }, label) as HTMLButtonElement;
      b.addEventListener('click', () => {
        closeMenu();
        el.focus();
        run();
      });
      buttons.push(b);
      m.append(b);
    }
    m.addEventListener('keydown', (e) => {
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        buttons[(at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        closeMenu();
        el.focus();
      }
      e.stopPropagation();
    });
    const host = el.closest('.modal') ?? document.body;
    host.append(m);
    const hostBox = host.getBoundingClientRect();
    const w = m.offsetWidth;
    const hh = m.offsetHeight;
    m.style.setProperty('--x', `${Math.min(x, hostBox.right - w - 8) - hostBox.left}px`);
    m.style.setProperty('--y', `${(y + hh > hostBox.bottom - 8 ? y - hh : y) - hostBox.top}px`);
    const release = claimEscape(el, () => {
      const was = closeMenu();
      if (was) el.focus();
      return was;
    });
    menu = { el: m, release };
    buttons[0]?.focus();
  }

  const onOutside = (e: MouseEvent) => {
    if (menu && !menu.el.contains(e.target as Node)) closeMenu();
  };
  document.addEventListener('mousedown', onOutside, true);
  const onResize = () => {
    closeMenu();
    schedule();
  };
  window.addEventListener('resize', onResize);
  // The tree can be filled while its tab is hidden: once it has a height, bring the cursor into view and draw.
  let hadHeight = false;
  const sized = new ResizeObserver(() => {
    const has = el.clientHeight > 0;
    if (has && !hadHeight) scrollToCursor();
    hadHeight = has;
    schedule();
  });
  sized.observe(el);

  const api: FileTree = {
    el,
    setFiles(next, key) {
      const keep = rowPath(rows[cursor]);
      files = next;
      tree = buildDocTree(files);
      if (key !== setKey) {
        setKey = key;
        expanded = loadExpanded(opts.storageKey, key) ?? new Set(files.length <= SMALL_PROJECT ? docTreeDirPaths(tree) : []);
      }
      if (current) for (const p of docTreeAncestors(tree, current)) expanded.add(p);
      hits = query ? filterDocs(files, query) : [];
      rebuild(keep);
    },
    setQuery(q) {
      const next = q.trim();
      if (next === query) return;
      query = next;
      hits = query ? filterDocs(files, query) : [];
      cursor = 0;
      if (query) el.scrollTop = 0;
      rebuild(query ? hits[0]?.doc.path : (current ?? undefined));
      if (!query) {
        scrollToCursor();
        draw();
      }
    },
    setCurrent(path, dirty) {
      const moved = path !== current;
      current = path;
      currentDirty = dirty;
      if (moved && path) api.reveal(path);
      else draw();
    },
    reveal(path) {
      if (query) {
        const at = rows.findIndex((r) => rowPath(r) === path);
        if (at >= 0) setCursor(at);
        return;
      }
      for (const p of docTreeAncestors(tree, path)) expanded.add(p);
      persist();
      rebuild(path);
      scrollToCursor();
      draw();
    },
    expandAll() {
      expanded = new Set(docTreeDirPaths(tree));
      persist();
      rebuild();
    },
    collapseAll() {
      expanded.clear();
      persist();
      rebuild();
      el.scrollTop = 0;
    },
    moveCursor(by) {
      setCursor(cursor + by);
    },
    activateCursor() {
      activate(cursor);
    },
    focus() {
      el.focus();
    },
    counts() {
      return { shown: query ? hits.length : files.length, total: files.length, changed: tree.changed };
    },
    dispose() {
      closeMenu();
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener('mousedown', onOutside, true);
      window.removeEventListener('resize', onResize);
      sized.disconnect();
    },
  };
  return api;
}
