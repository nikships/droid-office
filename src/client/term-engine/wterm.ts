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
  private readonly fit = event<boolean>();
  private proposal?: { cols: number; rows: number };
  private replay?: 'waiting' | 'parsed' | 'painted';
  private revealFrame = 0;
  private readonly changed = event<keyof ClientTerminalOptions>();
  private readonly data = event<string>();
  private readonly lifetime = new AbortController();
  private root?: HTMLDivElement;
  private displayWrite = false;
  private paused = false;
  private inViewport = true;
  private paintLifetime?: AbortController;
  private metricsPending = true;
  // History index including discarded rows, or undefined when following the tail.
  private readerRow?: number;
  private holdReaderAfterPaint = false;
  private heldAlternate = false;
  private paintedDiscarded = 0;
  private paintPending = false;
  private pendingRestore?: { appliedTop?: number };
  private readerRevision = 0;
  private keyHandler?: (e: KeyboardEvent) => boolean;

  constructor(
    options: ClientTerminalOptions,
    private readonly loadFeatures?: () => Promise<readonly WTermFeature[]>,
    private readonly syncFontMetrics?: (term: WTerm) => void,
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
  /** Integer CSS extents and device-pixel scroll offsets can disagree at the end. */
  isAtTail(range?: number) {
    const el = this.root;
    return !el || (range ?? el.scrollHeight - el.clientHeight) - el.scrollTop < Math.max(1, 1 / window.devicePixelRatio);
  }
  private sampleReader(scrolled = false) {
    const el = this.root;
    // display:none collapses every DOM scroll metric to zero. Keep the last visible
    // position and subtract history evicted while painting was paused.
    if (!el?.clientHeight) return;
    if (this.pendingRestore) {
      // Do not sample our own (possibly clamped) metric compensation as a new
      // reader. A later wheel, thumb drag or reveal is a new scroll position.
      const applied = this.pendingRestore.appliedTop;
      if (el.scrollTop === applied || (applied === undefined && !scrolled)) return;
      this.pendingRestore.appliedTop = el.scrollTop;
      // Shrinking the scroll range can force a formerly valid offset down to
      // its new maximum. Ordinary navigation to the bottom approaches from below.
      const max = el.scrollHeight - el.clientHeight;
      if (applied !== undefined && applied > max && el.scrollTop < applied && this.isAtTail(max)) return;
      this.readerRevision++;
    }
    const range = el.scrollHeight - el.clientHeight;
    const remaining = range - el.scrollTop;
    this.readerRow = this.isAtTail(range) ? undefined : this.paintedDiscarded + el.scrollTop / this.rowHeight;
    // wterm 0.6 follows within 5px of the end, and resets to zero when a
    // clipped shared grid has no history. Don't let either paint move a reader.
    if (scrolled) {
      this.heldAlternate = !!this.core?.usingAltScreen();
      this.holdReaderAfterPaint = this.readerRow !== undefined && ((!this.heldAlternate && remaining < 5) || (el.scrollTop > 0 && this.core?.getScrollbackCount() === 0));
    }
  }
  /** An explicit navigation supersedes both a metric restore and an older saved reader. */
  cancelReaderRestore(revealed = true) {
    if (revealed) this.holdReaderAfterPaint = false;
    this.readerRevision++;
    this.pendingRestore = undefined;
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
  saveReader({ explicit = false } = {}): (() => void) | undefined {
    const { baseY, viewportY } = this.buffer.active;
    const c = this.core;
    if (!c || viewportY >= baseY) return;
    const savedRevision = this.readerRevision;
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
      // Closing Find explicitly requests the pre-search position, even after stepping through matches.
      const revision = explicit ? this.readerRevision : savedRevision;
      const el = this.root;
      if (!el || this.core !== c || revision !== this.readerRevision) return;
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
        if (this.root === el && revision === this.readerRevision && el.clientHeight && target >= 0) el.scrollTop = (target + fraction) * this.rowHeight;
      });
    };
  }
  private rowHeight = 1;
  private lastClientHeight = 0;
  private metricsContext?: CanvasRenderingContext2D | null;
  private keepTailOnShrink() {
    const el = this.root;
    if (!el) return;
    const clientHeight = el.clientHeight;
    if (clientHeight <= 0) return;
    const shrank = this.lastClientHeight > 0 && clientHeight < this.lastClientHeight;
    if (shrank && this.readerRow === undefined && this.isAtTail(el.scrollHeight - this.lastClientHeight) && !this.isAtTail()) this.followTail();
    this.lastClientHeight = clientHeight;
  }
  private refreshMetrics() {
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
    // Compact, Default and Relaxed scale the font's natural line box in device pixels.
    const dpr = window.devicePixelRatio;
    if (fontHeight > 0) this.rowHeight = Math.floor(Math.ceil(fontHeight * dpr) * (this.options.lineHeight ?? 1.1)) / dpr;
    el.style.setProperty('--term-row-height', `${this.rowHeight}px`);
    this.metricsPending = false;
    if (this.native) {
      this.syncFontMetrics?.(this.native);
      if (previousHeight !== this.rowHeight) {
        if (this.readerRow !== undefined) el.scrollTop = Math.max(0, this.readerRow - this.paintedDiscarded) * this.rowHeight;
        this.pendingRestore = { appliedTop: el.scrollTop };
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
      this.root.style.setProperty('--office-pane-bg', colors.background);
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
    const [{ loadWterm }, features] = await Promise.all([import('./wterm-core'), this.loadFeatures?.() ?? []]);
    if (signal.aborted) return;
    const root = document.createElement('div');
    root.className = 'office-wterm wterm';
    root.classList.toggle('replaying', !!this.replay);
    root.inert = true;
    this.root = root;
    host.append(root);
    let lastScrollTop: number | undefined;
    let restoredSameTop = false;
    try {
      const { native, core, attachFeatures } = await loadWterm(
        this,
        root,
        (d) => {
          // WTerm synthesizes pixel-size replies inside write(), outside core.getResponse().
          if (!this.displayWrite && !this.options.disableStdin && !signal.aborted) {
            // Native input already scrolled to the tail; its scroll event may
            // arrive after the PTY echo. Mouse reports leave the reader alone.
            if (this.holdReaderAfterPaint) this.sampleReader(true);
            this.data.fire(d);
          }
        },
        features,
        (discarded) => {
          this.paintPending = false;
          this.paintedDiscarded = discarded;
          if (!this.pendingRestore && this.holdReaderAfterPaint && this.heldAlternate === this.core?.usingAltScreen()) this.pendingRestore = { appliedTop: root.scrollTop };
          const restore = this.pendingRestore;
          if (restore || this.replay === 'parsed')
            queueMicrotask(() => {
              if (this.metricsPending || !root.clientHeight) return;
              if (restore && restore === this.pendingRestore) {
                // Native paint follows output. Only navigate again if the last
                // painted row is still below the viewport (e.g. a paused write).
                if (this.readerRow !== undefined) root.scrollTop = Math.max(0, this.readerRow - this.paintedDiscarded) * this.rowHeight;
                else if (!this.replay || (root.querySelector('.term-grid')?.getBoundingClientRect().bottom ?? 0) > root.getBoundingClientRect().bottom) root.scrollTop = root.scrollHeight;
                // Chromium queues scroll even when two writes in one paint cancel
                // out. Feeding that duplicate back to wterm would repaint forever
                // on a clipped grid without history. Never hide a new coordinate.
                restoredSameTop = this.holdReaderAfterPaint && this.core?.getScrollbackCount() === 0 && root.scrollTop === lastScrollTop;
                this.pendingRestore = undefined;
              }
              if (this.replay === 'parsed') {
                this.replay = 'painted';
                this.revealPaintedGrid();
              }
            });
        },
      );
      if (signal.aborted) {
        native.destroy();
        core.dispose();
        return;
      }
      this.refreshMetrics();
      this.native = native;
      this.core = core;
      await native.init();
      if (signal.aborted) return;
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

      // A focus report is not typing: wterm 0.6.0's normal input callback also scrolls to the tail.
      const reportFocus = (event: FocusEvent) => {
        if (core.focusEvents() && !this.options.disableStdin) this.data.fire(event.type === 'focus' ? '\x1b[I' : '\x1b[O');
      };
      this.textarea?.addEventListener('focus', reportFocus, { signal });
      this.textarea?.addEventListener('blur', reportFocus, { signal });
      root.addEventListener(
        'scroll',
        (e) => {
          if (e.target !== root) return;
          if (restoredSameTop && lastScrollTop === root.scrollTop) e.stopImmediatePropagation();
          restoredSameTop = false;
          this.keepTailOnShrink();
          lastScrollTop = root.scrollTop;
          this.sampleReader(true);
        },
        { capture: true, passive: true, signal },
      );
      this.syncRendering();
      // The content box excludes padding, borders and the actual scrollbar. The
      // native font probe survives grid rebuilds and also observes web-font loads.
      const probe = root.querySelector('.term-size-probe')!;
      let box: DOMRectReadOnly | undefined;
      let cell: DOMRectReadOnly | undefined;
      let lastGeometry: string | undefined;
      this.lastClientHeight = root.clientHeight;
      const observer = new ResizeObserver((entries) => {
        this.keepTailOnShrink();
        for (const entry of entries) {
          if (entry.target === root) box = entry.contentRect;
          else cell = entry.contentRect;
        }
        if (!box?.width || !box.height || !cell?.width || !cell.height) {
          this.proposal = undefined;
          return;
        }
        if (this.metricsPending) {
          this.refreshMetrics();
          cell = probe.getBoundingClientRect();
        }
        const geometry = `${box.width},${box.height},${cell.width},${cell.height}`;
        if (this.proposal && geometry === lastGeometry) return;
        this.proposal = { cols: Math.floor(box.width / cell.width), rows: Math.floor(box.height / cell.height) };
        const changed = lastGeometry !== undefined && lastGeometry !== geometry;
        lastGeometry = geometry;
        this.fit.fire(changed);
        this.revealPaintedGrid();
      });
      observer.observe(root);
      observer.observe(probe);
      const visibility = new IntersectionObserver(([entry]) => {
        this.inViewport = entry.isIntersecting;
        this.syncRendering();
      });
      visibility.observe(root);
      root.ownerDocument.addEventListener('visibilitychange', () => this.syncRendering(), { signal });
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
    return this.proposal;
  }
  onFit(fn: (geometryChanged: boolean) => void) {
    return this.fit.on(fn);
  }
  beginSnapshot() {
    this.replay = 'waiting';
    this.root?.classList.add('replaying');
  }
  endSnapshot() {
    this.replay = 'parsed';
  }
  private revealPaintedGrid() {
    if (!this.proposal || this.replay !== 'painted' || this.revealFrame) return;
    // The first content-box observation can negotiate a different grid after
    // native paint. A resize invalidates that paint before it can be revealed.
    this.revealFrame = requestAnimationFrame(() => {
      this.revealFrame = 0;
      if (this.replay !== 'painted' || !this.proposal) return;
      this.replay = undefined;
      this.root?.classList.remove('replaying');
    });
  }
  attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) {
    this.keyHandler = fn;
  }
  /** A display-only log leaves the focused window and browser in charge of keys.
   * Unlike a handled terminal shortcut, these events keep their default action. */
  useWindowKeyboard() {
    this.onOpen((native) => {
      if (this.textarea) this.textarea.disabled = true;
      // A scrollable div is otherwise an implicit tab stop in Chromium.
      native.element.tabIndex = -1;
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
    this.paintPending = true;
    this.native?.write(chunk);
    this.nativeParsed.fire(chunk);
  }
  write(data: string, done?: () => void) {
    if (this.lifetime.signal.aborted) return;
    this.before.fire(data);
    this.displayWrite = true;
    try {
      this.parser.write(data, (chunk) => this.writeNative(chunk));
    } finally {
      this.displayWrite = false;
    }
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
    this.followTail();
  }
  resize(cols: number, rows: number) {
    const t = this.native;
    if (!t || (cols === t.cols && rows === t.rows)) return;
    this.keepTailOnShrink();
    if (this.replay === 'painted') this.replay = 'parsed';
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
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    this.textarea?.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }
  input(data: string) {
    if (!this.options.disableStdin && !this.lifetime.signal.aborted) {
      this.scrollToBottom();
      this.data.fire(data);
    }
  }
  setRenderingPaused(paused: boolean) {
    this.paused = paused;
    this.syncRendering();
  }
  private get renderingPaused() {
    return this.paused || !this.inViewport || !!this.root?.ownerDocument.hidden;
  }
  /** Read operations waiting for a paint must stop if this pane can no longer paint. */
  get paintSignal() {
    if (this.renderingPaused || this.lifetime.signal.aborted) return undefined;
    return (this.paintLifetime ??= new AbortController()).signal;
  }
  private syncRendering() {
    const paused = this.renderingPaused;
    this.native?.setRenderingPaused(paused);
    if (paused) {
      this.paintLifetime?.abort();
      this.paintLifetime = undefined;
    }
  }
  scrollToBottom() {
    this.readerRevision++;
    this.followTail();
  }
  private followTail() {
    this.holdReaderAfterPaint = false;
    this.readerRow = undefined;
    const el = this.root;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    // Buffered output can lengthen the spacer after this immediate scroll.
    if (this.pendingRestore || this.paintPending || (this.native && this.metricsPending)) this.pendingRestore = { appliedTop: el.clientHeight ? el.scrollTop : undefined };
  }
  dispose() {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    if (this.revealFrame) cancelAnimationFrame(this.revealFrame);
    this.paintLifetime?.abort();
    this.pendingRestore = undefined;
    this.native?.destroy();
    this.core?.dispose();
    this.root?.remove();
    this.root = this.native = this.core = undefined;
    this.parser.reset();
    this.keyHandler = undefined;
    for (const e of [this.before, this.changed, this.opened, this.parsed, this.nativeParsed, this.resetting, this.resized, this.fit, this.data]) e.clear();
  }
}
