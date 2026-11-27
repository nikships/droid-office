import type { WTerm } from '@wterm/dom';
import type { GhosttyCore } from '@wterm/ghostty';
import { VtScanner } from '../../shared/vt-scanner';
import { TERM_THEME } from '../term-theme';
import type { ClientTerminal, ClientTerminalOptions } from './types';

const widths = '\x1b[?2027l';
const palette = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;

function event<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    on(fn: (value: T) => void) {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
    fire(value: T) {
      for (const fn of listeners) fn(value);
    },
    clear() {
      listeners.clear();
    },
  };
}

export class WTermAdapter implements ClientTerminal {
  readonly supportsLineHeight = true;
  readonly options: ClientTerminalOptions;
  readonly parser = new VtScanner();
  native?: WTerm;
  core?: GhosttyCore;
  private readonly opened = event<WTerm>();
  private readonly before = event<string>();
  private readonly parsed = event<void>();
  private readonly nativeParsed = event<string>();
  private readonly resetting = event<void>();
  private readonly resized = event<{ cols: number; rows: number }>();
  private readonly changed = event<keyof ClientTerminalOptions>();
  private readonly data = event<string>();
  private readonly lifetime = new AbortController();
  private root?: HTMLDivElement;
  private displayWrite = false;
  private paused = false;
  private inViewport = true;
  private metricsPending = true;
  private keyHandler?: (e: KeyboardEvent) => boolean;

