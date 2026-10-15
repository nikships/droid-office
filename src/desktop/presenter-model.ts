/** Pure logic of the native presenter: what the page renders, how fast, and how the native side's samples are reported. No Electron import, so tests/ can load it. */

/** The offscreen page's shared texture format: float16 when a screen can show brighter than white, else 8-bit. */
export type OsrPixelFormat = 'argb' | 'rgbaf16';

export function osrPixelFormat(edrCapable: boolean): OsrPixelFormat {
  return edrCapable ? 'rgbaf16' : 'argb';
}

/** What the native layer is built with (`new Presenter(handle, { pixelFormat })`). */
export function layerPixelFormat(osr: OsrPixelFormat): 'rgbaf16' | 'bgra' {
  return osr === 'rgbaf16' ? 'rgbaf16' : 'bgra';
}

/** How the addon puts a frame on the display: as it arrives (`direct`), as it arrives but held to the vsync grid so a steady cadence stays steady (`paced`), or on the next `CAMetalDisplayLink` update (`link`). */
export type PresentMode = 'direct' | 'paced' | 'link';

/** `DROID_OFFICE_PRESENT_MODE` picks `link` or `direct` for a comparison; anything else is `paced`, the default. */
export function presentMode(env: Record<string, string | undefined>): PresentMode {
  const mode = env.DROID_OFFICE_PRESENT_MODE;
  return mode === 'link' || mode === 'direct' ? mode : 'paced';
}

const MIN_OSR_FPS = 30;
const MAX_OSR_FPS = 120;

/**
 * The offscreen page's frame rate: the display's own refresh, so the page's rAF loop (and its 40/60/120 FPS cap in
 * `render-pace.ts`) paces against the refresh the player has. Clamped to what the office supports.
 */
export function osrFrameRate(maxFps: number | undefined): number {
  if (!maxFps || !Number.isFinite(maxFps) || maxFps <= 0) return 60;
  return Math.min(MAX_OSR_FPS, Math.max(MIN_OSR_FPS, Math.round(maxFps)));
}

/** The CSS-pixel size the offscreen page takes from the window's content size. */
export function pageSize(content: { width: number; height: number }): { width: number; height: number } {
  return { width: Math.max(1, Math.round(content.width)), height: Math.max(1, Math.round(content.height)) };
}

/** Textures Electron lent out and the native side has not handed back yet. Releasing twice, or an id nobody holds, is a no-op. */
export class TextureLedger<T extends { release(): void }> {
  private readonly held = new Map<number, T>();
  private next = 1;

  hold(texture: T): number {
    const id = this.next++;
    this.held.set(id, texture);
    return id;
  }

  release(id: number): boolean {
    const texture = this.held.get(id);
    if (!texture) return false;
    this.held.delete(id);
    texture.release();
    return true;
  }

  releaseAll(): void {
    for (const id of [...this.held.keys()]) this.release(id);
  }

  get size(): number {
    return this.held.size;
  }
}

/** What `Presenter.stats()` returns from the addon. `samples` has SAMPLE_STRIDE numbers per presented frame, oldest first. */
export interface NativeStats {
  submitted: number;
  dropped: number;
  presented: number;
  notShown: number;
  ticks: number;
  ticksWithFrame: number;
  importFailures: number;
  released: number;
  inFlight: number;
  maxInFlight: number;
  now: number;
  samples: ArrayLike<number>;
}

/** Numbers per sample, in this order: id, submittedAt, tickAt, targetPresentation, presentedAt (seconds), gpuMs. */
export const SAMPLE_STRIDE = 6;

export interface Spread {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface PresenterReport {
  /** How the presenter puts frames on the display (see `presentMode`). */
  mode: PresentMode;
  /** Frames Chromium handed over, frames the presenter showed, and frames replaced in the mailbox before a refresh could show them. */
  submitted: number;
  presented: number;
  dropped: number;
  /** Frames the compositor never showed (their presented time stayed 0). */
  notShown: number;
  importFailures: number;
  /** Display refreshes the presenter was woken for, and those that had a new frame to show. */
  ticks: number;
  ticksWithFrame: number;
  /** Most frames the GPU held at once, which is also the most textures the presenter kept from Electron's pool. */
  maxInFlight: number;
  /** Frames per second over the sampled span. */
  fps: number;
  /** Milliseconds between consecutive presented frames. */
  interval: Spread;
  /** Milliseconds from the paint event reaching the addon to the frame being on the display. */
  latency: Spread;
  /** Milliseconds a frame waited in the mailbox for the next refresh. */
  wait: Spread;
  /** Milliseconds the GPU spent drawing the frame into the layer. */
  gpu: Spread;
  /** Intervals longer than 1.5 planned frames, and shorter than half of one (a frame shown for a single refresh and the next one right behind). */
  late: number;
  early: number;
  /** The interval between frames the numbers above are judged against, in milliseconds. */
  plannedMs: number;
  /** Every presented frame, oldest first, when asked for (`samples: true`): see SAMPLE_STRIDE. Seconds are on the app's monotonic clock (`now()` of the addon). */
  samples?: number[];
}

const ZERO: Spread = { p50: 0, p95: 0, p99: 0, max: 0 };

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index]!;
}

export function spread(values: number[]): Spread {
  if (!values.length) return ZERO;
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), max: sorted[sorted.length - 1]! };
}

/** Turns the addon's raw counters and samples into the report `office.presenterStats()` returns. `plannedMs` is the frame interval the player asked for (the FPS cap, or the refresh when it is faster). */
export function summarizeNativeStats(stats: NativeStats, plannedMs: number, withSamples = false, mode: PresentMode = 'paced'): PresenterReport {
  const interval: number[] = [];
  const latency: number[] = [];
  const wait: number[] = [];
  const gpu: number[] = [];
  let late = 0;
  let early = 0;
  let firstAt = 0;
  let lastAt = 0;
  let previousAt = 0;
  const count = Math.floor(stats.samples.length / SAMPLE_STRIDE);
  for (let i = 0; i < count; i++) {
    const at = i * SAMPLE_STRIDE;
    const submittedAt = stats.samples[at + 1]!;
    const tickAt = stats.samples[at + 2]!;
    const presentedAt = stats.samples[at + 4]!;
    const gpuMs = stats.samples[at + 5]!;
    latency.push((presentedAt - submittedAt) * 1000);
    wait.push((tickAt - submittedAt) * 1000);
    gpu.push(gpuMs);
    if (previousAt > 0) {
      const gap = (presentedAt - previousAt) * 1000;
      interval.push(gap);
      if (gap > plannedMs * 1.5) late++;
      else if (gap < plannedMs * 0.5) early++;
    } else {
      firstAt = presentedAt;
    }
    previousAt = presentedAt;
    lastAt = presentedAt;
  }
  const span = lastAt - firstAt;
  return {
    mode,
    submitted: stats.submitted,
    presented: stats.presented,
    dropped: stats.dropped,
    notShown: stats.notShown,
    importFailures: stats.importFailures,
    ticks: stats.ticks,
    ticksWithFrame: stats.ticksWithFrame,
    maxInFlight: stats.maxInFlight,
    fps: span > 0 ? (count - 1) / span : 0,
    interval: spread(interval),
    latency: spread(latency),
    wait: spread(wait),
    gpu: spread(gpu),
    late,
    early,
    plannedMs,
    ...(withSamples ? { samples: Array.from(stats.samples) } : {}),
  };
}
