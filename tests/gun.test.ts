import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BloodSpray, GUN_LEN, HELD_FLASH, INDOOR_LIGHT, MUZZLE_AT, Muzzle, Puff, disposeGun, heldGunFill, lightHeldGun, magnum } from '../src/client/world/gun.js';
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

test("recoil kicks in full in the shot's frame, is still visibly up a tenth of a second on, and is home by 0.3 s", () => {
  assert.equal(recoilAt(0), 1);
  assert.ok(recoilAt(33) > 0.85, 'the next 30 Hz frame still shows nearly all of it');
  assert.ok(recoilAt(133) > 0.3 && recoilAt(133) < 0.55, 'four frames on the hand is still bringing it down');
  assert.ok(recoilAt(300) < 0.05, 'settled onto the aim by 0.3 s');
  let last = Infinity;
  for (let ms = 0; ms <= 400; ms += 5) {
    assert.ok(recoilAt(ms) <= last, `the return never kicks back up (${ms} ms)`);
    last = recoilAt(ms);
  }
  assert.equal(recoilAt(340), 0);
  assert.equal(recoilAt(-5), 0);
  assert.equal(recoilAt(Number.NaN), 0);
});

/** three.js getDistanceAttenuation: what a point light's intensity is worth `d` meters from it. */
function attenuation(d: number, cutoff: number, decay: number): number {
  const falloff = 1 / Math.max(d ** decay, 0.01);
  return cutoff > 0 ? falloff * Math.min(1, Math.max(0, 1 - (d / cutoff) ** 4)) ** 2 : falloff;
}

test("a held gun's flash pops warm round the shot without whiting out the gun or what is at its muzzle", () => {
  const muzzle = new Muzzle(HELD_FLASH);
  let light: THREE.PointLight | null = null;
  muzzle.group.traverse((o) => {
    if ((o as THREE.PointLight).isPointLight) light = o as THREE.PointLight;
  });
  assert.ok(light);
  const lamp = light as THREE.PointLight;
  muzzle.fire();
  assert.equal(lamp.intensity, HELD_FLASH.intensity, "full in the shot's own frame");
  assert.ok(lamp.position.z > 0.1, 'it sits out ahead of the barrel, not on it');
  // A toon surface lit from any side takes 0.7–1 of the light, times its color over pi.
  for (let d = 0.01; d <= 3; d += 0.01) {
    const share = (lamp.intensity * attenuation(d, lamp.distance, lamp.decay)) / Math.PI;
    assert.ok(share < 0.6, `${d.toFixed(2)} m from it a surface gets ${share.toFixed(2)} of its color, not a white-out`);
    if (d <= 0.7) assert.ok(0.7 * share > 0.25, `${d.toFixed(2)} m from it, the gun and what it is pointed at, the flash shows`);
    if (d >= 1.4) assert.equal(share, 0, `${d.toFixed(2)} m from it the room is left as it was`);
  }
  muzzle.update(1 / 30);
  muzzle.update(1);
  assert.equal(lamp.intensity, 0);
  muzzle.dispose();
  // The flash seen from across the room keeps its hard physical light.
  const room = new Muzzle();
  room.fire();
  let roomLight = 0;
  room.group.traverse((o) => {
    if ((o as THREE.PointLight).isPointLight) roomLight = (o as THREE.PointLight).decay;
  });
  assert.equal(roomLight, 2);
  room.dispose();
});

test('a held gun is lit like the hand holding it: half its own color indoors, less on a dark street', () => {
  const gun = magnum();
  const muzzle = new Muzzle(HELD_FLASH);
  gun.add(muzzle.group);
  lightHeldGun(gun, INDOOR_LIGHT);
  const toon: THREE.MeshToonMaterial[] = [];
  gun.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (m instanceof THREE.MeshToonMaterial) toon.push(m);
  });
  assert.equal(toon.length, 4);
  const indoors = heldGunFill(INDOOR_LIGHT);
  assert.ok(indoors > 0.4 && indoors < 0.55, "about the native hand renderer's 0.55 ambient");
  for (const m of toon) {
    assert.ok(Math.abs(m.emissive.r - m.color.r * indoors) < 1e-9);
    assert.ok(Math.abs(m.emissive.b - m.color.b * indoors) < 1e-9);
  }
  muzzle.group.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (m) assert.ok(m instanceof THREE.MeshBasicMaterial, 'the flash itself is not filled');
  });
  lightHeldGun(gun, 0);
  assert.ok(toon[0].emissive.r < toon[0].color.r * indoors, 'darker out on a night street');
  assert.equal(heldGunFill(Number.NaN), indoors);
  assert.ok(heldGunFill(5) <= 0.85 + 1e-9);
  muzzle.dispose();
  disposeGun(gun);
});

test('the held gun, its flash and a hit spray export to the headset renderer without unsupported features', async () => {
  const { NativeScene } = await import('../src/client/native/scene.js');
  const scene = new THREE.Scene();
  const grip = new THREE.Group();
  scene.add(grip);
  const gun = magnum();
  const muzzle = new Muzzle(HELD_FLASH);
  gun.add(muzzle.group);
  lightHeldGun(gun, INDOOR_LIGHT);
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
