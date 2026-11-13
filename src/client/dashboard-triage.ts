import { rankFloors } from '../shared/floor-relevance';
import { floorPalette } from '../shared/floors';
import { ORCHESTRATOR_ID } from '../shared/mission-control';
import type { FloorInfo, FloorRoster, GhPull, WorkerInfo } from '../shared/protocol';
import { isAsleep, needsOwnerInput } from '../shared/status';
import type { BuildingWorkerRow } from './dashboard-building';

export type TriageKind = 'needs' | 'done' | 'normal';
export type FloorIdleState = 'working' | 'ready' | 'asleep' | 'empty';

export interface TriageFloor {
  floor: FloorInfo;
  index: number;
  number: string;
  chord?: string;
  trim: string;
  branch?: string;
  metaLabel?: string;
  triage: TriageKind;
  needsInput: number;
  unackedDone: number;
  busy: number;
  totalWorkers: number;
  idleState: FloorIdleState;
  openPrs: number;
}

export function floorChord(index: number): string | undefined {
  if (index < 0 || index > 9) return undefined;
  return `⇧ ⌘ ${index === 9 ? 0 : index + 1}`;
}

function countOpenPulls(pulls: readonly GhPull[] | undefined): number {
  if (!pulls?.length) return 0;
  let open = 0;
  for (const pr of pulls) {
    if (pr.state === 'OPEN' || pr.state === 'DRAFT') open++;
  }
  return open;
}

function floorDeskWorkers(roster: readonly WorkerInfo[]): WorkerInfo[] {
  return roster.filter((w) => w.id !== ORCHESTRATOR_ID && !w.remote);
}

function floorIdleState(totalWorkers: number, busy: number, needsInput: number, deskWorkers?: readonly WorkerInfo[]): FloorIdleState {
  if (totalWorkers === 0) return 'empty';
  if (busy > 0 || needsInput > 0) return 'working';
  if (deskWorkers?.every((w) => isAsleep(w.status))) return 'asleep';
  return 'ready';
}

export function buildTriageFloors(input: { floors: readonly FloorInfo[]; building: ReadonlyMap<string, FloorRoster>; currentFloor: string | null; workers: Iterable<WorkerInfo>; pulls?: readonly GhPull[] }): TriageFloor[] {
  const liveWorkers = floorDeskWorkers([...input.workers]);
  return input.floors.map((floor, index) => {
    const isCurrent = floor.id === input.currentFloor;
    const rosterEntry = input.building.get(floor.id);
    let deskWorkers: WorkerInfo[] | undefined;
    if (isCurrent) deskWorkers = liveWorkers;
    else if (rosterEntry && (rosterEntry.workers.length > 0 || floor.workers === 0)) deskWorkers = floorDeskWorkers(rosterEntry.workers);

    let needsInput = 0;
    let unackedDone = 0;
    let busy = 0;
    let totalWorkers = floor.workers;

    if (deskWorkers) {
      totalWorkers = deskWorkers.length;
      for (const w of deskWorkers) {
        if (needsOwnerInput(w)) needsInput++;
        else if (!w.lead && w.status === 'done' && !w.acked) unackedDone++;
        if (w.status === 'working' || w.status === 'starting') busy++;
      }
      if (!isCurrent && floor.waiting > needsInput + unackedDone) {
        needsInput += floor.waiting - (needsInput + unackedDone);
      }
    } else {
      needsInput = floor.waiting;
      busy = floor.busy;
    }

    const idleState = floorIdleState(totalWorkers, busy, needsInput, deskWorkers);
    let triage: TriageKind = 'normal';
    if (needsInput > 0) triage = 'needs';
    else if (unackedDone > 0) triage = 'done';
    const pullsSource = isCurrent && input.pulls !== undefined ? input.pulls : rosterEntry?.pulls;
    const branch = floor.branch?.trim() || undefined;
    let metaLabel: string | undefined;
    if (branch) metaLabel = `/${branch}`;
    else if (floor.plain) metaLabel = 'plain folder';

    return {
      floor,
      index,
      number: String(index + 1).padStart(2, '0'),
      chord: floorChord(index),
      trim: floorPalette(floor.palette).trim,
      branch,
      metaLabel,
      triage,
      needsInput,
      unackedDone,
      busy,
      totalWorkers,
      idleState,
      openPrs: countOpenPulls(pullsSource),
    };
  });
}

