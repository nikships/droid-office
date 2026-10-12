import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PipelineRun } from '../shared/pipelines.js';
import { SavedSwitch, type SwitchState } from './saved-switch.js';

/**
 * Whether a run that fails on this floor wakes the Pipeline agent to heal it (find the root cause
 * and hire a worker who pushes the fix), picked on that floor's Pipelines window and kept in the
 * floor's .droid-office/auto-heal.json. Off until someone on the floor turns it on.
 */
export class AutoHeal extends SavedSwitch {
  constructor(dataDir: string, onState: (state: SwitchState) => void) {
    super(dataDir, 'auto-heal.json', false, onState);
  }
}

/**
 * A floor with no auto-heal.json yet starts from the office-wide file this used to be (the same on
 * every floor), copied in once. After that the floor keeps its own, and the office file is left on disk.
 */
export function seedAutoHeal(floorDataDir: string, officeDataDir: string) {
  const dest = path.join(floorDataDir, 'auto-heal.json');
  if (floorDataDir === officeDataDir || existsSync(dest)) return;
  try {
    const s = JSON.parse(readFileSync(path.join(officeDataDir, 'auto-heal.json'), 'utf8')) as Partial<SwitchState>;
    if (typeof s.on !== 'boolean') return;
    const seeded: Required<SwitchState> = { on: s.on, by: typeof s.by === 'string' ? s.by : 'someone', at: typeof s.at === 'number' ? s.at : 0 };
    writeFileSync(dest, JSON.stringify(seeded, null, 2), { mode: 0o600 });
  } catch {
    // no office file, or it can't be read: the floor starts off
  }
}

/**
 * How many failures in a row of one workflow on one branch wake the Pipeline agent. A fix that keeps
 * failing is left to a person after that, so a red pipeline can't keep hiring workers forever.
 */
export const HEAL_TRIES = 3;
/** Failed runs remembered so a run seen ending twice (a lost poll, say) isn't healed twice. */
const SEEN_MAX = 200;

export type HealCall = 'heal' | 'gaveUp';

/** One floor's failed runs, and which of them the Pipeline agent is sent to heal. */
export class HealWatch {
  /** Failures in a row since the last pass, by workflow and branch. */
  private streak = new Map<string, number>();
  /** Failed runs already counted, by id and attempt: a re-run of the same run is a new attempt. */
  private seen = new Set<string>();

  /**
   * A run the office watched has ended. A pass clears its workflow's streak on that branch. A failure
   * while `on` is `heal`, or `gaveUp` once, the first time it has failed more than HEAL_TRIES times in a row.
   */
  finished(run: PipelineRun, on: boolean): HealCall | undefined {
    const key = `${run.workflow}\n${run.branch}`;
    if (run.state === 'success') {
      this.streak.delete(key);
      return undefined;
    }
    if (run.state !== 'failure' || !on) return undefined;
    const id = `${run.id}#${run.attempt ?? 1}`;
    if (this.seen.has(id)) return undefined;
    this.seen.add(id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
    const n = (this.streak.get(key) ?? 0) + 1;
    this.streak.set(key, n);
    if (n <= HEAL_TRIES) return 'heal';
    return n === HEAL_TRIES + 1 ? 'gaveUp' : undefined;
  }
}
