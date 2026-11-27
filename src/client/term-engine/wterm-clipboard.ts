import type { WTerm } from '@wterm/dom';
import type { WTermAdapter } from './wterm';

/** The core validates OSC 52 and delivers UTF-8 text (up to 64 KiB), never a
 * clipboard read. Android can supply its native writer. Denials are final. */
export function attachWtermClipboard(adapter: WTermAdapter, native: WTerm, signal: AbortSignal, writable: () => boolean, writeText: (text: string) => void | Promise<void> = (text) => navigator.clipboard.writeText(text)) {
  const before = adapter.onBeforeWrite((chunk) => {
    if (!writable()) adapter.parser.suppressOscInWrite(52, chunk.length);
  });
  native.onClipboardWrite = async (text) => {
    if (signal.aborted || !writable()) return;
    try {
      await writeText(text);
    } catch {
      // Clipboard unavailable, unfocused, or denied. Don't queue or retry it.
    }
  };
  signal.addEventListener(
    'abort',
    () => {
      before.dispose();
      native.onClipboardWrite = null;
    },
    { once: true },
  );
}
