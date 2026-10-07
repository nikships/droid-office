import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { disposeGun, GUN_LEN, magnum, MUZZLE_AT, setCylinder } from '../src/client/world/gun';

function hits(gun: THREE.Group, origin: THREE.Vector3, direction: THREE.Vector3) {
  gun.updateMatrixWorld(true);
  return new THREE.Raycaster(origin, direction).intersectObject(gun, true);
}

test('the aiming axis ends at the open muzzle lip, with the grip at the holder origin', () => {
  const gun = magnum();
  const box = new THREE.Box3().setFromObject(gun);
  assert.ok(Math.abs(box.max.z - MUZZLE_AT.z) < 0.00001, 'the muzzle is exactly at the foremost surface');
  assert.ok(Math.abs(box.max.z - box.min.z - GUN_LEN) < 0.001, 'gun length includes the hammer behind the grip');
  const lip = hits(gun, MUZZLE_AT.clone().add(new THREE.Vector3(0.012, 0, 0.1)), new THREE.Vector3(0, 0, -1));
  assert.ok(Math.abs(lip[0].point.z - MUZZLE_AT.z) < 0.00001, 'the barrel surrounds the bore at its endpoint');
  const bore = hits(gun, MUZZLE_AT.clone().add(new THREE.Vector3(0, 0, 0.1)), new THREE.Vector3(0, 0, -1));
  assert.ok(bore[0].point.z < MUZZLE_AT.z - 0.015, 'the bore is recessed, with no solid cap or front-facing frame across it');
  const grip = hits(gun, new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0));
  assert.equal(grip[0].object.name, 'gun-walnut', 'the holder origin lies inside the grip');
  assert.ok(grip[0].point.x > 0.018 && grip[0].point.x < 0.03, 'the grip has a plausible full-size width');
  disposeGun(gun);
});

test('the trigger guard opens in the vertical barrel plane rather than across the gun', () => {
  const gun = magnum();
  const across = new THREE.Vector3(-1, 0, 0);
  assert.equal(hits(gun, new THREE.Vector3(1, -0.02, 0.06), across).length, 0, 'a finger can pass through the guard opening from either side');
  const guard = hits(gun, new THREE.Vector3(1, -0.041, 0.05), across);
  assert.ok(guard.length > 0, 'the guard has a continuous lower loop');
  assert.ok(guard[0].point.x < 0.006, 'the guard is narrow across X, instead of a sideways torus');
  const forward = hits(gun, new THREE.Vector3(0, -0.01, 0.02), new THREE.Vector3(0, 0, 1));
  assert.equal(forward[0].object.name, 'gun-details', 'the trigger is the first thing a finger meets inside the guard');
  assert.ok(forward[0].point.z < 0.06, 'the trigger sits in the rear of the guard, toward the grip');
  disposeGun(gun);
});

test('up is +Y and back is -Z: sights on top, hammer behind the grip, grip below the bore', () => {
  const gun = magnum();
  const down = new THREE.Vector3(0, -1, 0);
  const front = hits(gun, new THREE.Vector3(0, 1, MUZZLE_AT.z - 0.012), down);
  assert.equal(front[0].object.name, 'gun-details', 'a dark front sight stands on the rib near the muzzle');
  assert.ok(front[0].point.y > MUZZLE_AT.y + 0.025, 'the front sight is above the bore');
  const box = new THREE.Box3().setFromObject(gun);
  const rear = hits(gun, new THREE.Vector3(0, 0.12, -1), new THREE.Vector3(0, 0, 1));
  assert.equal(rear[0].object.name, 'gun-details', 'the hammer spur is the rearmost part');
  assert.ok(Math.abs(rear[0].point.z - box.min.z) < 0.005);
  assert.ok(box.min.y < -0.06 && box.min.y > -0.08, 'the grip ends a fist-height below the origin');
  assert.ok(MUZZLE_AT.y > 0.07 && MUZZLE_AT.y < 0.1, 'the bore rides above the fist, like a held revolver');
  assert.ok(Math.abs(box.max.x + box.min.x) < 0.001, 'the model is symmetric across its vertical barrel plane');
  disposeGun(gun);
});

