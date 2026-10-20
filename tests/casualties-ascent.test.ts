import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { ASCEND_TIME, BEAM_TIME, Casualties, type CasualtyLaptop, type CasualtyLook } from '../src/client/world/casualties.js';
import { Worker } from '../src/client/world/character.js';
import { WALL_HEIGHT } from '../src/shared/layout.js';

/** Real workers need text canvases, but these tests exercise geometry without WebGL. */
function canvasDocument() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => {
        const canvas = { width: 1, height: 1, getContext: () => context };
        const context = new Proxy({ canvas, measureText: (text: string) => ({ width: text.length * 12 }) }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) });
        return canvas;
      },
    },
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  };
}

class Patient extends Worker {
  disposals = 0;
  override dispose() {
    this.disposals++;
    super.dispose();
  }
}

function fixture(yaw = Math.PI, scale = 1, ground = 0, look: CasualtyLook = 'blood') {
  const scene = new THREE.Scene();
  const seat = new THREE.Group();
  seat.position.set(0, ground + 0.4, 5);
  seat.rotation.y = yaw;
  seat.scale.setScalar(scale);
  scene.add(seat);
  const model = new Patient('Patient', '#86b2d4');
  seat.add(model.root);
  let laptopDisposals = 0;
  const laptop: CasualtyLaptop = { root: new THREE.Group(), shut: () => true, dispose: () => laptopDisposals++ };
  const casualties = new Casualties(scene, () => ground);
  let time = 0;
  const frame = (dt = 1 / 60) => {
    time += dt;
    casualties.update(dt, time);
    scene.updateMatrixWorld(true);
  };
  const until = (phase: string | null) => {
    for (let guard = 0; guard < 400; guard++) {
      if (casualties.phaseOf('patient') === phase) return;
      frame();
    }
    assert.fail(`did not reach ${phase}`);
  };
  casualties.ascend('patient', model, laptop, look);
  return { scene, seat, model, laptop, casualties, frame, until, laptopDisposals: () => laptopDisposals };
}

test('real workers ease face-up and rise vertically at full size, on the floor or loft', () => {
  const restore = canvasDocument();
  try {
    for (const yaw of [0, Math.PI / 2, Math.PI]) {
      for (const ground of [0, 3.2]) {
        for (const look of ['blood', 'spell'] as const) {
          const f = fixture(yaw, 0.85, ground, look);
          const start = f.model.root.position.clone();
          const scale = f.model.root.getWorldScale(new THREE.Vector3());
          // Inspect every frame, including the beam/ascent/fade boundaries.
          let y = start.y;
          const rotation = f.model.root.quaternion.clone();
          for (let i = 0; i < Math.ceil((BEAM_TIME + ASCEND_TIME) * 60) + 4; i++) {
            f.frame();
            const root = f.model.root;
            assert.ok(root.position.y >= y, 'never drops back down');
            assert.ok(root.position.y - y < 0.09, 'no jump at phase boundaries');
            assert.ok(root.quaternion.angleTo(rotation) < 0.12, 'no abrupt rotation');
            assert.ok(root.getWorldScale(new THREE.Vector3()).distanceTo(scale) < 1e-9);
            assert.equal(root.position.x, start.x);
            assert.equal(root.position.z, start.z);
            y = root.position.y;
            rotation.copy(root.quaternion);
          }
          const up = new THREE.Vector3(0, 0, 1).applyQuaternion(f.model.root.quaternion);
          assert.ok(up.y > 0.999, 'face-up in the beam');
          const bounds = new THREE.Box3().setFromObject(f.model.root);
          assert.ok(bounds.min.y > WALL_HEIGHT, 'the entire worker passes through the ceiling');
          f.until(null);
          assert.equal(f.model.disposals, 1);
          assert.equal(f.laptopDisposals(), 1);
          assert.equal(f.scene.getObjectByName('heavenly-beam'), undefined);
        }
      }
    }
  } finally {
    restore();
  }
});

test('ascent never changes shared worker materials and releases beam resources once', () => {
  const restore = canvasDocument();
  try {
    for (const phase of ['beam', 'ascend', 'fade', null]) {
      const f = fixture();
      const patientMesh = f.model.root.children[0].children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial>;
      const original = patientMesh.material;
      const bystander = new THREE.Mesh(new THREE.BoxGeometry(), original);
      f.scene.add(bystander);
      let originalDisposals = 0;
      original.addEventListener('dispose', () => originalDisposals++);
      const resources = new Set<THREE.BufferGeometry | THREE.Material>();
      f.scene.getObjectByName('heavenly-beam')!.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        resources.add(mesh.geometry);
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) resources.add(material);
      });
      const released = new Map<object, number>();
      for (const resource of resources) resource.addEventListener('dispose', () => released.set(resource, (released.get(resource) ?? 0) + 1));
      f.until(phase);
      f.casualties.clear();
      f.casualties.clear();
      assert.equal(f.model.disposals, 1);
      assert.equal(f.laptopDisposals(), 1);
      assert.equal(patientMesh.material, original);
      assert.equal(original.opacity, 1);
      assert.equal(original.transparent, false);
      assert.equal(originalDisposals, 0, 'shared source material remains live');
      assert.equal(bystander.material, original);
      assert.equal(released.size, resources.size);
      assert.ok(
        [...released.values()].every((count) => count === 1),
        'each beam resource is freed once',
      );
      assert.equal(f.scene.getObjectByName('heavenly-beam'), undefined);
      bystander.geometry.dispose();
    }
  } finally {
    restore();
  }
});
