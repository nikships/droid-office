import { TERM_THEME } from '../term-theme';
import { WTermAdapter } from './wterm';
import './wterm.css';
import { attachWtermGraphics } from './wterm-graphics';
import { attachWtermClipboard } from './wterm-clipboard';
import { createWtermSearch, useNativeSearchControls } from './wterm-search-controls';
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
      scrollback: 5000,
      cursorBlink: false,
      disableStdin: true,
    },
    async () => [
      (adapter) => {
        graphics = attachWtermGraphics(adapter, images);
      },
    ],
    (native) => {
      // Phone/Desktop fitting tests successive font sizes in the same turn. Update
      // native hit-test and scroll metrics before restoring the reader, but never
      // fit a local grid in place of the authoritative PTY.
      const { style } = native.element;
      const width = style.width;
      style.width = '0px';
      try {
        native.fit();
      } finally {
        style.width = width;
      }
    },
  );
  return { term, expandAtClient: (x: number, y: number) => graphics?.expandAtClient(x, y) ?? false };
}

export { TERM_THEME };
export { attachWtermClipboard, createWtermSearch, useNativeSearchControls };
