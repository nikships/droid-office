import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { NativeControls, type NativeHooks } from '../src/client/native/controls.js';
import { FINISH_AFTER, HAUL_REACH, shootInWorld } from '../src/client/native/downed.js';
import type { NativeHand, NativeInputFrame, Pose7 } from '../src/client/native/input.js';
import { ShotStage, type ShotOutcome, type StageHaulOptions, type StageHaulResult, type StageShotOptions, type StageShotResult, matchWorker, stageAim } from '../src/client/native/stage.js';
import { PlayerController } from '../src/client/player.js';
import { loadSettings } from '../src/client/state.js';
import { Casualties, FALL_TIME } from '../src/client/world/casualties.js';
import { Worker } from '../src/client/world/character.js';
import { gunHit } from '../src/client/world/gun.js';
import { buildOffice, type Office } from '../src/client/world/office.js';

// Headset shots against the real office and real seated workers, through the controller path:
// scripted samples → NativeControls → the physical trigger → the muzzle ray → the in-world
// outcome (native/downed.ts), and hauls through the grip → native/physical.ts haul → casualties.

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

/** NativeControls on the real office, wired as main.ts wires them: the muzzle ray, the in-world outcome, the casualties and the haul. */
function headset(t: TestContext, f: ReturnType<typeof seat>, debuggable = true) {
  const camera = new THREE.PerspectiveCamera();
  const player = new PlayerController(camera, new EventTarget() as unknown as HTMLElement, f.office.colliders);
  player.pos.set(f.middle.x + 3, 0, f.middle.z + 3);
  let time = 1000;
  t.mock.method(performance, 'now', () => time);
  const shots: { workerId: string | null; outcome: ShotOutcome; point: THREE.Vector3 | null }[] = [];
  const sent: string[] = [];
  const kills = new Set<string>();
  const raycaster = new THREE.Raycaster();
  const casualties = new Casualties(f.scene, () => 0, { spawnMedic: () => ({ root: new THREE.Group(), update() {}, dispose() {} }), onLand() {}, onSiren() {} });
  t.after(() => casualties.clear());
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
        const outcome: ShotOutcome =
          workerId === null
            ? 'miss'
            : shootInWorld(casualties, workerId, f.worker, f.desk.seatAnchor, direction, kills, (id) => {
                kills.add(id);
                sent.push(id);
              });
        shots.push({ workerId, outcome, point: result?.hit.point.clone() ?? null });
        stage?.shot({ workerId, outcome, solid: result?.hit.object.name ?? null, distance: result?.hit.distance ?? null });
      },
      bodies: {
        within: (point) => casualties.reach(point, HAUL_REACH),
        haul: (id, lift) => casualties.haul(id, lift),
        letGo: (id) => casualties.letGo(id),
        revive: (id) => void casualties.revive(id),
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
      const chest = casualties.chest(id);
      if (!chest) return null;
      const open = chest.clone().sub(f.desk.seatAnchor.getWorldPosition(new THREE.Vector3())).setY(0);
      return { state: kills.has(id) ? 'finished' : casualties.lyingFor(id) === null ? 'falling' : 'lying', chest, open };
    },
    lineOfFire: (muzzle, direction, id) => gunHit(new THREE.Raycaster(muzzle, direction), f.office.group, new Map([...f.workers, [f.worker.root, f.id]]))?.workerId === id,
    blocked: () => null,
    eye: () => camera.position.clone(),
    clearPanel() {},
    revive: (id) => void casualties.revive(id),
    now: () => time,
  });
  stage.debuggable = debuggable;
  /** One Java poll: three 90 Hz samples from a still, tracked headset, then a gameplay update. */
  const poll = () => {
    if (!stage!.frozen) {
      const frames: NativeInputFrame[] = [0, 1, 2].map(() => ({ time: (time += 11), head: [0, 1.62, 0, 0, 0, 0, 1], hands: [idle(), idle()] }));
      controls.consume(frames);
      controls.update(1 / 30);
      casualties.update(1 / 30, time / 1000);
    } else time += 33;
    stage!.tick();
  };
  const wait = (seconds: number) => {
    for (let i = 0; i < Math.ceil(seconds * 30); i++) poll();
  };
  /** The page's __office.stageShot / stageHaul, with polls arriving until it resolves. */
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
  const stageHaul = (options: StageHaulOptions): Promise<StageHaulResult> => settle(stage!.haul(options));
  return { controls, player, stage, casualties, shots, sent, poll, wait, stageShot, stageHaul };
}

/** Degrees around the worker from in front of its face, toward its left: front, both sides and diagonals. */
const ANGLES = [15, 65, 100, -40, -95];

