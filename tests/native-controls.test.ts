import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { NativeControls, type NativeHooks } from '../src/client/native/controls.js';
import { LOST_MS, MAX_QUEUE, type NativeHand, type NativeInputFrame, type Pose7, readFrame, webStick } from '../src/client/native/input.js';
import { applyGravity, findLanding, rigFor, stepToward } from '../src/client/native/locomotion.js';
import { PlayerController } from '../src/client/player.js';
import { loadSettings } from '../src/client/state.js';
import type { GrabHooks, Grabbable } from '../src/client/vr/grab.js';
import { SNAP_ANGLE } from '../src/client/vr/session.js';
import type { Collider, Interactable } from '../src/client/world/office.js';
import { FLOOR, SLAB } from '../src/shared/layout.js';
import type { CarriedIssue, CarriedObject } from '../src/shared/protocol.js';

const officeFloor: Collider = { ...FLOOR, bottom: -SLAB, top: 0 };
const IDENT: Pose7 = [0, 0, 0, 0, 0, 0, 1];

function globals(t: TestContext) {
  for (const [name, value] of [
    ['window', new EventTarget()],
    ['document', Object.assign(new EventTarget(), { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, strokeRect() {}, fillText() {}, measureText: (s: string) => ({ width: s.length * 10 }) }) }) })],
  ] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

function quatYaw(yaw: number): [number, number, number, number] {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  return [q.x, q.y, q.z, q.w];
}

function pose(x: number, y: number, z: number, q: readonly number[] = [0, 0, 0, 1]): Pose7 {
  return [x, y, z, q[0], q[1], q[2], q[3]];
}

function off(): NativeHand {
  return { active: false, aim: [...IDENT], grip: [...IDENT], trigger: 0, squeeze: 0, stick: [0, 0], a: false, b: false, menu: false, ui: false };
}

function controller(patch: Partial<NativeHand> = {}): NativeHand {
  return { active: true, aim: pose(0.2, 1.2, -0.3), grip: pose(0.2, 1.2, -0.3), trigger: 0, squeeze: 0, stick: [0, 0], a: false, b: false, menu: false, ui: false, ...patch };
}

/** A raw native slot that reports an OpenXR tracked hand, as an older host build would send it. */
function trackedHand(patch: Record<string, unknown> = {}): Record<string, unknown> {
  const joints = Array.from({ length: 26 }, () => [0.2, 1.2, -0.4, 0, 0, 0, 1, 0.01]);
  return { ...controller(), hand: true, trigger: 1, squeeze: 1, a: true, b: true, menu: true, stick: [0, 1], joints, ...patch };
}

interface Rig {
  controls: NativeControls;
  player: PlayerController;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  hooks: NativeHooks;
  calls: { e: (Interactable | null)[]; next: number; panel: number; putBack: number; cancel: number[]; carryAlong: THREE.Vector3[] };
  /** Feed samples and run one 30 Hz tick. */
  tick: (...frames: NativeInputFrame[]) => void;
  /** The next sample, 11 ms after the last one unless `time` sets (and advances) the clock. */
  frame: (patch?: Partial<NativeInputFrame> & { left?: NativeHand; right?: NativeHand }) => NativeInputFrame;
  /** The sample clock (ms) of the last frame() call. */
  time: () => number;
  advance: (ms: number) => void;
  target: Interactable;
}

function rig(t: TestContext, colliders: Collider[] = [], hooks: Partial<NativeHooks> = {}): Rig {
  globals(t);
  let clock = 1000;
  t.mock.method(performance, 'now', () => clock);
  const camera = new THREE.PerspectiveCamera();
  const player = new PlayerController(camera, new EventTarget() as unknown as HTMLElement, [officeFloor, ...colliders]);
  player.pos.set(0, 0, 0);
  player.facing = 0;
  const scene = new THREE.Scene();
  const target: Interactable = { kind: 'tv', x: 0, z: -2, radius: 1.5 };
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.2));
  box.position.set(0, 1.2, 2);
  box.userData.interact = target;
  scene.add(box);
  scene.updateMatrixWorld(true);
  const calls: Rig['calls'] = { e: [], next: 0, panel: 0, putBack: 0, cancel: [], carryAlong: [] };
  const settings = loadSettings();
  const full: NativeHooks = {
    player,
    settings,
    useE: (it) => calls.e.push(it),
    pickFromRay: (ray) => {
      const hit = ray.intersectObject(box, false)[0];
      return hit ? { it: target, near: hit.distance < 3, hit } : null;
    },
    noteUnder: () => null,
    nextWaiting: () => calls.next++,
    putBack: () => calls.putBack++,
    carrying: () => null,
    modalOpen: () => false,
    toast: () => {},
    hudRefresh: () => {},
    reachOf: () => 3,
    reachAnim: () => {},
    onTarget: () => {},
    togglePanel: () => calls.panel++,
    cancelRay: (i) => calls.cancel.push(i),
    carryAlong: (d) => calls.carryAlong.push(d),
    ...hooks,
  };
  const controls = new NativeControls(scene, camera, full);
  let time = 0;
  const frame: Rig['frame'] = (patch = {}) => {
    time = patch.time ?? time + 11;
    const { left, right, ...rest } = patch;
    return { head: pose(0, 1.6, 0), hands: [left ?? off(), right ?? off()], ...rest, time };
  };
  const tick: Rig['tick'] = (...frames) => {
    controls.consume(frames);
    controls.update(1 / 30);
  };
  return { controls, player, camera, scene, hooks: full, calls, tick, frame, time: () => time, advance: (ms) => (clock += ms), target };
}

/** Every string in the renderer's control state, outside the carried card's own title. */
function texts(value: unknown, path = 'state'): string[] {
  if (typeof value === 'string') return [`${path}=${value}`];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => (path === 'state.carrying' && k === 'title' ? [] : texts(v, `${path}.${k}`)));
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Head world position from the exported state matrix and a native head pose. */
function headFrom(matrix: number[], local: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(...local).applyMatrix4(new THREE.Matrix4().fromArray(matrix));
}

