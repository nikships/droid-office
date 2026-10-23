import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildRooftop } from '../src/client/world/rooftop.js';
import { ROOF_PLANTER, ROOF_PLANTERS, buildRoofPlanters, installRoofPlanters } from '../src/client/world/rooftop-planter.js';
import { surfaceFinish } from '../src/client/world/surface.js';
import type { Collider } from '../src/client/world/office.js';
import { ELEVATOR, ELEVATOR_FRONT, FLOOR } from '../src/shared/layout.js';

function sourceKit() {
  const materials = ['PlanterConcrete', 'PlanterSteel', 'PlanterSoil', 'PlanterSage', 'PlanterEvergreen', 'PlanterSeedheads'].map((name) => new THREE.MeshStandardMaterial({ name, color: '#738659' }));
  materials[0].map = new THREE.Texture();
  materials[0].map.colorSpace = THREE.SRGBColorSpace;
  const geometry = new THREE.BoxGeometry(ROOF_PLANTER.width, ROOF_PLANTER.basinHeight, ROOF_PLANTER.depth).translate(0, ROOF_PLANTER.basinHeight / 2, 0);
  const source = new THREE.Group();
  source.add(new THREE.Mesh(geometry, materials), new THREE.Mesh(geometry, materials[2]));
  return { source, materials, geometry };
}

function canvasDocument() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => {
        const canvas = { width: 1, height: 1, getContext: () => context };
        const gradient = { addColorStop() {} };
        const context = new Proxy(
          { canvas, measureText: (text: string) => ({ width: text.length * 12 }), createRadialGradient: () => gradient, createLinearGradient: () => gradient },
          { get: (target, key) => Reflect.get(target, key) ?? (() => {}) },
        );
        return canvas;
      },
    },
  });
  return () => (previous ? Object.defineProperty(globalThis, 'document', previous) : Reflect.deleteProperty(globalThis, 'document'));
}

test('six basins share the placement record and leave the centre, railing walks and elevator approach clear', () => {
  const colliders: Collider[] = [];
  const planters = buildRoofPlanters(colliders);
  assert.equal(planters.children.length, 6);
  assert.equal(colliders.length, 6);
  planters.updateMatrixWorld(true);
  for (const [i, mount] of planters.children.entries()) {
    const p = ROOF_PLANTERS[i];
    assert.deepEqual(mount.position.toArray(), [p.x, 0, p.z]);
    assert.equal(mount.rotation.y, p.rotY);
    const box = new THREE.Box3().setFromObject(mount.children[0]);
    const c = colliders[i];
    assert.ok(Math.abs(c.minX - box.min.x) < 1e-6 && Math.abs(c.maxX - box.max.x) < 1e-6);
    assert.ok(Math.abs(c.minZ - box.min.z) < 1e-6 && Math.abs(c.maxZ - box.max.z) < 1e-6);
    assert.equal(c.bottom, 0);
    assert.equal(c.top, ROOF_PLANTER.basinHeight);
    assert.ok(c.minX - FLOOR.minX >= 1.19 && FLOOR.maxX - c.maxX >= 1.19);
    assert.ok(FLOOR.maxZ - c.maxZ >= 1.29);
    assert.ok(c.maxZ > ELEVATOR_FRONT + 1);
    assert.ok(c.minX > ELEVATOR.x + ELEVATOR.width / 2 || c.maxX < ELEVATOR.x - ELEVATOR.width / 2 || c.minZ > ELEVATOR_FRONT + 1);
    assert.ok(c.minX > 1 || c.maxX < -1);
  }
});

