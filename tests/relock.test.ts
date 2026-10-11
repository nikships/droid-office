import assert from 'node:assert/strict';
import test from 'node:test';
import { RELOCK_JUMP, RELOCK_JUMP_FOR, SETTLE_MAX, SETTLE_REST, idleRelock, relockAt, takeRelockMove } from '../src/client/player.js';

const t0 = 10_000;

test('a click relock holds follow-through, then looks once the hand rests', () => {
  const held = takeRelockMove(relockAt(t0), { dx: 4, dy: 6, now: t0 + 20, rested: 20 });
  assert.equal(held.look, false);
  assert.equal(held.relock.settleUntil, t0 + SETTLE_MAX);

  const rested = takeRelockMove(held.relock, { dx: 4, dy: 6, now: t0 + SETTLE_REST + 20, rested: SETTLE_REST + 20 });
  assert.equal(rested.look, true);
  assert.equal(rested.relock.settleUntil, 0);
  assert.equal(rested.relock.jumpUntil, t0 + RELOCK_JUMP_FOR);
});

test('one warp from a higher menu is dropped after the hand has rested, and the next move looks', () => {
  const warp = takeRelockMove(relockAt(t0), { dx: 12, dy: -320, now: t0 + SETTLE_REST + 20, rested: SETTLE_REST + 20 });
  assert.equal(warp.look, false);
  assert.equal(warp.relock.jumpUntil, 0);

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

test('a warp that arrives after the follow-through cap is still dropped, until the jump window passes', () => {
  const late = takeRelockMove(relockAt(t0), { dx: 0, dy: 240, now: t0 + SETTLE_MAX + 20, rested: SETTLE_MAX + 20 });
  assert.equal(late.look, false);

  const after = takeRelockMove(relockAt(t0), { dx: 0, dy: 240, now: t0 + RELOCK_JUMP_FOR, rested: RELOCK_JUMP_FOR });
  assert.equal(after.look, true);
  assert.equal(after.relock.jumpUntil, 0);
});

test('a move just under the warp, and any move with no relock, looks', () => {
  const under = takeRelockMove(relockAt(t0), { dx: 0, dy: -(RELOCK_JUMP - 1), now: t0 + SETTLE_REST + 20, rested: SETTLE_REST + 20 });
  assert.equal(under.look, true);
  assert.equal(takeRelockMove(idleRelock(), { dx: 0, dy: -400, now: t0, rested: 0 }).look, true);
});
