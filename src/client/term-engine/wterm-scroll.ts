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
    let reportTravel = 0;
    let reportAlt = false;
    let reportTracking = 0;
    let horizontalReport = false;
    let remainder = 0;
    let lastTop: number | undefined;
    const pixels = (e: WheelEvent, delta = e.deltaY) => delta * (e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? el.clientHeight : e.deltaMode === WheelEvent.DOM_DELTA_LINE ? height() : 1);
    const historyWheel = (e: WheelEvent) => {
      // At normal speed Chromium owns the gesture, including platform momentum.
      const speed = (adapter.options.scrollSensitivity ?? 1) * (e.altKey ? 5 : 1);
      if (speed === 1 || !e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.ctrlKey || e.shiftKey || e.metaKey) {
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
        const tracking = core.mouseTracking();
        if (!tracking) {
          reportTravel = 0;
          return;
        }
        const max = el.scrollHeight - el.clientHeight;
        if (adapter.options.disableStdin || (!core.usingAltScreen() && !e.shiftKey && !adapter.isAtTail(max))) {
          // Don't send reports from a read-only mirror or a reader even just
          // two pixels from the tail. Native scrolling owns history.
          reportTravel = 0;
          e.stopImmediatePropagation();
          if (core.usingAltScreen()) e.preventDefault();
          else historyWheel(e);
          return;
        }
        if (e.shiftKey && max > 0) return; // wterm's explicit history override
        const first = el.querySelector('.term-row:not(.term-scrollback-row)')?.getBoundingClientRect();
        const row = height();
        const width = parseFloat(el.style.getPropertyValue('--term-cell-width')) * adapter.cols;
        if (!first || e.clientX < first.left || e.clientX >= first.left + width || e.clientY < first.top || e.clientY >= first.top + row * adapter.rows) return;
        const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
        if (horizontal !== horizontalReport) reportTravel = 0;
        horizontalReport = horizontal;
        reportAlt = core.usingAltScreen();
        reportTracking = tracking;
        reportTravel += pixels(e, horizontal ? e.deltaX : e.deltaY);
        if (Math.abs(reportTravel) >= row) {
          reportTravel %= row;
          return; // pass the original event to wterm's negotiated encoder
        }
        e.preventDefault();
        e.stopImmediatePropagation();
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
        if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        e.preventDefault();
        if (core.mouseTracking() || adapter.options.disableStdin || e.shiftKey) return;
        partialRow += pixels(e) / height();
        const rows = Math.trunc(partialRow);
        partialRow -= rows;
        if (rows) adapter.input(`\x1b${core.cursorKeysApp() ? 'O' : '['}${rows < 0 ? 'A' : 'B'}`.repeat(Math.min(Math.abs(rows), adapter.rows)));
      },
      { passive: false, signal },
    );
    // The VT scanner flushes mode changes in order, including two programs
    // switching screens in one PTY write with no intervening wheel event.
    adapter.onNativeParsed(() => {
      if (reportTravel && (reportAlt !== core.usingAltScreen() || reportTracking !== core.mouseTracking())) reportTravel = 0;
      if (partialRow && (!core.usingAltScreen() || core.mouseTracking())) partialRow = 0;
    });
    adapter.onReset(() => {
      partialRow = remainder = reportTravel = 0;
    });
  });
  return { handleKey: (e: KeyboardEvent) => handleKey(e) };
}
