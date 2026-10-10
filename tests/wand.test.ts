import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, test } from 'node:test';
import * as THREE from 'three';
import { READY } from '../src/client/world/gun-motion.js';
import { Hands, WAND_HOLD } from '../src/client/world/hands.js';
import { Confetti } from '../src/client/world/confetti.js';
import { BOLT_SPEED, GRIP_R, GRIP_Z, parseWand, SPELL_CONFETTI, SPELL_HIT, SpellBolt, SpellImpact, Sparkles, TipTrail, WAND_BACK, WAND_SEGMENTS, WAND_TIP, WARD_TIME, Wand, Ward, wandReady } from '../src/client/world/wand.js';
import { CONFETTI_AT, RELEASE_AT, sampleWandMove, WAND_CHANNELS, WAND_MOVES, WAND_READY, WAND_SPELLS, type WandMoveId, WandMotion } from '../src/client/world/wand-motion.js';

const input = { yaw: 0, pitch: 0, walkPhase: 0, walking: false, airborne: false, jitter: 0 };

before(async () => {
  const glb = readFileSync(new URL('../src/client/public/props/wand.glb', import.meta.url));
  await parseWand(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));
});

/** The wand's meshes, without the glows and the light round its tip. */
function body(w: Wand): THREE.Box3 {
  w.group.updateMatrixWorld(true);
  const box = new THREE.Box3();
  w.group.traverse((o) => {
    if (o instanceof THREE.Mesh) box.expandByObject(o);
  });
  return box;
}

test('wand.glb points along +Z, from the pommel behind the fist out to the emitter at the tip', () => {
  assert.ok(wandReady());
  const w = new Wand();
  assert.ok(w.whole);
  const box = body(w);
  assert.ok(Math.abs(box.min.z - WAND_BACK) < 0.003, `pommel at ${box.min.z}`);
  assert.ok(box.max.z > WAND_TIP.z - 0.006 && box.max.z < WAND_TIP.z + 0.004, `tip at ${box.max.z}`);
  const size = box.getSize(new THREE.Vector3());
  assert.ok(size.x < 0.03 && size.y < 0.03, `slim: ${size.x.toFixed(3)} × ${size.y.toFixed(3)}`);
  for (const part of ['wand-shaft', 'wand-grip', 'wand-steel', 'wand-rings', 'wand-rotor', 'wand-core']) assert.ok(w.group.getObjectByName(part), part);
  for (let i = 0; i < WAND_SEGMENTS; i++) assert.ok(w.group.getObjectByName(`wand-segment-${i}`), `segment ${i}`);
  assert.equal(w.group.getObjectByName('wand-rotor')!.parent, w.rotor, 'the rotor turns on its hub');
  w.dispose();
});

test('the grip is a round handle GRIP_R thick between GRIP_Z, the shaft thinner past it', () => {
  const w = new Wand();
  const grip = w.group.getObjectByName('wand-grip') as THREE.Mesh;
  grip.geometry.computeBoundingBox();
  const g = grip.geometry.boundingBox!;
  assert.ok(Math.abs(g.max.x - GRIP_R) < 0.0015 && Math.abs(g.min.y + GRIP_R) < 0.0015, `grip radius ${g.max.x}`);
  assert.ok(g.min.z >= GRIP_Z[0] - 0.002 && g.max.z <= GRIP_Z[1] + 0.002, `grip ${g.min.z} … ${g.max.z}`);
  const shaft = w.group.getObjectByName('wand-shaft') as THREE.Mesh;
  const pos = shaft.geometry.getAttribute('position');
  let widest = 0;
  for (let i = 0; i < pos.count; i++) if (pos.getZ(i) > 0.12) widest = Math.max(widest, Math.hypot(pos.getX(i), pos.getY(i)));
  assert.ok(widest > 0 && widest < GRIP_R * 0.8, `shaft ${widest}`);
  w.dispose();
});

