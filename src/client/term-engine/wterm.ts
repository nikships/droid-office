import type { WTerm } from '@wterm/dom';
import type { GhosttyCore } from '@wterm/ghostty';
import { VtScanner } from '../../shared/vt-scanner';
import { TERM_THEME } from '../term-theme';
import type { ClientTerminalOptions } from './types';

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

export type WTermFeature = (adapter: WTermAdapter) => void;

export class WTermAdapter {
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
  // History index including discarded rows, or undefined when following the tail.
  private readerRow?: number;
  private paintedDiscarded = 0;
  private restoreAfterPaint = false;
  private keyHandler?: (e: KeyboardEvent) => boolean;

  constructor(
    options: ClientTerminalOptions,
    private readonly loadFeatures?: () => Promise<readonly WTermFeature[]>,
  ) {
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
        const modes = params.filter((mode) => mode !== 2027).map((mode) => (Array.isArray(mode) ? mode.join(':') : mode));
        if (modes.length) this.writeNative(`\x1b[?${modes.join(';')}${final}`);
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
  get modes() {
    const c = this.core;
    return {
      sendFocusMode: !!c?.focusEvents(),
      applicationCursorKeysMode: !!c?.cursorKeysApp(),
      bracketedPasteMode: !!c?.bracketedPaste(),
      mouseTrackingMode: c?.mouseTracking() === 1003 ? 'any' : c?.mouseTracking() === 1002 ? 'drag' : c?.mouseTracking() === 1000 ? 'vt200' : 'none',
    } as const;
  }
  private sampleReader() {
    const el = this.root;
    // display:none collapses every DOM scroll metric to zero. Keep the last visible
    // position and subtract history evicted while painting was paused.
    if (el?.clientHeight && !this.restoreAfterPaint) this.readerRow = el.scrollHeight - el.clientHeight - el.scrollTop < 1 ? undefined : this.paintedDiscarded + el.scrollTop / this.rowHeight;
  }
  get buffer() {
    const baseY = this.core?.getScrollbackCount() ?? 0;
    const discarded = this.core?.getScrollbackDiscardedCount() ?? 0;
    this.sampleReader();
    const viewportY = this.readerRow === undefined ? baseY : Math.min(baseY, Math.max(0, Math.floor(this.readerRow - discarded)));
    return { active: { baseY, viewportY } };
  }
  /** A fresh attach resets core pins. Save a physical row plus its text and verify
   * the row after replay (find the nearest matching row if history was trimmed). */
  saveReader(): (() => void) | undefined {
    const { baseY, viewportY } = this.buffer.active;
    const c = this.core;
    if (!c || viewportY >= baseY) return;
    const fraction = (this.readerRow ?? 0) % 1;
    const rowText = (row: number, base: number, expected?: string) => {
      const offset = base - 1 - row;
      let text = '';
      for (let col = 0, len = c.getScrollbackLineLen(offset); col < len; col++) {
        const cell = c.getScrollbackCell(offset, col);
        if (cell.width === 0) continue;
        const chars = cell.chars ?? String.fromCodePoint(cell.char || 32);
        if (expected !== undefined && (text.length < expected.length ? !expected.startsWith(chars, text.length) : chars.trimEnd())) return;
        text += chars;
      }
      return text.trimEnd();
    };
    const label = rowText(viewportY, baseY);
    const next = viewportY + 1 < baseY ? rowText(viewportY + 1, baseY) : undefined;
    return () => {
      const el = this.root;
      if (!el || this.core !== c) return;
      const base = c.getScrollbackCount();
      const start = Math.min(viewportY, base - 1);
      let row: number | undefined;
      search: for (let d = 0; d < base; d++) {
        for (const candidate of d ? [start - d, start + d] : [start]) {
          if (candidate < 0 || candidate >= base || rowText(candidate, base, label) !== label) continue;
          row ??= candidate;
          if (next === undefined || (candidate + 1 < base && rowText(candidate + 1, base, next) === next)) {
            row = candidate;
            break search;
          }
        }
      }
      const target = row ?? start;
      // The DOM spacer and native pin-to-bottom policy update in wterm's render frame.
      requestAnimationFrame(() => {
        if (this.root === el && el.clientHeight && target >= 0) el.scrollTop = (target + fraction) * this.rowHeight;
      });
    };
  }
  private rowHeight = 1;
  private fontAdvance = 0;
  private metricsContext?: CanvasRenderingContext2D | null;
  refreshMetrics() {
    const el = this.root;
    if (!el) return;
    if (this.native && !el.clientWidth) {
      this.metricsPending = true;
      return;
    }
    this.sampleReader();
    const previousHeight = this.rowHeight;
    if (this.options.fontFamily) el.style.setProperty('--term-font-family', this.options.fontFamily);
    const size = this.options.fontSize ?? 14;
    el.style.setProperty('--term-font-size', `${size}px`);
    const font = `${size}px ${this.options.fontFamily ?? getComputedStyle(el).fontFamily}`;
    this.metricsContext ??= document.createElement('canvas').getContext('2d');
    let fontHeight = 0;
    if (this.metricsContext) {
      this.metricsContext.font = font;
      const metrics = this.metricsContext.measureText('W');
      this.fontAdvance = metrics.width;
      fontHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
    }
    if (!(fontHeight > 0)) {
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;line-height:normal';
      probe.style.font = font;
      probe.textContent = 'W';
      el.append(probe);
      fontHeight = probe.offsetHeight;
      probe.remove();
    }
    // Preserve the previous renderer's device-pixel rounding, including on Retina displays.
    const dpr = window.devicePixelRatio;
    if (fontHeight > 0) this.rowHeight = Math.floor(Math.ceil(fontHeight * dpr) * (this.options.lineHeight ?? 1.1)) / dpr;
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
      if (previousHeight !== this.rowHeight) {
        this.restoreAfterPaint = true;
        if (this.readerRow !== undefined) el.scrollTop = Math.max(0, this.readerRow - this.paintedDiscarded) * this.rowHeight;
      }
    }
  }
  private applyOption(key: keyof ClientTerminalOptions) {
    const t = this.native;
    if (!t || !this.root) return;
    if (key === 'fontSize' || key === 'fontFamily' || key === 'lineHeight') this.refreshMetrics();
    if (key === 'theme') {
      const colors = { ...TERM_THEME, ...this.options.theme };
      const rgb = (key: keyof typeof TERM_THEME) => Number.parseInt((/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(colors[key]) ? colors[key].slice(0, 7) : TERM_THEME[key]).slice(1), 16);
      t.setThemeColors({ foreground: rgb('foreground'), background: rgb('background'), cursor: rgb('cursor'), palette: palette.map(rgb) });
      this.root.style.setProperty('--term-bg', colors.background);
      this.root.style.setProperty('--term-selection-bg', colors.selectionBackground);
      this.root.classList.toggle('has-cursor-accent', !!colors.cursorAccent);
      this.root.style.setProperty('--office-cursor-accent', colors.cursorAccent ?? '');
    }
    if (key === 'cursorBlink') {
      this.root.classList.toggle('cursor-blink', this.options.cursorBlink === true);
      this.root.classList.toggle('cursor-steady', this.options.cursorBlink === false);
    }
    if (key === 'cursorStyle') t.write(`\x1b[${this.options.cursorStyle === 'bar' ? 6 : this.options.cursorStyle === 'underline' ? 4 : 2} q`);
  }

