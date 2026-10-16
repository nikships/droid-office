import assert from 'node:assert/strict';
import test from 'node:test';
import { ChargeHaptics, chargeHapticSegment, type HapticPattern } from '../src/client/haptics.js';
import { hapticScript, parseHapticPattern, TrackpadHaptics } from '../src/server/haptics.js';

test('the JXA script performs the MTPLX patterns at full density, and only those', () => {
  assert.match(hapticScript('tick'), /for\(var i=0;i<3;i\+\+\)\{[^}]*NSHapticFeedbackPatternGeneric[^}]*sleepForTimeInterval\(0\.012\)/);
  assert.match(hapticScript('charged'), /for\(var i=0;i<3;i\+\+\)\{[^}]*NSHapticFeedbackPatternLevelChange[^}]*sleepForTimeInterval\(0\.03\)/);
  const superScript = hapticScript('super');
  assert.match(superScript, /NSHapticFeedbackPatternLevelChange/);
  assert.match(superScript, /for\(var i=0;i<120;i\+\+\)\{[^}]*NSHapticFeedbackPatternGeneric[^}]*sleepForTimeInterval\(0\.005\)/);
  for (const script of [hapticScript('tick'), hapticScript('charged'), superScript]) {
    assert.match(script, /NSHapticFeedbackManager\.defaultPerformer/);
    assert.match(script, /NSHapticFeedbackPerformanceTimeNow/);
    assert.doesNotMatch(script, /tick|charged|super/, 'no request text reaches the script');
  }
});

test('only the three pattern names are accepted, from any JSON value', () => {
  assert.equal(parseHapticPattern('tick'), 'tick');
  assert.equal(parseHapticPattern('charged'), 'charged');
  assert.equal(parseHapticPattern('super'), 'super');
  for (const bad of ['generic', 'alignment', 'TICK', '', 'tick; rm -rf /', '__proto__', null, undefined, 0, {}, ['tick']]) assert.equal(parseHapticPattern(bad), null, JSON.stringify(bad));
});

test('off macOS nothing is run and the page is told to stop asking', () => {
  let ran = 0;
  const haptics = new TrackpadHaptics({ platform: 'linux', run: () => ran++ });
  assert.equal(haptics.supported, false);
  assert.deepEqual(haptics.perform('super'), { ok: false, supported: false });
  assert.equal(ran, 0);
});

test('ticks are rate-limited but the charged detent and the super buzz always fire', () => {
  const scripts: string[] = [];
  let now = 1000;
  const haptics = new TrackpadHaptics({ platform: 'darwin', now: () => now, run: (s) => scripts.push(s) });
  assert.deepEqual(haptics.perform('tick'), { ok: true, supported: true });
  assert.deepEqual(haptics.perform('tick'), { ok: true, supported: true, throttled: true });
  assert.deepEqual(haptics.perform('bogus'), { ok: false, supported: true });
  now += 10;
  assert.equal(haptics.perform('charged').ok, true, 'the detent lands a frame after the last tick');
  assert.equal(haptics.perform('super').ok, true, 'so does the release buzz');
  now += 100;
  assert.equal(haptics.perform('tick').ok, true);
  assert.equal(scripts.length, 4);
  assert.match(scripts[1], /LevelChange/);
});

test('charge segments tick once per eighth of the ring, never at full', () => {
  assert.equal(chargeHapticSegment(0), 0);
  assert.equal(chargeHapticSegment(-1), 0);
  assert.equal(chargeHapticSegment(Number.NaN), 0);
  assert.equal(chargeHapticSegment(0.01), 1);
  assert.equal(chargeHapticSegment(0.5), 5);
  assert.equal(chargeHapticSegment(1), 8);
  assert.equal(chargeHapticSegment(2), 8);
});

test('a held charge ticks up the ring, detents at full, and buzzes only on a charged release', async () => {
  const sent: HapticPattern[] = [];
  const haptics = new ChargeHaptics(async (p) => {
    sent.push(p);
    return true;
  });
  for (const progress of [0.05, 0.1, 0.2, 0.24, 0.4, 0.6, 0.8, 0.99]) haptics.charge(progress);
  assert.deepEqual(sent, ['tick', 'tick', 'tick', 'tick', 'tick', 'tick'], 'one tick per frame that crosses into a new segment');
  haptics.charge(1);
  assert.equal(sent.length, 6, 'filling the ring is the detent, not another tick');
  haptics.charged();
  haptics.release(false);
  assert.deepEqual(sent, ['tick', 'tick', 'tick', 'tick', 'tick', 'tick', 'charged'], 'a normal release adds nothing');
  haptics.charge(0.2);
  haptics.release(true);
  assert.deepEqual(sent.slice(-2), ['tick', 'super']);
});

test('an office with no trackpad to reach silences the page for good, failures do not', async () => {
  let reachable = true;
  let calls = 0;
  const haptics = new ChargeHaptics(async () => {
    calls++;
    return reachable;
  });
  haptics.charge(0.2);
  await Promise.resolve();
  reachable = false;
  haptics.charge(0.4);
  // The sender's answer lands on a microtask; let it settle before the next crossing.
  await new Promise((r) => setTimeout(r, 0));
  haptics.charge(0.6);
  haptics.charged();
  assert.equal(calls, 2, 'once unsupported, nothing else is sent');
});
