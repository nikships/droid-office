import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { Climber } from '../src/client/climb.js';
import { NativeControls, type NativeHooks } from '../src/client/native/controls.js';
import { type NativeHand, type NativeInputFrame, type Pose7, readFrame } from '../src/client/native/input.js';
import { GRIP_PITCH, NativePuppet, type PuppetEnv, type PuppetHand, type PuppetPacket, blendHands, headingRotation, resolveHand } from '../src/client/native/puppet.js';
import { PlayerController } from '../src/client/player.js';
import { loadSettings } from '../src/client/state.js';
import { FLOOR, POLES, SLAB } from '../src/shared/layout.js';

const v3 = (p: readonly number[]) => new THREE.Vector3(p[0], p[1], p[2]);
const q4 = (p: readonly number[]) => new THREE.Quaternion(p[3], p[4], p[5], p[6]);
/** Where a pose's -Z ray points. */
const forward = (p: readonly number[]) => new THREE.Vector3(0, 0, -1).applyQuaternion(q4(p));
const near = (a: THREE.Vector3, b: THREE.Vector3, eps = 1e-6) => a.distanceTo(b) < eps;
const HEAD: Pose7 = [0, 1.6, 0, 0, 0, 0, 1];

function puppetWith(env: Partial<PuppetEnv> = {}, clock = { now: 1000 }) {
  const puppet = new NativePuppet({ head: () => HEAD, rig: () => null, ...env }, () => clock.now);
  puppet.host(true);
  return { puppet, api: puppet.api, clock };
}

/** capture_puppet.h applyPuppet, for driving the page the way the native display loop does. */
function nativeMerge(frame: NativeInputFrame, packet: PuppetPacket | null): NativeInputFrame {
  if (!packet) return frame;
  const head = { p: v3(frame.head), q: q4(frame.head) };
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(head.q);
  const heading = { p: head.p, q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-fwd.x, -fwd.z)) };
  const place = (space: string, pose: Pose7): Pose7 => {
    const f = space === 'head' ? head : space === 'heading' ? heading : null;
    if (!f) return pose;
    const p = v3(pose).applyQuaternion(f.q).add(f.p);
    const q = f.q.clone().multiply(q4(pose));
    return [p.x, p.y, p.z, q.x, q.y, q.z, q.w];
  };
  const hands = frame.hands.map((real, h) => {
    const p = packet.hands[h];
    if (!p || (real.active && real.gripTracked !== false)) return real;
    return {
      active: true,
      gripTracked: true,
      puppet: true,
      ui: false,
      grip: place(p.space, p.grip),
      aim: place(p.space, p.aim),
      trigger: p.trigger,
      squeeze: p.squeeze,
      stick: p.stick,
      a: p.a,
      b: p.b,
      menu: p.menu,
      stickClick: p.stickClick,
    } as NativeHand;
  }) as [NativeHand, NativeHand];
  return { ...frame, hands };
}

test('the puppet is unavailable until a debug host reports it, and never sends otherwise', () => {
  const puppet = new NativePuppet({ head: () => HEAD, rig: () => null }, () => 0);
  assert.equal(puppet.api.available, false);
  assert.throws(() => puppet.api.set({ right: { grip: [0.15, -0.2, -0.35] } }), /debug build/);
  assert.throws(() => puppet.api.update({ right: { trigger: 1 } }), /debug build/);
  assert.throws(() => puppet.api.script([{ right: { grip: [0, 0, -0.3] } }]), /debug build/);
  assert.equal(puppet.packet(), null);
  assert.equal(puppet.api.clear().active, false, 'clear is always safe');
  puppet.host(true);
  assert.equal(puppet.api.available, true);
  puppet.api.set({ right: { grip: [0.15, -0.2, -0.35] } });
  assert.ok(puppet.packet());
  // A host that stops reporting it (a release build after an update) drops the staging.
  puppet.host(false);
  assert.equal(puppet.api.state().active, false);
  assert.equal(puppet.packet(), null);
});

