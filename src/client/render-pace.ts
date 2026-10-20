// How fast the 3D loop draws. The loop in main.ts asks renderPace; it does not decide this itself.
// Nothing here touches window, document or WebGL, so tests can drive every case under node.

/** Every frame, a few frames a second, or not at all. */
export type RenderPace = 'full' | 'idle' | 'paused';

/**
 * Gap between frames while the office is on screen and nothing much is moving.
 * Long enough to matter on a laptop, short enough that a still room does not look frozen.
 */
export const IDLE_FRAME_MS = 200;

/**
 * How long the office must stay still before it drops to the idle pace. A short pause between
 * moves, or reading a board, keeps full rate; only a room left alone this long slows down.
 */
export const IDLE_AFTER_MS = 30_000;

/** The loop's existing hitch cap, in seconds. A pause must not fast-forward across the gap. */
export const FRAME_DT_CAP = 0.1;

/** How long a gong strike still counts as moving. The disc's swing in world/gong.ts dies out in about this long. */
export const GONG_RING_MS = 6000;

/** Rain or snow heavier than this is visible. Below it, the last of a shower can run at the idle pace. */
const SKY_FALL = 0.02;

/**
 * What is moving in the office. Any of these keeps full rate while the page is visible.
 * Traffic through a window and a worker's idle pose are not in this list: they keep going at the idle pace.
 */
export interface SceneMotion {
  /** Moving, looking, falling, climbing, or the view is swaying. */
  player: boolean;
  /** Walking, hopping for attention, leaving, or being carried out. */
  worker: boolean;
  confetti: boolean;
  gong: boolean;
  smoke: boolean;
  /** Traffic is the picture: up on the roof, or you're standing outside. */
  cars: boolean;
  elevator: boolean;
  /** A board card is moving, not just sitting in your hands. */
  boardCard: boolean;
  /** Rain or snow is falling. */
  sky: boolean;
}

export const SCENE_MOTIONS = ['player', 'worker', 'confetti', 'gong', 'smoke', 'cars', 'elevator', 'boardCard', 'sky'] as const satisfies readonly (keyof SceneMotion)[];

export function stillScene(): SceneMotion {
  return { player: false, worker: false, confetti: false, gong: false, smoke: false, cars: false, elevator: false, boardCard: false, sky: false };
}

export interface RenderSignals {
  /**
   * The tab is in the background, minimized, or fully covered by another window.
   * Measured on macOS in October 2026, Chrome 155 and Safari: `document.visibilityState`
   * becomes `hidden` for a background tab at once, and for a window sitting fully behind
   * another window within a couple of seconds. It stays `visible` when that window is
   * unfocused but still on screen beside another window. An IntersectionObserver on the
   * canvas does not notice the covering window (the canvas stays fully in the viewport).
   * `document.hasFocus()` goes false for both, so it is not a covered-window signal.
   */
  hidden: boolean;
  /**
   * Covered while the page still says it is visible. Current Chrome and Safari report
   * occlusion as `hidden` (see above), so the office leaves this false. It is here so a
   * browser that never reports occlusion can still pause, and so tests can drive it.
   */
  covered: boolean;
  /**
   * The tab was opened with `?pace=full`: draw every frame whatever the other signals say, so a
   * screen recording of a still or covered office does not drop to the idle pace or stop.
   */
  fullRate: boolean;
  motion: SceneMotion;
  /** Milliseconds since something in `motion` was last going, or the page last came into view. */
  quietMs: number;
}

/** Rain or snow is actually falling, not just a clear night. */
export function skyFalling(rain: number, snow: number): boolean {
  return rain > SKY_FALL || snow > SKY_FALL;
}

/** A strike at `struckAtMs` is still swinging at `nowMs`. */
export function gongRinging(nowMs: number, struckAtMs: number): boolean {
  return struckAtMs > 0 && nowMs - struckAtMs < GONG_RING_MS;
}

export function sceneIsMoving(motion: SceneMotion): boolean {
  return SCENE_MOTIONS.some((key) => motion[key]);
}

/**
 * `fullRate`: every frame. Hidden or covered: draw nothing. Visible and something in `motion` is
 * going, or was within `IDLE_AFTER_MS`: every frame. Visible and quiet for longer than that: the idle pace.
 */
export function renderPace(signals: RenderSignals): RenderPace {
  if (signals.fullRate) return 'full';
  if (signals.hidden || signals.covered) return 'paused';
  if (sceneIsMoving(signals.motion) || signals.quietMs < IDLE_AFTER_MS) return 'full';
  return 'idle';
}

/**
 * Seconds to step the world this frame. `rawSeconds` is how long the timer says since the last
 * draw. Full rate keeps the loop's hitch cap. Idle frames are spaced on purpose, so one step
 * covers that slot. The first frame after a pause uses the hitch cap either way, so a covered
 * window does not fast-forward the office across the gap.
 */
