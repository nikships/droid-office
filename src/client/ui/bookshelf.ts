import { buildDocTree, flattenDocTree, isDocPath, isEditablePath, resolveDocLink, type DocFile, type DocList, type DocSaveResult, type DocSearchHit, type DocSearchResults, type DocText, type DocTreeDir } from '../../shared/docs';
import { withToken } from '../token';
import { claimEscape, clip, h, openModal, setDoing, timeAgo, toast } from './dom';
import type { CodeEditor, CodeEditorCursor } from './editor';
import { mountWikiTab, type WikiTab } from './factory-wiki';
import { emptyState, windowHeader } from './kit';
import { markdownFile } from './markdown';

// The bookshelf: every Markdown doc and editable text file in the floor's project, to read, search
// and edit without leaving the office. Filter by name/title, browse the collapsible folder tree, or
// grep across file contents; read Markdown rendered like GitHub, or switch to Edit / Split mode to
// edit with CodeMirror 6 syntax highlighting and save straight to disk (⌘S / Ctrl+S). While it's
// open your character holds an open book. Its AutoWiki tab reads the Factory wiki (ui/factory-wiki.ts).

const LAST_KEY = 'droid-office.bookshelf';

export interface ShelfDeps {
  /** The floor whose project it is, and the project's name. */
  floor: string;
  project?: string;
  /** Where the project's files are on its forge (…/blob/HEAD on GitHub, …/-/blob/HEAD on GitLab) and the forge's name, for links to files on the forge. */
  blob?: { url: string; site: string };
  /** You turned a page (opened a doc, saved, or scrolled a screenful): the book in your hands turns one too. */
  onTurn(): void;
  /** Which tab it opens on: the project's docs (the default) or its AutoWiki. */
  tab?: ShelfTab;
  /** ⚙️ Settings → Factory, for connecting the office from the AutoWiki tab. */
  openFactorySettings?: () => void;
}

export type ShelfTab = 'docs' | 'wiki';
export type DocViewMode = 'preview' | 'edit' | 'split';
type ShelfScope = 'docs' | 'all';
type SidebarLayout = 'list' | 'tree' | 'grep';

/** A doc that passes the filter: how well, and which letters of its title and path matched. */
interface Hit {
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

/** The docs that match every word of `query`, best first; all of them, in shelf order, for none. */
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
  return hits.sort((a, b) => b.score - a.score || a.doc.path.length - b.doc.path.length || a.doc.path.localeCompare(b.doc.path));
}

/** The project's own docs first (its README before the rest), then each folder's, in path order. */
function shelfOrder(files: DocFile[]): DocFile[] {
  const rank = (p: string) => (p.includes('/') ? 2 : /^readme\./i.test(p) ? 0 : 1);
  return [...files].sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
}

/** `text` with the letters at `at` marked. */
function marked(text: string, at: Set<number>): (string | HTMLElement)[] {
  if (!at.size) return [text];
  const out: (string | HTMLElement)[] = [];
  let run = '';
  let on = false;
  for (let i = 0; i <= text.length; i++) {
    const hit = at.has(i);
    if (i === text.length || hit !== on) {
      if (run) out.push(on ? h('mark', {}, run) : run);
      run = '';
      on = hit;
    }
    if (i < text.length) run += text[i];
  }
  return out;
}

/** Highlights every case-insensitive occurrence of `needle` inside `text`. */
function markSubstring(text: string, needle: string): (string | HTMLElement)[] {
  const q = needle.trim().toLowerCase();
  if (!q) return [text];
  const at = new Set<number>();
  const lower = text.toLowerCase();
  let pos = 0;
  while (pos < lower.length) {
    const idx = lower.indexOf(q, pos);
    if (idx < 0) break;
    for (let k = 0; k < q.length; k++) at.add(idx + k);
    pos = idx + q.length;
  }
  return marked(text, at);
}

/** A heading's anchor, as GitHub makes them: lower case, punctuation dropped, spaces to dashes. */
export function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

function lastRead(floor: string): string | undefined {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}')[floor];
  } catch {
    return undefined;
  }
}

function rememberRead(floor: string, path: string) {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}');
    all[floor] = path;
    localStorage.setItem(LAST_KEY, JSON.stringify(all));
  } catch {
    // Private mode, or storage is full: it just won't reopen where you were.
  }
}

/** Gives a rendered page's headings their anchors (GitHub's, numbered when repeated) and fills the contents menu with them. */
export function anchorHeadings(body: HTMLElement, toc: HTMLSelectElement) {
  const seen = new Map<string, number>();
  const heads: { level: number; text: string; anchor: string }[] = [];
  for (const hd of body.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) {
    const base = slug(hd.textContent ?? '');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const anchor = n ? `${base}-${n}` : base;
    hd.dataset.anchor = anchor;
    const level = Number(hd.tagName[1]);
    if (level <= 3 && hd.textContent?.trim()) heads.push({ level, text: hd.textContent.trim(), anchor });
  }
  toc.replaceChildren(h('option', { value: '' }, '☰ Contents'), ...heads.map((x) => h('option', { value: x.anchor }, `${' '.repeat(x.level - 1)}${clip(x.text, 60)}`)));
  toc.hidden = heads.length < 3;
}

