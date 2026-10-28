import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { presentThread, type ThreadRow } from '../src/shared/thread-presentation.js';
import type { ThreadEntry } from '../src/shared/worker-thread.js';

const fixture = JSON.parse(readFileSync(new URL('../android/app/src/test/resources/thread-presentation-golden.json', import.meta.url), 'utf8')) as {
  cases: { name: string; busy: boolean; entries: ThreadEntry[]; expected: unknown }[];
};
const snapshot = (row: ThreadRow): unknown => {
  if (row.kind === 'message') return { kind: row.kind, id: row.id, role: row.entry.role, startsTurn: row.startsTurn };
  if (row.kind === 'notice') return { kind: row.kind, id: row.id, text: row.text, tone: row.tone };
  if (row.kind === 'thought') return { kind: row.kind, id: row.id, preview: row.preview, live: row.live };
  const states = { complete: 'done', working: 'running', failed: 'failed', incomplete: 'no_result', cancelled: 'cancelled' };
  return {
    kind: row.kind,
    id: row.id,
    summary: row.label,
    live: row.live,
    items: row.items.map((item) => ({ type: item.type, id: item.entry.id, title: item.title, detail: item.detail ?? null, state: states[item.state] })),
    failed: row.failed.map((action) => action.title),
    ...(row.cancelled ? { cancelled: row.cancelled } : {}),
    noResult: row.noResult,
    plan: row.plan?.map((step) => ({ status: step.done ? 'completed' : step.active ? 'in_progress' : 'pending', text: step.text })) ?? null,
  };
};
for (const example of fixture.cases) {
  test(`Android/web presentation parity: ${example.name}`, () => {
    assert.deepEqual(presentThread(example.entries, example.busy).map(snapshot), example.expected);
  });
}
