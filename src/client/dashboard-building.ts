import { type MissionControlState, ORCHESTRATOR_ID } from '../shared/mission-control';
import type { FloorInfo, FloorRoster, WorkerInfo } from '../shared/protocol';
import { isAsleep, needsOwnerAttention, needsOwnerInput } from '../shared/status';
import { orchestratorWorker } from './mission';

export const MISSION_FLOOR = '__mission__';

export interface BuildingWorkerRow {
  worker: WorkerInfo;
  kind: 'desk' | 'orchestrator' | 'bot';
  floorId: string;
  /** Older offices place external bots on a floor; only real Mission Control agents open globally. */
  navigationFloor?: string;
  floorName: string;
  repo?: string;
  leadName?: string;
  grokBot?: boolean;
  depth: number;
}

export type BuildingFilter = 'all' | 'needs_input' | 'working' | 'done' | 'asleep';

function repoLabel(floor: FloorInfo | undefined): string | undefined {
  if (!floor) return undefined;
  if (floor.home) return 'Home';
  if (floor.repo?.trim()) return floor.repo.trim();
  if (floor.plain) return 'Folder';
  const folder = floor.dir
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .pop()
    ?.trim();
  return folder && folder.toLowerCase() !== floor.name.trim().toLowerCase() ? folder : undefined;
}

function actionable(row: BuildingWorkerRow): boolean {
  return row.kind !== 'bot' && !row.worker.remote;
}

function priority(row: BuildingWorkerRow): number {
  const w = row.worker;
  if (!actionable(row)) {
    if (w.status === 'working' || w.status === 'starting') return 3;
    if (w.status === 'done' || w.status === 'idle') return 5;
    return 7;
  }
  switch (w.status) {
    case 'needs_input':
      return 0;
    case 'working':
      return 2;
    case 'starting':
      return 3;
    case 'done':
      return needsOwnerAttention(w) ? 1 : 4;
    case 'idle':
      return 5;
    case 'exited':
      return 6;
    case 'offline':
      return 7;
  }
}

/** Current-floor workers replace that entire snapshot, including workers removed since it was sent. */
export function buildingRoster(input: { floors: readonly FloorInfo[]; building: ReadonlyMap<string, FloorRoster>; currentFloor: string | null; workers: Iterable<WorkerInfo>; mission?: MissionControlState }): BuildingWorkerRow[] {
  const { floors, building, currentFloor, mission } = input;
  const floorMap = new Map(floors.map((floor) => [floor.id, floor]));
  const floorRank = new Map(floors.map((floor, index) => [floor.id, index]));
  const live = new Map([...input.workers].map((w) => [w.id, w]));
  const rows = new Map<string, BuildingWorkerRow>();
  const addMission = (worker: WorkerInfo, kind: 'orchestrator' | 'bot', navigationFloor?: string, grokBot?: boolean) => {
    if (!rows.has(worker.id)) rows.set(worker.id, { worker, kind, floorId: MISSION_FLOOR, navigationFloor, floorName: 'Mission Control', ...(grokBot ? { grokBot: true } : {}), depth: 0 });
  };
  const orchestrator = orchestratorWorker(mission);
  if (orchestrator) addMission(orchestrator, 'orchestrator');
  for (const bot of mission?.bots ?? []) addMission(bot.worker, 'bot', undefined, bot.grokBot);

  const floorIds = [...new Set([...floorMap.keys(), ...[...building.keys()].sort(), ...(currentFloor === null ? [] : [currentFloor])])];
  for (const floorId of floorIds) {
    const floor = floorMap.get(floorId);
    const workers = floorId === currentFloor ? live.values() : (building.get(floorId)?.workers ?? []);
    for (const worker of workers) {
      if (worker.id === ORCHESTRATOR_ID || (mission && worker.remote) || rows.has(worker.id)) continue;
      if (currentFloor !== null && floorId !== currentFloor && live.has(worker.id)) continue;
      if (worker.remote) {
        addMission(worker, 'bot', floorId);
      } else {
        rows.set(worker.id, { worker, kind: 'desk', floorId, floorName: floor?.name ?? floorId, repo: repoLabel(floor), depth: 0 });
      }
    }
  }
  for (const row of rows.values()) {
    if (row.worker.lead) row.leadName = rows.get(row.worker.lead)?.worker.name.trim() || row.worker.team?.leadName.trim() || undefined;
  }
  return arrangeRows([...rows.values()], floorRank);
}

