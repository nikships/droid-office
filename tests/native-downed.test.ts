import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FINISH_AFTER, HAUL_REACH, shootInWorld } from '../src/client/native/downed.js';
import { BLEED_TIME, beatGap, Casualties, type CasualtyLaptop, type CasualtyModel, FALL_TIME, type Medic } from '../src/client/world/casualties.js';
import { Worker } from '../src/client/world/character.js';
import { BloodSpray } from '../src/client/world/gun.js';

// The headset's shot: no dialog, every outcome a physical act at the body (native/downed.ts).

class Model implements CasualtyModel {
  readonly root = new THREE.Group();
  dead = false;
  update() {}
  die() {
    this.dead = true;
  }
  revive() {
    this.dead = false;
  }
  dispose() {}
}

const medic = (): Medic => ({ root: new THREE.Group(), update() {}, dispose() {} });
const laptop = (): CasualtyLaptop => ({ root: new THREE.Group(), shut: () => true, dispose() {} });

/** A floor with `n` seated workers, the casualties over it, and what was sent and heard. */
function office(n = 1) {
  const parent = new THREE.Group();
  const lands: THREE.Vector3[] = [];
  const beats: THREE.Vector3[] = [];
  const casualties = new Casualties(parent, () => 0, {
    spawnMedic: medic,
    onLand: (at) => void lands.push(at.clone()),
    onSiren() {},
    onBeat: (at) => void beats.push(at.clone()),
  });
  const workers = Array.from({ length: n }, (_, i) => {
    const seat = new THREE.Group();
    seat.position.set(i * 3, 0.4, 5);
    seat.rotation.y = Math.PI;
    parent.add(seat);
    const model = new Model();
    seat.add(model.root);
    return { id: `w${i + 1}`, seat, model };
  });
  const sent: string[] = [];
  const kills = new Set<string>();
  const bullet = new THREE.Vector3(1, -0.3, 0).normalize();
  /** One bullet into worker `i`, as main.ts resolves it in the headset. */
  const shoot = (i = 0) => {
    const w = workers[i];
    return shootInWorld(casualties, w.id, w.model, w.seat, bullet, kills, (id) => {
      kills.add(id);
      sent.push(id);
    });
  };
  let clock = 0;
  const run = (seconds: number, dt = 1 / 30) => {
    for (let t = 0; t < seconds - 1e-9; t += dt) casualties.update(dt, (clock += dt));
  };
  return { parent, casualties, workers, lands, beats, sent, shoot, run };
}

test('one shot only drops a worker: nothing is sent, and nothing but the body changes', () => {
  const o = office();
  assert.equal(o.shoot(), 'down');
  assert.equal(o.workers[0].model.dead, true);
  o.run(5);
  assert.deepEqual(o.sent, [], 'a stray shot never ends a session');
  assert.equal(o.casualties.dying('w1'), true, 'it lies there, session running, for as long as you leave it');
});

test('a second, aimed shot into the body once it has lain still finishes it off, exactly once', () => {
  const o = office();
  o.shoot();
  o.run(FALL_TIME + 0.05);
  assert.equal(o.casualties.lyingFor('w1')! < FINISH_AFTER, true);
  assert.equal(o.shoot(), 'hit', 'too soon after it landed: it only jerks');
  assert.deepEqual(o.sent, []);
  o.run(FINISH_AFTER);
  assert.equal(o.shoot(), 'finished');
  assert.deepEqual(o.sent, ['w1'], 'the ordinary kill goes out once');
  assert.equal(o.shoot(), 'hit', 'more bullets send nothing more');
  assert.deepEqual(o.sent, ['w1']);
  // The medics are the confirmation, when the removal arrives.
  assert.equal(o.casualties.confirm('w1', laptop()), true);
  assert.equal(o.shoot(), 'hit');
});

