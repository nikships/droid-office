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

test('a fork splits from the source toward its new seat and lands exactly at its anchor', (t) => {
  t.after(canvasDocument());
  const worker = new Worker('Twin', '#e76f51');
  worker.setStatus('idle', false);
  worker.splitFrom(new THREE.Vector3(-2.2, 0, 0));
  assert.equal(worker.root.position.x, -2.2, 'starts at the source to the left');
  worker.update(0.325, 0.325);
  assert.ok(Math.abs(worker.root.position.x + 1.1) < 1e-8, 'moves right toward the new seat');
  assert.ok(worker.root.position.y > 0, 'rises slightly in the split');
  assert.equal(worker.animating, true);
  worker.update(0.325, 0.65);
  assert.deepEqual(worker.root.position.toArray(), [0, 0, 0]);
  worker.update(1, 1.65);
  assert.equal(worker.animating, false);
  worker.dispose();
});

test('a fork finishes its split before a dance or levitation can start', (t) => {
  t.after(canvasDocument());
  const worker = new Worker('Twin', '#e76f51');
  worker.setStatus('idle', false);
  worker.splitFrom(new THREE.Vector3(-2.2, 0, 0));
  worker.update(0.325, 0.325);
  assert.equal(worker.levitate(), false);
  worker.dance({ pos: new THREE.Vector3(), yaw: 0 });
  worker.update(0.325, 0.65);
  assert.deepEqual(worker.root.position.toArray(), [0, 0, 0], 'a dance cannot freeze the split mid-flight');
  assert.equal(worker.levitate(), true, 'other poses work again after landing');
  worker.dispose();
});

test('stopping a pose, sending home or shooting a twin cancels its split at the seat', (t) => {
  t.after(canvasDocument());
  for (const action of ['stop', 'leave', 'die'] as const) {
    const worker = new Worker('Twin', '#e76f51');
    worker.setStatus('idle', false);
    worker.splitFrom(new THREE.Vector3(-2.2, 0, 0));
    worker.update(0.325, 0.325);
    if (action === 'stop') worker.stopDancing();
    else if (action === 'leave') worker.leave('Goodbye');
    else worker.die();
    assert.deepEqual(worker.root.position.toArray(), [0, 0, 0], action);
    worker.update(0.1, 0.425);
    assert.deepEqual(worker.root.position.toArray(), [0, 0, 0], `${action} cannot resume a stale split`);
    worker.dispose();
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

test('visit poses and speech keep an otherwise idle worker animating until they end', (t) => {
  t.after(canvasDocument());
  const worker = new Worker('Visitor', '#e76f51');
  worker.setStatus('idle', false);
  const frames = (n: number) => {
    for (let i = 0; i < n; i++) worker.update(1 / 60, i / 60);
  };
  frames(360);
  assert.equal(worker.animating, false);
  for (const pose of ['stand', 'peer', 'talk'] as const) {
    worker.visitPose = pose;
    assert.equal(worker.animating, true, pose);
  }
  worker.visitPose = null;
  worker.speak('Checking your screen', 'VISITOR SAYS', 'v-1', 1);
  assert.equal(worker.animating, true);
  frames(180);
  assert.equal(worker.saying, null);
  assert.equal(worker.animating, false);
  worker.dispose();
});

test('a cheer never overrides a visitor leaning over the host laptop', (t) => {
  t.after(canvasDocument());
  const worker = new Worker('Visitor', '#e76f51');
  const control = new Worker('Control', '#e76f51');
  for (const model of [worker, control]) {
    model.setStatus('idle', false);
    model.visitPose = 'peer';
    for (let i = 0; i < 120; i++) model.update(1 / 60, i / 60);
  }
  worker.cheer(3);
  for (let i = 120; i < 180; i++) {
    worker.update(1 / 60, i / 60);
    control.update(1 / 60, i / 60);
    assert.ok(Math.abs(worker.lean - control.lean) < 1e-9, 'the peer pose still controls the body');
    assert.equal(worker.root.children[0].position.y, control.root.children[0].position.y, 'no celebration hop');
  }
  worker.dispose();
  control.dispose();
});
