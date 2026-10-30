import type { WorkerInfo } from '../shared/protocol';
import { isAsleep } from '../shared/status';

function localThread(worker: WorkerInfo): boolean {
  return worker.kind === 'agent' && !worker.cloud && !worker.guest && !worker.lost;
}

/** Worktree setup and CLI boot happen before a local conversation can be read. */
export function threadStarting(worker: WorkerInfo): boolean {
  return localThread(worker) && worker.status === 'starting';
}

export function threadSnapshotError(worker: WorkerInfo, error?: string, firstReadGrace = false): string {
  if (localThread(worker) && !isAsleep(worker.status) && (threadStarting(worker) || firstReadGrace) && error === 'The local conversation file is not available yet.') return '';
  return error ?? '';
}