test('the complete gun is a finite, compact model: four static batches and a loaded cylinder on its crane', () => {
  const gun = magnum();
  let triangles = 0;
  let meshes = 0;
  const materials = new Set<THREE.Material>();
  gun.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    meshes++;
    materials.add(object.material);
    assert.ok(object.material instanceof THREE.MeshToonMaterial);
    assert.equal(object.material.transparent, false);
    assert.equal(object.material.map, null, 'the gun introduces no texture uploads');
    const position = object.geometry.getAttribute('position');
    const normal = object.geometry.getAttribute('normal');
    triangles += (object.geometry.index?.count ?? position.count) / 3;
    for (let i = 0; i < position.count; i++) {
      for (const coordinate of [position.getX(i), position.getY(i), position.getZ(i)]) assert.ok(Number.isFinite(coordinate));
      const length = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
      assert.ok(length > 0.99 && length < 1.01, 'every surface has a valid unit normal');
    }
  });
  assert.equal(meshes, 8, 'four static batches, the crane arm, and the cylinder, its brass and its chambers');
  assert.equal(materials.size, 5, 'steel, frame, walnut, dark details and brass');
  assert.ok(triangles <= 1400, 'the shared close-up model remains inexpensive to render');
  const size = new THREE.Box3().setFromObject(gun).getSize(new THREE.Vector3());
  assert.ok(size.x < 0.07 && size.y < 0.21 && size.z < 0.35, 'the model is in meters without a hidden scale or rotation');

  disposeGun(gun);
});

test('the cylinder swings out to the gun’s left on its crane, clear of the frame, and turns on its own axis', () => {
  const gun = magnum();
  const drum = gun.getObjectByName('gun-drum')!;
  const at = () => {
    gun.updateMatrixWorld(true);
    return drum.getWorldPosition(new THREE.Vector3());
  };
  const shut = at();
  assert.ok(Math.abs(shut.x) < 1e-6 && Math.abs(shut.y - (MUZZLE_AT.y - 0.026)) < 1e-6, 'shut, it sits in the frame’s window under the top strap');
  setCylinder(gun, 1, 0);
  const open = at();
  assert.ok(open.x > 0.042, 'out to the left (+X), past the frame’s side');
  assert.ok(open.y < shut.y, 'and down, the way it falls out when canted');
  assert.ok(Math.abs(open.z - shut.z) < 1e-9, 'the crane hinges along the bore, so it does not slide');
  setCylinder(gun, 1, Math.PI / 3);
  assert.ok(at().distanceTo(open) < 1e-9, 'turning it leaves its axis where it is');
  const box = new THREE.Box3().setFromObject(gun.getObjectByName('gun-brass')!);
  assert.ok(box.max.z < shut.z - 0.03, 'the brass case heads are on its back face');
  setCylinder(gun, 0, 0);
  assert.ok(at().distanceTo(shut) < 1e-9, 'and it closes back exactly where it was');
  disposeGun(gun);
});

test('disposing one gun frees its resources without disposing another holder gun', () => {
  const scene = new THREE.Scene();
  const first = magnum();
  const other = magnum();
  scene.add(first, other);
  let firstGeometryDisposals = 0;
  let firstMaterialDisposals = 0;
  let otherDisposals = 0;
  const meshesOf = (gun: THREE.Group) => {
    const out: THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial>[] = [];
    gun.traverse((o) => {
      if (o instanceof THREE.Mesh) out.push(o as THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial>);
    });
    return out;
  };
  const firstMaterials = new Set<THREE.Material>();
  for (const mesh of meshesOf(first)) {
    mesh.geometry.addEventListener('dispose', () => firstGeometryDisposals++);
    if (!firstMaterials.has(mesh.material)) mesh.material.addEventListener('dispose', () => firstMaterialDisposals++);
    firstMaterials.add(mesh.material);
  }
  const otherMaterials = new Set<THREE.Material>();
  for (const mesh of meshesOf(other)) {
    mesh.geometry.addEventListener('dispose', () => otherDisposals++);
    if (!otherMaterials.has(mesh.material)) mesh.material.addEventListener('dispose', () => otherDisposals++);
    otherMaterials.add(mesh.material);
  }
  disposeGun(first);
  assert.equal(first.parent, null);
  assert.equal(firstGeometryDisposals, 8, 'every mesh frees its own geometry');
  assert.equal(firstMaterialDisposals, 5, 'each shared material is freed exactly once');
  assert.equal(otherDisposals, 0);
  assert.equal(other.parent, scene);
  disposeGun(other);
});