test('a string of trigger pulls as fast as the revolver allows takes FALL_TIME + FINISH_AFTER to finish anyone', () => {
  const o = office();
  const outcomes: string[] = [];
  let t = 0;
  for (; t < 4; t += 0.35) {
    outcomes.push(o.shoot());
    if (o.sent.length) break;
    o.run(0.35);
  }
  assert.equal(outcomes[0], 'down');
  assert.equal(outcomes.at(-1), 'finished');
  assert.ok(t >= FALL_TIME + FINISH_AFTER - 0.05, `finished ${t.toFixed(2)} s after the first shot, on pull ${outcomes.length}`);
  assert.ok(outcomes.length >= 5, 'a double or triple tap only drops it');
});

test('several workers can be down at once, each with its own fate', () => {
  const o = office(3);
  assert.equal(o.shoot(0), 'down');
  assert.equal(o.shoot(1), 'down');
  assert.equal(o.shoot(2), 'down');
  o.run(FALL_TIME + FINISH_AFTER + 0.1);
  assert.equal(o.shoot(1), 'finished');
  assert.deepEqual(o.sent, ['w2']);
  assert.equal(o.casualties.revive('w1'), true, 'the first gets up');
  assert.equal(o.casualties.dying('w3'), true, 'the third still lies there');
  assert.deepEqual(o.casualties.down().sort(), ['w2', 'w3']);
});

test('a body on the floor has a heartbeat that slows as it bleeds and stops once finished off', () => {
  const o = office();
  o.shoot();
  o.run(FALL_TIME - 0.1);
  assert.equal(o.beats.length, 0, 'no heartbeat mid-fall');
  o.run(4);
  assert.ok(o.beats.length >= 3, `${o.beats.length} beats in 4 s`);
  assert.ok(
    o.beats.every((at) => at.y < 0.6),
    'from its chest, down on the floor',
  );
  assert.ok(beatGap(1) > beatGap(0));
  o.run(BLEED_TIME);
  const before = o.beats.length;
  assert.equal(o.shoot(), 'finished');
  o.run(5);
  assert.equal(o.beats.length, before, 'flat');
});

test('a hand within reach takes hold; the body comes up toward its chair with the haul and slumps back when let go', () => {
  const o = office(2);
  o.shoot(0);
  o.shoot(1);
  o.run(FALL_TIME + 0.2);
  const root = o.workers[0].model.root;
  const lying = root.position.clone();
  const chest = o.casualties.chest('w1')!;
  assert.equal(o.casualties.reach(chest.clone().add(new THREE.Vector3(0, 0.3, 0)), HAUL_REACH), 'w1');
  assert.equal(o.casualties.reach(chest.clone().add(new THREE.Vector3(0, 1.2, 0)), HAUL_REACH), null, 'from standing height it is out of reach');
  assert.equal(o.casualties.haul('w1', 0.6), true);
  o.run(1 / 30);
  const seat = o.workers[0].seat.getWorldPosition(new THREE.Vector3());
  assert.ok(root.position.y > lying.y + 0.2, 'up off the floor');
  assert.ok(root.position.distanceTo(seat) < lying.distanceTo(seat), 'on its way back to its chair');
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(root.quaternion);
  assert.ok(up.y > 0.5, 'sitting up');
  assert.equal(o.workers[1].model.root.position.y < 0.1, true, 'the other body stays where it is');
  o.casualties.letGo('w1');
  const thuds = o.lands.length;
  o.run(0.5);
  assert.ok(root.position.distanceTo(lying) < 1e-6, 'back where it lay');
  assert.equal(o.lands.length, thuds + 1, 'it hits the floor again');
  assert.equal(o.casualties.dying('w1'), true, 'still down, session running');
});

test('hauled all the way it is revived back into its seat; a finished body cannot be hauled', () => {
  const o = office(2);
  o.shoot(0);
  o.shoot(1);
  o.run(FALL_TIME + FINISH_AFTER + 0.1);
  for (const lift of [0.2, 0.5, 0.9]) assert.equal(o.casualties.haul('w1', lift), true);
  assert.equal(o.casualties.revive('w1'), true);
  assert.equal(o.workers[0].model.root.parent, o.workers[0].seat);
  assert.equal(o.workers[0].model.dead, false);
  assert.equal(o.shoot(1), 'finished');
  assert.equal(o.casualties.haul('w2', 0.3), false);
  assert.equal(o.casualties.reach(o.casualties.chest('w2')!, HAUL_REACH), null, 'no hand takes hold of it');
});

