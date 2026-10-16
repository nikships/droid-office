/** A tap fires normally; holding for three quarters of a second arms one super shot on release. */
export const SHOT_CHARGE_MS = 750;
export const SHOT_CHARGE_PREVIEW_MS = 120;

export class SidearmCharge {
  private since: number | null = null;

  get held(): boolean {
    return this.since !== null;
  }

  begin(now: number): boolean {
    if (this.held) return false;
    this.since = now;
    return true;
  }

  elapsed(now: number): number {
    return this.since === null ? 0 : Math.max(0, now - this.since);
  }

  progress(now: number): number {
    return Math.min(1, this.elapsed(now) / SHOT_CHARGE_MS);
  }

  release(now: number): { superShot: boolean } | null {
    if (!this.held) return null;
    const superShot = this.progress(now) === 1;
    this.cancel();
    return { superShot };
  }

  cancel() {
    this.since = null;
  }
}
