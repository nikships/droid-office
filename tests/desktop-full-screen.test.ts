import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { leaveFullScreen } from '../src/desktop/full-screen.ts';

class FakeWindow extends EventEmitter {
  destroyed = false;
  calls: boolean[] = [];
  constructor(public fullScreen: boolean) {
    super();
  }
  isDestroyed() {
    return this.destroyed;
  }
  isFullScreen() {
    return this.fullScreen;
  }
  setFullScreen(on: boolean) {
    this.calls.push(on);
  }
}

test('a window that is not in full screen is left alone', async () => {
  const win = new FakeWindow(false);
  await leaveFullScreen(win);
  assert.deepEqual(win.calls, []);
});

test('a destroyed window is left alone', async () => {
  const win = new FakeWindow(true);
  win.destroyed = true;
  await leaveFullScreen(win);
  assert.deepEqual(win.calls, []);
});

test('a full-screen window settles only once macOS says it has left full screen', async () => {
  const win = new FakeWindow(true);
  let settled = false;
  const left = leaveFullScreen(win, 60_000).then(() => {
    settled = true;
  });
  assert.deepEqual(win.calls, [false]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  win.fullScreen = false;
  win.emit('leave-full-screen');
  await left;
  assert.equal(settled, true);
  assert.equal(win.listenerCount('leave-full-screen'), 0);
  assert.equal(win.listenerCount('closed'), 0);
});

test('a window closed while leaving full screen settles too', async () => {
  const win = new FakeWindow(true);
  const left = leaveFullScreen(win, 60_000);
  win.destroyed = true;
  win.emit('closed');
  await left;
});

test('a window that never reports leaving full screen is given up on', async () => {
  const win = new FakeWindow(true);
  await leaveFullScreen(win, 10);
  assert.equal(win.listenerCount('leave-full-screen'), 0);
  assert.equal(win.listenerCount('closed'), 0);
});
