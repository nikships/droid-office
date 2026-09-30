import test from 'node:test';
import assert from 'node:assert/strict';
import { returnLanding } from '../src/shared/floors.js';
import { ROOF } from '../src/shared/rooftop.js';

const floors = ['alpha', 'beta'];

test('a floor that is still there puts you back on it', () => {
  assert.deepEqual(returnLanding('beta', floors, ROOF), { onRoof: false, floorId: 'beta', back: true, gone: false });
});

test('no remembered floor is the first floor, by elevator', () => {
  assert.deepEqual(returnLanding(null, floors, ROOF), { onRoof: false, floorId: 'alpha', back: false, gone: false });
});

test('the roof is still the roof, and the spot there can be used', () => {
  assert.deepEqual(returnLanding(ROOF, floors, ROOF), { onRoof: true, floorId: undefined, back: true, gone: false });
});

test('a floor that is gone sends you to the roof, not onto an empty floor', () => {
  assert.deepEqual(returnLanding('gone', floors, ROOF), { onRoof: true, floorId: undefined, back: false, gone: true });
});

test('a gone floor with no building left has nowhere to stand', () => {
  assert.deepEqual(returnLanding('gone', [], ROOF), { onRoof: false, floorId: undefined, back: false, gone: true });
  assert.deepEqual(returnLanding(ROOF, [], ROOF), { onRoof: false, floorId: undefined, back: false, gone: false });
  assert.deepEqual(returnLanding(null, [], ROOF), { onRoof: false, floorId: undefined, back: false, gone: false });
});
