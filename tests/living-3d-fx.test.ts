import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { materialFeatures, spellStandIns } from '../src/client/shader-warmup.js';
import { casualtyMarkers } from '../src/client/world/casualties.js';
import { Sky, withBaselineOfficeFill } from '../src/client/world/sky.js';
import { VibeFx } from '../src/client/world/vibe-fx.js';
import { buildVibesSwitch } from '../src/client/world/vibes-switch.js';
import { DESK_MOMENT_FX, FLOOR_EVENT_FX, MICRO_REACTION_FX } from '../src/shared/gemini-vibes.js';
import { WALL_HEIGHT } from '../src/shared/layout.js';

/** Canvas 2D calls `Sky` makes, recorded as no-ops so they run under Node. */
function stubCanvas(t: { after: (fn: () => void) => void }) {
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const ctx2d = new Proxy({ measureText: (s: string) => ({ width: s.length * 10 }), createRadialGradient: () => ({ addColorStop: () => {} }) } as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : () => {}),
    set: () => true,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => ({ width: 256, height: 128, getContext: () => ctx2d }) },
  });
  t.after(() => {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete (globalThis as { document?: unknown }).document;
  });
}

function makeSky() {
  const scene = new THREE.Scene();
  const sky = new Sky(
    scene,
    { sun: new THREE.DirectionalLight('#ffffff', 0.18), hemi: new THREE.HemisphereLight('#ffffff', '#000000', 0.3), ambient: new THREE.AmbientLight('#ffffff', 0.1) },
    { lamps: [], bulbs: [], windows: [], halos: [], clouds: new THREE.MeshBasicMaterial(), street: -4 },
  );
  return { sky, cam: new THREE.PerspectiveCamera() };
}

function hasRingGeometry(root: THREE.Object3D): boolean {
  let found = false;
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.geometry instanceof THREE.RingGeometry) found = true;
  });
  return found;
}

test('Sky breathes subtly with non-calm moods, washes the room softly for events, and pins the baseline while baking', (t) => {
  stubCanvas(t);
  const { sky, cam } = makeSky();
  sky.setMood('calm_planning', true);
  sky.update(0.016, 0, cam);
  assert.equal(sky.moodAnimating, false, 'the calm baseline holds still, so an idle floor can sleep');

  sky.setMood('debugging_tension', true);
  sky.setMoodStakes(1);
  assert.equal(sky.moodAnimating, true, 'tension keeps breathing');
  const fills: number[] = [];
  for (let i = 0; i < 80; i++) {
    sky.update(0.05, i * 0.05, cam);
    fills.push(sky.officeFillLevel);
  }
  const swing = Math.max(...fills) - Math.min(...fills);
  const ratio = swing / Math.max(...fills);
  assert.ok(ratio > 0.12 && ratio < 0.35, `the room light breathes subtly without strobing (${ratio.toFixed(2)} of peak)`);
  let baked = 0;
  const live = sky.officeFillLevel;
  withBaselineOfficeFill(1, () => {
    baked = sky.officeFillLevel;
  });
  assert.ok(baked > 0 && Math.abs(baked - live) > 1e-4, 'probe bakes see the baseline fill, not the tension pulse');
  assert.equal(sky.officeFillLevel, live, 'and the live fill comes back after the bake');
  sky.calmMotion = true;
  sky.update(0.05, 3, cam);
  assert.equal(sky.moodAnimating, false, 'reduced motion stops the breathing pulse');
  sky.calmMotion = false;

  for (const kind of ['convergence', 'collision', 'crisis', 'brainstorm', 'ship_it'] as const) {
    const fx = FLOOR_EVENT_FX[kind];
    sky.flashRoom(fx.hex, 2.6, fx.pulses, 0.55);
    sky.update(0.6, 4, cam);
    assert.ok(sky.roomFlash > 0.2, `${kind} washes the room`);
    assert.equal(sky.moodAnimating, true);
    sky.update(3, 7, cam);
    assert.equal(sky.roomFlash, 0, `${kind} wash ends`);
  }
});

