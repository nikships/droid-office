import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Climber } from '../src/client/climb.js';
import { NativeControls, type NativeHooks } from '../src/client/native/controls.js';
import { type NativeHand, type NativeInputFrame, type Pose7, LOST_MS } from '../src/client/native/input.js';
import { type DownedBodies, gongContact, inBackHolster, onLadder } from '../src/client/native/physical.js';
import { PlayerController } from '../src/client/player.js';
import { loadSettings } from '../src/client/state.js';
import { GONG_TOUCH } from '../src/client/world/gong.js';
import { INDOOR_LIGHT, MUZZLE_AT, heldGunFill } from '../src/client/world/gun.js';
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
  const kicked = new THREE.Vector3(0, 0, 1).transformDirection(r.gun()!.matrixWorld);
  assert.ok(kicked.y > 0.2, 'the shot kicks the muzzle up at once');
  assert.equal(r.uses(), 0, 'gun trigger does not also dispatch E');
  r.advance(400);
  r.tick(r.frame(hand(pose(0.25, 1.2, -0.3), { squeeze: 1 })));
  const muzzle = r.gun()!.localToWorld(MUZZLE_AT.clone());
  assert.ok(r.shots[0].origin.distanceTo(muzzle) < 1e-9, 'the bullet left the muzzle as aimed, before the kick');
  assert.ok(r.shots[0].direction.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-9);
  r.tick(r.frame(hand(pose(0.25, 1.2, -0.3), { trigger: 1 })));
  assert.equal(r.shots.length, 1, 'a released grip cannot fire');
  assert.equal(r.controls.holdingGun, false);
  assert.equal(r.gun()?.userData.nativeControllerAttachment, undefined, 'dropped gun uses a world transform');
  assert.equal(r.gun()?.visible, true);
  for (let i = 0; i < 35; i++) r.tick(r.frame());
  assert.equal(r.gun(), undefined, 'drop lands and disappears, resetting the holster');
  assert.deepEqual(r.gunEvents, [true, false]);
});

test('a shot kicks the held gun up about the wrist in its own frame, still up 133 ms on, back on the aim by 0.3 s', (t) => {
  const r = fixture(t);
  r.draw();
  const aimed = pose(0.25, 1.2, -0.3);
  for (const z of [0.1, -0.1, -0.3]) r.tick(r.frame(hand(pose(0.25, 1.2, z), { squeeze: 1 })));
  const gun = r.gun()!;
  const rest = gun.getWorldPosition(new THREE.Vector3());
  const muzzleRise = () => THREE.MathUtils.radToDeg(Math.asin(new THREE.Vector3(0, 0, 1).transformDirection(gun.matrixWorld).y));
  assert.ok(Math.abs(muzzleRise()) < 1e-6);
  r.tick(r.frame(hand(aimed, { squeeze: 1, trigger: 1 })));
  assert.equal(r.shots.length, 1);
  assert.ok(muzzleRise() > 13, `the shot's own frame shows the kick (${muzzleRise().toFixed(1)} deg)`);
  const kicked = gun.getWorldPosition(new THREE.Vector3());
  assert.ok(kicked.y > rest.y + 0.005, 'the fist rides up round the wrist');
  assert.ok(kicked.z > rest.z + 0.02, 'and slides back toward you');
  // frame() adds 11 ms: these land 133 ms and 300 ms after the shot.
  r.advance(122);
  r.tick(r.frame(hand(aimed, { squeeze: 1 })));
  assert.ok(muzzleRise() > 4 && muzzleRise() < 9, `still coming down 133 ms on (${muzzleRise().toFixed(1)} deg)`);
  r.advance(156);
  r.tick(r.frame(hand(aimed, { squeeze: 1 })));
  assert.ok(muzzleRise() < 0.5, `back on the aim by 0.3 s (${muzzleRise().toFixed(2)} deg)`);
  r.advance(100);
  r.tick(r.frame(hand(aimed, { squeeze: 1 })));
  assert.ok(gun.getWorldPosition(new THREE.Vector3()).distanceTo(rest) < 1e-9, 'home exactly, in the fist');
});

