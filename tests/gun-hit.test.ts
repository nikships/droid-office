import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { gunHit } from '../src/client/world/gun.js';
import type { Interactable } from '../src/client/world/office.js';

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

test('a hidden office subtree cannot block the visible worker behind it', () => {
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

test('visible furniture and glass still block the worker behind them', () => {
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

test('a hidden worker stays untargetable even when supplied as a separate root', () => {
  const f = fixture();
  f.worker.visible = false;
  f.office.updateMatrixWorld(true);
  assert.equal(gunHit(f.ray, f.office, f.workers), null);
});

test('a visible arriving worker outside the office is targetable, while unregistered players are excluded', () => {
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

function laptopFixture(distance = 2) {
  const f = fixture();
  const laptop = new THREE.Group();
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.45), new THREE.MeshBasicMaterial());
  screen.position.z = -distance;
  laptop.add(screen);
  f.office.add(laptop);
  const screens = new Map<THREE.Object3D, string>([[screen, 'laptop-worker']]);
  return { ...f, laptop, screen, screens };
}

test('a shot at a laptop screen selects its UI rather than the worker behind it, at any distance', () => {
  for (const distance of [2, 12, 1000]) {
    const f = laptopFixture(distance);
    f.body.position.z = -distance - 1;
    f.office.updateMatrixWorld(true);
    const hit = gunHit(f.ray, f.office, f.workers, f.screens);
    assert.equal(hit?.hit.object, f.screen);
    assert.ok(Math.abs(hit!.hit.distance - distance) < 1e-9);
    assert.equal(hit?.laptopWorkerId, 'laptop-worker');
    assert.equal(hit?.workerId, null, 'screen shots do not damage the worker');
  }
});

test('screen shots still respect visible blockers and do not treat the laptop shell as its UI', () => {
  const f = laptopFixture();
  f.office.add(f.blocker);
  f.office.updateMatrixWorld(true);
  let hit = gunHit(f.ray, f.office, f.workers, f.screens);
  assert.equal(hit?.hit.object, f.blocker);
  assert.equal(hit?.laptopWorkerId, null);
  f.laptop.add(f.blocker);
  f.office.updateMatrixWorld(true);
  hit = gunHit(f.ray, f.office, f.workers, f.screens);
  assert.equal(hit?.laptopWorkerId, null, 'another solid inside the laptop is not a screen');
});

test('hidden laptop screens cannot open a UI or block a worker', () => {
  for (const hidden of ['laptop', 'screen', 'material', 'opacity'] as const) {
    const f = laptopFixture();
    if (hidden === 'laptop') f.laptop.visible = false;
    else if (hidden === 'screen') f.screen.visible = false;
    else if (hidden === 'material') f.screen.material.visible = false;
    else f.screen.material.opacity = 0;
    f.office.updateMatrixWorld(true);
    const hit = gunHit(f.ray, f.office, f.workers, f.screens);
    assert.equal(hit?.workerId, 'worker');
    assert.equal(hit?.laptopWorkerId, null);
  }
});

test('an unregistered display remains a solid miss, not a laptop UI target', () => {
  const f = laptopFixture();
  f.office.updateMatrixWorld(true);
  const hit = gunHit(f.ray, f.office, f.workers);
  assert.equal(hit?.hit.object, f.screen);
  assert.equal(hit?.laptopWorkerId, null);
});

test('shots resolve every pane and the jukebox through their tagged parent, without a reach limit', () => {
  const kinds = ['issues', 'pulls', 'actions', 'ci', 'whiteboard', 'computers', 'jukebox', 'bookshelf', 'decor', 'elevator'] as const;
  for (const kind of kinds) {
    for (const distance of [2, 12, 1000]) {
      const f = laptopFixture(distance);
      const it: Interactable = { kind, x: 0, z: -distance, radius: 1 };
      f.laptop.userData.interact = it;
      f.body.position.z = -distance - 1;
      f.office.updateMatrixWorld(true);
      const hit = gunHit(f.ray, f.office, f.workers);
      assert.equal(hit?.hit.object, f.screen, kind);
      assert.equal(hit?.interactable, it, kind);
      assert.equal(hit?.workerId, null, 'opening a pane must not damage a worker behind it');
    }
  }
});

test('a solid blocker never forwards a shot to the pane behind it', () => {
  const f = laptopFixture(12);
  f.laptop.userData.interact = { kind: 'whiteboard', x: 0, z: -12, radius: 1 } satisfies Interactable;
  f.office.add(f.blocker);
  f.office.updateMatrixWorld(true);
  const hit = gunHit(f.ray, f.office, f.workers);
  assert.equal(hit?.hit.object, f.blocker);
  assert.equal(hit?.interactable, null);
});

test('hidden or disabled panes cannot become shot interactions', () => {
  for (const hidden of ['laptop', 'screen', 'material', 'opacity', 'off'] as const) {
    const f = laptopFixture();
    const it: Interactable = { kind: 'computers', x: 0, z: -2, radius: 1 };
    f.laptop.userData.interact = it;
    if (hidden === 'laptop') f.laptop.visible = false;
    else if (hidden === 'screen') f.screen.visible = false;
    else if (hidden === 'material') f.screen.material.visible = false;
    else if (hidden === 'opacity') f.screen.material.opacity = 0;
    else it.off = true;
    f.office.updateMatrixWorld(true);
    assert.equal(gunHit(f.ray, f.office, f.workers)?.interactable, null, hidden);
  }
});

test('a mesh interaction takes precedence over a containing group, including the boss monitor', () => {
  const f = laptopFixture();
  const chair: Interactable = { kind: 'seat', seatId: 'boss-chair', x: 0, z: -2, radius: 1 };
  f.screen.userData.interact = chair;
  f.laptop.userData.interact = { kind: 'decor', decorId: 'picture', x: 0, z: -2, radius: 1 } satisfies Interactable;
  f.office.updateMatrixWorld(true);
  assert.equal(gunHit(f.ray, f.office, f.workers)?.interactable, chair);
});
