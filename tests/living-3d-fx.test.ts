import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { materialFeatures, spellStandIns } from '../src/client/shader-warmup.js';
import { Sky, withBaselineOfficeFill } from '../src/client/world/sky.js';
import { VibeFx } from '../src/client/world/vibe-fx.js';
import { DESK_MOMENT_FX, FLOOR_EVENT_FX, MICRO_REACTION_FX } from '../src/shared/gemini-vibes.js';

/** Canvas 2D calls the text sprites make, recorded as no-ops so they run under Node. */
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

test('VibeFx rings follow graded workers, flare on reactions, and fold away when Living 3D switches off', (t) => {
  stubCanvas(t);
  const fx = new VibeFx();
  fx.setAura('a', true, 'emerald', 'flow', 0.8);
  assert.equal(fx.auraCount, 0, 'no rings while Living 3D is off');
  fx.setEnabled(true);
  fx.setAura('a', true, 'emerald', 'flow', 0.8);
  fx.setAura('b', true, 'neutral', 'investigating', 0.2);
  fx.setAura('c', false, 'neutral', 'steady', 0.5);
  fx.follow('a', new THREE.Vector3(2, 0, 3));
  for (let i = 0; i < 30; i++) fx.update(0.05);
  assert.equal(fx.auraCount, 2, 'only graded workers get a ring');
  const ringA = fx.group.children.find((g) => g.position.x === 2);
  assert.ok(ringA, 'the ring sits under its worker');
  assert.ok(ringA.position.y > 0 && ringA.position.y < 0.05, 'just above the floor');

  const before = fx.group.children.length;
  const kind = 'breakthrough';
  fx.react('a', MICRO_REACTION_FX[kind].glyph, MICRO_REACTION_FX[kind].hex, new THREE.Vector3(2, 2, 3), new THREE.Vector3(2, 0, 3));
  assert.ok(fx.group.children.length >= before + 3, 'an emoji, sparks and a shockwave');
  assert.equal(fx.update(0.1), true);
  fx.roomWave(new THREE.Vector3(), '#22c55e', [{ id: 'a', head: new THREE.Vector3(10, 2, 0), feet: new THREE.Vector3(10, 0, 0) }], '✅');
  for (let i = 0; i < 80; i++) fx.update(0.05);
  assert.equal(fx.group.children.length, 2, 'every transient effect is removed once it has played');

  fx.power(false, new THREE.Vector3());
  fx.setEnabled(false);
  let moving = true;
  for (let i = 0; i < 80 && moving; i++) moving = fx.update(0.05);
  assert.equal(moving, false, 'the scene can sleep again once the rings have faded');
  assert.equal(fx.auraCount, 0);
  assert.equal(fx.group.children.length, 0, 'switched off, the rings are dropped');

  fx.setEnabled(true);
  fx.setAura('a', true, 'crimson', 'struggling', 1);
  fx.power(true, new THREE.Vector3());
  fx.calmMotion = true;
  for (let i = 0; i < 40; i++) fx.update(0.05);
  assert.equal(fx.auraCount, 1);
  fx.clear();
  assert.equal(fx.group.children.length, 0);
});

test('shader warmup covers every Living 3D effect material', (t) => {
  stubCanvas(t);
  const { world, hands } = spellStandIns();
  const warmed = new Set([...materialFeatures(world), ...materialFeatures(hands)]);
  const fx = new VibeFx();
  fx.setEnabled(true);
  fx.setAura('a', true, 'amber', 'deliberating', 0.5, 0.6);
  fx.update(0.05);
  fx.react('a', '💡', '#facc15', new THREE.Vector3(0, 2, 0), new THREE.Vector3());
  fx.deskMoment('a', '👋', '#7dd3fc', new THREE.Vector3(0, 2, 0), new THREE.Vector3(), { beam: true });
  fx.links([[new THREE.Vector3(0, 2, 0), new THREE.Vector3(4, 2, 0)]], '#ff9f1c');
  fx.power(true, new THREE.Vector3());
  for (const feature of materialFeatures(fx.group)) assert.ok(warmed.has(feature), feature);
});

test('VibeFx draws progress arcs, plays desk moments, crackles between desks and lets a departed ring fade', (t) => {
  stubCanvas(t);
  const fx = new VibeFx();
  fx.setEnabled(true);
  fx.setAura('a', true, 'emerald', 'flow', 0.6, 0.75);
  fx.setAura('b', true, 'amber', 'struggling', 0.9, 0);
  for (let i = 0; i < 200; i++) fx.update(0.05);
  assert.ok(Math.abs(fx.progressOf('a') - 0.75) < 0.01, `the arc fills to how far through its task it is (${fx.progressOf('a')})`);
  assert.equal(fx.progressOf('b'), 0, 'no arc without a progress grade');
  fx.setAura('a', true, 'emerald', 'flow', 0.6, 1);
  for (let i = 0; i < 200; i++) fx.update(0.05);
  assert.ok(fx.progressOf('a') > 0.99, 'and grows as it finishes');

  const settled = fx.group.children.length;
  for (const kind of ['hired', 'finished', 'shipped', 'sent_home', 'shot'] as const) {
    const m = DESK_MOMENT_FX[kind];
    fx.deskMoment('a', m.glyph, m.hex, new THREE.Vector3(0, 2, 0), new THREE.Vector3(), { beam: kind === 'hired', implode: kind === 'sent_home' || kind === 'shot' });
  }
  assert.ok(fx.group.children.length >= settled + 5 * 3 + 1, 'each moment adds an emoji, sparks and a shockwave, and a hire a beam');
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
  assert.equal(fx.group.children.length, settled, 'every moment cleans up after itself');

  fx.release('b');
  assert.equal(fx.auraCount, 1, 'a worker that left loses its ring at once in the count');
  for (let i = 0; i < 120; i++) fx.update(0.05);
  assert.equal(fx.group.children.length, settled - 1, 'and the faded ring is dropped while Living 3D stays on');
});
