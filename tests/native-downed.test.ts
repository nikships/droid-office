import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { bodyAt, PendingShots, REVIVE_RANGE, REVIVE_TOUCH, SHOT_ECHO_MS } from '../src/client/native/downed.js';
import { BLEED_TIME, beatGap, beatStrength, Casualties, type CasualtyLaptop, type CasualtyModel, FALL_TIME, type Medic, POOL_R, poolSize, REVIVE_WINDOW, RISE_TIME } from '../src/client/world/casualties.js';
import { Worker } from '../src/client/world/character.js';
import { BloodSpray } from '../src/client/world/gun.js';

// The headset's shot on the owner's design: the server owns the revival window, the body tells its
// time in the world, and the use action at the body revives it (native/downed.ts).

class Model implements CasualtyModel {
  readonly root = new THREE.Group();
  dead = false;
  pulses: [number, number][] = [];
  update() {}
  die() {
    this.dead = true;
  }
  revive() {
    this.dead = false;
  }
  pulse(beat: number, life: number) {
    this.pulses.push([beat, life]);
  }
  dispose() {}
}

const medic = (): Medic => ({ root: new THREE.Group(), update() {}, dispose() {} });
const laptop = (): CasualtyLaptop => ({ root: new THREE.Group(), shut: () => true, dispose() {} });

/**
 * A floor with `n` seated workers and the headset's casualties over it: the server's deadlines
 * (`until`, seconds on `clock`), and what was heard, felt and stood back up.
 */
function office(n = 1, headset = true) {
  const parent = new THREE.Group();
  const lands: THREE.Vector3[] = [];
  const beats: { at: THREE.Vector3; strength: number; time: number }[] = [];
  const backs: string[] = [];
  const until = new Map<string, number>();
  let clock = 0;
  const casualties = new Casualties(parent, () => 0, {
    spawnMedic: medic,
    onLand: (at) => void lands.push(at.clone()),
    onSiren() {},
    onBack: (id) => void backs.push(id),
    ...(headset
      ? {
          onBeat: (at: THREE.Vector3, strength: number) => void beats.push({ at: at.clone(), strength, time: clock }),
          left: (id: string) => (until.has(id) ? until.get(id)! - clock : null),
          riseTime: RISE_TIME,
        }
      : {}),
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
  const bullet = new THREE.Vector3(1, -0.3, 0).normalize();
  /** One bullet into worker `i`, and the server's window for it. */
  const shoot = (i = 0) => {
    const w = workers[i];
    until.set(w.id, clock + REVIVE_WINDOW);
    return casualties.shoot(w.id, w.model, w.seat, bullet);
  };
  const run = (seconds: number, dt = 1 / 30) => {
    for (let t = 0; t < seconds - 1e-9; t += dt) casualties.update(dt, (clock += dt));
  };
  return { parent, casualties, workers, lands, beats, backs, until, shoot, run, now: () => clock };
}

test('the heartbeat keeps the server window: it slows and fades toward the deadline and stops there', () => {
  const o = office();
  o.shoot();
  o.run(FALL_TIME - 0.1);
  assert.equal(o.beats.length, 0, 'no heartbeat mid-fall');
  o.run(REVIVE_WINDOW + 3);
  const gaps = o.beats.slice(1).map((b, i) => b.time - o.beats[i].time);
  assert.ok(gaps.length > 12, `${o.beats.length} beats in the window`);
  assert.ok(gaps[0] < 0.85, `fast at first (${gaps[0].toFixed(2)} s)`);
  assert.ok(gaps.at(-1)! > 1.6, `dragging at the end (${gaps.at(-1)!.toFixed(2)} s)`);
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] >= gaps[i - 1] - 1 / 30 - 1e-9, 'never speeds up again');
  assert.ok(o.beats[0].strength > 0.9 && o.beats.at(-1)!.strength < 0.4, 'and fades');
  assert.ok(
    o.beats.every((b) => b.at.y < 0.6 && b.time < REVIVE_WINDOW + 1e-6),
    'from its chest on the floor, never past the deadline',
  );
  assert.ok(beatGap(1) > beatGap(0.5) && beatGap(0.5) > beatGap(0));
  assert.ok(beatStrength(1) < beatStrength(0));
});

test('its light flashes red with each beat over an ember that dims, and goes out at the deadline', () => {
  const o = office();
  const model = o.workers[0].model;
  o.shoot();
  o.run(FALL_TIME + 3);
  const early = model.pulses.slice(-90);
  assert.ok(Math.max(...early.map(([b]) => b)) > 0.8, 'a beat lights it up');
  assert.ok(Math.min(...early.map(([b]) => b)) < 0.1, 'and it dies away between beats');
  assert.ok(
    early.every(([, life]) => life > 0.8),
    'with nearly all its time left',
  );
  o.run(REVIVE_WINDOW - 6);
  assert.ok(model.pulses.at(-1)![1] < 0.15, 'its ember nearly gone near the deadline');
  o.run(4);
  assert.deepEqual(model.pulses.at(-1), [0, 0], 'out once the window has closed');
  const count = model.pulses.length;
  o.run(2);
  assert.equal(model.pulses.length, count, 'and it stays out');
});

