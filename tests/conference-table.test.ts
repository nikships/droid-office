import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { installConferenceTable } from '../src/client/world/conference-table.js';
import { surfaceFinish } from '../src/client/world/surface.js';
import { GLASS_ROOM_TABLE } from '../src/shared/layout.js';

test('conference table swap retains the room and surface pose, and converts all finishes', () => {
  const def = GLASS_ROOM_TABLE;
  const office = new THREE.Group();
  const table = new THREE.Group();
  table.name = 'conference-table';
  table.position.set(def.x, 0, def.z);
  table.add(new THREE.Object3D());
  office.add(table);
  for (const name of ['chair', 'glass', 'artwork']) {
    const sibling = new THREE.Object3D();
    sibling.name = name;
    office.add(sibling);
  }
  const children = [...office.children];
  const materials = [
    new THREE.MeshStandardMaterial({ name: 'TableTop', color: '#808489' }),
    new THREE.MeshStandardMaterial({ name: 'TableFrame', color: '#596169' }),
    new THREE.MeshStandardMaterial({ name: 'TableSteel', color: '#b1b9c0', metalness: 0.85 }),
    new THREE.MeshStandardMaterial({ name: 'TableRubber', color: '#282c31' }),
    new THREE.MeshStandardMaterial({ name: 'TableSignal', color: '#ee6018', emissive: '#ee6018' }),
  ];
  const source = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(def.width, 0.045, def.depth), [...materials, materials[0]]);
  body.name = 'ConferenceTable';
  body.position.y = def.height - 0.0225;
  source.add(body);
  assert.equal(installConferenceTable(source, office), true);
  assert.deepEqual(office.children, children);
  assert.deepEqual(table.position.toArray(), [def.x, 0, def.z]);
  const loaded = table.getObjectByName('ConferenceTable') as THREE.Mesh;
  assert.equal(loaded.geometry, body.geometry);
  const converted = loaded.material as THREE.MeshToonMaterial[];
  assert.ok(converted.every((m) => m.isMeshToonMaterial));
  assert.equal(converted[0], converted[5]);
  assert.equal(surfaceFinish(converted[0]), null);
  assert.deepEqual(surfaceFinish(converted[1]), [0.04, 0.72]);
  assert.deepEqual(surfaceFinish(converted[2]), [0.55, 0.3]);
  assert.equal(surfaceFinish(converted[3]), null);
  assert.equal(converted[4].emissive.getHexString(), 'ee6018');
  assert.equal(body.material[0], materials[0]);
  table.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(table);
  assert.ok(Math.abs(bounds.max.y - def.height) < 1e-6);
  assert.ok(Math.abs(bounds.min.x - (def.x - def.width / 2)) < 1e-6);
});

test('conference table keeps its fallback for absent nodes and accepts a single material', () => {
  const office = new THREE.Group();
  const table = new THREE.Group();
  table.name = 'conference-table';
  const fallback = new THREE.Object3D();
  table.add(fallback);
  office.add(table);
  assert.equal(installConferenceTable(new THREE.Group(), office), false);
  assert.equal(table.children[0], fallback);
  const body = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'TableTop' }));
  body.name = 'ConferenceTable';
  assert.equal(installConferenceTable(body, new THREE.Group()), false);
  assert.equal(installConferenceTable(body, office), true);
  assert.ok(((table.children[0] as THREE.Mesh).material as THREE.MeshToonMaterial).isMeshToonMaterial);
});

test('exported conference table retains layout dimensions, named node and prop budget', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'));
  const table = manifest['conference-table'];
  assert.equal(table.width, GLASS_ROOM_TABLE.width);
  assert.equal(table.depth, GLASS_ROOM_TABLE.depth);
  assert.equal(table.height, GLASS_ROOM_TABLE.height);
  assert.ok(table.triangles <= 8000);
  assert.equal(table.materials, 5);
  const glb = readFileSync(new URL('../src/client/public/props/conference-table.glb', import.meta.url));
  assert.equal(glb.byteLength, table.bytes);
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  assert.ok(json.nodes.some((n: { name: string }) => n.name === 'ConferenceTable'));
});
