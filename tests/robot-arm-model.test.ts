import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const data = readFileSync(new URL('../src/client/public/props/robot-arm.glb', import.meta.url));
const json = JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)).toString('utf8'));
const meta = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'))['robot-arm'];
const bounds: Record<string, [number[], number[]]> = {
  Forearm: [
    [-0.07, -0.07, -0.145],
    [0.07, 0.61, 0.075],
  ],
  'robot-arm': [
    [-0.31, 0, -0.31],
    [0.31, 0.44, 0.31],
  ],
  Tool: [
    [-0.08, 0, -0.08],
    [0.08, 0.1125, 0.08],
  ],
  Turret: [
    [-0.186, 0, -0.186],
    [0.186, 0.362, 0.186],
  ],
  UpperArm: [
    [-0.097, -0.088, -0.12095528096],
    [0.097, 0.698, 0.088],
  ],
  Wrist: [
    [-0.046, 0, -0.046],
    [0.046, 0.12, 0.046],
  ],
};
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test('robot arm retains six direct, origin-authored meshes for the original joint chain', () => {
  assert.deepEqual(
    json.nodes.map((n: { name: string }) => n.name),
    Object.keys(bounds),
  );
  json.nodes.forEach((n: { mesh: number; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }) => {
    assert.equal(n.matrix, undefined);
    assert.equal(n.translation, undefined);
    assert.equal(n.rotation, undefined);
    assert.equal(n.scale, undefined);
    assert.equal(json.meshes[n.mesh].primitives.length, 1);
  });
});

test('every moving part keeps its exact original joint-local envelope and tool reach', () => {
  json.nodes.forEach((n: { name: string; mesh: number }) => {
    const p = json.meshes[n.mesh].primitives[0];
    const a = json.accessors[p.attributes.POSITION];
    bounds[n.name][0].forEach((v, i) => near(a.min[i], v));
    bounds[n.name][1].forEach((v, i) => near(a.max[i], v));
  });
});

test('arm stays below budget with a single Factory material and all original embedded UV maps', () => {
  assert.deepEqual([meta.width, meta.height, meta.depth], [0.62, 0.786, 0.62]);
  assert.ok(meta.triangles <= 8000);
  assert.equal(meta.bytes, data.byteLength);
  assert.equal(meta.materials, 1);
  assert.equal(json.images.length, 3);
  assert.ok(json.images.every((i: { mimeType: string; bufferView: number }) => i.mimeType === 'image/png' && i.bufferView !== undefined));
  let triangles = 0;
  json.nodes.forEach((n: { mesh: number }) => {
    const p = json.meshes[n.mesh].primitives[0];
    assert.equal(json.materials[p.material].name, 'Factory');
    assert.equal(json.accessors[p.attributes.TEXCOORD_0].count, json.accessors[p.attributes.POSITION].count);
    triangles += json.accessors[p.indices].count / 3;
  });
  assert.equal(triangles, meta.triangles);
});
