import { KITTY_PLACEHOLDER_CHAR } from '../../shared/kitty';
import { createKittyOverlay, type KittyTerminalOptions } from '../term-kitty-overlay';
import type { WTermAdapter } from './wterm';
import { graphicsAnchors, placeholderCells } from './wterm-graphics-cells';

export function attachWtermGraphics(adapter: WTermAdapter, images: KittyTerminalOptions = {}) {
  let expand: ((clientX: number, clientY: number) => boolean) | undefined;
  adapter.onOpen((term, signal) => {
    const core = adapter.core!;
    const root = term.element;
    const grid = root.querySelector<HTMLElement>('.term-grid')!;
    const screen = document.createElement('div');
    screen.className = 'wterm-kitty-screen';
    screen.hidden = true;
    // A sibling, not a child: wterm rebuilds the entire grid on resize. Leave
    // screen free of stacking contexts so its canvases can straddle the DOM text.
    root.style.isolation = 'isolate';
    screen.style.cssText = 'position:absolute;pointer-events:none;';
    root.append(screen);
    const behind = document.createElement('canvas');
    behind.width = behind.height = 0;
    behind.style.cssText = 'position:absolute;left:0;top:0;z-index:-1;pointer-events:none';
    behind.setAttribute('aria-hidden', 'true');
    screen.append(behind);

    const anchors = graphicsAnchors(core, adapter.parser);
    // Observe every native resize synchronously, including a resize away and
    // back inside the same turn (a ResizeObserver only sees the final box).
    const priorResize = term.onResize;
    const resized = (cols: number, rows: number) => {
      anchors.resized();
      priorResize?.(cols, rows);
    };
    term.onResize = resized;
    let virtual = false;
    let top = 0;
    let rows = 0;
    const overlay = createKittyOverlay(
      {
        capturePointer: true,
        moveWithoutAnchor: true,
        get cols() {
          return core.getCols();
        },
        get rows() {
          return rows;
        },
        cursorColumn: () => core.getCursor().col,
        anchorRow: anchors.anchor,
        viewportTop: () => top,
        placeholders: (line) => (virtual ? placeholderCells(core, line) : { mutated: false }),
        cellGeometry: () => {
          const style = getComputedStyle(root);
          const cellW = parseFloat(style.getPropertyValue('--term-cell-width'));
          const cellH = parseFloat(style.getPropertyValue('--term-row-height'));
          if (!(cellW > 0 && cellH > 0)) return null;
          const total = core.getScrollbackCount() + core.getRows();
          top = Math.max(0, Math.min(total - 1, Math.floor((root.scrollTop - grid.offsetTop) / cellH)));
          rows = Math.min(total - top, Math.ceil(root.clientHeight / cellH) + 1);
          const cssW = Math.min(grid.clientWidth, core.getCols() * cellW);
          const cssH = rows * cellH;
          // The viewport-sized canvas lives in scroll *content* coordinates.
          // A fractional scroll therefore moves it with the row even before JS runs.
          screen.style.left = `${grid.offsetLeft}px`;
          screen.style.top = `${grid.offsetTop + top * cellH}px`;
          screen.style.width = `${cssW}px`;
          screen.style.height = `${cssH}px`;
          return { cellW, cellH, cssW, cssH };
        },
        extraRows: () => 0,
        refresh: () => {},
        shellState: () => ({ mouseTrackingMode: adapter.modes.mouseTrackingMode, bufferType: core.usingAltScreen() ? 'alternate' : 'normal' }),
        focus: () => term.focus(),
        hasSelection: () => !!term.getSelectionText(),
        hasPlaceholder: () => false,
      },
      images,
    );
    overlay.mount(screen, root, behind);
    expand = overlay.expandAtClient;
    screen.querySelector<HTMLCanvasElement>('.term-kitty-layer')!.style.cssText = 'position:absolute;left:0;z-index:1;pointer-events:none';
    const button = screen.querySelector('button');
    if (button) Object.assign(button.style, { position: 'absolute', pointerEvents: 'auto', zIndex: '3' });
    const paint = () => {
      if (overlay.needsPaint()) overlay.paintNow();
    };
    const reset = () => {
      anchors.reset();
      virtual = false;
      screen.hidden = true;
      overlay.graphics.reset();
      overlay.clearPlacements();
      overlay.clearDecoded();
      overlay.schedulePaint();
    };
    const hooks = [
      adapter.parser.registerApcHandler((body) => {
        if (!body.startsWith('G')) return false;
        const move = overlay.handleApcBody(body.slice(1));
        screen.hidden = overlay.graphics.size === 0;
        if (move) term.write(move);
        return true;
      }),
      adapter.onNativeParsed((s) => {
        anchors.parsed();
        if (!virtual && s.includes(KITTY_PLACEHOLDER_CHAR)) virtual = true;
      }),
      adapter.onWriteParsed(() => {
        if (overlay.needsPaint()) overlay.schedulePaint();
      }),
      adapter.onReset(reset),
      adapter.parser.registerEscHandler({ final: 'c' }, () => {
        reset();
        return false;
      }),
      adapter.onOptionChange(() => overlay.schedulePaint()),
    ];
    root.addEventListener('scroll', paint, { passive: true, signal });
    const size = new ResizeObserver(paint);
    size.observe(root);
    size.observe(grid);
    // Includes column-only resize (wterm replaces the rows even when the
    // grid's CSS box is unchanged) and the scrollback spacer materializing.
    const rebuilt = new MutationObserver(paint);
    rebuilt.observe(grid, { childList: true });
    signal.addEventListener('abort', () => {
      size.disconnect();
      rebuilt.disconnect();
      for (const h of hooks) h.dispose();
      if (term.onResize === resized) term.onResize = priorResize;
      overlay.dispose();
      expand = undefined;
      anchors.dispose();
      screen.remove();
    });
  });
  return { expandAtClient: (clientX: number, clientY: number) => expand?.(clientX, clientY) ?? false };
}