test('roof installs shared toon resources before warmup without replacing pickables, controls, lights or colliders', (t) => {
  t.after(canvasDocument());
  const night = { bulbs: [], halos: [], lamps: [], street: 0, windows: [], clouds: new THREE.MeshToonMaterial() };
  const roof = buildRooftop(night, 4);
  const mountGroup = roof.group.getObjectByName('rooftop-planters')!;
  assert.ok(roof.pickables.includes(mountGroup));
  const colliders = [...roof.colliders];
  const interactables = [...roof.interactables];
  const lights = [night.bulbs.length, night.halos.length, night.lamps.length];
  const kit = sourceKit();
  assert.equal(installRoofPlanters(kit.source, roof.group), true);
  let first: THREE.Material[] | undefined;
  for (const mount of mountGroup.children) {
    const model = mount.children[0];
    const body = model.children[0] as THREE.Mesh;
    assert.equal(body.geometry, kit.geometry);
    assert.ok(Array.isArray(body.material));
    if (!first) first = body.material;
    else assert.deepEqual(body.material, first);
    for (const material of body.material) assert.ok(material instanceof THREE.MeshToonMaterial);
    const concrete = body.material[0] as THREE.MeshToonMaterial;
    assert.equal(concrete.map, kit.materials[0].map);
    assert.equal(concrete.map?.colorSpace, THREE.SRGBColorSpace);
    assert.deepEqual(surfaceFinish(body.material[1]), [0.55, 0.3]);
    assert.equal(body.material[3].userData.outlineParameters.visible, false);
    assert.deepEqual(body.position.toArray(), [0, 0, 0]);
    assert.deepEqual(body.scale.toArray(), [1, 1, 1]);
  }
  assert.deepEqual(roof.colliders, colliders);
  assert.deepEqual(roof.interactables, interactables);
  assert.deepEqual([night.bulbs.length, night.halos.length, night.lamps.length], lights);
  assert.equal((kit.source.children[0] as THREE.Mesh).material, kit.materials);
  roof.setFloors(5);
  assert.equal(roof.group.getObjectByName('rooftop-planters'), mountGroup);
});

test('missing mounts, missing materials and unsupported materials retain every planted fallback', () => {
  const root = buildRoofPlanters([]);
  const original = root.children.map((mount) => [...mount.children]);
  const kit = sourceKit();
  assert.equal(installRoofPlanters(kit.source, new THREE.Group()), false);
  assert.equal(installRoofPlanters(new THREE.Group(), root), false);
  kit.materials[0].map = null;
  assert.equal(installRoofPlanters(kit.source, root), false);
  kit.materials[0].map = new THREE.Texture();
  kit.source.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
  assert.equal(installRoofPlanters(kit.source, root), false);
  assert.deepEqual(
    root.children.map((mount) => [...mount.children]),
    original,
  );
});

test('generated planter has the exact solid footprint, opaque foliage and embedded cast-concrete grain', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'));
  const asset = manifest['rooftop-planter'];
  assert.equal(asset.width, ROOF_PLANTER.width);
  assert.equal(asset.depth, ROOF_PLANTER.depth);
  assert.ok(asset.height > 1.5 && asset.height < 1.65);
  assert.equal(asset.triangles, 6800);
  assert.ok(asset.triangles <= 8000);
  assert.equal(asset.materials, 6);
  const buffer = readFileSync(new URL('../src/client/public/props/rooftop-planter.glb', import.meta.url));
  assert.equal(buffer.length, asset.bytes);
  const length = buffer.readUInt32LE(12);
  const glb = JSON.parse(buffer.subarray(20, 20 + length).toString());
  for (const material of glb.materials) assert.ok(!material.alphaMode || material.alphaMode === 'OPAQUE');
  const concrete = glb.materials.find((m: { name: string }) => m.name === 'PlanterConcrete');
  assert.ok(concrete.pbrMetallicRoughness.baseColorTexture);
  assert.equal(glb.images.length, 1);
  const image = glb.images[0];
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.uri, undefined);
  const view = glb.bufferViews[image.bufferView];
  const png = buffer.subarray(28 + length + view.byteOffset, 28 + length + view.byteOffset + view.byteLength);
  assert.equal(png.toString('ascii', 1, 4), 'PNG');
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
});
