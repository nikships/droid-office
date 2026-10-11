import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ShadowWatch } from '../src/client/world/shadow-watch.js';

const caster = (x = 0, z = 0) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  m.castShadow = true;
  m.position.set(x, 0.5, z);
  return m;
};

/** A camera at the origin looking down −z: what it sees is the view frustum. */
function view() {
  const cam = new THREE.PerspectiveCamera(55, 1, 0.1, 50);
  cam.updateMatrixWorld(true);
  return new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
}

function office() {
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight();
  const desk = caster(0, -5);
  const worker = new THREE.Group();
  const arm = caster(1, -5);
  worker.add(arm);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
  glass.position.z = -4;
  // Behind the camera, nowhere near the view.
  const behind = caster(0, 20);
  scene.add(sun, desk, worker, glass, behind);
  const w = new ShadowWatch(30);
  let now = 0;
  const frustum = view();
  /** One frame, 100 ms after the last so the rate cap never holds a redraw back. */
  const frame = (dt = 100) => {
    now += dt;
    scene.updateMatrixWorld(true);
    return w.update(scene, [sun, sun.target], frustum, now);
  };
  return { scene, sun, desk, worker, arm, glass, behind, w, frame };
}

test('the shadow map is redrawn first, then only when something in view that casts a shadow changes', () => {
  const o = office();
  assert.equal(o.frame(), true, 'the first frame always draws it');
  assert.equal(o.frame(), false, 'nothing moved');

  o.arm.rotation.x = 0.3;
  assert.equal(o.frame(), true, 'a caster moved');
  assert.equal(o.frame(), false);

  o.worker.position.x = 0.5;
  assert.equal(o.frame(), true, 'a parent carried a caster along');

  o.glass.position.x = 2;
  assert.equal(o.frame(), false, 'something that casts no shadow moved');

  o.worker.visible = false;
  assert.equal(o.frame(), true, 'a caster vanished');
  o.worker.visible = true;
  assert.equal(o.frame(), true, 'and came back');

  o.desk.geometry.attributes.position.needsUpdate = true;
  assert.equal(o.frame(), true, 'a caster changed shape');

  o.sun.position.x = 5;
  assert.equal(o.frame(), true, 'the light moved');

  o.scene.add(caster(-1, -6));
  assert.equal(o.frame(), true, 'a caster appeared in view');
  assert.equal(o.frame(), false);

  o.w.reset();
  assert.equal(o.frame(), true, 'a reset redraws it');
});

test('a change out of view waits until it comes into view', () => {
  const o = office();
  o.frame();
  o.behind.rotation.y = 1;
  assert.equal(o.frame(), false, 'its shadow is nowhere you can see');
  assert.equal(o.frame(), false, 'and it stays noted, not redrawn');
  o.behind.position.z = -8;
  assert.equal(o.frame(), true, 'it walked into view');
  assert.equal(o.frame(), false);

  o.behind.position.z = 20;
  assert.equal(o.frame(), true, 'it left the view: its old shadow was in view');
  o.behind.rotation.y = 2;
  assert.equal(o.frame(), false);
  o.arm.rotation.x = 1;
  assert.equal(o.frame(), true, 'something in view moved');
  // That redraw put the caster behind into the map too, so seeing it later needs nothing.
  o.behind.position.z = 19.9;
  o.behind.position.z = 20;
  assert.equal(o.frame(), false);
});

test('looking at where an unseen caster used to be redraws its old shadow away', () => {
  const o = office();
  const cam = new THREE.PerspectiveCamera(55, 1, 0.1, 50);
  const frustumFrom = (yaw: number) => {
    cam.rotation.y = yaw;
    cam.updateMatrixWorld(true);
    return new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  };
  const w = new ShadowWatch(30);
  let now = 0;
  const frame = (f: THREE.Frustum) => {
    o.scene.updateMatrixWorld(true);
    return w.update(o.scene, [o.sun, o.sun.target], f, (now += 100));
  };
  const ahead = frustumFrom(0);
  frame(ahead);
  // Behind you, it walks off to the side, still out of view.
  o.behind.position.x = 15;
  assert.equal(frame(ahead), false);
  // Turn round: it isn't there any more, but the map still has its shadow there.
  assert.equal(frame(frustumFrom(Math.PI)), true);
});

test('a caster just out of view still counts when its shadow can reach the view', () => {
  const o = office();
  o.frame();
  // Off to the side of a 55° view at 5 m, but within the shadow's reach of its edge.
  const beside = caster(4.5, -5);
  o.scene.add(beside);
  assert.equal(o.frame(), true);
  beside.rotation.y = 0.5;
  assert.equal(o.frame(), true);
});

test('while something in view keeps moving, the map is redrawn at most hz times a second', () => {
  const o = office();
  let redraws = 0;
  for (let i = 0; i < 120; i++) {
    o.arm.rotation.x = i * 0.01;
    if (o.frame(1000 / 120)) redraws++;
  }
  assert.ok(redraws >= 29 && redraws <= 31, `${redraws} redraws in a second at 120 fps`);
});

test('instanced casters count their instances moving', () => {
  const scene = new THREE.Scene();
  const cars = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 4);
  cars.castShadow = true;
  scene.add(cars);
  scene.updateMatrixWorld(true);
  const w = new ShadowWatch(30);
  let now = 0;
  const frame = () => w.update(scene, [], view(), (now += 100));
  assert.equal(frame(), true);
  assert.equal(frame(), false);
  cars.setMatrixAt(1, new THREE.Matrix4().makeTranslation(1, 0, 0));
  cars.instanceMatrix.needsUpdate = true;
  assert.equal(frame(), true);
  cars.count = 3;
  assert.equal(frame(), true);
  assert.equal(frame(), false);
});
