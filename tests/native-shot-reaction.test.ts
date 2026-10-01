import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { groundAt } from '../src/client/player.js';
import { Casualties, FALL_TIME, type Medic, RISE_TIME, reelTilt, SETTLE_TIME } from '../src/client/world/casualties.js';
import { Worker } from '../src/client/world/character.js';
import { buildOffice, type Office } from '../src/client/world/office.js';

// The headset's own shot, seen from where the shooter stands: a real worker at a real desk, shot
// from a normal standing stance 1-1.5 m away on each open side, reels back out of its chair away
// from the shot and goes over onto the open floor beside it, where the shooter can see it, so the
// whole reaction plays out where they are looking (world/casualties.ts Reel).

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

/** One real office for the file (it is the expensive part); each take seats its own worker. */
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

const medic = (): Medic => ({ root: new THREE.Group(), update() {}, dispose() {} });

/** The eyes of someone standing in the office (the native rig's player height). */
const EYE = 1.57;

/** Every third vertex of the worker's visible meshes, in the world. */
function points(root: THREE.Object3D): THREE.Vector3[] {
  root.updateWorldMatrix(true, true);
  const out: THREE.Vector3[] = [];
  root.traverseVisible((o) => {
    const mesh = o as THREE.Mesh;
    const at = mesh.isMesh ? mesh.geometry.attributes.position : undefined;
    if (at) for (let i = 0; i < at.count; i += 3) out.push(new THREE.Vector3().fromBufferAttribute(at, i).applyMatrix4(mesh.matrixWorld));
  });
  return out;
}

/** Degrees from the middle of a view from `eye` along `look` to `p`, and above its horizon. */
function off(eye: THREE.Vector3, look: THREE.Vector3, p: THREE.Vector3): { from: number; up: number } {
  const d = p.clone().sub(eye);
  const forward = look.clone().normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward);
  return { from: THREE.MathUtils.radToDeg(d.angleTo(forward)), up: THREE.MathUtils.radToDeg(Math.atan2(d.dot(up), d.dot(forward))) };
}

interface Take {
  /** The furthest any part of it got from the middle of a view looking at it as it sat, over the whole reaction, and as it sat. */
  farthest: number;
  seated: number;
  /** Its lowest point below the horizon of a level view (the critics' unworn headset), over the whole reaction, and as it sat. */
  lowest: number;
  seatedLowest: number;
  /** How much of it, lying still, is in plain sight past the desks, chairs and workers round it. */
  seen: number;
  /** Horizontal metres from the shooter to its chest, as it sat and lying still; and from its seat. */
  before: number;
  after: number;
  fromSeat: number;
  /** Seconds after the shot: out of its chair and down on its feet, landing with a thud, lying still. */
  out: number;
  thud: number;
  still: number;
  /** Its lowest point lying still, over the floor under it; and how level its length lies. */
  rests: number;
  tilt: number;
}

/**
 * Shoots the worker at desk `deskId` from a stance `angle` degrees round from its face toward its
 * left, `metres` from its chest, with the muzzle where a right hand holds a gun at the chest, as
 * main.ts does (the bullet's direction and the shooter's eyes); `told` leaves the eyes out.
 */
