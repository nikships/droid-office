import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { installBalconyBench } from '../src/client/world/balcony-bench.js';
import { surfaceFinish } from '../src/client/world/surface.js';
import { BALCONY, SEATING_BY_ID, seatPlace } from '../src/shared/layout.js';

test('balcony bench replacement retains the original mount, picking and both seat places', () => {
  const seat = SEATING_BY_ID.get('bench')!;
  const office = new THREE.Group();
  const bench = new THREE.Group();
  bench.name = 'balcony-bench';
  bench.position.set(seat.x, seat.y, seat.z);
  bench.rotation.y = seat.rotY;
  const interact = { kind: 'seat', seatId: 'bench', radius: 1.6 };
  bench.userData.interact = interact;
  bench.add(new THREE.Object3D());
  const neighbor = new THREE.Group();
  office.add(bench, neighbor);
  const source = new THREE.Group();
  const part = new THREE.Group();
  part.name = 'BalconyBench';
  const wood = new THREE.MeshStandardMaterial({ name: 'BalconySlatLight', color: '#8c8d88' });
  const steel = new THREE.MeshStandardMaterial({ name: 'BalconySteel', color: '#8d969c', metalness: 0.8 });
  const rubber = new THREE.MeshStandardMaterial({ name: 'BalconyRubber', color: '#2a2d2f' });
  const geometry = new THREE.BoxGeometry();
  const original = [wood, steel, rubber, steel];
  part.add(new THREE.Mesh(geometry, original), new THREE.Mesh(geometry, steel));
  source.add(part);
  assert.equal(installBalconyBench(source, office), true);
  assert.deepEqual(bench.position.toArray(), [-9, 0, BALCONY.minZ + 0.3]);
  assert.equal(bench.rotation.y, 0);
  assert.equal(bench.userData.interact, interact);
  assert.equal(office.children[1], neighbor);
  assert.equal(bench.children.length, 1);
  const model = bench.children[0];
  const mesh = model.children[0] as THREE.Mesh;
  assert.equal(mesh.geometry, geometry);
  const materials = mesh.material as THREE.MeshToonMaterial[];
  assert.ok(materials.every((m) => m.isMeshToonMaterial));
  assert.deepEqual(materials.map(surfaceFinish), [null, [0.55, 0.3], null, [0.55, 0.3]]);
  assert.equal(materials[1], materials[3]);
  assert.equal((model.children[1] as THREE.Mesh).material, materials[1]);
  assert.ok(materials[0].color.equals(wood.color));
  assert.equal((part.children[0] as THREE.Mesh).material, original);
  assert.equal(part.parent, source);
  assert.deepEqual([seat.places, seat.hips, seat.depth, seat.out], [[-0.5, 0.5], 0.47, 0, 0.8]);
  assert.deepEqual(
    seat.places.map((_, i) => seatPlace(seat, i).x),
    [-9.5, -8.5],
  );
});

test('a missing bench mount or model keeps procedural geometry', () => {
  const office = new THREE.Group();
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  source.name = 'BalconyBench';
  assert.equal(installBalconyBench(source, office), false);
  const bench = new THREE.Group();
  bench.name = 'balcony-bench';
  const fallback = new THREE.Object3D();
  bench.add(fallback);
  office.add(bench);
  assert.equal(installBalconyBench(new THREE.Group(), office), false);
  assert.equal(bench.children[0], fallback);
  assert.equal(installBalconyBench(source, office), true);
  assert.ok(((bench.children[0] as THREE.Mesh).material as THREE.MeshToonMaterial).isMeshToonMaterial);
  assert.ok(source.material.isMeshStandardMaterial);
});

test('exported bench preserves its footprint, seat level and outward +z front', () => {
  const metadata = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'))['balcony-bench'];
  assert.deepEqual([metadata.width, metadata.height, metadata.depth], [2, 0.94, 0.46]);
  assert.ok(metadata.triangles <= 8000);
  assert.equal(metadata.materials, 6);
  const data = readFileSync(new URL('../src/client/public/props/balcony-bench.glb', import.meta.url));
  assert.equal(data.byteLength, metadata.bytes);
  const json = JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)).toString('utf8'));
  assert.ok(json.nodes.some((n: { name: string }) => n.name === 'BalconyBench'));
  type Primitive = { material: number; attributes: { POSITION: number } };
  const parts: Primitive[] = json.meshes.flatMap((m: { primitives: Primitive[] }) => m.primitives);
  const bounds = (name: string) => {
    const p = parts.find((p) => json.materials[p.material].name === name);
    assert.ok(p);
    return json.accessors[p.attributes.POSITION];
  };
  const back = bounds('BalconyBackWood');
  assert.ok(back.max[2] < -0.17, 'back stays on -z, behind both outward-facing places');
  assert.ok(Math.abs(back.max[1] - 0.94) < 1e-4);
  for (const name of ['BalconySlatLight', 'BalconySlatDark']) {
    const slats = bounds(name);
    assert.ok(Math.abs(slats.max[1] - 0.49) < 1e-4);
    assert.ok(Math.abs(slats.min[0] + 1) < 1e-4 && Math.abs(slats.max[0] - 1) < 1e-4);
  }
  assert.ok(Math.abs(bounds('BalconyRubber').min[1]) < 1e-4);
});