export function frameDelta(rawSeconds: number, pace: RenderPace, resumed: boolean): number {
  if (!(rawSeconds > 0) || pace === 'paused') return 0;
  const cap = pace === 'idle' && !resumed ? IDLE_FRAME_MS / 1000 : FRAME_DT_CAP;
  return Math.min(rawSeconds, cap);
}

/** The frame cap's state, on the animation frame clock (ms). */
export interface FrameGate {
  /** When the next capped frame is due; null draws the next frame. */
  due: number | null;
  /** The last animation frame's timestamp, drawn or skipped. */
  last: number | null;
  /** The gaps between the last few animation frames, oldest first. */
  gaps: readonly number[];
}

export const OPEN_GATE: FrameGate = { due: null, last: null, gaps: [] };

/** Animation frame gaps kept to measure the display's refresh. The shortest is the refresh: a hitch only makes a gap longer. */
const REFRESH_GAPS = 8;
/** The refresh assumed before any gap is measured. */
const REFRESH_GUESS_MS = 1000 / 120;
/**
 * How early, in refreshes, a frame may arrive and still be the one for its due time. Just under a half, so the one
 * nearest wins and a tie (40 FPS on 60 Hz lands due times halfway between refreshes) always goes to the later frame.
 */
const EARLY_REFRESHES = 0.45;

/** The display's refresh period as measured from animation frame gaps, in ms. */
export function displayRefresh(gate: FrameGate): number {
  return gate.gaps.length ? Math.min(...gate.gaps) : REFRESH_GUESS_MS;
}

/**
 * Whether the animation frame at `now` draws under a cap of `fps`, and the gate after it. Due times sit on a fixed
 * grid one interval apart and the refresh nearest each one draws, so the average rate is exactly the cap and timestamp
 * jitter under about half a refresh changes nothing: on 120 Hz, 40 is every 3rd refresh and 60 every 2nd; on 60 Hz,
 * 40 alternates one and two refreshes. A frame that finds the grid behind (a hitch, or a draw outside the cap) starts
 * it again from itself, so the loop never bursts to catch up.
 */
export function gateFrame(gate: FrameGate, now: number, fps: number): { draw: boolean; gate: FrameGate } {
  const gap = gate.last === null ? 0 : now - gate.last;
  const gaps = gap > 0 ? [...gate.gaps, gap].slice(-REFRESH_GAPS) : gate.gaps;
  const interval = 1000 / fps;
  const early = Math.min(interval, displayRefresh({ ...gate, gaps })) * EARLY_REFRESHES;
  if (gate.due !== null && now < gate.due - early) return { draw: false, gate: { due: gate.due, last: now, gaps } };
  const next = (gate.due ?? now) + interval;
  return { draw: true, gate: { due: next - early <= now ? now + interval : next, last: now, gaps } };
}

export type LoopMode = 'off' | 'full' | 'idle' | 'paused';

/** What to do with the animation callback after this step. `keep` leaves a running full-rate loop alone. */
export type LoopSchedule = 'keep' | 'raf' | 'idle' | 'stop';

export interface RenderClock {
  mode: LoopMode;
  /** The next draw is the first one after a pause. */
  resume: boolean;
}

export interface LoopPlan {
  clock: RenderClock;
  /** Draw during this call. A wake only schedules; the animation callback draws. */
  draw: boolean;
  schedule: LoopSchedule;
  /** Cap this draw like a hitch. Meaningful when `draw` is true. */
  resumed: boolean;
}

/**
 * One step of the scheduler. `tick` is a callback that was due (a frame, or an idle timeout).
 * `wake` is a key, a pointer, or a server message: draw on the next animation frame, not after
 * the rest of the idle wait. A hidden page schedules nothing.
 */
export function advanceClock(clock: RenderClock, pace: RenderPace, event: 'tick' | 'wake'): LoopPlan {
  if (pace === 'paused') {
    const schedule: LoopSchedule = clock.mode === 'paused' || clock.mode === 'off' ? 'keep' : 'stop';
    return { clock: { mode: 'paused', resume: true }, draw: false, schedule, resumed: false };
  }
  if (event === 'wake') {
    if (clock.mode === 'full') return { clock, draw: false, schedule: 'keep', resumed: false };
    // Break an idle wait, or start again after a pause, and draw on the next animation frame.
    const resume = clock.resume || clock.mode === 'paused';
    return { clock: { mode: 'full', resume }, draw: false, schedule: 'raf', resumed: false };
  }
  const resumed = clock.resume;
  if (pace === 'idle') return { clock: { mode: 'idle', resume: false }, draw: true, schedule: 'idle', resumed };
  const schedule: LoopSchedule = clock.mode === 'full' ? 'keep' : 'raf';
  return { clock: { mode: 'full', resume: false }, draw: true, schedule, resumed };
}
