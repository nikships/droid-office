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

for (const example of fixture.cases) {
  test(`office presentation: ${example.name}`, () => {
    assert.deepEqual(presentThread(example.entries, example.busy), example.expected);
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
