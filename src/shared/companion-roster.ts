import type { WorkerInfo, WorkerStatus } from './protocol.js';

export interface RosterFilter {
  query?: string;
  status?: WorkerStatus;
  kind?: 'agent' | 'shell' | 'cloud' | 'guest';
}

export interface RosterRow {
  worker: WorkerInfo;
  depth: number;
  parentId?: string;
  childCount: number;
  descendantCount: number;
  childStatuses: Partial<Record<WorkerStatus, number>>;
  collapsed: boolean;
  matches: boolean;
}

/** Supervision is lead alone. Missing leads and malformed cycles remain visible as roots. */
export function companionRoster(workers: readonly WorkerInfo[], filter: RosterFilter = {}, collapsed: ReadonlySet<string> = new Set()): RosterRow[] {
  const ordered = [...workers].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const byId = new Map(ordered.map((w) => [w.id, w]));
  const parents = new Map<string, string>();
  for (const w of ordered) {
    if (!w.lead || !byId.has(w.lead) || w.lead === w.id) continue;
    const seen = new Set([w.id]);
    let id: string | undefined = w.lead;
    while (id && !seen.has(id)) {
      seen.add(id);
      id = byId.get(id)?.lead;
    }
    if (!id) parents.set(w.id, w.lead);
  }
  const children = new Map<string, WorkerInfo[]>();
  for (const w of ordered) {
    const parent = parents.get(w.id) ?? '';
    const list = children.get(parent) ?? [];
    list.push(w);
    children.set(parent, list);
  }
  const query = filter.query?.trim().toLocaleLowerCase() ?? '';
  const matches = (w: WorkerInfo) =>
    (!filter.status || w.status === filter.status) &&
    (!filter.kind || (w.guest ? 'guest' : w.cloud ? 'cloud' : w.kind) === filter.kind) &&
    (!query || [w.name, w.title, w.task?.name, w.task?.summary, w.activity, w.prompt, w.activeModel ?? w.model, w.lead && byId.get(w.lead)?.name].some((v) => v?.toLocaleLowerCase().includes(query)));
  const visible = new Set<string>();
  for (const w of ordered) {
    if (!matches(w)) continue;
    let id: string | undefined = w.id;
    while (id && !visible.has(id)) {
      visible.add(id);
      id = parents.get(id);
    }
  }
  const descendants = (id: string): WorkerInfo[] => (children.get(id) ?? []).flatMap((w) => [w, ...descendants(w.id)]);
  const result: RosterRow[] = [];
  const filtered = !!(query || filter.status || filter.kind);
  const visit = (parent: string, depth: number) => {
    for (const worker of children.get(parent) ?? []) {
      if (!visible.has(worker.id)) continue;
      const all = descendants(worker.id);
      const childStatuses: RosterRow['childStatuses'] = {};
      for (const child of all) childStatuses[child.status] = (childStatuses[child.status] ?? 0) + 1;
      const folded = !filtered && collapsed.has(worker.id);
      result.push({ worker, depth, parentId: parents.get(worker.id), childCount: children.get(worker.id)?.length ?? 0, descendantCount: all.length, childStatuses, collapsed: folded, matches: matches(worker) });
      if (!folded) visit(worker.id, depth + 1);
    }
  };
  visit('', 0);
  return result;
}

export function companionCapabilities(worker: WorkerInfo) {
  const local = !worker.guest && !worker.cloud && worker.kind !== 'cloud';
  return {
    thread: local && worker.kind === 'agent',
    terminal: local && !worker.lost && worker.status !== 'offline' && worker.status !== 'exited',
    prompt: !worker.guest && !worker.lost,
    dismiss: !worker.guest,
  };
}

export function companionWorkedMs(worker: WorkerInfo, now: number): number {
  return Math.max(0, worker.workedMs ?? 0) + (worker.workingSince ? Math.max(0, now - worker.workingSince) : 0);
}
