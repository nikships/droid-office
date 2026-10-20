import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CALIBRATION_FRAMES,
  CALIBRATION_WARMUP_SECONDS,
  HIDDEN_FRAME_RATE,
  HtmlFullScreen,
  INPUT_REAPPLY_TICK_MS,
  INPUT_REAPPLY_TRAIL_MS,
  InputFrameRate,
  PageVisibility,
  windowVisible,
  calibratePaced,
  layerPixelFormat,
  learnPacedLate,
  newPacedDeadline,
  pacedHold,
  presentMode,
  type NativeStats,
  osrFrameRate,
  osrPixelFormat,
  pageSize,
  SAMPLE_STRIDE,
  spread,
  summarizeNativeStats,
  TextureLedger,
} from '../src/desktop/presenter-model.js';

test('the page renders float16 only when a screen can show brighter than white', () => {
  assert.equal(osrPixelFormat(true), 'rgbaf16');
  assert.equal(osrPixelFormat(false), 'argb');
  assert.equal(layerPixelFormat('rgbaf16'), 'rgbaf16');
  assert.equal(layerPixelFormat('argb'), 'bgra');
});

test('the offscreen frame rate follows the display within the office range', () => {
  assert.equal(osrFrameRate(120), 120);
  assert.equal(osrFrameRate(60), 60);
  assert.equal(osrFrameRate(59.94), 60);
  assert.equal(osrFrameRate(240), 120);
  assert.equal(osrFrameRate(10), 30);
  assert.equal(osrFrameRate(0), 60);
  assert.equal(osrFrameRate(undefined), 60);
  assert.equal(osrFrameRate(Number.NaN), 60);
});

test('the page takes the window content size, never smaller than a pixel', () => {
  assert.deepEqual(pageSize({ width: 1440.4, height: 868.6 }), { width: 1440, height: 869 });
  assert.deepEqual(pageSize({ width: 0, height: -3 }), { width: 1, height: 1 });
});

test('the texture ledger releases each texture once and only when asked', () => {
  const released: string[] = [];
  const texture = (name: string) => ({ release: () => released.push(name) });
  const ledger = new TextureLedger();
  const a = ledger.hold(texture('a'));
  const b = ledger.hold(texture('b'));
  const c = ledger.hold(texture('c'));
  assert.equal(ledger.size, 3);
  assert.equal(ledger.release(b), true);
  assert.equal(ledger.release(b), false);
  assert.equal(ledger.release(999), false);
  assert.deepEqual(released, ['b']);
  ledger.releaseAll();
  assert.deepEqual(released.sort(), ['a', 'b', 'c']);
  assert.equal(ledger.size, 0);
  assert.equal(ledger.release(a), false);
  assert.equal(ledger.release(c), false);
});

test('spread takes percentiles of a sorted copy', () => {
  assert.deepEqual(spread([]), { p50: 0, p95: 0, p99: 0, max: 0 });
  const values = Array.from({ length: 100 }, (_, i) => 100 - i);
  assert.deepEqual(spread(values), { p50: 50, p95: 95, p99: 99, max: 100 });
  assert.equal(values[0], 100);
});

function stats(samples: number[][], extra: Partial<NativeStats> = {}): NativeStats {
  return {
    submitted: samples.length + 2,
    dropped: 2,
    presented: samples.length,
    notShown: 0,
    ticks: samples.length * 2,
    ticksWithFrame: samples.length,
    importFailures: 0,
    released: samples.length,
    inFlight: 0,
    maxInFlight: 2,
    now: 0,
    samples: samples.flat(),
    ...extra,
  };
}

