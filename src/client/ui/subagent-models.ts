import { SUBAGENT_MODEL_NOTE_MAX, type SubagentModel } from '../../shared/protocol';
import { withoutGlyph } from '../world/glyph';
import { h } from './dom';
import { droidCatalogue, droidDisplayName, multiplierLabel, type DroidModelOption } from './models';

export interface SubagentModelPicker {
  element: HTMLElement;
  /** Shows what the office has saved, unless the owner is part way through changing it. */
  paint(saved: SubagentModel[] | undefined): void;
}

/** What a model costs and can do, in one line under its name. */
function facts(m: DroidModelOption | undefined, id: string): string {
  if (!m) return `${id} · droid doesn't list it now`;
  const cost = m.custom ? 'own API key, no Factory credits' : m.tokenMultiplier !== undefined ? `${multiplierLabel(m.tokenMultiplier)} credits` : '';
  return [id, m.provider, cost, m.noImages ? 'no images' : '', m.legacy ? 'legacy' : '', m.promo].filter(Boolean).join(' · ');
}

/**
 * ⚙️ Settings → Subagents: a checkbox for every model droid lists, cheapest first, and a note for
 * each one picked that the Team lead reads in `office-workers models` when it chooses one.
 * Nothing picked lets leads run any model.
 */
export function subagentModelPicker(save: (models: SubagentModel[] | undefined) => void): SubagentModelPicker {
  /** Picked ids, in the order they were picked, with their notes. */
  let picked = new Map<string, string>();
  let saved: SubagentModel[] | undefined;
  let touched = false;
  let models: DroidModelOption[] = [];
  let loaded: 'loading' | 'ok' | 'failed' = 'loading';

  const filter = h('input.input.sub-models-filter', { type: 'search', placeholder: 'Filter by name, id or provider', 'aria-label': 'Filter models' }) as HTMLInputElement;
  const count = h('small.sub-models-count');
  const list = h('ul.list.boxed.sub-models', { 'aria-label': 'Models leads can pick' });
  const saveBtn = h('button.btn.sm.primary', { type: 'button' }, 'Save');
  const anyBtn = h('button.btn.sm', { type: 'button' }, 'Allow any model');
  const revert = h('button.btn.sm.ghost', { type: 'button' }, 'Undo changes');

  const same = () => JSON.stringify([...picked].map(([id, note]) => ({ id, ...(note.trim() ? { note: note.trim() } : {}) }))) === JSON.stringify(saved ?? []);
  const paintButtons = () => {
    const changed = !same();
    saveBtn.toggleAttribute('disabled', !changed);
    revert.classList.toggle('hidden', !changed);
    anyBtn.classList.toggle('hidden', !saved?.length && !picked.size);
    const total = models.length;
    count.textContent = loaded === 'loading' ? 'Loading Droid models…' : picked.size ? `${picked.size} picked${total ? ` of ${total}` : ''}` : loaded === 'failed' ? 'Model list unavailable' : `None picked: leads can run any of ${total}`;
  };

  const row = (id: string, m: DroidModelOption | undefined) => {
    const on = picked.has(id);
    const box = h('input', { type: 'checkbox', checked: on, 'aria-label': `Let leads pick ${m?.displayName ?? id}` }) as HTMLInputElement;
    const note = h('input.input.sub-model-note', {
      type: 'text',
      maxlength: SUBAGENT_MODEL_NOTE_MAX,
      placeholder: 'What it’s good for, for the lead (optional): “cheap, fine for tests and docs”',
      'aria-label': `Note on ${m?.displayName ?? id}`,
      class: on ? '' : 'hidden',
    }) as HTMLInputElement;
    note.value = picked.get(id) ?? '';
    box.addEventListener('change', () => {
      touched = true;
      if (box.checked) picked.set(id, note.value);
      else picked.delete(id);
      note.classList.toggle('hidden', !box.checked);
      li.classList.toggle('on', box.checked);
      if (box.checked) note.focus();
      paintButtons();
    });
    note.addEventListener('input', () => {
      touched = true;
      picked.set(id, note.value);
      paintButtons();
    });
    const name = withoutGlyph(m?.displayName ?? droidDisplayName(id));
    const li = h(
      'li.list-row.sub-model',
      { class: on ? 'on' : '' },
      h(
        'label.sub-model-pick',
        { title: id },
        h('span.list-icon', {}, box),
        h('span.list-main', {}, h('span.list-title', {}, name), h('span.list-meta', {}, facts(m, id))),
        !m?.custom && m?.tokenMultiplier !== undefined ? h('span.list-end', {}, multiplierLabel(m.tokenMultiplier)) : null,
      ),
      note,
    );
    return li;
  };

  const paintList = () => {
    const want = filter.value.trim().toLowerCase();
    const known = new Set(models.map((m) => m.id));
    // The saved picks on top, then own-key models, then cheapest first; one picked that droid no
    // longer lists stays visible. Rows reorder only on a repaint, never under the pointer mid-pick.
    const rank = (m: DroidModelOption) => (m.custom ? -1 : (m.tokenMultiplier ?? Number.POSITIVE_INFINITY));
    const sorted = [...models].sort((a, b) => Number(picked.has(b.id)) - Number(picked.has(a.id)) || Number(!!a.legacy) - Number(!!b.legacy) || rank(a) - rank(b));
    const rows: [string, DroidModelOption | undefined][] = [...[...picked.keys()].filter((id) => !known.has(id)).map((id): [string, undefined] => [id, undefined]), ...sorted.map((m): [string, DroidModelOption] => [m.id, m])];
    const shown = rows.filter(([id, m]) => !want || [id, m?.displayName, m?.provider].some((s) => s?.toLowerCase().includes(want)));
    list.replaceChildren(...(shown.length ? shown.map(([id, m]) => row(id, m)) : [h('li.list-row.sub-model', {}, h('span.list-meta', {}, loaded === 'loading' ? 'Loading Droid models…' : 'No model matches.'))]));
    paintButtons();
  };

  const reset = () => {
    touched = false;
    picked = new Map((saved ?? []).map((m) => [m.id, m.note ?? '']));
    paintList();
  };

  filter.addEventListener('input', paintList);
  saveBtn.addEventListener('click', () => {
    touched = false;
    const next = [...picked].map(([id, note]) => ({ id, ...(note.trim() ? { note: note.trim() } : {}) }));
    save(next.length ? next : undefined);
  });
  anyBtn.addEventListener('click', () => {
    touched = false;
    picked = new Map();
    save(undefined);
    paintList();
  });
  revert.addEventListener('click', reset);

  void droidCatalogue()
    .then((c) => {
      models = c.models;
      loaded = 'ok';
    })
    .catch(() => {
      loaded = 'failed';
    })
    .finally(paintList);

  return {
    element: h('div.stack.tight.sub-models-picker', {}, h('div.row', {}, filter, count), list, h('div.row', {}, saveBtn, anyBtn, revert)),
    paint(next) {
      saved = next?.map((m) => ({ ...m }));
      if (!touched) reset();
      else paintButtons();
    },
  };
}
