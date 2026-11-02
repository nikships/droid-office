import type { WorkerInfo } from '../shared/protocol';
import { NEW_SESSION_GRACE_MS } from '../shared/factory-sessions';
import { isAsleep, isBusy } from '../shared/status';

function localThread(worker: WorkerInfo): boolean {
  return worker.kind === 'agent' && !worker.cloud && !worker.lost;
}

/** Worktree setup and CLI boot happen before a local conversation can be read. */
export function threadStarting(worker: WorkerInfo): boolean {
  return localThread(worker) && worker.status === 'starting';
}

export function threadSnapshotError(worker: WorkerInfo, error?: string, firstReadGrace = false): string {
  if (localThread(worker) && !isAsleep(worker.status) && (threadStarting(worker) || firstReadGrace) && error === 'The local conversation file is not available yet.') return '';
  return error ?? '';
}

/**
 * A cloud worker whose session has no messages to show yet is still starting while it works, or while
 * the first prompt it was hired with is new: Factory lists a just-made session's messages late.
 */
export function cloudStarting(worker: WorkerInfo, now: number): boolean {
  if (!worker.cloud || worker.cloud.error || isAsleep(worker.status)) return false;
  return isBusy(worker.status) || (!!worker.prompt && now - worker.createdAt < NEW_SESSION_GRACE_MS);
}
