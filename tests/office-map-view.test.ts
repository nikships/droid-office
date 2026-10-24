import test from 'node:test';
import assert from 'node:assert/strict';
import { DESKS, DESK_BY_ID, KIOSK, deskSeat } from '../src/shared/layout.js';
import {
  MAP_BOUNDS,
  angleDelta,
  blendView,
  cameraAt,
  clampTarget,
  easeInOut,
  easeOut,
  frameView,
  focusView,
  homeView,
  nearestInDirection,
  projectPoint,
  seatSpot,
  tagWidth,
  tagsDotsOnly,
  tagsExpanded,
  tuckedTags,
  viewOf,
  type MapView,
} from '../src/client/office-map-view.js';

test('a seat spot is where the 3D office seats its worker: at the desk, on the bean bag, behind the kiosk', () => {
  const desk = DESKS.find((d) => !d.beanbag && !d.station)!;
  const at = deskSeat(desk, 0.93);
  assert.deepEqual(seatSpot(desk.id), { x: at.x, z: at.z, head: 1.4, kind: 'desk' });
  const bag = DESKS.find((d) => d.beanbag);
  if (bag) assert.deepEqual(seatSpot(bag.id), { x: bag.x, z: bag.z, head: 1.15, kind: 'beanbag' });
  const kiosk = [...DESK_BY_ID.values()].find((d) => d.station);
  if (kiosk) {
    const p = deskSeat(kiosk, KIOSK.stand);
    assert.deepEqual(seatSpot(kiosk.id), { x: p.x, z: p.z, head: 1.3, kind: 'station' });
  }
  assert.equal(seatSpot('no-such-desk'), undefined);
});

test('the home view looks at the floor from the south and fits all of it on a wide, a square and a tall screen', () => {
  for (const aspect of [16 / 9, 1440 / 900, 1024 / 700, 1, 9 / 16]) {
    const home = homeView(aspect);
    const cam = cameraAt(home);
    let top = -Infinity;
    let bottom = Infinity;
    let side = 0;
    assert.ok(cam.z > home.z, 'the camera stands south (+z) of what it looks at');
    assert.ok(cam.y > 0, 'and above the floor');
    for (const x of [MAP_BOUNDS.minX, MAP_BOUNDS.maxX])
      for (const z of [MAP_BOUNDS.minZ, MAP_BOUNDS.maxZ]) {
        const p = projectPoint(home, aspect, { x, y: 0, z });
        assert.ok(p.depth > 0, 'every corner is in front of the camera');
        assert.ok(Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1, `corner (${x}, ${z}) on screen at ${aspect.toFixed(2)}: ${p.x.toFixed(2)}, ${p.y.toFixed(2)}`);
        top = Math.max(top, p.y);
        bottom = Math.min(bottom, p.y);
        side = Math.max(side, Math.abs(p.x));
      }
    assert.ok(Math.abs(top + bottom) < 0.25, 'the floor sits about in the middle, top to bottom');
    assert.ok(Math.max(top, -bottom, side) > 0.8, `and fills the screen one way or the other at ${aspect.toFixed(2)}`);
  }
  const box = { minX: -15, maxX: 15, minZ: -10, maxZ: 10 };
  assert.ok(frameView(box, 9 / 16).distance > frameView(box, 16 / 9).distance, 'a narrow screen stands further back for the same floor');
});

test('projecting puts the aim point mid-screen, east on the right and higher things higher, from the south', () => {
  const v: MapView = { x: 2, z: 1, distance: 20, yaw: 0, pitch: 1 };
  const mid = projectPoint(v, 1.5, { x: 2, y: 0, z: 1 });
  assert.ok(Math.abs(mid.x) < 1e-9 && Math.abs(mid.y) < 1e-9);
  assert.ok(Math.abs(mid.depth - 20) < 1e-9);
  assert.ok(projectPoint(v, 1.5, { x: 4, y: 0, z: 1 }).x > 0);
  assert.ok(projectPoint(v, 1.5, { x: 2, y: 2, z: 1 }).y > 0);
  assert.ok(projectPoint(v, 1.5, { x: 2, y: 0, z: -3 }).y > 0, 'further north is further up the screen');
});

test('a view survives the trip to a camera position and back', () => {
  const v: MapView = { x: 3, z: -2, distance: 18, yaw: -0.4, pitch: 0.9 };
  const back = viewOf(cameraAt(v), { x: v.x, y: 0, z: v.z });
  for (const k of ['x', 'z', 'distance', 'yaw', 'pitch'] as const) assert.ok(Math.abs(back[k] - v[k]) < 1e-9, k);
});

test('flying in to a worker keeps the way the camera faces and puts the worker mid-screen', () => {
  const spot = seatSpot(DESKS[0]!.id)!;
  const v = focusView(spot, 0);
  assert.equal(v.yaw, 0);
  assert.ok(v.z < spot.z, 'aimed past the worker, away from the camera (which is +z of it at yaw 0)');
  assert.ok(Math.abs(v.x - spot.x) < 1e-9);
  const p = projectPoint(v, 16 / 9, { x: spot.x, y: 1, z: spot.z });
  assert.ok(Math.abs(p.x) < 1e-9 && Math.abs(p.y) < 0.05, `the worker's middle is mid-screen: ${p.y}`);
  assert.ok(cameraAt(v).z > spot.z, 'the camera is still on the near side of the worker');
});

