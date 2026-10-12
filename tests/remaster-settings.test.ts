import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyQuality,
  autoQuality,
  CHOICE_SETTINGS,
  choiceLive,
  choiceValue,
  gpuGuess,
  gpuName,
  LEVELS,
  loadRemaster,
  normalizeRemaster,
  probeCount,
  QUALITY_PRESETS,
  qualityOf,
  REMASTER_DEFAULTS,
  REMASTER_KEY,
  type RemasterSettings,
  resetRemaster,
  RESOLUTION_MAX,
  RESOLUTION_MIN,
  resolveRemaster,
  saveRemaster,
  snapResolution,
  whiteBalance,
  withChoice,
} from '../src/client/remaster-settings.js';

const near = (actual: number, expected: number, label: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} !~ ${expected}`);

test('every setting default is one of its options, and the resolution sits on a tenth', () => {
  const keys = new Set<string>();
  for (const c of CHOICE_SETTINGS) {
    assert.ok(!keys.has(c.key), `${c.key} is listed twice`);
    keys.add(c.key);
    const v = choiceValue(REMASTER_DEFAULTS, c.key);
    assert.ok(
      c.options.some((o) => o.value === v),
      `${c.key} default ${v} is not an option`,
    );
  }
  assert.equal(snapResolution(REMASTER_DEFAULTS.resolution), REMASTER_DEFAULTS.resolution);
  assert.ok(REMASTER_DEFAULTS.resolution >= RESOLUTION_MIN && REMASTER_DEFAULTS.resolution <= RESOLUTION_MAX);
});

test('a fresh install is Classic at High, and the presets mix levels instead of setting every knob the same', () => {
  assert.equal(REMASTER_DEFAULTS.enabled, false);
  assert.equal(qualityOf(REMASTER_DEFAULTS), 'high');
  assert.equal(QUALITY_PRESETS.high.antiAliasing, 'medium');
  assert.equal(QUALITY_PRESETS.high.giQuality, 'veryHigh');
  assert.equal(QUALITY_PRESETS.high.liveGi, 'low');
  assert.equal(QUALITY_PRESETS.ultra.shadowQuality, 'veryHigh');
  assert.equal(QUALITY_PRESETS.ultra.liveGi, 'veryHigh');
  for (const lv of LEVELS) assert.equal(qualityOf({ ...REMASTER_DEFAULTS, ...QUALITY_PRESETS[lv] }), lv);
});

test('saved settings come back normalized: junk, wrong types and a resolution off its step go to a default or the edge', () => {
  assert.deepEqual(normalizeRemaster(null), REMASTER_DEFAULTS);
  assert.deepEqual(normalizeRemaster('nope'), REMASTER_DEFAULTS);
  const s = normalizeRemaster({
    gi: 'yes',
    exposure: 99,
    brightness: 'blinding',
    antiAliasing: 'veryHigh',
    hdr: true,
    debug: 'ao',
    resolution: 9,
    pace: 'full',
  });
  assert.equal(s.brightness, REMASTER_DEFAULTS.brightness);
  assert.equal(s.antiAliasing, REMASTER_DEFAULTS.antiAliasing);
  assert.equal(s.debug, 'final');
  assert.equal(s.hdr, true);
  assert.equal(s.pace, 'full');
  assert.equal(s.resolution, RESOLUTION_MAX);
  assert.equal('exposure' in s, false);
  assert.equal(normalizeRemaster({ resolution: Number.NaN }).resolution, 1);
  assert.equal(normalizeRemaster({ resolution: 0.1 + 0.6 }).resolution, 0.7);
  assert.equal(normalizeRemaster({ resolution: 0.04 }).resolution, RESOLUTION_MIN);
});

test('settings saved before the levels become the nearest quality, and a new save keeps its own levels', () => {
  const performance = normalizeRemaster({ preset: 'performance', exposure: 1.5, hdr: true });
  assert.deepEqual({ antiAliasing: performance.antiAliasing, shadowQuality: performance.shadowQuality, giQuality: performance.giQuality, liveGi: performance.liveGi }, QUALITY_PRESETS.medium);
  assert.equal(performance.hdr, true);
  assert.equal(performance.brightness, 'normal');
  const ultra = normalizeRemaster({ preset: 'ultra' });
  assert.equal(qualityOf(ultra), 'ultra');
  assert.equal(normalizeRemaster({ preset: 'toon' }).style, 'toon');
  assert.equal(qualityOf(normalizeRemaster({ preset: 'nik' })), 'high');
  assert.equal(qualityOf(normalizeRemaster({ preset: 'crisp' })), 'high');
  const kept = normalizeRemaster({ shadowQuality: 'low', preset: 'ultra', resolution: 0.74 });
  assert.equal(kept.shadowQuality, 'low');
  assert.equal(kept.resolution, 0.7);
  assert.equal(qualityOf(kept), 'custom');
});

test('resolution snaps to a tenth inside 0.5×–1.5×', () => {
  assert.equal(snapResolution(0.74), 0.7);
  assert.equal(snapResolution(1.05), 1.1);
  assert.equal(snapResolution(-5), RESOLUTION_MIN);
  assert.equal(snapResolution(1e9), RESOLUTION_MAX);
  assert.equal(snapResolution(1.1 + 0.2), 1.3);
});

test('a quality sets the four cost settings and turns Remastered on; picture, display and resolution stay', () => {
  const tuned: RemasterSettings = { ...REMASTER_DEFAULTS, enabled: false, resolution: 0.8, brightness: 'bright', hdr: true, debug: 'hdr', pace: 'full', style: 'toon' };
  for (const lv of LEVELS) {
    const s = applyQuality(lv, tuned);
    assert.equal(s.enabled, true, lv);
    assert.equal(qualityOf(s), lv);
    assert.equal(s.resolution, 0.8);
    assert.equal(s.brightness, 'bright');
    assert.equal(s.hdr, true);
    assert.equal(s.debug, 'hdr');
    assert.equal(s.pace, 'full');
    assert.equal(s.style, 'toon');
    assert.deepEqual(normalizeRemaster(s), s, `${lv} survives a save and load`);
  }
  const custom = withChoice(applyQuality('high', tuned), 'shadowQuality', 'ultra');
  assert.equal(qualityOf(custom), 'custom');
  assert.equal(withChoice(tuned, 'brightness', 'nope'), tuned);
  assert.equal(choiceValue({ ...tuned, hdr: true }, 'hdr'), 'on');
});

test('reset goes back to High at 1.0× and leaves the renderer as it is', () => {
  const on = resetRemaster({ ...REMASTER_DEFAULTS, enabled: true, resolution: 1.5, brightness: 'darker', shadowQuality: 'ultra' });
  assert.deepEqual(on, { ...REMASTER_DEFAULTS, enabled: true });
  const off = resetRemaster({ ...REMASTER_DEFAULTS, enabled: false, color: 'vivid' });
  assert.deepEqual(off, REMASTER_DEFAULTS);
});

test('a setting is live only while the setting it depends on is on', () => {
  const liveGi = CHOICE_SETTINGS.find((c) => c.key === 'liveGi')!;
  const highlights = CHOICE_SETTINGS.find((c) => c.key === 'hdrHighlights')!;
  const enabled = CHOICE_SETTINGS.find((c) => c.key === 'enabled')!;
  assert.equal(choiceLive(liveGi, { ...REMASTER_DEFAULTS, giQuality: 'high' }), true);
  assert.equal(choiceLive(liveGi, { ...REMASTER_DEFAULTS, giQuality: 'low' }), false);
  assert.equal(choiceLive(highlights, { ...REMASTER_DEFAULTS, hdr: true }), true);
  assert.equal(choiceLive(highlights, { ...REMASTER_DEFAULTS, hdr: false }), false);
  assert.equal(choiceLive(enabled, { ...REMASTER_DEFAULTS, enabled: false }), true);
});

test('each quality resolves to the samples, shadow map, probe spacing and live rate it names', () => {
  const expect: Record<(typeof LEVELS)[number], { msaa: number; shadow: number; spacing: number; bounces: number; live: number }> = {
    low: { msaa: 0, shadow: 1024, spacing: 3, bounces: 0, live: 0 },
    medium: { msaa: 2, shadow: 2048, spacing: 2, bounces: 1, live: 0 },
    high: { msaa: 2, shadow: 3072, spacing: 1.4, bounces: 1, live: 0 },
    veryHigh: { msaa: 4, shadow: 4096, spacing: 1.4, bounces: 1, live: 15 },
    ultra: { msaa: 4, shadow: 4096, spacing: 1.4, bounces: 2, live: 60 },
  };
  for (const lv of LEVELS) {
    const p = resolveRemaster(applyQuality(lv, REMASTER_DEFAULTS));
    const e = expect[lv];
    assert.equal(p.msaa, e.msaa, lv);
    assert.equal(p.shadowMapSize, e.shadow, lv);
    assert.equal(p.gi, true, lv);
    assert.equal(p.giSpacing, e.spacing, lv);
    assert.equal(p.giBounces, e.bounces, lv);
    assert.equal(p.giLive, e.live, lv);
  }
  const hand = resolveRemaster({ ...applyQuality('ultra', REMASTER_DEFAULTS), shadowQuality: 'ultra', liveGi: 'ultra' });
  assert.equal(hand.shadowMapSize, 8192);
  assert.equal(hand.shadowSoftness, 4);
  assert.equal(hand.giLive, 120);
  const flat = resolveRemaster({ ...REMASTER_DEFAULTS, giQuality: 'low', liveGi: 'ultra' });
  assert.equal(flat.gi, false);
  assert.equal(flat.giLive, 0);
  const look = resolveRemaster({ ...REMASTER_DEFAULTS, brightness: 'brighter', color: 'warm', style: 'toon', sharpness: 'off', hdr: true, hdrHighlights: 'max' });
  assert.equal(look.exposure, 1.7);
  assert.equal(look.temperature, 0.25);
  assert.equal(look.toonRamp, 'classic');
  assert.equal(look.outlines, true);
  assert.equal(look.sharpen, 0);
  assert.equal(look.hdrPeak, 16);
  assert.equal(look.screenGlow, resolveRemaster(REMASTER_DEFAULTS).screenGlow * 1.6);
  assert.equal(look.toneMap, 'linear');
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

test('a probe grid has at least two probes along each side', () => {
  assert.equal(probeCount(0.5, 3), 2);
  assert.equal(probeCount(20, 2), 11);
});

test('a WebGL renderer string becomes the GPU name', () => {
  assert.equal(gpuName('ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)'), 'Apple M5 Pro');
  assert.equal(gpuName('ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 (0x2684) Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'NVIDIA GeForce RTX 4090');
  assert.equal(gpuName('ANGLE (AMD, AMD Radeon RX 7900 XTX (0x744c), D3D11)'), 'AMD Radeon RX 7900 XTX');
  assert.equal(gpuName(''), '');
});

test('GPU speed is scored from the name, with an M1 8-core GPU as 1', () => {
  const score = (name: string) => gpuGuess(name).score;
  near(score('Apple M1'), 1, 'm1');
  near(score('Apple M3 Pro'), 2.9, 'm3 pro');
  near(score('Apple M4 Max'), 6.8, 'm4 max');
  near(score('Apple M5 Ultra'), 17.6, 'm5 ultra');
  near(score('Apple M5 Pro'), 4.4, 'm5 pro');
  near(score('Apple M6'), 2.75, 'm6');
  near(score('Apple GPU'), 1.5, 'safari');
  near(score('NVIDIA GeForce RTX 4090'), 13.2, '4090');
  near(score('NVIDIA GeForce RTX 3060 Laptop GPU'), 2.392, '3060 laptop');
  near(score('NVIDIA GeForce RTX 4070 Ti'), 9.108, '4070 ti');
  near(score('NVIDIA GeForce GTX 1650'), 1.1, '1650');
  near(score('NVIDIA GeForce RTX 5090'), 16.8, '5090');
  near(score('NVIDIA GeForce GTX 960'), 1.12, '960');
  near(score('NVIDIA GeForce MX150'), 0.4, 'mx');
  near(score('NVIDIA RTX A6000'), 4, 'rtx a');
  near(score('AMD Radeon RX 7900 XTX'), 10.472, '7900 xtx');
  near(score('AMD Radeon RX 7600M'), 2.352, '7600m');
  near(score('AMD Radeon RX 580'), 1.4, '580');
  near(score('AMD Radeon 890M'), 1.8, '890m');
  near(score('AMD Radeon 999M'), 0.6, 'unknown apu');
  near(score('AMD Radeon Graphics'), 0.6, 'radeon');
  near(score('Intel Arc B580'), 3.8, 'b580');
  near(score('Intel Arc A770'), 3.5, 'a770');
  near(score('Intel Arc A380'), 1.2, 'a380');
  near(score('Intel Arc Graphics'), 1, 'arc');
  near(score('Intel Iris Xe Graphics'), 0.5, 'iris xe');
  near(score('Intel Iris Plus Graphics'), 0.35, 'iris');
  near(score('Intel UHD Graphics 630'), 0.25, 'uhd');
  near(score('Intel HD Graphics'), 0.2, 'intel');
  near(score('Adreno X1-85'), 1.5, 'adreno x1');
  near(score('Adreno 740'), 0.25, 'adreno');
  near(score('Mali-G78'), 0.25, 'mali');
  near(score('Google SwiftShader'), 0.05, 'software');
  near(score('Something Else'), 1, 'unknown');
  assert.equal(gpuGuess('').name, 'Unknown GPU');
});

test('Auto picks a quality for the GPU, the pixels and the frame rate, and only lowers resolution below Low', () => {
  const fullHd = 1920 * 1080;
  const pro = autoQuality({ gpu: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)', pixels: fullHd, fpsCap: 60 });
  assert.equal(pro.quality, 'ultra');
  assert.equal(pro.resolution, 1);
  assert.equal(pro.gpu.name, 'Apple M5 Pro');
  assert.equal(autoQuality({ gpu: 'Apple M1', pixels: fullHd, fpsCap: 60 }).quality, 'high');
  assert.equal(autoQuality({ gpu: 'Apple M5 Pro', pixels: fullHd, fpsCap: 120 }).quality, 'ultra');
  const uhd = autoQuality({ gpu: 'Intel UHD Graphics 630', pixels: fullHd, fpsCap: 60 });
  assert.equal(uhd.quality, 'low');
  assert.equal(uhd.resolution, 0.8);
  const soft = autoQuality({ gpu: 'Google SwiftShader', pixels: fullHd, fpsCap: 60 });
  assert.equal(soft.quality, 'low');
  assert.equal(soft.resolution, 0.5);
  const fourK = autoQuality({ gpu: 'Apple M1', pixels: 3840 * 2160, fpsCap: 60 });
  assert.equal(fourK.quality, 'low');
  assert.equal(fourK.resolution, 0.8);
  assert.equal(autoQuality({ gpu: 'Apple M1', pixels: fullHd, fpsCap: 10 }).quality, 'ultra');
  assert.equal(autoQuality({ gpu: 'Apple M5 Pro', pixels: 0, fpsCap: 60 }).resolution, 1);
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
  const tuned = applyQuality('veryHigh', { ...REMASTER_DEFAULTS, resolution: 1.2, color: 'cool' });
  saveRemaster(tuned);
  assert.deepEqual(loadRemaster(), tuned);
  mem.set(REMASTER_KEY, '{');
  assert.deepEqual(loadRemaster(), REMASTER_DEFAULTS);
});
