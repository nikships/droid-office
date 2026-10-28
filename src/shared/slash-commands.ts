/**
 * Droid's built-in slash commands, and what the Thread view does with each. A slash command typed
 * into the composer goes to Droid's input box like any message, so Droid runs it. Most of them open
 * one of Droid's own dialogs (a model picker, settings, a session list), which only the terminal
 * can show: those send and then switch to Raw TTY. The rest run without one and the view stays.
 * Ending the CLI is refused: Send home is how a worker leaves. A command Droid doesn't list here
 * (a skill, a custom command) is sent and the view stays: Droid runs it as a prompt.
 *
 * The Android app has the same list (core/SlashCommands.kt), checked by tests/slash-commands.test.ts.
 */

export type SlashKind = 'thread' | 'tty' | 'blocked';

export interface SlashCommand {
  name: string;
  description: string;
  kind: SlashKind;
  aliases?: readonly string[];
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'compress', aliases: ['compact'], description: 'Compress the session in place. Add instructions to shape the summary', kind: 'thread' },
  { name: 'clear', description: 'Clear the conversation, keeping the model and autonomy', kind: 'thread' },
  { name: 'new', description: 'Start a fresh session with the default model and autonomy', kind: 'thread' },
  { name: 'handoff', description: 'Start a new session with a summary of this one', kind: 'thread' },
  { name: 'fast', description: 'Turn fast mode on for the current model (/fast off to turn it off)', kind: 'thread' },
  { name: 'favorite', aliases: ['pin'], description: 'Pin this session for quick access', kind: 'thread' },
  { name: 'vim', description: 'Turn vim keys on or off in the input box', kind: 'thread' },
  { name: 'model', description: 'Choose the model', kind: 'tty' },
  { name: 'settings', description: 'Change Droid’s settings', kind: 'tty' },
  { name: 'context', description: 'See what fills the context window', kind: 'tty' },
  { name: 'status', description: 'See the CLI’s status and configuration', kind: 'tty' },
  { name: 'stats', description: 'See your Droid usage', kind: 'tty' },
  { name: 'btw', description: 'Ask a side question without adding it to the conversation', kind: 'tty' },
  { name: 'copy', description: 'Copy prompts, replies, turns or the session id', kind: 'tty' },
  { name: 'rename', description: 'Rename the session', kind: 'tty' },
  { name: 'fork', description: 'Fork the session', kind: 'tty' },
  { name: 'tree', description: 'Move around the session’s fork tree', kind: 'tty' },
  { name: 'rewind-conversation', description: 'Rewind the conversation to an earlier message', kind: 'tty' },
  { name: 'sessions', aliases: ['resume'], description: 'Resume an earlier session', kind: 'tty' },
  { name: 'share', description: 'Share the session with your organization', kind: 'tty' },
  { name: 'mcp', description: 'Manage MCP servers', kind: 'tty' },
  { name: 'connectors', description: 'Manage connectors and MCP servers', kind: 'tty' },
  { name: 'skills', description: 'Manage skills', kind: 'tty' },
  { name: 'droids', description: 'Manage custom droids', kind: 'tty' },
  { name: 'commands', description: 'Manage custom slash commands', kind: 'tty' },
  { name: 'hooks', description: 'Manage tool hooks', kind: 'tty' },
  { name: 'plugins', description: 'Manage plugins and marketplaces', kind: 'tty' },
  { name: 'limits', description: 'Manage credit limits and overage', kind: 'tty' },
  { name: 'statusline', description: 'Set up a custom status line', kind: 'tty' },
  { name: 'themes', description: 'Choose a color theme', kind: 'tty' },
  { name: 'language', description: 'Change the display language', kind: 'tty' },
  { name: 'terminal-setup', description: 'Set up keys for multi-line input', kind: 'tty' },
  { name: 'cd', aliases: ['cwd'], description: 'Change the session’s working directory', kind: 'tty' },
  { name: 'account', description: 'Open your Factory account in the browser', kind: 'tty' },
  { name: 'billing', description: 'Open Factory billing in the browser', kind: 'tty' },
  { name: 'login', description: 'Log in to Factory', kind: 'tty' },
  { name: 'logout', description: 'Log out of Factory', kind: 'tty' },
  { name: 'quit', aliases: ['exit'], description: 'Ends this worker’s Droid. Use Send home instead', kind: 'blocked' },
];

/** What a draft that starts with `/` asks for: the command's name as typed, and the command when Droid has it built in. */
export function slashOf(draft: string): { name: string; command?: SlashCommand } | undefined {
  const m = /^\/([^\s/]*)/.exec(draft.trimStart());
  if (!m) return undefined;
  const name = m[1].toLowerCase();
  return { name, command: SLASH_COMMANDS.find((c) => c.name === name || c.aliases?.includes(name)) };
}

/** What a slash draft does when sent: run in the thread, run and open Raw TTY, or nothing. A plain message is 'thread'. */
export function slashKind(draft: string): SlashKind {
  return slashOf(draft)?.command?.kind ?? 'thread';
}

/**
 * Why a slash draft can't be sent now, or undefined when it can: a command that would end the CLI
 * never, and none while a turn runs, when Droid would take it as steering.
 */
export function slashRefusal(draft: string, name: string, busy: boolean): string | undefined {
  const slash = slashOf(draft);
  if (!slash) return undefined;
  if (slash.command?.kind === 'blocked') return `/${slash.name} would end ${name}’s Droid. Send it home instead.`;
  if (busy) return `Slash commands run once ${name} finishes this turn. Stop it to run one now.`;
  return undefined;
}

/**
 * The commands to offer while the owner types one: only while the draft is a `/` and the start of a
 * name, with no space yet. Names that start with what's typed come first, then aliases, then names
 * that contain it.
 */
export function slashSuggestions(draft: string, limit = 8): SlashCommand[] {
  const m = /^\/([^\s/]*)$/.exec(draft.trimStart());
  if (!m) return [];
  const typed = m[1].toLowerCase();
  const rank = (c: SlashCommand) => (c.name.startsWith(typed) ? 0 : c.aliases?.some((a) => a.startsWith(typed)) ? 1 : c.name.includes(typed) ? 2 : -1);
  return SLASH_COMMANDS.map((c, i) => ({ c, r: rank(c), i }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.c);
}
