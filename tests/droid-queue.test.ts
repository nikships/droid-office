import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { type DroidQueued, readDroidQueue, showsAs } from '../src/shared/droid-queue.js';
import { ThreadQueue } from '../src/shared/thread-queue.js';

// Screens copied from a worker's real terminal on the owner's office, shared with the Android app's DroidQueueTest.
const fixture = JSON.parse(readFileSync(new URL('../android/app/src/test/resources/droid-queue-golden.json', import.meta.url), 'utf8')) as {
  cases: { name: string; rows: string[]; expected: DroidQueued[] | null }[];
  matches: { row: DroidQueued; text: string; shows: boolean }[];
};

for (const example of fixture.cases) {
  test(`reads Droid's queue as the Android app does: ${example.name}`, () => {
    assert.deepEqual(readDroidQueue(example.rows), example.expected ?? undefined);
  });
}

test('matches whole messages to the rows Droid shows for them, as the Android app does', () => {
  for (const match of fixture.matches) assert.equal(showsAs(match.row, match.text), match.shows, JSON.stringify(match));
});

test("the queue shows Droid's rows with the whole text sent from here", () => {
  const queue = new ThreadQueue();
  queue.sent('Line one of a multi-line queued message\nline two of it', false, 1, 1_000);
  queue.sent('not drawn yet', false, 1, 2_000);
  const droid = [
    { text: 'From the desktop', cut: false, more: 0 },
    { text: 'Line one of a multi-line queued message', cut: false, more: 1 },
  ];
  const shown = queue.shown(droid, 2_500);
  assert.deepEqual(
    shown.map((item) => item.text),
    ['From the desktop', 'Line one of a multi-line queued message\nline two of it', 'not drawn yet'],
  );
  assert.deepEqual(
    shown.map((item) => item.preview),
    [false, false, false],
  );
  // Droid drained them: each stays a few seconds for the conversation to catch up, then goes.
  assert.equal(queue.shown([], 5_000).length, 2);
  assert.deepEqual(
    queue.shown([], 6_100).map((item) => item.text),
    ['Line one of a multi-line queued message\nline two of it'],
  );
  assert.deepEqual(queue.shown([], 6_600), []);
  assert.deepEqual(queue.pending, []);
});

test('without the screen, everything sent shows', () => {
  const queue = new ThreadQueue();
  queue.sent('a', false, 1, 0);
  assert.deepEqual(
    queue.shown(undefined, 60_000).map((item) => item.text),
    ['a'],
  );
  assert.equal(queue.pending.length, 1);
});

test('a cut row says it is a preview, and when it was seen does not survive a reload', () => {
  const shown = new ThreadQueue().shown(
    [
      { text: 'Long', cut: true, more: 0 },
      { text: 'Two', cut: false, more: 2 },
    ],
    0,
  );
  assert.deepEqual(
    shown.map((item) => [item.preview, item.more]),
    [
      [true, 0],
      [true, 2],
    ],
  );
  const queue = new ThreadQueue();
  queue.sync('session', []);
  queue.sent('kept', false, 0, 10);
  queue.shown([{ text: 'kept', cut: false, more: 0 }], 20);
  const saved = JSON.parse(JSON.stringify(queue));
  assert.deepEqual(saved.items, [{ id: 1, text: 'kept', hasImage: false, after: 0, at: 10 }]);
  assert.equal(new ThreadQueue(saved).pending[0].at, 10);
});
