import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SOURCE_LAYER, StaticBatcher, batchKey, lookKey, mergeWorld, pieceKeys } from '../src/client/vr/batch.js';
import { pickLayered } from '../src/client/vr/layers.js';

const box = (mat: THREE.Material, x = 0) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  m.position.x = x;
  return m;
};

test('batchKey groups meshes by material and draw state, and refuses what cannot merge', () => {
  const a = new THREE.MeshBasicMaterial();
  const b = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  assert.equal(batchKey(box(a)), batchKey(box(a, 3)));
  assert.notEqual(batchKey(box(a)), batchKey(box(b)));
  // Only the color differs: the color goes in the vertices and the two draw as one.
  assert.equal(batchKey(box(new THREE.MeshToonMaterial({ color: 'red' }))), batchKey(box(new THREE.MeshToonMaterial({ color: 'blue' }))));
  assert.notEqual(batchKey(box(new THREE.MeshToonMaterial({ emissive: 'red' }))), batchKey(box(new THREE.MeshToonMaterial())));
  // A material that brings its own vertex colors keeps its own key.
  const vc = new THREE.MeshBasicMaterial({ vertexColors: true });
  assert.equal(batchKey(box(vc))!.startsWith(`mat:${vc.uuid}`), true);
  const shadow = box(a);
  shadow.castShadow = true;
  assert.notEqual(batchKey(shadow), batchKey(box(a)));
  const ordered = box(a);
  ordered.renderOrder = 5;
  assert.notEqual(batchKey(ordered), batchKey(box(a)));

  // A transparent that writes depth sorts per object, so it draws alone.
  assert.equal(batchKey(box(new THREE.MeshBasicMaterial({ transparent: true }))), null);
  const panel = box(a);
  panel.userData.panel = {};
  assert.equal(batchKey(panel), null);
  const grab = box(a);
  grab.userData.grabbable = 'coffee';
  assert.equal(batchKey(grab), null);
  const hooked = box(a);
  hooked.onBeforeRender = () => {};
  assert.equal(batchKey(hooked), null);
  assert.equal(batchKey(new THREE.Mesh(new THREE.BoxGeometry(), [a, b])), null);
  assert.equal(batchKey(new THREE.InstancedMesh(new THREE.BoxGeometry(), a, 2)), null);
});

test('batchKey merges flat, depth-free transparent layers per material only', () => {
  const glass = new THREE.MeshBasicMaterial({ color: '#9cf', transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide });
  const shine = new THREE.MeshBasicMaterial({ color: '#fff', transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
  assert.notEqual(batchKey(box(glass)), null);
  assert.equal(batchKey(box(glass)), batchKey(box(glass, 3)));
  // Same look, other color: order-dependent when layered, so no shared look material.
  assert.notEqual(batchKey(box(glass)), batchKey(box(shine)));
  assert.equal(batchKey(box(glass))!.startsWith(`mat:${glass.uuid}`), true);
  const additive = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  assert.notEqual(batchKey(box(additive)), null);

  const tex = new THREE.Texture();
  assert.equal(batchKey(box(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, map: tex }))), null);
  assert.equal(batchKey(box(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, alphaMap: tex }))), null);
  assert.equal(batchKey(box(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, vertexColors: true }))), null);
  assert.equal(batchKey(box(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.MultiplyBlending, premultipliedAlpha: true }))), null);
});

test('StaticBatcher merges glass panes into one draw that keeps their material', () => {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  scene.add(root);
  const glass = new THREE.MeshBasicMaterial({ color: '#9cf', transparent: true, opacity: 0.14, depthWrite: false });
  const panes = [box(glass, 0), box(glass, 2), box(glass, 4)];
  root.add(...panes);
  const b = new StaticBatcher(scene);
  b.update(root, 0);
  b.update(root, 1600);
  assert.equal(b.meshes, 1);
  const merged = scene.getObjectByName('batch:3') as THREE.Mesh;
  assert.equal(merged.material, glass);
  assert.equal(merged.geometry.getAttribute('color'), undefined);
  for (const p of panes) assert.equal(p.layers.isEnabled(0), false);
});

test('mergeWorld bakes world transforms and keeps mirrored faces facing out', () => {
  const mat = new THREE.MeshBasicMaterial();
  const a = box(mat, -2);
  const b = box(mat, 2);
  b.scale.x = -1;
  a.updateMatrixWorld();
  b.updateMatrixWorld();
  const g = mergeWorld([{ mesh: a }, { mesh: b }])!;
  assert.ok(g);
  g.computeBoundingBox();
  assert.deepEqual([g.boundingBox!.min.x, g.boundingBox!.max.x], [-2.5, 2.5]);
  // The mirrored half's first triangle winds the other way from the plain box's.
  const plain = new THREE.BoxGeometry(1, 1, 1);
  const n = plain.index!.count;
  const idx = g.index!.array;
  const off = plain.attributes.position.count;
  assert.deepEqual([idx[n] - off, idx[n + 1] - off, idx[n + 2] - off], [plain.index!.array[0], plain.index!.array[2], plain.index!.array[1]]);
});

