// The terminal window's text size. The desktop keeps xterm's 14 px; a headset panel starts larger,
// and anyone can step it up or down there. The choice is kept in this browser, apart for each.

export const TERM_FONT_DESKTOP = 14;
export const TERM_FONT_NATIVE = 20;
export const TERM_FONT_MIN = 10;
export const TERM_FONT_MAX = 36;
const STEP = 2;

let base = TERM_FONT_DESKTOP;
let storageKey = 'droid-office.term-font';
const listeners = new Set<(px: number) => void>();

export function clampTermFont(px: number): number {
  if (!Number.isFinite(px)) return base;
  return Math.max(TERM_FONT_MIN, Math.min(TERM_FONT_MAX, Math.round(px)));
}

/** One step bigger (+1) or smaller (-1). */
export function stepTermFont(px: number, dir: 1 | -1): number {
  return clampTermFont(px + dir * STEP);
}

/** From now on the terminal starts at the headset panel's size, and remembers its own choice. */
export function useNativeTermFont() {
  base = TERM_FONT_NATIVE;
  storageKey = 'droid-office.term-font.native';
}

/** The size a terminal opens at: the saved choice, else the default for where the office runs. */
export function termFontSize(): number {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved !== null) return clampTermFont(Number(saved));
  } catch {
    // storage blocked
  }
  return base;
}

export function setTermFontSize(px: number) {
  const size = clampTermFont(px);
  try {
    localStorage.setItem(storageKey, String(size));
  } catch {
    // storage blocked
  }
  for (const fn of listeners) fn(size);
}

/** Hears every change of size; returns the unlisten. */
export function onTermFontSize(fn: (px: number) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
