import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isAgentEffort, type AgentEffort } from '../shared/protocol.js';
import { DROID_MODEL_MAX, isValidDroidModel } from './agents.js';
import { askDroid, DROID_LIST } from './droid-rpc.js';
import { isLabelEffort, type LabelEffort } from '../shared/worker-labels.js';

export const DROID_SETTINGS_PATH = path.join(homedir(), '.factory', 'settings.json');
const DROID_CATALOGUE_TTL_MS = 60_000;

/** A Droid model described by the selectable or read-only discovery catalogue. */
export interface DroidModelOption {
  id: string;
  /** The display name droid shows, or the id when nothing names it. */
  displayName: string;
  /** A BYOK model from the user's `customModels`. */
  custom?: true;
  /** Listed by Droid but switched off; exposed only through the full discovery catalogue. */
  disabled?: true;
  /** A model droid still runs but has replaced or deprecated. */
  legacy?: true;
  defaultReasoningEffort?: AgentEffort;
  supportedReasoningEfforts?: AgentEffort[];
  /** Full catalogue efforts for the sign writer, without broadening worker pins. */
  labelReasoningEfforts?: LabelEffort[];
  /** Who serves it, as droid says: anthropic, openai, google, factory… */
  provider?: string;
  /** Droid's credit multiplier: what a token costs against the base rate (0.5 is half). */
  tokenMultiplier?: number;
  /** It can't read images. */
  noImages?: true;
  /** A limited offer droid advertises on it ("50% off, launch discount"). */
  promo?: string;
}

export interface DroidModelCatalogue {
  /** Account-free operation: remembered Factory defaults and allowlists must not reintroduce hosted models. */
  customOnly?: true;
  /** Every selectable model: custom models first, then Factory's current models, then legacy ones. */
  models: DroidModelOption[];
  /** Droid-disabled entries retained for read-only discovery, never offered in hire pickers. */
  disabledModels?: DroidModelOption[];
  /** The global default model droid runs without an override, when settings names a valid one. */
  defaultModel?: string;
  defaultReasoningEffort?: AgentEffort;
}

/** Account-free discovery and execution use configured custom entries, never an id-prefix guess. */
export function customModelCatalogue(catalogue: DroidModelCatalogue): DroidModelCatalogue {
  const models = catalogue.models.filter((m) => m.custom);
  const validDefault = models.some((m) => m.id === catalogue.defaultModel);
  return {
    customOnly: true,
    models,
    ...(catalogue.disabledModels ? { disabledModels: catalogue.disabledModels.filter((m) => m.custom) } : {}),
    ...(validDefault ? { defaultModel: catalogue.defaultModel, defaultReasoningEffort: catalogue.defaultReasoningEffort } : {}),
  };
}

export function airgappedModelError(airgapped: boolean | undefined, model: string | undefined, catalogue: DroidModelCatalogue): string | undefined {
  if (!airgapped) return undefined;
  const id = model || catalogue.defaultModel;
  if (id && catalogue.models.some((m) => m.custom && m.id === id)) return undefined;
  return 'Airgapped mode requires a configured custom model. Add one to ~/.factory/settings.json (customModels), or connect DroidProxy, then choose it in Settings → Models.';
}

function effort(value: unknown): AgentEffort | undefined {
  return isAgentEffort(value) ? value : undefined;
}

/** The efforts a model takes that the office can pin; empty when it takes none of them (only `none`, say). */
function efforts(value: unknown): AgentEffort[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter(isAgentEffort))];
}

function displayName(value: unknown, id: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : id;
}

/**
 * Text for one line of what a lead reads (a provider, a promo, the owner's note on a model):
 * control characters and line breaks flattened to spaces, cut at `max`. Its words are still read by
 * the lead as written; they come from droid and from the owner's own Settings, both trusted.
 */
export function oneLine(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const flat = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  return flat ? flat.slice(0, max) : undefined;
}

function multiplier(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000 ? value : undefined;
}

/**
 * The models droid can run, from its own settings file: every `customModels` entry, plus the
 * session default and favorited built-in ids when settings names ones that aren't custom models
 * (built-ins like `glm-5.3-flash` never appear in `customModels`; stale `custom:*` ids that are no
 * longer in `customModels` are dropped). A bad id in an overlay silently runs the default model
 * instead, so only well-shaped ids are listed.
 */
const settingsCache = new Map<string, { stamp: string; value: DroidModelCatalogue }>();

