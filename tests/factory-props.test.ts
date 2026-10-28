import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { BEANBAGS, COMPUTE_WALL, DESK_SIZE, DESKS, DROID_RACK, EXIT_DOOR, FLOOR, STATIONS, WALL_HEIGHT, WINDOWS } from '../src/shared/layout';
import type { DressingKit } from '../src/client/world/factory-floor';
import { placeFactoryProps } from '../src/client/world/factory-props';
import type { Collider } from '../src/client/world/office';

function kit() {
  const fixtures: unknown[][] = [];
  const k = {
    group: new THREE.Group(),
    colliders: [] as Collider[],
    interactables: [],
    fixture: (...args: unknown[]) => fixtures.push(args),
    night: { lamps: [] },
  } as unknown as DressingKit;
  return { k, fixtures };
}

type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };
const overlaps = (a: Rect, b: Rect) => a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;

test('the props build without their GLBs, the DOM or WebGL, and wait for the models', () => {
  const { k, fixtures } = kit();
  const dressing = placeFactoryProps(k);
  assert.equal(k.group.children.length, 1);
  // Nothing is loaded in Node, so every frame just keeps waiting.
  for (let t = 0; t < 20; t += 0.5) dressing.update(t, 0.5);
  assert.deepEqual(
    fixtures.map((f) => f[0]),
    ['west'],
  );
  assert.equal(k.colliders.length, 1);
});

test('the rack stands against the west wall under the fleet half of the compute wall', () => {
  const CW = COMPUTE_WALL;
  // Facing +x, the machine's screen is the wall's south (+z) end; the fleet's is the rest.
  const fleet = { minZ: CW.z - CW.width / 2, maxZ: CW.z + CW.width / 2 - CW.machineWidth - CW.gap };
  assert.equal(DROID_RACK.minX, FLOOR.minX);
  assert.ok(DROID_RACK.minZ >= fleet.minZ && DROID_RACK.maxZ <= fleet.maxZ, 'the rack sits under the fleet screen');
  assert.ok(DROID_RACK.top < CW.y - CW.height / 2, 'the cubes stay under the screen');
  // The kitchen counter and fridge start at z 11.7.
  assert.ok(DROID_RACK.maxZ < 11.7);
});

test('the compute wall is on the west wall, clear of its windows, the exit door, the ceiling and the kitchen', () => {
  const CW = COMPUTE_WALL;
  const minZ = CW.z - CW.width / 2 - 0.08;
  const maxZ = CW.z + CW.width / 2 + 0.08;
  const bottom = CW.y - CW.height / 2 - 0.08;
  const top = CW.y + CW.height / 2 + 0.08;
  assert.equal(CW.x, FLOOR.minX);
  for (const w of WINDOWS.filter((o) => o.wall === 'west')) {
    assert.ok(maxZ <= w.u - w.width / 2 || minZ >= w.u + w.width / 2 || bottom > w.y1 + 0.05, `clear of the window at ${w.u}`);
  }
  // Beside the door, not above it: the low strip starts south of the door and its EXIT sign.
  assert.ok(minZ > EXIT_DOOR.u + EXIT_DOOR.width / 2, 'clear of the exit door and its sign');
  assert.ok(top < WALL_HEIGHT - 0.5, 'under the ceiling and its purlins');
  assert.ok(bottom > 1, 'at eye level, well below the old billboard bottom of 3.45 m');
  assert.ok(maxZ < FLOOR.maxZ, 'inside the south wall');
  // The counter top is 1.03 m high and starts at x -17, so the wall's screen is above and behind it.
  assert.ok(bottom > 1.03);
  assert.ok(CW.machineWidth + CW.gap < CW.width / 2, 'the fleet gets the bigger screen');
});

test('the rack does not sit on a desk, a bean bag or a kiosk', () => {
  const { k } = kit();
  placeFactoryProps(k);
  const desks = DESKS.map((d) => ({ minX: d.x - DESK_SIZE.width / 2, maxX: d.x + DESK_SIZE.width / 2, minZ: d.z - DESK_SIZE.depth / 2 - 0.8, maxZ: d.z + DESK_SIZE.depth / 2 + 0.8 }));
  const seats = [...BEANBAGS, ...STATIONS].map((s) => ({ minX: s.x - 0.8, maxX: s.x + 0.8, minZ: s.z - 0.8, maxZ: s.z + 0.8 }));
  for (const prop of [DROID_RACK]) {
    for (const spot of [...desks, ...seats]) assert.equal(overlaps(prop, spot), false, `${JSON.stringify(prop)} overlaps ${JSON.stringify(spot)}`);
  }
});
