import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderLoop } from '../src/client/render-loop.js';
import { IDLE_FRAME_MS, type RenderPace } from '../src/client/render-pace.js';

function rig(initial: RenderPace = 'idle') {
  let now = 1000;
  let pace = initial;
  let animation: ((timestamp: number) => void) | null = null;
  let serial = 0;
  let paused = 0;
  const draws: { dt: number; elapsed: number }[] = [];
  const schedules: boolean[] = [];
  const timers = new Map<number, () => void>();
  const loop = new RenderLoop({
    pace: () => pace,
    now: () => now,
    draw: (dt, elapsed) => draws.push({ dt, elapsed }),
    animation: (callback) => {
      animation = callback;
      schedules.push(!!callback);
    },
    delay: (callback, ms) => {
      assert.equal(ms, IDLE_FRAME_MS);
      assert.equal(timers.size, 0, 'never two idle callbacks');
      timers.set(++serial, callback);
      return serial;
    },
    cancelDelay: (id) => assert.ok(timers.delete(id), 'cancel the pending idle callback'),
    paused: () => paused++,
  });
  return {
    loop,
    draws,
    timers,
    schedules,
    paused: () => paused,
    pace: (next: RenderPace) => (pace = next),
    advance: (ms: number) => (now += ms),
    frame: (ms = 16) => {
      now += ms;
      assert.ok(animation, 'an animation callback is armed');
      animation(now);
    },
    idle: () => {
      now += IDLE_FRAME_MS;
      const [id, callback] = [...timers][0] ?? [];
      assert.ok(callback, 'an idle callback is pending');
      timers.delete(id);
      callback();
    },
  };
}

test('the actual loop paints once, keeps one idle timeout, and wakes on the next animation frame', () => {
  const r = rig();
  r.loop.wake();
  assert.equal(r.loop.mode, 'off', 'events cannot start the loop before boot');
  r.loop.start();
  r.loop.start();
  assert.deepEqual(r.draws, [{ dt: 0, elapsed: 0 }]);
  assert.equal(r.timers.size, 1);
  r.idle();
  assert.deepEqual(r.draws.at(-1), { dt: 0.2, elapsed: 0.2 });
  r.loop.wake();
  r.loop.wake();
  assert.equal(r.draws.length, 2, 'a wake schedules; it does not render synchronously');
  assert.equal(r.timers.size, 0);
  assert.deepEqual(r.schedules, [true], 'repeated wakes do not duplicate RAF loops');
  r.frame();
  assert.equal(r.loop.mode, 'idle');
  assert.deepEqual(r.schedules, [true, false]);
  assert.equal(r.timers.size, 1);
});

test('motion keeps RAF armed, becoming idle stops it, and hiding cancels an idle timeout', () => {
  const r = rig('full');
  r.loop.start();
  r.loop.wake();
  r.frame();
  assert.deepEqual(r.schedules, [true]);
  r.pace('idle');
  r.frame();
  assert.equal(r.timers.size, 1);
  assert.deepEqual(r.schedules, [true, false]);
  r.pace('paused');
  r.loop.wake();
  r.loop.wake();
  assert.equal(r.timers.size, 0);
  assert.equal(r.loop.mode, 'paused');
  assert.equal(r.paused(), 1);
});

test('an idle callback that discovers new motion hands off to RAF instead of keeping an idle timeout', () => {
  const r = rig();
  r.loop.start();
  r.pace('full');
  r.idle();
  assert.equal(r.loop.mode, 'full');
  assert.equal(r.timers.size, 0);
  assert.deepEqual(r.schedules, [true]);
  r.frame();
  assert.equal(r.draws.length, 3);
});

test('hiding stops RAF, messages while hidden do not rearm it, and both clocks cap the resume gap', () => {
  const r = rig('full');
  r.loop.start();
  r.frame(20);
  const before = r.draws.at(-1)!.elapsed;
  r.pace('paused');
  r.loop.wake();
  r.advance(30_000);
  r.loop.wake();
  assert.equal(r.draws.length, 2);
  assert.equal(r.timers.size, 0);
  assert.deepEqual(r.schedules, [true, false]);
  r.pace('idle');
  r.loop.wake();
  r.frame();
  assert.deepEqual(r.draws.at(-1), { dt: 0.1, elapsed: before + 0.1 });
  r.idle();
  assert.deepEqual(r.draws.at(-1), { dt: 0.2, elapsed: before + 0.1 + 0.2 });
});

test('booting hidden never arms a callback, and showing the page still paints the first frame', () => {
  const r = rig('paused');
  r.loop.start();
  assert.equal(r.draws.length, 0);
  assert.equal(r.timers.size, 0);
  assert.deepEqual(r.schedules, []);
  r.advance(60_000);
  r.pace('full');
  r.loop.wake();
  r.frame();
  assert.deepEqual(r.draws, [{ dt: 0, elapsed: 0 }]);
});