/** Scrolls `page` to the heading (or named anchor) `hash` names, or to the top for none. */
export function jumpTo(page: HTMLElement, hash: string) {
  if (!hash) return page.scrollTo({ top: 0 });
  let id = hash;
  try {
    id = decodeURIComponent(hash);
  } catch {
    // Not encoded after all.
  }
  id = id.replace(/^user-content-/, '');
  const esc = CSS.escape(id);
  const at = page.querySelector(`[data-anchor="${esc}"]`) ?? page.querySelector(`[data-anchor="${CSS.escape(id.toLowerCase())}"]`) ?? page.querySelector(`[id="${esc}"], [name="${esc}"]`);
  at?.scrollIntoView({ block: 'start' });
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(withToken(url), { credentials: 'same-origin' });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

class SaveConflictError extends Error {
  constructor(
    message: string,
    readonly mtime?: number,
  ) {
    super(message);
  }
}

async function putFileJson(url: string, body: { path: string; text: string; baseMtime?: number }): Promise<DocSaveResult> {
  const r = await fetch(withToken(url), {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const payload = (await r.json().catch(() => null)) as { error?: string; mtime?: number } | null;
    const msg = payload?.error ?? `HTTP ${r.status}`;
    if (r.status === 409) throw new SaveConflictError(msg, payload?.mtime);
    throw new Error(msg);
  }
  return r.json() as Promise<DocSaveResult>;
}

function parseLineHash(hash: string): number | undefined {
  const m = /^L(\d+)/i.exec(hash.trim());
  return m ? Number(m[1]) : undefined;
}

export function openBookshelf(deps: ShelfDeps) {
  const { floor, blob } = deps;
  const blobUrl = (path: string, hash = '') => `${blob?.url}/${path.split('/').map(encodeURIComponent).join('/')}${hash ? `#${hash}` : ''}`;
  const q = (params: Record<string, string>) => new URLSearchParams({ floor, ...params }).toString();
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const modKey = isMac ? '⌘' : 'Ctrl+';

  // Start warming the CodeMirror chunk in the background so switching to Edit/Split is instant.
  const editorModulePromise = import('./editor');

  // Sidebar controls: scope (Docs vs All files) and layout (List vs Tree vs Grep).
  let scope: ShelfScope = 'docs';
  let layout: SidebarLayout = 'list';
  const scopeDocsBtn = h('button.btn.sm.on', { type: 'button', role: 'radio', 'aria-checked': 'true', 'data-scope': 'docs' }, 'Docs') as HTMLButtonElement;
  const scopeAllBtn = h('button.btn.sm', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-scope': 'all' }, 'All files') as HTMLButtonElement;
  const scopeGroup = h('div.seg.bs-scope', { role: 'radiogroup', 'aria-label': 'File scope' }, scopeDocsBtn, scopeAllBtn);

  const layoutListBtn = h('button.btn.sm.on', { type: 'button', role: 'radio', 'aria-checked': 'true', 'data-layout': 'list', title: 'Flat ranked list' }, 'List') as HTMLButtonElement;
  const layoutTreeBtn = h('button.btn.sm', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-layout': 'tree', title: 'Collapsible folder tree' }, 'Tree') as HTMLButtonElement;
  const layoutGrepBtn = h('button.btn.sm', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-layout': 'grep', title: 'Search inside files' }, 'Search') as HTMLButtonElement;
  const layoutGroup = h('div.seg.bs-layout', { role: 'radiogroup', 'aria-label': 'Sidebar view' }, layoutListBtn, layoutTreeBtn, layoutGrepBtn);

  const filter = h('input.input', { type: 'text', placeholder: 'Filter the docs…', 'aria-label': 'Filter the docs', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const count = h('div.bs-count', {}, 'Looking along the shelves…');
  const list = h('ul.list.bs-list', { role: 'listbox', 'aria-label': 'Docs' });

  // Reader / Editor bar controls.
  const crumbs = h('div.bs-crumbs');
  const modePreviewBtn = h('button.btn.sm.on', { type: 'button', role: 'radio', 'aria-checked': 'true', 'data-mode': 'preview', title: 'Rendered Markdown preview' }, 'Preview') as HTMLButtonElement;
  const modeEditBtn = h('button.btn.sm', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-mode': 'edit', title: `Edit file (${modKey}E)` }, 'Edit') as HTMLButtonElement;
  const modeSplitBtn = h('button.btn.sm', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-mode': 'split', title: 'Side-by-side editor and live preview' }, 'Split') as HTMLButtonElement;
  const modeGroup = h('div.seg.bs-mode', { role: 'radiogroup', 'aria-label': 'View mode', hidden: true }, modePreviewBtn, modeEditBtn, modeSplitBtn);

  const findBtn = h('button.btn.sm.ghost.bs-find-btn', { type: 'button', title: `Find & replace in file (${modKey}F)`, hidden: true }, 'Find') as HTMLButtonElement;
  const discardBtn = h('button.btn.sm.ghost.bs-discard-btn', { type: 'button', title: 'Revert unsaved changes', hidden: true }, 'Discard') as HTMLButtonElement;
  const saveBtn = h('button.btn.sm.accent.bs-save-btn', { type: 'button', title: `Save to disk (${modKey}S)`, disabled: true, hidden: true }, 'Save ', h('span.key', {}, `${modKey}S`)) as HTMLButtonElement;

  const meta = h('div.bs-meta');
  const toc = h('select.select.sm.bs-toc', { 'aria-label': 'Jump to a heading', title: 'Jump to a heading', hidden: true }) as HTMLSelectElement;

  // Conflict banner (shown when disk mtime changed while editing).
  const conflictReloadBtn = h('button.btn.sm', { type: 'button' }, 'Reload from disk') as HTMLButtonElement;
  const conflictForceBtn = h('button.btn.sm.accent', { type: 'button' }, 'Overwrite disk') as HTMLButtonElement;
  const conflictMsg = h('span.bs-conflict-text', {}, 'This file changed on disk since you opened it.');
  const conflictBar = h('div.note.warn.bs-conflict', { hidden: true }, conflictMsg, h('div.bs-conflict-actions', {}, conflictReloadBtn, conflictForceBtn));

  // Workspace: holds the CodeMirror editor pane and the Markdown preview pane.
  const editorPane = h('div.bs-editor-pane', { hidden: true });
  const page = h('div.bs-page', { tabindex: -1 });
  const work = h('div.bs-work', {}, editorPane, page);

  // Editor status bar at the bottom of the reader pane.
  const statusLang = h('span.pill.bs-lang', {}, 'Markdown');
  const statusInfo = h('span.bs-status-info');
  const statusForge = h('span.bs-status-forge');
  const statusCursor = h('span.bs-status-cursor', {}, 'Ln 1, Col 1');
  const statusBar = h('div.bs-status', { hidden: true }, h('div.bs-status-left', {}, statusLang, statusInfo, statusForge), h('div.bs-status-right', {}, statusCursor));

  const tabButton = (tab: ShelfTab, label: string) => h('button.tab', { type: 'button', role: 'tab', 'data-tab': tab, 'aria-selected': 'false' }, label) as HTMLButtonElement;
  const tabs = { docs: tabButton('docs', 'Docs'), wiki: tabButton('wiki', 'AutoWiki') };
  const closeBtn = h('button.btn.close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, '✕') as HTMLButtonElement;
  const header = windowHeader(
    'Bookshelf',
    deps.project ? `The docs & files in ${deps.project}, and its AutoWiki` : 'The project’s docs & files, and its AutoWiki',
    h('div.tabs.bs-tabs', { role: 'tablist', 'aria-label': 'What to read' }, tabs.docs, tabs.wiki),
  );
  header.append(closeBtn);

  const docsBody = h(
    'div.body.flush.split.bs-split',
    { role: 'tabpanel' },
    h('aside.bs-side', {}, h('div.bs-side-bar', {}, scopeGroup, layoutGroup), h('div.bs-find', {}, filter), count, list),
    h('article.bs-reader.flush', {}, h('div.bs-bar', {}, crumbs, modeGroup, findBtn, discardBtn, saveBtn, meta, toc), conflictBar, work, statusBar),
  );
  const wikiBody = h('div.body.flush.bs-wiki', { role: 'tabpanel', hidden: true });
  const el = h('div.modal.full.bookshelf', { role: 'dialog', 'aria-label': 'Bookshelf' }, header, docsBody, wikiBody);
  page.append(h('div.bs-loading', {}, h('span.spinner')));

  let allFiles: DocFile[] = [];
  let files: DocFile[] = [];
  let moreFiles = false;
  let shown: Hit[] = [];
  const collapsedDirs = new Set<string>();
  /** Which of `shown` ↑ ↓ are on. */
  let sel = 0;
  /** The file open now, and each open's number, so a slow one that's been overtaken is dropped. */
  let current: string | null = null;
  let currentMtime: number | undefined;
  let loadedText = '';
  let dirty = false;
  let saving = false;
  let viewMode: DocViewMode = 'preview';
  let preferredMdMode: DocViewMode = 'preview';
  let editor: CodeEditor | null = null;
  let splitPreviewTimer: ReturnType<typeof setTimeout> | null = null;
  let grepTimer: ReturnType<typeof setTimeout> | null = null;
  let grepSeq = 0;
  let grepResults: DocSearchResults | null = null;
  let grepLoading = false;
  let opening = 0;
  /** Where the page was last time it turned (see the scroll listener). */
  let turnedAt = 0;

  let wiki: WikiTab | undefined;
  let shownTab: ShelfTab = 'docs';
  /** What the docs tab last said you were doing, to say again when you come back to it. */
  let docsDoing = '📚 at the bookshelf';

  const confirmUnsaved = (actionLabel: string, onProceed: () => void) => {
    if (!dirty || !current) return onProceed();
    const fileLabel = nameOf(current);
    const keepBtn = h('button.btn.ghost', { type: 'button' }, 'Keep editing');
    const dropBtn = h('button.btn.danger', { type: 'button' }, 'Discard changes');
    const saveAndGoBtn = h('button.btn.accent', { type: 'button' }, `Save & ${actionLabel}`);
    const dialogEl = h(
      'div.modal.sm',
      { role: 'alertdialog', 'aria-label': `Unsaved changes in ${fileLabel}` },
      windowHeader('Unsaved changes', current),
      h('div.body.stack', {}, h('p', {}, `You have unsaved edits in ${fileLabel}. Save them to disk before leaving?`)),
      h('footer', {}, dropBtn, h('span.grow'), keepBtn, saveAndGoBtn),
    );
    const subModal = openModal(dialogEl);
    keepBtn.addEventListener('click', () => {
      subModal.close();
      editor?.focus();
    });
    dropBtn.addEventListener('click', () => {
      subModal.close();
      editor?.discard();
      setDirtyState(false);
      onProceed();
    });
    saveAndGoBtn.addEventListener('click', () => {
      saveAndGoBtn.disabled = true;
      void saveCurrentFile(false).then((ok) => {
        subModal.close();
        if (ok) onProceed();
      });
    });
    setTimeout(() => saveAndGoBtn.focus(), 20);
  };

  const tryCloseModal = () => {
    if (shownTab === 'docs' && dirty && current) {
      confirmUnsaved('close', () => modal.close());
      return;
    }
    modal.close();
  };

  closeBtn.addEventListener('click', tryCloseModal);

  const modal = openModal(el, {
    doing: docsDoing,
    reading: true,
    backdropCloses: false,
    escCloses: () => {
      tryCloseModal();
      return false;
    },
    onClose: () => {
      releaseEscape();
      if (splitPreviewTimer) clearTimeout(splitPreviewTimer);
      if (grepTimer) clearTimeout(grepTimer);
      editor?.destroy();
      editor = null;
      wiki?.dispose();
    },
  });

  // Let CodeMirror's search panel claim Escape first before closing the Bookshelf window.
  const releaseEscape = claimEscape(el, () => (editor ? editor.closeSearch() : false));

  modal.backdrop.addEventListener('mousedown', (e) => {
    if (e.target === modal.backdrop) tryCloseModal();
  });

  const updateDoing = () => {
    if (!current) {
      docsDoing = '📚 at the bookshelf';
    } else {
      const info = allFiles.find((f) => f.path === current);
      const label = info?.title ?? nameOf(current);
      docsDoing = viewMode === 'preview' ? `📚 reading ${label}` : `✏️ editing ${nameOf(current)}`;
    }
    if (shownTab === 'docs') setDoing(modal, docsDoing);
  };

  const updateCrumbs = () => {
    if (!current) {
      crumbs.replaceChildren();
      crumbs.title = '';
      return;
    }
    const dir = current.slice(0, current.length - nameOf(current).length);
    crumbs.replaceChildren(dir ? h('span.dir', {}, dir) : '', h('span.bs-crumb-name', {}, nameOf(current)), dirty ? h('span.bs-dirty-pill', { title: 'Unsaved changes in editor' }, '● Modified') : '');
    crumbs.title = current;
  };

  const updateStatusAndMeta = () => {
    if (!current) return;
    const info = allFiles.find((f) => f.path === current);
    const activeText = editor ? editor.getText() : loadedText;
    const byteLen = new TextEncoder().encode(activeText).length;
    const words = activeText.split(/\s+/).filter(Boolean).length;
    meta.replaceChildren(
      [isDocPath(current) ? `${Math.max(1, Math.round(words / 220))} min read` : '', size(info && !dirty ? info.size : byteLen), info ? `updated ${timeAgo(info.mtime)}` : ''].filter(Boolean).join(' · '),
      blob ? h('a', { href: blobUrl(current), target: '_blank', rel: 'noopener noreferrer', title: `Open it on ${blob.site}` }, `${blob.site} ↗`) : '',
    );
    if (editor) statusLang.textContent = editor.languageName();
    statusInfo.textContent = [size(byteLen), saving ? 'Saving…' : dirty ? '● Unsaved changes' : info ? `Saved · updated ${timeAgo(info.mtime)}` : 'Saved'].join(' · ');
    statusInfo.classList.toggle('dirty', dirty);
    statusForge.replaceChildren(blob ? h('a', { href: blobUrl(current), target: '_blank', rel: 'noopener noreferrer', title: `Open it on ${blob.site}` }, `${blob.site} ↗`) : '');
  };

  const updateToolbar = () => {
    const hasFile = Boolean(current);
    const isMd = Boolean(current && isDocPath(current));
    modeGroup.hidden = !hasFile;
    modePreviewBtn.hidden = !isMd;
    modeSplitBtn.hidden = !isMd;
    for (const [m, btn] of [
      ['preview', modePreviewBtn],
      ['edit', modeEditBtn],
      ['split', modeSplitBtn],
    ] as const) {
      const on = viewMode === m;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-checked', String(on));
    }
    const inEditor = hasFile && (viewMode === 'edit' || viewMode === 'split');
    findBtn.hidden = !inEditor;
    discardBtn.hidden = !dirty;
    saveBtn.hidden = !inEditor && !dirty;
    saveBtn.disabled = !dirty || saving;
    saveBtn.replaceChildren(saving ? 'Saving…' : 'Save ', saving ? '' : h('span.key', {}, `${modKey}S`));
    meta.hidden = inEditor;
    statusBar.hidden = !inEditor;
    if (!isMd || viewMode === 'edit') toc.hidden = true;
    updateCrumbs();
    updateStatusAndMeta();
    updateDoing();
  };

  const setDirtyState = (nextDirty: boolean) => {
    const changed = dirty !== nextDirty;
    dirty = nextDirty;
    updateToolbar();
    if (changed) renderSidebar();
  };

  const renderMarkdownIntoPage = (text: string, path: string, preserveScroll = false) => {
    const prevTop = page.scrollTop;
    const body = text.trim() ? markdownFile(text) : h('div.md', {}, h('p.none', {}, 'This file is empty.'));
    wire(body, path);
    if (viewMode === 'edit' || !isDocPath(path)) toc.hidden = true;
    page.replaceChildren(body);
    if (preserveScroll) page.scrollTop = prevTop;
  };

  const ensureEditor = async (path: string, text: string): Promise<CodeEditor> => {
    if (editor) return editor;
    const mod = await editorModulePromise;
    if (editor) return editor;
    editor = mod.createCodeEditor({
      parent: editorPane,
      path,
      text,
      onChange: (newText, isNowDirty) => {
        setDirtyState(isNowDirty);
        if (viewMode === 'split' && current && isDocPath(current)) {
          if (splitPreviewTimer) clearTimeout(splitPreviewTimer);
          splitPreviewTimer = setTimeout(() => {
            if (current && isDocPath(current)) renderMarkdownIntoPage(newText, current, true);
          }, 90);
        }
      },
      onSave: () => {
        void saveCurrentFile(false);
      },
      onCursor: (c: CodeEditorCursor) => {
        const selPart = c.selected > 0 ? ` (${c.selected} selected)` : '';
        statusCursor.textContent = `Ln ${c.line}, Col ${c.col}${selPart} · ${c.lines} line${c.lines === 1 ? '' : 's'}`;
      },
      onScroll: () => {
        const scroller = editor?.view.scrollDOM;
        if (!scroller) return;
        if (Math.abs(scroller.scrollTop - turnedAt) < scroller.clientHeight * 0.8) return;
        turnedAt = scroller.scrollTop;
        deps.onTurn();
      },
    });
    return editor;
  };

  const setViewMode = async (mode: DocViewMode, focusEditor = true) => {
    if (!current) return;
    const isMd = isDocPath(current);
    const targetMode: DocViewMode = isMd ? mode : 'edit';
    if (isMd) preferredMdMode = targetMode;
    viewMode = targetMode;

    editorPane.hidden = targetMode === 'preview';
    page.hidden = targetMode === 'edit';
    work.classList.toggle('is-split', targetMode === 'split');

    if (targetMode === 'preview') {
      const textToRender = editor ? editor.getText() : loadedText;
      renderMarkdownIntoPage(textToRender, current, true);
      updateToolbar();
      return;
    }

    const ed = await ensureEditor(current, loadedText);
    if (!el.isConnected || !current) return;
    if (targetMode === 'split' && isMd) {
      renderMarkdownIntoPage(ed.getText(), current, true);
    }
    updateToolbar();
    if (focusEditor) ed.focus();
  };

  const saveCurrentFile = async (forceOverwrite: boolean): Promise<boolean> => {
    if (!current || !editor || saving) return false;
    if (!dirty && !forceOverwrite) return true;
    const savingPath = current;
    const textToSave = editor.getText();
    saving = true;
    conflictBar.hidden = true;
    updateToolbar();
    try {
      const res = await putFileJson(`/api/docs/file?${q({})}`, {
        path: savingPath,
        text: textToSave,
        ...(forceOverwrite || currentMtime === undefined ? {} : { baseMtime: currentMtime }),
      });
      if (!el.isConnected) return false;
      loadedText = textToSave;
      currentMtime = res.mtime;
      const existing = allFiles.find((f) => f.path === savingPath);
      if (existing) {
        existing.size = res.size;
        existing.mtime = res.mtime;
        if (res.title !== undefined) existing.title = res.title;
        else delete existing.title;
      }
      if (current === savingPath) {
        editor.setSavedText(textToSave);
        if (isDocPath(savingPath) && viewMode !== 'edit') {
          renderMarkdownIntoPage(textToSave, savingPath, true);
        }
      }
      saving = false;
      setDirtyState(false);
      renderSidebar();
      toast(`Saved ${nameOf(savingPath)}`, 'info');
      deps.onTurn();
      return true;
    } catch (err) {
      if (!el.isConnected) return false;
      saving = false;
      if (err instanceof SaveConflictError) {
        conflictMsg.textContent = `${nameOf(savingPath)} changed on disk since you opened it.`;
        conflictBar.hidden = false;
      } else {
        toast(`Couldn't save ${nameOf(savingPath)}: ${(err as Error).message}`, 'error');
      }
      updateToolbar();
      return false;
    }
  };

  conflictReloadBtn.addEventListener('click', () => {
    if (!current) return;
    conflictBar.hidden = true;
    setDirtyState(false);
    const reloadPath = current;
    current = null;
    void openDoc(reloadPath);
  });

  conflictForceBtn.addEventListener('click', () => {
    void saveCurrentFile(true);
  });

  modePreviewBtn.addEventListener('click', () => void setViewMode('preview'));
  modeEditBtn.addEventListener('click', () => void setViewMode('edit'));
  modeSplitBtn.addEventListener('click', () => void setViewMode('split'));
  findBtn.addEventListener('click', () => {
    editor?.openSearch();
  });
  discardBtn.addEventListener('click', () => {
    if (!editor || !current) return;
    conflictBar.hidden = true;
    editor.discard();
    if (isDocPath(current) && viewMode !== 'edit') {
      renderMarkdownIntoPage(loadedText, current, true);
    }
    setDirtyState(false);
    toast(`Reverted changes in ${nameOf(current)}`, 'info');
  });
  saveBtn.addEventListener('click', () => {
    void saveCurrentFile(false);
  });

  const showTab = (tab: ShelfTab) => {
    shownTab = tab;
    docsBody.hidden = tab !== 'docs';
    wikiBody.hidden = tab !== 'wiki';
    for (const [k, b] of Object.entries(tabs)) b.setAttribute('aria-selected', String(k === tab));
    if (tab === 'wiki') {
      wiki ??= mountWikiTab(wikiBody, {
        floor,
        onTurn: deps.onTurn,
        openSettings: deps.openFactorySettings,
        setDoing: (text) => {
          if (shownTab === 'wiki') setDoing(modal, text);
        },
      });
      wiki.shown();
    } else setDoing(modal, docsDoing);
  };
  tabs.docs.addEventListener('click', () => {
    showTab('docs');
    filter.focus();
  });
  tabs.wiki.addEventListener('click', () => showTab('wiki'));

  const renderFileRow = (hit: Hit, i: number, depth = 0, inTree = false): HTMLLIElement => {
    const { doc } = hit;
    const isMd = isDocPath(doc.path);
    const title = isMd && doc.title ? doc.title : nameOf(doc.path);
    const isFileDirty = dirty && doc.path === current;
    const titleStart = doc.path.length - nameOf(doc.path).length;
    const nameMarks = new Set([...hit.path].map((p) => p - titleStart).filter((p) => p >= 0));
    const li = h(
      'li.list-row.bs-item',
      {
        role: 'option',
        'aria-selected': String(i === sel),
        class: [doc.path === current ? 'on' : '', inTree ? 'bs-tree-file' : ''].filter(Boolean).join(' '),
        title: doc.path,
      },
      h(
        'div.list-main',
        {},
        h('div.list-title', {}, ...(isMd && doc.title ? marked(title, hit.title) : marked(title, nameMarks)), isFileDirty ? h('span.bs-dirty-dot', { title: 'Unsaved changes' }, ' ●') : null),
        inTree && (!isMd || !doc.title) ? null : h('div.list-meta.bs-path', {}, ...marked(doc.path, hit.path)),
      ),
    ) as HTMLLIElement;
    if (inTree) li.style.setProperty('--depth', String(depth));
    li.addEventListener('mousedown', (e) => e.preventDefault());
    li.addEventListener('click', () => {
      sel = i;
      requestOpenDoc(doc.path);
    });
    return li;
  };

  const renderTreeNodes = (dir: DocTreeDir, depth: number, hitByPath: Map<string, Hit>, indexByPath: Map<string, number>, forceExpand: boolean): HTMLLIElement[] => {
    const rows: HTMLLIElement[] = [];
    for (const sub of dir.dirs) {
      const isCollapsed = !forceExpand && collapsedDirs.has(sub.path);
      const folderRow = h(
        'li.list-row.bs-folder',
        {
          role: 'treeitem',
          'aria-expanded': String(!isCollapsed),
          title: sub.path,
        },
        h('span.bs-chev', {}, isCollapsed ? '▸' : '▾'),
        h('span.bs-folder-name', {}, sub.name),
        h('span.bs-folder-count', {}, String(sub.count)),
      ) as HTMLLIElement;
      folderRow.style.setProperty('--depth', String(depth));
      folderRow.addEventListener('mousedown', (e) => e.preventDefault());
      folderRow.addEventListener('click', () => {
        if (collapsedDirs.has(sub.path)) collapsedDirs.delete(sub.path);
        else collapsedDirs.add(sub.path);
        renderSidebar();
      });
      rows.push(folderRow);
      if (!isCollapsed) {
        rows.push(...renderTreeNodes(sub, depth + 1, hitByPath, indexByPath, forceExpand));
      }
    }
    for (const f of dir.files) {
      const hit = hitByPath.get(f.path) ?? { doc: f, score: 0, title: new Set(), path: new Set() };
      const idx = indexByPath.get(f.path) ?? -1;
      rows.push(renderFileRow(hit, idx, depth, true));
    }
    return rows;
  };

  const renderGrepResults = () => {
    const queryText = filter.value.trim();
    if (!queryText) {
      count.textContent = `Type above to search inside ${scope === 'docs' ? 'docs' : 'all project files'}`;
      list.replaceChildren(h('li.bs-none', {}, 'Enter a word or phrase to search file contents.'));
      return;
    }
    if (grepLoading) {
      count.textContent = 'Searching files…';
      return;
    }
    const hits: DocSearchHit[] = grepResults?.hits ?? [];
    const totalMatches = hits.reduce((sum, x) => sum + x.matches.length, 0);
    count.textContent = hits.length ? `${totalMatches} match${totalMatches === 1 ? '' : 'es'} in ${hits.length}${grepResults?.more ? '+' : ''} file${hits.length === 1 ? '' : 's'}` : '0 matches';
    if (!hits.length) {
      list.replaceChildren(h('li.bs-none', {}, 'No matching lines found.'));
      return;
    }
    const items: HTMLLIElement[] = [];
    for (const hit of hits) {
      const fileHeader = h(
        'li.list-row.bs-grep-file',
        { class: hit.path === current ? 'on' : '', title: hit.path },
        h('div.list-main', {}, h('div.list-title', {}, hit.title ?? nameOf(hit.path)), h('div.list-meta.bs-path', {}, hit.path)),
      ) as HTMLLIElement;
      fileHeader.addEventListener('click', () => requestOpenDoc(hit.path));
      items.push(fileHeader);
      for (const m of hit.matches) {
        const lineRow = h('li.list-row.bs-grep-line', { title: `${hit.path}:${m.line}` }, h('span.bs-grep-ln', {}, `:${m.line}`), h('span.bs-grep-text', {}, ...markSubstring(m.text, queryText))) as HTMLLIElement;
        lineRow.addEventListener('click', () => requestOpenDoc(hit.path, `L${m.line}`));
        items.push(lineRow);
      }
    }
    list.replaceChildren(...items);
  };

  const renderSidebar = () => {
    if (layout === 'grep') {
      renderGrepResults();
      return;
    }
    const noun = scope === 'docs' ? 'doc' : 'file';
    const hasQuery = Boolean(filter.value.trim());
    if (!files.length) {
      count.textContent = '';
    } else if (hasQuery) {
      count.textContent = `${shown.length} of ${files.length} ${noun}s`;
    } else {
      count.textContent = `${files.length} ${noun}${files.length === 1 ? '' : 's'}${moreFiles ? ` (the first ${files.length})` : ''}`;
    }

    if (layout === 'tree') {
      const tree = buildDocTree(shown.map((x) => x.doc));
      const visibleFiles = flattenDocTree(tree, hasQuery ? new Set() : collapsedDirs);
      const hitByPath = new Map(shown.map((x) => [x.doc.path, x]));
      shown = visibleFiles.map((f) => hitByPath.get(f.path) ?? { doc: f, score: 0, title: new Set(), path: new Set() });
      if (sel >= shown.length) sel = Math.max(0, shown.length - 1);
      const indexByPath = new Map(shown.map((x, idx) => [x.doc.path, idx]));
      list.replaceChildren(...renderTreeNodes(tree, 0, hitByPath, indexByPath, hasQuery));
    } else {
      list.replaceChildren(...shown.map((hit, i) => renderFileRow(hit, i)));
    }

    if (!files.length) {
      list.append(h('li.bs-none', {}, scope === 'docs' ? 'No Markdown files in this project yet.' : 'No editable files in this project yet.'));
    } else if (!shown.length) {
      list.append(h('li.bs-none', {}, `No ${noun} matches that.`));
    }
  };

  const triggerGrep = () => {
    if (grepTimer) clearTimeout(grepTimer);
    const queryText = filter.value.trim();
    if (!queryText) {
      grepLoading = false;
      grepResults = null;
      renderSidebar();
      return;
    }
    grepLoading = true;
    renderSidebar();
    const mySeq = ++grepSeq;
    grepTimer = setTimeout(() => {
      void getJson<DocSearchResults>(`/api/docs/search?${q({ q: queryText, all: scope === 'all' ? '1' : '0' })}`)
        .then((res) => {
          if (mySeq !== grepSeq || !el.isConnected) return;
          grepLoading = false;
          grepResults = res;
          renderSidebar();
        })
        .catch(() => {
          if (mySeq !== grepSeq || !el.isConnected) return;
          grepLoading = false;
          grepResults = { query: queryText, hits: [], more: false };
          renderSidebar();
        });
    }, 150);
  };

  const refilter = () => {
    if (layout === 'grep') {
      triggerGrep();
      return;
    }
    shown = filterDocs(files, filter.value);
    const curIdx = current ? shown.findIndex((x) => x.doc.path === current) : -1;
    sel = curIdx >= 0 ? curIdx : 0;
    renderSidebar();
    list.scrollTop = 0;
  };

  const syncScopeAndLayoutUI = () => {
    for (const [s, btn] of [
      ['docs', scopeDocsBtn],
      ['all', scopeAllBtn],
    ] as const) {
      const on = scope === s;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-checked', String(on));
    }
    for (const [l, btn] of [
      ['list', layoutListBtn],
      ['tree', layoutTreeBtn],
      ['grep', layoutGrepBtn],
    ] as const) {
      const on = layout === l;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-checked', String(on));
    }
    if (layout === 'grep') {
      filter.placeholder = scope === 'docs' ? 'Search inside docs…' : 'Search inside files…';
      filter.setAttribute('aria-label', filter.placeholder);
    } else {
      filter.placeholder = scope === 'docs' ? 'Filter the docs…' : 'Filter project files…';
      filter.setAttribute('aria-label', filter.placeholder);
    }
  };

  const applyScope = (nextScope: ShelfScope) => {
    scope = nextScope;
    files = scope === 'all' ? allFiles : allFiles.filter((f) => isDocPath(f.path));
    syncScopeAndLayoutUI();
    refilter();
  };

  const applyLayout = (nextLayout: SidebarLayout) => {
    layout = nextLayout;
    syncScopeAndLayoutUI();
    refilter();
  };

  scopeDocsBtn.addEventListener('click', () => applyScope('docs'));
  scopeAllBtn.addEventListener('click', () => applyScope('all'));
  layoutListBtn.addEventListener('click', () => applyLayout('list'));
  layoutTreeBtn.addEventListener('click', () => applyLayout('tree'));
  layoutGrepBtn.addEventListener('click', () => {
    applyLayout('grep');
    filter.focus();
  });

  const move = (by: number) => {
    if (!shown.length || layout === 'grep') return;
    sel = (sel + by + shown.length) % shown.length;
    renderSidebar();
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };

  filter.addEventListener('input', refilter);
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (layout === 'grep') return;
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      if (layout === 'grep') return;
      e.preventDefault();
      const hit = shown[sel];
      if (hit) requestOpenDoc(hit.doc.path);
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      // The page, not the box: read on without leaving the filter.
      e.preventDefault();
      page.scrollBy({ top: (e.key === 'PageDown' ? 1 : -1) * page.clientHeight * 0.85, behavior: 'smooth' });
    }
  });

  // Global keyboard shortcuts while the Bookshelf modal is open.
  el.addEventListener('keydown', (e) => {
    if (shownTab !== 'docs' || !current) return;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void saveCurrentFile(false);
    } else if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'e') {
      if (isDocPath(current)) {
        e.preventDefault();
        void setViewMode(viewMode === 'preview' ? 'edit' : 'preview');
      }
    }
  });

  const jump = (hash: string) => {
    const lineNum = parseLineHash(hash);
    if (lineNum !== undefined) {
      void setViewMode(isDocPath(current ?? '') && viewMode === 'split' ? 'split' : 'edit').then(() => {
        editor?.goToLine(lineNum);
      });
      return;
    }
    jumpTo(page, hash);
  };

  /** Points the doc's links and pictures at the project: project docs & editable files open here, the rest on the forge. */
  function wire(body: HTMLElement, path: string) {
    anchorHeadings(body, toc);
    for (const a of body.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const to = resolveDocLink(path, a.getAttribute('href') ?? '');
      if (!to) continue;
      if (to.path === path || isDocPath(to.path) || isEditablePath(to.path)) {
        a.removeAttribute('target');
        a.dataset.doc = to.path;
        a.dataset.hash = to.hash;
      } else if (blob) {
        a.href = blobUrl(to.path, to.hash);
      } else {
        a.removeAttribute('href');
        a.title = to.path;
      }
    }
    for (const img of body.querySelectorAll<HTMLImageElement>('img[src]')) {
      const to = resolveDocLink(path, img.getAttribute('src') ?? '');
      if (to) img.src = withToken(`/api/docs/picture?${q({ path: to.path })}`);
    }
  }

  const expandAncestors = (path: string) => {
    for (const d of [...collapsedDirs]) {
      if (path.startsWith(`${d}/`)) collapsedDirs.delete(d);
    }
  };

  const openDoc = async (path: string, hash = '') => {
    if (path === current) {
      jump(hash);
      return;
    }
    const mine = ++opening;
    let doc: DocText;
    try {
      doc = await getJson<DocText>(`/api/docs/file?${q({ path })}`);
    } catch (err) {
      if (mine !== opening) return;
      toast(`Couldn't open ${nameOf(path)}: ${(err as Error).message}`, 'warn');
      if (!current) page.replaceChildren(emptyState('📕', `Couldn't open ${nameOf(path)}`, (err as Error).message));
      return;
    }
    if (mine !== opening || !el.isConnected) return;

    // If a non-Markdown file was opened (e.g. via a link in a doc), switch scope to All files so it shows in the sidebar.
    if (!isDocPath(path) && scope === 'docs') {
      scope = 'all';
      files = allFiles;
      syncScopeAndLayoutUI();
      shown = filterDocs(files, filter.value);
    }
    expandAncestors(path);

    current = path;
    currentMtime = doc.mtime;
    loadedText = doc.text;
    dirty = false;
    saving = false;
    conflictBar.hidden = true;
    rememberRead(floor, path);

    const isMd = isDocPath(path);
    const lineNum = parseLineHash(hash);
    const nextMode: DocViewMode = !isMd ? 'edit' : lineNum !== undefined ? (preferredMdMode === 'split' ? 'split' : 'edit') : preferredMdMode;
    viewMode = nextMode;

    editorPane.hidden = nextMode === 'preview';
    page.hidden = nextMode === 'edit';
    work.classList.toggle('is-split', nextMode === 'split');

    if (editor) {
      editor.loadFile(path, doc.text);
    } else if (nextMode !== 'preview') {
      await ensureEditor(path, doc.text);
    }

    if (isMd && nextMode !== 'edit') {
      renderMarkdownIntoPage(doc.text, path, false);
    }

    turnedAt = 0;
    const idx = shown.findIndex((x) => x.doc.path === path);
    if (idx >= 0) sel = idx;
    updateToolbar();
    renderSidebar();
    if (lineNum !== undefined) {
      editor?.goToLine(lineNum);
    } else if (nextMode !== 'edit') {
      jumpTo(page, hash);
    } else {
      editor?.focus();
    }
    deps.onTurn();
  };

  const requestOpenDoc = (path: string, hash = '') => {
    if (path === current) {
      jump(hash);
      return;
    }
    confirmUnsaved('open file', () => {
      void openDoc(path, hash);
    });
  };

  page.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[data-doc]') : null;
    if (!a) return;
    e.preventDefault();
    requestOpenDoc(a.dataset.doc!, a.dataset.hash ?? '');
  });
  // Every screenful you read, a page of the book in your hands turns.
  page.addEventListener('scroll', () => {
    if (Math.abs(page.scrollTop - turnedAt) < page.clientHeight * 0.8) return;
    turnedAt = page.scrollTop;
    deps.onTurn();
  });
  toc.addEventListener('change', () => {
    jumpTo(page, toc.value);
    toc.value = '';
  });

  // A moment later, so the E that opened the shelf isn't typed into the box.
  if (deps.tab === 'wiki') showTab('wiki');
  else {
    showTab('docs');
    setTimeout(() => filter.focus(), 30);
  }
  getJson<DocList>(`/api/docs?${q({ all: '1' })}`)
    .then((r) => {
      if (!el.isConnected) return;
      allFiles = r.files;
      moreFiles = r.more;
      const mdFiles = allFiles.filter((f) => isDocPath(f.path));
      // Default to Docs scope when the project has Markdown files, or All files when it only has code.
      if (!mdFiles.length && allFiles.length) {
        scope = 'all';
        files = allFiles;
      } else {
        files = mdFiles;
      }
      syncScopeAndLayoutUI();
      refilter();
      const last = lastRead(floor);
      const start = [last, ...shelfOrder(files).map((f) => f.path)].find((p) => p && allFiles.some((f) => f.path === p));
      if (start) void openDoc(start);
      else page.replaceChildren(emptyState('📚', 'Nothing to read here', 'This project has no editable files yet.'));
    })
    .catch((err: Error) => {
      if (!el.isConnected) return;
      count.textContent = '';
      page.replaceChildren(emptyState('📕', 'Couldn’t look along the shelves', err.message));
    });
}