test('hands resolve from a grip, an aim point or full poses, with the controller grip pitched above its ray', () => {
  const hand = resolveHand({ grip: [0.15, -0.2, -0.35], aimAt: [0, 0, -4] }, null);
  assert.equal(hand.space, 'head', 'head space by default');
  assert.deepEqual(hand.grip.slice(0, 3), [0.15, -0.2, -0.35]);
  assert.deepEqual(hand.aim.slice(0, 3), [0.15, -0.2, -0.35], 'the ray starts at the grip');
  const toTarget = new THREE.Vector3(0, 0, -4).sub(v3(hand.aim)).normalize();
  assert.ok(near(forward(hand.aim), toTarget), 'aim -Z points at aimAt');
  const pitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), GRIP_PITCH);
  assert.ok(q4(hand.grip).angleTo(q4(hand.aim).multiply(pitch)) < 1e-6, 'grip = aim · rotateX(GRIP_PITCH)');
  assert.equal(hand.trigger, 0);
  assert.deepEqual(hand.stick, [0, 0]);
  assert.equal(hand.a || hand.b || hand.menu || hand.stickClick, false);

  const fromGrip = resolveHand({ space: 'local', grip: [0, 1, -0.4, 0, 0, 0, 1] }, null);
  assert.ok(q4(fromGrip.aim).multiply(pitch).angleTo(new THREE.Quaternion()) < 1e-6, 'an aim follows a given grip');
  const full = resolveHand({ space: 'local', grip: [0, 1, 0, 0, 0, 0, 1], aim: [0, 1.05, -0.05, 0, 0, 0, 1] }, null);
  assert.deepEqual(full.aim, [0, 1.05, -0.05, 0, 0, 0, 1]);
  assert.deepEqual(full.grip, [0, 1, 0, 0, 0, 0, 1]);
  const flat = resolveHand({ grip: [0, 0, -0.3] }, null);
  assert.ok(near(forward(flat.aim), new THREE.Vector3(0, 0, -1)), 'no orientation points straight ahead');

  // Patching keeps what is not given, including the aim's offset from the grip.
  const moved = resolveHand({ grip: [0, 1.2, 0] }, full);
  assert.deepEqual(
    moved.aim.slice(0, 3).map((x) => +x.toFixed(6)),
    [0, 1.25, -0.05],
  );
  assert.deepEqual(moved.grip.slice(3), full.grip.slice(3));
  const pressed = resolveHand({ trigger: 3, squeeze: -1, stick: [2, -0.5], a: true }, full);
  assert.deepEqual([pressed.trigger, pressed.squeeze, pressed.stick, pressed.a, pressed.grip], [1, 0, [1, -0.5], true, full.grip]);
  assert.equal(resolveHand({ b: true }, pressed).trigger, 1);

  for (const [spec, previous, message] of [
    [{ trigger: 1 }, null, /needs grip/],
    [{ space: 'hand', grip: [0, 0, 0] }, null, /space must be/],
    [{ grip: [0, 0] }, null, /grip must be/],
    [{ grip: [0, Number.NaN, 0] }, null, /finite/],
    [{ grip: [0, 2000, 0] }, null, /finite/],
    [{ grip: [0, 0, 0, 0, 0, 0, 0] }, null, /unit quaternion/],
    [{ grip: [0, 0, 0], aimAt: [0, 0, 0] }, null, /away from/],
    [{ grip: [0, 0, 0], a: 1 }, null, /true or false/],
    [{ grip: [0, 0, 0], stick: [1] }, null, /stick/],
    [{ space: 'world' }, full, /needs its grip/],
  ] as const) {
    assert.throws(() => resolveHand(spec as never, previous as PuppetHand | null), message);
  }
});

