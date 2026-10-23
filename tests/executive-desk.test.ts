import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { installExecutiveDesk } from '../src/client/world/executive-desk.js';
import { buildBossDesk, type Collider, type Interactable } from '../src/client/world/office.js';
import { installTaskChairs } from '../src/client/world/task-chair.js';
import { Laptop } from '../src/client/world/laptop.js';
import { gunHit } from '../src/client/world/gun.js';
import { surfaceFinish } from '../src/client/world/surface.js';
import { DESK_LAPTOP, SEATING_BY_ID, seatPlace } from '../src/shared/layout.js';

test('executive desk swap preserves the live shell screen, BOSS sign and chair interaction', () => {
  const seat = SEATING_BY_ID.get('boss-chair')!;
  const office = new THREE.Group();
  const parent = new THREE.Group();
  parent.position.set(seat.x, seat.y, seat.z - 1);
  const desk = new THREE.Group();
  desk.name = 'executive-desk';
  desk.add(new THREE.Object3D());
  const texture = new THREE.Texture();
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.45), new THREE.MeshBasicMaterial({ map: texture }));
  screen.position.set(0, 1.18, -0.165);
  const interact = { kind: 'seat', seatId: 'boss-chair' };
  screen.userData.interact = interact;
  const plate = new THREE.Object3D();
  plate.name = 'BOSS';
  const chair = new THREE.Group();
  chair.userData.interact = interact;
  parent.add(desk, screen, plate, chair);
  office.add(parent);
  const children = [...parent.children];
  const originals = [
    new THREE.MeshStandardMaterial({ name: 'BossTop', color: '#808489' }),
    new THREE.MeshStandardMaterial({ name: 'BossFrame', color: '#596169' }),
    new THREE.MeshStandardMaterial({ name: 'BossSteel', color: '#b1b9c0', metalness: 0.85 }),
    new THREE.MeshStandardMaterial({ name: 'BossRubber', color: '#24282d' }),
    new THREE.MeshStandardMaterial({ name: 'BossSignal', color: '#ee6018', emissive: '#ee6018' }),
  ];
  const source = new THREE.Mesh(new THREE.BoxGeometry(), [...originals, originals[0]]);
  source.name = 'ExecutiveDesk';
  assert.equal(installExecutiveDesk(source, office), true);
  assert.deepEqual(parent.children, children);
  assert.deepEqual(parent.position.toArray(), [seat.x, seat.y, seat.z - 1]);
  assert.equal(screen.material.map, texture);
  assert.equal(screen.userData.interact, interact);
  assert.equal(chair.userData.interact, interact);
  assert.deepEqual(screen.position.toArray(), [0, 1.18, -0.165]);
  const model = desk.children[0] as THREE.Mesh;
  assert.equal(model.geometry, source.geometry);
  const materials = model.material as THREE.MeshToonMaterial[];
  assert.ok(materials.every((m) => m.isMeshToonMaterial));
  assert.equal(materials[0], materials[5]);
  assert.equal(surfaceFinish(materials[0]), null);
  assert.deepEqual(surfaceFinish(materials[1]), [0.04, 0.72]);
  assert.deepEqual(surfaceFinish(materials[2]), [0.55, 0.3]);
  assert.equal(surfaceFinish(materials[3]), null);
  assert.equal(materials[4].emissive.getHexString(), 'ee6018');
  assert.equal(source.material[0], originals[0]);
});

test('executive desk retains fallback for absent nodes and supports one material', () => {
  const office = new THREE.Group();
  const desk = new THREE.Group();
  desk.name = 'executive-desk';
  const fallback = new THREE.Object3D();
  desk.add(fallback);
  office.add(desk);
  assert.equal(installExecutiveDesk(new THREE.Group(), office), false);
  assert.equal(desk.children[0], fallback);
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'BossRubber' }));
  source.name = 'ExecutiveDesk';
  assert.equal(installExecutiveDesk(source, new THREE.Group()), false);
  assert.equal(installExecutiveDesk(source, office), true);
  assert.ok(((desk.children[0] as THREE.Mesh).material as THREE.MeshToonMaterial).isMeshToonMaterial);
});

