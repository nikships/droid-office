import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPILE_HOLD_MS, COMPILE_STALL_MS, DONE_HOLD_MS, WarmupWatch } from '../src/client/warmup.js';

const frame = (now: number, over: { programs?: number; drawMs?: number; bake?: number | null } = {}) => ({
  now,
  programs: over.programs ?? 10,
  drawMs: over.drawMs ?? 5,
  bake: over.bake ?? null,
});

test('a quiet office shows nothing', () => {
  const w = new WarmupWatch();
  assert.equal(w.update(frame(0, { programs: 10, drawMs: 4 })), null);
  assert.equal(w.update(frame(16)), null);
  assert.equal(w.showing, false);
});

test('a new material that compiles quickly says nothing', () => {
  const w = new WarmupWatch();
  w.update(frame(0, { programs: 10, drawMs: 4 }));
  assert.equal(w.update(frame(16, { programs: 11, drawMs: COMPILE_STALL_MS - 1 })), null);
});

test('a frame stalled on new programs says shaders are compiling, with no percent, then goes', () => {
  const w = new WarmupWatch();
  w.update(frame(0, { programs: 10, drawMs: 4 }));
  const s = w.update(frame(16, { programs: 14, drawMs: 120 }));
  assert.deepEqual(s, { say: 'Compiling shaders', progress: null, done: false });
  assert.equal(w.update(frame(16 + COMPILE_HOLD_MS - 1, { programs: 14 }))?.say, 'Compiling shaders');
  const done = w.update(frame(16 + COMPILE_HOLD_MS, { programs: 14 }));
  assert.deepEqual(done, { say: 'Shaders ready', progress: 1, done: true });
  assert.ok(w.showing);
  assert.equal(w.update(frame(16 + COMPILE_HOLD_MS + DONE_HOLD_MS, { programs: 14 })), null);
  assert.equal(w.showing, false);
});

test('a slow frame with no new programs is not a compile', () => {
  const w = new WarmupWatch();
  w.update(frame(0, { programs: 10 }));
  assert.equal(w.update(frame(16, { programs: 10, drawMs: 200 })), null);
});

test('the first frame, which compiles everything, counts', () => {
  const w = new WarmupWatch();
  assert.equal(w.update(frame(0, { programs: 40, drawMs: 400 }))?.say, 'Compiling shaders');
});

test('a bake shows how far through it is, clamped, then says it is baked', () => {
  const w = new WarmupWatch();
  assert.deepEqual(w.update(frame(0, { bake: 0.42 })), { say: 'Baking light', progress: 0.42, done: false });
  assert.equal(w.update(frame(16, { bake: 1.3 }))?.progress, 1);
  assert.equal(w.update(frame(32, { bake: -1 }))?.progress, 0);
  assert.deepEqual(w.update(frame(48)), { say: 'Light baked', progress: 1, done: true });
  assert.equal(w.update(frame(32 + DONE_HOLD_MS - 1))?.say, 'Light baked');
  assert.equal(w.update(frame(32 + DONE_HOLD_MS)), null);
});

test('a compile during a bake says both and keeps the bake percent', () => {
  const w = new WarmupWatch();
  w.update(frame(0, { programs: 10, bake: 0.1 }));
  assert.deepEqual(w.update(frame(16, { programs: 12, drawMs: 90, bake: 0.2 })), {
    say: 'Compiling shaders · baking light',
    progress: 0.2,
    done: false,
  });
});
