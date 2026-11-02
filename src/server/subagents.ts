import { readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { SUBAGENT_DEFAULTS, SUBAGENT_MAX_PER_LEAD, SUBAGENT_MODEL_NOTE_MAX, SUBAGENT_MODELS_MAX, isAgentEffort, type AgentChoice, type SubagentModel, type SubagentSettings, type SubagentsState } from '../shared/protocol.js';
import { isValidDroidModel } from './agents.js';
import { oneLine } from './droid-models.js';
import { agentChoiceProblem } from './prompts.js';

/** Where Droid looks for the user's own skills, on every project. */
export const FACTORY_SKILLS_DIR = path.join(homedir(), '.factory', 'skills');
/** Legacy ownership marks: remove only the bundled skills the office wrote, never a user's skill. */
export const SKILL_MARK = '<!-- Written by Droid Office (⚙️ Settings → Subagents & visits), which keeps this file up to date: edits here are overwritten. Turn the skill off there to remove it. -->';
export const WHITEBOARD_SKILL_MARK = '<!-- Written by Droid Office (⚙️ Settings → Droid → Whiteboard skill), which keeps this file up to date: edits here are overwritten. Turn the skill off there to remove it. -->';

/** One-time startup migration to the Office MCP. Missing files are normal; failures are warnings. */
export function removeBundledSkills(skillsDir: string | undefined): string[] {
  const problems: string[] = [];
  if (!skillsDir) return problems;
  for (const [name, mark] of [
    ['droid-office-subagents', SKILL_MARK],
    ['droid-office-whiteboard', WHITEBOARD_SKILL_MARK],
  ]) {
    const dir = path.join(skillsDir, name);
    const file = path.join(dir, 'SKILL.md');
    try {
      if (!readFileSync(file, 'utf8').includes(mark)) continue;
      rmSync(file);
      if (!readdirSync(dir).length) rmdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(`Couldn't remove ${file}: ${(err as Error).message}`);
    }
  }
  return problems;
}

/** Settings as they came over the wire or off disk, made safe; anything missing or wrong is the default. */
export function cleanSettings(raw: unknown, base: SubagentSettings = SUBAGENT_DEFAULTS): SubagentSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bool = (key: keyof SubagentSettings) => (typeof r[key] === 'boolean' ? (r[key] as boolean) : (base[key] as boolean));
  const max = Number.isInteger(r.maxPerLead) ? Math.min(SUBAGENT_MAX_PER_LEAD, Math.max(1, r.maxPerLead as number)) : base.maxPerLead;
  const a = r.agent as Record<string, unknown> | null | undefined;
  let agent: AgentChoice | undefined = base.agent;
  if (a === null) agent = undefined;
  else if (a && typeof a === 'object') {
    const choice: AgentChoice = { ...(typeof a.model === 'string' && a.model ? { model: a.model } : {}), ...(isAgentEffort(a.effort) ? { effort: a.effort } : {}) };
    agent = choice.model || choice.effort ? choice : undefined;
  }
  let models = base.models;
  if (r.models === null) models = undefined;
  else if (Array.isArray(r.models)) models = cleanModels(r.models);
  return {
    officeMcp: bool('officeMcp'),
    on: bool('on'),
    deskWorkers: bool('deskWorkers'),
    worktree: bool('worktree'),
    wakeLead: bool('wakeLead'),
    visits: bool('visits'),
    maxPerLead: max,
    ...(agent ? { agent } : {}),
    ...(models?.length ? { models: models.map((m) => ({ ...m })) } : {}),
  };
}

/** The models leads may pick, made safe: well-shaped ids once each, notes on one short line. */
function cleanModels(list: unknown[]): SubagentModel[] {
  const out: SubagentModel[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const e = (typeof entry === 'string' ? { id: entry } : entry) as Record<string, unknown> | null;
    if (!e || typeof e !== 'object' || !isValidDroidModel(e.id) || seen.has(e.id)) continue;
    seen.add(e.id);
    const note = oneLine(e.note, SUBAGENT_MODEL_NOTE_MAX);
    out.push({ id: e.id, ...(note ? { note } : {}) });
    if (out.length >= SUBAGENT_MODELS_MAX) break;
  }
  return out;
}

/**
 * How workers hire subagents (⚙️ Settings → Subagents & visits), for every floor, kept in
 * .droid-office/subagents.json.
 */
export class Subagents {
  private saved: SubagentSettings & { by?: string; at?: number };
  private path: string;

  constructor(
    dataDir: string,
    private onState: (state: SubagentsState) => void,
  ) {
    this.path = path.join(dataDir, 'subagents.json');
    this.saved = this.restore();
  }

  get settings(): SubagentSettings {
    const { by: _by, at: _at, ...settings } = this.saved;
    return { ...settings, ...(settings.agent ? { agent: { ...settings.agent } } : {}), ...(settings.models ? { models: settings.models.map((m) => ({ ...m })) } : {}) };
  }

  state(): SubagentsState {
    return { ...this.settings, ...(this.saved.by ? { by: this.saved.by, at: this.saved.at } : {}) };
  }

  /**
   * Saves new settings (all of them: no `agent` is the office's default worker, no `models` is any
   * model); returns why it can't, if it can't.
   */
  set(raw: unknown, by: string): string | undefined {
    const { agent: _agent, models, ...rest } = this.settings;
    const sent = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).models : undefined;
    // A models value that is neither a list nor null is malformed: it keeps the saved list, so it
    // can never widen what leads may pick.
    const malformed = sent !== undefined && sent !== null && !Array.isArray(sent);
    const next = cleanSettings(raw, malformed ? { ...rest, ...(models ? { models } : {}) } : rest);
    if (next.agent) {
      const why = agentChoiceProblem(next.agent);
      if (why) return why;
    }
    this.saved = { ...next, by, at: Date.now() };
    this.persist();
    this.onState(this.state());
    return undefined;
  }

  private restore(): SubagentSettings & { by?: string; at?: number } {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>;
    } catch {
      return { ...SUBAGENT_DEFAULTS };
    }
    const settings = cleanSettings(raw);
    // One the office can't start any more is forgotten.
    if (settings.agent && agentChoiceProblem(settings.agent)) delete settings.agent;
    return { ...settings, ...(typeof raw.by === 'string' ? { by: raw.by, at: typeof raw.at === 'number' ? raw.at : 0 } : {}) };
  }

  private persist() {
    try {
      writeFileSync(this.path, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}
