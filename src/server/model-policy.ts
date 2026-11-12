// Which models an Office MCP caller may give a worker: ⚙️ Settings → Subagents & visits → "Models leads can pick".
// Every Office MCP path that sets or defaults a worker's model (team_models, office_whoami, team_hire,
// office_worker_spawn, models_list) asks this module, so they cannot drift apart. The owner's own hires from a window
// are never limited, and existing workers keep their saved models when resumed or messaged.

import type { SubagentModel, SubagentSettings } from '../shared/protocol.js';

/**
 * The picks that limit every Office MCP caller (floor leads, the Orchestrator and external bots alike):
 * undefined when nothing is picked in Settings, meaning any current model may be used.
 */
export function modelList(settings: Pick<SubagentSettings, 'models'>): readonly SubagentModel[] | undefined {
  return settings.models?.length ? settings.models : undefined;
}

/** Whether `model` (an explicit model id, or `undefined` when no default resolved) is outside `list`. */
export function outsideModelList(list: readonly SubagentModel[] | undefined, model: string | undefined): boolean {
  return !!list && (!model || !list.some((m) => m.id === model));
}

/**
 * What a refused caller is told when a requested or default model is outside `list`, naming the allowed model ids.
 * `shown`: the requested or resolved default model id (already shortened for a message), or `undefined` when no
 * default model resolved. `named`: true when the caller passed `model` explicitly, false when `model` was omitted.
 */
export function outsideModelListMessage(shown: string | undefined, list: readonly SubagentModel[], named = true): string {
  const allowed = list.map((m) => m.id).join(', ');
  if (!named) {
    const which = shown ? `The default model (${shown}) isn't` : 'No default model is';
    return `${which} on this office's allowed list (⚙️ Settings → Subagents & visits): pass model explicitly using one of the allowed models (${allowed}) from team_models`;
  }
  return `${shown} isn't one of the models this office lets subagents use (⚙️ Settings → Subagents & visits): pick an allowed model from team_models (${allowed})`;
}
