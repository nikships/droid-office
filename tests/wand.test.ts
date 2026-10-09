import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GUN_TRICKS, READY } from '../src/client/world/gun-motion.js';
import { Hands } from '../src/client/world/hands.js';
import { SPELL_HIT, SpellBolt, Sparkles, WAND_TIP, WAND_TRICKS, sidearmProp, tricksFor, wand } from '../src/client/world/wand.js';

test('the wand points along +Z like the magnum, its handle in the fist at the origin and its star at the tip', () => {
  const w = wand();
  assert.equal(w.name, 'wand');
  w.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(w);
  assert.ok(box.max.z > 0.33 && box.max.z < 0.37, `tip and its glow ${box.max.z}`);
  assert.ok(box.min.z > -0.05, 'nothing sticks out the back of the fist');
  assert.ok(box.min.y < -0.07, 'the handle runs down into the fist, where the magnum grip is');
  const star = w.getObjectByName('wand-star')!;
  assert.deepEqual(star.position.toArray(), WAND_TIP.toArray());
  const handle = w.getObjectByName('wand-handle')!;
  assert.ok(Math.abs(handle.position.z) < 0.03 && handle.position.y < 0, 'in the fist');
  assert.equal(w.getObjectByName('gun-drum'), undefined, 'no cylinder to swing out');
});

test('sidearmProp gives the wand a spell flash at its tip and the magnum its own', () => {
  const spell = sidearmProp('wand');
  assert.equal(spell.prop.name, 'wand');
  assert.deepEqual(spell.muzzle.group.position.toArray(), WAND_TIP.toArray());
  const gun = sidearmProp('magnum');
  assert.equal(gun.prop.name, 'magnum');
  assert.ok(gun.muzzle.group.position.z < WAND_TIP.z);
  spell.muzzle.fire();
  assert.equal(spell.muzzle.lit, true);
});

test('the wand has the same six tricks on the same keys, named for a wand', () => {
  assert.deepEqual(
    WAND_TRICKS.map((t) => t.id),
    GUN_TRICKS.map((t) => t.id),
  );
  assert.equal(tricksFor('magnum'), GUN_TRICKS);
  assert.equal(tricksFor('wand'), WAND_TRICKS);
  assert.ok(WAND_TRICKS.every((t) => t.emoji && t.label));
  assert.ok(!WAND_TRICKS.some((t) => /cylinder|smoke|gun/i.test(t.label)));
});

test('sparkles burst, drift up and fade away', () => {
  const s = new Sparkles(new THREE.Vector3(1, 1, 1), new THREE.Vector3(0, 0, 1), { colors: SPELL_HIT, count: 6, seconds: 0.5 });
  assert.equal(s.group.children.length, 6);
  assert.deepEqual(s.group.position.toArray(), [1, 1, 1]);
  let frames = 0;
  while (s.update(1 / 60)) frames++;
  assert.ok(frames >= 28 && frames <= 31, `${frames} frames`);
  const mesh = s.group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  assert.equal(mesh.material.opacity, 0);
  s.dispose();
});

test('a spell bolt reaches from the tip to where it landed, then fades', () => {
  const from = new THREE.Vector3(0, 1.4, 0);
  const to = new THREE.Vector3(0, 1, -4);
  const bolt = new SpellBolt(from, to);
  bolt.group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(bolt.group);
  assert.ok(box.containsPoint(to.clone().lerp(from, 0.01)), 'reaches the target');
  assert.ok(box.min.z < -3.9 && box.max.z > -0.05);
  let alive = 0;
  while (bolt.update(1 / 60)) alive++;
  assert.ok(alive > 10 && alive < 20);
  bolt.dispose();
});

test('your first-person hands swap the wand for the magnum (and back) while it is drawn', () => {
  const hands = new Hands('#4f86f7', '#f1c27d');
  const held = () => {
    let name = '';
    hands.scene.traverse((o) => {
      if (o.name === 'wand' || o.name === 'magnum') name = o.name;
    });
    return name;
  };
  hands.setGunPose(READY, 'wand');
  assert.equal(held(), 'wand');
  assert.ok(hands.muzzleTip(new THREE.Vector3()));
  hands.setGunPose(READY, 'magnum');
  assert.equal(held(), 'magnum');
  hands.setGunPose(null);
  assert.equal(held(), '');
  assert.equal(hands.muzzleTip(new THREE.Vector3()), null);
});
