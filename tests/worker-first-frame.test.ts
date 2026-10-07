import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from '../src/client/world/character';

/** Real characters need text canvases, but this test only checks transforms, without WebGL. */
function canvasDocument() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => {
        const canvas = { width: 1, height: 1, getContext: () => context };
        const context = new Proxy({ canvas, measureText: (text: string) => ({ width: text.length * 12 }) }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) });
        return canvas;
      },
    },
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  };
}

/** A frame that lands on the same timestamp as the one before (or the very first one) has a delta of 0. */
test('a worker whose first frame has no time in it still has a body', (t) => {
  t.after(canvasDocument());
  for (const status of ['working', 'idle', 'needs_input', 'done'] as const) {
    const worker = new Worker('Lead', '#e76f51');
    worker.setStatus(status, false);
    worker.update(0, 0);
    for (let i = 1; i <= 10; i++) worker.update(1 / 60, i / 60);
    const body = worker.root.children[0];
    body.updateMatrix();
    assert.ok(body.matrix.elements.every(Number.isFinite), `${status}: the body's transform went NaN, so nothing of it is drawn`);
  }
});
