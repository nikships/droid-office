import type { KeyAction } from '../term-keys';
import type { KittyTerminalOptions } from '../term-kitty-overlay';
import type { TerminalPathLinksAddon } from '../ui/terminal-path-links';
import type { TerminalFind } from './types';
import type { WTermAdapter } from './wterm';

interface Hooks {
  keyAction(event: KeyboardEvent, csiEnter: boolean): KeyAction;
  handleKey(event: KeyboardEvent): boolean;
  find(hit: TerminalFind): string | undefined;
  scrollAtOnce(move: () => void): void;
}

/** Views bind their handlers before open; the opt-in runtime installs the real features
 * before init, so not even the feature code or its CSS is downloaded by an xterm user. */
export const wtermHooks = new WeakMap<WTermAdapter, { hooks: Hooks; images?: KittyTerminalOptions; paths?: TerminalPathLinksAddon }>();
export function bindWtermHooks(adapter: WTermAdapter, images?: KittyTerminalOptions, paths?: TerminalPathLinksAddon) {
  const hooks: Hooks = { keyAction: () => ({ do: 'default' }), handleKey: () => false, find: () => undefined, scrollAtOnce: (move) => move() };
  wtermHooks.set(adapter, { hooks, images, paths });
  return hooks;
}
