import { $, toast } from './dom';

/** The Keyboard Lock API (Chromium, secure pages only), which TypeScript's DOM types don't have. */
interface KeyboardLock {
  lock(codes?: string[]): Promise<void>;
  unlock(): void;
}

const EXPAND_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const SHRINK_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';

export interface Fullscreen {
  /** Whether this browser can put the page in full screen at all (iPhone Safari can't). */
  readonly available: boolean;
  isOn(): boolean;
  toggle(): void;
  /** Whether Esc reaches the page in full screen instead of the browser, so the page must free the mouse itself. */
  escapeLocked(): boolean;
  onChange(fn: () => void): void;
}

/**
 * Full screen for the office, from the button in the bottom right corner or the ☰ menu.
 * The office closes every window with Esc, which would otherwise also drop you out of full screen,
 * so where the browser allows it Esc is kept for the page; holding Esc still leaves full screen.
 */
export function mountFullscreen(): Fullscreen {
  const btn = $('fullscreen');
  const keyboard = (navigator as Navigator & { keyboard?: Partial<KeyboardLock> }).keyboard;
  const available = !!document.fullscreenEnabled;
  const listeners = new Set<() => void>();
  let escLocked = false;

  const isOn = () => !!document.fullscreenElement;
  const paint = () => {
    const on = isOn();
    btn.innerHTML = on ? SHRINK_SVG : EXPAND_SVG;
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
    btn.title = on ? `Exit full screen (${escLocked ? 'or hold Esc' : 'Esc'})` : 'Full screen';
    for (const fn of listeners) fn();
  };

  document.addEventListener('fullscreenchange', () => {
    if (isOn()) {
      keyboard
        ?.lock?.(['Escape'])
        .then(() => {
          escLocked = isOn();
          paint();
        })
        .catch(() => undefined);
    } else {
      escLocked = false;
      keyboard?.unlock?.();
    }
    paint();
  });

  const toggle = () => {
    const go = isOn() ? document.exitFullscreen() : document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    go.catch(() => toast('This browser won’t go full screen here', 'warn'));
  };
  btn.addEventListener('click', toggle);
  btn.classList.toggle('hidden', !available);
  paint();

  return {
    available,
    isOn,
    toggle,
    escapeLocked: () => escLocked && isOn(),
    onChange: (fn) => listeners.add(fn),
  };
}
