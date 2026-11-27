// A worker's live screen in a few lines of text, for the web companion's overview: the same
// `screen` frames the laptops draw, read as text with the terminal's colors. No DOM at import time.

import { DECORATIONS, FLAG_BOLD, FLAG_DIM, FLAG_INVERSE, FLAG_INVISIBLE, FLAG_ITALIC, FLAG_OVERLINE, FLAG_STRIKE, FLAG_UNDERLINE, RGB_FLAG, type Run } from '../shared/protocol';
import { TERM_THEME } from './term-theme';

const BASE16 = [
  TERM_THEME.black,
  TERM_THEME.red,
  TERM_THEME.green,
  TERM_THEME.yellow,
  TERM_THEME.blue,
  TERM_THEME.magenta,
  TERM_THEME.cyan,
  TERM_THEME.white,
  TERM_THEME.brightBlack,
  TERM_THEME.brightRed,
  TERM_THEME.brightGreen,
  TERM_THEME.brightYellow,
  TERM_THEME.brightBlue,
  TERM_THEME.brightMagenta,
  TERM_THEME.brightCyan,
  TERM_THEME.brightWhite,
];
const CUBE = [0, 95, 135, 175, 215, 255];
const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** A run's color as CSS: undefined for the terminal's default, else the theme's 16, xterm's 256 or a 24-bit color. */
export function runColor(c: number): string | undefined {
  if (!Number.isInteger(c) || c < 0) return undefined;
  if (c >= RGB_FLAG) return `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
  if (c < 16) return BASE16[c];
  if (c < 232) {
    const i = c - 16;
    return hex(CUBE[Math.floor(i / 36)], CUBE[Math.floor(i / 6) % 6], CUBE[i % 6]);
  }
  if (c < 256) {
    const v = 8 + (c - 232) * 10;
    return hex(v, v, v);
  }
  return undefined;
}

export interface PreviewRun {
  text: string;
  color?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  decoration?: string;
  cols?: number;
}

const blank = (row: Run[] | undefined) => !row?.some(([text, , bg, flags]) => text.trim() || bg !== -1 || flags & (FLAG_INVERSE | DECORATIONS));

/**
 * The bottom `max` rows of a screen that has anything on it, as styled runs: trailing blank rows are
 * dropped so a short session isn't a black box, and a row keeps its leading spaces so columns line up.
 */
export function previewRows(lines: readonly (Run[] | undefined)[], rows: number, max: number): PreviewRun[][] {
  let end = Math.min(rows, lines.length);
  while (end > 0 && blank(lines[end - 1])) end--;
  const start = Math.max(0, end - max);
  const out: PreviewRun[][] = [];
  for (let i = start; i < end; i++) {
    out.push(
      (lines[i] ?? []).flatMap(([text, fg, bg, flags, cols, stride]) => {
        const inverse = (flags & FLAG_INVERSE) !== 0;
        const color = runColor(inverse ? bg : fg) ?? (inverse ? TERM_THEME.background : undefined);
        const background = runColor(inverse ? fg : bg) ?? (inverse ? TERM_THEME.foreground : undefined);
        const run: PreviewRun = { text: flags & FLAG_INVISIBLE ? ' '.repeat(cols ?? [...text].length) : text };
        if (cols !== undefined) run.cols = cols;
        if (color) run.color = color;
        if (background) run.background = background;
        if (flags & FLAG_BOLD) run.bold = true;
        if (flags & FLAG_DIM) run.dim = true;
        if (flags & FLAG_ITALIC) run.italic = true;
        if (!(flags & FLAG_INVISIBLE) && flags & DECORATIONS) run.decoration = [flags & FLAG_UNDERLINE && 'underline', flags & FLAG_STRIKE && 'line-through', flags & FLAG_OVERLINE && 'overline'].filter(Boolean).join(' ');
        if (stride !== undefined && !(flags & FLAG_INVISIBLE)) return Array.from(text, (glyph) => ({ ...run, text: glyph, cols: stride }));
        return run;
      }),
    );
  }
  return out;
}
