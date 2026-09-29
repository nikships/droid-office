import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RayAccel, TRI_MIN, loadTrees, triangles, wantsTree } from '../src/client/vr/pick.js';

test.before(loadTrees);

const ball = (x: number) => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 24), new THREE.MeshBasicMaterial());
  m.position.x = x;
  m.updateMatrixWorld();
  return m;
};

const cast = (objects: THREE.Object3D[], from: THREE.Vector3, dir: THREE.Vector3) => new THREE.Raycaster(from, dir.normalize()).intersectObjects(objects, true);

test('wantsTree takes only plain meshes with enough triangles', () => {
  assert.ok(triangles(new THREE.SphereGeometry(0.5, 32, 24).toNonIndexed()) >= TRI_MIN);
  assert.equal(wantsTree(ball(0)), true);
  assert.equal(wantsTree(new THREE.Mesh(new THREE.BoxGeometry())), false);
  assert.equal(wantsTree(new THREE.Group()), false);
});

test('RayAccel hits exactly what three hits, uv included, and puts three back on reset', () => {
  const root = new THREE.Group();
  const a = ball(0);
  const b = ball(3);
  const box = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  box.position.set(-3, 0, 0);
  root.add(a, b, box);
  root.updateMatrixWorld(true);

  const rays: [THREE.Vector3, THREE.Vector3][] = [
    [new THREE.Vector3(0.1, 0.2, 5), new THREE.Vector3(0, 0, -1)],
    [new THREE.Vector3(3, -0.3, 5), new THREE.Vector3(0, 0.05, -1)],
    [new THREE.Vector3(-8, 0.1, 0.1), new THREE.Vector3(1, 0, 0)],
    [new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, 1, 0)],
  ];
  const before = rays.map(([o, d]) => cast([root], o.clone(), d.clone()));

  const accel = new RayAccel();
  for (let i = 0; i < 10 && accel.built < 2; i++) accel.update(root);
  // Each ball has its own geometry; the box is below the triangle bar.
  assert.equal(accel.built, 2);
  assert.equal(Object.hasOwn(a, 'raycast'), true);
  assert.equal(Object.hasOwn(box, 'raycast'), false);

  const after = rays.map(([o, d]) => cast([root], o.clone(), d.clone()));
  for (let i = 0; i < rays.length; i++) {
    assert.equal(after[i].length, before[i].length, `ray ${i} hit count`);
    for (let j = 0; j < before[i].length; j++) {
      assert.equal(after[i][j].object, before[i][j].object);
      assert.ok(Math.abs(after[i][j].distance - before[i][j].distance) < 1e-6);
      assert.equal(after[i][j].faceIndex, before[i][j].faceIndex);
      assert.ok(after[i][j].uv && before[i][j].uv && after[i][j].uv!.distanceTo(before[i][j].uv!) < 1e-6);
    }
  }

  accel.reset();
  assert.equal(Object.hasOwn(a, 'raycast'), false);
  assert.equal(accel.built, 0);
  // A second session reuses the trees kept on the geometries: no build, patched on the scan.
  accel.update(root);
  assert.equal(accel.built, 2);
  accel.reset();
});

test('RayAccel leaves meshes with their own raycast alone', () => {
  const root = new THREE.Group();
  const merged = ball(0);
  merged.raycast = () => {};
  root.add(merged);
  const accel = new RayAccel();
  accel.update(root);
  assert.equal(accel.built, 0);
  assert.equal(cast([root], new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1)).length, 0);
});
