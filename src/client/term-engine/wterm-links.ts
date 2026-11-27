import type { TerminalPathLinksAddon } from '../ui/terminal-path-links';
import type { TerminalFind } from './types';
import type { WTermAdapter } from './wterm';

export function attachWtermLinks(_adapter: WTermAdapter, _paths?: TerminalPathLinksAddon) {
  return { find: (_hit: TerminalFind): string | undefined => 'This terminal cannot locate that line.' };
}
