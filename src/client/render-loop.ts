import { IDLE_FRAME_MS, advanceClock, displayRefresh, frameDelta, gateFrame, OPEN_GATE, type FrameGate, type RenderClock, type RenderPace } from './render-pace';

interface RenderHost {
  pace(): RenderPace;
  /** The most frames a second to draw at the full pace. */
  fpsCap(): number;
  /** `at` is when the frame is drawn; `paced` when the full-rate loop drew it on an animation frame. */
  draw(dt: number, elapsed: number, frame: { at: number; paced: boolean }): void;
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
  private gate: FrameGate = OPEN_GATE;
  private elapsed = 0;

  constructor(private host: RenderHost) {}

  get mode() {
    return this.clock.mode;
  }

  /** The display's refresh period measured from animation frames, in ms. */
  get refreshMs(): number {
    return displayRefresh(this.gate);
  }

  start() {
    if (this.clock.mode === 'off') this.step('tick', this.host.now());
  }

  wake() {
    if (this.clock.mode !== 'off') this.step('wake');
  }

  private step(event: 'tick' | 'wake', timestamp?: number, frame = false) {
    const pace = this.host.pace();
    const fps = this.host.fpsCap();
    let gated = false;
    if (frame && timestamp !== undefined && pace === 'full' && this.clock.mode === 'full') {
      const { draw, gate } = gateFrame(this.gate, timestamp, fps);
      this.gate = gate;
      // A skipped frame steps nothing and draws nothing; the animation callback stays armed.
      if (!draw) return;
      gated = true;
    }
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
      // An idle or first draw counts against the cap too, so a wake straight after one waits its turn.
      if (!gated) this.gate = { ...this.gate, due: now + 1000 / fps };
      // Absolute-time poses must advance by the same capped step as physics, not by the hidden gap.
      this.elapsed += dt;
      this.host.draw(dt, this.elapsed, { at: now, paced: gated });
    }
    if (plan.schedule === 'raf' && !this.armed) {
      this.armed = true;
      this.host.animation((t) => this.step('tick', t, true));
    } else if (plan.schedule === 'idle') {
      this.idleTimer = this.host.delay(() => {
        this.idleTimer = null;
        this.step('tick', this.host.now());
      }, IDLE_FRAME_MS);
    }
  }
}
