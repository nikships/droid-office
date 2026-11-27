import type { GhosttyCore } from '@wterm/ghostty';

export interface Point {
  x: number;
  y: number;
}

/** Adapt retained rows (oldest first) to the core's reverse-indexed history and live screen. */
export function retainedRows(core: GhosttyCore) {
  const history = core.getScrollbackCount();
  const cols = core.getCols();
  const length = history + core.getRows();
  const meta = (row: number) => (row < history ? core.getScrollbackRowMetadata(history - 1 - row) : core.getRowMetadata(row - history));
  const cell = (row: number, col: number) => (row < history ? core.getScrollbackCell(history - 1 - row, col) : core.getCell(row - history, col));
  function rowText(row: number, trim: boolean, cells?: Point[], search = false) {
    const count = row < history ? core.getScrollbackLineLen(history - 1 - row) : cols;
    let text = '';
    for (let col = 0; col < count; col++) {
      const c = cell(row, col);
      // xterm's search buffer includes the blank right-margin cell left by an
      // early-wrapped wide character. It is not part of a link or tracked text.
      if (c.spacerHead && search) text += ' ';
      if (c.width === 0 || c.spacerHead) continue;
      const chars = c.chars ?? String.fromCodePoint(c.char || 32);
      text += chars;
      if (cells) for (let i = 0; i < chars.length; i++) cells.push({ x: col + 1, y: row + 1 });
    }
    return trim ? text.trimEnd() : text;
  }
  function logical(row: number, links = false) {
    let start = row,
      end = row;
    // Never parse a fragment when the oldest part was pruned or the line exceeds a
    // pointer-event work budget. Search has no cutoff and doesn't build a cell map.
    const limit = links ? Math.max(1, Math.floor(16384 / cols)) : Infinity;
    while (start > 0 && row - start < limit && meta(start)?.continuesPrevious) start--;
    while (end + 1 < length && end - start < limit && meta(end)?.wrapsToNext) end++;
    if (links && (meta(start)?.continuesPrevious || meta(end)?.wrapsToNext || end - start >= limit)) return;
    let text = '';
    const cells: Point[] = [];
    for (let y = start; y <= end; y++) text += rowText(y, y === end, links ? cells : undefined);
    return { text, cells, start, end };
  }
  return {
    cols,
    length,
    cell,
    logical,
    getLine(row: number) {
      if (row < 0 || row >= length) return;
      return { isWrapped: !!meta(row)?.continuesPrevious, translateToString: (trim = false) => rowText(row, trim, undefined, true) };
    },
  };
}
