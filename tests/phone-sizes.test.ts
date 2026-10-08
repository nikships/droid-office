import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PhoneSizes, type TermDims } from '../src/server/phone-sizes.js';

const at = (sizes: Record<string, TermDims>) => (id: string) => sizes[id];

test('a phone that drops off puts back the size from before its first resize', () => {
  const p = new PhoneSizes();
  p.resized('w1', { cols: 160, rows: 48 }, { cols: 45, rows: 30 });
  // Rotating sends a second size; what to restore is still the desktop's.
  p.resized('w1', { cols: 45, rows: 30 }, { cols: 90, rows: 18 });
  assert.deepEqual(p.restores(at({ w1: { cols: 90, rows: 18 } })), [{ workerId: 'w1', size: { cols: 160, rows: 48 } }]);
});

test('a terminal another window has resized since is left alone', () => {
  const p = new PhoneSizes();
  p.resized('w1', { cols: 160, rows: 48 }, { cols: 45, rows: 30 });
  assert.deepEqual(p.restores(at({ w1: { cols: 120, rows: 40 } })), []);
});

test('a phone that restored the size itself has nothing left to put back', () => {
  const p = new PhoneSizes();
  p.resized('w1', { cols: 160, rows: 48 }, { cols: 45, rows: 30 });
  p.resized('w1', { cols: 45, rows: 30 }, { cols: 160, rows: 48 });
  assert.deepEqual(p.restores(at({ w1: { cols: 160, rows: 48 } })), []);
});

test('a terminal that is gone is skipped, and each restore happens once', () => {
  const p = new PhoneSizes();
  p.resized('w1', { cols: 160, rows: 48 }, { cols: 45, rows: 30 });
  p.resized('w2', { cols: 100, rows: 30 }, { cols: 45, rows: 30 });
  const now = at({ w2: { cols: 45, rows: 30 } });
  assert.deepEqual(p.restores(now), [{ workerId: 'w2', size: { cols: 100, rows: 30 } }]);
  assert.deepEqual(p.restores(now), []);
});
