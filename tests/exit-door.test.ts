import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { installExitDoor } from '../src/client/world/exit-door.js';
import { surfaceFinish } from '../src/client/world/surface.js';

test('exit leaf keeps its hinge hierarchy, original glass, stripe and sign while converting only solids', () => {
  const office = new THREE.Group();
  const frame = new THREE.Group();
  frame.position.set(-18, 0, 6.5);
  frame.rotation.y = -Math.PI / 2;
  const hinge = new THREE.Group();
  hinge.position.set(-0.61, 0, 0.02);
  const leaf = new THREE.Group();
  const mount = new THREE.Group();
  mount.name = 'exit-door-hardware';
  mount.userData.owner = 'exit';
  const fallback = new THREE.Object3D();
  mount.add(fallback);
  const glassMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.14 });
  const glass = new THREE.Mesh(new THREE.CircleGeometry(0.2, 20), glassMaterial);
  glass.position.set(0.61, 1.76, 0);
  const stripeMaterial = new THREE.MeshToonMaterial({ color: '#ee6018' });
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.794, 0.012, 0.01), stripeMaterial);
  stripe.position.set(0.61, 1, -0.1);
  const sign = new THREE.Object3D();
  leaf.add(mount, glass, stripe);
  hinge.add(leaf);
  frame.add(hinge, sign);
  office.add(frame);

  const source = new THREE.Group();
  const part = new THREE.Group();
  part.name = 'ExitDoorLeaf';
  const paint = new THREE.MeshStandardMaterial({ name: 'DoorPaint', color: '#3a3a3a', metalness: 0.2 });
  const steel = new THREE.MeshStandardMaterial({ name: 'DoorSteel', color: '#a6afb6', metalness: 0.85 });
  const rubber = new THREE.MeshStandardMaterial({ name: 'DoorRubber', color: '#171b1e' });
  const original = [paint, steel, rubber, steel];
  const geometry = new THREE.BoxGeometry(1.22, 2.3, 0.06);
  part.add(new THREE.Mesh(geometry, original), new THREE.Mesh(geometry, steel));
  source.add(part);
  hinge.rotation.y = -0.9;
  office.updateMatrixWorld(true);
  const glassBefore = glass.matrixWorld.clone();
  const stripeBefore = stripe.matrixWorld.clone();
  assert.equal(installExitDoor(source, office), true);
  office.updateMatrixWorld(true);
  assert.equal(mount.parent, leaf);
  assert.equal(leaf.parent, hinge);
  assert.equal(hinge.rotation.y, -0.9);
  assert.deepEqual(hinge.position.toArray(), [-0.61, 0, 0.02]);
  assert.equal(mount.userData.owner, 'exit');
  assert.deepEqual(leaf.children, [mount, glass, stripe]);
  assert.equal(frame.children[1], sign);
  assert.ok(glass.matrixWorld.equals(glassBefore));
  assert.ok(stripe.matrixWorld.equals(stripeBefore));
  assert.equal(glass.material, glassMaterial);
  assert.equal(stripe.material, stripeMaterial);
  const model = mount.children[0];
  const loaded = model.children[0] as THREE.Mesh;
  assert.equal(loaded.geometry, geometry);
  const materials = loaded.material as THREE.MeshToonMaterial[];
  assert.ok(materials.every((m) => m.isMeshToonMaterial));
  assert.deepEqual(materials.map(surfaceFinish), [[0.04, 0.72], [0.55, 0.3], null, [0.55, 0.3]]);
  assert.equal(materials[1], materials[3]);
  assert.equal((model.children[1] as THREE.Mesh).material, materials[1]);
  assert.ok(materials[0].color.equals(paint.color));
  assert.ok(materials.every((m) => m.emissive.getHex() === 0));
  assert.equal((part.children[0] as THREE.Mesh).material, original);
  assert.equal(part.parent, source);
  assert.equal(fallback.parent, null);
  // Installed geometry follows the same hinge at all opening fractions.
  for (const k of [0, 0.25, 0.5, 1]) {
    hinge.rotation.y = -1.8 * k * k * (3 - 2 * k);
    office.updateMatrixWorld(true);
    const expected = new THREE.Vector3(0.61, 1, -0.07).applyMatrix4(hinge.matrixWorld);
    const actual = model.localToWorld(new THREE.Vector3(0.61, 1, -0.07));
    assert.ok(actual.distanceTo(expected) < 1e-9);
  }
});

test('incomplete exit assets keep the procedural leaf and a single-mesh source is also supported', () => {
  const office = new THREE.Group();
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'DoorRubber' }));
  source.name = 'ExitDoorLeaf';
  assert.equal(installExitDoor(source, office), false);
  const mount = new THREE.Group();
  mount.name = 'exit-door-hardware';
  const fallback = new THREE.Object3D();
  mount.add(fallback);
  office.add(mount);
  assert.equal(installExitDoor(new THREE.Group(), office), false);
  assert.equal(mount.children[0], fallback);
  assert.equal(installExitDoor(source, office), true);
  const material = (mount.children[0] as THREE.Mesh).material as THREE.MeshToonMaterial;
  assert.ok(material.isMeshToonMaterial);
  assert.equal(surfaceFinish(material), null);
  assert.ok(source.material.isMeshStandardMaterial);
});

test('exit GLB preserves hinge-local bounds, old handle contact planes and the porthole aperture', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'));
  const asset = manifest['exit-door'];
  assert.deepEqual([asset.width, asset.height, asset.depth], [1.22, 2.3, 0.19]);
  assert.ok(asset.triangles <= 8000);
  assert.equal(asset.materials, 4);
  const glb = readFileSync(new URL('../src/client/public/props/exit-door.glb', import.meta.url));
  assert.equal(glb.byteLength, asset.bytes);
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  const root = json.nodes.find((n: { name: string }) => n.name === 'ExitDoorLeaf');
  assert.ok(root);
  assert.equal(root.children, undefined);
  const primitives = json.meshes[root.mesh].primitives as { material: number; attributes: { POSITION: number } }[];
  const bounds = primitives.map((p) => json.accessors[p.attributes.POSITION]);
  for (const [axis, min, max] of [
    [0, 0, 1.22],
    [1, 0.01, 2.31],
    [2, -0.095, 0.095],
  ]) {
    assert.ok(Math.abs(Math.min(...bounds.map((b) => b.min[axis])) - min) < 1e-4);
    assert.ok(Math.abs(Math.max(...bounds.map((b) => b.max[axis])) - max) < 1e-4);
  }
  assert.deepEqual(json.materials.map((m: { name: string }) => m.name).sort(), ['DoorPaint', 'DoorPlate', 'DoorRubber', 'DoorSteel']);
  assert.ok(json.materials.every((m: { emissiveFactor?: number[] }) => !m.emissiveFactor?.some(Boolean)));
  // Original glass/push-bar stripe/sign must not be baked into this static asset.
  assert.equal(json.nodes.length, 1);
  const generator = readFileSync(new URL('../tools/props/generate.py', import.meta.url), 'utf8');
  assert.match(generator, /ring\("PortholeClamp", 0\.235, 0\.165/);
});
