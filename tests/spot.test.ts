import test from 'node:test';
import assert from 'node:assert/strict';
import { lastSpot, rememberSpot, spotParams, type Spot } from '../src/client/state.js';

const mem = new Map<string, string>();
const storage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => {
    mem.set(k, v);
  },
  removeItem: (k: string) => {
    mem.delete(k);
  },
};

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

const here: Spot = { floor: 'alpha', name: 'Alpha', x: 1.2, y: 0, z: -3.4, facing: 1.23456 };

test('a spot round-trips through the browser, and only rides along on its own floor', () => {
  mem.clear();
  assert.equal(lastSpot(), null);
  rememberSpot(here);
  assert.deepEqual(lastSpot(), here);
  assert.deepEqual(spotParams('alpha', lastSpot()), { x: '1.20', y: '0.00', z: '-3.40', rotY: '1.235' });
  assert.equal(spotParams('beta', lastSpot()), null);
  assert.equal(spotParams(null, lastSpot()), null);
});

test('a stored spot with a bad shape is ignored, and a missing name is empty', () => {
  mem.set('droid-office.spot', '{');
  assert.equal(lastSpot(), null);
  mem.set('droid-office.spot', JSON.stringify({ floor: 'alpha', x: 1, y: 2, z: 3, facing: Number.NaN }));
  assert.equal(lastSpot(), null);
  mem.set('droid-office.spot', JSON.stringify({ floor: '', x: 1, y: 2, z: 3, facing: 0 }));
  assert.equal(lastSpot(), null);
  mem.set('droid-office.spot', JSON.stringify({ floor: 'alpha', x: 1, y: 2, z: 3, facing: 0 }));
  assert.deepEqual(lastSpot(), { floor: 'alpha', name: '', x: 1, y: 2, z: 3, facing: 0 });
});
