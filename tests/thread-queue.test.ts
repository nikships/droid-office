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
