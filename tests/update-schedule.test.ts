import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { UpdateController } from '../src/desktop/update-controller.js';
import { UpdateSchedule } from '../src/desktop/update-schedule.js';

const INITIAL = 10_000;
const INTERVAL = 30 * 60_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function rig(t: TestContext, initiallyLocked = false) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let locked = initiallyLocked;
  const power = Object.assign(new EventEmitter(), { getSystemIdleState: () => (locked ? 'locked' : 'active') });
  const calls: number[] = [];
  let check: () => Promise<string | undefined> = async () => undefined;
  const schedule = new UpdateSchedule(power, () => controller.check(false));
  const controller = new UpdateController({
    enabled: true,
    currentVersion: '0.1.0',
    check: () =>
      schedule.track(() => {
        calls.push(Date.now());
        return check();
      }),
    download: () => {
      throw new Error('Scheduling must not download updates');
    },
    beforeInstall: async () => {},
    quitAndInstall: () => assert.fail('Scheduling must not install updates'),
    render: () => {},
    close: () => controller.closed(),
  });
  t.after(() => schedule.stop());
  return {
    schedule,
    controller,
    calls,
    power,
    check: (operation: () => Promise<string | undefined>) => {
      check = operation;
    },
    lock: (value: boolean, emit = true) => {
      locked = value;
      if (emit) power.emit(value ? 'lock-screen' : 'unlock-screen');
    },
    tick: async (ms: number) => {
      t.mock.timers.tick(ms);
      await setImmediate();
    },
  };
}

test('automatic checks start after ten seconds and wait thirty minutes after completion', async (t) => {
  const r = rig(t);
  r.schedule.start();
  await r.tick(INITIAL - 1);
  assert.equal(r.calls.length, 0);
  await r.tick(1);
  assert.equal(r.calls.length, 1);
  await r.tick(INTERVAL - 1);
  assert.equal(r.calls.length, 1);
  await r.tick(1);
  assert.equal(r.calls.length, 2);
});

test('repeated start is idempotent and stop detaches every power listener and timer', async (t) => {
  const r = rig(t);
  r.schedule.start();
  await r.tick(INITIAL / 2);
  r.schedule.start();
  for (const event of ['suspend', 'resume', 'lock-screen', 'unlock-screen']) assert.equal(r.power.listenerCount(event), 1);
  await r.tick(INITIAL / 2);
  assert.equal(r.calls.length, 1, 'start does not postpone an existing deadline');
  r.schedule.stop();
  r.schedule.stop();
  assert.deepEqual(r.power.eventNames(), []);
  r.power.emit('resume');
  r.lock(false);
  await r.tick(INTERVAL * 4);
  assert.equal(r.calls.length, 1);
});

test('a screen locked at startup defers all overdue intervals until one check after unlock', async (t) => {
  const r = rig(t, true);
  const timers = t.mock.method(globalThis, 'setTimeout');
  r.schedule.start();
  await r.tick(INTERVAL * 4);
  assert.equal(r.calls.length, 0);
  assert.equal(timers.mock.callCount(), 0, 'locked scheduling has no polling timer');
  r.lock(false);
  r.lock(false);
  await r.tick(INITIAL - 1);
  assert.equal(r.calls.length, 0);
  await r.tick(1);
  assert.equal(r.calls.length, 1);
  await r.tick(INTERVAL);
  assert.equal(r.calls.length, 2);
});

test('suspend and lock are independent blockers regardless of wake/unlock order', async (t) => {
  const r = rig(t);
  r.schedule.start();
  r.power.emit('suspend');
  r.lock(true);
  await r.tick(INTERVAL * 5);
  r.power.emit('resume');
  r.power.emit('resume');
  await r.tick(INTERVAL);
  assert.equal(r.calls.length, 0, 'waking does not override a locked screen');
  r.power.emit('suspend');
  r.lock(false);
  await r.tick(INTERVAL);
  assert.equal(r.calls.length, 0, 'unlocking does not override suspend');
  r.power.emit('resume');
  r.power.emit('resume');
  await r.tick(INITIAL);
  assert.equal(r.calls.length, 1);
});

test('short suspend preserves a future deadline instead of checking on every wake', async (t) => {
  const r = rig(t);
  r.schedule.start();
  await r.tick(INITIAL);
  r.power.emit('suspend');
  await r.tick(1_000);
  r.power.emit('resume');
  await r.tick(INTERVAL - 1_001);
  assert.equal(r.calls.length, 1);
  await r.tick(1);
  assert.equal(r.calls.length, 2);
});

test('a missed lock event is caught at the deadline and wake samples the current lock state', async (t) => {
  const r = rig(t);
  r.schedule.start();
  r.lock(true, false);
  await r.tick(INITIAL);
  assert.equal(r.calls.length, 0);
  r.power.emit('suspend');
  await r.tick(INTERVAL);
  r.power.emit('resume');
  await r.tick(INTERVAL);
  assert.equal(r.calls.length, 0);
  r.lock(false);
  await r.tick(INITIAL);
  assert.equal(r.calls.length, 1);
});

