import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import * as THREE from 'three';
import { createFloorTravel, type FloorTravelHost } from '../src/client/runtime/floor-travel.js';
import { createWorkerScene, type WorkerSceneHost } from '../src/client/runtime/worker-scene.js';
import { createSidearm, type SidearmHost } from '../src/client/runtime/sidearm.js';
import { DESK_BY_ID, ELEVATOR_CAR, SLAB, STOREY } from '../src/shared/layout.js';
import { ROOF } from '../src/shared/rooftop.js';
import type { ClientMsg, WorkerInfo } from '../src/shared/protocol.js';
import type { Spot } from '../src/client/state.js';

/** The same no-WebGL canvas stand-in used by worker-first-frame.test.ts, with DOM controls too. */
class Element {
  width = 1;
  height = 1;
  className = '';
  textContent = '';
  title = '';
  children: unknown[] = [];
  attributes = new Map<string, string>();
  classes = new Set<string>();
  style = { setProperty() {} };
  classList = {
    add: (...names: string[]) => names.forEach((n) => this.classes.add(n)),
    remove: (...names: string[]) => names.forEach((n) => this.classes.delete(n)),
    toggle: (name: string, on: boolean) => (on ? this.classes.add(name) : this.classes.delete(name)),
  };
  append(...children: unknown[]) {
    this.children.push(...children);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  addEventListener() {}
  remove() {}
  getContext() {
    return new Proxy({ canvas: this, measureText: (text: string) => ({ width: text.length * 12 }) }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) });
  }
}

function browser(t: TestContext) {
  const elements = new Map<string, Element>();
  const listeners = new Map<string, () => void>();
  const document = {
    hidden: false,
    body: new Element(),
    createElement: () => new Element(),
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id)!;
    },
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
  };
  for (const [name, value] of Object.entries({ document, Node: Element, window: { setTimeout: globalThis.setTimeout } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => (previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name)));
  }
  return { document, elements, listeners };
}

function floorRig(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = browser(t);
  const events: string[] = [];
  const sent: ClientMsg[] = [];
  const saved: Spot[] = [];
  const state = {
    floor: 'api' as string | null,
    floors: [
      { id: 'api', name: 'API', waiting: 0 },
      { id: 'web', name: 'Web', waiting: 0 },
    ],
    currentFloor() {
      return this.floors.find((f) => f.id === this.floor);
    },
  };
  const player = {
    pos: new THREE.Vector3(5, 0, 3),
    facing: 1.2,
    enabled: true,
    colliders: [],
    seat: null,
    clearKeys: () => events.push('keys'),
    standingSpot: () => null as THREE.Vector3 | null,
  };
  const host = {
    store: state,
    player,
    office: {
      group: new THREE.Group(),
      colliders: [],
      elevator: { setOpen: (open: boolean) => events.push(`doors:${open}`) },
      setPlain: () => [],
      setLook: () => events.push('paint'),
    },
    camera: new THREE.PerspectiveCamera(),
    sky: { setRoof: (up: boolean) => events.push(`sky:${up}`) },
    net: {
      send: (msg: ClientMsg) => {
        sent.push(msg);
        return true;
      },
    },
    hanger: { active: false, cancel: () => events.push('hang:cancel') },
    climber: { active: false, abort: () => events.push('climb:abort'), arrived: () => events.push('climb:arrived') },
    sound: { floorChime: () => events.push('chime'), ding: () => events.push('ding') },
    roof: null,
    upTop: false,
    firstWelcome: false,
    walking: false,
    far: 100,
    builtFloors: () => state.floors,
    theRoof: () => {
      throw new Error('roof not expected');
    },
    roofFloors: () => state.floors.length,
    placeInCar: () => events.push('car'),
    standUp: () => events.push('stand'),
    stopWalking: () => events.push('walk:stop'),
    holsterGun: () => events.push('holster'),
    renderWake: () => events.push('wake'),
    clearLinkedWorker: () => events.push('unlink'),
    liftOnto: () => events.push('lift'),
    syncVibesWatch: () => events.push('vibes'),
    invalidateHint: () => events.push('hint'),
    renderProject: () => events.push('project'),
    syncStack: () => events.push('stack'),
    showElevator: () => events.push('panel'),
    lastSpot: () => saved[0] ?? null,
    rememberSpot: (spot: Spot) => saved.push(spot),
  } as unknown as { -readonly [K in keyof FloorTravelHost]: FloorTravelHost[K] };
  return { dom, host, state, player, sent, saved, events, travel: createFloorTravel(host) };
}