export function readDroidModels(settingsPath: string = DROID_SETTINGS_PATH): DroidModelCatalogue {
  let stamp = '';
  try {
    const st = statSync(settingsPath);
    stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
    const cached = settingsCache.get(settingsPath);
    if (cached?.stamp === stamp) {
      return {
        models: cached.value.models.map((m) => ({ ...m, ...(m.supportedReasoningEfforts ? { supportedReasoningEfforts: [...m.supportedReasoningEfforts] } : {}) })),
        ...(cached.value.defaultModel ? { defaultModel: cached.value.defaultModel } : {}),
        ...(cached.value.defaultReasoningEffort ? { defaultReasoningEffort: cached.value.defaultReasoningEffort } : {}),
      };
    }
  } catch {
    settingsCache.delete(settingsPath);
    return { models: [] };
  }
  const models: DroidModelOption[] = [];
  const seen = new Set<string>();
  const add = (id: unknown, name?: unknown, fallback?: AgentEffort, supported?: AgentEffort[], custom = false) => {
    if (!isValidDroidModel(id) || id.length > DROID_MODEL_MAX || seen.has(id)) return;
    seen.add(id);
    models.push({
      id,
      displayName: displayName(name, id),
      ...(custom ? { custom: true as const } : {}),
      ...(fallback ? { defaultReasoningEffort: fallback } : {}),
      ...(supported ? { supportedReasoningEfforts: supported } : {}),
    });
  };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return { models };
  }
  if (!raw || typeof raw !== 'object') return { models };
  const custom = Array.isArray(raw.customModels) ? raw.customModels : [];
  for (const entry of custom) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    add(e.id, e.displayName, effort(e.defaultReasoningEffort) ?? effort(e.reasoningEffort), efforts(e.supportedReasoningEfforts), true);
  }
  const session = raw.sessionDefaultSettings as Record<string, unknown> | undefined;
  const rawDefault = isValidDroidModel(session?.model) ? (session.model as string) : undefined;
  const defaultModel = rawDefault && (!rawDefault.startsWith('custom:') || seen.has(rawDefault)) ? rawDefault : undefined;
  const defaultReasoningEffort = effort(session?.reasoningEffort);
  if (defaultModel) add(defaultModel);
  const favorites = Array.isArray(raw.modelFavorites) ? raw.modelFavorites : [];
  for (const fav of favorites) {
    if (typeof fav === 'string' && fav.startsWith('custom:')) continue;
    add(fav);
  }
  const result: DroidModelCatalogue = { models, ...(defaultModel ? { defaultModel } : {}), ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}) };
  if (stamp) {
    if (settingsCache.size >= 16) {
      const oldest = settingsCache.keys().next().value;
      if (oldest !== undefined) settingsCache.delete(oldest);
    }
    settingsCache.set(settingsPath, { stamp, value: result });
  }
  return result;
}

/**
 * Droid's own model list (`droid.list_models` results) as hire-dialog options: disabled models
 * dropped by default (retained for full discovery), efforts the office can't pin dropped, and custom models
 * first, then current Factory models, then legacy and deprecated ones.
 */
export function parseDroidModelList(list: unknown[], includeDisabled = false): DroidModelOption[] {
  const groups: [DroidModelOption[], DroidModelOption[], DroidModelOption[]] = [[], [], []];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (!isValidDroidModel(e.id) || seen.has(e.id) || (e.disabled === true && !includeDisabled)) continue;
    seen.add(e.id);
    const custom = e.isCustom === true;
    const legacy = !custom && (e.legacy === true || e.deprecated === true);
    const fallback = effort(e.defaultReasoningEffort);
    const supported = efforts(e.supportedReasoningEfforts);
    const provider = oneLine(e.modelProvider, 40);
    const tokenMultiplier = multiplier(e.tokenMultiplier);
    const promo = oneLine(e.promoLabel, 80);
    groups[custom ? 0 : legacy ? 2 : 1].push({
      id: e.id,
      displayName: displayName(e.displayName, e.id),
      ...(custom ? { custom: true as const } : {}),
      ...(e.disabled === true ? { disabled: true as const } : {}),
      ...(legacy ? { legacy: true as const } : {}),
      ...(fallback ? { defaultReasoningEffort: fallback } : {}),
      ...(supported ? { supportedReasoningEfforts: supported } : {}),
      ...(Array.isArray(e.supportedReasoningEfforts) ? { labelReasoningEfforts: [...new Set(e.supportedReasoningEfforts.filter(isLabelEffort))] } : {}),
      ...(provider ? { provider } : {}),
      ...(tokenMultiplier !== undefined ? { tokenMultiplier } : {}),
      ...(e.noImageSupport === true ? { noImages: true as const } : {}),
      ...(promo ? { promo } : {}),
    });
  }
  return groups.flat();
}