test('readFrame validates, normalizes and rejects malformed samples', () => {
  const good = { time: 1, head: [0, 1.6, 0, 0, 0, 0, 1.2], hands: [off(), controller({ trigger: 3, stick: [2, -2] })] };
  const f = readFrame(good);
  assert.ok(f);
  assert.deepEqual(f.head.slice(3), [0, 0, 0, 1], 'quaternion normalized');
  assert.equal(f.hands[1].trigger, 1);
  assert.deepEqual(f.hands[1].stick, [1, -1]);
  assert.equal(f.hands[0].active, false);
  for (const bad of [
    null,
    { ...good, time: Number.NaN },
    { ...good, head: [0, 1, 0] },
    { ...good, head: [0, 1, 0, 0, 0, 0, 0] },
    { ...good, hands: [off()] },
    { ...good, hands: [off(), { ...controller(), aim: [0, 0, Number.POSITIVE_INFINITY, 0, 0, 0, 1] }] },
    { ...good, hands: [off(), { ...controller(), stick: [0] }] },
  ]) {
    assert.equal(readFrame(bad), null, JSON.stringify(bad));
  }
  const handFrame = readFrame({ ...good, hands: [trackedHand(), trackedHand({ joints: [] })] });
  assert.ok(handFrame, 'a tracked-hand slot is not a malformed frame');
  assert.deepEqual(
    handFrame.hands.map((h) => h.active),
    [false, false],
    'tracked hands read as no controller',
  );
  assert.equal('joints' in handFrame.hands[0] || 'hand' in handFrame.hands[0], false, 'no hand fields survive validation');
  assert.deepEqual(webStick([0.2, 1]), { x: 0.2, y: -1 }, 'OpenXR +y forward is WebXR -y');
});

test('the rig puts the headset over the avatar facing its view, and the state matrix reproduces the camera', (t) => {
  const r = rig(t);
  r.player.pos.set(4, 0, 3);
  r.player.facing = Math.PI / 2;
  r.controls.start();
  assert.equal(r.player.enabled, false, 'desktop keys are off');
  const head: [number, number, number] = [0.4, 1.55, -0.7];
  r.tick(r.frame({ head: pose(...head, quatYaw(0.6)) }));
  const s = r.controls.state();
  const world = headFrom(s.matrix, head);
  assert.ok(Math.abs(world.x - 4) < 1e-6 && Math.abs(world.z - 3) < 1e-6, `head over the feet: ${world.toArray()}`);
  assert.ok(Math.abs(world.y - 1.55) < 1e-6, 'native floor is the avatar floor');
  assert.ok(Math.abs(r.player.facing - Math.PI / 2) < 1e-6, 'facing kept');
  assert.ok(r.camera.position.distanceTo(world) < 1e-6, 'camera sits at the head');
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(r.camera.quaternion);
  assert.ok(dir.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-6, 'camera looks along the facing');
  assert.deepEqual(
    s.head.pos.map((v) => +v.toFixed(6)),
    world.toArray().map((v) => +v.toFixed(6)),
  );
  const out = new THREE.Vector3();
  r.controls.lookDir(out);
  assert.ok(out.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-6);
  r.tick(r.frame({ head: pose(...head, quatYaw(0.6)) }));
  assert.ok(Math.abs(r.player.pos.x - 4) < 1e-6 && Math.abs(r.player.pos.z - 3) < 1e-6, 'no first-frame walk');
});

test('the camera pose is solved through whatever parent main.ts hung it under', (t) => {
  const r = rig(t);
  const parent = new THREE.Group();
  parent.position.set(10, 2, -5);
  parent.rotation.y = 1;
  r.scene.add(parent);
  parent.add(r.camera);
  r.controls.start();
  r.tick(r.frame({ head: pose(0.1, 1.5, 0.2) }));
  const w = r.camera.getWorldPosition(new THREE.Vector3());
  assert.ok(w.distanceTo(new THREE.Vector3(r.player.pos.x, 1.5, r.player.pos.z)) < 1e-6);
});

test('snap turn rotates about the head, once per push, without moving the avatar', (t) => {
  const r = rig(t);
  r.controls.start();
  const head = pose(0.3, 1.6, -0.4);
  r.tick(r.frame({ head }));
  const before = r.controls.state();
  const headBefore = headFrom(before.matrix, [0.3, 1.6, -0.4]);
  const feet = r.player.pos.clone();
  r.tick(r.frame({ head, right: controller({ stick: [1, 0] }) }), r.frame({ head, right: controller({ stick: [1, 0] }) }));
  const after = r.controls.state();
  const turned = wrap(after.yaw - before.yaw);
  assert.ok(Math.abs(turned + SNAP_ANGLE) < 1e-6, `one step right: ${turned}`);
  assert.ok(headFrom(after.matrix, [0.3, 1.6, -0.4]).distanceTo(headBefore) < 1e-6, 'head fixed');
  assert.ok(r.player.pos.distanceTo(feet) < 1e-6, 'avatar fixed');
  r.tick(r.frame({ head, right: controller({ stick: [0, 0] }) }), r.frame({ head, right: controller({ stick: [-1, 0] }) }));
  assert.ok(Math.abs(wrap(r.controls.state().yaw - before.yaw)) < 1e-6, 'recentered stick re-arms; left push turns back');
});

test('room-scale walking goes through the player collision and stops at a desk', (t) => {
  const desk: Collider = { minX: -1, maxX: 1, minZ: -2, maxZ: -1.2, top: 0.78 };
  const r = rig(t, [desk]);
  r.controls.start();
  r.tick(r.frame({ head: pose(0, 1.6, 0) }));
  const base = r.controls.state();
  // The rig faces +Z (facing 0), so native -Z is world +Z: walk native +Z to go world -Z into the desk.
  for (let z = 0; z <= 2; z += 0.25) r.tick(r.frame({ head: pose(0, 1.6, z) }));
  assert.ok(r.player.pos.z > -1.2 + 0.3, `stopped outside the desk: z=${r.player.pos.z}`);
  assert.ok(r.player.pos.z < -0.5, 'did walk up to it');
  assert.ok(Math.abs(r.controls.state().yaw - base.yaw) < 1e-9);
  const cam = r.camera.position;
  assert.ok(cam.z < -1.2, 'the head itself can lean over the desk; only the body collides');
  assert.equal(r.player.moving, true);
});

test('a long head move between 30 Hz ticks cannot tunnel through a thin wall', (t) => {
  const wall: Collider = { minX: -3, maxX: 3, minZ: -0.75, maxZ: -0.7, top: 3 };
  const r = rig(t, [wall]);
  r.player.pos.set(0, 0, 0);
  stepToward(r.player, 0, -1.4);
  assert.ok(r.player.pos.z > -0.7, `z=${r.player.pos.z}`);
});

