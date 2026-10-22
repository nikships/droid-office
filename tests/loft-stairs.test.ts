import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { groundAt } from '../src/client/player.js';
import { buildLoftStairs, type Collider } from '../src/client/world/office.js';
import { installLoftStairs } from '../src/client/world/loft-stairs.js';
import { surfaceFinish } from '../src/client/world/surface.js';
import { LOFT, STAIRS } from '../src/shared/layout.js';

test('real loft stair builder keeps all fifteen walkable steps, eight rail posts and side barrier', () => {
  const colliders: Collider[] = [];
  const stairs = buildLoftStairs(colliders);
  assert.equal(stairs.name, 'loft-stairs');
  const run = (STAIRS.toX - STAIRS.fromX) / STAIRS.steps;
  const rise = LOFT.y / STAIRS.steps;
  const expected = Array.from({ length: STAIRS.steps }, (_, i) => ({
    minX: STAIRS.fromX + i * run,
    maxX: STAIRS.fromX + (i + 1) * run,
    minZ: STAIRS.minZ,
    maxZ: STAIRS.maxZ,
    top: (i + 1) * rise,
  }));
  const barrier = { minX: STAIRS.fromX, maxX: STAIRS.toX, minZ: STAIRS.minZ - 0.1, maxZ: STAIRS.minZ, top: 99 };
  assert.deepEqual(colliders, [...expected, barrier]);
  stairs.updateMatrixWorld(true);
  // Check the actual procedural surface at each rise, including both tread edges.
  const rays = new THREE.Raycaster();
  for (const step of expected) {
    const x = (step.minX + step.maxX) / 2;
    for (const z of [STAIRS.minZ + 0.3, (STAIRS.minZ + STAIRS.maxZ) / 2, STAIRS.maxZ - 0.3]) {
      assert.equal(groundAt(colliders, x, z, step.top + 0.01), step.top);
      rays.set(new THREE.Vector3(x, step.top + 0.1, z), new THREE.Vector3(0, -1, 0));
      assert.ok(Math.abs(rays.intersectObject(stairs, true)[0].point.y - step.top) < 1e-5);
    }
  }
  for (let i = 1; i <= STAIRS.steps; i += 2) {
    rays.set(new THREE.Vector3(STAIRS.fromX + (i - 0.5) * run, i * rise + 0.45, STAIRS.minZ - 0.5), new THREE.Vector3(0, 0, 1));
    assert.ok(Math.abs(rays.intersectObject(stairs, true)[0].point.z - (STAIRS.minZ + 0.04)) < 1e-5);
  }
  const office = new THREE.Group();
  const glass = new THREE.Object3D();
  const colliderSnapshot = structuredClone(colliders);
  stairs.userData.assembly = 'original';
  office.add(stairs, glass);
  const geometry = new THREE.BoxGeometry();
  const paint = new THREE.MeshStandardMaterial({ name: 'StairBody', color: '#7b7b7b' });
  const metal = new THREE.MeshStandardMaterial({ name: 'StairSteel', color: '#8c9296', metalness: 0.8 });
  const signal = new THREE.MeshStandardMaterial({ name: 'StairSignal', color: '#ee6018' });
  const original = [paint, metal, signal, metal];
  const source = new THREE.Group();
  const part = new THREE.Group();
  part.name = 'LoftStairs';
  part.add(new THREE.Mesh(geometry, original), new THREE.Mesh(geometry, metal));
  source.add(part);
  assert.equal(installLoftStairs(source, office), true);
  assert.equal(office.children[0], stairs);
  assert.equal(office.children[1], glass);
  assert.equal(stairs.userData.assembly, 'original');
  assert.deepEqual(stairs.position.toArray(), [0, 0, 0]);
  assert.equal(stairs.children.length, 1);
  assert.deepEqual(colliders, colliderSnapshot);
  const model = stairs.children[0];
  assert.deepEqual(model.position.toArray(), [STAIRS.fromX, 0, STAIRS.minZ]);
  const loaded = model.children[0] as THREE.Mesh;
  assert.equal(loaded.geometry, geometry);
  const materials = loaded.material as THREE.MeshToonMaterial[];
  assert.ok(materials.every((m) => m.isMeshToonMaterial));
  assert.deepEqual(materials.map(surfaceFinish), [[0.04, 0.72], [0.55, 0.3], null, [0.55, 0.3]]);
  assert.equal(materials[1], materials[3]);
  assert.equal((model.children[1] as THREE.Mesh).material, materials[1]);
  assert.equal(materials[2].emissive.getHex(), 0);
  assert.ok(materials[2].color.equals(signal.color));
  assert.equal((part.children[0] as THREE.Mesh).material, original);
  assert.equal(part.parent, source);
});

test('missing loft stair parts keep the complete fallback; a direct mesh source also installs', () => {
  const office = new THREE.Group();
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  source.name = 'LoftStairs';
  assert.equal(installLoftStairs(source, office), false);
  const stairs = buildLoftStairs([]);
  office.add(stairs);
  const fallback = [...stairs.children];
  assert.equal(installLoftStairs(new THREE.Group(), office), false);
  assert.deepEqual(stairs.children, fallback);
  assert.equal(installLoftStairs(source, office), true);
  assert.ok(((stairs.children[0] as THREE.Mesh).material as THREE.MeshToonMaterial).isMeshToonMaterial);
  assert.ok(source.material.isMeshStandardMaterial);
});

test('stair GLB retains a direct identity node, exact run/width and fifteen original safety stripes', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'));
  const asset = manifest['loft-stairs'];
  assert.equal(asset.triangles, 7800);
  assert.equal(asset.materials, 5);
  assert.equal(asset.width, STAIRS.toX - STAIRS.fromX + 0.04);
  assert.equal(asset.depth, Number((STAIRS.maxZ - STAIRS.minZ).toFixed(4)));
  const buffer = readFileSync(new URL('../src/client/public/props/loft-stairs.glb', import.meta.url));
  assert.equal(buffer.length, asset.bytes);
  const glb = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString());
  const node = glb.nodes.find((n: { name: string }) => n.name === 'LoftStairs');
  assert.ok(node);
  assert.equal(node.translation, undefined);
  assert.equal(node.rotation, undefined);
  assert.equal(node.scale, undefined);
  type Primitive = { material: number; indices: number; attributes: { POSITION: number } };
  const primitives: Primitive[] = glb.meshes[node.mesh].primitives;
  const bounds = primitives.map((p) => glb.accessors[p.attributes.POSITION]);
  const min = [0, 1, 2].map((i) => Math.min(...bounds.map((b) => b.min[i])));
  const max = [0, 1, 2].map((i) => Math.max(...bounds.map((b) => b.max[i])));
  for (const [got, want] of [
    [min[0], -0.04],
    [min[1], 0],
    [min[2], 0],
    [max[0], 6],
    [max[2], 1.8],
  ])
    assert.ok(Math.abs(got - want) < 1e-5);
  // The original rail envelope, with only its 5 mm corner bevel removed.
  assert.ok(max[1] > 3.94 && max[1] < 3.945);
  const signal = primitives.find((p) => glb.materials[p.material].name === 'StairSignal')!;
  assert.ok(signal);
  const stripe = glb.accessors[signal.attributes.POSITION];
  assert.ok(Math.abs(stripe.min[1] - 0.195) < 1e-5);
  assert.ok(Math.abs(stripe.max[1] - 3.007) < 1e-5);
  assert.equal(glb.accessors[signal.indices].count / 3, 15 * 44);
});
