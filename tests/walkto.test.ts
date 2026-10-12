import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerController } from '../src/client/player.js';
import { wayTo } from '../src/client/walkto.js';
import type { DressingKit } from '../src/client/world/factory-floor.js';
import { placeFactoryProps } from '../src/client/world/factory-props.js';
import type { Collider } from '../src/client/world/office.js';
import { DESK_BY_ID, DESKS, deskSeat, ELEVATOR, ELEVATOR_FRONT, FLOOR, ROBOT_CELL, SLAB } from '../src/shared/layout.js';
import { walkable } from '../src/shared/nav.js';

/** The office floor and the factory props' own colliders, as world/factory-props.ts builds them. */
function propColliders(): Collider[] {
  const colliders: Collider[] = [];
  placeFactoryProps({ group: new THREE.Group(), colliders, interactables: [], night: { lamps: [] }, fixture() {} } as unknown as DressingKit);
  return colliders;
}

/** A player on stub DOM (the player.test.ts pattern) among `colliders`, on the office floor. */
function walker(t: TestContext, colliders: Collider[]) {
  for (const name of ['window', 'document'] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: new EventTarget() });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  return new PlayerController(new THREE.PerspectiveCamera(), new EventTarget() as unknown as HTMLElement, [{ ...FLOOR, bottom: -SLAB, top: 0 }, ...colliders]);
}

/** Walks the way wayTo picks, frame by frame, and says how it ended and where. */
function walk(player: PlayerController, from: { x: number; z: number }, to: { x: number; y: number; z: number }) {
  player.pos.set(from.x, 0, from.z);
  const path = wayTo(player.pos, to);
  let result = '';
  player.onPathEnd = (why) => {
    result = why;
  };
  player.walkPath(path);
  for (let i = 0; i < 3600 && !result; i++) player.update(1 / 60);
  return { path, result, at: player.pos.clone() };
}

test("every factory prop's collider is off the walking map, so routes go round it", () => {
  const colliders = propColliders();
  assert.ok(
    colliders.some((c) => c.fence && c.minX === ROBOT_CELL.x - ROBOT_CELL.width / 2),
    'the robot cell is fenced',
  );
  for (const c of colliders) {
    for (let x = c.minX + 0.05; x < c.maxX; x += 0.2) {
      for (let z = c.minZ + 0.05; z < c.maxZ; z += 0.2) assert.equal(walkable(x, z), false, `(${x.toFixed(2)}, ${z.toFixed(2)}) is inside a prop but on the map`);
    }
  }
});

test('the walk from Desk 7 to the elevator goes round the robot cell instead of into its fence', (t) => {
  const player = walker(t, propColliders());
  const to = { x: ELEVATOR.x, y: 0, z: ELEVATOR_FRONT - 0.4 };
  const { path, result, at } = walk(player, deskSeat(DESK_BY_ID.get('desk-7')!, 2.4), to);
  assert.equal(result, 'arrived', `stopped at (${at.x.toFixed(2)}, ${at.z.toFixed(2)}) along ${JSON.stringify(path)}`);
  assert.ok(Math.hypot(at.x - to.x, at.z - to.z) < 1.5, `ended near the elevator, at (${at.x.toFixed(2)}, ${at.z.toFixed(2)})`);
});

test('from behind every desk, the walk to the elevator gets there past the props', (t) => {
  const player = walker(t, propColliders());
  const to = { x: ELEVATOR.x, y: 0, z: ELEVATOR_FRONT - 0.4 };
  for (const d of DESKS) {
    const { result, at } = walk(player, deskSeat(d, 2.4), to);
    assert.equal(result, 'arrived', `${d.id} got stuck at (${at.x.toFixed(2)}, ${at.z.toFixed(2)})`);
  }
});
