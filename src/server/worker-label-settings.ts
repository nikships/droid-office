import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isLabelEffort, isOpenAiLabelEffort, parseLabelEndpointUrl, sameEndpointOrigin, WORKER_LABEL_DEFAULTS, type WorkerLabelSettings } from '../shared/worker-labels.js';
import { DROID_MODEL_MAX, isValidDroidModel } from './agents.js';

export interface ResolvedWorkerLabelSettings {
  settings: WorkerLabelSettings;
  apiKey?: string;
}

function isValidEndpointModel(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= DROID_MODEL_MAX && !/[\p{Cc}\p{Cf}]/u.test(trimmed);
}

export function resolveLabelSettings(value: unknown, previous?: { settings: WorkerLabelSettings; apiKey?: string }): ResolvedWorkerLabelSettings | { error: string } {
  if (!value || typeof value !== 'object') {
    return { error: 'Choose a model, effort, and refresh interval from 15 to 3600 seconds.' };
  }
  const v = value as WorkerLabelSettings;
  if (typeof v.on !== 'boolean' || !isLabelEffort(v.effort) || !Number.isInteger(v.intervalSeconds) || v.intervalSeconds < 15 || v.intervalSeconds > 3600) {
    return { error: 'Choose a refresh interval from 15 to 3600 seconds and a valid reasoning effort.' };
  }
  if (v.implementation !== undefined && v.implementation !== 'droid' && v.implementation !== 'openai') {
    return { error: 'Choose Droid or OpenAI-compatible endpoint.' };
  }
  if (v.implementation !== 'openai') {
    if (!isValidDroidModel(v.model)) return { error: 'Choose an available Droid label model.' };
    return { settings: { on: v.on, model: v.model, effort: v.effort, intervalSeconds: v.intervalSeconds } };
  }
  const parsed = parseLabelEndpointUrl(v.baseUrl);
  if ('error' in parsed) return { error: parsed.error };
  if (!isValidEndpointModel(v.model)) {
    return { error: 'Enter the model slug your endpoint expects (1–256 characters, no control characters).' };
  }
  if (v.endpointEffort !== undefined && !isOpenAiLabelEffort(v.endpointEffort)) {
    return { error: 'Choose Provider default or a supported reasoning effort.' };
  }
  let apiKey: string | undefined;
  if (v.apiKey !== undefined) {
    if (typeof v.apiKey !== 'string' || v.apiKey.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(v.apiKey)) {
      return { error: 'Enter a valid API key without control characters.' };
    }
    const trimmedKey = v.apiKey.trim();
    apiKey = trimmedKey || undefined;
  } else if (previous?.settings.implementation === 'openai' && sameEndpointOrigin(previous.settings.baseUrl, parsed.baseUrl)) {
    apiKey = previous.apiKey;
  }
  const model = v.model.trim();
  return {
    settings: {
      on: v.on,
      implementation: 'openai',
      baseUrl: parsed.baseUrl,
      hasApiKey: !!apiKey,
      ...(v.endpointEffort ? { endpointEffort: v.endpointEffort } : {}),
      model,
      effort: v.effort,
      intervalSeconds: v.intervalSeconds,
    },
    ...(apiKey ? { apiKey } : {}),
  };
}

export function labelSettings(value: unknown): WorkerLabelSettings | undefined {
  const resolved = resolveLabelSettings(value);
  return 'error' in resolved ? undefined : resolved.settings;
}

/** Office-wide, never written into Droid's own profile. API keys stay on disk (0600) and are never returned to clients. */
export class WorkerLabelPreferences {
  private value: WorkerLabelSettings = { ...WORKER_LABEL_DEFAULTS };
  private savedApiKey?: string;
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'worker-labels.json');
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { implementation?: unknown } | null;
      if (raw && typeof raw === 'object' && raw.implementation === 'custom') {
        // Legacy custom-script settings stay off on upgrade rather than falling back to billed Factory calls.
        this.value = { ...WORKER_LABEL_DEFAULTS, on: false };
        return;
      }
      const resolved = resolveLabelSettings(raw);
      if (!('error' in resolved)) {
        this.value = resolved.settings;
        this.savedApiKey = resolved.apiKey;
      }
    } catch {
      // Missing or invalid preferences use the documented defaults.
    }
  }

  get(): WorkerLabelSettings {
    return { ...this.value };
  }

  apiKey(): string | undefined {
    return this.savedApiKey;
  }

  resolve(value: unknown): ResolvedWorkerLabelSettings | { error: string } {
    return resolveLabelSettings(value, { settings: this.value, apiKey: this.savedApiKey });
  }

  set(value: unknown): string | undefined {
    const resolved = this.resolve(value);
    if ('error' in resolved) return resolved.error;
    const { hasApiKey: _hasApiKey, ...diskSettings } = resolved.settings;
    const persisted = { ...diskSettings, ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}) };
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(persisted, null, 2), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      return 'Could not save worker labels. Your previous settings are unchanged.';
    }
    this.value = resolved.settings;
    this.savedApiKey = resolved.apiKey;
  }
}