/** Asks droid for its models; resolves with the raw `models` array of the `droid.list_models` result. */
export type DroidModelLister = (command: string, cwd: string) => Promise<unknown[]>;

/**
 * `droid exec` in stream-jsonrpc mode answers `droid.list_models` without starting a session or
 * calling a model: it is the same list the droid CLI's model picker shows, built-in and custom.
 */
export const listDroidModels: DroidModelLister = async (command, cwd) => {
  const [result] = await askDroid(command, cwd, [DROID_LIST.models]);
  const models = (result as { models?: unknown } | undefined)?.models;
  if (!Array.isArray(models)) throw new Error('droid refused to list its models');
  return models;
};

export interface DroidCatalogueOptions {
  /** The droid binary to ask, or how to find it now (it may be installed after the office starts). */
  command?: string | (() => string);
  cwd?: string;
  settingsPath?: string;
  lister?: DroidModelLister;
  now?: () => number;
}

export interface DroidCatalogue {
  get(): Promise<DroidModelCatalogue>;
  /** The last catalogue already read, even after its refresh deadline; never starts a lookup. */
  peek(): DroidModelCatalogue | undefined;
  /** Drops the cached list, so the next get() asks droid again (Droid was installed, or DroidProxy rewrote its models). */
  forget(): void;
}

/**
 * Droid's full model list, falling back to what settings names when droid can't answer (an old
 * droid, or none on PATH). When droid answers, its list is authoritative: stale favorites and
 * retired/disabled ids in settings are never re-injected. Cached briefly: models change when the
 * user edits them, not mid-hire.
 */
export function createDroidModelCatalogue(options: DroidCatalogueOptions = {}): DroidCatalogue {
  const { command = 'droid', cwd = homedir(), settingsPath = DROID_SETTINGS_PATH, lister = listDroidModels, now = Date.now } = options;
  let cached: { catalogue: DroidModelCatalogue; expiresAt: number } | undefined;
  let pending: Promise<DroidModelCatalogue> | undefined;
  const load = async (): Promise<DroidModelCatalogue> => {
    const settings = readDroidModels(settingsPath);
    let listed: DroidModelOption[] = [];
    let disabled: DroidModelOption[] = [];
    let selectable = new Set<string>();
    try {
      const raw = await lister(typeof command === 'function' ? command() : command, cwd);
      listed = parseDroidModelList(raw);
      selectable = new Set(listed.map((m) => m.id));
      disabled = parseDroidModelList(raw, true).filter((m) => m.disabled && !selectable.has(m.id));
    } catch {
      // Settings alone are still a usable list.
    }
    const discovery = disabled.length ? { disabledModels: disabled } : {};
    if (!listed.length) {
      const disabledIds = new Set(disabled.map((m) => m.id));
      const models = disabledIds.size ? settings.models.filter((m) => !disabledIds.has(m.id)) : settings.models;
      const defaultModel = settings.defaultModel && !disabledIds.has(settings.defaultModel) ? settings.defaultModel : undefined;
      return {
        models,
        ...(defaultModel ? { defaultModel } : {}),
        ...(settings.defaultReasoningEffort ? { defaultReasoningEffort: settings.defaultReasoningEffort } : {}),
        ...discovery,
      };
    }
    const defaultModel = settings.defaultModel && selectable.has(settings.defaultModel) ? settings.defaultModel : undefined;
    return {
      models: listed,
      ...(defaultModel ? { defaultModel } : {}),
      ...(settings.defaultReasoningEffort ? { defaultReasoningEffort: settings.defaultReasoningEffort } : {}),
      ...discovery,
    };
  };
  return {
    peek: () => cached?.catalogue,
    get() {
      if (cached && now() < cached.expiresAt) return Promise.resolve(cached.catalogue);
      if (pending) return pending;
      pending = load()
        .then((catalogue) => {
          cached = { catalogue, expiresAt: now() + DROID_CATALOGUE_TTL_MS };
          return catalogue;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
    forget() {
      cached = undefined;
    },
  };
}
