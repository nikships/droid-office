import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { installExecutiveDesk } from '../src/client/world/executive-desk.js';
import { surfaceFinish } from '../src/client/world/surface.js';
import { SEATING_BY_ID } from '../src/shared/layout.js';

test('executive desk swap preserves the live shell screen, BOSS sign and chair interaction', () => {
  const seat = SEATING_BY_ID.get('boss-chair')!;
  const office = new THREE.Group();
  const parent = new THREE.Group();
  parent.position.set(seat.x, seat.y, seat.z - 1);
  const desk = new THREE.Group();
  desk.name = 'executive-desk';
  desk.add(new THREE.Object3D());
  const texture = new THREE.Texture();
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.45), new THREE.MeshBasicMaterial({ map: texture }));
  screen.position.set(0, 1.18, -0.165);
  const interact = { kind: 'seat', seatId: 'boss-chair' };
  screen.userData.interact = interact;
  const plate = new THREE.Object3D();
  plate.name = 'BOSS';
  const chair = new THREE.Group();
  chair.userData.interact = interact;
  parent.add(desk, screen, plate, chair);
  office.add(parent);
  const children = [...parent.children];
  const originals = [
    new THREE.MeshStandardMaterial({ name: 'BossTop', color: '#808489' }),
    new THREE.MeshStandardMaterial({ name: 'BossFrame', color: '#596169' }),
    new THREE.MeshStandardMaterial({ name: 'BossSteel', color: '#b1b9c0', metalness: 0.85 }),
    new THREE.MeshStandardMaterial({ name: 'BossRubber', color: '#24282d' }),
    new THREE.MeshStandardMaterial({ name: 'BossSignal', color: '#ee6018', emissive: '#ee6018' }),
    new THREE.MeshStandardMaterial({ name: 'BossKeys', color: '#484f56' }),
  ];
  const source = new THREE.Mesh(new THREE.BoxGeometry(), [...originals, originals[0]]);
  source.name = 'ExecutiveDesk';
  assert.equal(installExecutiveDesk(source, office), true);
  assert.deepEqual(parent.children, children);
  assert.deepEqual(parent.position.toArray(), [seat.x, seat.y, seat.z - 1]);
  assert.equal(screen.material.map, texture);
  assert.equal(screen.userData.interact, interact);
  assert.equal(chair.userData.interact, interact);
  assert.deepEqual(screen.position.toArray(), [0, 1.18, -0.165]);
  const model = desk.children[0] as THREE.Mesh;
  assert.equal(model.geometry, source.geometry);
  const materials = model.material as THREE.MeshToonMaterial[];
  assert.ok(materials.every((m) => m.isMeshToonMaterial));
  assert.equal(materials[0], materials[6]);
  assert.equal(surfaceFinish(materials[0]), null);
  assert.deepEqual(surfaceFinish(materials[1]), [0.04, 0.72]);
  assert.deepEqual(surfaceFinish(materials[2]), [0.55, 0.3]);
  assert.equal(surfaceFinish(materials[3]), null);
  assert.equal(surfaceFinish(materials[5]), null);
  assert.equal(materials[4].emissive.getHexString(), 'ee6018');
  assert.equal(source.material[0], originals[0]);
});

test('executive desk retains fallback for absent nodes and supports one material', () => {
  const office = new THREE.Group();
  const desk = new THREE.Group();
  desk.name = 'executive-desk';
  const fallback = new THREE.Object3D();
  desk.add(fallback);
  office.add(desk);
  assert.equal(installExecutiveDesk(new THREE.Group(), office), false);
  assert.equal(desk.children[0], fallback);
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'BossRubber' }));
  source.name = 'ExecutiveDesk';
  assert.equal(installExecutiveDesk(source, new THREE.Group()), false);
  assert.equal(installExecutiveDesk(source, office), true);
  assert.ok(((desk.children[0] as THREE.Mesh).material as THREE.MeshToonMaterial).isMeshToonMaterial);
});

test('executive GLB retains its footprint, actual worktop height, node and triangle budget', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'));
  const desk = manifest['executive-desk'];
  assert.equal(desk.width, 2.6);
  assert.equal(desk.depth, 1.21);
  assert.equal(desk.height, 1.455);
  assert.ok(desk.triangles <= 8000);
  assert.equal(desk.materials, 6);
  const glb = readFileSync(new URL('../src/client/public/props/executive-desk.glb', import.meta.url));
  assert.equal(glb.byteLength, desk.bytes);
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  assert.ok(json.nodes.some((n: { name: string }) => n.name === 'ExecutiveDesk'));
  const top = json.meshes.flatMap((m: { primitives: { material: number; attributes: { POSITION: number } }[] }) => m.primitives).find((p: { material: number }) => json.materials[p.material].name === 'BossTop');
  assert.ok(top);
  const bounds = json.accessors[top.attributes.POSITION];
  assert.ok(Math.abs(bounds.max[1] - 0.83) < 1e-5);
});
