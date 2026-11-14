import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as THREE from 'three';
import { buildSnapshot, listTargets, resolveTarget, standFor, type RawState, type TargetContext } from '../src/client/automation.js';
import { EYE_HEIGHT, HIPS, STEP } from '../src/client/player.js';
import type { Interactable } from '../src/client/world/office.js';
import { firstVisibleIntersection, preparePicking } from '../src/client/world/picking.js';
import { buildVibesSwitch, VIBES_SWITCH_PALETTE } from '../src/client/world/vibes-switch.js';
import { GeminiDecisionsStore } from '../src/server/gemini-decisions.js';
import { OfficeVibes } from '../src/server/office-vibes.js';
import { emptyGeminiState, type GeminiConnectionState, resolveVibesSwitchState } from '../src/shared/gemini-vibes.js';
import { CEILING_GLYPH, SPAWN, VIBES_SWITCH } from '../src/shared/layout.js';
import { route, walkable } from '../src/shared/nav.js';

const TEST_KEY = 'AIzaSyTestKey1234567890abcdef123456789';

test('VIBES_SWITCH stands directly beneath the spinning ceiling Factory glyph at character abdomen height', () => {
  assert.equal(VIBES_SWITCH.x, CEILING_GLYPH.x);
  assert.equal(VIBES_SWITCH.z, CEILING_GLYPH.z);
  assert.ok(VIBES_SWITCH.height > HIPS + 0.15, 'rises comfortably above character hip height');
  assert.ok(VIBES_SWITCH.height < 0.78, 'stays below chest ID card and desk height, at the character abdomen');
  assert.ok(VIBES_SWITCH.height > STEP, 'taller than STEP so walking against the column never steps onto it');
  assert.ok(VIBES_SWITCH.columnRadius < VIBES_SWITCH.buttonRadius * 0.4, 'a thin vertical column beneath a wider circular button');
});

test('resolveVibesSwitchState never misleads when disconnected, rejected, or airgapped', () => {
  // Fresh office defaults have vibesOn: true, which must still show as disconnected until a key is saved.
  const fresh = emptyGeminiState();
  assert.equal(fresh.connected, false);
  assert.equal(fresh.vibesOn, true);
  assert.equal(resolveVibesSwitchState(fresh), 'disconnected');
  assert.equal(resolveVibesSwitchState({ ...fresh, vibesOn: false }), 'disconnected');

  // Connected and healthy reflects vibesOn directly.
  const connectedOn: GeminiConnectionState = { ...fresh, connected: true, vibesOn: true };
  const connectedOff: GeminiConnectionState = { ...fresh, connected: true, vibesOn: false };
  assert.equal(resolveVibesSwitchState(connectedOn), 'on');
  assert.equal(resolveVibesSwitchState(connectedOff), 'off');

  // Rejected key takes precedence over vibesOn so the switch does not claim Living 3D is active.
  assert.equal(resolveVibesSwitchState({ ...connectedOn, rejected: 'API key not valid' }), 'rejected');
  assert.equal(resolveVibesSwitchState({ ...connectedOff, rejected: 'API key not valid' }), 'rejected');

  // Airgapped mode overrides even a saved valid key.
  assert.equal(resolveVibesSwitchState(connectedOn, { airgapped: true }), 'airgapped');
  assert.equal(resolveVibesSwitchState(fresh, { airgapped: true }), 'airgapped');
});

