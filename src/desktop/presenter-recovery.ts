/** Two page crashes inside this many milliseconds are a loop, not a fluke: the second one asks the owner instead of reloading again. */
export const CRASH_WINDOW_MS = 60_000;

export type CrashAction = 'ignore' | 'reload' | 'dialog';

/**
 * What to do when the office page's render process goes away. A clean exit is the page closing itself, and a kill while the
 * app is quitting is the quit; anything else leaves a frozen last frame on the screen, so the page is reloaded once and a
 * second crash within a minute is put to the owner (Reload or Quit) rather than reloaded in a loop.
 */
export class CrashPolicy {
  private crashes: number[] = [];

  onGone(reason: string, now: number, quitting: boolean): CrashAction {
    if (reason === 'clean-exit') return 'ignore';
    if (reason === 'killed' && quitting) return 'ignore';
    this.crashes = this.crashes.filter((at) => now - at < CRASH_WINDOW_MS);
    this.crashes.push(now);
    return this.crashes.length >= 2 ? 'dialog' : 'reload';
  }

  /** The owner chose to reload after a dialog: the next crash starts the count again. */
  reset(): void {
    this.crashes = [];
  }
}

/** How long after the GPU process dies the page may stay silent before it is reloaded. */
export const GPU_REPAINT_MS = 3000;

export type GpuAction = 'reload' | 'fail';

/**
 * The GPU process dying takes the page's compositor with it. Chromium normally restarts it and the page paints again; if no
 * texture arrives within `GPU_REPAINT_MS` the page is reloaded, and if that stays silent too the app says so and quits.
 */
export class GpuRecovery {
  private silent = 0;

  /** A texture arrived: whatever came before was recovered. */
  painted(): void {
    this.silent = 0;
  }

  /** `GPU_REPAINT_MS` passed with no texture. */
  silentFor(): GpuAction {
    this.silent++;
    return this.silent === 1 ? 'reload' : 'fail';
  }
}

/** Import failures in a row, before any frame has been drawn, after which the window is judged unable to show anything. */
export const IMPORT_FAILURE_LIMIT = 5;

/**
 * What the window waits for before it is shown: a frame the GPU has drawn, not just one the page has painted. A texture that
 * arrives but cannot be imported draws nothing, and showing the window then would put a black one on the screen that looks started.
 */
export class FirstFrameGate {
  private drawnOnce = false;

  /** The addon reports its first drawn frame. True the first time only: that is when the window is shown. */
  drawn(): boolean {
    if (this.drawnOnce) return false;
    this.drawnOnce = true;
    return true;
  }

  isDrawn(): boolean {
    return this.drawnOnce;
  }

  /** The addon reports `count` import failures in a row. True when the window should fail startup. */
  importFailed(count: number): boolean {
    return !this.drawnOnce && count >= IMPORT_FAILURE_LIMIT;
  }
}

/** Whether a frame at `frameUrl` belongs to the page at `origin`; no frame, an unparsable URL or no known origin is not. */
export function trustedFrame(frameUrl: string | undefined, origin: string | undefined): boolean {
  if (!frameUrl || !origin) return false;
  try {
    return new URL(frameUrl).origin === origin;
  } catch {
    return false;
  }
}
