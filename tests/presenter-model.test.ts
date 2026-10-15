import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layerPixelFormat, presentMode, type NativeStats, osrFrameRate, osrPixelFormat, pageSize, SAMPLE_STRIDE, spread, summarizeNativeStats, TextureLedger } from '../src/desktop/presenter-model.js';

test('the page renders float16 only when a screen can show brighter than white', () => {
  assert.equal(osrPixelFormat(true), 'rgbaf16');
  assert.equal(osrPixelFormat(false), 'argb');
  assert.equal(layerPixelFormat('rgbaf16'), 'rgbaf16');
  assert.equal(layerPixelFormat('argb'), 'bgra');
});

test('the offscreen frame rate follows the display within the office range', () => {
  assert.equal(osrFrameRate(120), 120);
  assert.equal(osrFrameRate(60), 60);
  assert.equal(osrFrameRate(59.94), 60);
  assert.equal(osrFrameRate(240), 120);
  assert.equal(osrFrameRate(10), 30);
  assert.equal(osrFrameRate(0), 60);
  assert.equal(osrFrameRate(undefined), 60);
  assert.equal(osrFrameRate(Number.NaN), 60);
});

test('the page takes the window content size, never smaller than a pixel', () => {
  assert.deepEqual(pageSize({ width: 1440.4, height: 868.6 }), { width: 1440, height: 869 });
  assert.deepEqual(pageSize({ width: 0, height: -3 }), { width: 1, height: 1 });
});

test('the texture ledger releases each texture once and only when asked', () => {
  const released: string[] = [];
  const texture = (name: string) => ({ release: () => released.push(name) });
  const ledger = new TextureLedger();
  const a = ledger.hold(texture('a'));
  const b = ledger.hold(texture('b'));
  const c = ledger.hold(texture('c'));
  assert.equal(ledger.size, 3);
  assert.equal(ledger.release(b), true);
  assert.equal(ledger.release(b), false);
  assert.equal(ledger.release(999), false);
  assert.deepEqual(released, ['b']);
  ledger.releaseAll();
  assert.deepEqual(released.sort(), ['a', 'b', 'c']);
  assert.equal(ledger.size, 0);
  assert.equal(ledger.release(a), false);
  assert.equal(ledger.release(c), false);
});

test('spread takes percentiles of a sorted copy', () => {
  assert.deepEqual(spread([]), { p50: 0, p95: 0, p99: 0, max: 0 });
  const values = Array.from({ length: 100 }, (_, i) => 100 - i);
  assert.deepEqual(spread(values), { p50: 50, p95: 95, p99: 99, max: 100 });
  assert.equal(values[0], 100);
});

function stats(samples: number[][], extra: Partial<NativeStats> = {}): NativeStats {
  return {
    submitted: samples.length + 2,
    dropped: 2,
    presented: samples.length,
    notShown: 0,
    ticks: samples.length * 2,
    ticksWithFrame: samples.length,
    importFailures: 0,
    released: samples.length,
    inFlight: 0,
    maxInFlight: 2,
    now: 0,
    samples: samples.flat(),
    ...extra,
  };
}

test('presenter stats report intervals, latency, waits and GPU time per presented frame', () => {
  const planned = 1000 / 120;
  const refresh = planned / 1000;
  // id, submittedAt, tickAt, target, presentedAt (s), gpuMs: frames each one refresh apart, one that slipped two refreshes, one shown right behind another.
  const rows = [
    [1, 10.0, 10.004, 10.008, 10.0083, 0.3],
    [2, 10.0083, 10.0125, 10.0167, 10.0167, 0.4],
    [3, 10.0167, 10.0208, 10.025, 10.025, 0.5],
    [4, 10.0333, 10.0375, 10.0417, 10.0417 + refresh, 0.6],
    [5, 10.0417, 10.0458, 10.05, 10.0501, 0.2],
  ];
  assert.equal(rows[0]!.length, SAMPLE_STRIDE);
  const report = summarizeNativeStats(stats(rows), planned);
  assert.equal(report.presented, 5);
  assert.equal(report.dropped, 2);
  assert.equal(report.submitted, 7);
  assert.equal(report.maxInFlight, 2);
  assert.equal(report.plannedMs, planned);
  assert.equal(report.late, 1);
  assert.equal(report.early, 1);
  assert.ok(Math.abs(report.latency.p50 - 8.3) < 0.2, `latency p50 ${report.latency.p50}`);
  assert.ok(report.wait.max > 4 && report.wait.max < 4.5);
  assert.equal(report.gpu.max, 0.6);
  assert.ok(report.fps > 90 && report.fps < 140, `fps ${report.fps}`);
  assert.equal(report.interval.max > planned * 1.5, true);
});

test('presenter stats on an empty ring are zeros, and one frame has no interval yet', () => {
  const empty = summarizeNativeStats(stats([]), 8.3);
  assert.equal(empty.fps, 0);
  assert.deepEqual(empty.interval, { p50: 0, p95: 0, p99: 0, max: 0 });
  const one = summarizeNativeStats(stats([[1, 1, 1.002, 1.008, 1.009, 0.3]]), 8.3);
  assert.equal(one.fps, 0);
  assert.equal(one.late, 0);
  assert.ok(Math.abs(one.latency.p50 - 9) < 0.01);
});

test('the present mode is paced unless a comparison asks for another', () => {
  assert.equal(presentMode({}), 'paced');
  assert.equal(presentMode({ DROID_OFFICE_PRESENT_MODE: 'link' }), 'link');
  assert.equal(presentMode({ DROID_OFFICE_PRESENT_MODE: 'direct' }), 'direct');
  assert.equal(presentMode({ DROID_OFFICE_PRESENT_MODE: 'bogus' }), 'paced');
});
