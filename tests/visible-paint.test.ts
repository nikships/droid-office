import assert from 'node:assert/strict';
import test from 'node:test';
import { VisiblePaint } from '../src/client/visible-paint.js';

function rig() {
  let visible = true;
  let state = 0;
  let next = 0;
  const frames = new Map<number, () => void>();
  const drawn: number[] = [];
  const paints = new VisiblePaint(
    () => visible,
    () => drawn.push(state),
    (draw) => {
      frames.set(++next, draw);
      return next;
    },
    (id) => {
      frames.delete(id);
    },
  );
  return {
    paints,
    frames,
    drawn,
    state: (value: number) => {
      state = value;
    },
    visible: (value: boolean) => {
      visible = value;
      paints.visibilityChanged();
    },
    frame: () => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback();
    },
  };
}

test('a burst of live updates paints the newest state once per visible frame', () => {
  const r = rig();
  for (let i = 0; i < 1000; i++) {
    r.state(i);
    r.paints.schedule();
  }
  assert.equal(r.frames.size, 1);
  assert.deepEqual(r.drawn, []);
  r.frame();
  assert.deepEqual(r.drawn, [999]);
  r.paints.schedule();
  r.frame();
  assert.deepEqual(r.drawn, [999, 999]);
});

test('hiding cancels queued work; repeated hidden updates retain only one invalidation', () => {
  const r = rig();
  r.paints.schedule();
  r.visible(false);
  assert.equal(r.frames.size, 0);
  for (let i = 0; i < 1000; i++) {
    r.state(i);
    r.paints.now();
    r.paints.schedule();
  }
  assert.equal(r.frames.size, 0);
  assert.deepEqual(r.drawn, []);
  r.visible(true);
  assert.deepEqual(r.drawn, [999]);
  r.visible(true);
  assert.deepEqual(r.drawn, [999]);
});

test('user actions paint synchronously and cancel a redundant scheduled paint', () => {
  const r = rig();
  r.paints.schedule();
  r.state(1);
  r.paints.now();
  assert.deepEqual(r.drawn, [1]);
  assert.equal(r.frames.size, 0);
  r.frame();
  assert.deepEqual(r.drawn, [1]);
});

test('a visibility change before a frame runs never draws hidden state', () => {
  let visible = true;
  let callback = () => {};
  let drawn = 0;
  const paints = new VisiblePaint(
    () => visible,
    () => {
      drawn++;
    },
    (next) => {
      callback = next;
      return 1;
    },
    () => {},
  );
  paints.schedule();
  visible = false;
  callback();
  assert.equal(drawn, 0);
  visible = true;
  paints.visibilityChanged();
  assert.equal(drawn, 1);
});
