import test from 'node:test';
import assert from 'node:assert/strict';
import { GRAPHICS_DEFAULTS, gpuBusy, halton, jitterAt, jitterPhases, normalizeGraphics, normalizeScale, renderSize, statsText } from '../src/client/graphics.js';
import { parseIoreg } from '../src/server/gpu-stats.js';

test('graphics settings default to native resolution with MSAA and the overlay on', () => {
  assert.deepEqual(normalizeGraphics(undefined), GRAPHICS_DEFAULTS);
  assert.deepEqual(GRAPHICS_DEFAULTS, { scale: 1, taa: false, sharpen: 0.5, shadows: 'smart', stats: true });
});

test('saved graphics settings are clamped and snapped, bad values fall back', () => {
  assert.deepEqual(normalizeGraphics({ scale: 0.72, taa: true, sharpen: 3, shadows: 'off', stats: false }), { scale: 0.7, taa: true, sharpen: 1, shadows: 'off', stats: false });
  assert.equal(normalizeGraphics({ shadows: 'live' }).shadows, 'live');
  assert.equal(normalizeGraphics({ scale: 0.1 }).scale, 0.5);
  assert.equal(normalizeGraphics({ scale: 4 }).scale, 1);
  assert.deepEqual(normalizeGraphics({ scale: 'big', taa: 1, sharpen: Number.NaN, shadows: 'soft', stats: 'yes' }), GRAPHICS_DEFAULTS);
  assert.equal(normalizeScale(0.775), 0.8);
});

test('the render target is the drawing buffer times the scale, never empty', () => {
  assert.deepEqual(renderSize(2880, 1800, 0.7), { width: 2016, height: 1260 });
  assert.deepEqual(renderSize(2880, 1800, 1), { width: 2880, height: 1800 });
  assert.deepEqual(renderSize(1, 1, 0.5), { width: 1, height: 1 });
});

test('jitter walks a Halton (2, 3) cycle inside the pixel, longer at lower scales', () => {
  assert.equal(halton(1, 2), 0.5);
  assert.equal(halton(2, 2), 0.25);
  assert.equal(halton(3, 2), 0.75);
  assert.ok(Math.abs(halton(1, 3) - 1 / 3) < 1e-12);
  assert.equal(jitterPhases(1), 8);
  assert.equal(jitterPhases(0.5), 32);
  assert.equal(jitterPhases(0.7), 17);
  const seen = new Set<string>();
  for (let f = 0; f < 8; f++) {
    const j = jitterAt(f, 1);
    assert.ok(j.x >= -0.5 && j.x < 0.5 && j.y >= -0.5 && j.y < 0.5);
    seen.add(`${j.x},${j.y}`);
  }
  assert.equal(seen.size, 8);
  assert.deepEqual(jitterAt(8, 1), jitterAt(0, 1));
  // Never the pixel centre on both axes, which index 0 would give every cycle.
  assert.notDeepEqual(jitterAt(0, 1), { x: -0.5, y: -0.5 });
});

test('GPU busy is the share of wall time spent on GPU work, capped at 100%', () => {
  assert.equal(gpuBusy(250, 500), 0.5);
  assert.equal(gpuBusy(900, 500), 1);
  assert.equal(gpuBusy(10, 0), 0);
});

test('the overlay names fps, GPU time, the Mac GPU, how the scene is drawn and its shadows', () => {
  const base = { fps: 119.6, frameMs: 8.36, render: { width: 2016, height: 1260 }, output: { width: 2880, height: 1800 }, shadows: { mode: 'smart' as const, redrawn: 0.04 } };
  assert.equal(
    statsText({ ...base, gpu: { ms: 3.214, busy: 0.384 }, system: 52, scale: 0.7, taa: true }),
    ['120 FPS · 8.4 ms', 'GPU 3.21 ms/frame · 38% busy', 'Mac GPU 52%', '70% 2016×1260 → 2880×1800 · TAAU', 'Shadows smart · redrawn 4% of frames'].join('\n'),
  );
  assert.equal(
    statsText({ ...base, render: base.output, gpu: null, gpuNote: 'timing unavailable in this browser', system: null, scale: 1, taa: false, shadows: { mode: 'live', redrawn: 1 } }),
    ['120 FPS · 8.4 ms', 'GPU timing unavailable in this browser', '100% 2880×1800 · MSAA', 'Shadows live · redrawn 100% of frames'].join('\n'),
  );
  assert.match(statsText({ ...base, gpu: null, system: null, scale: 1, taa: true }), /· TAA\n/);
  assert.match(statsText({ ...base, gpu: null, system: null, scale: 0.5, taa: false }), /· bilinear\n/);
  assert.match(statsText({ ...base, gpu: null, system: null, scale: 1, taa: false, shadows: { mode: 'off', redrawn: 0 } }), /\nShadows off$/);
});

test('ioreg output gives the busiest GPU', () => {
  const one = '"PerformanceStatistics" = {"In use system memory (driver)"=0,"Tiler Utilization %"=12,"Renderer Utilization %"=47,"Device Utilization %"=49,"SplitSceneCount"=0}';
  assert.deepEqual(parseIoreg(one), { device: 49, renderer: 47, tiler: 12 });
  const two = `${one}\n"PerformanceStatistics" = {"Device Utilization %"=80}`;
  assert.deepEqual(parseIoreg(two), { device: 80, renderer: 80, tiler: 0 });
  assert.equal(parseIoreg(''), null);
  assert.equal(parseIoreg('"PerformanceStatistics" = {"recoveryCount"=0}'), null);
});
