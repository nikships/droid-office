// The office's bundled fonts (public/fonts, no CDN): Geist for prose and long-form content,
// Geist Mono for UI chrome, metadata and anything drawn on a world canvas.

export const SANS = "'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif";
export const MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/**
 * The terminals' font stack (the xterm windows and the 3D laptop screens painting them).
 * Geist Mono for text, then the bundled OFL-derived symbols fitted to its 0.6em cells.
 * The original Symbols Nerd Font Mono has 1em advances and outlines: using it as a fallback
 * made xterm clip icons against the next cell's background and made canvas prompts drift.
 * System Nerd Fonts and symbol/emoji fonts remain fallbacks for other glyphs.
 */
export const TERM_FONT = [
  "'Geist Mono'",
  "'Droid Office Terminal Symbols'",
  "'JetBrainsMono Nerd Font Mono'",
  "'JetBrainsMono Nerd Font'",
  "'FiraCode Nerd Font Mono'",
  "'FiraCode Nerd Font'",
  "'Hack Nerd Font Mono'",
  "'Hack Nerd Font'",
  "'MesloLGS NF'",
  "'CaskaydiaCove Nerd Font'",
  'ui-monospace',
  'SFMono-Regular',
  'Menlo',
  'Consolas',
  "'Apple Symbols'",
  "'Segoe UI Symbol'",
  "'Noto Sans Symbols 2'",
  "'Apple Color Emoji'",
  "'Segoe UI Emoji'",
  "'Noto Color Emoji'",
  'monospace',
].join(', ');

let loaded: Promise<unknown> | undefined;
let revision = 0;

/** Canvas terminals repaint when fonts finish, even if the PTY has printed nothing new. */
export function fontRevision(): number {
  return revision;
}

/**
 * Loads the weights the canvas painters and HUD use, so textures don't silently draw with
 * fallback fonts. Call once at boot, then invalidate and redraw anything painted before it
 * resolved (see main.ts).
 */
export function loadFonts(): Promise<unknown> {
  return (loaded ??= Promise.allSettled([
    document.fonts.load('400 16px Geist'),
    document.fonts.load('600 16px Geist'),
    document.fonts.load('700 16px Geist'),
    document.fonts.load('400 16px "Geist Mono"'),
    document.fonts.load('500 16px "Geist Mono"'),
    document.fonts.load('700 16px "Geist Mono"'),
    // A powerline glyph (U+E0B0), so the symbols font is ready before a prompt paints one.
    document.fonts.load('400 16px "Droid Office Terminal Symbols"', '\ue0b0'),
    document.fonts.load('700 16px "Droid Office Terminal Symbols"', '\ue0b0'),
  ]).then(() => {
    revision++;
  }));
}
