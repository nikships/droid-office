import type headless from '@xterm/headless';
import { cellUnderlineId, decodePlaceholderCell, isKittyPlaceholderCell, kittyImageSignature, type DecodedPlaceholder } from '../shared/kitty.js';
import { FLAG_BOLD, FLAG_DIM, FLAG_INVERSE, RGB_FLAG, screenHistoryRows, type Run, type ScreenImage, type ScreenPlacement } from '../shared/protocol.js';
import { getTerminalKitty, SERVER_CELL_PX_H, SERVER_CELL_PX_W } from './screen.js';

// Runs in the server only: the PTY host never paints a laptop, so changing this needs no PTY_PROTOCOL bump.

type HeadlessTerminal = InstanceType<typeof headless.Terminal>;
type BufferLine = NonNullable<ReturnType<HeadlessTerminal['buffer']['active']['getLine']>>;
type BufferCell = ReturnType<HeadlessTerminal['buffer']['active']['getNullCell']>;

/** What a laptop or monitor is sent of a terminal: rows by index, `above` when it changed, and visible Kitty images. */
export interface ScreenFrame {
  cols: number;
  rows: number;
  lines: Record<number, Run[]>;
  full: boolean;
  cursor: [number, number];
  above?: Run[][];
  placements?: ScreenPlacement[];
  images?: Record<number, ScreenImage>;
}

interface RowSpan {
  id: number;
  placementId: number;
  x: number;
  cols: number;
  srcCol: number;
  srcRow: number;
}

interface RawCell {
  x: number;
  width: number;
  ch: string;
  fg: number;
  bg: number;
  flags: number;
  phBg?: number;
}

const EMPTY_SPANS: readonly RowSpan[] = [];

function trimRuns(runs: Run[]) {
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
}

function extractKittyRow(line: BufferLine, cols: number, cell: BufferCell): { runs: Run[]; spans: readonly RowSpan[] } {
  const runs: Run[] = [];
  const spans: RowSpan[] = [];
  const cells: RawCell[] = [];
  let prevPh: DecodedPlaceholder | undefined;
  let curSpan: RowSpan | null = null;
  for (let x = 0; x < cols; x++) {
    line.getCell(x, cell);
    const width = cell.getWidth();
    if (width === 0) continue;
    const raw = cell.getChars() || ' ';
    let ch = raw;
    let fg = cell.isFgDefault() ? -1 : cell.isFgRGB() ? RGB_FLAG | cell.getFgColor() : cell.getFgColor();
    let bg = cell.isBgDefault() ? -1 : cell.isBgRGB() ? RGB_FLAG | cell.getBgColor() : cell.getBgColor();
    let flags = (cell.isBold() ? FLAG_BOLD : 0) | (cell.isInverse() ? FLAG_INVERSE : 0) | (cell.isDim() ? FLAG_DIM : 0);
    let phBg: number | undefined;

    if (isKittyPlaceholderCell(raw)) {
      const fgLow24 = cell.isFgDefault() ? 0 : cell.getFgColor();
      const ph = decodePlaceholderCell(raw, fgLow24, cellUnderlineId(cell), prevPh);
      prevPh = ph;
      if (bg !== -1 && !(flags & FLAG_INVERSE)) phBg = bg;
      ch = ' ';
      fg = -1;
      bg = -1;
      flags &= ~FLAG_INVERSE;
      if (ph) {
        if (curSpan && curSpan.id === ph.imageId && curSpan.placementId === ph.placementId && curSpan.srcRow === ph.row && curSpan.x + curSpan.cols === x && curSpan.srcCol + curSpan.cols === ph.col) {
          curSpan.cols++;
        } else {
          curSpan = { id: ph.imageId, placementId: ph.placementId, x, cols: 1, srcCol: ph.col, srcRow: ph.row };
          spans.push(curSpan);
        }
      } else {
        curSpan = null;
      }
    } else {
      prevPh = undefined;
      curSpan = null;
    }

    cells.push({ x, width, ch, fg, bg, flags, phBg });
  }

  // Drop container background fill from empty space around inline images so it blends into OLED black,
  // while keeping distinct accent bars (such as a 1-col prompt border) and real text backgrounds.
  if (spans.length) {
    let imgStart = Infinity;
    for (let i = 0; i < spans.length; i++) imgStart = Math.min(imgStart, spans[i].x);
    let lastVisibleCol = 0;
    for (const c of cells) {
      if (c.ch.trim() || c.flags & FLAG_INVERSE) lastVisibleCol = c.x + c.width;
    }
    const blankFrom = Math.max(imgStart, lastVisibleCol);
    for (let i = 0; i < cells.length; i++) {
      const phBg = cells[i].phBg;
      if (phBg === undefined) continue;
      for (let j = i - 1; j >= 0; j--) {
        const left = cells[j];
        if (left.ch.trim() || left.flags & FLAG_INVERSE || left.bg !== phBg) break;
        left.bg = -1;
      }
    }
    for (const c of cells) {
      if (c.x >= blankFrom && !c.ch.trim() && !(c.flags & FLAG_INVERSE)) c.bg = -1;
    }
  }

  let cur: Run | null = null;
  for (const { ch, fg, bg, flags } of cells) {
    if (cur && cur[1] === fg && cur[2] === bg && cur[3] === flags) cur[0] += ch;
    else {
      cur = [ch, fg, bg, flags];
      runs.push(cur);
    }
  }
  trimRuns(runs);
  return { runs, spans };
}

