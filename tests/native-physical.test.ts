import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Climber } from '../src/client/climb.js';
import { NativeControls, type NativeHooks } from '../src/client/native/controls.js';
import { type NativeHand, type NativeInputFrame, type Pose7, LOST_MS } from '../src/client/native/input.js';
import { gongContact, inBackHolster, onLadder } from '../src/client/native/physical.js';
import { PlayerController } from '../src/client/player.js';
import { loadSettings } from '../src/client/state.js';
import { GONG_TOUCH } from '../src/client/world/gong.js';
import { MUZZLE_AT } from '../src/client/world/gun.js';
import { FLOOR, GONG, LADDER, POLES, SLAB, WALL_HEIGHT, type PoleSpot } from '../src/shared/layout.js';

const pose = (x: number, y: number, z: number): Pose7 => [x, y, z, 0, 0, 0, 1];
const hand = (grip: Pose7 = pose(0.2, 1.2, -0.3), patch: Partial<NativeHand> = {}): NativeHand => ({
  active: true,
  grip,
  aim: grip,
  gripTracked: true,
  trigger: 0,
  squeeze: 0,
  a: false,
  b: false,
  menu: false,
  ui: false,
  stick: [0, 0],
  ...patch,
});
const off = (): NativeHand => hand(pose(0, 0, 0), { active: false });

