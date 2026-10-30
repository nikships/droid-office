import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ThreadHistory } from '../src/client/thread-history.js';
import { presentThread, type ThreadPresentation, type ThreadRow } from '../src/shared/thread-presentation.js';
import type { ThreadEntry } from '../src/shared/worker-thread.js';
import { FIXTURE, render, threadFixture } from '../tools/thread-fixture.mjs';

const file = readFileSync(FIXTURE, 'utf8');
const fixture = JSON.parse(file) as {
  cases: { name: string; busy: boolean; entries: ThreadEntry[]; expected: ThreadRow[] }[];
  paging: {
    name: string;
    steps: {
      snapshot: { before?: number; sessionId: string; entries: ThreadEntry[]; hasMore: boolean; presentation: ThreadPresentation };
      expected: { entries: string[]; rows: ThreadRow[] };
    }[];
  }[];
};

test('the shared fixture is what the office engine says now', () => {
  assert.equal(file, render(threadFixture(fixture)), 'run node --import tsx tools/thread-fixture.mjs and review the diff');
});

// The cases' `expected` rows are regenerated from presentThread, so comparing against them can't
// catch a regression. These check the fixture's `rules` against every captured session instead.
const HIDDEN = new Set(['todowrite', 'todoread', 'toolsearch', 'skill', 'waitforscript', 'taskoutput']);
const blocksOf = (row: ThreadRow) => (row.kind === 'activity' ? row.blocks : []);
const actionsIn = (row: ThreadRow) => blocksOf(row).flatMap((block) => (block.kind === 'tools' ? block.actions : []));

for (const example of fixture.cases) {
  test(`office presentation rules: ${example.name}`, () => {
    const rows = presentThread(example.entries, example.busy);
    const byId = new Map(example.entries.map((entry) => [entry.id, entry]));
    for (const [index, row] of rows.entries()) {
      assert.ok(row.from <= row.to, `${row.id} spans forwards`);
      if (index) assert.ok(row.from > rows[index - 1].to, `${row.id} starts after the row before it`);
      if (index && row.kind === 'activity') assert.notEqual(rows[index - 1].kind, 'activity', 'everything between two top-level rows is one Activity');
    }
    for (const entry of example.entries) {
      if (entry.kind === 'text' && entry.role !== 'system' && entry.text?.trim()) {
        assert.ok(
          rows.some((row) => row.kind === 'message' && row.id === entry.id),
          `${entry.id} stays visible`,
        );
      }
    }
    for (const row of rows) {
      if (row.kind !== 'activity') continue;
      assert.equal(row.id, `activity:${row.sourceIds[0]}`);
      const seqs = row.sourceIds.map((id) => byId.get(id)?.seq ?? Number.NaN);
      assert.equal(row.from, seqs[0]);
      assert.equal(row.to, Math.max(...seqs));
      assert.ok(row.blocks.length, 'an Activity with nothing to show leaves no row');
      assert.equal(row.open, false, 'every disclosure starts closed');
      for (const block of row.blocks) assert.equal(block.open, false);
      const actions = actionsIn(row);
      assert.deepEqual(
        row.failed.map((failure) => failure.id),
        actions.filter((action) => action.state === 'failed' && !action.causedBy).map((action) => action.id),
        'a causal wrapper failure is not counted twice',
      );
      if (!row.blocks.some((block) => block.kind === 'tools')) assert.equal(row.label, 'Thought');
      for (const action of actions) {
        const entry = byId.get(action.id);
        assert.equal(action.open, false);
        assert.ok(!(entry && !entry.error && HIDDEN.has(entry.name?.toLowerCase() ?? '')), `${action.id} is bookkeeping that succeeded`);
        if (action.state === 'complete') assert.notEqual(entry?.output, undefined, `${action.id} is complete only with output`);
        if (action.state === 'working') assert.ok(example.busy && row.live, `${action.id} works only in the live run`);
        assert.doesNotMatch(action.title, /\/Users\/|^\s*[{[]/, `${action.id} has a human title`);
      }
    }
  });
}
for (const scenario of fixture.paging) {
  test(`web paging holds the office's rows: ${scenario.name}`, () => {
    const history = new ThreadHistory();
    for (const [index, step] of scenario.steps.entries()) {
      history.apply(step.snapshot);
      assert.deepEqual(
        history.entries.map((entry) => entry.id),
        step.expected.entries,
        `step ${index}`,
      );
      assert.deepEqual(history.rows, step.expected.rows, `step ${index}`);
    }
  });
}
