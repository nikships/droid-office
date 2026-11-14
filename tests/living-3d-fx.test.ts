import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { materialFeatures, spellStandIns } from '../src/client/shader-warmup.js';
import { Sky, withBaselineOfficeFill } from '../src/client/world/sky.js';
import { VibeFx } from '../src/client/world/vibe-fx.js';
import { DESK_MOMENT_FX, FLOOR_EVENT_FX, MICRO_REACTION_FX } from '../src/shared/gemini-vibes.js';

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

test('Sky breathes with non-calm moods, flashes the room for events, and pins the baseline while baking', (t) => {
  stubCanvas(t);
  const { sky, cam } = makeSky();
  sky.setMood('calm_planning', true);
  sky.update(0.016, 0, cam);
  assert.equal(sky.moodAnimating, false, 'the calm baseline holds still, so an idle floor can sleep');

  sky.setMood('debugging_tension', true);
  sky.setMoodStakes(1);
  assert.equal(sky.moodAnimating, true, 'tension keeps breathing');
  const fills: number[] = [];
  for (let i = 0; i < 40; i++) {
    sky.update(0.05, i * 0.05, cam);
    fills.push(sky.officeFillLevel);
  }
  const swing = Math.max(...fills) - Math.min(...fills);
  assert.ok(swing / Math.max(...fills) > 0.3, `the room light visibly breathes (${(swing / Math.max(...fills)).toFixed(2)} of its peak)`);
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
    sky.flashRoom(fx.hex, 2.6, fx.pulses, 1.7);
    sky.update(0.6, 4, cam);
    assert.ok(sky.roomFlash > 0.2, `${kind} lights the room`);
    assert.equal(sky.moodAnimating, true);
    sky.update(3, 7, cam);
    assert.equal(sky.roomFlash, 0, `${kind} flash ends`);
  }
});

test('VibeFx plays reactions, desk moments, crackling links and room waves without persistent floor rings or emoji sprites', () => {
  const fx = new VibeFx();
  assert.equal(fx.enabled, false);
  fx.setEnabled(true);
  assert.equal(fx.enabled, true);

  const kind = 'breakthrough';
  fx.react(MICRO_REACTION_FX[kind].hex, new THREE.Vector3(2, 2, 3), new THREE.Vector3(2, 0, 3));
  assert.equal(fx.group.children.length, 2, 'sparks and a shockwave, without a sprite');
  assert.equal(
    fx.group.children.some((c) => c instanceof THREE.Sprite),
    false,
    'no in-world emoji sprites',
  );
  assert.equal(fx.update(0.1), true);
  fx.roomWave(new THREE.Vector3(), '#22c55e', [{ id: 'a', head: new THREE.Vector3(10, 2, 0), feet: new THREE.Vector3(10, 0, 0) }]);
  for (let i = 0; i < 80; i++) fx.update(0.05);
  assert.equal(fx.group.children.length, 0, 'every transient effect is removed once it has played');

  fx.power(false, new THREE.Vector3());
  assert.equal(fx.group.children.length, 1);
  fx.power(true, new THREE.Vector3());
  assert.equal(fx.group.children.length, 3);
  let moving = true;
  for (let i = 0; i < 80 && moving; i++) moving = fx.update(0.05);
  assert.equal(moving, false, 'the scene can sleep again once effects finish');
  assert.equal(fx.group.children.length, 0);

  for (const moment of ['hired', 'finished', 'shipped', 'sent_home', 'shot'] as const) {
    const m = DESK_MOMENT_FX[moment];
    fx.deskMoment(m.hex, new THREE.Vector3(0, 2, 0), new THREE.Vector3(), { beam: moment === 'hired', implode: moment === 'sent_home' || moment === 'shot' });
  }
  assert.equal(fx.group.children.length, 5 * 2 + 1, 'each moment adds sparks and a shockwave, and a hire adds a beam');
  fx.links(
    [
      [new THREE.Vector3(0, 2, 0), new THREE.Vector3(4, 2, 0)],
      [new THREE.Vector3(4, 2, 0), new THREE.Vector3(8, 2, 2)],
    ],
    FLOOR_EVENT_FX.collision.hex,
  );
  const lines = fx.group.children.filter((c) => c instanceof THREE.Line);
  assert.equal(lines.length, 4, 'two crackling strands per pair of desks at odds');
  for (let i = 0; i < 100; i++) fx.update(0.05);
  assert.equal(fx.group.children.length, 0, 'every moment cleans up after itself');

  fx.calmMotion = true;
  fx.power(true, new THREE.Vector3());
  assert.equal(fx.group.children.length, 0, 'reduced motion skips power shockwaves');
  fx.links([[new THREE.Vector3(0, 2, 0), new THREE.Vector3(4, 2, 0)]], '#ff9f1c');
  assert.equal(fx.group.children.length, 0, 'reduced motion skips crackling links');
  fx.calmMotion = false;
  fx.react('#34d399', new THREE.Vector3(0, 2, 0), new THREE.Vector3());
  fx.clear();
  assert.equal(fx.group.children.length, 0);
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