test('the pool spreads at once, then creeps out to full size exactly at the deadline', () => {
  assert.ok(poolSize(2, 2 / REVIVE_WINDOW, true) < POOL_R * 0.5);
  assert.ok(Math.abs(poolSize(REVIVE_WINDOW, 1, true) - POOL_R) < 1e-9);
  for (let s = 1; s < REVIVE_WINDOW; s++) assert.ok(poolSize(s + 1, (s + 1) / REVIVE_WINDOW, true) > poolSize(s, s / REVIVE_WINDOW, true), `still growing at ${s} s`);
  assert.equal(poolSize(BLEED_TIME, 1, false), POOL_R, 'the desktop keeps its six-second spread');
  const o = office();
  const before = new Set(o.parent.children);
  o.shoot();
  const pool = o.parent.children.find((c) => !before.has(c) && c !== o.workers[0].model.root)!;
  o.run(FALL_TIME + 10);
  assert.ok(pool.scale.x > 0.3 && pool.scale.x < POOL_R * 0.75, `a third of the way in, the pool is ${pool.scale.x.toFixed(2)}`);
});

test('a hand is at a body when its grip is within reach of any part of it, or its ray points at it from close by', () => {
  const o = office(2);
  o.shoot(0);
  o.shoot(1);
  o.run(FALL_TIME + 0.2);
  const chest = o.casualties.chest('w1')!;
  const nowhere = new THREE.Vector3(0, 50, 0);
  assert.equal(bodyAt(o.casualties, chest.clone().add(new THREE.Vector3(0, 0.35, 0)), null), 'w1', 'a hand just above it');
  assert.equal(bodyAt(o.casualties, chest.clone().add(new THREE.Vector3(0, 1.1, 0)), null), null, 'a hand at standing height is not at it');
  const from = chest.clone().add(new THREE.Vector3(0, 1, 1.4));
  const ray = new THREE.Ray(from, chest.clone().sub(from).normalize());
  assert.ok(from.distanceTo(chest) < REVIVE_RANGE);
  assert.equal(bodyAt(o.casualties, nowhere, ray), 'w1', 'pointing at it from a step away');
  const far = chest.clone().add(new THREE.Vector3(0, 1, 2.6));
  assert.equal(bodyAt(o.casualties, nowhere, new THREE.Ray(far, chest.clone().sub(far).normalize())), null, `not from beyond ${REVIVE_RANGE} m`);
  assert.equal(bodyAt(o.casualties, nowhere, new THREE.Ray(from, new THREE.Vector3(0, 0, 1))), null, 'not pointing away');
  assert.equal(bodyAt(o.casualties, chest.clone().add(new THREE.Vector3(0, REVIVE_TOUCH - 0.05, 0)), new THREE.Ray(from, new THREE.Vector3(0, 0, 1))), 'w1', 'touch wins over a stray ray');
  o.run(REVIVE_WINDOW);
  assert.equal(bodyAt(o.casualties, chest, ray), null, 'nothing to revive once the window has closed');
});

test('roused, it stirs at once; revived by the server, it gets back up into its chair and the office is told once', () => {
  const o = office();
  o.shoot();
  o.run(FALL_TIME + 1);
  const { model, seat } = o.workers[0];
  const lying = model.root.position.clone();
  const chair = seat.getWorldPosition(new THREE.Vector3());
  assert.equal(o.casualties.rouse('w1'), true);
  assert.equal(o.casualties.rouse('w1'), false, 'one rouse at a time');
  assert.equal(o.casualties.roused('w1'), true);
  o.run(0.15);
  const stirred = model.root.position.clone();
  assert.ok(stirred.distanceTo(chair) < lying.distanceTo(chair), 'it stirs toward its chair');
  assert.ok(model.dead, 'still down until the server says');
  // The server's revival arrives mid-stir: it carries on up, without a jump.
  assert.equal(o.casualties.revive('w1'), true);
  assert.equal(o.casualties.dying('w1'), false, 'no longer down');
  assert.equal(o.casualties.revive('w1'), false, 'already on its way up');
  let last = stirred.distanceTo(chair);
  for (let i = 0; i < Math.ceil(RISE_TIME * 30) + 2; i++) {
    o.run(1 / 30);
    if (model.root.parent === seat) break;
    const d = model.root.position.distanceTo(chair);
    assert.ok(d <= last + 1e-6, 'steadily back toward its chair');
    last = d;
  }
  assert.equal(model.root.parent, seat, `back in its seat within ${RISE_TIME} s`);
  assert.equal(model.dead, false);
  assert.deepEqual(o.backs, ['w1']);
  assert.equal(o.casualties.phaseOf('w1'), null);
});

