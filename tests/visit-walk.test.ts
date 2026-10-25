import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { DESK_BY_ID } from '../src/shared/layout.js';
import { VISIT_HOP_MS, VISIT_WALK_SPEED, visitRoute, visitSpot, visitWalkMs, type Visit } from '../src/shared/visits.js';
import { CATCH_UP, pointAlong, routeLength, SAY_MAX, SEATED, sayFor, stepProgress, trimSay, visitProgress } from '../src/client/world/visit-path.js';
import { Visitors, type Seated } from '../src/client/world/visitors.js';

const HOP = VISIT_HOP_MS / 1000;
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

test('a visitor gets up, walks at the visit speed and stands on its spot', () => {
  const L = 10;
  assert.equal(visitProgress('walking', 0, L), SEATED);
  near(visitProgress('walking', VISIT_HOP_MS / 2, L), -0.5);
  near(visitProgress('walking', VISIT_HOP_MS + 1000, L), VISIT_WALK_SPEED);
  assert.equal(visitProgress('walking', 60_000, L), L, 'a walk the server has not ended yet waits on the spot');
  assert.equal(visitProgress('walking', -500, L), SEATED, 'a phase that starts after now has not started');
  for (const phase of ['reading', 'talking', 'waiting'] as const) assert.equal(visitProgress(phase, 1234, L), L);
  assert.equal(visitProgress(null, 0, L), SEATED);
});

test('walking back is the walk over reversed, then sitting down', () => {
  const L = 8;
  assert.equal(visitProgress('returning', 0, L), L);
  near(visitProgress('returning', 1000, L), L - VISIT_WALK_SPEED);
  near(visitProgress('returning', (L / VISIT_WALK_SPEED) * 1000 + VISIT_HOP_MS / 2, L), -0.5);
  assert.equal(visitProgress('returning', 60_000, L), SEATED);
});

test('the client walk takes exactly as long as the server times it', () => {
  const path = visitRoute('desk-3', 'desk-9', 1);
  const L = routeLength(path);
  const ms = visitWalkMs(path);
  near(visitProgress('walking', ms, L), L, 1e-2);
  assert.ok(visitProgress('walking', ms - 100, L) < L);
  near(visitProgress('returning', ms, L), SEATED, 1e-2);
  assert.ok(visitProgress('returning', ms - 100, L) > SEATED);
});

test('progress catches up no faster than CATCH_UP times the walk, across the hop, without overshooting', () => {
  const L = 5;
  near(stepProgress(2, 4, 0.1, L), 2 + CATCH_UP * VISIT_WALK_SPEED * 0.1);
  assert.equal(stepProgress(2, 2.01, 1, L), 2.01);
  // Off the seat and onto the route in one step: the whole hop takes HOP / CATCH_UP.
  const t = HOP / CATCH_UP + 0.1;
  near(stepProgress(SEATED, L, t, L), CATCH_UP * VISIT_WALK_SPEED * 0.1);
  // And back down onto it.
  near(stepProgress(0.1, SEATED, 0.1 / (CATCH_UP * VISIT_WALK_SPEED) + HOP / CATCH_UP / 2, L), -0.5);
  assert.equal(stepProgress(1, SEATED, 100, L), SEATED);
  assert.equal(stepProgress(SEATED, 99, 100, L), L, 'clamped to the route');
  assert.equal(stepProgress(3, 4, 0, L), 3);
});

test('a point along a route, and the way along it', () => {
  const path: [number, number][] = [
    [0, 0],
    [2, 0],
    [2, 3],
  ];
  const out = { x: 0, z: 0, heading: 0 };
  pointAlong(path, 1, out);
  assert.deepEqual([out.x, out.z], [1, 0]);
  near(out.heading, Math.PI / 2, 1e-9);
  pointAlong(path, 3.5, out);
  assert.deepEqual([out.x, out.z], [2, 1.5]);
  near(out.heading, 0, 1e-9);
  pointAlong(path, 99, out);
  assert.deepEqual([out.x, out.z], [2, 3]);
  pointAlong(path, -1, out);
  assert.deepEqual([out.x, out.z], [0, 0]);
  assert.equal(routeLength(path), 5);
  pointAlong([], 1, out);
  assert.deepEqual([out.x, out.z], [0, 0]);
});

