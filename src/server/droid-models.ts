import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isAgentEffort, type AgentEffort } from '../shared/protocol.js';
import { DROID_MODEL_MAX, isValidDroidModel } from './agents.js';

export const DROID_SETTINGS_PATH = path.join(homedir(), '.factory', 'settings.json');
export const DROID_CATALOGUE_TTL_MS = 60_000;
export const DROID_LIST_TIMEOUT_MS = 20_000;
const DROID_LIST_MAX_OUTPUT = 4 * 1024 * 1024;

/** A Droid model the hire dialog can offer. */
export interface DroidModelOption {
  id: string;
  /** The display name droid shows, or the id when nothing names it. */
  displayName: string;
  /** A BYOK model from the user's `customModels`. */
  custom?: true;
  /** A model droid still runs but has replaced or deprecated. */
  legacy?: true;
  defaultReasoningEffort?: AgentEffort;
  supportedReasoningEfforts?: AgentEffort[];
}

export interface DroidModelCatalogue {
  /** Every selectable model: custom models first, then Factory's current models, then legacy ones. */
  models: DroidModelOption[];
  /** The global default model droid runs without an override, when settings names a valid one. */
  defaultModel?: string;
  defaultReasoningEffort?: AgentEffort;
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
 * The models droid can run, from its own settings file: every `customModels` entry, plus the
 * session default and favorited ids when settings names ones that aren't custom models (built-ins
 * like `glm-5.3-flash` never appear in `customModels`). A bad id in an overlay silently runs the
 * default model instead, so only well-shaped ids are listed.
 */
export function readDroidModels(settingsPath: string = DROID_SETTINGS_PATH): DroidModelCatalogue {
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
  const defaultModel = isValidDroidModel(session?.model) ? (session.model as string) : undefined;
  const defaultReasoningEffort = effort(session?.reasoningEffort);
  if (defaultModel) add(defaultModel);
  const favorites = Array.isArray(raw.modelFavorites) ? raw.modelFavorites : [];
  for (const fav of favorites) add(fav);
  return { models, ...(defaultModel ? { defaultModel } : {}), ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}) };
}

/**
 * Droid's own model list (`droid.list_models` results) as hire-dialog options: disabled models
 * dropped, efforts the office can't pin dropped (`off`, `none`, `minimal`), and custom models
 * first, then current Factory models, then legacy and deprecated ones.
 */
export function parseDroidModelList(list: unknown[]): DroidModelOption[] {
  const groups: [DroidModelOption[], DroidModelOption[], DroidModelOption[]] = [[], [], []];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (!isValidDroidModel(e.id) || seen.has(e.id) || e.disabled === true) continue;
    seen.add(e.id);
    const custom = e.isCustom === true;
    const legacy = !custom && (e.legacy === true || e.deprecated === true);
    const fallback = effort(e.defaultReasoningEffort);
    const supported = efforts(e.supportedReasoningEfforts);
    groups[custom ? 0 : legacy ? 2 : 1].push({
      id: e.id,
      displayName: displayName(e.displayName, e.id),
      ...(custom ? { custom: true as const } : {}),
      ...(legacy ? { legacy: true as const } : {}),
      ...(fallback ? { defaultReasoningEffort: fallback } : {}),
      ...(supported ? { supportedReasoningEfforts: supported } : {}),
    });
  }
  return groups.flat();
}

/** Asks droid for its models; resolves with the raw `models` array of the `droid.list_models` result. */
export type DroidModelLister = (command: string, cwd: string) => Promise<unknown[]>;

const LIST_REQUEST_ID = 'office-list-models';

/**
 * `droid exec` in stream-jsonrpc mode answers `droid.list_models` without starting a session or
 * calling a model: it is the same list the droid CLI's model picker shows, built-in and custom.
 */
export const listDroidModels: DroidModelLister = (command, cwd) =>
  new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, ['exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc'], { cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let buffered = '';
    let total = 0;
    let settled = false;
    const finish = (error: Error | undefined, models?: unknown[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (error) reject(error);
      else resolve(models ?? []);
    };
    const timer = setTimeout(() => finish(new Error('droid did not list its models in time')), DROID_LIST_TIMEOUT_MS);
    child.on('error', (err) => finish(err));
    child.on('close', () => finish(new Error('droid exited without listing its models')));
    child.stdin?.on('error', () => {});
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      total += chunk.length;
      if (total > DROID_LIST_MAX_OUTPUT) return finish(new Error('droid printed too much'));
      buffered += chunk;
      for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        let msg: { type?: unknown; id?: unknown; error?: unknown; result?: { models?: unknown } };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue;
        }
        if (msg?.type !== 'response' || msg.id !== LIST_REQUEST_ID) continue;
        const models = msg.result?.models;
        if (msg.error || !Array.isArray(models)) return finish(new Error('droid refused to list its models'));
        return finish(undefined, models);
      }
    });
    child.stdin?.end(`${JSON.stringify({ factoryApiVersion: '1.0.0', factoryProtocolVersion: '1.201.1', type: 'request', jsonrpc: '2.0', id: LIST_REQUEST_ID, method: 'droid.list_models', params: {} })}\n`);
  });

export interface DroidCatalogueOptions {
  /** The droid binary to ask. */
  command?: string;
  cwd?: string;
  settingsPath?: string;
  lister?: DroidModelLister;
  now?: () => number;
}

export interface DroidCatalogue {
  get(): Promise<DroidModelCatalogue>;
}

/**
 * Droid's full model list, falling back to what settings names when droid can't answer (an old
 * droid, or none on PATH). Settings still decide the default model, and any settings-only id
 * (a favorite droid no longer lists) stays offered. Cached briefly: models change when the user
 * edits them, not mid-hire.
 */
export function createDroidModelCatalogue(options: DroidCatalogueOptions = {}): DroidCatalogue {
  const { command = 'droid', cwd = homedir(), settingsPath = DROID_SETTINGS_PATH, lister = listDroidModels, now = Date.now } = options;
  let cached: { catalogue: DroidModelCatalogue; expiresAt: number } | undefined;
  let pending: Promise<DroidModelCatalogue> | undefined;
  const load = async (): Promise<DroidModelCatalogue> => {
    const settings = readDroidModels(settingsPath);
    let listed: DroidModelOption[] = [];
    try {
      listed = parseDroidModelList(await lister(command, cwd));
    } catch {
      // Settings alone are still a usable list.
    }
    if (!listed.length) return settings;
    const known = new Set(listed.map((m) => m.id));
    const extra = settings.models.filter((m) => !known.has(m.id));
    return { ...settings, models: [...listed.filter((m) => m.custom), ...extra, ...listed.filter((m) => !m.custom)] };
  };
  return {
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
  };
}