function take(t: TestContext, deskId: string, angle: number, metres: number, told = false): Take {
  const { office: o, scene } = office(t);
  const desk = o.desks.get(deskId)!;
  const worker = new Worker('Target', '#86b2d4');
  desk.seatAnchor.add(worker.root);
  worker.update(1 / 60, 1);
  scene.updateMatrixWorld(true);
  const lands: number[] = [];
  let clock = 0;
  const ground = (x: number, z: number, y: number) => groundAt(o.colliders, x, z, y);
  const casualties = new Casualties(scene, ground, { spawnMedic: medic, onLand: () => void lands.push(clock), onSiren() {} });
  const chest = worker.root.localToWorld(new THREE.Vector3(0, 0.62, 0));
  const seat = desk.seatAnchor.getWorldPosition(new THREE.Vector3());
  const facing = new THREE.Vector3(0, 0, 1).transformDirection(worker.root.matrixWorld).setY(0).normalize();
  const toward = facing.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(angle));
  const eye = chest.clone().addScaledVector(toward, metres).setY(EYE);
  const heading = chest.clone().sub(eye).setY(0).normalize();
  const right = new THREE.Vector3().crossVectors(heading, new THREE.Vector3(0, 1, 0)).normalize();
  const muzzle = eye
    .clone()
    .addScaledVector(heading, 0.35)
    .addScaledVector(right, 0.15)
    .add(new THREE.Vector3(0, -0.2, 0));
  const looking = chest.clone().sub(eye);
  const sat = points(worker.root);
  const seated = Math.max(...sat.map((p) => off(eye, looking, p).from));
  const seatedLowest = Math.min(...sat.map((p) => off(eye, heading, p).up));
  assert.equal(casualties.shoot('w', worker, desk.seatAnchor, chest.clone().sub(muzzle).normalize(), told ? undefined : eye), true);
  let farthest = 0;
  let lowest = 0;
  let out = Infinity;
  let still = Infinity;
  let last = new THREE.Matrix4();
  for (let k = 0; k < 60; k++) {
    clock = (k + 1) / 30;
    casualties.update(1 / 30, clock);
    for (const p of points(worker.root)) {
      farthest = Math.max(farthest, off(eye, looking, p).from);
      lowest = Math.min(lowest, off(eye, heading, p).up);
    }
    const at = worker.root.position;
    if (out === Infinity && Math.hypot(at.x - seat.x, at.z - seat.z) > 0.6 && at.y < seat.y - 0.2) out = clock;
    const pose = worker.root.matrixWorld.clone();
    if (!pose.equals(last)) still = Infinity;
    else if (still === Infinity) still = clock - 1 / 30;
    last = pose;
  }
  const around: THREE.Mesh[] = [];
  for (const d of o.desks.values())
    if (d.group.position.distanceTo(desk.group.position) < 3.5)
      d.group.traverseVisible((m) => {
        if ((m as THREE.Mesh).isMesh) around.push(m as THREE.Mesh);
      });
  const ray = new THREE.Raycaster();
  const body = points(worker.root);
  const visible = body.filter((p) => {
    const d = p.clone().sub(eye);
    ray.set(eye, d.clone().normalize());
    ray.far = d.length() - 0.01;
    return ray.intersectObjects(around, false).length === 0;
  });
  const lying = casualties.chest('w')!;
  const under = ground(lying.x, lying.z, 0.05);
  const result: Take = {
    farthest,
    seated,
    lowest,
    seatedLowest,
    seen: visible.length / body.length,
    before: Math.hypot(chest.x - eye.x, chest.z - eye.z),
    after: Math.hypot(lying.x - eye.x, lying.z - eye.z),
    fromSeat: Math.hypot(lying.x - seat.x, lying.z - seat.z),
    out,
    thud: lands[0] ?? Infinity,
    still,
    rests: Math.min(...body.map((p) => p.y)) - under,
    tilt: Math.abs(new THREE.Vector3(0, 1, 0).applyQuaternion(worker.root.quaternion).y),
  };
  casualties.clear();
  worker.root.removeFromParent();
  worker.dispose();
  return result;
}

/** Round the worker from its face toward its left: both sides, and the diagonals behind it past its chair's back. */
const SIDES = [90, -90];
const BEHIND = [135, -135];

test('shot from a standing stance 1-1.5 m away, the whole reaction plays out where the shooter is looking', (t) => {
  for (const deskId of ['desk-16', 'desk-6', 'desk-1'])
    for (const angle of [...SIDES, ...BEHIND])
      for (const metres of [1, 1.25, 1.5]) {
        const r = take(t, deskId, angle, metres);
        const at = `${deskId} from ${angle}° at ${metres} m: ${JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 100) / 100])))}`;
        // Out of its chair and down on its feet away from the shot in a third of a second, over
        // backwards and down with a thud at FALL_TIME, still a bounce later.
        assert.ok(r.out <= 0.3, `${at}: out of its chair`);
        assert.ok(Math.abs(r.thud - FALL_TIME) < 0.05, `${at}: lands`);
        assert.ok(r.still <= FALL_TIME + SETTLE_TIME + 0.05, `${at}: lies still`);
        // Away from the shooter, near its chair, flat on its back and resting on the floor.
        assert.ok(r.after > r.before + 0.8, `${at}: knocked away from the shot`);
        assert.ok(r.fromSeat < 1.5, `${at}: near its chair`);
        assert.ok(r.rests > -0.01 && r.rests < 0.03, `${at}: resting on the floor`);
        assert.ok(r.tilt < 1e-6, `${at}: lying flat`);
        // In plain sight, past the chair it fell out of and the desks round it.
        assert.ok(r.seen >= 0.8, `${at}: in plain sight`);
        // Shot from beside it, no part of it ever strays further from the middle of the view than
        // it sat; from behind it goes out sideways round its desk, still well inside the view.
        if (SIDES.includes(angle)) assert.ok(r.farthest <= r.seated + 1, `${at}: within the target's own place in view`);
        else assert.ok(r.farthest <= 40, `${at}: well inside the view`);
        // A level view (the unworn headset's): from beside it, it never drops lower in view than it
        // sat; from behind, its feet come down beside the chair a few degrees lower at most.
        assert.ok(r.lowest >= r.seatedLowest - (SIDES.includes(angle) ? 0 : 4), `${at}: no lower in a level view than it sat`);
      }
});

test('a shot the headset only knows the bullet of still lands it in plain sight beyond its chair', (t) => {
  for (const angle of [...SIDES, ...BEHIND]) {
    const r = take(t, 'desk-16', angle, 1.25, true);
    const at = `from ${angle}°: ${JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 100) / 100])))}`;
    assert.ok(r.seen >= 0.8, `${at}: in plain sight`);
    assert.ok(r.after > r.before + 0.8, `${at}: away from the shot`);
  }
});

