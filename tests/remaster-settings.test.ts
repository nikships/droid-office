import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPreset, controlLive, formatRange, probeCount, REMASTER_CONTROLS, REMASTER_DEFAULTS, REMASTER_PRESETS, type RangeControl, normalizeRemaster, snapRange, whiteBalance } from '../src/client/remaster-settings.js';

const range = (key: string) => REMASTER_CONTROLS.find((c) => c.key === key && c.kind === 'range') as RangeControl;

test('every control has a default of its own kind, inside its range or among its options', () => {
  const keys = new Set<string>();
  for (const c of REMASTER_CONTROLS) {
    assert.ok(!keys.has(c.key), `${c.key} is listed twice`);
    keys.add(c.key);
    const v = REMASTER_DEFAULTS[c.key];
    if (c.kind === 'toggle') assert.equal(typeof v, 'boolean', c.key);
    else if (c.kind === 'range') {
      assert.equal(typeof v, 'number', c.key);
      assert.ok((v as number) >= c.min && (v as number) <= c.max, `${c.key} default ${v} outside ${c.min}–${c.max}`);
      assert.equal(snapRange(c, v as number), v, `${c.key} default is off its step`);
    } else
      assert.ok(
        c.options.some(([o]) => o === v),
        `${c.key} default ${String(v)} is not an option`,
      );
  }
});

test('saved settings come back normalized: junk, wrong types and out-of-range values go to defaults or the edge', () => {
  assert.deepEqual(normalizeRemaster(null), REMASTER_DEFAULTS);
  assert.deepEqual(normalizeRemaster('nope'), REMASTER_DEFAULTS);
  const s = normalizeRemaster({ bloom: 'yes', exposure: 99, toneMap: 'filmic-9000', aa: 'smaa', sharpen: Number.NaN, preset: 'bogus', hdr: false });
  assert.equal(s.bloom, REMASTER_DEFAULTS.bloom);
  assert.equal(s.exposure, range('exposure').max);
  assert.equal(s.toneMap, REMASTER_DEFAULTS.toneMap);
  assert.equal(s.aa, 'smaa');
  assert.equal(s.sharpen, REMASTER_DEFAULTS.sharpen);
  assert.equal(s.preset, REMASTER_DEFAULTS.preset);
  assert.equal(s.hdr, false);
  assert.equal(normalizeRemaster({ preset: 'custom' }).preset, 'custom');
});

test('range values snap to their step without float noise', () => {
  const c = range('bloomStrength');
  assert.equal(snapRange(c, 0.351234), Number((c.min + Math.round((0.351234 - c.min) / c.step) * c.step).toFixed(3)));
  assert.equal(snapRange(c, -5), c.min);
  assert.equal(snapRange(c, 1e9), c.max);
  for (const ctl of REMASTER_CONTROLS) {
    if (ctl.kind !== 'range') continue;
    const v = snapRange(ctl, ctl.min + ctl.step * 7.3);
    assert.ok(String(v).length < 10, `${ctl.key} snapped to ${v}`);
  }
});

test('presets: Classic only turns the renderer off; the others start from the defaults and keep the diagnostics', () => {
  const tuned = { ...REMASTER_DEFAULTS, exposure: 2, debug: 'ao' as const, pace: 'full' as const };
  const classic = applyPreset('classic', tuned);
  assert.equal(classic.enabled, false);
  assert.equal(classic.exposure, 2);
  for (const p of REMASTER_PRESETS) {
    if (p.id === 'classic') continue;
    const s = applyPreset(p.id, tuned);
    assert.equal(s.enabled, true, p.id);
    assert.equal(s.preset, p.id);
    assert.equal(s.debug, 'ao');
    assert.equal(s.pace, 'full');
    for (const [k, v] of Object.entries(p.values)) {
      if (k !== 'debug' && k !== 'pace' && k !== 'preset') assert.deepEqual(s[k as keyof typeof s], v, `${p.id}.${k}`);
    }
    assert.deepEqual(normalizeRemaster(s), s, `${p.id} survives a save and load`);
  }
  assert.equal(applyPreset('nope', tuned), tuned);
});

test('a control is live only while its master switches are on', () => {
  const bloomStrength = REMASTER_CONTROLS.find((c) => c.key === 'bloomStrength')!;
  assert.equal(controlLive(bloomStrength, REMASTER_DEFAULTS), REMASTER_DEFAULTS.bloom && REMASTER_DEFAULTS.enabled);
  assert.equal(controlLive(bloomStrength, { ...REMASTER_DEFAULTS, bloom: false }), false);
  assert.equal(controlLive(bloomStrength, { ...REMASTER_DEFAULTS, bloom: true, enabled: false }), false);
  const enabled = REMASTER_CONTROLS.find((c) => c.key === 'enabled')!;
  assert.equal(controlLive(enabled, { ...REMASTER_DEFAULTS, enabled: false }), true);
});

test('range values read the way the panel shows them', () => {
  assert.equal(formatRange(range('renderScale'), 1.5), '150%');
  assert.equal(formatRange(range('exposure'), 1.25), '1.25×');
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
