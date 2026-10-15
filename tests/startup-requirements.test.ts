import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRequirements, darwinMajor, type Machine, MIN_DARWIN, MIN_MACOS, parseChip } from '../src/desktop/requirements.js';
import { formatStartupFailure, nativeModuleFailure, sharedTextureFailure } from '../src/desktop/startup-failure.js';

const GOOD: Machine = { platform: 'darwin', arch: 'arm64', release: '25.0.0', brand: 'Apple M5 Pro' };
const on = (changes: Partial<Machine>): Machine => ({ ...GOOD, ...changes });

test('parseChip reads Apple M-series tiers', () => {
  assert.deepEqual(parseChip('Apple M1'), { family: 'apple', generation: 1, tier: 'base' });
  assert.deepEqual(parseChip('Apple M2 Pro'), { family: 'apple', generation: 2, tier: 'pro' });
  assert.deepEqual(parseChip('Apple M3 Max\n'), { family: 'apple', generation: 3, tier: 'max' });
  assert.deepEqual(parseChip('Apple M2 Ultra'), { family: 'apple', generation: 2, tier: 'ultra' });
  assert.deepEqual(parseChip('Apple M12 Pro'), { family: 'apple', generation: 12, tier: 'pro' });
});

test('parseChip tells Intel and anything else apart', () => {
  assert.deepEqual(parseChip('Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz'), { family: 'intel' });
  assert.deepEqual(parseChip('VirtualApple @ 2.50GHz'), { family: 'unknown' });
  assert.deepEqual(parseChip('Apple M1 (Virtual)'), { family: 'unknown' });
  assert.deepEqual(parseChip('Apple M4 Fusion'), { family: 'unknown' });
  assert.deepEqual(parseChip(''), { family: 'unknown' });
});

test('darwinMajor reads the kernel major version', () => {
  assert.equal(darwinMajor('23.6.0'), 23);
  assert.equal(darwinMajor('25.0.0'), 25);
  assert.equal(darwinMajor('nonsense'), undefined);
  assert.equal(darwinMajor(''), undefined);
});

test('macOS 14 is Darwin 23', () => {
  assert.equal(MIN_MACOS, 14);
  assert.equal(MIN_DARWIN, 23);
});

test('Pro, Max and Ultra chips on macOS 14 and later pass', () => {
  for (const brand of ['Apple M1 Pro', 'Apple M2 Max', 'Apple M3 Ultra', 'Apple M5 Pro', 'Apple M9 Max']) {
    assert.equal(checkRequirements(on({ brand })), undefined, brand);
  }
  for (const release of ['23.0.0', '24.1.0', '25.0.0', '27.2.0']) assert.equal(checkRequirements(on({ release })), undefined, release);
});

test('base M chips are refused with the chip named', () => {
  for (const brand of ['Apple M1', 'Apple M2', 'Apple M3', 'Apple M4', 'Apple M5']) {
    const failure = checkRequirements(on({ brand }));
    assert.equal(failure?.kind, 'chip', brand);
    assert.match(failure?.title ?? '', /Pro chip or better/);
    assert.ok(failure?.detail.includes(brand), brand);
  }
});

test('Intel Macs are refused, as the chip and as the architecture', () => {
  const byBrand = checkRequirements(on({ brand: 'Intel(R) Core(TM) i7-8700B CPU @ 3.20GHz' }));
  assert.equal(byBrand?.kind, 'chip');
  assert.match(byBrand?.detail ?? '', /Intel/);
  const byArch = checkRequirements(on({ arch: 'x64', brand: 'VirtualApple @ 2.50GHz' }));
  assert.equal(byArch?.kind, 'chip');
  assert.match(byArch?.detail ?? '', /x64/);
});

test('an unreadable or unrecognized chip is refused', () => {
  assert.equal(checkRequirements(on({ brand: undefined }))?.kind, 'chip');
  assert.equal(checkRequirements(on({ brand: 'Apple M1 (Virtual)' }))?.kind, 'chip');
  assert.match(checkRequirements(on({ brand: 'Something Else' }))?.title ?? '', /couldn't confirm/);
});

test('macOS before 14 is refused before the chip is looked at', () => {
  const failure = checkRequirements(on({ release: '22.6.0', brand: 'Apple M1' }));
  assert.equal(failure?.kind, 'macos');
  assert.match(failure?.title ?? '', /macOS 14 or later/);
  assert.equal(checkRequirements(on({ release: '' }))?.kind, 'macos');
});

test('another platform is refused', () => {
  assert.equal(checkRequirements(on({ platform: 'linux' }))?.kind, 'platform');
});

test('the CI escape hatch skips only the chip check', () => {
  assert.equal(checkRequirements(on({ brand: 'Apple M1 (Virtual)', allowAnyChip: true })), undefined);
  assert.equal(checkRequirements(on({ brand: undefined, allowAnyChip: true })), undefined);
  assert.equal(checkRequirements(on({ release: '22.6.0', allowAnyChip: true }))?.kind, 'macos');
  assert.equal(checkRequirements(on({ arch: 'x64', allowAnyChip: true }))?.kind, 'chip');
  assert.equal(checkRequirements(on({ platform: 'linux', allowAnyChip: true }))?.kind, 'platform');
});

test('startup failures for the native module and the shared texture name the cause', () => {
  const module = nativeModuleFailure(new Error('dlopen failed: code signature invalid'));
  assert.equal(module.kind, 'native-module');
  assert.ok(module.detail.includes('dlopen failed: code signature invalid'));
  const texture = sharedTextureFailure('no frame in 5000 ms');
  assert.equal(texture.kind, 'shared-texture');
  assert.ok(texture.detail.includes('no frame in 5000 ms'));
  assert.equal(nativeModuleFailure('plain string').detail.endsWith('plain string'), true);
  assert.match(formatStartupFailure(texture), /^Droid Office couldn't get frames from the GPU\n\n/);
});
