import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { installAgentKiosks } from '../src/client/world/agent-kiosk.js';
import { surfaceFinish } from '../src/client/world/surface.js';
import { KIOSK, STATIONS } from '../src/shared/layout.js';

test('kiosks share converted geometry and retain each station sign, pose, stage and picking', () => {
  const source = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ name: 'KioskPaint', color: '#72777d' });
  const steel = new THREE.MeshStandardMaterial({ name: 'KioskSteel', metalness: 0.85, color: '#a1aab3' });
  const rubber = new THREE.MeshStandardMaterial({ name: 'KioskRubber', color: '#24282d' });
  const signal = new THREE.MeshStandardMaterial({ name: 'KioskSignal', color: '#ee6018', emissive: '#ee6018' });
  const body = new THREE.Mesh(new THREE.BoxGeometry(), [paint, steel, rubber, signal, paint]);
  body.name = 'AgentKiosk';
  source.add(body);
  const stations = STATIONS.map((def) => {
    const group = new THREE.Group();
    group.position.set(def.x, 0, def.z);
    group.rotation.y = def.rotY;
    group.userData.interact = { kind: 'station', deskId: def.id };
    const counter = new THREE.Group();
    counter.name = 'agent-kiosk';
    counter.add(new THREE.Object3D());
    group.add(counter);
    for (const name of ['sign', 'laptopAnchor', 'seatAnchor', 'vacancy', 'stage']) {
      const anchor = new THREE.Object3D();
      anchor.name = name;
      group.add(anchor);
    }
    return group;
  });
  const children = stations.map((s) => [...s.children]);
  assert.equal(installAgentKiosks(source, [...stations, new THREE.Group()]), STATIONS.length);
  const first = stations[0].getObjectByName('AgentKiosk') as THREE.Mesh;
  const materials = first.material as THREE.MeshToonMaterial[];
  assert.ok(materials.every((m) => m.isMeshToonMaterial));
  assert.equal(materials[0], materials[4]);
  assert.deepEqual(surfaceFinish(materials[0]), [0.04, 0.72]);
  assert.deepEqual(surfaceFinish(materials[1]), [0.55, 0.3]);
  assert.equal(surfaceFinish(materials[2]), null);
  assert.equal(materials[3].emissive.getHexString(), 'ee6018');
  for (let i = 0; i < stations.length; i++) {
    const station = stations[i];
    const def = STATIONS[i];
    assert.deepEqual(station.children, children[i]);
    assert.deepEqual(station.position.toArray(), [def.x, 0, def.z]);
    assert.equal(station.rotation.y, def.rotY);
    assert.deepEqual(station.userData.interact, { kind: 'station', deskId: def.id });
    const loaded = station.getObjectByName('AgentKiosk') as THREE.Mesh;
    assert.equal(loaded.geometry, body.geometry);
    assert.equal((loaded.material as THREE.Material[])[0], materials[0]);
  }
  assert.equal(body.material[0], paint);
});

test('incomplete kiosk source retains fallback and single-material models are supported', () => {
  const station = new THREE.Group();
  const counter = new THREE.Group();
  counter.name = 'agent-kiosk';
  const fallback = new THREE.Object3D();
  counter.add(fallback);
  station.add(counter);
  assert.equal(installAgentKiosks(new THREE.Group(), [station]), 0);
  assert.equal(counter.children[0], fallback);
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'KioskRubber' }));
  source.name = 'AgentKiosk';
  assert.equal(installAgentKiosks(source, [station]), 1);
  assert.ok(((counter.children[0] as THREE.Mesh).material as THREE.MeshToonMaterial).isMeshToonMaterial);
});

test('kiosk GLB exports its required node, original footprint and budget', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'));
  const kiosk = manifest['agent-kiosk'];
  assert.equal(kiosk.width, KIOSK.width);
  assert.equal(kiosk.depth, KIOSK.depth + 0.02);
  assert.equal(kiosk.height, KIOSK.height);
  assert.ok(kiosk.triangles <= 8000);
  assert.equal(kiosk.materials, 4);
  const glb = readFileSync(new URL('../src/client/public/props/agent-kiosk.glb', import.meta.url));
  assert.equal(glb.byteLength, kiosk.bytes);
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  assert.ok(json.nodes.some((n: { name: string }) => n.name === 'AgentKiosk'));
});
