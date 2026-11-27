import type { CellData, TerminalCore } from '@wterm/core';
import { TERM_THEME } from '../term-theme';
import type { WTermAdapter } from './wterm';

const linear = Float64Array.from({ length: 256 }, (_, i) => {
  const s = i / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
});
const luminance = (rgb: number) => 0.05 + 0.2126 * linear[rgb >> 16] + 0.7152 * linear[(rgb >> 8) & 255] + 0.0722 * linear[rgb & 255];

/** Walk the same 10% sRGB steps as xterm. Switch direction when the preferred end cannot meet the ratio. */
function contrast(ink: number, ground: number, ratio: number) {
  const bg = luminance(ground);
  let fg = luminance(ink);
  if (Math.max(fg, bg) >= ratio * Math.min(fg, bg)) return ink;
  const whiteContrast = 1.05 / bg;
  const blackContrast = bg / 0.05;
  const lighter = whiteContrast >= ratio && blackContrast >= ratio ? fg >= bg : whiteContrast > blackContrast;
  let r = ink >> 16;
  let g = (ink >> 8) & 255;
  let b = ink & 255;
  do {
    r += lighter ? Math.ceil((255 - r) / 10) : -Math.ceil(r / 10);
    g += lighter ? Math.ceil((255 - g) / 10) : -Math.ceil(g / 10);
    b += lighter ? Math.ceil((255 - b) / 10) : -Math.ceil(b / 10);
    ink = (r << 16) | (g << 8) | b;
    fg = luminance(ink);
  } while (ink !== 0 && ink !== 0xffffff && Math.max(fg, bg) < ratio * Math.min(fg, bg));
  return ink;
}

/** Display-only view; the original cell data remains available to graphics and links. */
export function wtermAppearance(core: TerminalCore, adapter: WTermAdapter): TerminalCore {
  let hostFg = Number.parseInt(TERM_THEME.foreground.slice(1), 16);
  let hostBg = 0;
  let fg = hostFg;
  let bg = hostBg;
  let ratio = adapter.options.minimumContrastRatio ?? 1;
  const cache = new Map<number, number>();
  adapter.onOptionChange((key) => {
    if (key === 'minimumContrastRatio') {
      ratio = adapter.options.minimumContrastRatio ?? 1;
      cache.clear();
    }
  });
  function display(cell: CellData): CellData {
    // Only the office policy opens links, and its image overlay owns placeholder ink.
    if (cell.linkUri) cell = { ...cell, linkUri: undefined, linkId: undefined, linkKey: undefined };
    if (cell.char === 0x10eeee) return { ...cell, char: 32, chars: undefined, flags: cell.flags & ~8, underlineStyle: 'none' };
    // In reverse video the ground is glyph ink. CSS transparency belongs on the glass, not the glyph.
    if (cell.flags & 0x20 && cell.bgRgb === undefined) cell = { ...cell, bgRgb: bg };
    if (ratio <= 1 || cell.char <= 32 || (cell.char >= 0x2500 && cell.char <= 0x259f) || (cell.char >= 0xe0a4 && cell.char <= 0xe0d6)) return cell;
    const reverse = cell.flags & 0x20;
    const ink = reverse ? (cell.bgRgb ?? bg) : (cell.fgRgb ?? fg);
    const ground = reverse ? (cell.fgRgb ?? fg) : (cell.bgRgb ?? bg);
    const dim = !!(cell.flags & 2);
    const key = ((dim ? 0x1000000 : 0) + ground) * 0x1000000 + ink;
    let rgb = cache.get(key);
    if (rgb === undefined) {
      rgb = contrast(ink, ground, dim ? ratio / 2 : ratio);
      // Bound memory even for animations cycling through millions of color pairs.
      if (cache.size >= 8192) cache.clear();
      cache.set(key, rgb);
    }
    return rgb === ink ? cell : reverse ? { ...cell, bgRgb: rgb } : { ...cell, fgRgb: rgb };
  }
  // Bind the public interface once. Rendering each cell needs no Proxy or method lookup table.
  return {
    init: core.init.bind(core),
    resize: core.resize.bind(core),
    writeString: core.writeString.bind(core),
    writeRaw: core.writeRaw.bind(core),
    getRowMetadata: core.getRowMetadata?.bind(core),
    getRowId: core.getRowId?.bind(core),
    isRowContentDirty: core.isRowContentDirty?.bind(core),
    isDirtyRow: core.isDirtyRow.bind(core),
    clearDirty: core.clearDirty.bind(core),
    getCols: core.getCols.bind(core),
    getRows: core.getRows.bind(core),
    trackPosition: core.trackPosition?.bind(core),
    getCursor: core.getCursor.bind(core),
    cursorKeysApp: core.cursorKeysApp.bind(core),
    bracketedPaste: core.bracketedPaste.bind(core),
    usingAltScreen: core.usingAltScreen.bind(core),
    mouseTracking: core.mouseTracking?.bind(core),
    mouseSgr: core.mouseSgr?.bind(core),
    mouseEncoding: core.mouseEncoding?.bind(core),
    focusEvents: core.focusEvents?.bind(core),
    synchronizedOutput: core.synchronizedOutput?.bind(core),
    synchronizedOutputGeneration: core.synchronizedOutputGeneration?.bind(core),
    kittyKeyboardFlags: core.kittyKeyboardFlags?.bind(core),
    modifyOtherKeys: core.modifyOtherKeys?.bind(core),
    getTitle: core.getTitle.bind(core),
    getWorkingDirectory: core.getWorkingDirectory?.bind(core),
    getBellCount: core.getBellCount?.bind(core),
    getClipboardWrite: core.getClipboardWrite?.bind(core),
    getShellIntegrationState: core.getShellIntegrationState?.bind(core),
    getResponse: core.getResponse.bind(core),
    getResourceState: core.getResourceState?.bind(core),
    getGraphicsState: core.getGraphicsState?.bind(core),
    getGraphicsImage: core.getGraphicsImage?.bind(core),
    getScrollbackCount: core.getScrollbackCount.bind(core),
    getScrollbackDiscardedCount: core.getScrollbackDiscardedCount?.bind(core),
    setScrollbackLines: core.setScrollbackLines?.bind(core),
    getScrollbackLineLen: core.getScrollbackLineLen.bind(core),
    getScrollbackRowMetadata: core.getScrollbackRowMetadata?.bind(core),
    findPrompt: core.findPrompt?.bind(core),
    getUnhandledSequences: core.getUnhandledSequences.bind(core),
    setUpdateListener: core.setUpdateListener?.bind(core),
    getCell: (r, c) => display(core.getCell(r, c)),
    getScrollbackCell: (r, c) => display(core.getScrollbackCell(r, c)),
    setThemeColors(colors, opts) {
      hostFg = fg = colors.foreground;
      hostBg = bg = colors.background;
      core.setThemeColors?.(colors, opts);
    },
    getColorOverrides() {
      const colors = core.getColorOverrides?.() ?? {};
      fg = colors.foreground ?? hostFg;
      bg = colors.background ?? hostBg;
      return colors;
    },
  };
}
