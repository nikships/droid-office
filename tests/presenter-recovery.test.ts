import assert from 'node:assert/strict';
import { test } from 'node:test';
import { windowOpenAction } from '../src/desktop/links.js';
import { CRASH_WINDOW_MS, CrashPolicy, FirstFrameGate, GpuRecovery, IMPORT_FAILURE_LIMIT, PaintStall, STALL_FAIL_MS, STALL_KICK_MS, STALL_RELOAD_MS, trustedFrame } from '../src/desktop/presenter-recovery.js';
import { formatStartupFailure, rendererCrashFailure } from '../src/desktop/startup-failure.js';

test('a crashed page is reloaded once, and a second crash within a minute asks the owner', () => {
  const policy = new CrashPolicy();
  assert.equal(policy.onGone('crashed', 1000, false), 'reload');
  assert.equal(policy.onGone('oom', 1000 + CRASH_WINDOW_MS - 1, false), 'dialog');
  assert.equal(policy.onGone('crashed', 1000 + CRASH_WINDOW_MS, false), 'dialog', 'the dialog is still the answer while two are inside the window');
});

test('crashes more than a minute apart are each reloaded', () => {
  const policy = new CrashPolicy();
  assert.equal(policy.onGone('crashed', 0, false), 'reload');
  assert.equal(policy.onGone('crashed', CRASH_WINDOW_MS, false), 'reload');
  assert.equal(policy.onGone('crashed', CRASH_WINDOW_MS * 3, false), 'reload');
});

test('a clean exit and a kill while quitting are not crashes and are not counted', () => {
  const policy = new CrashPolicy();
  assert.equal(policy.onGone('clean-exit', 0, false), 'ignore');
  assert.equal(policy.onGone('killed', 10, true), 'ignore');
  assert.equal(policy.onGone('killed', 20, false), 'reload', 'a kill outside a quit is a crash');
  assert.equal(policy.onGone('crashed', 30, false), 'dialog', 'and the ignored ones did not count toward the two');
});

test('after the owner reloads from the dialog the count starts again', () => {
  const policy = new CrashPolicy();
  policy.onGone('crashed', 0, false);
  assert.equal(policy.onGone('crashed', 1, false), 'dialog');
  policy.reset();
  assert.equal(policy.onGone('crashed', 2, false), 'reload');
});

test('a silent page after the GPU process dies is reloaded once, then the app fails', () => {
  const gpu = new GpuRecovery();
  assert.equal(gpu.silentFor(), 'reload');
  assert.equal(gpu.silentFor(), 'fail');
});

test('a texture after the GPU came back clears the count', () => {
  const gpu = new GpuRecovery();
  assert.equal(gpu.silentFor(), 'reload');
  gpu.painted();
  assert.equal(gpu.silentFor(), 'reload', 'a later GPU crash gets its own reload');
});

test('the window is shown on the first drawn frame only, and import failures fail startup only before one', () => {
  const gate = new FirstFrameGate();
  assert.equal(gate.isDrawn(), false);
  assert.equal(gate.importFailed(IMPORT_FAILURE_LIMIT - 1), false, 'a few failures are tolerated');
  assert.equal(gate.importFailed(IMPORT_FAILURE_LIMIT), true, 'a run of them with nothing drawn is fatal');
  assert.equal(gate.drawn(), true);
  assert.equal(gate.drawn(), false, 'the window is shown once');
  assert.equal(gate.isDrawn(), true);
  assert.equal(gate.importFailed(IMPORT_FAILURE_LIMIT * 10), false, 'once a frame has been drawn a bad texture is only counted');
});

test('only the office origin is trusted, and a missing frame, url or origin is not', () => {
  const origin = 'http://localhost:4600';
  assert.equal(trustedFrame('http://localhost:4600/', origin), true);
  assert.equal(trustedFrame('http://localhost:4600/?floor=2#x', origin), true);
  assert.equal(trustedFrame('http://localhost:4601/', origin), false);
  assert.equal(trustedFrame('https://localhost:4600/', origin), false);
  assert.equal(trustedFrame('http://evil.example/http://localhost:4600/', origin), false);
  assert.equal(trustedFrame('data:text/html,hi', origin), false);
  assert.equal(trustedFrame(undefined, origin), false);
  assert.equal(trustedFrame('http://localhost:4600/', undefined), false);
  assert.equal(trustedFrame('not a url', origin), false);
});

test('a window the page opens is never an app window: the office, the web and mail go to the browser, the rest is dropped', () => {
  const origin = 'http://localhost:4600';
  assert.equal(windowOpenAction('http://localhost:4600/', origin), 'browser');
  assert.equal(windowOpenAction('https://github.com/nikships/droid-office/pull/204', origin), 'browser');
  assert.equal(windowOpenAction('mailto:a@b.c', origin), 'browser');
  assert.equal(windowOpenAction('file:///etc/passwd', origin), 'ignore');
  assert.equal(windowOpenAction('javascript:alert(1)', origin), 'ignore');
  assert.equal(windowOpenAction('nonsense', origin), 'ignore');
});

test('the crash dialog has its own kind and says what to do', () => {
  const failure = rendererCrashFailure('reason: crashed');
  assert.equal(failure.kind, 'renderer-crashed');
  assert.equal(failure.title, 'The office window crashed');
  assert.match(formatStartupFailure(failure), /Reload it to try again/);
  assert.match(failure.detail, /reason: crashed/);
});

test('a page that paints after loading is never kicked, reloaded or failed', () => {
  const stall = new PaintStall();
  stall.arm(0);
  assert.equal(stall.check(STALL_KICK_MS[0] - 1), 'wait');
  stall.painted();
  assert.equal(stall.armed, false);
  assert.equal(stall.check(60_000), 'wait');
});

test('a silent page is kicked twice, reloaded once, then fails within ten seconds of loading', () => {
  const stall = new PaintStall();
  stall.arm(0);
  assert.equal(stall.check(STALL_KICK_MS[0]), 'kick');
  assert.equal(stall.check(STALL_KICK_MS[0] + 10), 'wait', 'one kick per step');
  assert.equal(stall.check(STALL_KICK_MS[1]), 'kick');
  assert.equal(stall.check(STALL_KICK_MS[1] + 10), 'wait');
  assert.equal(stall.check(STALL_RELOAD_MS), 'reload');
  // The reload loads the page again, which arms the watch again; the reload is not forgotten.
  stall.arm(STALL_RELOAD_MS + 200);
  assert.equal(stall.check(STALL_RELOAD_MS + 200 + STALL_FAIL_MS - 1), 'wait');
  assert.equal(stall.check(STALL_RELOAD_MS + 200 + STALL_FAIL_MS), 'fail');
  assert.ok(STALL_RELOAD_MS + 200 + STALL_FAIL_MS < 10_000);
});

test('a paint after the reload forgets it, so a later stall starts over', () => {
  const stall = new PaintStall();
  stall.arm(0);
  stall.check(STALL_RELOAD_MS);
  stall.painted();
  stall.arm(20_000);
  assert.equal(stall.check(20_000 + STALL_KICK_MS[0]), 'kick');
});
