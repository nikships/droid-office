/**
 * Modified Enter as native terminals send it: CSI u sequences. Droid binds Ctrl+Enter (queue a
 * message while it works) and Shift+Enter (newline) to exactly these, and parses them even when it
 * has not negotiated the kitty keyboard protocol. A plain shell that never asked for CSI u would
 * print them as garbage.
 */

import type { WorkerInfo } from './protocol.js';

export const CTRL_ENTER = '\x1b[13;5u';
export const SHIFT_ENTER = '\x1b[13;2u';

/** Whether a worker's program understands CSI u Enter: every agent runs Droid, which does; a shell doesn't. */
export function wantsCsiEnter(kind: WorkerInfo['kind'] | undefined): boolean {
  return kind === 'agent';
}