test('floor travel preserves saved and seated positions, deduplicates writes and excludes an upstairs fall', (t) => {
  const { travel, player, state, host, saved } = floorRig(t);
  travel.saveSpot();
  travel.saveSpot();
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], { floor: 'api', name: 'API', x: 5, y: 0, z: 3, facing: 1.2 });
  player.standingSpot = () => new THREE.Vector3(8, 0, 4);
  assert.equal(travel.spotHere()!.x, 8);
  host.firstWelcome = true;
  assert.equal(travel.whereNow(), saved[0]);
  player.standingSpot = () => null;
  state.floor = 'web';
  player.pos.y = -SLAB - 0.1;
  assert.equal(travel.spotHere(), null);
  state.floor = 'api';
  assert.ok(travel.spotHere(), 'the ground floor keeps its street');
  host.climber.active = true;
  assert.equal(travel.spotHere(), null);
});

test('an immediate floor switch keeps the street-relative pose, stops prior activities and ignores overlapping requests', (t) => {
  const { travel, player, state, host, sent, events } = floorRig(t);
  state.floor = 'web';
  player.pos.y = -3;
  host.walking = true;
  host.hanger.active = true;
  host.climber.active = true;
  travel.switchFloor('api', true);
  assert.equal(travel.trip?.how, 'switch');
  assert.equal(player.enabled, false);
  assert.deepEqual(events, ['holster', 'hang:cancel', 'climb:abort', 'walk:stop', 'keys', 'wake']);
  assert.deepEqual(sent, [{ t: 'floor.go', floor: 'api', at: { x: 5, y: -3 + STOREY, z: 3, rotY: 1.2 } }]);
  travel.switchFloor('web', true);
  travel.ride('api');
  assert.equal(sent.length, 1);
  state.floor = 'api';
  travel.arrive();
  assert.equal(travel.trip, null);
  assert.equal(player.enabled, true);
  assert.deepEqual(events.slice(-4), ['lift', 'paint', 'project', 'stack']);
  t.mock.timers.tick(10_000);
  assert.equal(events.includes('unlink'), false, 'arrival cancels the failure timer');
});

