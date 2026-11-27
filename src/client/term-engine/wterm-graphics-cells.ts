import type { GhosttyCore } from '@wterm/ghostty';
import type { TerminalPosition, TrackedTerminalPosition } from '@wterm/core';
import { decodePlaceholderCell, KITTY_PLACEHOLDER_CHAR, type DecodedPlaceholder } from '../../shared/kitty';
import type { VtScanner } from '../../shared/vt-scanner';
import type { KittyRowAnchor } from '../term-kitty-overlay';

const placeholder = KITTY_PLACEHOLDER_CHAR.codePointAt(0);
const graphicsHandleLimit = 60; // Four of the core's 64 slots are reserved for other features.

export function placeholderCells(core: GhosttyCore, line: number) {
  const history = core.getScrollbackCount();
  const offset = history - line - 1; // Offset zero is the newest history row.
  const cols = offset >= 0 ? core.getScrollbackLineLen(offset) : core.getCols();
  let map: Map<number, DecodedPlaceholder> | undefined;
  let previous: DecodedPlaceholder | undefined;
  for (let col = 0; col < cols; col++) {
    const cell = offset >= 0 ? core.getScrollbackCell(offset, col) : core.getCell(line - history, col);
    if (cell.width === 0) continue;
    previous = cell.char === placeholder ? decodePlaceholderCell(cell.chars ?? KITTY_PLACEHOLDER_CHAR, cell.fgRgb ?? 0, cell.underlineRgb, previous) : undefined;
    if (previous) (map ??= new Map()).set(col, previous);
  }
  return { mutated: false, map };
}

/** A pin follows history and reflow. It does not follow content copied between
 * rows by IL/DL/SU/SD, or rows cleared at the margins. In those cases discard
 * the affected screen's pins, never infer a new position from cursor deltas. */
export function graphicsAnchors(core: GhosttyCore, parser: VtScanner) {
  const anchors = new Map<KittyRowAnchor, TrackedTerminalPosition | null>();
  let saved: { cols: number; rows: number; history: number; positions: Map<KittyRowAnchor, TerminalPosition> } | undefined;
  let returning = false;
  const discardSaved = () => {
    if (saved) for (const a of saved.positions.keys()) a.dispose();
    saved = undefined;
  };
  let region = false;
  let horizontalMargins = false;
  const dropLive = (start = 0) => {
    if (saved) return false;
    const first = core.getScrollbackCount() + start;
    for (const a of anchors.keys()) if (a.line < 0 || a.line >= first) a.dispose();
    return false;
  };
  const hooks = [
    ...['L', 'M'].map((final) => parser.registerCsiHandler({ final }, () => dropLive(core.getCursor().row))),
    ...['S', 'T'].map((final) => parser.registerCsiHandler({ final }, () => dropLive())),
    parser.registerEscHandler({ final: 'M' }, () => core.getCursor().row === 0 && dropLive()),
    ...['', '?'].map((prefix) =>
      parser.registerCsiHandler({ prefix, final: 'J' }, ([mode]) => {
        if (anchors.size && !saved) {
          const history = core.getScrollbackCount();
          const cursor = core.getCursor();
          // ED0 at the right edge cancels a pending wrap in wterm but not
          // xterm. A subsequent ED1 may then erase xterm's cursor-row marker.
          const firstErased = cursor.row + (cursor.col === core.getCols() - 1 ? 0 : 1);
          for (const a of anchors.keys()) {
            const row = a.line - history;
            if (row >= 0 && (mode === 2 || (mode === 0 && row >= firstErased) || (mode === 1 && row < cursor.row))) a.dispose();
          }
        }
        return false;
      }),
    ),
    parser.registerCsiHandler({ final: 'r' }, ([top, bottom]) => {
      region = (top || 1) !== 1 || (bottom || core.getRows()) !== core.getRows();
      return region && dropLive();
    }),
    parser.registerCsiHandler({ prefix: '?', final: 'r' }, (params) => {
      // A saved DEC mode can switch screens or width inside an otherwise
      // unobserved span. Only explicit enter/leave pairs can restore pins.
      if (params.some((p) => p === 3 || p === 47 || p === 1047 || p === 1049)) discardSaved();
      return false;
    }),
    ...['h', 'l'].map((final) =>
      parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        // DECCOLM can resize the inactive normal screen without a host resize event.
        if (params.includes(3)) discardSaved();
        const switchesScreen = params.some((p) => p === 47 || p === 1047 || p === 1049);
        if (switchesScreen && final === 'h' && !core.usingAltScreen() && anchors.size && !saved && !params.includes(3)) {
          saved = { cols: core.getCols(), rows: core.getRows(), history: core.getScrollbackCount(), positions: new Map() };
          returning = false;
          for (const [a, handle] of anchors) {
            const pos = handle?.resolve();
            if (!pos) a.dispose();
            else {
              saved.positions.set(a, pos);
              handle?.dispose();
              anchors.set(a, null);
            }
          }
        }
        if (switchesScreen && final === 'l' && core.usingAltScreen()) returning = true;
        if (params.includes(69) && horizontalMargins !== (final === 'h')) {
          horizontalMargins = final === 'h';
          dropLive();
        }
        return false;
      }),
    ),
  ];
  return {
    resized: discardSaved,
    parsed() {
      if (!saved || core.usingAltScreen()) return;
      if (!returning || saved.cols !== core.getCols() || saved.rows !== core.getRows() || saved.history !== core.getScrollbackCount()) return discardSaved();
      for (const [a, pos] of saved.positions) {
        // The alternate application can leave a scroll region active on the
        // restored normal screen. Our ordinary partial-margin rule still applies.
        if ((region || horizontalMargins) && pos.row >= saved.history) {
          a.dispose();
          continue;
        }
        const handle = core.trackPosition(pos);
        if (handle) anchors.set(a, handle);
        else a.dispose();
      }
      saved = undefined;
    },
    anchor(): KittyRowAnchor | undefined {
      if (region || horizontalMargins || core.usingAltScreen()) return;
      const position = { row: core.getScrollbackCount() + core.getCursor().row, col: 0 };
      let handle = anchors.size < graphicsHandleLimit ? core.trackPosition(position) : null;
      if (!handle) {
        // A long write can prune pins before the next paint releases them.
        for (const a of anchors.keys()) if (a.line < 0) a.dispose();
        if (anchors.size >= graphicsHandleLimit) return;
        handle = core.trackPosition(position);
      }
      if (!handle) return;
      const anchor: KittyRowAnchor = {
        get line() {
          return anchors.get(anchor)?.resolve()?.row ?? -1;
        },
        get isDisposed() {
          return !anchors.has(anchor);
        },
        dispose() {
          saved?.positions.delete(anchor);
          anchors.get(anchor)?.dispose();
          anchors.delete(anchor);
        },
      };
      anchors.set(anchor, handle);
      return anchor;
    },
    reset() {
      region = horizontalMargins = false;
      saved = undefined;
      for (const a of anchors.keys()) a.dispose();
    },
    dispose() {
      this.reset();
      for (const hook of hooks) hook.dispose();
    },
  };
}
