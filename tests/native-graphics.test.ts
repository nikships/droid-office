import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_NATIVE_GRAPHICS, nativeFoveationStatus, nativeGraphicsPacket, nativeWorldResolution, readNativeGraphics, stepNativeRenderScale } from '../src/client/native/graphics-settings.js';
import { nativeFpsCounter } from '../src/client/native/performance.js';

test('missing, corrupted and legacy graphics storage uses the tested defaults', () => {
  for (const value of [undefined, null, 'broken', 42, {}]) assert.deepEqual(readNativeGraphics(value), DEFAULT_NATIVE_GRAPHICS);
  assert.deepEqual(readNativeGraphics({ renderScale: Number.NaN, peripheralDensity: Infinity, foveation: 'unknown', fps: 'true', foveationDebug: 'true' }), DEFAULT_NATIVE_GRAPHICS);
  assert.equal('peripheralDensity' in readNativeGraphics({ peripheralDensity: 0.55 }), false, 'the runtime profiles have no density setting');
});

test('graphics changes remain bounded and do not alter the display refresh request', () => {
  assert.deepEqual(readNativeGraphics({ renderScale: 0.1, peripheralDensity: 2, foveation: 'clarity', fps: true }), { v: 1, renderScale: 0.75, foveation: 'clarity', fps: true, sharpScreens: true, foveationDebug: false });
  assert.deepEqual(readNativeGraphics({ renderScale: 3, peripheralDensity: -1, foveation: 'performance', fps: false, sharpScreens: false, foveationDebug: true }), {
    v: 1,
    renderScale: 2,
    foveation: 'performance',
    fps: false,
    sharpScreens: false,
    foveationDebug: true,
  });
  assert.equal(readNativeGraphics({ sharpScreens: 'false' }).sharpScreens, true);
  assert.equal(readNativeGraphics(JSON.parse(JSON.stringify({ ...DEFAULT_NATIVE_GRAPHICS, sharpScreens: false }))).sharpScreens, false);
});

test('legacy recommended settings stay at 100% and higher resolution with foveation off survives storage', () => {
  assert.equal(readNativeGraphics({ v: 1, renderScale: 1 }).renderScale, 1);
  const next = { ...DEFAULT_NATIVE_GRAPHICS, renderScale: 1.65, foveation: 'off' };
  assert.deepEqual(readNativeGraphics(JSON.parse(JSON.stringify(next))), next);
  for (const foveation of ['off', 'performance', 'balanced', 'clarity']) assert.equal(readNativeGraphics({ foveation }).foveation, foveation);
  for (const renderScale of [undefined, '1.7', Number.NaN, Infinity]) assert.equal(readNativeGraphics({ renderScale }).renderScale, 1);
});

const galaxyResolution = {
  worldRecommendedWidth: 1856,
  worldRecommendedHeight: 2160,
  worldMaxWidth: 3152,
  worldMaxHeight: 3682,
  worldWidth: 1856,
  worldHeight: 2160,
  maxRenderScale: 3152 / 1856,
};

test('resolution controls expose the runtime maximum and distinguish selected from applied dimensions', () => {
  const recommended = nativeWorldResolution(galaxyResolution, 1);
  assert.equal(recommended.maxScale, 3152 / 1856);
  assert.equal(recommended.hasMaximum, true);
  assert.deepEqual(recommended.selected, { width: 1856, height: 2160 });
  const raised = nativeWorldResolution(galaxyResolution, 1.5);
  assert.deepEqual(raised.selected, { width: 2784, height: 3240 });
  assert.deepEqual(raised.applied, { width: 1856, height: 2160 });
  const maximum = nativeWorldResolution(galaxyResolution, 2);
  assert.equal(maximum.selectedScale, 3152 / 1856);
  assert.deepEqual(maximum.selected, { width: 3152, height: 3668 });
  assert.deepEqual(maximum.maximum, { width: 3152, height: 3682 });
  assert.deepEqual(nativeWorldResolution({ ...galaxyResolution, maxRenderScale: Math.fround(galaxyResolution.maxRenderScale) }, 2).selected, maximum.selected);
});

test('both eye dimensions bound the slider, including imperfect or absent native metrics', () => {
  const heightLimited = nativeWorldResolution({ ...galaxyResolution, worldMaxHeight: 3000, maxRenderScale: 2 }, 2);
  assert.equal(heightLimited.maxScale, 3000 / 2160);
  assert.deepEqual(heightLimited.selected, { width: 2576, height: 3000 });
  assert.equal(nativeWorldResolution({ ...galaxyResolution, maxRenderScale: undefined }, 2).maxScale, 3152 / 1856);
  assert.equal(nativeWorldResolution({ maxRenderScale: 3 }, 2).maxScale, 2);
  for (const metrics of [undefined, null, 'corrupted', {}, { maxRenderScale: Number.NaN }, { worldRecommendedWidth: Infinity, worldRecommendedHeight: 2160 }]) {
    assert.deepEqual(nativeWorldResolution(metrics, 1.7), { recommended: null, maximum: null, applied: null, selected: null, maxScale: 1, selectedScale: 1, hasMaximum: false });
  }
  assert.equal(nativeWorldResolution(galaxyResolution, Number.NaN).selectedScale, 1);
});

