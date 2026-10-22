import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildLoungeBeanbag, installLoungeBeanbags } from '../src/client/world/lounge-beanbag.js';
import { SEATING_BY_ID, TV } from '../src/shared/layout.js';
import { surfaceFinish } from '../src/client/world/surface.js';

test('beanbag mounts retain the original coordinates and point their low +z fronts at the TV', () => {
  for (const id of ['lounge-beanbag-1', 'lounge-beanbag-2']) {
    const seat = SEATING_BY_ID.get(id)!;
    const bag = buildLoungeBeanbag(id, '#6a6a6a');
    assert.deepEqual(bag.position.toArray(), [seat.x, 0, seat.z]);
    assert.equal(bag.rotation.y, seat.rotY);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(bag.quaternion);
    assert.ok(forward.distanceTo(new THREE.Vector3(TV.x - seat.x, 0, TV.z - seat.z).normalize()) < 1e-12);
    assert.equal(seat.hips, 0.42);
    assert.equal(seat.depth, -0.1);
    const fallback = bag.children[0] as THREE.Mesh;
    assert.equal(fallback.position.y, 0.35);
    assert.equal(fallback.scale.y, 0.6);
    assert.ok((fallback.material as THREE.MeshToonMaterial).isMeshToonMaterial);
  }
});

test('both beanbags keep distinct colors, exact seat mounts and shared geometry/hardware', () => {
  const office = new THREE.Group();
  const bags = [buildLoungeBeanbag('lounge-beanbag-1', '#6a6a6a'), buildLoungeBeanbag('lounge-beanbag-2', '#5c5c5c')];
  const poses = bags.map((b) => b.quaternion.clone());
  const picks = bags.map((b, i) => {
    const it = { seatId: b.name, kind: 'seat', radius: 1.4, index: i };
    b.userData.interact = it;
    return it;
  });
  office.add(...bags);
  const source = new THREE.Group();
  const part = new THREE.Group();
  part.name = 'LoungeBeanbag';
  const fabric = new THREE.MeshStandardMaterial({ name: 'BeanFabric', color: '#6a6a6a' });
  const metal = new THREE.MeshStandardMaterial({ name: 'BeanHardware', metalness: 0.85, color: '#a6afb6' });
  const thread = new THREE.MeshStandardMaterial({ name: 'BeanThread', color: '#969b9e' });
  const signal = new THREE.MeshStandardMaterial({ name: 'BeanSignal', color: '#ee6018' });
  const original = [fabric, metal, thread, signal, fabric];
  const geometry = new THREE.SphereGeometry(0.59, 16, 12);
  part.add(new THREE.Mesh(geometry, original), new THREE.Mesh(geometry, fabric));
  source.add(part);
  assert.equal(installLoungeBeanbags(source, office), 2);
  const materials = bags.map((bag, i) => {
    const seat = SEATING_BY_ID.get(bag.name)!;
    assert.deepEqual(bag.position.toArray(), [seat.x, 0, seat.z]);
    assert.ok(bag.quaternion.equals(poses[i]));
    assert.equal(bag.userData.interact, picks[i]);
    const model = bag.children[0];
    const mesh = model.children[0] as THREE.Mesh;
    assert.equal(mesh.geometry, geometry);
    const mats = mesh.material as THREE.MeshToonMaterial[];
    assert.ok(mats.every((m) => m.isMeshToonMaterial));
    assert.deepEqual(mats.map(surfaceFinish), [null, [0.55, 0.3], null, null, null]);
    assert.equal(mats[0], mats[4]);
    assert.equal((model.children[1] as THREE.Mesh).material, mats[0]);
    assert.equal(mats[3].emissive.getHex(), 0);
    return mats;
  });
  assert.ok(materials[0][0].color.equals(new THREE.Color('#6a6a6a')));
  assert.ok(materials[1][0].color.equals(new THREE.Color('#5c5c5c')));
  assert.notEqual(materials[0][0], materials[1][0]);
  for (const i of [1, 2, 3]) assert.equal(materials[0][i], materials[1][i]);
  assert.equal((part.children[0] as THREE.Mesh).material, original);
  assert.equal(part.parent, source);
});

test('missing beanbag assets or mounts retain fallbacks; untinted single meshes use the source color', () => {
  const office = new THREE.Group();
  const bag = buildLoungeBeanbag('lounge-beanbag-1', '#6a6a6a');
  office.add(bag);
  const fallback = bag.children[0];
  assert.equal(installLoungeBeanbags(new THREE.Group(), office), 0);
  assert.equal(bag.children[0], fallback);
  const source = new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshStandardMaterial({ name: 'BeanFabric', color: '#555555' }));
  source.name = 'LoungeBeanbag';
  assert.equal(installLoungeBeanbags(source, new THREE.Group()), 0);
  delete bag.userData.fabricColor;
  assert.equal(installLoungeBeanbags(source, office), 1);
  const material = (bag.children[0] as THREE.Mesh).material as THREE.MeshToonMaterial;
  assert.ok(material.color.equals(source.material.color));
  assert.ok(source.material.isMeshStandardMaterial);
});

test('actual beanbag GLB stays within the original diameter, with all zipper hardware behind the -z back', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'));
  const bag = manifest['lounge-beanbag'];
  assert.ok(bag.triangles <= 8000);
  assert.equal(bag.materials, 5);
  assert.ok(bag.width > 1.1 && bag.width <= 1.2);
  assert.ok(bag.depth > 1.1 && bag.depth <= 1.2);
  assert.ok(bag.height > 0.65 && bag.height < 0.72);
  const glb = readFileSync(new URL('../src/client/public/props/lounge-beanbag.glb', import.meta.url));
  assert.equal(glb.byteLength, bag.bytes);
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  assert.ok(json.nodes.some((n: { name: string }) => n.name === 'LoungeBeanbag'));
  type Primitive = { material: number; attributes: { POSITION: number } };
  const primitives: Primitive[] = json.meshes.flatMap((m: { primitives: Primitive[] }) => m.primitives);
  const hardware = primitives.filter((p) => ['BeanHardware', 'BeanSignal'].includes(json.materials[p.material].name));
  assert.equal(hardware.length, 2);
  for (const p of hardware) assert.ok(json.accessors[p.attributes.POSITION].max[2] < -0.45, 'the zipper must be at the -z back, not the TV-facing front');
});
