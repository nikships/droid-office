import type { ITheme } from '@xterm/xterm';
import type { TerminalPathLinksAddon } from '../ui/terminal-path-links';
import type { GhosttyAdapter } from './ghostty';
import type { TerminalFind } from './types';

/** Open-time and live theme mapping. Until the glass treatment is ported, use an opaque ground. */
export function ghosttyTheme(theme: ITheme | undefined): ITheme {
  return { ...theme, background: theme?.background?.startsWith('rgba(') ? '#000000' : theme?.background };
}

/** Owns link activation, search decorations and glass. Paths are absent on the watch-only log. */
export function attachGhosttyLinks(adapter: GhosttyAdapter, _paths?: TerminalPathLinksAddon) {
  adapter.onOpen((native, lifetime) => {
    // Native OSC 8 activation does not enforce the office's URI policy.
    native.element?.addEventListener('click', (event) => event.stopImmediatePropagation(), { capture: true, signal: lifetime });
  });
  return { find: (_hit: TerminalFind): string | undefined => 'Search highlights are available with the xterm engine.' };
}
