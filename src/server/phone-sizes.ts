export interface TermDims {
  cols: number;
  rows: number;
}

const same = (a: TermDims, b: TermDims) => a.cols === b.cols && a.rows === b.rows;

/**
 * The terminal sizes one phone connection set, and what each terminal was before its first one. A
 * phone restores the size itself when it leaves a terminal; this covers a phone that drops off
 * without doing that (out of range, the app killed), so the desktop isn't left at the phone's size.
 */
export class PhoneSizes {
  private sized = new Map<string, { before: TermDims; set: TermDims }>();

  /** The phone resized `workerId` from `before` to `after` (after the office's clamping). */
  resized(workerId: string, before: TermDims, after: TermDims) {
    const first = this.sized.get(workerId)?.before ?? before;
    if (same(first, after)) this.sized.delete(workerId);
    else this.sized.set(workerId, { before: first, set: after });
  }

  /**
   * What to put back once the phone is gone: each terminal still at the size the phone last set.
   * One another window has resized since is left alone.
   */
  restores(current: (workerId: string) => TermDims | undefined): { workerId: string; size: TermDims }[] {
    const out: { workerId: string; size: TermDims }[] = [];
    for (const [workerId, { before, set }] of this.sized) {
      const now = current(workerId);
      if (now && same(now, set)) out.push({ workerId, size: before });
    }
    this.sized.clear();
    return out;
  }
}
