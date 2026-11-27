import type { KittyTerminalOptions } from '../term-kitty-overlay';
import type { TerminalPaths } from '../ui/terminal-path-links';
import type { ClientTerminalOptions, TerminalFind } from './types';
import { WTermAdapter } from './wterm';
import type { WtermSearchOptions } from './wterm-search';

export interface WebTerminalFeatures {
  keyException(event: KeyboardEvent, agent: boolean): boolean;
  handleKey(event: KeyboardEvent): boolean;
  find(hit: TerminalFind): string | undefined;
  toggleSearch(): void;
}

export function createWebTerminal(options: ClientTerminalOptions, images?: KittyTerminalOptions, paths?: TerminalPaths, search?: WtermSearchOptions) {
  let pendingSearch = false;
  const features: WebTerminalFeatures = {
    keyException: () => false,
    handleKey: () => false,
    find: () => undefined,
    toggleSearch: () => {
      pendingSearch = !pendingSearch;
    },
  };
  const term = new WTermAdapter(options, async () => {
    const runtime = (await import('./wterm-runtime')).webFeatures(features, images, paths, search);
    return [
      ...runtime,
      () => {
        if (pendingSearch) {
          pendingSearch = false;
          features.toggleSearch();
        }
      },
    ];
  });
  return { term, features };
}
