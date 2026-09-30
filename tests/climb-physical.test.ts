import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Climber, type Arrival, type Grip, type Way } from '../src/client/climb.js';
import { PlayerController } from '../src/client/player.js';
import type { Collider } from '../src/client/world/office.js';
import { FLOOR, LADDER, POLE, POLES, SLAB, WALL_HEIGHT } from '../src/shared/layout.js';

// The ladder and poles held with real hands (grabLadder/slide/twirl with `physical`): only the
// signed pulls and turns handed in move you, once each, and letting go is always safe.

const officeFloor: Collider = { ...FLOOR, bottom: -SLAB, top: 0 };
const LADDER_TOP = WALL_HEIGHT - 1.15;
const LADDER_BOTTOM = -1.5;
const OFF_X = LADDER.hatch.maxX + 0.4;
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

function rig(t: TestContext, floors: { up?: string; down?: string }) {
  const win = new EventTarget();
  const doc = new EventTarget();
  for (const [name, value] of [
    ['window', win],
    ['document', doc],
  ] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const player = new PlayerController(new THREE.PerspectiveCamera(), new EventTarget() as unknown as HTMLElement, [officeFloor]);
  const sounds: string[] = [];
  const travels: { way: Way; how: Grip; at: Arrival }[] = [];
  const dones: { how: Grip; landed: boolean }[] = [];
  const climber = new Climber(player, {
    floorThere: (way) => (way === 1 ? floors.up : floors.down),
    travel: (way, how, at) => void travels.push({ way, how, at }),
    sound: (kind) => void sounds.push(kind),
    done: (how, landed) => void dones.push({ how, landed }),
  });
  const frames = (count: number, dt = 1 / 60) => {
    for (let i = 0; i < count; i++) player.update(dt);
  };
  const key = (type: 'keydown' | 'keyup', code: string) => win.dispatchEvent(Object.assign(new Event(type), { code }));
  return { player, climber, sounds, travels, dones, frames, key };
}

function onLadder(t: TestContext, floors: { up?: string; down?: string } = {}, y = 1) {
  const r = rig(t, floors);
  r.player.pos.set(LADDER.x + 0.4, y, LADDER.z);
  r.climber.grabLadder(true);
  r.frames(1);
  return r;
}

test('physical ladder: signed pulls move you exactly that far, a still hand holds you', (t) => {
  const { player, climber, frames } = onLadder(t);
  assert.equal(climber.physical, true);
  const y0 = player.pos.y;
  frames(120);
  assert.equal(player.pos.y, y0, 'no pull, no motion');
  assert.equal(climber.pullLadder(0.25), true);
  frames(1);
  assert.ok(near(player.pos.y, y0 + 0.25), `up 0.25 to ${player.pos.y}`);
  assert.equal(climber.pullLadder(-0.1), true);
  frames(1);
  assert.ok(near(player.pos.y, y0 + 0.15), `down 0.1 to ${player.pos.y}`);
  frames(60);
  assert.ok(near(player.pos.y, y0 + 0.15), 'a pull is used up by one tick');
  assert.equal(climber.pullLadder(0), false);
  assert.equal(climber.pullLadder(-0), false);
  assert.equal(climber.pullLadder(1e-6), false, 'tremor below the still threshold');
  frames(10);
  assert.ok(near(player.pos.y, y0 + 0.15));
});

test('physical ladder: several samples before a tick add up and are applied once', (t) => {
  const { player, climber, frames } = onLadder(t);
  const y0 = player.pos.y;
  // Two hands pulling in the same tick, averaged by the caller, then a second sample.
  climber.pullLadder(0.1);
  climber.pullLadder(0.1);
  climber.pullLadder(0.05);
  frames(1);
  assert.ok(near(player.pos.y, y0 + 0.25), `summed once: ${player.pos.y}`);
  frames(30);
  assert.ok(near(player.pos.y, y0 + 0.25), 'never applied a second time');
  climber.pullLadder(0.2);
  climber.pullLadder(-0.2);
  frames(1);
  assert.ok(near(player.pos.y, y0 + 0.25), 'opposing samples cancel');
});

test('physical ladder: invalid and huge pulls are harmless and bounded', (t) => {
  const { player, climber, frames } = onLadder(t);
  const y0 = player.pos.y;
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined as unknown as number, '1' as unknown as number]) {
    assert.equal(climber.pullLadder(bad), false, `rejects ${String(bad)}`);
  }
  frames(1);
  assert.equal(player.pos.y, y0);
  assert.equal(climber.pullLadder(1e9), true);
  frames(1);
  assert.ok(near(player.pos.y, y0 + 0.35), `one pull clipped to 0.35: ${player.pos.y}`);
  for (let i = 0; i < 1000; i++) climber.pullLadder(1e9);
  frames(1);
  assert.ok(near(player.pos.y, y0 + 0.35 + 0.6), `a tick's queue clipped to 0.6: ${player.pos.y}`);
  assert.ok(Number.isFinite(player.pos.y));
});

