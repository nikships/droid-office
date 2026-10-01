import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { NativeControls, type NativeHooks } from '../src/client/native/controls.js';
import { bodyAt, PendingShots } from '../src/client/native/downed.js';
import type { NativeHand, NativeInputFrame, Pose7 } from '../src/client/native/input.js';
import { ShotStage, type ShotOutcome, type StageReviveOptions, type StageReviveResult, type StageShotOptions, type StageShotResult, matchWorker, stageAim } from '../src/client/native/stage.js';
import { PlayerController } from '../src/client/player.js';
import { loadSettings } from '../src/client/state.js';
import { Casualties, FALL_TIME, REVIVE_WINDOW, RISE_TIME } from '../src/client/world/casualties.js';
import { Worker } from '../src/client/world/character.js';
import { gunHit } from '../src/client/world/gun.js';
import { buildOffice, type Office } from '../src/client/world/office.js';

// Headset shots against the real office and real seated workers, through the controller path:
// scripted samples → NativeControls → the physical trigger → the muzzle ray → the local fall and
// worker.shoot (as main.ts landShot), against a stand-in for the server's revival window; and
// revivals through the use action → native/physical.ts useAtBody → worker.revive → the rise.

/** Text canvases and font loading, enough for the office and characters to build without WebGL. */
function stubDom(t: TestContext) {
  const canvas = () => {
    const c = { width: 1, height: 1, getContext: () => ctx, toDataURL: () => '' };
    const ctx: unknown = new Proxy(
      {
        canvas: c,
        measureText: (s: string) => ({ width: s.length * 12 }),
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        createImageData: () => ({ data: new Uint8ClampedArray(4) }),
      },
      { get: (target, key) => Reflect.get(target, key) ?? (() => {}) },
    );
    return c;
  };
  for (const [name, value] of [
    ['window', new EventTarget()],
    ['document', Object.assign(new EventTarget(), { createElement: canvas, fonts: { ready: new Promise(() => {}) } })],
  ] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => (previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name)));
  }
}

let built: { office: Office; scene: THREE.Scene } | null = null;

/** One real office for the file (it is the expensive part); each test seats its own worker. */
function office(t: TestContext) {
  stubDom(t);
  if (!built) {
    const o = buildOffice();
    const scene = new THREE.Scene();
    scene.add(o.group);
    built = { office: o, scene };
  }
  return built;
}

function seat(t: TestContext, deskIndex: number, name = 'Pixel') {
  const { office: o, scene } = office(t);
  const desk = [...o.desks.values()].filter((d) => d.def.id.startsWith('desk-'))[deskIndex];
  const worker = new Worker(name, '#86b2d4');
  desk.seatAnchor.add(worker.root);
  worker.update(1 / 60, 1);
  scene.updateMatrixWorld(true);
  t.after(() => {
    worker.root.removeFromParent();
    worker.dispose();
  });
  const id = name.toLowerCase().replace(/\W+/g, '-');
  const workers = new Map<THREE.Object3D, string>([[worker.root, id]]);
  const facing = new THREE.Vector3(0, 0, 1).transformDirection(worker.root.matrixWorld);
  const middle = worker.root.localToWorld(new THREE.Vector3(0, 0.62, 0));
  return { office: o, scene, desk, worker, workers, facing, middle, id, name };
}

const pose = (x: number, y: number, z: number): Pose7 => [x, y, z, 0, 0, 0, 1];
const idle = (): NativeHand => ({ active: false, aim: pose(0, 0, 0), grip: pose(0, 0, 0), trigger: 0, squeeze: 0, stick: [0, 0], a: false, b: false, menu: false, ui: false });

/**
 * NativeControls on the real office, wired as main.ts wires them: the muzzle ray, the local fall
 * and worker.shoot, the use action at the body and worker.revive. `server` stands in for the
 * office: it owns each shot worker's revival window and answers on the next poll.
 */
