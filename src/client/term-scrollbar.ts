// Minimal, scroll-only visibility controller for xterm.js terminals.
//
// xterm reveals its scrollbar on hover across the whole terminal and on every
// programmatic output write, and keeps a full-height hidden slider in the DOM
// even when there is no scrollback. This controller tracks actual scrollback
// (`.term-scrollable`), reveals the hairline thumb only when genuine user
// scroll input moves the viewport (`.term-scrolling`), and holds it open while
// the user drags the thumb (`.term-scrollbar-drag`). Typing, streaming output,
// resizing and alternate-screen apps never light it up.

import type { IDisposable, Terminal } from '@xterm/xterm';

/** How long after a user scroll gesture an ensuing scroll position change counts as user-driven. */
export const SCROLL_INTENT_MS = 220;
/** How long the minimal scrollbar stays visible after scrolling stops. */
export const SCROLLBAR_HIDE_MS = 700;

interface ScrollPosition {
  scrollTop: number;
}
interface XtermScrollableElement {
  onScroll(listener: (e: ScrollPosition) => void): IDisposable;
  getScrollPosition(): ScrollPosition;
  getScrollDimensions?(): { height: number; scrollHeight: number };
}
interface XtermViewport {
  _scrollableElement?: XtermScrollableElement;
  _isSyncing?: boolean;
}
interface XtermCore {
  _viewport?: XtermViewport;
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/** The only keyboard shortcuts xterm binds to scrollback navigation. */
export function isTerminalScrollKey(e: Pick<KeyboardEvent, 'key' | 'shiftKey'>): boolean {
  return e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown');
}

export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}

function findViewport(term: Terminal): { viewport: XtermViewport; scroller: XtermScrollableElement } | null {
  const viewport = (term as unknown as { _core?: XtermCore })._core?._viewport;
  const scroller = viewport?._scrollableElement;
  if (!viewport || !scroller || typeof scroller.onScroll !== 'function' || typeof scroller.getScrollPosition !== 'function') return null;
  return { viewport, scroller };
}

/**
 * Attaches minimal scrollbar state classes to `term`'s root element. Safe to
 * call before or after `term.open(host)`; cleans up automatically on dispose.
 */