test('a controller trigger taps E once per press, even when press and release land between ticks', (t) => {
  const r = rig(t);
  r.controls.start();
  const aimAtBox = pose(0, 1.2, 0, quatYaw(Math.PI));
  const c = (trigger: number) => controller({ aim: aimAtBox, trigger });
  r.tick(r.frame({ right: c(0) }));
  // The rig faces +Z, so the box at world z=2 is native -Z: aim straight ahead (identity).
  const ahead = pose(0, 1.2, 0);
  r.tick(r.frame({ right: controller({ aim: ahead, trigger: 1 }) }), r.frame({ right: controller({ aim: ahead, trigger: 0 }) }));
  assert.deepEqual(r.calls.e, [r.target], 'one E from a sub-tick click');
  r.tick(r.frame({ right: controller({ aim: ahead, trigger: 0.8 }) }), r.frame({ right: controller({ aim: ahead, trigger: 0.65 }) }), r.frame({ right: controller({ aim: ahead, trigger: 0.8 }) }));
  assert.equal(r.calls.e.length, 2, 'hysteresis: easing to 0.65 is still held');
  r.tick(r.frame({ right: controller({ aim: aimAtBox, trigger: 0 }) }), r.frame({ right: controller({ aim: aimAtBox, trigger: 1 }) }));
  assert.equal(r.calls.e.length, 2, 'aimed away: nothing to use');
  assert.ok(r.controls.state().haptics.length > 0, 'controller presses request haptics');
  assert.equal(r.controls.state().haptics.length, 0, 'haptics drain');
});

test('aiming at something in reach labels nothing: the headset names no controls', (t) => {
  const targets: (Interactable | null)[] = [];
  const r = rig(t, [], { onTarget: (it) => targets.push(it) });
  r.controls.start();
  r.tick(r.frame({ right: controller({ aim: pose(0, 1.2, 0) }) }));
  assert.equal(targets.at(-1), r.target, 'the aimed target still drives use');
  assert.equal(r.controls.state().hands[1].hover?.near, true, 'the ray still shows its in-reach dot');
  assert.deepEqual(texts(r.controls.state()), []);
});

test('a ray on a compositor panel yields: no E, no teleport, no squeeze grab or menu', (t) => {
  const r = rig(t);
  r.controls.start();
  const ahead = pose(0, 1.2, 0);
  r.tick(r.frame({ right: controller({ aim: ahead, ui: true }) }), r.frame({ right: controller({ aim: ahead, ui: true, trigger: 1, a: true, squeeze: 1 }) }));
  r.tick(r.frame({ right: controller({ aim: ahead, ui: true }) }));
  assert.equal(r.calls.e.length, 0);
  assert.equal(r.controls.state().teleport, null);
  assert.equal(r.controls.state().hands[1].ui, true);
  assert.equal(r.controls.state().hands[1].hover, null);
  assert.equal(r.calls.panel, 0, 'grip on a panel neither grabs nor toggles the menu');
});

test('panel scrolling consumes both sticks without turning, walking or climbing', (t) => {
  const r = rig(t);
  r.hooks.settings.vr.glide = true;
  r.controls.start();
  r.tick(r.frame());
  const yaw = r.controls.state().yaw;
  const feet = r.player.pos.clone();
  for (const turn of ['snap', 'smooth'] as const) {
    r.hooks.settings.vr.turn = turn;
    for (let i = 0; i < 3; i++) {
      r.tick(r.frame({ left: controller({ stick: [0, 1], ui: true }), right: controller({ stick: [1, 1], ui: true }) }));
    }
    assert.equal(r.controls.state().yaw, yaw, `${turn} scrolling keeps the world facing`);
    assert.ok(r.player.pos.distanceTo(feet) < 1e-6, 'scrolling keeps the avatar in place');
  }
  const climbs: number[] = [];
  r.player.rig = () => climbs.push(r.player.climbInput);
  r.tick(r.frame({ left: controller({ stick: [0, 1], ui: true }) }));
  assert.deepEqual(climbs, [0], 'panel scrolling does not climb a ladder');
  r.player.rig = null;
  r.hooks.settings.vr.turn = 'snap';
  r.tick(r.frame({ left: controller(), right: controller({ stick: [1, 0] }) }));
  assert.ok(Math.abs(wrap(r.controls.state().yaw - yaw) + SNAP_ANGLE) < 1e-6, 'the stick turns again when it leaves the panel');
});

test('face buttons have distinct roles and only left Menu opens the workspace', (t) => {
  const r = rig(t);
  let commands = 0,
    back = 0,
    panelOpen = false;
  r.hooks.openCommands = () => commands++;
  r.hooks.back = () => back++;
  r.hooks.panelOpen = () => panelOpen;
  r.controls.start();
  r.tick(r.frame({ left: controller(), right: controller() }));
  r.tick(r.frame({ left: controller({ a: true }), right: controller({ b: true, stickClick: true }) }));
  assert.equal(r.calls.next, 1, 'only X calls the next waiting worker');
  assert.equal(back, 0, 'B in the world with no card does nothing');
  assert.equal(r.calls.panel, 0, 'no button but left Menu opens the workspace');
  r.tick(r.frame({ left: controller(), right: controller() }), r.frame({ left: controller({ b: true }), right: controller({ a: true }) }));
  assert.equal(commands, 1, 'Y opens commands');
  assert.ok(r.player.vy > 0, 'A jumps');
  assert.equal(r.calls.next, 1, 'Y and A do not also call N');
  panelOpen = true;
  r.tick(r.frame({ left: controller(), right: controller() }), r.frame({ left: controller({ stickClick: true }), right: controller({ b: true, stickClick: true }) }));
  assert.equal(back, 1);
  assert.equal(r.calls.panel, 0, 'a stick click with the workspace open leaves it as it is');
  r.tick(r.frame({ left: controller({ menu: true }), right: controller({ menu: true, b: true, stickClick: true }) }));
  assert.equal(r.calls.panel, 1, 'only left Menu toggles the workspace');
  assert.equal(back, 1);
  r.tick(r.frame({ left: controller(), right: controller() }), r.frame({ right: controller({ menu: true }) }));
  assert.equal(r.calls.panel, 1, 'right Menu stays reserved');
});

