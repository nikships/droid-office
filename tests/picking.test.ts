import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { boundStaticRaycast, visibleIntersections } from '../src/client/world/picking.js';
import { mergeByMaterial, toonUnique } from '../src/client/world/toon.js';

function box(z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  mesh.position.z = z;
  return mesh;
}

function ray(): THREE.Raycaster {
  return new THREE.Raycaster(new THREE.Vector3(0.1, 0.2, 5), new THREE.Vector3(0, 0, -1));
}

test('visible picking preserves the exact sorted hits, UVs and transforms of the normal raycaster', () => {
  const root = new THREE.Group();
  const near = box(2);
  const far = box(-2);
  far.rotation.y = 0.3;
  root.add(far, near);
  root.updateMatrixWorld(true);
  const cast = ray();
  assert.deepEqual(visibleIntersections(cast, [root]), cast.intersectObject(root, true));
  assert.equal(visibleIntersections(cast, [root])[0].object, near);
});

test('hidden objects and all descendants skip raycasting, even when their own visible flag is true', () => {
  const root = new THREE.Group();
  const hidden = new THREE.Group();
  const hiddenMesh = box(3);
  hidden.visible = false;
  hidden.add(hiddenMesh);
  const visible = box(0);
  root.add(hidden, visible);
  root.updateMatrixWorld(true);
  hiddenMesh.raycast = () => assert.fail('hidden geometry must not be tested');
  const hits = visibleIntersections(ray(), [root]);
  assert.ok(hits.length > 0);
  assert.ok(hits.every((hit) => hit.object === visible));
  visible.visible = false;
  assert.deepEqual(visibleIntersections(ray(), [root]), []);
  hidden.visible = true;
  hiddenMesh.raycast = THREE.Mesh.prototype.raycast;
  assert.equal(visibleIntersections(ray(), [root])[0].object, hiddenMesh, 'shown models become pickable immediately');
});

test('picking respects layers without hiding children on another layer', () => {
  const root = new THREE.Group();
  root.layers.set(1);
  root.raycast = () => assert.fail('the root is on an excluded layer');
  const mesh = box(0);
  root.add(mesh);
  root.updateMatrixWorld(true);
  assert.equal(visibleIntersections(ray(), [root])[0].object, mesh);
  mesh.layers.set(1);
  assert.deepEqual(visibleIntersections(ray(), [root]), []);
});

test('a custom raycast can stop recursion, as with the normal raycaster', () => {
  const root = new THREE.Group();
  root.raycast = () => false;
  const mesh = box(0);
  mesh.raycast = () => assert.fail('the parent stopped recursion');
  root.add(mesh);
  assert.deepEqual(visibleIntersections(ray(), [root]), []);
});

test('static batches skip empty space between source solids without reading any triangles', () => {
  const root = new THREE.Group();
  const material = toonUnique('#ffffff');
  for (const x of [-4, 4]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    mesh.position.x = x;
    root.add(mesh);
  }
  const merged = mergeByMaterial(root);
  const mesh = merged.children[0] as THREE.Mesh;
  merged.rotation.y = 0.3;
  merged.position.set(0, 0, -2);
  merged.updateMatrixWorld(true);
  mesh.geometry.computeBoundingSphere();
  const positions = mesh.geometry.getAttribute('position');
  let reads = 0;
  const getX = positions.getX.bind(positions);
  positions.getX = (i) => {
    reads++;
    return getX(i);
  };
  const cast = ray();
  assert.deepEqual(cast.intersectObject(mesh), []);
  assert.equal(reads, 0);
  const accelerated = mesh.raycast;
  mesh.raycast = THREE.Mesh.prototype.raycast;
  assert.deepEqual(cast.intersectObject(mesh), []);
  assert.ok(reads > 0, 'the full batch tests triangles across the empty gap');
  mesh.raycast = accelerated;
  const target = new THREE.Vector3(4, 0.2, 0.1).applyMatrix4(mesh.matrixWorld);
  cast.ray.origin.copy(target).add(new THREE.Vector3(0, 3, 0));
  cast.ray.direction.set(0, -1, 0);
  const bounded = cast.intersectObject(mesh);
  mesh.raycast = THREE.Mesh.prototype.raycast;
  assert.ok(bounded.length > 0);
  assert.deepEqual(bounded, cast.intersectObject(mesh), 'face indices, normals, points and ordering remain exact');
});

test('bounded picking intersects the original draw range and restores it, including after a throw', () => {
  const geometry = new THREE.BoxGeometry();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  geometry.setDrawRange(3, 18);
  const ranges: { start: number; count: number }[] = [];
  mesh.raycast = () => {
    ranges.push({ ...geometry.drawRange });
  };
  const chunks = [
    { box: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)), start: 0, count: 12 },
    { box: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)), start: 12, count: 24 },
  ];
  boundStaticRaycast(mesh, chunks);
  mesh.raycast(ray(), []);
  assert.deepEqual(ranges, [
    { start: 3, count: 9 },
    { start: 12, count: 9 },
  ]);
  assert.deepEqual(geometry.drawRange, { start: 3, count: 18 });
  mesh.raycast = () => {
    throw new Error('test');
  };
  boundStaticRaycast(mesh, chunks);
  assert.throws(() => mesh.raycast(ray(), []), /test/);
  assert.deepEqual(geometry.drawRange, { start: 3, count: 18 });
});
