import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_NATIVE_HEIGHT, eyeHeightFor, floorOffsetFor, readNativeHeight } from '../src/client/native/height';

test('a stored height falls back to defaults when malformed', () => {
  assert.deepEqual(readNativeHeight(null), DEFAULT_NATIVE_HEIGHT);
  assert.deepEqual(readNativeHeight({ heightCm: 'tall', floorOffset: Number.NaN }), DEFAULT_NATIVE_HEIGHT);
  assert.deepEqual(readNativeHeight({ heightCm: 182.4, floorOffset: 1.27 }), { v: 1, heightCm: 182, floorOffset: 1.27 });
});

test('height and floor correction stay within a human body', () => {
  assert.equal(readNativeHeight({ heightCm: 40 }).heightCm, 120);
  assert.equal(readNativeHeight({ heightCm: 400 }).heightCm, 220);
  assert.equal(readNativeHeight({ floorOffset: 9 }).floorOffset, 2.5);
  assert.equal(readNativeHeight({ floorOffset: -9 }).floorOffset, -2.5);
});

test('calibration puts the reported eyes at the eye height of the set body height', () => {
  assert.equal(eyeHeightFor(175), 1.64);
  // A headset reporting the eyes at 3.16 m for a 175 cm player is 1.52 m above the real floor.
  assert.ok(Math.abs(floorOffsetFor(3.16, 175) - 1.52) < 1e-9);
  // A correct headset needs no correction.
  assert.ok(Math.abs(floorOffsetFor(1.64, 175)) < 1e-9);
  // A seated or short reading lowers nothing below the real floor beyond the clamp.
  assert.equal(floorOffsetFor(-10, 175), -2.5);
});
