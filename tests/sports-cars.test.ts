import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildGarage } from '../src/client/world/outside.js';
import { CAR } from '../src/client/world/cars.js';
import { installSportsCars } from '../src/client/world/sports-cars.js';
import { surfaceFinish } from '../src/client/world/surface.js';
import type { Collider } from '../src/client/world/office.js';
import { STREET_Y } from '../src/shared/layout.js';

const NAMES = ['CarPaint', 'CarRubber', 'CarMetal', 'CarCarbon', 'CarGlass', 'CarHeadlight', 'CarTaillight', 'CarCaliper'];

function sourceKit() {
  const source = new THREE.Group();
  source.position.set(17, 12, -9);
  const materials = NAMES.map((name) => new THREE.MeshStandardMaterial({ name, color: '#ffffff', side: THREE.DoubleSide }));
  materials[3].map = new THREE.Texture();
  materials[4].map = new THREE.Texture();
  for (const name of ['SportsWedge', 'SportsCoupe']) {
    const model = new THREE.Group();
    model.name = name;
    model.position.set(0.02, 0, 0);
    for (const material of materials) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), material);
      mesh.position.set(0, 0.1, 0.2);
      model.add(mesh);
    }
    source.add(model);
  }
  return { source, materials };
}

function canvasDocument() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => {
        const canvas = { width: 1, height: 1, getContext: () => context };
        const context = new Proxy({ canvas, measureText: (text: string) => ({ width: text.length * 12 }) }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) });
        return canvas;
      },
    },
  });
  return () => (previous ? Object.defineProperty(globalThis, 'document', previous) : Reflect.deleteProperty(globalThis, 'document'));
}

