import type { WTerm } from '@wterm/dom';

/** The core validates OSC 52 and delivers UTF-8 text (up to 64 KiB), never a
 * clipboard read. Android can supply its native writer. Denials are final. */
export function attachWtermClipboard(native: WTerm, signal: AbortSignal, writable: () => boolean, writeText: (text: string) => void | Promise<void> = (text) => navigator.clipboard.writeText(text)) {
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
      native.onClipboardWrite = null;
    },
    { once: true },
  );
}
