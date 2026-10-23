// How the companion words a worker on its tags, cards and rows. No DOM, so the web companion and the
// Android tablet overview (android-overview.ts) say the same thing.

import { PROVIDER_LABEL } from '../shared/guests';
import type { WorkerInfo } from '../shared/protocol';

/** What sort of worker it is: a Droid here or on a Factory computer, a shell, or a guest agent. */
export function workerKind(w: WorkerInfo): string {
  return w.guest ? `${PROVIDER_LABEL[w.guest.provider]} · outside office` : w.cloud ? 'Droid · Factory' : w.kind === 'shell' ? 'Shell' : 'Droid';
}

/** One line on what it's doing: the question when it needs you, else its task, title or activity. */
export function doingLine(w: WorkerInfo): string {
  return (w.status === 'needs_input' ? w.activity : undefined) ?? w.task?.name ?? w.title ?? w.activity ?? (w.kind === 'shell' ? 'Shell' : 'Waiting for a task');
}
