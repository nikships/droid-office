// Mission Control: the building's agents, which belong to no floor and have no desk. The Orchestrator is the
// one the office launches and owns, a Droid session in a PTY. External bots (Settings → Tailscale MCP) run
// elsewhere. Both sign in to the Office MCP's external surface (office_roster, office_worker_*,
// office_send_home, team_* across floors), sit in Mission Control on every floor, and hire onto any floor by
// naming it. See docs/mission-control.md.

import type { AgentEffort, WorkerInfo, WorkerStatus } from './protocol.js';

/**
 * The Orchestrator's worker id everywhere: `worker.attach`, `term.*`, `thread.read` and `worker.answer`
 * addressed to it from any floor, and `WorkerInfo.lead` on the subagents it hires.
 */
export const ORCHESTRATOR_ID = 'orchestrator';
export const ORCHESTRATOR_NAME = 'Orchestrator';
/** The Orchestrator's colour in every client: the office accent, before and after its first prompt. */
export const ORCHESTRATOR_COLOR = '#ee6018';

export interface OrchestratorSettings {
  /** Off: hidden in the office and both companions, its session stops, and its team carries on reporting to nobody. */
  on: boolean;
  /** Model id for its Droid session; absent is the office default. */
  model?: string;
  effort?: AgentEffort;
}

export const DEFAULT_ORCHESTRATOR_SETTINGS: OrchestratorSettings = { on: true };

/** One subagent of a building agent, on whichever floor it sits. */
export interface MissionTeamMember {
  id: string;
  name: string;
  floor: string;
  floorName: string;
  status: WorkerStatus;
  title?: string;
  activity?: string;
}

/**
 * One agent in Mission Control. `worker` has no desk (`deskId` '') and is never in a floor's worker list.
 * For the Orchestrator its status comes from its own session's hooks. For an external bot (`remote: true`)
 * it is what the bot last reported with office_status, `offline` until it reports after an office restart.
 */
export interface MissionAgent {
  worker: WorkerInfo;
  /** Its subagents across every open floor, in hiring order. */
  team: MissionTeamMember[];
  /** External bots: when any of its keys last authenticated. */
  lastUsedAt?: number;
  /** External bots: true when marked as a Grok Bot with webhook push enabled. */
  grokBot?: boolean;
}

export interface OrchestratorState {
  settings: OrchestratorSettings;
  /**
   * Its session: `worker` has `id` ORCHESTRATOR_ID and `kind` 'agent', with status, activity, ask, todos,
   * labels and active model. Absent until its first prompt and after a new conversation.
   */
  agent?: MissionAgent;
  /**
   * Its subagents across every open floor, in hiring order: they stay its own between conversations and
   * while it is off, when there is no `agent` to carry them.
   */
  team: MissionTeamMember[];
  /** Why it can't start now (Droid missing or signed out, Office MCP off, its model can't run); shown in place of the composer. */
  blocked?: string;
  /** The Settings pane where what blocks it is fixed. Absent when that is its own pane (a model that can't run). */
  blockedPane?: OrchestratorFixPane;
}

/** A Settings pane (`SettingsPane` in settings-nav.ts) other than the Orchestrator's own that unblocks it. */
export type OrchestratorFixPane = 'connections' | 'subagents';

/** Why the Orchestrator can't start, and where the owner fixes it. */
export interface OrchestratorBlock {
  why: string;
  pane?: OrchestratorFixPane;
}

export interface MissionControlState {
  orchestrator: OrchestratorState;
  /** External bots, in the order they were added. */
  bots: MissionAgent[];
}

/** Whether a building agent waits on the owner: a finished turn nobody has read, or a question or permission prompt. External bots never do. */
export function missionAgentNeedsOwner(agent: MissionAgent | undefined): boolean {
  const w = agent?.worker;
  return !!w && !w.remote && (w.status === 'needs_input' || (w.status === 'done' && !w.acked));
}

/** The Orchestrator waits on the owner. */
export function orchestratorNeedsOwner(state: MissionControlState | undefined): boolean {
  return !!state?.orchestrator.settings.on && missionAgentNeedsOwner(state.orchestrator.agent);
}

/** The building agent a worker id names, if any. */
export function missionAgent(state: MissionControlState | undefined, id: string): MissionAgent | undefined {
  if (!state) return undefined;
  if (id === ORCHESTRATOR_ID) return state.orchestrator.settings.on ? state.orchestrator.agent : undefined;
  return state.bots.find((b) => b.worker.id === id);
}
