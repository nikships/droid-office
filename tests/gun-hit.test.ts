import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { gunHit } from '../src/client/world/gun.js';

function fixture() {
  const office = new THREE.Group();
  const worker = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1, 0.5), new THREE.MeshBasicMaterial());
  body.position.z = -4;
  worker.add(body);
  office.add(worker);
  const workers = new Map<THREE.Object3D, string>([[worker, 'worker']]);
  const ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));
  ray.camera = new THREE.PerspectiveCamera();
  const blocker = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.2), new THREE.MeshBasicMaterial());
  blocker.position.z = -1;
  return { office, worker, body, workers, ray, blocker };
}

test('a hidden office subtree cannot block the visible droid behind it', () => {
  const f = fixture();
  const hidden = new THREE.Group();
  hidden.visible = false;
  hidden.add(f.blocker);
  f.office.add(hidden);
  f.office.updateMatrixWorld(true);
  assert.equal(f.ray.intersectObject(f.office, true)[0].object, f.blocker, 'the unfiltered ray reproduces the hidden-blocker bug');
  assert.equal(gunHit(f.ray, f.office, f.workers)?.workerId, 'worker');
});

test('invisible and zero-opacity materials do not absorb a bullet', () => {
  for (const field of ['visible', 'opacity'] as const) {
    const f = fixture();
    if (field === 'visible') f.blocker.material.visible = false;
    else f.blocker.material.opacity = 0;
    f.office.add(f.blocker);
    f.office.updateMatrixWorld(true);
    assert.equal(gunHit(f.ray, f.office, f.workers)?.hit.object, f.body);
  }
});

test('visible furniture and glass still block the droid behind them', () => {
  for (const glass of [false, true]) {
    const f = fixture();
    if (glass) {
      f.blocker.material.transparent = true;
      f.blocker.material.opacity = 0.14;
      f.blocker.material.depthWrite = false;
    }
    f.office.add(f.blocker);
    f.office.updateMatrixWorld(true);
    const result = gunHit(f.ray, f.office, f.workers);
    assert.equal(result?.workerId, null);
    assert.equal(result?.hit.object, f.blocker);
  }
});

test('UI billboards and glow points are not solid shot targets or blockers', () => {
  const f = fixture();
  const label = new THREE.Sprite(new THREE.SpriteMaterial());
  label.position.z = -1;
  f.office.add(label);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -2], 3));
  const glow = new THREE.Points(geometry, new THREE.PointsMaterial());
  f.office.add(glow);
  f.office.updateMatrixWorld(true);
  assert.ok(f.ray.intersectObject(f.office, true).some((hit) => hit.object === label));
  assert.ok(f.ray.intersectObject(f.office, true).some((hit) => hit.object === glow));
  f.ray.camera = null;
  label.raycast = () => {
    assert.fail('a direct muzzle ray must not intersect a camera-dependent name sprite');
  };
  assert.equal(gunHit(f.ray, f.office, f.workers)?.hit.object, f.body);
});

test('a hidden droid stays untargetable even when supplied as a separate root', () => {
  const f = fixture();
  f.worker.visible = false;
  f.office.updateMatrixWorld(true);
  assert.equal(gunHit(f.ray, f.office, f.workers), null);
});

test('a visible arriving droid outside the office is targetable, while unregistered players are excluded', () => {
  const f = fixture();
  const scene = new THREE.Scene();
  scene.add(f.office, f.worker);
  const player = new THREE.Group();
  player.add(f.blocker);
  scene.add(player);
  scene.updateMatrixWorld(true);
  assert.equal(gunHit(f.ray, f.office, f.workers)?.workerId, 'worker');
  f.body.position.x = 3;
  scene.updateMatrixWorld(true);
  assert.equal(gunHit(f.ray, f.office, f.workers), null, 'a miss never becomes a hit on a player');
});
