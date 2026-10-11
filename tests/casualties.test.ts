import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ASCEND_HEIGHT, ASCEND_TIME, BEAM_TIME, BLEED_TIME, Casualties, FADE_TIME, FALL_TIME, POOL_R, SPELL_TIME, type CasualtyLaptop, type CasualtyModel } from '../src/client/world/casualties.js';
import { WALL_HEIGHT } from '../src/shared/layout.js';

class Model implements CasualtyModel {
  readonly root = new THREE.Group();
  dead = false;
  asleep = false;
  disposed = false;
  updates = 0;
  update(_dt: number, _t: number) {
    this.updates++;
  }
  die(asleep = false) {
    this.dead = true;
    this.asleep = asleep;
  }
  revive() {
    this.dead = false;
  }
  dispose() {
    this.disposed = true;
  }
}

class LaptopStub implements CasualtyLaptop {
  readonly root = new THREE.Group();
  shuts = 0;
  disposed = false;
  shut(_dt: number) {
    return ++this.shuts > 3;
  }
  dispose() {
    this.disposed = true;
  }
}

function rig() {
  const parent = new THREE.Group();
  const seat = new THREE.Group();
  seat.position.set(0, 0.4, 5);
  seat.rotation.y = Math.PI;
  parent.add(seat);
  const lands: THREE.Vector3[] = [];
  const landLooks: string[] = [];
  const casualties = new Casualties(parent, () => 0, {
    onLand: (at, look) => {
      lands.push(at.clone());
      landLooks.push(look);
    },
  });
  const model = new Model();
  seat.add(model.root);
  const frames = (n: number, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) casualties.update(dt, i * dt);
  };
  return { parent, seat, lands, landLooks, casualties, model, frames };
}

/** What's on the floor under a body: the blood pool or the spell circle (the casualty's only other child of the parent). */
function under(parent: THREE.Object3D, model: Model): THREE.Object3D | undefined {
  return parent.children.find((o) => o !== model.root && o.type === 'Group' && o.children.length && o.name !== 'heavenly-beam' && o.position.y > 0);
}

test('the wand puts it to sleep on a spell circle instead of a blood pool, and the rest of the scene is the same', () => {
  const { parent, seat, landLooks, casualties, model, frames } = rig();
  assert.equal(casualties.lookOf('w1'), null);
  assert.equal(casualties.shoot('w1', model, seat, 'spell'), true);
  assert.equal(casualties.lookOf('w1'), 'spell');
  assert.equal(model.asleep, true, 'eyes shut, asleep');
  const circle = under(parent, model);
  assert.equal(circle?.name, 'spell-circle');
  assert.equal(circle.children.filter((o) => o.name === 'spell-star').length, 4, 'stars circling over it');
  frames(Math.ceil(FALL_TIME * 60) + 2);
  assert.equal(casualties.phaseOf('w1'), 'bled');
  assert.deepEqual(landLooks, ['spell'], 'it dozes off rather than thuds');
  const turned = circle.rotation.y;
  frames(Math.ceil(SPELL_TIME * 60) + 1);
  assert.ok(circle.rotation.y > turned, 'the circle turns while the spell holds');
  assert.ok(Math.abs(circle.scale.x - POOL_R) < 1e-6, 'opens to the pool size well before blood would spread');
  assert.ok(SPELL_TIME < BLEED_TIME / 2);
  assert.equal(casualties.revive('w1'), true);
  assert.equal(circle.parent, null, 'gone with the spell');
  assert.equal(model.dead, false);
});

test('the Magnum still leaves a blood pool, face slack', () => {
  const { parent, seat, landLooks, casualties, model, frames } = rig();
  casualties.shoot('w1', model, seat);
  assert.equal(casualties.lookOf('w1'), 'blood');
  assert.equal(model.asleep, false);
  assert.notEqual(under(parent, model)?.name, 'spell-circle');
  frames(Math.ceil(FALL_TIME * 60) + 2);
  assert.deepEqual(landLooks, ['blood']);
});