test('all nine original parking anchors, paint colors, directions and contact surfaces survive instancing', (t) => {
  t.after(canvasDocument());
  const root = new THREE.Group();
  const colliders: Collider[] = [];
  buildGarage(root, colliders);
  const children = [...root.children];
  const parked = root.getObjectByName('parked-cars')!;
  const anchors = parked.children.filter((object) => object.userData.parkedCar);
  assert.equal(anchors.length, 9);
  assert.equal(anchors.filter((a) => a.userData.parkedCar.kind === 'lambo').length, 5);
  const poses = anchors.map((anchor) => [anchor.position.toArray(), anchor.quaternion.toArray(), { ...anchor.userData.parkedCar }]);
  const originalColliders = structuredClone(colliders);
  const fallback = parked.getObjectByName('parked-car-fallback')!;
  let disposed = 0;
  let fallbackMeshes = 0;
  fallback.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      fallbackMeshes++;
      object.geometry.addEventListener('dispose', () => disposed++);
    }
  });
  const { source, materials } = sourceKit();
  let sourceDisposed = 0;
  source.traverse((object) => {
    if (object instanceof THREE.Mesh) object.geometry.addEventListener('dispose', () => sourceDisposed++);
  });
  assert.equal(installSportsCars(source, root), true);
  assert.deepEqual(root.children, children);
  assert.deepEqual(colliders, originalColliders);
  assert.deepEqual(
    anchors.map((anchor) => [anchor.position.toArray(), anchor.quaternion.toArray(), { ...anchor.userData.parkedCar }]),
    poses,
  );
  assert.equal(disposed, fallbackMeshes);
  assert.equal(sourceDisposed, 0);
  assert.equal(fallback.parent, null);
  const batches = parked.getObjectByName('sports-car-models')!;
  assert.equal(batches.children.length, 16);
  const converted = new Map<string, THREE.Material>();
  for (const [kind, name] of [
    ['lambo', 'SportsWedge'],
    ['ferrari', 'SportsCoupe'],
  ] as const) {
    const sites = anchors.filter((a) => a.userData.parkedCar.kind === kind);
    for (const part of source.getObjectByName(name)!.children as THREE.Mesh[]) {
      const src = part.material as THREE.MeshStandardMaterial;
      const batch = batches.getObjectByName(`${kind}-${src.name}`) as THREE.InstancedMesh;
      assert.ok(batch instanceof THREE.InstancedMesh);
      assert.equal(batch.geometry, part.geometry);
      assert.equal(batch.count, sites.length);
      if (converted.has(src.name)) assert.equal(batch.material, converted.get(src.name));
      converted.set(src.name, batch.material as THREE.Material);
      const relative = new THREE.Matrix4().multiplyMatrices(source.matrixWorld.clone().invert(), part.matrixWorld);
      for (const [i, site] of sites.entries()) {
        const actual = new THREE.Matrix4();
        batch.getMatrixAt(i, actual);
        const expected = new THREE.Matrix4().multiplyMatrices(site.matrix, relative);
        assert.ok(actual.elements.every((v, j) => Math.abs(v - expected.elements[j]) < 1e-5));
        if (src.name === 'CarPaint') {
          const color = new THREE.Color();
          batch.getColorAt(i, color);
          const expected = new THREE.Color(site.userData.parkedCar.color);
          assert.ok(Math.abs(color.r - expected.r) + Math.abs(color.g - expected.g) + Math.abs(color.b - expected.b) < 1e-6);
        } else assert.equal(batch.instanceColor, null);
      }
      assert.ok(batch.boundingBox && batch.boundingSphere);
    }
  }
  for (const name of ['CarGlass', 'CarHeadlight', 'CarTaillight']) assert.ok(converted.get(name) instanceof THREE.MeshBasicMaterial);
  assert.ok(converted.get('CarPaint') instanceof THREE.MeshToonMaterial);
  assert.deepEqual(surfaceFinish(converted.get('CarMetal')!), [0.55, 0.3]);
  assert.deepEqual(surfaceFinish(converted.get('CarPaint')!), [0.04, 0.72]);
  assert.equal((converted.get('CarCarbon') as THREE.MeshToonMaterial).map, materials[3].map);
  assert.equal((converted.get('CarGlass') as THREE.MeshBasicMaterial).map, materials[4].map);
  const orange = anchors[8];
  assert.equal(orange.userData.parkedCar.color, '#ee6018');
  const nose = new THREE.Vector3(0, 0, 1).applyQuaternion(orange.quaternion);
  assert.ok(nose.x > 0.999 && Math.abs(nose.z) < 1e-6);
  const contact = colliders.at(-2)!;
  assert.ok(Math.abs(contact.minX - 6.78) < 1e-6 && Math.abs(contact.maxX - 11.22) < 1e-6);
  assert.ok(Math.abs(contact.minZ - 17.28) < 1e-6 && Math.abs(contact.maxZ - 19.12) < 1e-6);
  assert.equal(contact.top, STREET_Y + CAR.body);
  assert.equal(colliders.at(-1)!.top, STREET_Y + CAR.roof);
  const before = new THREE.Box3().setFromObject(parked);
  root.position.y = -14;
  root.updateMatrixWorld(true);
  const after = new THREE.Box3().setFromObject(parked);
  assert.ok(Math.abs(after.min.y - before.min.y + 14) < 1e-6);
  assert.equal(installSportsCars(source, root), false);
  assert.equal(disposed, fallbackMeshes);
});

test('missing nodes, materials, textures, geometry or parking records retain the complete fallback', (t) => {
  t.after(canvasDocument());
  const root = new THREE.Group();
  buildGarage(root, []);
  const parked = root.getObjectByName('parked-cars')!;
  const fallback = parked.getObjectByName('parked-car-fallback');
  const { source, materials } = sourceKit();
  const coupe = source.getObjectByName('SportsCoupe')!;
  source.remove(coupe);
  assert.equal(installSportsCars(source, root), false);
  source.add(coupe);
  const mesh = coupe.children[0] as THREE.Mesh;
  const original = mesh.material;
  mesh.material = new THREE.MeshBasicMaterial();
  assert.equal(installSportsCars(source, root), false);
  mesh.material = original;
  const carbon = materials[3].map;
  materials[3].map = null;
  assert.equal(installSportsCars(source, root), false);
  materials[3].map = carbon;
  const geometry = mesh.geometry;
  mesh.geometry = new THREE.BufferGeometry();
  assert.equal(installSportsCars(source, root), false);
  mesh.geometry = geometry;
  const name = materials[0].name;
  materials[0].name = 'UnknownPaint';
  assert.equal(installSportsCars(source, root), false);
  materials[0].name = name;
  const sites = parked.children.filter((a) => a.userData.parkedCar?.kind === 'ferrari');
  parked.remove(...sites);
  assert.equal(installSportsCars(source, root), false);
  assert.equal(parked.getObjectByName('parked-car-fallback'), fallback);
  assert.equal(parked.getObjectByName('sports-car-models'), undefined);
  assert.equal(installSportsCars(source, new THREE.Group()), false);
});