test('the control packet carries resolved hands; world hands follow the rig and wait for it', () => {
  const rig = new THREE.Matrix4().compose(new THREE.Vector3(5, 0, 2), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2), new THREE.Vector3(1, 1, 1));
  let rigNow: THREE.Matrix4 | null = rig;
  const { puppet, api } = puppetWith({ rig: () => rigNow });
  assert.equal(puppet.packet(), null, 'nothing staged');
  const report = api.set({ right: { grip: [0.15, -0.2, -0.35], aimAt: [0, 0, -4], trigger: 0.5, b: true } });
  assert.equal(report.active, true);
  assert.ok(report.since);
  assert.equal(report.hands.left, null);
  const packet = puppet.packet()!;
  assert.equal(packet.v, 1);
  assert.equal(packet.hands[0], null);
  assert.equal(packet.hands[1]?.space, 'head', 'native composes head space with each display frame');
  assert.deepEqual(packet.hands[1]?.grip, report.hands.right?.grip);
  assert.equal(packet.hands[1]?.trigger, 0.5);
  assert.equal(packet.hands[1]?.b, true);
  assert.deepEqual(JSON.parse(JSON.stringify(packet)), packet, 'plain JSON');

  // A world point: the right hand reaches a button at (5.2, 1.5, 1.6) in the office.
  api.set({ left: { space: 'world', grip: [5.2, 1.5, 1.6], aimAt: [5.2, 1.5, 1.4] } });
  const local = puppet.packet()!.hands[0]!;
  assert.equal(local.space, 'local');
  const world = v3(local.grip).applyMatrix4(rig);
  assert.ok(near(world, new THREE.Vector3(5.2, 1.5, 1.6)), 'world → LOCAL_FLOOR through the inverse rig');
  const ray = forward(local.aim).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(rig));
  assert.ok(near(ray, new THREE.Vector3(0, 0, -1)), 'the ray still points at the button in the world');
  assert.equal(puppet.api.state().hands.right, null, 'set replaces the whole puppet');
  rigNow = null;
  assert.equal(puppet.packet(), null, 'a world hand waits for native controls');
  api.clear();
  assert.equal(api.state().since, null);
});

test('update patches one hand and keeps the other; null removes a hand', () => {
  const { puppet, api } = puppetWith();
  api.set({ left: { grip: [-0.2, -0.3, -0.35] }, right: { grip: [0.2, -0.3, -0.35], squeeze: 1 } });
  api.update({ right: { trigger: 1 } });
  let s = api.state();
  assert.equal(s.hands.right?.trigger, 1);
  assert.equal(s.hands.right?.squeeze, 1, 'squeeze held');
  assert.deepEqual(s.hands.right?.grip.slice(0, 3), [0.2, -0.3, -0.35]);
  assert.ok(s.hands.left);
  api.update({ left: null });
  s = api.state();
  assert.equal(s.hands.left, null);
  assert.equal(puppet.packet()?.hands[0], null);
  // Native reports which slots it actually drove; a tracked controller wins.
  puppet.observe([{ hands: [{ active: true }, { active: true, puppet: true }] }]);
  assert.deepEqual(api.state().driven, { left: false, right: true });
  puppet.observe([]);
  assert.deepEqual(api.state().driven, { left: false, right: true }, 'an empty batch changes nothing');
});

