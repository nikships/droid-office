// The terminal window starts at 14 px. Its adjustable size is saved in this browser.

export const TERM_FONT_DEFAULT = 14;
export const TERM_FONT_MIN = 10;
export const TERM_FONT_MAX = 36;
export const TERM_FONT_STEP = 2;

const storageKey = 'droid-office.term-font';
const listeners = new Set<(px: number) => void>();
let unsavedSize: number | undefined;

function clampTermFont(px: number): number {
  if (!Number.isFinite(px)) return TERM_FONT_DEFAULT;
  return Math.max(TERM_FONT_MIN, Math.min(TERM_FONT_MAX, Math.round(px)));
}

/** One step bigger (+1) or smaller (-1). */
export function stepTermFont(px: number, dir: 1 | -1): number {
  return clampTermFont(px + dir * TERM_FONT_STEP);
}

/** The size a terminal opens at: the saved choice, else the default. */
export function termFontSize(): number {
  if (unsavedSize !== undefined) return unsavedSize;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved !== null) return clampTermFont(Number(saved));
  } catch {
    // storage blocked
  }
  return TERM_FONT_DEFAULT;
}

export function setTermFontSize(px: number) {
  const size = clampTermFont(px);
  try {
    localStorage.setItem(storageKey, String(size));
    unsavedSize = undefined;
  } catch {
    unsavedSize = size;
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
