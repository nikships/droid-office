import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DESK_BY_ID, DESKS, deskSeat } from '../src/shared/layout.js';
import { walkable } from '../src/shared/nav.js';
import { VISIT_HOP_MS, VISIT_WALK_SPEED, visitRoute, visitSpot, visitWalkMs } from '../src/shared/visits.js';

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

test('the first two visitors stand on different open spots beside the host', () => {
  for (const id of ['desk-1', 'desk-9', 'beanbag-2', 'station-lead']) {
    const a = visitSpot(id, 0);
    const b = visitSpot(id, 1);
    assert.ok(walkable(a.x, a.z), `${id} slot 0 is on open floor`);
    assert.ok(walkable(b.x, b.z), `${id} slot 1 is on open floor`);
    assert.ok(dist(a, b) >= 0.6, `${id}: slots 0 and 1 are apart`);
  }
  // Beside the worker's chair, not on it.
  const desk = DESK_BY_ID.get('desk-9')!;
  const seat = deskSeat(desk);
  const spot = visitSpot('desk-9', 0);
  assert.ok(dist(spot, seat) > 0.6 && dist(spot, seat) < 1.3);
});

test('every seat has six distinct open spots for its visitors', () => {
  for (const id of DESK_BY_ID.keys()) {
    const spots = Array.from({ length: 6 }, (_, i) => visitSpot(id, i));
    for (const [i, s] of spots.entries()) {
      assert.ok(walkable(s.x, s.z), `${id} slot ${i} is on open floor`);
      for (const o of spots.slice(0, i)) assert.ok(dist(s, o) > 0.3, `${id} slot ${i} keeps off an earlier slot`);
    }
  }
});

test('a visitor faces the host’s laptop', () => {
  // Desk 9 seats its worker facing +z (rotY PI), with the laptop on the desk at z 3.45.
  const desk = DESK_BY_ID.get('desk-9')!;
  const s = visitSpot('desk-9', 0);
  const forward = { x: -Math.sin(s.rotY), z: -Math.cos(s.rotY) };
  const toLaptop = { x: desk.x - s.x, z: desk.z - s.z };
  const n = Math.hypot(toLaptop.x, toLaptop.z);
  assert.ok((forward.x * toLaptop.x + forward.z * toLaptop.z) / n > 0.95);
  assert.ok(forward.z > 0, 'it looks toward +z, at the desk');
});

test('a slot past the laid-out spots still gets a spot, and a seat that does not exist gets the origin', () => {
  const far = visitSpot('desk-1', 9);
  assert.ok(walkable(far.x, far.z));
  assert.deepEqual(visitSpot('nowhere', 0), { x: 0, z: 0, rotY: 0 });
});

test('the route ends on the visitor’s spot and starts beside its own chair', () => {
  const path = visitRoute('desk-3', 'desk-9', 1);
  const spot = visitSpot('desk-9', 1);
  const end = path[path.length - 1];
  assert.deepEqual(end, [spot.x, spot.z]);
  const own = deskSeat(DESK_BY_ID.get('desk-3')!);
  assert.ok(Math.hypot(path[0][0] - own.x, path[0][1] - own.z) < 1.2);
  assert.ok(path.length >= 2);
  // Across the room: from a seat that does not exist it is only the spot.
  assert.deepEqual(visitRoute('nowhere', 'desk-9', 0), [[visitSpot('desk-9', 0).x, visitSpot('desk-9', 0).z]]);
});

test('a route from every desk to every desk ends on the spot', () => {
  for (const a of DESKS) {
    for (const b of DESKS) {
      if (a === b) continue;
      const path = visitRoute(a.id, b.id, 0);
      const spot = visitSpot(b.id, 0);
      assert.deepEqual(path[path.length - 1], [spot.x, spot.z]);
    }
  }
});

test('walking time is the route’s length at the walking speed, plus getting up', () => {
  assert.equal(visitWalkMs([]), VISIT_HOP_MS);
  assert.equal(visitWalkMs([[0, 0]]), VISIT_HOP_MS);
  assert.equal(
    visitWalkMs([
      [0, 0],
      [3, 4],
    ]),
    Math.round((5 / VISIT_WALK_SPEED) * 1000) + VISIT_HOP_MS,
  );
  const path = visitRoute('desk-1', 'desk-16', 0);
  assert.ok(visitWalkMs(path) > visitWalkMs(visitRoute('desk-1', 'desk-2', 0)));
});