test('every staging call is recorded for capture labels, until the puppet is gone', async () => {
  const { puppet, api, clock } = puppetWith();
  assert.equal(api.state().label, null);
  assert.deepEqual(api.state().staging, []);
  api.set({ left: { grip: [-0.2, -0.3, -0.38] }, right: { grip: [0.2, -0.3, -0.38] } }, { label: 'scene.mjs puppet idle-hands' });
  // A direct call without a label is named after the API it used.
  api.update({ right: { b: true } });
  const s = api.state();
  assert.equal(s.label, '__office.puppet.update');
  assert.deepEqual(
    s.staging.map((x) => x.label),
    ['scene.mjs puppet idle-hands', '__office.puppet.update'],
  );
  assert.ok(s.staging.every((x) => !Number.isNaN(Date.parse(x.at))));
  api.update({ right: { b: false } });
  assert.equal(api.state().staging.length, 2, 'the same caller again is one entry');
  // A script is recorded when its steps apply, not when it is only queued.
  const done = api.script([{ right: { squeeze: 1 } }, { after: 50, right: { squeeze: 0 } }], { label: 'scene.mjs puppet hold-gun-right' });
  assert.equal(api.state().label, '__office.puppet.update');
  puppet.packet();
  clock.now += 60;
  puppet.packet();
  assert.equal((await done).ok, true);
  assert.equal(api.state().label, 'scene.mjs puppet hold-gun-right');
  // set replaces every hand, and the record starts over with it.
  api.set({ left: { grip: [-0.15, -0.2, -0.35] } }, { label: 'scene.mjs puppet hold-gun-left' });
  assert.deepEqual(
    api.state().staging.map((x) => x.label),
    ['scene.mjs puppet hold-gun-left'],
  );
  assert.throws(() => api.update({ left: { a: true } }, { label: ' ' }), /label/);
  assert.throws(() => api.set({}, { label: 7 as unknown as string }), /label/);
  api.update({ left: { a: true } }, { label: `  ${'x'.repeat(500)}  ` });
  assert.equal(api.state().label, 'x'.repeat(120));
  // Many calls keep the first and the latest ones.
  for (let i = 0; i < 30; i++) api.update({ left: { a: i % 2 === 0 } }, { label: `call ${i}` });
  const labels = api.state().staging.map((x) => x.label);
  assert.equal(labels.length, 12);
  assert.equal(labels[0], 'scene.mjs puppet hold-gun-left');
  assert.equal(labels.at(-1), 'call 29');
  api.clear();
  assert.equal(api.state().label, null);
  assert.deepEqual(api.state().staging, []);
  // Removing the last hand also ends the record; the next staging starts a new one.
  api.update({ right: { grip: [0.2, -0.3, -0.38] } }, { label: 'first' });
  api.update({ right: null }, { label: 'second' });
  assert.deepEqual(api.state().staging, []);
  api.update({ right: { grip: [0.2, -0.3, -0.38] } }, { label: 'third' });
  assert.deepEqual(
    api.state().staging.map((x) => x.label),
    ['third'],
  );
});

test('scripts send every step at least once, in order, on the page clock', async () => {
  const { puppet, api, clock } = puppetWith();
  const done = api.script([
    { label: 'aim', right: { grip: [0.15, -0.2, -0.35], aimAt: [0, 0, -4] } },
    { at: 0, left: { grip: [-0.2, -0.3, -0.35] } },
    { label: 'squeeze', at: 100, right: { squeeze: 1 } },
    { label: 'pull', after: 300, right: { trigger: 1 } },
    { label: 'release', after: 10, right: { trigger: 0 } },
  ]);
  const sent: (number | undefined)[] = [];
  const tick = (ms: number) => {
    clock.now += ms;
    const p = puppet.packet();
    sent.push(p?.hands[1]?.trigger);
    return p;
  };
  const first = tick(0)!;
  assert.ok(first.hands[0] && first.hands[1], 'steps at the same time apply together');
  assert.equal(api.state().script?.step, 2);
  tick(50);
  assert.equal(api.state().hands.right?.squeeze, 0, 'not before its time');
  tick(60);
  assert.equal(api.state().hands.right?.squeeze, 1);
  tick(300);
  assert.equal(api.state().hands.right?.trigger, 1);
  // The release is already due, but the pull is sent once first.
  assert.equal(sent.at(-1), 1);
  tick(33);
  assert.equal(api.state().hands.right?.trigger, 0);
  const result = await done;
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.applied.map((a) => [a.step, a.label]),
    [
      [0, 'aim'],
      [1, undefined],
      [2, 'squeeze'],
      [3, 'pull'],
      [4, 'release'],
    ],
  );
  assert.deepEqual(
    result.applied.map((a) => a.atMs),
    [0, 0, 110, 410, 443],
  );
  assert.equal(api.state().script, null);
  assert.ok(api.state().active, 'the last pose stays staged');
});