test('the elevator preserves door, fade, network and arrival-chime timing inside and outside its car', (t) => {
  const { travel, player, sent, events, state } = floorRig(t);
  player.pos.set((ELEVATOR_CAR.minX + ELEVATOR_CAR.maxX) / 2, 0, (ELEVATOR_CAR.minZ + ELEVATOR_CAR.maxZ) / 2);
  travel.ride('web');
  assert.deepEqual(events, ['holster', 'keys', 'doors:false']);
  t.mock.timers.tick(649);
  assert.equal(sent.length, 0);
  t.mock.timers.tick(1);
  t.mock.timers.tick(319);
  assert.equal(sent.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(sent, [{ t: 'floor.go', floor: 'web' }]);
  assert.equal(events.at(-1), 'car');
  state.floor = 'web';
  travel.arrive();
  t.mock.timers.tick(449);
  assert.equal(player.enabled, false);
  t.mock.timers.tick(1);
  assert.deepEqual(events.slice(-2), ['doors:true', 'chime']);
  assert.equal(player.enabled, true);

  player.pos.set(0, 0, 0);
  travel.ride('api');
  t.mock.timers.tick(0);
  t.mock.timers.tick(320);
  assert.equal(sent.length, 2, 'outside the car does not wait 650ms for the doors');
});

test('ladder arrival and failed trips release their state without a late timeout affecting the next trip', (t) => {
  const { travel, sent, events, state, player } = floorRig(t);
  travel.travel('web', 'ladder', { x: 1, y: 0, z: 2, rotY: 0 });
  t.mock.timers.tick(169);
  assert.equal(sent.length, 0);
  t.mock.timers.tick(1);
  assert.equal(sent.length, 1);
  state.floor = 'web';
  travel.arrive();
  assert.equal(events.at(-1), 'climb:arrived');
  travel.ride('api');
  t.mock.timers.tick(10_000);
  assert.equal(travel.trip, null);
  assert.equal(player.enabled, true);
  assert.deepEqual(events.slice(-2), ['unlink', 'doors:true']);
  travel.travel('api', 'ladder', { x: 1, y: 0, z: 2, rotY: 0 });
  t.mock.timers.tick(10_000);
  assert.equal(events.at(-1), 'climb:abort');
});

test('roof arrival changes the visible world, colliders, far plane and light before re-enabling movement', (t) => {
  const { host, state, travel, events } = floorRig(t);
  const roof = { group: new THREE.Group(), colliders: [{}], elevator: { setOpen: (on: boolean) => events.push(`roof:${on}`) } };
  host.theRoof = () => roof as unknown as ReturnType<FloorTravelHost['theRoof']>;
  host.roof = roof as unknown as FloorTravelHost['roof'];
  state.floor = ROOF;
  travel.arrive('back');
  assert.equal(host.upTop, true);
  assert.equal(host.office.group.visible, false);
  assert.equal(roof.group.visible, true);
  assert.equal(host.player.colliders, roof.colliders);
  assert.equal(host.camera.far, 700);
  assert.equal(events.at(-1), 'roof:true');
  state.floor = 'api';
  travel.arrive('back');
  assert.equal(host.upTop, false);
  assert.equal(roof.group.visible, false);
  assert.equal(host.camera.far, 100);
});

function workerRig(t: TestContext) {
  browser(t);
  const events: string[] = [];
  const def = DESK_BY_ID.get('desk-3')!;
  const group = new THREE.Group();
  const seatAnchor = new THREE.Object3D();
  const laptopAnchor = new THREE.Object3D();
  group.add(seatAnchor, laptopAnchor);
  const desk = { def, group, seatAnchor, laptopAnchor, propSpot: new THREE.Vector3(), chair: new THREE.Group(), vacancy: { visible: false } };
  const worker = { id: 'proof', name: 'Proof', color: '#e76f51', kind: 'agent', status: 'working', deskId: def.id, acked: true, createdAt: 0 } as WorkerInfo;
  const state = {
    workers: new Map([[worker.id, worker]]),
    visits: [],
    screens: new Map(),
    pulls: { items: [] },
    missionControl: null,
    officeNow: () => 20_000,
    workerAtDesk: () => worker,
  };
  const host = {
    scene: new THREE.Scene(),
    office: { desks: new Map([[def.id, desk]]), colliders: [], stack: { state: { index: 0 } }, setBeanbags: () => [] },
    store: state,
    player: { pos: new THREE.Vector3() },
    sound: { ding: (status: string) => events.push(`ding:${status}`), setTyping() {}, removeTypist: () => events.push('typist:remove') },
    notifier: { alert: () => events.push('alert'), sync: () => events.push('notify:sync') },
    reduceMotion: { matches: false },
    mission: { views: new Map(), group: new THREE.Group(), sync: () => false, update() {}, animating: false },
    teamLines: { set: () => events.push('links'), focus() {} },
    screenGlows: [],
    sky: { moodAnimating: false },
    vibeFxMoving: false,
    lastWandShip: new Map([[worker.id, 10]]),
    wandOut: () => true,
    noOutline() {},
    liftOnto() {},
    burstOver: () => events.push('burst'),
    deskMomentFx: (_id: string, _v: unknown, kind: string) => events.push(`moment:${kind}`),
    shippedFx: () => events.push('shipped'),
    renderWorkers: () => events.push('workers'),
    modelBadge: () => undefined,
    renderWaiting: () => events.push('waiting'),
    renderTitle: () => events.push('title'),
    renderWake() {},
    words: () => ({ pr: 'PR', ref: (n: number) => `#${n}` }),
  } as unknown as WorkerSceneHost;
  const runtime = createWorkerScene(host);
  t.after(() => {
    for (const view of runtime.workerViews.values()) {
      view.model.dispose();
      view.laptop.dispose();
    }
  });
  return { host, runtime, state, worker, events, desk };
}

test('worker synchronization retains models, dings once per transition and updates the HUD after scene synchronization', (t) => {
  const { runtime, worker, events } = workerRig(t);
  runtime.syncWorkers();
  const view = runtime.workerViews.get(worker.id)!;
  assert.ok(view);
  assert.equal(
    events.some((e) => e.startsWith('ding')),
    false,
  );
  events.length = 0;
  worker.status = 'done';
  worker.acked = false;
  runtime.syncWorkers();
  assert.deepEqual(events, ['ding:done', 'alert', 'burst', 'moment:finished', 'workers', 'links', 'waiting', 'notify:sync', 'title']);
  assert.equal(runtime.workerViews.get(worker.id), view);
  events.length = 0;
  runtime.syncWorkers();
  assert.equal(
    events.some((e) => e.startsWith('ding') || e === 'burst'),
    false,
  );
  worker.action = 'failing';
  runtime.syncWorkers();
  runtime.syncWorkers();
  assert.equal(events.filter((e) => e === 'ding:error').length, 1);
  worker.pr = { number: 12, state: 'open', url: 'https://github.com/nikships/droid-office/pull/12' };
  runtime.syncWorkers();
  runtime.syncWorkers();
  assert.equal(events.filter((e) => e === 'shipped').length, 1);
});

test('worker removal distinguishes a floor replacement, send-home and charged dismissal, and clears sidearm cooldowns', (t) => {
  for (const why of ['floor', 'sent_home', 'shot'] as const) {
    const { runtime, state, worker, host, events } = workerRig(t);
    runtime.syncWorkers();
    const view = runtime.workerViews.get(worker.id)!;
    t.mock.method(runtime.departures, 'add', () => events.push('departure'));
    t.mock.method(runtime.casualties, 'ascend', () => events.push('ascend'));
    t.mock.method(view.model, 'dispose', () => events.push('dispose:model'));
    t.mock.method(view.laptop, 'dispose', () => events.push('dispose:laptop'));
    if (why === 'sent_home') runtime.sentHome.add(worker.id);
    if (why === 'shot') runtime.shotWorkers.add(worker.id);
    state.workers.clear();
    events.length = 0;
    runtime.syncWorkers();
    assert.equal(runtime.workerViews.size, 0);
    assert.equal(host.lastWandShip.size, 0);
    assert.equal(events.includes('typist:remove'), true);
    assert.equal(events.includes('departure'), why === 'sent_home');
    assert.equal(events.includes('ascend'), why === 'shot');
    assert.equal(events.includes('dispose:model'), why === 'floor');
    view.model.root.removeFromParent();
    view.laptop.root.removeFromParent();
    t.mock.restoreAll();
    view.model.dispose();
    view.laptop.dispose();
  }
});

test('worker frame updates preserve hold hysteresis, visitor-first order and reusable screen glows', (t) => {
  const { runtime, host, worker } = workerRig(t);
  runtime.syncWorkers();
  const view = runtime.workerViews.get(worker.id)!;
  const order: string[] = [];
  t.mock.method(runtime.visitors, 'update', () => order.push('visitors'));
  t.mock.method(view.model, 'update', () => order.push('model'));
  t.mock.method(view.laptop, 'update', () => order.push('laptop'));
  t.mock.method(view.laptop, 'glow', () => 1);
  view.model.root.position.set(0, 0, 0);
  view.model.root.updateMatrixWorld(true);
  host.player.pos.set(3.9, 0, 0);
  assert.equal(runtime.updateWorkers(1 / 60, 1, new THREE.Vector3()), 1);
  assert.deepEqual(order, ['visitors', 'model', 'laptop']);
  const glow = host.screenGlows[0];
  assert.equal(view.model.held, true);
  host.player.pos.x = 4.5;
  runtime.updateWorkers(1 / 60, 2, new THREE.Vector3());
  assert.equal(view.model.held, true);
  host.player.pos.x = 5.1;
  runtime.updateWorkers(1 / 60, 3, new THREE.Vector3());
  assert.equal(view.model.held, false);
  assert.equal(host.screenGlows[0], glow);
});

function sidearmRig(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = browser(t);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ supported: false }) }) as Response);
  const events: string[] = [];
  const sent: ClientMsg[] = [];
  const host = {
    settings: { sidearm: 'gun' },
    store: { workers: new Map() },
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(55, 1, 0.1, 100),
    player: { enabled: true },
    hands: { setLumos: (on: boolean) => events.push(`lumos:${on}`), muzzleTip: () => null, wandTip: () => null, fireGun() {} },
    me: { fire() {} },
    sound: {
      sidearmCharge: () => {
        events.push('charge');
        return () => events.push('charge:stop');
      },
      gunCue: (cue: string) => events.push(cue),
      wandCue: (cue: string) => events.push(cue),
      gunshot() {},
      hit() {},
    },
    smoke: {},
    net: {
      send: (msg: ClientMsg) => {
        sent.push(msg);
        return true;
      },
    },
    office: { group: new THREE.Group() },
    bossLaptop: { screen: new THREE.Mesh() },
    confetti: {},
    workerViews: new Map(),
    reduceMotion: { matches: false },
    climber: { active: false },
    hanger: { active: false },
    carrying: null,
    emoteWheel: { isOpen: false },
    raycaster: new THREE.Raycaster(),
    crosshair: new THREE.Vector2(),
    upTop: false,
    confettiDensity: 1,
    thud: 0,
    invalidateHint() {},
    openWorkerTerminal: (id: string) => events.push(`terminal:${id}`),
    openOfficeShell() {},
    openPane: () => false,
    runUnder: () => undefined,
    danceParty() {},
    floorArea: () => 1,
    ceilingOver: () => 2,
  } as unknown as SidearmHost;
  const runtime = createSidearm(host);
  t.after(() => {
    runtime.cancelShotCharge();
    runtime.tipTrail.points.geometry.dispose();
    (runtime.tipTrail.points.material as THREE.Material).dispose();
    for (const puff of runtime.puffs) puff.dispose();
  });
  return { dom, host, runtime, events, sent };
}

