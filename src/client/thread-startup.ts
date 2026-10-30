import type { WorkerInfo } from '../shared/protocol';

/** Worktree setup and CLI boot happen before a local conversation can be read. */
export function threadStarting(worker: WorkerInfo): boolean {
  return worker.kind === 'agent' && !worker.cloud && !worker.guest && !worker.lost && worker.status === 'starting';
}

export function threadSnapshotError(worker: WorkerInfo, error?: string): string {
  if (threadStarting(worker) && error === 'The local conversation file is not available yet.') return '';
  return error ?? '';
}
