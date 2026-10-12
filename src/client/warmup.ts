/**
 * The warm-up line at the bottom of the view: says when the renderer is busy with work that costs frame
 * rate for a while (baking the bounce light, compiling shaders), so a slow first minute reads as the
 * office getting ready rather than a slow office or a slow machine. Pure, so it loads in Node.
 */

/**
 * A frame that drew more shader programs than the last one and took at least this long (ms) was stalled on
 * compiling them. A new material on its own (a worker's color, a prop) compiles in a few ms and says nothing.
 */
export const COMPILE_STALL_MS = 30;
/** How long "compiling shaders" stays up after the last stalled frame: a driver keeps linking for a few frames more. */
export const COMPILE_HOLD_MS = 1500;
/** How long the line stays up, full, after the work is done, so a short bake doesn't flash. */
export const DONE_HOLD_MS = 700;

export interface WarmupFrame {
  now: number;
  /** Shader programs three.js holds after this frame (`renderer.info.programs.length`). */
  programs: number;
  /** How long this frame's scene draw took on the main thread, in ms. */
  drawMs: number;
  /** A full bake of the bounce light running now, and how far through it is (0–1); null when none is. */
  bake: number | null;
}

export interface WarmupStatus {
  /** The short label: what is happening. */
  say: string;
  /** 0–1 through it, or null when there's no telling. */
  progress: number | null;
  /** The work is done and the line is about to go. */
  done: boolean;
}

export class WarmupWatch {
  private programs = 0;
  private compiledAt = Number.NEGATIVE_INFINITY;
  private last: WarmupStatus | null = null;
  private busyAt = Number.NEGATIVE_INFINITY;

  /** What to show after this frame, or null for nothing. */
  update(f: WarmupFrame): WarmupStatus | null {
    if (f.programs > this.programs && f.drawMs >= COMPILE_STALL_MS) this.compiledAt = f.now;
    this.programs = f.programs;
    const compiling = f.now - this.compiledAt < COMPILE_HOLD_MS;
    const baking = f.bake !== null;
    if (compiling || baking) {
      this.busyAt = f.now;
      this.last = {
        say: compiling && baking ? 'Compiling shaders · baking light' : compiling ? 'Compiling shaders' : 'Baking light',
        progress: baking ? Math.min(1, Math.max(0, f.bake ?? 0)) : null,
        done: false,
      };
      return this.last;
    }
    if (this.last && f.now - this.busyAt < DONE_HOLD_MS) {
      if (!this.last.done) this.last = { say: this.last.progress === null ? 'Shaders ready' : 'Light baked', progress: 1, done: true };
      return this.last;
    }
    this.last = null;
    return null;
  }

  /** Something is on screen that needs more frames to change (see the render pace). */
  get showing(): boolean {
    return this.last !== null;
  }
}