test('VibeFx casts feathered ceiling rays, soft stationary glow pools and shimmering filaments with zero hard rings', () => {
  const fx = new VibeFx();
  assert.equal(fx.enabled, false);
  fx.setEnabled(true);
  assert.equal(fx.enabled, true);

  const kind = 'breakthrough';
  fx.react(MICRO_REACTION_FX[kind].hex, new THREE.Vector3(2, 2, 3), new THREE.Vector3(2, 0, 3));
  assert.equal(fx.group.children.length, 2, 'delicate motes and a soft stationary glow pool');
  assert.ok(!fx.group.children.some((c) => c instanceof THREE.Sprite), 'no in-world emoji sprites');
  assert.equal(hasRingGeometry(fx.group), false, 'no RingGeometry shockwave on reactions');
  assert.equal(fx.update(0.1), true);

  fx.roomWave(new THREE.Vector3(), '#22c55e', [{ id: 'a', head: new THREE.Vector3(10, 2, 0), feet: new THREE.Vector3(10, 0, 0) }]);
  assert.equal(hasRingGeometry(fx.group), false, 'roomWave never casts a hard floor ring');
  for (let i = 0; i < 80; i++) fx.update(0.05);
  assert.equal(fx.group.children.length, 0, 'every transient effect is removed once it has played');

  fx.power(false, new THREE.Vector3());
  assert.equal(fx.group.children.length, 1);
  assert.equal(hasRingGeometry(fx.group), false, 'power-off uses a soft settling pool, not a closing ring');
  fx.power(true, new THREE.Vector3());
  assert.equal(fx.group.children.length, 3);
  assert.equal(hasRingGeometry(fx.group), false, 'power-on casts a ceiling ray and motes, never floor rings');
  let moving = true;
  for (let i = 0; i < 80 && moving; i++) moving = fx.update(0.05);
  assert.equal(moving, false, 'the scene can sleep again once effects finish');
  assert.equal(fx.group.children.length, 0);

  for (const moment of ['hired', 'finished', 'shipped', 'sent_home', 'shot'] as const) {
    const m = DESK_MOMENT_FX[moment];
    fx.deskMoment(m.hex, new THREE.Vector3(0, 2, 0), new THREE.Vector3(), { beam: moment === 'hired' || moment === 'shipped', implode: moment === 'sent_home' || moment === 'shot' });
  }
  assert.equal(hasRingGeometry(fx.group), false, 'desk moments never shoot hard rings across the ground');

  // Verify the ceiling ray spans to WALL_HEIGHT and feathers vertex colors to 0 across width as well
  // as at the floor and ceiling, and its stationary floor glow feathers to 0 at its outer perimeter.
  const beamGroup = fx.group.children.find((c): c is THREE.Group => c instanceof THREE.Group && c.children.length === 2);
  assert.ok(beamGroup, 'hire/shipped casts a feathered ceiling ray group');
  const outerShaft = beamGroup.children[0] as THREE.Mesh;
  const shaftPos = outerShaft.geometry.getAttribute('position') as THREE.BufferAttribute;
  const shaftCol = outerShaft.geometry.getAttribute('color') as THREE.BufferAttribute;
  let maxY = 0;
  let maxMidWeight = 0;
  for (let i = 0; i < shaftPos.count; i++) {
    const y = shaftPos.getY(i);
    const r = Math.hypot(shaftPos.getX(i), shaftPos.getZ(i));
    maxY = Math.max(maxY, y);
    maxMidWeight = Math.max(maxMidWeight, shaftCol.getX(i));
    if (y < 1e-4 || Math.abs(y - WALL_HEIGHT) < 1e-4) {
      assert.ok(shaftCol.getX(i) < 1e-5, 'ray shaft fades completely to zero at floor and ceiling seams');
    }
    const halfW = 0.72 + (0.22 - 0.72) * (y / WALL_HEIGHT);
    if (Math.abs(r - halfW) < 1e-4) {
      assert.ok(shaftCol.getX(i) < 1e-5, 'ray shaft feathers completely to zero at its side edges');
    }
  }
  assert.ok(Math.abs(maxY - WALL_HEIGHT) < 1e-4, 'ceiling ray reaches full wall height');
  assert.ok(maxMidWeight > 0.8, 'ceiling ray has a luminous center core');

  const floorPool = beamGroup.children[1] as THREE.Mesh;
  const poolPos = floorPool.geometry.getAttribute('position') as THREE.BufferAttribute;
  const poolCol = floorPool.geometry.getAttribute('color') as THREE.BufferAttribute;
  assert.ok(poolCol.getX(0) > 0.99, 'floor pool is bright at its center');
  for (let i = 1; i < poolPos.count; i++) {
    const r = Math.hypot(poolPos.getX(i), poolPos.getZ(i));
    if (Math.abs(r - 1) < 1e-4) assert.ok(poolCol.getX(i) < 1e-5, 'floor pool feathers smoothly to zero at its outer edge');
  }

  fx.links(
    [
      [new THREE.Vector3(0, 2, 0), new THREE.Vector3(4, 2, 0)],
      [new THREE.Vector3(4, 2, 0), new THREE.Vector3(8, 2, 2)],
    ],
    FLOOR_EVENT_FX.collision.hex,
  );
  const lines = fx.group.children.filter((c) => c instanceof THREE.Line);
  assert.equal(lines.length, 4, 'two shimmering filaments per pair of desks at odds');
  for (const line of lines) {
    assert.equal((line.material as THREE.Material).depthTest, true, 'filaments respect 3D scene occlusion');
  }
  for (let i = 0; i < 100; i++) fx.update(0.05);
  assert.equal(fx.group.children.length, 0, 'every moment cleans up after itself');

  fx.calmMotion = true;
  fx.power(true, new THREE.Vector3());
  assert.equal(fx.group.children.length, 0, 'reduced motion skips power effects');
  fx.links([[new THREE.Vector3(0, 2, 0), new THREE.Vector3(4, 2, 0)]], '#ff9f1c');
  assert.equal(fx.group.children.length, 0, 'reduced motion skips shimmering links');
  fx.calmMotion = false;
  fx.react('#34d399', new THREE.Vector3(0, 2, 0), new THREE.Vector3());
  fx.clear();
  assert.equal(fx.group.children.length, 0);
});