test('a step moves poses over time, buttons change at once, and checks can stop a script', async (t) => {
  const { puppet, api, clock } = puppetWith();
  api.set({ right: { grip: [0, -0.2, -0.3], aimAt: [0, -0.2, -2] } });
  const done = api.script([
    { over: 300, right: { grip: [0.3, -0.2, -0.3] } },
    { at: 150, right: { squeeze: 1 } },
  ]);
  puppet.packet();
  clock.now += 150;
  const mid = puppet.packet()!.hands[1]!;
  assert.ok(Math.abs(mid.grip[0] - 0.15) < 1e-6, 'half way at half time (smoothstep)');
  assert.equal(mid.squeeze, 1, 'a button in the middle of a move is not blended');
  assert.ok(near(forward(mid.aim), forward(api.state().hands.right!.aim), 1e-6), 'orientation unchanged when only the position moves');
  clock.now += 100;
  puppet.packet();
  assert.equal(api.state().script?.step, 2, 'running until the move ends');
  clock.now += 60;
  assert.ok(Math.abs(puppet.packet()!.hands[1]!.grip[0] - 0.3) < 1e-9);
  assert.equal((await done).ok, true);

  let allowed: boolean | string = 'gun not held';
  const stopped = api.script([{ right: { squeeze: 1 } }, { at: 100, check: () => allowed, right: { trigger: 1 } }]);
  puppet.packet();
  clock.now += 120;
  puppet.packet();
  const result = await stopped;
  assert.deepEqual([result.ok, result.reason, result.step], [false, 'gun not held', 1]);
  assert.equal(api.state().hands.right?.trigger, 0, 'a stopped step is not applied');

  allowed = true;
  const cancelled = api.script([{ at: 1000, right: { trigger: 1 } }]);
  api.set({ right: { grip: [0, 0, -0.3] } });
  assert.deepEqual([(await cancelled).ok, (await cancelled).reason], [false, 'cancelled']);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timedOut = api.script([{ at: 10, right: { trigger: 1 } }], { timeoutMs: 5 });
  t.mock.timers.tick(5);
  assert.deepEqual([(await timedOut).ok, (await timedOut).reason], [false, 'timeout'], 'no packets: the host stopped polling');

  assert.throws(() => api.script([]), /at least one step/);
  assert.throws(() => api.script([{ at: 50 }, { at: 10 }]), /earlier/);
  assert.throws(() => api.script([{ right: { trigger: 1 } }, { left: { trigger: 1 } }]), /needs grip/, 'steps are checked before anything moves');
  assert.equal(api.state().script, null);
});

test('moves between head and heading space blend in LOCAL_FLOOR from the latest head pose', () => {
  // Head turned 90° left and pitched down 30°: heading space ignores the pitch.
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const q = yaw.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 6));
  const head: Pose7 = [1, 1.5, 2, q.x, q.y, q.z, q.w];
  assert.ok(headingRotation(q).angleTo(yaw) < 1e-6);
  const env = { head: () => head, rig: () => null };
  const holster = resolveHand({ space: 'heading', grip: [0.15, -0.55, 0.3] }, null);
  const front = resolveHand({ space: 'head', grip: [0.15, -0.2, -0.35] }, null);
  const start = blendHands(holster, front, 0, env);
  assert.equal(start.space, 'local');
  assert.ok(near(v3(start.grip), new THREE.Vector3(1.3, 0.95, 1.85)), 'the holster sits behind the heading');
  assert.equal(blendHands(holster, front, 1, env), front, 'the end of a move is the target itself');
  assert.equal(blendHands(holster, front, 0.5, { head: () => null, rig: () => null }), front, 'no head yet: jump');
});