test('the hit throws its arms up, they are flung out where it lies, and back at its sides as it gets up', (t) => {
  const { office: o, scene } = office(t);
  const desk = o.desks.get('desk-16')!;
  const worker = new Worker('Target', '#86b2d4');
  desk.seatAnchor.add(worker.root);
  worker.update(1 / 60, 1);
  scene.updateMatrixWorld(true);
  const casualties = new Casualties(scene, (x, z, y) => groundAt(o.colliders, x, z, y), { spawnMedic: medic, onLand() {}, onSiren() {}, riseTime: RISE_TIME });
  const arm = (worker as unknown as { armR: THREE.Object3D }).armR;
  casualties.shoot('w', worker, desk.seatAnchor, new THREE.Vector3(1, -0.2, 0), new THREE.Vector3(-1.6, EYE, 5.48));
  const run = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds * 30); i++) casualties.update(1 / 30, 0);
  };
  run(0.2);
  assert.ok(arm.rotation.x < -1, `thrown up and forward by the hit (${arm.rotation.x.toFixed(2)})`);
  run(1.5);
  assert.ok(arm.rotation.x > 0.8 && arm.rotation.z > 0.6, 'flung out to its side, down on the floor');
  casualties.revive('w');
  run(RISE_TIME / 2);
  assert.ok(arm.rotation.z < 0.6, 'coming back in as it gets up');
  run(RISE_TIME);
  assert.equal(worker.root.parent, desk.seatAnchor, 'back in its chair');
  worker.update(1 / 60, 1);
  assert.ok(Math.abs(arm.rotation.z) < 0.3, 'its arms its own again');
  worker.root.removeFromParent();
  worker.dispose();
});

test('the medics take a body that reeled over from where it lies, its arms in at its sides on the stretcher', (t) => {
  const { office: o, scene } = office(t);
  const desk = o.desks.get('desk-6')!;
  const worker = new Worker('Target', '#86b2d4');
  desk.seatAnchor.add(worker.root);
  worker.update(1 / 60, 1);
  scene.updateMatrixWorld(true);
  const casualties = new Casualties(scene, (x, z, y) => groundAt(o.colliders, x, z, y), { spawnMedic: medic, onLand() {}, onSiren() {} });
  const arm = (worker as unknown as { armL: THREE.Object3D }).armL;
  const seat = desk.seatAnchor.getWorldPosition(new THREE.Vector3());
  casualties.shoot('w', worker, desk.seatAnchor, new THREE.Vector3(-1, -0.25, 0.1), seat.clone().add(new THREE.Vector3(1.3, 1.2, 0)));
  const run = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds * 30); i++) casualties.update(1 / 30, 0);
  };
  run(1.5);
  const lying = worker.root.position.clone();
  assert.ok(Math.abs(arm.rotation.z) > 0.6, 'flung out where it lies');
  const laptop = { root: new THREE.Group(), shut: () => true, dispose() {} };
  assert.equal(casualties.confirm('w', laptop), true);
  assert.ok(worker.root.position.distanceTo(lying) < 1e-6, 'collected from where it lies');
  for (let i = 0; i < 3000 && casualties.phaseOf('w') !== 'carry'; i++) run(1 / 30);
  assert.equal(casualties.phaseOf('w'), 'carry');
  assert.ok(Math.abs(arm.rotation.z) < 1e-6 && Math.abs(arm.rotation.x) < 1e-6, 'its arms at its sides on the stretcher');
  casualties.clear();
});

test('the reel snaps back at once, leans on as it staggers, goes over faster and faster and bounces once', () => {
  assert.equal(reelTilt(0), 0);
  assert.ok(reelTilt(1 / 30) > 0.25, 'most of the hit shows in the first headset frame');
  let last = 0;
  for (let t = 1 / 90; t <= FALL_TIME; t += 1 / 90) {
    assert.ok(reelTilt(t) >= last - 1e-9, 'it only goes further over until it lands');
    last = reelTilt(t);
  }
  assert.ok(reelTilt(FALL_TIME - 0.05) - reelTilt(FALL_TIME - 0.1) > reelTilt(0.35) - reelTilt(0.3), 'faster and faster as it goes over');
  assert.ok(Math.abs(reelTilt(FALL_TIME) - Math.PI / 2) < 1e-9, 'flat on its back as it lands');
  assert.ok(reelTilt(FALL_TIME + SETTLE_TIME / 3) < Math.PI / 2 - 0.05, 'its head bounces up off the floor');
  assert.ok(Math.abs(reelTilt(FALL_TIME + SETTLE_TIME) - Math.PI / 2) < 1e-9, 'and lies still after it');
  assert.ok(FALL_TIME + SETTLE_TIME <= 1.1, 'all within about a second');
});
