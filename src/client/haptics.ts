import { withToken } from './token';

/** What the office can be asked to tap out; `src/server/haptics.ts` validates the same names. */
export type HapticPattern = 'tick' | 'charged' | 'super';

/**
 * The page side of the trackpad taps (`src/server/haptics.ts`): while a shot charges, one hard
 * tick per segment of the ring, a firm detent when it fills, and a buzz when a charged shot is
 * released. The patterns honour the Mac's own trackpad haptic setting, and where there is no
 * Force Touch trackpad to reach (every other OS, a page on another machine than the office, a
 * remote tab) the server says so once and this stops asking.
 */

/** How many ticks a full charge is divided into: one about every 94 ms of the 750 ms hold. */
export const CHARGE_HAPTIC_SEGMENTS = 8;

/** Which segment `progress` (0…1) is in, 0 before the first tick and `segments` when full. */
export function chargeHapticSegment(progress: number, segments = CHARGE_HAPTIC_SEGMENTS): number {
  if (!Number.isFinite(progress) || progress <= 0) return 0;
  return Math.min(segments, Math.floor(progress * segments) + 1);
}

/** Sends one pattern; resolves false only when the office says this page can never be felt. */
export type HapticSender = (pattern: HapticPattern) => Promise<boolean>;

const sendToOffice: HapticSender = async (pattern) => {
  try {
    const res = await fetch(withToken('/api/haptics'), {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pattern }),
    });
    if (!res.ok) return res.status !== 403;
    const body = (await res.json().catch(() => null)) as { supported?: unknown } | null;
    return body?.supported !== false;
  } catch {
    // The office is restarting or the tab is offline: keep the sound-only charge, try again next shot.
    return true;
  }
};

/**
 * A held charge's worth of taps. `charge` is called every frame and only a segment crossing
 * sends anything; `charged` and `release` are one tap each. Nothing here blocks or throws: a
 * failed tap must never cost the shot.
 */
export class ChargeHaptics {
  private segment = 0;
  private reachable = true;
  private readonly send: HapticSender;

  constructor(send: HapticSender = sendToOffice) {
    this.send = send;
  }

  private tap(pattern: HapticPattern) {
    if (!this.reachable) return;
    void this.send(pattern)
      .then((ok) => {
        if (!ok) this.reachable = false;
      })
      .catch(() => {});
  }

  /** A frame of the hold, at `progress` 0…1. */
  charge(progress: number) {
    const segment = chargeHapticSegment(progress);
    if (segment <= this.segment) return;
    this.segment = segment;
    if (progress < 1) this.tap('tick');
  }

  /** The ring just filled: the firm detent under the ready cue. */
  charged() {
    this.tap('charged');
  }

  /** The shot just left: only a charged release buzzes; a normal tap already clicked for real. */
  release(superShot: boolean) {
    this.reset();
    if (superShot) this.tap('super');
  }

  /** A cancelled or finished hold: the next charge ticks from the bottom again. */
  reset() {
    this.segment = 0;
  }
}
