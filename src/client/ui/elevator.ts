import type { FloorInfo, ServerMsg } from '../../shared/protocol';
import { floorPalette } from '../../shared/floors';
import { ROOF, ROOF_NAME } from '../../shared/rooftop';
import type { Net } from '../net';
import { store } from '../state';
import { createAddFloorSection, routeAddFloorMessage } from './add-floor';
import { h, openModal, type Modal } from './dom';
import { floorNo, floorStats } from './floormenu';
import { floorDragHandle, floorReorder } from './floor-reorder';
import { emptyState, windowHeader } from './kit';
import { confirmDialog } from './prompt';

// The elevator's panel: a button for every floor (every project), and "add a project", which lists the
// git checkouts already in the office's workspace folder and makes the one you pick a new floor, right
// where it is: nothing is cloned or copied. Browse picks any other folder, which becomes a plain floor
// when it isn't a git checkout. The first time the office runs there are no floors, and this is where
// you start. A floor can be taken off the building here too; its folder stays on disk.

export interface ElevatorOptions {
  net: Net;
  ride(floorId: string): void;
}

/** Main feeds server messages through here, so a panel waiting on its new floor hears back. */
export function routeElevatorMessage(msg: ServerMsg) {
  routeAddFloorMessage(msg);
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
  let showAdd = setup || !store.floors.length;
  /** The search box and list are in place (rebuilding them would lose the focus mid-typing). */
  let built = false;

  const floorsEl = h('div.list.boxed.floors', { role: 'list', 'aria-label': 'Floors' });
  const addEl = h('section.section.add');
  const addBtn = h('button.btn.primary', { type: 'button' }, 'Add floor');
  const addSection = createAddFloorSection({
    net,
    submitBtn: addBtn,
    onOpenFloor: (floorId) => {
      modal.close();
      opts.ride(floorId);
    },
  });

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
    return h('div.list-row.floor-row', { role: 'listitem', 'data-floor-id': f.id, class: f.id === store.floor ? 'here on' : '' }, floorDragHandle(f.name), btn, f.home ? h('span.floor-off-slot') : off);
  };

  const confirmRemove = (f: FloorInfo) => {
    const next = store.floors.find((o) => o.id !== f.id);
    const workers = f.workers ? `Its ${f.workers} worker${f.workers === 1 ? '' : 's'} stop${f.workers === 1 ? 's' : ''}. ` : '';
    const ride = f.id === store.floor ? `You ride the elevator to ${next ? next.name : 'the lobby'}. ` : '';
    const own = f.local ? ' The office keeps its own settings there too, so it carries on as before, just without this floor.' : '';
    confirmDialog(`Take ${f.name} off the building?`, `${workers}${ride}Nothing is deleted: its ${f.plain ? 'folder' : 'checkout'} stays in ${f.dir}, .droid-office folder and all.${own}`, 'Remove floor', () =>
      net.send({ t: 'floor.remove', floor: f.id }),
    );
  };

  /** The roof, over every floor. */
  const roofButton = () => {
    const here = store.floor === ROOF;
    const btn = h(
      'button.floor-btn',
      { type: 'button', class: here ? 'here' : '', disabled: here, title: here ? "You're up on the roof" : `Ride up to the ${ROOF_NAME.toLowerCase()}` },
      h('span.list-icon.floor-no.roof', { 'aria-hidden': 'true' }, '🏙️'),
      h('span.list-main', {}, h('span.list-title', {}, ROOF_NAME), h('span.list-meta', {}, 'The city all around')),
      h('span.list-end', {}, here ? h('span.pill.floor-here', {}, 'You are here') : null),
    );
    btn.addEventListener('click', () => {
      if (here) return;
      modal.close();
      opts.ride(ROOF);
    });
    return h('div.list-row.floor-row', { role: 'listitem', class: here ? 'here on' : '' }, h('span.floor-off-slot'), btn, h('span.floor-off-slot'));
  };

  const renderFloors = () => {
    const floors = store.floors;
    // Top floor first, the way an elevator's buttons stack, with the roof over them and floor 1 at the bottom.
    floorsEl.classList.toggle('boxed', floors.length > 0);
    floorsEl.replaceChildren(...(floors.length ? [roofButton()] : []), ...(floors.length ? floors.map(floorRow).reverse() : [emptyState('🛗', 'No floors yet', 'Add a project below to make the first one.')]));
  };

  const renderAdd = (focusInput = false) => {
    if (!showAdd) {
      const open = h('button.btn.add-open', { type: 'button' }, '＋ Add a project');
      open.addEventListener('click', () => {
        showAdd = true;
        renderAdd(true);
      });
      addEl.replaceChildren(open);
      addBtn.classList.add('hidden');
      return;
    }
    addBtn.classList.remove('hidden');
    if (!built) {
      built = true;
      addEl.replaceChildren(h('div.eyebrow', {}, h('span.no', {}, '02'), setup && !store.floors.length ? 'Pick your first project' : 'Add a project'), addSection.el);
      addSection.start(focusInput);
    } else {
      addSection.render();
      if (focusInput) setTimeout(() => addSection.input.focus(), 0);
    }
  };

  const sub = setup
    ? store.floors.length
      ? 'Every project is a floor of this building. Pick a floor to ride to, or add another project.'
      : "Every project is a floor of this building, and it doesn't have any yet. Pick one of your git projects, or browse to any folder: it becomes the first floor, and the office works in it right where it is."
    : 'Every project is a floor. Pick one to ride to.';
  const floorsSection = h('section.section', {}, h('div.eyebrow', {}, h('span.no', {}, '01'), 'Floors'), h('p.field-hint', {}, 'Drag the handles to change floor numbers and shortcuts.'), floorsEl);
  const el = h(
    'div.modal.elevator',
    { role: 'dialog', 'aria-label': 'Elevator' },
    windowHeader(setup ? 'Welcome to Droid Office' : 'Elevator', sub),
    h('div.body', {}, h('div.stack.loose', {}, floorsSection, addEl)),
    h('footer', {}, h('span.grow', {}, h('span.key', {}, 'Esc'), setup ? 'look around first' : 'stay here'), addBtn),
  );
  const unsubs = [store.on('floors', () => (renderFloors(), renderAdd())), store.on('floor', renderFloors)];
  const modal = openModal(el, {
    doing: '🛗 at the elevator',
    // A stray click shouldn't lose the first-run panel; ✕ and Esc still close it.
    backdropCloses: !setup,
    onClose: () => {
      current = null;
      disposeReorder();
      addSection.dispose();
      for (const off of unsubs) off();
    },
  });
  const disposeReorder = floorReorder(floorsEl, net, true);
  current = modal;
  renderFloors();
  renderAdd(showAdd);
}
