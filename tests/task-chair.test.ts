import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { installTaskChairs } from '../src/client/world/task-chair.js';
import { surfaceFinish } from '../src/client/world/surface.js';

test('task chair swap preserves swivel groups, shares geometry and converts every material', () => {
  const source = new THREE.Group();
  const fabric = new THREE.MeshStandardMaterial({ color: '#73777c' });
  const steel = new THREE.MeshStandardMaterial({ color: '#969da5', metalness: 0.8 });
  const geometry = new THREE.BoxGeometry(0.6, 0.1, 0.56);
  const mesh = new THREE.Mesh(geometry, [fabric, steel]);
  source.add(mesh);
  const chairs = [new THREE.Group(), new THREE.Group()];
  for (const chair of chairs) {
    chair.position.set(2, 0, 0.9);
    chair.rotation.y = 0.7;
    chair.userData.seat = 'retained';
    chair.add(new THREE.Object3D());
  }
  installTaskChairs(source, chairs);
  const first = chairs[0].children[0].children[0] as THREE.Mesh;
  const second = chairs[1].children[0].children[0] as THREE.Mesh;
  assert.equal(chairs[0].position.x, 2);
  assert.equal(chairs[0].position.z, 0.9);
  assert.equal(chairs[0].rotation.y, 0.7);
  assert.equal(chairs[0].userData.seat, 'retained');
  assert.equal(chairs[0].children.length, 1);
  assert.equal(chairs[0].children[0].name, 'task-chair');
  assert.equal(first.geometry, geometry);
  assert.equal(second.geometry, geometry);
  const materials = first.material as THREE.MeshToonMaterial[];
  assert.ok(materials.every((material) => material.isMeshToonMaterial));
  assert.equal(materials[0], (second.material as THREE.Material[])[0]);
  assert.equal(materials[0].color.getHexString(), '73777c');
  assert.deepEqual(surfaceFinish(materials[1]), [0.55, 0.3]);
  assert.equal(mesh.material[0], fabric, 'the cached GLB stays untouched');
});

test('single-material chairs retain a single toon material', () => {
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  const chair = new THREE.Group();
  installTaskChairs(source, [chair]);
  const model = chair.children[0] as THREE.Mesh;
  assert.ok((model.material as THREE.MeshToonMaterial).isMeshToonMaterial);
});