test('heavenly ascent beam and Living 3D switch avoid hard floor rings', () => {
  const markers = casualtyMarkers();
  assert.equal(hasRingGeometry(markers), false, 'heavenly beam uses a feathered pool without a hard floor rim ring');

  const sw = buildVibesSwitch();
  let floorLevelRings = 0;
  sw.group.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.geometry instanceof THREE.RingGeometry && obj.position.y < 0.1) floorLevelRings++;
  });
  assert.equal(floorLevelRings, 0, 'pedestal switch has no colored ring painted on the floor slab');
});

test('shader warmup covers every Living 3D effect material', () => {
  const { world, hands } = spellStandIns();
  const warmed = new Set([...materialFeatures(world), ...materialFeatures(hands)]);
  const fx = new VibeFx();
  fx.setEnabled(true);
  fx.react('#facc15', new THREE.Vector3(0, 2, 0), new THREE.Vector3());
  fx.deskMoment('#7dd3fc', new THREE.Vector3(0, 2, 0), new THREE.Vector3(), { beam: true });
  fx.links([[new THREE.Vector3(0, 2, 0), new THREE.Vector3(4, 2, 0)]], '#ff9f1c');
  fx.power(true, new THREE.Vector3());
  for (const feature of materialFeatures(fx.group)) assert.ok(warmed.has(feature), feature);
});