test('presenter stats report intervals, latency, waits and GPU time per presented frame', () => {
  const planned = 1000 / 120;
  const refresh = planned / 1000;
  // id, submittedAt, tickAt, target, presentedAt (s), gpuMs: frames each one refresh apart, one that slipped two refreshes, one shown right behind another.
  const rows = [
    [1, 10.0, 10.004, 10.008, 10.0083, 0.3],
    [2, 10.0083, 10.0125, 10.0167, 10.0167, 0.4],
    [3, 10.0167, 10.0208, 10.025, 10.025, 0.5],
    [4, 10.0333, 10.0375, 10.0417, 10.0417 + refresh, 0.6],
    [5, 10.0417, 10.0458, 10.05, 10.0501, 0.2],
  ];
  assert.equal(rows[0]!.length, SAMPLE_STRIDE);
  const report = summarizeNativeStats(stats(rows), planned);
  assert.equal(report.presented, 5);
  assert.equal(report.dropped, 2);
  assert.equal(report.submitted, 7);
  assert.equal(report.maxInFlight, 2);
  assert.equal(report.plannedMs, planned);
  assert.equal(report.late, 1);
  assert.equal(report.early, 1);
  assert.ok(Math.abs(report.latency.p50 - 8.3) < 0.2, `latency p50 ${report.latency.p50}`);
  assert.ok(report.wait.max > 4 && report.wait.max < 4.5);
  assert.equal(report.gpu.max, 0.6);
  assert.ok(report.fps > 90 && report.fps < 140, `fps ${report.fps}`);
  assert.equal(report.interval.max > planned * 1.5, true);
});

test('presenter stats on an empty ring are zeros, and one frame has no interval yet', () => {
  const empty = summarizeNativeStats(stats([]), 8.3);
  assert.equal(empty.fps, 0);
  assert.deepEqual(empty.interval, { p50: 0, p95: 0, p99: 0, max: 0 });
  const one = summarizeNativeStats(stats([[1, 1, 1.002, 1.008, 1.009, 0.3]]), 8.3);
  assert.equal(one.fps, 0);
  assert.equal(one.late, 0);
  assert.ok(Math.abs(one.latency.p50 - 9) < 0.01);
});

test('the present mode is direct unless a comparison asks for another', () => {
  assert.equal(presentMode({}), 'direct');
  assert.equal(presentMode({ DROID_OFFICE_PRESENT_MODE: 'link' }), 'link');
  assert.equal(presentMode({ DROID_OFFICE_PRESENT_MODE: 'paced' }), 'paced');
  assert.equal(presentMode({ DROID_OFFICE_PRESENT_MODE: 'direct' }), 'direct');
  assert.equal(presentMode({ DROID_OFFICE_PRESENT_MODE: 'bogus' }), 'direct');
});

// A model of the compositor for `paced` mode: a frame committed at `c` with a hold until `slot` is shown at the first refresh at or after
// max(slot, c + deadline); the layer has three drawables, and a frame's drawable frees when the frame after it is shown.
function simulatePaced(options: { acquireAtArrival: boolean; frames?: number; arrivalPeriod?: number; startupDelay?: number }) {
  const p = 1 / 120;
  const deadline = 0.022;
  const phase = 0.0031;
  const arrivalPeriod = options.arrivalPeriod ?? 2 * p;
  const vsyncAtOrAfter = (t: number) => phase + Math.ceil((t - phase) / p - 1e-9) * p;
  let state = newPacedDeadline();
  const shown: number[] = [];
  const arrived: number[] = [];
  let heldFrames: { shownAt: number; slot: number }[] = [];
  let anchor = 0;
  let smoothed = 0;
  let bumps = 0;
  let blocked = 0;
  for (let n = 0; n < (options.frames ?? 700); n++) {
    const a = 1 + n * arrivalPeriod + (((n * 7919) % 13) - 6) * 0.00008;
    if (n > 0) smoothed = smoothed > 0 ? smoothed * 0.9 + (a - arrived[n - 1]!) * 0.1 : a - arrived[n - 1]!;
    arrived.push(a);
    // The presenter only learns of a frame once the compositor has shown it.
    for (const done of heldFrames.filter((x) => x.shownAt <= a)) {
      const next = learnPacedLate(state, done.shownAt, done.slot, p);
      if (next.minLatency > state.minLatency) bumps++;
      state = next;
    }
    heldFrames = heldFrames.filter((x) => x.shownAt > a);
    for (const t of shown) if (t <= a) anchor = Math.max(anchor, t);
    const hold = pacedHold({ arrivedAt: a, now: a, anchor, period: p, arrivalInterval: smoothed, state });
    const acquireAt = hold && !options.acquireAtArrival ? hold.acquireAt : a;
    // Three drawables: this frame's is the one of the frame two before, which frees when the frame after that is shown.
    const committed = Math.max(acquireAt, n >= 2 ? shown[n - 2]! : 0);
    if (n >= 300 && committed > acquireAt) blocked++;
    let presented = vsyncAtOrAfter(Math.max(hold ? hold.slot - 0.5 * p : 0, committed + deadline + (a - 1 < CALIBRATION_WARMUP_SECONDS ? (options.startupDelay ?? 0) : 0)));
    if (n > 0) presented = Math.max(presented, shown[n - 1]! + p);
    shown.push(presented);
    if (hold) heldFrames.push({ shownAt: presented, slot: hold.slot });
    else state = calibratePaced(state, presented - a, a);
  }
  const settled = shown.slice(300);
  return {
    intervals: settled.slice(1).map((t, i) => (t - settled[i]!) / p),
    latencies: settled.map((t, i) => t - arrived[300 + i]!),
    bumps,
    blocked,
    shown,
    arrived,
    minLatency: state.minLatency,
    p,
  };
}

