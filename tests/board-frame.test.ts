import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { installBoardFrames } from '../src/client/world/board-frame.js';
import { surfaceFinish } from '../src/client/world/surface.js';
import { ANISOTROPY } from '../src/client/world/texture-quality.js';
import { materialFeatures } from '../src/client/shader-warmup.js';

test('board frames share textured geometry without touching live faces or interactions', () => {
  const source = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(), [
    new THREE.MeshStandardMaterial({ name: 'BoardPaint', map: new THREE.Texture(), normalMap: new THREE.Texture() }),
    new THREE.MeshStandardMaterial({ name: 'BoardSteel', metalness: 0.8 }),
    new THREE.MeshStandardMaterial({ name: 'BoardRubber' }),
    new THREE.MeshStandardMaterial({ name: 'BoardSignal', color: '#ee6018' }),
  ]);
  body.name = 'board-frame';
  body.material[0].normalScale.set(0.6, 0.8);
  source.add(body);
  const office = new THREE.Group();
  const faces: THREE.Mesh[] = [];
  const mounts = [0, 1, 2].map((i) => {
    const board = new THREE.Group();
    board.position.set(i * 7.8, 2.1, -12.84);
    board.userData.interact = { kind: 'issues' };
    const mount = new THREE.Group();
    mount.name = 'board-frame-mount';
    mount.add(new THREE.Object3D());
    const face = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), new THREE.MeshBasicMaterial({ map: new THREE.Texture() }));
    face.position.z = 0.07;
    faces.push(face);
    board.add(mount, face);
    office.add(board);
    return mount;
  });
  const parents = office.children.map((board) => ({ children: [...board.children], position: board.position.clone(), interact: board.userData.interact }));
  assert.equal(installBoardFrames(source, office), 3);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(office.children[i].children, parents[i].children);
    assert.deepEqual(office.children[i].position, parents[i].position);
    assert.equal(office.children[i].userData.interact, parents[i].interact);
    assert.equal(faces[i].position.z, 0.07);
    assert.ok(faces[i].material instanceof THREE.MeshBasicMaterial);
    assert.ok(faces[i].material.map);
  }
  const first = mounts[0].children[0] as THREE.Mesh;
  const second = mounts[1].children[0] as THREE.Mesh;
  assert.equal(first.geometry, body.geometry);
  assert.equal(second.geometry, body.geometry);
  const mats = first.material as THREE.MeshToonMaterial[];
  assert.ok(mats.every((m) => m.isMeshToonMaterial));
  assert.equal(mats[0], (second.material as THREE.MeshToonMaterial[])[0]);
  assert.equal(mats[0].map, body.material[0].map);
  assert.equal(mats[0].normalMap, body.material[0].normalMap);
  assert.deepEqual(mats[0].normalScale.toArray(), [0.6, 0.8]);
  assert.equal(mats[0].map?.anisotropy, ANISOTROPY);
  assert.equal(mats[0].normalMap?.anisotropy, ANISOTROPY);
  assert.deepEqual(surfaceFinish(mats[0]), [0.04, 0.72]);
  assert.deepEqual(surfaceFinish(mats[1]), [0.55, 0.3]);
  assert.equal(surfaceFinish(mats[2]), null);
  assert.equal(surfaceFinish(mats[3]), null);
  assert.ok(materialFeatures(first).includes('MeshToonMaterial|map|normal|gradient|surface'));
  assert.ok(body.material.every((m) => m.isMeshStandardMaterial));
});

test('missing frame model or mounts retain the fallback; single-material models work', () => {
  const office = new THREE.Group();
  const mount = new THREE.Group();
  mount.name = 'board-frame-mount';
  const fallback = new THREE.Object3D();
  mount.add(fallback);
  office.add(mount);
  assert.equal(installBoardFrames(new THREE.Group(), office), 0);
  assert.equal(mount.children[0], fallback);
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  source.name = 'board-frame';
  assert.equal(installBoardFrames(source, new THREE.Group()), 0);
  assert.equal(installBoardFrames(source, office), 1);
  assert.ok((mount.children[0] as THREE.Mesh).material instanceof THREE.MeshToonMaterial);
});

test('exported frame has metre-scaled UVs, embedded finish maps and unchanged screen clearance', () => {
  const data = readFileSync(new URL('../src/client/public/props/board-frame.glb', import.meta.url));
  const json = JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)).toString('utf8'));
  const meta = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'))['board-frame'];
  assert.deepEqual([meta.width, meta.height, meta.depth], [6.3, 3.3, 0.116]);
  assert.ok(meta.triangles <= 8000);
  assert.equal(meta.bytes, data.byteLength);
  assert.equal(meta.materials, 4);
  assert.equal(json.nodes[0].name, 'board-frame');
  assert.equal(json.images.length, 4);
  assert.ok(json.images.every((image: { bufferView?: number; mimeType: string }) => image.bufferView !== undefined && image.mimeType === 'image/png'));
  for (const material of json.materials.filter((m: { name: string }) => ['BoardPaint', 'BoardSteel'].includes(m.name))) {
    assert.ok(material.pbrMetallicRoughness.baseColorTexture);
    assert.ok(material.normalTexture);
  }
  let triangles = 0;
  for (const primitive of json.meshes[0].primitives) {
    const position = json.accessors[primitive.attributes.POSITION];
    assert.ok(position.min[2] >= -0.06001 && position.max[2] < 0.07, 'hardware never crosses the live canvas plane');
    assert.notEqual(primitive.attributes.TEXCOORD_0, undefined);
    triangles += json.accessors[primitive.indices].count / 3;
  }
  assert.equal(triangles, meta.triangles);
});