  async open(host: HTMLElement) {
    const { signal } = this.lifetime;
    const [{ loadWterm }, features] = await Promise.all([import('./wterm-core'), this.loadFeatures?.() ?? []]);
    if (signal.aborted) return;
    const root = document.createElement('div');
    root.className = 'office-wterm wterm';
    root.inert = true;
    this.root = root;
    host.append(root);
    this.refreshMetrics();
    try {
      const { native, core, attachFeatures } = await loadWterm(
        this,
        root,
        (d) => {
          // WTerm synthesizes pixel-size replies inside write(), outside core.getResponse().
          if (!this.displayWrite && !this.options.disableStdin && !signal.aborted) this.data.fire(d);
        },
        features,
        (discarded) => {
          this.paintedDiscarded = discarded;
          if (this.restoreAfterPaint)
            queueMicrotask(() => {
              // Native paint commits both the virtual spacer and its own scroll
              // adjustment. Only then is a logical row a usable pixel offset.
              if (!this.restoreAfterPaint || this.metricsPending || !root.clientHeight) return;
              root.scrollTop = this.readerRow === undefined ? root.scrollHeight : Math.max(0, this.readerRow - this.paintedDiscarded) * this.rowHeight;
              this.restoreAfterPaint = false;
            });
        },
      );
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
      this.refreshMetrics();
      this.applyOption('theme');
      this.applyOption('cursorBlink');
      this.applyOption('cursorStyle');
      native.write(widths);
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

      root.addEventListener('scroll', () => this.sampleReader(), { passive: true, signal });
      native.setRenderingPaused(this.paused);
      const observer = new ResizeObserver(() => {
        if (root.clientWidth > 0 && this.metricsPending) this.refreshMetrics();
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
      attachFeatures();
      root.inert = false;
      this.opened.fire(native);
    } catch (error) {
      this.native?.destroy();
      this.core?.dispose();
      root.remove();
      this.root = this.native = this.core = undefined;
      throw error;
    }
  }
  proposeDimensions() {
    const el = this.root;
    if (!el?.clientWidth || !el.clientHeight) return;
    const style = getComputedStyle(el);
    // The previous DOM renderer sized its screen to a whole CSS pixel, then
    // divided by the current column count. A rounded single span can lose a
    // column at the boundary, especially after changing the font or shared grid.
    const width = this.fontAdvance > 0 ? Math.round(this.fontAdvance * this.cols) / this.cols : parseFloat(style.getPropertyValue('--term-cell-width'));
    if (!(width > 0)) return;
    // The modal reserves space beside the grid, including any real scrollbar.
    // Keep that reserve out of CSS padding so it cannot clip the painted row.
    const inner = el.offsetWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
    const gutter = parseFloat(style.getPropertyValue('--office-fit-gutter')) || 0;
    const available = Math.min(el.clientWidth, inner - gutter) - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return {
      cols: Math.floor(available / width),
      rows: Math.floor((el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / this.rowHeight),
    };
  }
  attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) {
    this.keyHandler = fn;
  }
  /** A display-only log leaves the focused window and browser in charge of keys.
   * Unlike a handled terminal shortcut, these events keep their default action. */
  useWindowKeyboard() {
    this.onOpen(() => {
      if (this.textarea) this.textarea.disabled = true;
    });
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
    this.readerRow = undefined;
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
    this.readerRow = undefined;
    if (this.native && this.metricsPending) this.restoreAfterPaint = true;
    if (this.root) this.root.scrollTop = this.root.scrollHeight;
  }
  dispose() {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.restoreAfterPaint = false;
    this.native?.destroy();
    this.core?.dispose();
    this.root?.remove();
    this.root = this.native = this.core = undefined;
    this.parser.reset();
    this.keyHandler = undefined;
    for (const e of [this.before, this.changed, this.opened, this.parsed, this.nativeParsed, this.resetting, this.resized, this.data]) e.clear();
  }
}
