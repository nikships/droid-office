import type { Net } from '../net';
import { store } from '../state';
import { h } from './dom';
import { toggle } from './kit';
import { modelLogo } from './model-logo';
import { droidCatalogue, pickerModel, type DroidModelOption } from './models';

/** The desktop owns this list; picker results on every connected device follow it. */
export function hiddenModelSettings(net: Net): { element: HTMLElement; dispose: () => void } {
  let models: DroidModelOption[] = [];
  let loading = true;
  let failed = false;
  let disposed = false;
  const search = h('input.input.grow', { type: 'search', placeholder: 'Search models or providers…', 'aria-label': 'Search model visibility' });
  const count = h('small', { role: 'status' });
  const error = h('p.field-error', { hidden: true });
  const list = h('div.list.boxed.model-visibility-list', { 'aria-label': 'Models shown in pickers' });
  const send = async (id: string | null, hidden: boolean) => {
    const result = await net.request({ t: 'models.hide', id, hidden });
    if (disposed) return;
    error.hidden = result.ok;
    error.textContent = result.ok ? '' : (result.error ?? 'Could not save model visibility.');
    if (!result.ok) paint();
  };
  const all = h('button.btn.sm', { type: 'button', onclick: () => void send(null, false) }, 'Show all');
  const retry = h('button.btn.sm.hidden', { type: 'button', onclick: () => void load() }, 'Retry');
  const paint = () => {
    if (disposed) return;
    const hidden = new Set(store.hiddenModels);
    const focused = list.contains(document.activeElement) ? document.activeElement?.id : undefined;
    const knownIds = new Set(models.map((m) => m.id));
    const source: DroidModelOption[] = [...models, ...store.hiddenModels.filter((id) => !knownIds.has(id)).map((id) => ({ id, displayName: id }))];
    const query = search.value.trim().toLowerCase();
    const matches = source.filter((m) => `${m.id} ${m.displayName} ${pickerModel(m).group} ${m.provider ?? ''}`.toLowerCase().includes(query));
    count.textContent = loading ? 'Loading models…' : `${source.length - hidden.size} shown · ${hidden.size} hidden`;
    all.disabled = !hidden.size;
    retry.classList.toggle('hidden', !failed);
    list.replaceChildren(
      ...matches.map((m) => {
        const shown = pickerModel(m);
        const control = toggle({ id: `model-visibility-${m.id}`, label: `Show ${shown.name}`, bare: true, checked: !hidden.has(m.id), onChange: (on) => void send(m.id, !on) });
        return h(
          'div.list-row',
          {},
          modelLogo({ id: m.id, name: m.displayName, provider: m.provider }),
          h('div.list-main', {}, h('div.list-title', { title: shown.name }, shown.name), h('div.list-meta', { title: m.id }, `${shown.group} · ${m.id}`)),
          control,
        );
      }),
      ...(matches.length ? [] : [h('p', {}, loading ? 'Loading Droid models…' : failed ? 'Could not load models. Retry to load the list.' : query ? 'No models match your search.' : 'No Droid models found.')]),
    );
    if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
  };
  async function load() {
    loading = true;
    failed = false;
    paint();
    try {
      models = (await droidCatalogue()).models;
    } catch {
      failed = true;
    }
    loading = false;
    paint();
  }
  search.addEventListener('input', paint);
  const off = store.on('hiddenModels', paint);
  void load();
  return {
    element: h('div.stack.tight', {}, h('div.row', {}, search, all), h('div.row', {}, count, retry), error, list),
    dispose: () => {
      disposed = true;
      off();
    },
  };
}
