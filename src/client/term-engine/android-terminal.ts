import { TERM_THEME } from '../term-theme';
import { WTermAdapter } from './wterm';
import './wterm.css';
import { attachWtermGraphics } from './wterm-graphics';
import type { KittyTerminalOptions } from '../term-kitty-overlay';

/** Android owns IME and PTY transport; the WebView only consumes the stream. */
export function createAndroidTerminal(images: KittyTerminalOptions) {
  let graphics: ReturnType<typeof attachWtermGraphics> | undefined;
  const term = new WTermAdapter(
    {
      fontFamily: "'Geist Mono', 'Droid Office Terminal Symbols', monospace",
      fontSize: 12.5,
      lineHeight: 1.1,
      theme: TERM_THEME,
      minimumContrastRatio: 4.5,
      scrollback: 5000,
      cursorBlink: false,
      disableStdin: true,
    },
    async () => [
      (adapter) => {
        graphics = attachWtermGraphics(adapter, images);
      },
    ],
  );
  return { term, expandAtClient: (x: number, y: number) => graphics?.expandAtClient(x, y) ?? false };
}

export { TERM_THEME };