test('sidearm charge feedback previews once, cancels on a disabled player, and quiet holstering stows both motions', (t) => {
  const { runtime, host, events } = sidearmRig(t);
  assert.equal(runtime.wandLight.visible, false);
  runtime.toggleGun();
  runtime.gunMotion.update(2);
  runtime.shotCharge.begin(0);
  runtime.updateShotCharge(100);
  assert.equal(events.includes('charge'), false);
  runtime.updateShotCharge(750);
  runtime.updateShotCharge(900);
  assert.equal(events.filter((e) => e === 'charge').length, 1);
  assert.equal(events.filter((e) => e === 'cock').length, 1);
  host.player.enabled = false;
  runtime.updateShotCharge(1000);
  assert.equal(runtime.shotCharge.held, false);
  assert.equal(events.at(-1), 'charge:stop');
  runtime.holsterGun(true);
  assert.equal(runtime.gunOut, false);
  assert.equal(runtime.gunMotion.doing, null);
  assert.equal(runtime.wandMotion.doing, null);
  host.settings.sidearm = 'wand';
  runtime.toggleGun();
  assert.equal(runtime.drawnArm, 'wand');
  runtime.wandMotion.update(2);
  runtime.wandCues(['lumos']);
  assert.equal(runtime.lumos, true);
  runtime.holsterGun(true);
  assert.equal(runtime.lumos, false);
});

