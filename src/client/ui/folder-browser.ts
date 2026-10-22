import type { FolderChoice, ServerMsg } from '../../shared/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal } from './dom';
import { emptyState, windowHeader } from './kit';

// The elevator's folder browser: walks the office machine's folders (the server lists them, so it
// works from the Mac app, a browser or a phone alike) and picks one to make a floor. A git checkout
// gets the boards and worktrees; any other folder becomes a plain floor without them.

type Listing = Extract<ServerMsg, { t: 'floor.folders' }>;

const waiters = new Set<(msg: Listing) => void>();

/** Main feeds server messages through here, so an open browser hears its listing. */
export function routeFolderMessage(msg: ServerMsg) {
  if (msg.t === 'floor.folders') for (const fn of waiters) fn(msg);
}

let seq = 0;

/** Opens the folder browser on the workspace folder; `onPick` gets the folder picked, absolute. */
export function openFolderBrowser(net: Net, onPick: (dir: string) => void): void {
  let listing: Listing | null = null;
  let request = '';

  const pathInput = h('input', { type: 'text', 'aria-label': 'Folder', placeholder: '~/Documents/notes', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const upBtn = h('button.btn.icon', { type: 'button', title: 'The folder this one is in', 'aria-label': 'Up one folder' }, '↑');
  const listEl = h('div.list.boxed.folder-list', { role: 'listbox', 'aria-label': 'Folders' });
  const noteEl = h('div.stack.tight');
  const pickBtn = h('button.btn.primary', { type: 'button' }, 'Add this folder');
  const cancelBtn = h('button.btn.ghost', { type: 'button' }, 'Cancel');

  let offline = false;
  const go = (dir?: string) => {
    request = `f${++seq}`;
    listing = null;
    offline = !net.send({ t: 'floor.folders', request, ...(dir ? { dir } : {}) });
    render();
  };

  const row = (f: FolderChoice) => {
    const floor = store.floors.find((x) => x.dir === f.dir);
    const btn = h(
      'button.list-row',
      { type: 'button', role: 'option', title: f.dir },
      h('span.list-icon', { 'aria-hidden': 'true' }, f.git ? '🌿' : '📁'),
      h('span.list-main', {}, h('span.list-title', {}, f.name), f.git ? h('span.list-meta', {}, 'git checkout') : null),
      h('span.list-end', {}, floor ? h('span.pill', {}, `floor ${store.floors.indexOf(floor) + 1}`) : null),
    );
    btn.addEventListener('click', () => go(f.dir));
    return btn;
  };

  const render = () => {
    upBtn.disabled = !listing?.parent;
    if (!listing) {
      listEl.replaceChildren(offline ? h('p.note.bad', {}, 'Disconnected. Nothing can be sent.') : h('p.note.info.busy', {}, h('span.spinner'), 'Looking…'));
      pickBtn.disabled = true;
      noteEl.replaceChildren();
      return;
    }
    if (document.activeElement !== pathInput) pathInput.value = listing.shown;
    const l = listing;
    listEl.replaceChildren(
      ...(l.folders.length ? l.folders.map(row) : [emptyState('📁', l.error ? "Can't open this folder" : 'No folders in here', l.error ? undefined : 'Add this folder, or go up and pick another.')]),
      ...(l.more ? [h('p.field-hint', {}, 'Only the first folders are listed. Type a path to go further.')] : []),
    );
    const floor = store.floors.find((f) => f.dir === l.dir);
    pickBtn.disabled = !!floor || !!l.error || !!l.blocked;
    pickBtn.textContent = floor ? `Already ${floor.name}` : 'Add this folder';
    noteEl.replaceChildren(
      l.error || l.blocked
        ? h('p.note.bad', {}, l.error ?? l.blocked)
        : h(
            'p.field-hint',
            {},
            l.git
              ? 'A git checkout gets its boards, pipelines and worktrees. It has to be in the workspace folder.'
              : 'A folder that isn’t a git checkout becomes a plain floor: workers work in it directly, with no boards, pipelines, branches or worktrees.',
          ),
    );
  };

  const onListing = (msg: Listing) => {
    if (msg.request !== request) return;
    listing = msg;
    render();
  };
  waiters.add(onListing);

  upBtn.addEventListener('click', () => {
    if (listing?.parent) go(listing.parent);
  });
  pathInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const typed = pathInput.value.trim();
    if (typed) go(typed);
    pathInput.blur();
  });
  pickBtn.addEventListener('click', () => {
    if (!listing || pickBtn.disabled) return;
    const dir = listing.dir;
    modal.close();
    onPick(dir);
  });
  cancelBtn.addEventListener('click', () => modal.close());

  const el = h(
    'div.modal.folder-browser',
    { role: 'dialog', 'aria-label': 'Pick a folder' },
    windowHeader('Pick a folder', 'Any folder on the office’s machine can be a floor. Open folders to find yours, then add it.'),
    h('div.body', {}, h('div.stack.tight', {}, h('div.input-group', {}, upBtn, pathInput), listEl, noteEl)),
    h('footer', {}, h('span.grow', {}, h('span.key', {}, 'Enter'), 'go to the path typed'), cancelBtn, pickBtn),
  );
  const modal = openModal(el, { doing: '🛗 at the elevator', onClose: () => waiters.delete(onListing) });
  go();
}