test('what a visitor says is put on one readable line and cut at a word', () => {
  assert.equal(trimSay('  Can you\nlook at\tthe failing test?  '), 'Can you look at the failing test?');
  assert.equal(trimSay('\u001b[1;32mgreen\u001b[0m and \u001b]0;title\u0007plain\u0000end'), 'green and plain end');
  assert.equal(trimSay('\u001b]8;;https://x\u001b\\link'), 'link');
  const long = 'word '.repeat(80);
  const cut = trimSay(long);
  assert.ok(Array.from(cut).length <= SAY_MAX);
  assert.ok(cut.endsWith('word…'), cut);
  const unbroken = 'x'.repeat(300);
  assert.equal(Array.from(trimSay(unbroken)).length, SAY_MAX);
  assert.equal(trimSay(''), '');
  assert.equal(sayFor('hi'), 2.6);
  assert.equal(sayFor(long), 9);
});

/** A worker's model as Visitors uses it, without the meshes. */
function fakeModel() {
  return { root: new THREE.Group(), visitPose: null as string | null, walking: false, lean: 0, stopDancing() {} };
}

/** A desk's group and seat anchor, placed the way office.ts builds a desk. */
function fakeDesk(id: string) {
  const def = DESK_BY_ID.get(id)!;
  const group = new THREE.Group();
  group.position.set(def.x, 0, def.z);
  group.rotation.y = def.rotY;
  const seatAnchor = new THREE.Object3D();
  seatAnchor.position.set(0, 0.4, 0.93);
  seatAnchor.rotation.y = Math.PI;
  seatAnchor.scale.setScalar(0.82);
  group.add(seatAnchor);
  return { def, group, seatAnchor };
}

function floor(desks: Record<string, string>) {
  const scene = new THREE.Scene();
  const seats = new Map<string, Seated>();
  for (const [worker, desk] of Object.entries(desks)) {
    const d = fakeDesk(desk);
    scene.add(d.group);
    const model = fakeModel();
    d.seatAnchor.add(model.root);
    seats.set(worker, { model, desk: d } as unknown as Seated);
  }
  const clock = { now: 1_000_000 };
  const visitors = new Visitors(
    scene,
    () => 0.07,
    (id) => seats.get(id),
    () => clock.now,
  );
  const run = (seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) {
      clock.now += 1000 / 60;
      visitors.update(1 / 60);
    }
  };
  return { scene, seats, clock, visitors, run };
}

const visit = (o: Partial<Visit> & Pick<Visit, 'phase' | 'since'>): Visit => ({ id: 'v1', visitor: 'a', host: 'h', kind: 'ask', slot: 0, ...o });

