// A stand-in for the Whiteboard window (docs/whiteboard.md, "The window"), so the wall can open it.
// The window's own module replaces this file.

import type { Net } from '../net';

export function openWhiteboard(net: Net, opts?: { card?: string }): void {
  console.info('[whiteboard] the window is not built yet', { connected: !!net, card: opts?.card });
}