function headset(t: TestContext, f: ReturnType<typeof seat>, debuggable = true) {
  const camera = new THREE.PerspectiveCamera();
  const player = new PlayerController(camera, new EventTarget() as unknown as HTMLElement, f.office.colliders);
  player.pos.set(f.middle.x + 3, 0, f.middle.z + 3);
  let time = 1000;
  t.mock.method(performance, 'now', () => time);
  const shots: { workerId: string | null; outcome: ShotOutcome; point: THREE.Vector3 | null }[] = [];
  /** Every message to the office, in order. */
  const sent: { t: 'worker.shoot' | 'worker.revive'; workerId: string }[] = [];
  const outbox: typeof sent = [];
  /** The office's revival windows (performance-clock ms), as WorkerInfo.downedUntil. */
  const server = new Map<string, number>();
  const pending = new PendingShots();
  const send = (msg: (typeof sent)[number]) => {
    sent.push(msg);
    outbox.push(msg);
  };
  const raycaster = new THREE.Raycaster();
  const casualties = new Casualties(f.scene, () => 0, {
    spawnMedic: () => ({ root: new THREE.Group(), update() {}, dispose() {} }),
    onLand() {},
    onSiren() {},
    onBeat() {},
    left: (id) => (server.has(id) ? (server.get(id)! - time) / 1000 : null),
    riseTime: RISE_TIME,
  });
  t.after(() => casualties.clear());
  /** The office answers: windows open and close, and every client syncs its workers (main.ts syncWorkers). */
  const deliver = () => {
    for (const msg of outbox.splice(0)) {
      if (msg.t === 'worker.shoot' && !server.has(msg.workerId)) server.set(msg.workerId, time + REVIVE_WINDOW * 1000);
      if (msg.t === 'worker.revive' && (server.get(msg.workerId) ?? 0) > time) server.delete(msg.workerId);
    }
    if (server.has(f.id)) {
      pending.settle(f.id);
      casualties.shoot(f.id, f.worker, f.desk.seatAnchor);
    } else if (!pending.holds(f.id, time)) casualties.revive(f.id);
  };
  let stage: ShotStage | null = null;
  const hooks: NativeHooks = {
    player,
    settings: loadSettings(),
    useE() {},
    pickFromRay: () => null,
    noteUnder: () => null,
    nextWaiting() {},
    putBack() {},
    carrying: () => null,
    modalOpen: () => false,
    panelOpen: () => false,
    togglePanel() {},
    toast() {},
    hudRefresh() {},
    reachOf: () => 4,
    reachAnim() {},
    onTarget() {},
    aimLabel: () => null,
    physical: {
      player,
      climber: { active: false, physical: false, grip: null, pullLadder: () => false, turnPole: () => false, pausePhysical() {}, letGoPhysical() {} },
      gong: new THREE.Group(),
      strikeGong() {},
      ladderAvailable: () => false,
      poles: () => [],
      grabLadder() {},
      grabPole() {},
      canDraw: () => true,
      gunChanged() {},
      // main.ts fireNativeGun → resolveGunShot → landShot, minus the effects.
      fireGun: (origin, direction) => {
        raycaster.set(origin, direction);
        raycaster.near = 0;
        raycaster.far = Infinity;
        const result = gunHit(raycaster, f.office.group, new Map([...f.workers, [f.worker.root, f.id]]));
        const workerId = result?.workerId ?? null;
        let outcome: ShotOutcome = workerId === null ? 'miss' : 'hit';
        if (workerId !== null && !server.has(workerId)) {
          if (casualties.shoot(workerId, f.worker, f.desk.seatAnchor, direction)) pending.add(workerId, time);
          send({ t: 'worker.shoot', workerId });
          outcome = 'down';
        }
        shots.push({ workerId, outcome, point: result?.hit.point.clone() ?? null });
        stage?.shot({ workerId, outcome, solid: result?.hit.object.name ?? null, distance: result?.hit.distance ?? null });
      },
      bodies: {
        at: (grip, ray) => bodyAt(casualties, grip, ray),
        // main.ts reviveBody.
        revive: (id) => {
          if ((server.get(id) ?? 0) <= time || !casualties.rouse(id)) return false;
          send({ t: 'worker.revive', workerId: id });
          return true;
        },
      },
    },
  };
  const controls = new NativeControls(f.scene, camera, hooks);
  controls.start();
  t.after(() => controls.stop());
  stage = new ShotStage({
    controls,
    player,
    worker: (key) => matchWorker(key, [{ id: f.id, name: f.name, root: f.worker.root }]),
    downed: (id) => {
      const chest = casualties.dying(id) ? casualties.chest(id) : null;
      if (!chest) return null;
      const open = chest.clone().sub(f.desk.seatAnchor.getWorldPosition(new THREE.Vector3())).setY(0);
      const until = server.get(id);
      return { state: until !== undefined && until <= time ? 'closed' : casualties.roused(id) ? 'roused' : casualties.lyingFor(id) === null ? 'falling' : 'lying', chest, open };
    },
    lineOfFire: (muzzle, direction, id) => gunHit(new THREE.Raycaster(muzzle, direction), f.office.group, new Map([...f.workers, [f.worker.root, f.id]]))?.workerId === id,
    blocked: () => null,
    eye: () => camera.position.clone(),
    clearPanel() {},
    revive: (id) => {
      if (!hooks.physical!.bodies!.revive(id) && server.has(id)) send({ t: 'worker.revive', workerId: id });
    },
    now: () => time,
  });
  stage.debuggable = debuggable;
  /** One Java poll: three 90 Hz samples from a still, tracked headset, then a gameplay update; the office answers. */
  const poll = () => {
    if (!stage!.frozen) {
      const frames: NativeInputFrame[] = [0, 1, 2].map(() => ({ time: (time += 11), head: [0, 1.62, 0, 0, 0, 0, 1], hands: [idle(), idle()] }));
      controls.consume(frames);
      controls.update(1 / 30);
      casualties.update(1 / 30, time / 1000);
    } else time += 33;
    stage!.tick();
    deliver();
  };
  const wait = (seconds: number) => {
    for (let i = 0; i < Math.ceil(seconds * 30); i++) poll();
  };
  /** The page's __office.stageShot / stageRevive, with polls arriving until it resolves. */
  const settle = async <R>(started: Promise<R>): Promise<R> => {
    let result: R | null = null;
    void started.then((r) => (result = r));
    for (let i = 0; i < 150 && !result; i++) {
      poll();
      await Promise.resolve();
    }
    assert.ok(result, 'the staged act resolved');
    return result;
  };
  const stageShot = (options: StageShotOptions): Promise<StageShotResult> => settle(stage!.run(options));
  const stageRevive = (options: StageReviveOptions): Promise<StageReviveResult> => settle(stage!.revive(options));
  /** Lets the office move on by `ms` without anything else happening (the deadline passing). */
  const skip = (ms: number) => {
    time += ms;
  };
  return { controls, player, stage, casualties, shots, sent, server, poll, wait, skip, stageShot, stageRevive };
}

