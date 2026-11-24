/**
 * Droid's slash commands, and what the Thread view does with each. A slash command typed into the
 * composer goes to Droid's input box like any message, so Droid runs it.
 *
 * The built-in ones are listed here: droid lists no built-ins over JSON-RPC, and each needs its own
 * handling. Most open one of Droid's own dialogs (a model picker, settings, a session list), which
 * only the terminal can show: those send and then switch to Raw TTY. The rest run without one and
 * the view stays. Ending the CLI is refused: Send home is how a worker leaves. The names and
 * descriptions follow Droid 1.12.1's command registry; `midTurn` marks the ones it opens while a turn
 * runs (others answer "can only be used when the agent is idle" or ask to stop the turn).
 *
 * The worker's skills and custom commands come from its own droid (`droid.list_skills` and
 * `droid.list_commands`, asked in its folder by src/server/droid-commands.ts and served at
 * GET /api/agents/droid/commands?worker=). They run as prompts, so the view stays.
 *
 * The Android app has the same built-in list (core/SlashCommands.kt), checked by tests/slash-commands.test.ts.
 */

export type SlashKind = 'thread' | 'tty' | 'blocked';

export interface SlashCommand {
  name: string;
  description: string;
  kind: SlashKind;
  aliases?: readonly string[];
  /** Where a command that isn't built in comes from: one of the worker's skills, or a custom command. */
  source?: DroidSlashCommand['source'];
  /** What to type after the name, as the command describes it. */
  argumentHint?: string;
  /** Droid runs it during a turn (a dialog or setting that leaves the turn running) instead of asking to stop the turn. */
  midTurn?: boolean;
}

/** A skill or custom command a worker's droid offers, as GET /api/agents/droid/commands lists it. */
export interface DroidSlashCommand {
  name: string;
  description: string;
  source: 'skill' | 'command';
  argumentHint?: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'compress', aliases: ['compact'], description: 'Compress the session in place. Add instructions to shape the summary', kind: 'thread' },
  { name: 'clear', description: 'Clear the conversation, keeping the model', kind: 'thread' },
  { name: 'new', description: 'Start a fresh session with the default model', kind: 'thread' },
  { name: 'handoff', description: 'Start a new session with a summary of this one', kind: 'thread' },
  { name: 'fast', description: 'Turn fast mode on for the current model (/fast off to turn it off)', kind: 'thread' },
  { name: 'favorite', aliases: ['pin'], description: 'Pin this session for quick access', kind: 'thread', midTurn: true },
  { name: 'archive', description: 'Archive the session. Continuing it or restoring it from /sessions brings it back', kind: 'thread' },
  { name: 'vim', description: 'Turn vim keys on or off in the input box', kind: 'thread' },
  { name: 'btw', aliases: ['side'], description: 'Ask a side question without adding it to the conversation', kind: 'thread', midTurn: true },
  { name: 'readiness-report', description: 'Generate a readiness report for this repository', kind: 'thread' },
  { name: 'readiness-fix', description: 'Apply the readiness report’s fixes', kind: 'thread' },
  { name: 'install-code-review', description: 'Set up Factory code review for this repository', kind: 'thread' },
  { name: 'model', description: 'Choose the model', kind: 'tty', midTurn: true },
  { name: 'settings', description: 'Change Droid’s settings', kind: 'tty', midTurn: true },
  { name: 'copy', description: 'Copy a reply, a prompt, a range of turns, the transcript or the session id', kind: 'tty', midTurn: true },
  { name: 'tree', description: 'Move around the session’s fork tree', kind: 'tty' },
  { name: 'rewind-conversation', description: 'Rewind the conversation to an earlier message', kind: 'tty' },
  { name: 'sessions', aliases: ['resume'], description: 'Resume an earlier session', kind: 'tty', midTurn: true },
  { name: 'share', description: 'Share the session with your organization', kind: 'tty' },
  { name: 'review', description: 'Run a code review on the current changes', kind: 'tty', midTurn: true },
  { name: 'missions', aliases: ['workstreams'], description: 'Open the missions picker', kind: 'tty', midTurn: true },
  { name: 'create-skill', description: 'Create a skill from this conversation', kind: 'tty' },
  { name: 'mcp', description: 'Manage MCP servers', kind: 'tty', midTurn: true },
  { name: 'connectors', description: 'Manage connectors and MCP servers', kind: 'tty', midTurn: true },
  { name: 'skills', description: 'Manage skills', kind: 'tty', midTurn: true },
  { name: 'droids', description: 'Manage custom droids', kind: 'tty', midTurn: true },
  { name: 'commands', description: 'Manage custom slash commands', kind: 'tty', midTurn: true },
  { name: 'hooks', description: 'Manage tool hooks', kind: 'tty', midTurn: true },
  { name: 'plugins', description: 'Manage plugins and marketplaces', kind: 'tty', midTurn: true },
  { name: 'limits', description: 'Manage credit limits and overage', kind: 'tty', midTurn: true },
  { name: 'diagnostics', description: 'Open the diagnostics menu', kind: 'tty', midTurn: true },
  { name: 'ide', description: 'Manage IDE integration', kind: 'tty' },
  { name: 'bug', description: 'Report a bug to Factory', kind: 'tty' },
  { name: 'install-slack-app', description: 'Install the Factory Slack app', kind: 'tty' },
  { name: 'setup-incident-response', description: 'Set up incident response for a Slack channel', kind: 'tty' },
  { name: 'statusline', description: 'Set up a custom status line', kind: 'tty' },
  { name: 'themes', description: 'Choose a color theme', kind: 'tty', midTurn: true },
  { name: 'language', description: 'Change the display language', kind: 'tty', midTurn: true },
  { name: 'terminal-setup', description: 'Set up keys for multi-line input', kind: 'tty' },
  { name: 'cd', aliases: ['cwd'], description: 'Change the session’s working directory', kind: 'tty' },
  { name: 'account', description: 'Open your Factory account in the browser', kind: 'tty', midTurn: true },
  { name: 'billing', description: 'Open Factory billing in the browser', kind: 'tty', midTurn: true },
  { name: 'login', description: 'Log in to Factory', kind: 'tty' },
  { name: 'logout', description: 'Log out of Factory', kind: 'tty' },
  { name: 'quit', aliases: ['exit'], description: 'Ends this worker’s Droid. Use Send home instead', kind: 'blocked' },
];
/**
 * Every slash command a worker offers: the built-in ones, then its droid's custom commands and
 * skills. One named like a built-in command (or its alias) is left out, since Droid runs the built-in.
 */
