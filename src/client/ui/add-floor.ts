import { MAX_FLOORS, parseGitHubUrl } from '../../shared/floors';
import type { FloorInfo, RepoChoice, ServerMsg } from '../../shared/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { claimEscape, h, openModal, timeAgo, type Modal } from './dom';
import { openFolderBrowser } from './folder-browser';
import { icon } from './icons';
import { windowHeader } from './kit';

/** How many checkouts the list shows at once; typing narrows it down. */
const SHOWN = 60;
/** Look in the workspace folder again after this long. */
const REPOS_STALE_MS = 30_000;

const addedWaiters = new Set<(msg: Extract<ServerMsg, { t: 'floor.added' }>) => void>();

/** Feeds server messages to any open Add floor dialog or Elevator panel waiting on `floor.added`. */
export function routeAddFloorMessage(msg: ServerMsg) {
  if (msg.t === 'floor.added') for (const fn of addedWaiters) fn(msg);
}

/** Whether what the owner typed is an explicit filesystem path (`/…`, `~` or `~/…`). */
export function isTypedFloorPath(raw: string): boolean {
  const t = raw.trim();
  return t.startsWith('/') || t === '~' || t.startsWith('~/');
}

/** Display path where a pasted GitHub URL will be cloned inside the workspace folder. */
export function cloneTargetPath(projectsDir: string, name: string): string {
  const base = projectsDir.trim().replace(/\/+$/, '');
  return base ? `${base}/${name}` : name;
}

/** Formats an absolute folder path on the office's machine as `~/…` when the home folder is known. */
export function shortenFloorPath(dir: string, projectsDir: string, floors: readonly Pick<FloorInfo, 'dir' | 'home'>[]): string {
  let home = floors.find((f) => f.home)?.dir;
  if (!home && projectsDir.startsWith('~/')) {
    const suffix = projectsDir.slice(1);
    const at = dir.indexOf(`${suffix}/`);
    if (at > 0) home = dir.slice(0, at);
    else if (dir.endsWith(suffix) && dir.length > suffix.length) home = dir.slice(0, dir.length - suffix.length);
  }
  if (home && (dir === home || dir.startsWith(`${home}/`))) return `~${dir.slice(home.length)}`;
  return dir;
}

/** Filters discovered workspace checkouts by repository name, pasted GitHub URL, raw path or `~/…` display path. */
export function filterWorkspaceRepos(repos: readonly RepoChoice[], query: string, projectsDir = '', floors: readonly Pick<FloorInfo, 'dir' | 'home'>[] = []): RepoChoice[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...repos];
  const ghRepo = parseGitHubUrl(query)?.repo.toLowerCase();
  return repos.filter(
    (x) =>
      (ghRepo !== undefined && (x.repo?.toLowerCase() === ghRepo || x.name.toLowerCase() === ghRepo)) ||
      x.name.toLowerCase().includes(q) ||
      x.dir.toLowerCase().includes(q) ||
      shortenFloorPath(x.dir, projectsDir, floors).toLowerCase().includes(q),
  );
}

/**
 * Resolves what "Add floor" (or pressing Enter) submits:
 * 1. An explicitly selected row from the checkout list, else
 * 2. A typed `/…` or `~/…` path, else
 * 3. A pasted GitHub URL (reusing an existing unadded checkout in the workspace, or cloning into it), else
 * 4. On Enter: the sole matching unadded checkout, or a non-matching typed string so the server explains why it can't be added.
 */