test('StaticBatcher merges what holds still, and originals keep answering rays', () => {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  scene.add(root);
  const mat = new THREE.MeshBasicMaterial();
  const still = [box(mat, 0), box(mat, 2), box(mat, 4)];
  const mover = box(mat, 6);
  still[1].userData.interact = { kind: 'desk' };
  root.add(...still, mover);
  const b = new StaticBatcher(scene);

  b.update(root, 0);
  // Watching: nothing merged yet. The mover moves during the watch window.
  mover.position.y = 1;
  mover.updateMatrixWorld();
  assert.equal(b.update(root, 1000), false);
  assert.equal(b.update(root, 2000), true);
  assert.equal(b.meshes, 1);
  assert.equal(b.saved, 2);
  for (const m of still) assert.equal(m.layers.isEnabled(0), false);
  assert.equal(mover.layers.isEnabled(0), true);

  // A camera sees only the merged mesh; the VR raycaster still hits the original.
  const ray = new THREE.Raycaster(new THREE.Vector3(2, 0, 5), new THREE.Vector3(0, 0, -1));
  ray.layers.enable(SOURCE_LAYER);
  const hits = ray.intersectObjects([root, ...scene.children], true);
  assert.equal(hits[0]?.object, still[1]);
  const plain = new THREE.Raycaster(new THREE.Vector3(2, 0, 5), new THREE.Vector3(0, 0, -1));
  assert.equal(plain.intersectObjects(scene.children, true).length, 0);

  // A merged source that moves draws itself again right away, and its batch rebuilds without it.
  still[0].position.z = 1;
  still[0].updateMatrixWorld();
  assert.equal(b.update(root, 3000), true);
  assert.equal(b.meshes, 0);
  for (const m of still) assert.equal(m.layers.isEnabled(0), true);
  b.update(root, 4600);
  b.update(root, 6200);
  assert.equal(b.meshes, 1);
  assert.equal(b.saved, 1);
  assert.equal(still[0].layers.isEnabled(0), true);

  // Hiding the root (the roof) and session end put everything back.
  root.visible = false;
  assert.equal(b.update(root, 7000), true);
  for (const m of still) assert.equal(m.layers.isEnabled(0), true);
  root.visible = true;
  b.update(root, 7100);
  b.update(root, 8700);
  assert.equal(b.meshes, 1);
  b.reset();
  assert.equal(b.meshes, 0);
  for (const m of still) assert.equal(m.layers.isEnabled(0), true);
  assert.equal(scene.children.includes(root), true);
  assert.equal(scene.children.length, 1);
});

test('StaticBatcher rebuilds after a floor change takes sources out of the tree', () => {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  scene.add(root);
  const mat = new THREE.MeshBasicMaterial();
  const floor = new THREE.Group();
  const meshes = [box(mat, 0), box(mat, 2)];
  floor.add(...meshes);
  root.add(floor);
  const b = new StaticBatcher(scene);
  b.update(root, 0);
  b.update(root, 1600);
  assert.equal(b.meshes, 1);
  root.remove(floor);
  const next = new THREE.Group();
  next.add(box(mat, 0), box(mat, 2), box(mat, 4));
  root.add(next);
  assert.equal(b.update(root, 2000), true);
  assert.equal(b.meshes, 0);
  for (const m of meshes) assert.equal(m.layers.isEnabled(0), true);
  b.update(root, 3600);
  b.update(root, 5200);
  assert.equal(b.meshes, 1);
  assert.equal(b.saved, 2);
});

test('pieceKeys splits a multi-material mesh into one key per geometry group', () => {
  const wood = new THREE.MeshBasicMaterial();
  const label = new THREE.MeshBasicMaterial({ map: new THREE.Texture() });
  const crate = new THREE.Mesh(new THREE.BoxGeometry(), [wood, wood, wood, wood, label, wood]);
  const keys = pieceKeys(crate)!;
  assert.equal(keys.length, 6);
  assert.equal(new Set(keys).size, 2);
  assert.equal(keys[4], batchKey(box(label)));
  assert.deepEqual(pieceKeys(box(wood)), [batchKey(box(wood))]);
  // Any see-through slot keeps the whole mesh drawing itself.
  assert.equal(pieceKeys(new THREE.Mesh(new THREE.BoxGeometry(), [wood, wood, wood, wood, new THREE.MeshBasicMaterial({ transparent: true }), wood])), null);
});

