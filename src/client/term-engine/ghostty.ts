import type { FitAddon, ITerminalOptions, Terminal } from 'ghostty-web';
import { VtScanner } from '../../shared/vt-scanner';
import { ghosttyTheme } from './ghostty-links';
import type { ClientTerminal, ClientTerminalOptions } from './types';

function event<T>() {
  const listeners = new Set<(data: T) => void>();
  return {
    on(fn: (data: T) => void) {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
    fire(data: T) {
      for (const fn of listeners) fn(data);
    },
    clear() {
      listeners.clear();
    },
  };
}

/** Only options supported by the public Ghostty constructor. Its palette requires an opaque background. */
export function ghosttyOptions(opts: ClientTerminalOptions): ITerminalOptions {
  const { cursorBlink, cursorStyle, disableStdin, fontSize, fontFamily, theme, scrollback, smoothScrollDuration } = opts;
  return { cursorBlink, cursorStyle, disableStdin, fontSize, fontFamily, scrollback, smoothScrollDuration, theme: ghosttyTheme(theme) };
}

export class GhosttyAdapter implements ClientTerminal {
  readonly parser = new VtScanner();
  readonly options: ClientTerminalOptions;
  private readonly parsed = event<void>();
  private readonly beforeWrite = event<string>();
  private readonly resetting = event<void>();
  private readonly changed = event<keyof ClientTerminalOptions>();
  private readonly data = event<string>();
  private readonly opened = event<Terminal>();
  private readonly lifetime = new AbortController();
  private closed = false;
  private fit?: FitAddon;
  private keyHandler?: (event: KeyboardEvent) => boolean;
  private root?: HTMLElement;
  native?: Terminal;
  /** Install DOM-based features after native.open, never on a half-loaded or closed pane.
   * Abort releases feature-owned listeners/observers before the native terminal is disposed. */
  onOpen(install: (native: Terminal, lifetime: AbortSignal) => void) {
    if (this.native?.element && !this.closed) {
      install(this.native, this.lifetime.signal);
      return { dispose() {} };
    }
    return this.opened.on((native) => install(native, this.lifetime.signal));
  }
  constructor(options: ClientTerminalOptions) {
    this.options = new Proxy(
      { ...options },
      {
        set: (target, key: keyof ClientTerminalOptions, value: unknown) => {
          if (Reflect.get(target, key) === value) return true;
          Reflect.set(target, key, value);
          if (this.native) {
            const mapped = ghosttyOptions(target);
            if (key === 'theme' && mapped.theme) {
              this.native.renderer?.setTheme(mapped.theme);
              this.redraw();
            } else if (Object.hasOwn(mapped, key)) Reflect.set(this.native.options, key, Reflect.get(mapped, key));
          }
          this.changed.fire(key);
          return true;
        },
      },
    );
  }
  redraw() {
    const t = this.native;
    if (t?.renderer && t.wasmTerm) t.renderer.render(t.wasmTerm, true, t.getViewportY(), t);
  }
  get cols() {
    return this.native?.cols ?? 80;
  }
  get rows() {
    return this.native?.rows ?? 24;
  }
  get textarea() {
    return this.native?.textarea;
  }
  get modes(): ClientTerminal['modes'] {
    const t = this.native;
    return {
      sendFocusMode: !!t?.hasFocusEvents(),
      applicationCursorKeysMode: !!t?.getMode(1),
      bracketedPasteMode: !!t?.hasBracketedPaste(),
      mouseTrackingMode: t?.getMode(1003) ? 'any' : t?.getMode(1002) ? 'drag' : t?.getMode(1000) ? 'vt200' : t?.getMode(9) ? 'x10' : 'none',
    };
  }
  get buffer() {
    const baseY = this.native?.getScrollbackLength() ?? 0;
    return { active: { baseY, viewportY: baseY - (this.native?.getViewportY() ?? 0) } };
  }
  async open(host: HTMLElement) {
    const { createGhostty } = await import('./ghostty-runtime');
    if (this.closed) return;
    const { term, fit } = await createGhostty(ghosttyOptions(this.options));
    if (this.closed) {
      term.dispose();
      return;
    }
    this.native = term;
    this.fit = fit;
    // Settings and connection state may have changed while WASM was loading.
    Object.assign(term.options, ghosttyOptions(this.options));
    const root = document.createElement('div');
    root.className = 'ghostty-terminal';
    this.root = root;
    host.append(root);
    // open() focuses both immediately and on its next timer. Neither may steal focus from a
    // sibling pane. The owning window explicitly focuses interactive terminals when ready.
    root.inert = true;
    // Ghostty calls its custom handler on keydown only. The view also needs releases
    // for Kitty and must be able to swallow a keypress after replacing its keydown.
    const forward = (event: KeyboardEvent) => {
      if (this.keyHandler?.(event) !== false) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    for (const phase of ['keypress', 'keyup'] as const) root.addEventListener(phase, forward, { capture: true, signal: this.lifetime.signal });
    term.open(root);
    root.tabIndex = -1;
    term.onData((d) => this.data.fire(d));
    term.attachCustomKeyEventHandler((e) => (this.keyHandler ? !this.keyHandler(e) : false));
    const report = (focused: boolean) => {
      if (!this.closed && !this.options.disableStdin && term.hasFocusEvents()) this.data.fire(focused ? '\x1b[I' : '\x1b[O');
    };
    root.addEventListener('focusin', (e) => {
      if (!root.contains(e.relatedTarget as Node | null)) report(true);
    });
    root.addEventListener('focusout', (e) => {
      if (!root.contains(e.relatedTarget as Node | null)) report(false);
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    root.inert = false;
    if (!this.closed) this.opened.fire(term);
  }
  proposeDimensions() {
    return this.fit?.proposeDimensions();
  }
  attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) {
    this.keyHandler = fn;
  }
  onData(fn: (data: string) => void) {
    return this.data.on(fn);
  }
  onWriteParsed(fn: () => void) {
    return this.parsed.on(fn);
  }
  onBeforeWrite(fn: (data: string) => void) {
    return this.beforeWrite.on(fn);
  }
  onReset(fn: () => void) {
    return this.resetting.on(fn);
  }
  onOptionChange(fn: (key: keyof ClientTerminalOptions) => void) {
    return this.changed.on(fn);
  }
  write(data: string, done?: () => void) {
    if (!this.closed) {
      const reporting = this.native?.hasFocusEvents();
      this.beforeWrite.fire(data);
      this.parser.write(data, (chunk) => this.native?.write(chunk));
      if (!reporting && this.native?.hasFocusEvents() && !this.options.disableStdin && this.textarea === document.activeElement) this.data.fire('\x1b[I');
      this.parsed.fire();
      // Ghostty parses synchronously. Never pass write('') to its WASM allocator.
      if (done)
        queueMicrotask(() => {
          if (!this.closed) done();
        });
    }
  }
  reset() {
    this.resetting.fire();
    this.parser.reset();
    // RIS resets in place: native.reset() frees the core retained by the selection manager.
    this.native?.write('\x1bc\x1b[3J');
    this.native?.scrollToBottom();
  }
  resize(cols: number, rows: number) {
    this.native?.resize(cols, rows);
  }
  focus() {
    this.textarea?.focus({ preventScroll: true });
  }
  paste(data: string) {
    this.native?.paste(data);
  }
  input(data: string) {
    this.native?.input(data, true);
  }
  scrollToBottom() {
    this.native?.scrollToBottom();
  }
  dispose() {
    this.closed = true;
    this.lifetime.abort();
    this.opened.clear();
    this.native?.dispose();
    this.native = undefined;
    this.root?.remove();
    this.fit = undefined;
    this.parser.reset();
    this.data.clear();
    this.parsed.clear();
    this.beforeWrite.clear();
    this.resetting.clear();
    this.changed.clear();
  }
}
