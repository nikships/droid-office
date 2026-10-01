import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BloodSpray, GUN_LEN, MUZZLE_AT, Muzzle, Puff, disposeGun, magnum } from '../src/client/world/gun.js';
import { recoilAt } from '../src/client/native/physical.js';

test('a magnum points down +z with its grip around the origin', () => {
  const gun = magnum();
  assert.equal(gun.children.length, 4, 'the barrel, frame, grip and details share four material batches');
  assert.ok(Math.abs(MUZZLE_AT.z - 0.26) < 1e-9);
  assert.ok(GUN_LEN > MUZZLE_AT.z);
  const box = new THREE.Box3().setFromObject(gun);
  assert.ok(box.min.y < -0.06 && box.min.y > -0.08, 'a full-size grip extends below the fist');
  assert.ok(box.max.z > 0.2, 'the barrel runs out past the fist');
  disposeGun(gun);
  assert.equal(gun.parent, null);
});

test('the muzzle flash pops and fades back to nothing', () => {
  const muzzle = new Muzzle();
  assert.equal(muzzle.lit, false);
  muzzle.fire();
  assert.equal(muzzle.lit, true);
  muzzle.update(1 / 120);
  assert.equal(muzzle.lit, true);
  let light = 0;
  muzzle.group.traverse((o) => {
    if ((o as THREE.PointLight).isPointLight) light = (o as THREE.PointLight).intensity;
  });
  assert.ok(light > 0, 'the flash throws light on the walls');
  muzzle.update(1);
  assert.equal(muzzle.lit, false);
  muzzle.group.traverse((o) => {
    if ((o as THREE.PointLight).isPointLight) light = (o as THREE.PointLight).intensity;
  });
  assert.equal(light, 0);
  muzzle.dispose();
});

test('an impact puff bursts out and clears within half a second', () => {
  const puff = new Puff(new THREE.Vector3(1, 2, 3), new THREE.Vector3(0, 0, 1));
  assert.deepEqual(puff.group.position.toArray(), [1, 2, 3]);
  assert.equal(puff.update(1 / 60), true, 'still hanging in the air');
  assert.equal(puff.update(1), false, 'cleared');
  puff.dispose();
});

test('the first frame after a shot shows the whole flash, however long that frame is', () => {
  const muzzle = new Muzzle();
  const core = muzzle.group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  muzzle.fire();
  muzzle.update(1 / 30);
  assert.equal(core.material.opacity, 1, 'a 30 Hz headset frame is not spent fading it');
  muzzle.update(1 / 30);
  assert.ok(core.material.opacity > 0.4 && core.material.opacity < 1, 'it fades from the next frame');
  muzzle.update(1 / 30);
  muzzle.update(1 / 30);
  assert.equal(muzzle.lit, false);
  muzzle.dispose();
});

test('a worker hit sprays out of the wound toward the shooter and clears within half a second', () => {
  const at = new THREE.Vector3(1, 1, 1);
  const spray = new BloodSpray(at, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1));
  assert.deepEqual(spray.group.position.toArray(), [1, 1, 1]);
  assert.equal(spray.update(1 / 30), true);
  const toward = spray.group.children.filter((c) => c.position.z > 0).length;
  assert.ok(toward > spray.group.children.length / 2, 'most of it flies back out at the shooter');
  assert.equal(spray.update(0.5), false, 'cleared');
  spray.dispose();
});

test('recoil kicks in full on the shot and settles within a quarter second', () => {
  assert.equal(recoilAt(0), 1);
  assert.ok(recoilAt(33) > 0.5 && recoilAt(33) < 1);
  assert.ok(recoilAt(100) < recoilAt(33));
  assert.equal(recoilAt(250), 0);
  assert.equal(recoilAt(-5), 0);
  assert.equal(recoilAt(Number.NaN), 0);
});

test('the held gun, its flash and a hit spray export to the headset renderer without unsupported features', async () => {
  const { NativeScene } = await import('../src/client/native/scene.js');
  const scene = new THREE.Scene();
  const grip = new THREE.Group();
  scene.add(grip);
  const gun = magnum();
  const muzzle = new Muzzle();
  gun.add(muzzle.group);
  gun.userData.nativeControllerAttachment = { hand: 1, requiresGrip: true };
  grip.add(gun);
  muzzle.fire();
  const spray = new BloodSpray(new THREE.Vector3(0, 1, -1), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1));
  scene.add(spray.group);
  const native = new NativeScene(scene, new THREE.PerspectiveCamera(), { encodeImage: async () => ({ fmt: 'png', bytes: new Uint8Array([1]) }), now: () => 0 });
  native.capture();
  while (native.drain()) {}
  spray.update(1 / 30);
  muzzle.update(1 / 30);
  native.capture();
  while (native.drain()) {}
  assert.deepEqual(native.report().errors, []);
  assert.deepEqual(native.report().unsupported, []);
  spray.dispose();
  muzzle.dispose();
  disposeGun(gun);
});