test('executive GLB retains its footprint, actual worktop height, node and triangle budget', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/client/public/props/manifest.json', import.meta.url), 'utf8'));
  const desk = manifest['executive-desk'];
  assert.equal(desk.width, 2.6);
  assert.equal(desk.depth, 1.21);
  assert.equal(desk.height, 0.83, 'no monitor, keyboard or mouse remains above the worktop');
  assert.ok(desk.triangles <= 8000);
  assert.equal(desk.materials, 5);
  const glb = readFileSync(new URL('../src/client/public/props/executive-desk.glb', import.meta.url));
  assert.equal(glb.byteLength, desk.bytes);
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  assert.ok(json.nodes.some((n: { name: string }) => n.name === 'ExecutiveDesk'));
  const top = json.meshes.flatMap((m: { primitives: { material: number; attributes: { POSITION: number } }[] }) => m.primitives).find((p: { material: number }) => json.materials[p.material].name === 'BossTop');
  assert.ok(top);
  const bounds = json.accessors[top.attributes.POSITION];
  assert.ok(Math.abs(bounds.max[1] - 0.83) < 1e-5);
  assert.ok(!json.materials.some((m: { name: string }) => m.name === 'BossKeys'));
  for (const mesh of json.meshes) {
    for (const primitive of mesh.primitives) assert.ok(json.accessors[primitive.attributes.POSITION].max[1] <= 0.83001, 'all static casework stays below the laptop');
  }
});

test('boss desk mounts the worker laptop and chair without changing shell picking or the collider', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const ctx = {
    measureText: (text: string) => ({ width: text.length * 8 }),
    setTransform() {},
    clearRect() {},
    beginPath() {},
    roundRect() {},
    fill() {},
    stroke() {},
    fillText() {},
    fillRect() {},
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  const colliders: Collider[] = [];
  const interactables: Interactable[] = [];
  const { group, bossChair, bossLaptopAnchor } = buildBossDesk(colliders, interactables);
  const seat = SEATING_BY_ID.get('boss-chair')!;
  group.updateMatrixWorld(true);
  assert.deepEqual(bossChair.getWorldPosition(new THREE.Vector3()).toArray(), [seat.x, seat.y, seat.z]);
  assert.deepEqual(bossChair.scale.toArray(), [1, 1, 1]);
  assert.equal(seatPlace(seat, 0).hips, 0.5, 'sitting matches the normal-size cushion');
  assert.equal(seat.shell, true);
  assert.deepEqual(bossLaptopAnchor.position.toArray(), [0, 0.83, DESK_LAPTOP.z]);
  assert.deepEqual(bossLaptopAnchor.scale.toArray(), Array(3).fill(DESK_LAPTOP.scale));
  assert.equal(bossLaptopAnchor.rotation.y, 0, 'the screen faces the chair on +z');
  assert.equal(bossLaptopAnchor.userData.interact, bossChair.userData.interact);
  assert.equal(interactables[0], bossChair.userData.interact);
  assert.deepEqual(colliders, [{ minX: seat.x - 1.3, maxX: seat.x + 1.3, minZ: seat.z - 1.6, maxZ: seat.z - 0.4, bottom: seat.y, top: seat.y + 0.8 }]);
  const fallback = group.getObjectByName('executive-desk')!;
  const fallbackBounds = new THREE.Box3().setFromObject(fallback);
  assert.ok(fallbackBounds.max.y < seat.y + 0.831, 'the procedural fallback also has no monitor');
  const workerChair = new THREE.Group();
  const source = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  installTaskChairs(source, [workerChair, bossChair]);
  const workerModel = workerChair.children[0] as THREE.Mesh;
  const bossModel = bossChair.children[0] as THREE.Mesh;
  assert.equal(bossModel.geometry, workerModel.geometry);
  assert.equal(bossModel.material, workerModel.material, 'boss and worker use the same model resources');
  assert.equal(bossChair.userData.interact, interactables[0]);
  const laptop = new Laptop();
  t.after(() => laptop.dispose());
  bossLaptopAnchor.add(laptop.root);
  laptop.update(1, undefined);
  const standIn = laptop.screen;
  // As when the GLB arrives, picking must follow the current display through its mount.
  const inner = laptop as unknown as { lidModel: THREE.Group; wireDisplay(): void };
  const display = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.46).translate(0, 0.253, 0.013), new THREE.MeshBasicMaterial());
  display.name = 'Display';
  inner.lidModel.add(display);
  inner.wireDisplay();
  assert.notEqual(laptop.screen, standIn);
  assert.equal(laptop.screen, display);
  assert.equal(display.material, standIn.material, 'shell texture survives the GLB swap');
  group.updateMatrixWorld(true);
  const pos = new THREE.Box3().setFromObject(display).getCenter(new THREE.Vector3());
  const dir = new THREE.Vector3(0, 0, 1).transformDirection(display.matrixWorld);
  const hit = gunHit(new THREE.Raycaster(pos.clone().addScaledVector(dir, 0.3), dir.negate()), group, new Map());
  assert.equal(hit?.hit.object, laptop.screen);
  assert.equal(hit?.interactable, interactables[0], 'both display versions inherit the shell-seat interaction');
  const glowPos = new THREE.Vector3();
  const glowDir = new THREE.Vector3();
  assert.equal(laptop.glow(glowPos, glowDir), 1);
  assert.ok(glowDir.z > 0.99, 'screen light faces the seated owner');
});