test('the progress bar lights a segment per tenth of charge, and the rotor spins up with the pose', () => {
  assert.equal(Wand.litSegments(0), 0);
  assert.equal(Wand.litSegments(0.5), 5);
  assert.equal(Wand.litSegments(1.4), WAND_SEGMENTS);
  const w = new Wand();
  const lit = () =>
    Array.from({ length: WAND_SEGMENTS }, (_, i) => {
      const m = (w.group.getObjectByName(`wand-segment-${i}`) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial>).material;
      return m.emissive.r > 0.1;
    });
  w.update(1 / 60, { spin: 0, glow: 0, charge: 0.3, lumos: 0 });
  assert.deepEqual(lit(), [true, true, true, false, false, false, false, false, false, false]);
  const idle = w.rotor.rotation.z;
  w.update(0.1, { spin: 0, glow: 0, charge: 0, lumos: 0 });
  const slow = Math.abs(w.rotor.rotation.z - idle);
  const before = w.rotor.rotation.z;
  w.update(0.1, { spin: 1, glow: 1, charge: 1, lumos: 0 });
  assert.ok(Math.abs(w.rotor.rotation.z - before) > slow * 10, 'flat out is far faster than idling');
  assert.ok(lit().every(Boolean));
  w.dispose();
});

test('the wand has six spells, each with a move that starts and ends at the ready', () => {
  assert.equal(WAND_SPELLS.length, 6);
  assert.equal(new Set(WAND_SPELLS.map((s) => s.id)).size, 6);
  assert.ok(WAND_SPELLS.every((s) => s.emoji && s.label && !/gun|cylinder|smoke/i.test(s.label)));
  for (const id of ['cast', ...WAND_SPELLS.map((s) => s.id)] as WandMoveId[]) {
    const move = WAND_MOVES[id];
    const start = sampleWandMove(move, 0);
    const end = sampleWandMove(move, move.seconds);
    for (const c of WAND_CHANNELS) {
      const off = (p: number) => (c === 'twirl' ? Math.abs(Math.sin(p / 2)) : Math.abs(p - WAND_READY[c]));
      assert.ok(off(end[c]) < 1e-3, `${id} ends with ${c} at ${end[c]}`);
      if (id !== 'cast') assert.ok(off(start[c]) < 0.02, `${id} starts with ${c} at ${start[c]}`);
    }
    const times = move.cues.map(([t]) => t);
    assert.deepEqual(
      times,
      [...times].sort((a, b) => a - b),
      `${id}'s cues in order`,
    );
    assert.ok(
      times.every((t) => t >= 0 && t <= move.seconds),
      `${id}'s cues inside it`,
    );
  }
  assert.equal(WAND_MOVES.build.cues.filter(([, c]) => c === 'tick').length, WAND_SEGMENTS, 'one tick per segment');
  const charge = sampleWandMove(WAND_MOVES.build, WAND_MOVES.build.seconds * 0.8).charge;
  assert.ok(charge > 0.9, `the build fills the bar (${charge})`);
});

test('drawing comes up from out of view and boots; a cast releases its bolt RELEASE_AT after the click', () => {
  const m = new WandMotion();
  assert.equal(m.pose, null);
  assert.equal(m.cast(), false, 'nothing to cast with');
  m.draw();
  const cues: string[] = [];
  cues.push(...m.update(0));
  assert.ok(m.pose!.out < 0.05, 'starts down');
  for (let t = 0; t < WAND_MOVES.draw.seconds + 0.05; t += 1 / 60) cues.push(...m.update(1 / 60));
  assert.deepEqual(cues, ['draw', 'whoosh', 'boot', 'ready']);
  assert.equal(m.doing, null);
  assert.deepEqual({ ...m.pose! }, { ...WAND_READY });
  assert.equal(m.cast(), true);
  let t = 0;
  let released = -1;
  while (m.doing === 'cast') {
    t += 1 / 120;
    if (m.update(1 / 120).includes('release')) released = t;
  }
  assert.ok(Math.abs(released - RELEASE_AT) < 1 / 100, `released at ${released}`);
  m.holster();
  assert.equal(m.drawn, false);
  for (let i = 0; i < 60; i++) m.update(1 / 60);
  assert.equal(m.pose, null, 'put away');
  assert.equal(m.spell('lumos'), false);
});

test('a cast takes over a spell at once, from wherever the wand was', () => {
  const m = new WandMotion();
  m.draw();
  for (let i = 0; i < 60; i++) m.update(1 / 60);
  m.spell('sparkler');
  for (let i = 0; i < 20; i++) m.update(1 / 60);
  const mid = { ...m.pose! };
  m.cast();
  m.update(0);
  assert.equal(m.doing, 'cast');
  for (const c of WAND_CHANNELS) {
    if (c === 'twirl') assert.ok(Math.abs(Math.sin((m.pose![c] - mid[c]) / 2)) < 1e-6);
    else assert.ok(Math.abs(m.pose![c] - mid[c]) < 1e-6, `${c} carries on from where it was`);
  }
});