test('the held gun is lit like the hand holding it, for how lit it is where it is', (t) => {
  const r = fixture(t);
  const levels: THREE.Vector3[] = [];
  let level = INDOOR_LIGHT;
  r.hooks.physical!.lightAt = (p) => {
    levels.push(p.clone());
    return level;
  };
  r.draw();
  const steel = () => {
    let m: THREE.MeshToonMaterial | null = null;
    r.gun()!.traverse((o) => {
      if (o.name === 'gun-steel') m = (o as THREE.Mesh).material as THREE.MeshToonMaterial;
    });
    return m as unknown as THREE.MeshToonMaterial;
  };
  assert.ok(Math.abs(steel().emissive.g - steel().color.g * heldGunFill(INDOOR_LIGHT)) < 1e-9, 'lit from the frame it is drawn');
  assert.ok(levels.length > 0 && levels.every((p) => p.distanceTo(r.gun()!.getWorldPosition(new THREE.Vector3())) < 0.5), 'asked where the gun is');
  level = 0.05;
  r.tick(r.frame(hand(pose(0.25, 1.2, -0.3), { squeeze: 1 })));
  assert.ok(Math.abs(steel().emissive.g - steel().color.g * heldGunFill(0.05)) < 1e-9, 'out on a dark street it dims with your hands');
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

for (const activeHand of [0, 1] as const) {
  test(`the ${activeHand === 0 ? 'left' : 'right'} gun follows aim orientation while its handle stays at the tracked grip`, (t) => {
    const r = fixture(t);
    // A forward pointing pose with a pitched grip reproduces the upward barrel in the worn capture.
    const gripPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.15);
    const aim = new THREE.Quaternion();
    const sample = (z: number, squeeze: number, trigger = 0) => {
      const grip = aim.clone().multiply(gripPitch);
      const h = hand([0.25, 0.85, z, grip.x, grip.y, grip.z, grip.w], { aim: [0.28, 0.9, z - 0.08, aim.x, aim.y, aim.z, aim.w], squeeze, trigger });
      return r.frame(activeHand === 1 ? h : off(), activeHand === 0 ? h : off());
    };
    r.tick(sample(0.3, 0));
    r.tick(sample(0.3, 1));
    assert.equal(r.controls.holdingGun, true);
    for (const rotation of [new THREE.Euler(0, 0, 0), new THREE.Euler(0.35, -0.7, 0.25), new THREE.Euler(-0.2, 0.6, -0.4)]) {
      aim.setFromEuler(rotation);
      r.tick(sample(0.1, 1), sample(-0.1, 1), sample(-0.3, 1));
      const gun = r.gun()!;
      const expected = new THREE.Vector3(0, 0, -1).applyQuaternion(aim).transformDirection(r.controls.rig.matrixWorld);
      const bore = new THREE.Vector3(0, 0, 1).transformDirection(gun.matrixWorld);
      assert.ok(bore.distanceTo(expected) < 1e-9, 'pitch, yaw and roll follow the pointing pose');
      const expectedHandle = new THREE.Vector3(0.25, 0.85, -0.3).applyMatrix4(r.controls.rig.matrixWorld);
      assert.ok(gun.getWorldPosition(new THREE.Vector3()).distanceTo(expectedHandle) < 1e-9, 'the aim pose offset never moves the handle out of the fist');
      r.advance(400);
      r.tick(sample(-0.3, 1), sample(-0.3, 1, 1));
      const shot = r.shots.at(-1)!;
      assert.ok(shot.direction.distanceTo(expected) < 1e-9, 'shots follow the corrected visual bore');
      r.advance(400);
      r.tick(sample(-0.3, 1));
      assert.ok(shot.origin.distanceTo(gun.localToWorld(MUZZLE_AT.clone())) < 1e-9, 'the muzzle returns to where the bullet left it');
      assert.equal(r.uses(), 0);
    }
    assert.equal(r.shots.length, 3);
  });
}

test("the trigger stays live after a hit: nothing holds the next shot but the revolver's own 350 ms", (t) => {
  const r = fixture(t);
  r.draw();
  for (const z of [0.1, -0.1, -0.3]) r.tick(r.frame(hand(pose(0.25, 1.2, z), { squeeze: 1 })));
  r.tick(r.frame(hand(pose(0.25, 1.2, -0.3), { squeeze: 1, trigger: 1 })));
  r.tick(r.frame(hand(pose(0.25, 1.2, -0.3), { squeeze: 1 })));
  r.tick(r.frame(hand(pose(0.25, 1.2, -0.3), { squeeze: 1, trigger: 1 })));
  assert.equal(r.shots.length, 1, 'a second pull inside 350 ms is the hammer still coming back');
  r.advance(400);
  r.tick(r.frame(hand(pose(0.25, 1.2, -0.3), { squeeze: 1 })));
  r.tick(r.frame(hand(pose(0.25, 1.2, -0.3), { squeeze: 1, trigger: 1 })));
  assert.equal(r.shots.length, 2);
  assert.equal(r.uses(), 0, 'the held gun owns the trigger');
});

/**
 * A body lying on the floor at `at` with its revival window open: a free hand's grip within 0.45 m
 * of it, or a ray passing within 0.3 m of it no more than 2.4 m away, is at it. Records every
 * revival the use action asks for; `open` false refuses them (the window closed).
 */
function body(r: ReturnType<typeof fixture>, at = new THREE.Vector3(0.2, 0.2, -0.4)) {
  const log = { revived: [] as string[], open: true, asked: 0 };
  const bodies: DownedBodies = {
    at: (grip, ray) => {
      log.asked++;
      if (grip.distanceTo(at) <= 0.45) return 'w1';
      return ray && ray.distanceToPoint(at) <= 0.3 && ray.origin.distanceTo(at) <= 2.4 ? 'w1' : null;
    },
    revive: (id) => {
      if (!log.open) return false;
      log.revived.push(id);
      return true;
    },
  };
  r.hooks.physical!.bodies = bodies;
  return log;
}

const firm = (r: ReturnType<typeof fixture>, idx: 0 | 1) => r.controls.state().haptics.some((h) => h.hand === idx && h.strength >= 0.9);

test('the trigger of a free hand touching a body on the floor revives it, with a firm pulse in that hand', (t) => {
  const r = fixture(t);
  const log = body(r);
  const at = (patch: Partial<NativeHand> = {}) => hand(pose(0.2, 0.3, -0.4), patch);
  r.tick(r.frame(off(), at()));
  r.tick(r.frame(off(), at()));
  r.controls.state();
  r.tick(r.frame(off(), at({ trigger: 1 })));
  assert.deepEqual(log.revived, ['w1']);
  assert.ok(firm(r, 0), 'a firm pulse answers at once');
  assert.equal(r.uses(), 0, 'nothing else hears that trigger');
  assert.equal(r.controls.state().hands[0].holding, false, 'the hand holds nothing: no grab, no haul');
  // Squeezing at the body grabs nothing either: the use action is the trigger.
  r.tick(r.frame(off(), at()));
  r.tick(r.frame(off(), at({ squeeze: 1 })));
  assert.equal(r.controls.state().hands[0].holding, false);
  assert.deepEqual(log.revived, ['w1']);
});

test('pointing a free hand at a body from a step away and pulling the trigger revives it; from too far it does not', (t) => {
  const r = fixture(t);
  const log = body(r, new THREE.Vector3(-0.2, 1, -1.9));
  const at = (z: number, patch: Partial<NativeHand> = {}) => hand(pose(-0.2, 1, z), patch);
  r.tick(r.frame(off(), at(-0.3)));
  r.tick(r.frame(off(), at(-0.3)));
  r.tick(r.frame(off(), at(-0.3, { trigger: 1 })));
  assert.deepEqual(log.revived, ['w1'], 'pointing at it 1.6 m away');
  const far = body(r, new THREE.Vector3(-0.2, 1, -3.2));
  r.tick(r.frame(off(), at(-0.3)));
  r.tick(r.frame(off(), at(-0.3, { trigger: 1 })));
  assert.deepEqual(far.revived, [], 'not from 2.9 m');
});

test("the gun hand's trigger fires and never revives; a refused revival, an untracked grip or an open workspace revive nothing", (t) => {
  const r = fixture(t);
  r.draw();
  const log = body(r, new THREE.Vector3(0.25, 0.85, -0.3));
  for (const z of [0.1, -0.1, -0.3]) r.tick(r.frame(hand(pose(0.25, 0.9, z), { squeeze: 1 })));
  r.tick(r.frame(hand(pose(0.25, 0.9, -0.3), { squeeze: 1, trigger: 1 })));
  assert.equal(r.shots.length, 1, 'the gun fires');
  assert.deepEqual(log.revived, [], 'even with its muzzle on the body');
  const at = (patch: Partial<NativeHand> = {}) => hand(pose(0.25, 0.8, -0.3), patch);
  log.open = false;
  r.tick(r.frame(off(), at()));
  r.tick(r.frame(off(), at()));
  r.controls.state();
  r.tick(r.frame(off(), at({ trigger: 1 })));
  assert.deepEqual(log.revived, []);
  assert.equal(firm(r, 0), false, 'a refused revival gives no answering pulse');
  log.open = true;
  r.tick(r.frame(off(), at({ gripTracked: false })));
  r.tick(r.frame(off(), at({ gripTracked: false, trigger: 1 })));
  assert.deepEqual(log.revived, [], 'never through the aim-pose fallback');
  r.tick(r.frame(off(), at()));
  r.tick(r.frame(off(), at()));
  r.open(true);
  r.tick(r.frame(off(), at({ trigger: 1 })));
  assert.deepEqual(log.revived, [], 'the workspace pauses world actions');
  r.open(false);
  r.tick(r.frame(off(), at()));
  r.tick(r.frame(off(), at({ trigger: 1 })));
  assert.deepEqual(log.revived, ['w1']);
});

test('a free hand arriving at a body feels a soft tick once, and no aim words show while it is there', (t) => {
  const r = fixture(t);
  body(r);
  r.hooks.pickFromRay = () => ({ it: { kind: 'desk', deskId: 'desk-1' } as never, near: true, hit: { point: new THREE.Vector3(0, 0.7, -1), distance: 1 } as THREE.Intersection });
  r.hooks.aimLabel = () => "E · Pixel's terminal";
  const away = hand(pose(0.6, 1.3, 0.2));
  const at = hand(pose(0.2, 0.3, -0.4));
  r.tick(r.frame(off(), away));
  r.tick(r.frame(off(), away));
  assert.equal(r.controls.state().aim, "E · Pixel's terminal");
  r.tick(r.frame(off(), hand(pose(0.4, 0.8, -0.2))));
  r.tick(r.frame(off(), hand(pose(0.25, 0.45, -0.35))));
  r.tick(r.frame(off(), at));
  const ticks = (s: ReturnType<typeof r.controls.state>) => s.haptics.filter((h) => h.hand === 0 && h.strength === 0.2).length;
  let state = r.controls.state();
  assert.equal(ticks(state), 1, 'a soft tick as it arrives');
  assert.equal(state.aim, null, 'no words in front of you at the body');
  r.tick(r.frame(off(), at));
  r.tick(r.frame(off(), at));
  state = r.controls.state();
  assert.equal(ticks(state), 0, 'once, not on every frame');
  r.tick(r.frame(off(), hand(pose(0.25, 0.45, -0.35))));
  r.tick(r.frame(off(), hand(pose(0.4, 0.8, -0.2))));
  r.tick(r.frame(off(), away));
  assert.equal(r.controls.state().aim, "E · Pixel's terminal", 'away from it the aim words come back');
});
