import type { KeyAction } from '../term-keys';
import type { GhosttyAdapter } from './ghostty';

/** The view has already handled host shortcuts. 'default' continues to native Ghostty input. */
export function attachGhosttyKeys(_adapter: GhosttyAdapter) {
  return { keyAction: (_event: KeyboardEvent, _csiEnter: boolean): KeyAction => ({ do: 'default' }) };
}