test('a visitor walks over, leans in while reading, and sits back exactly where it was', () => {
  const { seats, clock, visitors, run } = floor({ a: 'desk-3', h: 'desk-9' });
  const a = seats.get('a')!;
  const seat = a.model.root.parent;
  const path = visitRoute('desk-3', 'desk-9', 0);
  const walk = visitWalkMs(path);
  visitors.sync([visit({ phase: 'walking', since: clock.now })]);
  run(0.3);
  assert.equal(visitors.info('a')?.step, 'getting up');
  assert.notEqual(a.model.root.parent, seat, 'off its seat, into the scene');
  run(HOP + 0.5);
  assert.equal(visitors.info('a')?.step, 'walking');
  assert.equal(a.model.walking, true);
  assert.equal(a.model.visitPose, 'stand');
  run(walk / 1000);
  const spot = visitSpot('desk-9', 0);
  const at = visitors.info('a')!;
  assert.equal(at.step, 'at spot');
  near(at.x, spot.x, 1e-3);
  near(at.z, spot.z, 1e-3);
  assert.equal(a.model.walking, false);
  visitors.sync([visit({ phase: 'reading', since: clock.now })]);
  run(0.5);
  assert.equal(a.model.visitPose, 'peer');
  assert.ok(Math.abs(wrap(visitors.info('a')!.facing - spot.rotY)) < 0.05, 'faces the host’s laptop');
  visitors.sync([visit({ phase: 'waiting', since: clock.now })]);
  run(0.1);
  assert.equal(a.model.visitPose, 'stand');
  visitors.sync([visit({ phase: 'returning', since: clock.now })]);
  run(1);
  assert.equal(visitors.info('a')?.step, 'walking back');
  run(walk / 1000);
  assert.equal(a.model.root.parent, seat, 'back on its own seat');
  assert.deepEqual(a.model.root.position.toArray(), [0, 0, 0]);
  assert.equal(a.model.root.rotation.y, 0);
  assert.equal(a.model.root.scale.x, 1);
  assert.equal(a.model.visitPose, null);
  assert.equal(visitors.info('a')?.step, 'seated');
  visitors.sync([]);
  run(0.1);
  assert.equal(visitors.info('a'), null, 'forgotten once the visit is gone');
});

test('a page that opens mid-visit puts the visitor where the clock says, not back at the start', () => {
  const { seats, clock, visitors } = floor({ a: 'desk-3', h: 'desk-9' });
  const path = visitRoute('desk-3', 'desk-9', 0);
  const L = routeLength(path);
  visitors.sync([visit({ phase: 'walking', since: clock.now - VISIT_HOP_MS - (L / 2 / VISIT_WALK_SPEED) * 1000 })]);
  const mid = { x: 0, z: 0, heading: 0 };
  pointAlong(path, L / 2, mid);
  const p = seats.get('a')!.model.root.position;
  near(p.x, mid.x, 1e-6);
  near(p.z, mid.z, 1e-6);
  near(seats.get('a')!.model.root.rotation.y, mid.heading, 1e-6);
  // On the spot already, a second visitor at the same host stands on the other slot.
  const two = floor({ a: 'desk-3', b: 'desk-5', h: 'desk-9' });
  two.visitors.sync([visit({ phase: 'reading', since: two.clock.now - 5000 }), visit({ id: 'v2', visitor: 'b', slot: 1, phase: 'waiting', since: two.clock.now - 5000 })]);
  const s0 = visitSpot('desk-9', 0);
  const s1 = visitSpot('desk-9', 1);
  const a = two.visitors.info('a')!;
  const b = two.visitors.info('b')!;
  near(a.x, s0.x);
  near(b.x, s1.x);
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= 0.6);
  assert.equal(two.seats.get('a')!.model.visitPose, 'peer');
  assert.equal(two.seats.get('b')!.model.visitPose, 'stand');
});

