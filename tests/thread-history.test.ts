import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ThreadHistory } from '../src/client/thread-history.js';
import { pageRows, presentThread, type ThreadPresentation } from '../src/shared/thread-presentation.js';
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

const tool = (seq: number): ThreadEntry => ({ id: `t-${seq}`, seq, role: 'assistant', kind: 'tool', name: 'Read', input: '{}', output: 'Done' });
/** What the office sends for a page of a longer conversation: the rows built over all of it. */
const page = (all: ThreadEntry[], from: number, to: number, before?: number) => {
  const entries = all.slice(from, to);
  const presentation: ThreadPresentation = { version: 1, rows: pageRows(presentThread(all, false), entries, before) };
  return { sessionId: 'one', entries, hasMore: from > 0, presentation, ...(before !== undefined ? { before } : {}) };
};

test('rows the office built keep a group whole across a page start and join earlier pages once', () => {
  const all = [entry(0, { role: 'user' }), ...Array.from({ length: 6 }, (_, i) => tool(i + 1)), entry(7)];
  const h = new ThreadHistory();
  h.apply(page(all, 5, 8));
  assert.deepEqual(
    h.rows.map((row) => [row.id, row.from, row.to]),
    [
      ['activity:t-1', 1, 6],
      ['e-7', 7, 7],
    ],
  );
  h.apply(page(all, 2, 5, 5));
  h.apply(page(all, 0, 2, 2));
  assert.deepEqual(h.rows, presentThread(all, false));
  assert.equal(h.unsupported, false);
});

test('a latest page replaces the rows from its first row on, and a session change drops them', () => {
  const all = [entry(0, { role: 'user' }), tool(1), tool(2)];
  const h = new ThreadHistory();
  h.apply(page(all, 0, 3));
  const grown = [...all, tool(3), entry(4)];
  h.apply(page(grown, 2, 5));
  assert.deepEqual(h.rows, presentThread(grown, false));
  h.apply({ ...page(grown, 2, 5), sessionId: 'two' });
  assert.deepEqual(
    h.rows.map((row) => row.id),
    ['activity:t-1', 'e-4'],
  );
  h.apply({ sessionId: 'two', entries: [], hasMore: false, presentation: { version: 1, rows: [] } });
  assert.deepEqual(h.rows, []);
});

test('a presentation this client cannot read shows nothing rather than guessing', () => {
  const h = new ThreadHistory();
  h.apply({ ...page([entry(1)], 0, 1), presentation: { version: 2, rows: [] } as unknown as ThreadPresentation });
  assert.equal(h.unsupported, true);
  assert.deepEqual(h.rows, []);
  h.apply({ sessionId: 'one', entries: [entry(1)], hasMore: false });
  assert.equal(h.unsupported, true, 'an office from before the model sends none');
});

test('bounding loaded history drops the rows outside it', () => {
  const all = Array.from({ length: 2100 }, (_, i) => entry(i, { role: i % 2 ? 'assistant' : 'user' }));
  const h = new ThreadHistory();
  h.apply(page(all, 0, 2100));
  assert.equal(h.rows.length, 2000);
  assert.equal(h.rows[0].from, 100);
});
