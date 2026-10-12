import type headless from '@xterm/headless';
import type serialize from '@xterm/addon-serialize';
import { FLAG_BOLD, FLAG_DIM, FLAG_INVERSE, RGB_FLAG, type Run } from '../shared/protocol.js';
import { SCROLLBACK } from './ptys.js';

type HeadlessTerminal = InstanceType<typeof headless.Terminal>;

/** The DECSET modes xterm.js reads as a mouse report encoding: SGR and SGR pixels. */
const MOUSE_ENCODINGS = [1006, 1016];

/**
 * A snapshot of `term` that a fresh terminal replays into the same screen, mouse included.
 *
 * The serialize addon puts mouse tracking back but not its encoding, so a browser attaching to
 * a full-screen program using tracking plus SGR (1006) got the wheel in the default encoding, which
 * the office doesn't forward and it doesn't read: scrolling and clicking did nothing. So the encoding
 * is followed here, the way xterm.js sets and resets it, and appended to every snapshot.
 */
export function screenSnapshot(term: InstanceType<typeof headless.Terminal>, ser: InstanceType<typeof serialize.SerializeAddon>): () => string {
  let encoding: number | undefined;
  const decset = (on: boolean) => (params: (number | number[])[]) => {
    for (const p of params) {
      if (typeof p === 'number' && MOUSE_ENCODINGS.includes(p)) encoding = on ? p : undefined;
    }
    return false; // xterm.js still switches the mode itself
  };
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, decset(true));
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, decset(false));
  term.parser.registerEscHandler({ final: 'c' }, () => {
    encoding = undefined; // a full reset (RIS)
    return false;
  });
  return () => ser.serialize({ scrollback: SCROLLBACK }) + (encoding ? `\x1b[?${encoding}h` : '');
}

/** The rows of `term` that changed since `last`, for a laptop or monitor. `last` is updated in place. */
export function snapshotScreen(term: HeadlessTerminal, last: string[]) {
  const buf = term.buffer.active;
  const cols = term.cols;
  const rows = term.rows;
  const full = last.length !== rows;
  const lines: Record<number, Run[]> = {};
  let changed = false;
  const cell = buf.getNullCell();
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
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
    const key = JSON.stringify(runs);
    if (full || last[y] !== key) {
      lines[y] = runs;
      last[y] = key;
      changed = true;
    }
  }
  last.length = rows;
  if (!changed) return null;
  return { cols, rows, lines, full, cursor: [buf.cursorX, buf.cursorY] as [number, number] };
}
