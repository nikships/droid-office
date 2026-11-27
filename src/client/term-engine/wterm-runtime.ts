import { WTerm } from '@wterm/dom';
import './wterm.css';
import { GhosttyCore } from '@wterm/ghostty';
import wasmPath from '@wterm/ghostty/ghostty-vt.wasm?url';
import { wtermAppearance } from './wterm-appearance';
import { wtermHooks } from './wterm-hooks';
import { attachWtermKeys } from './wterm-keys';
import { attachWtermScroll } from './wterm-scroll';
import { attachWtermGraphics } from './wterm-graphics';
import { attachWtermLinks } from './wterm-links';
import { scrollAtOnce } from '../ui/terminal-prefs';
import type { WTermAdapter } from './wterm';

/** Only the opted-in path imports this module. Each core owns independent memory. */
export async function loadWterm(adapter: WTermAdapter, element: HTMLElement, onData: (data: string) => void) {
  const core = await GhosttyCore.load({ wasmPath, scrollbackLines: adapter.options.scrollback, imageStorageLimit: 0 });
  try {
    const binding = wtermHooks.get(adapter);
    if (binding) {
      const keys = attachWtermKeys(adapter);
      const scroll = attachWtermScroll(adapter);
      const links = attachWtermLinks(adapter, binding.paths);
      attachWtermGraphics(adapter, binding.images);
      Object.assign(binding.hooks, { keyAction: keys.keyAction, handleKey: scroll.handleKey, find: links.find, scrollAtOnce: (move: () => void) => scrollAtOnce(adapter, move, scroll.snap) });
      wtermHooks.delete(adapter);
    }
    const display = wtermAppearance(core, adapter);
    // Always drain (not just hide) pending replies, including asynchronous paint/theme drains.
    const bound = new Map<PropertyKey, unknown>();
    const mirror = new Proxy(display, {
      get(target, key) {
        if (key === 'getResponse')
          return () => {
            while (core.getResponse() !== null) {
              /* The PTY host already answered. */
            }
            return null;
          };
        if (bound.has(key)) return bound.get(key);
        const v = Reflect.get(target, key);
        if (typeof v !== 'function') return v;
        const method = v.bind(target);
        bound.set(key, method);
        return method;
      },
    });
    const native = new WTerm(element, { core: mirror, cols: 80, rows: 24, autoResize: false, cursorBlink: adapter.options.cursorBlink, onData, onBinary: (bytes) => onData(String.fromCharCode(...bytes)) });
    return { native, core };
  } catch (error) {
    core.dispose();
    throw error;
  }
}
