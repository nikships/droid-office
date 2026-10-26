import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { boundStaticRaycast, firstVisibleIntersection, preparePicking, visibleIntersections } from '../src/client/world/picking.js';
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

for (const indexed of [true, false]) {
  test(`triangle bounds preserve exact ${indexed ? 'indexed' : 'non-indexed'} hits and draw ranges`, () => {
    const source = new THREE.TorusKnotGeometry(1, 0.3, 80, 8);
    const geometry = indexed ? source : source.toNonIndexed();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.position.set(1, 0.2, -2);
    mesh.rotation.set(0.2, 0.4, -0.1);
    mesh.scale.set(1.1, 0.8, 1.4);
    mesh.updateMatrixWorld(true);
    preparePicking(mesh);
    for (const range of [
      { start: 0, count: Infinity },
      { start: 12, count: 900 },
      { start: 1, count: 101 },
      { start: 0, count: 0 },
    ]) {
      geometry.setDrawRange(range.start, range.count);
      for (let x = -1; x <= 3; x += 0.2) {
        const cast = new THREE.Raycaster(new THREE.Vector3(x, 0.2, 5), new THREE.Vector3(0, 0, -1), 0.1, 20);
        assert.deepEqual(visibleIntersections(cast, [mesh]), cast.intersectObject(mesh));
        assert.deepEqual(geometry.drawRange, range);
      }
    }
  });
}

test('shared triangle bounds skip detailed geometry across empty space without changing buffers', () => {
  const geometry = new THREE.TorusGeometry(2, 0.1, 12, 80);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.updateMatrixWorld(true);
  const index = geometry.index;
  const positions = geometry.getAttribute('position');
  const original = positions.array.slice();
  preparePicking(mesh);
  let reads = 0;
  const get = mesh.getVertexPosition;
  const getX = positions.getX.bind(positions);
  positions.getX = (i) => {
    reads++;
    return getX(i);
  };
  const cast = new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1));
  assert.deepEqual(visibleIntersections(cast, [mesh]), []);
  const boundedReads = reads;
  cast.intersectObject(mesh);
  assert.ok(reads > boundedReads * 10, `${boundedReads} bounded reads versus ${reads - boundedReads} unbounded reads`);
  assert.equal(mesh.getVertexPosition, get);
  assert.equal(geometry.index, index);
  assert.deepEqual(positions.array, original);
  const clone = mesh.clone();
  clone.position.z = 1;
  clone.updateMatrixWorld(true);
  assert.deepEqual(visibleIntersections(cast, [clone]), cast.intersectObject(clone));
});

test('triangle bounds rebuild for changed or replaced position and index buffers', () => {
  const geometry = new THREE.PlaneGeometry(2, 2, 20, 20);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  preparePicking(mesh);
  for (let i = 0; i < 3; i++) {
    const positions = geometry.getAttribute('position');
    for (let j = 0; j < positions.count; j++) positions.setX(j, positions.getX(j) + 2);
    positions.needsUpdate = true;
    geometry.computeBoundingSphere();
    if (i === 1) geometry.setAttribute('position', positions.clone());
    if (i === 2) geometry.setIndex(geometry.index!.clone());
    const cast = new THREE.Raycaster(new THREE.Vector3(2 * (i + 1), 0, 5), new THREE.Vector3(0, 0, -1));
    const expected = cast.intersectObject(mesh);
    assert.ok(expected.length);
    assert.deepEqual(visibleIntersections(cast, [mesh]), expected);
  }
});

test('morphed, custom and multi-material meshes keep their original raycaster', () => {
  const geometry = new THREE.PlaneGeometry(2, 2, 20, 20);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  geometry.morphAttributes.position = [geometry.getAttribute('position').clone()];
  mesh.updateMorphTargets();
  mesh.morphTargetInfluences![0] = 0.5;
  const cast = ray();
  assert.deepEqual(visibleIntersections(cast, [mesh]), cast.intersectObject(mesh));
  delete geometry.morphAttributes.position;
  const original = mesh.getVertexPosition;
  mesh.getVertexPosition = (index, point) => original.call(mesh, index, point);
  assert.deepEqual(visibleIntersections(cast, [mesh]), cast.intersectObject(mesh));
  mesh.getVertexPosition = original;
  const multi = new THREE.Mesh(geometry, [mesh.material]);
  geometry.addGroup(0, geometry.index!.count, 0);
  assert.deepEqual(visibleIntersections(cast, [multi]), cast.intersectObject(multi));
});