test('blending views turns the short way round and lands exactly on both ends', () => {
  assert.ok(Math.abs(angleDelta(3, -3) - (2 * Math.PI - 6)) < 1e-9);
  assert.ok(Math.abs(angleDelta(-3, 3) + (2 * Math.PI - 6)) < 1e-9);
  const a: MapView = { x: 0, z: 0, distance: 10, yaw: 3, pitch: 0.5 };
  const b: MapView = { x: 4, z: 2, distance: 20, yaw: -3, pitch: 1 };
  assert.deepEqual(blendView(a, b, 0), a);
  const end = blendView(a, b, 1);
  assert.ok(Math.abs(angleDelta(end.yaw, b.yaw)) < 1e-9);
  const mid = blendView(a, b, 0.5);
  assert.ok(Math.abs(Math.abs(mid.yaw) - Math.PI) < 0.3, 'halfway is behind, not through yaw 0');
  assert.equal(mid.distance, 15);
});

test('eases start at 0, end at 1, never overshoot and keep going one way', () => {
  for (const ease of [easeInOut, easeOut]) {
    assert.equal(ease(0), 0);
    assert.equal(ease(1), 1);
    assert.equal(ease(-1), 0);
    assert.equal(ease(2), 1);
    let last = 0;
    for (let i = 1; i <= 100; i++) {
      const y = ease(i / 100);
      assert.ok(y >= last && y <= 1);
      last = y;
    }
  }
  assert.equal(easeInOut(0.5), 0.5);
  assert.ok(easeOut(0.25) > 0.25, 'ease-out is quick off the mark');
});

test('a drag keeps the aim on the floor', () => {
  assert.deepEqual(clampTarget(0, 0), { x: 0, z: 0 });
  assert.deepEqual(clampTarget(-1e3, 1e3), { x: MAP_BOUNDS.minX, z: MAP_BOUNDS.maxZ });
  assert.deepEqual(clampTarget(1e3, -1e3), { x: MAP_BOUNDS.maxX, z: MAP_BOUNDS.minZ });
});

test('the arrow keys go to the nearest worker that way on screen, wherever the camera has turned', () => {
  const from = { x: 0, z: 0 };
  const north = { x: 0, z: -4, id: 'north' };
  const south = { x: 0.5, z: 3, id: 'south' };
  const east = { x: 5, z: 0.4, id: 'east' };
  const west = { x: -3, z: 0, id: 'west' };
  const far = { x: 0, z: -12, id: 'far north' };
  const pts = [north, south, east, west, far];
  // Facing north (yaw 0): screen up is -z, screen right is +x.
  assert.equal(nearestInDirection(from, 'up', pts, 0)?.id, 'north');
  assert.equal(nearestInDirection(from, 'down', pts, 0)?.id, 'south');
  assert.equal(nearestInDirection(from, 'right', pts, 0)?.id, 'east');
  assert.equal(nearestInDirection(from, 'left', pts, 0)?.id, 'west');
  // Turned a quarter (camera east of its target, looking west): screen up is -x, screen right is -z.
  assert.equal(nearestInDirection(from, 'up', pts, Math.PI / 2)?.id, 'west');
  assert.equal(nearestInDirection(from, 'right', pts, Math.PI / 2)?.id, 'north');
  assert.equal(nearestInDirection(from, 'down', pts, Math.PI / 2)?.id, 'east');
  assert.equal(nearestInDirection(from, 'up', [south], 0), undefined, 'nothing that way');
  assert.equal(nearestInDirection(from, 'up', [{ x: 0.1, z: -0.1 }], 0), undefined, 'a neighbour almost on top does not count');
});

test('name tags are about a desk wide, within bounds, and show what each worker does only close in', () => {
  assert.equal(tagWidth(1), 92);
  assert.equal(tagWidth(1e4), 220);
  assert.equal(tagWidth(50), 120);
  assert.equal(tagsExpanded(40), false);
  assert.equal(tagsExpanded(64), true);
  assert.equal(tagsDotsOnly(28), false, 'the whole floor on a laptop screen still shows names');
  assert.equal(tagsDotsOnly(12), true);
});

test('a tag that would sit mostly under a nearer one tucks down to its dot; a lit or waiting one never does', () => {
  const near = { id: 'near', x: 100, y: 100, w: 80, h: 24, depth: 0.5 };
  const behind = { id: 'behind', x: 110, y: 96, w: 80, h: 24, depth: 0.6 };
  const apart = { id: 'apart', x: 300, y: 100, w: 80, h: 24, depth: 0.7 };
  const grazing = { id: 'grazing', x: 175, y: 100, w: 80, h: 24, depth: 0.8 };
  assert.deepEqual([...tuckedTags([behind, near, apart, grazing])], ['behind']);
  assert.deepEqual([...tuckedTags([near, { ...behind, keep: true }])], ['near'], 'the lit tag wins even from behind');
  assert.deepEqual(
    [
      ...tuckedTags([
        { ...near, keep: true },
        { ...behind, keep: true },
      ]),
    ],
    [],
    'two that must show both show',
  );
  assert.deepEqual([...tuckedTags([])], []);
});