test('tracked hands are ignored: no E, N, menu, grab, teleport, glide or turn, and no connected slot', (t) => {
  const r = rig(t);
  r.hooks.settings.vr.glide = true;
  r.controls.start();
  r.tick(r.frame());
  const yaw = r.controls.state().yaw;
  const raw = (h: Record<string, unknown>) => ({ ...r.frame(), hands: [h, h] });
  for (let i = 0; i < 40; i++) {
    r.controls.consume([raw(trackedHand({ aim: pose(0, 1.2, 0) })), raw(trackedHand({ aim: pose(0, 1.2, 0), trigger: 0, menu: false }))]);
    r.controls.update(1 / 30);
  }
  assert.deepEqual(r.calls.e, []);
  assert.equal(r.calls.next, 0);
  assert.equal(r.calls.panel, 0);
  const s = r.controls.state();
  assert.deepEqual(
    s.hands.map((h) => h.connected),
    [false, false],
  );
  assert.equal(s.teleport, null);
  assert.equal(s.yaw, yaw);
  assert.ok(Math.hypot(r.player.pos.x, r.player.pos.z) < 1e-6, 'a hand never glides the avatar');
});

test('right stick forward aims and releases teleport in either movement mode; A and left stick do not', (t) => {
  const r = rig(t);
  r.hooks.settings.vr.fade = false;
  r.controls.start();
  const down = pose(0, 1.2, 0, new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5, 0, 0)).toArray());
  r.tick(r.frame({ left: controller(), right: controller({ aim: down }) }));
  for (const glide of [false, true]) {
    r.hooks.settings.vr.glide = glide;
    const before = r.player.pos.clone();
    r.tick(r.frame({ left: controller(), right: controller({ aim: down, stick: [0, 1] }) }));
    assert.ok(r.controls.state().teleport?.valid);
    r.tick(r.frame({ left: controller(), right: controller({ aim: down }) }));
    assert.ok(r.player.pos.distanceTo(before) > 1, 'right stick release travels');
  }
  r.hooks.settings.vr.glide = false;
  r.tick(r.frame({ left: controller({ aim: down, a: true, stick: [0, 1] }), right: controller({ aim: down, a: true }) }));
  assert.equal(r.controls.state().teleport, null, 'A/X and left stick never start a teleport');
});

test('glide moves along the head direction with collision; smooth turn rotates about the head', (t) => {
  const r = rig(t);
  r.hooks.settings.vr.glide = true;
  r.hooks.settings.vr.turn = 'smooth';
  r.controls.start();
  r.tick(r.frame());
  for (let i = 0; i < 15; i++) r.tick(r.frame({ left: controller({ stick: [0, 1] }) }));
  assert.ok(r.player.pos.z > 1.5, `forward is the facing (+Z): ${r.player.pos.z}`);
  assert.ok(Math.abs(r.player.pos.x) < 1e-6);
  const yaw = r.controls.state().yaw;
  const head = r.camera.position.clone();
  // With the left controller connected the right stick only turns (alone, it would also glide, as in VRSession).
  r.tick(r.frame({ left: controller(), right: controller({ stick: [1, 0] }) }));
  const d = wrap(r.controls.state().yaw - yaw);
  assert.ok(Math.abs(d + THREE.MathUtils.degToRad(90) / 30) < 1e-6, `90°/s for 1/30 s: ${d}`);
  assert.ok(r.camera.position.distanceTo(head) < 1e-6);
});

function grabRig(t: TestContext) {
  const sent: (CarriedObject | null)[] = [];
  const released: unknown[] = [];
  const item: CarriedObject = { kind: 'coffee', empty: false, pose: { hand: 'right', position: [0, 0, 0], quaternion: [0, 0, 0, 1] } };
  const cupAt = new THREE.Vector3(-0.2, 1.2, 0.4);
  const cup: Grabbable = {
    point: cupAt,
    item,
    take() {},
    use: () => {
      if (item.kind === 'coffee') item.empty = true;
    },
    release: (aim) => released.push(aim),
    valid: () => true,
    place: true,
    mouthUse: true,
  };
  const grab: GrabHooks = { pick: () => cup, changed: (s) => sent.push(s), ground: () => 0.75 };
  const r = rig(t, [], { grab });
  return { ...r, sent, released, item };
}

test('controller squeeze grabs a nearby cup, trigger drinks it, release places it, and losing the controller clears it', (t) => {
  const g = grabRig(t);
  g.controls.start();
  g.tick(g.frame());
  const near = pose(0.2, 1.2, -0.4);
  g.tick(g.frame({ right: controller({ grip: near }) }), g.frame({ right: controller({ grip: near, squeeze: 1 }) }));
  assert.equal(g.sent.at(-1)?.pose?.hand, 'right');
  assert.equal(g.controls.state().hands[1].holding, true);
  g.tick(g.frame({ right: controller({ grip: near, squeeze: 1, trigger: 1 }) }));
  assert.equal(g.item.kind === 'coffee' && g.item.empty, true, 'trigger uses the held cup');
  assert.equal(g.calls.e.length, 0, 'and does not also press E');
  g.tick(g.frame({ right: controller({ grip: near, squeeze: 0 }) }));
  assert.equal(g.sent.at(-1)?.pose?.placed, true);
  // It rests on the surface (ground 0.75 + 0.04), below the hand that let go of it.
  const atCup = pose(0.2, 0.85, -0.4);
  g.tick(g.frame({ right: controller({ grip: atCup, squeeze: 0 }) }), g.frame({ right: controller({ grip: atCup, squeeze: 1 }) }));
  assert.equal(g.sent.at(-1)?.pose?.placed, undefined, 'the placed cup is grabbed again');
  g.tick(g.frame({ right: off() }));
  assert.ok(g.calls.cancel.includes(1), 'a loss cancels the panel press at once');
  assert.notEqual(g.sent.at(-1), null, 'a brief loss keeps the cup in hand');
  g.tick(g.frame({ right: off(), time: g.time() + LOST_MS }));
  assert.equal(g.sent.at(-1), null, 'a disconnect clears the carry');
  assert.equal(g.calls.panel, 0);
});

