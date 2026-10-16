import { execFile } from 'node:child_process';

/**
 * The MacBook Force Touch trackpad's taps, for the charged shot (the idea is MTPLX's: its native
 * app ticks `NSHapticFeedbackManager` as a slider crosses each step, `Haptics.swift` there).
 *
 * There is no web or Electron API for this actuator. Chromium never exposes it, so the page asks
 * this server, which runs on the same Mac as the trackpad in both supported shapes (the Mac app,
 * and a browser on the office's own machine; the route is gated to that page, see `server.ts`).
 * The tap itself is one `/usr/bin/osascript` JavaScript-for-Automation run: it imports AppKit and
 * performs a feedback pattern in that process, the same trick the ForceTouchVibrationCLI toy uses
 * from a command-line tool. Off macOS, or when osascript fails, it is silently nothing: the sound
 * and the ring already carry the charge everywhere else.
 */

/** What the page can ask for, in the order a charged shot meets them. */
export type HapticPattern = 'tick' | 'charged' | 'super';

const PATTERNS: readonly string[] = ['tick', 'charged', 'super'];

/** A validated pattern name from an untrusted request body, or null for anything else. */
export function parseHapticPattern(v: unknown): HapticPattern | null {
  return typeof v === 'string' && PATTERNS.includes(v) ? (v as HapticPattern) : null;
}

/**
 * The JXA script for a pattern. Built only from the fixed table below, never from request text.
 * The API has no amplitude: a pattern is one fixed-strength tap, so strength is density and
 * duration (the ForceTouchVibrationCLI toy loops `.generic` every 5 ms to make the pad buzz).
 * These are all at that ceiling: `tick` is three `.generic` taps per ring segment, `charged` is
 * three firm `.levelChange` detents, and `super` is a detent plus `.generic` every 5 ms for
 * about 0.6 s, which is what reads as a hard buzz under the finger holding the button down.
 */
export function hapticScript(pattern: HapticPattern): string {
  const perform = (constant: string) => `p.performFeedbackPatternPerformanceTime(${constant}, $.NSHapticFeedbackPerformanceTimeNow);`;
  const sleep = (seconds: number) => `$.NSThread.sleepForTimeInterval(${seconds});`;
  const burst = (constant: string, times: number, gap: number) => `for(var i=0;i<${times};i++){${perform(constant)}${sleep(gap)}}`;
  const head = 'ObjC.import("AppKit");ObjC.import("Foundation");var p=$.NSHapticFeedbackManager.defaultPerformer;';
  if (pattern === 'tick') return head + burst('$.NSHapticFeedbackPatternGeneric', 3, 0.012);
  if (pattern === 'charged') return head + burst('$.NSHapticFeedbackPatternLevelChange', 3, 0.03);
  return `${head}${perform('$.NSHapticFeedbackPatternLevelChange')}${burst('$.NSHapticFeedbackPatternGeneric', 120, 0.005)}${perform('$.NSHapticFeedbackPatternLevelChange')}`;
}

/** Runs one script. Split out so tests can stand in without spawning osascript. */
export type HapticRunner = (script: string) => void;

const runOsascript: HapticRunner = (script) => {
  execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 2500 }, () => {});
};

/** The least gap between two `tick` spawns; a charge crosses a segment about every 94 ms. */
export const HAPTIC_TICK_MIN_MS = 70;

export interface HapticResult {
  ok: boolean;
  /** False off macOS (nothing to tap with); the page stops asking for the rest of its session. */
  supported: boolean;
  /** A `tick` dropped because the last one is still fresh. The charge itself is unaffected. */
  throttled?: boolean;
}

/**
 * One trackpad, however many tabs are open: `tick`s are droppable and rate-limited, while the
 * `charged` detent and the `super` buzz always fire (a release can land a frame after the detent,
 * and losing the buzz to a throttle would lose the whole point).
 */
export class TrackpadHaptics {
  private lastTickAt = Number.NEGATIVE_INFINITY;
  private readonly platform: string;
  private readonly now: () => number;
  private readonly run: HapticRunner;

  constructor(opts: { platform?: string; now?: () => number; run?: HapticRunner } = {}) {
    this.platform = opts.platform ?? process.platform;
    this.now = opts.now ?? Date.now;
    this.run = opts.run ?? runOsascript;
  }

  get supported(): boolean {
    return this.platform === 'darwin';
  }

  perform(v: unknown): HapticResult {
    const pattern = parseHapticPattern(v);
    if (!pattern) return { ok: false, supported: this.supported };
    if (!this.supported) return { ok: false, supported: false };
    if (pattern === 'tick') {
      const at = this.now();
      if (at - this.lastTickAt < HAPTIC_TICK_MIN_MS) return { ok: true, supported: true, throttled: true };
      this.lastTickAt = at;
    }
    try {
      this.run(hapticScript(pattern));
    } catch {
      return { ok: false, supported: true };
    }
    return { ok: true, supported: true };
  }
}