function fixture(t: TestContext, at = new THREE.Vector3()) {
  for (const [name, value] of [
    ['window', new EventTarget()],
    ['document', Object.assign(new EventTarget(), { createElement: () => ({ getContext: () => ({ fillRect() {}, strokeRect() {}, fillText() {}, measureText: () => ({ width: 10 }) }) }) })],
  ] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => (previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name)));
  }
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const player = new PlayerController(camera, new EventTarget() as unknown as HTMLElement, [{ ...FLOOR, bottom: -SLAB, top: 0 }]);
  player.pos.copy(at);
  player.facing = Math.PI;
  let time = 1000;
  let open = false;
  let strikes = 0;
  let uses = 0;
  let travels = 0;
  const shots: { origin: THREE.Vector3; direction: THREE.Vector3 }[] = [];
  const gunEvents: boolean[] = [];
  t.mock.method(performance, 'now', () => time);
  const gong = new THREE.Group();
  gong.position.set(GONG.x, 0, GONG.z);
  scene.add(gong);
  const climber = new Climber(player, { floorThere: () => 'Another floor', travel: () => travels++, sound() {}, done() {} });
  const hooks: NativeHooks = {
    player,
    settings: loadSettings(),
    useE: () => uses++,
    pickFromRay: () => null,
    noteUnder: () => null,
    nextWaiting() {},
    putBack() {},
    carrying: () => null,
    modalOpen: () => open,
    panelOpen: () => open,
    togglePanel: () => {
      open = !open;
    },
    toast() {},
    hudRefresh() {},
    reachOf: () => 4,
    reachAnim() {},
    onTarget() {},
    aimLabel: () => null,
    physical: {
      player,
      climber,
      gong,
      strikeGong: () => strikes++,
      ladderAvailable: () => true,
      poles: () => POLES,
      grabLadder: () => climber.grabLadder(true),
      grabPole: (spot) => climber.twirl(spot, true),
      canDraw: () => !climber.active,
      gunChanged: (held) => gunEvents.push(held),
      fireGun: (origin, direction) => shots.push({ origin: origin.clone(), direction: direction.clone() }),
    },
  };
  const controls = new NativeControls(scene, camera, hooks);
  controls.start();
  const frame = (right: NativeHand = off(), left: NativeHand = off(), patch: Partial<NativeInputFrame> = {}): NativeInputFrame => ({ time: (time += 11), head: pose(0, 1.6, 0), hands: [left, right], ...patch });
  const tick = (...frames: NativeInputFrame[]) => {
    controls.consume(frames);
    controls.update(1 / 30);
  };
  const gun = () => scene.getObjectByName('native-held-magnum');
  const draw = () => {
    tick(frame(hand(pose(0.25, 0.85, 0.3))));
    tick(frame(hand(pose(0.25, 0.85, 0.3), { squeeze: 1 })));
    assert.equal(controls.holdingGun, true);
  };
  return {
    scene,
    controls,
    player,
    climber,
    hooks,
    frame,
    tick,
    gun,
    draw,
    open: (value: boolean) => {
      open = value;
    },
    strikes: () => strikes,
    shots,
    gunEvents,
    uses: () => uses,
    travels: () => travels,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test('gong contact uses a swept fixed disc, approach speed and bounded motion', () => {
  const point = (z: number, x = 0) => new THREE.Vector3(x, GONG_TOUCH.y, z);
  assert.equal(gongContact(point(0.2), point(-0.1), 1 / 90), true, 'a punch can pass through between samples');
  assert.equal(gongContact(point(0.2, 1), point(-0.1, 1), 1 / 90), false, 'frame is not the disc');
  assert.equal(gongContact(point(0.121), point(0.119), 1 / 90), false, 'resting contact is not a strike');
  assert.equal(gongContact(point(1), point(-1), 1 / 90), false, 'tracking jump is not a strike');
  assert.equal(gongContact(point(0.2), point(-0.1), 0.5), false, 'old samples do not supply punch velocity');
});

test('controller punches ring once per approach; resting, UI and occupied grips cannot retrigger', (t) => {
  const r = fixture(t, new THREE.Vector3(GONG.x, 0, GONG.z + 0.6));
  const strike = () => r.tick(...[0.1, -0.05, -0.2, -0.35, -0.45].map((z) => r.frame(hand(pose(0, GONG_TOUCH.y - 0.025, z)))));
  strike();
  assert.equal(r.strikes(), 1);
  r.advance(600);
  for (let i = 0; i < 20; i++) r.tick(r.frame(hand(pose(0, GONG_TOUCH.y - 0.025, -0.45))));
  assert.equal(r.strikes(), 1, 'disc swing and a resting hand do not rearm');
  strike();
  assert.equal(r.strikes(), 2, 'withdrawal re-arms a later approach');
  r.advance(600);
  r.open(true);
  strike();
  assert.equal(r.strikes(), 2, 'workspace navigation suppresses punches');
  r.open(false);
  r.hooks.carrying = () => ({ issue: 1, title: 'A held card' });
  r.tick(r.frame(hand()));
  strike();
  assert.equal(r.strikes(), 2, 'the holding hand does not punch through its card');
});

test('ladder grips use rendered rails and rungs rather than the walk-up point', () => {
  assert.equal(onLadder(new THREE.Vector3(FLOOR.minX + 0.16, 1.2, 0)), true);
  assert.equal(onLadder(new THREE.Vector3(FLOOR.minX + 0.16, 1.34, LADDER.width / 2)), true);
  assert.equal(onLadder(new THREE.Vector3(FLOOR.minX + 0.16, 1.34, 0)), false, 'gap between rungs');
  assert.equal(onLadder(new THREE.Vector3(LADDER.x, 1.2, 0)), false, 'body anchor is not a rung');
});

test('two ladder grips average their motion, consume every batched sample once, and do not feed rig movement back', (t) => {
  const r = fixture(t, new THREE.Vector3(LADDER.x, 0, LADDER.z));
  const grip = (y: number, squeezed = 1) => hand(pose(FLOOR.minX + 0.16 - LADDER.x, y, 0.1), { squeeze: squeezed });
  r.tick(r.frame(grip(1.2, 0), grip(1.2, 0)));
  r.tick(r.frame(grip(1.2), grip(1.2)));
  assert.equal(r.climber.physical, true);
  r.tick(r.frame(grip(1.2), grip(1.2)));
  r.tick(r.frame(grip(1.15), grip(1.15)), r.frame(grip(1.1), grip(1.1)));
  assert.ok(Math.abs(r.player.pos.y - 0.1) < 1e-9, 'two hands produce 10 cm, not 20 cm');
  r.tick(r.frame(grip(1.1), grip(1.1)));
  assert.ok(Math.abs(r.player.pos.y - 0.1) < 1e-9, 'still hands and rig rise add no pull');
  r.tick(r.frame(grip(1.1, 0), grip(1.1)));
  r.tick(r.frame(grip(1.1, 0), grip(1.1)));
  r.tick(r.frame(grip(1.1, 0), grip(1.0)));
  assert.ok(Math.abs(r.player.pos.y - 0.2) < 1e-9, 'the other hand keeps the climb');
  r.open(true);
  r.tick(r.frame(grip(0.9), grip(0.8)));
  assert.ok(Math.abs(r.player.pos.y - 0.2) < 1e-9, 'workspace pauses real pulling');
});

test('invalid grip fallback, pose jumps and tracking interruptions cannot pull the ladder', (t) => {
  const r = fixture(t, new THREE.Vector3(LADDER.x, 0, LADDER.z));
  const grip = (y: number, patch: Partial<NativeHand> = {}) => hand(pose(FLOOR.minX + 0.16 - LADDER.x, y, 0.1), { squeeze: 1, ...patch });
  r.tick(r.frame(grip(1.2, { squeeze: 0 })));
  r.tick(r.frame(grip(1.2, { gripTracked: false })));
  assert.equal(r.climber.active, false, 'an aim fallback cannot grab a rung');
  r.tick(r.frame(grip(1.2, { squeeze: 0 })), r.frame(grip(1.2)));
  r.tick(r.frame(grip(0.2)));
  assert.equal(r.player.pos.y, 0, 'one-meter tracking jump is rejected');
  r.tick(r.frame(off()), r.frame(grip(1.2)));
  assert.equal(r.player.pos.y, 0, 'tracking reacquisition is reanchored');
  r.tick(r.frame(grip(1.1)));
  assert.ok(Math.abs(r.player.pos.y - 0.1) < 1e-9);
});

test('floor scene cleanup preserves a committed ladder journey and arrival finishes despite input reset', (t) => {
  const r = fixture(t, new THREE.Vector3(LADDER.x, WALL_HEIGHT - 1.3, LADDER.z));
  const grip = (y: number, squeezed = 1) => hand(pose(FLOOR.minX + 0.16 - LADDER.x, y, 0.1), { squeeze: squeezed });
  r.tick(r.frame(grip(1.1, 0)), r.frame(grip(1.1)));
  r.tick(r.frame(grip(1.1)), r.frame(grip(0.9)));
  assert.equal(r.travels(), 1);
  assert.equal(r.climber.ladder?.waiting, true);
  r.controls.clearGrab();
  assert.equal(r.climber.ladder?.waiting, true, 'scene teardown never aborts travel');
  r.climber.arrived();
  r.controls.reset();
  for (let i = 0; i < 70; i++) r.tick(r.frame());
  assert.equal(r.climber.active, false, 'auto arrival steps onto the new floor safely');
});

test('held pole stays still until tangential hand motion; grip release steps off', (t) => {
  const spot: PoleSpot = POLES[0];
  const r = fixture(t, new THREE.Vector3(spot.x, 0, spot.z + 0.6));
  const grip = (x: number, squeezed = 1) => hand(pose(x, 1.2, -0.6), { squeeze: squeezed });
  r.tick(r.frame(grip(0, 0)), r.frame(grip(0)));
  assert.equal(r.climber.grip, 'pole');
  r.tick(r.frame(grip(0)));
  const angle = () => Math.atan2(r.player.pos.x - spot.x, r.player.pos.z - spot.z);
  const start = angle();
  r.tick(r.frame(grip(0)));
  assert.ok(Math.abs(angle() - start) < 1e-9, 'no automatic spin');
  r.tick(r.frame(grip(-0.08)));
  assert.ok(angle() > start + 0.1, 'counter-motion moves around the pole');
  r.tick(r.frame(grip(-0.08, 0)));
  for (let i = 0; i < 20; i++) r.tick(r.frame(grip(-0.08, 0)));
  assert.equal(r.climber.active, false);
});

test('back holster excludes the front and follows horizontal heading without head pitch', () => {
  const head = new THREE.Vector3(0, 1.6, 0);
  const q = new THREE.Quaternion();
  assert.equal(inBackHolster(new THREE.Vector3(0.3, 0.8, 0.3), head, q), true);
  assert.equal(inBackHolster(new THREE.Vector3(0.3, 0.8, -0.3), head, q), false);
  assert.equal(inBackHolster(new THREE.Vector3(0.8, 0.8, 0.3), head, q), false);
  q.setFromEuler(new THREE.Euler(0.5, Math.PI / 2, 0));
  assert.equal(inBackHolster(new THREE.Vector3(0.3, 0.8, 0), head, q), true);
});

test('gun draws on a fresh back grip, aims from the canonical muzzle, and grip release suppresses a simultaneous shot', (t) => {
  const r = fixture(t);
  r.draw();
  assert.equal(r.controls.state().hands[1].holding, true);
  assert.deepEqual(r.gun()?.userData.nativeControllerAttachment, { hand: 1, requiresGrip: true });
  for (const z of [0.1, -0.1, -0.3]) r.tick(r.frame(hand(pose(0.25, 1.2, z), { squeeze: 1 })));
  r.tick(r.frame(hand(pose(0.25, 1.2, -0.3), { squeeze: 1, trigger: 1 })));
  assert.equal(r.shots.length, 1);
  const muzzle = r.gun()!.localToWorld(MUZZLE_AT.clone());
  assert.ok(r.shots[0].origin.distanceTo(muzzle) < 1e-9);
  assert.ok(r.shots[0].direction.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-9);
  assert.equal(r.uses(), 0, 'gun trigger does not also dispatch E');
  r.advance(400);
  r.tick(r.frame(hand(pose(0.25, 1.2, -0.3), { squeeze: 1 })));
  r.tick(r.frame(hand(pose(0.25, 1.2, -0.3), { trigger: 1 })));
  assert.equal(r.shots.length, 1, 'a released grip cannot fire');
  assert.equal(r.controls.holdingGun, false);
  assert.equal(r.gun()?.userData.nativeControllerAttachment, undefined, 'dropped gun uses a world transform');
  assert.equal(r.gun()?.visible, true);
  for (let i = 0; i < 35; i++) r.tick(r.frame());
  assert.equal(r.gun(), undefined, 'drop lands and disappears, resetting the holster');
  assert.deepEqual(r.gunEvents, [true, false]);
});

test('back release holsters immediately; menus, fallback poses, loss and focus reset never fire or leave a ghost gun', (t) => {
  const r = fixture(t);
  r.draw();
  r.tick(r.frame(hand(pose(0.25, 0.85, 0.3))));
  assert.equal(r.gun(), undefined, 'back release does not drop to the floor');
  r.draw();
  r.open(true);
  r.tick(r.frame(hand(pose(0.25, 0.85, 0.3), { squeeze: 1, trigger: 1 })));
  assert.equal(r.shots.length, 0, 'open workspace suppresses weapon firing');
  r.open(false);
  r.tick(r.frame(hand(pose(0.25, 0.85, 0.3), { squeeze: 1, gripTracked: false })));
  assert.equal(r.gun()?.visible, false);
  r.tick(r.frame(hand(pose(0.25, 0.85, 0.3), { squeeze: 1, trigger: 1, gripTracked: false })));
  assert.equal(r.shots.length, 0, 'an aim fallback cannot fire');
  r.advance(LOST_MS);
  r.tick(r.frame(off()));
  assert.equal(r.gun(), undefined);
  r.tick(r.frame(hand(pose(0.25, 0.85, 0.3), { squeeze: 1, trigger: 1 })));
  assert.equal(r.controls.holdingGun, false, 'reconnect with held buttons never draws or fires');
  r.tick(r.frame(hand(pose(0.25, 0.85, 0.3))));
  r.draw();
  r.controls.reset();
  assert.equal(r.gun(), undefined);
  assert.equal(r.controls.holdingGun, false);
});
