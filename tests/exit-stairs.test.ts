import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { groundAt, STEP } from '../src/client/player.js';
import { buildExitStairs, type Collider } from '../src/client/world/office.js';
import { installExitStairs } from '../src/client/world/exit-stairs.js';
import { surfaceFinish } from '../src/client/world/surface.js';
import { EXIT_STAIRS, STOREY, STREET_Y } from '../src/shared/layout.js';

test('actual exit stair fallback keeps landing, fourteen walkable treads and both rail barriers', () => {
  const colliders: Collider[] = [];
  const stairs = buildExitStairs(colliders);
  const { minX, maxX, landingZ0, landingZ1, steps, run } = EXIT_STAIRS;
  const rise = -STREET_Y / steps;
  const bottomZ = landingZ1 + (steps - 1.5) * run;
  const surfaces = [{ minX, maxX, minZ: landingZ0, maxZ: landingZ1, bottom: STREET_Y, top: 0 }];
  for (let i = 1; i < steps; i++) {
    const z0 = landingZ1 + (i - 1) * run;
    surfaces.push({ minX, maxX, minZ: z0, maxZ: z0 + run, bottom: STREET_Y, top: -i * rise });
  }
  assert.deepEqual(colliders, [...surfaces, { minX: minX - 0.05, maxX: minX + 0.1, minZ: landingZ0, maxZ: bottomZ, bottom: STREET_Y, top: 99 }, { minX, maxX, minZ: landingZ0 - 0.05, maxZ: landingZ0 + 0.1, bottom: STREET_Y, top: 99 }]);
  assert.ok(rise < STEP);
  assert.ok(Math.abs(surfaces.at(-1)!.top - STREET_Y - rise) < 1e-10);
  assert.equal(stairs.name, 'exit-stairs');
  stairs.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  for (const surface of surfaces) {
    const z = surface.minZ + (surface.maxZ - surface.minZ) / 2;
    for (const x of [minX + 0.3, (minX + maxX) / 2, maxX - 0.3]) {
      assert.equal(groundAt(colliders, x, z, surface.top + 0.01), surface.top);
      ray.set(new THREE.Vector3(x, surface.top + 0.1, z), new THREE.Vector3(0, -1, 0));
      assert.ok(Math.abs(ray.intersectObject(stairs, true)[0].point.y - surface.top - 0.005) < 1e-5);
    }
  }
});

test('stair installation keeps ground parent/storey shift, siblings, colliders and shared concrete/metal finishes', () => {
  const colliders: Collider[] = [];
  const stairs = buildExitStairs(colliders);
  const originalColliders = structuredClone(colliders);
  const ground = new THREE.Group();
  const door = new THREE.Object3D();
  const balcony = new THREE.Object3D();
  const office = new THREE.Group();
  ground.add(stairs, door, balcony);
  ground.position.y = -STOREY;
  office.add(ground);
  stairs.userData.fixture = 'original';
  stairs.visible = false;
  const source = new THREE.Group();
  const part = new THREE.Group();
  part.name = 'ExitStairs';
  const concrete = new THREE.MeshStandardMaterial({ name: 'ExitConcrete', color: '#a9a9a9' });
  const tread = new THREE.MeshStandardMaterial({ name: 'ExitTread', color: '#b2b2b2' });
  const rail = new THREE.MeshStandardMaterial({ name: 'ExitRail', color: '#a6a6a6', metalness: 0.8 });
  const anchor = new THREE.MeshStandardMaterial({ name: 'ExitAnchor', color: '#b8bec3', metalness: 0.85 });
  const original = [concrete, tread, rail, anchor, rail];
  const geometry = new THREE.BoxGeometry();
  part.add(new THREE.Mesh(geometry, original), new THREE.Mesh(geometry, rail));
  source.add(part);
  assert.equal(installExitStairs(source, office), true);
  assert.equal(stairs.parent, ground);
  assert.deepEqual(ground.children, [stairs, door, balcony]);
  assert.equal(stairs.userData.fixture, 'original');
  assert.equal(stairs.visible, false);
  assert.deepEqual(stairs.position.toArray(), [0, 0, 0]);
  assert.deepEqual(colliders, originalColliders);
  const model = stairs.children[0];
  assert.deepEqual(model.position.toArray(), [(EXIT_STAIRS.minX + EXIT_STAIRS.maxX) / 2, 0, EXIT_STAIRS.landingZ0]);
  for (const index of [0, 1, 3]) {
    ground.position.y = -index * STOREY;
    office.updateMatrixWorld(true);
    assert.equal(model.getWorldPosition(new THREE.Vector3()).y + index * STOREY, 0);
  }
  const loaded = model.children[0] as THREE.Mesh;
  assert.equal(loaded.geometry, geometry);
  const materials = loaded.material as THREE.MeshToonMaterial[];
  assert.ok(materials.every((m) => m.isMeshToonMaterial));
  assert.deepEqual(materials.map(surfaceFinish), [null, null, [0.55, 0.3], [0.55, 0.3], [0.55, 0.3]]);
  assert.equal(materials[2], materials[4]);
  assert.equal((model.children[1] as THREE.Mesh).material, materials[2]);
  assert.ok(materials.every((m, i) => m.color.equals(original[i].color) && m.emissive.getHex() === 0));
  assert.equal((part.children[0] as THREE.Mesh).material, original);
  assert.equal(part.parent, source);
});

