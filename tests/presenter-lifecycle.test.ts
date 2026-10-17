import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NativeEvent } from '../src/desktop/input-events.js';
import { type InputNative, type InputPage, PresenterInput } from '../src/desktop/presenter-input.js';
import { PresenterTimers } from '../src/desktop/presenter-lifecycle.js';
import { INPUT_REAPPLY_TICK_MS, InputFrameRate, PageVisibility } from '../src/desktop/presenter-model.js';

const destroyed = () => new TypeError('Object has been destroyed');

test('stopping the timers clears every one, and nothing can be started afterwards', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const timers = new PresenterTimers();
  const fired: string[] = [];
  timers.after('watchdog', 10_000, () => fired.push('watchdog'));
  timers.after('gpu', 3000, () => fired.push('gpu'));
  timers.after('settle', 500, () => fired.push('settle'));
  timers.after('reloading', 5000, () => fired.push('reloading'), { unref: true });
  timers.every('recheck', 1000, () => fired.push('recheck'));
  timers.every('stall', 250, () => fired.push('stall'), { unref: true });
  timers.every('input', 3, () => fired.push('input'), { unref: true });
  assert.equal(timers.count, 7);

  timers.stop();
  assert.equal(timers.count, 0, 'every timer is cleared');
  assert.equal(timers.isStopped, true);
  t.mock.timers.tick(60_000);
  assert.deepEqual(fired, [], 'none of them fires after the stop');

  timers.after('late', 10, () => fired.push('late'));
  const end = timers.every('late-repeat', 10, () => fired.push('late-repeat'));
  end();
  t.mock.timers.tick(60_000);
  assert.deepEqual(fired, [], 'a timer asked for after the stop never runs');
  assert.equal(timers.count, 0);
});

test('a named timer replaces the one before it, ends itself and can be cleared', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const timers = new PresenterTimers();
  const fired: string[] = [];
  timers.after('gpu', 100, () => fired.push('first'));
  timers.after('gpu', 100, () => fired.push('second'));
  t.mock.timers.tick(100);
  assert.deepEqual(fired, ['second']);
  assert.equal(timers.has('gpu'), false, 'a one-shot timer removes itself');

  const stop = timers.every('tick', 10, () => fired.push('t'));
  t.mock.timers.tick(30);
  assert.equal(fired.filter((f) => f === 't').length, 3);
  stop();
  assert.equal(timers.has('tick'), false);
  t.mock.timers.tick(100);
  assert.equal(fired.filter((f) => f === 't').length, 3, 'the disposer ends only its own timer');

  const first = timers.every('same', 10, () => fired.push('a'));
  timers.every('same', 10, () => fired.push('b'));
  first();
  assert.equal(timers.has('same'), true, 'an old disposer does not end the timer that replaced it');
  timers.clear('same');
  assert.equal(timers.has('same'), false);
});

/** The wiring `PresenterWindow` uses: the input frame-rate timer is one of the presenter's timers, setting the rate on the page's contents. */
function presenterRate(contents: { setFrameRate(fps: number): void }) {
  const timers = new PresenterTimers();
  const visibility = new PageVisibility({ startPainting() {}, stopPainting() {}, setFrameRate: (fps) => contents.setFrameRate(fps), notify() {} });
  const rate = new InputFrameRate({
    now: () => Date.now(),
    repeat: (fn, ms) => timers.every('input', ms, fn, { unref: true }),
    reapply: () => visibility.reapply(),
    isVisible: () => visibility.isVisible(),
  });
  return { timers, rate };
}

test('the input frame-rate timer does nothing once the presenter has quiesced', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const sets: number[] = [];
  const { timers, rate } = presenterRate({ setFrameRate: (fps) => void sets.push(fps) });
  rate.onInput();
  t.mock.timers.tick(INPUT_REAPPLY_TICK_MS * 10);
  assert.ok(sets.length >= 10, 'it sets the rate while input flows');

  timers.stop();
  rate.dispose();
  const before = sets.length;
  t.mock.timers.tick(10_000);
  rate.onInput();
  t.mock.timers.tick(10_000);
  assert.equal(sets.length, before, 'a late tick or a late input event sets nothing');
  assert.equal(timers.count, 0);
});

test('an input timer that finds the page destroyed ends itself and never raises', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  let calls = 0;
  let alive = true;
  const { timers, rate } = presenterRate({
    setFrameRate: () => {
      calls++;
      if (!alive) throw destroyed();
    },
  });
  rate.onInput();
  t.mock.timers.tick(INPUT_REAPPLY_TICK_MS * 3);
  alive = false;
  assert.doesNotThrow(() => t.mock.timers.tick(INPUT_REAPPLY_TICK_MS * 50));
  const after = calls;
  t.mock.timers.tick(10_000);
  assert.equal(calls, after, 'it tried once more at most, then stopped');
  assert.equal(timers.has('input'), false);

  assert.doesNotThrow(() => rate.onInput(), 'an input event on a destroyed page is dropped too');
});

function destroyablePage() {
  const state = { destroyed: false };
  const sent: unknown[] = [];
  const commands: string[] = [];
  const guard = () => {
    if (state.destroyed) throw destroyed();
  };
  const page: InputPage = {
    sendInputEvent: (e) => {
      guard();
      sent.push(e);
    },
    focus: guard,
    getURL: () => {
      guard();
      return 'http://localhost:4600/';
    },
    debugger: {
      attach: guard,
      detach: guard,
      isAttached: () => {
        guard();
        return true;
      },
      sendCommand: async (method: string) => {
        guard();
        commands.push(method);
        return method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'MAIN' } } } : {};
      },
      on: () => {},
    } as InputPage['debugger'],
    on: () => {},
    once: () => {},
  };
  const native: string[] = [];
  const nativeApi: InputNative = {
    inputCapture: (on) => (native.push(`capture ${on}`), on),
    inputCapabilities: () => ({ rawMouse: true }),
    inputSetCursor: (name) => void native.push(`cursor ${name}`),
    inputSetCursorImage: () => void native.push('cursorImage'),
    inputSetTextInput: (on) => void native.push(`text ${on}`),
    inputSetImeRect: () => {},
    inputFocus: () => {},
  };
  const input = new PresenterInput({ page, native: nativeApi, shimSource: '', officeOrigin: () => 'http://localhost:4600', focused: () => true });
  return { state, sent, commands, native, input };
}

const move: NativeEvent = { type: 'mouse', kind: 'move', button: 0, buttons: 0, x: 4, y: 5, clickCount: 0, mods: 0 };
const key: NativeEvent = { type: 'key', kind: 'down', keyCode: 0, chars: 'a', base: 'a', mods: 0, repeat: false } as unknown as NativeEvent;

test('after input stops, native events and visibility changes never reach the page', async () => {
  const h = destroyablePage();
  h.input.stop();
  h.state.destroyed = true;
  assert.doesNotThrow(() => h.input.handle(move));
  assert.doesNotThrow(() => h.input.handle(key));
  assert.doesNotThrow(() => h.input.setPageVisible(false));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.commands, []);
  assert.doesNotThrow(() => h.input.stop(), 'stopping twice is harmless');
});

test('a page destroyed before input stops costs the app nothing: events are dropped, the stop still releases the native side', async () => {
  const h = destroyablePage();
  h.state.destroyed = true;
  assert.doesNotThrow(() => h.input.handle(move));
  assert.doesNotThrow(() => h.input.setPageVisible(true));
  assert.doesNotThrow(() => h.input.stop());
  assert.ok(h.native.includes('text false'), 'the text input is released even though the page is gone');
  await new Promise((r) => setImmediate(r));
});
