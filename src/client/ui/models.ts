import type { AgentChoice, AgentEffort } from '../../shared/protocol';
import { AGENT_EFFORTS } from '../../shared/protocol';
import { withoutGlyph } from '../world/glyph';
import { store } from '../state';
import { withToken } from '../token';
import { h } from './dom';

export const EFFORT_LABEL: Record<AgentEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** A Droid model the office can offer, from droid's own model list (GET /api/agents/droid/models). */
export interface DroidModelOption {
  id: string;
  displayName: string;
  /** A BYOK model from the user's own Droid settings. */
  custom?: boolean;
  /** Replaced or deprecated, but droid still runs it. */
  legacy?: boolean;
  /** What this model runs when nobody picks an effort. */
  defaultReasoningEffort?: AgentEffort;
  /** The efforts the model takes, when droid says (empty: none the office can pin); the fixed list otherwise. */
  supportedReasoningEfforts?: AgentEffort[];
}

/** The catalogue's groups, in the order the server sends them: your own models, Factory's, then the old ones. */
export function droidModelGroups(models: DroidModelOption[]): { label: string; models: DroidModelOption[] }[] {
  const groups = [
    { label: 'Your models', models: models.filter((m) => m.custom) },
    { label: 'Factory', models: models.filter((m) => !m.custom && !m.legacy) },
    { label: 'Legacy', models: models.filter((m) => !m.custom && m.legacy) },
  ];
  return groups.filter((g) => g.models.length);
}

const MODEL_MAX = 256;

/** The catalogue of Droid models, as /api/agents/droid/models answers it. */
interface Catalogue {
  models: DroidModelOption[];
  defaultModel?: string;
  defaultReasoningEffort?: AgentEffort;
}

let catalogue: Catalogue | null = null;
let catalogueAt = 0;
let request: Promise<Catalogue> | null = null;

function asEffort(value: unknown): AgentEffort | undefined {
  return AGENT_EFFORTS.includes(value as AgentEffort) ? (value as AgentEffort) : undefined;
}

function asEfforts(value: unknown): AgentEffort[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.map(asEffort).filter((e): e is AgentEffort => !!e))];
}

function fetchCatalogue(): Promise<Catalogue> {
  if (catalogue && Date.now() - catalogueAt < 60_000) return Promise.resolve(catalogue);
  if (request) return request;
  request = fetch(withToken('/api/agents/droid/models'), { credentials: 'same-origin', cache: 'no-store' })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { models?: unknown; defaultModel?: unknown; defaultReasoningEffort?: unknown };
      const models = Array.isArray(body.models)
        ? body.models.flatMap((m): DroidModelOption[] => {
            if (!m || typeof m !== 'object') return [];
            const { id, displayName, custom, legacy, defaultReasoningEffort, supportedReasoningEfforts } = m as Record<string, unknown>;
            if (typeof id !== 'string' || !id || id.length > MODEL_MAX || /[\s\p{Cc}\p{Cf}]/u.test(id)) return [];
            return [
              {
                id,
                displayName: typeof displayName === 'string' && displayName ? displayName : id,
                ...(custom === true ? { custom: true } : {}),
                ...(legacy === true ? { legacy: true } : {}),
                ...(defaultReasoningEffort ? { defaultReasoningEffort: asEffort(defaultReasoningEffort) } : {}),
                ...(supportedReasoningEfforts ? { supportedReasoningEfforts: asEfforts(supportedReasoningEfforts) } : {}),
              },
            ];
          })
        : [];
      catalogue = {
        models,
        ...(typeof body.defaultModel === 'string' && body.defaultModel ? { defaultModel: body.defaultModel } : {}),
        ...(body.defaultReasoningEffort ? { defaultReasoningEffort: asEffort(body.defaultReasoningEffort) } : {}),
      };
      catalogueAt = Date.now();
      return catalogue;
    })
    .finally(() => {
      request = null;
    });
  return request;
}

/** Droid's own models (Factory's, not the owner's BYOK ones), for a session on a Factory computer. */
export function factoryModels(): Promise<DroidModelOption[]> {
  return fetchCatalogue().then((c) => c.models.filter((m) => !m.custom && !m.legacy));
}

/**
 * A Droid model id as the office shows it: its display name when the catalogue has loaded, else the id
 * tidied up ("custom:droidproxy:opus-5-5" is "DroidProxy: Opus 5.5"). The "DroidProxy" stays in so
 * cards and lists can draw it as the Factory pinwheel (see world/glyph.ts).
 */
