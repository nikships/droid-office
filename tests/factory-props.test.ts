import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { BEANBAGS, COMPUTE_WALL, DESK_SIZE, DESKS, DROID_RACK, EXIT_DOOR, FLOOR, ROBOT_CELL, STATIONS, WALL_HEIGHT, WINDOWS } from '../src/shared/layout';
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
  assert.equal(k.group.children.length, 2);
  // Nothing is loaded in Node, so every frame just keeps waiting.
  for (let t = 0; t < 20; t += 0.5) dressing.update(t, 0.5);
  assert.deepEqual(
    fixtures.map((f) => f[0]),
    ['west'],
  );
  assert.equal(k.colliders.length, 2);
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

test('the robot cell has orange neon safety lighting and two local light pools', () => {
  const { k } = kit();
  placeFactoryProps(k);
  const cell = k.group.children[1];
  const strips = cell.children.filter((o) => o instanceof THREE.Group && o.children.some((c) => c instanceof THREE.Mesh && c.geometry instanceof THREE.PlaneGeometry));
  assert.equal(strips.length, 4, 'all four safety edges have neon strips');
  for (const strip of strips) {
    const core = strip.children[0] as THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
    const halo = strip.children[1] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    assert.equal(core.material.color.getHexString(), 'ee6018');
    assert.equal(core.material.toneMapped, false);
    assert.equal(halo.material.blending, THREE.AdditiveBlending);
    assert.equal(halo.material.depthWrite, false);
    assert.ok(halo.material.map instanceof THREE.DataTexture);
    const data = halo.material.map.image.data;
    assert.equal(data[3], 0, 'the halo fades to transparent at its edge');
    assert.ok(data[(16 * 64 + 32) * 4 + 3] > 0, 'the halo glows at its centre');
    const bounds = new THREE.Box3().setFromObject(strip);
    assert.ok(bounds.min.y > 0.02, 'the lighting stays above the plate');
  }
  assert.deepEqual(
    k.night.lamps.map(({ x, y, z, reach, color, power }) => ({ x, y, z, reach, color, power })),
    [-1, 1].map((lane) => ({ x: ROBOT_CELL.x, y: 0.55, z: ROBOT_CELL.z + lane * 0.8, reach: 1.65, color: '#ee6018', power: 1.8 })),
  );
  assert.ok(
    k.night.lamps.every((l) => !l.ground),
    'the cell light stays on its office floor',
  );
  assert.ok(
    k.night.lamps.every((l) => l.indoor),
    'the shader routes these pools to machinery inside the office',
  );
});

test('the compute wall is on the west wall, clear of its windows, the exit door, the ceiling and the kitchen', () => {
  const CW = COMPUTE_WALL;
  const minZ = CW.z - CW.width / 2 - 0.08;
  const maxZ = CW.z + CW.width / 2 + 0.08;
  const bottom = CW.y - CW.height / 2 - 0.08;
  const top = CW.y + CW.height / 2 + 0.08;
  assert.equal(CW.x, FLOOR.minX);
  for (const w of WINDOWS.filter((o) => o.wall === 'west')) {
    assert.ok(maxZ <= w.u - w.width / 2 || minZ >= w.u + w.width / 2, `clear of the window at ${w.u}`);
  }
  // The door and the EXIT sign over it, which reaches about 3.1 m.
  assert.ok(minZ > EXIT_DOOR.u + EXIT_DOOR.width / 2 + 0.3, 'clear of the exit door and its sign');
  assert.ok(top < WALL_HEIGHT - 1, 'well under the ceiling');
  assert.ok(maxZ < FLOOR.maxZ, 'inside the south wall');
  // The counter top is 1.03 m high and starts at x -17, so the wall's screen is above and behind it.
  assert.ok(bottom > 1.03);
  assert.ok(CW.machineWidth + CW.gap < CW.width / 2, 'the fleet gets the bigger screen');
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
