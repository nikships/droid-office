// The terminal window starts at 14 px. Its adjustable size is saved in this browser.

export const TERM_FONT_DESKTOP = 14;
export const TERM_FONT_MIN = 10;
export const TERM_FONT_MAX = 36;
const STEP = 2;

const base = TERM_FONT_DESKTOP;
const storageKey = 'droid-office.term-font';
const listeners = new Set<(px: number) => void>();

export function clampTermFont(px: number): number {
  if (!Number.isFinite(px)) return base;
  return Math.max(TERM_FONT_MIN, Math.min(TERM_FONT_MAX, Math.round(px)));
}

/** One step bigger (+1) or smaller (-1). */
export function stepTermFont(px: number, dir: 1 | -1): number {
  return clampTermFont(px + dir * STEP);
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