function extractRow(line: BufferLine | undefined, cols: number, cell: BufferCell): { runs: Run[]; spans: readonly RowSpan[] } {
  if (!line) return { runs: [], spans: EMPTY_SPANS };
  const runs: Run[] = [];
  let curText = '';
  let curFg = -2;
  let curBg = -2;
  let curFlags = -1;
  for (let x = 0; x < cols; x++) {
    line.getCell(x, cell);
    const width = cell.getWidth();
    if (width === 0) continue;
    const raw = cell.getChars() || ' ';
    if (isKittyPlaceholderCell(raw)) {
      return extractKittyRow(line, cols, cell);
    }
    const fg = cell.isFgDefault() ? -1 : cell.isFgRGB() ? RGB_FLAG | cell.getFgColor() : cell.getFgColor();
    const bg = cell.isBgDefault() ? -1 : cell.isBgRGB() ? RGB_FLAG | cell.getBgColor() : cell.getBgColor();
    const flags = (cell.isBold() ? FLAG_BOLD : 0) | (cell.isInverse() ? FLAG_INVERSE : 0) | (cell.isDim() ? FLAG_DIM : 0);
    if (fg === curFg && bg === curBg && flags === curFlags) {
      curText += raw;
    } else {
      if (curFlags >= 0) runs.push([curText, curFg, curBg, curFlags]);
      curText = raw;
      curFg = fg;
      curBg = bg;
      curFlags = flags;
    }
  }
  if (curFlags >= 0) runs.push([curText, curFg, curBg, curFlags]);
  trimRuns(runs);
  return { runs, spans: EMPTY_SPANS };
}

interface MergedSpan extends RowSpan {
  y: number;
  rows: number;
}

/** Tracks which image payloads have already been delivered for a caller's diff state `last`. */
const deliveredImages = new WeakMap<string[], Map<number, string>>();

/**
 * The rows of `term` that changed since `last`, for a laptop or monitor. `last` is updated in place:
 * one key per row, one for `above`, and one for image placements. An empty `last` gets a full frame.
 */