test('normal aimed shots open a terminal while only charged local shots send a dismissal', (t) => {
  const { runtime, host, events, sent } = sidearmRig(t);
  const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  body.position.z = -4;
  body.updateMatrixWorld(true);
  host.camera.updateMatrixWorld(true);
  host.workerViews.set('proof', { model: { root: body }, laptop: { screen: new THREE.Mesh() } } as unknown as Parameters<typeof host.workerViews.set>[1]);
  runtime.toggleGun();
  runtime.gunMotion.update(2);
  runtime.fireGun();
  assert.deepEqual(events, ['terminal:proof']);
  assert.deepEqual(sent, []);
  runtime.gunMotion.update(2);
  runtime.fireGun(true);
  assert.deepEqual(sent, [{ t: 'worker.shoot', workerId: 'proof', superShot: true }]);
  assert.equal(host.thud, 0.72);
  body.geometry.dispose();
  (body.material as THREE.Material).dispose();
});

test('main remains the composition root and runtime modules never import it or register listeners on import', () => {
  const main = readFileSync(new URL('../src/client/main.ts', import.meta.url), 'utf8');
  for (const name of ['floor-travel', 'worker-scene', 'sidearm', 'prop-models', 'wall-boards']) {
    assert.ok(main.includes(`'./runtime/${name}'`), name);
    const source = readFileSync(new URL(`../src/client/runtime/${name}.ts`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from ['"].*\/main['"]/);
  }
  assert.match(main, /store\.on\('workers', syncWorkers\)/);
  assert.match(main, /workerScene\.updateWorkers\(dt, t, camPos\)/);
  assert.ok(main.indexOf('workerScene.updateWorkers(dt, t, camPos)') < main.indexOf('workerScene.updateMission(dt, t, camPos)'));
});
