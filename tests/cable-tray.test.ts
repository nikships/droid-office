import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { installCableTrays } from '../src/client/world/cable-tray.js';
import { surfaceFinish } from '../src/client/world/surface.js';
import { ANISOTROPY } from '../src/client/world/texture-quality.js';

test('the two tray runs share textured geometry and leave suspension and lighting untouched', () => {
  const source = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(), [
    new THREE.MeshStandardMaterial({ name: 'TrayZinc', map: new THREE.Texture(), metalness: 0.65 }),
    new THREE.MeshStandardMaterial({ name: 'TrayCable', color: '#3b4147' }),
    new THREE.MeshStandardMaterial({ name: 'TrayClamp', metalness: 0.2 }),
    new THREE.MeshStandardMaterial({ name: 'TraySignal', color: '#ee6018' }),
  ]);
  body.name = 'cable-tray';
  source.add(body);
  const office = new THREE.Group();
  const mounts = [-4.33, 4.33].map((z) => {
    const mount = new THREE.Group();
    mount.name = 'cable-tray-mount';
    mount.position.set(-6, 5.9, z);
    mount.add(new THREE.Object3D());
    office.add(mount);
    return mount;
  });
  const rod = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.72, 0.012), new THREE.MeshToonMaterial());
  const lit = new THREE.MeshToonMaterial({ emissive: '#fff3e0' });
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(), lit);
  office.add(rod, diffuser);
  const children = [...office.children];
  assert.equal(installCableTrays(source, office), 2);
  assert.deepEqual(office.children, children);
  assert.deepEqual(
    mounts.map((m) => m.position.toArray()),
    [
      [-6, 5.9, -4.33],
      [-6, 5.9, 4.33],
    ],
  );
  const first = mounts[0].children[0] as THREE.Mesh;
  const second = mounts[1].children[0] as THREE.Mesh;
  assert.equal(first.geometry, body.geometry);
  assert.equal(second.geometry, body.geometry);
  const materials = first.material as THREE.MeshToonMaterial[];
  assert.ok(materials.every((m) => m.isMeshToonMaterial));
  assert.equal(materials[0], (second.material as THREE.MeshToonMaterial[])[0]);
  assert.equal(materials[0].map, body.material[0].map);
  assert.equal(materials[0].map?.anisotropy, ANISOTROPY);
  assert.deepEqual(surfaceFinish(materials[0]), [0.55, 0.3]);
  assert.equal(surfaceFinish(materials[1]), null);
  assert.deepEqual(surfaceFinish(materials[2]), [0.04, 0.72]);
  assert.equal(surfaceFinish(materials[3]), null);
  assert.equal(materials[3].color.getHexString(), 'ee6018');
  assert.equal(diffuser.material, lit);
  assert.equal(lit.emissive.getHexString(), 'fff3e0');
  assert.ok(body.material.every((m) => m.isMeshStandardMaterial));
});

test('missing tray model or mount retains the fallback and single-material models work', () => {
  const office = new THREE.Group();
  const mount = new THREE.Group();
  mount.name = 'cable-tray-mount';
  const fallback = new THREE.Object3D();
  mount.add(fallback);
  office.add(mount);
  assert.equal(installCableTrays(new THREE.Group(), office), 0);
  assert.equal(mount.children[0], fallback);
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  source.name = 'cable-tray';
  assert.equal(installCableTrays(source, new THREE.Group()), 0);
  assert.equal(installCableTrays(source, office), 1);
  assert.ok((mount.children[0] as THREE.Mesh).material instanceof THREE.MeshToonMaterial);
});

test('exported tray keeps the 17 m run, metre-scaled UVs and a packed 512px zinc texture', () => {
  const data = readFileSync(new URL('../src/client/public/props/cable-tray.glb', import.meta.url));
  const length = data.readUInt32LE(12);
  const json = JSON.parse(data.subarray(20, 20 + length).toString('utf8'));
  const meta = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'))['cable-tray'];
  assert.ok(Math.abs(meta.width - 17) < 0.001);
  assert.ok(meta.height < 0.1 && meta.depth < 0.34);
  assert.ok(meta.triangles <= 8000);
  assert.equal(meta.bytes, data.byteLength);
  assert.equal(meta.materials, 4);
  assert.equal(json.nodes[0].name, 'cable-tray');
  assert.equal(json.images.length, 1);
  assert.equal(json.images[0].mimeType, 'image/png');
  const view = json.bufferViews[json.images[0].bufferView];
  const png = data.subarray(28 + length + (view.byteOffset ?? 0));
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
  const zinc = json.materials.find((m: { name: string }) => m.name === 'TrayZinc');
  assert.ok(zinc.pbrMetallicRoughness.baseColorTexture);
  let triangles = 0;
  for (const primitive of json.meshes[0].primitives) {
    const position = json.accessors[primitive.attributes.POSITION];
    assert.ok(position.min[1] > -0.03 && position.max[1] < 0.08, 'mount remains on the original tray elevation');
    assert.notEqual(primitive.attributes.TEXCOORD_0, undefined);
    triangles += json.accessors[primitive.indices].count / 3;
  }
  assert.equal(triangles, meta.triangles);
});
