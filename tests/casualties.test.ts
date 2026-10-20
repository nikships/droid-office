import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ASCEND_HEIGHT, ASCEND_TIME, BEAM_TIME, Casualties, FADE_TIME, type CasualtyLaptop, type CasualtyModel } from '../src/client/world/casualties.js';
import { WALL_HEIGHT } from '../src/shared/layout.js';

class Model implements CasualtyModel {
  readonly root = new THREE.Group();
  asleep = false;
  disposals = 0;
  updates = 0;
  update() {
    this.updates++;
  }
  die(asleep = false) {
    this.asleep = asleep;
  }
  dispose() {
    this.disposals++;
  }
}

class LaptopStub implements CasualtyLaptop {
  readonly root = new THREE.Group();
  shuts = 0;
  disposals = 0;
  shut() {
    return ++this.shuts > 3;
  }
  dispose() {
    this.disposals++;
  }
}

function rig(ground = 0) {
  const parent = new THREE.Group();
  const seat = new THREE.Group();
  seat.position.set(0, ground + 0.4, 5);
  seat.rotation.y = Math.PI;
  parent.add(seat);
  const casualties = new Casualties(parent, () => ground);
  const model = new Model();
  const laptop = new LaptopStub();
  seat.add(model.root);
  parent.add(laptop.root);
  const frames = (n: number, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) casualties.update(dt, i * dt);
  };
  return { parent, seat, casualties, model, laptop, frames };
}

test('charged dismissals start the beam immediately, without a fall, blood pool, or spell circle', () => {
  for (const look of ['spell', 'blood'] as const) {
    const { parent, casualties, model, laptop, frames } = rig();
    assert.equal(casualties.phaseOf('w'), null);
    assert.equal(casualties.ascend('w', model, laptop, look), true);
    assert.equal(casualties.ascend('w', model, laptop, look), false);
    assert.equal(casualties.phaseOf('w'), 'beam');
    assert.equal(model.asleep, look === 'spell');
    assert.ok(parent.getObjectByName('heavenly-beam'));
    assert.equal(parent.getObjectByName('spell-circle'), undefined);
    assert.deepEqual(model.root.position.toArray(), [0, 0.4, 5]);
    frames(Math.ceil(BEAM_TIME * 60) + 1);
    assert.equal(casualties.phaseOf('w'), 'ascend');
    frames(Math.ceil((ASCEND_TIME + FADE_TIME) * 60) + 3);
    assert.equal(casualties.phaseOf('w'), null);
    assert.equal(casualties.active, false);
    assert.equal(model.disposals, 1);
    assert.equal(laptop.disposals, 1);
    assert.equal(model.root.parent, null);
    assert.equal(parent.getObjectByName('heavenly-beam'), undefined);
    assert.ok(ASCEND_HEIGHT > WALL_HEIGHT);
  }
});

test('floor changes dispose owned models and laptops once at any ascent phase', () => {
  for (const seconds of [0, BEAM_TIME + 0.1, BEAM_TIME + ASCEND_TIME + 0.1]) {
    const { casualties, model, laptop, frames } = rig();
    casualties.ascend('w', model, laptop);
    frames(Math.floor(seconds * 60));
    casualties.clear();
    casualties.clear();
    assert.equal(casualties.active, false);
    assert.equal(model.disposals, 1);
    assert.equal(laptop.disposals, 1);
  }
});

test('missing ground and mesh geometry never produce nonfinite positions', () => {
  const { parent, model, laptop } = rig();
  const casualties = new Casualties(parent, () => -Infinity);
  casualties.ascend('w', model, laptop);
  for (let i = 0; i < 300; i++) {
    casualties.update(1 / 60, i / 60);
    assert.ok(model.root.position.toArray().every(Number.isFinite));
  }
  casualties.clear();
});
