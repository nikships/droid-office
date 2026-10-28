/**
 * What a mounted terminal does with its size. `fit-send` fits to its box and asks the shared PTY for
 * that size; `follow` renders at the PTY's size; `fit-only` fits without a PTY (a guest's banner).
 * A hidden or zero-size box never sizes anything: fitting it would shrink the PTY under every other view.
 */
export type TerminalSizing = 'none' | 'fit-only' | 'follow' | 'fit-send';

export function terminalSizing(s: { guest: boolean; active: boolean; laidOut: boolean; typing: boolean; adoptShared: boolean }): TerminalSizing {
  if (!s.laidOut) return 'none';
  if (s.guest) return 'fit-only';
  // Only the pane the owner is in claims the PTY; the others mirror whatever size it has.
  if (!s.active) return 'follow';
  if (!s.typing && s.adoptShared) return 'follow';
  return 'fit-send';
}
