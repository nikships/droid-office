import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const data = readFileSync(new URL('../src/client/public/props/pr-crate.glb', import.meta.url));
const json = JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)).toString('utf8'));
const meta = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'))['pr-crate'];
const part = (name: string) => {
  const node = json.nodes.find((n: { name: string }) => n.name === name);
  assert.ok(node);
  assert.equal(json.meshes[node.mesh].primitives.length, 1, 'runtime-facing parts stay individual meshes');
  return json.meshes[node.mesh].primitives[0];
};
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test('shipping crate keeps original envelope, origin and two runtime-facing nodes', () => {
  assert.deepEqual([meta.width, meta.height, meta.depth], [0.26, 0.2, 0.26]);
  assert.equal(data.byteLength, meta.bytes);
  assert.ok(meta.triangles <= 8000);
  assert.equal(meta.materials, 1);
  assert.deepEqual(json.nodes, [
    { mesh: 0, name: 'pr-crate' },
    { mesh: 1, name: 'Status' },
  ]);
  const bounds = json.accessors[part('pr-crate').attributes.POSITION];
  [-0.13, 0, -0.13].forEach((v, i) => near(bounds.min[i], v));
  [0.13, 0.2, 0.13].forEach((v, i) => near(bounds.max[i], v));
});

test('both original status bars retain exact positions, size and a direct replaceable mesh', () => {
  const bounds = json.accessors[part('Status').attributes.POSITION];
  [-0.04, 0.152, -0.123].forEach((v, i) => near(bounds.min[i], v));
  [0.04, 0.164, 0.123].forEach((v, i) => near(bounds.max[i], v));
});

test('crate body and status retain the shared Factory palette and embedded UV maps', () => {
  assert.equal(json.images.length, 3);
  assert.ok(json.images.every((i: { mimeType: string; bufferView: number }) => i.mimeType === 'image/png' && i.bufferView !== undefined));
  for (const name of ['pr-crate', 'Status']) {
    const p = part(name);
    assert.equal(json.materials[p.material].name, 'Factory');
    assert.equal(json.accessors[p.attributes.TEXCOORD_0].count, json.accessors[p.attributes.POSITION].count);
  }
  const triangles = json.accessors[part('pr-crate').indices].count / 3 + json.accessors[part('Status').indices].count / 3;
  assert.equal(triangles, meta.triangles);
});
