import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const glb = readFileSync(new URL('../src/client/public/props/droid-computer.glb', import.meta.url));
const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
const manifest = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'))['droid-computer'];
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test('Droid Computer keeps its exact original envelope and two runtime-facing nodes', () => {
  assert.deepEqual([manifest.width, manifest.height, manifest.depth], [0.45, 0.472, 0.454]);
  assert.equal(glb.byteLength, manifest.bytes);
  assert.ok(manifest.triangles <= 8000);
  assert.equal(manifest.materials, 2);
  assert.deepEqual(json.nodes.map((n: { name: string }) => n.name).sort(), ['Shell', 'droid-computer']);
  const triangles = json.meshes.flatMap((m: { primitives: { indices: number }[] }) => m.primitives).reduce((sum: number, p: { indices: number }) => sum + json.accessors[p.indices].count / 3, 0);
  assert.equal(triangles, manifest.triangles);
  for (const n of json.nodes) {
    assert.equal(n.translation, undefined, 'the existing rack adds the only placement offset');
    assert.equal(n.rotation, undefined);
  }
});

test('the separate Shell retains brushed-finish UVs, material and original cube bounds', () => {
  const node = json.nodes.find((n: { name: string }) => n.name === 'Shell');
  const primitives = json.meshes[node.mesh].primitives;
  assert.equal(primitives.length, 1, 'the runtime replaces Shell.material as one mesh');
  const part = primitives[0];
  const material = json.materials[part.material];
  assert.equal(material.name, 'DroidShell');
  near(material.pbrMetallicRoughness.metallicFactor, 0.75);
  near(material.pbrMetallicRoughness.roughnessFactor, 0.36);
  const bounds = json.accessors[part.attributes.POSITION];
  [-0.225, 0.022, -0.225].forEach((v, i) => near(bounds.min[i], v));
  [0.225, 0.472, 0.225].forEach((v, i) => near(bounds.max[i], v));
  assert.ok(part.attributes.TEXCOORD_0 !== undefined);
  assert.equal(json.accessors[part.attributes.TEXCOORD_0].count, bounds.count);
});

test('palette hardware retains embedded atlas maps, floor contact and LED-plane clearance', () => {
  const node = json.nodes.find((n: { name: string }) => n.name === 'droid-computer');
  const part = json.meshes[node.mesh].primitives[0];
  assert.equal(json.materials[part.material].name, 'Factory');
  assert.equal(json.meshes[node.mesh].primitives.length, 1);
  assert.equal(json.images.length, 3);
  assert.ok(json.images.every((i: { mimeType: string; bufferView: number }) => i.mimeType === 'image/png' && i.bufferView !== undefined));
  const bounds = json.accessors[part.attributes.POSITION];
  near(bounds.min[1], 0);
  assert.ok(bounds.max[1] < 0.405);
  assert.ok(bounds.max[2] > 0.228 && bounds.max[2] < 0.2294, 'all hardware stays behind the original live LED at z=0.2295');
  assert.equal(json.accessors[part.attributes.TEXCOORD_0].count, bounds.count);
  const pbr = json.materials[part.material].pbrMetallicRoughness;
  assert.ok(pbr.baseColorTexture && pbr.metallicRoughnessTexture);
});
