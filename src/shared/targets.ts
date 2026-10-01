// Practice targets: disposable shell workers that exist to be shot. A `worker.spawn` with
// `target: true` hires one, and the office names it "Target <n>". No other hire is ever given that
// name and workers are never renamed. Tools that may only shoot disposable workers (the headset's
// capture staging, for one) never go by that name, though: they shoot only worker ids they were
// given or hired themselves, and each must still be a plain shell (isDisposableShell).

import type { WorkerKind } from './protocol.js';

/** A shell worker's name ends with this mark (see WorkerManager.spawn). */
const SHELL_MARK = / 🐚$/u;
const TARGET_NAME = /^target ([1-9]\d*)$/i;

/** The number in a practice target's name ("Target 3" or "Target 3 🐚"), or null for any other name. */
export function targetNumber(name: string): number | null {
  const m = TARGET_NAME.exec(name.replace(SHELL_MARK, ''));
  return m ? Number(m[1]) : null;
}

/** The name the next practice target gets: "Target <n>" with the lowest n no worker in `taken` has. */
export function nextTargetName(taken: Iterable<string>): string {
  const used = new Set<number>();
  for (const name of taken) {
    const n = targetNumber(name);
    if (n !== null) used.add(n);
  }
  let n = 1;
  while (used.has(n)) n++;
  return `Target ${n}`;
}

/** Why a hire cannot be a practice target, or undefined when it can: only a plain shell at a desk is one. */
export function targetHireError(o: { kind: WorkerKind; worktree: boolean; repos: number; station: boolean; meeting: boolean }): string | undefined {
  if (o.station || o.meeting) return 'A practice target sits at a desk or a bean bag';
  if (o.kind !== 'shell' || o.worktree || o.repos > 0) return 'A practice target is a plain shell, with no agent and no worktree';
  return undefined;
}

/**
 * Whether a worker is nothing but a plain shell: no agent, worktree, other repositories or meeting
 * of its own, so a tool's shot (dismissed 30 s later unless revived) destroys no real work.
 */
export function isDisposableShell(w: { kind?: WorkerKind; worktree?: unknown; repos?: readonly unknown[]; meeting?: string }): boolean {
  return w.kind === 'shell' && !w.worktree && !w.repos?.length && !w.meeting;
}

/**
 * Whether a worker is the office's answer to a practice target hire: a plain shell named
 * "Target <n>". It tells that answer apart on the floor; it never lets a tool shoot anyone.
 */
export function isPracticeTarget(w: { name: string; kind?: WorkerKind; worktree?: unknown; repos?: readonly unknown[]; meeting?: string }): boolean {
  return isDisposableShell(w) && targetNumber(w.name) !== null;
}
