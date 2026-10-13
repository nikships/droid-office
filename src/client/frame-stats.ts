// Frame pacing as the display sees it: how far apart drawn frames land, and how many refreshes each one stays up
// longer than the frame rate limit meant. Average FPS hides both. Pure and loadable in Node (tests/frame-stats.test.ts).

/** The parts of a frame timed on the CPU, in the order `drawFrame` (main.ts) runs them. */
export const FRAME_PASSES = ['update', 'scene', 'hands'] as const;
export type FramePass = (typeof FRAME_PASSES)[number];

/** One drawn frame. */
export interface FrameSample {
  /** The animation frame's timestamp (ms). */
  at: number;
  /** Drawn by the full-rate loop on an animation frame. Idle and wake draws are spaced on purpose and break the chain. */
  paced: boolean;
  /** CPU time of each pass, in ms. */
  cpu: Record<FramePass, number>;
}

/** p50, p95, p99 and the worst, in ms. */
export interface Spread {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface FrameReport {
  /** Paced frames measured: gaps between two of them in a row. */
  frames: number;
  /** Wall time those gaps cover, in ms. */
  spanMs: number;
  fps: number;
  fpsCap: number;
  /** The display's refresh period as measured from animation frames, in ms, and the rate it is. */
  refreshMs: number;
  refreshHz: number;
  /** Time between drawn frames. */
  frameTime: Spread;
  /** Frames that landed at least one refresh after the limit's slot for them. */
  missed: number;
  /** Refreshes that showed the previous frame again beyond what the limit plans for. */
  repeated: number;
  /** CPU time per pass, and their sum. */
  cpu: Record<FramePass | 'total', Spread>;
  /** GPU time per pass averaged over the frames the timer queries came back for, in ms; null where it isn't timed. */
  gpu: { scene: number | null; hands: number | null };
}

/** About a minute at 120 FPS. */
const KEEP = 7200;

export function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export function spread(values: readonly number[]): Spread {
  const s = [...values].sort((a, b) => a - b);
  return { p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), max: s.length ? s[s.length - 1] : 0 };
}

/**
 * Refreshes a frame stayed on screen beyond the limit's plan. Under a 40 FPS limit a 60 Hz display alternates one and
 * two refreshes, so the plan is the most refreshes one interval can take (`ceil`), and a gap counts in whole refreshes.
 */
export function extraRefreshes(gapMs: number, intervalMs: number, refreshMs: number): number {
  if (!(refreshMs > 0)) return 0;
  const planned = Math.max(1, Math.ceil(intervalMs / refreshMs - 1e-6));
  return Math.max(0, Math.round(gapMs / refreshMs) - planned);
}

/** A rolling record of the last minute of drawn frames. */
export class FrameStats {
  private samples: FrameSample[] = [];

  record(sample: FrameSample) {
    this.samples.push(sample);
    if (this.samples.length > KEEP) this.samples.splice(0, this.samples.length - KEEP);
  }

  reset() {
    this.samples = [];
  }

  /** Frames recorded since `since` (ms, the animation frame clock), or all that are kept. */
  report(o: { fpsCap: number; refreshMs: number; gpu?: FrameReport['gpu']; since?: number }): FrameReport {
    const since = o.since ?? Number.NEGATIVE_INFINITY;
    const samples = this.samples.filter((s) => s.at >= since);
    const interval = 1000 / o.fpsCap;
    const gaps: number[] = [];
    let missed = 0;
    let repeated = 0;
    for (let i = 1; i < samples.length; i++) {
      const s = samples[i];
      if (!s.paced || !samples[i - 1].paced) continue;
      const gap = s.at - samples[i - 1].at;
      gaps.push(gap);
      const extra = extraRefreshes(gap, interval, o.refreshMs);
      if (extra > 0) missed++;
      repeated += extra;
    }
    const spanMs = gaps.reduce((a, b) => a + b, 0);
    const cpuOf = (pass: FramePass | 'total') => spread(samples.map((s) => (pass === 'total' ? FRAME_PASSES.reduce((a, p) => a + s.cpu[p], 0) : s.cpu[pass])));
    return {
      frames: gaps.length,
      spanMs,
      fps: spanMs > 0 ? (gaps.length * 1000) / spanMs : 0,
      fpsCap: o.fpsCap,
      refreshMs: o.refreshMs,
      refreshHz: o.refreshMs > 0 ? 1000 / o.refreshMs : 0,
      frameTime: spread(gaps),
      missed,
      repeated,
      cpu: { update: cpuOf('update'), scene: cpuOf('scene'), hands: cpuOf('hands'), total: cpuOf('total') },
      gpu: o.gpu ?? { scene: null, hands: null },
    };
  }
}

/** The overlay's pacing line. */
export function pacingText(r: FrameReport): string {
  const t = r.frameTime;
  return `p50 ${t.p50.toFixed(1)} · p95 ${t.p95.toFixed(1)} · p99 ${t.p99.toFixed(1)} ms · ${r.missed} missed · ${r.repeated} repeated`;
}