/** Degrees around the worker from in front of its face, toward its left: front, both sides and diagonals. */
const ANGLES = [15, 65, 100, -40, -95];

test('native: a held gun drops a Target worker through the trigger path at every range, from every open side; only worker.shoot goes out', async (t) => {
  const f = seat(t, 0, 'Target 1');
  const h = headset(t, f);
  for (const angle of ANGLES)
    for (const gap of [0.04, 0.3, 1.2, 2.2]) {
      const before = h.shots.length;
      const sent = h.sent.length;
      const result = await h.stageShot({ worker: 'Target 1', gap, angle, pitch: 15 });
      assert.equal(result.ok, true, `${gap} m at ${angle}°: ${result.reason ?? ''}`);
      assert.equal(h.shots.length, before + 1, `${gap} m at ${angle}°: the trigger fired once`);
      const shot = h.shots.at(-1)!;
      assert.equal(shot.workerId, f.id, `${gap} m at ${angle}°: struck ${result.solid ?? 'nothing'} instead`);
      assert.equal(result.outcome, 'down');
      assert.ok(shot.point!.distanceTo(new THREE.Vector3(...result.surface!)) < 0.06, `${gap} m at ${angle}°: struck where the bore meets the body`);
      assert.deepEqual(h.sent.slice(sent), [{ t: 'worker.shoot', workerId: f.id }], 'the shot asks the office to down it, and nothing else');
      assert.equal(h.casualties.dying(f.id), true, 'it is down at once, before the office answers');
      h.stage.release();
      h.wait(RISE_TIME + 0.2);
      assert.equal(h.sent.at(-1)?.t, 'worker.revive', 'release asks the office to revive it');
      assert.equal(f.worker.root.parent, f.desk.seatAnchor, 'back in its chair');
    }
});

