import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isValidDroidModel } from './agents.js';

const MAX_HIDDEN_MODELS = 2000;

/** Office-wide picker preferences, independent of Droid settings and worker permissions. */
export class HiddenModels {
  private ids: string[] = [];
  private nativeHidden = false;
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'hidden-models.json');
    try {
      const saved: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (Array.isArray(saved)) {
        this.ids = [...new Set(saved.filter(isValidDroidModel))].slice(0, MAX_HIDDEN_MODELS);
      } else if (saved && typeof saved === 'object') {
        const raw = saved as { ids?: unknown; hideNative?: unknown };
        if (Array.isArray(raw.ids)) this.ids = [...new Set(raw.ids.filter(isValidDroidModel))].slice(0, MAX_HIDDEN_MODELS);
        this.nativeHidden = raw.hideNative === true;
      }
    } catch {
      // All models are shown until a preference has been saved.
    }
  }

  state(): string[] {
    return [...this.ids];
  }

  hideNative(): boolean {
    return this.nativeHidden;
  }

  private write(nextIds: string[], nextHideNative: boolean): string | undefined {
    const payload = nextHideNative ? { hideNative: true, ids: nextIds } : nextIds;
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(payload, null, 2), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      return 'Could not save hidden models. Your previous choices are unchanged.';
    }
    this.ids = nextIds;
    this.nativeHidden = nextHideNative;
  }

  /** Null with hidden=false restores every model. Change one id so concurrent devices don't overwrite each other. */
  set(id: unknown, hidden: unknown): string | undefined {
    if (typeof hidden !== 'boolean' || (id === null ? hidden : !isValidDroidModel(id))) return 'Choose a valid model and whether to hide it.';
    const next = id === null ? [] : hidden ? [...new Set([...this.ids, id as string])] : this.ids.filter((value) => value !== id);
    if (next.length > MAX_HIDDEN_MODELS) return `At most ${MAX_HIDDEN_MODELS} models can be hidden.`;
    return this.write(next, id === null ? false : this.nativeHidden);
  }

  /** Automatically hide every non-custom Factory model across office menus and pickers, keeping individual hidden ids intact. */
  setHideNative(hidden: unknown): string | undefined {
    if (typeof hidden !== 'boolean') return 'Choose whether to hide native Factory models.';
    return this.write(this.ids, hidden);
  }
}