test('missing exit stair nodes preserve the fallback; a direct mesh source installs too', () => {
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  source.name = 'ExitStairs';
  const office = new THREE.Group();
  assert.equal(installExitStairs(source, office), false);
  const stairs = buildExitStairs([]);
  office.add(stairs);
  const fallback = [...stairs.children];
  assert.equal(installExitStairs(new THREE.Group(), office), false);
  assert.deepEqual(stairs.children, fallback);
  assert.equal(installExitStairs(source, office), true);
  assert.ok(((stairs.children[0] as THREE.Mesh).material as THREE.MeshToonMaterial).isMeshToonMaterial);
  assert.ok(source.material.isMeshStandardMaterial);
});

test('exit stair GLB keeps landing-origin identity and the original concrete/rail envelope', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'));
  const asset = manifest['exit-stairs'];
  assert.equal(asset.triangles, 7028);
  assert.equal(asset.materials, 4);
  assert.deepEqual([asset.width, asset.height, asset.depth], [1.6, 4.635, 6.67]);
  const buffer = readFileSync(new URL('../src/client/public/props/exit-stairs.glb', import.meta.url));
  assert.equal(buffer.length, asset.bytes);
  const glb = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString());
  const node = glb.nodes.find((n: { name: string }) => n.name === 'ExitStairs');
  assert.ok(node);
  assert.equal(node.translation, undefined);
  assert.equal(node.rotation, undefined);
  assert.equal(node.scale, undefined);
  type Primitive = { material: number; attributes: { POSITION: number } };
  const primitives: Primitive[] = glb.meshes[node.mesh].primitives;
  const bounds = primitives.map((p) => glb.accessors[p.attributes.POSITION]);
  const min = [0, 1, 2].map((i) => Math.min(...bounds.map((b) => b.min[i])));
  const max = [0, 1, 2].map((i) => Math.max(...bounds.map((b) => b.max[i])));
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(min[i] - [-0.8, STREET_Y, 0][i]) < 1e-5);
    assert.ok(Math.abs(max[i] - [0.8, 1.035, 6.67][i]) < 1e-5);
  }
  const tread = primitives.find((p) => glb.materials[p.material].name === 'ExitTread')!;
  const core = primitives.find((p) => glb.materials[p.material].name === 'ExitConcrete')!;
  const coreBounds = glb.accessors[core.attributes.POSITION];
  // Keep the cap/core side faces distinct so the overlapping solids cannot self-shadow into black seams.
  assert.ok(Math.abs(coreBounds.min[0] + 0.798) < 1e-5);
  assert.ok(Math.abs(coreBounds.max[0] - 0.798) < 1e-5);
  const treadBounds = glb.accessors[tread.attributes.POSITION];
  assert.ok(Math.abs(treadBounds.max[1] - 0.005) < 1e-5);
  assert.ok(Math.abs(treadBounds.min[1] - (-14 * 0.24 - 0.035)) < 1e-5);
});
