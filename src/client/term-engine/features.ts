import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { attachKittyTerminal, type KittyTerminalOptions } from '../term-kitty';
import { attachPixelScroll } from '../term-pixel-scroll';
import { attachTerminalScrollbar } from '../term-scrollbar';
import type { TerminalPathLinksAddon } from '../ui/terminal-path-links';
import type { KeyAction } from '../term-keys';
import type { TerminalEngine } from './index';

/** Installation point for engine-specific keyboard, graphics, scrolling and links. Changes
 * is read-only and deliberately has no path/web add-ons. */
export function attachEngineFeatures(engine: TerminalEngine, images?: KittyTerminalOptions, paths?: TerminalPathLinksAddon) {
  const term = engine.xterm;
  if (!term) return { keyAction: (): KeyAction => ({ do: 'default' }), handleKey: () => false };
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
  return { keyAction: kitty.keyAction, handleKey: pixel.handleKey };
}
