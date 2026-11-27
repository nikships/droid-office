import type { CanvasRenderer, GhosttyCell, IRenderable, Terminal } from 'ghostty-web';
import { contrastRatio, mixHex } from '../../shared/companion-themes';
import { KITTY_PLACEHOLDER_CHAR } from '../../shared/kitty';
import type { GhosttyAdapter } from './ghostty';

const rgb = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;
const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`;
const placeholder = KITTY_PLACEHOLDER_CHAR.codePointAt(0);

export function contrasted(fg: number, bg: number, ratio: number): number {
  const ink = hex(fg);
  const ground = hex(bg);
  if (contrastRatio(ink, ground) >= ratio) return fg;
  const target = contrastRatio('#ffffff', ground) >= contrastRatio('#000000', ground) ? '#ffffff' : '#000000';
  let lo = 0;
  let hi = 256;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (contrastRatio(mixHex(ink, target, mid / 256), ground) >= ratio) hi = mid;
    else lo = mid;
  }
  return Number.parseInt(mixHex(ink, target, hi / 256).slice(1), 16);
}

export function installAppearance(adapter: GhosttyAdapter, term: Terminal, signal: AbortSignal) {
  if (!term.renderer || !term.wasmTerm) return;
  const original = term.renderer;
  const core = term.wasmTerm;
  const cache = new Map<number, number>();
  const glassGround = () => (adapter.options.theme?.background?.startsWith('rgba(') ? Number.parseInt(adapter.options.theme.cursorAccent?.slice(1) ?? '0', 16) || 0 : 0);
  let ground = glassGround();
  const cells = (line: GhosttyCell[] | null) => {
    const ratio = adapter.options.minimumContrastRatio ?? 1;
    if (!line) return line;
    for (const c of line) {
      if (c.codepoint === placeholder) {
        // The image overlay owns the glyph. Keep the original core cell for placement/search.
        c.codepoint = 32;
        c.grapheme_len = 0;
      }
      if (c.codepoint <= 32 || ratio <= 1 || (c.codepoint >= 0x2500 && c.codepoint <= 0x259f) || (c.codepoint >= 0xe0b0 && c.codepoint <= 0xe0bf)) continue;
      const inverse = !!(c.flags & 16);
      const fg = inverse ? rgb(c.bg_r, c.bg_g, c.bg_b) : rgb(c.fg_r, c.fg_g, c.fg_b);
      const bg = inverse ? rgb(c.fg_r, c.fg_g, c.fg_b) : rgb(c.bg_r, c.bg_g, c.bg_b) || ground;
      const dim = !!(c.flags & 128);
      const key = (dim ? 0x1000000000000 : 0) + fg * 0x1000000 + bg;
      let adjusted = cache.get(key);
      if (adjusted === undefined) {
        adjusted = contrasted(fg, bg, dim ? ratio / 2 : ratio);
        if (cache.size >= 2048) cache.clear();
        cache.set(key, adjusted);
      }
      if (adjusted !== fg) {
        // GhosttyTerminal.getLine and getScrollbackLine return copies, never the core's cell pool.
        if (inverse) [c.bg_r, c.bg_g, c.bg_b] = [adjusted >> 16, (adjusted >> 8) & 255, adjusted & 255];
        else [c.fg_r, c.fg_g, c.fg_b] = [adjusted >> 16, (adjusted >> 8) & 255, adjusted & 255];
      }
    }
    return line;
  };
  // The native input handler and selection manager retain the renderer made by open().
  // Keep that renderer (and its selection manager) as painter. Customize only the public
  // render inputs, not its methods, cell pool, or private metrics.
  let viewportOffset = 0;
  const buffer: IRenderable = {
    getLine: (row) => cells(core.getLine(row)),
    getCursor: () => core.getCursor(),
    getDimensions: () => core.getDimensions(),
    clearDirty: () => core.clearDirty(),
    isRowDirty: (row) => core.isRowDirty(row),
    needsFullRedraw: () => core.needsFullRedraw(),
    getGraphemeString: (row, col) => {
      // CanvasRenderer asks for viewport-relative graphemes even when it paints history.
      const active = row - viewportOffset;
      return active < 0 ? core.getScrollbackGraphemeString(core.getScrollbackLength() + active, col) : core.getGraphemeString(active, col);
    },
  };
  const scrollback = { getScrollbackLength: () => core.getScrollbackLength(), getScrollbackLine: (row: number) => cells(core.getScrollbackLine(row)) };
  const Base = original.constructor as typeof CanvasRenderer;
  class OfficeRenderer extends Base {
    override getCanvas = original.getCanvas.bind(original);
    override getMetrics = original.getMetrics.bind(original);
    override get charWidth() {
      return original.charWidth;
    }
    override get charHeight() {
      return original.charHeight;
    }
    override clear = original.clear.bind(original);
    override resize = original.resize.bind(original);
    override remeasureFont = original.remeasureFont.bind(original);
    override setFontFamily = original.setFontFamily.bind(original);
    override setFontSize = original.setFontSize.bind(original);
    override setTheme = original.setTheme.bind(original);
    override setCursorBlink = original.setCursorBlink.bind(original);
    override setCursorStyle = original.setCursorStyle.bind(original);
    override setSelectionManager = original.setSelectionManager.bind(original);
    override setHoveredLinkRange = original.setHoveredLinkRange.bind(original);
    override setHoveredHyperlinkId = original.setHoveredHyperlinkId.bind(original);
    override dispose = original.dispose.bind(original);
    override render(source: IRenderable, force?: boolean, offset?: number, history?: Parameters<CanvasRenderer['render']>[3], opacity?: number) {
      viewportOffset = Math.floor(offset ?? 0);
      original.render(source === core ? buffer : source, force, offset, history === term ? scrollback : history, opacity);
    }
  }
  term.renderer = new OfficeRenderer(original.getCanvas());
  const changed = adapter.onOptionChange((key) => {
    if (key === 'minimumContrastRatio' || key === 'theme') {
      ground = glassGround();
      cache.clear();
      adapter.redraw();
    }
  });
  // Ghostty blinks on a fixed interval from open(), even during typing and focus changes.
  // Start a new visible phase on input/focus like xterm. DEC private mode 25 still wins.
  const showCursor = () => {
    if (adapter.options.cursorBlink) {
      original.setCursorBlink(false);
      original.setCursorBlink(true);
    }
  };
  term.element?.addEventListener('focusin', showCursor, { signal });
  const input = adapter.onData(showCursor);
  signal.addEventListener(
    'abort',
    () => {
      changed.dispose();
      input.dispose();
    },
    { once: true },
  );
}
