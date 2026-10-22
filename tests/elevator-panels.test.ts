import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { ELEVATOR, ELEVATOR_FRONT } from '../src/shared/layout.js';
import { buildElevator } from '../src/client/world/elevator.js';
import { installElevatorPanels } from '../src/client/world/elevator-panels.js';
import { surfaceFinish } from '../src/client/world/surface.js';

function sourcePanels() {
  const source = new THREE.Group();
  const geometry = new THREE.BoxGeometry(0.72, 2.38, 0.055);
  const skin = new THREE.MeshStandardMaterial({ name: 'LiftSkin', color: '#8c8c8c', metalness: 0.8 });
  const steel = new THREE.MeshStandardMaterial({ name: 'LiftHardware', color: '#70767b', metalness: 0.85 });
  const seal = new THREE.MeshStandardMaterial({ name: 'LiftSeal', color: '#161616' });
  const original = [skin, steel, seal, steel];
  for (const side of ['Left', 'Right']) {
    const part = new THREE.Group();
    part.name = `ElevatorPanel${side}`;
    part.add(new THREE.Mesh(geometry, original), new THREE.Mesh(geometry, skin));
    source.add(part);
  }
  return { source, geometry, original };
}

test('actual elevator retains its eased slides, clearance, controls and immediate shut-door collider', () => {
  const elevator = buildElevator();
  const { source, geometry, original } = sourcePanels();
  const left = elevator.group.getObjectByName('elevator-panel-left')!;
  const right = elevator.group.getObjectByName('elevator-panel-right')!;
  const others = elevator.group.children.filter((o) => o !== left && o !== right);
  const collider = elevator.colliders.at(-1)!;
  const colliderBefore = { ...collider };
  const interaction = elevator.interactable;
  const positions = [left, right].map((o) => o.position.toArray());
  const fallback = left.children[0];
  assert.equal(installElevatorPanels(source, elevator.group), true);
  assert.deepEqual(
    elevator.group.children.filter((o) => o !== left && o !== right),
    others,
  );
  assert.deepEqual(
    [left, right].map((o) => o.position.toArray()),
    positions,
  );
  assert.deepEqual(collider, colliderBefore);
  assert.equal(elevator.interactable, interaction);
  assert.equal(fallback.parent, null);
  const loaded = left.children[0].children[0] as THREE.Mesh;
  const materials = loaded.material as THREE.MeshToonMaterial[];
  assert.equal(loaded.geometry, geometry);
  assert.ok(materials.every((m) => m.isMeshToonMaterial));
  assert.deepEqual(materials.map(surfaceFinish), [[0.55, 0.3], [0.55, 0.3], null, [0.55, 0.3]]);
  assert.ok(materials[0].color.equals(original[0].color));
  assert.equal(materials[1], materials[3]);
  const rightMaterials = (right.children[0].children[0] as THREE.Mesh).material as THREE.Material[];
  for (const [i, material] of rightMaterials.entries()) assert.equal(material, materials[i]);
  assert.equal((left.children[0].children[1] as THREE.Mesh).material, materials[0]);
  assert.equal((source.children[0].children[0] as THREE.Mesh).material, original);
  assert.equal(source.children[0].parent, source);
  assert.ok(materials.every((m) => m.emissive.getHex() === 0));
  const half = ELEVATOR.doorWidth / 2 + 0.02;
  const travel = (ELEVATOR.width - ELEVATOR.doorWidth) / 2 - 0.03;
  const check = (fraction: number) => {
    const eased = fraction * fraction * (3 - 2 * fraction);
    for (const [i, side] of [-1, 1].entries()) {
      const mount = [left, right][i];
      assert.ok(Math.abs(mount.position.x - (ELEVATOR.x + (side * half) / 2 + side * eased * travel)) < 1e-9);
      assert.equal(mount.position.y, ELEVATOR.doorHeight / 2);
      assert.equal(mount.position.z, ELEVATOR_FRONT - ELEVATOR.wall - 0.03);
      assert.deepEqual(mount.scale.toArray(), [1, 1, 1]);
    }
  };
  check(0);
  elevator.setOpen(true);
  elevator.update(0.35);
  check(0.5);
  assert.equal(elevator.settled, false);
  assert.equal(collider.top, 99);
  elevator.update(0.35);
  check(1);
  assert.equal(elevator.open, true);
  assert.equal(elevator.settled, true);
  assert.equal(collider.top, -1);
  elevator.setOpen(false);
  assert.equal(collider.top, 99);
  elevator.update(0.3);
  check(0.5);
  elevator.update(0.3);
  check(0);
  assert.equal(elevator.open, false);
  assert.equal(elevator.settled, true);
});

