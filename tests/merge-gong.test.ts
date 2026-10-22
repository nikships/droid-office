import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { buildGong } from '../src/client/world/gong.js';
import { GONG } from '../src/shared/layout.js';

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

test('Blender gong preserves mounting, independent disc motion, strike glow and picking', (t) => {
  t.after(canvasDocument());
  const gong = buildGong();
  const source = new THREE.Group();
  const bronze = new THREE.MeshStandardMaterial({ name: 'GongBronze', color: '#c7a877', metalness: 0.85 });
  const steel = new THREE.MeshStandardMaterial({ color: '#a0a8af', metalness: 0.85 });
  const cord = new THREE.MeshStandardMaterial({ color: '#292b2e' });
  for (const [name, material, y] of [
    ['GongFrame', [steel, cord], 1.2],
    ['GongDisc', [bronze, steel], 1.09],
    ['GongCords', cord, 1.9],
  ] as const) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.05).translate(0, y, 0), material as THREE.Material | THREE.Material[]);
    mesh.name = name;
    source.add(mesh);
  }
  const collider = gong.colliders;
  const interaction = gong.group.userData.interact;
  assert.equal(gong.setModel(source), true);
  assert.equal(gong.colliders, collider);
  assert.equal(gong.group.userData.interact, interaction);
  const disc = gong.group.getObjectByName('GongDisc') as THREE.Mesh;
  const frame = gong.group.getObjectByName('GongFrame') as THREE.Mesh;
  const materials = disc.material as THREE.MeshToonMaterial[];
  assert.ok(materials.every((mat) => mat.isMeshToonMaterial));
  assert.equal(materials[1], (frame.material as THREE.Material[])[0]);
  assert.equal((source.children[1] as THREE.Mesh).material[0], bronze);
  assert.equal(disc.geometry, (source.children[1] as THREE.Mesh).geometry);
  gong.group.updateMatrixWorld(true);
  assert.ok(Math.abs(new THREE.Box3().setFromObject(disc).getCenter(new THREE.Vector3()).y - 1.09) < 1e-6);
  assert.deepEqual(gong.group.position.toArray(), [GONG.x, 0, GONG.z]);
  gong.strike();
  gong.update(1 / 60);
  assert.ok(materials[0].emissiveIntensity > 0.1);
  assert.ok(disc.parent!.parent!.rotation.x > 0, 'disc swings under the original suspension pivot');
  assert.equal(frame.parent!.rotation.x, 0, 'stand never swings');
  gong.strike(0.5);
  gong.update(20);
  gong.update(1);
  assert.equal(disc.parent!.parent!.rotation.x, 0);
  assert.ok(materials[0].emissiveIntensity < 1e-8);
});

test('an incomplete model keeps the procedural gong intact and playable', (t) => {
  t.after(canvasDocument());
  const gong = buildGong();
  const children = [...gong.group.children];
  assert.equal(gong.setModel(new THREE.Group()), false);
  assert.deepEqual(gong.group.children, children);
  gong.strike(2);
  gong.update(0.05);
  gong.update(30);
  gong.update(1);
});
