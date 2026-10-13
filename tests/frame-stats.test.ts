import test from 'node:test';
import assert from 'node:assert/strict';
import { extraRefreshes, FrameStats, type FrameSample, pacingText, percentile, spread } from '../src/client/frame-stats.js';

const R120 = 1000 / 120;
const R60 = 1000 / 60;
const cpu = { update: 1, scene: 3, hands: 0.5 };

/** Paced frames at `gaps` (ms) apart from t=1000. */
function frames(gaps: number[], paced = true): FrameSample[] {
  let at = 1000;
  const out: FrameSample[] = [{ at, paced, cpu }];
  for (const g of gaps) {
    at += g;
    out.push({ at, paced, cpu });
  }
  return out;
}

test('percentiles pick the nearest rank, and an empty list is all zeros', () => {
  const s = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(s, 50), 50);
  assert.equal(percentile(s, 95), 95);
  assert.equal(percentile(s, 99), 99);
  assert.equal(percentile(s, 100), 100);
  assert.equal(percentile([], 50), 0);
  assert.deepEqual(spread([3, 1, 2]), { p50: 2, p95: 3, p99: 3, max: 3 });
  assert.deepEqual(spread([]), { p50: 0, p95: 0, p99: 0, max: 0 });
});

test('a frame on its slot costs no extra refresh at any limit the office offers', () => {
  // 120 Hz: 120 is every refresh, 60 every 2nd, 40 every 3rd.
  assert.equal(extraRefreshes(R120, 1000 / 120, R120), 0);
  assert.equal(extraRefreshes(2 * R120, 1000 / 60, R120), 0);
  assert.equal(extraRefreshes(3 * R120, 1000 / 40, R120), 0);
  // 60 Hz under a 40 FPS limit alternates one and two refreshes: neither is a repeat.
  assert.equal(extraRefreshes(R60, 1000 / 40, R60), 0);
  assert.equal(extraRefreshes(2 * R60, 1000 / 40, R60), 0);
  // A limit above the display's rate draws every refresh.
  assert.equal(extraRefreshes(R60, 1000 / 120, R60), 0);
  // Timestamp jitter under half a refresh is still on time.
  assert.equal(extraRefreshes(R120 + 3, 1000 / 120, R120), 0);
});

test('a late frame counts each refresh the one before it stayed up again', () => {
  assert.equal(extraRefreshes(2 * R120, 1000 / 120, R120), 1);
  assert.equal(extraRefreshes(5 * R120, 1000 / 120, R120), 4);
  assert.equal(extraRefreshes(3 * R120, 1000 / 60, R120), 1);
  assert.equal(extraRefreshes(3 * R60, 1000 / 40, R60), 1);
  assert.equal(extraRefreshes(100, 1000 / 120, 0), 0, 'no refresh measured yet: nothing to count against');
});

test('the report counts missed frames and repeated refreshes at 120 FPS on 120 Hz', () => {
  const stats = new FrameStats();
  // 97 frames on time, one that took two refreshes and one that took four.
  for (const s of frames([...Array(97).fill(R120), 2 * R120, 4 * R120])) stats.record(s);
  const r = stats.report({ fpsCap: 120, refreshMs: R120 });
  assert.equal(r.frames, 99);
  assert.equal(r.missed, 2);
  assert.equal(r.repeated, 1 + 3);
  assert.equal(Math.round(r.refreshHz), 120);
  assert.ok(Math.abs(r.frameTime.p50 - R120) < 1e-9);
  assert.ok(Math.abs(r.frameTime.p95 - R120) < 1e-9);
  // The 99th of 99 gaps is the worst one.
  assert.ok(Math.abs(r.frameTime.p99 - 4 * R120) < 1e-9);
  assert.ok(Math.abs(r.frameTime.max - 4 * R120) < 1e-9);
  assert.ok(r.fps > 115 && r.fps < 120);
  assert.deepEqual(r.cpu.total, { p50: 4.5, p95: 4.5, p99: 4.5, max: 4.5 });
  assert.deepEqual(r.cpu.scene, { p50: 3, p95: 3, p99: 3, max: 3 });
  assert.deepEqual(r.gpu, { scene: null, hands: null });
  assert.equal(pacingText(r), 'p50 8.3 · p95 8.3 · p99 33.3 ms · 2 missed · 4 repeated');
});

test('idle and wake draws break the chain instead of counting as missed frames', () => {
  const stats = new FrameStats();
  for (const s of frames([R120, R120])) stats.record(s);
  // An idle draw 500 ms later, then the loop picks up at full rate again.
  stats.record({ at: 1500, paced: false, cpu });
  stats.record({ at: 1500 + R120, paced: true, cpu });
  stats.record({ at: 1500 + 2 * R120, paced: true, cpu });
  const r = stats.report({ fpsCap: 120, refreshMs: R120 });
  assert.equal(r.frames, 3);
  assert.equal(r.missed, 0);
  assert.equal(r.repeated, 0);
});

test('a report since a time leaves out the frames before it, and reset starts over', () => {
  const stats = new FrameStats();
  for (const s of frames(Array(10).fill(2 * R120))) stats.record(s);
  assert.equal(stats.report({ fpsCap: 60, refreshMs: R120, since: 1000 + 5 * 2 * R120 }).frames, 5);
  const gpu = { scene: 2.5, hands: 0.25 };
  assert.deepEqual(stats.report({ fpsCap: 60, refreshMs: R120, gpu }).gpu, gpu);
  stats.reset();
  const r = stats.report({ fpsCap: 60, refreshMs: R120 });
  assert.equal(r.frames, 0);
  assert.equal(r.fps, 0);
  assert.equal(r.missed, 0);
});

test('only about the last minute at 120 FPS is kept', () => {
  const stats = new FrameStats();
  for (const s of frames(Array(8000).fill(R120))) stats.record(s);
  assert.equal(stats.report({ fpsCap: 120, refreshMs: R120 }).frames, 7199);
});