export function resolveFloorTarget(opts: { filter: string; selected: string | null; repos: readonly RepoChoice[]; floors: readonly Pick<FloorInfo, 'dir' | 'home'>[]; projectsDir?: string; onEnter?: boolean }): string | undefined {
  if (opts.selected) return opts.selected;
  if (isTypedFloorPath(opts.filter)) return opts.filter.trim();
  const gh = parseGitHubUrl(opts.filter);
  if (gh) {
    const existing = opts.repos.filter((x) => x.repo?.toLowerCase() === gh.repo.toLowerCase());
    const unadded = existing.filter((x) => !opts.floors.some((f) => f.dir === x.dir));
    if (unadded.length > 0) return unadded[0].dir;
    if (existing.length > 0) return undefined;
    return opts.filter.trim();
  }
  if (!opts.onEnter) return undefined;
  const trimmed = opts.filter.trim();
  if (!trimmed) return undefined;
  const matches = filterWorkspaceRepos(opts.repos, trimmed, opts.projectsDir ?? '', opts.floors);
  const unadded = matches.filter((x) => !opts.floors.some((f) => f.dir === x.dir));
  if (unadded.length === 1) return unadded[0].dir;
  if (matches.length === 0) return trimmed;
  return undefined;
}

export interface AddFloorSectionOptions {
  net: Net;
  /** Primary submit button (placed in the enclosing modal's footer). */
  submitBtn: HTMLButtonElement;
  /** Called when an already-open floor is clicked or a newly added floor opens. */
  onOpenFloor(floorId: string): void;
}

export interface AddFloorSection {
  el: HTMLElement;
  input: HTMLInputElement;
  /** Loads workspace checkouts if stale and renders the picker. */
  start(focusInput?: boolean): void;
  render(): void;
  dispose(): void;
}

/**
 * Shared project & folder picker used by both the Web Companion's Add floor dialog and the 3D office's Elevator.
 * Searches checkouts in the workspace folder, accepts any typed or browsed folder path (git checkout in the
 * workspace or plain folder anywhere), and lets the owner change the workspace folder inline.
 */
