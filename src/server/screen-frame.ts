import type headless from '@xterm/headless';
import { FLAG_BOLD, FLAG_DIM, FLAG_INVERSE, RGB_FLAG, type Run, screenHistoryRows } from '../shared/protocol.js';

// Runs in the server only: the PTY host never paints a laptop, so changing this needs no PTY_PROTOCOL bump.

type HeadlessTerminal = InstanceType<typeof headless.Terminal>;
type BufferLine = NonNullable<ReturnType<HeadlessTerminal['buffer']['active']['getLine']>>;
type BufferCell = ReturnType<HeadlessTerminal['buffer']['active']['getNullCell']>;

/** What a laptop or monitor is sent of a terminal: rows by index, and `above` when it changed (see screenHistoryRows). */
export interface ScreenFrame {
  cols: number;
  rows: number;
  lines: Record<number, Run[]>;
  full: boolean;
  cursor: [number, number];
  above?: Run[][];
}

function rowRuns(line: BufferLine | undefined, cols: number, cell: BufferCell): Run[] {
  const runs: Run[] = [];
  if (line) {
    let cur: Run | null = null;
    for (let x = 0; x < cols; x++) {
      line.getCell(x, cell);
      const width = cell.getWidth();
      if (width === 0) continue;
      const ch = cell.getChars() || ' ';
      const fg = cell.isFgDefault() ? -1 : cell.isFgRGB() ? RGB_FLAG | cell.getFgColor() : cell.getFgColor();
      const bg = cell.isBgDefault() ? -1 : cell.isBgRGB() ? RGB_FLAG | cell.getBgColor() : cell.getBgColor();
      const flags = (cell.isBold() ? FLAG_BOLD : 0) | (cell.isInverse() ? FLAG_INVERSE : 0) | (cell.isDim() ? FLAG_DIM : 0);
      if (cur && cur[1] === fg && cur[2] === bg && cur[3] === flags) cur[0] += ch;
      else {
        cur = [ch, fg, bg, flags];
        runs.push(cur);
      }
    }
  }
  // Trim trailing default-styled whitespace to keep frames small.
  while (runs.length) {
    const r = runs[runs.length - 1];
    if (r[2] !== -1 || r[3] & FLAG_INVERSE) break;
    const trimmed = r[0].replace(/\s+$/, '');
    if (trimmed) {
      r[0] = trimmed;
      break;
    }
    runs.pop();
  }
  return runs;
}

/**
 * The rows of `term` that changed since `last`, for a laptop or monitor. `last` is updated in place:
 * one key per row, then one for the scrollback rows above the screen. An empty `last` gets a full frame.
 */
export function snapshotScreen(term: HeadlessTerminal, last: string[]): ScreenFrame | null {
  const buf = term.buffer.active;
  const cols = term.cols;
  const rows = term.rows;
  const full = last.length !== rows + 1;
  const lines: Record<number, Run[]> = {};
  let changed = false;
  const cell = buf.getNullCell();
  for (let y = 0; y < rows; y++) {
    const runs = rowRuns(buf.getLine(buf.viewportY + y), cols, cell);
    const key = JSON.stringify(runs);
    if (full || last[y] !== key) {
      lines[y] = runs;
      last[y] = key;
      changed = true;
    }
  }
  const above: Run[][] = [];
  for (let y = buf.viewportY - Math.min(buf.viewportY, screenHistoryRows(cols, rows)); y < buf.viewportY; y++) above.push(rowRuns(buf.getLine(y), cols, cell));
  const aboveKey = JSON.stringify(above);
  const aboveChanged = full || last[rows] !== aboveKey;
  last[rows] = aboveKey;
  last.length = rows + 1;
  if (!changed && !aboveChanged) return null;
  return { cols, rows, lines, full, cursor: [buf.cursorX, buf.cursorY], ...(aboveChanged ? { above } : {}) };
}
