import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { NativeControls, type NativeHooks } from '../src/client/native/controls.js';
import type { NativeHand, NativeInputFrame, Pose7 } from '../src/client/native/input.js';
import { ShotStage, type StageShotOptions, type StageShotResult, matchWorker, stageAim } from '../src/client/native/stage.js';
import { PlayerController } from '../src/client/player.js';
import { loadSettings } from '../src/client/state.js';
import { Worker } from '../src/client/world/character.js';
import { type GunHit, gunHit, traceShot } from '../src/client/world/gun.js';
import { buildOffice, type Office } from '../src/client/world/office.js';

// Point-blank shots against the real office and a real seated worker: a muzzle pressed into the
// body, touching it, 30 cm off and across the room, from several sides. The native shots run
// through the trigger path (controller samples → NativeControls → physical trigger → traced bore).

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

function seat(t: TestContext, deskIndex = 0) {
  const { office: o, scene } = office(t);
  const desk = [...o.desks.values()].filter((d) => d.def.id.startsWith('desk-'))[deskIndex];
  const worker = new Worker('Pixel', '#86b2d4');
  desk.seatAnchor.add(worker.root);
  worker.update(1 / 60, 1);
  scene.updateMatrixWorld(true);
  t.after(() => {
    worker.root.removeFromParent();
    worker.dispose();
  });
  const workers = new Map<THREE.Object3D, string>([[worker.root, 'pixel']]);
  const facing = new THREE.Vector3(0, 0, 1).transformDirection(worker.root.matrixWorld);
  const middle = worker.root.localToWorld(new THREE.Vector3(0, 0.62, 0));
  return { office: o, scene, desk, worker, workers, facing, middle };
}

const pose = (x: number, y: number, z: number): Pose7 => [x, y, z, 0, 0, 0, 1];
const idle = (): NativeHand => ({ active: false, aim: pose(0, 0, 0), grip: pose(0, 0, 0), trigger: 0, squeeze: 0, stick: [0, 0], a: false, b: false, menu: false, ui: false });

/** NativeControls on the real office, whose gun hook resolves shots exactly as main.ts's fireNativeGun. */
function headset(t: TestContext, f: ReturnType<typeof seat>, debuggable = true) {
  const camera = new THREE.PerspectiveCamera();
  const player = new PlayerController(camera, new EventTarget() as unknown as HTMLElement, f.office.colliders);
  player.pos.set(f.middle.x + 3, 0, f.middle.z + 3);
  let time = 1000;
  t.mock.method(performance, 'now', () => time);
  const shots: (GunHit | null)[] = [];
  const raycaster = new THREE.Raycaster();
  let stage: ShotStage | null = null;
  let revives = 0;
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
      fireGun: (bore) => {
        const result = traceShot(raycaster, bore, f.office.group, f.workers);
        shots.push(result);
        stage?.shot({ workerId: result?.workerId ?? null, buried: result?.buried ?? false, solid: result?.hit.object.name ?? null, distance: result?.hit.distance ?? null });
      },
    },
  };
  const controls = new NativeControls(f.scene, camera, hooks);
  controls.start();
  t.after(() => controls.stop());
  stage = new ShotStage({
    controls,
    player,
    worker: (key) => (key.toLowerCase() === 'pixel' ? { id: 'pixel', name: 'Pixel', root: f.worker.root } : null),
    blocked: () => null,
    eye: () => camera.position.clone(),
    clearPanel() {},
    revive: () => revives++,
    now: () => time,
  });
  stage.debuggable = debuggable;
  /** One Java poll: three 90 Hz samples from a still, tracked headset, then a gameplay update. */
  const poll = () => {
    if (!stage!.frozen) {
      const frames: NativeInputFrame[] = [0, 1, 2].map(() => ({ time: (time += 11), head: [0, 1.62, 0, 0, 0, 0, 1], hands: [idle(), idle()] }));
      controls.consume(frames);
      controls.update(1 / 30);
    } else time += 33;
    stage!.tick();
  };
  /** The page's __office.stageShot, with polls arriving until it resolves. */
  const stageShot = async (options: StageShotOptions): Promise<StageShotResult> => {
    let result: StageShotResult | null = null;
    void stage!.run(options).then((r) => (result = r));
    for (let i = 0; i < 120 && !result; i++) {
      poll();
      await Promise.resolve();
    }
    assert.ok(result, 'the staged shot resolved');
    return result;
  };
  return { controls, player, stage, shots, poll, stageShot, revives: () => revives };
}

const GAPS = [
  { gap: -0.15, label: 'muzzle deep inside the body' },
  { gap: -0.03, label: 'barrel pressed 3 cm in' },
  { gap: 0.02, label: 'touching, 2 cm off' },
  { gap: 0.05, label: 'touching, 5 cm off' },
  { gap: 0.3, label: '30 cm away' },
  { gap: 2.2, label: 'across the room' },
];
/** Degrees around the worker from in front of its face, toward its left: front, both sides and diagonals. */
const ANGLES = [15, 65, 100, -40, -95];