/** A first-person wand at the ready, settled. */
function heldWand(): Hands {
  const hands = new Hands('#333333', '#c08a60');
  hands.setWandPose(WAND_READY);
  for (let i = 0; i < 40; i++) hands.update(1 / 60, i / 60, input);
  hands.scene.updateMatrixWorld(true);
  return hands;
}

/** Where the first-person wand and the arm holding it are, in camera space and on a 16:9 screen. */
function measureHold(hands: Hands) {
  hands.scene.updateMatrixWorld(true);
  hands.camera.aspect = 16 / 9;
  hands.camera.updateProjectionMatrix();
  const wand = hands.scene.getObjectByName('wand')!;
  let arm: THREE.Object3D = wand;
  while (arm.parent && arm.parent !== hands.scene) arm = arm.parent;
  const knuckle = (i: number) => hands.scene.getObjectByName(`glove-finger-${i}-0`)!.parent!.getWorldPosition(new THREE.Vector3());
  const seen = (p: THREE.Vector3) => p.clone().project(hands.camera);
  return {
    dir: hands.wandDir(new THREE.Vector3())!,
    tip: seen(hands.wandTip(new THREE.Vector3())!),
    grip: wand.localToWorld(new THREE.Vector3()),
    gripOnScreen: seen(wand.localToWorld(new THREE.Vector3())),
    /** From the little finger's knuckle to the index finger's. */
    knuckles: knuckle(0).sub(knuckle(3)).normalize(),
    forearm: new THREE.Vector3(0, 0, 1).transformDirection(arm.matrixWorld),
    sleeve: seen(arm.localToWorld(new THREE.Vector3(0, 0, 0.22))),
  };
}

test('at the ready the wand stands up out of a thumb-up fist low on the right, leaning forward', () => {
  const h = measureHold(heldWand());
  assert.ok(h.dir.angleTo(WAND_HOLD.dir) < 0.03, `pointing along WAND_HOLD.dir (off by ${h.dir.angleTo(WAND_HOLD.dir).toFixed(3)} rad)`);
  assert.ok(h.dir.y > 0.75 && h.dir.z < -0.3, `upright and leaning away from you: ${h.dir.toArray().map((n) => n.toFixed(2))}`);
  assert.ok(h.knuckles.y > 0.95, `the knuckles in a line up and down, index on top: ${h.knuckles.y.toFixed(2)}`);
  assert.ok(h.grip.distanceTo(WAND_HOLD.grip) < 0.03, `the grip where WAND_HOLD has it, ${h.grip.distanceTo(WAND_HOLD.grip).toFixed(3)} m off`);
  assert.ok(h.tip.x > 0 && h.tip.x < 0.5 && Math.abs(h.tip.y) < 0.4, `the tip right of the middle at about eye height: ${h.tip.x.toFixed(2)}, ${h.tip.y.toFixed(2)}`);
  assert.ok(h.gripOnScreen.x > h.tip.x && h.gripOnScreen.y < -0.5, 'the fist low on the right, below the tip');
  assert.ok(h.forearm.z > 0.95, 'the forearm running back toward you');
  assert.ok(h.sleeve.y < -1, 'the sleeve off the bottom of the view');
});

test('a cast is a flick of the wrist: the wand snaps forward at the target and the arm stays down', () => {
  const hands = heldWand();
  const ready = measureHold(hands);
  const move = WAND_MOVES.cast;
  let worst = { sleeve: -Infinity, knuckles: 1, forearm: 1 };
  let atRelease: ReturnType<typeof measureHold> | null = null;
  for (let t = 0; t <= move.seconds + 1e-9; t += 1 / 120) {
    hands.setWandPose(sampleWandMove(move, t));
    hands.update(1 / 120, t, input);
    const h = measureHold(hands);
    worst = { sleeve: Math.max(worst.sleeve, h.sleeve.y), knuckles: Math.min(worst.knuckles, h.knuckles.y), forearm: Math.min(worst.forearm, h.forearm.z) };
    if (!atRelease && t >= RELEASE_AT) atRelease = h;
  }
  const r = atRelease!;
  assert.ok(r.dir.z < -0.9 && r.dir.y < 0.4, `at the release the wand points away at the target: ${r.dir.toArray().map((n) => n.toFixed(2))}`);
  assert.ok(r.dir.angleTo(ready.dir) > 0.6, 'a real snap from the ready');
  assert.ok(worst.forearm > 0.9, `the forearm keeps running back toward you (${worst.forearm.toFixed(2)})`);
  assert.ok(worst.sleeve < -0.9, `the sleeve stays at the bottom edge (${worst.sleeve.toFixed(2)})`);
  assert.ok(worst.knuckles > 0.6, `the fist doesn't roll over (${worst.knuckles.toFixed(2)})`);
});

