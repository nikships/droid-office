import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { OfficeSound } from '../src/client/sound.js';
import { GunMotion } from '../src/client/world/gun-motion.js';
import { Muzzle } from '../src/client/world/gun.js';
import { SUPER_RELEASE_AT, WAND_CHANNELS, WAND_MOVES, WAND_READY, WandMotion, sampleWandMove } from '../src/client/world/wand-motion.js';
import { SpellBolt, SpellImpact } from '../src/client/world/wand.js';
import { materialFeatures, spellStandIns } from '../src/client/shader-warmup.js';
import { SidearmCharge, SHOT_CHARGE_MS } from '../src/client/sidearm-charge.js';

test('a tap is normal, a full hold is charged, and neither holding nor cancellation fires a shot', () => {
  const charge = new SidearmCharge();
  assert.equal(charge.release(0), null);
  assert.equal(charge.begin(100), true);
  assert.equal(charge.begin(200), false, 'repeated pointerdown cannot reset the charge');
  assert.deepEqual(charge.release(100 + SHOT_CHARGE_MS - 1), { superShot: false });
  charge.begin(1000);
  assert.equal(charge.progress(1000 + SHOT_CHARGE_MS), 1);
  assert.equal(charge.held, true, 'full charge waits for release');
  assert.deepEqual(charge.release(1000 + SHOT_CHARGE_MS), { superShot: true });
  assert.equal(charge.release(10000), null, 'one release fires once');
  charge.begin(2000);
  assert.equal(charge.progress(1000), 0);
  charge.cancel();
  assert.equal(charge.held, false);
  assert.equal(charge.progress(20000), 0);
  assert.equal(charge.release(20000), null, 'blur, holstering and dialogs discard the charge');
});

test('the Magnum super shot has a stronger, longer recoil that settles and never leaks into a normal shot', () => {
  const normal = new GunMotion();
  const heavy = new GunMotion();
  for (const motion of [normal, heavy]) {
    motion.draw();
    motion.update(1);
    motion.trick('inspect');
    motion.update(0.5);
  }
  normal.fire();
  heavy.fire(true);
  normal.update(0);
  heavy.update(0);
  assert.ok(heavy.pose!.kick > normal.pose!.kick * 1.7);
  for (let i = 0; i < 18; i++) {
    normal.update(1 / 60);
    heavy.update(1 / 60);
  }
  assert.equal(normal.pose!.kick, 0);
  assert.ok(heavy.pose!.kick > 0);
  heavy.update(0.2);
  heavy.update(0);
  assert.equal(heavy.pose!.kick, 0);
  assert.equal(heavy.pose!.roll, 0);
  heavy.fire();
  heavy.update(0);
  assert.equal(heavy.pose!.kick, 1);
  assert.equal(heavy.pose!.roll, 0);
});

test('the Magnum pressure rings are exclusive to the super shot and reset on the next normal shot', () => {
  const muzzle = new Muzzle();
  const rings = muzzle.group.children.filter((object) => object.name === 'super-shot-pressure-ring') as THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[];
  assert.equal(rings.length, 2);
  muzzle.fire();
  assert.ok(rings.every((ring) => ring.material.opacity === 0));
  const normalSize = muzzle.group.scale.x;
  muzzle.fire(true);
  assert.ok(muzzle.group.scale.x > normalSize * 1.7);
  assert.ok(rings.some((ring) => ring.material.opacity > 0));
  muzzle.update(0);
  muzzle.update(0.12);
  assert.equal(muzzle.lit, true);
  assert.ok(rings[0].position.z > 0.2, 'the pressure front travels along the barrel, +z');
  const size = rings[0].scale.x;
  muzzle.update(0.04);
  assert.ok(rings[0].scale.x > size, 'the pressure front expands as it travels');
  muzzle.fire();
  assert.ok(rings.every((ring) => ring.material.opacity === 0));
  assert.equal(muzzle.group.scale.x, normalSize);
  muzzle.update(0);
  muzzle.update(1);
  assert.equal(muzzle.lit, false);
  muzzle.dispose();
});

test('the wand coils before its super release, emits exactly once, and cancels cleanly into normal casts or holstering', () => {
  const m = new WandMotion();
  assert.equal(m.cast(true), false);
  m.draw();
  m.update(1);
  m.charge(1);
  assert.deepEqual(m.update(1), [], 'a held full charge never releases by itself');
  assert.equal(m.pose!.charge, 1);
  assert.ok(m.pose!.z > 0, 'coiled back while held');
  m.cast(true);
  assert.equal(m.doing, 'super');
  assert.deepEqual(m.update(SUPER_RELEASE_AT - 0.001), []);
  assert.ok(m.pose!.charge > 0.99);
  assert.deepEqual(m.update(0.002), ['superRelease']);
  assert.ok(m.pose!.glow > 1.5);
  assert.deepEqual(m.update(1), []);
  for (const c of WAND_CHANNELS) assert.equal(m.pose![c], WAND_READY[c], c);
  const coil = sampleWandMove(WAND_MOVES.super, 0);
  const release = sampleWandMove(WAND_MOVES.super, SUPER_RELEASE_AT);
  assert.ok(coil.z > 0 && release.z < -0.1, 'pull back, then thrust forward');
  m.cast(true);
  m.update(0.03);
  m.cast();
  assert.deepEqual(m.update(0.3), ['charge', 'release'], 'no stale super release after cancellation');
  m.cast(true);
  m.update(0.03);
  m.holster();
  assert.ok(!m.update(1).includes('superRelease'));
  assert.equal(m.pose, null);
});

