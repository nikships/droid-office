import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { buildJukebox } from '../src/client/world/jukebox.js';
import { JUKEBOX } from '../src/shared/layout.js';

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

test('Blender jukebox preserves live display, playing state, beat lighting and notes', (t) => {
  t.after(canvasDocument());
  const jukebox = buildJukebox();
  const source = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: '#b9c2ca', metalness: 0.9 });
  const paint = new THREE.MeshStandardMaterial({ color: '#45494e' });
  const rubber = new THREE.MeshStandardMaterial({ name: 'JukeboxRubber', color: '#202327' });
  const tube = new THREE.MeshStandardMaterial({ name: 'JukeboxTube', color: '#ee6018' });
  const cabinet = new THREE.Mesh(new THREE.BoxGeometry(), [steel, paint, rubber, steel]);
  cabinet.name = 'JukeboxCabinet';
  const light = new THREE.Mesh(new THREE.BoxGeometry(), tube);
  light.name = 'JukeboxNeon';
  source.add(cabinet, light);
  const screen = jukebox.group.children.find((child) => child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial)!;
  const collider = jukebox.collider;
  const interactable = jukebox.group.userData.interact;
  jukebox.show(true, 'Existing music');
  assert.equal(jukebox.setModel(source), true);
  assert.ok(jukebox.group.children.includes(screen));
  assert.equal(jukebox.collider, collider);
  assert.equal(jukebox.group.userData.interact, interactable);
  assert.deepEqual(jukebox.group.position.toArray(), [JUKEBOX.x, 0, JUKEBOX.z]);
  assert.equal(jukebox.group.rotation.y, -Math.PI / 2);
  const loaded = jukebox.group.getObjectByName('JukeboxCabinet') as THREE.Mesh;
  assert.equal(loaded.geometry, cabinet.geometry);
  assert.ok((loaded.material as THREE.MeshToonMaterial[]).every((m) => m.isMeshToonMaterial));
  assert.equal(loaded.material[0], loaded.material[3]);
  const neon = (jukebox.group.getObjectByName('JukeboxNeon') as THREE.Mesh).material as THREE.MeshToonMaterial;
  jukebox.show(true, 'Existing music');
  jukebox.update(1, 0.016, 1);
  const bright = neon.emissiveIntensity;
  jukebox.update(1.1, 0.016, 0);
  assert.ok(bright > neon.emissiveIntensity);
  const notes = jukebox.group.children.filter((c) => c instanceof THREE.Sprite);
  assert.ok(notes.every((n) => n.visible));
  jukebox.show(false, '');
  assert.ok(notes.every((n) => !n.visible));
  assert.equal(neon.emissive.getHexString(), '5a2208');
  jukebox.update(2, 0.016, 1);
  assert.equal(neon.emissiveIntensity, 1);
  assert.equal(light.material, tube, 'source GLB is untouched');
});

test('jukebox keeps the procedural cabinet when either model node is missing', (t) => {
  t.after(canvasDocument());
  const jukebox = buildJukebox();
  const children = [...jukebox.group.children];
  assert.equal(jukebox.setModel(new THREE.Group()), false);
  const source = new THREE.Group();
  const mesh = new THREE.Mesh();
  mesh.name = 'JukeboxCabinet';
  source.add(mesh);
  assert.equal(jukebox.setModel(source), false);
  assert.deepEqual(jukebox.group.children, children);
});