test('installation during a slide retains progress and single-mesh leaves work for another elevator', () => {
  const source = new THREE.Group();
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshStandardMaterial({ name: 'LiftSeal' });
  for (const side of ['Left', 'Right']) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `ElevatorPanel${side}`;
    source.add(mesh);
  }
  const elevators = [buildElevator(), buildElevator()];
  for (const elevator of elevators) {
    elevator.setOpen(true);
    elevator.update(0.35);
    const mounts = ['left', 'right'].map((s) => elevator.group.getObjectByName(`elevator-panel-${s}`)!);
    const before = mounts.map((o) => o.position.toArray());
    assert.equal(installElevatorPanels(source, elevator.group), true);
    assert.deepEqual(
      mounts.map((o) => o.position.toArray()),
      before,
    );
    for (const mount of mounts) {
      const mesh = mount.children[0] as THREE.Mesh;
      assert.equal(mesh.geometry, geometry);
      assert.equal(surfaceFinish(mesh.material as THREE.Material), null);
    }
    elevator.update(0.35);
    assert.equal(elevator.settled, true);
  }
  assert.equal((source.children[0] as THREE.Mesh).material, material);
});

test('missing either leaf or mount preserves both procedural panels', () => {
  for (const side of ['Left', 'Right']) {
    const { source } = sourcePanels();
    const elevator = buildElevator();
    const mounts = ['left', 'right'].map((s) => elevator.group.getObjectByName(`elevator-panel-${s}`)!);
    const children = mounts.map((o) => [...o.children]);
    source.getObjectByName(`ElevatorPanel${side}`)!.removeFromParent();
    assert.equal(installElevatorPanels(source, elevator.group), false);
    assert.deepEqual(
      mounts.map((o) => o.children),
      children,
    );
    const complete = sourcePanels().source;
    elevator.group.getObjectByName(`elevator-panel-${side.toLowerCase()}`)!.removeFromParent();
    assert.equal(installElevatorPanels(complete, elevator.group), false);
    assert.deepEqual(
      mounts.map((o) => o.children),
      children,
    );
  }
});

test('both GLB leaves retain identity origins and exact original sliding-local envelopes', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'));
  const asset = manifest['elevator-panels'];
  assert.deepEqual([asset.width, asset.height, asset.depth], [0.72, 2.38, 0.055]);
  assert.ok(asset.triangles <= 8000);
  assert.equal(asset.materials, 3);
  const glb = readFileSync(new URL('../src/client/public/props/elevator-panels.glb', import.meta.url));
  assert.equal(glb.byteLength, asset.bytes);
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  assert.equal(json.nodes.length, 2);
  for (const name of ['ElevatorPanelLeft', 'ElevatorPanelRight']) {
    const node = json.nodes.find((n: { name: string }) => n.name === name);
    assert.ok(node);
    assert.equal(node.children, undefined);
    assert.deepEqual(node.translation ?? [0, 0, 0], [0, 0, 0]);
    assert.deepEqual(node.rotation ?? [0, 0, 0, 1], [0, 0, 0, 1]);
    assert.deepEqual(node.scale ?? [1, 1, 1], [1, 1, 1]);
    const bounds = json.meshes[node.mesh].primitives.map((p: { attributes: { POSITION: number } }) => json.accessors[p.attributes.POSITION]);
    for (const [axis, radius] of [
      [0, 0.36],
      [1, 1.19],
      [2, 0.0275],
    ]) {
      assert.ok(Math.abs(Math.min(...bounds.map((b: { min: number[] }) => b.min[axis])) + radius) < 1e-4);
      assert.ok(Math.abs(Math.max(...bounds.map((b: { max: number[] }) => b.max[axis])) - radius) < 1e-4);
    }
  }
  assert.deepEqual(json.materials.map((m: { name: string }) => m.name).sort(), ['LiftHardware', 'LiftSeal', 'LiftSkin']);
  assert.ok(json.materials.every((m: { emissiveFactor?: number[] }) => !m.emissiveFactor?.some(Boolean)));
});
