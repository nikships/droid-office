import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { Casualties, LOAD_TIME, type CasualtyLaptop } from '../src/client/world/casualties';
import { Person, Worker, type MedicPose } from '../src/client/world/character';

/** Real characters need text canvases, but these tests exercise geometry and poses without WebGL. */
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

class ContactMedic extends Person {
  contacts: MedicPose | null = null;
  disposals = 0;
  override medicPose(pose: MedicPose | null) {
    super.medicPose(pose);
    this.contacts = pose ? { ...pose, left: pose.left.clone(), right: pose.right.clone() } : null;
  }
  override dispose() {
    this.disposals++;
    super.dispose();
  }
}

class Patient extends Worker {
  disposals = 0;
  override dispose() {
    this.disposals++;
    super.dispose();
  }
}

function fixture(yaw = Math.PI, scale = 1) {
  const scene = new THREE.Scene();
  const seat = new THREE.Group();
  seat.position.set(0, 0.4, 5);
  seat.rotation.y = yaw;
  seat.scale.setScalar(scale);
  scene.add(seat);
  const model = new Patient('Patient', '#86b2d4');
  seat.add(model.root);
  const medics: ContactMedic[] = [];
  let laptopDisposals = 0;
  const laptop: CasualtyLaptop = { root: new THREE.Group(), shut: () => true, dispose: () => laptopDisposals++ };
  const casualties = new Casualties(scene, () => 0, {
    spawnMedic: () => {
      const medic = new ContactMedic('Medic', '#f2f4f6', { skin: medics.length ? 4 : 0, hair: 0, style: 0 });
      medics.push(medic);
      return medic;
    },
    onLand: () => {},
    onSiren: () => {},
  });
  let time = 0;
  const frame = (dt = 1 / 60) => {
    time += dt;
    casualties.update(dt, time);
    scene.updateMatrixWorld(true);
  };
  const until = (phase: string | null) => {
    for (let guard = 0; guard < 10_000; guard++) {
      if (casualties.phaseOf('patient') === phase) return;
      frame();
    }
    assert.fail(`did not reach ${phase}`);
  };
  casualties.shoot('patient', model, seat);
  return { scene, seat, model, medics, laptop, casualties, frame, until, laptopDisposals: () => laptopDisposals };
}

const handNames = ['medic-left-hand', 'medic-right-hand'];

function contactError(medic: ContactMedic) {
  let worst = 0;
  for (let hand = 0; hand < 2; hand++) {
    const point = medic.root.getObjectByName(handNames[hand])!.getWorldPosition(new THREE.Vector3());
    medic.root.worldToLocal(point);
    worst = Math.max(worst, point.distanceTo(hand ? medic.contacts!.right : medic.contacts!.left));
  }
  return worst;
}

test('both actual hands hold their targets through approach, pickup and turning carry', () => {
  const restore = canvasDocument();
  const random = Math.random;
  try {
    for (const [fall, yaw] of [
      [0.15, 0],
      [0.35, Math.PI / 2],
      [0.7, 0],
      [0.7, Math.PI],
      [0.7, Math.PI / 2],
      [0.95, Math.PI],
    ]) {
      Math.random = () => fall;
      const f = fixture(yaw);
      f.casualties.confirm('patient', f.laptop);
      let carryFrames = 0;
      let frames = 0;
      let worst = 0;
      let detail: unknown;
      while (f.casualties.phaseOf('patient') !== 'fade' && frames++ < 10_000) {
        f.frame();
        for (const medic of f.medics) {
          const error = contactError(medic);
          if (error > worst) {
            worst = error;
            detail = {
              phase: f.casualties.phaseOf('patient'),
              root: f.model.root.position.toArray(),
              medic: medic.root.position.toArray(),
              left: medic.contacts?.left.toArray(),
              right: medic.contacts?.right.toArray(),
              crouch: medic.contacts?.crouch,
            };
          }
        }
        if (f.casualties.phaseOf('patient') === 'carry') carryFrames++;
        for (const medic of f.medics) {
          for (const name of ['medic-left-foot', 'medic-right-foot']) {
            assert.ok(medic.root.getObjectByName(name)!.getWorldPosition(new THREE.Vector3()).y >= 0.044, 'boots stay above the floor during the crouch and walk');
          }
        }
      }
      assert.ok(carryFrames > 10, 'the team completes a real carry route');
      assert.ok(worst < 0.025, `hands must contact the handles/patient; yaw ${yaw}, error ${worst}; ${JSON.stringify(detail)}`);
      f.casualties.clear();
    }
  } finally {
    Math.random = random;
    restore();
  }
});

