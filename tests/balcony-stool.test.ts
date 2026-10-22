import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { installBalconyStools } from '../src/client/world/balcony-stool.js';
import { surfaceFinish } from '../src/client/world/surface.js';
import { SEATING_BY_ID } from '../src/shared/layout.js';

function mount(id: number, color?: string) {
  const seat = SEATING_BY_ID.get(`stool-${id}`)!;
  const group = new THREE.Group();
  group.name = `balcony-stool-${id}`;
  group.position.set(seat.x, seat.y, seat.z);
  group.userData.seatColor = color;
  group.userData.interact = { kind: 'seat', seatId: seat.id, radius: 0.9 };
  group.add(new THREE.Object3D());
  return group;
}

test('both stool mounts retain their colors, seats and picking while sharing hardware and geometry', () => {
  const office = new THREE.Group();
  const first = mount(1, '#808080'),
    second = mount(2, '#8a8a8a');
  const picks = [first.userData.interact, second.userData.interact];
  const poses = [first.position.toArray(), second.position.toArray()];
  const table = new THREE.Group();
  office.add(first, second, table);
  const source = new THREE.Group();
  const part = new THREE.Group();
  part.name = 'BalconyStool';
  const seat = new THREE.MeshStandardMaterial({ name: 'StoolSeat', color: '#808080' });
  const shell = new THREE.MeshStandardMaterial({ name: 'StoolShell' });
  const steel = new THREE.MeshStandardMaterial({ name: 'StoolSteel', metalness: 0.85 });
  const welt = new THREE.MeshStandardMaterial({ name: 'StoolWelt' });
  const rubber = new THREE.MeshStandardMaterial({ name: 'StoolRubber' });
  const original = [seat, shell, steel, welt, rubber, seat];
  const geometry = new THREE.CylinderGeometry(0.2, 0.2, 0.05, 24);
  part.add(new THREE.Mesh(geometry, original), new THREE.Mesh(geometry, steel));
  source.add(part);
  assert.equal(installBalconyStools(source, office), 2);
  assert.equal(office.children[2], table);
  const a = first.children[0].children[0] as THREE.Mesh;
  const b = second.children[0].children[0] as THREE.Mesh;
  const am = a.material as THREE.MeshToonMaterial[],
    bm = b.material as THREE.MeshToonMaterial[];
  assert.ok(am.every((m) => m.isMeshToonMaterial));
  assert.deepEqual(am.map(surfaceFinish), [null, [0.04, 0.72], [0.55, 0.3], null, null, null]);
  assert.equal(a.geometry, geometry);
  assert.equal(b.geometry, geometry);
  assert.notEqual(am[0], bm[0]);
  assert.ok(am[0].color.equals(new THREE.Color('#808080')));
  assert.ok(bm[0].color.equals(new THREE.Color('#8a8a8a')));
  assert.equal(am[0], am[5]);
  assert.equal(bm[0], bm[5]);
  for (const i of [1, 2, 3, 4]) assert.equal(am[i], bm[i]);
  assert.equal((first.children[0].children[1] as THREE.Mesh).material, am[2]);
  assert.equal((part.children[0] as THREE.Mesh).material, original);
  assert.ok(seat.color.equals(new THREE.Color('#808080')));
  assert.equal(part.parent, source);
  [first, second].forEach((m, i) => {
    assert.deepEqual(m.position.toArray(), poses[i]);
    assert.equal(m.userData.interact, picks[i]);
    const s = SEATING_BY_ID.get(`stool-${i + 1}`)!;
    assert.deepEqual([s.places, s.hips, s.depth, s.out], [[0], 0.5, 0, -0.7]);
    assert.equal(s.rotY, i === 0 ? Math.PI / 2 : -Math.PI / 2);
  });
});

test('missing stool nodes retain fallback and untinted single-mesh sources remain immutable', () => {
  const office = new THREE.Group();
  const stool = mount(1);
  const fallback = stool.children[0];
  office.add(stool);
  assert.equal(installBalconyStools(new THREE.Group(), office), 0);
  assert.equal(stool.children[0], fallback);
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'StoolSeat', color: '#808080' }));
  source.name = 'BalconyStool';
  assert.equal(installBalconyStools(source, new THREE.Group()), 0);
  assert.equal(installBalconyStools(source, office), 1);
  const material = (stool.children[0] as THREE.Mesh).material as THREE.MeshToonMaterial;
  assert.ok(material.isMeshToonMaterial);
  assert.ok(material.color.equals(source.material.color));
  assert.ok(source.material.isMeshStandardMaterial);
});

test('stool GLB retains original radius, floor contact and 0.49 m seat surface', () => {
  const meta = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'))['balcony-stool'];
  assert.deepEqual([meta.width, meta.height, meta.depth], [0.4, 0.49, 0.4]);
  assert.ok(meta.triangles <= 8000);
  assert.equal(meta.materials, 5);
  const data = readFileSync(new URL('../src/client/public/props/balcony-stool.glb', import.meta.url));
  assert.equal(data.byteLength, meta.bytes);
  const json = JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)).toString('utf8'));
  assert.ok(json.nodes.some((n: { name: string }) => n.name === 'BalconyStool'));
  type Primitive = { material: number; attributes: { POSITION: number } };
  const parts: Primitive[] = json.meshes.flatMap((m: { primitives: Primitive[] }) => m.primitives);
  const pad = parts.find((p) => json.materials[p.material].name === 'StoolSeat');
  assert.ok(pad);
  const bounds = json.accessors[pad.attributes.POSITION];
  assert.ok(Math.abs(bounds.max[1] - 0.49) < 1e-4);
  assert.ok(Math.abs(bounds.max[0] - 0.2) < 1e-4 && Math.abs(bounds.min[0] + 0.2) < 1e-4);
  assert.ok(Math.abs(Math.min(...parts.map((p) => json.accessors[p.attributes.POSITION].min[1]))) < 1e-4);
});