test('paced: a steady 60 FPS stream on a 120 Hz grid shows every frame two refreshes after the last, however the arrivals jitter', () => {
  const run = simulatePaced({ acquireAtArrival: false });
  assert.ok(
    run.intervals.every((x) => Math.abs(x - 2) < 0.01),
    JSON.stringify(run.intervals.filter((x) => Math.abs(x - 2) >= 0.01)),
  );
  assert.equal(run.bumps, 0);
  // Quickest deadline time plus the half refresh the hold adds, and at most a refresh on top.
  assert.ok(Math.max(...run.latencies) < run.minLatency + 2 * run.p, `latency ${Math.max(...run.latencies)}`);
});

test('paced: a 40 FPS stream is held three refreshes apart', () => {
  const run = simulatePaced({ acquireAtArrival: false, arrivalPeriod: 3 / 120 });
  assert.ok(run.intervals.every((x) => Math.abs(x - 3) < 0.01));
});

test('paced: a frame waits for its slot without a drawable, so the layer never runs out of its three', () => {
  const late = simulatePaced({ acquireAtArrival: false });
  assert.equal(late.blocked, 0);
  // Taking the drawable on arrival keeps three frames' worth of drawables busy and makes the next frame wait for one.
  assert.ok(simulatePaced({ acquireAtArrival: true }).blocked > 0);
});

test('paced: nothing is held until the deadline is known, at one frame per refresh, or when the grid is stale', () => {
  const p = 1 / 120;
  const known = { ...newPacedDeadline(), calibrated: CALIBRATION_FRAMES, minLatency: 0.026, baseLatency: 0.026 };
  const base = { arrivedAt: 10, now: 10, anchor: 9.99, period: p, arrivalInterval: 2 * p, state: known };
  assert.ok(pacedHold(base));
  assert.equal(pacedHold({ ...base, state: newPacedDeadline() }), null);
  assert.equal(pacedHold({ ...base, arrivalInterval: p }), null);
  assert.equal(pacedHold({ ...base, arrivalInterval: 0 }), null);
  assert.equal(pacedHold({ ...base, now: 11 }), null);
  assert.equal(pacedHold({ ...base, anchor: 0 }), null);
});

test('paced: the slot is a refresh of the grid half a refresh past the deadline, and its drawable is taken a millisecond before the deadline', () => {
  const p = 1 / 120;
  const state = { ...newPacedDeadline(), calibrated: CALIBRATION_FRAMES, minLatency: 0.025, baseLatency: 0.025 };
  const hold = pacedHold({ arrivedAt: 10.0005, now: 10.0005, anchor: 9.9, period: p, arrivalInterval: 2 * p, state })!;
  const refreshes = (hold.slot - 9.9) / p;
  assert.ok(Math.abs(refreshes - Math.round(refreshes)) < 1e-6);
  assert.ok(hold.slot >= 10.0005 + 0.025 + 0.5 * p);
  assert.ok(hold.slot < 10.0005 + 0.025 + 1.5 * p);
  assert.ok(Math.abs(hold.acquireAt - (hold.slot - 0.026)) < 1e-9);
});