export function slashCommands(live: readonly DroidSlashCommand[] = []): SlashCommand[] {
  const taken = new Set(SLASH_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
  const extra: SlashCommand[] = [];
  for (const c of live) {
    if (typeof c?.name !== 'string' || typeof c.description !== 'string' || (c.source !== 'skill' && c.source !== 'command')) continue;
    const name = c.name.toLowerCase();
    if (taken.has(name)) continue;
    taken.add(name);
    extra.push({ name: c.name, description: c.description, kind: 'thread', source: c.source, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) });
  }
  return [...SLASH_COMMANDS, ...extra];
}

/** What a draft that starts with `/` asks for: the command's name as typed, and the command when the list has it. */
export function slashOf(draft: string, commands: readonly SlashCommand[] = SLASH_COMMANDS): { name: string; command?: SlashCommand } | undefined {
  const m = /^\/([^\s/]*)(?=\s|$)/.exec(draft.trimStart());
  if (!m) return undefined;
  const name = m[1].toLowerCase();
  return { name, command: commands.find((c) => c.name.toLowerCase() === name || c.aliases?.includes(name)) };
}

/** What a slash draft does when sent: run in the thread, run and open Raw TTY, or nothing. A plain message is 'thread'. */
export function slashKind(draft: string): SlashKind {
  return slashOf(draft)?.command?.kind ?? 'thread';
}

/** Connected offices show their own limits window, even when Factory cannot report quota windows. */
export function nativeLimits(draft: string, factoryConnected: boolean): boolean {
  return factoryConnected && slashOf(draft)?.command?.name === 'limits';
}

/** A bare `/copy` opens the Thread's own copy choices (Droid's /copy menu) instead of the terminal's. */
export function nativeCopy(draft: string): boolean {
  return slashOf(draft)?.command?.name === 'copy' && !/\s\S/.test(draft.trim());
}

/** The question a `/btw` (or `/side`) draft asks, or undefined for any other draft. */
export function sideQuestion(draft: string): string | undefined {
  const slash = slashOf(draft);
  if (slash?.command?.name !== 'btw') return undefined;
  return draft.trim().replace(/^\/\S+\s*/, '');
}

