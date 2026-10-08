import type { FloorInfo, RepoChoice, ServerMsg } from '../../shared/protocol';
import { floorPalette } from '../../shared/floors';
import { ROOF, ROOF_NAME } from '../../shared/rooftop';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, timeAgo, type Modal } from './dom';
import { floorNo, floorStats } from './floormenu';
import { confirmDialog } from './prompt';

// The elevator's panel: a button for every floor (every project), and "add a project", which lists the
// git checkouts already in the office's workspace folder and makes the one you pick a new floor, right
// where it is: nothing is cloned or copied. The first time the office runs there are no floors, and
// this is where you start. A floor can be taken off the building here too; its checkout stays on disk.

export interface ElevatorOptions {
  net: Net;
  ride(floorId: string): void;
}

/** How many checkouts the list shows at once; typing narrows it down. */
const SHOWN = 60;
/** Look in the workspace folder again after this long. */
const REPOS_STALE_MS = 30_000;

const addedWaiters = new Set<(msg: Extract<ServerMsg, { t: 'floor.added' }>) => void>();

/** Main feeds server messages through here, so a panel waiting on its new floor hears back. */
export function routeElevatorMessage(msg: ServerMsg) {
  if (msg.t === 'floor.added') for (const fn of addedWaiters) fn(msg);
}

let current: Modal | null = null;

export function elevatorPanelOpen(): boolean {
  return !!current;
}

