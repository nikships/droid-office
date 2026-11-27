// How worker terminals and the office shell draw, scroll and read the keyboard. Saved in this
// browser and applied live to every open terminal. Text size keeps its own key (term-font.ts),
// which the A− / A+ buttons share.

import type { WTermAdapter } from '../term-engine/wterm';
import type { ClientTerminalOptions } from '../term-engine/types';
import { savedPrefs, type PrefOptions } from './saved-prefs';

export const TERM_LINE_HEIGHTS = ['compact', 'default', 'relaxed'] as const;
export const TERM_CURSOR_STYLES = ['block', 'bar', 'underline'] as const;
export const TERM_SCROLL_SPEEDS = ['slow', 'default', 'fast'] as const;

export interface TerminalPrefs {
  lineHeight: (typeof TERM_LINE_HEIGHTS)[number];
  cursorStyle: (typeof TERM_CURSOR_STYLES)[number];
  cursorBlink: boolean;
  scrollSpeed: (typeof TERM_SCROLL_SPEEDS)[number];
  /** Option (Alt) sends Meta to the program, as Droid's word jumps want, instead of typing the character it makes. */
  optionIsMeta: boolean;
}

export const TERMINAL_DEFAULTS: Readonly<TerminalPrefs> = Object.freeze({ lineHeight: 'default', cursorStyle: 'block', cursorBlink: true, scrollSpeed: 'default', optionIsMeta: true });

const BOTH = [true, false] as const;
const OPTIONS: PrefOptions<TerminalPrefs> = {
  lineHeight: TERM_LINE_HEIGHTS,
  cursorStyle: TERM_CURSOR_STYLES,
  cursorBlink: BOTH,
  scrollSpeed: TERM_SCROLL_SPEEDS,
  optionIsMeta: BOTH,
};

const prefs = savedPrefs('droid-office.terminal', TERMINAL_DEFAULTS, OPTIONS);

export const normalizeTerminalPrefs = prefs.normalize;
export const isDefaultTerminalPrefs = prefs.isDefault;
export const terminalPrefs = prefs.get;
export const setTerminalPrefs = prefs.set;
export const resetTerminalPrefs = prefs.reset;
export const onTerminalPrefs = prefs.on;

const LINE_HEIGHT: Record<TerminalPrefs['lineHeight'], number> = { compact: 1, default: 1.1, relaxed: 1.25 };
const SCROLL_SPEED: Record<TerminalPrefs['scrollSpeed'], number> = { slow: 0.5, default: 1, fast: 2 };
/** Long enough to follow by eye, short enough that a held key never lags behind. */
export const SMOOTH_SCROLL_MS = 125;

export type TerminalPrefOptions = Required<Pick<ClientTerminalOptions, 'lineHeight' | 'cursorStyle' | 'cursorBlink' | 'smoothScrollDuration' | 'scrollSensitivity' | 'macOptionIsMeta'>>;

/** The concrete terminal settings for these preferences. */
export function terminalOptions(p: TerminalPrefs = terminalPrefs()): TerminalPrefOptions {
  return {
    lineHeight: LINE_HEIGHT[p.lineHeight],
    cursorStyle: p.cursorStyle,
    cursorBlink: p.cursorBlink,
    smoothScrollDuration: SMOOTH_SCROLL_MS,
    scrollSensitivity: SCROLL_SPEED[p.scrollSpeed],
    macOptionIsMeta: p.optionIsMeta,
  };
}

/**
 * Keeps `term` on the saved choices until the returned unlisten. `fixed` options win over the
 * choices (a read-only log never blinks); `resized` runs when its cells change height.
 */
export function followTerminalPrefs(term: Pick<WTermAdapter, 'options'>, opts: { fixed?: Partial<TerminalPrefOptions>; resized?: () => void } = {}): () => void {
  return onTerminalPrefs((next) => {
    const before = term.options.lineHeight;
    Object.assign(term.options, terminalOptions(next), opts.fixed);
    if (term.options.lineHeight !== before) opts.resized?.();
  });
}

/** Snap a snapshot or search jump immediately, then restore the user's scroll settings. */
export function scrollAtOnce(term: Pick<WTermAdapter, 'options'>, scroll: () => void, snap?: () => void) {
  const glide = term.options.smoothScrollDuration ?? 0;
  if (!glide) return scroll();
  term.options.smoothScrollDuration = 0;
  try {
    scroll();
  } finally {
    term.options.smoothScrollDuration = glide;
    snap?.();
  }
}