test('a rouse the server never answers slumps back with a thud, and the body can be roused again', () => {
  const o = office();
  o.shoot();
  o.run(FALL_TIME + 1);
  const lying = o.workers[0].model.root.position.clone();
  const thuds = o.lands.length;
  o.casualties.rouse('w1');
  o.run(4);
  assert.ok(o.workers[0].model.root.position.distanceTo(lying) < 1e-6, 'back where it lay');
  assert.equal(o.lands.length, thuds + 1, 'it hits the floor again');
  assert.equal(o.casualties.dying('w1'), true, 'still down, session running');
  assert.equal(o.casualties.rouse('w1'), true);
});

test('the window closing under a stirring body: it slumps back and the medics take it flat', () => {
  const o = office();
  o.shoot();
  o.run(FALL_TIME + 1);
  const lying = o.workers[0].model.root.position.clone();
  o.until.set('w1', o.now() + 0.1);
  o.casualties.rouse('w1');
  o.run(0.2);
  assert.equal(o.casualties.roused('w1'), false, 'the window closed under it');
  assert.equal(o.casualties.rouse('w1'), false);
  assert.equal(o.casualties.confirm('w1', laptop()), true);
  o.run(0.5);
  assert.ok(o.workers[0].model.root.position.distanceTo(lying) < 1e-6, 'flat for the stretcher');
});

test('shot again while still getting back up, it is put in its chair first and falls again', () => {
  const o = office();
  o.shoot();
  o.run(FALL_TIME + 1);
  o.casualties.revive('w1');
  o.run(0.2);
  assert.equal(o.shoot(), true, 'a fresh fall');
  assert.deepEqual(o.backs, ['w1']);
  assert.equal(o.casualties.dying('w1'), true);
  o.run(FALL_TIME + 0.1);
  assert.ok(o.casualties.lyingFor('w1')! >= 0);
});

test('settle puts a body still getting up straight into its seat; a body still down is left alone', () => {
  const o = office(2);
  o.shoot(0);
  o.shoot(1);
  o.run(FALL_TIME + 1);
  o.casualties.revive('w1');
  o.casualties.settle('w1');
  o.casualties.settle('w2');
  assert.equal(o.workers[0].model.root.parent, o.workers[0].seat);
  assert.equal(o.casualties.dying('w2'), true);
});

test('the desktop keeps main: no heartbeat, its own six-second pool, and revival straight back into the seat', () => {
  const o = office(1, false);
  o.shoot();
  o.run(FALL_TIME + 1);
  assert.equal(o.beats.length, 0);
  assert.deepEqual(o.workers[0].model.pulses, []);
  assert.equal(o.casualties.revive('w1'), true);
  assert.equal(o.workers[0].model.root.parent, o.workers[0].seat);
  assert.deepEqual(o.backs, ['w1']);
});

test('a shot resolved here keeps its local fall until the server echoes it, or for SHOT_ECHO_MS', () => {
  const p = new PendingShots();
  p.add('w1', 1000);
  assert.equal(p.holds('w1', 1000 + SHOT_ECHO_MS - 1), true);
  assert.equal(p.holds('w2', 1000), false);
  p.settle('w1');
  assert.equal(p.holds('w1', 1001), false, 'echoed');
  p.add('w1', 1000);
  assert.equal(p.holds('w1', 1000 + SHOT_ECHO_MS), false, 'never echoed: it gets back up');
  assert.equal(p.holds('w1', 1001), false, 'and is forgotten');
  p.add('w3', 0);
  p.clear();
  assert.equal(p.holds('w3', 1), false);
});

function stubCanvas(t: { after(fn: () => void): void }) {
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
}

test("a real worker's light shows the heartbeat while down and its status again once revived", (t) => {
  stubCanvas(t);
  const worker = new Worker('Target', '#86b2d4');
  const bulb = (worker as unknown as { bulb: { mat: THREE.MeshToonMaterial } }).bulb.mat;
  const lit = bulb.emissive.clone();
  worker.pulse(1, 1);
  assert.deepEqual(bulb.emissive.toArray(), lit.toArray(), 'nothing while it is up');
  worker.die();
  worker.pulse(1, 1);
  assert.ok(bulb.emissive.r > 0.8 && bulb.emissive.g < 0.2, 'red at the beat');
  worker.pulse(0, 0.5);
  assert.ok(bulb.emissive.r > 0 && bulb.emissive.r < 0.15, 'an ember between beats');
  worker.pulse(0, 0);
  assert.equal(bulb.emissive.getHex(), 0, 'out');
  worker.revive();
  assert.ok(bulb.emissive.r + bulb.emissive.g + bulb.emissive.b > 0.1, 'its status light again');
  worker.dispose();
});

test('every hit spray shares one sphere, so the headset uploads it once', () => {
  const a = new BloodSpray(new THREE.Vector3(), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1));
  const b = new BloodSpray(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1));
  assert.equal((a.group.children[0] as THREE.Mesh).geometry, (b.group.children[0] as THREE.Mesh).geometry);
  a.dispose();
  b.dispose();
});

test('a real worker lands flat and resting on the floor, not sunk into it, however it falls', (t) => {
  stubCanvas(t);
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
