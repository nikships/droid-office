import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const data = readFileSync(new URL('../src/client/public/props/conveyor.glb', import.meta.url));
const json = JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)).toString('utf8'));
const meta = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8')).conveyor;

test('conveyor keeps its original asymmetric envelope and single-node contract', () => {
  assert.deepEqual([meta.width, meta.height, meta.depth], [2.61, 0.91, 0.736]);
  assert.equal(data.byteLength, meta.bytes);
  assert.ok(meta.triangles <= 8000);
  assert.equal(meta.materials, 1);
  assert.deepEqual(json.nodes, [{ mesh: 0, name: 'conveyor' }]);
  assert.equal(json.meshes[0].primitives.length, 1);
  const part = json.meshes[0].primitives[0];
  const bounds = json.accessors[part.attributes.POSITION];
  [-1.3, 0, -0.486].forEach((v, i) => assert.ok(Math.abs(bounds.min[i] - v) < 1e-5));
  [1.31, 0.91, 0.25].forEach((v, i) => assert.ok(Math.abs(bounds.max[i] - v) < 1e-5));
  assert.equal(json.accessors[part.indices].count / 3, meta.triangles);
});

test('conveyor retains its Factory palette UVs and three embedded maps', () => {
  const part = json.meshes[0].primitives[0];
  assert.equal(json.materials[part.material].name, 'Factory');
  assert.equal(json.accessors[part.attributes.TEXCOORD_0].count, json.accessors[part.attributes.POSITION].count);
  assert.equal(json.images.length, 3);
  assert.ok(json.images.every((i: { mimeType: string; bufferView: number }) => i.mimeType === 'image/png' && i.bufferView !== undefined));
  const pbr = json.materials[part.material].pbrMetallicRoughness;
  assert.ok(pbr.baseColorTexture && pbr.metallicRoughnessTexture);
});
