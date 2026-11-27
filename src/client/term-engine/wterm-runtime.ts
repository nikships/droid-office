import { attachWtermPrompts } from './wterm-prompts';
import { attachWtermSearch, type WtermSearchOptions } from './wterm-search';
import type { KittyTerminalOptions } from '../term-kitty-overlay';
import type { TerminalPaths } from '../ui/terminal-path-links';
import type { WebTerminalFeatures } from './web-terminal';
import type { WTermFeature } from './wterm';
import { attachWtermGraphics } from './wterm-graphics';
import { deskKeyExceptions } from './wterm-keys';
import { attachWtermLinks } from './wterm-links';
import { attachWtermScroll } from './wterm-scroll';

/** The web/Mac feature list. Other surfaces supply their own list to the same core. */
export function webFeatures(hooks: WebTerminalFeatures, images?: KittyTerminalOptions, paths?: TerminalPaths, search?: WtermSearchOptions): WTermFeature[] {
  return [
    attachWtermPrompts,
    (adapter) => {
      hooks.toggleSearch = attachWtermSearch(adapter, paths, search).toggle;
    },
    (adapter) => {
      hooks.keyException = deskKeyExceptions(adapter);
    },
    (adapter) => {
      hooks.handleKey = attachWtermScroll(adapter).handleKey;
    },
    (adapter) => {
      hooks.find = attachWtermLinks(adapter, paths).find;
    },
    (adapter) => attachWtermGraphics(adapter, images),
  ];
}
