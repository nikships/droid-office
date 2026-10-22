import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { WALL_HEIGHT } from '../src/shared/layout.js';
import { installHighBayLamps } from '../src/client/world/high-bay-lamp.js';
import { surfaceFinish } from '../src/client/world/surface.js';

test('high-bay housing swap retains three mounts, suspension rods and live ceiling materials', () => {
  const source = new THREE.Group();
  const body = new THREE.Group();
  body.name = 'HighBayLamp';
  source.add(body);
  const geometry = new THREE.BoxGeometry();
  const metal = new THREE.MeshStandardMaterial({ color: '#727272', metalness: 0.65, name: 'BayShell' });
  const paint = new THREE.MeshStandardMaterial({ color: '#24272b', metalness: 0.15, name: 'BayHousing' });
  const rubber = new THREE.MeshStandardMaterial({ color: '#161719', name: 'BayRubber' });
  body.add(new THREE.Mesh(geometry, [metal, paint, rubber]));
  const office = new THREE.Group();
  const mounts = [
    [13, 4.3, -4.33],
    [13, 4.3, 4.33],
    [-14.5, 4.3, 10.4],
  ].map((position) => {
    const mount = new THREE.Group();
    mount.name = 'high-bay-lamp';
    mount.position.fromArray(position);
    mount.userData.fixture = true;
    mount.add(new THREE.Object3D());
    office.add(mount);
    return mount;
  });
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, WALL_HEIGHT - 0.18 - 4.3 - 0.3), metal);
  const lit = new THREE.MeshToonMaterial({ emissive: '#fff3e0' });
  const diffuser = new THREE.Mesh(geometry, lit);
  office.add(rod, diffuser);
  const children = [...office.children];
  assert.equal(installHighBayLamps(source, office), 3);
  assert.deepEqual(office.children, children);
  assert.deepEqual(
    mounts.map((m) => m.position.toArray()),
    [
      [13, 4.3, -4.33],
      [13, 4.3, 4.33],
      [-14.5, 4.3, 10.4],
    ],
  );
  assert.ok(mounts.every((m) => m.userData.fixture && m.rotation.y === 0));
  const first = mounts[0].children[0].children[0] as THREE.Mesh;
  const second = mounts[1].children[0].children[0] as THREE.Mesh;
  assert.equal(first.geometry, geometry);
  assert.equal(second.geometry, geometry);
  const materials = first.material as THREE.Material[];
  assert.ok(materials.every((m) => m instanceof THREE.MeshToonMaterial));
  assert.equal(materials[0], (second.material as THREE.Material[])[0]);
  assert.deepEqual(surfaceFinish(materials[0]), [0.55, 0.3]);
  assert.deepEqual(surfaceFinish(materials[1]), [0.04, 0.72]);
  assert.equal(surfaceFinish(materials[2]), null);
  assert.equal((first.material as THREE.MeshToonMaterial[])[0].color.getHexString(), '727272');
  assert.equal((body.children[0] as THREE.Mesh).material[0], metal);
  assert.equal(rod.material, metal);
  assert.equal(diffuser.material, lit);
  assert.equal(lit.emissive.getHexString(), 'fff3e0');
});

test('missing lamp model or mount keeps the original fallback intact', () => {
  const office = new THREE.Group();
  const mount = new THREE.Group();
  mount.name = 'high-bay-lamp';
  const fallback = new THREE.Object3D();
  mount.add(fallback);
  office.add(mount);
  assert.equal(installHighBayLamps(new THREE.Group(), office), 0);
  assert.equal(mount.children[0], fallback);
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  source.name = 'HighBayLamp';
  assert.equal(installHighBayLamps(source, new THREE.Group()), 0);
  assert.equal(installHighBayLamps(source, office), 1);
  const model = mount.children[0] as THREE.Mesh;
  assert.equal(model.geometry, source.geometry);
  assert.ok(model.material instanceof THREE.MeshToonMaterial);
});

test('exported pendant retains the original 0.4 m radius and mouth-relative housing height', () => {
  const data = readFileSync(new URL('../src/client/public/props/high-bay-lamp.glb', import.meta.url));
  const json = JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)).toString('utf8'));
  const meta = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'))['high-bay-lamp'];
  assert.deepEqual([meta.width, meta.height, meta.depth], [0.8, 0.34, 0.8]);
  assert.ok(meta.triangles <= 8000);
  assert.equal(meta.materials, 5);
  assert.equal(meta.bytes, data.byteLength);
  assert.deepEqual(json.nodes, [{ mesh: 0, name: 'HighBayLamp' }]);
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  for (const p of json.meshes[0].primitives) {
    const a = json.accessors[p.attributes.POSITION];
    a.min.forEach((v: number, i: number) => {
      min[i] = Math.min(min[i], v);
    });
    a.max.forEach((v: number, i: number) => {
      max[i] = Math.max(max[i], v);
    });
    triangles += json.accessors[p.indices].count / 3;
  }
  [-0.4, -0.01, -0.4].forEach((v, i) => assert.ok(Math.abs(min[i] - v) < 1e-6));
  [0.4, 0.33, 0.4].forEach((v, i) => assert.ok(Math.abs(max[i] - v) < 1e-6));
  assert.equal(triangles, meta.triangles);
  assert.ok(json.materials.every((m: { emissiveFactor?: number[] }) => !m.emissiveFactor || m.emissiveFactor.every((v) => v === 0)));
});
