import { throwOk, type BallState } from '../shared/hoop.js';

/** How often one person can pick the ball up, at most (ms): and so throw it, as it has to be in their hands. */
const EVERY = 150;

/**
 * A floor's basketball: whether it's held, or how it was last thrown. The office only keeps track
 * of that much; each page flies the ball from the throw itself (see shared/hoop.ts), so where it
 * lands is the same everywhere without the office working it out. Internally the holder key is the
 * connection id, so one connection's take, throw and leave stay precise.
 */
export class Court {
  private holder: string | undefined;
  private shot: { x: number; y: number; z: number; vx: number; vy: number; vz: number; at: number } | undefined;
  private last = new Map<string, number>();

  constructor(private now = () => Date.now()) {}

  /** The ball as it is now, for the floor's pages: held or not, never by whom. */
  state(): BallState {
    if (this.holder) return { held: true };
    if (!this.shot) return {};
    const { at, ...s } = this.shot;
    return { shot: { ...s, elapsed: Math.max(0, this.now() - at) } };
  }

  /** `id` picks the ball up (or catches it): only if it isn't held. Says whether anything changed. */
  take(id: string): boolean {
    if (this.holder || this.tooSoon(id)) return false;
    this.holder = id;
    this.shot = undefined;
    return true;
  }

  /** `id` throws the ball they have (or drops it, slowly). Says whether anything changed. */
  throw(id: string, s: { x: number; y: number; z: number; vx: number; vy: number; vz: number }): boolean {
    if (this.holder !== id || !throwOk(s)) return false;
    this.holder = undefined;
    this.shot = { x: s.x, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz, at: this.now() };
    return true;
  }

  /** `id` left the floor (or the office): the ball in their hands goes back under the hoop. Says whether it did. */
  left(id: string): boolean {
    this.last.delete(id);
    if (this.holder !== id) return false;
    this.holder = undefined;
    this.shot = undefined;
    return true;
  }

  private tooSoon(id: string): boolean {
    const now = this.now();
    if (now - (this.last.get(id) ?? -Infinity) < EVERY) return true;
    this.last.set(id, now);
    return false;
  }
}
