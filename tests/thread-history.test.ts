import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ThreadHistory } from '../src/client/thread-history.js';
import type { ThreadEntry } from '../src/shared/worker-thread.js';

const entry = (seq: number, extra: Partial<ThreadEntry> = {}): ThreadEntry => ({ id: `e-${seq}`, seq, role: 'assistant', kind: 'text', text: `Message ${seq}`, ...extra });

test('latest pages update tool results without losing loaded history', () => {
  const h = new ThreadHistory();
  h.apply({ sessionId: 'one', entries: [entry(3), entry(4, { kind: 'tool' })], hasMore: true });
  h.apply({ sessionId: 'one', entries: [entry(1), entry(2)], hasMore: false, before: 3 });
  h.apply({ sessionId: 'one', entries: [entry(4, { kind: 'tool', output: 'done' }), entry(5)], hasMore: true });
  assert.deepEqual(
    h.entries.map((e) => e.seq),
    [1, 2, 3, 4, 5],
  );
  assert.equal(h.entries[3].output, 'done');
  assert.equal(h.hasMore, false);
});

test('session changes and conversation rewrites discard stale entries', () => {
  const h = new ThreadHistory();
  h.apply({ sessionId: 'one', entries: [entry(1), entry(5)], hasMore: false });
  h.apply({ sessionId: 'two', entries: [entry(8)], hasMore: true });
  assert.deepEqual(
    h.entries.map((e) => e.seq),
    [8],
  );
  h.apply({ sessionId: 'two', entries: [entry(2)], hasMore: false });
  assert.deepEqual(
    h.entries.map((e) => e.seq),
    [2],
  );
  h.apply({ sessionId: 'two', entries: [entry(2, { id: 'replacement' })], hasMore: false });
  assert.equal(h.entries[0].id, 'replacement');
  h.apply({ sessionId: 'two', entries: [], hasMore: false });
  assert.deepEqual(h.entries, []);
});

test('a missed page never silently leaves a hole in the conversation', () => {
  const h = new ThreadHistory();
  h.apply({ sessionId: 'one', entries: [entry(1), entry(2)], hasMore: false });
  h.apply({ sessionId: 'one', entries: [entry(150), entry(151)], hasMore: true });
  assert.deepEqual(
    h.entries.map((e) => e.seq),
    [150, 151],
  );
  assert.equal(h.hasMore, true);
});

test('paging deduplicates IDs, sorts entries and bounds loaded history', () => {
  const h = new ThreadHistory();
  h.apply({ sessionId: 'one', entries: [entry(3), entry(2)], hasMore: true });
  h.apply({ sessionId: 'one', entries: [entry(1), entry(2)], hasMore: false, before: 3 });
  assert.deepEqual(
    h.entries.map((e) => e.seq),
    [1, 2, 3],
  );
  h.apply({ sessionId: 'one', entries: Array.from({ length: 2100 }, (_, i) => entry(i + 1)), hasMore: false });
  assert.equal(h.entries.length, 2000);
  assert.equal(h.entries[0].seq, 101);
  assert.equal(h.hasMore, true);
  h.apply({ sessionId: 'one', entries: Array.from({ length: 100 }, (_, i) => entry(i + 1)), hasMore: false, before: 101 });
  assert.equal(h.entries[0].seq, 1);
  assert.equal(h.entries.at(-1)?.seq, 2000);
  assert.equal(h.historical, true);
  h.apply({ sessionId: 'one', entries: [entry(2200)], hasMore: true });
  assert.equal(h.entries.at(-1)?.seq, 2000);
  h.clear();
  assert.equal(h.entries.length, 0);
  assert.equal(h.sessionId, undefined);
  assert.equal(h.historical, false);
});