export function createAddFloorSection(opts: AddFloorSectionOptions): AddFloorSection {
  const { net, submitBtn, onOpenFloor } = opts;
  let filter = '';
  let selected: string | null = null;
  let adding: string | null = null;
  let error = '';
  let editingDir = false;
  let savingDir = false;
  let dirError = '';

  const input = h('input.input', {
    type: 'text',
    maxlength: 1024,
    placeholder: 'Search projects, paste a GitHub URL, or type a folder path',
    'aria-label': 'Project or folder path',
    autocomplete: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement;
  const refreshBtn = h('button.btn.icon', { type: 'button', title: 'Look in the workspace folder again', 'aria-label': 'Look in the workspace folder again' }, icon('refresh', 14));
  const browseBtn = h('button.btn', { type: 'button', title: 'Pick any folder on the office’s machine, git checkout or not' }, icon('folder', 14), 'Browse…');
  const listEl = h('div.list.boxed.repo-list', { role: 'listbox', 'aria-label': 'Projects' });
  const statusEl = h('div.stack.tight.add-status');

  const dirInput = h('input.input.grow', { type: 'text', maxlength: 1024, placeholder: '~/Workspace', 'aria-label': 'Workspace folder', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const dirSave = h('button.btn.primary', { type: 'button' }, 'Save');
  const dirCancel = h('button.btn.ghost', { type: 'button' }, 'Cancel');
  const dirErrorEl = h('p.note.bad.hidden', { role: 'alert' });
  const dirEl = h('div.stack.tight.dir-pick.hidden', {}, h('div.row', {}, dirInput, dirCancel, dirSave), dirErrorEl);

  const el = h('div.stack.tight.add-floor', {}, h('div.row', {}, h('div.input-group.repo-search.grow', {}, input, refreshBtn), browseBtn), listEl, statusEl, dirEl);

  const renderDir = () => {
    dirEl.classList.toggle('hidden', !editingDir);
    dirInput.disabled = savingDir || !net.up;
    dirSave.disabled = savingDir || !net.up;
    dirSave.textContent = savingDir ? 'Saving…' : 'Save';
    dirErrorEl.textContent = dirError;
    dirErrorEl.classList.toggle('hidden', !dirError);
  };

  const editDir = (on: boolean) => {
    editingDir = on;
    savingDir = false;
    dirError = '';
    renderDir();
    if (!on) return;
    dirInput.value = store.projectsDir.dir;
    setTimeout(() => dirInput.focus(), 0);
  };

  const needRepos = (force = false) => {
    const r = store.repos;
    if (!force && (r.loading || (r.at && Date.now() - r.at < REPOS_STALE_MS && !r.error))) return;
    store.repos = { ...r, loading: true, ...(force ? { error: undefined } : {}) };
    if (!net.send({ t: 'floor.repos', ...(force ? { refresh: true } : {}) })) {
      store.repos = { ...r, loading: false, error: 'Disconnected from the office.' };
    }
    render();
  };

  const saveDir = async () => {
    if (savingDir) return;
    const dir = dirInput.value.trim();
    if (!dir) return dirInput.focus();
    if (dir === store.projectsDir.dir) {
      editDir(false);
      return;
    }
    savingDir = true;
    dirError = '';
    renderDir();
    const result = await net.request({ t: 'floor.projectsDir', dir });
    savingDir = false;
    if (!result.ok) {
      dirError = result.error ?? "Couldn't change the workspace folder.";
      renderDir();
      dirInput.focus();
      return;
    }
    editDir(false);
    needRepos(true);
  };
  dirSave.addEventListener('click', () => void saveDir());
  dirCancel.addEventListener('click', () => {
    editDir(false);
    input.focus();
  });
  dirInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      void saveDir();
    }
  });

  const shownMatches = () => filterWorkspaceRepos(store.repos.list, filter, store.projectsDir.dir, store.floors).slice(0, SHOWN);

  const repoRow = (r: RepoChoice) => {
    const floor = store.floors.find((f) => f.dir === r.dir);
    const on = !floor && selected === r.dir;
    const shownPath = shortenFloorPath(r.dir, store.projectsDir.dir, store.floors);
    const row = h(
      'button.list-row.repo',
      { type: 'button', role: 'option', class: on ? 'on' : '', 'aria-selected': String(on), title: r.dir, 'data-repo-dir': r.dir },
      h('span.list-icon.forge', { title: r.forge === 'gitlab' ? 'GitLab' : r.forge === 'github' ? 'GitHub' : 'Local folder', 'aria-hidden': 'true' }, r.forge === 'gitlab' ? '🦊' : r.forge === 'github' ? '🐙' : '📁'),
      h('span.list-main', {}, h('span.list-title', {}, r.name), h('span.list-meta', {}, shownPath)),
      h(
        'span.list-end',
        {},
        floor ? h('span.pill', { class: floor.id === store.floor ? 'floor-here' : '' }, floor.id === store.floor ? 'you are here' : `floor ${store.floors.indexOf(floor) + 1}`) : r.activeAt ? h('span.when', {}, timeAgo(r.activeAt)) : null,
      ),
    );
    row.addEventListener('click', () => {
      if (adding) return;
      if (floor) {
        if (floor.id !== store.floor) onOpenFloor(floor.id);
        return;
      }
      selected = r.dir;
      error = '';
      render();
    });
    row.addEventListener('dblclick', () => {
      if (!floor && !adding) add(r.dir);
    });
    return row;
  };

  const render = () => {
    const r = store.repos;
    const allMatches = filterWorkspaceRepos(r.list, filter, store.projectsDir.dir, store.floors);
    const visible = allMatches.slice(0, SHOWN);
    if (selected && store.floors.some((f) => f.dir === selected)) selected = null;
    const full = store.floors.length >= MAX_FLOORS;
    const ghUrl = parseGitHubUrl(filter);
    const rows: HTMLElement[] = visible.map(repoRow);
    if (!rows.length && ghUrl) {
      const target = cloneTargetPath(shortenFloorPath(store.projectsDir.dir, store.projectsDir.dir, store.floors), ghUrl.name);
      const cloneRow = h(
        'button.list-row.repo.on.clone-row',
        {
          type: 'button',
          role: 'option',
          'aria-selected': 'true',
          disabled: !!adding || !net.up || full,
          title: `Clone ${ghUrl.repo} into ${target} and open as a floor`,
          'data-clone-repo': ghUrl.repo,
        },
        h('span.list-icon.forge', { title: 'GitHub', 'aria-hidden': 'true' }, '🐙'),
        h('span.list-main', {}, h('span.list-title', {}, ghUrl.repo), h('span.list-meta', {}, `Clone into ${target}`)),
        h('span.list-end', {}, h('span.pill.floor-clone', {}, 'clone')),
      );
      cloneRow.addEventListener('click', () => {
        if (!adding) add(filter.trim());
      });
      rows.push(cloneRow);
    }
    if (!rows.length) {
      rows.push(
        h(
          'p.repo-empty',
          {},
          r.loading
            ? `Looking for git projects in ${store.projectsDir.dir || 'the workspace folder'}…`
            : r.error
              ? 'Could not list workspace projects. Paste a GitHub URL, type a folder’s full path, or Browse to add one.'
              : filter.trim()
                ? isTypedFloorPath(filter)
                  ? `Press Add floor to open ${filter.trim()} right where it is.`
                  : 'Nothing matches. Paste a GitHub URL to clone, type a folder’s full path (~/… or /…), or Browse to it.'
                : `No git projects in ${store.projectsDir.dir || 'the workspace folder'}. Paste a GitHub URL to clone, browse to a folder, or change the workspace folder below.`,
        ),
      );
    }
    if (allMatches.length > SHOWN) rows.push(h('p.repo-empty.more', {}, `…and ${allMatches.length - SHOWN} more — type to narrow it down`));
    listEl.replaceChildren(...rows);

    const pick = resolveFloorTarget({ filter, selected, repos: r.list, floors: store.floors, projectsDir: store.projectsDir.dir });
    const willClone = !!pick && !!parseGitHubUrl(pick);
    const addingGh = adding ? parseGitHubUrl(adding) : undefined;
    const change = h('button.btn.sm.dir-change', { type: 'button', disabled: !!adding || !net.up, title: 'Look for projects in another folder on the office’s machine (also in ⚙️ Settings)' }, 'Change folder');
    change.addEventListener('click', () => editDir(true));

    statusEl.replaceChildren(
      adding
        ? h(
            'p.note.info.busy',
            { role: 'status' },
            h('span.spinner'),
            addingGh
              ? ` Cloning ${addingGh.repo} into ${cloneTargetPath(shortenFloorPath(store.projectsDir.dir, store.projectsDir.dir, store.floors), addingGh.name)}…`
              : ` Adding ${shortenFloorPath(adding, store.projectsDir.dir, store.floors)}…`,
          )
        : h(
            'div.row.between.dir-line',
            {},
            h(
              'p.field-hint',
              {},
              'Looking in ',
              h('code', { title: store.projectsDir.dir }, store.projectsDir.dir || 'the workspace folder'),
              '. Existing folders open where they are; pasted GitHub URLs clone into this folder. A folder without git becomes a plain floor.',
            ),
            change,
          ),
      ...(full && !adding ? [h('p.note.warn', { role: 'status' }, `The building is full (${MAX_FLOORS} floors). Remove a floor before adding another.`)] : []),
      ...(!net.up && !adding && !error ? [h('p.note.bad', { role: 'alert' }, 'Disconnected from the office. Reconnect before adding a floor.')] : []),
      ...[r.error, error].filter(Boolean).map((e) => h('p.note.bad', { role: 'alert' }, e)),
    );
    submitBtn.disabled = !!adding || !net.up || full || !pick;
    submitBtn.textContent = adding ? (addingGh ? 'Cloning…' : 'Adding…') : willClone ? 'Clone & add' : 'Add floor';
    input.disabled = !!adding;
    refreshBtn.disabled = !!adding || !net.up || r.loading;
    browseBtn.disabled = !!adding || !net.up || full;
    renderDir();
  };

  const add = (dir: string) => {
    if (adding) return;
    if (store.floors.length >= MAX_FLOORS) {
      error = `The building is full (${MAX_FLOORS} floors)`;
      render();
      return;
    }
    if (!net.up) {
      error = 'Disconnected from the office. Reconnect before adding a floor.';
      render();
      return;
    }
    adding = dir;
    error = '';
    render();
    if (!net.send({ t: 'floor.add', dir })) {
      adding = null;
      error = 'Disconnected from the office. Nothing was sent.';
      render();
    }
  };

  const onAdded = (msg: Extract<ServerMsg, { t: 'floor.added' }>) => {
    if (!adding || msg.dir !== adding) return;
    adding = null;
    if (msg.error || !msg.floor) {
      error = msg.error ?? 'The floor could not be added';
      render();
      input.focus();
      return;
    }
    onOpenFloor(msg.floor);
  };
  addedWaiters.add(onAdded);

  const stepSelection = (delta: -1 | 1) => {
    const choices = shownMatches().filter((x) => !store.floors.some((f) => f.dir === x.dir));
    if (!choices.length) return;
    const at = choices.findIndex((x) => x.dir === selected);
    const next = at < 0 ? (delta > 0 ? 0 : choices.length - 1) : (at + delta + choices.length) % choices.length;
    selected = choices[next].dir;
    error = '';
    render();
    listEl.querySelector<HTMLElement>('.list-row.on')?.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => {
    filter = input.value;
    selected = null;
    error = '';
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      stepSelection(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const pick = resolveFloorTarget({ filter, selected, repos: store.repos.list, floors: store.floors, projectsDir: store.projectsDir.dir, onEnter: true });
    if (pick) add(pick);
  });
  const onSubmitClick = () => {
    const pick = resolveFloorTarget({ filter, selected, repos: store.repos.list, floors: store.floors, projectsDir: store.projectsDir.dir });
    if (pick) add(pick);
  };
  submitBtn.addEventListener('click', onSubmitClick);
  browseBtn.addEventListener('click', () => openFolderBrowser(net, add));
  refreshBtn.addEventListener('click', () => needRepos(true));

  const unclaim = claimEscape(el, () => {
    if (!editingDir) return false;
    editDir(false);
    input.focus();
    return true;
  });
  const unsubs = [
    store.on('floors', render),
    store.on('repos', render),
    store.on('projectsDir', () => {
      if (editingDir) editDir(false);
      needRepos(true);
    }),
    net.onStatus((up) => {
      if (!up && adding) {
        adding = null;
        error = 'Disconnected before the floor was confirmed. Check the floor list before trying again.';
      }
      if (up && !store.repos.at && !store.repos.loading) needRepos();
      render();
    }),
  ];

  return {
    el,
    input,
    start(focusInput = true) {
      needRepos();
      render();
      if (focusInput) setTimeout(() => input.focus(), 30);
    },
    render,
    dispose() {
      unclaim();
      addedWaiters.delete(onAdded);
      submitBtn.removeEventListener('click', onSubmitClick);
      for (const off of unsubs) off();
    },
  };
}

let currentModal: Modal | null = null;

/** Opens the standalone Add floor dialog in the web or Mac companion. */
export function openAddFloor(net: Net, onOpenFloor: (floorId: string) => void): void {
  if (currentModal) return;
  const cancelBtn = h('button.btn.ghost', { type: 'button' }, 'Cancel');
  const submitBtn = h('button.btn.accent', { type: 'button' }, 'Add floor');
  const section = createAddFloorSection({
    net,
    submitBtn,
    onOpenFloor: (floorId) => {
      modal.close();
      onOpenFloor(floorId);
    },
  });
  cancelBtn.addEventListener('click', () => modal.close());
  const el = h(
    'div.modal.add-floor-modal',
    { role: 'dialog', 'aria-label': 'Add floor' },
    windowHeader('Add floor', 'Open a project folder on the office’s machine, or paste a GitHub URL to clone it.'),
    h('div.body', {}, section.el),
    h('footer', {}, h('span.grow', {}, h('span.key', {}, 'Enter'), 'add floor'), cancelBtn, submitBtn),
  );
  const modal = openModal(el, {
    onClose: () => {
      currentModal = null;
      section.dispose();
    },
  });
  currentModal = modal;
  section.start(true);
}