test('native: staged shots refuse anyone not named Target, and a worker already down', async (t) => {
  const pixel = seat(t, 1, 'Pixel');
  const p = headset(t, pixel);
  const refused = await p.stageShot({ worker: 'Pixel' });
  assert.equal(refused.ok, false);
  assert.match(refused.reason ?? '', /Target/);
  assert.deepEqual(p.sent, []);
  assert.equal(p.shots.length, 0);

  const target = seat(t, 2, 'Target 2');
  const h = headset(t, target);
  assert.equal((await h.stageShot({ worker: 'target 2' })).outcome, 'down');
  h.wait(FALL_TIME);
  const again = await h.stageShot({ worker: 'target 2' });
  assert.equal(again.ok, false, 'a downed worker is not shot again');
  assert.match(again.reason ?? '', /stageRevive/);
  assert.deepEqual(
    h.sent.map((m) => m.t),
    ['worker.shoot'],
  );
  h.stage.release();
});

test('native: a free hand at the body revives it through the use action, touching it or pointing at it from a step away', async (t) => {
  const f = seat(t, 3, 'Target 3');
  const h = headset(t, f);
  assert.equal((await h.stageRevive({ worker: 'Target 3' })).ok, false, 'nothing to revive while it sits');
  assert.equal((await h.stageShot({ worker: 'Target 3', angle: 40 })).outcome, 'down');
  h.wait(FALL_TIME + 0.2);
  const frozen = await h.stageRevive({ worker: 'Target 3', freezeMs: 100 });
  assert.equal(frozen.ok, true, frozen.reason);
  assert.equal(frozen.roused, true, 'the use action landed on the body');
  assert.deepEqual(
    h.sent.map((m) => m.t),
    ['worker.shoot', 'worker.revive'],
  );
  h.stage.release(false);
  h.wait(RISE_TIME + 0.2);
  assert.equal(f.worker.root.parent, f.desk.seatAnchor, 'it got back up into its chair');
  assert.equal(h.controls.staging, false, 'the controller is handed back');

  assert.equal((await h.stageShot({ worker: 'Target 3', angle: -40 })).outcome, 'down');
  h.wait(FALL_TIME + 0.2);
  const pointed = await h.stageRevive({ worker: 'Target 3', how: 'point' });
  assert.equal(pointed.ok, true, pointed.reason);
  assert.equal(pointed.revived, true, 'revived by pointing at it');
  h.wait(RISE_TIME);
  assert.equal(f.worker.root.parent, f.desk.seatAnchor);
  assert.equal(h.shots.length, 2, 'the free hand fired nothing');
});

test('native: once the window has closed nothing revives it, and the body stays for the medics', async (t) => {
  const f = seat(t, 5, 'Target 4');
  const h = headset(t, f);
  assert.equal((await h.stageShot({ worker: 'Target 4' })).outcome, 'down');
  h.wait(FALL_TIME + 0.2);
  h.skip(REVIVE_WINDOW * 1000);
  h.wait(0.1);
  const late = await h.stageRevive({ worker: 'Target 4' });
  assert.equal(late.ok, false);
  assert.match(late.reason ?? '', /window/);
  h.stage.release();
  assert.deepEqual(
    h.sent.map((m) => m.t),
    ['worker.shoot'],
    'no revival goes out',
  );
  assert.equal(h.casualties.dying(f.id), true);
});

