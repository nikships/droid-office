import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildBookshelf } from '../src/client/world/bookshelf.js';
import { BOOKSHELF } from '../src/shared/layout.js';
import { surfaceFinish } from '../src/client/world/surface.js';

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
  return () => (previous ? Object.defineProperty(globalThis, 'document', previous) : Reflect.deleteProperty(globalThis, 'document'));
}

test('Blender bookshelf retains live wiki volumes, labels, location and picking', (t) => {
  t.after(canvasDocument());
  const shelf = buildBookshelf();
  const source = new THREE.Group();
  const cover = new THREE.MeshStandardMaterial({ color: '#353b42' });
  const steel = new THREE.MeshStandardMaterial({ color: '#969ea6', metalness: 0.8 });
  const paint = new THREE.MeshStandardMaterial({ name: 'ShelfCase', color: '#45494e' });
  const body = new THREE.Mesh(new THREE.BoxGeometry(), [cover, steel, paint, cover]);
  body.name = 'BookshelfStatic';
  source.add(body);
  shelf.setWiki('writing');
  const children = [...shelf.group.children];
  const visibility = children.map((c) => c.visible);
  const collider = shelf.collider;
  const interactable = shelf.group.userData.interact;
  assert.equal(shelf.setModel(source), true);
  assert.deepEqual(shelf.group.children, children);
  assert.deepEqual(
    children.map((c) => c.visible),
    visibility,
  );
  assert.equal(shelf.collider, collider);
  assert.equal(shelf.group.userData.interact, interactable);
  assert.deepEqual(shelf.group.position.toArray(), [BOOKSHELF.x, 0, BOOKSHELF.z]);
  assert.equal(shelf.group.rotation.y, Math.PI);
  const loaded = shelf.group.getObjectByName('BookshelfStatic') as THREE.Mesh;
  assert.equal(loaded.geometry, body.geometry);
  const materials = loaded.material as THREE.MeshToonMaterial[];
  assert.ok(materials.every((m) => m.isMeshToonMaterial));
  assert.equal(materials[0], materials[3]);
  assert.equal(surfaceFinish(materials[0]), null);
  assert.deepEqual(surfaceFinish(materials[1]), [0.55, 0.3]);
  assert.deepEqual(surfaceFinish(materials[2]), [0.04, 0.72]);
  assert.equal(body.material[0], cover);
  for (const [state, plain, volumes, written, writing] of [
    ['none', true, false, false, false],
    ['wiki', false, true, true, false],
    ['writing', false, true, false, true],
  ] as const) {
    shelf.setWiki(state);
    assert.deepEqual(
      children.slice(1, 5).map((c) => c.visible),
      [plain, volumes, written, writing],
    );
  }
});

test('missing bookshelf mesh keeps fallback and single-material source is supported', (t) => {
  t.after(canvasDocument());
  const shelf = buildBookshelf();
  const original = shelf.group.children[0].children[0];
  assert.equal(shelf.setModel(new THREE.Group()), false);
  assert.equal(shelf.group.children[0].children[0], original);
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  source.name = 'BookshelfStatic';
  assert.equal(shelf.setModel(source), true);
  assert.ok(((shelf.group.getObjectByName('BookshelfStatic') as THREE.Mesh).material as THREE.MeshToonMaterial).isMeshToonMaterial);
});

test('exported bookshelf retains the existing crown footprint and prop budget', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'));
  const shelf = manifest.bookshelf;
  assert.ok(Math.abs(shelf.width - (BOOKSHELF.width + 0.08)) < 1e-4);
  assert.ok(Math.abs(shelf.height - (BOOKSHELF.height + 0.07)) < 1e-4);
  assert.ok(Math.abs(shelf.depth - (BOOKSHELF.depth + 0.05)) < 1e-4);
  assert.ok(shelf.triangles <= 8000);
});