function arrangeRows(rows: BuildingWorkerRow[], floorRank: ReadonlyMap<string, number>): BuildingWorkerRow[] {
  const byId = new Map(rows.map((row) => [row.worker.id, row]));
  const floorOrder = (row: BuildingWorkerRow) => (row.floorId === MISSION_FLOOR ? -1 : (floorRank.get(row.floorId) ?? Number.MAX_SAFE_INTEGER));
  const waiting = (row: BuildingWorkerRow) => (row.worker.status === 'needs_input' || row.worker.status === 'done' ? (row.worker.waitingSince ?? Infinity) : 0);
  const compare = (a: BuildingWorkerRow, b: BuildingWorkerRow) => priority(a) - priority(b) || waiting(a) - waiting(b) || floorOrder(a) - floorOrder(b) || a.worker.createdAt - b.worker.createdAt || a.worker.id.localeCompare(b.worker.id);
  const ordered = [...rows].sort(compare);
  const parents = new Map<string, string>();
  for (const row of rows) {
    const lead = row.worker.lead;
    if (lead && lead !== row.worker.id && byId.has(lead)) parents.set(row.worker.id, lead);
  }

  // Break each stale cycle at a deterministic member without discarding its team.
  const settled = new Set<string>();
  for (const row of ordered) {
    const path: string[] = [];
    const positions = new Map<string, number>();
    let id: string | undefined = row.worker.id;
    while (id !== undefined && !settled.has(id)) {
      const position = positions.get(id);
      if (position !== undefined) {
        const root = path
          .slice(position)
          .map((member) => byId.get(member)!)
          .sort(compare)[0];
        parents.delete(root.worker.id);
        break;
      }
      positions.set(id, path.length);
      path.push(id);
      id = parents.get(id);
    }
    for (const member of path) settled.add(member);
  }

  const children = new Map<string, BuildingWorkerRow[]>();
  for (const row of ordered) {
    const parent = parents.get(row.worker.id);
    if (!parent) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(row);
    children.set(parent, siblings);
  }
  const groups = ordered
    .filter((row) => !parents.has(row.worker.id))
    .map((root) => {
      const members: BuildingWorkerRow[] = [];
      const visit = (row: BuildingWorkerRow, depth: number) => {
        members.push({ ...row, depth: Math.min(depth, 2) });
        for (const child of children.get(row.worker.id) ?? []) visit(child, depth + 1);
      };
      visit(root, 0);
      return {
        root,
        members,
        priority: Math.min(...members.map(priority)),
        waiting: Math.min(Infinity, ...members.filter((row) => actionable(row) && needsOwnerAttention(row.worker)).map((row) => row.worker.waitingSince ?? Infinity)),
      };
    });
  groups.sort((a, b) => a.priority - b.priority || a.waiting - b.waiting || compare(a.root, b.root));
  return groups.flatMap((group) => group.members);
}

function matchesFilter(row: BuildingWorkerRow, filter: BuildingFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'needs_input':
      return actionable(row) && needsOwnerInput(row.worker);
    case 'working':
      return row.worker.status === 'working' || row.worker.status === 'starting';
    case 'done':
      return row.worker.status === 'done';
    case 'asleep':
      return isAsleep(row.worker.status);
  }
}

/** Search never adds nonmatching ancestors; a team whose lead is hidden starts at depth zero. */
export function filterBuildingRows(rows: readonly BuildingWorkerRow[], query: string, floorId: string, filter: BuildingFilter): BuildingWorkerRow[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const visible = rows.filter((row) => {
    if ((floorId && floorId !== 'all' && row.floorId !== floorId) || !matchesFilter(row, filter)) return false;
    const w = row.worker;
    const text = [
      w.name,
      w.title,
      w.task?.name,
      w.task?.summary,
      w.activity,
      w.prompt,
      w.model,
      w.activeModel,
      row.leadName,
      row.floorName,
      row.repo,
      w.worktree?.branch,
      ...(w.repos ?? []).flatMap((repo) => [repo.name, repo.repo, repo.branch]),
    ]
      .join(' ')
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const depths = new Map<string, number>();
  return visible.map((row) => {
    const parentDepth = row.worker.lead ? depths.get(row.worker.lead) : undefined;
    const depth = row.depth > 0 && parentDepth !== undefined ? Math.min(parentDepth + 1, 2) : 0;
    depths.set(row.worker.id, depth);
    return { ...row, depth };
  });
}

export function buildingCounts(rows: readonly BuildingWorkerRow[]): Record<BuildingFilter, number> {
  const counts: Record<BuildingFilter, number> = { all: rows.length, needs_input: 0, working: 0, done: 0, asleep: 0 };
  for (const row of rows) {
    for (const filter of ['needs_input', 'working', 'done', 'asleep'] as const) {
      if (matchesFilter(row, filter)) counts[filter]++;
    }
  }
  return counts;
}
