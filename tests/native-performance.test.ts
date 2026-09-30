import test from 'node:test';
import assert from 'node:assert/strict';
import { nativePerformanceLabel } from '../src/client/native/performance.js';

const populated = { refresh: 90, fps: 90.01, focused: true, missedPeriods: 0, controlAgeMs: 34, scene: { objects: 1700, drawCalls: 150, stateSerial: 25 } };

test('unavailable native display measurements make no performance claim', () => {
  for (const metrics of [undefined, null, {}, { refresh: 0 }, { refresh: Number.NaN }, '90']) assert.equal(nativePerformanceLabel(metrics), null);
});

test('a populated fresh office reports the measured display mode without a stable90 guarantee', () => {
  assert.deepEqual(nativePerformanceLabel(populated), { text: '90 Hz display', warning: false });
});

test('72 or60 Hz is a visible degraded state despite current compositor frame rate', () => {
  assert.deepEqual(nativePerformanceLabel({ ...populated, refresh: 72 }), { text: '72 Hz display · 90 Hz required', warning: true });
  assert.deepEqual(nativePerformanceLabel({ ...populated, refresh: 60 }), { text: '60 Hz display · 90 Hz required', warning: true });
});

test('a stale heartbeat cannot present90 compositor FPS as a healthy office', () => {
  for (const controlAgeMs of [null, undefined, 1001, 60000, Number.NaN]) assert.deepEqual(nativePerformanceLabel({ ...populated, controlAgeMs }), { text: '90 Hz display · Office updates delayed', warning: true });
  assert.deepEqual(nativePerformanceLabel({ ...populated, focused: false }), { text: 'Headset session paused', warning: true });
});

test('an empty or undrawn scene is loading even with fresh90Hz metrics', () => {
  for (const scene of [undefined, { objects: 0, drawCalls: 0, stateSerial: 0 }, { objects: 1700, drawCalls: 0, stateSerial: 25 }, { objects: 1700, drawCalls: 150, stateSerial: 0 }]) {
    assert.deepEqual(nativePerformanceLabel({ ...populated, scene }), { text: '90 Hz display · Loading the office…', warning: true });
  }
});

test('measured slow frames and missed display periods remain visible', () => {
  for (const metrics of [
    { ...populated, fps: 80 },
    { ...populated, missedPeriods: 1 },
  ])
    assert.deepEqual(nativePerformanceLabel(metrics), { text: '90 Hz display · Frame rate below 90 fps', warning: true });
  assert.deepEqual(nativePerformanceLabel({ ...populated, fps: undefined }), { text: '90 Hz display · Measuring frame rate…', warning: false });
});