test('mergeWorld keeps only a group piece its own triangles', () => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()]);
  m.updateMatrixWorld();
  const face = m.geometry.groups[4];
  const g = mergeWorld([{ mesh: m, group: face }])!;
  assert.equal(g.index!.count, face.count);
  assert.deepEqual(Array.from(g.index!.array), Array.from(m.geometry.index!.array.slice(face.start, face.start + face.count)));
});

test('StaticBatcher draws multi-material meshes per material, and breaks their batches together', () => {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  scene.add(root);
  const wood = new THREE.MeshBasicMaterial();
  const label = new THREE.MeshBasicMaterial({ map: new THREE.Texture() });
  const crate = (x: number, face: THREE.Material) => {
    const c = new THREE.Mesh(new THREE.BoxGeometry(), [wood, wood, wood, wood, face, wood]);
    c.position.x = x;
    return c;
  };
  const a = crate(0, label);
  const b = crate(2, label);
  const plain = box(wood, 4);
  root.add(a, b, plain);
  const batcher = new StaticBatcher(scene);
  batcher.update(root, 0);
  batcher.update(root, 1600);
  // Wood (5 faces × 2 crates + the box) and label (2 faces): two draws instead of 13.
  assert.equal(batcher.meshes, 2);
  assert.equal(batcher.saved, 13 - 2);
  for (const m of [a, b, plain]) assert.equal(m.layers.isEnabled(0), false);

  // One crate moving frees everything that shared a merged mesh with it.
  a.position.y = 1;
  a.updateMatrixWorld();
  assert.equal(batcher.update(root, 2000), true);
  assert.equal(batcher.meshes, 0);
  for (const m of [a, b, plain]) assert.equal(m.layers.isEnabled(0), true);
  assert.equal(batcher.isDynamic(a), true);
  assert.equal(batcher.isDynamic(b), false);

  // The rebuild merges the rest; the still crate's lone label face gets a merged mesh of its own.
  batcher.update(root, 3600);
  batcher.update(root, 5200);
  assert.equal(batcher.meshes, 2);
  assert.equal(b.layers.isEnabled(0), false);
  assert.equal(a.layers.isEnabled(0), true);
});

test('pickLayered gives layers to the frontmost visible panels within the budget', () => {
  const panels = [{ order: 9991 }, { order: 0 }, { order: 9995 }, { order: 9993 }];
  assert.deepEqual(
    pickLayered(panels, 2).map((p) => p.order),
    [9995, 9993],
  );
  assert.deepEqual(pickLayered(panels, 0), []);
  assert.equal(pickLayered(panels, 10).length, 4);
});

test('StaticBatcher bakes each color into the vertices of one shared material, and lets a recolored mesh go', () => {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  scene.add(root);
  const red = new THREE.MeshToonMaterial({ color: '#ff0000' });
  const blue = new THREE.MeshToonMaterial({ color: '#0000ff' });
  const meshes = [box(red, 0), box(blue, 2), box(red, 4)];
  root.add(...meshes);
  const b = new StaticBatcher(scene);
  b.update(root, 0);
  b.update(root, 1600);
  assert.equal(b.meshes, 1);
  const merged = scene.getObjectByName('vr-static-batches')!.children[0] as THREE.Mesh;
  const mat = merged.material as THREE.MeshToonMaterial;
  assert.equal(mat.vertexColors, true);
  assert.equal(mat.color.getHex(), 0xffffff);
  assert.notEqual(mat, red);
  const colors = merged.geometry.attributes.color;
  const perBox = meshes[0].geometry.attributes.position.count;
  assert.deepEqual([colors.getX(0), colors.getZ(0)], [1, 0]);
  assert.deepEqual([colors.getX(perBox), colors.getZ(perBox)], [0, 1]);

  // Recoloring a source (a status light, a lamp) frees it within a check.
  blue.color.set('#00ff00');
  assert.equal(b.update(root, 2000), true);
  assert.equal(b.meshes, 0);
  assert.equal(b.isDynamic(meshes[1]), true);
  for (const m of meshes) assert.equal(m.layers.isEnabled(0), true);
  b.reset();
});

test('lookKey ignores the color and refuses materials with their own vertex colors or hooks', () => {
  assert.equal(lookKey(new THREE.MeshToonMaterial({ color: 'red' })), lookKey(new THREE.MeshToonMaterial({ color: 'green' })));
  assert.notEqual(lookKey(new THREE.MeshToonMaterial()), lookKey(new THREE.MeshBasicMaterial()));
  assert.equal(lookKey(new THREE.MeshBasicMaterial({ vertexColors: true })), null);
  const hooked = new THREE.MeshBasicMaterial();
  hooked.onBeforeCompile = () => {};
  assert.equal(lookKey(hooked), null);
});