function controlsFixture(t: TestContext) {
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
  player.facing = Math.PI;
  const clock = { now: 1000 };
  t.mock.method(performance, 'now', () => clock.now);
  const climber = new Climber(player, { floorThere: () => null, travel() {}, sound() {}, done() {} });
  const shots: { origin: THREE.Vector3; direction: THREE.Vector3 }[] = [];
  let uses = 0;
  const hooks: NativeHooks = {
    player,
    settings: loadSettings(),
    useE: () => uses++,
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
      climber,
      gong: new THREE.Group(),
      strikeGong() {},
      ladderAvailable: () => false,
      poles: () => POLES,
      grabLadder() {},
      grabPole() {},
      canDraw: () => true,
      gunChanged() {},
      fireGun: (origin, direction) => shots.push({ origin: origin.clone(), direction: direction.clone() }),
    },
  };
  const controls = new NativeControls(scene, camera, hooks);
  controls.start();
  const puppet = new NativePuppet({ head: () => controls.headPose(), rig: () => controls.rig.matrixWorld }, () => clock.now);
  puppet.host(true);
  let real: [NativeHand | null, NativeHand | null] = [null, null];
  const idle = (): NativeHand => ({ active: false, aim: [0, 0, 0, 0, 0, 0, 1], grip: [0, 0, 0, 0, 0, 0, 1], trigger: 0, squeeze: 0, stick: [0, 0], a: false, b: false, menu: false, ui: false });
  /** One host poll: three 90 Hz samples merged with the latest puppet, as native does. */
  const poll = () => {
    controls.state();
    const packet = puppet.packet();
    const frames = [0, 1, 2].map(() => {
      clock.now += 11;
      return nativeMerge({ time: clock.now, head: HEAD, headTracked: true, hands: [real[0] ?? idle(), real[1] ?? idle()] }, packet);
    });
    // Native's sample JSON goes through the page's validation.
    const read = frames.map((f) => readFrame(JSON.parse(JSON.stringify(f))));
    puppet.observe(read);
    controls.consume(read);
    controls.update(1 / 30);
  };
  const run = async (until: () => boolean, max = 200) => {
    for (let i = 0; i < max && !until(); i++) poll();
  };
  return { controls, puppet, poll, run, shots, uses: () => uses, scene, setReal: (h: 0 | 1, hand: NativeHand | null) => (real[h] = hand), reset: () => (real = [null, null]) };
}

test('through the real input path: a puppet draws the gun from the back holster and fires at the view centre', async (t) => {
  const r = controlsFixture(t);
  r.poll();
  const api = r.puppet.api;
  const target = [0, 0, -4];
  const done = api.script([
    { label: 'holster', right: { space: 'heading', grip: [0.15, -0.55, 0.3], aimAt: [0.15, -1.5, 0.35] } },
    { label: 'draw', at: 250, right: { squeeze: 1 } },
    { label: 'present', at: 450, over: 400, right: { space: 'head', grip: [0.15, -0.2, -0.35], aimAt: target } },
    { label: 'fire', at: 1100, check: () => r.controls.holdingGun || 'no gun', right: { trigger: 1 } },
    { label: 'release', at: 1250, right: { trigger: 0 } },
  ]);
  let finished = false;
  void done.then(() => (finished = true));
  await r.run(() => finished);
  const result = await done;
  assert.equal(result.ok, true, result.reason);
  assert.equal(r.controls.holdingGun, true, 'squeeze in the holster drew the gun');
  assert.deepEqual(api.state().driven, { left: false, right: true });
  assert.equal(r.shots.length, 1, 'the trigger fired once through NativePhysical');
  assert.equal(r.uses(), 0, 'and dispatched nothing else');
  // The shot leaves the muzzle along the ray towards the view centre (4 m ahead of the eyes).
  const shot = r.shots[0];
  const aimPoint = new THREE.Vector3(...(target as [number, number, number])).add(v3(HEAD)).applyMatrix4(r.controls.rig.matrixWorld);
  const along = aimPoint.clone().sub(shot.origin).dot(shot.direction);
  const miss = shot.origin.clone().addScaledVector(shot.direction, along).distanceTo(aimPoint);
  assert.ok(along > 3 && miss < 0.1, `bore passes ${miss.toFixed(3)} m from the view centre`);
  const gun = r.scene.getObjectByName('native-held-magnum');
  assert.deepEqual(gun?.userData.nativeControllerAttachment, { hand: 1, requiresGrip: true }, 'native renders it at the puppet grip');

  // A real tracked controller always wins: its pose and its released grip take over at once.
  r.setReal(1, { active: true, gripTracked: true, aim: [0.3, 1.2, -0.3, 0, 0, 0, 1], grip: [0.3, 1.2, -0.3, 0, 0, 0, 1], trigger: 0, squeeze: 0, stick: [0, 0], a: false, b: false, menu: false, ui: false });
  r.poll();
  assert.deepEqual(api.state().driven, { left: false, right: false });
  assert.equal(r.controls.holdingGun, false, 'the person holding the controller is not squeezing');

  // Clearing hands the slot back to the runtime: an idle controller reads as lost, then gone.
  r.reset();
  api.set({ right: { grip: [0.15, -0.2, -0.35], squeeze: 1 } });
  r.poll();
  assert.equal(r.controls.state().hands[1].connected, true);
  api.clear();
  r.poll();
  assert.equal(r.controls.state().hands[1].connected, true, 'a blip shorter than LOST_MS keeps the controller');
  for (let i = 0; i < 14; i++) r.poll();
  assert.equal(r.controls.state().hands[1].connected, false, 'tracking loss ends the synthetic controller');
});

