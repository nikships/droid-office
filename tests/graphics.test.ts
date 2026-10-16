import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FPS_CAPS,
  GRAPHICS_DEFAULTS,
  LOOK_SENSITIVITY_MAX,
  LOOK_SENSITIVITY_MIN,
  normalizeLookSensitivity,
  gpuBusy,
  halton,
  jitterAt,
  jitterPhases,
  normalizeGraphics,
  normalizeOverhead,
  normalizeScale,
  renderSize,
  statsText,
} from '../src/client/graphics.js';
import { parseIoreg } from '../src/server/gpu-stats.js';

test('graphics settings default to native resolution with MSAA and the overlay on', () => {
  assert.deepEqual(normalizeGraphics(undefined), GRAPHICS_DEFAULTS);
  assert.deepEqual(GRAPHICS_DEFAULTS, { scale: 1, taa: false, sharpen: 0.5, overhead: 1, fpsCap: 120, stats: true, rawMouse: false, lookSensitivity: 1 });
});

test('saved graphics settings are clamped and snapped, bad values fall back', () => {
  // A shadow mode saved before shadows were taken out is dropped.
  assert.deepEqual(normalizeGraphics({ scale: 0.72, taa: true, sharpen: 3, shadows: 'off', overhead: 0.42, fpsCap: 60, stats: false }), {
    scale: 0.7,
    taa: true,
    sharpen: 1,
    overhead: 0.4,
    fpsCap: 60,
    stats: false,
    rawMouse: false,
    lookSensitivity: 1,
  });
  assert.ok(!('shadows' in normalizeGraphics({ shadows: 'live' })));
  assert.equal(normalizeGraphics({ scale: 0.1 }).scale, 0.5);
  assert.equal(normalizeGraphics({ scale: 4 }).scale, 1);
  assert.deepEqual(normalizeGraphics({ scale: 'big', taa: 1, sharpen: Number.NaN, shadows: 'soft', overhead: '50%', fpsCap: 144, stats: 'yes', rawMouse: 'on', lookSensitivity: '2x' }), GRAPHICS_DEFAULTS);
  assert.equal(normalizeGraphics({ rawMouse: true }).rawMouse, true);
  assert.equal(normalizeScale(0.775), 0.8);
});

test('look sensitivity is kept from 0.1× to 3× in steps of 0.05', () => {
  assert.equal(normalizeGraphics({ lookSensitivity: 0.5 }).lookSensitivity, 0.5);
  assert.equal(normalizeGraphics({ lookSensitivity: 2.37 }).lookSensitivity, 2.35);
  assert.equal(normalizeGraphics({ lookSensitivity: 0 }).lookSensitivity, LOOK_SENSITIVITY_MIN);
  assert.equal(normalizeGraphics({ lookSensitivity: 10 }).lookSensitivity, LOOK_SENSITIVITY_MAX);
  assert.equal(normalizeGraphics({ lookSensitivity: Number.NaN }).lookSensitivity, 1);
  assert.equal(normalizeGraphics({ lookSensitivity: Number.POSITIVE_INFINITY }).lookSensitivity, 1);
  assert.equal(normalizeLookSensitivity(0.35), 0.35);
  assert.equal(normalizeLookSensitivity(1.024), 1);
});

test('the overhead lights go from off to as built, in 5% steps', () => {
  assert.equal(normalizeGraphics({ overhead: 0 }).overhead, 0);
  assert.equal(normalizeGraphics({ overhead: -1 }).overhead, 0);
  assert.equal(normalizeGraphics({ overhead: 2 }).overhead, 1);
  assert.equal(normalizeGraphics({ overhead: Number.NaN }).overhead, 1);
  assert.equal(normalizeOverhead(0.37), 0.35);
  assert.equal(normalizeOverhead(0.7), 0.7);
});

test('the frame rate limit is 40, 60 or 120, and anything else saved is 120', () => {
  assert.deepEqual(FPS_CAPS, [40, 60, 120]);
  for (const fps of FPS_CAPS) assert.equal(normalizeGraphics({ fpsCap: fps }).fpsCap, fps);
  for (const bad of [undefined, null, 0, 30, 59.9, 144, 240, Number.POSITIVE_INFINITY, '60', 'unlimited']) assert.equal(normalizeGraphics({ fpsCap: bad }).fpsCap, 120, String(bad));
  assert.equal(normalizeGraphics({}).fpsCap, 120);
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

test('the overlay names fps, GPU time, the Mac GPU and how the scene is drawn', () => {
  const base = { fps: 119.6, frameMs: 8.36, fpsCap: 120 as const, render: { width: 2016, height: 1260 }, output: { width: 2880, height: 1800 } };
  assert.equal(statsText({ ...base, gpu: { ms: 3.214, busy: 0.384 }, system: 52, scale: 0.7, taa: true }), ['120 FPS · cap 120 · 8.4 ms', 'GPU 3.21 ms/frame · 38% busy', 'Mac GPU 52%', '70% 2016×1260 → 2880×1800 · TAAU'].join('\n'));
  assert.equal(
    statsText({ ...base, render: base.output, gpu: null, gpuNote: 'timing unavailable in this browser', system: null, scale: 1, taa: false }),
    ['120 FPS · cap 120 · 8.4 ms', 'GPU timing unavailable in this browser', '100% 2880×1800 · MSAA'].join('\n'),
  );
  assert.match(statsText({ ...base, gpu: null, system: null, scale: 1, taa: true }), /· TAA$/);
  assert.match(statsText({ ...base, fps: 59.8, fpsCap: 60, gpu: null, system: null, scale: 1, taa: false }), /^60 FPS · cap 60 · /);
  assert.match(statsText({ ...base, gpu: null, system: null, scale: 0.5, taa: false }), /· bilinear$/);
  assert.equal(statsText({ ...base, pacing: 'p50 8.3 · p95 8.4 · p99 9.0 ms · 0 missed · 0 repeated', gpu: null, system: null, scale: 1, taa: false }).split('\n')[1], 'p50 8.3 · p95 8.4 · p99 9.0 ms · 0 missed · 0 repeated');
});

test('ioreg output gives the busiest GPU', () => {
  const one = '"PerformanceStatistics" = {"In use system memory (driver)"=0,"Tiler Utilization %"=12,"Renderer Utilization %"=47,"Device Utilization %"=49,"SplitSceneCount"=0}';
  assert.deepEqual(parseIoreg(one), { device: 49, renderer: 47, tiler: 12 });
  const two = `${one}\n"PerformanceStatistics" = {"Device Utilization %"=80}`;
  assert.deepEqual(parseIoreg(two), { device: 80, renderer: 80, tiler: 0 });
  assert.equal(parseIoreg(''), null);
  assert.equal(parseIoreg('"PerformanceStatistics" = {"recoveryCount"=0}'), null);
});
