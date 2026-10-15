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

/** How the addon puts a frame on the display: as it arrives (`direct`, the default), as it arrives but held to the vsync grid so a steady cadence stays steady (`paced`, a diagnostic: it costs latency), or on the next `CAMetalDisplayLink` update (`link`, a diagnostic). */
export type PresentMode = 'direct' | 'paced' | 'link';

/** `DROID_OFFICE_PRESENT_MODE` picks `link` or `paced` for a comparison; anything else is `direct`, the default. */
export function presentMode(env: Record<string, string | undefined>): PresentMode {
  const mode = env.DROID_OFFICE_PRESENT_MODE;
  return mode === 'link' || mode === 'paced' ? mode : 'direct';
}

/** The frame rate a page that nobody can see is held to. Hiding the offscreen window does not change the page's `visibilityState` or stop its animation frames in Electron's offscreen mode; only a low frame rate slows them. */
export const HIDDEN_FRAME_RATE = 1;

export interface PageVisibilityEffects {
  startPainting(): void;
  stopPainting(): void;
  setFrameRate(fps: number): void;
  /** Tells the office page itself (its visibility shim), which is what pauses its render loop. */
  notify(visible: boolean): void;
}

/** Whether the native side's report says the window can be seen: a report with no verdict counts as visible, so nothing is hidden on a guess. */
export function windowVisible(state: { visible?: boolean }): boolean {
  return state.visible !== false;
}

/**
 * What follows a window becoming visible or hidden, in one place so it can be tested without Electron. The page's own window is never
 * shown or hidden here: ordering it front or back from another Space tugs the Space switch of a window that is going full screen.
 */
export class PageVisibility {
  private visible = true;
  private fps = 60;

  constructor(private readonly effects: PageVisibilityEffects) {}

  isVisible(): boolean {
    return this.visible;
  }

  /** What the page's frame rate must be right now: the display's own rate while visible, the floor while hidden. */
  expectedRate(): number {
    return this.visible ? this.fps : HIDDEN_FRAME_RATE;
  }

  /** The display's frame rate changed: a visible page follows it, a hidden one stays slow. */
  setDisplayRate(fps: number): void {
    this.fps = fps;
    this.reapply();
  }

  /** Sets the rate again whatever it is thought to be (Electron only reports the last value asked for, not the one a page view runs at): a new page view or a dropped call can leave the page at another rate than the one asked for. */
  reapply(): void {
    this.effects.setFrameRate(this.expectedRate());
  }

  set(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) {
      this.effects.startPainting();
    } else {
      this.effects.stopPainting();
    }
    this.reapply();
    this.effects.notify(visible);
  }
}

/** While input flows, the frame rate is set again at most this often (ms). */
export const INPUT_REAPPLY_GAP_MS = 32;
/**
 * Chromium drops an offscreen page to 60 frames a second about 120 ms after any input event (mouse, key, sent or through the
 * DevTools Protocol) and keeps it there until the frame rate is set again. The set after the last event has to come after that drop
 * lands, so it is made this long (ms) after the event.
 */
export const INPUT_REAPPLY_TRAIL_MS = 250;

export interface InputFrameRateEffects {
  now(): number;
  /** Runs `fn` after `ms`; returns what cancels it. */
  schedule(fn: () => void, ms: number): () => void;
  /** Sets the page's frame rate again (`PageVisibility.reapply`). */
  reapply(): void;
  isVisible(): boolean;
}

/**
 * Keeps an offscreen page at its frame rate while input reaches it: a throttled re-apply during the input and one after the last
 * event. Nothing runs while the page is idle or hidden (a hidden page's rate is the floor `PageVisibility` set, and no input reaches it).
 */
export class InputFrameRate {
  private lastReapply = Number.NEGATIVE_INFINITY;
  private cancel: (() => void) | undefined;

  constructor(private readonly effects: InputFrameRateEffects) {}

  onInput(): void {
    if (!this.effects.isVisible()) return;
    const now = this.effects.now();
    if (now - this.lastReapply >= INPUT_REAPPLY_GAP_MS) {
      this.lastReapply = now;
      this.effects.reapply();
    }
    this.cancel?.();
    this.cancel = this.effects.schedule(() => {
      this.cancel = undefined;
      if (!this.effects.isVisible()) return;
      this.lastReapply = this.effects.now();
      this.effects.reapply();
    }, INPUT_REAPPLY_TRAIL_MS);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = undefined;
  }
}

/** Frames shown at the first refresh they can make, before `paced` mode has seen where the compositor's deadline is. */
export const CALIBRATION_FRAMES = 20;
/** `paced` mode holds a frame only when frames arrive at least this many refreshes apart; at one per refresh there is nothing to hold. */
const HOLD_MIN_REFRESHES = 1.5;
/** How long after the last presented frame the vsync grid is trusted, in seconds. */
const GRID_STALE_SECONDS = 0.25;
/** Seconds after the first frame at the held pace before any is measured: the window is still appearing and the page starting, and those frames show slower than the steady state the hold is judged against. */
export const CALIBRATION_WARMUP_SECONDS = 3;
/** The drawable is acquired this long (seconds) before the compositor's deadline for the slot. */
const ACQUIRE_MARGIN_SECONDS = 0.001;