test('the glove closes round the grip: fingers and thumb on it, none through it', () => {
  const hands = heldWand();
  const wand = hands.scene.getObjectByName('wand')!;
  const local = new THREE.Vector3();
  const gaps = new Map<string, number>();
  hands.scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !/^glove-(finger|thumb)/.test(o.name) || !(o.geometry instanceof THREE.CapsuleGeometry)) return;
    let arm: THREE.Object3D = o;
    while (arm.parent && arm.parent !== hands.scene) arm = arm.parent;
    if (!arm.getObjectByName('wand')) return;
    const { radius, height } = o.geometry.parameters;
    o.geometry.computeBoundingBox();
    const box = o.geometry.boundingBox!;
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const axis = size.x > size.y && size.x > size.z ? 'x' : size.y > size.z ? 'y' : 'z';
    let best = Infinity;
    for (let i = 0; i <= 12; i++) {
      const p = c.clone();
      p[axis] += (height / 2) * (i / 6 - 1);
      wand.worldToLocal(local.copy(o.localToWorld(p)));
      if (local.z < GRIP_Z[0] - 0.01 || local.z > GRIP_Z[1] + 0.01) continue;
      best = Math.min(best, Math.hypot(local.x, local.y) - radius - GRIP_R);
    }
    if (best < Infinity) gaps.set(o.name, best);
  });
  assert.ok(gaps.size >= 8, `${gaps.size} glove bones by the grip`);
  for (const [name, gap] of gaps) assert.ok(gap > -0.0015, `${name} is ${(-gap * 1000).toFixed(1)} mm into the grip`);
  for (let f = 0; f < 4; f++) {
    const touch = Math.min(...[0, 1, 2].map((j) => gaps.get(`glove-finger-${f}-${j}`) ?? Infinity));
    assert.ok(touch < 0.003, `finger ${f} round the grip (${(touch * 1000).toFixed(1)} mm off it)`);
  }
});

test('your hands hold the wand or the magnum, and put either away', () => {
  const hands = new Hands('#4f86f7', '#f1c27d');
  const held = () => {
    let name = '';
    hands.scene.traverse((o) => {
      if (o.name === 'wand' || o.name === 'magnum') name = o.name;
    });
    return name;
  };
  hands.setWandPose(WAND_READY);
  assert.equal(held(), 'wand');
  assert.ok(hands.wandTip(new THREE.Vector3()));
  assert.equal(hands.muzzleTip(new THREE.Vector3()), null);
  hands.setLumos(true);
  for (let i = 0; i < 30; i++) hands.update(1 / 60, i / 60, input);
  assert.ok(hands.lumos > 0.9, 'Lumos comes up');
  hands.setWandPose(null);
  assert.equal(held(), '');
  assert.equal(hands.lumos, 0, 'and goes out with the wand away');
  hands.setGunPose(READY);
  assert.equal(held(), 'magnum');
  assert.ok(hands.muzzleTip(new THREE.Vector3()));
  assert.equal(hands.wandTip(new THREE.Vector3()), null);
  hands.setGunPose(null);
  assert.equal(held(), '');
});

test('sparkles burst, drift up and fade away', () => {
  const s = new Sparkles(new THREE.Vector3(1, 1, 1), new THREE.Vector3(0, 0, 1), { colors: SPELL_HIT, count: 6, seconds: 0.5 });
  assert.equal(s.group.children.length, 6);
  assert.deepEqual(s.group.position.toArray(), [1, 1, 1]);
  let frames = 0;
  while (s.update(1 / 60)) frames++;
  assert.ok(frames >= 28 && frames <= 31, `${frames} frames`);
  const mesh = s.group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  assert.equal(mesh.material.opacity, 0);
  s.dispose();
});

test('a spell bolt flies from the tip at BOLT_SPEED, lands once, then its tail fades', () => {
  const from = new THREE.Vector3(0, 1.4, 0);
  const to = new THREE.Vector3(0, 1, -6);
  let landed = 0;
  const bolt = new SpellBolt(from, to, () => landed++);
  assert.ok(Math.abs(bolt.flight - from.distanceTo(to) / BOLT_SPEED) < 1e-9);
  let t = 0;
  let landedAt = -1;
  while (bolt.update(1 / 120)) {
    t += 1 / 120;
    if (bolt.landed && landedAt < 0) landedAt = t;
  }
  assert.equal(landed, 1);
  assert.ok(Math.abs(landedAt - bolt.flight) < 1 / 60, `landed at ${landedAt}`);
  assert.ok(t > bolt.flight && t < bolt.flight + 0.4, 'the tail fades soon after');
  bolt.dispose();
});

