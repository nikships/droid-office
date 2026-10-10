import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface SwitchState {
  on: boolean;
  /** Who set it, and when. Unset for the default. */
  by?: string;
  at?: number;
}

/**
 * An on/off setting in ⚙️ Settings that anyone can flip, the same on every floor, kept in a file in
 * the office's .droid-office folder.
 */
export class SavedSwitch {
  private saved?: Required<SwitchState>;
  private path: string;

  constructor(
    dataDir: string,
    file: string,
    /** What it is until someone sets it. */
    private fallback: boolean,
    private onState: (state: SwitchState) => void,
  ) {
    this.path = path.join(dataDir, file);
    this.restore();
  }

  get on(): boolean {
    return this.saved?.on ?? this.fallback;
  }

  state(): SwitchState {
    return this.saved ? { ...this.saved } : { on: this.fallback };
  }

  set(on: boolean, by: string) {
    this.saved = { on, by, at: Date.now() };
    this.persist();
    this.onState(this.state());
  }

  private restore() {
    try {
      const s = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<SwitchState>;
      if (typeof s.on === 'boolean') this.saved = { on: s.on, by: typeof s.by === 'string' ? s.by : 'someone', at: typeof s.at === 'number' ? s.at : 0 };
    } catch {
      // never set: the default
    }
  }

  private persist() {
    try {
      writeFileSync(this.path, JSON.stringify(this.saved ?? {}, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}

/**
 * Whether a fresh worker starts from the latest of the default branch (see WorkerManager.freshMain),
 * kept in .droid-office/fresh-main.json. On until someone turns it off.
 */
export class FreshMain extends SavedSwitch {
  constructor(dataDir: string, onState: (state: SwitchState) => void) {
    super(dataDir, 'fresh-main.json', true, onState);
  }
}
