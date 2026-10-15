/** Why a pointer lock request is refused, by the names a browser uses. `player.ts` retries without `unadjustedMovement` on 'NotSupportedError' and counts the others as a refusal. */
export type LockError = 'NotAllowedError' | 'NotSupportedError';

export type LockAnswer = { ok: true; raw: boolean } | { ok: false; error: LockError };

/**
 * The rules a browser applies to `requestPointerLock`, which an offscreen page cannot do itself (Chromium refuses every
 * request there with a WrongDocumentError). The page's request, Esc, losing focus and `exitPointerLock` all end up here, and
 * what comes out is what the page is told: granted, refused, or released.
 *
 * - A request needs a click or key behind it, except right after the page let go of the mouse itself.
 * - Esc releases the mouse on key down. While it is held, a request is refused, and the release it caused is the user's.
 * - Esc coming up releases the mouse too, unless the page took the key (`preventDefault`), which is how `player.ts` relocks.
 * - Losing focus releases the mouse. The next request needs a click or key again.
 */
export class PointerLock {
  locked = false;
  /** Whether the lock in force reads the mouse raw (no pointer acceleration). */
  raw = false;
  /** The page let go of the mouse last, which earns it one request without a click or key. */
  private letGo = false;
  private escDown = false;

  /** `rawSupported` is asked at each request: a mouse can be plugged in or pulled out between two. */
  constructor(private rawSupported: boolean | (() => boolean)) {}

  request(req: { raw: boolean; activation: boolean }): LockAnswer {
    if (req.raw && !(typeof this.rawSupported === 'function' ? this.rawSupported() : this.rawSupported)) return { ok: false, error: 'NotSupportedError' };
    const earned = this.letGo;
    // Asking uses up the leave, whatever comes of it.
    this.letGo = false;
    if (this.locked) return { ok: true, raw: this.raw };
    if (this.escDown || !(req.activation || earned)) return { ok: false, error: 'NotAllowedError' };
    this.locked = true;
    this.raw = req.raw;
    return { ok: true, raw: req.raw };
  }

  /** `document.exitPointerLock()`. True when that released the mouse. */
  pageExit(): boolean {
    if (!this.locked) return false;
    this.locked = false;
    this.letGo = true;
    return true;
  }

  /** The user (or the system) took the mouse away. True when it was held. */
  userExit(): boolean {
    this.letGo = false;
    if (!this.locked) return false;
    this.locked = false;
    return true;
  }

  /** Esc went down in the native view. True when it released the mouse. */
  escapeDown(): boolean {
    this.escDown = true;
    return this.userExit();
  }

  /** Esc came up in the native view, before the page sees it. */
  escapeUp() {
    this.escDown = false;
  }

  /** The page's own report of that Esc key up, once its handlers ran: a lock still held and a key the page did not take is released. */
  escapeUpSeenByPage(prevented: boolean): boolean {
    if (prevented) return false;
    return this.userExit();
  }

  windowBlurred(): boolean {
    this.escDown = false;
    return this.userExit();
  }
}
