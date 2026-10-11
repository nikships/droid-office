/** WebGL2's timer queries, if the browser offers them (Chrome and Electron do on macOS; Safari does not). */
interface TimerQueryExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** Queries waiting on the GPU before new frames stop being timed. Results come back a few frames late. */
const MAX_PENDING = 6;

/**
 * Times the GPU work between `begin` and `end` each frame. The result is how long the GPU actually spent drawing the
 * office, which the frame rate can't say: at a locked 120 FPS a frame can cost 2 ms or 8 ms.
 */
export class GpuTimer {
  private readonly ext: TimerQueryExt | null;
  private readonly pending: WebGLQuery[] = [];
  private readonly free: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private totalMs = 0;
  private timed = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
  }

  get supported(): boolean {
    return !!this.ext;
  }

  begin() {
    if (!this.ext || this.active) return;
    this.poll();
    if (this.pending.length >= MAX_PENDING) return;
    const q = this.free.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end() {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** The average GPU time of the frames timed since the last call, in ms, or null if none came back. */
  take(): number | null {
    this.poll();
    const ms = this.timed ? this.totalMs / this.timed : null;
    this.totalMs = 0;
    this.timed = 0;
    return ms;
  }

  private poll() {
    if (!this.ext) return;
    const gl = this.gl;
    // A disjoint event (a GPU reset, power state change) makes every result in flight meaningless.
    const disjoint = !!gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      this.pending.shift();
      this.free.push(q);
      if (!disjoint) {
        this.totalMs += ns / 1e6;
        this.timed++;
      }
    }
  }
}