test('buildVibesSwitch applies unmistakable green/red/unpowered visuals, plunger travel, emblem spin, and neutral GI bake hiding', () => {
  const sw = buildVibesSwitch();
  assert.equal(sw.group.position.x, CEILING_GLYPH.x);
  assert.equal(sw.group.position.z, CEILING_GLYPH.z);
  assert.equal(sw.group.userData.interact, sw.interactable);
  assert.equal(sw.interactable.kind, 'vibes');

  // Starts disconnected (dark graphite, zero cap glow — neither green nor red).
  const initial = sw.inspect();
  assert.equal(initial.state, 'disconnected');
  assert.equal(initial.capHex, VIBES_SWITCH_PALETTE.disconnected.cap);
  assert.equal(initial.emissiveIntensity, 0);

  // Connected ON -> unmistakable bright green + latched plunger + spinning top pinwheel.
  sw.setState('on');
  const onSnap = sw.inspect();
  assert.equal(onSnap.state, 'on');
  assert.equal(onSnap.capHex, '#22c55e');
  assert.equal(onSnap.ringHex, '#34d399');
  assert.ok(onSnap.emissiveIntensity >= 0.8);
  assert.ok(onSnap.plungerY < initial.plungerY, 'latches slightly lower when engaged');

  const plunger = sw.group.getObjectByName('vibes-switch-plunger')!;
  const emblem = plunger.children.at(-1)!;
  sw.update(2.5, 0.016);
  const spunAngle = emblem.rotation.y;
  assert.ok(Math.abs(spunAngle - 2.5 * CEILING_GLYPH.spin) < 1e-6, 'top glyph turns in sync with ceiling glyph while ON');

  // Connected OFF -> unmistakable bright red + stationary top pinwheel.
  sw.setState('off');
  const offSnap = sw.inspect();
  assert.equal(offSnap.state, 'off');
  assert.equal(offSnap.capHex, '#ef4444');
  assert.equal(offSnap.ringHex, '#f87171');
  assert.ok(offSnap.emissiveIntensity >= 0.75);
  assert.notEqual(offSnap.capHex, onSnap.capHex);
  sw.update(5.0, 0.016);
  assert.equal(emblem.rotation.y, spunAngle, 'top glyph stops spinning when Living 3D is OFF');

  // Rejected & airgapped remain visually distinct from both ON green and OFF red.
  sw.setState('rejected');
  assert.equal(sw.inspect().capHex, '#27272a');
  assert.equal(sw.inspect().ringHex, '#f59e0b');
  sw.setState('airgapped');
  assert.equal(sw.inspect().capHex, '#1f2024');
  assert.equal(sw.inspect().emissiveIntensity, 0);

  // Tactile press depresses plunger and emits an expanding ripple that settles cleanly.
  sw.setState('on');
  const beforePressY = sw.inspect().plungerY;
  sw.press('off');
  const pressedSnap = sw.inspect();
  assert.ok(pressedSnap.plungerY < beforePressY - 0.02);
  assert.equal(pressedSnap.rippleVisible, true);
  for (let i = 0; i < 40; i++) sw.update(6 + i * 0.02, 0.02);
  const settledSnap = sw.inspect();
  assert.ok(Math.abs(settledSnap.plungerY - beforePressY) < 1e-3, 'plunger springs back smoothly');
  assert.equal(settledSnap.rippleVisible, false, 'ripple fades out after press');

  // Every illuminated/colored indicator mesh is listed in bakeHidden so Remastered GI bakes stay neutral.
  const hiddenRoots = new Set<THREE.Object3D>(sw.bakeHidden);
  const isHiddenDuringBake = (obj: THREE.Object3D): boolean => {
    for (let cur: THREE.Object3D | null = obj; cur; cur = cur.parent) {
      if (hiddenRoots.has(cur)) return true;
    }
    return false;
  };
  sw.group.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.Material & { color?: THREE.Color; emissive?: THREE.Color; emissiveIntensity?: number };
    const hex = mat.color ? `#${mat.color.getHexString()}` : '';
    const emitsLight = Boolean(mat.emissive && mat.emissive.getHex() !== 0 && (mat.emissiveIntensity ?? 0) > 0);
    if (hex === '#22c55e' || hex === '#34d399' || emitsLight) {
      assert.equal(isHiddenDuringBake(m), true, `colored/emissive mesh (${hex}) must be hidden during GI probe bakes`);
    }
  });
});

test('3D crosshair raycast hits the pedestal button from all four cardinal directions', () => {
  const sw = buildVibesSwitch();
  const root = new THREE.Group();
  root.add(sw.group);
  root.updateMatrixWorld(true);
  preparePicking(root);

  const buttonTarget = new THREE.Vector3(VIBES_SWITCH.x, VIBES_SWITCH.height - 0.015, VIBES_SWITCH.z);
  const directions: [string, number, number][] = [
    ['south', 0, 1.1],
    ['north', 0, -1.1],
    ['east', 1.1, 0],
    ['west', -1.1, 0],
  ];

  for (const [label, dx, dz] of directions) {
    const eye = new THREE.Vector3(VIBES_SWITCH.x + dx, EYE_HEIGHT, VIBES_SWITCH.z + dz);
    const dir = buttonTarget.clone().sub(eye).normalize();
    const ray = new THREE.Raycaster(eye, dir, 0, 3.5);
    const hit = firstVisibleIntersection(ray, [root]);
    assert.ok(hit, `ray from ${label} hits the pedestal button`);
    let found: Interactable | undefined;
    for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
      found ??= o.userData.interact as Interactable | undefined;
    }
    assert.equal(found?.kind, 'vibes', `ray from ${label} resolves to the vibes interactable`);
  }
});

test('floor navigation routes around the pedestal column while keeping approach spots walkable', () => {
  assert.equal(walkable(VIBES_SWITCH.x, VIBES_SWITCH.z), false, 'column footprint itself is blocked in nav grid');
  const sw = buildVibesSwitch();
  assert.equal(walkable(sw.interactable.x, sw.interactable.z), true, 'default interaction spot in front of pedestal is walkable');

  // Walking across the plaza right through (VIBES_SWITCH.x, VIBES_SWITCH.z) routes cleanly around it.
  const way = route([VIBES_SWITCH.x - 2.5, VIBES_SWITCH.z], [VIBES_SWITCH.x + 2.5, VIBES_SWITCH.z]);
  assert.ok(way.length >= 3, 'route detours around the pedestal column');
  for (let i = 1; i < way.length; i++) {
    const [x0, z0] = way[i - 1];
    const [x1, z1] = way[i];
    const steps = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.15);
    for (let k = 0; k <= steps; k++) {
      const x = x0 + ((x1 - x0) * k) / steps;
      const z = z0 + ((z1 - z0) * k) / steps;
      assert.equal(walkable(x, z), true, `detour stays walkable at (${x.toFixed(2)}, ${z.toFixed(2)})`);
    }
  }

  // Spawn to the pedestal interaction spot has a clean walkable path.
  const toSwitch = route([SPAWN.x, SPAWN.z], [sw.interactable.x, sw.interactable.z]);
  assert.deepEqual(toSwitch.at(-1), [sw.interactable.x, sw.interactable.z]);
});

