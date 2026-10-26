import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeWorkerPaint, type WorkerPart } from '../src/client/world/worker-parts.js';
import { toon } from '../src/client/world/toon.js';

function part(color: string, x = 0): WorkerPart {
  return { geo: new THREE.BoxGeometry(1, 1, 1).translate(x, 0, 0), mat: toon(color) };
}

function expanded(geo: THREE.BufferGeometry, name: string): number[] {
  const attr = geo.getAttribute(name);
  const index = geo.index;
  const data: number[] = [];
  for (let i = 0; i < (index?.count ?? attr.count); i++) {
    const n = index ? index.getX(i) : i;
    for (let j = 0; j < attr.itemSize; j++) data.push(attr.getComponent(n, j));
  }
  return data;
}

test('fixed-joint paint retains every triangle, normal, UV and source order with linear per-vertex colors', () => {
  const a = part('#161618');
  const b = part('#52545c', 2);
  const result = mergeWorkerPaint([a, b]);
  assert.equal(result.length, 1);
  const merged = result[0];
  for (const attr of ['position', 'normal', 'uv']) assert.deepEqual(expanded(merged.geo, attr), [...expanded(a.geo, attr), ...expanded(b.geo, attr)]);
  const colors = expanded(merged.geo, 'color');
  const expected: number[] = [];
  for (const p of [a, b]) {
    const c = (p.mat as THREE.MeshToonMaterial).color;
    for (let i = 0; i < p.geo.index!.count; i++) expected.push(...new Float32Array([c.r, c.g, c.b]));
  }
  assert.deepEqual(colors, expected);
  assert.equal(merged.mat === 'skin' ? false : merged.mat.vertexColors, true);
  assert.equal((merged.mat as THREE.MeshToonMaterial).color.getHex(), 0xffffff);
  assert.equal(a.geo.hasAttribute('color'), false, 'source buffers are not changed');
  assert.equal(b.geo.hasAttribute('color'), false);
});

test('skin, emissive optics and outline boundaries stay separate and in their original order', () => {
  const a = part('#161618');
  const skin: WorkerPart = { geo: a.geo.clone(), mat: 'skin' };
  const led: WorkerPart = { geo: a.geo.clone(), mat: toon('#ee6018', { emissive: '#ee6018' }) };
  const visor = part('#070709');
  (visor.mat as THREE.MeshToonMaterial).userData.outlineParameters = { visible: false };
  const pieces = [a, skin, a, led, a, visor];
  assert.deepEqual(mergeWorkerPaint(pieces), pieces);
});

test('unsupported paint keeps its original geometry and material', () => {
  for (const change of [
    (m: THREE.MeshToonMaterial) => (m.transparent = true),
    (m: THREE.MeshToonMaterial) => (m.opacity = 0.5),
    (m: THREE.MeshToonMaterial) => (m.vertexColors = true),
    (m: THREE.MeshToonMaterial) => (m.map = new THREE.Texture()),
    (m: THREE.MeshToonMaterial) => (m.alphaMap = new THREE.Texture()),
    (m: THREE.MeshToonMaterial) => (m.emissiveMap = new THREE.Texture()),
    (m: THREE.MeshToonMaterial) => (m.userData.remasterFinish = 'metal'),
  ]) {
    const a = part('#161618');
    a.mat = (a.mat as THREE.MeshToonMaterial).clone();
    change(a.mat);
    const b = part('#52545c');
    assert.deepEqual(mergeWorkerPaint([a, b]), [a, b]);
  }
});

test('gradient and face-side boundaries are not merged', () => {
  for (const field of ['gradientMap', 'side'] as const) {
    const a = part('#161618');
    const b = part('#52545c');
    b.mat = (b.mat as THREE.MeshToonMaterial).clone();
    if (field === 'gradientMap') b.mat.gradientMap = new THREE.Texture();
    else b.mat.side = THREE.DoubleSide;
    assert.deepEqual(mergeWorkerPaint([a, b]), [a, b]);
  }
});

test('matching outline parameters survive on the merged paint and empty input stays empty', () => {
  const a = part('#161618');
  const b = part('#52545c');
  for (const p of [a, b]) {
    p.mat = (p.mat as THREE.MeshToonMaterial).clone();
    p.mat.userData.outlineParameters = { visible: false };
  }
  const result = mergeWorkerPaint([a, b]);
  assert.equal(result.length, 1);
  assert.deepEqual((result[0].mat as THREE.MeshToonMaterial).userData.outlineParameters, { visible: false });
  assert.deepEqual(mergeWorkerPaint([]), []);
});

test('a matching custom toon gradient survives paint merging', () => {
  const parts = [part('#161618'), part('#52545c')];
  const gradient = new THREE.Texture();
  for (const p of parts) {
    p.mat = (p.mat as THREE.MeshToonMaterial).clone();
    p.mat.gradientMap = gradient;
  }
  const result = mergeWorkerPaint(parts);
  assert.equal(result.length, 1);
  assert.equal((result[0].mat as THREE.MeshToonMaterial).gradientMap, gradient);
});

test('incompatible attributes retain the original parts rather than losing triangles', (t) => {
  const a = part('#161618');
  const b = part('#52545c');
  b.geo.deleteAttribute('uv');
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
  assert.deepEqual(mergeWorkerPaint([a, b]), [a, b]);
  assert.equal(errors.length, 1);
});

test('real droid GLB joints retain their complete ordered triangle attributes and effective paint', async () => {
  const bytes = readFileSync(new URL('../src/client/public/props/droid-worker.glb', import.meta.url));
  const { scene } = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const joints = new Map<string, WorkerPart[]>();
  scene.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const original = node.material as THREE.MeshStandardMaterial;
    const key = node.parent?.name || node.name;
    const list = joints.get(key) ?? [];
    list.push({ geo: node.geometry, mat: original.name === 'DroidSkin' ? 'skin' : toon(original.color, { emissive: original.emissive }) });
    joints.set(key, list);
  });
  let saved = 0;
  const effective = (parts: WorkerPart[]) =>
    parts.flatMap((p) => {
      const count = p.geo.index?.count ?? p.geo.getAttribute('position').count;
      if (p.mat === 'skin') return Array(count * 3).fill(-1);
      const color = p.mat.color;
      return p.mat.vertexColors ? expanded(p.geo, 'color') : Array.from({ length: count }, () => [Math.fround(color.r), Math.fround(color.g), Math.fround(color.b)]).flat();
    });
  for (const parts of joints.values()) {
    const merged = mergeWorkerPaint(parts);
    saved += parts.length - merged.length;
    for (const name of ['position', 'normal', 'uv']) {
      if (parts.every((p) => p.geo.hasAttribute(name)))
        assert.deepEqual(
          merged.flatMap((p) => expanded(p.geo, name)),
          parts.flatMap((p) => expanded(p.geo, name)),
        );
    }
    assert.deepEqual(effective(merged), effective(parts));
  }
  assert.ok(saved > 0, 'the actual GLB has compatible consecutive paint parts');
});
