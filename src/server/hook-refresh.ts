/**
 * What a worker's finished tool call may have changed that the office shows, so it can look again
 * at once instead of on its next timer: its Changes window after a file edit or a command, its branch
 * after a switch, and the floor's pull requests and pipelines after a push or a pull request command.
 */
export interface ToolRefresh {
  /** Its files or commits: the Changes window. */
  changes?: true;
  /** The branch its checkout is on. */
  branch?: true;
  /** The floor's pull requests (and issues) on the forge. */
  board?: true;
  /** The floor's CI runs: a push starts them. */
  pipelines?: true;
}

const EDIT_TOOLS = new Set<unknown>(['Create', 'Edit', 'MultiEdit', 'ApplyPatch', 'Write', 'NotebookEdit']);
const SHELL_TOOLS = new Set<unknown>(['Execute', 'Bash']);

/** `git`, with any of its global options (-C dir, -c key=value, --no-pager…) before the subcommand. */
const GIT = String.raw`\bgit(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*\s+`;
const BRANCH = [new RegExp(`${GIT}(?:switch|checkout|worktree)\\b`), new RegExp(`${GIT}branch\\s+(?:-[mM]|--move)\\b`), /\bgh\s+pr\s+checkout\b/, /\bglab\s+mr\s+checkout\b/];
const PUSH = new RegExp(`${GIT}push\\b`);
const BOARD = [/\bgh\s+pr\s+(?:create|merge|close|ready|reopen|edit)\b/, /\bglab\s+mr\s+(?:create|merge|close|update|reopen|approve)\b/, /\bgh\s+issue\s+(?:create|close|reopen|edit)\b/, /\bglab\s+issue\s+(?:create|close|reopen|update)\b/];
/** Merging can start CI on the branch it merged into. */
const MERGE = /\b(?:gh\s+pr|glab\s+mr)\s+merge\b/;

/** What to look at again after `tool` ran with `input`; undefined when nothing the office shows can have changed. */
export function toolRefresh(tool: unknown, input: unknown): ToolRefresh | undefined {
  if (EDIT_TOOLS.has(tool)) return { changes: true };
  if (!SHELL_TOOLS.has(tool)) return undefined;
  const command = input && typeof input === 'object' ? (input as Record<string, unknown>).command : undefined;
  const refresh: ToolRefresh = { changes: true };
  if (typeof command !== 'string') return refresh;
  if (BRANCH.some((re) => re.test(command))) refresh.branch = true;
  const push = PUSH.test(command);
  if (push || BOARD.some((re) => re.test(command))) refresh.board = true;
  if (push || MERGE.test(command)) refresh.pipelines = true;
  return refresh;
}

/**
 * Calls `fn` once, `ms` after the last of a burst of calls: a worker pushing three times, or three
 * workers each opening a pull request, cost the forge one look.
 */
export function debounce(fn: () => void, ms: number): { (): void; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const call = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, ms);
    timer.unref?.();
  };
  call.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return call;
}
