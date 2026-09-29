import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GUN_LEN, MUZZLE_AT, Muzzle, Puff, disposeGun, magnum } from '../src/client/world/gun.js';

test('a magnum points down +z with its grip under the origin', () => {
  const gun = magnum();
  assert.ok(gun.children.length > 15, 'barrel, cylinder, hammer, trigger, grip and all');
  assert.ok(Math.abs(MUZZLE_AT.z - 0.26) < 1e-9);
  assert.ok(GUN_LEN > MUZZLE_AT.z);
  const box = new THREE.Box3().setFromObject(gun);
  assert.ok(box.min.y < -0.1, 'the grip hangs below the fist');
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
