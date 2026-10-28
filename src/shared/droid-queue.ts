/**
 * Droid's own queue, read off its terminal. While a turn runs, Droid lists what was queued with
 * Ctrl+Enter just above its input box:
 *
 *    Queued messages:
 *    The first queued message, cut to the terminal's width…
 *    Line one of another (1 more line)
 *    Ctrl+R to modify queue   Ctrl+G to pull top   Ctrl+X to clear queue
 *
 * That block is the truth about what Droid will send next, whichever window queued it. Each row is
 * a preview: one line, maybe cut short. The Android app reads the same block (core/DroidQueue.kt),
 * checked against the same screens (android/app/src/test/resources/droid-queue-golden.json).
 */

export interface DroidQueued {
  /** The row as Droid shows it, without its "…" or "(N more lines)". */
  text: string;
  /** Droid cut the first line short. */
  cut: boolean;
  /** Lines after the first that Droid didn't show. */
  more: number;
}

/** The keys that clear Droid's queue while it shows one. */
export const CLEAR_DROID_QUEUE = '\x18';

const BOX_BOTTOM = /^\s*╰─+╯\s*$/;
const BOX_TOP = /^\s*╭─+╮\s*$/;
const INPUT_ROW = /^\s*│\s?[>!]/;
const HEADING = /^\s*Queued messages:\s*$/;
const HINT = /Ctrl\+X to clear queue/;
const MORE = /^(.*?)\s*\((\d+) more lines?\)$/;
/** How far above the input box the queue can start: the mode line, a spinner, and the queue itself. */
const REACH = 48;

/**
 * What Droid has queued, oldest first: an empty list when its input box shows and nothing is queued,
 * or undefined when the bottom of the screen isn't Droid at its input box (a dialog, another program,
 * no screen yet), so nothing can be said either way.
 */
export function readDroidQueue(rows: readonly string[]): DroidQueued[] | undefined {
  let bottom = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (BOX_BOTTOM.test(rows[i])) {
      bottom = i;
      break;
    }
  }
  if (bottom < 0) return undefined;
  let top = -1;
  for (let i = bottom - 1; i >= 0 && i >= bottom - 40; i--) {
    if (BOX_TOP.test(rows[i])) {
      top = i;
      break;
    }
  }
  // Droid's input row, not a dialog's box: "│ > …", or "│ ! …" in bash mode.
  if (top < 0 || !rows.slice(top + 1, bottom).some((row) => INPUT_ROW.test(row))) return undefined;
  let heading = -1;
  for (let i = top - 1; i >= 0 && i >= top - REACH; i--) {
    if (HEADING.test(rows[i])) {
      heading = i;
      break;
    }
  }
  if (heading < 0) return [];
  let hint = -1;
  for (let i = heading + 1; i < top; i++) {
    if (HINT.test(rows[i])) {
      hint = i;
      break;
    }
  }
  if (hint < 0) return [];
  const items: DroidQueued[] = [];
  for (let i = heading + 1; i < hint; i++) {
    let text = rows[i].trim();
    if (!text) continue;
    let more = 0;
    const m = MORE.exec(text);
    if (m) {
      text = m[1];
      more = Number(m[2]);
    }
    const cut = text.endsWith('…');
    if (cut) text = text.slice(0, -1).trimEnd();
    items.push({ text, cut, more });
  }
  return items;
}

const words = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Whether Droid's row [item] is how it shows [text]: its first line, whole or cut short. */
export function showsAs(item: DroidQueued, text: string): boolean {
  const first = words(text.split('\n').find((line) => line.trim()) ?? '');
  const shown = words(item.text);
  if (!shown) return !first;
  return item.cut ? first.startsWith(shown) : first === shown;
}