test('another bullet jerks a body along the bullet where it lies, then it settles back', () => {
  const o = office();
  o.shoot();
  o.run(FALL_TIME + 0.2);
  const root = o.workers[0].model.root;
  const lying = root.position.clone();
  assert.equal(o.shoot(), 'hit');
  o.run(1 / 30);
  assert.ok(root.position.x - lying.x > 0.02, 'shoved along the bullet');
  o.run(1);
  assert.ok(root.position.distanceTo(lying) < 1e-3, 'settled where it lay');
});

test('collecting a body mid-haul lays it flat for the stretcher', () => {
  const o = office();
  o.shoot();
  o.run(FALL_TIME + 0.2);
  const root = o.workers[0].model.root;
  const lying = root.position.clone();
  o.casualties.haul('w1', 0.7);
  o.run(1 / 30);
  assert.equal(o.casualties.confirm('w1', laptop()), true);
  assert.ok(root.position.distanceTo(lying) < 1e-6);
});

test('every hit spray shares one sphere, so the headset uploads it once', () => {
  const a = new BloodSpray(new THREE.Vector3(), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1));
  const b = new BloodSpray(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1));
  assert.equal((a.group.children[0] as THREE.Mesh).geometry, (b.group.children[0] as THREE.Mesh).geometry);
  a.dispose();
  b.dispose();
});

test('a real worker lands flat and resting on the floor, not sunk into it, however it falls', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => {
        const canvas = { width: 1, height: 1, getContext: () => context };
        const context = new Proxy({ canvas, measureText: (text: string) => ({ width: text.length * 12 }) }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) });
        return canvas;
      },
    },
  });
  t.after(() => (previous ? Object.defineProperty(globalThis, 'document', previous) : Reflect.deleteProperty(globalThis, 'document')));
  const lowest = (root: THREE.Object3D) => {
    root.updateWorldMatrix(true, true);
    let low = Infinity;
    const v = new THREE.Vector3();
    root.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      const at = mesh.isMesh ? mesh.geometry.attributes.position : undefined;
      if (at) for (let i = 0; i < at.count; i++) low = Math.min(low, v.fromBufferAttribute(at, i).applyMatrix4(mesh.matrixWorld).y);
    });
    return low;
  };
  const rug = 0.021;
  for (let i = 0; i < 16; i++) {
    const parent = new THREE.Group();
    const seat = new THREE.Group();
    seat.position.set(0, 0.42, 0);
    seat.rotation.y = i * 0.7;
    parent.add(seat);
    const worker = new Worker('Target', '#86b2d4');
    seat.add(worker.root);
    worker.update(1 / 60, 1);
    const casualties = new Casualties(parent, () => rug, { spawnMedic: medic, onLand() {}, onSiren() {} });
    casualties.shoot('w', worker, seat, new THREE.Vector3(Math.cos(i), -0.2, Math.sin(i)));
    for (let k = 0; k < 40; k++) casualties.update(1 / 30, k / 30);
    const low = lowest(worker.root);
    assert.ok(low > rug - 0.01 && low < rug + 0.03, `fall ${i}: its lowest point is ${(low - rug).toFixed(3)} m off the rug`);
    const along = new THREE.Vector3(0, 1, 0).applyQuaternion(worker.root.quaternion);
    assert.ok(Math.abs(along.y) < 1e-6, `fall ${i}: lying flat`);
    const chest = casualties.chest('w')!;
    assert.ok(chest.y > rug && chest.y < 0.45, `fall ${i}: its chest within a hand's reach of the floor`);
    worker.dispose();
  }
});
