import { LABEL_EFFORTS, type LabelEffort, type WorkerLabelSettings } from '../../shared/worker-labels';
import type { Net } from '../net';
import { store } from '../state';
import { h } from './dom';
import { field, toggle } from './kit';
import { modelPicker } from './model-picker';
import { droidCatalogue, pickerModel, type DroidModelOption } from './models';

export function workerLabelSettings(net: Net): { element: HTMLElement; dispose: () => void } {
  let models: DroidModelOption[] = [];
  let disposed = false;
  let saving = false;
  let dirty = false;
  let saved = JSON.stringify(store.workerLabels.settings);
  const error = h('p.field-error', { role: 'alert', hidden: true });
  const status = h('p.field-hint', { role: 'status' });
  const on = toggle({ label: 'Generate worker labels', checked: store.workerLabels.settings.on, onChange: () => changed() });
  const effort = h('select.select', { 'aria-label': 'Worker label reasoning effort', onchange: () => changed() });
  const interval = h('input.input', { type: 'number', min: 15, max: 3600, step: 1, 'aria-label': 'Worker label refresh seconds', oninput: () => changed() });
  const picker = modelPicker({
    label: 'Worker label model',
    models: [],
    value: store.workerLabels.settings.model,
    allowCustom: false,
    onChange: () => {
      efforts();
      changed();
    },
  });
  const save = h('button.btn.primary', { type: 'button', disabled: true, onclick: () => void submit() }, 'Save');
  const retry = h('button.btn.sm.hidden', { type: 'button', onclick: () => void load() }, 'Reload models');
  const reset = h(
    'button.btn.ghost',
    {
      type: 'button',
      onclick: () => {
        sync();
        dirty = false;
        save.disabled = true;
      },
    },
    'Cancel',
  );

  function changed() {
    dirty = true;
    save.disabled = saving;
    error.hidden = true;
  }
  function efforts(want?: string) {
    const selected = models.find((m) => m.id === picker.value());
    const supported: readonly string[] = selected?.labelReasoningEfforts ?? selected?.supportedReasoningEfforts ?? [];
    const values = LABEL_EFFORTS.filter((value) => supported.includes(value));
    effort.replaceChildren(...values.map((value) => h('option', { value }, value === 'xhigh' ? 'Extra high' : value[0].toUpperCase() + value.slice(1))));
    effort.value = want && values.includes(want as LabelEffort) ? want : (values[0] ?? '');
    effort.disabled = !values.length || saving;
  }
  function sync() {
    const settings = store.workerLabels.settings;
    on.input.checked = settings.on;
    picker.set(settings.model);
    interval.value = String(settings.intervalSeconds);
    efforts(settings.effort);
  }
  function paint() {
    if (disposed) return;
    const state = store.workerLabels;
    const next = JSON.stringify(state.settings);
    if (saved !== next) {
      saved = next;
      if (!dirty) sync();
    }
    status.textContent = !state.settings.on
      ? 'Off. Existing labels are kept.'
      : (state.error ??
        (state.running || state.queued
          ? `${state.running} generating · ${state.queued} waiting across all floors`
          : state.updatedAt
            ? `Last label updated ${new Date(state.updatedAt).toLocaleTimeString()}. Only changed conversations are refreshed.`
            : 'Waiting for a local Droid conversation. Requires the Office Factory API key.'));
  }
  async function submit() {
    saving = true;
    save.disabled = true;
    save.textContent = 'Saving…';
    reset.disabled = true;
    on.input.disabled = true;
    picker.setDisabled(true);
    effort.disabled = true;
    interval.disabled = true;
    const settings: WorkerLabelSettings = { on: on.input.checked, model: picker.value(), effort: (effort.value || store.workerLabels.settings.effort) as LabelEffort, intervalSeconds: Number(interval.value) };
    const result = await net.request({ t: 'workerLabels.set', settings });
    if (disposed) return;
    saving = false;
    save.textContent = 'Save';
    reset.disabled = false;
    on.input.disabled = false;
    picker.setDisabled(false);
    effort.disabled = !effort.options.length;
    interval.disabled = false;
    dirty = !result.ok;
    save.disabled = result.ok;
    error.hidden = result.ok;
    error.textContent = result.ok ? '' : (result.error ?? 'Could not save worker labels.');
    if (result.ok) sync();
    paint();
  }
  async function load() {
    retry.classList.add('hidden');
    try {
      models = (await droidCatalogue()).models;
      if (disposed) return;
      picker.setModels(models.filter((m) => (m.labelReasoningEfforts ?? m.supportedReasoningEfforts)?.length).map(pickerModel));
      if (!dirty) sync();
      else efforts(effort.value);
    } catch {
      if (disposed) return;
      error.textContent = 'Could not load Droid models. Reload to try again.';
      error.hidden = false;
      retry.classList.remove('hidden');
    }
  }
  sync();
  paint();
  const off = store.on('workerLabels', paint);
  void load();
  return {
    element: h(
      'div.stack.tight',
      {},
      h('p.field-hint', {}, 'A stable task subject and a one-line current-work summary for every Office-managed local Droid, including leads and subagents. Uses Factory credits. No cloud workers, guests or shells.'),
      on,
      field('Label model', picker.element),
      field('Reasoning effort', effort, 'Starts at the lowest supported effort when you change models.'),
      field('Refresh interval (seconds)', interval, 'Default: 60. Only visible user and assistant text that changed is sent, with a final update after a turn. Up to 24,000 recent characters plus the previous subject.'),
      h('p.field-hint', {}, 'No tool calls, tool results, thinking, hooks or attachments are used. The sign writer has an isolated, temporary Droid profile, not your project or personal configuration.'),
      status,
      error,
      h('div.row', {}, save, reset, retry),
    ),
    dispose: () => {
      disposed = true;
      picker.close();
      off();
    },
  };
}
