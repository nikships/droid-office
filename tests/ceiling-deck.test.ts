import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { installCeilingDeck } from '../src/client/world/ceiling-deck.js';
import { buildStack, type Stack } from '../src/client/world/stack.js';
import { materialFeatures } from '../src/client/shader-warmup.js';
import { ANISOTROPY } from '../src/client/world/texture-quality.js';
import type { Collider } from '../src/client/world/office.js';
import { LADDER, POLES, WALL_HEIGHT } from '../src/shared/layout.js';

function sourceKit() {
  const source = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ name: 'CeilingDeck', map: new THREE.Texture(), normalMap: new THREE.Texture(), aoMap: new THREE.Texture() });
  steel.map!.colorSpace = THREE.SRGBColorSpace;
  for (const texture of [steel.map!, steel.normalMap!, steel.aoMap!]) texture.flipY = false;
  source.add(new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2).rotateX(Math.PI / 2), steel));
  return { source, steel };
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

function ceiling(stack: Stack) {
  const result = stack.group.children.find((object) => object instanceof THREE.Mesh && object.position.y === WALL_HEIGHT && object.material instanceof THREE.MeshToonMaterial && object.material.emissiveMap);
  assert.ok(result instanceof THREE.Mesh);
  assert.ok(result.material instanceof THREE.MeshToonMaterial);
  return result as THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial>;
}

test('baked ceiling retains its material, geometry, picking, hatches and colliders across floors', (t) => {
  t.after(canvasDocument());
  const colliders: Collider[] = [];
  const stack = buildStack(colliders, new THREE.MeshToonMaterial());
  stack.set({ index: 1, count: 4, up: 'gemdex', down: 'Home' });
  const before = ceiling(stack);
  const geometry = before.geometry;
  const material = before.material;
  const originalColliders = structuredClone(colliders);
  const interactables = [...stack.interactables];
  const children = [...stack.group.children];
  let disposed = 0;
  material.map!.addEventListener('dispose', () => disposed++);
  const { source, steel } = sourceKit();
  const emission = material.emissive.clone();
  assert.equal(stack.setCeilingModel(source), true);
  assert.equal(ceiling(stack), before);
  assert.equal(before.geometry, geometry);
  assert.equal(before.material, material);
  assert.deepEqual(stack.group.children, children);
  assert.deepEqual(colliders, originalColliders);
  assert.deepEqual(stack.interactables, interactables);
  assert.equal(disposed, 1);
  assert.ok(material.emissive.equals(emission));
  assert.equal(material.emissiveMap, material.map);
  assert.deepEqual(material.userData.outlineParameters, { visible: false });
  assert.equal(material.aoMapIntensity, 0.85);
  for (const [actual, original] of [
    [material.map, steel.map],
    [material.normalMap, steel.normalMap],
    [material.aoMap, steel.aoMap],
  ]) {
    assert.ok(actual && original);
    assert.notEqual(actual, original);
    assert.equal(actual.source, original.source);
    assert.deepEqual(actual.repeat.toArray(), [1 / 1.2, -1 / 1.2]);
    assert.deepEqual(actual.offset.toArray(), [0.5, 0.5]);
    assert.deepEqual(original.repeat.toArray(), [1, 1]);
    assert.equal(actual.wrapS, THREE.RepeatWrapping);
    assert.equal(actual.wrapT, THREE.RepeatWrapping);
    assert.equal(actual.flipY, false);
    assert.equal(actual.colorSpace, original.colorSpace);
    assert.equal(actual.anisotropy, ANISOTROPY);
  }
  assert.ok(materialFeatures(stack.group).includes('MeshToonMaterial|map|normal|ao|gradient|surface'));
  const installed = [material.map, material.normalMap, material.aoMap];
  for (const index of [0, 2, 3, 1]) {
    stack.set({ index, count: 4 });
    const mesh = ceiling(stack);
    assert.equal(mesh.material, material);
    assert.deepEqual([material.map, material.normalMap, material.aoMap], installed);
    stack.group.updateMatrixWorld(true);
    const hits = (x: number, z: number) => new THREE.Raycaster(new THREE.Vector3(x, WALL_HEIGHT - 0.5, z), new THREE.Vector3(0, 1, 0)).intersectObject(mesh);
    assert.ok(hits(0, 0).length > 0);
    assert.ok(hits(0, 0)[0].face!.normal.y < -0.999);
    const uv = hits(2, 3)[0].uv!;
    assert.ok(Math.abs(uv.x - 2) < 1e-5 && Math.abs(uv.y - 3) < 1e-5);
    assert.equal(hits((LADDER.hatch.minX + LADDER.hatch.maxX) / 2, (LADDER.hatch.minZ + LADDER.hatch.maxZ) / 2).length > 0, index === 3);
    for (const p of POLES) assert.equal(hits(p.x, p.z).length > 0, index === 3);
  }
  const events: string[] = [];
  stack.onHatch = (where, open) => events.push(`${where}:${open}`);
  stack.update(0.3, [{ x: LADDER.x, y: 5, z: LADDER.z, grip: 'ladder' }], new THREE.Vector3(-16, 6.6, 0));
  stack.update(1, [], new THREE.Vector3(-16, 1.6, 0));
  assert.deepEqual(events, ['ceiling:true', 'ceiling:false']);
});

