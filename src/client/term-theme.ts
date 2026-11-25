// The terminal's colors: an OLED-black ground with an orange cursor. The ANSI palette keeps its
// distinct hues — agents paint with it, so only the base, cursor and selection are ours to restyle.
// Kept out of world/laptop so non-3D clients (the dashboard, the terminal window) can use the
// terminal without loading three.js. world/laptop re-exports this as TERM_THEME.

import type { ITheme } from '@xterm/xterm';

export const TERM_THEME = {
  background: '#000000',
  foreground: '#eeeeee',
  cursor: '#ee6018',
  selectionBackground: '#2a2a2a',
  black: '#282a36',
  red: '#ff5c7a',
  green: '#7cf29a',
  yellow: '#ffd166',
  blue: '#6cb6ff',
  magenta: '#d69cff',
  cyan: '#72ddf7',
  white: '#e6e6f0',
  brightBlack: '#6c7086',
  brightRed: '#ff8fa3',
  brightGreen: '#a6f4b8',
  brightYellow: '#ffe29a',
  brightBlue: '#9ccfff',
  brightMagenta: '#e5c1ff',
  brightCyan: '#a5ecfb',
  brightWhite: '#ffffff',
};

/** What a companion theme lays over TERM_THEME. The ANSI palette stays, for the reason above. */
export interface TermThemeColors {
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
}

let colors: TermThemeColors | null = null;
let glass = false;
const listeners = new Set<() => void>();

/**
 * The theme terminals open with and follow. TERM_THEME until a companion theme retints it; then the
 * cells' ground is transparent, so the pane's themed glass shows behind the text.
 */
export function termTheme(): ITheme {
  return colors ? { ...TERM_THEME, ...colors, background: 'rgba(0, 0, 0, 0)' } : TERM_THEME;
}

/** Whether terminals let a transparent ground through. xterm reads this only when a terminal opens, so a page that themes them turns it on before any opens. */
export const termThemeTransparent = () => glass;

/** Retints every terminal on this page (null: back to TERM_THEME) and lets later ones open transparent. */
export function setTermThemeColors(next: TermThemeColors | null) {
  glass = true;
  colors = next;
  for (const fn of listeners) fn();
}

export function onTermTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
