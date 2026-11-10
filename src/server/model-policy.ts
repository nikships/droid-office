// Which models an Office MCP caller may give a worker: ⚙️ Settings → Subagents & visits → "Models leads can pick".
// Every Office MCP path that sets a worker's model (team_models, office_whoami, team_hire, office_worker_spawn,
// models_list) asks this module, so they cannot drift apart. The owner's own hires from a window are never limited.

import type { SubagentModel, SubagentSettings, WorkerInfo } from '../shared/protocol.js';
import { ignoresModelList } from './building-agent.js';

/**
 * The picks that limit `caller`: undefined when it may use any model (nothing is picked, or it is an
 * external bot). The Orchestrator and every floor lead keep to the list.
 */
export function modelList(caller: Pick<WorkerInfo, 'id' | 'remote'>, settings: Pick<SubagentSettings, 'models'>): readonly SubagentModel[] | undefined {
  return settings.models?.length && !ignoresModelList(caller) ? settings.models : undefined;
}

/**
 * `model` is outside the list. `fallback` is the model a hire without one runs (or Droid's own default
 * when the office has none), which is always allowed.
 */
export function outsideModelList(list: readonly SubagentModel[] | undefined, model: string, fallback: string | undefined): boolean {
  return !!list && model !== fallback && !list.some((m) => m.id === model);
}

/** What a refused caller is told; `shown` is the model id, already shortened for a message. */
export function outsideModelListMessage(shown: string): string {
  return `${shown} isn't one of the models this office lets subagents use (⚙️ Settings → Subagents & visits): pick one from team_models, or leave model out for the default`;
}
