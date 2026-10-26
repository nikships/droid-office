import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isValidDroidModel } from './agents.js';

const MAX_HIDDEN_MODELS = 2000;

/** Office-wide picker preferences, independent of Droid settings and worker permissions. */
export class HiddenModels {
  private ids: string[] = [];
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'hidden-models.json');
    try {
      const saved: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (Array.isArray(saved)) this.ids = [...new Set(saved.filter(isValidDroidModel))].slice(0, MAX_HIDDEN_MODELS);
    } catch {
      // All models are shown until a preference has been saved.
    }
  }

  state(): string[] {
    return [...this.ids];
  }

  /** Null with hidden=false restores every model. Change one id so concurrent devices don't overwrite each other. */
  set(id: unknown, hidden: unknown): string | undefined {
    if (typeof hidden !== 'boolean' || (id === null ? hidden : !isValidDroidModel(id))) return 'Choose a valid model and whether to hide it.';
    const next = id === null ? [] : hidden ? [...new Set([...this.ids, id as string])] : this.ids.filter((value) => value !== id);
    if (next.length > MAX_HIDDEN_MODELS) return `At most ${MAX_HIDDEN_MODELS} models can be hidden.`;
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      return 'Could not save hidden models. Your previous choices are unchanged.';
    }
    this.ids = next;
  }
}