test('paced: the first frames are not measured, so a slow start does not set the deadline', () => {
  const slow = simulatePaced({ acquireAtArrival: false, startupDelay: 0.006 });
  const normal = simulatePaced({ acquireAtArrival: false });
  assert.ok(Math.abs(slow.minLatency - normal.minLatency) < 1e-9);
  assert.ok(slow.intervals.every((x) => Math.abs(x - 2) < 0.01));
});

test('paced: calibration keeps the quickest frame after the warm-up and ignores impossible latencies; late holds grow the deadline twice at most', () => {
  let s = newPacedDeadline();
  for (let t = 0; t < CALIBRATION_WARMUP_SECONDS; t += 0.05) s = calibratePaced(s, 0.5, 100 + t);
  assert.equal(s.calibrated, 0);
  const at = 100 + CALIBRATION_WARMUP_SECONDS + 1;
  s = calibratePaced(s, 0.03, at);
  s = calibratePaced(s, 0.026, at);
  s = calibratePaced(s, 0, at);
  s = calibratePaced(s, 5, at);
  assert.equal(s.calibrated, 2);
  assert.equal(s.minLatency, 0.026);
  for (let i = 2; i < CALIBRATION_FRAMES; i++) s = calibratePaced(s, 0.027, at);
  assert.equal(s.baseLatency, 0.026);
  assert.equal(calibratePaced(s, 0.01, at), s);
  const p = 1 / 120;
  for (let i = 0; i < 20; i++) s = learnPacedLate(s, 20 + 0.9 * p, 20, p);
  assert.ok(Math.abs(s.minLatency - (0.026 + 2 * p)) < 1e-9);
  assert.equal(learnPacedLate({ ...s, lateRun: 2 }, 20, 20, p).lateRun, 0);
});

test('hiding the page stops painting, slows its frame rate to the floor and tells the office page; showing undoes all of it', () => {
  const calls: string[] = [];
  const gate = new PageVisibility({
    startPainting: () => calls.push('start'),
    stopPainting: () => calls.push('stop'),
    setFrameRate: (fps) => calls.push(`rate ${fps}`),
    notify: (visible) => calls.push(`notify ${visible}`),
  });
  gate.setDisplayRate(120);
  assert.deepEqual(calls.splice(0), ['rate 120']);
  gate.set(true);
  assert.deepEqual(calls, [], 'already visible: nothing happens');
  gate.set(false);
  assert.deepEqual(calls.splice(0), ['stop', `rate ${HIDDEN_FRAME_RATE}`, 'notify false']);
  assert.equal(gate.isVisible(), false);
  gate.set(false);
  assert.deepEqual(calls, [], 'hiding twice does nothing');
  gate.setDisplayRate(60);
  assert.deepEqual(calls.splice(0), [`rate ${HIDDEN_FRAME_RATE}`], 'a display change while hidden keeps the floor');
  gate.set(true);
  assert.deepEqual(calls.splice(0), ['start', 'rate 60', 'notify true']);
});

test('a window report with no verdict counts as visible, only an explicit false hides', () => {
  assert.equal(windowVisible({}), true);
  assert.equal(windowVisible({ visible: true }), true);
  assert.equal(windowVisible({ visible: false }), false);
});

test('a visible page is always asked for the display rate and a hidden one for the floor, however often it is set again', () => {
  const rates: number[] = [];
  const gate = new PageVisibility({ startPainting: () => {}, stopPainting: () => {}, setFrameRate: (fps) => rates.push(fps), notify: () => {} });
  assert.equal(gate.expectedRate(), 60, 'before the display is known a visible page runs at the default');
  gate.setDisplayRate(120);
  gate.set(false);
  gate.set(true);
  gate.reapply();
  gate.reapply();
  assert.deepEqual(rates, [120, HIDDEN_FRAME_RATE, 120, 120, 120]);
  assert.equal(gate.expectedRate(), 120);
  gate.set(false);
  rates.length = 0;
  gate.reapply();
  assert.deepEqual(rates, [HIDDEN_FRAME_RATE]);
  gate.set(true);
  gate.setDisplayRate(60);
  assert.equal(rates.at(-1), 60, 'a display change while visible follows at once');
  assert.equal(gate.expectedRate(), 60);
});