test('native: a held gun drops a seated worker through the trigger path at every range, from every open side, and sends nothing', async (t) => {
  const f = seat(t, 0);
  const h = headset(t, f);
  for (const angle of ANGLES)
    for (const gap of [0.04, 0.3, 1.2, 2.2]) {
      const before = h.shots.length;
      const result = await h.stageShot({ worker: 'Pixel', gap, angle, pitch: 15 });
      assert.equal(result.ok, true, `${gap} m at ${angle}°: ${result.reason ?? ''}`);
      assert.equal(h.shots.length, before + 1, `${gap} m at ${angle}°: the trigger fired once`);
      const shot = h.shots.at(-1)!;
      assert.equal(shot.workerId, f.id, `${gap} m at ${angle}°: struck ${result.solid ?? 'nothing'} instead`);
      assert.equal(result.outcome, 'down');
      assert.ok(shot.point!.distanceTo(new THREE.Vector3(...result.surface!)) < 0.06, `${gap} m at ${angle}°: struck where the bore meets the body`);
      h.stage.release();
      assert.equal(h.casualties.dying(f.id), false, 'release stands it back up');
    }
  assert.deepEqual(h.sent, [], 'not one kill');
});

test('native: staged shots finish off only a disposable Target worker, with a second shot at the body once it has lain still', async (t) => {
  const pixel = seat(t, 1, 'Pixel');
  const p = headset(t, pixel);
  assert.equal((await p.stageShot({ worker: 'Pixel' })).outcome, 'down');
  p.wait(FALL_TIME + FINISH_AFTER);
  const again = await p.stageShot({ worker: 'Pixel' });
  assert.equal(again.ok, false, 'a downed worker is not shot again by default');
  assert.match(again.reason ?? '', /finish: true/);
  const refused = await p.stageShot({ worker: 'Pixel', finish: true });
  assert.equal(refused.ok, false);
  assert.match(refused.reason ?? '', /Target/);
  assert.deepEqual(p.sent, []);
  p.stage.release();
  assert.equal(p.casualties.dying(pixel.id), false);

  const target = seat(t, 2, 'Target 1');
  const h = headset(t, target);
  assert.equal((await h.stageShot({ worker: 'target 1', finish: true })).ok, false, 'not down yet: shoot it once first');
  assert.equal((await h.stageShot({ worker: 'target 1' })).outcome, 'down');
  h.wait(FALL_TIME + FINISH_AFTER);
  const finished = await h.stageShot({ worker: 'target 1', finish: true });
  assert.equal(finished.ok, true, finished.reason);
  assert.equal(finished.hit, true, `struck ${finished.solid}`);
  assert.equal(finished.outcome, 'finished');
  assert.deepEqual(h.sent, [target.id], 'its kill went out once');
  h.stage.release();
  assert.equal(h.casualties.dying(target.id), true, 'a finished body stays down for its medics');
});

test('native: a staged haul grips the body on the floor and lifts it back into its chair through the grip path', async (t) => {
  const f = seat(t, 3);
  const h = headset(t, f);
  assert.equal((await h.stageHaul({ worker: 'Pixel' })).ok, false, 'nothing to haul while it sits');
  assert.equal((await h.stageShot({ worker: 'Pixel', angle: 40 })).outcome, 'down');
  h.wait(FALL_TIME + 0.2);
  const frozen = await h.stageHaul({ worker: 'Pixel', freezeMs: 500 });
  assert.equal(frozen.ok, true, frozen.reason);
  assert.equal(frozen.revived, false, 'frozen halfway up');
  const chest = h.casualties.chest(f.id)!;
  assert.ok(chest.y > frozen.chest![1] + 0.1, 'the body is coming up with the hand');
  h.stage.release(false);
  h.wait(0.6);
  assert.equal(h.casualties.dying(f.id), true, 'let go, it slumps back down');
  const lifted = await h.stageHaul({ worker: 'Pixel' });
  assert.equal(lifted.ok, true, lifted.reason);
  assert.equal(lifted.revived, true);
  assert.equal(f.worker.root.parent, f.desk.seatAnchor, 'back in its chair');
  assert.equal(h.controls.staging, false, 'the controller is handed back');
  assert.deepEqual(h.sent, []);
});

test('the staging hooks are inert without a debuggable host, and clean up after themselves', async (t) => {
  const f = seat(t, 4);
  const h = headset(t, f, false);
  const refused = await h.stage.run({ worker: 'Pixel' });
  assert.equal(refused.ok, false);
  assert.match(refused.reason ?? '', /debuggable/);
  assert.equal((await h.stage.haul({ worker: 'Pixel' })).ok, false);
  for (let i = 0; i < 40; i++) h.poll();
  assert.equal(h.controls.staging, false);
  assert.equal(h.shots.length, 0, 'nothing is drawn or fired');
  h.stage.debuggable = true;
  assert.equal((await h.stage.run({ worker: 'Nobody' })).ok, false);
  // A staged gun has no real controller under it, so it is drawn at the scripted pose.
  let run: StageShotResult | null = null;
  void h.stage.run({ worker: 'pixel', gap: 0.3, freezeMs: 100 }).then((r) => (run = r));
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
  assert.equal(h.casualties.dying(f.id), false, 'release stands the worker back up');
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
