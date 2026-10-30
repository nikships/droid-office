import type { WorkerInfo } from '../shared/protocol';
import { isBusy } from '../shared/status';

type Member = Pick<WorkerInfo, 'id' | 'lead' | 'createdAt' | 'status' | 'acked'>;
export interface WorkerTeam<T> {
  lead: T;
  children: T[];
}

/** Hiring is one level deep. Stale, self-referencing or cyclic links never hide a worker. */
export function workerTeams<T extends Member>(workers: readonly T[]): WorkerTeam<T>[] {
  const sorted = [...workers].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const byId = new Map(sorted.map((w) => [w.id, w]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const w of sorted) {
    const parent = w.lead ? byId.get(w.lead) : undefined;
    if (parent && parent !== w && !parent.lead) {
      const siblings = children.get(parent.id) ?? [];
      siblings.push(w);
      children.set(parent.id, siblings);
    } else roots.push(w);
  }
  return roots.map((lead) => ({ lead, children: children.get(lead.id) ?? [] }));
}

export function teamCounts(workers: readonly Member[]) {
  return {
    working: workers.filter((w) => isBusy(w.status) && w.status !== 'needs_input').length,
    attention: workers.filter((w) => w.status === 'needs_input' || (w.status === 'done' && !w.acked)).length,
  };
}