export function openElevator(opts: ElevatorOptions): void {
  if (current) return;
  // Nowhere to go yet: the panel greets you. It closes like any other; the elevator (or the floor
  // name in the corner) opens it again.
  const setup = !store.floor;
  const { net } = opts;
  let filter = '';
  let selected: string | null = null;
  let adding: string | null = null;
  let error = '';
  let showAdd = setup || !store.floors.length;
  /** The search box and list are in place (rebuilding them would lose the focus mid-typing). */
  let built = false;

  const floorsEl = h('div.list.boxed.floors', { role: 'list', 'aria-label': 'Floors' });
  const addEl = h('section.section.add');
  const input = h('input', { type: 'text', placeholder: 'Search your projects, or type a checkout’s full path', 'aria-label': 'Project', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const listEl = h('div.list.boxed.repo-list', { role: 'listbox', 'aria-label': 'Projects' });
  const statusEl = h('div.stack.tight.add-status');
  const addBtn = h('button.btn.primary', { type: 'button' }, 'Add floor');
  const refreshBtn = h('button.btn.icon', { type: 'button', title: 'Look in the workspace folder again', 'aria-label': 'Look again' }, '↻');

  // Where checkouts are looked for. It can be moved right here: the first project is when it matters.
  const dirInput = h('input', { type: 'text', placeholder: '~/Workspace', 'aria-label': 'Workspace folder', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const dirSave = h('button.btn.primary', { type: 'button' }, 'Save');
  const dirCancel = h('button.btn.ghost', { type: 'button' }, 'Cancel');
  const dirEl = h('div.row.dir-pick.hidden', {}, dirInput, dirCancel, dirSave);
  const editDir = (on: boolean) => {
    dirEl.classList.toggle('hidden', !on);
    if (!on) return;
    dirInput.value = store.projectsDir.dir;
    setTimeout(() => dirInput.focus(), 0);
  };
  const saveDir = () => {
    const dir = dirInput.value.trim();
    if (!dir) return dirInput.focus();
    // The server says why it can't, if it can't; the folder moving closes this.
    if (dir === store.projectsDir.dir) editDir(false);
    else net.send({ t: 'floor.projectsDir', dir });
  };
  dirSave.addEventListener('click', saveDir);
  dirCancel.addEventListener('click', () => editDir(false));
  dirInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) saveDir();
  });

  const needRepos = () => {
    const r = store.repos;
    if (r.loading || (r.at && Date.now() - r.at < REPOS_STALE_MS && !r.error)) return;
    store.repos = { ...r, loading: true };
    net.send({ t: 'floor.repos' });
  };

  /** What "Add floor" would add: the row picked, else what's typed if it's a full path. */
  const typedPath = (): string | undefined => {
    const t = filter.trim();
    return t.startsWith('/') || t === '~' || t.startsWith('~/') ? t : undefined;
  };
  const choice = (): string | undefined => selected ?? typedPath();

  const floorButton = (f: FloorInfo, i: number) => {
    const here = f.id === store.floor;
    const p = floorPalette(f.palette);
    const btn = h(
      'button.floor-btn',
      { type: 'button', class: here ? 'here' : '', disabled: here, title: here ? "You're on this floor" : `Ride to ${f.name}` },
      floorNo(String(i + 1), p.trim),
      h('span.list-main', {}, h('span.list-title', { title: f.name }, f.name), h('span.list-meta', { title: f.repo ?? f.dir }, f.repo ?? f.dir)),
      h('span.list-end', {}, here ? h('span.pill.floor-here', {}, 'You are here') : null, floorStats(f)),
    );
    btn.addEventListener('click', () => {
      if (here) return;
      modal.close();
      opts.ride(f.id);
    });
    return btn;
  };

  /** The floor's button, with a 🗑 beside it to take it off the building (an empty slot where it can't be, so the rows line up). */
  const floorRow = (f: FloorInfo, i: number) => {
    const btn = floorButton(f, i);
    const off = h('button.btn.icon.ghost.floor-off', { type: 'button', title: `Take ${f.name} off the building`, 'aria-label': `Remove ${f.name}` }, '🗑');
    off.addEventListener('click', () => confirmRemove(f));
    return h('div.list-row.floor-row', { role: 'listitem', class: f.id === store.floor ? 'here on' : '' }, btn, f.home ? h('span.floor-off-slot') : off);
  };

  const confirmRemove = (f: FloorInfo) => {
    const next = store.floors.find((o) => o.id !== f.id);
    const workers = f.workers ? `Its ${f.workers} worker${f.workers === 1 ? '' : 's'} stop${f.workers === 1 ? 's' : ''}. ` : '';
    const ride = f.id === store.floor ? `You ride the elevator to ${next ? next.name : 'the lobby'}. ` : '';
    const own = f.local ? ' The office keeps its own settings there too, so it carries on as before, just without this floor.' : '';
    confirmDialog(`Take ${f.name} off the building?`, `${workers}${ride}Nothing is deleted: its checkout stays in ${f.dir}, .droid-office folder and all.${own}`, 'Remove floor', () => net.send({ t: 'floor.remove', floor: f.id }));
  };

  /** The roof, over every floor: the rooftop bar. */
  const roofButton = () => {
    const here = store.floor === ROOF;
    const btn = h(
      'button.floor-btn',
      { type: 'button', class: here ? 'here' : '', disabled: here, title: here ? "You're up on the roof" : `Ride up to the ${ROOF_NAME.toLowerCase()}` },
      h('span.list-icon.floor-no.roof', { 'aria-hidden': 'true' }, '🍸'),
      h('span.list-main', {}, h('span.list-title', {}, ROOF_NAME), h('span.list-meta', {}, 'A DJ playing drum and bass, a bar, and the city all around')),
      h('span.list-end', {}, here ? h('span.pill.floor-here', {}, 'You are here') : null),
    );
    btn.addEventListener('click', () => {
      if (here) return;
      modal.close();
      opts.ride(ROOF);
    });
    return h('div.list-row.floor-row', { role: 'listitem', class: here ? 'here on' : '' }, btn, h('span.floor-off-slot'));
  };

  const renderFloors = () => {
    const floors = store.floors;
    // Top floor first, the way an elevator's buttons stack, with the roof over them and floor 1 at the bottom.
    floorsEl.classList.toggle('boxed', floors.length > 0);
    floorsEl.replaceChildren(
      ...(floors.length ? [roofButton()] : []),
      ...(floors.length ? floors.map(floorRow).reverse() : [h('div.empty-state', {}, h('span.empty-icon', { 'aria-hidden': 'true' }, '🛗'), h('b', {}, 'No floors yet'), h('p', {}, 'Add a project below to make the first one.'))]),
    );
  };

  const repoRow = (r: RepoChoice) => {
    const floor = store.floors.find((f) => f.dir === r.dir);
    const on = selected === r.dir;
    const row = h(
      'div.list-row.repo',
      { role: 'option', class: on ? 'on' : '', 'aria-selected': String(on), title: r.dir },
      h('span.list-icon.forge', { title: r.forge === 'gitlab' ? 'GitLab' : r.forge === 'github' ? 'GitHub' : 'Local folder' }, r.forge === 'gitlab' ? '🦊' : r.forge === 'github' ? '🐙' : '📁'),
      h('span.list-main', {}, h('span.list-title', {}, r.name), h('span.list-meta', {}, tildePath(r.dir))),
      h(
        'span.list-end',
        {},
        floor ? h('span.pill', { class: floor.id === store.floor ? 'floor-here' : '' }, floor.id === store.floor ? 'you are here' : `floor ${store.floors.indexOf(floor) + 1}`) : r.activeAt ? h('span.when', {}, timeAgo(r.activeAt)) : null,
      ),
    );
    row.addEventListener('click', () => {
      if (adding) return;
      if (floor) {
        // Already a floor: the button takes you there.
        if (floor.id !== store.floor) {
          modal.close();
          opts.ride(floor.id);
        }
        return;
      }
      selected = r.dir;
      renderAdd();
    });
    row.addEventListener('dblclick', () => {
      if (!floor) add(r.dir);
    });
    return row;
  };

  /** The workspace folder is shown as ~/… where it can be; a checkout's path is shown the same way. */
  const tildePath = (dir: string) => {
    const root = store.projectsDir.dir;
    return root && dir.startsWith(`${root}/`) ? `${root}${dir.slice(root.length)}` : dir;
  };

  const renderAdd = () => {
    if (!showAdd) {
      const open = h('button.btn.add-open', { type: 'button' }, '＋ Add a project');
      open.addEventListener('click', () => {
        showAdd = true;
        needRepos();
        renderAdd();
        setTimeout(() => input.focus(), 0);
      });
      addEl.replaceChildren(open);
      addBtn.classList.add('hidden');
      return;
    }
    addBtn.classList.remove('hidden');
    const r = store.repos;
    const q = filter.trim().toLowerCase();
    const matches = r.list.filter((x) => !q || x.name.toLowerCase().includes(q) || x.dir.toLowerCase().includes(q));
    const rows: HTMLElement[] = matches.slice(0, SHOWN).map(repoRow);
    if (!rows.length)
      rows.push(
        h(
          'p.repo-empty',
          {},
          r.loading
            ? `Looking for git projects in ${store.projectsDir.dir}…`
            : r.error
              ? ''
              : q
                ? 'Nothing matches. Type the full path of a checkout in the workspace folder to add one that isn’t listed.'
                : `No git projects in ${store.projectsDir.dir}. Change the folder below.`,
        ),
      );
    if (matches.length > SHOWN) rows.push(h('p.repo-empty.more', {}, `…and ${matches.length - SHOWN} more — type to narrow it down`));
    listEl.replaceChildren(...rows);
    const pick = choice();
    const change = h('button.btn.sm.dir-change', { type: 'button', title: 'Look for projects in another folder on the office’s machine (also in ⚙️ Settings)' }, 'Change folder');
    change.addEventListener('click', () => editDir(true));
    statusEl.replaceChildren(
      adding
        ? h('p.note.info.busy', {}, h('span.spinner'), `Adding ${adding}…`)
        : h(
            'div.row.between.dir-line',
            {},
            h('p.field-hint', {}, 'Looking in ', h('code', { title: store.projectsDir.dir }, store.projectsDir.dir || 'the workspace folder'), '. The new floor works in the checkout where it is: nothing is cloned or copied.'),
            change,
          ),
      ...[r.error, error].filter(Boolean).map((e) => h('p.note.bad', {}, e)),
    );
    addBtn.disabled = !!adding || !pick || store.floors.some((f) => f.dir === pick);
    addBtn.textContent = adding ? 'Adding…' : 'Add floor';
    input.disabled = !!adding;
    if (!built) {
      built = true;
      addEl.replaceChildren(
        h('div.eyebrow', {}, h('span.no', {}, '02'), setup && !store.floors.length ? 'Pick your first project' : 'Add a project'),
        h('div.stack.tight', {}, h('div.input-group.repo-search', {}, input, refreshBtn), listEl, statusEl, dirEl),
      );
    }
  };

  const add = (dir: string) => {
    if (adding) return;
    adding = dir;
    error = '';
    renderAdd();
    net.send({ t: 'floor.add', dir });
  };

  const onAdded = (msg: Extract<ServerMsg, { t: 'floor.added' }>) => {
    if (!adding || msg.dir !== adding) return;
    adding = null;
    if (msg.error || !msg.floor) {
      error = msg.error ?? 'The floor could not be added';
      renderAdd();
      return;
    }
    modal.close();
    opts.ride(msg.floor);
  };
  addedWaiters.add(onAdded);

  input.addEventListener('input', () => {
    filter = input.value;
    // Typing something else drops the row that was picked.
    selected = null;
    renderAdd();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const q = filter.trim().toLowerCase();
    const matches = store.repos.list.filter((x) => !store.floors.some((f) => f.dir === x.dir) && (x.name.toLowerCase().includes(q) || x.dir.toLowerCase().includes(q)));
    const pick = choice() ?? (q && matches.length === 1 ? matches[0].dir : undefined);
    if (pick) add(pick);
  });
  addBtn.addEventListener('click', () => {
    const pick = choice();
    if (pick) add(pick);
  });
  refreshBtn.addEventListener('click', () => {
    store.repos = { ...store.repos, loading: true, error: undefined };
    renderAdd();
    net.send({ t: 'floor.repos', refresh: true });
  });

  const sub = setup
    ? store.floors.length
      ? 'Every project is a floor of this building. Pick a floor to ride to, or add another project.'
      : "Every project is a floor of this building, and it doesn't have any yet. Pick one of your git projects: it becomes the first floor, and the office works in it right where it is."
    : 'Every project is a floor. Pick one to ride to.';
  const floorsSection = h('section.section', {}, h('div.eyebrow', {}, h('span.no', {}, '01'), 'Floors'), floorsEl);
  const el = h(
    'div.modal.md.elevator',
    { role: 'dialog', 'aria-label': 'Elevator' },
    h('header', {}, h('div.titles', {}, h('h2', {}, setup ? 'Welcome to Droid Office' : 'Elevator'), h('p.sub', {}, sub))),
    h('div.body', {}, h('div.stack.loose', {}, floorsSection, addEl)),
    h('footer', {}, h('span.grow', {}, h('span.key', {}, 'Esc'), setup ? 'look around first' : 'stay here'), addBtn),
  );
  const unsubs = [store.on('floors', () => (renderFloors(), renderAdd())), store.on('repos', renderAdd), store.on('projectsDir', () => (editDir(false), renderAdd())), store.on('floor', renderFloors)];
  const modal = openModal(el, {
    doing: '🛗 at the elevator',
    // A stray click shouldn't lose the first-run panel; ✕ and Esc still close it.
    backdropCloses: !setup,
    onClose: () => {
      current = null;
      addedWaiters.delete(onAdded);
      for (const off of unsubs) off();
    },
  });
  current = modal;
  renderFloors();
  if (showAdd) needRepos();
  renderAdd();
  if (showAdd) setTimeout(() => input.focus(), 30);
}