test('one shot drops it out of its chair with a thud, and it bleeds out where it lands', () => {
  const { seat, lands, casualties, model, frames } = rig();
  assert.equal(casualties.active, false);
  assert.equal(casualties.shoot('w1', model, seat), true);
  assert.equal(casualties.active, true);
  assert.equal(casualties.shoot('w1', model, seat), false, 'no second scene for the same worker');
  assert.equal(casualties.phaseOf('w1'), 'fall');
  assert.equal(casualties.dying('w1'), true);
  assert.equal(model.dead, true);
  frames(Math.ceil(FALL_TIME * 60) + 2);
  assert.equal(casualties.phaseOf('w1'), 'bled');
  assert.equal(lands.length, 1, 'one thud as it lands');
  // Sideways out of the chair into the open (not forward under the desk), down on the floorboards, tipped over.
  assert.ok(Math.abs(Math.abs(model.root.position.x) - 0.65) < 0.01);
  assert.ok(Math.abs(model.root.position.z - 5) < 0.01);
  assert.ok(Math.abs(model.root.position.y - -0.07) < 0.01);
  assert.ok(Math.abs(model.root.rotation.x) > 1, 'flat on the floor');
  assert.ok(model.root.parent !== seat, 'out of its seat');
});

test('revive stands it back up in its seat with nothing disposed', () => {
  const { seat, casualties, model, frames } = rig();
  assert.equal(casualties.revive('nobody'), false);
  casualties.shoot('w1', model, seat);
  frames(10);
  assert.equal(casualties.revive('w1'), true, 'mid-fall too');
  assert.equal(casualties.revive('w1'), false, 'nothing left to revive');
  assert.equal(casualties.active, false);
  assert.equal(model.dead, false);
  assert.equal(model.disposed, false);
  assert.equal(model.root.parent, seat);
  assert.deepEqual(model.root.position.toArray(), [0, 0, 0]);
  assert.deepEqual([model.root.rotation.x, model.root.rotation.y, model.root.rotation.z], [0, 0, 0]);
});

test('revival targets a nearby fallen worker, not a distant body or a different storey', () => {
  const { seat, casualties, model, frames } = rig();
  casualties.shoot('w1', model, seat);
  frames(60);
  const at = model.root.position;
  assert.equal(casualties.nearby({ x: at.x, y: 0, z: at.z }), 'w1');
  assert.equal(casualties.nearby({ x: at.x + 2.3, y: 0, z: at.z }), 'w1');
  assert.equal(casualties.nearby({ x: at.x + 2.5, y: 0, z: at.z }), null);
  assert.equal(casualties.nearby({ x: at.x, y: 4, z: at.z }), null);
  casualties.revive('w1');
  assert.equal(casualties.nearby({ x: at.x, y: 0, z: at.z }), null);
});

test('revival picks the nearest casualty and excludes bodies already being collected', () => {
  const { parent, seat, casualties, model, frames } = rig();
  const seat2 = new THREE.Group();
  seat2.position.set(4, 0.4, 5);
  parent.add(seat2);
  const model2 = new Model();
  seat2.add(model2.root);
  casualties.shoot('w1', model, seat);
  casualties.shoot('w2', model2, seat2);
  frames(60);
  const at = model2.root.position.clone();
  assert.equal(casualties.nearby(at), 'w2');
  casualties.confirm('w2', new LaptopStub());
  assert.equal(casualties.nearby(at), null);
  assert.equal(casualties.nearby(model.root.position), 'w1');
});

