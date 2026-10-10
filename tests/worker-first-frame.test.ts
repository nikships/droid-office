import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
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

test('a done worker idles only after landing beside its card, and resumes hopping when you leave', (t) => {
  t.after(canvasDocument());
  const worker = new Worker('Lead', '#e76f51');
  worker.setStatus('done', true);
  for (let i = 0; i < 90; i++) worker.update(1 / 60, i / 60);
  assert.equal(worker.animating, true);
  worker.held = true;
  assert.equal(worker.animating, true, 'finish the hop already in progress');
  for (let i = 90; i < 180; i++) worker.update(1 / 60, i / 60);
  assert.equal(worker.bouncing, true, 'attention is still enabled');
  assert.equal(worker.animating, false, 'but the worker is stationary');
  worker.held = false;
  assert.equal(worker.animating, true);
});

test('spawn, work, attention, cheers and dances count as motion, but sleeping and dead poses do not', (t) => {
  t.after(canvasDocument());
  const worker = new Worker('Lead', '#e76f51');
  worker.setStatus('idle', false);
  assert.equal(worker.animating, true, 'a newly hired worker pops into its seat');
  const frames = () => {
    for (let i = 0; i < 360; i++) worker.update(1 / 60, i / 60);
  };
  frames();
  assert.equal(worker.animating, false);
  worker.cheer(0.8);
  assert.equal(worker.animating, true);
  frames();
  assert.equal(worker.animating, false);
  worker.dance({ pos: new THREE.Vector3(), yaw: 0 });
  assert.equal(worker.animating, true);
  frames();
  assert.equal(worker.animating, false);
  worker.setStatus('working', false);
  assert.equal(worker.animating, true);
  worker.setStatus('needs_input', true);
  worker.held = true;
  assert.equal(worker.animating, true, 'waiting still taps a foot, even with the hop held');
  worker.setStatus('offline', false);
  frames();
  assert.equal(worker.animating, false);
  worker.die();
  assert.equal(worker.animating, false, 'the casualty scene owns the fall');
});