/**
 * What `paced` mode has learned about the compositor: `minLatency` is the quickest paint-to-display time of the first
 * CALIBRATION_FRAMES frames shown without a hold, which is where the deadline for a refresh sits. This is the model of
 * the native code in `native/presenter/src/presenter.mm` (`pacedSlot`, `learn`); change them together.
 */
export interface PacedDeadline {
  calibrated: number;
  minLatency: number;
  baseLatency: number;
  lateRun: number;
  /** When the first frame at the held pace arrived (0 before it), on the clock the frames' times are on. */
  startedAt: number;
}

export function newPacedDeadline(): PacedDeadline {
  return { calibrated: 0, minLatency: 0, baseLatency: 0, lateRun: 0, startedAt: 0 };
}

/** A frame that arrived at `arrivedAt` and was shown with no hold took `latency` seconds to reach the display. Call it only for frames that arrive at the pace being held to. */
export function calibratePaced(state: PacedDeadline, latency: number, arrivedAt: number): PacedDeadline {
  if (state.calibrated >= CALIBRATION_FRAMES) return state;
  if (state.startedAt === 0) state = { ...state, startedAt: arrivedAt };
  if (arrivedAt - state.startedAt < CALIBRATION_WARMUP_SECONDS || !(latency > 0 && latency < 0.2)) return state;
  const minLatency = state.calibrated === 0 ? latency : Math.min(state.minLatency, latency);
  const calibrated = state.calibrated + 1;
  return { ...state, calibrated, minLatency, baseLatency: calibrated === CALIBRATION_FRAMES ? minLatency : state.baseLatency };
}

export interface PacedHoldInput {
  /** When the frame's paint reached the presenter. */
  arrivedAt: number;
  /** Now, and the presented time of the latest frame the compositor showed: any refresh of the grid. All in seconds on one clock. */
  now: number;
  anchor: number;
  /** One refresh, and the smoothed gap between arrivals (0 when unknown). */
  period: number;
  arrivalInterval: number;
  state: PacedDeadline;
}

export interface PacedHold {
  /** The refresh (grid time) the frame is held to. */
  slot: number;
  /** When to take the frame's drawable: late enough that the frame does not sit on one of the layer's three drawables while it waits. */
  acquireAt: number;
}

/**
 * Where a frame goes: the refresh half a refresh past the one the deadline would give it, which stays the same refresh however
 * the arrivals jitter. null means show it at the first refresh it can make.
 */
export function pacedHold(input: PacedHoldInput): PacedHold | null {
  const { arrivedAt, now, anchor, period, arrivalInterval, state } = input;
  if (state.calibrated < CALIBRATION_FRAMES || anchor <= 0 || period <= 0 || arrivedAt <= 0) return null;
  if (arrivalInterval <= 0 || arrivalInterval < HOLD_MIN_REFRESHES * period || now - anchor > GRID_STALE_SECONDS) return null;
  const target = arrivedAt + state.minLatency + 0.5 * period;
  const slot = anchor + Math.ceil((target - anchor) / period) * period;
  return { slot, acquireAt: slot - state.minLatency - ACQUIRE_MARGIN_SECONDS };
}

/**
 * A held frame was shown at `presentedAt`, for the slot it was held to. Three in a row shown over half a refresh after their slot
 * mean the deadline is later than thought, so the hold grows by a refresh; at most twice, because a held frame that waited for a
 * drawable also shows late and growing the hold then only makes it worse.
 */
export function learnPacedLate(state: PacedDeadline, presentedAt: number, slot: number, period: number): PacedDeadline {
  if (presentedAt - slot <= 0.5 * period) return state.lateRun === 0 ? state : { ...state, lateRun: 0 };
  const lateRun = state.lateRun + 1;
  if (lateRun >= 3 && state.minLatency < state.baseLatency + 1.5 * period) return { ...state, lateRun: 0, minLatency: state.minLatency + period };
  return { ...state, lateRun };
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
  /** `paced` mode's estimate of the compositor's deadline: the quickest paint-to-display time of frames shown without a hold, in milliseconds (0 until measured). */
  deadlineMs: number;
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
  /** `paced` mode's estimate of the compositor's deadline: the quickest paint-to-display time of frames shown without a hold, in milliseconds (0 until measured). */
  deadlineMs: number;
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
export function summarizeNativeStats(stats: NativeStats, plannedMs: number, withSamples = false, mode: PresentMode = 'direct'): PresenterReport {
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
    deadlineMs: stats.deadlineMs,
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
