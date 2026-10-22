import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { installFloorLadder } from '../src/client/world/floor-ladder.js';
import { buildStack } from '../src/client/world/stack.js';
import { surfaceFinish } from '../src/client/world/surface.js';
import type { Collider } from '../src/client/world/office.js';
import { FLOOR, LADDER, WALL_HEIGHT } from '../src/shared/layout.js';

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
  return () => (previous ? Object.defineProperty(globalThis, 'document', previous) : Reflect.deleteProperty(globalThis, 'document'));
}

/** Unit components measured from the generated GLB, independent of any floor height. */
function sourceKit() {
  const source = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ name: 'LadderSteel', color: '#c0c0c0', metalness: 0.8 });
  const rung = new THREE.MeshStandardMaterial({ name: 'LadderRungs', color: '#eaeaea', metalness: 0.85 });
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1, 0.07).translate(0, 0.5, 0), steel);
  rail.name = 'LadderRail';
  const step = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 16).rotateX(Math.PI / 2), rung);
  step.name = 'LadderRung';
  const mount = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.09, 0.07).translate(-0.08, 0, 0), [steel, steel, steel, steel, steel, steel]);
  mount.name = 'LadderMount';
  source.add(rail, step, mount);
  return { source, steel, rung, rail, step, mount };
}

test('all three real ladder sections keep their groups, rung grid, picking, signs, hatches and collider', (t) => {
  t.after(canvasDocument());
  const colliders: Collider[] = [];
  const stack = buildStack(colliders, new THREE.MeshToonMaterial());
  stack.set({ index: 1, count: 4, up: 'gemdex', down: 'Home' });
  const kit = sourceKit();
  const sections = ['main', 'below', 'above'].map((name) => stack.group.getObjectByName(`floor-ladder-${name}`)!);
  const ladder = sections[0].parent!;
  const interact = ladder.userData.interact;
  const siblings = ladder.children.filter((c) => !sections.includes(c));
  const signs = stack.group.children.filter((c) => c instanceof THREE.Mesh && c.material instanceof THREE.MeshBasicMaterial && c.material.map);
  assert.equal(signs.length, 2);
  const collider = colliders.find((c) => c.minX === FLOOR.minX && c.maxX === FLOOR.minX + 0.21)!;
  assert.ok(collider);
  const oldCollider = { ...collider };
  const rungs = sections.flatMap((section) => section.children.filter((c) => c instanceof THREE.Mesh && c.geometry instanceof THREE.CylinderGeometry).map((c) => c.position.y));
  assert.equal(rungs.length, 34);
  assert.equal(installFloorLadder(kit.source, stack.group), true);
  assert.equal(ladder.userData.interact, interact);
  assert.deepEqual(
    ladder.children.filter((c) => !sections.includes(c)),
    siblings,
  );
  assert.ok(signs.every((s) => s.parent === stack.group));
  assert.deepEqual(collider, oldCollider);
  assert.equal(colliders.includes(collider), true);
  const materials = new Set<THREE.Material>();
  for (const section of sections) {
    assert.equal(section.children.length, 1);
    section.traverse((o) => {
      if (o instanceof THREE.Mesh) materials.add(o.material);
    });
  }
  assert.equal(materials.size, 2);
  for (const material of materials) {
    assert.ok(material instanceof THREE.MeshToonMaterial);
    assert.deepEqual(surfaceFinish(material), [0.55, 0.3]);
  }
  assert.equal(kit.rail.material, kit.steel);
  assert.equal(kit.step.material, kit.rung);
  assert.ok(Array.isArray(kit.mount.material));
  assert.ok(kit.mount.material.every((m) => m === kit.steel));
  assert.deepEqual(kit.rail.position.toArray(), [0, 0, 0]);
  assert.deepEqual(kit.rail.scale.toArray(), [1, 1, 1]);
  // The grip centres/radius remain identical at every rung, including both shaft extensions.
  stack.group.updateMatrixWorld(true);
  for (const y of rungs) {
    const section = sections[y < 0 ? 1 : y > WALL_HEIGHT ? 2 : 0];
    for (const z of [-0.15, 0, 0.15]) {
      const ray = new THREE.Raycaster(new THREE.Vector3(FLOOR.minX + 0.5, y, z), new THREE.Vector3(-1, 0, 0));
      const hits = ray.intersectObject(section, true);
      assert.ok(hits.length, `missing rung at ${y}, ${z}`);
      assert.ok(Math.abs(hits[0].point.x - (FLOOR.minX + 0.19)) < 1e-5);
    }
  }
  for (const [index, count, below, above] of [
    [0, 4, false, true],
    [1, 4, true, true],
    [3, 4, true, false],
    [0, 1, false, false],
  ] as const) {
    stack.set({ index, count });
    stack.update(0.1, [], new THREE.Vector3(-16, 1.6, 0));
    assert.equal(ladder.visible, count > 1);
    assert.equal(interact.off, count === 1);
    assert.equal(sections[1].visible, below);
    assert.equal(sections[2].visible, above);
    assert.equal(colliders.includes(collider), count > 1);
  }
  stack.set({ index: 1, count: 4 });
  const hatchEvents: string[] = [];
  stack.onHatch = (where, open) => hatchEvents.push(`${where}:${open}`);
  stack.update(0.3, [{ x: LADDER.x, y: 0, z: LADDER.z, grip: 'ladder' }], new THREE.Vector3(-16, 1.6, 0));
  stack.update(0.3, [{ x: LADDER.x, y: 5, z: LADDER.z, grip: 'ladder' }], new THREE.Vector3(-16, 6.6, 0));
  stack.update(1, [], new THREE.Vector3(-16, 1.6, 0));
  assert.deepEqual(hatchEvents, ['floor:true', 'ceiling:true', 'floor:false', 'ceiling:false']);
  stack.update(0.1, [], new THREE.Vector3(-19, 1.6, 0));
  assert.equal(sections[1].visible, false);
  assert.equal(sections[2].visible, false);
});