function inputRateHarness(visible = true) {
  let clock = 0;
  let sets = 0;
  const repeats: { fn: () => void; ms: number; next: number; live: boolean }[] = [];
  const state = { visible };
  const keeper = new InputFrameRate({
    now: () => clock,
    repeat: (fn, ms) => {
      const timer = { fn, ms, next: clock + ms, live: true };
      repeats.push(timer);
      return () => {
        timer.live = false;
      };
    },
    reapply: () => {
      sets++;
    },
    isVisible: () => state.visible,
  });
  const advance = (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const due = repeats.filter((t) => t.live && t.next <= end).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      clock = due.next;
      due.next += due.ms;
      due.fn();
    }
    clock = end;
  };
  return { keeper, advance, state, sets: () => sets, running: () => repeats.some((t) => t.live) };
}

test('input sets the frame rate again at a steady pace until a while after the last event, then stops', () => {
  const h = inputRateHarness();
  h.keeper.onInput();
  assert.equal(h.sets(), 1, 'the first event sets it at once');
  for (let i = 0; i < 100; i++) {
    h.advance(8);
    h.keeper.onInput();
  }
  const during = h.sets();
  assert.ok(during >= 800 / INPUT_REAPPLY_TICK_MS - 2, `${during} sets in 0.8 s of input, several per frame`);
  assert.equal(h.running(), true);
  h.advance(INPUT_REAPPLY_TRAIL_MS - 10);
  assert.equal(h.running(), true, 'still setting just before the trailing time');
  h.advance(20);
  assert.equal(h.running(), false, 'stopped after the trailing time');
  const after = h.sets();
  h.advance(10_000);
  assert.equal(h.sets(), after, 'nothing runs while the page is idle');
  h.keeper.onInput();
  assert.equal(h.running(), true, 'input after a pause starts it again');
});

test('a hidden page is never set again by input, and stopping ends the pace', () => {
  const hidden = inputRateHarness(false);
  hidden.keeper.onInput();
  hidden.advance(1000);
  assert.equal(hidden.sets(), 0);
  assert.equal(hidden.running(), false);
  const h = inputRateHarness();
  h.keeper.onInput();
  h.advance(10);
  h.state.visible = false;
  const before = h.sets();
  h.advance(20);
  assert.equal(h.sets(), before, 'the pace ends once the page is hidden');
  assert.equal(h.running(), false);
  h.state.visible = true;
  h.keeper.onInput();
  h.keeper.stop();
  assert.equal(h.running(), false, 'a stopped keeper schedules nothing further');
});

test('page full screen takes the visible window full screen, never the page window, and gives it back', () => {
  const calls: string[] = [];
  let full = false;
  const exits: number[] = [];
  const win = {
    isFullScreen: () => full,
    setFullScreen: (on: boolean) => {
      calls.push(on ? 'enter' : 'leave');
      full = on;
    },
  };
  const fs = new HtmlFullScreen(win, () => exits.push(1));

  // A windowed app: the visible window goes full screen with the page and comes back with it.
  fs.enter();
  assert.equal(fs.isActive, true);
  assert.deepEqual(calls, ['enter']);
  fs.enter();
  assert.deepEqual(calls, ['enter'], 'a second request (a video inside a full-screen card) changes nothing');
  fs.leave();
  assert.equal(fs.isActive, false);
  assert.deepEqual(calls, ['enter', 'leave']);
  fs.windowLeft();
  assert.deepEqual(exits, [], 'the window leaving because the page left asks nothing more of the page');

  // Already full screen (how the app opens): the window stays put on both sides.
  calls.length = 0;
  full = true;
  fs.enter();
  fs.leave();
  assert.deepEqual(calls, []);
  assert.equal(full, true);

  // The owner leaves full screen (Ctrl+Cmd+F, the green button) while the page is: the page leaves too, and nothing reopens it.
  calls.length = 0;
  full = false;
  fs.enter();
  full = false;
  fs.windowLeft();
  assert.deepEqual(exits, [1]);
  fs.leave();
  assert.deepEqual(calls, ['enter'], 'the window is not toggled again once the owner has left');
});
