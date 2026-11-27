import type { WTermAdapter } from './wterm';

export function attachWtermScroll(adapter: WTermAdapter) {
  let handleKey = (_event: KeyboardEvent) => false;
  adapter.onOpen(({ element: el }, signal) => {
    const core = adapter.core!;
    // A short pane can overflow before the first fit. Start it at the tail.
    adapter.scrollToBottom();
    const height = () => parseFloat(el.style.getPropertyValue('--term-row-height'));
    handleKey = (e) => {
      if (!e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || (e.key !== 'PageUp' && e.key !== 'PageDown') || core.usingAltScreen()) return false;
      e.preventDefault();
      if (e.type === 'keydown') el.scrollTop += (e.key === 'PageUp' ? -1 : 1) * Math.max(height(), el.clientHeight - height());
      return true;
    };

    let partialRow = 0;
    let remainder = 0;
    let lastTop: number | undefined;
    const pixels = (e: WheelEvent) => e.deltaY * (e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? el.clientHeight : e.deltaMode === WheelEvent.DOM_DELTA_LINE ? height() : 1);
    const historyWheel = (e: WheelEvent) => {
      // At normal speed Chromium owns the gesture, including platform momentum.
      const speed = (adapter.options.scrollSensitivity ?? 1) * (e.altKey ? 5 : 1);
      if (speed === 1 || !e.deltaY || e.ctrlKey || e.shiftKey || e.metaKey) {
        remainder = 0;
        return;
      }
      e.preventDefault();
      // Slow scrolling must not round every half-pixel gesture to a whole pixel.
      const target = el.scrollTop + pixels(e) * speed + (lastTop === el.scrollTop ? remainder : 0);
      el.scrollTop = target;
      lastTop = el.scrollTop;
      remainder = target > 0 && target < el.scrollHeight - el.clientHeight ? target - lastTop : 0;
    };
    el.addEventListener(
      'wheel',
      (e) => {
        // A read-only mirror must not let wterm consume a wheel for a mouse
        // report it can't send. Its normal-screen history is always scrollable.
        if (!adapter.options.disableStdin || !core.mouseTracking()) return;
        e.stopImmediatePropagation();
        if (core.usingAltScreen()) e.preventDefault();
        else historyWheel(e);
      },
      { capture: true, passive: false, signal },
    );
    el.addEventListener(
      'wheel',
      (e) => {
        // wterm gets first choice: it consumes negotiated mouse reports over
        // the live grid but leaves the wheel alone while reading history.
        if (e.defaultPrevented) return;
        if (!core.usingAltScreen()) return historyWheel(e);
        e.preventDefault();
        if (core.mouseTracking() || adapter.options.disableStdin || e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        partialRow += pixels(e) / height();
        const rows = Math.trunc(partialRow);
        partialRow -= rows;
        if (rows) adapter.input(`\x1b${core.cursorKeysApp() ? 'O' : '['}${rows < 0 ? 'A' : 'B'}`.repeat(Math.min(Math.abs(rows), adapter.rows)));
      },
      { passive: false, signal },
    );
    adapter.onReset(() => {
      partialRow = remainder = 0;
    });
  });
  return { handleKey: (e: KeyboardEvent) => handleKey(e) };
}