test('physical ladder: W/S, arrows, the stick and Space do nothing', (t) => {
  const { player, climber, frames, key } = onLadder(t);
  const y0 = player.pos.y;
  player.climbInput = 1;
  frames(60);
  player.climbInput = -1;
  frames(60);
  player.climbInput = 0;
  for (const code of ['KeyW', 'ArrowUp', 'KeyS', 'ArrowDown', 'Space']) {
    key('keydown', code);
    frames(30);
    key('keyup', code);
  }
  assert.equal(player.pos.y, y0);
  assert.equal(climber.active, true, 'Space does not jump you off a held ladder');
});

test('desktop ladder still climbs with W and is untouched by the physical calls', (t) => {
  const { player, climber, frames, key } = rig(t, {});
  player.pos.set(LADDER.x + 0.4, 0, LADDER.z);
  climber.grabLadder();
  assert.equal(climber.physical, false);
  assert.equal(player.camYaw, Math.PI / 2, 'desktop faces the rungs');
  assert.equal(player.lookPitch, 0.45);
  assert.equal(climber.pullLadder(0.3), false);
  climber.pausePhysical(true);
  climber.letGoPhysical();
  assert.equal(climber.active, true);
  key('keydown', 'KeyW');
  frames(30);
  key('keyup', 'KeyW');
  assert.ok(player.pos.y > 0.9, `W climbs: ${player.pos.y}`);
});

test('physical ladder leaves the head alone', (t) => {
  const { player, climber } = rig(t, {});
  player.pos.set(LADDER.x + 0.4, 0, LADDER.z);
  player.camYaw = 0.3;
  player.lookPitch = -0.2;
  climber.grabLadder(true);
  for (let i = 0; i < 20; i++) {
    climber.pullLadder(0.1);
    player.update(1 / 60);
  }
  assert.equal(player.camYaw, 0.3);
  assert.equal(player.lookPitch, -0.2);
});

test('physical ladder: up through the hatch, one travel, then carried on and off even when paused', (t) => {
  const { player, climber, travels, dones, frames } = onLadder(t, { up: 'upstairs' });
  for (let i = 0; i < 200 && travels.length === 0; i++) {
    climber.pullLadder(0.3);
    frames(1);
  }
  assert.equal(travels.length, 1);
  assert.equal(travels[0].way, 1);
  assert.equal(player.pos.y, LADDER_TOP);
  assert.deepEqual(climber.ladder, { y: LADDER_TOP, waiting: true, auto: false });
  // Waiting: pulls are refused, pause and release neither move you nor abort the journey.
  assert.equal(climber.pullLadder(0.3), false);
  climber.pausePhysical(true);
  climber.letGoPhysical();
  climber.pausePhysical(true);
  frames(120);
  assert.equal(travels.length, 1);
  assert.equal(player.pos.y, LADDER_TOP);
  assert.equal(climber.active, true);
  assert.deepEqual(dones, []);
  climber.arrived();
  assert.equal(climber.pullLadder(0.3), false, 'carried on: no hand pulls');
  frames(300);
  assert.equal(climber.active, false);
  assert.equal(player.pos.y, 0);
  assert.ok(near(player.pos.x, OFF_X, 0.05));
  assert.deepEqual(dones, [{ how: 'ladder', landed: true }]);
  assert.equal(travels.length, 1);
});

