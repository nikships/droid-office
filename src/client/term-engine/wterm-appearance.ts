import type { CellData, TerminalCore } from '@wterm/core';
import type { WTermAdapter } from './wterm';

// Display-only surfaces (Android and Changes Log) never expose navigable anchors.
export const nativeLinkPanes = new WeakSet<WTermAdapter>();

/** Only mask host-owned placeholders and links on surfaces without navigation. */
export function wtermAppearance(core: TerminalCore, adapter: WTermAdapter): TerminalCore {
  function display(cell: CellData): CellData {
    if (cell.linkUri && !nativeLinkPanes.has(adapter)) cell = { ...cell, linkUri: undefined, linkId: undefined, linkKey: undefined };
    if (cell.char === 0x10eeee) return { ...cell, char: 32, chars: undefined, flags: cell.flags & ~8, underlineStyle: 'none' };
    return cell;
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
    setThemeColors: core.setThemeColors?.bind(core),
    getColorOverrides: core.getColorOverrides?.bind(core),
  };
}
