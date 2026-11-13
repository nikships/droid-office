import {
  LABEL_EFFORTS,
  OPENAI_LABEL_EFFORTS,
  parseLabelEndpointUrl,
  sameEndpointOrigin,
  WORKER_LABEL_DEFAULTS,
  WORKER_LABEL_ENDPOINT_PRESETS,
  type LabelEffort,
  type OpenAiLabelEffort,
  type WorkerLabelSettings,
} from '../../shared/worker-labels';
import { AIRGAPPED_REASON } from '../../shared/setup';
import type { Net } from '../net';
import { store } from '../state';
import { h } from './dom';
import { field, toggle } from './kit';
import { modelPicker } from './model-picker';
import { droidCatalogue, pickerModel, type DroidModelOption } from './models';

const DEFAULT_MODEL_PLACEHOLDER = 'gpt-4.1-mini, llama3.2, qwen2.5:7b…';

function formatEffortLabel(value: string): string {
  return value === 'xhigh' ? 'Extra high' : value[0].toUpperCase() + value.slice(1);
}

export function workerLabelSettings(net: Net): { element: HTMLElement; dispose: () => void } {
  let models: DroidModelOption[] = [];
  let disposed = false;
  let saving = false;
  let testing = false;
  let dirty = false;
  let keyCleared = false;
  let saved = JSON.stringify(store.workerLabels.settings);

  const error = h('p.field-error', { role: 'alert', hidden: true });
  const testNote = h('p.note.good.hidden', { role: 'status' });
  const status = h('p.field-hint', { role: 'status' });
  const modeNote = h('p.note.info', {}, AIRGAPPED_REASON, ' Use an OpenAI-compatible endpoint for worker labels.');
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
    h('option', { value: 'openai' }, 'OpenAI-compatible endpoint'),
  );

  // ---- Droid built-in model controls (untouched behavior) ----
  const effort = h('select.select', { 'aria-label': 'Worker label reasoning effort', onchange: () => changed() });
  const picker = modelPicker({
    label: 'Worker label model',
    models: [],
    value: store.workerLabels.settings.implementation === 'openai' ? WORKER_LABEL_DEFAULTS.model : store.workerLabels.settings.model,
    allowCustom: false,
    onChange: () => {
      efforts();
      changed();
    },
  });
  const droidFields = h('div.stack.tight', {}, field('Label model', picker.element), field('Reasoning effort', effort, 'Droid offers supported efforts only.'));

  // ---- OpenAI-compatible endpoint controls ----
  const baseUrl = h('input.input', {
    type: 'url',
    spellcheck: false,
    autocomplete: 'off',
    'aria-label': 'Worker label endpoint URL',
    placeholder: 'http://localhost:11434/v1 or https://api.openai.com/v1',
    oninput: () => changed(),
  });
  const urlHint = h('p.field-hint');
  const presetButtons = WORKER_LABEL_ENDPOINT_PRESETS.map((preset) =>
    h(
      'button.chip',
      {
        type: 'button',
        onclick: () => {
          if (saving || testing) return;
          baseUrl.value = preset.baseUrl;
          changed();
          if (preset.needsKey && !apiKey.value.trim() && !keepingSavedKey()) apiKey.focus();
          else if (!endpointModel.value.trim()) endpointModel.focus();
        },
      },
      preset.label,
    ),
  );
  const presetRow = h('div.chips', { 'aria-label': 'Common endpoint presets' }, ...presetButtons);

  const endpointModel = h('input.input', {
    type: 'text',
    spellcheck: false,
    autocomplete: 'off',
    'aria-label': 'Worker label endpoint model slug',
    placeholder: DEFAULT_MODEL_PLACEHOLDER,
    oninput: () => changed(),
  });

  const apiKey = h('input.input', {
    type: 'password',
    spellcheck: false,
    autocomplete: 'off',
    'aria-label': 'Worker label endpoint API key',
    placeholder: 'Optional for localhost · Bearer token',
    oninput: () => {
      if (apiKey.value) keyCleared = false;
      changed();
    },
  });
  const clearKey = h(
    'button.btn.ghost.hidden',
    {
      type: 'button',
      onclick: () => {
        keyCleared = true;
        apiKey.value = '';
        changed();
      },
    },
    'Clear key',
  );
  const apiKeyHint = h('p.field-hint');
  const apiKeyControl = h('div.input-group', {}, apiKey, clearKey);

  const endpointEffort = h(
    'select.select',
    { 'aria-label': 'Endpoint reasoning effort', onchange: () => changed() },
    h('option', { value: '' }, 'Provider default (don’t send)'),
    ...OPENAI_LABEL_EFFORTS.map((value) => h('option', { value }, formatEffortLabel(value))),
  );

  const urlField = field('Endpoint URL', baseUrl);
  urlField.append(presetRow, urlHint);
  const apiKeyField = h('div.field', {}, h('label', { for: (apiKey.id = `${urlField.querySelector('input')?.id ?? 'wl'}-key`) }, 'API key'), apiKeyControl, apiKeyHint);

  const endpointFields = h(
    'div.stack.tight',
    {},
    urlField,
    field('Model slug', endpointModel, 'Exact model ID your endpoint expects (for example gpt-4.1-nano, llama3.2, or openai/gpt-4.1-mini).'),
    apiKeyField,
    field('Reasoning effort', endpointEffort, 'Omitted by default so standard chat models work out of the box. Choose one only if your reasoning model expects reasoning_effort.'),
  );

  const interval = h('input.input', { type: 'number', min: 15, max: 3600, step: 1, 'aria-label': 'Worker label refresh seconds', oninput: () => changed() });
  const save = h('button.btn.primary', { type: 'button', disabled: true, onclick: () => void submit() }, 'Save');
  const testBtn = h('button.btn.hidden', { type: 'button', onclick: () => void runTest() }, 'Test endpoint');
  const retry = h('button.btn.sm.hidden', { type: 'button', onclick: () => void load() }, 'Reload models');
  const reset = h(
    'button.btn.ghost',
    {
      type: 'button',
      onclick: () => {
        sync();
        dirty = false;
        error.hidden = true;
        testNote.classList.add('hidden');
        paint();
      },
    },
    'Cancel',
  );

  function keepingSavedKey(): boolean {
    const s = store.workerLabels.settings;
    return !!s.hasApiKey && !keyCleared && !apiKey.value.trim() && sameEndpointOrigin(s.baseUrl, baseUrl.value);
  }

  function changed() {
    dirty = true;
    error.hidden = true;
    testNote.classList.add('hidden');
    paint();
  }

  function mode() {
    const openai = implementation.value === 'openai';
    droidFields.classList.toggle('hidden', openai);
    endpointFields.classList.toggle('hidden', !openai);
    testBtn.classList.toggle('hidden', !openai);
    retry.classList.toggle('hidden', openai || models.length > 0);
  }

  function efforts(want?: string) {
    const selected = models.find((m) => m.id === picker.value());
    const supported: readonly string[] = selected?.labelReasoningEfforts ?? selected?.supportedReasoningEfforts ?? [];
    const values = LABEL_EFFORTS.filter((value) => supported.includes(value));
    effort.replaceChildren(...values.map((value) => h('option', { value }, formatEffortLabel(value))));
    effort.value = want && values.includes(want as LabelEffort) ? want : (values[0] ?? '');
    effort.disabled = !values.length || saving || testing;
  }

  function paintEndpointDetails() {
    const rawUrl = baseUrl.value.trim();
    const parsed = rawUrl ? parseLabelEndpointUrl(rawUrl) : null;
    const activePreset = parsed && !('error' in parsed) ? WORKER_LABEL_ENDPOINT_PRESETS.find((p) => parseLabelEndpointUrl(p.baseUrl) && sameEndpointOrigin(p.baseUrl, parsed.baseUrl) && parsed.baseUrl === p.baseUrl) : undefined;
    for (let i = 0; i < WORKER_LABEL_ENDPOINT_PRESETS.length; i++) {
      const p = WORKER_LABEL_ENDPOINT_PRESETS[i];
      const match = !!parsed && !('error' in parsed) && parsed.baseUrl === p.baseUrl;
      presetButtons[i].classList.toggle('on', match);
      presetButtons[i].setAttribute('aria-pressed', String(match));
      presetButtons[i].disabled = saving || testing;
    }
    endpointModel.placeholder = activePreset?.modelPlaceholder ?? DEFAULT_MODEL_PLACEHOLDER;
    if (!rawUrl) {
      urlHint.textContent = 'Paste a base URL or full completions URL — localhost, LAN/Tailscale, Ollama, LM Studio, OpenAI, OpenRouter, vLLM…';
    } else if (parsed && !('error' in parsed)) {
      urlHint.textContent = `Requests POST ${parsed.completionsUrl}`;
    } else if (parsed && 'error' in parsed) {
      urlHint.textContent = parsed.error;
    }
    const savedKeyActive = keepingSavedKey();
    apiKey.placeholder = savedKeyActive ? 'Saved · type a new key to replace' : 'Optional for localhost · Bearer token';
    clearKey.classList.toggle('hidden', !savedKeyActive);
    clearKey.disabled = saving || testing;
    apiKeyHint.textContent = savedKeyActive
      ? 'API key saved on this computer (never sent back to browsers). Leave blank to keep it.'
      : keyCleared
        ? 'Saved API key will be removed when you press Save.'
        : 'Sent as Authorization: Bearer. Leave blank for local servers that need no key.';
  }

  function sync() {
    const settings = store.workerLabels.settings;
    saved = JSON.stringify(settings);
    on.input.checked = settings.on;
    implementation.value = settings.implementation ?? 'droid';
    keyCleared = false;
    apiKey.value = '';
    if (settings.implementation === 'openai') {
      baseUrl.value = settings.baseUrl ?? '';
      endpointModel.value = settings.model;
      endpointEffort.value = settings.endpointEffort ?? '';
    } else {
      picker.set(settings.model);
    }
    interval.value = String(settings.intervalSeconds);
    mode();
    efforts(settings.effort);
    paintEndpointDetails();
  }

  function setControlsDisabled(disabled: boolean) {
    reset.disabled = disabled;
    implementation.disabled = disabled;
    baseUrl.disabled = endpointModel.disabled = apiKey.disabled = endpointEffort.disabled = disabled;
    interval.disabled = disabled;
    effort.disabled = disabled || !effort.options.length;
  }

  function paint() {
    if (disposed) return;
    const busy = saving || testing;
    modeNote.classList.toggle('hidden', !store.setup.airgapped);
    const hosted = !!store.setup.airgapped && implementation.value !== 'openai';
    const hostedOption = implementation.querySelector<HTMLOptionElement>('option[value=droid]');
    if (hostedOption) hostedOption.disabled = !!store.setup.airgapped;
    on.input.disabled = busy || hosted;
    picker.setDisabled(busy || !!store.setup.airgapped);
    save.disabled = busy || !dirty || (hosted && on.input.checked);
    testBtn.disabled = busy;
    paintEndpointDetails();

    const state = store.workerLabels;
    const next = JSON.stringify(state.settings);
    if (saved !== next && !dirty && !busy) sync();
    status.textContent = !state.settings.on
      ? 'Off. Existing labels are kept.'
      : (state.error ??
        (state.running || state.queued
          ? `${state.running} generating · ${state.queued} waiting across all floors`
          : state.updatedAt
            ? `Last label updated ${new Date(state.updatedAt).toLocaleTimeString()}. Only changed conversations are refreshed.`
            : state.settings.implementation === 'openai'
              ? 'Waiting for a local Droid conversation. Calls your configured OpenAI-compatible endpoint directly.'
              : 'Waiting for a local Droid conversation. Requires the Office Factory API key.'));
  }

  function buildPayload(requireEndpointFields: boolean): WorkerLabelSettings | undefined {
    const secs = Number(interval.value);
    if (!Number.isInteger(secs) || secs < 15 || secs > 3600) {
      error.textContent = 'Enter a refresh interval from 15 to 3600 seconds.';
      error.hidden = false;
      interval.focus();
      return;
    }
    const openai = implementation.value === 'openai';
    if (openai) {
      const parsed = parseLabelEndpointUrl(baseUrl.value);
      if ('error' in parsed) {
        error.textContent = requireEndpointFields || on.input.checked ? parsed.error : `${parsed.error} (Or switch Implementation back to Droid to turn labels off.)`;
        error.hidden = false;
        baseUrl.focus();
        return;
      }
      const slug = endpointModel.value.trim();
      if (!slug) {
        error.textContent = 'Enter the model slug your endpoint expects (for example gpt-4.1-mini or llama3.2).';
        error.hidden = false;
        endpointModel.focus();
        return;
      }
      const typedKey = apiKey.value.trim();
      const keyField = typedKey ? { apiKey: typedKey } : keyCleared ? { apiKey: '' } : {};
      const selectedEffort = endpointEffort.value as OpenAiLabelEffort | '';
      return {
        on: on.input.checked,
        implementation: 'openai',
        baseUrl: parsed.baseUrl,
        ...keyField,
        ...(selectedEffort ? { endpointEffort: selectedEffort } : {}),
        model: slug,
        effort: store.workerLabels.settings.effort,
        intervalSeconds: secs,
      };
    }
    return {
      on: on.input.checked,
      model: picker.value(),
      effort: (effort.value || store.workerLabels.settings.effort) as LabelEffort,
      intervalSeconds: secs,
    };
  }

  async function runTest() {
    const settings = buildPayload(true);
    if (!settings) return;
    testing = true;
    error.hidden = true;
    testNote.classList.add('hidden');
    testBtn.textContent = 'Testing…';
    setControlsDisabled(true);
    paint();
    const result = await net.request({ t: 'workerLabels.test', settings }, 20_000);
    if (disposed) return;
    testing = false;
    testBtn.textContent = 'Test endpoint';
    setControlsDisabled(false);
    if (result.ok) {
      testNote.textContent = result.note ?? 'Connected · the endpoint returned a valid worker label.';
      testNote.classList.remove('hidden');
      error.hidden = true;
    } else {
      testNote.classList.add('hidden');
      error.textContent = result.error ?? 'Endpoint test failed.';
      error.hidden = false;
    }
    paint();
  }

  async function submit() {
    const settings = buildPayload(false);
    if (!settings) return;
    saving = true;
    error.hidden = true;
    testNote.classList.add('hidden');
    save.textContent = 'Saving…';
    setControlsDisabled(true);
    paint();
    const result = await net.request({ t: 'workerLabels.set', settings });
    if (disposed) return;
    saving = false;
    save.textContent = 'Save';
    setControlsDisabled(false);
    dirty = !result.ok;
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
      if (implementation.value !== 'openai') {
        error.textContent = 'Could not load Droid models. Reload to try again.';
        error.hidden = false;
        retry.classList.remove('hidden');
      }
    }
  }

  sync();
  paint();
  const off = store.on('workerLabels', paint);
  const offMode = store.on('setup', paint);
  void load();
  return {
    element: h(
      'div.stack.tight',
      {},
      on,
      modeNote,
      field('Implementation', implementation),
      droidFields,
      endpointFields,
      field('Refresh interval (seconds)', interval, 'Default: 60. Only visible user and assistant text that changed is sent, with a final update after a turn. Up to 24,000 recent characters plus the previous subject.'),
      h(
        'p.field-hint',
        {},
        'No tool calls, tool results, thinking, hooks or attachments are input. The Droid implementation uses Factory credits and an isolated temporary profile. OpenAI-compatible endpoints are called directly with no Droid install or Factory key required.',
      ),
      status,
      testNote,
      error,
      h('div.row.wrap', {}, save, testBtn, reset, retry),
    ),
    dispose: () => {
      disposed = true;
      picker.close();
      off();
      offMode();
    },
  };
}
