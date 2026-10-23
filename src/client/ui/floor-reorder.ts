import type { Net } from '../net';
import { store } from '../state';
import { claimEscape, h, openModal, toast } from './dom';
import { windowHeader } from './kit';

export function floorDragHandle(name: string): HTMLButtonElement {
  return h('button.btn.icon.ghost.floor-drag', { type: 'button', 'data-floor-drag': '', 'aria-label': `Reorder ${name}`, title: 'Drag to reorder. Arrow keys move this floor.' }, '⠿');
}

/** Pointer events work with a mouse, pen and touch, unlike native HTML drag-and-drop. */
export function floorReorder(list: HTMLElement, net: Net, reversed = false): () => void {
  let drag: { id: string; pointer: number; start: number; x: number; y: number; active: boolean; before?: string | null } | undefined;
  let frame = 0;
  let keyboardFocus = '';
  const rows = () => [...list.querySelectorAll<HTMLElement>('[data-floor-id]')];
  const clearMarks = () => {
    for (const row of rows()) row.classList.remove('floor-dragging', 'floor-drop-before', 'floor-drop-after');
  };
  const cancel = () => {
    cancelAnimationFrame(frame);
    const pointer = drag?.pointer;
    drag = undefined;
    try {
      if (pointer !== undefined && list.hasPointerCapture(pointer)) list.releasePointerCapture(pointer);
    } catch {
      // A released pointer or detached list has nothing left to capture.
    }
    clearMarks();
  };
  const save = (id: string, before: string | null) => {
    const ids = store.floors.map((f) => f.id);
    const at = ids.indexOf(id);
    if (at < 0 || ids[at + 1] === (before ?? undefined)) return;
    void net.request({ t: 'floor.reorder', floor: id, before }).then((result) => {
      if (!result.ok) toast(result.error ?? "Couldn't reorder floors.", 'warn');
    });
  };
  let scroller: HTMLElement = list;
  const tick = () => {
    if (!drag?.active) return;
    clearMarks();
    const bounds = list.getBoundingClientRect();
    const scroll = scroller.getBoundingClientRect();
    const top = Math.max(bounds.top, scroll.top);
    const bottom = Math.min(bounds.bottom, scroll.bottom);
    drag.before = undefined;
    if (drag.x >= bounds.left && drag.x <= bounds.right && drag.y >= top - 32 && drag.y <= bottom + 32) {
      scroller.scrollTop += drag.y < top + 32 ? -8 : drag.y > bottom - 32 ? 8 : 0;
      const rest = rows().filter((r) => r.dataset.floorId !== drag?.id);
      const at = rest.findIndex((r) => drag!.y < r.getBoundingClientRect().top + r.getBoundingClientRect().height / 2);
      const index = at < 0 ? rest.length : at;
      const marker = rest[index] ?? rest.at(-1);
      marker?.classList.add(index < rest.length ? 'floor-drop-before' : 'floor-drop-after');
      const ids = rest.map((r) => r.dataset.floorId!);
      ids.splice(index, 0, drag.id);
      if (reversed) ids.reverse();
      drag.before = ids[ids.indexOf(drag.id) + 1] ?? null;
    }
    rows()
      .find((r) => r.dataset.floorId === drag?.id)
      ?.classList.add('floor-dragging');
    frame = requestAnimationFrame(tick);
  };
  const down = (e: PointerEvent) => {
    if (e.button !== 0 || !e.isPrimary || drag) return;
    const handle = (e.target as Element).closest('[data-floor-drag]');
    const row = handle?.closest<HTMLElement>('[data-floor-id]');
    if (!row || !list.contains(row)) return;
    e.preventDefault();
    scroller = list;
    while (scroller.parentElement && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    keyboardFocus = '';
    drag = { id: row.dataset.floorId!, pointer: e.pointerId, start: e.clientY, x: e.clientX, y: e.clientY, active: false };
    try {
      list.setPointerCapture(e.pointerId);
    } catch {
      cancel();
    }
  };
  const move = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.active && Math.abs(drag.y - drag.start) > 4) {
      drag.active = true;
      tick();
    }
  };
  const up = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    cancelAnimationFrame(frame);
    tick();
    const { id, active, before } = drag;
    cancel();
    if (active && before !== undefined) save(id, before);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && drag) {
      e.preventDefault();
      e.stopImmediatePropagation();
      cancel();
      return;
    }
    const handle = (e.target as Element).closest('[data-floor-drag]');
    const id = handle?.closest<HTMLElement>('[data-floor-id]')?.dataset.floorId;
    if (!id || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const ids = rows().map((r) => r.dataset.floorId!);
    const from = ids.indexOf(id);
    const to = from + (e.key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= ids.length) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    if (reversed) ids.reverse();
    keyboardFocus = id;
    save(id, ids[ids.indexOf(id) + 1] ?? null);
  };
  let order = store.floors.map((f) => f.id).join('\n');
  const off = store.on('floors', () => {
    const next = store.floors.map((f) => f.id).join('\n');
    if (next !== order) cancel();
    order = next;
    const focus = keyboardFocus;
    keyboardFocus = '';
    if (focus)
      queueMicrotask(() => {
        if (document.activeElement === document.body || list.contains(document.activeElement))
          rows()
            .find((r) => r.dataset.floorId === focus)
            ?.querySelector<HTMLElement>('[data-floor-drag]')
            ?.focus();
      });
  });
  const unclaim = claimEscape(list, () => {
    if (!drag) return false;
    cancel();
    return true;
  });
  list.addEventListener('pointerdown', down);
  list.addEventListener('pointermove', move);
  list.addEventListener('pointerup', up);
  list.addEventListener('pointercancel', cancel);
  list.addEventListener('lostpointercapture', cancel);
  list.addEventListener('keydown', key);
  return () => {
    cancel();
    off();
    unclaim();
    list.removeEventListener('pointerdown', down);
    list.removeEventListener('pointermove', move);
    list.removeEventListener('pointerup', up);
    list.removeEventListener('pointercancel', cancel);
    list.removeEventListener('lostpointercapture', cancel);
    list.removeEventListener('keydown', key);
  };
}

export function openFloorOrder(net: Net): void {
  const list = h('div.list.boxed.floor-order-list', { 'aria-label': 'Floor order' });
  const render = () =>
    list.replaceChildren(
      ...store.floors.map((f, i) =>
        h('div.list-row.floor-reorder-row', { 'data-floor-id': f.id }, floorDragHandle(f.name), h('span.list-main', {}, h('span.list-title', { title: f.name }, f.name)), h('span.key', {}, i < 10 ? `⌘${(i + 1) % 10}` : String(i + 1))),
      ),
    );
  const dispose = floorReorder(list, net);
  const off = store.on('floors', render);
  const modal = openModal(h('div.modal', {}, windowHeader('Reorder floors', 'Drag the handles. Floor numbers and Command shortcuts change for every device.'), h('div.body', {}, list)), {
    onClose: () => {
      dispose();
      off();
    },
  });
  render();
  modal.el.querySelector<HTMLElement>('[data-floor-drag]')?.focus();
}