test('the staging hooks are inert without a debuggable host, and clean up after themselves', async (t) => {
  const f = seat(t, 4, 'Target 5');
  const h = headset(t, f, false);
  const refused = await h.stage.run({ worker: 'Target 5' });
  assert.equal(refused.ok, false);
  assert.match(refused.reason ?? '', /debuggable/);
  assert.equal((await h.stage.revive({ worker: 'Target 5' })).ok, false);
  for (let i = 0; i < 40; i++) h.poll();
  assert.equal(h.controls.staging, false);
  assert.equal(h.shots.length, 0, 'nothing is drawn or fired');
  h.stage.debuggable = true;
  assert.equal((await h.stage.run({ worker: 'Nobody' })).ok, false);
  // A staged gun has no real controller under it, so it is drawn at the scripted pose.
  let run: StageShotResult | null = null;
  void h.stage.run({ worker: 'target 5', gap: 0.3, freezeMs: 100 }).then((r) => (run = r));
  let sawWorldGun = false;
  for (let i = 0; i < 120 && !run; i++) {
    h.poll();
    const gun = f.scene.getObjectByName('native-held-magnum');
    if (gun?.visible && gun.userData.nativeControllerAttachment === undefined) sawWorldGun = true;
    await Promise.resolve();
  }
  const frozen = run as StageShotResult | null;
  assert.ok(frozen?.hit, 'the frozen shot hit');
  assert.ok(sawWorldGun, 'the staged gun is drawn in the world, not on an absent controller');
  assert.ok((frozen?.frozenAfterMs ?? -1) >= 100 && (frozen?.frozenAfterMs ?? 0) < 140, `frozen ${frozen?.frozenAfterMs} ms after the shot`);
  assert.equal(h.stage.frozen, true);
  const gun = f.scene.getObjectByName('native-held-magnum')!;
  const held = gun.matrixWorld.clone();
  for (let i = 0; i < 10; i++) h.poll();
  assert.ok(gun.matrixWorld.equals(held), 'the frozen instant holds');
  h.stage.release();
  assert.equal(h.stage.frozen, false);
  assert.equal(h.controls.staging, false);
  assert.equal(h.controls.holdingGun, false, 'release puts the gun away');
  h.wait(RISE_TIME + 0.2);
  assert.equal(h.casualties.dying(f.id), false, 'release revives the worker');
  assert.equal(f.worker.root.parent, f.desk.seatAnchor);
});

test('desktop: the camera ray strikes the worker up close and across the room, from several sides', (t) => {
  const f = seat(t, 5);
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 100);
  const raycaster = new THREE.Raycaster();
  for (const angle of ANGLES)
    for (const gap of [0.04, 0.3, 2.2]) {
      const aim = stageAim({ target: f.middle, body: f.worker.root, facing: f.facing, angle: THREE.MathUtils.degToRad(angle), pitch: 0.4, gap });
      camera.position.copy(aim.muzzle);
      camera.lookAt(aim.muzzle.clone().add(aim.direction));
      camera.updateMatrixWorld(true);
      raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
      const result = gunHit(raycaster, f.office.group, f.workers);
      assert.equal(result?.workerId, f.id, `camera ${gap} m off at ${angle}°: struck ${result?.hit.object.name || 'nothing'}`);
    }
});

test('a staged act finds its worker by id, by name in any case, or by name without emoji', () => {
  const crew = [
    { id: 'a1', name: 'Pixel 🐚' },
    { id: 'b2', name: 'Byte' },
  ];
  assert.equal(matchWorker('a1', crew)?.name, 'Pixel 🐚');
  assert.equal(matchWorker('pixel', crew)?.id, 'a1');
  assert.equal(matchWorker('PIXEL 🐚', crew)?.id, 'a1');
  assert.equal(matchWorker('byte', crew)?.id, 'b2');
  assert.equal(matchWorker('🐚', crew), null);
  assert.equal(matchWorker('Pix', crew), null, 'part of a word names nobody');
  assert.equal(matchWorker('pixel', [{ id: 'c3', name: 'Pixel (shell)' }])?.id, 'c3', 'leading words name the only worker they start');
  assert.equal(
    matchWorker('pixel', [
      { id: 'c3', name: 'Pixel one' },
      { id: 'c4', name: 'Pixel two' },
    ]),
    null,
    'an ambiguous start names nobody',
  );
});
