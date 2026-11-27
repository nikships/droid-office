import type { GhosttyCell, GhosttyTerminal } from 'ghostty-web';
import type { BufferLike } from '../../shared/search';

export interface CellPosition {
  x: number;
  y: number;
}

/** Ghostty's xterm-compatible line drops internal blanks and only returns a grapheme's
 * first codepoint. Read the core's fixed-column rows and consult the grapheme table only
 * for extended cells. Public scrollback cells have no soft-wrap flag. */
export function ghosttyLines(core: GhosttyTerminal) {
  const history = core.getScrollbackLength();
  const length = history + core.rows;
  let screen: ReturnType<GhosttyTerminal['getViewport']> | undefined;
  const wrapped = (y: number) => y >= history && y < length && core.isRowWrapped(y - history);
  function read(y: number, positions?: CellPosition[]) {
    let line: GhosttyCell[] | null;
    let offset = 0;
    if (y < history) line = core.getScrollbackLine(y);
    else {
      if (!screen) {
        core.update();
        screen = core.getViewport();
      }
      line = screen;
      offset = (y - history) * core.cols;
    }
    let text = '';
    for (let x = 0; line && x < core.cols && offset + x < line.length; x++) {
      const cell = line[offset + x];
      if (!cell.width) continue;
      const chars = cell.grapheme_len ? (y < history ? core.getScrollbackGraphemeString(y, x) : core.getGraphemeString(y - history, x)) : String.fromCodePoint(cell.codepoint || 32);
      text += chars;
      if (positions) for (let i = 0; i < chars.length; i++) positions.push({ x: x + 1, y: y + 1 });
    }
    return text;
  }
  const buffer: BufferLike = {
    length,
    getLine: (y) => (y >= 0 && y < length ? { isWrapped: wrapped(y), translateToString: (trim) => (trim ? read(y).trimEnd() : read(y)) } : undefined),
  };
  function logical(row: number) {
    let first = row - 1;
    while (first > 0 && row - first < 16 && wrapped(first)) first--;
    const cells: CellPosition[] = [];
    let text = '';
    for (let y = first; y < length && y < first + 16; y++) {
      text += read(y, cells);
      if (!wrapped(y + 1)) break;
    }
    text = text.trimEnd();
    cells.length = text.length;
    return { text, cells };
  }
  return { buffer, logical, wrapped };
}