test('a spell marks what it lands on with the glyph, flat on the surface, and fades', () => {
  const impact = new SpellImpact(new THREE.Vector3(2, 1, -3), new THREE.Vector3(0, 0, 1), true);
  const mark = impact.group.children[0];
  assert.ok(Math.abs(mark.position.z - -3) < 0.01 && mark.position.z > -3, 'just off the wall');
  assert.ok(new THREE.Vector3(0, 0, 1).applyQuaternion(mark.quaternion).distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-6, 'facing out of it');
  let frames = 0;
  while (impact.update(1 / 60)) frames++;
  assert.ok(frames > 30 && frames < 70, `${frames} frames`);
  impact.dispose();
});

test('the sparkler and Ship it keep the tip in front of your eyes, where you see their magic', () => {
  for (const id of ['sparkler', 'ship'] as const) {
    const hands = heldWand();
    const move = WAND_MOVES[id];
    const magic = move.cues.filter(([, c]) => c === 'spark' || c === 'confetti').map(([t]) => t);
    assert.ok(magic.length > 0, `${id} does something`);
    for (const t of magic) {
      hands.setWandPose(sampleWandMove(move, t));
      hands.update(1 / 120, t, input);
      const { tip } = measureHold(hands);
      assert.ok(Math.abs(tip.x) < 0.8 && Math.abs(tip.y) < 0.8, `${id}'s tip on screen at ${t.toFixed(2)} s: ${tip.x.toFixed(2)}, ${tip.y.toFixed(2)}`);
    }
  }
  assert.ok(WAND_MOVES.sparkler.cues.filter(([, c]) => c === 'spark').length >= 10, 'the sparkler keeps spitting');
  assert.deepEqual(
    WAND_MOVES.ship.cues.filter(([, c]) => c === 'confetti').map(([t]) => t),
    [CONFETTI_AT],
  );
});

test('confetti sprayed along a direction flies that way, then falls and lands', () => {
  const confetti = new Confetti(() => 0);
  confetti.spray(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(0, 0.3, -1), 40, SPELL_CONFETTI);
  assert.equal(confetti.count, 40);
  for (let i = 0; i < 30; i++) confetti.update(1 / 60);
  const at = new THREE.Vector3();
  const m = new THREE.Matrix4();
  let ahead = 0;
  for (let i = 0; i < 40; i++) {
    confetti.mesh.getMatrixAt(i, m);
    if (at.setFromMatrixPosition(m).z < -0.5) ahead++;
  }
  assert.ok(ahead > 35, `${ahead} of 40 out in front after half a second`);
  // Every bit lives at least 4 s, so all of them are still there.
  for (let i = 0; i < 180; i++) confetti.update(1 / 60);
  let down = 0;
  for (let i = 0; i < 40; i++) {
    confetti.mesh.getMatrixAt(i, m);
    if (Math.abs(at.setFromMatrixPosition(m).y - 0.01) < 1e-6) down++;
  }
  assert.ok(down > 35, `${down} of 40 on the floor after 3.5 s`);
});

test('the tip leaves a trail of light only while a move asks for one, and it fades', () => {
  const trail = new TipTrail();
  trail.emit(new THREE.Vector3(0, 0, 0), 0);
  trail.update(1 / 60);
  assert.equal(trail.glowing, 0);
  for (let i = 0; i < 10; i++) {
    trail.emit(new THREE.Vector3(i * 0.02, 0, 0), 1);
    trail.update(1 / 60);
  }
  assert.ok(trail.glowing > 10 && trail.points.visible);
  for (let i = 0; i < 60; i++) trail.update(1 / 60);
  assert.equal(trail.glowing, 0);
  assert.equal(trail.points.visible, false);
});

test('Protego holds a ward in front of your eyes for WARD_TIME', () => {
  const ward = new Ward();
  assert.ok(ward.group.position.z < -0.5, 'in front of you');
  let t = 0;
  while (ward.update(1 / 60)) t += 1 / 60;
  assert.ok(Math.abs(t - WARD_TIME) < 0.05, `${t}`);
  ward.dispose();
});
