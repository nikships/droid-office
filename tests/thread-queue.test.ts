import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ThreadQueue } from '../src/shared/thread-queue.js';
import type { ThreadEntry } from '../src/shared/worker-thread.js';

const fixture = JSON.parse(readFileSync(new URL('../android/app/src/test/resources/thread-queue-golden.json', import.meta.url), 'utf8')) as {
  cases: { name: string; steps: { session: string; entries: ThreadEntry[]; sends?: { text: string; hasImage: boolean }[]; expected: string[] }[] }[];
};
for (const example of fixture.cases) {
  test(`Android/web local queue parity: ${example.name}`, () => {
    const queue = new ThreadQueue();
    for (const step of example.steps) {
      queue.sync(step.session, step.entries);
      for (const send of step.sends ?? []) queue.sent(send.text, send.hasImage);
      assert.deepEqual(
        queue.pending.map((item) => item.text),
        step.expected,
      );
    }
  });
}

test('queue receipts survive a reload without claiming delivery', () => {
  const queue = new ThreadQueue();
  queue.sync('real-session', []);
  queue.sent('same', false);
  queue.sent('same', false);
  const first: ThreadEntry = { id: 'u1', seq: 1, role: 'user', kind: 'text', text: 'same' };
  queue.sync('real-session', [first]);
  const reloaded = new ThreadQueue(JSON.parse(JSON.stringify(queue)));
  assert.equal(reloaded.pending.length, 1);
  reloaded.sync('real-session', [first]);
  assert.equal(reloaded.pending.length, 1, 'one observed message cannot acknowledge two receipts');
  reloaded.sync('real-session', [first, { ...first, id: 'u2', seq: 2 }]);
  assert.equal(reloaded.pending.length, 0);
});

test('dismiss only clears local receipts and rejects malformed persisted state', () => {
  const queue = new ThreadQueue();
  queue.sync('session', []);
  queue.sent('draft', false);
  queue.clear();
  assert.deepEqual(queue.pending, []);
  assert.deepEqual(new ThreadQueue({ items: ['bad'] }).pending, []);
  const saved = {
    session: 'session',
    sequence: 2,
    consumed: [1, 'entry'],
    items: [
      { id: 1, text: 'valid', hasImage: false, after: 2 },
      { id: 'bad', text: 'invalid', after: 2 },
    ],
  };
  assert.deepEqual(
    new ThreadQueue(saved).pending.map((item) => item.text),
    ['valid'],
  );
});
