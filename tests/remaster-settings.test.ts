import assert from 'node:assert/strict';
import test from 'node:test';
import { BAKE_BUDGET_MAX_MS, BAKE_FORMAT, bakeBudget, bakeKey, loadRemaster, normalizeRemaster, probeCount, REMASTER_DEFAULTS, REMASTER_KEY, resolveRemaster, saveRemaster, whiteBalance } from '../src/client/remaster-settings.js';

const near = (actual: number, expected: number, label: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} !~ ${expected}`);

test('a fresh install is Classic with HDR off', () => {
  assert.deepEqual(REMASTER_DEFAULTS, { enabled: false, hdr: false });
});

test('a save keeps only whether Remastered is on and whether HDR is on', () => {
  assert.deepEqual(normalizeRemaster(null), REMASTER_DEFAULTS);
  assert.deepEqual(normalizeRemaster('nope'), REMASTER_DEFAULTS);
  assert.deepEqual(normalizeRemaster({ enabled: true }), { enabled: true, hdr: false });
  assert.deepEqual(normalizeRemaster({ hdr: true, enabled: 'yes' }), { enabled: false, hdr: true });
  // A Graphics Lab mix, including the old quality presets, does not come back.
  const discarded = normalizeRemaster({
    enabled: true,
    hdr: false,
    resolution: 0.5,
    antiAliasing: 'high',
    giQuality: 'low',
    brightness: 'brighter',
    color: 'vivid',
    lights: 'neon',
    style: 'toon',
    sharpness: 'high',
    hdrHighlights: 'max',
    debug: 'gi',
    pace: 'full',
    preset: 'ultra',
  });
  assert.deepEqual(discarded, { enabled: true, hdr: false });
  assert.equal('resolution' in discarded, false);
  assert.equal('pace' in discarded, false);
});

test('Remastered always resolves to the locked picture, and HDR only opens the highlights', () => {
  const off = resolveRemaster(REMASTER_DEFAULTS);
  assert.equal(off.enabled, false);
  assert.equal(off.resolution, 1);
  assert.equal(off.msaa, 2);
  assert.equal(off.sharpen, 0);
  assert.equal(off.hdr, false);
  assert.equal(off.hdrPeak, 4);
  assert.equal(off.exposure, 1.25);
  assert.equal(off.gi, true);
  assert.equal(off.giSpacing, 1.4);
  assert.equal(off.giBounces, 2);
  assert.equal(off.saturation, 1);
  assert.equal(off.vibrance, 0);
  assert.equal(off.contrast, 1);
  assert.equal(off.temperature, 0);
  assert.equal(off.screenLight, 1);
  assert.equal(off.screenGlow, 1);
  assert.equal(off.toonRamp, 'smooth');
  assert.equal(off.outlines, false);
  assert.equal(off.debug, 'final');
  assert.equal(off.pace, 'adaptive');
  assert.equal(off.toneMap, 'linear');
  const on = resolveRemaster({ enabled: true, hdr: true });
  assert.equal(on.enabled, true);
  assert.equal(on.hdr, true);
  assert.equal(on.hdrPeak, 4);
  assert.equal(on.screenGlow, 1.6);
  assert.equal(on.resolution, off.resolution);
  assert.equal(on.giBounces, off.giBounces);
});

test('white balance keeps brightness and leans warm, cool, green or magenta', () => {
  assert.deepEqual(whiteBalance(0, 0), [1, 1, 1]);
  const warm = whiteBalance(1, 0);
  assert.ok(warm[0] > warm[2]);
  const cool = whiteBalance(-1, 0);
  assert.ok(cool[2] > cool[0]);
  const magenta = whiteBalance(0, 1);
  assert.ok(magenta[1] < magenta[0]);
  for (const w of [warm, cool, magenta, whiteBalance(5, -5)]) assert.ok(Math.abs(w[0] + w[1] + w[2] - 3) < 1e-9);
});

test('the bake key changes with HDR and the ceiling lights, and not with the grade', () => {
  const on = resolveRemaster({ enabled: true, hdr: false });
  const key = (p: ReturnType<typeof resolveRemaster>, overhead = 1, build = '0.1.900') => bakeKey(p, overhead, build);
  const base = key(on);
  assert.ok(base.startsWith(`gi${BAKE_FORMAT}|0.1.900|`));
  assert.equal(key(on), base);
  assert.notEqual(key(resolveRemaster({ enabled: true, hdr: true })), base);
  assert.notEqual(key(on, 0.5), base);
  assert.notEqual(key(on, 1, '0.1.901'), base);
  assert.equal(key(resolveRemaster(REMASTER_DEFAULTS)), '');
  assert.equal(key(on, 1, ''), '');
});

test('a probe grid has at least two probes along each side', () => {
  assert.equal(probeCount(0.5, 3), 2);
  assert.equal(probeCount(20, 2), 11);
});

test('settings round-trip through localStorage, and a broken save comes back as the defaults', (t) => {
  const mem = new Map<string, string>();
  const prev = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => mem.set(k, v),
    removeItem: (k: string) => mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  } as Storage;
  t.after(() => {
    globalThis.localStorage = prev;
  });
  saveRemaster({ enabled: true, hdr: true });
  assert.deepEqual(loadRemaster(), { enabled: true, hdr: true });
  mem.set(REMASTER_KEY, '{');
  assert.deepEqual(loadRemaster(), REMASTER_DEFAULTS);
});

test('a GI bake slice takes at most half a frame at the limit, and never more than 14 ms', () => {
  near(bakeBudget(120), 1000 / 120 / 2, '120 FPS');
  near(bakeBudget(60), 1000 / 60 / 2, '60 FPS');
  near(bakeBudget(40), 12.5, '40 FPS');
  assert.equal(bakeBudget(30), BAKE_BUDGET_MAX_MS);
  assert.equal(bakeBudget(0), BAKE_BUDGET_MAX_MS);
  assert.equal(bakeBudget(Number.NaN), BAKE_BUDGET_MAX_MS);
  near(bakeBudget(120, 1000 / 60), 1000 / 60 / 2, '120 FPS on 60 Hz');
  near(bakeBudget(120, 1000 / 120), 1000 / 120 / 2, '120 FPS on 120 Hz');
  near(bakeBudget(40, 1000 / 120), 12.5, '40 FPS on 120 Hz');
  near(bakeBudget(0, 1000 / 60), 1000 / 60 / 2, 'no limit: the refresh');
});
