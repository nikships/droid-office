import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildCity } from '../src/client/world/city.js';
import { installCityFacades } from '../src/client/world/city-facades.js';
import { materialFeatures } from '../src/client/shader-warmup.js';
import { ANISOTROPY } from '../src/client/world/texture-quality.js';

function sourceKit() {
  const materials = Array.from({ length: 10 }, (_, i) => {
    const map = new THREE.Texture();
    map.colorSpace = THREE.SRGBColorSpace;
    const normalMap = new THREE.Texture();
    const emissiveMap = new THREE.Texture({ width: 512, height: 512 });
    for (const texture of [map, normalMap, emissiveMap]) texture.flipY = false;
    return new THREE.MeshStandardMaterial({ name: `CityFacade${i}`, map, normalMap, emissiveMap });
  });
  const source = new THREE.Group();
  source.add(new THREE.Mesh(new THREE.PlaneGeometry(), materials));
  return { source, materials };
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

test('facade material replacement preserves geometry and live window atlases, with aligned normal UVs', () => {
  const draws: unknown[][] = [];
  const transforms: unknown[][] = [];
  const operations: string[] = [];
  const context = {
    globalCompositeOperation: 'source-over',
    save() {
      operations.push('save');
    },
    restore() {
      operations.push('restore');
    },
    setTransform(...args: unknown[]) {
      transforms.push(args);
    },
    drawImage(...args: unknown[]) {
      assert.equal(this.globalCompositeOperation, 'multiply');
      draws.push(args);
    },
  };
  const canvas = { width: 256, height: 1280, getContext: () => context } as unknown as HTMLCanvasElement;
  const windows = new THREE.CanvasTexture(canvas);
  const originalMap = new THREE.Texture();
  let disposed = 0;
  originalMap.addEventListener('dispose', () => disposed++);
  const target = new THREE.MeshToonMaterial({ map: originalMap, emissiveMap: windows, emissive: '#e9d3ac', emissiveIntensity: 0.72 });
  target.userData.facade = { style: 9, columns: 4, rows: 5, lightsAcross: 4, lightsDown: 5, tint: '#242424' };
  target.userData.outlineParameters = { visible: false };
  const unrelated = new THREE.MeshToonMaterial();
  const geometry = new THREE.BoxGeometry(12, 16, 10);
  const mesh = new THREE.Mesh(geometry, [target, unrelated, target]);
  const root = new THREE.Group();
  root.add(mesh);
  const { source, materials } = sourceKit();
  assert.equal(installCityFacades(source, root, root), 1);
  assert.equal(mesh.geometry, geometry);
  assert.deepEqual(mesh.material, [target, unrelated, target]);
  assert.equal(root.children.length, 1);
  assert.equal(target.emissiveMap, windows);
  assert.equal(target.emissiveIntensity, 0.72);
  assert.equal(target.emissive.getHexString(), 'e9d3ac');
  assert.equal(disposed, 1);
  assert.deepEqual(target.userData.outlineParameters, { visible: false });
  assert.equal(draws.length, 20);
  assert.deepEqual(draws[0], [materials[9].emissiveMap!.image, 0, 0, 64, 256]);
  assert.deepEqual(draws[19], [materials[9].emissiveMap!.image, 192, 1024, 64, 256]);
  assert.deepEqual(transforms, [[1, 0, 0, 1, 0, 0]]);
  assert.deepEqual(operations, ['save', 'restore']);
  for (const [actual, original] of [
    [target.map, materials[9].map],
    [target.normalMap, materials[9].normalMap],
  ]) {
    assert.ok(actual && original);
    assert.notEqual(actual, original);
    assert.equal(actual.source, original.source);
    assert.deepEqual(actual.repeat.toArray(), [4, -5]);
    assert.deepEqual(actual.offset.toArray(), [0, 1]);
    assert.deepEqual(original.repeat.toArray(), [1, 1]);
    assert.equal(actual.flipY, false);
    assert.equal(actual.wrapS, THREE.RepeatWrapping);
    assert.equal(actual.wrapT, THREE.RepeatWrapping);
    assert.equal(actual.anisotropy, ANISOTROPY);
  }
  const installed = [target.map, target.normalMap];
  assert.equal(installCityFacades(source, root), 0);
  assert.deepEqual([target.map, target.normalMap], installed);
  assert.equal(draws.length, 20);
  assert.equal(disposed, 1);
  assert.ok(materialFeatures(root).some((key) => key.includes('|normal')));
});

test('incomplete facade kits and unsupported targets keep their original fallback', () => {
  const { source, materials } = sourceKit();
  const original = new THREE.Texture();
  const target = new THREE.MeshToonMaterial({ map: original, emissiveMap: new THREE.Texture() });
  target.userData.facade = { style: 0 };
  const root = new THREE.Mesh(new THREE.BoxGeometry(), target);
  const normal = materials[9].normalMap;
  materials[9].normalMap = null;
  assert.equal(installCityFacades(source, root), 0);
  materials[9].normalMap = normal;
  assert.equal(installCityFacades(source, root), 0);
  target.emissiveMap = new THREE.CanvasTexture({ width: 32, height: 32, getContext: () => null } as unknown as HTMLCanvasElement);
  assert.equal(installCityFacades(source, root), 0);
  target.userData.facade.style = 99;
  assert.equal(installCityFacades(source, root), 0);
  assert.equal(target.map, original);
  assert.equal(target.normalMap, null);
});

test('city rebuilds reuse installed facade materials without changing geometry batches or traffic', (t) => {
  t.after(canvasDocument());
  const night = { bulbs: [], halos: [], lamps: [], street: 0, windows: [] as THREE.MeshToonMaterial[], clouds: new THREE.MeshToonMaterial() };
  const city = buildCity(night);
  city.setFloors(4);
  const walls = night.windows.filter((m) => m.userData.facade);
  assert.equal(walls.length, 9);
  const meshes: THREE.Mesh[] = [];
  city.group.traverse((o) => {
    if (o instanceof THREE.Mesh) meshes.push(o);
  });
  const traffic = meshes.filter((o): o is THREE.InstancedMesh => o instanceof THREE.InstancedMesh);
  const matrices = traffic.map((m) => Array.from(m.instanceMatrix.array));
  const geometries = meshes.map((m) => m.geometry);
  const { source } = sourceKit();
  assert.equal(installCityFacades(source, city.group), 9);
  assert.deepEqual(
    meshes.map((m) => m.geometry),
    geometries,
  );
  assert.deepEqual(
    traffic.map((m) => Array.from(m.instanceMatrix.array)),
    matrices,
  );
  const maps = walls.map((m) => [m.map, m.normalMap, m.emissiveMap]);
  for (const floors of [1, 6, 8, 4]) {
    city.setFloors(floors);
    assert.deepEqual(
      night.windows.filter((m) => m.userData.facade),
      walls,
    );
    assert.deepEqual(
      walls.map((m) => [m.map, m.normalMap, m.emissiveMap]),
      maps,
    );
  }
  city.update(0.5, 1, 1);
  assert.ok(traffic[0].instanceMatrix.array.some((v, i) => v !== matrices[0][i]));
  assert.deepEqual(Array.from(traffic[0].instanceMatrix.array), Array.from(traffic[1].instanceMatrix.array));
  assert.equal(installCityFacades(source, city.group), 0);
});

test('actual GLB packs ten color/normal/window-mask sets with concrete upright bay UVs', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'));
  const asset = manifest['city-facades'];
  assert.equal(asset.triangles, 20);
  assert.equal(asset.materials, 10);
  const buffer = readFileSync(new URL('../src/client/public/props/city-facades.glb', import.meta.url));
  assert.equal(buffer.length, asset.bytes);
  const length = buffer.readUInt32LE(12);
  const glb = JSON.parse(buffer.subarray(20, 20 + length).toString());
  const binary = buffer.subarray(28 + length);
  assert.equal(glb.materials.length, 10);
  assert.equal(glb.images.length, 30);
  for (const [i, material] of glb.materials.entries()) {
    assert.equal(material.name, `CityFacade${i}`);
    assert.ok(material.pbrMetallicRoughness.baseColorTexture);
    assert.ok(material.normalTexture);
    assert.ok(material.emissiveTexture);
  }
  for (const image of glb.images) {
    assert.equal(image.uri, undefined);
    assert.equal(image.mimeType, 'image/png');
    const view = glb.bufferViews[image.bufferView];
    const png = binary.subarray(view.byteOffset, view.byteOffset + view.byteLength);
    assert.equal(png.toString('ascii', 1, 4), 'PNG');
    assert.equal(png.readUInt32BE(16), 512);
    assert.equal(png.readUInt32BE(20), 512);
  }
  for (const [i, primitive] of glb.meshes[0].primitives.entries()) {
    const read = (name: string, index: number, width: number) => {
      const accessor = glb.accessors[primitive.attributes[name]];
      const view = glb.bufferViews[accessor.bufferView];
      assert.equal(accessor.componentType, 5126);
      const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + index * (view.byteStride ?? width * 4);
      return Array.from({ length: width }, (_, j) => binary.readFloatLE(start + j * 4));
    };
    const count = glb.accessors[primitive.attributes.POSITION].count;
    for (let j = 0; j < count; j++) {
      const [x, y, z] = read('POSITION', j, 3);
      const [u, v] = read('TEXCOORD_0', j, 2);
      assert.ok(Math.abs(z) < 1e-5);
      assert.ok(Math.abs(u - ((x - i * 3.2) / 2.8 + 0.5)) < 1e-5);
      assert.ok(Math.abs(v - (1 - y / 3.3)) < 1e-5);
      assert.ok(read('NORMAL', j, 3)[2] > 0.999);
    }
  }
});
