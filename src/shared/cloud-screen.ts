import { resultsByCall, toolLine, type FactoryBlock, type FactoryMessage } from './factory-sessions.js';
import { FLAG_BOLD, FLAG_DIM, RGB_FLAG, type Run } from './protocol.js';

// A cloud worker's laptop screen. Its session runs on a Factory computer, so there is no PTY here
// to paint: the newest messages of its transcript are laid out the way the Droid CLI shows them
// (the prompt, its replies, each tool call with the first lines of its result) on a terminal-sized
// grid, and sent as the same `screen` frame a local worker's PTY sends.

export const CLOUD_SCREEN_COLS = 80;
export const CLOUD_SCREEN_ROWS = 30;
/** Lines of a tool's result shown under its call. */
const RESULT_LINES = 3;
/** Lines of a reply shown, from its end. */
const REPLY_LINES = 12;

const DEFAULT = -1;
const RED = 1;
const GREEN = 2;
const GREY = 8;
const ORANGE = RGB_FLAG | 0xee6018;

export interface CloudScreenFrame {
  cols: number;
  rows: number;
  lines: Record<number, Run[]>;
  cursor: [number, number];
}

type ToolResult = Extract<FactoryBlock, { type: 'tool_result' }>;

// ANSI escapes and other control characters from tool output would land on the grid as junk.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;
const clean = (s: string) => s.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(CONTROL, '');

/** `text` cut into lines of at most `width` characters, breaking at spaces where it can. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of clean(text).split('\n')) {
    let rest = [...raw.trimEnd()];
    if (!rest.length) {
      out.push('');
      continue;
    }
    while (rest.length > width) {
      let cut = rest.lastIndexOf(' ', width);
      if (cut <= 0) cut = width;
      out.push(rest.slice(0, cut).join('').trimEnd());
      rest = rest.slice(rest[cut] === ' ' ? cut + 1 : cut);
    }
    out.push(rest.join(''));
  }
  return out;
}

const clip = (s: string, width: number) => {
  const c = [...s];
  return c.length > width ? `${c.slice(0, width - 1).join('')}…` : s;
};

/** Markdown marks that read as noise in a terminal: bold and code spans, heading hashes. */
const plain = (s: string) =>
  s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '');

class Grid {
  lines: Run[][] = [];
  constructor(readonly cols: number) {}

  blank() {
    if (this.lines.length && this.lines.at(-1)!.length) this.lines.push([]);
  }

  /** One line: runs of [text, color, flags]. */
  line(...parts: [string, number, number][]) {
    const runs: Run[] = [];
    let left = this.cols;
    for (const [text, fg, flags] of parts) {
      if (left <= 0) break;
      const t = clip(text, left);
      if (!t) continue;
      runs.push([t, fg, DEFAULT, flags]);
      left -= [...t].length;
    }
    this.lines.push(runs);
  }

  /** Text wrapped under a marker, the lines after the first indented to line up with it. */
  block(marker: string, markerFg: number, text: string, fg: number, flags: number, max = Infinity) {
    const pad = ' '.repeat([...marker].length);
    let rows = wrap(text, this.cols - pad.length);
    while (rows.length && !rows.at(-1)!.trim()) rows.pop();
    if (!rows.length) return;
    if (rows.length > max) rows = ['…', ...rows.slice(-max + 1)];
    rows.forEach((r, i) => this.line([i ? pad : marker, markerFg, 0], [r, fg, flags]));
  }
}

/** `running`: it has no result and nothing came after it, so it's still going. */
function toolCall(g: Grid, b: Extract<FactoryBlock, { type: 'tool_use' }>, r: ToolResult | undefined, running: boolean) {
  const line = toolLine(b.name, b.input, g.cols * 2);
  const colon = line.indexOf(': ');
  const name = colon < 0 ? line : line.slice(0, colon);
  const arg = colon < 0 ? '' : line.slice(colon + 2);
  g.blank();
  g.line(['● ', r?.isError ? RED : r ? GREEN : running ? ORANGE : GREY, 0], [name, DEFAULT, FLAG_BOLD], [arg ? ` ${arg}` : '', DEFAULT, 0]);
  if (!r) return running ? g.line(['  ⎿  ', GREY, 0], ['Running…', GREY, 0]) : undefined;
  const text = r.text.trim() || (r.images ? `${r.images} picture${r.images === 1 ? '' : 's'}` : '(no output)');
  const rows = clean(text)
    .split('\n')
    .filter((x) => x.trim());
  rows.slice(0, RESULT_LINES).forEach((x, i) => g.line([i ? '     ' : '  ⎿  ', GREY, 0], [x, r.isError ? RED : GREY, r.isError ? 0 : FLAG_DIM]));
  if (rows.length > RESULT_LINES) g.line(['     ', GREY, 0], [`… +${rows.length - RESULT_LINES} lines`, GREY, FLAG_DIM]);
}

/**
 * The screen for a transcript (oldest first): the newest `rows` lines of it, laid out on a
 * `cols`-wide grid. Undefined while it has nothing to show.
 */
export function cloudScreen(messages: readonly FactoryMessage[], cols = CLOUD_SCREEN_COLS, rows = CLOUD_SCREEN_ROWS): CloudScreenFrame | undefined {
  const g = new Grid(cols);
  const results = resultsByCall(messages);
  // A call with no result that isn't in the newest message ended without one listed (interrupted, say).
  const newest = messages.at(-1);
  for (const m of messages) {
    for (const b of m.blocks) {
      if (m.role === 'user') {
        if (b.type === 'text') {
          g.blank();
          g.block('> ', GREY, b.text, DEFAULT, FLAG_BOLD, REPLY_LINES);
        } else if (b.type === 'image') g.line(['> ', GREY, 0], ['[picture]', GREY, 0]);
        else if (b.type === 'document') g.line(['> ', GREY, 0], [`[${b.name}]`, GREY, 0]);
        continue;
      }
      if (b.type === 'tool_use') toolCall(g, b, results.get(b.id), m === newest);
      else if (b.type === 'thinking') {
        g.blank();
        g.line(['✻ ', GREY, 0], [wrap(b.text, cols - 2).find((x) => x.trim()) ?? 'Thinking…', GREY, FLAG_DIM]);
      } else if (b.type === 'text') {
        g.blank();
        if (m.role === 'tool') g.block('  ', GREY, b.text, GREY, FLAG_DIM, RESULT_LINES);
        else g.block('⛬ ', m.isError ? RED : DEFAULT, plain(b.text), m.isError ? RED : DEFAULT, 0, REPLY_LINES);
      } else if (b.type === 'image' && m.role !== 'tool') g.line(['  ', GREY, 0], ['[picture]', GREY, 0]);
    }
  }
  const all = g.lines;
  while (all.length && !all.at(-1)!.length) all.pop();
  if (!all.length) return undefined;
  const shown = all.slice(-rows);
  const lines: Record<number, Run[]> = {};
  for (let y = 0; y < rows; y++) lines[y] = shown[y] ?? [];
  return { cols, rows, lines, cursor: [0, Math.min(rows - 1, shown.length)] };
}
