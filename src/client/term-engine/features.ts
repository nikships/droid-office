import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { attachKittyTerminal, type KittyTerminalOptions } from '../term-kitty';
import { attachPixelScroll } from '../term-pixel-scroll';
import { attachTerminalScrollbar } from '../term-scrollbar';
import type { TerminalPathLinksAddon } from '../ui/terminal-path-links';
import { scrollAtOnce } from '../ui/terminal-prefs';
import { attachGhosttyKeys } from './ghostty-keys';
import { attachGhosttyScroll } from './ghostty-scroll';
import { attachGhosttyGraphics } from './ghostty-graphics';
import { attachGhosttyLinks } from './ghostty-links';
import { findInXterm } from './xterm-find';
import type { TerminalFind } from './types';
import type { TerminalEngine } from './index';

/** Installation point for engine-specific keyboard, graphics, scrolling and links. Changes
 * is read-only and deliberately has no path/web add-ons. */
export function attachEngineFeatures(engine: TerminalEngine, images?: KittyTerminalOptions, paths?: TerminalPathLinksAddon) {
  const term = engine.xterm;
  if (!term) {
    const adapter = engine.ghostty;
    const keys = attachGhosttyKeys(adapter);
    attachGhosttyGraphics(adapter, images);
    const scroll = attachGhosttyScroll(adapter);
    const links = attachGhosttyLinks(adapter, paths);
    return { keyAction: keys.keyAction, handleKey: scroll.handleKey, find: links.find, scrollAtOnce: (move: () => void) => scrollAtOnce(adapter, move, scroll.snap) };
  }
  if (paths) {
    term.loadAddon(paths);
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.metaKey || event.ctrlKey) window.open(uri, '_blank', 'noopener,noreferrer');
      }),
    );
  }
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  const kitty = attachKittyTerminal(term, images);
  const pixel = attachPixelScroll(term);
  attachTerminalScrollbar(term);
  return { keyAction: kitty.keyAction, handleKey: pixel.handleKey, find: (hit: TerminalFind) => findInXterm(term, hit), scrollAtOnce: (move: () => void) => scrollAtOnce(term, move, pixel.snap) };
}
