import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as THREE from 'three';
import { lampHalosShown } from '../src/client/native/mode.js';
import type { NightParts } from '../src/client/world/outside.js';
import { Sky } from '../src/client/world/sky.js';
import { STREET_Y } from '../src/shared/layout.js';

function page(t: TestContext, search: string) {
  const context = { fillRect() {}, beginPath() {}, ellipse() {}, fill() {}, createRadialGradient: () => ({ addColorStop() {} }) };
  for (const [key, value] of [
    ['location', { search }],
    ['document', { createElement: () => ({ width: 0, height: 0, getContext: () => context }) }],
  ] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => (previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key)));
  }
}

function fixture() {
  const scene = new THREE.Scene();
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.16), new THREE.MeshToonMaterial({ emissive: '#ffe08a', emissiveIntensity: 0.1 }));
  bulb.position.set(0, 4, 0);
  scene.add(bulb);
  const night: NightParts = {
    bulbs: [{ mat: bulb.material, day: 0.1 }],
    halos: [
      { at: bulb.position.clone(), size: 1.3, color: '#ffe08a' },
      { at: new THREE.Vector3(2, 3, 4), size: 0.9, color: '#ffe08a', ground: true },
    ],
    lamps: [{ x: 0, y: 4, z: 0, reach: 5, color: '#ffe08a', power: 2.4 }],
    street: STREET_Y,
    windows: [],
    clouds: new THREE.MeshToonMaterial(),
    wetGlass: new THREE.MeshBasicMaterial(),
  };
  const lights = { sun: new THREE.DirectionalLight(), hemi: new THREE.HemisphereLight(), ambient: new THREE.AmbientLight() };
  const sky = new Sky(scene, lights, night);
  const halos: THREE.Points[] = [];
  scene.traverse((object) => {
    if (object instanceof THREE.Points && object.material instanceof THREE.PointsMaterial && object.material.blending === THREE.AdditiveBlending) halos.push(object);
  });
  return { scene, bulb, night, sky, halos };
}

for (const search of ['', '?vr=1', '?native=1']) {
  test(`lamp halo construction and lighting for ${search || 'desktop'}`, (t) => {
    page(t, search);
    const native = search === '?native=1';
    assert.equal(lampHalosShown(), !native);
    const { scene, bulb, night, sky, halos } = fixture();
    assert.equal(halos.length, native ? 0 : 2, 'native never allocates the additive halo geometry or materials');
    const camera = new THREE.PerspectiveCamera();
    for (const x of [-1, 0, 1]) {
      camera.position.x = x;
      camera.rotation.y = x * 0.4;
      camera.updateMatrixWorld();
      sky.update(1 / 90, x + 2, camera);
      assert.equal(bulb.material.emissiveIntensity, 1, 'the bulb still emits light');
      assert.deepEqual(bulb.position.toArray(), [0, 4, 0], 'the actual lamp stays world-locked');
      assert.ok(scene.children.includes(bulb));
      assert.equal(night.lamps[0].power, 2.4, 'removing the halo does not remove the room lighting');
      for (const halo of halos) assert.equal(halo.visible, true, 'desktop and WebXR retain their halos');
    }
  });
}
