// What the terminal page works out without touching the DOM, so `tests/android-terminal.test.ts`
// can check it in Node.

/** The office's PTY limits (`resize` in src/server/workers.ts). */
const COLS = [20, 400];
const ROWS = [5, 200];

/** At most this many wheel events or arrow keys for one touch event, as Orca does. */
export const MAX_STEPS = 32;

/** xterm's mouse encodings (DECSET 1005, 1006 and 1015); 0 is the original X10 bytes. */
export const UTF8 = 1005;
export const SGR = 1006;
export const URXVT = 1015;

const clamp = (n, [lo, hi]) => Math.min(hi, Math.max(lo, n));

/** The grid that fits `viewW` × `viewH` CSS pixels at one cell's size, within the PTY's limits. */
export function fitGrid(viewW, viewH, cellW, cellH) {
  if (!(viewW > 0 && viewH > 0 && cellW > 0 && cellH > 0)) return null;
  return { cols: clamp(Math.floor(viewW / cellW), COLS), rows: clamp(Math.floor(viewH / cellH), ROWS) };
}

/**
 * How much to scale a `gridW` × `gridH` terminal to show all of it. The desktop view shrinks (or,
 * on a tablet, grows up to `maxScale`) the desktop's grid to the view; the phone view only shrinks,
 * while the PTY catches up with the size it asked for.
 */
export function fitScale(view, viewW, viewH, gridW, gridH, maxScale) {
  if (!(viewW > 0 && viewH > 0 && gridW > 0 && gridH > 0)) return 1;
  const s = Math.min(viewW / gridW, viewH / gridH);
  return view === 'phone' ? Math.min(1, s) : Math.min(maxScale, s);
}

/**
 * The bytes for scrolling a program by `rows` (negative is up, toward older lines), at cell
 * `col`, `row` (1-based): wheel events in the program's mouse encoding when it reports the mouse,
 * otherwise arrow keys, as xterm.js itself does for a wheel over the alternate screen.
 */
export function swipeInput(rows, state, col, row) {
  const n = Math.min(MAX_STEPS, Math.abs(Math.trunc(rows)));
  if (!n) return '';
  const up = rows < 0;
  if (state.mouse === 'none') {
    const key = state.appCursor ? (up ? '\x1bOA' : '\x1bOB') : up ? '\x1b[A' : '\x1b[B';
    return key.repeat(n);
  }
  const button = up ? 64 : 65;
  const x = Math.max(1, col);
  const y = Math.max(1, row);
  let one;
  if (state.encoding === SGR) one = `\x1b[<${button};${x};${y}M`;
  else if (state.encoding === URXVT) one = `\x1b[${button + 32};${x};${y}M`;
  else if (state.encoding === UTF8) one = `\x1b[M${String.fromCharCode(32 + button, 32 + Math.min(x, 2015), 32 + Math.min(y, 2015))}`;
  // X10 bytes stop at column and row 223.
  else one = `\x1b[M${String.fromCharCode(32 + button, 32 + Math.min(x, 223), 32 + Math.min(y, 223))}`;
  return one.repeat(n);
}

/** Turns pixels dragged into whole rows, keeping the remainder for the next move. */
export class RowAccumulator {
  constructor() {
    this.px = 0;
  }

  /** `px` more dragged (positive is toward newer lines) at `rowPx` per row; the whole rows that makes. */
  add(px, rowPx) {
    if (!(rowPx > 0)) return 0;
    this.px += px;
    const rows = Math.trunc(this.px / rowPx);
    this.px -= rows * rowPx;
    return rows;
  }

  reset() {
    this.px = 0;
  }
}
