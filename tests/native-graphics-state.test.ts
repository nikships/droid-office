import assert from 'node:assert/strict';
import test from 'node:test';
import { getNativeGraphicsSettings, onNativeGraphicsChange, setNativeGraphicsSettings, syncNativeGraphicsSettings } from '../src/client/native/graphics.js';

test('APK graphics are a read-only page mirror and never overwrite office preferences', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const writes: string[] = [];
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: (_key: string, value: string) => writes.push(value),
    },
  });
  t.after(() => (previous ? Object.defineProperty(globalThis, 'localStorage', previous) : Reflect.deleteProperty(globalThis, 'localStorage')));
  let changes = 0;
  const off = onNativeGraphicsChange(() => changes++);
  t.after(off);
  syncNativeGraphicsSettings({ v: 1, renderScale: 1.5, foveation: 'low', fps: true, sharpScreens: false });
  assert.deepEqual(getNativeGraphicsSettings(), { v: 1, renderScale: 1.5, foveation: 'low', fps: true, sharpScreens: false, foveationDebug: false });
  assert.equal(changes, 1);
  assert.deepEqual(writes, []);
  syncNativeGraphicsSettings(getNativeGraphicsSettings());
  assert.equal(changes, 1, 'repeated host reports do not repaint the UI');
  setNativeGraphicsSettings({ foveation: 'high' });
  assert.equal(writes.length, 1, 'legacy page-owned settings still persist');
});