test('interleaved positions invalidate their bounds when the shared buffer changes', () => {
  const geometry = new THREE.PlaneGeometry(2, 2, 20, 20);
  const original = geometry.getAttribute('position');
  const values = new Float32Array(original.count * 4);
  for (let i = 0; i < original.count; i++) values.set([original.getX(i), original.getY(i), original.getZ(i), 9], i * 4);
  const position = new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(values, 4), 3, 0);
  geometry.setAttribute('position', position);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  preparePicking(mesh);
  for (let i = 0; i < position.count; i++) position.setX(i, position.getX(i) + 3);
  position.needsUpdate = true;
  geometry.computeBoundingSphere();
  const cast = new THREE.Raycaster(new THREE.Vector3(3, 0, 5), new THREE.Vector3(0, 0, -1));
  const expected = cast.intersectObject(mesh);
  assert.ok(expected.length);
  assert.deepEqual(visibleIntersections(cast, [mesh]), expected);
});

test('changed index data rebuilds triangle bounds without changing face or UV results', () => {
  const geometry = new THREE.PlaneGeometry(2, 2, 20, 20);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  preparePicking(mesh);
  const index = geometry.index!;
  for (let i = 0; i < index.count; i++) index.setX(i, (index.getX(i) + 200) % geometry.getAttribute('position').count);
  index.needsUpdate = true;
  for (let x = -0.9; x < 1; x += 0.3) {
    const cast = new THREE.Raycaster(new THREE.Vector3(x, 0.2, 5), new THREE.Vector3(0, 0, -1), 0, 6);
    assert.deepEqual(visibleIntersections(cast, [mesh]), cast.intersectObject(mesh));
    cast.far = 4;
    assert.deepEqual(visibleIntersections(cast, [mesh]), []);
    cast.far = 6;
    cast.near = 5.1;
    assert.deepEqual(visibleIntersections(cast, [mesh]), []);
  }
});

test('triangle picking restores the shared geometry range when an exact vertex read throws', () => {
  const geometry = new THREE.PlaneGeometry(2, 2, 20, 20);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  preparePicking(mesh);
  geometry.computeBoundingSphere();
  const range = { ...geometry.drawRange };
  geometry.getAttribute('position').getX = () => {
    throw new Error('vertex read failed');
  };
  assert.throws(() => visibleIntersections(ray(), [mesh]), /vertex read failed/);
  assert.deepEqual(geometry.drawRange, range);
});

test('nearest visible picking matches the full exact list across transforms, clipping and source order', () => {
  const root = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  for (const z of [-5, 1, -1, 2]) {
    const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.3, 80, 8), material);
    mesh.position.set(0.1, 0.2, z);
    mesh.rotation.set(0.2, 0.4, -0.1);
    mesh.scale.set(0.9, 1.2, 1.4);
    root.add(mesh);
  }
  root.updateMatrixWorld(true);
  preparePicking(root);
  for (const children of [root.children, [...root.children].reverse()]) {
    for (const far of [Infinity, 3, 5, 10]) {
      for (let x = -1; x <= 1; x += 0.2) {
        const cast = new THREE.Raycaster(new THREE.Vector3(x, 0.2, 5), new THREE.Vector3(0, 0, -1), 0.1, far);
        const expected = visibleIntersections(cast, children)[0] ?? null;
        assert.deepEqual(firstVisibleIntersection(cast, children), expected);
        assert.equal(cast.near, 0.1);
        assert.equal(cast.far, far);
      }
    }
  }
});

test('nearest visible picking preserves equal-distance source order and non-interactive occlusion', () => {
  const first = box(2);
  const second = box(2);
  second.userData.interact = { kind: 'desk' };
  first.updateMatrixWorld(true);
  second.updateMatrixWorld(true);
  for (const roots of [
    [first, second],
    [second, first],
  ]) {
    const hits = visibleIntersections(ray(), roots);
    assert.deepEqual(firstVisibleIntersection(ray(), roots), hits[0]);
    assert.equal(firstVisibleIntersection(ray(), roots)?.object, roots[0]);
  }
});

test('nearest picking ignores hidden ancestors outside the supplied roots and retains layer recursion', () => {
  const hidden = new THREE.Group();
  const hiddenMesh = box(3);
  hidden.add(hiddenMesh);
  hidden.visible = false;
  const group = new THREE.Group();
  group.layers.set(1);
  const visible = box(0);
  group.add(visible);
  hidden.updateMatrixWorld(true);
  group.updateMatrixWorld(true);
  hiddenMesh.raycast = () => assert.fail('a hidden ancestor must exclude this root');
  group.raycast = () => assert.fail('excluded layer must not raycast');
  assert.equal(firstVisibleIntersection(ray(), [hiddenMesh, group])?.object, visible);
  visible.visible = false;
  assert.equal(firstVisibleIntersection(ray(), [hiddenMesh, group]), null);
});

