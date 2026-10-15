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

/** How long (ms) an office page may be silent after it loads before each step of PaintStall. */
export const STALL_KICK_MS = [1000, 2000] as const;
export const STALL_RELOAD_MS = 3500;
export const STALL_FAIL_MS = 3500;

export type StallAction = 'wait' | 'kick' | 'reload' | 'fail';

/**
 * A page that loaded but whose paints never reach the presenter: after a navigation to the office, Electron's offscreen view
 * sometimes starts with its frame capturer not delivering (about one launch in ten; the page runs at 120 rAF/s and the window
 * keeps showing the splash). Restarting painting wakes it. A page that stays silent is kicked twice, reloaded once, and then
 * the app says so and quits: never a window left on the splash. `armedAt` is when the office page finished loading;
 * `painted` ends the watch and forgets the reload.
 */
export class PaintStall {
  private armedAt: number | undefined;
  private kicks = 0;
  private reloaded = false;

  arm(now: number): void {
    this.armedAt = now;
    this.kicks = 0;
  }

  painted(): void {
    this.armedAt = undefined;
    this.reloaded = false;
  }

  get armed(): boolean {
    return this.armedAt !== undefined;
  }

  check(now: number): StallAction {
    if (this.armedAt === undefined) return 'wait';
    const silent = now - this.armedAt;
    if (this.reloaded) return silent >= STALL_FAIL_MS ? 'fail' : 'wait';
    if (silent >= STALL_RELOAD_MS) {
      this.reloaded = true;
      this.armedAt = now;
      this.kicks = 0;
      return 'reload';
    }
    const next = STALL_KICK_MS[this.kicks];
    if (next !== undefined && silent >= next) {
      this.kicks++;
      return 'kick';
    }
    return 'wait';
  }
}