test('input going stale drops every controller and its carry; the head keeps its pose', (t) => {
  const g = grabRig(t);
  g.controls.start();
  g.tick(g.frame());
  g.tick(g.frame({ right: controller({ grip: pose(0.2, 1.2, -0.4) }) }), g.frame({ right: controller({ grip: pose(0.2, 1.2, -0.4), squeeze: 1 }) }));
  assert.equal(g.controls.state().hands[1].connected, true);
  assert.notEqual(g.sent.at(-1), undefined);
  const cam = g.camera.position.clone();
  g.advance(600);
  g.controls.update(1 / 30);
  assert.equal(g.controls.state().hands[1].connected, false);
  assert.equal(g.sent.at(-1), null);
  assert.ok(g.camera.position.distanceTo(cam) < 1e-6);
});

test('desktop moves (N, elevator) carry the rig and panels; faceAvatar turns the head straight', (t) => {
  const r = rig(t);
  r.controls.start();
  r.tick(r.frame({ head: pose(0.2, 1.6, 0.1) }));
  r.player.pos.set(5, 0, -4);
  r.player.facing = -Math.PI / 2;
  r.controls.faceAvatar();
  r.tick(r.frame({ head: pose(0.2, 1.6, 0.1) }));
  const head = headFrom(r.controls.state().matrix, [0.2, 1.6, 0.1]);
  assert.ok(Math.hypot(head.x - 5, head.z + 4) < 0.3, `head follows the avatar: ${head.toArray()}`);
  assert.ok(Math.abs(r.player.facing + Math.PI / 2) < 1e-6, 'faces the avatar heading');
  assert.ok(r.calls.carryAlong.length > 0);
  const moved = r.calls.carryAlong.reduce((a, d) => a.add(d), new THREE.Vector3());
  assert.ok(moved.distanceTo(new THREE.Vector3(5, 0, -4)) < 0.3);
});

test('fades: a teleport blinks through black; a trip holds black until fadeIn', (t) => {
  const r = rig(t);
  r.controls.start();
  r.tick(r.frame());
  r.controls.fadeOut();
  for (let i = 0; i < 10; i++) r.tick(r.frame());
  assert.equal(r.controls.state().fade, 1, 'held black');
  r.controls.fadeIn();
  for (let i = 0; i < 10; i++) r.tick(r.frame());
  assert.equal(r.controls.state().fade, 0);
  r.controls.teleportTo(new THREE.Vector3(2, 0, 2));
  r.tick(r.frame());
  assert.ok(r.controls.state().fade > 0);
  for (let i = 0; i < 10; i++) r.tick(r.frame());
  assert.ok(Math.hypot(r.player.pos.x - 2, r.player.pos.z - 2) < 1e-6);
  assert.equal(r.controls.state().fade, 0);
});

test('a runtime recenter (head jump) rebases instead of walking the avatar through the room', (t) => {
  const r = rig(t);
  r.controls.start();
  r.tick(r.frame({ head: pose(0, 1.6, 0) }));
  const feet = r.player.pos.clone();
  r.tick(r.frame({ head: pose(3, 1.6, 2) }));
  assert.ok(r.player.pos.distanceTo(feet) < 1e-6);
  assert.ok(Math.hypot(r.camera.position.x - feet.x, r.camera.position.z - feet.z) < 1e-6);
});

test('a runtime origin change rebases a small translation and rotation against the new sample', (t) => {
  const r = rig(t);
  r.controls.start();
  r.tick(r.frame({ head: pose(0, 1.6, 0) }));
  const feet = r.player.pos.clone();
  const facing = r.player.facing;
  // This change is below the jump detector's threshold, but belongs to a new reference space.
  r.controls.rebase();
  r.tick(r.frame({ head: pose(0.4, 1.6, 0.3, quatYaw(Math.PI / 3)) }));
  assert.ok(r.player.pos.distanceTo(feet) < 1e-6);
  assert.ok(Math.hypot(r.camera.position.x - feet.x, r.camera.position.z - feet.z) < 1e-6);
  assert.ok(Math.abs(wrap(r.player.facing - facing)) < 1e-6);
});

test('the sample queue is bounded, ordered and ignores samples while inactive', (t) => {
  const r = rig(t);
  assert.equal(r.controls.consume([r.frame()]), 0, 'inactive');
  r.controls.start();
  const frames = Array.from({ length: MAX_QUEUE + 10 }, () => r.frame());
  assert.equal(r.controls.consume(frames), MAX_QUEUE + 10);
  assert.equal(r.controls.consume([{ ...frames[0] }, { bad: true }]), 0);
  const s = r.controls.state();
  assert.equal(s.stats.queued, MAX_QUEUE);
  assert.equal(s.stats.dropped, 10);
  assert.equal(s.stats.rejected, 2, 'an old time and a malformed sample');
  r.controls.update(1 / 30);
  assert.equal(r.controls.state().stats.queued, 0);
});

test('native climbing never substitutes stick direction or trigger activation for a physical grip', (t) => {
  const r = rig(t);
  r.controls.start();
  const seen: number[] = [];
  r.player.rig = () => seen.push(r.player.climbInput);
  r.tick(r.frame({ left: controller({ stick: [0, 1] }) }));
  r.tick(r.frame({ left: controller({ stick: [0, -1] }) }));
  assert.deepEqual(seen, [0, 0]);
  r.tick(r.frame({ right: controller() }), r.frame({ right: controller({ trigger: 1 }) }));
  assert.deepEqual(r.calls.e, [], 'trigger does not release a physical climb');
  r.player.rig = null;
  for (const kind of ['gong', 'ladder', 'pole'] as const) {
    r.target.kind = kind;
    r.tick(r.frame({ right: controller({ aim: pose(0, 1.2, 0) }) }), r.frame({ right: controller({ aim: pose(0, 1.2, 0), trigger: 1 }) }));
  }
  assert.deepEqual(r.calls.e, [], 'these objects require physical interactions');
});

test('stop hands the avatar back to the desktop controls', (t) => {
  const r = rig(t);
  r.controls.start();
  r.tick(r.frame({ right: controller() }));
  r.controls.stop();
  assert.equal(r.controls.active, false);
  assert.equal(r.player.enabled, true);
  assert.equal(r.controls.rig.visible, false);
  assert.equal(r.controls.consume([r.frame()]), 0);
  r.controls.update(1 / 30);
  assert.equal(r.controls.state().active, false);
});