test('actual paired GLB stays in the shared car envelope with +Z headlights, -Z tails and packed finishes', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'));
  const asset = manifest['sports-cars'];
  assert.ok(asset.triangles <= 8000);
  assert.equal(asset.materials, 8);
  assert.deepEqual([asset.width, asset.height, asset.depth], [CAR.width, CAR.roof, CAR.length]);
  const buffer = readFileSync(new URL('../src/client/public/props/sports-cars.glb', import.meta.url));
  assert.equal(buffer.length, asset.bytes);
  const length = buffer.readUInt32LE(12);
  const glb = JSON.parse(buffer.subarray(20, 20 + length).toString());
  const binary = buffer.subarray(28 + length);
  for (const name of ['SportsWedge', 'SportsCoupe']) {
    const node = glb.nodes.find((n: { name: string }) => n.name === name);
    assert.ok(node);
    const mesh = glb.meshes[node.mesh];
    assert.equal(mesh.primitives.length, 8);
    for (const primitive of mesh.primitives) {
      assert.equal(primitive.extensions?.KHR_draco_mesh_compression, undefined);
      const material = glb.materials[primitive.material];
      assert.ok(NAMES.includes(material.name));
      const accessor = glb.accessors[primitive.attributes.POSITION];
      const view = glb.bufferViews[accessor.bufferView];
      assert.equal(accessor.componentType, 5126);
      const positions: number[] = [];
      for (let i = 0; i < accessor.count; i++) {
        const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + i * (view.byteStride ?? 12);
        const [x, y, z] = [0, 4, 8].map((offset) => binary.readFloatLE(start + offset));
        positions.push(x, y, z);
        assert.ok(Math.abs(x) <= CAR.width / 2 + 1e-5);
        assert.ok(y >= -1e-5 && y <= CAR.roof + 1e-5);
        assert.ok(Math.abs(z) <= CAR.length / 2 + 1e-5);
        if (material.name === 'CarHeadlight') assert.ok(z > 1.7);
        if (material.name === 'CarTaillight') assert.ok(z < -2.2);
      }
      if (material.name === 'CarPaint') {
        const indices = glb.accessors[primitive.indices];
        const indexView = glb.bufferViews[indices.bufferView];
        const width = indices.componentType === 5123 ? 2 : 4;
        const elements = Array.from({ length: indices.count }, (_, i) => {
          const offset = (indexView.byteOffset ?? 0) + (indices.byteOffset ?? 0) + i * width;
          return width === 2 ? binary.readUInt16LE(offset) : binary.readUInt32LE(offset);
        });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setIndex(elements);
        const body = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
        for (const x of [-0.55, 0.55]) {
          const hit = new THREE.Raycaster(new THREE.Vector3(x, 2, 1.4), new THREE.Vector3(0, -1, 0)).intersectObject(body)[0];
          assert.ok(hit && hit.point.y > 0.65, `${name}: the wheel opening must not cut through the hood at x=${x}`);
        }
      }
    }
  }
  assert.equal(glb.images.length, 2);
  const sizes = glb.images.map((image: { bufferView: number; uri?: string; mimeType: string }) => {
    assert.equal(image.uri, undefined);
    assert.equal(image.mimeType, 'image/png');
    const view = glb.bufferViews[image.bufferView];
    const png = binary.subarray(view.byteOffset, view.byteOffset + view.byteLength);
    assert.equal(png.toString('ascii', 1, 4), 'PNG');
    assert.equal(png.readUInt32BE(16), png.readUInt32BE(20));
    return png.readUInt32BE(16);
  });
  assert.deepEqual(
    sizes.sort((a: number, b: number) => a - b),
    [256, 512],
  );
});