test('missing ladder components or sections leave every fallback intact', () => {
  const office = new THREE.Group();
  const sections = ['main', 'below', 'above'].map((name) => {
    const section = new THREE.Group();
    section.name = `floor-ladder-${name}`;
    section.add(new THREE.Object3D());
    office.add(section);
    return section;
  });
  const originals = sections.map((s) => s.children[0]);
  const { source } = sourceKit();
  const bracket = source.getObjectByName('LadderMount')!;
  bracket.removeFromParent();
  assert.equal(installFloorLadder(source, office), false);
  assert.deepEqual(
    sections.map((s) => s.children[0]),
    originals,
  );
  source.add(bracket);
  sections[2].removeFromParent();
  assert.equal(installFloorLadder(source, office), false);
  assert.deepEqual(
    sections.map((s) => s.children[0]),
    originals,
  );
});

test('ladder GLB keeps identity unit nodes, exact rail/rung envelopes and a sub-budget kit', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'));
  const asset = manifest['floor-ladder'];
  assert.equal(asset.triangles, 748);
  assert.equal(asset.materials, 3);
  const buffer = readFileSync(new URL('../src/client/public/props/floor-ladder.glb', import.meta.url));
  assert.equal(buffer.length, asset.bytes);
  const glb = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString());
  type Primitive = { attributes: { POSITION: number }; material: number };
  for (const name of ['LadderRail', 'LadderRung', 'LadderMount']) {
    const node = glb.nodes.find((n: { name: string }) => n.name === name);
    assert.ok(node);
    assert.equal(node.translation, undefined);
    assert.equal(node.rotation, undefined);
    assert.equal(node.scale, undefined);
    const primitives: Primitive[] = glb.meshes[node.mesh].primitives;
    const bounds = primitives.map((p) => glb.accessors[p.attributes.POSITION]);
    const min = [0, 1, 2].map((i) => Math.min(...bounds.map((b) => b.min[i])));
    const max = [0, 1, 2].map((i) => Math.max(...bounds.map((b) => b.max[i])));
    const expected =
      name === 'LadderRail'
        ? [
            [-0.035, 0, -0.035],
            [0.035, 1, 0.035],
          ]
        : name === 'LadderRung'
          ? [
              [-0.0345, -0.0345, -0.5],
              [0.0345, 0.0345, 0.5],
            ]
          : [
              [-0.17, -0.045, -0.035],
              [0.01, 0.045, 0.035],
            ];
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(min[i] - expected[0][i]) < 1e-5);
      assert.ok(Math.abs(max[i] - expected[1][i]) < 1e-5);
    }
    if (name === 'LadderRung') {
      const rod = primitives.find((p) => glb.materials[p.material].name === 'LadderRungs')!;
      const grip = glb.accessors[rod.attributes.POSITION];
      assert.ok(Math.abs(grip.min[0] + 0.03) < 1e-5);
      assert.ok(Math.abs(grip.max[0] - 0.03) < 1e-5);
    }
  }
});
