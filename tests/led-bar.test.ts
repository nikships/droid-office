import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { WALL_HEIGHT } from '../src/shared/layout.js';
import { installLedBarHousings } from '../src/client/world/led-bar.js';
import { surfaceFinish } from '../src/client/world/surface.js';

test('eight long bar housings share resources without touching live diffusers, pips, wires or the short loft lamp', () => {
  const source = new THREE.Group();
  const body = new THREE.Group();
  body.name = 'LedBarHousing';
  source.add(body);
  const geometry = new THREE.BoxGeometry(3.6, 0.07, 0.16);
  const paint = new THREE.MeshStandardMaterial({ color: '#1c2025', metalness: 0.15, name: 'BarHousing' });
  const metal = new THREE.MeshStandardMaterial({ color: '#8b939c', metalness: 0.85, name: 'BarHardware' });
  const rubber = new THREE.MeshStandardMaterial({ color: '#121417', name: 'BarRubber' });
  body.add(new THREE.Mesh(geometry, [paint, metal, rubber]));
  const office = new THREE.Group();
  const positions = [
    [-10.5, -4],
    [-1.5, -4],
    [-10.5, 4],
    [-1.5, 4],
  ].flatMap(([x, z]) => [-0.9, 0.9].map((dz) => [x, 4, z + dz]));
  const mounts = positions.map((position) => {
    const mount = new THREE.Group();
    mount.name = 'led-bar-housing';
    mount.position.fromArray(position);
    mount.add(new THREE.Object3D());
    office.add(mount);
    return mount;
  });
  const lit = new THREE.MeshToonMaterial({ emissive: '#fff3e0' });
  const signal = new THREE.MeshToonMaterial({ emissive: '#ee6018' });
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(3.56, 0.02, 0.11), lit);
  diffuser.position.set(0, -0.005, 0);
  const pip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.02), signal);
  pip.position.set(1.72, 0.045, 0.085);
  const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, WALL_HEIGHT - 4 - 0.07, 3), metal);
  const loft = new THREE.Group();
  loft.name = 'short-loft-led';
  loft.add(new THREE.Mesh(geometry, paint));
  office.add(diffuser, pip, wire, loft);
  const children = [...office.children],
    shortChildren = [...loft.children];
  assert.equal(installLedBarHousings(source, office), 8);
  assert.deepEqual(office.children, children);
  assert.deepEqual(loft.children, shortChildren);
  assert.deepEqual(
    mounts.map((m) => m.position.toArray()),
    positions,
  );
  const first = mounts[0].children[0].children[0] as THREE.Mesh;
  const last = mounts[7].children[0].children[0] as THREE.Mesh;
  assert.equal(first.geometry, geometry);
  assert.equal(last.geometry, geometry);
  const mats = first.material as THREE.Material[];
  assert.ok(mats.every((m) => m instanceof THREE.MeshToonMaterial));
  assert.equal(mats[1], (last.material as THREE.Material[])[1]);
  assert.deepEqual(surfaceFinish(mats[0]), [0.04, 0.72]);
  assert.deepEqual(surfaceFinish(mats[1]), [0.55, 0.3]);
  assert.equal(surfaceFinish(mats[2]), null);
  assert.equal((body.children[0] as THREE.Mesh).material[0], paint);
  assert.equal(diffuser.material, lit);
  assert.equal(pip.material, signal);
  assert.equal(wire.material, metal);
  assert.deepEqual(diffuser.position.toArray(), [0, -0.005, 0]);
  assert.deepEqual(pip.position.toArray(), [1.72, 0.045, 0.085]);
});

test('missing LED model or mount retains fallback geometry; single-material sources also work', () => {
  const office = new THREE.Group();
  const mount = new THREE.Group();
  mount.name = 'led-bar-housing';
  office.add(mount);
  const fallback = new THREE.Object3D();
  mount.add(fallback);
  assert.equal(installLedBarHousings(new THREE.Group(), office), 0);
  assert.equal(mount.children[0], fallback);
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  source.name = 'LedBarHousing';
  assert.equal(installLedBarHousings(source, new THREE.Group()), 0);
  assert.equal(installLedBarHousings(source, office), 1);
  const model = mount.children[0] as THREE.Mesh;
  assert.equal(model.geometry, source.geometry);
  assert.ok(model.material instanceof THREE.MeshToonMaterial);
});

test('LED housing retains the original exact envelope and contains no baked light source', () => {
  const data = readFileSync(new URL('../src/client/public/props/led-bar.glb', import.meta.url));
  const json = JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)).toString('utf8'));
  const meta = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'))['led-bar'];
  assert.deepEqual([meta.width, meta.height, meta.depth], [3.6, 0.07, 0.16]);
  assert.ok(meta.triangles <= 8000);
  assert.equal(meta.materials, 3);
  assert.equal(meta.bytes, data.byteLength);
  assert.deepEqual(json.nodes, [{ mesh: 0, name: 'LedBarHousing' }]);
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
  [-1.8, 0, -0.08].forEach((v, i) => assert.ok(Math.abs(min[i] - v) < 1e-6));
  [1.8, 0.07, 0.08].forEach((v, i) => assert.ok(Math.abs(max[i] - v) < 1e-6));
  assert.equal(triangles, meta.triangles);
  assert.ok(json.materials.every((m: { emissiveFactor?: number[] }) => !m.emissiveFactor || m.emissiveFactor.every((v) => v === 0)));
});
