import assert from 'node:assert/strict';
import test from 'node:test';
import type * as THREE from 'three';
import { randomLook } from '../src/shared/avatar';
import { isSharedGeometry, Person } from '../src/client/world/character';

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
