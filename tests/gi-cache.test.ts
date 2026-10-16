import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEEP_BAKES, touch } from '../src/client/gi-cache';

test('a bake under a new key is kept beside the last one, so switching back finds it', () => {
  let order: string[] = [];
  order = touch(order, 'sdr').order;
  const second = touch(order, 'hdr');
  assert.deepEqual(second.order, ['hdr', 'sdr']);
  assert.deepEqual(second.drop, []);
  assert.deepEqual(touch(second.order, 'sdr').order, ['sdr', 'hdr']);
});

test('a third key replaces the one used longest ago, and no more than two are kept', () => {
  const next = touch(['hdr', 'sdr'], 'ultra');
  assert.equal(KEEP_BAKES, 2);
  assert.deepEqual(next.order, ['ultra', 'hdr']);
  assert.deepEqual(next.drop, ['sdr']);
});

test('using a saved key again moves it to the front without dropping anything', () => {
  const next = touch(['hdr', 'sdr'], 'sdr');
  assert.deepEqual(next.order, ['sdr', 'hdr']);
  assert.deepEqual(next.drop, []);
});
