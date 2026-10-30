// How the companion words a worker on its cards and rows.

import { PROVIDER_LABEL } from '../shared/guests';
import type { WorkerInfo } from '../shared/protocol';
import { workerActivity } from '../shared/status';

/** What sort of worker it is: a Droid here or on a Factory computer, a shell, or a guest agent. */
export function workerKind(w: WorkerInfo): string {
  return w.guest ? `${PROVIDER_LABEL[w.guest.provider]} · outside office` : w.cloud ? 'Droid · Factory' : w.kind === 'shell' ? 'Shell' : 'Droid';
}

/** One line on what it's doing: the question when it needs you, else its task, title or activity. */
export function doingLine(w: WorkerInfo): string {
  if (w.task?.generated || w.lost || w.cloud?.error) return workerActivity(w) ?? w.task?.name ?? w.title ?? 'Waiting for a task';
  return (w.status === 'needs_input' ? w.activity : undefined) ?? w.task?.name ?? w.title ?? w.activity ?? (w.kind === 'shell' ? 'Shell' : 'Waiting for a task');
}
