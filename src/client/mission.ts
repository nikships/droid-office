// Mission Control as the clients show it (docs/mission-control.md): the Orchestrator before it has a
// session, what each building agent is doing in a line, and whose team a worker is on. No DOM, so the
// office, the companion and their tests share it.

import { missionAgent, ORCHESTRATOR_COLOR, ORCHESTRATOR_ID, ORCHESTRATOR_NAME, orchestratorNeedsOwner, type MissionAgent, type MissionControlState } from '../shared/mission-control';
import type { ClientMsg, WorkerInfo } from '../shared/protocol';
import { SETTINGS_PANES, type SettingsPane } from '../shared/settings-nav';
import { isAsleep } from '../shared/status';
import { doingLine } from './worker-words';

/** What the Orchestrator is for, in its empty state and on its Settings card. */
export const ORCHESTRATOR_PITCH = 'Tell it what you want done anywhere in the building. It plans, hires workers on any floor, answers their questions, checks their work and reports back. It leaves code changes to the workers it hires.';

/** When a new model or effort takes over, on its Settings card. Android says the same. */
export const ORCHESTRATOR_MODEL_CHANGE = 'A change takes over when its current turn ends, in the same conversation.';

/** Prompts its empty state offers; a click puts one in the composer. Android offers the same three. */
export const ORCHESTRATOR_EXAMPLES: readonly string[] = ['Get CI green on every floor', 'Triage the open issues across my projects and put workers on the top three', 'What is everyone doing?'];

/**
 * The Orchestrator as a worker: its session's, or before its first prompt (and after a new conversation)
 * an idle stand-in with no session, so its row, pane and composer have something to show. Undefined while it's off.
 */
export function orchestratorWorker(state: MissionControlState | undefined): WorkerInfo | undefined {
  const o = state?.orchestrator;
  if (!o?.settings.on) return undefined;
  if (o.agent) return o.agent.worker;
  return {
    id: ORCHESTRATOR_ID,
    kind: 'agent',
    name: ORCHESTRATOR_NAME,
    color: ORCHESTRATOR_COLOR,
    deskId: '',
    status: 'idle',
    acked: true,
    createdBy: '',
    createdAt: 0,
    cols: 0,
    rows: 0,
    open: false,
    ...(o.settings.model ? { model: o.settings.model } : {}),
    ...(o.settings.effort ? { effort: o.settings.effort } : {}),
  };
}

/** Whether the Orchestrator has a conversation yet: until then there is no session to read or terminal to show. */
export function orchestratorStarted(state: MissionControlState | undefined): boolean {
  return !!state?.orchestrator.settings.on && !!state.orchestrator.agent;
}

/**
 * A building agent with its team, by id: an external bot, or the Orchestrator while it's on. Before its first
 * prompt and after a new conversation the Orchestrator is its stand-in, still leading the team it kept.
 */
export function buildingAgent(state: MissionControlState | undefined, id: string): MissionAgent | undefined {
  if (id !== ORCHESTRATOR_ID) return missionAgent(state, id);
  const worker = orchestratorWorker(state);
  return worker && (state?.orchestrator.agent ?? { worker, team: state?.orchestrator.team ?? [] });
}

/** A building agent as a worker, by id: the Orchestrator (even before its first prompt) or an external bot. */
export function missionWorker(state: MissionControlState | undefined, id: string): WorkerInfo | undefined {
  return buildingAgent(state, id)?.worker;
}

/** The building agents that wait on the owner, for the tab title, notifications and the menu bar. */
export function missionWaiting(state: MissionControlState | undefined): number {
  return orchestratorNeedsOwner(state) ? 1 : 0;
}

/** The building agent a worker reports to, when its lead is one: the Orchestrator only while it's on. */
export function missionLead(state: MissionControlState | undefined, lead: string | undefined): MissionAgent | undefined {
  return lead ? buildingAgent(state, lead) : undefined;
}

/**
 * Why the Orchestrator can't start, while it has no session running (none yet, or asleep). A session that is
 * running keeps its status and its Stop, as the 3D office's `orchestratorPhase` has it.
 */
export function orchestratorBlocked(state: MissionControlState | undefined): string | undefined {
  const o = state?.orchestrator;
  const w = o?.agent?.worker;
  return o?.settings.on && o.blocked && (!w || isAsleep(w.status)) ? o.blocked : undefined;
}

/**
 * The Settings pane to open about the Orchestrator: where what blocks it is fixed (Connections for Droid,
 * Subagents & visits for the Office MCP), else its own. A pane this client doesn't have is its own too.
 */
export function orchestratorSettingsPane(state: MissionControlState | undefined): SettingsPane {
  const pane = orchestratorBlocked(state) ? state?.orchestrator.blockedPane : undefined;
  return SETTINGS_PANES.find((p) => p.id === pane)?.id ?? 'orchestrator';
}

/** The Orchestrator in a line: off, why it can't start, what it's doing, or that it's ready for a task. */
export function orchestratorLine(state: MissionControlState | undefined): string {
  const o = state?.orchestrator;
  if (!o?.settings.on) return 'Off. Turn it on in Settings → Orchestrator.';
  const blocked = orchestratorBlocked(state);
  if (blocked) return blocked;
  const w = o.agent?.worker;
  if (!w || (w.status === 'idle' && !w.task && !w.title && !w.activity)) return 'Ready for a task anywhere in the building';
  return doingLine(w);
}

/**
 * What a worker message means for the Orchestrator: a prompt and Stop are its own messages, which start
 * or wake its session; answers, terminal input and reads stay worker messages addressed to its id.
 */
export function orchestratorMessage(msg: ClientMsg): ClientMsg {
  if (msg.t === 'worker.prompt') return { t: 'orchestrator.prompt', prompt: msg.prompt, ...(msg.images?.length ? { images: msg.images } : {}), ...(msg.queue ? { queue: true } : {}) };
  if (msg.t === 'worker.interrupt') return { t: 'orchestrator.interrupt' };
  return msg;
}

/** An external bot in a line: what it last reported, or that it hasn't since the office started. */
export function botLine(bot: MissionAgent): string {
  const w = bot.worker;
  if (w.status === 'offline') return 'Hasn’t reported since the office started';
  return w.activity ?? w.title ?? doingLine(w);
}
