import type { KittyTerminalOptions } from '../term-kitty-overlay';
import type { TerminalPaths } from '../ui/terminal-path-links';
import type { ClientTerminalOptions, TerminalFind } from './types';
import { WTermAdapter } from './wterm';

export interface WebTerminalFeatures {
  keyException(event: KeyboardEvent, agent: boolean): boolean;
  handleKey(event: KeyboardEvent): boolean;
  find(hit: TerminalFind): string | undefined;
}

export function createWebTerminal(options: ClientTerminalOptions, images?: KittyTerminalOptions, paths?: TerminalPaths) {
  const features: WebTerminalFeatures = { keyException: () => false, handleKey: () => false, find: () => undefined };
  const term = new WTermAdapter(options, async () => (await import('./wterm-runtime')).webFeatures(features, images, paths));
  return { term, features };
}
