import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WhiteboardSkillState } from '../shared/protocol.js';

export const WHITEBOARD_SKILL_NAME = 'droid-office-whiteboard';
/** The line that says the office wrote the skill, so it rewrites or removes only its own file. */
export const WHITEBOARD_SKILL_MARK = '<!-- Written by Droid Office (⚙️ Settings → Droid → Whiteboard skill), which keeps this file up to date: edits here are overwritten. Turn the skill off there to remove it. -->';

/**
 * The Droid skill that tells a Droid worker how to use the floor's Whiteboard. Like the subagents
 * skill it lives with the user's own skills, applies only in sessions the office started, and hands
 * the details to `office-whiteboard help`, which always matches the office that's running.
 */
export function whiteboardSkill(): string {
  return `---
name: ${WHITEBOARD_SKILL_NAME}
description: Show the owner something on the Droid Office Whiteboard, and read what they wrote back - HTML artifacts (plans to review, choices to make, forms to fill in, diagrams, mockups, reports), comments, stickies and form answers. Use only when the DROID_OFFICE_WORKER_ID environment variable is set (this session is a Droid Office worker) and the work is visual, needs the owner's review or a decision, or the owner asks you to look at the Whiteboard. Outside Droid Office this skill does not apply; never use it there.
---

${WHITEBOARD_SKILL_MARK}

# The Droid Office Whiteboard

Your floor of Droid Office has a Whiteboard: a wall of cards the owner and every worker on the floor share. A card is an HTML page (an artifact) you push, which the owner opens in a sandboxed frame, uses (buttons, forms) and marks up with comments, stickies and pictures. You read all of it back with the \`office-whiteboard\` command.

## 1. Check that you're in Droid Office

\`\`\`bash
[ -n "$DROID_OFFICE_WORKER_ID" ] && command -v office-whiteboard >/dev/null && office-whiteboard whoami
\`\`\`

Nothing printed, or an error: this session isn't a Droid Office worker, or it can't reach the board. The skill doesn't apply: stop following it. Don't install or imitate \`office-whiteboard\`.

## 2. Read the guide

\`\`\`bash
office-whiteboard help
\`\`\`

It covers every command and flag, the \`apply\` operations, and the artifact JavaScript API. Don't guess flags.

## 3. When to use the board

- Anything visual: a UI mockup, a diagram, a chart, a screenshot with notes.
- A plan or a design the owner should review before you build it.
- A choice the owner has to make: lay out the options side by side with a button for each.
- Questions with several answers: a form the owner fills in.

Plain status updates and short answers stay in your terminal.

## 4. Rules

- Read before you change anything: \`office-whiteboard read\`. Pieces marked **changed** are what someone else (usually the owner) did since you last read that card: their comments, stickies, form answers and button presses. Answer them.
- A read moves your read point only for the cards it returned. Read a card again after the owner pings you.
- Change a card in place (\`update\`, \`state\`, \`comment … reply\`) rather than pushing a new one for every revision. Remove cards that no longer matter.
- Give elements people will comment on a \`data-wb-id\` (\`<section data-wb-id="option-a">\`), so comments stay attached when you rewrite the page.
- Lay the page out for 1280 pixels wide, and let it be as tall as it needs.
- Form fields with a \`name\` or \`id\` are saved by themselves; a \`<button data-wb-action="approve">\` records the press with no script. Use \`window.whiteboard\` for anything else (see the guide).
- Never put secrets in an artifact: it runs with network access.
- To keep a card in step with a file you're editing, \`link\` it instead of pushing it again after every change.
`;
}

/**
 * Whether the droid-office-whiteboard skill is installed (⚙️ Settings), for every floor, kept in
 * .droid-office/whiteboard-skill.json, and the skill itself in ~/.factory/skills.
 */
export class WhiteboardSkill {
  private saved: { on: boolean; by?: string; at?: number };
  private file: string;
  private skill: { path?: string; error?: string } = {};

  constructor(
    dataDir: string,
    private onState: (state: WhiteboardSkillState) => void,
    /** Where the skill goes; none (tests) writes no skill. */
    private skillsDir: string | undefined,
  ) {
    this.file = path.join(dataDir, 'whiteboard-skill.json');
    this.saved = this.restore();
  }

  state(): WhiteboardSkillState {
    return { on: this.saved.on, ...(this.saved.by ? { by: this.saved.by, at: this.saved.at } : {}), ...(this.skill.path ? { skillPath: this.skill.path } : {}), ...(this.skill.error ? { skillError: this.skill.error } : {}) };
  }

  set(on: boolean, by: string) {
    this.saved = { on, by, at: Date.now() };
    try {
      writeFileSync(this.file, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
    this.syncSkill();
    this.onState(this.state());
  }

  /**
   * Puts the skill in place, or takes it away. Only ever a SKILL.md the office wrote itself: one the
   * user wrote under the same name is left alone. Says whether where the skill is (or why it isn't) changed.
   */
  syncSkill(): boolean {
    const before = JSON.stringify(this.skill);
    this.writeSkill();
    return JSON.stringify(this.skill) !== before;
  }

  private writeSkill() {
    if (!this.skillsDir) return;
    const dir = path.join(this.skillsDir, WHITEBOARD_SKILL_NAME);
    const file = path.join(dir, 'SKILL.md');
    let current: string | undefined;
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      current = undefined;
    }
    const ours = current === undefined || current.includes(WHITEBOARD_SKILL_MARK);
    this.skill = {};
    try {
      if (this.saved.on) {
        if (!ours) {
          this.skill = { error: `${file} is a skill the office didn't write, so it's left as it is` };
          return;
        }
        const text = whiteboardSkill();
        if (current !== text) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(file, text);
        }
        this.skill = { path: file };
      } else if (current !== undefined && ours) {
        rmSync(file, { force: true });
        if (existsSync(dir) && !readdirSync(dir).length) rmdirSync(dir);
      }
    } catch (err) {
      this.skill = { error: `Couldn't ${this.saved.on ? 'write' : 'remove'} ${file}: ${(err as Error).message}` };
    }
  }

  private restore(): { on: boolean; by?: string; at?: number } {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      return { on: raw.on !== false, ...(typeof raw.by === 'string' ? { by: raw.by, at: typeof raw.at === 'number' ? raw.at : 0 } : {}) };
    } catch {
      return { on: true };
    }
  }
}
