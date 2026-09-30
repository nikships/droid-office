import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_NATIVE_GRAPHICS, readNativeGraphics } from '../src/client/native/graphics-settings.js';
import { nativeFpsCounter } from '../src/client/native/performance.js';

test('missing, corrupted and legacy graphics storage uses the tested defaults', () => {
  for (const value of [undefined, null, 'broken', 42, {}]) assert.deepEqual(readNativeGraphics(value), DEFAULT_NATIVE_GRAPHICS);
  assert.deepEqual(readNativeGraphics({ renderScale: Number.NaN, peripheralDensity: Infinity, foveation: 'unknown', fps: 'true' }), DEFAULT_NATIVE_GRAPHICS);
});

test('graphics changes remain bounded and do not alter the display refresh request', () => {
  assert.deepEqual(readNativeGraphics({ renderScale: 0.1, peripheralDensity: 2, foveation: 'clarity', fps: true }), { v: 1, renderScale: 0.75, peripheralDensity: 1, foveation: 'clarity', fps: true, sharpScreens: true });
  assert.deepEqual(readNativeGraphics({ renderScale: 3, peripheralDensity: -1, foveation: 'performance', fps: false, sharpScreens: false }), {
    v: 1,
    renderScale: 1,
    peripheralDensity: 0.25,
    foveation: 'performance',
    fps: false,
    sharpScreens: false,
  });
  assert.equal(readNativeGraphics({ sharpScreens: 'false' }).sharpScreens, true);
  assert.equal(readNativeGraphics(JSON.parse(JSON.stringify({ ...DEFAULT_NATIVE_GRAPHICS, sharpScreens: false }))).sharpScreens, false);
});

test('persistent counter distinguishes native FPS, display mode and delayed office updates', () => {
  const metrics = { fps: 90.015, refresh: 90, focused: true, controlAgeMs: 30, scene: { objects: 1500, drawCalls: 150, stateSerial: 2 } };
  assert.deepEqual(nativeFpsCounter(metrics), { text: '90.0 fps · 90 Hz', warning: false });
  assert.deepEqual(nativeFpsCounter({ ...metrics, fps: 79.23, refresh: 72 }), { text: '79.2 fps · 72 Hz', warning: true });
  assert.deepEqual(nativeFpsCounter({ ...metrics, controlAgeMs: 2000 }), { text: '90.0 fps · 90 Hz · Office delayed', warning: true });
  assert.deepEqual(nativeFpsCounter({ ...metrics, focused: false }), { text: 'Session paused', warning: true });
  assert.deepEqual(nativeFpsCounter({ fps: Number.NaN, refresh: Infinity }), { text: 'Measuring FPS…', warning: false });
});
