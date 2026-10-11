import assert from 'node:assert/strict';
import test from 'node:test';
import type * as THREE from 'three';
import { FADE_FAR, FADE_NEAR, labelFade, Worker } from '../src/client/world/character';

/** Real characters need text canvases, but this test only reads sprite materials, without WebGL. */
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

test('a worker card is gone over its shoulder, fades in walking away and is solid from across the room', () => {
  assert.equal(labelFade(0.5), 0);
  assert.equal(labelFade(FADE_NEAR), 0);
  assert.equal(labelFade(FADE_FAR), 1);
  assert.equal(labelFade(10), 1);
  let last = 0;
  for (let d = FADE_NEAR; d <= FADE_FAR; d += 0.1) {
    const a = labelFade(d);
    assert.ok(a >= last, `opacity drops walking away at ${d.toFixed(1)} m`);
    last = a;
  }
  const mid = labelFade((FADE_NEAR + FADE_FAR) / 2);
  assert.ok(Math.abs(mid - 0.5) < 1e-9, 'half way through the fade is half opaque');
});

test("a worker's card and name tag take its fade, and keep it through a new card", (t) => {
  t.after(canvasDocument());
  const worker = new Worker('Lead', '#e76f51');
  worker.setStatus('working', false);
  worker.setTask({ name: 'Fix the login page', summary: 'The form loses focus' });
  const sprites = () => worker.root.children.filter((c): c is THREE.Sprite => (c as THREE.Sprite).isSprite);
  assert.equal(sprites().length, 2, 'a card and a name tag');

  worker.update(1 / 60, 0);
  for (const s of sprites()) assert.equal(s.material.opacity, 1, 'far off, by default, both are solid');

  worker.seenFrom(1);
  worker.update(1 / 60, 1 / 60);
  for (const s of sprites()) assert.equal(s.material.opacity, 0, 'looking over its shoulder, both are gone');

  // A status change redraws the card; the next frame fades the new one too.
  worker.setStatus('needs_input', true);
  worker.update(1 / 60, 2 / 60);
  for (const s of sprites()) assert.equal(s.material.opacity, 0);

  worker.seenFrom(FADE_FAR + 1);
  worker.update(1 / 60, 3 / 60);
  for (const s of sprites()) assert.equal(s.material.opacity, 1);
});