/**
 * Floor ids from most to least relevant for the floor strip (src/shared/floor-relevance.ts): the
 * strip gives tabs in this order until the next would not fit, and the rest wait in "+N more".
 */
export function rankTriageFloors(items: readonly TriageFloor[], now: number): string[] {
  return rankFloors(
    items.map((item) => ({
      id: item.floor.id,
      needsInput: item.needsInput,
      unackedDone: item.unackedDone,
      busy: item.busy,
      totalWorkers: item.totalWorkers,
      lastVisitedAt: item.floor.lastVisitedAt,
      lastWorkerAt: item.floor.lastWorkerAt,
      hires: item.floor.hires,
    })),
    now,
  );
}

/**
 * Empty search lists the floors without a tab (or all floors when every one has a tab, so `⌘ K` always has rows);
 * a non-empty search matches across every floor in the building by number, name, repo, or branch.
 */
export function filterSwitcherFloors(items: readonly TriageFloor[], hidden: readonly TriageFloor[], query: string): TriageFloor[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return hidden.length ? [...hidden] : [...items];
  return items.filter((item) => {
    const haystack = [item.number, String(item.index + 1), item.floor.name, item.floor.repo ?? '', item.branch ?? '', item.floor.plain ? 'plain folder' : '', item.floor.home ? 'home ~' : ''].join(' ').toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

export function unackedDoneBuildingCount(rows: readonly BuildingWorkerRow[]): number {
  let count = 0;
  for (const row of rows) {
    if (row.kind !== 'bot' && !row.worker.remote && !row.worker.lead && row.worker.status === 'done' && !row.worker.acked) {
      count++;
    }
  }
  return count;
}

/**
 * Picks the next worker or floor needing owner input for the upper Building Pulse button:
 * prefers another floor when the owner is already looking at a blocked worker on the current floor.
 */
export function nextUrgentTarget(
  rows: readonly BuildingWorkerRow[],
  triageFloors: readonly TriageFloor[],
  currentFloor: string | null,
  focusedWorkerId?: string,
): { kind: 'worker'; row: BuildingWorkerRow } | { kind: 'floor'; floorId: string } | undefined {
  const urgentRows = rows.filter((row) => row.kind !== 'bot' && !row.worker.remote && needsOwnerInput(row.worker));
  if (urgentRows.length) {
    const focusedOnCurrent = focusedWorkerId && urgentRows.some((r) => r.worker.id === focusedWorkerId && (r.navigationFloor ?? r.floorId) === currentFloor);
    if (focusedOnCurrent) {
      const elsewhere = urgentRows.find((r) => r.worker.id !== focusedWorkerId && (r.navigationFloor ?? r.floorId) !== currentFloor) ?? urgentRows.find((r) => r.worker.id !== focusedWorkerId);
      if (elsewhere) return { kind: 'worker', row: elsewhere };
    } else {
      const otherFloor = urgentRows.find((r) => (r.navigationFloor ?? r.floorId) !== currentFloor);
      const onCurrent = urgentRows.find((r) => (r.navigationFloor ?? r.floorId) === currentFloor);
      const chosen = onCurrent ?? otherFloor ?? urgentRows[0];
      if (chosen) return { kind: 'worker', row: chosen };
    }
    return { kind: 'worker', row: urgentRows[0]! };
  }
  const otherBlocked = triageFloors.find((f) => f.floor.id !== currentFloor && f.needsInput > 0) ?? triageFloors.find((f) => f.needsInput > 0);
  return otherBlocked ? { kind: 'floor', floorId: otherBlocked.floor.id } : undefined;
}
