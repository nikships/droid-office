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

export interface TriagePartition {
  surfaced: TriageFloor[];
  quiet: TriageFloor[];
  quietBusy: number;
  quietNeeds: number;
  quietDone: number;
}

export function maxSurfacedBays(viewportWidth: number): number {
  return viewportWidth < 1100 ? 4 : 5;
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
      busy = Math.max(0, floor.busy - floor.waiting);
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
 * Surfaces the active floor first, then floors with live input blockers, then floors with
 * unacknowledged completed work, capped at `maxBays` so repository names stay legible.
 */
export function partitionTriageFloors(items: readonly TriageFloor[], currentFloor: string | null, maxBays = 5): TriagePartition {
  const cap = Math.max(1, maxBays);
  const surfaced: TriageFloor[] = [];
  const picked = new Set<string>();

  const active = currentFloor ? items.find((item) => item.floor.id === currentFloor) : undefined;
  if (active) {
    surfaced.push(active);
    picked.add(active.floor.id);
  }
  for (const item of items) {
    if (surfaced.length >= cap) break;
    if (!picked.has(item.floor.id) && item.needsInput > 0) {
      surfaced.push(item);
      picked.add(item.floor.id);
    }
  }
  for (const item of items) {
    if (surfaced.length >= cap) break;
    if (!picked.has(item.floor.id) && item.unackedDone > 0) {
      surfaced.push(item);
      picked.add(item.floor.id);
    }
  }

  const quiet: TriageFloor[] = [];
  let quietBusy = 0;
  let quietNeeds = 0;
  let quietDone = 0;
  for (const item of items) {
    if (picked.has(item.floor.id)) continue;
    quiet.push(item);
    quietBusy += item.busy;
    quietNeeds += item.needsInput;
    quietDone += item.unackedDone;
  }
  return { surfaced, quiet, quietBusy, quietNeeds, quietDone };
}

/**
 * Empty search lists quiet floors (or all floors when none are tucked away so `⌘ K` always has rows);
 * a non-empty search matches across every floor in the building by number, name, repo, or branch.
 */
export function filterSwitcherFloors(items: readonly TriageFloor[], quiet: readonly TriageFloor[], query: string): TriageFloor[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return quiet.length ? [...quiet] : [...items];
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
