import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { DROID_RACK } from '../src/shared/layout.js';
import type { DressingKit } from '../src/client/world/factory-floor.js';
import { placeFactoryProps } from '../src/client/world/factory-props.js';
import { installDroidRack } from '../src/client/world/droid-rack.js';
import { surfaceFinish } from '../src/client/world/surface.js';

function rack() {
  const fixtures: unknown[][] = [];
  const kit = {
    group: new THREE.Group(),
    colliders: [],
    interactables: [],
    fixture: (...args: unknown[]) => fixtures.push(args),
    night: { lamps: [] },
  } as unknown as DressingKit;
  const dressing = placeFactoryProps(kit);
  const mount = kit.group.getObjectByName('droid-rack-frame')!;
  return { kit, dressing, mount, root: mount.parent!, fixtures };
}

test('actual rack retains its envelope, collider, fixtures and live-object siblings', () => {
  const { kit, dressing, mount, root, fixtures } = rack();
  const before = new THREE.Box3().setFromObject(mount);
  const colliders = kit.colliders.map((c) => ({ ...c }));
  const fixtureBefore = fixtures.map((f) => [...f]);
  const material = new THREE.MeshBasicMaterial({ color: '#38d87c' });
  const live = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.058), material);
  live.position.set(DROID_RACK.maxX + 0.001, 0.232, (DROID_RACK.minZ + DROID_RACK.maxZ) / 2);
  root.add(live);
  const source = new THREE.Group();
  const part = new THREE.Group();
  part.name = 'DroidRack';
  const original = [
    new THREE.MeshStandardMaterial({ name: 'RackCase', color: '#141414', metalness: 0.25 }),
    new THREE.MeshStandardMaterial({ name: 'RackDeck', color: '#2a2a2a', metalness: 0.8 }),
    new THREE.MeshStandardMaterial({ name: 'RackBackboard', color: '#0e0e0e', metalness: 0.2 }),
    new THREE.MeshStandardMaterial({ name: 'RackHardware', color: '#6e767e', metalness: 0.85 }),
    new THREE.MeshStandardMaterial({ name: 'RackRubber', color: '#020202' }),
  ];
  const geometry = new THREE.BoxGeometry(0.71, 0.866, 2.31).translate(0, 0.433, 0);
  part.add(new THREE.Mesh(geometry, original), new THREE.Mesh(geometry, original[1]));
  source.add(part);
  const fallback = mount.children[0];
  assert.equal(installDroidRack(source, kit.group), true);
  assert.equal(mount.parent, root);
  assert.equal(fallback.parent, null);
  assert.equal(root.children[1], live);
  assert.equal(live.material, material);
  assert.deepEqual(live.position.toArray(), [DROID_RACK.maxX + 0.001, 0.232, (DROID_RACK.minZ + DROID_RACK.maxZ) / 2]);
  assert.deepEqual(kit.colliders, colliders);
  assert.deepEqual(fixtures, fixtureBefore);
  const model = mount.children[0];
  assert.deepEqual(model.position.toArray(), [(DROID_RACK.minX + DROID_RACK.maxX) / 2, 0, (DROID_RACK.minZ + DROID_RACK.maxZ) / 2]);
  const after = new THREE.Box3().setFromObject(mount);
  assert.ok(after.min.distanceTo(before.min) < 1e-4);
  assert.ok(after.max.distanceTo(before.max) < 1e-4);
  const loaded = model.children[0] as THREE.Mesh;
  assert.equal(loaded.geometry, geometry);
  const materials = loaded.material as THREE.MeshToonMaterial[];
  assert.ok(materials.every((m) => m.isMeshToonMaterial && m.emissive.getHex() === 0));
  assert.deepEqual(materials.map(surfaceFinish), [[0.04, 0.72], [0.55, 0.3], [0.04, 0.72], [0.55, 0.3], null]);
  assert.ok(materials[0].color.equals(original[0].color));
  assert.equal((model.children[1] as THREE.Mesh).material, materials[1]);
  assert.equal((part.children[0] as THREE.Mesh).material, original);
  assert.equal(part.parent, source);
  for (let t = 0; t < 2; t += 0.5) dressing.update(t, 0.5);
  assert.equal(root.children[1], live);
  assert.deepEqual(kit.colliders, colliders);
});

test('rack fallback survives missing nodes and a single-mesh source retains its own material', () => {
  const { kit, mount } = rack();
  const fallback = mount.children[0];
  assert.equal(installDroidRack(new THREE.Group(), kit.group), false);
  assert.equal(mount.children[0], fallback);
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'RackRubber' }));
  source.name = 'DroidRack';
  assert.equal(installDroidRack(source, new THREE.Group()), false);
  assert.equal(installDroidRack(source, kit.group), true);
  const material = (mount.children[0] as THREE.Mesh).material as THREE.MeshToonMaterial;
  assert.ok(material.isMeshToonMaterial);
  assert.equal(surfaceFinish(material), null);
  assert.ok(source.material.isMeshStandardMaterial);
});

test('rack GLB keeps the original plinth/backboard bounds without cubes, screens or lights', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'));
  const asset = manifest['droid-rack'];
  assert.deepEqual([asset.width, asset.height, asset.depth], [0.71, 0.866, 2.31]);
  assert.ok(asset.triangles <= 8000);
  assert.equal(asset.materials, 5);
  const glb = readFileSync(new URL('../src/client/public/props/droid-rack.glb', import.meta.url));
  assert.equal(glb.byteLength, asset.bytes);
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  assert.equal(json.nodes.length, 1);
  assert.equal(json.nodes[0].name, 'DroidRack');
  const bounds = json.meshes[json.nodes[0].mesh].primitives.map((p: { attributes: { POSITION: number } }) => json.accessors[p.attributes.POSITION]);
  for (const [axis, min, max] of [
    [0, -0.355, 0.355],
    [1, 0, 0.866],
    [2, -1.155, 1.155],
  ]) {
    assert.ok(Math.abs(Math.min(...bounds.map((b: { min: number[] }) => b.min[axis])) - min) < 1e-4);
    assert.ok(Math.abs(Math.max(...bounds.map((b: { max: number[] }) => b.max[axis])) - max) < 1e-4);
  }
  const deck = json.meshes[0].primitives.find((p: { material: number }) => json.materials[p.material].name === 'RackDeck');
  assert.ok(deck);
  const names = json.materials.map((m: { name: string }) => m.name).sort();
  assert.deepEqual(names, ['RackBackboard', 'RackCase', 'RackDeck', 'RackHardware', 'RackRubber']);
  assert.ok(json.materials.every((m: { emissiveFactor?: number[] }) => !m.emissiveFactor?.some(Boolean)));
});