test('native: a held gun registers a seated worker at every range through the trigger path, from every open side', async (t) => {
  const f = seat(t);
  const h = headset(t, f);
  for (const angle of ANGLES)
    for (const { gap, label } of GAPS) {
      const before = h.shots.length;
      const result = await h.stageShot({ worker: 'Pixel', gap, angle, pitch: 15 });
      assert.equal(result.ok, true, `${label} at ${angle}°: ${result.reason ?? ''}`);
      assert.equal(h.shots.length, before + 1, `${label} at ${angle}°: the trigger fired once`);
      const shot = h.shots.at(-1)!;
      assert.equal(shot?.workerId, 'pixel', `${label} at ${angle}°: struck ${shot?.hit.object.name || shot?.hit.object.type || 'nothing'} instead`);
      assert.equal(result.hit, true);
      // The hit lands on the body where the bore meets it, not on whatever is behind the worker.
      assert.ok(shot!.hit.point.distanceTo(new THREE.Vector3(...result.surface!)) < 0.06, `${label} at ${angle}°: struck where the barrel meets the body`);
      h.stage.release(false);
    }
});

test('native: point-blank from behind registers through the chair back; from 30 cm the chair back stops it', async (t) => {
  const f = seat(t, 1);
  const h = headset(t, f);
  for (const angle of [160, -165]) {
    for (const gap of [-0.1, -0.02, 0.03]) {
      const result = await h.stageShot({ worker: 'Pixel', gap, angle, pitch: 15 });
      assert.equal(result.hit, true, `gap ${gap} at ${angle}°: ${result.solid}`);
      h.stage.release(false);
    }
    const far = await h.stageShot({ worker: 'Pixel', gap: 0.3, angle, pitch: 15 });
    assert.equal(far.hit, false, 'a chair back between the muzzle and the worker still blocks');
    assert.equal(far.struck, null);
    h.stage.release(false);
  }
});

test('native: a whole gun buried in the worker strikes it at the muzzle', (t) => {
  const f = seat(t, 2);
  const aim = stageAim({ target: f.middle, body: f.worker.root, facing: f.facing, angle: 0.6, pitch: 0.1, gap: -0.4 });
  const raycaster = new THREE.Raycaster();
  const breech = aim.muzzle.clone().addScaledVector(aim.direction, -0.32);
  const buried = traceShot(raycaster, { breech, muzzle: aim.muzzle, direction: aim.direction }, f.office.group, f.workers);
  assert.equal(buried?.workerId, 'pixel');
  assert.equal(buried?.buried, true);
  assert.ok(buried!.hit.point.distanceTo(aim.muzzle) < 1e-9);
  // The old shot from the muzzle alone left through the back of the body into the office behind it.
  raycaster.set(aim.muzzle, aim.direction);
  const meshes: THREE.Mesh[] = [];
  f.scene.traverseVisible((o) => o instanceof THREE.Mesh && meshes.push(o));
  const first = raycaster.intersectObjects(meshes, false)[0];
  let owner: THREE.Object3D | null = first?.object ?? null;
  while (owner && owner !== f.worker.root) owner = owner.parent;
  assert.equal(owner, null, 'three.js alone never sees the body from inside it');
});

test('desktop: the camera ray registers the worker up close and across the room, from several sides', (t) => {
  const f = seat(t, 3);
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
      assert.equal(result?.workerId, 'pixel', `camera ${gap} m off at ${angle}°: struck ${result?.hit.object.name || 'nothing'}`);
      assert.equal(result?.buried, false);
    }
});

test('the staging hook is inert without a debuggable host, and cleans up after itself', async (t) => {
  const f = seat(t, 4);
  const h = headset(t, f, false);
  const refused = await h.stage.run({ worker: 'Pixel', gap: 0.03 });
  assert.equal(refused.ok, false);
  assert.match(refused.reason ?? '', /debuggable/);
  for (let i = 0; i < 40; i++) h.poll();
  assert.equal(h.controls.staging, false);
  assert.equal(h.shots.length, 0, 'nothing is drawn or fired');
  h.stage.debuggable = true;
  assert.equal((await h.stage.run({ worker: 'Nobody' })).ok, false);
  // A staged gun has no real controller under it, so it is drawn at the scripted pose.
  let run: StageShotResult | null = null;
  void h.stage.run({ worker: 'pixel', gap: 0.03, freezeMs: 100 }).then((r) => (run = r));
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
  assert.ok(h.revives() > 0, 'release stands the worker back up');
});

test('a staged shot finds its worker by id, by name in any case, or by name without emoji', () => {
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
