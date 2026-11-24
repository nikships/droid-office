// Pixel-smooth scrollback for an xterm.js terminal. xterm already keeps its scroll position in
// fractional pixels (its scrollbar, trackpad deltas and wheel glides all move it smoothly) but
// shows only whole rows. This draws the rest: the screen layer is translated by the part of a row
// the position sits past the rows on screen, and the row just above and just below are drawn
// beside them so the edge is never blank. The translation is a compositor-only transform, set at
// most once per frame and only while the position moves; once scrolling stops it settles onto a
// whole row, so a terminal at rest is laid out exactly as xterm draws it.
//
// Only the normal buffer moves by pixels. The alternate screen and programs that read the wheel
// (mouse reporting) still get whole lines from xterm, as before.
//
// Shared with the Android terminal page (bundled by tools/android-terminal.mjs), so it imports
// nothing at runtime and touches xterm internals only through the guarded lookups below.

import type { IDisposable, Terminal } from '@xterm/xterm';

/** How long the position has to stay still before it settles onto a whole row. */
export const SETTLE_DELAY_MS = 160;
/** How long settling onto a whole row takes. */
export const SETTLE_MS = 120;

interface ScrollPosition {
  scrollTop: number;
}
interface XtermScrollable {
  getFutureScrollPosition(): ScrollPosition;
}
interface XtermScrollableElement {
  _scrollable?: XtermScrollable;
  onScroll(listener: (e: ScrollPosition) => void): IDisposable;
  getScrollPosition(): ScrollPosition;
  getScrollDimensions?(): { height: number; scrollHeight: number };
  setScrollPosition(update: { scrollTop: number; reuseAnimation?: boolean }): void;
  getDomNode(): HTMLElement;
}
interface XtermDimensions {
  css: { cell: { width: number; height: number }; canvas: { width: number; height: number } };
}
interface XtermDomRenderer {
  dimensions: XtermDimensions;
  _rowContainer?: HTMLElement;
  _widthCache?: unknown;
  _rowFactory?: {
    createRow(
      line: unknown,
      row: number,
      isCursorRow: boolean,
      cursorStyle: string,
      cursorInactiveStyle: string,
      cursorX: number,
      cursorBlink: boolean,
      cellWidth: number,
      widthCache: unknown,
      linkStart: number,
      linkEnd: number,
    ): HTMLElement[];
  };
}
interface XtermCore {
  _viewport?: { _scrollableElement?: XtermScrollableElement };
  _renderService?: { _renderer?: { value?: XtermDomRenderer }; _renderRows?(start: number, end: number): void; onRender?: Terminal['onRender'] };
  _bufferService?: { buffer?: { lines: { get(i: number): unknown; length: number }; ybase: number; y: number; x: number } };
}

interface Parts {
  core: XtermCore;
  scroller: XtermScrollableElement;
  renderer: XtermDomRenderer;
  screen: HTMLElement;
}

export interface PixelScroll {
  /** The pixels the screen is drawn past its whole rows: positive shows part of the row below. */
  offset(): number;
  /** Moves the scrollback by `px` (positive toward newer lines); false when it could not move. */
  scrollBy(px: number): boolean;
  /** Lands on the nearest whole row at once, where any glide was headed. */
  snap(): void;
  /** Shift+Page Up/Down glide a page, building on a glide already under way. True when handled. */
  handleKey(e: KeyboardEvent): boolean;
  /** While held (a finger or the scrollbar is down), the position never settles by itself. */
  hold(held: boolean): void;
  /** Whether the screen is clipped to its box, so layers may draw the row above and below it too. */
  drawsExtraRows(): boolean;
  dispose(): void;
}

const attached = new WeakMap<object, PixelScroll>();

/** The pixel scroller attached to `term`, if any. */
export const pixelScrollOf = (term: object): PixelScroll | undefined => attached.get(term);

function findParts(term: Terminal): Parts | null {
  const core = (term as unknown as { _core?: XtermCore })._core;
  const scroller = core?._viewport?._scrollableElement;
  const renderer = core?._renderService?._renderer?.value;
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
  if (!core || !scroller?._scrollable || typeof scroller.onScroll !== 'function' || !renderer?._rowFactory || !renderer._rowContainer || !core._bufferService?.buffer || !screen) return null;
  return { core, scroller, renderer, screen };
}

