// Building agents: the Orchestrator and external bots. They sit in Mission Control, not at a floor's desk, and
// have the owner's authority on every floor (docs/mission-control.md).

import { GLASS_ROOM } from '../shared/layout.js';
import { ORCHESTRATOR_ID, type MissionTeamMember } from '../shared/mission-control.js';
import type { WorkerInfo } from '../shared/protocol.js';

/** A building agent: no floor, no desk, the owner's authority everywhere. */
export function isBuildingAgent(w: Pick<WorkerInfo, 'id' | 'remote'> | undefined): boolean {
  return !!w && (!!w.remote || w.id === ORCHESTRATOR_ID);
}

/** Where a building agent's subagents sit nearest to on every floor: Mission Control's door. */
export const MISSION_CONTROL_DOOR = { x: (GLASS_ROOM.door.x0 + GLASS_ROOM.door.x1) / 2, z: GLASS_ROOM.minZ } as const;

/** What a floor needs from the building's agents: who they are, and how to tell one something. */
export interface BuildingAgents {
  identity(id: string): WorkerInfo | undefined;
  /** A message from `floor` for building agent `id`: an external bot's inbox, or the Orchestrator's session. */
  tell(id: string, text: string, floor: string): string | undefined;
}

/** A building agent's subagents on every open floor, in hiring order. */
export function missionTeam(floors: readonly { id: string; def: { name: string }; workers: { list(): WorkerInfo[] } }[], lead: string): MissionTeamMember[] {
  return floors
    .flatMap((f) =>
      f.workers
        .list()
        .filter((w) => w.lead === lead)
        .map((w) => ({
          at: w.createdAt,
          member: { id: w.id, name: w.name, floor: f.id, floorName: f.def.name, status: w.status, ...(w.task?.name ? { title: w.task.name } : {}), ...(w.activity ? { activity: w.activity } : {}) },
        })),
    )
    .sort((a, b) => a.at - b.at)
    .map((x) => x.member);
}