/**
 * Why a slash draft can't be sent now, or undefined when it can: a command that would end the CLI
 * never, and while a turn runs only those Droid runs mid-turn; any other one Droid would refuse, or
 * ask in the terminal to stop the turn.
 */
export function slashRefusal(draft: string, name: string, busy: boolean, commands: readonly SlashCommand[] = SLASH_COMMANDS): string | undefined {
  const slash = slashOf(draft, commands);
  if (!slash) return undefined;
  if (slash.command?.kind === 'blocked') return `/${slash.name} would end ${name}’s Droid. Send it home instead.`;
  if (busy && !slash.command?.midTurn) return `/${slash.name} runs once ${name} finishes this turn. Stop it to run it now.`;
  return undefined;
}

export interface SlashQuery {
  start: number;
  end: number;
  query: string;
  /** True when `/` starts the first non-whitespace token in the draft. */
  atStart: boolean;
}

const SLASH_TOKEN_REST = /^[a-z0-9._:-]*$/i;

/**
 * Detects an active `/<query>` token at `cursor`: at the start of the draft or after whitespace,
 * with no whitespace or second `/` inside the token and only valid command-name characters.
 * Returns `null` for URLs (`https://...`), relative or absolute paths (`src/a`, `/etc/hosts`),
 * code comments (`//`, `/*`), JSX (`/>`), or cursors outside a slash token.
 */
export function findSlashQuery(value: string, cursor: number = value.length): SlashQuery | null {
  if (!value) return null;
  const pos = Math.max(0, Math.min(value.length, Math.trunc(cursor)));
  let start = pos;
  while (start > 0 && !/\s/.test(value[start - 1])) start--;
  if (start >= pos || value[start] !== '/') return null;

  let end = pos;
  while (end < value.length && !/\s/.test(value[end])) end++;

  const tokenRest = value.slice(start + 1, end);
  if (!SLASH_TOKEN_REST.test(tokenRest)) return null;

  const query = value.slice(start + 1, pos);
  const atStart = !/\S/.test(value.slice(0, start));
  return { start, end, query, atStart };
}

/**
 * Replaces the slash token `[start, end)` in `value` with `/<name> ` (avoiding a duplicate space
 * when one already follows) and places the cursor right after that space.
 */
export function applySlash(value: string, start: number, end: number, name: string): { value: string; cursor: number } {
  const s = Math.max(0, Math.min(value.length, Math.trunc(start)));
  const e = Math.max(s, Math.min(value.length, Math.trunc(end)));
  const clean = name.trim().replace(/^\/+/, '');
  const hasSpaceAfter = e < value.length && value[e] === ' ';
  const inserted = hasSpaceAfter ? `/${clean}` : `/${clean} `;
  return {
    value: `${value.slice(0, s)}${inserted}${value.slice(e)}`,
    cursor: s + 1 + clean.length + 1,
  };
}

/**
 * The commands to offer while the owner types a `/` token at `cursor` (defaults to the end of
 * `draft`): at the start of the draft, built-ins, custom commands, and skills are all offered;
 * mid-draft (after whitespace following earlier text) or when `inlineOnly` is true (a prepended
 * context precedes the draft), only skills are offered, unless the draft starts with a resolved
 * non-skill slash command (which owns the rest of the message in Droid). Exact matches come first,
 * then names that start with what's typed, then aliases, then names containing it.
 */
export function slashSuggestions(draft: string, commands: readonly SlashCommand[] = SLASH_COMMANDS, cursor: number = draft.length, inlineOnly = false): SlashCommand[] {
  const found = findSlashQuery(draft, cursor);
  if (!found) return [];
  let pool = commands;
  if (inlineOnly || !found.atStart) {
    if (!inlineOnly) {
      const leading = slashOf(draft, commands);
      if (leading?.command && leading.command.source !== 'skill') return [];
    }
    pool = commands.filter((c) => c.source === 'skill');
  }
  const typed = found.query.toLowerCase();
  const rank = (c: SlashCommand) => {
    const name = c.name.toLowerCase();
    if (typed && name === typed) return 0;
    if (name.startsWith(typed)) return 1;
    if (c.aliases?.some((a) => a.startsWith(typed))) return 2;
    if (name.includes(typed)) return 3;
    return -1;
  };
  return pool
    .map((c, i) => ({ c, r: rank(c), i }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}
