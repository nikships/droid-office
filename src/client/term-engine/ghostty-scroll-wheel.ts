import type { Terminal } from 'ghostty-web';
import type { GhosttyAdapter } from './ghostty';

/** xterm's application wheel channel: one arrow or mouse report per accepted wheel event,
 * not one per row. Small pixel deltas accumulate across a trackpad gesture. */
export function programWheel(adapter: GhosttyAdapter, native: Terminal) {
  let remainder = 0;
  return {
    reset() {
      remainder = 0;
    },
    handle(e: WheelEvent) {
      const modes = adapter.modes;
      // X10 only reports presses; normal-history wheels and alternate-screen arrows still work.
      const mouse = native.hasMouseTracking() && modes.mouseTrackingMode !== 'x10';
      if (!mouse && !native.wasmTerm?.isAlternateScreen()) return false;
      const renderer = native.renderer;
      if (e.shiftKey || !renderer || adapter.options.disableStdin) return true;
      const { width, height } = renderer.getMetrics();
      if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
        remainder += (e.deltaY / height) * (Math.abs(e.deltaY) < 50 ? 0.3 : 1) * (adapter.options.scrollSensitivity ?? 1) * (e.altKey || e.ctrlKey ? 5 : 1);
        if (Math.abs(remainder) < 1) return true;
        remainder %= 1;
      }
      if (!mouse) {
        adapter.input(`\x1b${modes.applicationCursorKeysMode ? 'O' : '['}${e.deltaY < 0 ? 'A' : 'B'}`);
        return true;
      }
      // The office uses onData, not xterm's binary channel for legacy mouse reports.
      const pixels = native.getMode(1016);
      if (!pixels && !native.getMode(1006)) return true;
      const rect = renderer.getCanvas().getBoundingClientRect();
      const px = Math.floor(Math.min(width * native.cols - 1, Math.max(0, e.clientX - rect.left)));
      const py = Math.floor(Math.min(height * native.rows - 1, Math.max(0, e.clientY - rect.top)));
      const code = (e.deltaY < 0 ? 64 : 65) + (e.altKey ? 8 : 0) + (e.ctrlKey ? 16 : 0);
      adapter.input(`\x1b[<${code};${pixels ? px : 1 + Math.floor(px / width)};${pixels ? py : 1 + Math.floor(py / height)}M`);
      return true;
    },
  };
}
