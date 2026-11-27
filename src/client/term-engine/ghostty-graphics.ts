import type { GhosttyCell } from 'ghostty-web';
import { KITTY_PLACEHOLDER_CHAR } from '../../shared/kitty';
import { createKittyOverlay, type KittyTerminalOptions } from '../term-kitty-overlay';
import type { GhosttyAdapter } from './ghostty';
import { GraphicsRows, placeholderRow } from './ghostty-graphics-rows';

export function attachGhosttyGraphics(adapter: GhosttyAdapter, images: KittyTerminalOptions = {}): void {
  let rows: GraphicsRows | undefined;
  let viewport: GhosttyCell[] = [];
  const overlay = createKittyOverlay(
    {
      capturePointer: true,
      get cols() {
        return adapter.cols;
      },
      get rows() {
        return adapter.rows;
      },
      cursorColumn: () => adapter.native?.wasmTerm?.getCursor().x ?? 0,
      anchorRow: () => rows?.anchor(),
      // Pinned CanvasRenderer draws at floor(offset), even between smooth-scroll steps.
      viewportTop: () => {
        const term = adapter.native;
        if (virtual && term?.wasmTerm) {
          term.wasmTerm.update();
          viewport = term.wasmTerm.getViewport();
        }
        return (term?.getScrollbackLength() ?? 0) - Math.floor(term?.getViewportY() ?? 0);
      },
      placeholders: (line) => {
        const term = adapter.native;
        if (!term?.wasmTerm || !virtual) return { mutated: false };
        return placeholderRow(term.wasmTerm, line, term.getScrollbackLength(), viewport);
      },
      cellGeometry: () => {
        const metrics = adapter.native?.renderer?.getMetrics();
        return (metrics && { cellW: metrics.width, cellH: metrics.height, cssW: metrics.width * adapter.cols, cssH: metrics.height * adapter.rows }) || null;
      },
      extraRows: () => 0,
      refresh: () => adapter.redraw(),
      shellState: () => ({ mouseTrackingMode: adapter.modes.mouseTrackingMode, bufferType: adapter.native?.wasmTerm?.isAlternateScreen() ? 'alternate' : 'normal' }),
      focus: () => adapter.focus(),
      hasSelection: () => adapter.native?.hasSelection() ?? false,
      hasPlaceholder: () => false,
    },
    images,
  );
  let virtual = false;
  const reset = () => {
    overlay.graphics.reset();
    overlay.clearPlacements();
    overlay.clearDecoded();
    rows?.setRegion(false);
    virtual = false;
    overlay.schedulePaint();
  };
  const hooks = [
    adapter.onReset(() => {
      reset();
      rows?.reset();
    }),
    adapter.parser.registerEscHandler({ final: 'c' }, () => {
      reset();
      return false;
    }),
    adapter.parser.registerApcHandler((body) => {
      rows?.apc();
      if (!body.startsWith('G')) return false;
      // Ignore the reply from KittyGraphicsStore: this is a passive PTY mirror.
      const move = overlay.handleApcBody(body.slice(1));
      if (!virtual) virtual = Array.from(overlay.graphics.values()).some((img) => img.unicode);
      if (move) rows?.move(move, (s) => adapter.native?.write(s));
      rows?.placed();
      return true;
    }),
    adapter.onBeforeWrite((data) => {
      if (!virtual && data.includes(KITTY_PLACEHOLDER_CHAR)) virtual = true;
      rows?.begin(data);
    }),
    adapter.onWriteParsed(() => {
      rows?.end();
      if (overlay.needsPaint()) overlay.schedulePaint();
    }),
    ...['h', 'l'].map((final) =>
      adapter.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        rows?.mode(params, final === 'h');
        return false;
      }),
    ),
    adapter.parser.registerCsiHandler({ final: 'r' }, (params) => {
      rows?.setRegion((params[0] || 1) !== 1 || (params[1] || adapter.rows) !== adapter.rows);
      return false;
    }),
    adapter.parser.registerCsiHandler({ final: 'J' }, (params) => {
      if (!adapter.native?.wasmTerm?.isAlternateScreen() && (params[0] === 2 || params[0] === 3)) rows?.invalidate(params[0] === 2);
      return false;
    }),
    ...['L', 'M', 'S', 'T'].map((final) =>
      adapter.parser.registerCsiHandler({ final }, () => {
        if (!adapter.native?.wasmTerm?.isAlternateScreen()) rows?.invalidate(true);
        return false;
      }),
    ),
  ];
  adapter.onOpen((term, lifetime) => {
    const canvas = term.renderer?.getCanvas();
    if (!term.wasmTerm || !canvas || !term.element) return;
    rows = new GraphicsRows(term.wasmTerm);
    const screen = document.createElement('div');
    screen.className = 'ghostty-kitty-screen';
    screen.contentEditable = 'false';
    canvas.before(screen);
    overlay.mount(screen, term.element.parentElement ?? term.element);
    hooks.push(
      term.onScroll(() => {
        if (overlay.needsPaint()) overlay.paintNow();
      }),
    );
    hooks.push(
      term.onResize(() => {
        // No stable line ID, reflow map, or trim count is available. Never leave an
        // absolute placement over unrelated text. Virtual placements re-read the new cells.
        rows?.resized();
        overlay.schedulePaint();
      }),
    );
    hooks.push(
      adapter.onOptionChange(() => {
        if (overlay.needsPaint()) overlay.schedulePaint();
      }),
    );
    lifetime.addEventListener(
      'abort',
      () => {
        for (const hook of hooks) hook.dispose();
        overlay.dispose();
        overlay.graphics.reset();
        screen.remove();
        rows = undefined;
      },
      { once: true },
    );
  });
}
