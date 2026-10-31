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
  const implementation = h(
    'select.select',
    {
      'aria-label': 'Worker label implementation',
      onchange: () => {
        mode();
        efforts();
        changed();
      },
    },
    h('option', { value: 'droid' }, 'Droid (Factory API key)'),
    h('option', { value: 'custom' }, 'Custom script (bring your own)'),
  );
  const command = h('input.input', { 'aria-label': 'Worker label executable path', placeholder: '/absolute/path/to/executable', oninput: () => changed() });
  const args = h('input.input', { 'aria-label': 'Worker label arguments', placeholder: '["/absolute/path/to/script.mjs"]', oninput: () => changed() });
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
  const customPicker = modelPicker({
    label: 'Custom worker label model',
    models: [],
    value: store.workerLabels.settings.model,
    allowCustom: true,
    placeholder: 'Type the model ID your script accepts',
    onChange: () => changed(),
  });
  const droidField = field('Label model', picker.element);
  const customFields = h(
    'div.stack.tight',
    {},
    field('Executable path', command, 'Absolute path on the Office host. Use an executable script or an interpreter such as Node. No shell expansion.'),
    field('Arguments (JSON array)', args, 'Literal arguments, for example ["/absolute/path/to/script.mjs"]. Keep API keys in your script’s environment or a private file, not here.'),
    field('Model ID passed to your script', customPicker.element),
    h(
      'p.field-hint',
      {},
      'Contract v1: one JSON request on stdin (version, system, conversation, previousSubject, model, effort), then EOF. Write only {"name":"Task subject","summary":"Current work"} to stdout and exit 0 within 45 seconds. Combined stdout/stderr limit: 64 KiB.',
    ),
    h('p.field-hint', {}, 'Only run scripts you trust. They run as you, inherit the Office process environment and use their own credentials. This is not a sandbox. No Droid install or Factory key is required.'),
  );
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
  function mode() {
    const custom = implementation.value === 'custom';
    droidField.classList.toggle('hidden', custom);
    customFields.classList.toggle('hidden', !custom);
    retry.classList.toggle('hidden', custom || models.length > 0);
  }
  function efforts(want?: string) {
    const selected = models.find((m) => m.id === picker.value());
    const supported: readonly string[] = implementation.value === 'custom' ? LABEL_EFFORTS : (selected?.labelReasoningEfforts ?? selected?.supportedReasoningEfforts ?? []);
    const values = LABEL_EFFORTS.filter((value) => supported.includes(value));
    effort.replaceChildren(...values.map((value) => h('option', { value }, value === 'xhigh' ? 'Extra high' : value[0].toUpperCase() + value.slice(1))));
    effort.value = want && values.includes(want as LabelEffort) ? want : (values[0] ?? '');
    effort.disabled = !values.length || saving;
  }
  function sync() {
    const settings = store.workerLabels.settings;
    on.input.checked = settings.on;
    implementation.value = settings.implementation ?? 'droid';
    command.value = settings.command ?? '';
    args.value = JSON.stringify(settings.args ?? []);
    picker.set(settings.model);
    customPicker.set(settings.model);
    interval.value = String(settings.intervalSeconds);
    mode();
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
            : state.settings.implementation === 'custom'
              ? 'Waiting for a local Droid conversation. Your script uses its own credentials.'
              : 'Waiting for a local Droid conversation. Requires the Office Factory API key.'));
  }
  async function submit() {
    let argumentsValue: unknown;
    if (implementation.value === 'custom') {
      try {
        argumentsValue = JSON.parse(args.value || '[]');
        if (!Array.isArray(argumentsValue) || argumentsValue.some((v) => typeof v !== 'string')) throw new Error();
      } catch {
        error.textContent = 'Arguments must be a JSON array of strings.';
        error.hidden = false;
        return;
      }
    }
    const settings: WorkerLabelSettings = {
      on: on.input.checked,
      model: implementation.value === 'custom' ? customPicker.value() : picker.value(),
      effort: (effort.value || store.workerLabels.settings.effort) as LabelEffort,
      intervalSeconds: Number(interval.value),
      ...(implementation.value === 'custom' ? { implementation: 'custom' as const, command: command.value, args: argumentsValue as string[] } : {}),
    };
    saving = true;
    save.disabled = true;
    save.textContent = 'Saving…';
    reset.disabled = true;
    on.input.disabled = true;
    picker.setDisabled(true);
    customPicker.setDisabled(true);
    implementation.disabled = command.disabled = args.disabled = true;
    effort.disabled = true;
    interval.disabled = true;
    const result = await net.request({ t: 'workerLabels.set', settings });
    if (disposed) return;
    saving = false;
    save.textContent = 'Save';
    reset.disabled = false;
    on.input.disabled = false;
    picker.setDisabled(false);
    customPicker.setDisabled(false);
    implementation.disabled = command.disabled = args.disabled = false;
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
      mode();
    } catch {
      if (disposed) return;
      if (implementation.value !== 'custom') {
        error.textContent = 'Could not load Droid models. Reload to try again.';
        error.hidden = false;
        retry.classList.remove('hidden');
      }
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
      on,
      field('Implementation', implementation),
      droidField,
      customFields,
      field('Reasoning effort', effort, 'Droid offers supported efforts only. Custom scripts receive this value literally and must validate it for their provider.'),
      field('Refresh interval (seconds)', interval, 'Default: 60. Only visible user and assistant text that changed is sent, with a final update after a turn. Up to 24,000 recent characters plus the previous subject.'),
      h(
        'p.field-hint',
        {},
        'No tool calls, tool results, thinking, hooks or attachments are input. The Droid implementation uses Factory credits and an isolated temporary profile. Custom scripts control their own implementation and billing.',
      ),
      status,
      error,
      h('div.row', {}, save, reset, retry),
    ),
    dispose: () => {
      disposed = true;
      picker.close();
      customPicker.close();
      off();
    },
  };
}