test('physical ladder: the top floor bonks once and never travels', (t) => {
  const { player, climber, sounds, travels, frames } = onLadder(t, {});
  for (let i = 0; i < 60; i++) {
    climber.pullLadder(0.3);
    frames(1);
  }
  assert.equal(player.pos.y, LADDER_TOP);
  assert.equal(travels.length, 0);
  assert.equal(sounds.filter((s) => s === 'bonk').length, 1);
  assert.equal(climber.active, true);
});

test('physical ladder: down to the floor with nothing below steps off onto it', (t) => {
  const { player, climber, dones, frames } = onLadder(t, {}, 0.5);
  for (let i = 0; i < 10 && climber.ladder?.auto !== true; i++) {
    climber.pullLadder(-0.2);
    frames(1);
  }
  frames(60);
  assert.equal(climber.active, false);
  assert.equal(player.pos.y, 0);
  assert.deepEqual(dones, [{ how: 'ladder', landed: true }]);
});

test('physical ladder: down through the floor travels once, and abort puts you back safely', (t) => {
  const { player, climber, travels, dones, frames } = onLadder(t, { down: 'downstairs' }, 0);
  for (let i = 0; i < 100 && travels.length === 0; i++) {
    climber.pullLadder(-0.3);
    frames(1);
  }
  assert.equal(travels.length, 1);
  assert.equal(travels[0].way, -1);
  assert.equal(player.pos.y, LADDER_BOTTOM);
  climber.abort();
  assert.equal(climber.active, false);
  assert.equal(player.rig, null);
  assert.equal(player.pos.y, 0);
  assert.equal(player.pos.x, OFF_X);
  assert.deepEqual(dones, [{ how: 'ladder', landed: false }]);
});

test('physical ladder: arriving down a floor drops the stale pull and carries you onto it', (t) => {
  const { player, climber, travels, dones, frames } = onLadder(t, { down: 'downstairs' }, 0);
  for (let i = 0; i < 100 && travels.length === 0; i++) {
    climber.pullLadder(-0.3);
    frames(1);
  }
  climber.arrived();
  const y = player.pos.y;
  assert.ok(y > 5, `now high up the floor below's ladder: ${y}`);
  frames(400);
  assert.equal(climber.active, false);
  assert.equal(player.pos.y, 0);
  assert.deepEqual(dones, [{ how: 'ladder', landed: true }]);
  assert.equal(travels.length, 1, 'carried on down, not through another floor');
});

test('physical ladder: a pause freezes you and drops what was queued', (t) => {
  const { player, climber, travels, frames } = onLadder(t, { up: 'upstairs' }, LADDER_TOP - 0.05);
  const y0 = player.pos.y;
  climber.pullLadder(0.3);
  climber.pausePhysical(true);
  assert.equal(climber.pullLadder(0.3), false);
  frames(120);
  assert.equal(player.pos.y, y0);
  assert.equal(travels.length, 0, 'no auto travel while tracking is lost');
  climber.pausePhysical(false);
  frames(10);
  assert.equal(player.pos.y, y0, 'the queued pull was dropped, not replayed');
  climber.pullLadder(-0.1);
  frames(1);
  assert.ok(near(player.pos.y, y0 - 0.1));
});

test('physical ladder: letting go up high drops you, low steps off, under the floor climbs back up', (t) => {
  {
    const { player, climber, dones, frames } = onLadder(t, {}, 2);
    climber.pullLadder(0.3);
    climber.letGoPhysical();
    assert.equal(climber.active, false);
    assert.equal(player.rig, null);
    assert.deepEqual(dones, [{ how: 'ladder', landed: false }]);
    frames(180);
    assert.equal(player.pos.y, 0);
    assert.equal(player.grounded, true);
  }
  {
    const { player, climber, dones, frames } = onLadder(t, {}, 0.2);
    climber.letGoPhysical();
    frames(60);
    assert.equal(climber.active, false);
    assert.equal(player.pos.y, 0);
    assert.deepEqual(dones, [{ how: 'ladder', landed: true }]);
  }
  {
    const { player, climber, travels, dones, frames } = onLadder(t, { down: 'downstairs' }, 0);
    climber.pullLadder(-0.3);
    climber.pullLadder(-0.3);
    frames(1);
    assert.ok(player.pos.y < -0.5, `under the floor: ${player.pos.y}`);
    climber.letGoPhysical();
    climber.pausePhysical(true);
    frames(120);
    assert.equal(climber.active, false);
    assert.equal(player.pos.y, 0);
    assert.equal(travels.length, 0);
    assert.deepEqual(dones, [{ how: 'ladder', landed: true }]);
  }
});

