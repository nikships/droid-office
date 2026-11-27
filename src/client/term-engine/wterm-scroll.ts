import type { WTermAdapter } from './wterm';

const SETTLE_DELAY_MS = 160;
const SETTLE_MS = 120;
const SCROLLBAR_HIDE_MS = 700;

export function attachWtermScroll(adapter: WTermAdapter) {
  let handleKey = (_event: KeyboardEvent) => false;
  let snap = () => {};
  adapter.onOpen(({ element: el }, signal) => {
    const core = adapter.core!;
    // In short panes the initial 80x24 grid can overflow before the first fit.
    // Start following it, or wterm mistakes the first resize for a scrolled reader.
    adapter.scrollToBottom();
    const height = () => parseFloat(el.style.getPropertyValue('--term-row-height'));
    const max = () => Math.max(0, el.scrollHeight - el.clientHeight);
    const clamp = (px: number) => Math.min(max(), Math.max(0, px));
    const nearest = (px: number) => (px >= max() ? px : Math.round(px / height()) * height());
    let frame = 0;
    let target: number | undefined;
    let held = false;
    let partialWheel = 0;
    let settleTimer = 0;
    let hideTimer = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      clearTimeout(settleTimer);
      target = undefined;
    };
    const show = () => {
      el.classList.add('wterm-scrolling');
      clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => el.classList.remove('wterm-scrolling'), SCROLLBAR_HIDE_MS);
    };
    const settle = () => {
      clearTimeout(settleTimer);
      if (!held && adapter.options.smoothScrollDuration && Math.abs(nearest(el.scrollTop) - el.scrollTop) > 0.5) settleTimer = window.setTimeout(() => glide(nearest(el.scrollTop), SETTLE_MS), SETTLE_DELAY_MS);
    };
    const glide = (px: number, duration = adapter.options.smoothScrollDuration ?? 0) => {
      stop();
      const from = el.scrollTop;
      const to = clamp(px);
      if (from === to) return;
      show();
      if (!duration) {
        el.scrollTop = to;
        return;
      }
      target = to;
      const start = performance.now();
      let last = from;
      const step = (now: number) => {
        // A search, a native history trim or a thumb drag supersedes this animation.
        if (el.scrollTop !== last || core.usingAltScreen()) return stop();
        const k = Math.min(1, Math.max(0, (now - start) / duration));
        el.scrollTop = from + (to - from) * (1 - (1 - k) ** 3);
        last = el.scrollTop;
        if (k < 1) frame = requestAnimationFrame(step);
        else {
          target = undefined;
          settle();
        }
      };
      frame = requestAnimationFrame(step);
    };
    handleKey = (e) => {
      if (!e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || (e.key !== 'PageUp' && e.key !== 'PageDown') || core.usingAltScreen()) return false;
      e.preventDefault();
      if (e.type === 'keydown') glide(nearest(target ?? el.scrollTop) + (e.key === 'PageUp' ? -1 : 1) * (adapter.rows - 1) * height());
      return true;
    };
    snap = () => {
      stop();
      el.scrollTop = nearest(el.scrollTop);
    };
    el.addEventListener(
      'wheel',
      (e) => {
        const cancel = () => {
          e.preventDefault();
          e.stopImmediatePropagation();
        };
        if (!e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return cancel();
        const speed = adapter.options.scrollSensitivity ?? 1;
        const pixel = e.deltaMode === WheelEvent.DOM_DELTA_PIXEL;
        if (core.mouseTracking() || core.usingAltScreen()) {
          if (e.shiftKey || adapter.options.disableStdin) return cancel();
          if (pixel) {
            partialWheel += (e.deltaY / height()) * (Math.abs(e.deltaY) < 50 ? 0.3 : 1) * speed * (e.altKey || e.ctrlKey ? 5 : 1);
            if (Math.abs(partialWheel) < 1) return cancel();
            partialWheel %= 1;
          }
          if (core.mouseTracking()) {
            // Native reports defer to history when scrolled up. xterm also uses
            // zero-based pixels for SGR-pixels, but one-based cells for other modes.
            const encoding = core.mouseEncoding();
            const rect = el.querySelector('.term-row:not(.term-scrollback-row)')?.getBoundingClientRect();
            if (!rect) return cancel();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const code = (e.deltaY < 0 ? 64 : 65) + (e.altKey ? 8 : 0) + (e.ctrlKey ? 16 : 0);
            const width = parseFloat(el.style.getPropertyValue('--term-cell-width'));
            if (x >= 0 && y >= 0 && x < adapter.cols * width && y < adapter.rows * height()) {
              const col = Math.floor(x / width) + 1;
              const row = Math.floor(y / height()) + 1;
              if (encoding === 'sgr-pixels') adapter.input(`\x1b[<${code};${Math.floor(x)};${Math.floor(y)}M`);
              else if (encoding === 'sgr') adapter.input(`\x1b[<${code};${col};${row}M`);
              // xterm ignores 1005/1015 and stays in legacy encoding. The PTY
              // takes UTF-8 strings: forward the complete ASCII report or nothing.
              else if (col <= 95 && row <= 95) adapter.input(`\x1b[M${String.fromCharCode(code + 32, col + 32, row + 32)}`);
            }
          } else adapter.input(`\x1b${core.cursorKeysApp() ? 'O' : '['}${e.deltaY < 0 ? 'A' : 'B'}`);
          return cancel();
        }
        cancel();
        const detent = pixel && !e.deltaX && 'wheelDeltaY' in e && typeof e.wheelDeltaY === 'number' && e.wheelDeltaY % 120 === 0 ? -e.wheelDeltaY / 120 : 0;
        const pixels = detent ? detent * 50 : pixel ? e.deltaY : e.deltaY * (e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? el.clientHeight : height());
        const delta = pixels * speed * (e.altKey ? 5 : 1);
        if (pixel && !detent) {
          glide(el.scrollTop + delta, 0); // The trackpad already supplies its own momentum.
          settle();
        } else glide((target ?? el.scrollTop) + delta);
      },
      { capture: true, passive: false, signal },
    );
    el.addEventListener(
      'pointerdown',
      () => {
        stop();
        held = true;
      },
      { signal },
    );
    el.addEventListener(
      'scroll',
      () => {
        if (held) show();
      },
      { signal },
    );
    const release = () => {
      if (!held) return;
      held = false;
      settle();
    };
    for (const event of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(event, release, { signal });
    adapter.onOptionChange((key) => {
      if (key === 'smoothScrollDuration' && !adapter.options.smoothScrollDuration) stop();
    });
    adapter.onData((data) => {
      if (data === '\x1b[I' || data === '\x1b[O') return;
      stop();
      el.classList.remove('wterm-scrolling');
    });
    adapter.onReset(() => {
      stop();
      partialWheel = 0;
    });
    signal.addEventListener(
      'abort',
      () => {
        stop();
        clearTimeout(hideTimer);
        handleKey = () => false;
        snap = () => {};
      },
      { once: true },
    );
  });
  return { handleKey: (e: KeyboardEvent) => handleKey(e), snap: () => snap() };
}
