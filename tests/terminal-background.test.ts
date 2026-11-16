import assert from 'node:assert/strict';
import test from 'node:test';
import { focusReports, TerminalMirror } from '../src/client/term-mirror.js';

function rig() {
  const writes: string[] = [];
  const callbacks: (() => void)[] = [];
  let ready = 0;
  let requests = 0;
  const mirror = new TerminalMirror(
    {
      write: (data: string | Uint8Array, callback?: () => void) => {
        writes.push(String(data));
        if (callback) callbacks.push(callback);
      },
      reset: () => {},
      resize: () => {},
    },
    () => {
      ready++;
    },
    () => {
      requests++;
    },
  );
  return {
    mirror,
    writes,
    ready: () => ready,
    requests: () => requests,
    drain: () => {
      while (callbacks.length) callbacks.shift()!();
    },
  };
}
const snapshot = { data: 'terminal snapshot', cols: 80, rows: 24 };

test('a hidden mirror parses no snapshots or live output and requests one fresh snapshot on return', () => {
  const r = rig();
  r.mirror.snapshot(snapshot);
  r.drain();
  assert.equal(r.mirror.ready, true);
  assert.equal(r.mirror.setVisible(false), true);
  const before = r.writes.length;
  for (let i = 0; i < 1000; i++) {
    r.mirror.data('x'.repeat(2048));
    r.mirror.snapshot(snapshot);
    assert.equal(r.mirror.setVisible(false), false);
  }
  assert.equal(r.writes.length, before);
  assert.equal(r.mirror.ready, false);
  assert.equal(r.requests(), 0);
  assert.equal(r.mirror.setVisible(true), true);
  assert.equal(r.mirror.setVisible(true), false);
  assert.equal(r.requests(), 1);
  r.mirror.data('ignored until snapshot');
  assert.equal(r.writes.length, before);
  r.mirror.snapshot({ ...snapshot, data: 'current terminal' });
  r.drain();
  r.mirror.data('live again');
  assert.deepEqual(r.writes.slice(before), ['', 'current terminal', 'live again']);
  assert.equal(r.ready(), 2);
});

test('hiding during an asynchronous snapshot invalidates pending callbacks and drops its backlog', () => {
  const r = rig();
  r.mirror.snapshot(snapshot);
  r.mirror.data('pending');
  r.mirror.setVisible(false);
  r.drain();
  assert.deepEqual(r.writes, ['']);
  assert.equal(r.ready(), 0);
  r.mirror.setVisible(true);
  r.mirror.snapshot({ ...snapshot, data: 'after restore' });
  r.mirror.data('next');
  r.drain();
  assert.deepEqual(r.writes, ['', '', 'after restore', 'next']);
  assert.equal(r.mirror.ready, true);
});

test('disconnect while hidden does not resume parsing before a new visible snapshot', () => {
  const r = rig();
  r.mirror.setVisible(false);
  r.mirror.disconnect();
  r.mirror.snapshot(snapshot);
  r.mirror.data('offline');
  assert.deepEqual(r.writes, []);
  r.mirror.setVisible(true);
  assert.equal(r.requests(), 1);
  r.mirror.snapshot(snapshot);
  r.drain();
  assert.equal(r.mirror.ready, true);
});

test('focus reports pass only when the window focus changes', () => {
  const focus = focusReports();
  assert.equal(focus.classify('x'), 'input');
  assert.equal(focus.classify('\x1b[O'), 'repeat', 'a window that never had focus does not report losing it');
  assert.equal(focus.classify('\x1b[I'), 'focus');
  assert.equal(focus.classify('\x1b[I'), 'repeat', 'focus reporting turned on again must not echo focus-in back');
  assert.equal(focus.classify('\x1b[Ix'), 'input');
  assert.equal(focus.classify('\x1b[O'), 'focus');
  assert.equal(focus.classify('\x1b[O'), 'repeat');
  focus.classify('\x1b[I');
  assert.equal(focus.reset(), undefined);
  assert.equal(focus.classify('\x1b[I'), 'focus', 'after a fresh snapshot the next focus-in is sent again');
  assert.equal(focus.reset(true, false), undefined, 'no report for a program that has not asked for them');
  assert.equal(focus.classify('\x1b[I'), 'focus', 'so the focus-in xterm sends when it turns reporting on goes through');
  assert.equal(focus.reset(true, true), '\x1b[I', 'a window still focused through a snapshot tells the program again');
  assert.equal(focus.classify('\x1b[O'), 'focus', 'and its next blur reaches the program');
});
