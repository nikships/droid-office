// What a Droid worker's terminal shows it doing, as a check on the status its hooks report.
//
// The hooks miss some turns (a message queued with Ctrl+Enter starts one without UserPromptSubmit)
// and the office misses hooks that fire while it's down for longer than they retry. Droid's own
// screen says which of three states it's in, in the rows at the bottom of the terminal.

import type { WorkerStatus } from '../shared/protocol.js';

/** Busy on a turn, waiting on an answer in a dialog, or at rest at its input box. */
export type DroidScreen = 'busy' | 'asking' | 'idle';

/**
 * How long the screen has to say one thing, with no hook coming in, before the status follows it.
 * Activity hooks take priority; Stop only announces an attempted finish, so completion needs this
 * confirmation too.
 */
export const SCREEN_SETTLE_MS = 4000;

/** The usual live area; a multiline input box can make it taller. */
const LIVE_ROWS = 8;
/**
 * How many rows above the input box can still hold the spinner: the mode line, and whatever Droid
 * puts between them (queued messages, a todo list). A reply quoting the spinner this close to the
 * box reads as busy, which only keeps a status (see screenStatus) and never finishes a turn.
 */
const ABOVE_BOX_ROWS = 8;

/** A permission prompt ("Alt/Option+E to inspect approval details") or an AskUser dialog. */
const ASKING = /inspect approval details|ESC stop agent/i;
/** The spinner line of a turn: "Thinking...", "Streaming...", "Executing...". */
const BUSY = /Press ESC to stop/i;
/** The footer under the input box, shown only when no dialog covers it (a dialog's key hints are its last row instead). */
const AT_REST = /\? for help/;
const BOX_TOP = /^\s*╭─+╮\s*$/;
const BOX_BOTTOM = /^\s*╰─+╯\s*$/;
const BOX_ROW = /^\s*│.*│\s*$/;

/** What the bottom of the screen shows; undefined for anything else (a menu, a login, another program). */
export function readDroidScreen(rows: readonly string[]): DroidScreen | undefined {
  const nonempty = rows.filter((r) => r.trim());
  // Find the actual input box instead of counting its text as status rows. A queued multiline
  // prompt otherwise pushes the spinner above the eight-row window, leaving only the idle footer.
  let footerRow = nonempty.length - 1;
  while (footerRow >= 0 && !AT_REST.test(nonempty[footerRow])) footerRow--;
  let top = footerRow - 2;
  const hasBottom = BOX_BOTTOM.test(nonempty[footerRow - 1] ?? '');
  if (hasBottom) {
    while (top >= 0 && BOX_ROW.test(nonempty[top])) top--;
  }
  const hasBox = hasBottom && footerRow >= nonempty.length - LIVE_ROWS && BOX_TOP.test(nonempty[top] ?? '');
  const live = hasBox ? [...nonempty.slice(Math.max(0, top - ABOVE_BOX_ROWS), top), ...nonempty.slice(footerRow)] : nonempty.slice(-LIVE_ROWS);
  const last = (re: RegExp) => {
    for (let i = live.length - 1; i >= 0; i--) if (re.test(live[i])) return i;
    return -1;
  };
  const footer = last(AT_REST);
  // A dialog's key hints take the footer's place; above the footer they're a reply or the input box quoting them.
  if (last(ASKING) > footer) return 'asking';
  if (last(BUSY) >= 0) return 'busy';
  if (footer >= 0) return 'idle';
  return undefined;
}

/**
 * The status a worker should have, when its settled screen says its status is wrong. `quiet` is
 * whether its terminal has printed nothing for a while: a turn always prints (the spinner, the
 * elapsed time), so a busy screen has to be printing and an idle one has to be still.
 */
export function screenStatus(status: WorkerStatus, screen: DroidScreen, quiet: boolean): WorkerStatus | undefined {
  if (screen === 'asking') return status === 'working' || status === 'done' || status === 'idle' ? 'needs_input' : undefined;
  if (screen === 'busy') return !quiet && (status === 'needs_input' || status === 'done' || status === 'idle') ? 'working' : undefined;
  return quiet && (status === 'working' || status === 'needs_input') ? 'done' : undefined;
}
