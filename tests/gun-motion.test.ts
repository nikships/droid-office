import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUN_CHANNELS, GUN_MOVES, GUN_TRICKS, GunMotion, HOLSTERED, READY, sampleMove, type GunChannel, type GunCue, type GunPose } from '../src/client/world/gun-motion.js';

const FRAME = 1 / 60;
const TAU = Math.PI * 2;
const ANGLES: Partial<Record<GunChannel, number>> = { spin: TAU, turn: TAU, tilt: TAU, cylinder: Math.PI / 3 };

/** How far apart two poses are on a channel, counting whole turns of an angle as no distance. */
function apart(a: number, b: number, c: GunChannel): number {
  const period = ANGLES[c];
  const d = a - b;
  return period ? Math.abs(d - period * Math.round(d / period)) : Math.abs(d);
}

function assertPose(actual: Readonly<GunPose>, expected: Readonly<GunPose>, what: string) {
  for (const c of GUN_CHANNELS) assert.ok(apart(actual[c], expected[c], c) < 1e-6, `${what}: ${c} is ${actual[c]}, not ${expected[c]}`);
}

function run(m: GunMotion, seconds: number): GunCue[] {
  const cues: GunCue[] = [];
  for (let t = 0; t < seconds - 1e-9; t += FRAME) cues.push(...m.update(FRAME));
  return cues;
}

test('every trick starts on the ready pose and ends back on it, whole turns round at most', () => {
  for (const { id } of GUN_TRICKS) {
    const move = GUN_MOVES[id];
    assertPose(sampleMove(move, 0), READY, `${id} at the start`);
    assertPose(sampleMove(move, move.seconds), READY, `${id} at the end`);
    for (const [at] of move.cues) assert.ok(at >= 0 && at <= move.seconds, `${id}'s cues fall inside it`);
  }
});

test('the draw comes up out of the holster to the ready; the holster goes back down into it', () => {
  const away = sampleMove(GUN_MOVES.holster, GUN_MOVES.holster.seconds);
  assert.equal(away.out, HOLSTERED.out, 'the holster ends in the holster');
  assertPose(sampleMove(GUN_MOVES.draw, 0), away, 'the draw picks up where the holster left it');
  assertPose(sampleMove(GUN_MOVES.draw, GUN_MOVES.draw.seconds), READY, 'the draw at the ready');
  assertPose(sampleMove(GUN_MOVES.holster, 0), READY, 'the holster from the ready');
});

test('drawing it plays the draw with its sounds and settles at the ready; holstering it puts it away', () => {
  const m = new GunMotion();
  assert.equal(m.pose, null);
  m.draw();
  assert.equal(m.drawn, true);
  const drawCues = run(m, 0.1);
  assert.equal(m.doing, 'draw');
  assert.ok(m.pose && m.pose.out < 1, 'still on its way up');
  drawCues.push(...run(m, 0.6));
  assert.equal(m.doing, null);
  assertPose(m.pose!, READY, 'drawn');
  assert.deepEqual(drawCues, ['draw', 'whoosh', 'catch', 'cock']);
  m.holster();
  assert.equal(m.drawn, false);
  assert.ok(m.pose, 'the gun stays in hand while it goes back in');
  const holsterCues = run(m, 0.6);
  assert.equal(m.pose, null);
  assert.ok(holsterCues.includes('holster'));
});

test('mashing 7 takes over at once every time, with no jump in the hand', () => {
  const m = new GunMotion();
  m.draw();
  let last: GunPose | null = null;
  const presses = [0.08, 0.15, 0.21, 0.3, 0.33, 0.5, 0.52, 0.9];
  for (let frame = 0, t = 0; t < 1.6; frame++, t += FRAME) {
    if (presses.some((p) => Math.abs(p - t) < FRAME / 2)) {
      if (m.drawn) m.holster();
      else m.draw();
    }
    m.update(FRAME);
    const pose = m.pose;
    if (pose && last) {
      // The finger is out or in (the holders show one or the other), so it may flip in a frame.
      for (const c of GUN_CHANNELS.filter((c) => c !== 'finger')) {
        const most = ANGLES[c] ? 0.9 : 0.25;
        assert.ok(apart(pose[c], last[c], c) < most, `frame ${frame}: ${c} jumped from ${last[c]} to ${pose[c]}`);
      }
    }
    last = pose ? { ...pose } : null;
  }
});

