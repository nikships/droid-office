import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { BEANBAGS, DESK_SIZE, DESKS, FLOOR, MACHINE_MONITOR, STATIONS } from '../src/shared/layout';
import type { DressingKit } from '../src/client/world/factory-floor';
import { DROID_RACK, placeFactoryProps, ROBOT_CELL } from '../src/client/world/factory-props';
import type { Collider } from '../src/client/world/office';

function kit() {
  const fixtures: unknown[][] = [];
  const k = {
    group: new THREE.Group(),
    colliders: [] as Collider[],
    interactables: [],
    fixture: (...args: unknown[]) => fixtures.push(args),
  } as unknown as DressingKit;
  return { k, fixtures };
}

type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };
const overlaps = (a: Rect, b: Rect) => a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;

test('the props build without their GLBs, the DOM or WebGL, and wait for the models', () => {
  const { k, fixtures } = kit();
  const dressing = placeFactoryProps(k);
  assert.equal(k.group.children.length, 2);
  // Nothing is loaded in Node, so every frame just keeps waiting.
  for (let t = 0; t < 20; t += 0.5) dressing.update(t, 0.5);
  assert.deepEqual(
    fixtures.map((f) => f[0]),
    ['west'],
  );
  assert.equal(k.colliders.length, 2);
});

test('the rack stands against the west wall under the machine monitor', () => {
  assert.equal(DROID_RACK.minX, FLOOR.minX);
  assert.ok(DROID_RACK.minZ < MACHINE_MONITOR.z && MACHINE_MONITOR.z < DROID_RACK.maxZ);
  assert.ok(DROID_RACK.top < MACHINE_MONITOR.y - MACHINE_MONITOR.height / 2, 'the cubes stay under the monitor');
});

test('neither the rack nor the robot cell sits on a desk, a bean bag or a kiosk', () => {
  const { k } = kit();
  placeFactoryProps(k);
  const cell = { minX: ROBOT_CELL.x - ROBOT_CELL.width / 2, maxX: ROBOT_CELL.x + ROBOT_CELL.width / 2, minZ: ROBOT_CELL.z - ROBOT_CELL.depth / 2, maxZ: ROBOT_CELL.z + ROBOT_CELL.depth / 2 };
  assert.ok(k.colliders.some((c) => c.fence && c.minX === cell.minX && c.maxZ === cell.maxZ));
  const desks = DESKS.map((d) => ({ minX: d.x - DESK_SIZE.width / 2, maxX: d.x + DESK_SIZE.width / 2, minZ: d.z - DESK_SIZE.depth / 2 - 0.8, maxZ: d.z + DESK_SIZE.depth / 2 + 0.8 }));
  const seats = [...BEANBAGS, ...STATIONS].map((s) => ({ minX: s.x - 0.8, maxX: s.x + 0.8, minZ: s.z - 0.8, maxZ: s.z + 0.8 }));
  for (const prop of [DROID_RACK, cell]) {
    for (const spot of [...desks, ...seats]) assert.equal(overlaps(prop, spot), false, `${JSON.stringify(prop)} overlaps ${JSON.stringify(spot)}`);
  }
});