test('resolution steps reach the exact maximum without exceeding it or skipping a whole-percent step', () => {
  const maxScale = galaxyResolution.maxRenderScale;
  assert.equal(stepNativeRenderScale(1.68, 1, maxScale), 1.69);
  assert.equal(stepNativeRenderScale(1.69, 1, maxScale), maxScale);
  assert.equal(stepNativeRenderScale(maxScale, 1, maxScale), maxScale);
  assert.equal(stepNativeRenderScale(maxScale, -1, maxScale), 1.69);
  assert.equal(stepNativeRenderScale(2, -1, maxScale), 1.69);
  assert.equal(stepNativeRenderScale(1.69, -1, maxScale), 1.68);
  assert.equal(stepNativeRenderScale(0.75, -1, maxScale), 0.75);
});

test('persistent counter distinguishes native FPS, display mode and delayed office updates', () => {
  const metrics = { fps: 90.015, refresh: 90, focused: true, controlAgeMs: 30, scene: { objects: 1500, drawCalls: 150, stateSerial: 2 } };
  assert.deepEqual(nativeFpsCounter(metrics), { text: '90.0 fps · 90 Hz', warning: false });
  assert.deepEqual(nativeFpsCounter({ ...metrics, fps: 79.23, refresh: 72 }), { text: '79.2 fps · 72 Hz', warning: true });
  assert.deepEqual(nativeFpsCounter({ ...metrics, controlAgeMs: 2000 }), { text: '90.0 fps · 90 Hz · Office delayed', warning: true });
  assert.deepEqual(nativeFpsCounter({ ...metrics, focused: false }), { text: 'Session paused', warning: true });
  assert.deepEqual(nativeFpsCounter({ fps: Number.NaN, refresh: Infinity }), { text: 'Measuring FPS…', warning: false });
});

test('the native packet keeps the field older APKs require', () => {
  const packet = nativeGraphicsPacket({ ...DEFAULT_NATIVE_GRAPHICS, foveation: 'off', foveationDebug: true });
  assert.equal(packet.peripheralDensity, 0.25);
  assert.equal(packet.foveation, 'off');
  assert.equal(packet.foveationDebug, true);
  assert.deepEqual(JSON.parse(JSON.stringify({ ...packet, foveationDebug: undefined })).foveationDebug, undefined, 'the diagnostic view is not stored');
});

test('the applied foveation reads the runtime profile the headset reports', () => {
  assert.equal(nativeFoveationStatus(undefined), null);
  assert.equal(nativeFoveationStatus({ foveationEnabled: true }), 'Currently applied: On.');
  assert.equal(nativeFoveationStatus({ foveation: { level: 'medium', eyeTracked: true, fallback: '' } }), 'Currently applied: Medium runtime level, follows your eyes.');
  assert.equal(nativeFoveationStatus({ foveation: { level: 'high', eyeTracked: false, fallback: 'eye-tracked profile rejected' } }), 'Currently applied: High runtime level, fixed at the centre. Fallback: eye-tracked profile rejected.');
  assert.equal(nativeFoveationStatus({ foveation: { level: 'none', eyeTracked: false } }), 'Currently applied: Off (full detail everywhere).');
  assert.equal(nativeFoveationStatus({ foveation: { level: 'none', setting: 'off', fallback: '' } }), 'Currently applied: Off (full detail everywhere).');
  assert.equal(nativeFoveationStatus({ foveation: { level: 'unfoveated' } }), 'Currently applied: full detail everywhere (no runtime foveation).');
  assert.equal(nativeFoveationStatus({ foveation: 'broken', foveationEnabled: false }), 'Currently applied: Off.');
});

test('the menu reports the bound targets while a new foveation choice is still being applied', () => {
  assert.equal(nativeFoveationStatus({ foveation: { level: 'medium', setting: 'off', eyeTracked: true, pending: true } }), 'Currently applied: Medium runtime level, follows your eyes. Applying your choice…');
  assert.equal(nativeFoveationStatus({ foveation: { level: 'none', setting: 'balanced', pending: true } }), 'Currently applied: Off (full detail everywhere). Applying your choice…');
  assert.equal(
    nativeFoveationStatus({ foveation: { level: 'none', setting: 'balanced', pending: false, fallback: 'foveation profile rejected' } }),
    'Currently applied: full detail everywhere (no runtime foveation). Fallback: foveation profile rejected.',
  );
  assert.equal(nativeFoveationStatus({ foveation: { level: 'high', setting: 'performance', eyeTracked: false, pending: false, fallback: '' } }), 'Currently applied: High runtime level, fixed at the centre.');
});