test('missing or incomplete baked maps leave the procedural ceiling untouched', () => {
  const target = new THREE.MeshToonMaterial({ map: new THREE.Texture() });
  const original = target.map;
  assert.equal(installCeilingDeck(new THREE.Group(), target), false);
  const { source, steel } = sourceKit();
  const normal = steel.normalMap;
  steel.normalMap = null;
  assert.equal(installCeilingDeck(source, target), false);
  steel.normalMap = normal;
  steel.aoMap = null;
  assert.equal(installCeilingDeck(source, target), false);
  steel.aoMap = new THREE.Texture();
  steel.map = null;
  assert.equal(installCeilingDeck(source, target), false);
  assert.equal(target.map, original);
  assert.equal(target.normalMap, null);
  assert.equal(target.aoMap, null);
});

test('material donor exports downward normals, a metre-scaled tile and three embedded 1024px PNG bakes', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'));
  const asset = manifest['ceiling-deck'];
  assert.equal(asset.triangles, 2);
  assert.equal(asset.materials, 1);
  assert.deepEqual([asset.width, asset.height, asset.depth], [1.2, 0, 1.2]);
  const buffer = readFileSync(new URL('../src/client/public/props/ceiling-deck.glb', import.meta.url));
  assert.equal(buffer.length, asset.bytes);
  const jsonLength = buffer.readUInt32LE(12);
  const glb = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString());
  const binary = buffer.subarray(28 + jsonLength);
  const primitive = glb.meshes[0].primitives[0];
  assert.equal(primitive.extensions?.KHR_draco_mesh_compression, undefined);
  const normals = glb.accessors[primitive.attributes.NORMAL];
  const normalView = glb.bufferViews[normals.bufferView];
  assert.equal(normals.componentType, 5126);
  const readAttribute = (name: string, index: number, width: number) => {
    const accessor = glb.accessors[primitive.attributes[name]];
    const view = glb.bufferViews[accessor.bufferView];
    assert.equal(accessor.componentType, 5126);
    const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + index * (view.byteStride ?? width * 4);
    return Array.from({ length: width }, (_, i) => binary.readFloatLE(start + i * 4));
  };
  for (let i = 0; i < normals.count; i++) {
    const offset = (normalView.byteOffset ?? 0) + (normals.byteOffset ?? 0) + i * (normalView.byteStride ?? 12);
    assert.ok(Math.abs(binary.readFloatLE(offset)) < 1e-5);
    assert.ok(binary.readFloatLE(offset + 4) < -0.999);
    assert.ok(Math.abs(binary.readFloatLE(offset + 8)) < 1e-5);
    const [x, , z] = readAttribute('POSITION', i, 3);
    const [u, v] = readAttribute('TEXCOORD_0', i, 2);
    assert.ok(Math.abs(u - (0.5 + x / 1.2)) < 1e-5);
    assert.ok(Math.abs(v - (0.5 - z / 1.2)) < 1e-5);
  }
  const material = glb.materials[0];
  assert.equal(material.name, 'CeilingDeck');
  assert.ok(material.pbrMetallicRoughness.baseColorTexture);
  assert.ok(material.normalTexture);
  assert.ok(material.occlusionTexture);
  assert.equal(glb.images.length, 3);
  for (const image of glb.images) {
    assert.equal(image.uri, undefined);
    assert.equal(image.mimeType, 'image/png');
    const view = glb.bufferViews[image.bufferView];
    const png = binary.subarray(view.byteOffset, view.byteOffset + view.byteLength);
    assert.equal(png.toString('ascii', 1, 4), 'PNG');
    assert.equal(png.readUInt32BE(16), 1024);
    assert.equal(png.readUInt32BE(20), 1024);
  }
});
