import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isLabelEffort, WORKER_LABEL_DEFAULTS, type WorkerLabelSettings } from '../shared/worker-labels.js';
import { isValidDroidModel } from './agents.js';

export function labelSettings(value: unknown): WorkerLabelSettings | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as WorkerLabelSettings;
  if (typeof v.on !== 'boolean' || !isValidDroidModel(v.model) || !isLabelEffort(v.effort) || !Number.isInteger(v.intervalSeconds) || v.intervalSeconds < 15 || v.intervalSeconds > 3600) return;
  if (v.implementation !== undefined && v.implementation !== 'droid' && v.implementation !== 'custom') return;
  const base = { on: v.on, model: v.model, effort: v.effort, intervalSeconds: v.intervalSeconds };
  if (v.implementation !== 'custom') return base;
  if (typeof v.command !== 'string' || !path.isAbsolute(v.command) || v.command.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(v.command)) return;
  const args = v.args ?? [];
  if (!Array.isArray(args) || args.length > 32 || args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(arg))) return;
  return { ...base, implementation: 'custom', command: v.command, args: [...args] };
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
    return { ...this.value, ...(this.value.args ? { args: [...this.value.args] } : {}) };
  }

  set(value: unknown): string | undefined {
    const next = labelSettings(value);
    if (!next) return 'Choose a model, effort, and refresh interval from 15 to 3600 seconds. Custom scripts need an absolute executable path and an array of arguments.';
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      return 'Could not save worker labels. Your previous settings are unchanged.';
    }
    this.value = next;
  }
}