test('tricks only play with the gun drawn, and a trick key mid-trick starts it again', () => {
  const m = new GunMotion();
  assert.equal(m.trick('twirl'), false, 'not with it in the holster');
  m.draw();
  run(m, 0.7);
  for (const { id } of GUN_TRICKS) {
    assert.equal(m.trick(id), true);
    assert.equal(m.doing, id);
    run(m, GUN_MOVES[id].seconds + 0.05);
    assert.equal(m.doing, null, `${id} finishes`);
    assertPose(m.pose!, READY, `after ${id}`);
  }
  m.trick('toss');
  run(m, 0.5);
  const high = m.pose!.lift;
  m.trick('toss');
  assert.equal(m.doing, 'toss');
  run(m, 0.05);
  assert.ok(m.pose!.lift < high, 'again from the top: caught out of the air and brought back down');
  run(m, 0.1);
  assert.ok(m.pose!.lift < 1e-9, 'back in the hand for the next flick');
  m.holster();
  assert.equal(m.trick('inspect'), false, 'not on its way back into the holster');
});

test('a shot cuts a trick short: the gun snaps back to the ready and kicks', () => {
  const m = new GunMotion();
  m.draw();
  run(m, 0.7);
  m.trick('inspect');
  run(m, 1.2);
  assert.ok(m.pose!.yaw > 0.5, 'turned to show its side');
  m.fire();
  m.update(FRAME);
  assert.ok(m.pose!.kick > 0.9, 'the shot kicks at once');
  run(m, 0.1);
  assert.equal(m.doing, null);
  assert.ok(Math.abs(m.pose!.yaw) < 1e-9 && Math.abs(m.pose!.tilt) < 1e-9, 'back at the ready within a tenth of a second');
  run(m, 0.2);
  assert.equal(m.pose!.kick, 0, 'and the recoil is over');
});

test('the cylinder swings out, spins and is slammed shut on a chamber', () => {
  const move = GUN_MOVES.cylinder;
  const open = sampleMove(move, 1.0);
  assert.ok(open.crane > 0.99, 'swung out while it spins');
  assert.ok(open.roll > 0.3, 'canted over so it falls out to the left');
  const turns = sampleMove(move, 1.6).cylinder;
  assert.ok(turns >= TAU * 2, 'spun a few times round');
  assert.ok(apart(turns, 0, 'cylinder') < 1e-9, 'stopping on a chamber');
  assert.equal(sampleMove(move, 1.8).crane, 0, 'shut by the end of the flick');
  assert.ok(sampleMove(move, 0.55).left > 0.9, 'the left hand comes in to spin it');
});

test('the toss flies up end over end and lands back in the hand on a whole turn', () => {
  const move = GUN_MOVES.toss;
  let top = 0;
  for (let t = 0; t <= move.seconds; t += FRAME) top = Math.max(top, sampleMove(move, t).lift);
  assert.ok(top > 0.3, 'well up out of the hand');
  const caught = sampleMove(move, 1.2);
  assert.equal(caught.lift, 0);
  assert.ok(Math.abs(caught.spin) >= TAU * 2 - 1e-9 && apart(caught.spin, 0, 'spin') < 1e-9, 'two full flips, caught grip first');
});

test('stowing it takes it straight out of the hand, wherever it was', () => {
  const m = new GunMotion();
  m.draw();
  run(m, 0.3);
  m.stow();
  assert.equal(m.pose, null);
  assert.equal(m.drawn, false);
  assert.deepEqual(m.update(FRAME), []);
  m.draw();
  m.holster();
  assert.equal(m.pose, null, 'drawn and holstered before a frame: never shown');
});
