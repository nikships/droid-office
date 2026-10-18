import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { randomLook } from '../src/shared/avatar';
import { isSharedGeometry, parseWorker, Person, WORKER_PIVOTS, Worker, workerReady } from '../src/client/world/character';

/** A person needs text canvases for its label; this only looks at its meshes. */
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

test('only the crew kit counts as shared geometry, and every person wears the same one', () => {
  const restore = canvasDocument();
  try {
    const kitGeometries = (p: Person) => {
      const kit = p.root.getObjectByName('crew-kit');
      assert.ok(kit, 'a person wears a crew kit');
      return kit.children.map((m) => (m as THREE.Mesh).geometry);
    };
    const a = new Person('A', '#161616', randomLook());
    const b = new Person('B', '#3a3a3a', randomLook());
    const kit = kitGeometries(a);
    assert.equal(kit.length, 2);
    for (const geo of kit) assert.ok(isSharedGeometry(geo));
    assert.deepEqual(kitGeometries(b), kit);

    const own: THREE.BufferGeometry[] = [];
    a.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !kit.includes(m.geometry)) own.push(m.geometry);
    });
    assert.ok(own.length > 0);
    for (const geo of own) assert.equal(isSharedGeometry(geo), false);
  } finally {
    restore();
  }
});

test('droid-worker.glb upgrades waiting workers and mounts articulated droid parts on shared geometry', async () => {
  const restore = canvasDocument();
  try {
    const waiting = new Worker('Waiting', '#ee6018');
    waiting.setStatus('working');
    waiting.update(0.1, 1.0);

    const glb = readFileSync(new URL('../src/client/public/props/droid-worker.glb', import.meta.url));
    await parseWorker(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));
    assert.equal(workerReady(), true);

    const fresh = new Worker('Fresh', '#3b82f6');
    waiting.body.scale.setScalar(1);
    for (const w of [waiting, fresh]) {
      w.root.updateMatrixWorld(true);
      const box = new THREE.Box3();
      w.body.traverseVisible((o) => {
        if ((o as THREE.Mesh).isMesh) box.expandByObject(o);
      });
      const size = box.getSize(new THREE.Vector3());
      assert.ok(size.x > 0.65 && size.x < 0.75, `width ${size.x}`);
      assert.ok(size.y > 1.1 && size.y < 1.3, `height ${size.y}`);
      assert.ok(size.z > 0.44 && size.z < 0.56, `depth ${size.z}`);

      const skin = w.body.children[0] as THREE.Mesh;
      assert.ok(skin.isMesh, 'body.children[0] remains the worker-colored armor mesh');
      assert.equal(isSharedGeometry(skin.geometry), false, 'each worker owns a clone of the GLB geometry so casualties can dispose it');
    }

    assert.equal(fresh.armL.position.x, WORKER_PIVOTS.armL.x);
    assert.equal(fresh.armR.position.x, WORKER_PIVOTS.armR.x);
    fresh.setStatus('working');
    fresh.update(0.2, 1.2);
    fresh.leave('Heading out');
    fresh.say('See ya');
    fresh.update(0.1, 1.3);
    waiting.die(false);
    waiting.update(0.1, 1.3);
    waiting.revive();
    waiting.dispose();
    fresh.dispose();
  } finally {
    restore();
  }
});