export function attachTerminalScrollbar(term: Terminal, opts: { now?: () => number } = {}): IDisposable {
  const now = opts.now ?? (() => performance.now());
  const subs: IDisposable[] = [];
  let root: HTMLElement | null = null;
  let viewport: XtermViewport | null = null;
  let scroller: XtermScrollableElement | null = null;
  let intentUntil = -Infinity;
  let lastPos: number | null = null;
  let dragging = false;
  let selecting = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const clearHide = () => {
    if (hideTimer !== undefined) {
      clearTimeout(hideTimer);
      hideTimer = undefined;
    }
  };

  const hideNow = () => {
    clearHide();
    dragging = false;
    selecting = false;
    intentUntil = -Infinity;
    root?.classList.remove('term-scrolling', 'term-scrollbar-drag', 'term-scrollbar-quiet');
  };

  const scheduleHide = () => {
    clearHide();
    hideTimer = setTimeout(() => {
      hideTimer = undefined;
      root?.classList.remove('term-scrolling');
    }, SCROLLBAR_HIDE_MS);
  };

  const reveal = () => {
    if (!root || disposed) return;
    root.classList.remove('term-scrollbar-quiet');
    root.classList.add('term-scrolling');
    if (dragging) clearHide();
    else scheduleHide();
  };

  const cancelScrollReveal = () => {
    intentUntil = -Infinity;
    clearHide();
    if (!root) return;
    // Drop any active reveal or in-progress idle fade immediately before xterm snaps
    // to the prompt on input, while leaving direct rail hover and thumb drag untouched.
    root.classList.add('term-scrollbar-quiet');
    root.classList.remove('term-scrolling');
  };

  const hasScrollback = (): boolean => {
    const buf = term.buffer?.active;
    if (buf?.type !== 'normal' || buf.baseY <= 0) return false;
    const dims = scroller?.getScrollDimensions?.();
    return !dims || dims.scrollHeight > dims.height + 0.5;
  };

  const syncScrollable = (): boolean => {
    const scrollable = hasScrollback();
    root?.classList.toggle('term-scrollable', scrollable);
    if (!scrollable) {
      hideNow();
      lastPos = null;
    }
    return scrollable;
  };

  const onPosition = (pos: number) => {
    if (disposed) return;
    const scrollable = syncScrollable();
    const prev = lastPos;
    const moved = prev !== null && Math.abs(pos - prev) > 0.01;
    lastPos = scrollable ? pos : null;
    if (!scrollable || !moved) return;
    // Buffer-to-viewport sync (streaming output, capped-scrollback trimming, resizes) is programmatic.
    if (viewport?._isSyncing) return;
    if (dragging || now() <= intentUntil) reveal();
  };

  const markIntent = () => {
    if (hasScrollback()) intentUntil = now() + SCROLL_INTENT_MS;
  };

  const connect = () => {
    if (root || disposed || !term.element) return;
    const found = findViewport(term);
    if (!found) return;
    root = term.element;
    viewport = found.viewport;
    scroller = found.scroller;
    if (syncScrollable()) lastPos = scroller.getScrollPosition().scrollTop;

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY !== 0) markIntent();
    };
    const onTouchMove = () => markIntent();
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTerminalScrollKey(e)) markIntent();
      else if (!isModifierKey(e.key)) cancelScrollReveal();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as Element | null;
      if (target?.closest?.('.scrollbar.vertical')) {
        if (!syncScrollable()) return;
        dragging = true;
        intentUntil = now() + SCROLL_INTENT_MS;
        clearHide();
        root?.classList.remove('term-scrollbar-quiet');
        root?.classList.add('term-scrollbar-drag');
      } else {
        selecting = true;
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (selecting && (e.buttons & 1) !== 0) markIntent();
    };
    const onPointerEnd = () => {
      selecting = false;
      if (!dragging) return;
      dragging = false;
      root?.classList.remove('term-scrollbar-drag');
      if (root?.classList.contains('term-scrolling')) scheduleHide();
    };

    root.addEventListener('wheel', onWheel, { capture: true, passive: true });
    root.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
    root.addEventListener('keydown', onKeyDown, true);
    root.addEventListener('pointerdown', onPointerDown, true);
    const win = root.ownerDocument?.defaultView;
    win?.addEventListener('pointermove', onPointerMove, true);
    win?.addEventListener('pointerup', onPointerEnd);
    win?.addEventListener('pointercancel', onPointerEnd);
    win?.addEventListener('blur', onPointerEnd);

    subs.push({
      dispose: () => {
        root?.removeEventListener('wheel', onWheel, { capture: true });
        root?.removeEventListener('touchmove', onTouchMove, { capture: true });
        root?.removeEventListener('keydown', onKeyDown, true);
        root?.removeEventListener('pointerdown', onPointerDown, true);
        win?.removeEventListener('pointermove', onPointerMove, true);
        win?.removeEventListener('pointerup', onPointerEnd);
        win?.removeEventListener('pointercancel', onPointerEnd);
        win?.removeEventListener('blur', onPointerEnd);
      },
    });

    const syncOnly = () => {
      const scrollable = syncScrollable();
      if (scrollable && lastPos === null && scroller) lastPos = scroller.getScrollPosition().scrollTop;
    };
    subs.push(
      scroller.onScroll((e) => onPosition(e.scrollTop)),
      term.onWriteParsed(syncOnly),
      term.onResize(syncOnly),
      term.onData(cancelScrollReveal),
    );
    if (term.buffer?.onBufferChange) {
      subs.push(
        term.buffer.onBufferChange(() => {
          const scrollable = syncScrollable();
          lastPos = scrollable && scroller ? scroller.getScrollPosition().scrollTop : null;
        }),
      );
    }
  };

  const api: IDisposable = {
    dispose() {
      if (disposed) return;
      disposed = true;
      hideNow();
      root?.classList.remove('term-scrollable');
      for (const s of subs.splice(0)) s.dispose();
      root = null;
      viewport = null;
      scroller = null;
    },
  };

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
