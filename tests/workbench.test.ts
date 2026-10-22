import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { installWorkbenches } from '../src/client/world/workbench.js';
import { surfaceFinish } from '../src/client/world/surface.js';
import { DESK_SIZE } from '../src/shared/layout.js';

test('workbench swap keeps the desk, anchors, chair, picking and shared resources', () => {
  const source = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: '#b6bdc5', metalness: 0.85 });
  const paint = new THREE.MeshStandardMaterial({ color: '#969696' });
  const rubber = new THREE.MeshStandardMaterial({ color: '#292d31', name: 'BenchRubber' });
  const geometry = new THREE.BoxGeometry(2.14, 0.045, 1.06);
  source.add(new THREE.Mesh(geometry, [steel, paint, rubber]));
  const desks = [new THREE.Group(), new THREE.Group()];
  for (const desk of desks) {
    desk.position.set(3, 0, 4);
    desk.rotation.y = Math.PI;
    desk.userData.interact = { kind: 'desk', deskId: 'desk-1' };
    const workbench = new THREE.Group();
    workbench.name = 'workbench';
    workbench.add(new THREE.Object3D());
    desk.add(workbench);
    for (const name of ['laptop', 'worker', 'chair', 'vacancy']) {
      const anchor = new THREE.Group();
      anchor.name = name;
      desk.add(anchor);
    }
  }
  const children = [...desks[0].children];
  installWorkbenches(source, [...desks, new THREE.Group()]);
  assert.deepEqual(desks[0].children, children);
  assert.deepEqual(desks[0].position.toArray(), [3, 0, 4]);
  assert.equal(desks[0].rotation.y, Math.PI);
  assert.deepEqual(desks[0].userData.interact, { kind: 'desk', deskId: 'desk-1' });
  const first = desks[0].getObjectByName('workbench-model')!.children[0] as THREE.Mesh;
  const second = desks[1].getObjectByName('workbench-model')!.children[0] as THREE.Mesh;
  assert.equal(first.geometry, geometry);
  assert.equal(second.geometry, geometry);
  const materials = first.material as THREE.MeshToonMaterial[];
  assert.ok(materials.every((material) => material.isMeshToonMaterial));
  assert.equal(materials[0], (second.material as THREE.Material[])[0]);
  assert.deepEqual(surfaceFinish(materials[0]), [0.55, 0.3]);
  assert.deepEqual(surfaceFinish(materials[1]), [0.04, 0.72]);
  assert.equal(surfaceFinish(materials[2]), null);
  assert.equal(materials[1].color.getHexString(), '969696');
  assert.equal((source.children[0] as THREE.Mesh).material[0], steel);
});

test('workbench handles single-material meshes without allocating per-desk geometry', () => {
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  const desk = new THREE.Group();
  const bench = new THREE.Group();
  bench.name = 'workbench';
  desk.add(bench);
  installWorkbenches(source, [desk]);
  const model = bench.children[0] as THREE.Mesh;
  assert.ok((model.material as THREE.MeshToonMaterial).isMeshToonMaterial);
  assert.equal(model.geometry, source.geometry);
});

test('exported workbench fits the unchanged desk surface and prop budget', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'));
  const bench = manifest.workbench;
  assert.equal(bench.width, DESK_SIZE.width - 0.06);
  assert.equal(bench.depth, DESK_SIZE.depth - 0.04);
  assert.equal(bench.height, DESK_SIZE.height);
  assert.ok(bench.triangles <= 8000);
  assert.equal(bench.materials, 5);
  assert.equal(readFileSync(new URL('../src/client/public/props/workbench.glb', import.meta.url)).byteLength, bench.bytes);
});
