import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCK_WARP_MS, LOCK_WARP_PX, SETTLE_MAX, SETTLE_REST, idleRelock, lockWarp, relockAt, takeRelockMove } from '../src/client/player.js';

const t0 = 10_000;

test('a click relock holds follow-through, then looks once the hand rests', () => {
  const held = takeRelockMove(relockAt(t0), { dx: 4, dy: 6, now: t0 + 20, rested: 20 });
  assert.equal(held.look, false);
  assert.equal(held.relock.settleUntil, t0 + SETTLE_MAX);

  const rested = takeRelockMove(held.relock, { dx: 4, dy: 6, now: t0 + SETTLE_REST + 20, rested: SETTLE_REST + 20 });
  assert.equal(rested.look, true);
  assert.equal(rested.relock.settleUntil, 0);
  assert.equal(takeRelockMove(rested.relock, { dx: 200, dy: 0, now: t0 + 200, rested: 80 }).look, true, 'later deliberate flicks are not mistaken for a warp');
});

test('one warp from a higher menu is dropped after the hand has rested, and the next move looks', () => {
  const warp = takeRelockMove(relockAt(t0), { dx: 12, dy: -320, now: t0 + SETTLE_REST + 20, rested: SETTLE_REST + 20 });
  assert.equal(warp.look, false);
  const next = takeRelockMove(warp.relock, { dx: 10, dy: -6, now: t0 + SETTLE_REST + 40, rested: SETTLE_REST });
  assert.equal(next.look, true);
});

test('a warp during the follow-through is the one that is dropped, so a later flick still looks', () => {
  const warp = takeRelockMove(relockAt(t0), { dx: 0, dy: -400, now: t0 + 15, rested: 15 });
  assert.equal(warp.look, false);
  assert.ok(warp.relock.settleUntil > t0 + 15);

  const flick = takeRelockMove(warp.relock, { dx: 0, dy: -200, now: t0 + SETTLE_REST + 30, rested: SETTLE_REST + 15 });
  assert.equal(flick.look, true);
});

test('the first movement is rebased even after waiting several seconds, at any size', () => {
  for (const delay of [SETTLE_MAX + 20, 500, 1000, 10_000]) {
    for (const [dx, dy] of [
      [0, 240],
      [20, -30],
      [-1, 0],
    ]) {
      const first = takeRelockMove(relockAt(t0), { dx, dy, now: t0 + delay, rested: delay });
      assert.equal(first.look, false, `first move (${dx}, ${dy}) after ${delay} ms`);
      assert.equal(takeRelockMove(first.relock, { dx: 200, dy: 0, now: t0 + delay + 10, rested: 10 }).look, true);
    }
  }
});

test('zero-delta lock events do not consume the first movement guard', () => {
  const initial = relockAt(t0);
  const zero = takeRelockMove(initial, { dx: 0, dy: 0, now: t0 + 600, rested: 600 });
  assert.equal(zero.look, false);
  assert.deepEqual(zero.relock, initial);
  const first = takeRelockMove(zero.relock, { dx: 10, dy: 0, now: t0 + 2000, rested: 1400 });
  assert.equal(first.look, false);
  assert.equal(takeRelockMove(first.relock, { dx: 10, dy: 0, now: t0 + 2010, rested: 10 }).look, true);
});

test('continuous follow-through ends at the short cap, not a second later', () => {
  let relock = relockAt(t0);
  for (let elapsed = 10; elapsed < SETTLE_MAX; elapsed += 10) {
    const step = takeRelockMove(relock, { dx: 4, dy: 6, now: t0 + elapsed, rested: 10 });
    assert.equal(step.look, false);
    relock = step.relock;
  }
  assert.equal(takeRelockMove(relock, { dx: 4, dy: 6, now: t0 + SETTLE_MAX, rested: 10 }).look, true);
});

test('a normal lock has no first-movement guard', () => {
  assert.equal(takeRelockMove(idleRelock(), { dx: 0, dy: -400, now: t0, rested: 0 }).look, true);
  assert.equal(takeRelockMove(idleRelock(), { dx: 4, dy: 6, now: t0, rested: 0 }).look, true);
});

test('only right after a lock lands is a huge move taken for the cursor warping to the middle', () => {
  assert.equal(lockWarp(LOCK_WARP_PX + 1, 0, 0), true);
  assert.equal(lockWarp(0, -900, LOCK_WARP_MS - 1), true);
  assert.equal(lockWarp(LOCK_WARP_PX, LOCK_WARP_PX, 10), false, 'a move up to the limit is the hand');
  // Later, a fast flick passes whole instead of being clipped at 250.
  for (const dx of [251, 600, 1800, -2400]) assert.equal(lockWarp(dx, 0, LOCK_WARP_MS), false);
});