const angleOf = (p: THREE.Vector3, spot: { x: number; z: number }) => Math.atan2(p.x - spot.x, p.z - spot.z);
const angleNear = (a: number, b: number, eps = 1e-6) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < eps;

test('physical twirl: no canned spin, round only as far as the hands turn, off when let go', (t) => {
  const { player, climber, dones, frames } = rig(t, {});
  const spot = POLES[0];
  player.pos.set(spot.x + 1, 0, spot.z);
  player.camYaw = 0.7;
  player.lookPitch = 0.1;
  climber.twirl(spot, true);
  assert.equal(climber.sliding, 'twirl');
  const a0 = angleOf(player.pos, spot);
  frames(300);
  assert.equal(climber.active, true, 'held: no timed end');
  assert.ok(angleNear(angleOf(player.pos, spot), a0), 'no motion without a turn');
  assert.equal(player.pos.y, 0, 'no canned lift');
  assert.equal(climber.turnPole(0.5), true);
  climber.turnPole(0.25);
  frames(1);
  assert.ok(angleNear(angleOf(player.pos, spot), a0 + 0.75), 'turned once by the sum');
  frames(60);
  assert.ok(angleNear(angleOf(player.pos, spot), a0 + 0.75), 'never turned twice');
  climber.turnPole(-0.25);
  frames(1);
  assert.ok(angleNear(angleOf(player.pos, spot), a0 + 0.5), 'the other way too');
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0]) assert.equal(climber.turnPole(bad), false);
  for (let i = 0; i < 100; i++) climber.turnPole(1e9);
  frames(1);
  assert.ok(angleNear(angleOf(player.pos, spot), a0 + 0.5 + Math.PI / 2), 'one tick at most a quarter turn');
  assert.equal(player.camYaw, 0.7, 'the head is left alone');
  assert.equal(player.lookPitch, 0.1);
  // Tracking lost: frozen, turns refused.
  const a1 = angleOf(player.pos, spot);
  climber.pausePhysical(true);
  assert.equal(climber.turnPole(0.5), false);
  frames(60);
  assert.ok(angleNear(angleOf(player.pos, spot), a1));
  climber.pausePhysical(false);
  climber.letGoPhysical();
  assert.equal(climber.turnPole(0.5), false, 'let go: no more turns');
  frames(60);
  assert.equal(climber.active, false);
  assert.equal(player.rig, null);
  assert.equal(player.pos.y, 0);
  assert.ok(Math.hypot(player.pos.x - spot.x, player.pos.z - spot.z) >= POLE.grip + 0.3 - 1e-6, 'stepped out from the pole');
  assert.deepEqual(dones, [{ how: 'pole', landed: false }]);
});