  constructor(options: ClientTerminalOptions) {
    this.options = new Proxy(
      { ...options },
      {
        set: (target, key: keyof ClientTerminalOptions, value: unknown) => {
          if (Reflect.get(target, key) === value) return true;
          Reflect.set(target, key, value);
          this.applyOption(key);
          this.changed.fire(key);
          return true;
        },
      },
    );
    for (const final of ['h', 'l'])
      this.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        if (!params.includes(2027)) return false;
        for (const mode of params) if (typeof mode === 'number' && mode !== 2027) this.writeNative(`\x1b[?${mode}${final}`);
        return true;
      });
    this.parser.registerEscHandler({ final: 'c' }, () => {
      this.native?.clearSelection();
      this.writeNative(`\x1bc${widths}`);
      return true;
    });
  }
  get cols() {
    return this.native?.cols ?? 80;
  }
  get rows() {
    return this.native?.rows ?? 24;
  }
  get textarea() {
    return this.root?.querySelector('textarea') ?? undefined;
  }
  get modes(): ClientTerminal['modes'] {
    const c = this.core;
    return {
      sendFocusMode: !!c?.focusEvents(),
      applicationCursorKeysMode: !!c?.cursorKeysApp(),
      bracketedPasteMode: !!c?.bracketedPaste(),
      mouseTrackingMode: c?.mouseTracking() === 1003 ? 'any' : c?.mouseTracking() === 1002 ? 'drag' : c?.mouseTracking() === 1000 ? 'vt200' : 'none',
    };
  }
  get buffer() {
    const baseY = this.core?.getScrollbackCount() ?? 0;
    const el = this.root;
    const viewportY = !el || el.scrollHeight - el.clientHeight - el.scrollTop < 1 ? baseY : Math.min(baseY, Math.max(0, Math.floor(el.scrollTop / this.rowHeight)));
    return { active: { baseY, viewportY } };
  }
  private get rowHeight() {
    return Math.ceil((this.options.fontSize ?? 14) * (this.options.lineHeight ?? 1.1));
  }
  private typography() {
    const el = this.root;
    if (!el) return;
    if (this.options.fontFamily) el.style.setProperty('--term-font-family', this.options.fontFamily);
    el.style.setProperty('--term-font-size', `${this.options.fontSize ?? 14}px`);
    el.style.setProperty('--term-row-height', `${this.rowHeight}px`);
    this.metricsPending = true;
    if (this.native && el.clientWidth) {
      // fit() remeasures the font before considering a resize. An empty content width
      // lets it refresh mouse/cell metrics without reflowing the authoritative PTY grid.
      const width = el.style.width;
      el.style.width = '0px';
      try {
        this.native.fit();
        this.metricsPending = false;
      } finally {
        el.style.width = width;
      }
    }
  }
  private applyOption(key: keyof ClientTerminalOptions) {
    const t = this.native;
    if (!t || !this.root) return;
    if (key === 'fontSize' || key === 'fontFamily' || key === 'lineHeight') this.typography();
    if (key === 'theme') {
      const colors = { ...TERM_THEME, ...this.options.theme };
      const rgb = (key: keyof typeof TERM_THEME) => Number.parseInt((/^#[0-9a-f]{6}$/i.test(colors[key]) ? colors[key] : TERM_THEME[key]).slice(1), 16);
      t.setThemeColors({ foreground: rgb('foreground'), background: rgb('background'), cursor: rgb('cursor'), palette: palette.map(rgb) });
      this.root.style.setProperty('--term-bg', colors.background);
      this.root.style.setProperty('--term-selection-bg', colors.selectionBackground);
    }
    if (key === 'cursorBlink') {
      this.root.classList.toggle('cursor-blink', this.options.cursorBlink === true);
      this.root.classList.toggle('cursor-steady', this.options.cursorBlink === false);
    }
    if (key === 'cursorStyle') t.write(`\x1b[${this.options.cursorStyle === 'bar' ? 6 : this.options.cursorStyle === 'underline' ? 4 : 2} q`);
  }

  async open(host: HTMLElement) {
    const { signal } = this.lifetime;
    const modal = host.closest('.modal');
    const animations = modal?.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity) ?? [];
    const [{ loadWterm }] = await Promise.all([import('./wterm-runtime'), Promise.allSettled(animations.map((a) => a.finished))]);
    if (signal.aborted) return;
    const root = document.createElement('div');
    root.className = 'office-wterm wterm';
    root.inert = true;
    this.root = root;
    host.append(root);
    this.typography();
    for (const phase of ['keydown', 'keyup', 'keypress'] as const)
      root.addEventListener(
        phase,
        (e) => {
          if (this.keyHandler?.(e) !== false) return;
          e.preventDefault();
          e.stopImmediatePropagation();
        },
        { capture: true, signal },
      );
    const { native, core } = await loadWterm(this, root, (d) => {
      // WTerm synthesizes pixel-size replies inside write(), outside core.getResponse().
      if (!this.displayWrite && !this.options.disableStdin && !signal.aborted) this.data.fire(d);
    });
    if (signal.aborted) {
      native.destroy();
      core.dispose();
      return;
    }
    this.native = native;
    this.core = core;
    await native.init();
    if (signal.aborted) return;
    // Preferences can change while the core download is outstanding.
    this.typography();
    this.applyOption('theme');
    this.applyOption('cursorBlink');
    this.applyOption('cursorStyle');
    native.write(widths);
    root.inert = false;
    native.setRenderingPaused(this.paused);
    const observer = new ResizeObserver(() => {
      if (root.clientWidth > 0 && this.metricsPending) this.typography();
    });
    observer.observe(root);
    const visibility = new IntersectionObserver(([entry]) => {
      this.inViewport = entry.isIntersecting;
      native.setRenderingPaused(this.paused || !this.inViewport);
    });
    visibility.observe(root);
    signal.addEventListener(
      'abort',
      () => {
        observer.disconnect();
        visibility.disconnect();
      },
      { once: true },
    );
    this.opened.fire(native);
  }
  proposeDimensions() {
    const el = this.root;
    if (!el?.clientWidth || !el.clientHeight) return;
    const style = getComputedStyle(el);
    const width = parseFloat(style.getPropertyValue('--term-cell-width'));
    if (!(width > 0)) return;
    return {
      cols: Math.floor((el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / width),
      rows: Math.floor((el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / this.rowHeight),
    };
  }
  attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) {
    this.keyHandler = fn;
  }
  onOpen(fn: (native: WTerm, signal: AbortSignal) => void) {
    if (this.native && !this.root?.inert) fn(this.native, this.lifetime.signal);
    return this.opened.on((t) => fn(t, this.lifetime.signal));
  }
  onData(fn: (data: string) => void) {
    return this.data.on(fn);
  }
  onBeforeWrite(fn: (data: string) => void) {
    return this.before.on(fn);
  }
  onNativeParsed(fn: (data: string) => void) {
    return this.nativeParsed.on(fn);
  }
  onWriteParsed(fn: () => void) {
    return this.parsed.on(fn);
  }
  onReset(fn: () => void) {
    return this.resetting.on(fn);
  }
  onResize(fn: (size: { cols: number; rows: number }) => void) {
    return this.resized.on(fn);
  }
  onOptionChange(fn: (key: keyof ClientTerminalOptions) => void) {
    return this.changed.on(fn);
  }
  private writeNative(chunk: string) {
    this.native?.write(chunk);
    this.nativeParsed.fire(chunk);
  }
  write(data: string, done?: () => void) {
    if (this.lifetime.signal.aborted) return;
    const focused = this.core?.focusEvents();
    this.before.fire(data);
    this.displayWrite = true;
    try {
      this.parser.write(data, (chunk) => this.writeNative(chunk));
    } finally {
      this.displayWrite = false;
    }
    if (!focused && this.core?.focusEvents() && this.textarea === document.activeElement && !this.options.disableStdin) this.data.fire('\x1b[I');
    this.parsed.fire();
    if (done)
      queueMicrotask(() => {
        if (!this.lifetime.signal.aborted) done();
      });
  }
  reset() {
    this.resetting.fire();
    this.parser.reset();
    this.native?.clearSelection();
    this.native?.clearSearch();
    this.native?.write(`\x1bc\x1b[3J${widths}`);
    this.applyOption('cursorStyle');
    this.scrollToBottom();
  }
  resize(cols: number, rows: number) {
    const t = this.native;
    if (!t || (cols === t.cols && rows === t.rows)) return;
    const oldCols = t.cols,
      oldRows = t.rows;
    t.resize(cols, rows);
    if (oldCols !== t.cols || oldRows !== t.rows) this.resized.fire({ cols: t.cols, rows: t.rows });
  }
  focus() {
    this.native?.focus();
  }
  paste(text: string) {
    if (this.options.disableStdin) return;
    const data = text.replace(/\r?\n/g, '\r');
    this.input(this.modes.bracketedPasteMode ? `\x1b[200~${data.replaceAll('\x1b', '')}\x1b[201~` : data);
  }
  input(data: string) {
    if (!this.options.disableStdin && !this.lifetime.signal.aborted) {
      this.scrollToBottom();
      this.data.fire(data);
    }
  }
  setRenderingPaused(paused: boolean) {
    this.paused = paused;
    this.native?.setRenderingPaused(paused || !this.inViewport);
  }
  scrollToBottom() {
    if (this.root) this.root.scrollTop = this.root.scrollHeight;
  }
  dispose() {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.native?.destroy();
    this.core?.dispose();
    this.root?.remove();
    this.root = this.native = this.core = undefined;
    this.parser.reset();
    this.keyHandler = undefined;
    for (const e of [this.before, this.changed, this.opened, this.parsed, this.nativeParsed, this.resetting, this.resized, this.data]) e.clear();
  }
}
