import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { Casualties, CasualtyClock } from '../src/client/world/casualties';
import type { Worker } from '../src/client/world/character';
import type { Laptop } from '../src/client/world/laptop';
import type { DeskView } from '../src/client/world/office';

function fixture() {
  const scene = new THREE.Scene();
  const seat = new THREE.Group();
  seat.position.set(2, 0.7, 3);
  scene.add(seat);
  const root = new THREE.Group();
  root.position.set(0.2, 0.1, 0.3);
  root.rotation.y = 0.4;
  seat.add(root);
  let dead = false;
  let revived = false;
  let disposed = false;
  const model = {
    root,
    walking: false,
    stopDancing() {},
    die() {
      dead = true;
    },
    revive() {
      revived = true;
      dead = false;
    },
    update() {},
    dispose() {
      disposed = true;
    },
  } as unknown as Worker;
  const laptopRoot = new THREE.Group();
  const laptop = {
    root: laptopRoot,
    shut() {
      return true;
    },
    dispose() {
      laptopRoot.clear();
    },
  } as unknown as Laptop;
  const desk = { def: { id: 'desk-1' } } as DeskView;
  const events = { thuds: 0, medics: 0, settled: 0 };
  const casualties = new Casualties(
    scene,
    () => 0,
    () => events.settled++,
    {
      thud: () => events.thuds++,
      medic: () => events.medics++,
    },
  );
  return { scene, seat, root, model, laptop, desk, casualties, events, state: () => ({ dead, revived, disposed }) };
}

test('fall timeline lands, waits indefinitely for a choice, and revive resets its clock', () => {
  const clock = new CasualtyClock('fall');
  const halfway = clock.tick(0.36);
  assert.equal(halfway.complete, false);
  assert.ok(halfway.progress > 0.49 && halfway.progress < 0.51);
  assert.equal(clock.tick(0.36).complete, true);
  clock.enter('preview');
  assert.equal(clock.tick(30).complete, false);
  clock.enter('revive');
  assert.equal(clock.elapsed, 0);
  assert.equal(clock.tick(0.36).complete, false);
  assert.equal(clock.tick(0.36).complete, true);
});

test('preview holds the seat and session, then Revive restores the exact seat transform', () => {
  const f = fixture();
  const localPosition = f.root.position.clone();
  const localRotation = f.root.quaternion.clone();
  assert.equal(f.casualties.preview('worker-1', f.model, f.desk), true);
  assert.equal(f.state().dead, true);
  assert.equal(f.root.parent, f.scene);
  assert.equal(f.casualties.seated('desk-1'), true);
  assert.equal(f.casualties.busy(), true);
  assert.equal(f.casualties.preview('worker-2', f.model, f.desk), false);
  f.casualties.update(0.72);
  assert.equal(f.events.thuds, 1);
  assert.equal(f.casualties.revive('worker-1'), true);
  f.casualties.update(0.36);
  assert.equal(f.root.parent, f.scene);
  f.casualties.update(0.36);
  assert.equal(f.root.parent, f.seat);
  assert.ok(f.root.position.distanceTo(localPosition) < 1e-7);
  assert.ok(1 - Math.abs(f.root.quaternion.dot(localRotation)) < 1e-7);
  assert.equal(f.state().revived, true);
  assert.equal(f.casualties.busy(), false);
  assert.equal(f.casualties.seated('desk-1'), false);
  assert.equal(f.events.settled, 1);
  assert.equal(f.events.medics, 0);
});

test('disconnect or floor cancellation restores an unconfirmed preview without cleanup', () => {
  const f = fixture();
  assert.equal(f.casualties.preview('worker-1', f.model, f.desk), true);
  assert.equal(f.casualties.cancel('worker-1'), true);
  assert.equal(f.root.parent, f.seat);
  assert.equal(f.state().dead, false);
  assert.equal(f.casualties.busy(), false);
  assert.equal(f.events.settled, 0);
  assert.equal(f.casualties.cancel('worker-1'), false);
});

test('confirmed removal sends one crew to the elevator, then frees the seat and disposes temporary visuals', () => {
  const f = fixture();
  assert.equal(f.casualties.preview('worker-1', f.model, f.desk), true);
  f.casualties.update(0.72);
  assert.equal(f.casualties.confirmedRemoval('worker-1', f.laptop), true);
  assert.equal(f.events.medics, 1);
  assert.equal(f.casualties.seated('desk-1'), true);
  assert.equal(f.casualties.confirmedRemoval('worker-1', f.laptop), false);
  for (let i = 0; i < 500 && f.casualties.busy(); i++) f.casualties.update(0.1);
  assert.equal(f.casualties.busy(), false);
  assert.equal(f.casualties.seated('desk-1'), false);
  assert.equal(f.events.settled, 1);
  assert.equal(f.state().disposed, true);
});

test('medics can take as long as needed to approach/carry; load and fade have fixed durations', () => {
  const clock = new CasualtyClock('approach');
  assert.equal(clock.tick(60).complete, false);
  clock.enter('load');
  assert.equal(clock.tick(1).complete, false);
  assert.equal(clock.tick(0.5).complete, true);
  clock.enter('carry');
  assert.equal(clock.tick(60).complete, false);
  clock.enter('fade');
  assert.equal(clock.tick(0.6).complete, true);
});

test('negative frame deltas never reverse a casualty timeline', () => {
  const clock = new CasualtyClock('fall');
  assert.deepEqual(clock.tick(-1), { progress: 0, complete: false });
  assert.equal(clock.elapsed, 0);
  assert.equal(clock.tick(0.72).complete, true);
});
