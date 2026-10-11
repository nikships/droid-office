import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_DT_CAP,
  GONG_RING_MS,
  IDLE_AFTER_MS,
  IDLE_FRAME_MS,
  SCENE_MOTIONS,
  advanceClock,
  frameDelta,
  gateFrame,
  OPEN_GATE,
  displayRefresh,
  type FrameGate,
  gongRinging,
  renderPace,
  skyFalling,
  stillScene,
  type RenderClock,
  type RenderSignals,
} from '../src/client/render-pace.js';

function signals(patch: Partial<Omit<RenderSignals, 'motion'>> & { motion?: Partial<RenderSignals['motion']> } = {}): RenderSignals {
  return { hidden: false, covered: false, fullRate: false, quietMs: IDLE_AFTER_MS, ...patch, motion: { ...stillScene(), ...patch.motion } };
}

const off: RenderClock = { mode: 'off', resume: false };

test('a hidden tab or a covered window pauses, even if the scene is moving', () => {
  assert.equal(renderPace(signals({ hidden: true, motion: { player: true } })), 'paused');
  assert.equal(renderPace(signals({ covered: true, motion: { worker: true, sky: true } })), 'paused');
  assert.equal(renderPace(signals({ hidden: true, covered: true })), 'paused');
});

test('a tab opened with ?pace=full draws every frame, still, hidden or covered', () => {
  assert.equal(renderPace(signals({ fullRate: true })), 'full');
  assert.equal(renderPace(signals({ fullRate: true, quietMs: IDLE_AFTER_MS * 10 })), 'full');
  assert.equal(renderPace(signals({ fullRate: true, hidden: true })), 'full');
  assert.equal(renderPace(signals({ fullRate: true, covered: true })), 'full');
});

test('a visible office with nothing moving idles, and each kind of motion goes back to full rate', () => {
  assert.equal(renderPace(signals()), 'idle');
  for (const key of SCENE_MOTIONS) {
    assert.equal(renderPace(signals({ motion: { [key]: true } })), 'full', key);
  }
});

test('a still office keeps full rate until it has been quiet for the whole idle delay', () => {
  assert.equal(renderPace(signals({ quietMs: 0 })), 'full');
  assert.equal(renderPace(signals({ quietMs: IDLE_AFTER_MS - 1 })), 'full');
  assert.equal(renderPace(signals({ quietMs: IDLE_AFTER_MS })), 'idle');
  assert.equal(renderPace(signals({ quietMs: IDLE_AFTER_MS * 10 })), 'idle');
  assert.equal(renderPace(signals({ hidden: true, quietMs: 0 })), 'paused');
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

/** Refreshes of a `hz` display from 0 ms, each timestamp off by up to `jitter` ms either way (a fixed pseudo-random walk). */
function refreshes(hz: number, count: number, jitter = 0, from = 0): number[] {
  let seed = 7;
  return Array.from({ length: count }, (_, i) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return from + (i * 1000) / hz + (seed / 2147483648 - 0.5) * 2 * jitter;
  });
}

/** The refresh indices that draw under a cap of `fps`. */
function gated(times: readonly number[], fps: number, from: FrameGate = OPEN_GATE): number[] {
  const drawn: number[] = [];
  let gate = from;
  times.forEach((t, i) => {
    const step = gateFrame(gate, t, fps);
    if (step.draw) drawn.push(i);
    gate = step.gate;
  });
  return drawn;
}

const steps = (drawn: readonly number[]) => drawn.slice(1).map((i, k) => i - drawn[k]);

test('on a 120 Hz display 40, 60 and 120 FPS draw every 3rd, 2nd and every refresh, through timestamp jitter', () => {
  for (const jitter of [0, 0.1, 0.5, 1.5]) {
    const times = refreshes(120, 1200, jitter);
    for (const [fps, every] of [
      [40, 3],
      [60, 2],
      [120, 1],
    ] as const) {
      const drawn = gated(times, fps);
      assert.deepEqual(new Set(steps(drawn)), new Set([every]), `${fps} FPS, jitter ${jitter} ms`);
      assert.equal(drawn.length, 1200 / every, `${fps} FPS holds its rate, jitter ${jitter} ms`);
    }
  }
});

test('a frame 0.1 ms early still draws, and one a whole refresh early does not', () => {
  let { draw, gate } = gateFrame(OPEN_GATE, 0, 60);
  assert.ok(draw);
  ({ draw, gate } = gateFrame(gate, 1000 / 120, 60));
  assert.equal(draw, false);
  assert.ok(Math.abs(displayRefresh(gate) - 1000 / 120) < 1e-9, 'the refresh is measured from the frames');
  ({ draw, gate } = gateFrame(gate, 1000 / 60 - 0.1, 60));
  assert.ok(draw);
  assert.equal(gateFrame(gate, (2 * 1000) / 60 - 1000 / 120 - 0.1, 60).draw, false);
});

test('on a 60 Hz display 60 and 120 FPS draw every refresh, and 40 alternates one and two', () => {
  const times = refreshes(60, 600, 0.3);
  assert.deepEqual(new Set(steps(gated(times, 60))), new Set([1]));
  assert.deepEqual(new Set(steps(gated(times, 120))), new Set([1]));
  const forty = gated(times, 40);
  assert.deepEqual(new Set(steps(forty)), new Set([1, 2]));
  assert.ok(Math.abs(forty.length - 400) <= 1, `${forty.length} frames in 10 s`);
  for (let i = 2; i < forty.length; i++) assert.equal(forty[i] - forty[i - 2], 3, 'never two long or two short gaps in a row');
});

test('after a hitch the gate starts again from the late frame instead of bursting to catch up', () => {
  for (const [fps, every] of [
    [40, 3],
    [60, 2],
    [120, 1],
  ] as const) {
    const before = refreshes(120, 120, 0.2);
    let gate = OPEN_GATE;
    for (const t of before) gate = gateFrame(gate, t, fps).gate;
    // Nothing for a quarter of a second, then refreshes again.
    const after = refreshes(120, 240, 0.2, before.at(-1)! + 250);
    const drawn = gated(after, fps, gate);
    assert.equal(drawn[0], 0, 'the first frame after the gap draws');
    assert.deepEqual(new Set(steps(drawn)), new Set([every]), `${fps} FPS straight back to every ${every}`);
  }
});
