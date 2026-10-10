import { IDLE_FRAME_MS, advanceClock, frameDelta, type RenderClock, type RenderPace } from './render-pace';

interface RenderHost {
  pace(): RenderPace;
  draw(dt: number, elapsed: number): void;
  animation(callback: ((timestamp: number) => void) | null): void;
  delay(callback: () => void, ms: number): number;
  cancelDelay(id: number): void;
  now(): number;
  paused(): void;
}

/** Owns the real callbacks and a simulation clock, independent of music and server time. */
export class RenderLoop {
  private clock: RenderClock = { mode: 'off', resume: false };
  private idleTimer: number | null = null;
  private armed = false;
  private lastDraw: number | null = null;
  private elapsed = 0;

  constructor(private host: RenderHost) {}

  get mode() {
    return this.clock.mode;
  }

  start() {
    if (this.clock.mode === 'off') this.step('tick', this.host.now());
  }

  wake() {
    if (this.clock.mode !== 'off') this.step('wake');
  }

  private step(event: 'tick' | 'wake', timestamp?: number) {
    const pace = this.host.pace();
    const plan = advanceClock(this.clock, pace, event);
    this.clock = plan.clock;
    if (plan.schedule !== 'keep') {
      if (this.armed && plan.schedule !== 'raf') {
        this.host.animation(null);
        this.armed = false;
      }
      if (this.idleTimer !== null) {
        this.host.cancelDelay(this.idleTimer);
        this.idleTimer = null;
      }
    }
    if (plan.schedule === 'stop') this.host.paused();
    if (plan.draw) {
      const now = timestamp ?? this.host.now();
      const dt = frameDelta(this.lastDraw === null ? 0 : (now - this.lastDraw) / 1000, pace, plan.resumed);
      this.lastDraw = now;
      // Absolute-time poses must advance by the same capped step as physics, not by the hidden gap.
      this.elapsed += dt;
      this.host.draw(dt, this.elapsed);
    }
    if (plan.schedule === 'raf' && !this.armed) {
      this.armed = true;
      this.host.animation((t) => this.step('tick', t));
    } else if (plan.schedule === 'idle') {
      this.idleTimer = this.host.delay(() => {
        this.idleTimer = null;
        this.step('tick', this.host.now());
      }, IDLE_FRAME_MS);
    }
  }
}
