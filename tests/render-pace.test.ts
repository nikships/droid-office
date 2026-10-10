import test from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_DT_CAP, GONG_RING_MS, IDLE_FRAME_MS, SCENE_MOTIONS, advanceClock, frameDelta, gongRinging, renderPace, skyFalling, stillScene, type RenderClock, type RenderSignals } from '../src/client/render-pace.js';

function signals(patch: Partial<Omit<RenderSignals, 'motion'>> & { motion?: Partial<RenderSignals['motion']> } = {}): RenderSignals {
  return { hidden: false, covered: false, ...patch, motion: { ...stillScene(), ...patch.motion } };
}

const off: RenderClock = { mode: 'off', resume: false };

test('a hidden tab or a covered window pauses, even if the scene is moving', () => {
  assert.equal(renderPace(signals({ hidden: true, motion: { player: true } })), 'paused');
  assert.equal(renderPace(signals({ covered: true, motion: { worker: true, sky: true } })), 'paused');
  assert.equal(renderPace(signals({ hidden: true, covered: true })), 'paused');
});

test('a visible office with nothing moving idles, and each kind of motion goes back to full rate', () => {
  assert.equal(renderPace(signals()), 'idle');
  for (const key of SCENE_MOTIONS) {
    assert.equal(renderPace(signals({ motion: { [key]: true } })), 'full', key);
  }
});

test('rain or snow counts, a clear sky does not, and a gong rings for a few seconds', () => {
  assert.equal(skyFalling(0, 0), false);
  assert.equal(skyFalling(0.02, 0), false);
  assert.equal(skyFalling(0.03, 0), true);
  assert.equal(skyFalling(0, 0.5), true);
  assert.equal(gongRinging(1000, 0), false);
  assert.equal(gongRinging(1000, 1000), true);
  assert.equal(gongRinging(1000 + GONG_RING_MS - 1, 1000), true);
  assert.equal(gongRinging(1000 + GONG_RING_MS, 1000), false);
});

test('the frame after a pause is capped like a hitch, and an idle frame covers its own slot', () => {
  assert.equal(frameDelta(0, 'full', false), 0);
  assert.equal(frameDelta(-1, 'idle', false), 0);
  assert.equal(frameDelta(Number.NaN, 'full', false), 0);
  assert.equal(frameDelta(30, 'paused', true), 0);
  assert.equal(frameDelta(1 / 60, 'full', false), 1 / 60);
  assert.equal(frameDelta(30, 'full', false), FRAME_DT_CAP);
  assert.equal(frameDelta(30, 'idle', false), IDLE_FRAME_MS / 1000);
  // Coming back to a quiet office: do not play the missing minutes at the idle cap.
  assert.equal(frameDelta(30, 'idle', true), FRAME_DT_CAP);
});

test('the clock stops while hidden, idles when the room is quiet, and wakes on the next frame', () => {
  const hidden = advanceClock(off, 'paused', 'tick');
  assert.equal(hidden.draw, false);
  assert.equal(hidden.schedule, 'keep');
  assert.equal(hidden.clock.mode, 'paused');
  assert.equal(hidden.clock.resume, true);

  const running = advanceClock({ mode: 'full', resume: false }, 'paused', 'tick');
  assert.equal(running.schedule, 'stop');
  assert.equal(running.draw, false);
  assert.equal(running.clock.resume, true);
  // Another hide while already stopped leaves the callback alone.
  assert.equal(advanceClock(running.clock, 'paused', 'wake').schedule, 'keep');

  const back = advanceClock(running.clock, 'idle', 'wake');
  assert.equal(back.draw, false);
  assert.equal(back.schedule, 'raf');
  assert.equal(back.clock.resume, true);
  const first = advanceClock(back.clock, 'idle', 'tick');
  assert.equal(first.draw, true);
  assert.equal(first.resumed, true);
  assert.equal(first.schedule, 'idle');
  assert.equal(first.clock.resume, false);

  const later = advanceClock(first.clock, 'idle', 'tick');
  assert.equal(later.resumed, false);
  assert.equal(later.schedule, 'idle');

  const poked = advanceClock(later.clock, 'full', 'wake');
  assert.equal(poked.schedule, 'raf');
  assert.equal(poked.draw, false);
  const full = advanceClock(poked.clock, 'full', 'tick');
  assert.equal(full.draw, true);
  assert.equal(full.schedule, 'keep');
  assert.equal(full.resumed, false);
  // Already drawing every frame: a key does not restart the loop.
  assert.equal(advanceClock(full.clock, 'full', 'wake').schedule, 'keep');

  const quiet = advanceClock(full.clock, 'idle', 'tick');
  assert.equal(quiet.schedule, 'idle');
  assert.equal(quiet.draw, true);
});

test('the first tick draws immediately, so a quiet office still paints once before it idles', () => {
  const started = advanceClock(off, 'idle', 'tick');
  assert.equal(started.draw, true);
  assert.equal(started.schedule, 'idle');
  assert.equal(started.resumed, false);
  const moving = advanceClock(off, 'full', 'tick');
  assert.equal(moving.draw, true);
  assert.equal(moving.schedule, 'raf');
});
