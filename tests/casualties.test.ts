import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FALL_TIME, LOAD_TIME, POOL_TIME, fallProgress, poolSpread } from '../src/client/world/casualties.js';
import { MUZZLE, MuzzleFlash, magnum } from '../src/client/world/gun.js';

test('the blood pool starts as a splat and spreads all the way out over POOL_TIME', () => {
  assert.equal(poolSpread(0), 0.18);
  assert.equal(poolSpread(-1), 0.18);
  assert.ok(Math.abs(poolSpread(POOL_TIME) - 1) < 1e-9);
  assert.ok(Math.abs(poolSpread(POOL_TIME * 10) - 1) < 1e-9);
  let prev = 0;
  for (let t = 0; t <= POOL_TIME; t += 0.5) {
    const s = poolSpread(t);
    assert.ok(s >= prev, `spreads monotonically at t=${t}`);
    prev = s;
  }
  assert.ok(poolSpread(POOL_TIME / 2) > 0.5, 'eases out: most of the spread happens early');
});

test('the fall runs 0 to 1 over FALL_TIME, clamped at both ends', () => {
  assert.equal(fallProgress(0), 0);
  assert.equal(fallProgress(FALL_TIME), 1);
  assert.equal(fallProgress(FALL_TIME * 2), 1);
  assert.equal(fallProgress(-5), 0);
  assert.ok(Math.abs(fallProgress(FALL_TIME / 2) - 0.5) < 1e-9);
});

test('the timings are ordered: a crack, a bleed, a carry', () => {
  assert.ok(FALL_TIME > 0 && FALL_TIME < POOL_TIME);
  assert.ok(LOAD_TIME > 0 && LOAD_TIME < POOL_TIME);
});

test('the magnum points down +z with the muzzle past the barrel', () => {
  const gun = magnum();
  assert.ok(gun.children.length > 10, 'barrel, cylinder, grip, hammer, trigger, sights');
  const box = new THREE.Box3().setFromObject(gun);
  const size = box.getSize(new THREE.Vector3());
  assert.ok(size.z > 0.25 && size.z < 0.4, `about real size, got ${size.z.toFixed(2)} m`);
  assert.ok(MUZZLE.z > box.max.z - 0.02, 'the flash sits at the muzzle');
  gun.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
});

test('the muzzle flash is there and gone in a blink', () => {
  const flash = new MuzzleFlash();
  assert.equal(flash.firing, false);
  assert.equal(flash.group.visible, false);
  flash.fire();
  assert.equal(flash.firing, true);
  assert.equal(flash.group.visible, true);
  flash.update(0.05);
  assert.equal(flash.firing, true);
  flash.update(1);
  assert.equal(flash.firing, false);
  assert.equal(flash.group.visible, false);
  flash.dispose();
});