export function snapshotScreen(term: HeadlessTerminal, last: string[]): ScreenFrame | null {
  const buf = term.buffer.active;
  const cols = term.cols;
  const rows = term.rows;
  const full = last.length !== rows + 2;
  const lines: Record<number, Run[]> = {};
  let changed = false;
  const cell = buf.getNullCell();

  const aboveStart = buf.viewportY - Math.min(buf.viewportY, screenHistoryRows(cols, rows));
  const aboveCount = buf.viewportY - aboveStart;
  const above: Run[][] = [];
  const merged: MergedSpan[] = [];
  const activeByKey = new Map<string, MergedSpan>();

  const pushRowSpans = (yRel: number, spans: readonly RowSpan[]) => {
    if (!spans.length) {
      if (activeByKey.size) activeByKey.clear();
      return;
    }
    const nextActive = new Map<string, MergedSpan>();
    for (const s of spans) {
      const k = `${s.id}:${s.placementId}:${s.x}:${s.cols}:${s.srcCol}`;
      const prev = activeByKey.get(k);
      if (prev && prev.y + prev.rows === yRel && prev.srcRow + prev.rows === s.srcRow) {
        prev.rows++;
        nextActive.set(k, prev);
      } else {
        const m: MergedSpan = { ...s, y: yRel, rows: 1 };
        merged.push(m);
        nextActive.set(k, m);
      }
    }
    activeByKey.clear();
    for (const [k, v] of nextActive) activeByKey.set(k, v);
  };

  for (let i = 0; i < aboveCount; i++) {
    const { runs, spans } = extractRow(buf.getLine(aboveStart + i), cols, cell);
    above.push(runs);
    pushRowSpans(i - aboveCount, spans);
  }

  for (let y = 0; y < rows; y++) {
    const { runs, spans } = extractRow(buf.getLine(buf.viewportY + y), cols, cell);
    pushRowSpans(y, spans);
    const key = JSON.stringify(runs);
    if (full || last[y] !== key) {
      lines[y] = runs;
      last[y] = key;
      changed = true;
    }
  }

  const aboveKey = JSON.stringify(above);
  const aboveChanged = full || last[rows] !== aboveKey;
  last[rows] = aboveKey;

  const kitty = getTerminalKitty(term);
  const maxObserved = new Map<number, { cols: number; rows: number }>();
  for (const m of merged) {
    const prev = maxObserved.get(m.id);
    const mc = m.srcCol + m.cols;
    const mr = m.srcRow + m.rows;
    if (!prev) maxObserved.set(m.id, { cols: mc, rows: mr });
    else {
      if (mc > prev.cols) prev.cols = mc;
      if (mr > prev.rows) prev.rows = mr;
    }
  }

  const placements: ScreenPlacement[] = merged.map((m) => {
    const img = kitty?.graphics.get(m.id);
    const obs = maxObserved.get(m.id);
    const totalCols = Math.max(obs?.cols ?? m.cols, img?.cols ?? (img?.width ? Math.ceil(img.width / SERVER_CELL_PX_W) : 0));
    const totalRows = Math.max(obs?.rows ?? m.rows, img?.rows ?? (img?.height ? Math.ceil(img.height / SERVER_CELL_PX_H) : 0));
    return {
      id: m.id,
      x: m.x,
      y: m.y,
      cols: m.cols,
      rows: m.rows,
      srcCol: m.srcCol,
      srcRow: m.srcRow,
      totalCols: Math.max(1, totalCols),
      totalRows: Math.max(1, totalRows),
    };
  });

  // Direct (`U !== 1`) Kitty placements overlapping `[aboveStart, buf.viewportY + rows)`.
  if (kitty?.directPlacements.length && buf.type === 'normal') {
    for (const p of kitty.directPlacements) {
      if (p.marker.isDisposed || p.marker.line < 0) continue;
      const yRel = p.marker.line - buf.viewportY;
      if (yRel + p.rows <= -aboveCount || yRel >= rows) continue;
      const visY0 = Math.max(-aboveCount, yRel);
      const visY1 = Math.min(rows, yRel + p.rows);
      placements.push({
        id: p.imageId,
        x: p.col,
        y: visY0,
        cols: p.cols,
        rows: visY1 - visY0,
        srcCol: 0,
        srcRow: visY0 - yRel,
        totalCols: p.cols,
        totalRows: p.rows,
      });
    }
  }

  const placementsKey = placements.length ? JSON.stringify(placements) : '';
  const prevPlacementsKey = full ? '' : (last[rows + 1] ?? '');
  const placementsChanged = placementsKey !== prevPlacementsKey;
  last[rows + 1] = placementsKey;
  last.length = rows + 2;

  let sent = deliveredImages.get(last);
  if (!sent || full) {
    sent = new Map();
    deliveredImages.set(last, sent);
  }
  const images: Record<number, ScreenImage> = {};
  let imagesChanged = false;
  if (kitty && placements.length) {
    for (const p of placements) {
      const img = kitty.graphics.get(p.id);
      if (!img) continue;
      const sig = kittyImageSignature(img);
      if (sent.get(p.id) === sig) continue;
      sent.set(p.id, sig);
      images[p.id] = {
        format: img.format,
        ...(img.compression ? { compression: img.compression } : {}),
        width: img.width,
        height: img.height,
        ...(img.cols ? { cols: img.cols } : {}),
        ...(img.rows ? { rows: img.rows } : {}),
        data: img.data,
      };
      imagesChanged = true;
    }
  }

  if (!changed && !aboveChanged && !placementsChanged && !imagesChanged) return null;
  return {
    cols,
    rows,
    lines,
    full,
    cursor: [buf.cursorX, buf.cursorY],
    ...(aboveChanged ? { above } : {}),
    ...(placementsChanged || (full && placements.length) ? { placements } : {}),
    ...(imagesChanged ? { images } : {}),
  };
}
