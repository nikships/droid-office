import type { GhosttyCore } from '@wterm/ghostty';
import { decodePlaceholderCell, KITTY_PLACEHOLDER_CHAR, type DecodedPlaceholder } from '../../shared/kitty';
import type { VtScanner } from '../../shared/vt-scanner';
import type { KittyRowAnchor } from '../term-kitty-overlay';

const placeholder = KITTY_PLACEHOLDER_CHAR.codePointAt(0);

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
  const anchors = new Set<KittyRowAnchor>();
  let region = false;
  let horizontalMargins = false;
  const dropLive = (start = 0) => {
    const first = core.getScrollbackCount() + start;
    for (const a of anchors) if (a.line < 0 || a.line >= first) a.dispose();
    return false;
  };
  const hooks = [
    ...['L', 'M'].map((final) => parser.registerCsiHandler({ final }, () => dropLive(core.getCursor().row))),
    ...['S', 'T'].map((final) => parser.registerCsiHandler({ final }, () => dropLive())),
    parser.registerEscHandler({ final: 'M' }, () => core.getCursor().row === 0 && dropLive()),
    ...['', '?'].map((prefix) =>
      parser.registerCsiHandler({ prefix, final: 'J' }, ([mode]) => {
        if (anchors.size) {
          const history = core.getScrollbackCount();
          const cursor = core.getCursor().row;
          for (const a of anchors) {
            const row = a.line - history;
            if (row >= 0 && (mode === 2 || (mode === 0 && row > cursor) || (mode === 1 && row < cursor))) a.dispose();
          }
        }
        return false;
      }),
    ),
    parser.registerCsiHandler({ final: 'r' }, ([top, bottom]) => {
      region = (top || 1) !== 1 || (bottom || core.getRows()) !== core.getRows();
      return region && dropLive();
    }),
    ...['h', 'l'].map((final) =>
      parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        if (params.includes(69)) {
          horizontalMargins = final === 'h';
          dropLive();
        }
        return false;
      }),
    ),
  ];
  return {
    anchor(): KittyRowAnchor | undefined {
      if (region || horizontalMargins || core.usingAltScreen()) return;
      const position = { row: core.getScrollbackCount() + core.getCursor().row, col: 0 };
      let handle = core.trackPosition(position);
      if (!handle) {
        // A long write can prune pins before the next paint releases them.
        for (const a of anchors) if (a.line < 0) a.dispose();
        handle = core.trackPosition(position);
      }
      if (!handle) return;
      const anchor: KittyRowAnchor = {
        get line() {
          return handle.resolve()?.row ?? -1;
        },
        get isDisposed() {
          return !anchors.has(anchor);
        },
        dispose() {
          handle.dispose();
          anchors.delete(anchor);
        },
      };
      anchors.add(anchor);
      return anchor;
    },
    reset() {
      region = horizontalMargins = false;
      for (const a of anchors) a.dispose();
    },
    dispose() {
      this.reset();
      for (const hook of hooks) hook.dispose();
    },
  };
}
