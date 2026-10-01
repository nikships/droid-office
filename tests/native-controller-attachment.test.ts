import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { NativeScene } from '../src/client/native/scene';
import { base64ToBytes, type ObjectItem, type Packet } from '../src/client/native/wire';

function make() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 320);
  const native = new NativeScene(scene, camera, { encodeImage: async () => ({ fmt: 'png', bytes: new Uint8Array([1]) }), now: () => 0 });
  return { scene, native };
}

function drainAll(native: NativeScene): Packet[] {
  const out: Packet[] = [];
  for (let i = 0; i < 100; i++) {
    const p = native.drain();
    if (!p) return out;
    out.push(p);
  }
  throw new Error('drain never finished');
}

/** The rig and one grip, as controls.ts builds them: scene > rig > grip. */
function rigWithGrip(scene: THREE.Scene) {
  const rig = new THREE.Group();
  rig.position.set(4, 0, -2);
  rig.rotation.y = 0.7;
  const grip = new THREE.Group();
  grip.position.set(0.2, 1.1, -0.3);
  grip.quaternion.setFromEuler(new THREE.Euler(-0.4, 0.3, 0.2));
  rig.add(grip);
  scene.add(rig);
  return { rig, grip };
}

/** A gun modeled facing +Z, turned to face along grip -Z, with a barrel child at its muzzle. */
function gun(hand: 0 | 1) {
  const root = new THREE.Group();
  root.rotation.y = Math.PI;
  root.position.set(0, -0.02, 0.03);
  root.userData.nativeControllerAttachment = { hand };
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.08, 0.18), new THREE.MeshLambertMaterial());
  body.name = 'gun-body';
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.1), new THREE.MeshLambertMaterial());
  barrel.name = 'gun-barrel';
  barrel.position.set(0, 0.02, 0.12);
  barrel.rotation.x = Math.PI / 2;
  body.add(barrel);
  root.add(body);
  return { root, body, barrel };
}

const objects = (packets: Packet[]) => packets.flatMap((p) => p.objects ?? []);
const byName = (packets: Packet[], name: string) => objects(packets).filter((o) => o.name === name);

function affineOf(m: THREE.Matrix4): number[] {
  const e = m.elements;
  return [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10], e[12], e[13], e[14]].map((x) => Math.fround(x));
}

function assertAffine(actual: number[], expected: number[], what: string) {
  assert.equal(actual.length, 12, what);
  for (let i = 0; i < 12; i++) assert.ok(Math.abs(actual[i] - expected[i]) < 1e-5, `${what}[${i}]: ${actual[i]} vs ${expected[i]}`);
}

/** grip.matrixWorld^-1 * o.matrixWorld: what the headset composes with its live grip. */
function relative(grip: THREE.Object3D, o: THREE.Object3D) {
  return new THREE.Matrix4().copy(grip.matrixWorld).invert().multiply(o.matrixWorld);
}

test('a tagged gun and its descendants go out relative to their grip, with the hand', () => {
  for (const hand of [0, 1] as const) {
    const { scene, native } = make();
    const { grip } = rigWithGrip(scene);
    const g = gun(hand);
    grip.add(g.root);
    const world = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial());
    world.name = 'desk';
    world.position.set(1, 0, 1);
    scene.add(world);
    native.capture();
    const packets = drainAll(native);
    const [body] = byName(packets, 'gun-body');
    const [barrel] = byName(packets, 'gun-barrel');
    const [desk] = byName(packets, 'desk');
    assert.equal(body.hand, hand);
    assert.equal(barrel.hand, hand);
    assert.equal(desk.hand, undefined, 'world objects carry no hand');
    assertAffine(desk.m, affineOf(world.matrixWorld), 'world object matrix stays world');
    assertAffine(body.m, affineOf(relative(grip, g.body)), 'body relative to grip');
    assertAffine(barrel.m, affineOf(relative(grip, g.barrel)), 'barrel relative to grip');
    // The +Z model turned by PI around Y: its forward axis is grip -Z.
    assertAffine(body.m, affineOf(new THREE.Matrix4().compose(new THREE.Vector3(0, -0.02, 0.03), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI), new THREE.Vector3(1, 1, 1))), 'the PI Y convention');
    // The page's own world matrix (collision, picking) is unchanged by the export.
    const expected = new THREE.Matrix4().multiplyMatrices(grip.matrixWorld, relative(grip, g.body));
    for (let i = 0; i < 16; i++) assert.ok(Math.abs(g.body.matrixWorld.elements[i] - expected.elements[i]) < 1e-6);
  }
});

