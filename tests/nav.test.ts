import test from 'node:test';
import assert from 'node:assert/strict';
import { BALCONY, BALCONY_DOOR, EXIT_DOOR, EXIT_STAIRS, FLOOR, GLASS_ROOM, PARACHUTE, ROAD, SEATS, STATIONS } from '../src/shared/layout.js';
import { route, walkable, wayHome, wayToBalcony, type Pt } from '../src/shared/nav.js';

test('a worker sent home walks round the furniture, out the exit door and off along the sidewalk', () => {
  for (const seat of [...SEATS, ...STATIONS]) {
    const way = wayHome(seat);
    // It hops down right beside where it sat.
    assert.ok(Math.hypot(way[0][0] - seat.x, way[0][1] - seat.z) < 1.2, `${seat.id} hops down beside its seat`);
    const out = way.findIndex(([x]) => x < FLOOR.minX);
    assert.ok(out > 1, `${seat.id} leaves by the exit`);
    // From the aisle to the door, every step is on open floor.
    for (let i = 2; i < out; i++) {
      const [x0, z0] = way[i - 1];
      const [x1, z1] = way[i];
      const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.2);
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n;
        const z = z0 + ((z1 - z0) * k) / n;
        assert.ok(walkable(x, z), `${seat.id} walks into something at (${x.toFixed(2)}, ${z.toFixed(2)})`);
      }
    }
    // Through the doorway, not the wall beside it.
    for (const [, z] of [way[out - 1], way[out]]) assert.ok(Math.abs(z - EXIT_DOOR.u) < EXIT_DOOR.width / 2 - 0.2, `${seat.id} goes through the door`);
    // Down the steps outside, then away along the sidewalk.
    assert.ok(
      way.slice(out).every(([x, z]) => x < EXIT_STAIRS.minX + 1 || z > ROAD.minZ - 2.1),
      `${seat.id} stays off the building`,
    );
    const [ex, ez] = way[way.length - 1];
    assert.ok(ez > ROAD.minZ - 2 && ez < ROAD.minZ && ex < EXIT_STAIRS.minX - 10, `${seat.id} ends up down the sidewalk`);
  }
});

/** Every step from a to b is on open floor. */
function clear(a: Pt, b: Pt, what: string) {
  const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.2);
  for (let k = 0; k <= n; k++) {
    const x = a[0] + ((b[0] - a[0]) * k) / n;
    const z = a[1] + ((b[1] - a[1]) * k) / n;
    assert.ok(walkable(x, z), `${what} walks into something at (${x.toFixed(2)}, ${z.toFixed(2)})`);
  }
}

test('the unused glass room remains walkable through its doorway', () => {
  const way = route([8, 7], [10.75, 10]);
  for (let i = 1; i < way.length; i++) clear(way[i - 1], way[i], 'player');
  assert.deepEqual(way.at(-1), [10.75, 10]);
  const crossing = way.findIndex(([, z], i) => i > 0 && way[i - 1][1] < GLASS_ROOM.minZ && z >= GLASS_ROOM.minZ);
  assert.ok(crossing > 0);
  const [[ax, az], [bx, bz]] = [way[crossing - 1], way[crossing]];
  const x = ax + ((bx - ax) * (GLASS_ROOM.minZ - az)) / (bz - az);
  assert.ok(x > GLASS_ROOM.door.x0 && x < GLASS_ROOM.door.x1);
});

test('upstairs, with no exit door, a worker sent home walks out onto the balcony to the railing', () => {
  for (const seat of [...SEATS, ...STATIONS]) {
    const way = wayToBalcony(seat);
    assert.ok(Math.hypot(way[0][0] - seat.x, way[0][1] - seat.z) < 1.2, `${seat.id} hops down beside its seat`);
    const out = way.findIndex(([, z]) => z > FLOOR.maxZ);
    assert.ok(out > 1, `${seat.id} goes out onto the balcony`);
    for (let i = 2; i < out; i++) {
      const [x0, z0] = way[i - 1];
      const [x1, z1] = way[i];
      const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.2);
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n;
        const z = z0 + ((z1 - z0) * k) / n;
        assert.ok(walkable(x, z), `${seat.id} walks into something at (${x.toFixed(2)}, ${z.toFixed(2)})`);
      }
    }
    // Through the balcony doors, then straight across to the railing.
    for (const [x] of way.slice(out - 1)) assert.ok(Math.abs(x - BALCONY_DOOR.u) < BALCONY_DOOR.width / 2 - 0.3, `${seat.id} goes through the balcony doors`);
    const [jx, jz] = way[way.length - 1];
    assert.deepEqual([jx, jz], [PARACHUTE.jump.x, PARACHUTE.jump.z]);
    assert.ok(jz < BALCONY.maxZ && jz > BALCONY.maxZ - 0.6, `${seat.id} ends up at the railing`);
  }
});
