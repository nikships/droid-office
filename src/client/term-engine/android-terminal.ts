import { TERM_THEME } from '../term-theme';
import { WTermAdapter } from './wterm';
import { attachWtermGraphics } from './wterm-graphics';
import type { KittyTerminalOptions } from '../term-kitty-overlay';

/** Android owns IME and PTY transport; the WebView only consumes the stream. */
export function createAndroidTerminal(images: KittyTerminalOptions) {
  const term = new WTermAdapter({
    fontFamily: "'Geist Mono', 'Droid Office Terminal Symbols', monospace",
    fontSize: 12.5,
    lineHeight: 1.1,
    theme: TERM_THEME,
    minimumContrastRatio: 4.5,
    scrollback: 5000,
    cursorBlink: false,
    disableStdin: true,
  });
  attachWtermGraphics(term, images);
  return term;
}

export { TERM_THEME };
