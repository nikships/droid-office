// The terminal's colors: an OLED-black ground with an orange cursor. The ANSI palette keeps its
// distinct hues — agents paint with it, so only the base, cursor and selection are ours to restyle.
// Kept out of world/laptop so non-3D clients (the dashboard, the terminal window) can use the
// terminal without loading three.js. world/laptop re-exports this as TERM_THEME.

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
