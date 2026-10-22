import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { installLoungeSofa } from '../src/client/world/lounge-sofa.js';
import { surfaceFinish } from '../src/client/world/surface.js';
import { SEATING_BY_ID, seatPlace } from '../src/shared/layout.js';

test('sofa swap preserves the seating group, anchors and picking, facing +x', () => {
  const seat = SEATING_BY_ID.get('couch')!;
  const office = new THREE.Group();
  const couch = new THREE.Group();
  couch.name = 'lounge-sofa';
  couch.position.set(seat.x, seat.y, seat.z);
  const interact = { kind: 'seat', seatId: seat.id };
  couch.userData.interact = interact;
  couch.add(new THREE.Object3D());
  office.add(couch);
  const source = new THREE.Group();
  const body = new THREE.Group();
  body.name = 'LoungeSofa';
  const fabric = new THREE.MeshStandardMaterial({ color: '#87898c' });
  const steel = new THREE.MeshStandardMaterial({ color: '#62686e', metalness: 0.75 });
  const geometry = new THREE.BoxGeometry(0.78, 0.18, 1.16);
  const cushion = new THREE.Mesh(geometry, [fabric, steel, fabric]);
  cushion.position.set(0.08, 0.44, 0);
  body.add(cushion);
  source.add(body);
  const anchors = seat.places.map((_, i) => seatPlace(seat, i));
  assert.equal(installLoungeSofa(source, office), true);
  assert.equal(office.children[0], couch);
  assert.equal(couch.userData.interact, interact);
  assert.deepEqual(couch.position.toArray(), [10.5, 0, 0]);
  assert.deepEqual(
    seat.places.map((_, i) => seatPlace(seat, i)),
    anchors,
  );
  for (const place of anchors) {
    assert.equal(place.rotY, Math.PI / 2);
    assert.equal(place.hips, 0.5);
    assert.ok(Math.abs(place.x - 10.45) < 1e-6);
    assert.ok(Math.abs(place.z) <= 1.2);
  }
  const loaded = couch.getObjectByName('LoungeSofa')!.children[0] as THREE.Mesh;
  assert.equal(loaded.geometry, geometry);
  const materials = loaded.material as THREE.MeshToonMaterial[];
  assert.ok(materials.every((m) => m.isMeshToonMaterial));
  assert.equal(materials[0], materials[2]);
  assert.equal(surfaceFinish(materials[0]), null);
  assert.deepEqual(surfaceFinish(materials[1]), [0.55, 0.3]);
  assert.equal(materials[0].color.getHexString(), '87898c');
  assert.equal(cushion.material[0], fabric);
  const world = loaded.getWorldPosition(new THREE.Vector3());
  assert.deepEqual(world.toArray(), [10.58, 0.44, 0]);
});

test('sofa keeps its fallback for incomplete models and supports a single material', () => {
  const office = new THREE.Group();
  const couch = new THREE.Group();
  couch.name = 'lounge-sofa';
  const original = new THREE.Object3D();
  couch.add(original);
  office.add(couch);
  assert.equal(installLoungeSofa(new THREE.Group(), office), false);
  assert.equal(couch.children[0], original);
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  source.name = 'LoungeSofa';
  assert.equal(installLoungeSofa(source, new THREE.Group()), false);
  assert.equal(installLoungeSofa(source, office), true);
  assert.ok(((couch.children[0] as THREE.Mesh).material as THREE.MeshToonMaterial).isMeshToonMaterial);
});

test('sofa export fits the original lounge casework and stays under budget', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'));
  const sofa = manifest['lounge-sofa'];
  assert.equal(sofa.width, 1.1);
  assert.equal(sofa.height, 0.98);
  assert.ok(sofa.depth >= 4.3 && sofa.depth < 4.4);
  assert.ok(sofa.triangles <= 8000);
  assert.equal(sofa.materials, 6);
  assert.equal(readFileSync(new URL('../src/client/public/props/lounge-sofa.glb', import.meta.url)).byteLength, sofa.bytes);
});
