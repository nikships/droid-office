import { capabilityOf } from '../../shared/factory';
import {
  WIKI_DEFAULT_MODEL,
  WIKI_SEARCH_LIMIT,
  flattenWiki,
  resolveWikiLink,
  type DroidModel,
  type FactoryWikiFloor,
  type FactoryWikiHit,
  type FactoryWikiJob,
  type FactoryWikiNode,
  type FactoryWikiPage,
  type FactoryWikiPrivacy,
  type FactoryWikiRun,
  type FactoryWikiRunDetail,
} from '../../shared/factory-wiki';
import { factoryFetch, refreshFactory, watchFactory } from '../factory';
import { store } from '../state';
import { withToken } from '../token';
import { anchorHeadings, jumpTo } from './bookshelf';
import { clip, h, timeAgo, toast } from './dom';
import { emptyState } from './kit';
import { markdownFile } from './markdown';

// The bookshelf's AutoWiki tab: the wiki Factory keeps for the floor's repository, read the way the
// Docs tab reads the project's Markdown (the page tree down the side, the page beside it, links
// between pages opening in place). It also searches the wiki, picks an older version, and runs
// /wiki to write or refresh it (server/factory/wiki-run.ts), with privacy, export and delete.

const LAST_KEY = 'droid-office.autowiki';
const CONFIRM_TEXT =
  'Runs /wiki headless with this office’s Factory key, on the model you pick for /wiki and every subagent it starts. A small model like GLM-5.3-Flash costs much less. With a frontier model, a large repository takes about an hour and can spend 5 to 20 million credits on the connected account.';
const CI_HINT = 'To refresh it on every push instead, run /install-wiki in a Droid session in this repository: it adds a CI action that runs /wiki.';

export interface WikiTabDeps {
  floor: string;
  onTurn(): void;
  openSettings?: () => void;
  /** What your character is doing at the shelf, while this tab shows. */
  setDoing(text: string): void;
}

export interface WikiTab {
  /** The tab came into view: start watching, read what's needed. */
  shown(): void;
  dispose(): void;
}

const active = (job: FactoryWikiJob | undefined) => job?.state === 'starting' || job?.state === 'running';