test('loading stays supported and reparenting has no position, rotation or size jump', () => {
  const restore = canvasDocument();
  try {
    const f = fixture(Math.PI, 0.85);
    f.casualties.confirm('patient', f.laptop);
    f.until('load');
    const team = f.scene.getObjectByName('medic-team')!;
    const bed = f.scene.getObjectByName('medic-stretcher')!;
    const startScale = f.model.root.getWorldScale(new THREE.Vector3());
    let previous = f.model.root.getWorldPosition(new THREE.Vector3());
    let previousRotation = f.model.root.getWorldQuaternion(new THREE.Quaternion());
    let lowest = Infinity;
    for (let i = 0; i < Math.ceil((LOAD_TIME + 0.1) * 60); i++) {
      f.frame();
      const position = f.model.root.getWorldPosition(new THREE.Vector3());
      const rotation = f.model.root.getWorldQuaternion(new THREE.Quaternion());
      assert.ok(position.distanceTo(previous) < 0.03, 'no teleport at load/carry boundary');
      assert.ok(rotation.angleTo(previousRotation) < 0.055, 'body turns smoothly to face up');
      assert.ok(f.model.root.getWorldScale(new THREE.Vector3()).distanceTo(startScale) < 1e-9, 'droid size survives attachment');
      assert.deepEqual(team.scale.toArray(), [1, 1, 1], 'people do not shrink to enter or depart');
      lowest = Math.min(lowest, bed.getWorldPosition(new THREE.Vector3()).y);
      previous = position;
      previousRotation = rotation;
    }
    assert.ok(lowest < 0.15, 'the scoop lowers to the patient');
    assert.equal(f.model.root.parent, team);
    const up = new THREE.Vector3(0, 0, 1).applyQuaternion(f.model.root.getWorldQuaternion(new THREE.Quaternion()));
    assert.ok(up.y > 0.999, 'the droid faces upward on the bed');
    f.casualties.clear();
  } finally {
    restore();
  }
});

test('entry keeps the waiting body visible; private fade never changes another character material', () => {
  const restore = canvasDocument();
  try {
    const f = fixture();
    const patientMesh = f.model.root.children[0].children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial>;
    const original = patientMesh.material;
    const bystander = new THREE.Mesh(new THREE.BoxGeometry(), original);
    f.scene.add(bystander);
    f.casualties.confirm('patient', f.laptop);
    assert.equal(patientMesh.material, original, 'body remains visible while help arrives');
    assert.equal(original.opacity, 1);
    f.until('fade');
    f.frame(0.3);
    assert.notEqual(patientMesh.material, original);
    assert.ok(patientMesh.material.opacity < 1, 'the collected body fades with its team');
    assert.equal(original.opacity, 1, 'shared source material stays opaque');
    assert.equal(original.transparent, false);
    assert.deepEqual(f.scene.getObjectByName('medic-team')!.scale.toArray(), [1, 1, 1]);
    let originalDisposals = 0;
    let privateDisposals = 0;
    original.addEventListener('dispose', () => originalDisposals++);
    patientMesh.material.addEventListener('dispose', () => privateDisposals++);
    f.casualties.clear();
    assert.equal(privateDisposals, 1, 'private fade material is released');
    assert.equal(originalDisposals, 0, 'shared source material remains live');
    assert.equal(bystander.material, original);
    bystander.geometry.dispose();
  } finally {
    restore();
  }
});

test('clear cancels every collection stage once and revive cancels an unconfirmed fall', () => {
  const restore = canvasDocument();
  try {
    const waiting = fixture();
    waiting.frame();
    assert.equal(waiting.casualties.revive('patient'), true);
    assert.equal(waiting.model.root.parent, waiting.seat);
    assert.equal(waiting.model.disposals, 0);
    assert.equal(waiting.medics.length, 0, 'no dispatch until confirmation');
    for (const phase of ['fetch', 'load', 'carry', 'fade']) {
      const f = fixture();
      f.casualties.confirm('patient', f.laptop);
      f.until(phase);
      f.casualties.clear();
      f.casualties.clear();
      assert.equal(f.casualties.phaseOf('patient'), null);
      assert.equal(f.model.disposals, 1, `patient released once during ${phase}`);
      assert.equal(f.laptopDisposals(), 1);
      assert.ok(f.medics.every((medic) => medic.disposals === 1 && medic.contacts === null));
      assert.equal(f.scene.getObjectByName('medic-team'), undefined);
      assert.deepEqual(f.casualties.positions(), []);
    }
  } finally {
    restore();
  }
});

test('medic pose restores ordinary geometry and frees helper geometry exactly once', () => {
  const restore = canvasDocument();
  try {
    const medic = new ContactMedic('Medic', '#f2f4f6', { skin: 0, hair: 0, style: 0 });
    const originalMeshes: THREE.Mesh[] = [];
    medic.root.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) originalMeshes.push(object as THREE.Mesh);
    });
    const label = medic.root.children.find((object) => (object as THREE.Sprite).isSprite)!;
    label.visible = false;
    const originalPositions = originalMeshes.map((object) => object.position.clone());
    const originalScales = originalMeshes.map((object) => object.scale.clone());
    medic.medicPose({ left: new THREE.Vector3(-0.35, 0.72, 0.26), right: new THREE.Vector3(0.35, 0.72, 0.26), crouch: 1, stride: 0 });
    const helpers = new Set<THREE.BufferGeometry>();
    medic.root.traverse((object) => {
      if ((object as THREE.Mesh).isMesh && !originalMeshes.includes(object as THREE.Mesh)) helpers.add((object as THREE.Mesh).geometry);
    });
    let released = 0;
    for (const geometry of helpers) geometry.addEventListener('dispose', () => released++);
    medic.medicPose(null);
    medic.medicPose(null);
    medic.dispose();
    assert.equal(released, helpers.size);
    originalMeshes.forEach((object, i) => {
      assert.ok(object.position.equals(originalPositions[i]));
      assert.ok(object.scale.equals(originalScales[i]));
    });
    assert.equal(medic.root.getObjectByName('medic-left-hand'), undefined);
    assert.equal(label.visible, false, 'original label visibility is restored');
  } finally {
    restore();
  }
});