test('nearest picking rejects farther exact triangle reads and restores the original far distance', () => {
  const near = box(2);
  const far = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), new THREE.MeshBasicMaterial());
  far.position.z = -5;
  near.updateMatrixWorld(true);
  far.updateMatrixWorld(true);
  far.geometry.computeBoundingSphere();
  preparePicking(far);
  let reads = 0;
  const positions = far.geometry.getAttribute('position');
  const get = positions.getX.bind(positions);
  positions.getX = (i) => {
    reads++;
    return get(i);
  };
  const cast = ray();
  assert.equal(firstVisibleIntersection(cast, [near, far])?.object, near);
  assert.equal(reads, 0);
  assert.equal(cast.far, Infinity);
  assert.ok(visibleIntersections(cast, [near, far]).length);
  assert.ok(reads > 0);
});

test('nearest picking honors custom recursion stops and restores the raycaster when a cast throws', () => {
  const stopped = new THREE.Group();
  stopped.raycast = () => false;
  const child = box(3);
  child.raycast = () => assert.fail('custom recursion stop must be honored');
  stopped.add(child);
  const near = box(2);
  near.updateMatrixWorld(true);
  const cast = ray();
  cast.far = 15;
  assert.equal(firstVisibleIntersection(cast, [stopped, near])?.object, near);
  assert.equal(cast.far, 15);
  const throwing = new THREE.Object3D();
  throwing.raycast = (current) => {
    assert.ok(current.far < 3);
    throw new Error('nearest query exception');
  };
  assert.throws(() => firstVisibleIntersection(cast, [near, throwing]), /nearest query exception/);
  assert.equal(cast.far, 15);
  assert.equal(cast.near, 0);
});

test('the full-list query preserves custom raycaster side effects while the nearest query restores clipping', () => {
  const object = new THREE.Object3D();
  object.raycast = (cast) => {
    cast.far = 7;
  };
  const cast = ray();
  assert.deepEqual(visibleIntersections(cast, [object]), []);
  assert.equal(cast.far, 7);
  cast.far = 12;
  assert.equal(firstVisibleIntersection(cast, [object]), null);
  assert.equal(cast.far, 12);
});

test('world-sphere rejection skips local matrix inversion for misses and finite far clipping', () => {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), new THREE.MeshBasicMaterial());
  mesh.position.z = -5;
  mesh.updateMatrixWorld(true);
  mesh.geometry.computeBoundingSphere();
  preparePicking(mesh);
  let inversions = 0;
  const invert = THREE.Matrix4.prototype.invert;
  THREE.Matrix4.prototype.invert = function () {
    inversions++;
    return invert.call(this);
  };
  try {
    const miss = new THREE.Raycaster(new THREE.Vector3(3, 0, 5), new THREE.Vector3(0, 0, -1));
    assert.deepEqual(visibleIntersections(miss, [mesh]), []);
    const clipped = new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1), 0.1, 4);
    assert.equal(firstVisibleIntersection(clipped, [mesh]), null);
    assert.equal(clipped.far, 4);
    assert.equal(inversions, 0);
  } finally {
    THREE.Matrix4.prototype.invert = invert;
  }
});

test('world-sphere filtering preserves exact hits from inside, with clipping, reflection and parent shear', () => {
  const geometry = new THREE.SphereGeometry(2, 24, 12);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const parent = new THREE.Group();
  parent.add(mesh);
  parent.scale.set(1.5, 0.8, 1.1);
  mesh.rotation.set(0.2, 0.4, -0.1);
  geometry.computeBoundingSphere();
  preparePicking(parent);
  let hits = 0;
  for (const scale of [1, -1]) {
    mesh.scale.set(scale * 1.2, 0.7, 1.4);
    parent.updateMatrixWorld(true);
    for (const z of [0, 5]) {
      for (const near of [0, 0.5, 4]) {
        for (const far of [2, 8, Infinity]) {
          const cast = new THREE.Raycaster(new THREE.Vector3(0.1, 0.2, z), new THREE.Vector3(0, 0, -1), near, far);
          const expected = cast.intersectObject(mesh);
          hits += expected.length;
          assert.deepEqual(visibleIntersections(cast, [mesh]), expected);
          assert.deepEqual(firstVisibleIntersection(cast, [mesh]), expected[0] ?? null);
        }
      }
    }
  }
  assert.ok(hits > 0);
});
