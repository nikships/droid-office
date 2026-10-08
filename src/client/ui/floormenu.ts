import { floorPalette } from '../../shared/floors';
import { ROOF, ROOF_NAME } from '../../shared/rooftop';
import type { FloorInfo } from '../../shared/protocol';
import { store } from '../state';
import { h } from './dom';

// The floor list that drops down from the project in the corner: every floor of the building, top
// floor first. Picking one takes you straight there, to the same spot in the office you're standing
// in now. Adding a project is still the elevator's job.

export interface FloorMenuOptions {
  /** Go to that floor, staying where you are in the office. */
  go(floorId: string): void;
  /** Open the elevator's panel, to add a project. */
  elevator(): void;
  /** Up to the rooftop bar, by elevator. */
  roof(): void;
}

let current: { el: HTMLElement; close(): void } | null = null;

export function floorMenuOpen(): boolean {
  return !!current;
}

export function closeFloorMenu() {
  current?.close();
}

/** A floor's number on a badge in its palette's trim color (a custom property: the color is the floor's data). */
export function floorNo(text: string, color: string): HTMLElement {
  const el = h('span.list-icon.floor-no', { 'aria-hidden': 'true' }, text);
  el.style.setProperty('--floor-trim', color);
  return el;
}

/** Who is on a floor: waiting on someone, working, at desks. */
export function floorStats(f: FloorInfo): HTMLElement {
  const stat = (cls: string, title: string, icon: string, n: number) => h('span.floor-stat', { class: cls, title }, h('span', { 'aria-hidden': 'true' }, icon), String(n));
  return h('span.floor-stats', {}, f.waiting ? stat('waiting', 'Workers waiting on someone', '🙋', f.waiting) : null, f.busy ? stat('', 'Working', '👷', f.busy) : null, stat('', 'Workers at desks', '💻', f.workers));
}

/** Opens the floor list under `anchor`, or closes it if it's open. */
export function toggleFloorMenu(anchor: HTMLElement, opts: FloorMenuOptions): void {
  if (current) {
    current.close();
    return;
  }
  const el = h('div.floor-menu.panel', { role: 'menu', 'aria-label': 'Floors' });

  const item = (f: FloorInfo, i: number, here: number) => {
    const isHere = f.id === store.floor;
    const p = floorPalette(f.palette);
    const n = Math.abs(i - here);
    const where = isHere || here < 0 ? '' : `${i > here ? '⬆' : '⬇'} ${n} floor${n === 1 ? '' : 's'} ${i > here ? 'up' : 'down'}`;
    const btn = h(
      'button.list-row.floor-item',
      { type: 'button', role: 'menuitem', class: isHere ? 'here on' : '', disabled: isHere, title: isHere ? "You're on this floor" : `Go to ${f.name}, right where you're standing` },
      floorNo(String(i + 1), p.trim),
      h('span.list-main', {}, h('span.list-title', { title: f.name }, f.name), h('span.list-meta', { title: f.repo ?? f.dir }, where || (f.repo ?? f.dir))),
      h('span.list-end', {}, isHere ? h('span.pill.floor-here', {}, 'Here') : floorStats(f)),
    );
    btn.addEventListener('click', () => {
      if (isHere) return;
      close();
      opts.go(f.id);
    });
    return btn;
  };

  const render = () => {
    const floors = store.floors;
    const here = floors.findIndex((f) => f.id === store.floor);
    const add = h(
      'button.list-row.floor-item.add',
      { type: 'button', role: 'menuitem', title: 'The elevator: add another project as a floor' },
      h('span.list-icon.floor-no', { 'aria-hidden': 'true' }, '＋'),
      h('span.list-main', {}, h('span.list-title', {}, 'Add a project'), h('span.list-meta', {}, 'Opens the elevator')),
    );
    add.addEventListener('click', () => {
      close();
      opts.elevator();
    });
    // Top floor first, the way a building's directory reads, and the roof over them.
    const items = floors.map((f, i) => item(f, i, here)).reverse();
    const onRoof = store.floor === ROOF;
    const roof = h(
      'button.list-row.floor-item',
      { type: 'button', role: 'menuitem', class: onRoof ? 'here on' : '', disabled: onRoof, title: onRoof ? "You're up on the roof" : 'Take the elevator up to the roof' },
      h('span.list-icon.floor-no.roof', { 'aria-hidden': 'true' }, '🍸'),
      h('span.list-main', {}, h('span.list-title', {}, ROOF_NAME), h('span.list-meta', {}, 'A DJ, drinks and the city')),
      h('span.list-end', {}, onRoof ? h('span.pill.floor-here', {}, 'Here') : null),
    );
    roof.addEventListener('click', () => {
      if (onRoof) return;
      close();
      opts.roof();
    });
    el.replaceChildren(
      h('div.floor-menu-head.eyebrow', {}, h('span.no', {}, String(floors.length)), `floor${floors.length === 1 ? '' : 's'}`),
      h('div.list.floor-menu-list', {}, ...(floors.length ? [roof] : []), ...items),
      h('div.floor-menu-foot', {}, add),
    );
  };

  const place = () => {
    const r = anchor.getBoundingClientRect();
    el.style.left = `${r.left}px`;
    el.style.top = `${r.bottom + 8}px`;
  };

  const onDown = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!el.contains(t) && !anchor.contains(t)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  const offs = [store.on('floors', render), store.on('floor', render)];
  const close = () => {
    if (current?.el !== el) return;
    current = null;
    el.remove();
    anchor.classList.remove('open');
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    for (const off of offs) off();
  };
  render();
  document.body.append(el);
  place();
  anchor.classList.add('open');
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  current = { el, close };
}
