import { SETTLE_DELAY_MS, SETTLE_MS } from '../term-pixel-scroll';
import type { GhosttyAdapter } from './ghostty';
import { programWheel } from './ghostty-scroll-wheel';

/** Keep animation targets in top-relative rows: more output can arrive between any two frames. */
export function attachGhosttyScroll(adapter: GhosttyAdapter) {
  let handleKey = (_event: KeyboardEvent) => false;
  let snap = () => {};
  adapter.onOpen((native, signal) => {
    const history = () => native.getScrollbackLength();
    const top = () => history() - native.getViewportY();
    const normal = () => !native.wasmTerm?.isAlternateScreen();
    let destination: number | undefined;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading: { top: number; depth: number } | undefined;
    let writing = false;
    let moving = false;
    let held = false;
    const stop = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      frame = 0;
      destination = undefined;
    };
    const move = (row: number) => {
      moving = true;
      try {
        native.scrollLines(row - top());
      } finally {
        moving = false;
      }
    };
    const glide = (row: number, duration: number) => {
      stop();
      const from = top();
      const to = Math.min(history(), Math.max(0, row));
      if (!duration || to === from) return move(to);
      destination = to;
      const start = performance.now();
      const step = (now: number) => {
        const k = Math.max(0, Math.min(1, (now - start) / duration));
        move(k === 1 ? to : from + (to - from) * (1 - (1 - k) ** 3));
        if (k < 1) frame = requestAnimationFrame(step);
        else {
          destination = undefined;
          frame = 0;
          settle();
        }
      };
      frame = requestAnimationFrame(step);
    };
    const settle = () => {
      clearTimeout(timer);
      if (!held && normal() && !Number.isInteger(top())) timer = setTimeout(() => glide(Math.round(top()), SETTLE_MS), SETTLE_DELAY_MS);
    };
    snap = () => {
      stop();
      move(Math.round(top()));
    };
    handleKey = (e) => {
      if (!normal() || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || (e.key !== 'PageUp' && e.key !== 'PageDown')) return false;
      e.preventDefault();
      if (e.type === 'keydown') glide(Math.round(destination ?? top()) + (e.key === 'PageUp' ? -1 : 1) * (native.rows - 1), adapter.options.smoothScrollDuration ?? 0);
      return true;
    };
    const program = programWheel(adapter, native);
    native.attachCustomWheelEventHandler((e) => {
      // The native capture listener otherwise generates arrows for every alternate-screen
      // wheel, even in mouse mode. Don't let the second (bubbling) input handler report it too.
      e.stopImmediatePropagation();
      if (!e.deltaY || program.handle(e)) return true;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || !history()) return true;
      const cellHeight = native.renderer?.getMetrics().height;
      if (!cellHeight) return true;
      const pixelMode = e.deltaMode === WheelEvent.DOM_DELTA_PIXEL;
      // Chromium can report even a physical notch as DOM_DELTA_PIXEL. Its 120-unit detent
      // signal is what xterm maps to 50 CSS pixels, independent of the OS's deltaY setting.
      const ticks = pixelMode && !e.deltaX && 'wheelDeltaY' in e && typeof e.wheelDeltaY === 'number' && e.wheelDeltaY % 120 === 0 ? -e.wheelDeltaY / 120 : 0;
      const rows = ticks ? (ticks * 50) / cellHeight : pixelMode ? e.deltaY / cellHeight : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? e.deltaY * native.rows : e.deltaY;
      const delta = rows * (adapter.options.scrollSensitivity ?? 1) * (e.altKey ? 5 : 1);
      if (pixelMode && !ticks) {
        // Precise trackpad events include momentum. A second easing curve would fight the OS.
        stop();
        move(top() + delta);
        settle();
      } else glide((destination ?? top()) + delta, adapter.options.smoothScrollDuration ?? 0);
      return true;
    });
    const listeners = [
      native.onScroll(() => {
        if (moving || writing) return;
        stop(); // Search, native selection autoscroll or the canvas scrollbar takes ownership.
        settle();
      }),
      native.onResize(() => {
        stop();
        if (native.getViewportY() > history()) native.scrollLines(0);
      }),
      adapter.onReset(() => {
        stop();
        program.reset();
        reading = undefined;
      }),
      adapter.onOptionChange((key) => {
        if (key === 'smoothScrollDuration' && !adapter.options.smoothScrollDuration) stop();
      }),
      adapter.onBeforeWrite(() => {
        writing = true;
        const depth = native.getViewportY();
        reading = normal() && depth > 0 ? { top: history() - depth, depth } : undefined;
      }),
      adapter.onWriteParsed(() => {
        if (!normal()) stop();
        else if (reading) {
          // No trim count or stable row IDs. If history shrank, preserve depth rather than
          // jumping to the prompt. Once history is capped, identical lengths cannot identify trims.
          const row = Math.min(reading.top, history() - reading.depth);
          if (row < reading.top) stop();
          move(row);
        }
        reading = undefined;
        writing = false;
      }),
      adapter.onData((data) => {
        if (writing || data === '\x1b[I' || data === '\x1b[O') return;
        stop();
        native.scrollToBottom();
      }),
    ];
    // The library owns the thumb and its drag geometry. Do not settle under a stationary
    // pointer, or compete with selection's own autoscroll.
    native.element?.addEventListener(
      'pointerdown',
      () => {
        held = true;
        stop();
      },
      { signal, capture: true },
    );
    const release = () => {
      if (!held) return;
      held = false;
      settle();
    };
    for (const event of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(event, release, { signal });
    signal.addEventListener(
      'abort',
      () => {
        stop();
        native.attachCustomWheelEventHandler(undefined);
        for (const listener of listeners) listener.dispose();
        handleKey = () => false;
        snap = () => {};
      },
      { once: true },
    );
  });
  return { handleKey: (e: KeyboardEvent) => handleKey(e), snap: () => snap() };
}