test('a visit that vanishes sends the visitor back along its route, and release puts it straight back', () => {
  const { seats, clock, visitors, run } = floor({ a: 'desk-3', h: 'desk-9', c: 'desk-1' });
  const a = seats.get('a')!;
  const seat = a.model.root.parent;
  visitors.sync([visit({ phase: 'walking', since: clock.now })]);
  run(2.5);
  const out = visitors.info('a')!;
  assert.equal(out.step, 'walking');
  visitors.sync([]);
  run(0.2);
  assert.equal(visitors.info('a')?.step, 'walking back');
  run(10);
  assert.equal(a.model.root.parent, seat);
  assert.equal(visitors.info('a'), null);
  // A new visit to another desk while still out: home first, then off again.
  visitors.sync([visit({ phase: 'walking', since: clock.now })]);
  run(3);
  visitors.sync([visit({ id: 'v2', host: 'c', phase: 'walking', since: clock.now })]);
  run(0.2);
  assert.equal(visitors.info('a')?.step, 'walking back');
  assert.equal(visitors.info('a')?.visit, null);
  run(15);
  assert.equal(visitors.info('a')?.visit, 'v2');
  assert.equal(visitors.info('a')?.step, 'at spot');
  near(visitors.info('a')!.x, visitSpot('desk-1', 0).x, 1e-3);
  // Sent home mid-visit: on its seat at once, for the walk out to start from.
  visitors.release('a');
  assert.equal(a.model.root.parent, seat);
  assert.equal(visitors.info('a'), null);
  // A visit whose host isn't on the floor is nobody's to show.
  visitors.sync([visit({ host: 'nobody', phase: 'reading', since: clock.now })]);
  assert.equal(visitors.info('a'), null);
  visitors.sync([visit({ phase: 'reading', since: clock.now })]);
  assert.equal(visitors.info('a')?.step, 'at spot');
  visitors.clear();
  assert.equal(a.model.root.parent, seat);
  assert.equal(visitors.moving, false);
});

test('the lead at the kiosk walks out round its front to visit, and is visited on the kiosk’s own spots', () => {
  const { seats, clock, visitors, run } = floor({ lead: 'station-lead', h: 'desk-9', b: 'desk-7' });
  const lead = seats.get('lead')!;
  const seat = lead.model.root.parent;
  visitors.sync([visit({ visitor: 'lead', phase: 'walking', since: clock.now }), visit({ id: 'v2', visitor: 'b', host: 'lead', phase: 'walking', since: clock.now })]);
  run(Math.max(visitWalkMs(visitRoute('desk-7', 'station-lead', 0)), visitWalkMs(visitRoute('station-lead', 'desk-9', 0))) / 1000 + 1);
  const there = visitSpot('desk-9', 0);
  near(visitors.info('lead')!.x, there.x, 1e-3);
  near(visitors.info('lead')!.z, there.z, 1e-3);
  const kiosk = visitSpot('station-lead', 0);
  near(visitors.info('b')!.x, kiosk.x, 1e-3);
  near(visitors.info('b')!.z, kiosk.z, 1e-3);
  assert.ok(Math.abs(wrap(visitors.info('b')!.facing - kiosk.rotY)) < 0.05);
  visitors.sync([]);
  run(20);
  assert.equal(lead.model.root.parent, seat);
  assert.equal(visitors.info('lead'), null);
  assert.equal(visitors.info('b'), null);
});

test('told to walk back before it reached its spot, a visitor turns round where it is', () => {
  const { visitors, clock, run } = floor({ a: 'desk-3', h: 'desk-9' });
  visitors.sync([visit({ phase: 'walking', since: clock.now })]);
  run(1.5);
  const z0 = visitors.info('a')!.z;
  visitors.sync([visit({ phase: 'returning', since: clock.now })]);
  run(0.2);
  const z1 = visitors.info('a')!.z;
  assert.equal(visitors.info('a')!.step, 'walking back');
  // Desk 3 is toward -z from Desk 9: walking back, z only falls.
  assert.ok(z1 < z0, `${z1} < ${z0}`);
  run(3);
  assert.equal(visitors.info('a')!.step, 'seated');
  // Told to walk back before it was even up: it stays in its seat.
  visitors.sync([]);
  run(0.1);
  visitors.sync([visit({ id: 'v3', phase: 'walking', since: clock.now })]);
  run(0.05);
  visitors.sync([visit({ id: 'v3', phase: 'returning', since: clock.now })]);
  let most = -1;
  for (let i = 0; i < 60; i++) {
    run(1 / 60);
    most = Math.max(most, (visitors as unknown as { walkers: Map<string, { u: number }> }).walkers.get('a')?.u ?? -1);
  }
  assert.ok(most < -0.7, `it never got further up than ${most}`);
});
