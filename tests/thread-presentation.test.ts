import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presentThread, threadAction } from '../src/shared/thread-presentation.js';
import type { ThreadEntry } from '../src/shared/worker-thread.js';

// Shapes observed in Byte's real local session, also shown in the owner's Android capture.
const tool = (id: string, name: string, input: Record<string, unknown> = {}, extra: Partial<ThreadEntry> = {}): ThreadEntry => ({
  id,
  seq: Number(id.replace(/\D/g, '')) || 0,
  role: 'assistant',
  kind: 'tool',
  name,
  input: JSON.stringify(input),
  output: 'Done',
  ...extra,
});
const text = (id: string, role: 'user' | 'assistant' = 'assistant'): ThreadEntry => ({ id, seq: 0, role, kind: 'text', text: 'The release is published.' });

test('the reported release-check turn becomes one activity disclosure without bookkeeping', () => {
  const rows = presentThread(
    [
      text('u', 'user'),
      text('answer'),
      tool('s1', 'Script', { code: 'await Promise.allSettled([...])' }),
      tool('t2', 'TodoWrite', { todos: '1. [in_progress] Check release' }),
      tool('r3', 'Read', { file_path: '/Users/nik/project/.droid-office/floor-branch.json' }),
      tool('e4', 'Execute', { command: 'gh pr view 307', summary: 'Check merge and release runs' }),
      { id: 'todo', seq: 5, role: 'assistant', kind: 'todo', text: '1. [in progress] Check release' },
      tool('s6', 'Script', { code: 'await Promise.allSettled([...])' }),
      tool('e7', 'Execute', { command: 'gh release view v0.1.611', summary: 'Verify published release' }),
      tool('t8', 'TodoWrite', { todos: '1. [completed] Check release' }),
      text('final'),
    ],
    false,
  );
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['message', 'message', 'activity', 'message'],
  );
  const row = rows[2];
  assert.equal(row.kind, 'activity');
  if (row.kind !== 'activity') return;
  assert.equal(row.actions.length, 3);
  assert.equal(row.label, 'Read a file · Ran 2 commands');
  assert.equal(row.state, 'complete');
  assert.deepEqual(
    row.actions.map((a) => a.title),
    ['Read floor-branch.json', 'Check merge and release runs', 'Verify published release'],
  );
  assert.ok(!JSON.stringify(row.actions.map((a) => a.title)).includes('/Users/nik'));
});

test('standalone script results remain available without showing source as their title', () => {
  const rows = presentThread([tool('s1', 'functions.Script', { code: 'secret source' })], false);
  assert.equal(rows[0].kind, 'activity');
  if (rows[0].kind !== 'activity') return;
  assert.equal(rows[0].actions[0].title, 'Ran a script');
  assert.equal(rows[0].actions[0].entry.output, 'Done');
});

test('failed wrappers and bookkeeping cannot be silently hidden', () => {
  const rows = presentThread([tool('s1', 'Script', {}, { error: true }), tool('t2', 'TodoWrite', {}, { error: true }), tool('r3', 'Read')], false);
  assert.equal(rows[0].kind, 'activity');
  if (rows[0].kind !== 'activity') return;
  assert.equal(rows[0].state, 'failed');
  assert.equal(rows[0].failed.length, 2);
  assert.equal(rows[0].actions.length, 3);
});

test('todo snapshots never become repeated transcript cards', () => {
  assert.deepEqual(presentThread([tool('t1', 'TodoWrite'), { id: 'todo', seq: 2, role: 'assistant', kind: 'todo', text: '1. [completed] Done' }], false), []);
});

test('a successful wrapper yields to a failed bookkeeping child, but not an unrelated earlier call', () => {
  const rows = presentThread([tool('r1', 'Read'), tool('s2', 'Script'), tool('t3', 'TodoWrite', {}, { error: true })], false);
  assert.equal(rows[0].kind, 'activity');
  if (rows[0].kind === 'activity') {
    assert.deepEqual(
      rows[0].actions.map((a) => a.title),
      ['Read a file', "Couldn't update the plan"],
    );
    assert.equal(rows[0].label, 'Read a file');
  }
  const standalone = presentThread([tool('r1', 'Read'), tool('s2', 'Script')], false);
  if (standalone[0].kind === 'activity') assert.equal(standalone[0].actions.at(-1)?.title, 'Ran a script');
});

test('group IDs survive appends, result updates and busy state changes', () => {
  const pending = tool('s1', 'Script', {}, { output: undefined });
  const first = presentThread([text('user', 'user'), pending], true)[1];
  const next = presentThread([text('user', 'user'), pending, tool('r2', 'Read')], true)[1];
  assert.equal(first.id, next.id);
  const done = presentThread([text('user', 'user'), { ...pending, output: 'Done' }, tool('r2', 'Read')], false)[1];
  assert.equal(done.id, first.id);
  if (done.kind === 'activity') assert.deepEqual(done.sourceIds, ['s1', 'r2']);
});

test('unknown results are not presented as successful and historical pending tools are not running', () => {
  for (const [busy, expected] of [
    [true, 'working'],
    [false, 'incomplete'],
  ] as const) {
    const rows = presentThread([tool('e1', 'Execute', {}, { output: undefined })], busy);
    assert.equal(rows[0].kind, 'activity');
    if (rows[0].kind === 'activity') assert.equal(rows[0].state, expected);
  }
  const rows = presentThread([tool('e1', 'Execute', {}, { output: undefined }), text('answer')], true);
  assert.equal(rows[0].kind, 'activity');
  if (rows[0].kind === 'activity') assert.equal(rows[0].state, 'incomplete');
});

test('messages and cancellation form readable boundaries and do not disappear', () => {
  const cancelled: ThreadEntry = { id: 'cancel', seq: 8, role: 'system', kind: 'notice', text: 'Turn cancelled' };
  const rows = presentThread([tool('r1', 'Read'), text('commentary'), tool('e2', 'Execute'), cancelled, text('u', 'user')], false);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['activity', 'message', 'activity', 'notice', 'message'],
  );
  assert.equal(rows[3].kind, 'notice');
  if (rows[3].kind === 'notice') assert.equal(rows[3].text, 'Turn cancelled');
});

test('human summaries tolerate plain text, missing fields, namespaces and long paths', () => {
  assert.equal(threadAction(tool('r1', 'Read', { file_path: 'C:\\project\\src\\main.ts' })).title, 'Read main.ts');
  assert.equal(threadAction(tool('e2', 'functions.Execute', { summary: 'Run\n  release checks', command: 'raw command' })).title, 'Run');
  assert.equal(threadAction(tool('g3', 'Grep', { pattern: 'auth token' })).title, 'Searched for “auth token”');
  assert.equal(threadAction(tool('p4', 'ApplyPatch', {})).title, 'Edited files');
  assert.equal(threadAction(tool('a5', 'AskUser')).title, 'Asked you a question');
  assert.equal(threadAction(tool('x6', 'Custom_Tool', {}, { input: 'old format' })).title, 'Used custom tool');
  assert.ok(threadAction(tool('r7', 'Read', { file_path: `/${'long'.repeat(50)}` })).title.length <= 90);
});
