import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';
import { BloodSpray, disposeGun, GUN_LEN, MUZZLE_AT, Muzzle, magnum, magnumReady, Puff, parseMagnum } from '../src/client/world/gun.js';

test('a magnum made before magnum.glb loads fills in when it lands, pointing down +z with its grip round the origin', async () => {
  assert.equal(magnumReady(), false);
  const early = magnum();
  assert.equal(early.children.length, 1, 'only the empty crane until the model is in');
  const dropped = magnum();
  disposeGun(dropped);
  const glb = readFileSync(new URL('../src/client/public/props/magnum.glb', import.meta.url));
  await parseMagnum(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));
  assert.equal(magnumReady(), true);
  assert.equal(dropped.children.length, 1, 'a gun put away before then stays empty');
  for (const gun of [early, magnum()]) {
    assert.equal(gun.children.length, 6, 'the frame, steel, grip, details and sight batches, with the cylinder on its crane');
    assert.ok(gun.getObjectByName('gun-crane-arm') && gun.getObjectByName('gun-cylinder'));
    const box = new THREE.Box3().setFromObject(gun);
    assert.ok(Math.abs(box.max.z - MUZZLE_AT.z) < 1e-5, 'the muzzle is the front of the gun');
    assert.ok(Math.abs(box.max.z - box.min.z - GUN_LEN) < 1e-3);
    assert.ok(box.min.y < -0.06, 'a full-size grip extends below the fist');
    assert.ok(box.max.z > 0.2, 'the barrel runs out past the fist');
    disposeGun(gun);
    assert.equal(gun.parent, null);
  }
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
  assert.equal(core.material.opacity, 1, 'a slow frame is not spent fading it');
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