export function droidDisplayName(id: string): string {
  const known = catalogue?.models.find((m) => m.id === id)?.displayName;
  if (known) return known;
  // Any droidproxy provider segment ("custom:droidproxy:…", "custom:droidproxy-2:…") is a DroidProxy model.
  const proxy = /(?:^|:)droidproxy[\w.-]*:/i.exec(id);
  const bare = proxy ? id.slice(proxy.index + proxy[0].length) : id.replace(/^custom:(?:[^:]+:)?/, '');
  const name = bare
    .replace(/^claude-/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/(\d) (?=\d)/g, '$1.')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return proxy ? `DroidProxy: ${name}` : name;
}

/** A short badge for the task card / sidebar: "Opus 5.5", "Opus 5.5 · High", or nothing chosen. */
export function modelBadge(model: string | undefined, effort: AgentEffort | undefined): string | undefined {
  const parts = [model ? droidDisplayName(model) : undefined, effort ? EFFORT_LABEL[effort] : undefined].filter((v): v is string => !!v);
  return parts.length ? parts.join(' · ') : undefined;
}

/** Remembers the last model/effort chosen at a picker's key (a desk, or the queue). */
const choiceKey = (kind: 'model' | 'effort', key: string) => `droid-office.droid-${kind}.${key}`;

function rememberedModel(key: string): string | undefined {
  try {
    const saved = localStorage.getItem(choiceKey('model', key));
    if (saved && !/[\s\p{Cc}\p{Cf}]/u.test(saved)) return saved;
  } catch {
    // storage blocked
  }
  return undefined;
}

function rememberedEffort(key: string): AgentEffort | undefined {
  try {
    const saved = localStorage.getItem(choiceKey('effort', key));
    if (saved && (AGENT_EFFORTS as readonly string[]).includes(saved)) return saved as AgentEffort;
  } catch {
    // storage blocked
  }
  return undefined;
}

/**
 * What a picker remembered at `key` starts on, for hiring without showing one (an issue card
 * dropped on a desk): that key's model and effort.
 */
