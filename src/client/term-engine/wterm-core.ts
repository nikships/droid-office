import { WTerm } from '@wterm/dom';
import { GhosttyCore } from '@wterm/ghostty';
import wasmPath from '@wterm/ghostty/ghostty-vt.wasm?url';
import { wtermAppearance } from './wterm-appearance';
import type { WTermAdapter, WTermFeature } from './wterm';

/** Prime the public loader's compiled module cache; do not retain an instance. */
export async function warmWterm() {
  const core = await GhosttyCore.load({ wasmPath });
  core.dispose();
}

export async function loadWterm(adapter: WTermAdapter, element: HTMLElement, onData: (data: string) => void, features: readonly WTermFeature[]) {
  const core = await GhosttyCore.load({ wasmPath, scrollbackLines: adapter.options.scrollback, imageStorageLimit: 0 });
  try {
    const mirror = wtermAppearance(core, adapter);
    // Always drain (not just hide) pending replies, including asynchronous paint/theme drains.
    mirror.getResponse = () => {
      while (core.getResponse() !== null) {
        /* The PTY host already answered. */
      }
      return null;
    };
    const native = new WTerm(element, {
      core: mirror,
      cols: 80,
      rows: 24,
      autoResize: false,
      cursorBlink: adapter.options.cursorBlink,
      onData,
      onBinary: (bytes) => {
        // Our PTY transport encodes strings as UTF-8. A high-bit byte would be
        // expanded to two bytes and the trailing byte interpreted as fresh input.
        if (bytes.every((byte) => byte < 0x80)) onData(String.fromCharCode(...bytes));
      },
    });
    return {
      native,
      core,
      attachFeatures: () => {
        for (const attach of features) attach(adapter);
      },
    };
  } catch (error) {
    core.dispose();
    throw error;
  }
}
