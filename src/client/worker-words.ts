// How the companion words a worker on its cards and rows.

import { ORCHESTRATOR_ID } from '../shared/mission-control';
import type { WorkerInfo } from '../shared/protocol';
import { workerActivity } from '../shared/status';

/** What sort of worker it is: a building agent, a Droid here or on a Factory computer, or a shell. */
export function workerKind(w: WorkerInfo): string {
  if (w.id === ORCHESTRATOR_ID) return 'Orchestrator · Mission Control';
  if (w.remote) return 'External bot · Mission Control';
  return w.cloud ? 'Droid · Factory' : w.kind === 'shell' ? 'Shell' : 'Droid';
}

/** One line on what it's doing: the question when it needs you, else its task, title or activity. */
export function doingLine(w: WorkerInfo): string {
  if (w.task?.generated || w.lost || w.cloud?.error) return workerActivity(w) ?? w.task?.name ?? w.title ?? 'Waiting for a task';
  return (w.status === 'needs_input' ? w.activity : undefined) ?? w.task?.name ?? w.title ?? w.activity ?? (w.kind === 'shell' ? 'Shell' : 'Waiting for a task');
}