/** How long something has taken: 45s, 12m 05s, 1h 04m. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** What's on a run's label in the version menu and the status line: when, which commit, how many pages. */
export function runLabel(r: FactoryWikiRun): string {
  return [r.createdAt ? new Date(r.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'undated', r.commitHash?.slice(0, 7), `${r.pageCount} page${r.pageCount === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
}

function lastPage(floor: string): string | undefined {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}')[floor];
  } catch {
    return undefined;
  }
}

function rememberPage(floor: string, path: string) {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}');
    all[floor] = path;
    localStorage.setItem(LAST_KEY, JSON.stringify(all));
  } catch {
    // Private mode, or storage is full: it just won't reopen where you were.
  }
}

/** `text` with every case-insensitive occurrence of the words of `q` marked. */
function highlight(text: string, q: string): (string | HTMLElement)[] {
  const words = q
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return [text];
  const re = new RegExp(`(${words.join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? h('mark', {}, part) : part));
}

export function mountWikiTab(root: HTMLElement, deps: WikiTabDeps): WikiTab {
  const { floor } = deps;
  const search = h('input.input', { type: 'text', role: 'searchbox', placeholder: 'Search the wiki…', 'aria-label': 'Search the wiki', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const status = h('div.wk-status');
  const jobCard = h('div.wk-job', { hidden: true, role: 'status' });
  const count = h('div.bs-count');
  const list = h('ul.list.bs-list', { role: 'listbox', 'aria-label': 'Wiki pages' });
  const crumbs = h('div.bs-crumbs');
  const meta = h('div.bs-meta');
  const toc = h('select.select.sm.bs-toc', { 'aria-label': 'Jump to a heading', title: 'Jump to a heading' }) as HTMLSelectElement;
  const page = h('div.bs-page', { tabindex: -1 });
  const side = h('aside.bs-side', {}, status, jobCard, h('div.bs-find', {}, search), count, list);
  const reader = h('article.bs-reader.flush', {}, h('div.bs-bar', {}, crumbs, meta, toc), page);
  const panel = h('div.empty-state.wk-panel');
  toc.hidden = true;

  let watching: (() => void) | undefined;
  let disposed = false;
  /** The run being read (the newest, unless an older version was picked), and its tree. */
  let runId: string | undefined;
  let detail: FactoryWikiRunDetail | undefined;
  let pinned = false;
  let loadingRun = 0;
  let current: FactoryWikiPage | undefined;
  let opening = 0;
  let hits: FactoryWikiHit[] | null = null;
  let searching = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let confirming: 'generate' | 'delete' | null = null;
  /** The models Generate offers (read when its confirm first opens), and the one picked. */
  let models: DroidModel[] | undefined;
  let model = WIKI_DEFAULT_MODEL;
  let busy = false;
  let turnedAt = 0;
  /** What the panel or the status card last drew, so a broadcast that changes nothing redraws nothing. */
  let drawn = '';
  const pages = new Map<string, FactoryWikiPage>();

  const floorState = (): FactoryWikiFloor => store.factory.wiki.floors[floor] ?? { history: [], fetchedAt: 0 };

  type Mode = 'off' | 'denied' | 'why' | 'empty' | 'writing' | 'wiki';
  const modeOf = (f: FactoryWikiFloor): Mode => {
    const conn = store.factory.connection;
    if (!conn.connected || conn.rejected) return 'off';
    if (capabilityOf(conn, 'wiki')?.status === 'denied') return 'denied';
    if (f.why) return 'why';
    if (f.latest) return 'wiki';
    return active(f.job) ? 'writing' : 'empty';
  };

  const call = async <T>(path: string, init: Parameters<typeof factoryFetch>[2] = {}): Promise<T | undefined> => {
    try {
      return await factoryFetch<T>('wiki', path, init);
    } catch (err) {
      toast(`AutoWiki: ${(err as Error).message}`, 'warn');
      return undefined;
    }
  };

  const generate = async () => {
    confirming = null;
    busy = true;
    paint(true);
    await call('/generate', { method: 'POST', body: { floor, model } });
    busy = false;
    paint(true);
  };

  const loadModels = async () => {
    if (models) return;
    models = [];
    const r = await call<{ models: DroidModel[]; default: string }>('/models');
    models = r?.models ?? [];
    if (r?.default && !models.some((m) => m.id === model)) model = r.default;
    paint(true);
  };

  const modelName = (id: string | undefined) => (id ? (models?.find((m) => m.id === id)?.name ?? id) : '');

  /** Generate's model picker: Factory's models, then the owner's own. */
  const modelPicker = () => {
    const list = models?.length ? models : [{ id: model, name: model }];
    const opt = (m: DroidModel) => h('option', { value: m.id, selected: m.id === model }, m.name);
    const own = list.filter((m) => m.custom);
    const select = h(
      'select.select.sm.wk-model',
      { 'aria-label': 'Model', title: 'The model /wiki and its subagents run on' },
      ...(own.length ? [h('optgroup', { label: 'Factory' }, ...list.filter((m) => !m.custom).map(opt)), h('optgroup', { label: 'Your own models' }, ...own.map(opt))] : list.map(opt)),
    ) as HTMLSelectElement;
    select.addEventListener('change', () => {
      model = select.value;
    });
    select.id = 'wk-model';
    return h('div.field.inline.wk-model-row', {}, h('label', { for: select.id }, 'Model'), select);
  };

  const stop = async () => {
    if (!confirm('Stop writing the wiki? What /wiki has done so far is thrown away.')) return;
    await call('/cancel', { method: 'POST', body: { floor } });
  };

  // ---- Pieces the states share ------------------------------------------------------------------

  const confirmBox = (yes: string, onYes: () => void, text = CONFIRM_TEXT, danger = false) =>
    h(
      'div.note.wk-confirm',
      { role: 'alertdialog', class: danger ? 'bad' : 'info' },
      h('p', {}, text),
      danger ? '' : modelPicker(),
      h(
        'div.row.wrap.wk-actions',
        {},
        h(`button.btn.sm.${danger ? 'danger' : 'primary'}`, { type: 'button', onclick: onYes }, yes),
        h(
          'button.btn.sm.ghost',
          {
            type: 'button',
            onclick: () => {
              confirming = null;
              paint(true);
            },
          },
          'Cancel',
        ),
      ),
    );

  const generateButton = (label: string, small = false) =>
    h(
      small ? 'button.btn.sm.primary' : 'button.btn.primary',
      {
        type: 'button',
        disabled: busy,
        onclick: () => {
          confirming = 'generate';
          paint(true);
          void loadModels();
        },
      },
      busy ? 'Starting…' : label,
    );

  /** The job's card: what /wiki is doing and for how long, or how it ended. */
  const paintJob = (job: FactoryWikiJob | undefined, into: HTMLElement, big = false) => {
    if (!job || job.state === 'done') {
      into.hidden = true;
      into.replaceChildren();
      return;
    }
    into.hidden = false;
    const running = active(job);
    const took = (job.endedAt ?? Date.now()) - job.startedAt;
    const head = running
      ? h('div.wk-job-head', {}, h('span.spinner'), h('b', {}, job.state === 'starting' ? 'Getting the default branch…' : 'Writing the wiki…'), h('span.wk-elapsed', {}, elapsed(took)))
      : h('div.wk-job-head', {}, h('b', {}, job.state === 'cancelled' ? `Stopped after ${elapsed(took)}` : job.state === 'lost' ? 'The last run was cut off' : `/wiki failed after ${elapsed(took)}`));
    const who = h(
      'div.wk-job-who',
      {},
      [`started by ${job.by}`, job.startedAt ? timeAgo(job.startedAt) : '', job.commit ? `at ${job.commit}` : '', job.model ? `on ${job.modelName ?? modelName(job.model)}` : ''].filter(Boolean).join(' · '),
    );
    const lines = running || !job.error ? h('pre.wk-lines', {}, job.lines.join('\n')) : h('pre.wk-lines.bad', {}, job.error);
    const actions = h('div.row.wrap.wk-actions');
    if (running) actions.append(h('button.btn.sm.danger', { type: 'button', onclick: () => void stop() }, 'Stop'));
    into.className = `wk-job ${job.state}${big ? ' big' : ''}`;
    into.replaceChildren(head, who, lines, actions);
    if (running && big) into.append(h('p.field-hint', {}, 'The pages appear here on their own once /wiki uploads them. A first run takes a while: it reads the whole repository.'));
  };

  /** The run's line: its version menu, when it's from, and what can be done with it. */
  const paintStatus = (f: FactoryWikiFloor) => {
    const run = (runId && f.history.find((r) => r.id === runId)) || (runId === f.latest?.id ? f.latest : undefined) || detail;
    if (!run) {
      status.replaceChildren();
      return;
    }
    const versions = f.history.length ? f.history : f.latest ? [f.latest] : [];
    const picker = h('select.select.sm.wk-version', { 'aria-label': 'Which version', title: 'Older versions of the wiki' }) as HTMLSelectElement;
    for (const r of versions) picker.append(h('option', { value: r.id, selected: r.id === run.id }, `${r.id === f.latest?.id ? '● ' : ''}${runLabel(r)}`));
    if (!versions.some((r) => r.id === run.id)) picker.append(h('option', { value: run.id, selected: true }, runLabel(run)));
    picker.addEventListener('change', () => {
      pinned = picker.value !== f.latest?.id;
      void loadRun(picker.value);
    });
    const privacy = h(
      'select.select.sm.wk-privacy',
      { 'aria-label': 'Who can see it', title: run.canUpdatePrivacy === false ? 'This key can’t change who sees it' : 'Who can see it on Factory', disabled: run.canUpdatePrivacy === false || busy },
      h('option', { value: 'private', selected: run.privacyLevel !== 'organization' }, '🔒 Only you'),
      h('option', { value: 'organization', selected: run.privacyLevel === 'organization' }, '👥 Organization'),
    ) as HTMLSelectElement;
    privacy.addEventListener('change', async () => {
      busy = true;
      const ok = await call(`/runs/${encodeURIComponent(run.id)}/privacy`, { method: 'POST', body: { privacyLevel: privacy.value as FactoryWikiPrivacy } });
      busy = false;
      if (!ok) privacy.value = run.privacyLevel ?? 'private';
      paint(true);
    });
    const exportLink = h('a.btn.sm', { href: withToken(`/api/factory/wiki/runs/${encodeURIComponent(run.id)}/export`), download: '', title: 'Download its pages as a .zip' }, '⬇ .zip');
    const factoryLink = h('a.btn.sm', { href: `https://app.factory.ai/wiki/${encodeURIComponent(run.id)}`, target: '_blank', rel: 'noopener noreferrer', title: 'Open it on Factory' }, 'Factory ↗');
    const del = h(
      'button.btn.sm.danger',
      {
        type: 'button',
        title: 'Delete this version from Factory',
        onclick: () => {
          confirming = 'delete';
          paint(true);
        },
      },
      'Delete',
    );
    const writing = active(f.job);
    const age = h(
      'div.wk-age',
      {},
      [
        `${run.pageCount} pages`,
        run.createdAt ? `written ${timeAgo(run.createdAt)}` : '',
        run.branch && run.branch !== 'HEAD' ? run.branch : '',
        run.commitHash ? run.commitHash.slice(0, 7) : '',
        run.hasLocalChanges ? 'with local changes' : '',
        run.model ? `by ${modelName(run.model)}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    );
    const rows: (HTMLElement | string)[] = [h('div.wk-row', {}, picker), age, h('div.row.wrap.wk-actions', {}, writing ? '' : generateButton('Regenerate', true), exportLink, factoryLink, del), h('div.wk-row', {}, privacy)];
    if (confirming === 'generate') rows.push(confirmBox('Regenerate', () => void generate()));
    if (confirming === 'delete')
      rows.push(
        confirmBox(
          'Delete it',
          async () => {
            confirming = null;
            busy = true;
            paint(true);
            const gone = await call(`/runs/${encodeURIComponent(run.id)}`, { method: 'DELETE' });
            busy = false;
            if (gone) {
              pinned = false;
              runId = undefined;
              detail = undefined;
            }
            paint(true);
          },
          `Delete the wiki written ${run.createdAt ? timeAgo(run.createdAt) : ''} (${run.pageCount} pages) from Factory? This can’t be undone.`,
          true,
        ),
      );
    status.replaceChildren(...rows);
  };

  const panelOf = (mode: Mode, f: FactoryWikiFloor): (HTMLElement | string)[] => {
    const conn = store.factory.connection;
    const repo = f.repoUrl?.replace(/^https:\/\//, '') ?? 'this repository';
    if (mode === 'off')
      return [
        h('div.empty-icon', { 'aria-hidden': 'true' }, '🏭'),
        h('b', {}, conn.rejected ? 'Factory turned the office’s key down' : 'AutoWiki needs Factory'),
        h(
          'p',
          {},
          conn.rejected
            ? `Factory rejected the office’s API key (${conn.rejected}). Check it again or replace it in Settings → Factory.`
            : 'Connect the office to Factory with an API key in Settings → Factory, and the wiki Factory keeps for this repository shows up here, next to its docs.',
        ),
        deps.openSettings ? h('div.row', {}, h('button.btn.primary', { type: 'button', onclick: deps.openSettings }, 'Open Settings → Factory')) : '',
      ];
    if (mode === 'denied') return [h('div.empty-icon', { 'aria-hidden': 'true' }, '🔒'), h('b', {}, 'The key can’t reach AutoWiki'), h('p', {}, capabilityOf(conn, 'wiki')?.reason ?? 'Factory said no to the office’s key for AutoWiki.')];
    if (mode === 'why') return [h('div.empty-icon', { 'aria-hidden': 'true' }, '📭'), h('b', {}, 'No AutoWiki for this floor'), h('p', {}, f.why ?? '')];
    if (mode === 'writing') {
      const card = h('div.wk-job');
      paintJob(f.job, card, true);
      return [card];
    }
    const failed = h('div.wk-job');
    paintJob(f.job, failed);
    return [
      h('div.empty-icon', { 'aria-hidden': 'true' }, '📖'),
      h('b', {}, `No AutoWiki for ${repo} yet`),
      h('p', {}, 'AutoWiki reads the repository and writes a wiki of it: its architecture, modules, APIs and conventions, page by page. Generate it here and it’s kept on Factory, where the whole team can read it.'),
      f.job && !active(f.job) ? failed : '',
      f.noAccess ? h('p.note.warn', {}, `Factory says: ${f.noAccess.replace(/\.$/, '')}. Its GitHub or GitLab integration may not cover this repository, so its upload may be refused.`) : '',
      confirming === 'generate' ? confirmBox('Generate', () => void generate()) : h('div.row', {}, generateButton(f.job && !active(f.job) ? 'Try again' : 'Generate wiki')),
      h('p.field-hint.wk-note', {}, CI_HINT),
    ];
  };

  // ---- The tree and the page --------------------------------------------------------------------

  const renderList = () => {
    if (hits) {
      count.textContent = `${hits.length}${hits.length >= WIKI_SEARCH_LIMIT ? '+' : ''} result${hits.length === 1 ? '' : 's'}`;
      list.replaceChildren(
        ...hits.map((hit) => {
          const li = h(
            'li.list-row.bs-item.wk-hit',
            { role: 'option', class: current?.pageId === hit.pageId ? 'on' : '', title: hit.path },
            h(
              'div.list-main',
              {},
              h('div.list-title', {}, ...highlight(hit.title, search.value)),
              h('div.list-meta.bs-path', {}, hit.path, hit.matchCount > 1 ? ` · ${hit.matchCount} matches` : ''),
              hit.snippet ? h('div.wk-snippet', {}, ...highlight(clip(hit.snippet, 220), search.value)) : '',
            ),
          );
          li.addEventListener('click', () => void openPage(hit.pageId));
          return li;
        }),
      );
      if (!hits.length) list.append(h('li.bs-none', {}, 'Nothing in the wiki matches that.'));
      return;
    }
    const all = detail ? flattenWiki(detail.pageTree) : [];
    count.textContent = detail ? `${all.length} page${all.length === 1 ? '' : 's'}` : '';
    list.replaceChildren(
      ...all.map(({ node, depth }) => {
        const li = h(
          'li.list-row.bs-item.wk-node',
          { role: 'option', class: `${current?.pageId === node.pageId ? 'on' : ''} ${node.children.length ? 'section' : ''}`, title: node.path },
          h('div.list-main', {}, h('div.list-title', {}, node.title)),
        );
        li.style.setProperty('--depth', String(depth));
        li.addEventListener('click', () => void openPage(node.pageId));
        return li;
      }),
    );
    if (detail && !all.length) list.append(h('li.bs-none', {}, 'This version has no pages.'));
  };

  /** Points a page's links at the wiki: other pages open here, the rest leave the office. */
  const wire = (body: HTMLElement, from: FactoryWikiPage) => {
    anchorHeadings(body, toc);
    const tree = detail?.pageTree ?? [];
    const repoUrl = floorState().repoUrl;
    const commit = detail?.commitHash;
    for (const a of body.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const href = a.getAttribute('href') ?? '';
      const to = resolveWikiLink(tree, from.path, href);
      if (to) {
        a.removeAttribute('target');
        a.dataset.page = to.pageId;
        a.dataset.hash = to.hash;
      } else if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//') && !href.startsWith('#')) {
        // A path in the repository the page describes: the file on the forge, at the commit it's of.
        const path = href.replace(/^(\.\.?\/)+/, '').replace(/^\//, '');
        if (repoUrl && path) a.href = `${repoUrl}${repoUrl.includes('github.com') ? '' : '/-'}/blob/${commit ?? 'HEAD'}/${path}`;
        else a.removeAttribute('href');
      }
    }
    // Pictures the wiki uploaded come as links of their own; one the office can't fetch says what it was.
    for (const img of body.querySelectorAll<HTMLImageElement>('img[src]')) {
      if (!/^https:\/\//i.test(img.getAttribute('src') ?? '')) img.replaceWith(h('span.wk-missing', {}, `🖼 ${img.alt || 'picture'}`));
    }
    // Diagrams (```mermaid) stay as their source, labelled, rather than a picture the office can't draw.
    for (const code of body.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')) {
      const lang = /language-([\w-]+)/.exec(code.className)?.[1];
      if (lang && ['mermaid', 'plantuml', 'dot', 'graphviz', 'd2'].includes(lang)) code.parentElement?.before(h('div.wk-diagram', {}, `${lang} diagram, shown as its source`));
    }
  };

  const nodeById = (id: string) => (detail ? flattenWiki(detail.pageTree).find((x) => x.node.pageId === id)?.node : undefined);

  const openPage = async (pageId: string, hash = '') => {
    if (current?.pageId === pageId && current && detail) return jumpTo(page, hash);
    const run = runId;
    if (!run) return;
    const mine = ++opening;
    const key = `${run}/${pageId}`;
    let p = pages.get(key);
    if (!p) {
      if (!current) page.replaceChildren(h('div.bs-loading', {}, h('span.spinner')));
      p = await call<FactoryWikiPage>(`/runs/${encodeURIComponent(run)}/pages/${encodeURIComponent(pageId)}`);
      if (!p) return;
      pages.set(key, p);
    }
    if (mine !== opening || disposed || run !== runId) return;
    current = p;
    rememberPage(floor, p.path);
    const body = p.content.trim() ? markdownFile(p.content) : h('div.md', {}, h('p.none', {}, 'This page is empty.'));
    wire(body, p);
    page.replaceChildren(body);
    const dir = p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/') + 1) : '';
    crumbs.replaceChildren(dir ? h('span.dir', {}, dir) : '', nodeById(pageId)?.title ?? p.title);
    crumbs.title = p.path;
    const words = p.content.split(/\s+/).filter(Boolean).length;
    meta.replaceChildren(`${Math.max(1, Math.round(words / 220))} min read`);
    turnedAt = 0;
    jumpTo(page, hash);
    renderList();
    deps.setDoing(`🏭 reading the AutoWiki: ${clip(p.title, 40)}`);
    deps.onTurn();
  };

  /** Reads a run's tree and opens a page of it: the one read last on this floor, else the first. */
  const loadRun = async (id: string) => {
    const mine = ++loadingRun;
    runId = id;
    current = undefined;
    hits = null;
    search.value = '';
    const d = await call<FactoryWikiRunDetail>(`/runs/${encodeURIComponent(id)}`);
    if (mine !== loadingRun || disposed) return;
    if (!d) {
      page.replaceChildren(emptyState('📕', 'Couldn’t read this version of the wiki'));
      return;
    }
    detail = d;
    renderList();
    paint(true);
    const all = flattenWiki(d.pageTree).map((x) => x.node);
    const want = current ? undefined : lastPage(floor);
    const start: FactoryWikiNode | undefined = all.find((n) => n.path === want) ?? all[0];
    if (start) void openPage(start.pageId);
    else page.replaceChildren(emptyState('📭', 'This version has no pages'));
  };

  const runSearch = async () => {
    const q = search.value.trim();
    const run = runId;
    if (!q || !run) {
      hits = null;
      renderList();
      return;
    }
    const mine = ++searching;
    count.textContent = 'Searching…';
    const r = await call<{ results: FactoryWikiHit[] }>(`/runs/${encodeURIComponent(run)}/search`, { query: { q, limit: WIKI_SEARCH_LIMIT } });
    if (mine !== searching || disposed || search.value.trim() !== q) return;
    hits = r?.results ?? [];
    renderList();
    list.scrollTop = 0;
  };

  search.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void runSearch(), 250);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      // Clears the search rather than closing the shelf.
      e.stopPropagation();
      search.value = '';
      hits = null;
      renderList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const first = hits?.[0];
      if (first) void openPage(first.pageId);
      else void runSearch();
    }
  });
  page.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[data-page]') : null;
    if (!a) return;
    e.preventDefault();
    void openPage(a.dataset.page!, a.dataset.hash ?? '');
  });
  page.addEventListener('scroll', () => {
    if (Math.abs(page.scrollTop - turnedAt) < page.clientHeight * 0.8) return;
    turnedAt = page.scrollTop;
    deps.onTurn();
  });
  toc.addEventListener('change', () => {
    jumpTo(page, toc.value);
    toc.value = '';
  });

  // ---- Painting -------------------------------------------------------------------------------

  const paint = (force = false) => {
    if (disposed) return;
    const f = floorState();
    const mode = modeOf(f);
    const key = JSON.stringify([mode, f.latest?.id, f.latest?.privacyLevel, f.history.map((r) => r.id), f.job?.state, f.job?.lines, f.job?.error, confirming, busy, runId, f.why, store.factory.connection.rejected]);
    if (!force && key === drawn) return;
    drawn = key;
    if (mode !== 'wiki') {
      root.classList.add('wk-empty');
      root.classList.remove('split');
      panel.replaceChildren(...panelOf(mode, f));
      if (panel.parentElement !== root) root.replaceChildren(panel);
      return;
    }
    root.classList.remove('wk-empty');
    root.classList.add('split');
    if (side.parentElement !== root) root.replaceChildren(side, reader);
    // A new run landed and you were reading the newest: the new one replaces it.
    if (f.latest && (!runId || (!pinned && runId !== f.latest.id))) {
      if (!runId) page.replaceChildren(h('div.bs-loading', {}, h('span.spinner')));
      void loadRun(f.latest.id);
    }
    paintStatus(f);
    paintJob(f.job, jobCard);
  };

  const off = store.on('factory', () => paint());
  // The job's clock, and the "written 3h ago"s, while the tab is open.
  const clock = setInterval(() => {
    const job = floorState().job;
    if (active(job)) {
      const el = root.querySelector('.wk-elapsed');
      if (el && job) el.textContent = elapsed(Date.now() - job.startedAt);
    }
  }, 1000);
  const ages = setInterval(() => paint(true), 60_000);

  return {
    shown() {
      if (disposed) return;
      if (!watching) {
        watching = watchFactory('wiki');
        // The floor's history, read now rather than at the next poll.
        if (store.factory.connection.connected) {
          void factoryFetch('wiki', '/floor', { query: { floor } }).catch(() => refreshFactory('wiki'));
          // For the names of the models the runs were written by, and Generate's picker.
          void loadModels();
        }
      }
      paint(true);
      deps.setDoing(current ? `🏭 reading the AutoWiki: ${clip(current.title, 40)}` : '🏭 at the AutoWiki');
      if (modeOf(floorState()) === 'wiki') setTimeout(() => search.focus(), 30);
    },
    dispose() {
      disposed = true;
      watching?.();
      off();
      clearInterval(clock);
      clearInterval(ages);
      if (searchTimer) clearTimeout(searchTimer);
    },
  };
}
