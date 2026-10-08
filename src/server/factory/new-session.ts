import { FactoryError } from './api.js';

// Factory 404s a session it has just made for a few seconds before it can find it again. Polls
// cope by waiting (NEW_SESSION_GRACE_MS); a write someone asked for (change its settings, interrupt
// it, delete it) can't wait for the next poll, so it tries again a few times first.

/** A session made this recently (ms) may 404 only because Factory hasn't caught up with it yet. */
export const NEW_SESSION_MS = 30_000;
/** The waits between tries (ms): about ten seconds in all. */
export const NEW_SESSION_BACKOFF_MS: readonly number[] = [1000, 2000, 3000, 4000];

export interface NewSessionOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  backoff?: readonly number[];
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const isMissing = (err: unknown) => err instanceof FactoryError && err.status === 404;

/** Whether a session made at `madeAt` is still in the moments Factory may not find it. */
export const isNew = (madeAt: number | undefined, now: number) => madeAt !== undefined && madeAt > 0 && now - madeAt < NEW_SESSION_MS;

/**
 * Whether a failed write means the session is gone already: a 404 for one that was past its first
 * moments when the write was asked for (`askedAt`, before whileNew's tries).
 */
export const alreadyGone = (err: unknown, madeAt: number | undefined, askedAt: number) => isMissing(err) && !isNew(madeAt, askedAt);

/**
 * Runs `call` against a session made at `madeAt` (ms; undefined when the office doesn't know). A 404
 * while the session is younger than NEW_SESSION_MS is tried again after each wait of the backoff;
 * any other failure, a 404 for an older session, and the last 404 go through as they came.
 */
export async function whileNew<T>(madeAt: number | undefined, call: () => Promise<T>, opts: NewSessionOptions = {}): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? pause;
  const backoff = opts.backoff ?? NEW_SESSION_BACKOFF_MS;
  let young: boolean | undefined;
  for (let i = 0; ; i++) {
    try {
      return await call();
    } catch (err) {
      // How old it is counts at the first 404: one made 25 s ago still gets every try.
      young ??= isNew(madeAt, now());
      if (!isMissing(err) || !young || i >= backoff.length) throw err;
      await sleep(backoff[i]);
    }
  }
}