test('native jump uses the desktop boost and respects the same solid ceiling', (t) => {
  const r = rig(t, [{ minX: -1, maxX: 1, minZ: -1, maxZ: 1, bottom: 1.9, top: 2.2 }]);
  r.player.jumpBoost = 1.4;
  r.player.jump();
  assert.equal(r.player.grounded, false);
  assert.ok(r.player.vy > 6.4);
  for (let i = 0; i < 8; i++) applyGravity(r.player, 1 / 90);
  assert.ok(r.player.pos.y <= 0.2 + 1e-9, 'head stays below the overhead slab');
  assert.ok(r.player.vy <= 0, 'ceiling stops the upward jump');
});

test('locomotion helpers: rigFor puts any head pose over the feet, findLanding refuses walls', (t) => {
  globals(t);
  const out = new THREE.Vector3();
  const local = new THREE.Vector3(0.7, 1.5, -1.1);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 2);
  const yaw = rigFor(local, q, new THREE.Vector3(3, 1, -2), 0.4, out);
  const head = local
    .clone()
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
    .add(out);
  assert.ok(Math.hypot(head.x - 3, head.z + 2) < 1e-9);
  const look = new THREE.Vector3(0, 0, -1).applyQuaternion(q).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  assert.ok(Math.abs(Math.atan2(look.x, look.z) - 0.4) < 1e-9);
  const block: Collider = { minX: 1, maxX: 3, minZ: -1, maxZ: 1, top: 3 };
  const player = new PlayerController(new THREE.PerspectiveCamera(), new EventTarget() as unknown as HTMLElement, [officeFloor, block]);
  assert.equal(findLanding(player, [new THREE.Vector3(2, 0, 0)]), null, 'inside a wall');
  assert.deepEqual(findLanding(player, [new THREE.Vector3(2, 2, 5), new THREE.Vector3(-2, -0.05, 0)])?.toArray(), [-2, 0, 0]);
});

function carriedRig(t: TestContext) {
  let card: CarriedIssue | null = null;
  let placing = false;
  const sent: (CarriedObject | null)[] = [];
  const r = rig(t, [], { carrying: () => card, grab: { pick: () => null, changed: (item) => sent.push(item), ground: () => 0 } });
  const set = (next: CarriedIssue | null) => {
    card = next;
    r.controls.syncCarrying();
  };
  r.hooks.useE = () => set(placing ? null : { issue: 42, title: 'Shared issue card' });
  r.hooks.putBack = () => {
    r.calls.putBack++;
    set(null);
  };
  r.controls.start();
  r.tick(r.frame({ left: controller(), right: controller() }));
  return {
    ...r,
    sent,
    set,
    place: () => {
      placing = true;
    },
    card: () => card,
    visual: () => r.scene.getObjectByName('native-carried-issue'),
  };
}

test('a ray pickup attaches the original issue card to its selecting hand and publishes the shared carry pose', (t) => {
  const r = carriedRig(t);
  r.tick(r.frame({ left: controller({ trigger: 1 }), right: controller() }));
  assert.equal(r.card()?.issue, 42);
  assert.equal(r.controls.state().hands[0].holding, true);
  assert.equal(r.controls.state().hands[1].holding, false);
  const visual = r.visual();
  assert.ok(visual);
  assert.equal(visual.children.length, 1);
  const cardMesh = visual.children[0] as THREE.Mesh;
  assert.ok(cardMesh.geometry instanceof THREE.BoxGeometry, 'reuses the original HeldCard geometry');
  assert.ok((cardMesh.material as THREE.MeshToonMaterial[])[4].map instanceof THREE.CanvasTexture, 'reuses the original card text texture');
  const state = r.sent.at(-1);
  assert.equal(state?.pose?.hand, 'left');
  assert.deepEqual(state?.pose?.position, visual.parent!.getWorldPosition(new THREE.Vector3()).toArray());
  assert.deepEqual(r.controls.state().carrying, { issue: 42, title: 'Shared issue card' });
  assert.deepEqual(texts(r.controls.state()), [], 'the card in hand says what it is; no aim or carry text reaches the status panel');
  r.tick(r.frame({ left: controller({ grip: pose(-0.3, 1.1, -0.4) }), right: controller() }));
  assert.equal(r.visual(), visual, 'a hand update moves the same card instead of allocating another');
});

for (const hand of ['left', 'right'] as const) {
  test(`ray-picked ${hand} cards publish their grip position and wrist orientation`, (t) => {
    const r = carriedRig(t);
    r.tick(r.frame({ [hand]: controller({ trigger: 1 }), [hand === 'left' ? 'right' : 'left']: controller() }));
    const local = r.visual()!.children[0];
    for (const [pitch, yaw, roll] of [
      [0, 0, 0],
      [0.6, -0.8, 1.1],
      [-0.4, 1.2, -0.7],
    ]) {
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll));
      r.advance(60);
      r.tick(r.frame({ [hand]: controller({ grip: pose(-0.25, 1.35, -0.45, rotation.toArray()) }), [hand === 'left' ? 'right' : 'left']: controller() }));
      const carried = r.sent.at(-1)!;
      assert.equal(carried.pose?.hand, hand);
      const grip = r.visual()!.parent!;
      assert.deepEqual(carried.pose?.position, grip.getWorldPosition(new THREE.Vector3()).toArray(), 'the published pose is the grip frame');
      assert.ok(new THREE.Quaternion().fromArray(carried.pose!.quaternion).angleTo(grip.getWorldQuaternion(new THREE.Quaternion())) < 1e-7, 'the published pose carries the wrist roll');
      assert.ok(local.getWorldQuaternion(new THREE.Quaternion()).angleTo(grip.getWorldQuaternion(new THREE.Quaternion())) < 1e-7, 'the card stays rigidly attached to its owning grip');
    }
  });
}

test('window pickup chooses a tracked controller, swaps one visual, and clears it on original placement or Put back', (t) => {
  const r = carriedRig(t);
  r.set({ issue: 8, title: 'Picked in the issue window' });
  assert.equal(r.controls.state().hands[1].holding, true, 'window pickup prefers the right controller');
  const visual = r.visual();
  assert.ok(visual);
  r.set({ issue: 9, title: 'Another issue' });
  assert.equal(r.visual(), visual);
  assert.equal(visual.children.length, 1, 'swapping issue cards leaves exactly one mesh');
  assert.equal(r.controls.state().carrying?.issue, 9);
  r.place();
  r.tick(r.frame({ right: controller({ trigger: 1 }) }));
  assert.equal(r.card(), null, 'original placement dispatch clears the shared slot');
  assert.equal(r.visual(), undefined);
  assert.equal(r.controls.state().hands[1].holding, false);
  r.set({ issue: 10, title: 'Return this card' });
  r.hooks.putBack();
  assert.equal(r.visual(), undefined);
  assert.equal(r.controls.state().carrying, null);
});

