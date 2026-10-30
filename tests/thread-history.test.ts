import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ThreadHistory } from '../src/client/thread-history.js';
import { pageRows, presentThread, type ThreadPresentation, type ThreadRow } from '../src/shared/thread-presentation.js';
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

/** What the office sends when its read window starts at an entry: rows built over that window only. */
const windowPage = (entries: ThreadEntry[]) => ({ sessionId: 'one', entries, hasMore: true, presentation: { version: 1, rows: presentThread(entries, false) } });
const actionsOf = (row: ThreadRow) => (row.kind === 'activity' ? row.blocks.flatMap((block) => (block.kind === 'tools' ? block.actions : [])) : []);

test('an earlier disk page keeps its activity prefix before the first held row', () => {
  for (const failed of [undefined, 975, 1025]) {
    const all = Array.from({ length: 200 }, (_, i) => ({ ...tool(i + 950), ...(i + 950 === failed ? { error: true, output: 'ENOENT: no such file' } : {}) }));
    const h = new ThreadHistory();
    // The held row begins at 1000, before the latest page's first entry at 1050.
    h.apply(page(all.slice(50), 50, 150));
    const held = h.rows[0];
    // The reader has since advanced beyond 1050, so the earlier page is rebuilt from disk.
    const earlier = page(all.slice(0, 100), 0, 100, 1050);
    h.apply(earlier);
    assert.deepEqual(
      h.rows.map((row) => [row.from, row.to]),
      [
        [950, 999],
        [1000, 1149],
      ],
    );
    assert.equal(h.rows[1], held, 'the held row stays intact');
    const prefix = h.rows[0];
    assert.ok(prefix.kind === 'activity');
    const ids = all.slice(0, 50).map((entry) => entry.id);
    assert.deepEqual(prefix.sourceIds, ids);
    assert.deepEqual(
      actionsOf(prefix).map((action) => action.id),
      ids,
    );
    assert.deepEqual(
      prefix.failed.map((failure) => failure.id),
      failed === 975 ? ['t-975'] : [],
    );
    assert.equal(prefix.state, failed === 975 ? 'failed' : 'complete');
    assert.equal(prefix.label, 'Earlier activity');
    assert.equal(prefix.live, false);
    assert.equal(prefix.status, undefined);
    assert.equal(prefix.running, undefined);
    assert.deepEqual(
      h.rows.flatMap((row) => actionsOf(row).map((action) => action.id)),
      all.map((entry) => entry.id),
    );
    assert.deepEqual(h.entries, all);
    h.apply(earlier);
    assert.equal(h.rows.length, 2, 'loading the same earlier page never duplicates its prefix');
  }
});

test('a window that slid past an activity keeps the prefix this client still holds', () => {
  const all = [entry(0, { role: 'user' }), ...Array.from({ length: 9 }, (_, i) => tool(i + 1))];
  const h = new ThreadHistory();
  h.apply(windowPage(all));
  assert.deepEqual(
    h.rows.map((row) => [row.id, row.from, row.to]),
    [
      ['e-0', 0, 0],
      ['activity:t-1', 1, 9],
    ],
  );
  // The reader's window slid to seq 5, so its rows start there while 1..4 are still loaded here.
  h.apply(windowPage(all.slice(5)));
  assert.deepEqual(
    h.rows.map((row) => [row.id, row.from, row.to]),
    [
      ['e-0', 0, 0],
      ['activity:t-1', 1, 4],
      ['activity:t-5', 5, 9],
    ],
  );
  const prefix = h.rows[1];
  assert.ok(prefix.kind === 'activity');
  assert.deepEqual(prefix.sourceIds, ['t-1', 't-2', 't-3', 't-4']);
  assert.deepEqual(
    actionsOf(prefix).map((item) => item.id),
    ['t-1', 't-2', 't-3', 't-4'],
  );
  assert.equal(prefix.live, false, 'the live part of the run is the newest row');
  // Its summary describes what it holds, not the whole run the office's own row now covers.
  assert.equal(prefix.label, 'Earlier activity');
  assert.equal(prefix.state, 'complete');
  assert.equal(prefix.status, undefined);
  assert.equal(prefix.running, undefined);
});

test('a clipped prefix keeps the failures the office reported for it', () => {
  const all = [entry(0, { role: 'user' }), tool(1), { ...tool(2), error: true, output: 'ENOENT: no such file' }, ...Array.from({ length: 6 }, (_, i) => tool(i + 3))];
  const h = new ThreadHistory();
  h.apply(windowPage(all));
  const before = h.rows[1];
  assert.ok(before.kind === 'activity' && before.failed.length === 1);
  h.apply(windowPage(all.slice(5)));
  const prefix = h.rows[1];
  assert.ok(prefix.kind === 'activity');
  assert.deepEqual(
    prefix.failed.map((failure) => failure.id),
    ['t-2'],
  );
  assert.equal(prefix.state, 'failed');
  assert.equal(prefix.status, undefined, 'the status line would count the whole run again');
  const rest = h.rows[2];
  assert.ok(rest.kind === 'activity');
  assert.deepEqual(rest.failed, [], 'a failure the window still holds is never counted twice');
});

test('a failure past the cut stays with the row that reports it', () => {
  const all = [entry(0, { role: 'user' }), ...Array.from({ length: 8 }, (_, i) => tool(i + 1)), { ...tool(9), error: true, output: 'ENOENT: no such file' }];
  const h = new ThreadHistory();
  h.apply(windowPage(all));
  h.apply(windowPage(all.slice(5)));
  const prefix = h.rows[1];
  assert.ok(prefix.kind === 'activity');
  assert.deepEqual(prefix.failed, [], 'the prefix holds no failure of its own');
  assert.equal(prefix.state, 'complete', 'and never claims the run failed');
  const rest = h.rows[2];
  assert.ok(rest.kind === 'activity');
  assert.deepEqual(
    rest.failed.map((failure) => failure.id),
    ['t-9'],
  );
  assert.equal(rest.state, 'failed');
});