test('manual and remote checks stay immediate while blocked and replace the automatic deadline', async (t) => {
  const r = rig(t, true);
  r.schedule.start();
  r.power.emit('suspend');
  await r.controller.check(true);
  assert.equal(r.calls.length, 1);
  r.controller.closed();
  await r.tick(INTERVAL * 3);
  r.controller.remote({ action: 'check' });
  assert.equal(r.calls.length, 2, 'remote check reaches the backend synchronously');
  await setImmediate();
  r.lock(false);
  r.power.emit('resume');
  await r.tick(INTERVAL - 1);
  assert.equal(r.calls.length, 2);
  await r.tick(1);
  assert.equal(r.calls.length, 3);
});

test('a check before automatic scheduling starts also postpones the launch check', async (t) => {
  const r = rig(t);
  await r.controller.check(true);
  r.controller.closed();
  r.schedule.start();
  await r.tick(INITIAL);
  assert.equal(r.calls.length, 1);
  await r.tick(INTERVAL - INITIAL);
  assert.equal(r.calls.length, 2);
});

test('slow automatic checks cannot overlap or replay elapsed intervals', async (t) => {
  const r = rig(t);
  const pending = deferred<string | undefined>();
  r.check(() => pending.promise);
  r.schedule.start();
  await r.tick(INITIAL);
  await r.tick(INTERVAL * 10);
  r.power.emit('suspend');
  r.power.emit('resume');
  await r.controller.check(true);
  r.controller.remote({ action: 'check' });
  assert.equal(r.calls.length, 1, 'manual takeover shares the pending check');
  pending.resolve(undefined);
  await setImmediate();
  r.controller.closed();
  await r.tick(INTERVAL - 1);
  assert.equal(r.calls.length, 1);
  await r.tick(1);
  assert.equal(r.calls.length, 2);
});

test('overlapping explicit checks after closing a pending check wait for the last completion', async (t) => {
  const r = rig(t);
  const first = deferred<string | undefined>();
  const second = deferred<string | undefined>();
  r.check(() => first.promise);
  r.schedule.start();
  const checkingFirst = r.controller.check(true);
  r.controller.closed();
  r.check(() => second.promise);
  const checkingSecond = r.controller.check(true);
  second.resolve(undefined);
  await checkingSecond;
  r.controller.closed();
  await r.tick(INTERVAL * 3);
  assert.equal(r.calls.length, 2, 'old network check is still pending');
  first.resolve(undefined);
  await checkingFirst;
  await r.tick(INTERVAL - 1);
  assert.equal(r.calls.length, 2);
  await r.tick(1);
  assert.equal(r.calls.length, 3);
});

test('stop during a pending automatic check prevents completion from restarting timers', async (t) => {
  const r = rig(t);
  const pending = deferred<string | undefined>();
  r.check(() => pending.promise);
  r.schedule.start();
  await r.tick(INITIAL);
  r.schedule.stop();
  pending.resolve(undefined);
  await setImmediate();
  r.power.emit('resume');
  await r.tick(INTERVAL * 5);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.power.eventNames(), []);
});

test('a check finishing during suspend leaves no timer until wake', async (t) => {
  const r = rig(t);
  const pending = deferred<string | undefined>();
  const timers = t.mock.method(globalThis, 'setTimeout');
  r.check(() => pending.promise);
  r.schedule.start();
  await r.tick(INITIAL);
  r.power.emit('suspend');
  pending.resolve(undefined);
  await setImmediate();
  assert.equal(timers.mock.callCount(), 1, 'completion must not arm a timer while suspended');
  await r.tick(INTERVAL * 3);
  assert.equal(r.calls.length, 1);
  r.power.emit('resume');
  await r.tick(INITIAL - 1);
  assert.equal(r.calls.length, 1);
  await r.tick(1);
  assert.equal(r.calls.length, 2);
});

test('restarting while a check is pending never creates a second check', async (t) => {
  const r = rig(t);
  const pending = deferred<string | undefined>();
  r.check(() => pending.promise);
  r.schedule.start();
  await r.tick(INITIAL);
  r.schedule.stop();
  r.schedule.start();
  await r.tick(INTERVAL * 2);
  assert.equal(r.calls.length, 1);
  pending.resolve(undefined);
  await setImmediate();
  await r.tick(INTERVAL);
  assert.equal(r.calls.length, 2);
});

test('failed checks and controller-skipped checks retain a bounded retry cadence', async (t) => {
  const r = rig(t);
  r.check(async () => {
    throw new Error('offline');
  });
  r.schedule.start();
  await r.tick(INITIAL);
  assert.equal(r.controller.state.phase, 'error');
  await r.tick(INTERVAL);
  assert.equal(r.calls.length, 2);
  await r.controller.check(true);
  assert.equal(r.calls.length, 3);
  await r.tick(INTERVAL);
  await r.tick(INTERVAL);
  assert.equal(r.calls.length, 3, 'an open local window suppresses automatic backend checks');
  r.controller.closed();
  await r.tick(INTERVAL);
  assert.equal(r.calls.length, 4);
});

test('a rejected automatic callback is contained and retried only at the next deadline', async (t) => {
  const r = rig(t);
  let calls = 0;
  const schedule = new UpdateSchedule(r.power, async () => {
    ++calls;
    throw new Error('unexpected callback failure');
  });
  t.after(() => schedule.stop());
  schedule.start();
  await r.tick(INITIAL);
  assert.equal(calls, 1);
  await r.tick(INTERVAL - 1);
  assert.equal(calls, 1);
  await r.tick(1);
  assert.equal(calls, 2);
});