export function rememberedChoice(key: string): AgentChoice {
  const model = rememberedModel(key);
  const effort = rememberedEffort(key);
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/** The office's default worker as set in Settings, on Droid's own default model when nobody set one. */
export function officeChoice(): AgentChoice {
  const picked = store.prompts.agent;
  return { ...(picked?.model ? { model: picked.model } : {}), ...(picked?.effort ? { effort: picked.effort } : {}) };
}

export interface AgentFields {
  element: HTMLElement;
  model(): string | undefined;
  effort(): AgentEffort | undefined;
  /** Puts the fields on this model and effort. */
  set(choice: AgentChoice): void;
  choice(): AgentChoice;
}

/**
 * The model and effort a new worker runs on, from the Droid catalogue. `key` scopes what gets
 * remembered between hires — a desk id for the hire dialog, or a fixed key like "queue" for the
 * queue's add form — so a desk that always got Opus offers Opus again next time, without one hire
 * changing another's.
 */
export function agentPicker(id: string, key = id): AgentFields {
  return buildFields(id, key, rememberedModel(key), rememberedEffort(key), officeChoice);
}

/** The same fields, started on `initial` and remembering nothing: the office's default worker in Settings. */
export function agentFields(id: string, initial: AgentChoice): AgentFields {
  return buildFields(id, undefined, initial.model, initial.effort, () => ({}));
}

/**
 * `fallback` is what "Default" runs besides Droid's own settings. A hire with no model picked gets
 * the office's default worker from the server, so its picker has to name that one, not Droid's.
 */
function buildFields(id: string, key: string | undefined, initialModel: string | undefined, initialEffort: AgentEffort | undefined, fallback: () => AgentChoice): AgentFields {
  const modelSelect = h('select.select.model-select', { id, 'aria-label': 'Droid model' }) as HTMLSelectElement;
  const effortSelect = h('select.select.effort-select', { id: `${id}-effort`, 'aria-label': 'Reasoning effort' }) as HTMLSelectElement;
  const hint = h('small.model-hint', {}, 'Loading Droid models…');
  const remember = (kind: 'model' | 'effort', value: string) => {
    if (key === undefined) return;
    try {
      if (value) localStorage.setItem(choiceKey(kind, key), value);
      else localStorage.removeItem(choiceKey(kind, key));
    } catch {
      // storage blocked
    }
  };
  /** The model the fields are on, as the user last picked it while the catalogue loads. */
  let wantedModel = initialModel;
  let wantedEffort = initialEffort;

  /** The model "Default" runs: the office's default worker, else Droid's own default. */
  const defaultModel = () => fallback().model ?? catalogue?.defaultModel;
  /** The model picked, or the one droid runs on "Default". */
  const pickedModel = () => catalogue?.models.find((x) => x.id === (modelSelect.value || defaultModel()));
  /** The efforts to offer: the model's own list, else its default plus the fixed ladder. */
  const effortOptions = (): AgentEffort[] => {
    const m = pickedModel();
    if (m?.supportedReasoningEfforts) return m.supportedReasoningEfforts;
    if (m?.defaultReasoningEffort) return [m.defaultReasoningEffort, ...AGENT_EFFORTS.filter((e) => e !== m.defaultReasoningEffort)];
    return [...AGENT_EFFORTS];
  };
  /** Only the efforts the picked model takes, its own default named on "Default". */
  const applyEfforts = () => {
    const options = effortOptions();
    const runs = (!modelSelect.value && (fallback().effort ?? catalogue?.defaultReasoningEffort)) || pickedModel()?.defaultReasoningEffort;
    effortSelect.replaceChildren(h('option', { value: '' }, runs ? `Default (${EFFORT_LABEL[runs]})` : 'Default'), ...options.map((e) => h('option', { value: e }, EFFORT_LABEL[e])));
    effortSelect.value = wantedEffort && options.includes(wantedEffort) ? wantedEffort : '';
    effortSelect.disabled = !options.length;
  };

  const fill = () => {
    const selected = wantedModel;
    hint.textContent = catalogue ? 'Overrides the office default for this worker; pinned in its Droid settings overlay.' : 'Loading Droid models…';
    void fetchCatalogue()
      .then(({ models }) => {
        const runs = defaultModel();
        modelSelect.replaceChildren(
          h('option', { value: '' }, runs ? `Default (${withoutGlyph(droidDisplayName(runs))})` : 'Default (Droid settings)'),
          ...droidModelGroups(models).map((g) => h('optgroup', { label: `${g.label} (${g.models.length})` }, ...g.models.map((m) => h('option', { value: m.id }, withoutGlyph(m.displayName))))),
        );
        // A remembered id the catalogue no longer lists is still offered, so the choice isn't silently dropped.
        if (selected && !models.some((m) => m.id === selected)) modelSelect.append(h('option', { value: selected }, `${withoutGlyph(droidDisplayName(selected))} (unavailable)`));
        modelSelect.value = selected ?? '';
        hint.textContent = models.length ? 'Overrides the office default for this worker; pinned in its Droid settings overlay.' : 'No Droid models found in the office settings — the worker runs the global default.';
        applyEfforts();
      })
      .catch(() => {
        modelSelect.replaceChildren(h('option', { value: '' }, 'Default (Droid settings)'));
        if (selected) {
          modelSelect.append(h('option', { value: selected }, withoutGlyph(droidDisplayName(selected))));
          modelSelect.value = selected;
        }
        hint.textContent = 'Model list unavailable; the worker runs the global default.';
        applyEfforts();
      });
  };
  modelSelect.addEventListener('change', () => {
    wantedModel = modelSelect.value || undefined;
    remember('model', modelSelect.value);
    applyEfforts();
  });
  effortSelect.addEventListener('change', () => {
    wantedEffort = effortSelect.value ? (effortSelect.value as AgentEffort) : undefined;
    remember('effort', effortSelect.value);
  });
  fill();
  return {
    element: h('div.model-choice', {}, h('label.model-label', { for: id }, 'Model'), modelSelect, h('label.effort-label', { for: `${id}-effort` }, 'Effort'), effortSelect, hint),
    model: () => modelSelect.value || undefined,
    effort: () => (effortSelect.value ? (effortSelect.value as AgentEffort) : undefined),
    set: (choice) => {
      wantedModel = choice.model;
      wantedEffort = choice.effort;
      fill();
    },
    choice: () => ({ ...(modelSelect.value ? { model: modelSelect.value } : {}), ...(effortSelect.value ? { effort: effortSelect.value as AgentEffort } : {}) }),
  };
}
