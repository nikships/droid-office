// The office's terminal colours (TERM_THEME in src/client/world/laptop.ts); a test keeps them equal.
export const THEME = {
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

/** xterm halves the target for dim ANSI. Even half must exceed black's contrast with the
 * brightest pane, so it lifts dark ink rather than darkening it over a transparent ground. */
export function minimumContrast(background) {
  return background.slice(7) === '00' ? 6 : 4.5;
}
