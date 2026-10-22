import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { BALCONY, SEATING_BY_ID } from '../src/shared/layout.js';
import { installBalconyTable } from '../src/client/world/balcony-table.js';
import { surfaceFinish } from '../src/client/world/surface.js';

test('bistro table swaps only geometry, retaining placement and neighboring stools', () => {
  const office = new THREE.Group();
  const table = new THREE.Group();
  table.name = 'balcony-table';
  const z = (BALCONY.minZ + BALCONY.maxZ) / 2 + 0.2;
  table.position.set(0.2, 0, z);
  table.userData.owner = 'balcony';
  table.add(new THREE.Object3D());
  const stools = [new THREE.Group(), new THREE.Group()];
  office.add(table, ...stools);
  const source = new THREE.Group();
  const part = new THREE.Group();
  part.name = 'BalconyTable';
  const top = new THREE.MeshStandardMaterial({ name: 'BistroTop', color: '#727272' });
  const steel = new THREE.MeshStandardMaterial({ name: 'BistroSteel', metalness: 0.85, color: '#b6bdc5' });
  const rubber = new THREE.MeshStandardMaterial({ name: 'BistroRubber', color: '#292d2f' });
  const geometry = new THREE.CylinderGeometry(0.42, 0.42, 0.04, 32);
  const original = [top, steel, rubber, steel];
  part.add(new THREE.Mesh(geometry, original), new THREE.Mesh(geometry, steel));
  source.add(part);
  assert.equal(installBalconyTable(source, office), true);
  assert.deepEqual(table.position.toArray(), [0.2, 0, z]);
  assert.equal(table.userData.owner, 'balcony');
  assert.deepEqual(office.children.slice(1), stools);
  const model = table.children[0];
  const mesh = model.children[0] as THREE.Mesh;
  assert.equal(mesh.geometry, geometry);
  const materials = mesh.material as THREE.MeshToonMaterial[];
  assert.ok(materials.every((m) => m.isMeshToonMaterial));
  assert.deepEqual(materials.map(surfaceFinish), [[0.04, 0.72], [0.55, 0.3], null, [0.55, 0.3]]);
  assert.equal(materials[1], materials[3]);
  assert.equal((model.children[1] as THREE.Mesh).material, materials[1]);
  assert.ok(materials[0].color.equals(top.color));
  assert.equal((part.children[0] as THREE.Mesh).material, original);
  assert.equal(part.parent, source);
  for (const [id, x, rotY] of [
    ['stool-1', -0.6, Math.PI / 2],
    ['stool-2', 1, -Math.PI / 2],
  ] as const) {
    const seat = SEATING_BY_ID.get(id)!;
    assert.deepEqual([seat.x, seat.z, seat.rotY, seat.hips, seat.out], [x, z, rotY, 0.5, -0.7]);
  }
});

test('bistro fallback survives missing nodes and supports a single-mesh source', () => {
  const office = new THREE.Group();
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'BistroRubber' }));
  source.name = 'BalconyTable';
  assert.equal(installBalconyTable(source, office), false);
  const table = new THREE.Group();
  table.name = 'balcony-table';
  const fallback = new THREE.Object3D();
  table.add(fallback);
  office.add(table);
  assert.equal(installBalconyTable(new THREE.Group(), office), false);
  assert.equal(table.children[0], fallback);
  assert.equal(installBalconyTable(source, office), true);
  assert.ok(((table.children[0] as THREE.Mesh).material as THREE.MeshToonMaterial).isMeshToonMaterial);
  assert.ok(source.material.isMeshStandardMaterial);
});

test('actual bistro GLB retains the 0.84 m footprint and 0.76 m usable tabletop', () => {
  const metadata = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'))['balcony-table'];
  assert.deepEqual([metadata.width, metadata.height, metadata.depth], [0.84, 0.76, 0.84]);
  assert.ok(metadata.triangles <= 8000);
  assert.equal(metadata.materials, 4);
  const data = readFileSync(new URL('../src/client/public/props/balcony-table.glb', import.meta.url));
  assert.equal(data.byteLength, metadata.bytes);
  const json = JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)).toString('utf8'));
  assert.ok(json.nodes.some((n: { name: string }) => n.name === 'BalconyTable'));
  type Primitive = { material: number; attributes: { POSITION: number } };
  const parts: Primitive[] = json.meshes.flatMap((m: { primitives: Primitive[] }) => m.primitives);
  const top = parts.find((p) => json.materials[p.material].name === 'BistroTop');
  assert.ok(top);
  const bounds = json.accessors[top.attributes.POSITION];
  assert.ok(Math.abs(bounds.max[1] - 0.76) < 1e-4);
  assert.ok(Math.abs(bounds.min[0] + 0.402) < 1e-4 && Math.abs(bounds.max[0] - 0.402) < 1e-4);
  assert.ok(Math.abs(Math.min(...parts.map((p) => json.accessors[p.attributes.POSITION].min[1]))) < 1e-4);
});