test('native input samples keep the puppet mark; real samples are unchanged', () => {
  const hand = { active: true, aim: [0, 1, 0, 0, 0, 0, 1], grip: [0, 1, 0, 0, 0, 0, 1], gripTracked: true, trigger: 0, squeeze: 0, stick: [0, 0], a: false, b: false, menu: false, ui: false };
  const frame = readFrame({ time: 1, head: HEAD, hands: [hand, { ...hand, puppet: true }] })!;
  assert.equal(frame.hands[0].puppet, undefined);
  assert.equal(frame.hands[1].puppet, true);
});

test('only debug builds can accept the puppet (release builds ignore it entirely)', () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const gradle = read('native/android/app/build.gradle');
  const debug = gradle.match(/\n {8}debug \{\n([\s\S]*?)\n {8}\}/);
  assert.ok(debug, 'build.gradle has a debug build type block');
  assert.match(debug[1], /arguments '-DOFFICE_CAPTURE_PUPPET=ON'/);
  assert.equal(gradle.split('OFFICE_CAPTURE_PUPPET').length - 1, 1, 'nothing else (release, defaultConfig) turns it on');
  const cmake = read('native/android/app/src/main/cpp/CMakeLists.txt');
  assert.match(cmake, /option\(OFFICE_CAPTURE_PUPPET "[^"]*" OFF\)/, 'off unless the debug build type asks');
  assert.match(cmake, /if\(OFFICE_CAPTURE_PUPPET\)\n\s+target_compile_definitions\(office_xr PRIVATE OFFICE_CAPTURE_PUPPET=1\)/);
  const activity = read('native/android/app/src/main/java/dev/droidoffice/xr/OfficeActivity.java');
  assert.match(activity, /nativeCapturePuppet\(BuildConfig\.DEBUG\);/, 'the Java host passes its own debug flag');
  const office = read('native/android/app/src/main/cpp/office_xr.cpp');
  assert.match(office, /const bool enabled = office::capturePuppetEnabled\(hostDebug\);/);
  assert.match(office, /if constexpr \(office::kCapturePuppetBuild\) \{[\s\S]*?office::applyPuppet\(/, 'release builds compile no puppet into the display loop');
  const header = read('native/android/app/src/main/cpp/capture_puppet.h');
  assert.match(header, /constexpr bool capturePuppetEnabled\(bool hostDebug\) \{ return kCapturePuppetBuild && hostDebug; \}/);
  const host = read('native/tests/run-host.sh');
  assert.match(host, /"capture_puppet_debug\|tests\/capture_puppet_test\.cpp\|[^|"]*bridge_state\.cpp\|-DOFFICE_CAPTURE_PUPPET=1"/);
  assert.match(host, /"capture_puppet_release\|tests\/capture_puppet_test\.cpp\|[^|"]*bridge_state\.cpp\|"/, 'the host test also runs as the release build');
});
