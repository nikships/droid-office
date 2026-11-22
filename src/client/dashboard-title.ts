import { orchestratorNeedsOwner, ORCHESTRATOR_ID, type MissionControlState } from '../shared/mission-control';
import { needsOwnerAttention } from '../shared/status';
import type { BuildingWorkerRow } from './dashboard-building';

export function buildingWaitingCount({ buildingRows, mission }: { buildingRows: readonly BuildingWorkerRow[]; mission?: MissionControlState }): number {
  const waiting = new Set<string>();
  for (const { worker, kind } of buildingRows) {
    if (kind !== 'bot' && !worker.remote && worker.kind !== 'shell' && needsOwnerAttention(worker)) waiting.add(worker.id);
  }
  // The roster hides a teamless Orchestrator, but it can still be waiting on the owner.
  if (orchestratorNeedsOwner(mission)) waiting.add(ORCHESTRATOR_ID);
  return waiting.size;
}

export function companionDocumentTitle(officeName: string, waiting: number, nativeCompanion: boolean): string {
  return `${waiting > 0 ? `(${waiting}) ` : ''}${officeName} · ${nativeCompanion ? 'Companion' : 'Web companion'}`;
}