test('a confirmed kill casts a heavenly beam and floats the worker straight through the ceiling', () => {
  const { parent, seat, casualties, model, frames } = rig();
  assert.equal(casualties.confirm('nobody', new LaptopStub()), false);
  casualties.shoot('w1', model, seat);
  frames(Math.ceil((FALL_TIME + BLEED_TIME) * 60), 1 / 60);
  const laptop = new LaptopStub();
  assert.equal(casualties.confirm('w1', laptop), true);
  assert.equal(casualties.confirm('w1', laptop), false, 'one beam per body');
  assert.equal(casualties.dying('w1'), false, 'no longer available for revival');
  assert.equal(casualties.revive('w1'), false, 'too late to revive');
  assert.equal(casualties.phaseOf('w1'), 'beam');
  assert.equal(parent.getObjectByName('medic-team'), undefined);
  const beam = parent.getObjectByName('heavenly-beam')!;
  assert.ok(beam);
  const start = model.root.position.clone();
  const scale = model.root.scale.clone();
  frames(Math.ceil(BEAM_TIME * 60) + 1);
  assert.equal(casualties.phaseOf('w1'), 'ascend');
  assert.ok(model.root.position.y < start.y + 0.01, 'the beam appears before lifting');
  let previousY = model.root.position.y;
  for (let i = 0; i < Math.ceil(ASCEND_TIME * 60) + 1; i++) {
    frames(1);
    assert.equal(model.root.position.x, start.x, 'no sideways drift');
    assert.equal(model.root.position.z, start.z, 'no sideways drift');
    assert.ok(model.root.position.y >= previousY, 'only rises');
    assert.ok(model.root.scale.equals(scale), 'no shrinking');
    assert.equal(model.root.parent, parent);
    previousY = model.root.position.y;
  }
  assert.equal(casualties.phaseOf('w1'), 'fade');
  assert.ok(model.root.position.y > WALL_HEIGHT + 1, 'the whole body clears the ceiling');
  assert.ok(Math.abs(model.root.position.y - start.y - ASCEND_HEIGHT) < 1e-9);
  frames(Math.ceil(FADE_TIME * 60) + 2);
  assert.equal(casualties.phaseOf('w1'), null);
  assert.equal(model.disposed, true);
  assert.ok(laptop.shuts > 3 && laptop.disposed, 'the laptop shut and shrank');
  assert.equal(beam.parent, null);
  assert.equal(under(parent, model), undefined, 'no stain left');
  assert.equal(casualties.active, false);
});

test('confirming mid-fall lands once, then the empty beam fades in FADE_TIME', () => {
  const { parent, seat, lands, casualties, model, frames } = rig();
  casualties.shoot('w1', model, seat);
  casualties.confirm('w1', new LaptopStub());
  assert.equal(lands.length, 1);
  assert.equal(casualties.phaseOf('w1'), 'beam');
  const column = parent.getObjectByName('beam-column') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  let guard = 0;
  while (casualties.phaseOf('w1') !== 'fade' && guard++ < 400) frames(1);
  assert.equal(casualties.phaseOf('w1'), 'fade');
  const opacity = column.material.opacity;
  frames(Math.floor(FADE_TIME * 30));
  assert.ok(column.material.opacity > 0 && column.material.opacity < opacity);
  frames(Math.ceil(FADE_TIME * 60) + 2);
  assert.equal(casualties.phaseOf('w1'), null, 'gone with the body, no stain left');
  assert.equal(lands.length, 1, 'no repeated landing');
});

test('clear ends every scene: the dying go back in their seats, the collected are disposed', () => {
  const { parent, seat, casualties, model } = rig();
  const seat2 = new THREE.Group();
  seat2.position.set(2, 0.4, 5);
  seat.parent!.add(seat2);
  const model2 = new Model();
  seat2.add(model2.root);
  casualties.shoot('w1', model, seat);
  casualties.shoot('w2', model2, seat2);
  casualties.confirm('w2', new LaptopStub());
  casualties.clear();
  assert.equal(casualties.phaseOf('w1'), null);
  assert.equal(casualties.phaseOf('w2'), null);
  assert.equal(model.root.parent, seat, 'still the office’s to dispose');
  assert.equal(model.disposed, false);
  assert.equal(model2.disposed, true, 'collected bodies go with the floor');
  assert.equal(parent.getObjectByName('heavenly-beam'), undefined);
  assert.equal(casualties.dying('w1'), false);
});

test('the blood pool geometry is shared and the constants sanity-check', () => {
  assert.ok(FALL_TIME > 0 && FALL_TIME < 2);
  assert.ok(BEAM_TIME > 0 && BEAM_TIME < 2);
  assert.ok(ASCEND_TIME > 2 && ASCEND_TIME < 6, 'a short, readable ascent');
  assert.ok(ASCEND_HEIGHT > WALL_HEIGHT + 1);
  assert.ok(POOL_R > 0.5 && POOL_R < 1.5);
  assert.ok(FADE_TIME > 0 && FADE_TIME < 2);
});
