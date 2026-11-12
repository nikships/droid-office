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

export interface KeyMods {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

/** The bytes Enter with these modifiers should send, or undefined for the terminal's default. */
export function modifiedEnter(csiEnter: boolean, mods: KeyMods): string | undefined {
  if (!csiEnter || mods.alt || mods.meta) return undefined;
  if (mods.ctrl && !mods.shift) return CTRL_ENTER;
  if (mods.shift && !mods.ctrl) return SHIFT_ENTER;
  return undefined;
}

/** The slice of a KeyboardEvent the terminal's key handler reads. */
export interface KeyEventLike {
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
}

export type KeyAction = { do: 'send'; data: string } | { do: 'swallow' } | { do: 'default' };

/**
 * What xterm.js's custom key handler should do with a key event: `send` the replacement bytes
 * (on keydown), `swallow` it (the keypress/keyup of a replaced Enter, so xterm doesn't add its
 * own CR), or `default` to let xterm handle it.
 */
export function enterKeyAction(csiEnter: boolean, e: KeyEventLike): KeyAction {
  // Enter while an IME is composing commits the composition; it isn't a keystroke for the PTY.
  if (e.key !== 'Enter' || e.isComposing) return { do: 'default' };
  const data = modifiedEnter(csiEnter, { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
  if (data === undefined) return { do: 'default' };
  return e.type === 'keydown' ? { do: 'send', data } : { do: 'swallow' };
}