test('window.office automation lists, resolves, stands at, and snapshots the Living 3D switch', () => {
  const sw = buildVibesSwitch();
  const ctx: TargetContext = {
    workers: [],
    spots: [sw.interactable],
    floors: [{ id: 'f1', name: 'droid-office' }],
    floor: 'f1',
  };
  const targets = listTargets(ctx);
  assert.deepEqual(
    targets.find((t) => t.id === 'vibes'),
    { id: 'vibes', kind: 'place', label: 'Living 3D switch' },
  );

  for (const query of ['vibes', 'Living 3D switch', 'living 3d switch']) {
    const res = resolveTarget(query, ctx);
    assert.equal(res.ok, true, query);
    if (!res.ok) continue;
    assert.equal(res.target.spot, sw.interactable);
    const blocked = (x: number, z: number) => Math.hypot(x - VIBES_SWITCH.x, z - VIBES_SWITCH.z) < VIBES_SWITCH.colliderRadius + 0.32;
    const pose = standFor(res.target, blocked, { x: VIBES_SWITCH.x, y: VIBES_SWITCH.height / 2, z: VIBES_SWITCH.z });
    assert.ok(pose, 'finds unblocked standing pose facing the pedestal');
    assert.ok(pose.lookPitch < -0.3 && pose.lookPitch > -1.1, 'looks down comfortably at the abdomen-height pedestal');
  }

  const raw: RawState = {
    floor: 'f1',
    floors: [{ id: 'f1', name: 'droid-office', waiting: 0 }],
    riding: false,
    player: { x: 4.2, y: 0, z: -0.9, eyeHeight: EYE_HEIGHT, facing: Math.PI, lookPitch: -0.75, seat: null, enabled: true, walking: false, climbing: false },
    camera: { x: 4.2, y: EYE_HEIGHT, z: -0.9 },
    using: sw.interactable,
    modals: [],
    terminal: null,
    workers: [],
    carrying: null,
    hanging: false,
    gun: false,
    gunMove: null,
    sidearm: 'wand',
    vibesSwitch: 'on',
    vibes: {
      on: true,
      watching3d: 1,
      calls: 4,
      inputTokens: 320,
      mood: 'deep_crunch',
      workers: [],
    },
  };
  const snap = buildSnapshot(raw);
  assert.equal(snap.using?.id, 'vibes');
  assert.equal(snap.using?.label, 'Living 3D switch');
  assert.equal(snap.vibesSwitch, 'on');
  assert.equal(snap.vibes?.on, true);
});

test('toggling setVibesOn synchronizes persisted Gemini store, broadcast state, and switch state', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibes-switch-sync-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const geminiStore = new GeminiDecisionsStore(dir);
  const broadcasts: GeminiConnectionState[] = [];
  const vibes = new OfficeVibes({
    store: geminiStore,
    airgapped: () => false,
    clients: () => [],
    floors: () => [],
    floor: () => undefined,
    broadcastGemini: (s) => broadcasts.push(s),
    emitFloorVibes: () => {},
  });
  t.after(() => vibes.stop());

  // Disconnected initially -> switch is 'disconnected' even though vibesOn defaults to true.
  assert.equal(resolveVibesSwitchState(vibes.geminiState()), 'disconnected');

  // Connect key -> switch immediately becomes 'on'.
  assert.equal(geminiStore.saveKey(TEST_KEY, 'Nik', 1000), undefined);
  assert.equal(resolveVibesSwitchState(vibes.geminiState()), 'on');

  // Toggle OFF (from 3D switch or Settings) -> broadcasts vibesOn: false, persists to disk, switch is 'off'.
  assert.equal(vibes.setVibesOn(false), undefined);
  assert.equal(broadcasts.at(-1)?.vibesOn, false);
  assert.equal(resolveVibesSwitchState(broadcasts.at(-1)!), 'off');
  assert.equal(new GeminiDecisionsStore(dir).vibesOn(), false);

  // Toggle ON -> broadcasts vibesOn: true, persists to disk, switch is 'on'.
  assert.equal(vibes.setVibesOn(true), undefined);
  assert.equal(broadcasts.at(-1)?.vibesOn, true);
  assert.equal(resolveVibesSwitchState(broadcasts.at(-1)!), 'on');
  assert.equal(new GeminiDecisionsStore(dir).vibesOn(), true);
});
