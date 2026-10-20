import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTerminal, terminalShortcut } from '../src/client/terminal-cycle.js';
import { OFFICE_SHELL_ID } from '../src/shared/office-shell.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const worker = (id: string, deskId: string, over: Partial<WorkerInfo> = {}): WorkerInfo => ({ id, deskId, status: 'idle', ...over }) as WorkerInfo;

test('terminal cycling follows desk order, not insertion order, and wraps through the boss shell', () => {
  const workers = [worker('ten', 'desk-10'), worker('two', 'desk-2'), worker('one', 'desk-1'), worker('kiosk', 'station-issues'), worker('bean', 'beanbag-1')];
  const order = ['one', 'two', 'ten', 'bean', 'kiosk', OFFICE_SHELL_ID];
  for (let i = 0; i < order.length; i++) {
    assert.equal(nextTerminal(workers, order[i], 1), order[(i + 1) % order.length]);
    assert.equal(nextTerminal(workers, order[i], -1), order[(i - 1 + order.length) % order.length]);
  }
  assert.equal(nextTerminal(workers, null, 1), 'one');
  assert.equal(nextTerminal(workers, null, -1), OFFICE_SHELL_ID);
  assert.deepEqual(
    workers.map((w) => w.id),
    ['ten', 'two', 'one', 'kiosk', 'bean'],
    'does not reorder the store',
  );
});

test('only running terminals on the supplied floor participate, without waking stopped or invalid workers', () => {
  const workers = [
    worker('asleep', 'desk-1', { status: 'offline' }),
    worker('exited', 'desk-2', { status: 'exited' }),
    worker('lost', 'desk-3', { lost: {} as WorkerInfo['lost'] }),
    worker('guest', 'desk-4', { guest: {} as WorkerInfo['guest'] }),
    worker('cloud', 'desk-5', { cloud: {} as WorkerInfo['cloud'] }),
    worker('starting', 'desk-6', { status: 'starting' }),
    worker('working', 'desk-7', { status: 'working' }),
    worker('waiting', 'desk-8', { status: 'needs_input' }),
    worker('done', 'desk-9', { status: 'done' }),
  ];
  assert.equal(nextTerminal(workers, null, 1), 'starting');
  assert.equal(nextTerminal(workers, 'starting', 1), 'working');
  assert.equal(nextTerminal(workers, 'working', 1), 'waiting');
  assert.equal(nextTerminal(workers, 'waiting', 1), 'done');
  assert.equal(nextTerminal(workers, 'done', 1), OFFICE_SHELL_ID);
  assert.equal(nextTerminal(workers, 'other-floor-terminal', 1), 'starting');
  assert.equal(nextTerminal(workers, 'removed-terminal', -1), OFFICE_SHELL_ID);
});

test('empty and single-worker floors cycle safely, and departures are reflected immediately', () => {
  for (const current of [null, 'removed', OFFICE_SHELL_ID]) {
    assert.equal(nextTerminal([], current, 1), OFFICE_SHELL_ID);
    assert.equal(nextTerminal([], current, -1), OFFICE_SHELL_ID);
  }
  const workers = new Map([['one', worker('one', 'desk-1')]]);
  assert.equal(nextTerminal(workers.values(), 'one', 1), OFFICE_SHELL_ID);
  assert.equal(nextTerminal(workers.values(), 'one', -1), OFFICE_SHELL_ID);
  assert.equal(nextTerminal(workers.values(), OFFICE_SHELL_ID, 1), 'one');
  workers.delete('one');
  assert.equal(nextTerminal(workers.values(), 'one', 1), OFFICE_SHELL_ID);
});

test('unknown desks still have a stable order', () => {
  const workers = [worker('z', 'unknown'), worker('a', 'unknown'), worker('known', 'desk-1')];
  assert.equal(nextTerminal(workers, null, 1), 'known');
  assert.equal(nextTerminal(workers, 'known', 1), 'a');
  assert.equal(nextTerminal(workers, 'a', 1), 'z');
});

function key(over: Partial<KeyboardEvent> = {}) {
  const calls: (string | number)[] = [];
  const event = {
    key: 'ArrowRight',
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    defaultPrevented: false,
    repeat: false,
    preventDefault: () => calls.push('preventDefault'),
    stopImmediatePropagation: () => calls.push('stopImmediatePropagation'),
    ...over,
  } as KeyboardEvent;
  return { event, calls };
}

test('Command+Left/Right consumes navigation before xterm and browser history', () => {
  for (const [arrow, direction] of [
    ['ArrowLeft', -1],
    ['ArrowRight', 1],
  ] as const) {
    const { event, calls } = key({ key: arrow });
    assert.equal(
      terminalShortcut(event, (dir) => calls.push(dir)),
      true,
    );
    assert.deepEqual(calls, ['preventDefault', 'stopImmediatePropagation', direction]);
  }
  const held = key({ repeat: true });
  assert.equal(
    terminalShortcut(held.event, (dir) => held.calls.push(dir)),
    true,
  );
  assert.deepEqual(held.calls, ['preventDefault', 'stopImmediatePropagation']);
});

test('ordinary arrows, other modifier combinations, IME and handled keys remain untouched', () => {
  for (const over of [{ metaKey: false }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { defaultPrevented: true }, { key: 'ArrowUp' }, { key: 'ArrowDown' }]) {
    const { event, calls } = key(over);
    assert.equal(
      terminalShortcut(event, (dir) => calls.push(dir)),
      false,
    );
    assert.deepEqual(calls, []);
  }
});
