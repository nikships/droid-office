import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { SUBAGENT_DEFAULTS, SUBAGENT_MAX_PER_LEAD, isAgentEffort, type AgentChoice, type SubagentSettings, type SubagentsState } from '../shared/protocol.js';
import { agentChoiceProblem } from './prompts.js';

/** Where Droid looks for the user's own skills, on every project. */
export const FACTORY_SKILLS_DIR = path.join(homedir(), '.factory', 'skills');
export const SKILL_NAME = 'droid-office-subagents';
/** The line that says the office wrote the skill, so it rewrites or removes only its own file. */
export const SKILL_MARK = '<!-- Written by Droid Office (⚙️ Settings → Subagents), which keeps this file up to date: edits here are overwritten. Turn the skill off there to remove it. -->';

/**
 * The Droid skill that tells a Droid how to hire subagents in the office. It lives with the
 * user's own skills, so every droid session sees it: its description and its first step keep it to
 * sessions the office started (they have DROID_OFFICE_WORKER_ID), and it hands everything else to
 * `office-workers help`, which always matches the office that's running.
 */
export function subagentSkill(): string {
  return `---
name: ${SKILL_NAME}
description: Spawn and coordinate subagents as new Droid Office droids, each at its own desk with a laptop and a live terminal in your room. Use only when the DROID_OFFICE_WORKER_ID environment variable is set (this session is a Droid Office droid) and you are asked to, or decide to, delegate work to subagents. Outside Droid Office this skill does not apply; never use it there.
---

${SKILL_MARK}

# Subagents in Droid Office

In Droid Office a subagent is a real droid: it sits down at a free desk near you, with its own laptop and a terminal anyone in the office can open, works in its own git worktree, and reports back to you when it's done. You hire and run subagents with the \`office-workers\` command. Use it instead of the built-in Task tool, or any terminal-pane workflow, whenever you delegate work here.

## 1. Check that you're in Droid Office

\`\`\`bash
[ -n "$DROID_OFFICE_WORKER_ID" ] && command -v office-workers >/dev/null && office-workers whoami
\`\`\`

- Nothing printed, or an error: this session isn't a Droid Office droid. The skill doesn't apply: stop following it and carry on without it. Don't install or imitate \`office-workers\`.
- It says you're a subagent: you can't hire. Do your task yourself and report to your lead with \`office-workers report\`.
- It says you can't hire for another reason (subagents are turned off, say): tell the user what it said and carry on without subagents.

## 2. Read the guide

\`\`\`bash
office-workers help
\`\`\`

It covers every command and flag, and how to brief, wait for, read, answer and dismiss subagents. Don't guess flags.

## 3. Rules

- One task, one fresh subagent. Don't hand a new task to a subagent that finished another: hire a new one.
- A subagent starts knowing nothing. Write it a complete brief: the goal, where to look, what's off limits, how to check its work, and how to finish (commit in its worktree and open a pull request, or just report back).
- Give the brief on stdin in a quoted heredoc (\`<<'EOF'\`), never inline in the command.
- Unless \`office-workers whoami\` says otherwise, every subagent gets its own git worktree, cut from the latest on the forge. Pass \`--no-worktree\` only for read-only work, or when it must see your uncommitted changes.
- Split the work so no two subagents edit the same files, and don't hire more subagents than the work needs.
- After hiring, run \`office-workers wait\` until each one has reported, and answer questions with \`office-workers send\`. Look at their changes before you count the work as done.
- Cleanup is never automatic. When the work is done, tell the user what each subagent did and ask before you \`office-workers dismiss\` anyone.
`;
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
  return { on: bool('on'), deskWorkers: bool('deskWorkers'), skill: bool('skill'), worktree: bool('worktree'), wakeLead: bool('wakeLead'), maxPerLead: max, ...(agent ? { agent } : {}) };
}

/**
 * How droids hire subagents (⚙️ Settings → Subagents), for every floor, kept in
 * .droid-office/subagents.json, and the Droid skill that goes with it in ~/.factory/skills.
 */
export class Subagents {
  private saved: SubagentSettings & { by?: string; at?: number };
  private path: string;
  private skill: { path?: string; error?: string } = {};

  constructor(
    dataDir: string,
    private onState: (state: SubagentsState) => void,
    /** Where the skill goes; none (tests) writes no skill. */
    private skillsDir: string | undefined,
  ) {
    this.path = path.join(dataDir, 'subagents.json');
    this.saved = this.restore();
  }

  get settings(): SubagentSettings {
    const { by: _by, at: _at, ...settings } = this.saved;
    return { ...settings, ...(settings.agent ? { agent: { ...settings.agent } } : {}) };
  }

  state(): SubagentsState {
    return { ...this.settings, ...(this.saved.by ? { by: this.saved.by, at: this.saved.at } : {}), ...(this.skill.path ? { skillPath: this.skill.path } : {}), ...(this.skill.error ? { skillError: this.skill.error } : {}) };
  }

  /** Saves new settings (all of them: no `agent` is the office's default droid); returns why it can't, if it can't. */
  set(raw: unknown, by: string): string | undefined {
    const { agent: _agent, ...rest } = this.settings;
    const next = cleanSettings(raw, rest);
    if (next.agent) {
      const why = agentChoiceProblem(next.agent);
      if (why) return why;
    }
    this.saved = { ...next, by, at: Date.now() };
    this.persist();
    this.syncSkill();
    this.onState(this.state());
    return undefined;
  }

  /**
   * Puts the skill in place, or takes it away, as the settings say. Only ever a SKILL.md the office
   * wrote itself (SKILL_MARK): one the user wrote under the same name is left alone. Says whether
   * where the skill is (or why it isn't) changed.
   */
  syncSkill(): boolean {
    const before = JSON.stringify(this.skill);
    this.writeSkill();
    return JSON.stringify(this.skill) !== before;
  }

  private writeSkill() {
    if (!this.skillsDir) return;
    const dir = path.join(this.skillsDir, SKILL_NAME);
    const file = path.join(dir, 'SKILL.md');
    let current: string | undefined;
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      current = undefined;
    }
    const ours = current === undefined || current.includes(SKILL_MARK);
    this.skill = {};
    try {
      if (this.saved.skill && this.saved.on) {
        if (!ours) {
          this.skill = { error: `${file} is a skill the office didn't write, so it's left as it is` };
          return;
        }
        const text = subagentSkill();
        if (current !== text) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(file, text);
        }
        this.skill = { path: file };
      } else if (current !== undefined && ours) {
        rmSync(file, { force: true });
        // The folder goes too, unless someone put something else in it.
        if (existsSync(dir) && !readdirSync(dir).length) rmdirSync(dir);
      }
    } catch (err) {
      this.skill = { error: `Couldn't ${this.saved.skill && this.saved.on ? 'write' : 'remove'} ${file}: ${(err as Error).message}` };
    }
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