test('loss of the owning controller, focus reset and floor cleanup return a ray card through the original Put back action', (t) => {
  const r = carriedRig(t);
  r.set({ issue: 20, title: 'Tracking loss' });
  r.tick(r.frame({ left: controller() }));
  assert.equal(r.card()?.issue, 20, 'a brief loss keeps the card with its controller');
  assert.equal(r.controls.state().hands[1].holding, true);
  r.tick(r.frame({ left: controller(), time: r.time() + LOST_MS }));
  assert.equal(r.card(), null, 'the card is not silently transferred to the other controller');
  assert.equal(r.calls.putBack, 1);
  assert.equal(r.visual(), undefined);
  r.set({ issue: 21, title: 'Floor travel' });
  r.controls.clearGrab();
  assert.equal(r.card(), null);
  assert.equal(r.calls.putBack, 2);
  r.tick(r.frame({ right: controller() }));
  r.set({ issue: 22, title: 'Focus reset' });
  r.controls.reset();
  assert.equal(r.card(), null);
  assert.equal(r.calls.putBack, 3);
  assert.equal(r.visual(), undefined);
});

test('the held-card controller yields its panel ray while the free one can still use the workspace', (t) => {
  const r = carriedRig(t);
  r.set({ issue: 23, title: 'One owner' });
  r.tick(r.frame({ left: controller({ ui: true }), right: controller({ ui: true }) }));
  const state = r.controls.state();
  assert.equal(state.hands[0].ui, true);
  assert.equal(state.hands[0].holding, false);
  assert.equal(state.hands[1].ui, false);
  assert.equal(state.hands[1].holding, true);
  r.tick(r.frame({ left: controller({ ui: true }), right: controller({ squeeze: 1 }) }));
  assert.equal(r.card()?.issue, 23, 'grip does not return cards or navigate the workspace');
  r.tick(r.frame({ right: controller() }), r.frame({ right: controller({ b: true }) }));
  assert.equal(r.card(), null, 'B returns the card through the original Put back');
  assert.equal(r.calls.panel, 0, 'and never toggles the menu');
  assert.equal(r.visual(), undefined);
});

test('a physical near grab owns its original VRGrab visual without a duplicate ray card', (t) => {
  let card = null as CarriedIssue | null;
  let r: Rig;
  const item = { issue: 31, title: 'Physical board card' };
  const target: Grabbable = {
    point: new THREE.Vector3(-0.2, 1.2, 0.4),
    item,
    take: () => {
      card = item;
      r.controls.syncCarrying();
    },
    use: () => {},
    release: () => {
      card = null;
      r.controls.syncCarrying();
    },
    valid: () => card?.issue === item.issue,
  };
  r = rig(t, [], { carrying: () => card, grab: { pick: () => target, changed: () => {}, ground: () => 0 } });
  r.controls.start();
  r.tick(r.frame({ right: controller({ grip: pose(0.2, 1.2, -0.4) }) }), r.frame({ right: controller({ grip: pose(0.2, 1.2, -0.4), squeeze: 1 }) }));
  assert.equal(card?.issue, 31);
  assert.equal(r.controls.state().hands[1].holding, true);
  assert.equal(r.scene.getObjectByName('native-carried-issue'), undefined);
  r.tick(r.frame({ right: controller({ grip: pose(0.2, 1.2, -0.4), squeeze: 0 }) }));
  assert.equal(card, null);
  assert.equal(r.controls.state().hands[1].holding, false);
});

test('presentation epochs jump for snap, placement, recenter and focus reset while ordinary smooth motion stays continuous', (t) => {
  const r = rig(t);
  r.controls.start();
  r.tick(r.frame({ left: controller(), right: controller() }));
  let epoch = r.controls.state().presentationEpoch;
  r.hooks.settings.vr.glide = true;
  r.hooks.settings.vr.turn = 'smooth';
  r.tick(r.frame({ left: controller({ stick: [0, 1] }), right: controller({ stick: [1, 0] }) }));
  assert.equal(r.controls.state().presentationEpoch, epoch, 'glide and smooth yaw do not bypass interpolation');
  r.hooks.settings.vr.turn = 'snap';
  r.tick(r.frame({ right: controller({ stick: [1, 0] }) }));
  assert.notEqual(r.controls.state().presentationEpoch, epoch);
  epoch = r.controls.state().presentationEpoch;
  r.hooks.settings.vr.fade = false;
  const at = r.player.pos.clone().add(new THREE.Vector3(0.01, 0, 0));
  r.controls.teleportTo(at);
  assert.notEqual(r.controls.state().presentationEpoch, epoch, 'even a tiny teleport is an abrupt placement');
  const world = headFrom(r.controls.state().matrix, [0, 1.6, 0]);
  assert.ok(Math.abs(world.x - at.x) < 1e-7, 'epoch and moved rig are in the same packet');
  epoch = r.controls.state().presentationEpoch;
  r.controls.recenter();
  assert.notEqual(r.controls.state().presentationEpoch, epoch);
  epoch = r.controls.state().presentationEpoch;
  r.controls.reset();
  assert.notEqual(r.controls.state().presentationEpoch, epoch);
  epoch = r.controls.state().presentationEpoch;
  r.player.pos.x += 0.01;
  r.controls.update(1 / 30);
  assert.notEqual(r.controls.state().presentationEpoch, epoch, 'external Go-to-desk/elevator placement jumps');
});

test('a faded teleport commits its new epoch with the new rig while the view is fully black', (t) => {
  const r = rig(t);
  r.controls.start();
  r.tick(r.frame({ right: controller() }));
  const before = r.controls.state().presentationEpoch;
  const at = new THREE.Vector3(0.01, 0, 0);
  r.controls.teleportTo(at);
  r.controls.update(0.1);
  const state = r.controls.state();
  assert.equal(state.fade, 1);
  assert.notEqual(state.presentationEpoch, before);
  assert.ok(Math.abs(headFrom(state.matrix, [0, 1.6, 0]).x - at.x) < 1e-7);
  r.controls.update(0.03);
  assert.equal(r.controls.state().presentationEpoch, state.presentationEpoch, 'fade-in does not consume a late extra placement epoch');
  assert.ok(r.controls.state().fade < 1);
});

