import { countHiddenModels } from '../../shared/model-visibility';
import type { Net } from '../net';
import { store } from '../state';
import { h } from './dom';
import { toggle } from './kit';
import { modelLogo } from './model-logo';
import { droidCatalogue, pickerModel, type DroidModelOption } from './models';

/** The desktop owns this list; picker results on every connected device follow it. */
export function hiddenModelSettings(net: Net, onHiddenCount?: (count: number | undefined) => void): { element: HTMLElement; dispose: () => void } {
  let models: DroidModelOption[] = [];
  let loading = true;
  let failed = false;
  let disposed = false;
  let loadedAirgapped = Boolean(store.setup.airgapped);
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
    const hideNative = store.hideNativeModels;
    const hiddenCount = countHiddenModels(models, store.hiddenModels, hideNative);
    onHiddenCount?.(loading || failed ? undefined : hiddenCount);
    const focused = list.contains(document.activeElement) ? document.activeElement?.id : undefined;
    const query = search.value.trim().toLowerCase();
    const matches = models.filter((m) => `${m.id} ${m.displayName} ${pickerModel(m).group} ${m.provider ?? ''}`.toLowerCase().includes(query));
    count.textContent = loading ? 'Loading models…' : failed ? 'Could not load models.' : `${models.length - hiddenCount} shown · ${hiddenCount} hidden`;
    all.disabled = loading || failed || (!hiddenCount && !hideNative);
    retry.classList.toggle('hidden', !failed);
    list.replaceChildren(
      ...matches.map((m) => {
        const shown = pickerModel(m);
        const autoHidden = hideNative && !m.custom;
        const control = toggle({
          id: `model-visibility-${m.id}`,
          label: `Show ${shown.name}`,
          bare: true,
          checked: !autoHidden && !hidden.has(m.id),
          disabled: autoHidden,
          onChange: (on) => void send(m.id, !on),
        });
        const meta = autoHidden ? `${shown.group} · ${m.id} · hidden with native Factory models` : `${shown.group} · ${m.id}`;
        return h('div.list-row', {}, modelLogo({ id: m.id, name: m.displayName, provider: m.provider }), h('div.list-main', {}, h('div.list-title', { title: shown.name }, shown.name), h('div.list-meta', { title: meta }, meta)), control);
      }),
      ...(matches.length ? [] : [h('p', {}, loading ? 'Loading Droid models…' : failed ? 'Could not load models. Retry to load the list.' : query ? 'No models match your search.' : 'No Droid models found.')]),
    );
    if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
  };
  async function load() {
    loadedAirgapped = Boolean(store.setup.airgapped);
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
  const offHidden = store.on('hiddenModels', paint);
  const offSetup = store.on('setup', () => {
    if (Boolean(store.setup.airgapped) !== loadedAirgapped) void load();
  });
  void load();
  return {
    element: h('div.stack.tight', {}, h('div.row', {}, search, all), h('div.row', {}, count, retry), error, list),
    dispose: () => {
      disposed = true;
      offHidden();
      offSetup();
    },
  };
}
