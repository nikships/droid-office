/**
 * Every timer the presenter window runs, by name, so that one `stop()` ends them all. A timer that outlives the page it
 * touches fires into a destroyed `webContents` ("Object has been destroyed") and raises an uncaught exception in the main
 * process, which is what quitting the app did to the 3 ms frame-rate timer. Once stopped, nothing can be started again.
 */
export class PresenterTimers {
  private readonly active = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  get isStopped(): boolean {
    return this.stopped;
  }

  has(name: string): boolean {
    return this.active.has(name);
  }

  get count(): number {
    return this.active.size;
  }

  /** Runs `fn` once after `ms`, replacing a timer of the same name. Does nothing once stopped. */
  after(name: string, ms: number, fn: () => void, options: { unref?: boolean } = {}): void {
    this.clear(name);
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.active.delete(name);
      if (!this.stopped) fn();
    }, ms);
    if (options.unref) timer.unref();
    this.active.set(name, timer);
  }

  /** Runs `fn` every `ms`, replacing a timer of the same name. Does nothing once stopped. Returns what ends this timer. */
  every(name: string, ms: number, fn: () => void, options: { unref?: boolean } = {}): () => void {
    this.clear(name);
    if (this.stopped) return () => {};
    const timer = setInterval(() => {
      if (!this.stopped) fn();
    }, ms);
    if (options.unref) timer.unref();
    this.active.set(name, timer);
    return () => {
      if (this.active.get(name) === timer) this.clear(name);
    };
  }

  clear(name: string): void {
    const timer = this.active.get(name);
    if (!timer) return;
    clearTimeout(timer);
    clearInterval(timer);
    this.active.delete(name);
  }

  stop(): void {
    this.stopped = true;
    for (const name of [...this.active.keys()]) this.clear(name);
  }
}