test('physical slide: gravity and the floors, round the pole only by hand, head untouched', (t) => {
  const { player, climber, travels, frames } = rig(t, { down: 'below' });
  const spot = POLES[0];
  player.pos.set(spot.x + 1, 0, spot.z);
  player.camYaw = 1.1;
  player.lookPitch = -0.3;
  climber.slide(spot, true);
  frames(10);
  assert.equal(player.pos.y, 0, 'no canned hop up');
  frames(10);
  const a0 = angleOf(player.pos, spot);
  for (let i = 0; i < 200 && travels.length === 0; i++) player.update(1 / 60);
  assert.equal(travels.length, 1);
  assert.equal(travels[0].how, 'pole');
  assert.ok(angleNear(angleOf(player.pos, spot), a0), 'no automatic spin');
  assert.equal(player.camYaw, 1.1);
  assert.equal(player.lookPitch, -0.3);
  // Waiting in the dark: turns refused, pause does no harm.
  assert.equal(climber.turnPole(0.4), false);
  climber.pausePhysical(true);
  frames(60);
  climber.arrived();
  // Paused but the floor has come: the slide onto it carries on, and you hang on at it.
  frames(200);
  assert.equal(player.pos.y, 0);
  assert.equal(climber.active, true);
  assert.equal(travels.length, 1, 'no new journey while paused');
  climber.pausePhysical(false);
  climber.turnPole(0.3);
  frames(1);
  assert.ok(angleNear(angleOf(player.pos, spot), a0 + 0.3));
  // Still holding, with a floor below this one too: on down through it.
  for (let i = 0; i < 200 && travels.length === 1; i++) player.update(1 / 60);
  assert.equal(travels.length, 2);
});

test('physical slide: a pause before the floor freezes you and sets off nowhere', (t) => {
  const { player, climber, travels, frames } = rig(t, { down: 'below' });
  const spot = POLES[0];
  player.pos.set(spot.x + 1, 0, spot.z);
  climber.slide(spot, true);
  frames(30);
  const y = player.pos.y;
  assert.ok(y < 0, `sliding: ${y}`);
  climber.pausePhysical(true);
  frames(200);
  assert.equal(player.pos.y, y);
  assert.equal(travels.length, 0);
  climber.pausePhysical(false);
  for (let i = 0; i < 200 && travels.length === 0; i++) player.update(1 / 60);
  assert.equal(travels.length, 1);
});

test('physical slide: let go while waiting, then swing off safely at the floor that comes', (t) => {
  const { player, climber, travels, dones, sounds, frames } = rig(t, { down: 'below' });
  const spot = POLES[0];
  player.pos.set(spot.x + 1, 0, spot.z);
  climber.slide(spot, true);
  for (let i = 0; i < 200 && travels.length === 0; i++) player.update(1 / 60);
  climber.letGoPhysical();
  climber.letGoPhysical();
  frames(60);
  assert.equal(climber.active, true, 'still waiting on the floor below');
  assert.deepEqual(dones, []);
  climber.arrived();
  frames(400);
  assert.equal(climber.active, false);
  assert.equal(player.rig, null);
  assert.equal(player.pos.y, 0);
  assert.ok(near(Math.hypot(player.pos.x - spot.x, player.pos.z - spot.z), POLE.rail + 0.4, 1e-3), 'out past the railing');
  assert.ok(angleNear(angleOf(player.pos, spot), spot.open, 1e-3), 'through its gap');
  assert.deepEqual(dones, [{ how: 'pole', landed: true }]);
  assert.ok(sounds.includes('land'));
  assert.equal(travels.length, 1);
});

test('physical slide: held onto the bottom floor lands on the mat', (t) => {
  const floors: { up?: string; down?: string } = { down: 'garage' };
  const { player, climber, travels, dones, frames } = rig(t, floors);
  const spot = POLES[0];
  player.pos.set(spot.x + 1, 0, spot.z);
  climber.slide(spot, true);
  for (let i = 0; i < 200 && travels.length === 0; i++) player.update(1 / 60);
  // Now on the bottom floor: nothing further down.
  floors.down = undefined;
  climber.arrived();
  frames(400);
  assert.equal(climber.active, false);
  assert.equal(player.pos.y, 0);
  assert.deepEqual(dones, [{ how: 'pole', landed: true }]);
});

test('physical slide: abort while waiting puts you back where you grabbed it', (t) => {
  const { player, climber, travels, dones } = rig(t, { down: 'below' });
  const spot = POLES[0];
  player.pos.set(spot.x + 1, 0, spot.z);
  climber.slide(spot, true);
  for (let i = 0; i < 200 && travels.length === 0; i++) player.update(1 / 60);
  climber.abort();
  assert.equal(climber.active, false);
  assert.deepEqual([player.pos.x, player.pos.y, player.pos.z], [spot.x + 1, 0, spot.z]);
  assert.deepEqual(dones, [{ how: 'pole', landed: false }]);
});
