import type { WTerm } from '@wterm/dom';

/** The core validates OSC 52 and delivers UTF-8 text (up to 64 KiB), never a
 * clipboard read. Android can supply its native writer. Denials are final. */
export function attachWtermClipboard(native: WTerm, signal: AbortSignal, writable: () => boolean, writeText?: (text: string) => void | Promise<void>) {
  const permitted = () => !signal.aborted && writable();
  let backgroundPermission: Promise<PermissionStatus> | undefined;
  native.onClipboardWrite = async (text) => {
    if (!permitted()) return;
    try {
      if (writeText) {
        await writeText(text);
      } else if (document.hasFocus() && navigator.clipboard) {
        if (!navigator.userActivation?.isActive) {
          // On Chromium the ordinary clipboard-write status is for writes WITH
          // a gesture. A gestureless write can open a browser-owned prompt.
          const descriptor = { name: 'clipboard-write' as PermissionName, allowWithoutGesture: true };
          backgroundPermission ??= navigator.permissions?.query(descriptor);
          if ((await backgroundPermission)?.state !== 'granted' || !permitted() || !document.hasFocus()) return;
        }
        await navigator.clipboard.writeText(text);
      }
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
