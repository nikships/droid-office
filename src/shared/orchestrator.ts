// The Orchestrator: one Droid session for the whole building, not one per floor. The office launches and
// owns it, and it signs in to the Office MCP as an external bot, so it gets the building-wide, owner-level
// tools (office_roster, office_worker_*, office_send_home, team_* across floors) rather than a desk
// worker's. It plans and delegates; every code change goes to a worker it hires. See docs/orchestrator.md.

import type { AgentEffort, WorkerInfo, WorkerStatus } from './protocol.js';

/**
 * Its worker id everywhere: `worker.attach`, `term.*`, `thread.read` and `worker.answer` addressed to it
 * from any floor, and `WorkerInfo.lead` on the subagents it hires.
 */
export const ORCHESTRATOR_ID = 'orchestrator';
export const ORCHESTRATOR_NAME = 'Orchestrator';

export interface OrchestratorSettings {
  /** Off: hidden in the office and both companions, its session stops, and its team carries on reporting to nobody. */
  on: boolean;
  /** Model id for its Droid session; absent is the office default. */
  model?: string;
  effort?: AgentEffort;
}

export const DEFAULT_ORCHESTRATOR_SETTINGS: OrchestratorSettings = { on: true };

/** One of its subagents, on whichever floor it sits. */
export interface OrchestratorTeamMember {
  id: string;
  name: string;
  floor: string;
  floorName: string;
  status: WorkerStatus;
  title?: string;
  activity?: string;
}

export interface OrchestratorState {
  settings: OrchestratorSettings;
  /**
   * Its session as a worker (status, activity, ask, todos, labels, active model, session id), with
   * `id` ORCHESTRATOR_ID, `kind` 'agent' and no desk (`deskId` ''). Absent until its first prompt and
   * after a new conversation. It is never in a floor's worker list.
   */
  worker?: WorkerInfo;
  /** Its subagents across every open floor, in hiring order. */
  team: OrchestratorTeamMember[];
  /** Why it can't start now (Droid missing or signed out, Office MCP off, its model can't run); shown in place of the composer. */
  blocked?: string;
}

/** Whether it waits on the owner: a finished turn nobody has read, or a question or permission prompt. */
export function orchestratorNeedsOwner(state: OrchestratorState | undefined): boolean {
  const w = state?.settings.on ? state.worker : undefined;
  return !!w && (w.status === 'needs_input' || (w.status === 'done' && !w.acked));
}