test('grip never opens, closes or navigates a workspace, even with a carried card', (t) => {
  let card: CarriedIssue | null = null;
  const r = rig(t, [], { carrying: () => card });
  r.hooks.putBack = () => {
    r.calls.putBack++;
    card = null;
  };
  r.controls.start();
  for (const side of ['left', 'right'] as const) {
    r.tick(r.frame({ [side]: controller() }));
    r.tick(r.frame({ [side]: controller({ squeeze: 1 }) }), r.frame({ [side]: controller() }), r.frame({ [side]: controller({ squeeze: 1 }) }));
    r.tick(r.frame({ [side]: controller({ squeeze: 1, ui: true }) }), r.frame({ [side]: controller() }));
  }
  assert.equal(r.calls.panel, 0, 'no grip press toggles the menu');
  assert.equal(r.calls.putBack, 0, 'with nothing carried there is nothing to put back');
  card = { issue: 3, title: 'Held' };
  r.tick(r.frame({ right: controller() }), r.frame({ right: controller({ squeeze: 1 }) }));
  assert.equal(r.calls.putBack, 0, 'grip does not return a carried card');
  assert.equal(r.calls.panel, 0);
});

test('a controller that returns with its trigger, grip, menu or N still held fires nothing', (t) => {
  const r = rig(t);
  r.controls.start();
  const ahead = pose(0, 1.2, 0);
  r.tick(r.frame({ left: controller(), right: controller({ aim: ahead }) }));
  r.tick(r.frame({ left: controller({ menu: true, squeeze: 1, b: true }), right: controller({ aim: ahead, trigger: 1, b: true }) }));
  const e = r.calls.e.length;
  const panel = r.calls.panel;
  const next = r.calls.next;
  assert.deepEqual([e, panel], [1, 1], 'the first presses act once');
  const held = () => r.frame({ left: controller({ menu: true, squeeze: 1, b: true }), right: controller({ aim: ahead, trigger: 1, b: true }) });
  // A blip (one sample) and a long loss (past LOST_MS): neither replays a held button as a press.
  r.tick(r.frame({ left: off(), right: off() }), held());
  r.tick(r.frame({ left: off(), right: off() }), r.frame({ left: off(), right: off(), time: r.time() + LOST_MS }), held());
  assert.equal(r.calls.e.length, e, 'no phantom E');
  assert.equal(r.calls.panel, panel, 'no phantom menu toggle');
  assert.equal(r.calls.next, next, 'no phantom N');
  r.tick(r.frame({ left: controller(), right: controller({ aim: ahead }) }), r.frame({ left: controller({ menu: true }), right: controller({ aim: ahead, trigger: 1 }) }));
  assert.equal(r.calls.e.length, e + 1, 'a fresh trigger press acts again');
  assert.equal(r.calls.panel, panel + 1, 'a fresh menu press acts again');
});

test('a controller first seen with its buttons held is not a press', (t) => {
  const r = rig(t);
  r.controls.start();
  r.tick(r.frame());
  r.tick(r.frame({ left: controller({ menu: true, squeeze: 1 }), right: controller({ aim: pose(0, 1.2, 0), trigger: 1, stickClick: true }) }));
  assert.deepEqual([r.calls.e.length, r.calls.panel, r.calls.next], [0, 0, 0]);
});

test('a brief loss preserves a right-stick teleport and the other hand grab without firing either', (t) => {
  const g = grabRig(t);
  g.hooks.settings.vr.fade = false;
  g.controls.start();
  const near = pose(0.2, 1.2, -0.4);
  const down = pose(0, 1.2, 0, new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5, 0, 0)).toArray());
  g.tick(g.frame({ left: controller({ grip: near }), right: controller({ aim: down }) }));
  g.tick(g.frame({ left: controller({ grip: near, squeeze: 1 }), right: controller({ aim: down, stick: [0, 1] }) }));
  assert.equal(g.controls.state().hands[0].holding, true);
  assert.ok(g.controls.state().teleport);
  const feet = g.player.pos.clone();
  g.tick(g.frame());
  assert.ok(g.player.pos.distanceTo(feet) < 1e-9);
  assert.equal(g.released.length, 0);
  g.tick(g.frame({ left: controller({ grip: near, squeeze: 1 }), right: controller({ aim: down, stick: [0, 1] }) }));
  assert.ok(g.controls.state().teleport, 'aim resumes through brief tracking loss');
  g.tick(g.frame({ left: controller({ grip: near, squeeze: 1 }), right: controller({ aim: down }) }));
  assert.ok(g.player.pos.distanceTo(feet) > 0.5, 'intentional release travels');
});

test('long tracking loss cancels teleport and never transfers left/right stick roles', (t) => {
  const r = rig(t);
  r.hooks.settings.vr.fade = false;
  r.controls.start();
  const down = pose(0, 1.2, 0, new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5, 0, 0)).toArray());
  r.tick(r.frame({ left: controller(), right: controller({ aim: down }) }));
  r.tick(r.frame({ left: controller(), right: controller({ aim: down, stick: [0, 1] }) }));
  const feet = r.player.pos.clone();
  r.tick(r.frame({ left: controller({ aim: down, stick: [0, 1] }) }));
  r.tick(r.frame({ left: controller({ aim: down, stick: [0, 1] }), time: r.time() + LOST_MS }));
  assert.ok(r.player.pos.distanceTo(feet) < 1e-9, 'left controller never inherits right teleport');
  assert.equal(r.controls.state().teleport, null);
  r.tick(r.frame({ right: controller({ aim: down, stick: [0, 1] }) }));
  assert.equal(r.controls.state().teleport, null, 'reconnecting with pushed stick is not a fresh aim');
  r.tick(r.frame({ right: controller({ aim: down }) }), r.frame({ right: controller({ aim: down, stick: [0, 1] }) }));
  assert.ok(r.controls.state().teleport);
  r.hooks.settings.vr.glide = true;
  r.tick(r.frame({ right: controller({ aim: down }) }));
  const moved = r.player.pos.clone();
  r.tick(r.frame({ right: controller({ stick: [0, -1] }) }));
  assert.ok(r.player.pos.distanceTo(moved) < 1e-9, 'right stick never takes over locomotion');
});
