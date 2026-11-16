// Built from src/client/term-pixel-scroll.ts by tools/android-terminal.mjs. Do not edit.
const SETTLE_DELAY_MS = 160;
const SETTLE_MS = 120;
const attached = /* @__PURE__ */ new WeakMap();
const pixelScrollOf = (term) => attached.get(term);
function findParts(term) {
  const core = term._core;
  const scroller = core?._viewport?._scrollableElement;
  const renderer = core?._renderService?._renderer?.value;
  const screen = term.element?.querySelector(".xterm-screen");
  if (!core || !scroller?._scrollable || typeof scroller.onScroll !== "function" || !renderer?._rowFactory || !renderer._rowContainer || !core._bufferService?.buffer || !screen) return null;
  return { core, scroller, renderer, screen };
}
function attachPixelScroll(term, opts = {}) {
  const enabled = opts.enabled ?? (() => (term.options.smoothScrollDuration ?? 0) > 0);
  let parts = null;
  const subs = [];
  let drawnTop = 0;
  let shown = 0;
  let frame = 0;
  let settleTimer;
  let tween = 0;
  let tweening = false;
  let held = false;
  let dragging = false;
  let disposed = false;
  let leftover = 0;
  const above = document.createElement("div");
  const below = document.createElement("div");
  let extraTop = Number.NaN;
  let extraStale = true;
  const cell = () => parts?.renderer.dimensions?.css?.cell;
  const normal = () => term.buffer.active.type === "normal";
  const active = () => !!parts && enabled() && normal();
  const drawRow = (el, line, top) => {
    const p = parts;
    const dims = p.renderer.dimensions.css;
    const buf = p.core._bufferService.buffer;
    const data = line >= 0 ? buf.lines.get(line) : void 0;
    el.style.position = "absolute";
    el.style.left = "0";
    el.style.overflow = "hidden";
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
      ...p.renderer._rowFactory.createRow(
        data,
        line,
        line === cursorRow,
        term.options.cursorStyle ?? "block",
        term.options.cursorInactiveStyle ?? "outline",
        Math.min(buf.x, term.cols - 1),
        false,
        dims.cell.width,
        p.renderer._widthCache,
        -1,
        -1
      )
    );
  };
  const drawExtraRows = () => {
    const p = parts;
    const h = cell().height;
    if (p.renderer._rowContainer.lastElementChild !== below) p.renderer._rowContainer.append(above, below);
    drawRow(above, drawnTop - 1, -h);
    drawRow(below, drawnTop + term.rows, term.rows * h);
    extraTop = drawnTop;
    extraStale = false;
  };
  const target = () => {
    if (!active()) return 0;
    const h = cell()?.height;
    if (!h) return 0;
    const o = parts.scroller.getScrollPosition().scrollTop - drawnTop * h;
    return Math.max(-h, Math.min(h, o));
  };
  const apply = () => {
    frame = 0;
    if (!parts || disposed) return;
    const dpr = window.devicePixelRatio || 1;
    const o = Math.round(target() * dpr) / dpr;
    if (o !== 0 && (extraStale || extraTop !== drawnTop)) drawExtraRows();
    if (o === shown) return;
    shown = o;
    if (o) parts.screen.style.willChange = "transform";
    parts.screen.style.transform = o ? `translate3d(0, ${-o}px, 0)` : "";
  };
  const schedule = () => {
    if (!frame && !disposed) frame = requestAnimationFrame(apply);
  };
  const stopTween = () => {
    if (tween) cancelAnimationFrame(tween);
    tween = 0;
  };
  const write = (scrollTop) => {
    tweening = true;
    try {
      parts.scroller.setScrollPosition({ scrollTop });
    } finally {
      tweening = false;
    }
  };
  const nearestRow = (px) => {
    const h = cell().height;
    return Math.round(px / h) * h;
  };
  const offRow = (px) => {
    const h = cell()?.height;
    return !!h && Math.abs(px - Math.round(px / h) * h) > 0.01;
  };
  const settle = () => {
    settleTimer = void 0;
    if (!parts || disposed || held || dragging || !active() || !cell()?.height) return;
    const now = parts.scroller.getScrollPosition().scrollTop;
    if (Math.abs(parts.scroller._scrollable.getFutureScrollPosition().scrollTop - now) > 0.01) return scheduleSettle();
    const to = nearestRow(now);
    if (Math.abs(to - now) < 0.01) return;
    const start = performance.now();
    stopTween();
    const step = (t) => {
      const k = Math.min(1, (t - start) / SETTLE_MS);
      write(now + (to - now) * (1 - (1 - k) ** 3));
      tween = k < 1 ? requestAnimationFrame(step) : 0;
    };
    tween = requestAnimationFrame(step);
  };
  const scheduleSettle = () => {
    if (settleTimer !== void 0) clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, SETTLE_DELAY_MS);
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
    above.className = below.className = "term-extra-row";
    above.setAttribute("aria-hidden", "true");
    below.setAttribute("aria-hidden", "true");
    p.scroller.getDomNode().style.overflowY = "clip";
    subs.push(
      p.scroller.onScroll((e) => {
        if (!tweening) stopTween();
        const off = offRow(e.scrollTop);
        if (off || shown) schedule();
        if (off && active()) scheduleSettle();
      }),
      // Rows are redrawn in xterm's animation frame: line the screen up with them in the same one.
      term.onRender(() => {
        drawnTop = term.buffer.active.viewportY;
        extraStale = true;
        apply();
      }),
      term.onWriteParsed(() => {
        extraStale = true;
        if (shown) schedule();
      }),
      term.onSelectionChange(() => {
        extraStale = true;
        if (shown) schedule();
      }),
      // Typing lands on the bottom row (xterm only scrolls there when it isn't on that row already).
      term.onData(() => {
        const b = term.buffer.active;
        if (shown && b.viewportY >= b.baseY) api.snap();
      })
    );
    const node = p.scroller.getDomNode();
    const onPointerDown = (e) => {
      if (!e.target?.closest?.(".scrollbar")) return;
      dragging = true;
      stopTween();
    };
    node.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    subs.push({
      dispose: () => {
        node.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointerup", onPointerUp);
      }
    });
  };
  const api = {
    offset: () => shown,
    drawsExtraRows: () => !!parts && !disposed,
    scrollBy(px) {
      if (!parts || !normal()) {
        const h = cell()?.height || 1;
        leftover += px;
        const rows = Math.trunc(leftover / h);
        leftover -= rows * h;
        if (!rows) return true;
        const before2 = term.buffer.active.viewportY;
        term.scrollLines(rows);
        return term.buffer.active.viewportY !== before2;
      }
      const before = parts.scroller.getScrollPosition().scrollTop;
      parts.scroller.setScrollPosition({ scrollTop: before + px });
      if (!enabled()) return parts.scroller.getScrollPosition().scrollTop !== before;
      return Math.abs(parts.scroller.getScrollPosition().scrollTop - before) > 0.01;
    },
    snap() {
      if (!parts || !cell()?.height) return;
      stopTween();
      const future = parts.scroller._scrollable.getFutureScrollPosition().scrollTop;
      const to = nearestRow(future);
      if (to !== future || to !== parts.scroller.getScrollPosition().scrollTop) write(to);
      apply();
    },
    handleKey(e) {
      if (!active() || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.key !== "PageUp" && e.key !== "PageDown") return false;
      e.preventDefault();
      if (e.type !== "keydown") return true;
      const p = parts;
      const h = cell().height;
      const from = Math.round(p.scroller._scrollable.getFutureScrollPosition().scrollTop / h);
      const to = Math.max(0, Math.min(term.buffer.active.baseY, from + (e.key === "PageUp" ? -1 : 1) * (term.rows - 1)));
      stopTween();
      p.scroller.setScrollPosition({ scrollTop: to * h, reuseAnimation: true });
      return true;
    },
    hold(on) {
      if (held === on) return;
      held = on;
      if (on) {
        stopTween();
        if (settleTimer !== void 0) clearTimeout(settleTimer);
        settleTimer = void 0;
      } else if (shown) scheduleSettle();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      stopTween();
      if (settleTimer !== void 0) clearTimeout(settleTimer);
      for (const s of subs.splice(0)) s.dispose();
      above.remove();
      below.remove();
      if (parts) parts.screen.style.transform = "";
      attached.delete(term);
    }
  };
  attached.set(term, api);
  if (term.element) connect();
  else {
    const open = term.open.bind(term);
    term.open = (parent) => {
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
export {
  SETTLE_DELAY_MS,
  SETTLE_MS,
  attachPixelScroll,
  pixelScrollOf
};