/**
 * Makes `term`'s scrollback move by pixels while `enabled` says so (by default, while its
 * `smoothScrollDuration` is on). Call before or after `term.open`.
 */
export function attachPixelScroll(term: Terminal, opts: { enabled?: () => boolean } = {}): PixelScroll {
  const enabled = opts.enabled ?? (() => (term.options.smoothScrollDuration ?? 0) > 0);
  let parts: Parts | null = null;
  const subs: IDisposable[] = [];
  /** The viewport row xterm last drew at the top of the screen. */
  let drawnTop = 0;
  /** The offset the screen is translated by now. */
  let shown = 0;
  let frame = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let tween = 0;
  let tweening = false;
  let held = false;
  /** The scrollbar's thumb is being dragged. */
  let dragging = false;
  let disposed = false;
  /** Rows dragged but not yet scrolled, when xterm's internals are missing and whole rows are all there is. */
  let leftover = 0;
  const above = document.createElement('div');
  const below = document.createElement('div');
  /** Which top row the extra rows were drawn for, and whether what they show may have changed since. */
  let extraTop = Number.NaN;
  let extraStale = true;
  let extraDrawn = false;
  let overflowBefore = '';

  const cell = () => parts?.renderer.dimensions?.css?.cell;
  const normal = () => term.buffer.active.type === 'normal';
  const active = () => !!parts && enabled() && normal();

  const drawRow = (el: HTMLElement, line: number, top: number) => {
    const p = parts!;
    const dims = p.renderer.dimensions.css;
    const buf = p.core._bufferService!.buffer!;
    const data = line >= 0 ? buf.lines.get(line) : undefined;
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.overflow = 'hidden';
    el.style.top = `${top}px`;
    el.style.width = `${dims.canvas.width}px`;
    el.style.height = `${dims.cell.height}px`;
    el.style.lineHeight = `${dims.cell.height}px`;
    if (!data) {
      el.replaceChildren();
      return;
    }
    const cursorRow = buf.ybase + buf.y;
    el.replaceChildren(
      ...p.renderer._rowFactory!.createRow(
        data,
        line,
        line === cursorRow,
        term.options.cursorStyle ?? 'block',
        term.options.cursorInactiveStyle ?? 'outline',
        Math.min(buf.x, term.cols - 1),
        false,
        dims.cell.width,
        p.renderer._widthCache,
        -1,
        -1,
      ),
    );
  };

  const drawExtraRows = () => {
    const p = parts!;
    const h = cell()!.height;
    // xterm adds and removes its own rows at the end of the container, so keep these after them.
    if (p.renderer._rowContainer!.lastElementChild !== below) p.renderer._rowContainer!.append(above, below);
    drawRow(above, drawnTop - 1, -h);
    drawRow(below, drawnTop + term.rows, term.rows * h);
    above.hidden = below.hidden = false;
    extraTop = drawnTop;
    extraStale = false;
    extraDrawn = true;
  };
  /** Empties and hides the extra rows at rest, so a resize that moves the screen's edge never shows stale ones. */
  const clearExtraRows = () => {
    above.replaceChildren();
    below.replaceChildren();
    above.hidden = below.hidden = true;
    extraDrawn = false;
    extraStale = true;
  };

  /** Where the position is, against the rows xterm has drawn, clamped to the one extra row each side. */
  const target = (): number => {
    if (!active()) return 0;
    const h = cell()?.height;
    if (!h) return 0;
    const o = parts!.scroller.getScrollPosition().scrollTop - drawnTop * h;
    return Math.max(-h, Math.min(h, o));
  };

  const apply = () => {
    frame = 0;
    if (!parts || disposed) return;
    const dpr = window.devicePixelRatio || 1;
    const o = Math.round(target() * dpr) / dpr || 0;
    if (o !== 0 && (extraStale || extraTop !== drawnTop)) drawExtraRows();
    else if (o === 0 && extraDrawn) clearExtraRows();
    if (o === shown) return;
    shown = o;
    // Promoted the first time it moves, and kept: a layer made and dropped each gesture repaints twice.
    if (o) parts.screen.style.willChange = 'transform';
    parts.screen.style.transform = o ? `translate3d(0, ${-o}px, 0)` : '';
  };
  const schedule = () => {
    if (!frame && !disposed) frame = requestAnimationFrame(apply);
  };

  const stopTween = () => {
    if (tween) cancelAnimationFrame(tween);
    tween = 0;
  };
  const write = (scrollTop: number) => {
    tweening = true;
    try {
      parts!.scroller.setScrollPosition({ scrollTop });
    } finally {
      tweening = false;
    }
  };
  const nearestRow = (px: number) => {
    const h = cell()!.height;
    return Math.round(px / h) * h;
  };
  const offRow = (px: number) => !!cell()?.height && Math.abs(px - nearestRow(px)) > 0.01;
  const settle = () => {
    settleTimer = undefined;
    if (!parts || disposed || held || dragging || !active() || !cell()?.height) return;
    const now = parts.scroller.getScrollPosition().scrollTop;
    // xterm's own glide (a wheel notch, Shift+Page Up) is still under way; settle after it.
    if (Math.abs(parts.scroller._scrollable!.getFutureScrollPosition().scrollTop - now) > 0.01) return scheduleSettle();
    const to = nearestRow(now);
    if (Math.abs(to - now) < 0.01) return;
    const start = performance.now();
    stopTween();
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / SETTLE_MS);
      write(now + (to - now) * (1 - (1 - k) ** 3));
      tween = k < 1 ? requestAnimationFrame(step) : 0;
    };
    tween = requestAnimationFrame(step);
  };
  const scheduleSettle = () => {
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, SETTLE_DELAY_MS);
  };

  /**
   * xterm ignores its own scroll events while it resizes, which can leave its position rows away
   * from the rows it shows (its scrollbar too). Once its scroll box matches the buffer again, put
   * the position back on those rows rather than draw the gap.
   */
  const resync = () => {
    const p = parts;
    const h = cell()?.height;
    if (!p || disposed || !h || !active()) return;
    const dims = p.scroller.getScrollDimensions?.();
    const lines = p.core._bufferService!.buffer!.lines.length;
    if (!dims || Math.abs(dims.scrollHeight - lines * h) > 0.5 || Math.abs(dims.height - p.renderer.dimensions.css.canvas.height) > 0.5) return;
    const top = term.buffer.active.viewportY;
    if (Math.round(p.scroller.getScrollPosition().scrollTop / h) !== top) write(top * h);
  };

  const onPointerUp = () => {
    if (!dragging) return;
    dragging = false;
    if (shown) scheduleSettle();
  };

  const connect = () => {
    if (parts || disposed) return;
    parts = findParts(term);
    if (!parts) return;
    const p = parts;
    drawnTop = term.buffer.active.viewportY;
    above.className = below.className = 'term-extra-row';
    above.hidden = below.hidden = true;
    above.setAttribute('aria-hidden', 'true');
    below.setAttribute('aria-hidden', 'true');
    // The extra rows sit outside the screen's box, so clip them to it: they show only while moving.
    overflowBefore = p.scroller.getDomNode().style.overflowY;
    p.scroller.getDomNode().style.overflowY = 'clip';
    const markStale = () => {
      extraStale = true;
      if (shown) schedule();
    };
    subs.push(
      p.scroller.onScroll((e) => {
        const h = cell()?.height;
        // xterm's own sync may still be under way: look once it has finished.
        if (h && Math.round(e.scrollTop / h) !== term.buffer.active.viewportY) queueMicrotask(resync);
        if (!tweening) stopTween();
        const off = offRow(e.scrollTop);
        if (off || shown) schedule();
        if (off && active()) scheduleSettle();
      }),
      // Rows are redrawn in xterm's animation frame: line the screen up with them in the same one.
      // The public onRender skips redraws of an unmoved viewport, which still draw rows.
      (p.core._renderService?.onRender ?? term.onRender)(() => {
        drawnTop = term.buffer.active.viewportY;
        resync();
        extraStale = true;
        apply();
      }),
      term.onWriteParsed(markStale),
      term.onSelectionChange(markStale),
      // Typing lands on the bottom row (xterm only scrolls there when it isn't on that row already).
      term.onData(() => {
        const b = term.buffer.active;
        if (shown && b.viewportY >= b.baseY) api.snap();
      }),
    );
    const node = p.scroller.getDomNode();
    const onScrollbar = (e: Event) => !!(e.target as Element | null)?.closest?.('.scrollbar');
    const onPointerDown = (e: PointerEvent) => {
      if (!onScrollbar(e)) return;
      dragging = true;
      stopTween();
    };
    // xterm finds the row under the pointer from the screen's box and clamps it to the rows it
    // drew, so a press (or a selection dragged) onto the part-shown row past an edge would land on
    // the row beside it. Bring that row fully in first, drawn at once, so the same line is under the
    // pointer as a whole row when xterm handles the event.
    const onPointerOnStrip = (e: MouseEvent) => {
      if (!shown || !active() || (e.type === 'mousemove' && !e.buttons) || onScrollbar(e)) return;
      const r = p.screen.getBoundingClientRect();
      const dir = e.clientY >= r.bottom ? 1 : e.clientY < r.top ? -1 : 0;
      if (!dir) return;
      const render = p.core._renderService?._renderRows;
      if (typeof render !== 'function') {
        // Without a way to draw it now, doing nothing beats landing on the wrong line.
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      stopTween();
      write((drawnTop + dir) * cell()!.height);
      render.call(p.core._renderService, 0, term.rows - 1);
      apply();
    };
    node.addEventListener('pointerdown', onPointerDown);
    node.addEventListener('mousedown', onPointerOnStrip, true);
    node.addEventListener('mousemove', onPointerOnStrip, true);
    window.addEventListener('pointerup', onPointerUp);
    subs.push({
      dispose: () => {
        node.removeEventListener('pointerdown', onPointerDown);
        node.removeEventListener('mousedown', onPointerOnStrip, true);
        node.removeEventListener('mousemove', onPointerOnStrip, true);
        window.removeEventListener('pointerup', onPointerUp);
      },
    });
  };

  const api: PixelScroll = {
    offset: () => shown,
    drawsExtraRows: () => !disposed && active(),
    scrollBy(px) {
      if (!parts || !normal()) {
        const h = cell()?.height || 1;
        leftover += px;
        const rows = Math.trunc(leftover / h);
        leftover -= rows * h;
        if (!rows) return true;
        const before = term.buffer.active.viewportY;
        term.scrollLines(rows);
        return term.buffer.active.viewportY !== before;
      }
      const before = parts.scroller.getScrollPosition().scrollTop;
      parts.scroller.setScrollPosition({ scrollTop: before + px });
      const moved = parts.scroller.getScrollPosition().scrollTop - before;
      return enabled() ? Math.abs(moved) > 0.01 : moved !== 0;
    },
    snap() {
      if (!parts || !cell()?.height) return;
      stopTween();
      const future = parts.scroller._scrollable!.getFutureScrollPosition().scrollTop;
      const to = nearestRow(future);
      if (to !== future || to !== parts.scroller.getScrollPosition().scrollTop) write(to);
      apply();
    },
    handleKey(e) {
      if (!active() || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || (e.key !== 'PageUp' && e.key !== 'PageDown')) return false;
      e.preventDefault();
      if (e.type !== 'keydown') return true;
      const p = parts!;
      const h = cell()!.height;
      const from = Math.round(p.scroller._scrollable!.getFutureScrollPosition().scrollTop / h);
      const to = Math.max(0, Math.min(term.buffer.active.baseY, from + (e.key === 'PageUp' ? -1 : 1) * (term.rows - 1)));
      stopTween();
      p.scroller.setScrollPosition({ scrollTop: to * h, reuseAnimation: true });
      return true;
    },
    hold(on) {
      if (held === on) return;
      held = on;
      if (on) {
        stopTween();
        if (settleTimer !== undefined) clearTimeout(settleTimer);
        settleTimer = undefined;
      } else if (shown) scheduleSettle();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      stopTween();
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      for (const s of subs.splice(0)) s.dispose();
      above.remove();
      below.remove();
      if (parts) {
        parts.screen.style.transform = parts.screen.style.willChange = '';
        parts.scroller.getDomNode().style.overflowY = overflowBefore;
      }
      attached.delete(term);
    },
  };

  attached.set(term, api);
  if (term.element) connect();
  else {
    const open = term.open.bind(term);
    term.open = (parent: HTMLElement) => {
      open(parent);
      connect();
    };
  }
  const dispose = term.dispose.bind(term);
  term.dispose = () => {
    api.dispose();
    dispose();
  };
  return api;
}