test('the super bolt has two gold helical strands, lands once, and the crowned impact fades completely', () => {
  let hits = 0;
  const from = new THREE.Vector3();
  const to = new THREE.Vector3(0, 0, -6);
  const normal = new SpellBolt(from, to);
  const bolt = new SpellBolt(from, to, () => hits++, true);
  assert.ok(bolt.group.children.length > normal.group.children.length);
  assert.equal(bolt.flight, normal.flight, 'the brighter effect adds no extra flight delay');
  bolt.update(bolt.flight / 2);
  assert.ok(
    bolt.group.children.some((object) => Math.abs(object.position.x) > 0.01),
    'spiral leaves the centerline',
  );
  assert.ok(
    bolt.group.children.some((object) => object.position.z < -2.5),
    'flies toward the target, not back at the player',
  );
  bolt.update(bolt.flight);
  bolt.update(0.1);
  assert.equal(hits, 1);
  assert.equal(bolt.update(1), false);
  const impact = new SpellImpact(to, new THREE.Vector3(0, 0, 1), true, true);
  assert.ok(impact.group.getObjectByName('super-spell-crown'));
  assert.equal(impact.update(0.4), true);
  assert.equal(impact.update(2), false);
  impact.dispose();
  bolt.dispose();
  normal.dispose();
});

test('the shader warm-up covers the super muzzle, helical bolt and crowned impact', () => {
  const { world, hands } = spellStandIns();
  const features = new Set([...materialFeatures(world), ...materialFeatures(hands)]);
  const muzzle = new Muzzle();
  muzzle.fire(true);
  const bolt = new SpellBolt(new THREE.Vector3(), new THREE.Vector3(0, 0, -3), undefined, true);
  const impact = new SpellImpact(new THREE.Vector3(), new THREE.Vector3(0, 1, 0), true, true);
  assert.ok(world.getObjectByName('super-spell-crown'));
  assert.ok(hands.getObjectByName('super-shot-pressure-ring'));
  for (const effect of [muzzle, bolt, impact]) {
    for (const feature of materialFeatures(effect.group)) assert.ok(features.has(feature), feature);
    effect.dispose();
  }
});

/** Records real synthesis scheduling without needing an audio device in CI. */
function audio() {
  const nodes: ReturnType<typeof node>[] = [];
  const param = () => ({
    value: 0,
    events: [] as { value: number; at: number }[],
    setValueAtTime(value: number, at: number) {
      this.events.push({ value, at });
    },
    exponentialRampToValueAtTime(value: number, at: number) {
      this.events.push({ value, at });
    },
    linearRampToValueAtTime(value: number, at: number) {
      this.events.push({ value, at });
    },
    cancelScheduledValues() {},
  });
  function node(kind: string) {
    const n = {
      kind,
      type: '',
      gain: param(),
      frequency: param(),
      Q: param(),
      positionX: param(),
      positionY: param(),
      positionZ: param(),
      outputs: [] as unknown[],
      started: -1,
      stopped: -1,
      connect(next: unknown) {
        this.outputs.push(next);
        return next;
      },
      start(at: number) {
        this.started = at;
      },
      stop(at: number) {
        this.stopped = at;
      },
    };
    nodes.push(n);
    return n;
  }
  const ambience = node('bus');
  const ctx = {
    state: 'running',
    currentTime: 5,
    createGain: () => node('gain'),
    createOscillator: () => node('oscillator'),
    createBufferSource: () => node('noise'),
    createBiquadFilter: () => node('filter'),
    createPanner: () => node('panner'),
  };
  const sound = Object.assign(Object.create(OfficeSound.prototype), { ctx, ambience, buf: { white: {}, brown: {} }, played: {} }) as OfficeSound;
  return { sound, nodes, ambience };
}

test('super-shot audio has distinct voices, finite tails and routes through the existing volume bus', () => {
  const normal = audio();
  const heavy = audio();
  normal.sound.gunshot();
  heavy.sound.gunshot(true);
  assert.equal(heavy.sound.played.gunSuperShot, 1);
  assert.equal(heavy.sound.played.gunshot, undefined, 'not two stacked normal reports');
  assert.ok(
    heavy.nodes.some((n) => n.kind === 'oscillator' && n.frequency.events[0]?.value === 92),
    'a dedicated sub-bass body',
  );
  assert.ok(heavy.nodes.length > normal.nodes.length);
  const magic = audio();
  const stopCharge = magic.sound.sidearmCharge(true);
  stopCharge();
  stopCharge();
  magic.sound.wandCue('superRelease');
  magic.sound.spellHit({ x: 1, y: 2, z: 3 }, true);
  magic.sound.fizzle({ x: 1, y: 2, z: 3 }, true);
  assert.equal(magic.sound.played.wandChargeHold, 1);
  assert.equal(magic.sound.played.wandSuperRelease, 1);
  assert.equal(magic.sound.played.superSpellHit, 1);
  assert.equal(magic.sound.played.wandZap, undefined);
  for (const graph of [heavy, magic]) {
    for (const source of graph.nodes.filter((n) => n.started >= 0)) {
      assert.ok(source.stopped > source.started && source.stopped < 7, 'every voice stops within two seconds');
      const reachesBus = (n: (typeof graph.nodes)[number]): boolean => n === graph.ambience || n.outputs.some((out) => reachesBus(out as typeof n));
      assert.ok(reachesBus(source), 'muting the office silences every layer');
    }
  }
});
