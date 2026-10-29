import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isLabelEffort, WORKER_LABEL_DEFAULTS, type WorkerLabelSettings } from '../shared/worker-labels.js';
import { isValidDroidModel } from './agents.js';

export function labelSettings(value: unknown): WorkerLabelSettings | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as WorkerLabelSettings;
  if (typeof v.on !== 'boolean' || !isValidDroidModel(v.model) || !isLabelEffort(v.effort) || !Number.isInteger(v.intervalSeconds) || v.intervalSeconds < 15 || v.intervalSeconds > 3600) return;
  return { on: v.on, model: v.model, effort: v.effort, intervalSeconds: v.intervalSeconds };
}

/** Office-wide, never written into Droid's own profile. */
export class WorkerLabelPreferences {
  private value: WorkerLabelSettings = { ...WORKER_LABEL_DEFAULTS };
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'worker-labels.json');
    try {
      this.value = labelSettings(JSON.parse(readFileSync(this.file, 'utf8'))) ?? this.value;
    } catch {
      // Missing or invalid preferences use the documented defaults.
    }
  }

  get(): WorkerLabelSettings {
    return { ...this.value };
  }

  set(value: unknown): string | undefined {
    const next = labelSettings(value);
    if (!next) return 'Choose a model, a supported effort, and a refresh interval from 15 to 3600 seconds.';
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      return 'Could not save worker labels. Your previous settings are unchanged.';
    }
    this.value = next;
  }
}
