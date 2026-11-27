import type { TERM_THEME } from '../term-theme';

export interface ClientTerminalOptions {
  cursorBlink?: boolean;
  cursorStyle?: 'block' | 'underline' | 'bar';
  disableStdin?: boolean;
  fontFamily?: string;
  fontSize?: number;
  theme?: Partial<typeof TERM_THEME> & { cursorAccent?: string };
  scrollback?: number;
  lineHeight?: number;
  scrollSensitivity?: number;
  macOptionIsMeta?: boolean;
  minimumContrastRatio?: number;
}

/** A line to scroll to once the terminal has loaded: a search hit (see search.ts). */
export interface TerminalFind {
  /** What was searched for, as a searchKey. */
  needle: string;
  /** How many rows from the bottom of the worker's terminal the line was. */
  fromEnd: number;
}