test('moving the grip or rig sends no transform for a held gun; moving it on the grip does', () => {
  const { scene, native } = make();
  const { rig, grip } = rigWithGrip(scene);
  const g = gun(1);
  grip.add(g.root);
  native.capture();
  const bodyId = byName(drainAll(native), 'gun-body')[0].id;
  grip.position.x += 0.3;
  grip.rotation.z += 0.5;
  rig.position.z -= 2;
  rig.rotation.y += Math.PI / 4;
  native.capture();
  const moved = drainAll(native);
  assert.ok(
    moved.every((p) => !p.xf && !p.objects),
    'grip motion is composed natively, from the live grip',
  );
  g.root.position.z += 0.05;
  native.capture();
  const shifted = drainAll(native);
  const xf = shifted.find((p) => p.xf)?.xf;
  assert.ok(xf, 'moving the gun on its grip sends a transform');
  assert.equal(xf.ids.length, 2);
  const m = new Float32Array(base64ToBytes((xf.m as { d: string }).d).buffer.slice(0));
  const bodyIndex = xf.ids.indexOf(bodyId);
  assert.ok(bodyIndex >= 0);
  assertAffine(Array.from(m.subarray(bodyIndex * 12, bodyIndex * 12 + 12)), affineOf(relative(grip, g.body)), 'relative transform');
});

/** A reset snapshot of the current state. */
function drainAllReset(native: NativeScene): Packet[] {
  native.reset();
  return drainAll(native);
}

test('dropping the gun re-sends it whole as a world object in the same commit', () => {
  for (const drop of ['untag', 'reparent'] as const) {
    const { scene, native } = make();
    const { grip } = rigWithGrip(scene);
    const g = gun(0);
    grip.add(g.root);
    native.capture();
    drainAll(native);
    if (drop === 'untag') delete g.root.userData.nativeControllerAttachment;
    else scene.attach(g.root);
    native.capture();
    const packets = drainAll(native);
    const sent = objects(packets);
    const body = sent.find((o) => o.name === 'gun-body') as ObjectItem;
    const barrel = sent.find((o) => o.name === 'gun-barrel') as ObjectItem;
    assert.ok(body && barrel, `${drop}: both parts are re-sent as objects`);
    assert.equal(body.hand, undefined);
    assert.equal(barrel.hand, undefined);
    assertAffine(body.m, affineOf(g.body.matrixWorld), `${drop}: dropped body is in world space`);
    assertAffine(barrel.m, affineOf(g.barrel.matrixWorld), `${drop}: dropped barrel is in world space`);
    assert.ok(
      packets.every((p) => !p.xf?.ids.includes(body.id)),
      'no transform can reinterpret the dropped matrix',
    );
    assert.equal(packets.at(-1)?.commit, true);
    // Picking it up again switches back atomically.
    grip.attach(g.root);
    g.root.userData.nativeControllerAttachment = { hand: 1 };
    native.capture();
    const again = objects(drainAll(native)).find((o) => o.name === 'gun-body') as ObjectItem;
    assert.equal(again.hand, 1);
    assertAffine(again.m, affineOf(relative(grip, g.body)), `${drop}: picked up again relative`);
  }
});

test('an invalid tag leaves the subtree a world object and is reported', () => {
  for (const tag of [{ hand: 2 }, { hand: '0' }, { hand: -1 }, {}, 1, { hand: 0.5 }]) {
    const { scene, native } = make();
    const { grip } = rigWithGrip(scene);
    const g = gun(0);
    g.root.userData.nativeControllerAttachment = tag;
    grip.add(g.root);
    native.capture();
    const packets = drainAll(native);
    const [body] = byName(packets, 'gun-body');
    assert.equal(body.hand, undefined, JSON.stringify(tag));
    assertAffine(body.m, affineOf(g.body.matrixWorld), 'invalid tag keeps world matrix');
    assert.ok(native.report().unsupported.some((u) => u.reason.includes('nativeControllerAttachment')));
  }
  const { scene, native } = make();
  const g = gun(1);
  scene.add(g.root);
  native.capture();
  const [body] = byName(drainAll(native), 'gun-body');
  assert.equal(body.hand, undefined, 'a tag directly under the scene has no grip');
  assertAffine(body.m, affineOf(g.body.matrixWorld), 'untethered tag keeps world matrix');
});

test('a reset snapshot re-sends attachments with their hand and relative matrix', () => {
  const { scene, native } = make();
  const { grip } = rigWithGrip(scene);
  const g = gun(1);
  grip.add(g.root);
  native.capture();
  drainAll(native);
  const packets = drainAllReset(native);
  assert.equal(packets[0].reset, true);
  const [body] = byName(packets, 'gun-body');
  assert.equal(body.hand, 1);
  assertAffine(body.m, affineOf(relative(grip, g.body)), 'reset keeps the relative matrix');
});

test('attachment capture allocates no attachment records after the first capture', () => {
  const { scene, native } = make();
  const { grip } = rigWithGrip(scene);
  grip.add(gun(0).root);
  native.capture();
  const records = (native as unknown as { attachments: unknown[] }).attachments;
  const first = records[0];
  for (let i = 0; i < 5; i++) {
    grip.rotation.x += 0.1;
    native.capture();
  }
  assert.equal(records.length, 1);
  assert.equal(records[0], first);
});
