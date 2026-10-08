import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { Glove, type HandShape, SHAPES } from '../src/client/world/glove.js';
import { disposeGun, magnum, SPIN_AT } from '../src/client/world/gun.js';

const mats = () => ({ glove: new THREE.MeshBasicMaterial(), steel: new THREE.MeshBasicMaterial(), pinwheel: new THREE.MeshBasicMaterial() });

/** A glove on an arm at the origin, snapped into `shape`. */
function glove(side: 1 | -1, shape: HandShape): { arm: THREE.Group; glove: Glove } {
  const arm = new THREE.Group();
  const g = new Glove(side, mats());
  arm.add(g.group);
  g.shape(shape, true);
  arm.updateMatrixWorld(true);
  return { arm, glove: g };
}

/** The middle of a named mesh (a bone is `glove-finger-<0 index … 3 little>-<0 … 2 out to the tip>` or `glove-thumb-<0 … 2>`), in world space. */
function at(root: THREE.Object3D, name: string): THREE.Vector3 {
  root.updateMatrixWorld(true);
  const o = root.getObjectByName(name);
  assert.ok(o, `${name} is there`);
  return new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
}

const size = (arm: THREE.Object3D) => new THREE.Box3().setFromObject(arm).getSize(new THREE.Vector3());

test('a glove has a palm, four three-boned fingers and a three-boned thumb, with the pinwheel on its back', () => {
  const { arm, glove: g } = glove(1, SHAPES.flat);
  let bones = 0;
  arm.traverse((o) => {
    if (o instanceof THREE.Mesh && o.geometry.type === 'CapsuleGeometry') bones++;
  });
  // Four fingers and the thumb, three bones each, and the knuckle guard.
  assert.equal(bones, 5 * 3 + 1);
  const back = new THREE.Box3().setFromObject(arm.getObjectByName('glove-pinwheel')!);
  const palm = new THREE.Box3().setFromObject(g.group.children[0]);
  assert.ok(back.min.y > 0 && back.max.y <= palm.max.y + 0.002, 'the pinwheel lies on the back of the hand, not floating above it');
  assert.ok(back.max.x - back.min.x > 0.03, 'and is big enough to read');
  g.dispose();
});

test('the thumb is on the inside of each hand: -x on the right, +x on the left', () => {
  for (const side of [1, -1] as const) {
    const { arm } = glove(side, SHAPES.flat);
    const thumb = at(arm, 'glove-thumb-2');
    const little = at(arm, 'glove-finger-3-2');
    assert.ok(Math.sign(little.x - thumb.x) === side, `side ${side}: thumb across the hand from the little finger`);
  }
});

test('a fist is short and closed, an open hand long and spread, and a thumbs up stands up', () => {
  const open = size(glove(1, SHAPES.open).arm);
  const fist = size(glove(1, SHAPES.fist).arm);
  assert.ok(open.z > fist.z + 0.05, `open (${open.z.toFixed(3)} long) reaches well past a fist (${fist.z.toFixed(3)})`);
  assert.ok(open.x > fist.x, 'and is wider, fingers spread');
  const up = glove(1, SHAPES.thumbsUp).arm;
  const top = new THREE.Box3().setFromObject(up).max.y;
  assert.ok(top > 0.07, `a thumbs up's thumb stands up out of the fist (top at ${top.toFixed(3)})`);
});

test('shapes blend over a few frames rather than popping', () => {
  const { arm, glove: g } = glove(1, SHAPES.open);
  const start = size(arm).z;
  g.shape(SHAPES.fist);
  g.update(1 / 60);
  const step = size(arm).z;
  assert.ok(step < start && step > size(glove(1, SHAPES.fist).arm).z, 'a frame in, it is between open and closed');
  for (let i = 0; i < 60; i++) g.update(1 / 60);
  assert.ok(Math.abs(size(arm).z - size(glove(1, SHAPES.fist).arm).z) < 1e-3, 'and a second later it is a fist');
});

test('the right fist closes round the magnum’s grip, the index finger on the trigger', () => {
  const { arm, glove: g } = glove(1, SHAPES.grip);
  const gun = magnum();
  gun.rotation.y = Math.PI;
  g.gunMount(0, gun.position);
  arm.add(gun);
  arm.updateMatrixWorld(true);
  // Back into the gun's own frame: +z is the muzzle, +y up, +x its left.
  const inGun = (o: THREE.Object3D, local = new THREE.Vector3()) => gun.worldToLocal(o.localToWorld(local.clone()));
  const palm = inGun(g.group);
  assert.ok(palm.x < -0.01, `the palm is on the gun's right side (x ${palm.x.toFixed(3)})`);
  assert.ok(palm.y < 0.01 && palm.y > -0.07, 'level with the grip');
  const trigger = inGun(g.trigger);
  assert.ok(trigger.z > 0.03 && trigger.z < 0.07 && trigger.y < 0.02 && trigger.y > -0.03, `the index finger is in the guard (${trigger.toArray().map((v) => v.toFixed(3))})`);
  // The middle, ring and little fingers come round the front of the grip, under the guard, to its left side.
  for (const f of [1, 2, 3]) {
    const tip = gun.worldToLocal(at(arm, `glove-finger-${f}-2`));
    assert.ok(tip.x > 0.005, `finger ${f}'s tip wraps round to the gun's left (x ${tip.x.toFixed(3)})`);
    assert.ok(tip.z < 0.03, `and lies along the grip, not out in the guard (z ${tip.z.toFixed(3)})`);
    const first = gun.worldToLocal(at(arm, `glove-finger-${f}-0`));
    assert.ok(first.y < -0.02, `finger ${f} is below the guard (y ${first.y.toFixed(3)})`);
  }
  const thumb = gun.worldToLocal(at(arm, 'glove-thumb-2'));
  assert.ok(thumb.x > 0 && thumb.y > -0.01, `the thumb lies along the gun's left side, up by the frame (${thumb.toArray().map((v) => v.toFixed(3))})`);
  disposeGun(gun);
  g.dispose();
});

test('spinning, the gun hangs by its guard on the trigger finger', () => {
  const { arm, glove: g } = glove(1, SHAPES.spin);
  const gun = magnum();
  gun.rotation.y = Math.PI;
  g.gunMount(1, gun.position);
  arm.add(gun);
  arm.updateMatrixWorld(true);
  const finger = g.trigger.getWorldPosition(new THREE.Vector3());
  const guard = gun.localToWorld(SPIN_AT.clone());
  assert.ok(finger.distanceTo(guard) < 1e-6, 'the spin point is on the finger');
  // Halfway there, it's between the fist and the finger.
  const half = g.gunMount(0.5, new THREE.Vector3());
  const fist = g.gunMount(0, new THREE.Vector3());
  assert.ok(half.distanceTo(fist) > 0 && half.distanceTo(gun.position) > 0);
  disposeGun(gun);
  g.dispose();
});
