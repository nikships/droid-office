import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** What the companions' floor strip ranks a floor by, besides what's on it now (see src/shared/floor-relevance.ts). */
export interface FloorActivityInfo {
  lastVisitedAt?: number;
  lastWorkerAt?: number;
  hires: number;
}

interface Entry {
  lastVisitedAt?: number;
  lastWorkerAt?: number;
  hires: number;
  /** The workers on the floor when it was last looked at, so only new ones count as hires. */
  workers: string[];
}

/** How long changes wait before they're written, so a busy floor doesn't write on every update. */
const SAVE_DELAY_MS = 2_000;

/**
 * Each floor's history for the floor strip, kept in the office's .droid-office/floor-activity.json:
 * when the owner last went there, when it last had a worker, and how many workers it ever hired.
 * Counting starts the first time the office sees the floor, from the workers already on it.
 */
export class FloorActivity {
  private entries = new Map<string, Entry>();
  private file: string;
  private timer?: NodeJS.Timeout;

  constructor(
    dataDir: string,
    private now: () => number = Date.now,
  ) {
    this.file = path.join(dataDir, 'floor-activity.json');
    this.load();
  }

  info(floor: string): FloorActivityInfo {
    const e = this.entries.get(floor);
    if (!e) return { hires: 0 };
    return { ...(e.lastVisitedAt ? { lastVisitedAt: e.lastVisitedAt } : {}), ...(e.lastWorkerAt ? { lastWorkerAt: e.lastWorkerAt } : {}), hires: e.hires };
  }

  /** The owner went to `floor`. */
  visited(floor: string) {
    this.entry(floor).lastVisitedAt = this.now();
    this.saveSoon();
  }

  /**
   * The workers on `floor` now: any not seen before count as hires, and a floor that just lost its
   * last worker remembers when. Returns whether anything changed.
   */
  observe(floor: string, workerIds: readonly string[]): boolean {
    const known = this.entries.get(floor);
    if (!known) {
      this.entries.set(floor, { hires: workerIds.length, workers: [...workerIds], ...(workerIds.length ? { lastWorkerAt: this.now() } : {}) });
      this.saveSoon();
      return true;
    }
    const before = new Set(known.workers);
    const added = workerIds.filter((id) => !before.has(id)).length;
    const emptied = workerIds.length === 0 && known.workers.length > 0;
    const same = added === 0 && workerIds.length === known.workers.length;
    if (same) return false;
    known.hires += added;
    if (workerIds.length > 0 || emptied) known.lastWorkerAt = this.now();
    known.workers = [...workerIds];
    this.saveSoon();
    return true;
  }

  /** `floor` was taken off the building. */
  forget(floor: string) {
    if (this.entries.delete(floor)) this.saveSoon();
  }

  /** Writes anything still waiting. */
  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.save();
  }

  private entry(floor: string): Entry {
    let e = this.entries.get(floor);
    if (!e) {
      e = { hires: 0, workers: [] };
      this.entries.set(floor, e);
    }
    return e;
  }

  private saveSoon() {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.save();
    }, SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  private save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries), null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      console.error(`droid-office: couldn't save floor activity: ${(err as Error).message}`);
    }
  }

  private load() {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      const time = (t: unknown) => (typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : undefined);
      const lastVisitedAt = time(v.lastVisitedAt);
      const lastWorkerAt = time(v.lastWorkerAt);
      this.entries.set(id, {
        ...(lastVisitedAt ? { lastVisitedAt } : {}),
        ...(lastWorkerAt ? { lastWorkerAt } : {}),
        hires: typeof v.hires === 'number' && Number.isFinite(v.hires) && v.hires > 0 ? Math.floor(v.hires) : 0,
        workers: Array.isArray(v.workers) ? v.workers.filter((w): w is string => typeof w === 'string') : [],
      });
    }
  }
}
