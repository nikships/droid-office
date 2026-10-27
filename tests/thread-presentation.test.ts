import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const capturedEntries = (name: string): ThreadEntry[] =>
  JSON.parse(readFileSync(new URL('../android/app/src/test/resources/thread-presentation-golden.json', import.meta.url), 'utf8')).cases.find((example: { name: string }) => example.name === name).entries;
const capturedFailure = () => capturedEntries('unit_real_missing_read_causal_wrapper');
const capturedCancellation = () => capturedEntries('unit_real_late_script_owner_cancelled_interrupted_child').filter((entry) => entry.kind === 'tool');

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

test('unit: the captured causal Script diagnostics stay accessible but only Read counts as failed', () => {
  const entries = capturedFailure();
  const row = presentThread(entries, false)[0];
  assert.equal(row.kind, 'activity');
  if (row.kind !== 'activity') return;
  assert.equal(row.label, 'Read a file');
  assert.equal(row.failed.length, 1);
  assert.equal(row.failed[0].entry.id, entries[1].id);
  assert.match(row.failed[0].entry.output ?? '', /^Error reading file: ENOENT/);
  assert.equal(row.actions[0].causedBy, entries[1].id);
  assert.equal(row.actions[0].entry, entries[0]);
  assert.equal(row.actions[0].state, 'failed');
  assert.equal(row.state, 'failed');
  assert.deepEqual(
    row.sourceIds,
    entries.map((entry) => entry.id),
  );
});

test('unit variants of the capture never deduplicate unrelated or unproven wrapper failures', () => {
  const [wrapper, child] = capturedFailure();
  for (const output of [
    wrapper.output?.replace('Error: tools.Read: Error reading file:', 'SyntaxError:'),
    wrapper.output?.replace('"status":"failed"', '"status":"complete"'),
    wrapper.output?.replace('"toolCallId":"call_', '"toolCallId":"other_'),
    wrapper.output?.split('\n')[0],
    wrapper.output?.replace('"status":"failed"', '"status":"failed","independentError":"SyntaxError"'),
    wrapper.output?.replace(/{"toolCallId".*$/, '{invalid JSON'),
    `${wrapper.output}\nAdditional independent failure`,
    'SyntaxError: Unexpected token',
  ]) {
    const row = presentThread([{ ...wrapper, output }, child], false)[0];
    assert.equal(row.kind, 'activity');
    if (row.kind === 'activity') assert.equal(row.failed.length, 2, output);
  }
  for (const entries of [
    [wrapper],
    [wrapper, { ...child, error: false }],
    [wrapper, { ...child, output: undefined }],
    [wrapper, { ...child, output: 'An independent error' }],
    [child, wrapper],
    [wrapper, tool('next-script', 'Script'), child],
  ]) {
    const row = presentThread(entries, false)[0];
    assert.equal(row.kind, 'activity');
    if (row.kind === 'activity') assert.equal(row.actions.find((action) => action.entry.id === wrapper.id)?.causedBy, undefined);
  }
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

test('a real cancellation stays quiet without concealing an earlier genuine failure', () => {
  const rows = presentThread(
    [
      tool('r1', 'Read', { file_path: '/missing' }, { error: true, output: 'File not found' }),
      tool('e2', 'Execute', {}, { error: true, output: 'Tool execution cancelled by user' }),
      { id: 'turn:t:cancelled', seq: 3, role: 'system', kind: 'notice', text: 'Turn cancelled' },
    ],
    false,
  );
  assert.equal(rows[0].kind, 'activity');
  if (rows[0].kind !== 'activity') return;
  assert.equal(rows[0].cancelled, 1);
  assert.equal(rows[0].failed.length, 1);
  assert.equal(rows[0].actions[1].state, 'cancelled');
  assert.equal(rows[0].actions[1].entry.error, true);
  // An exact by-user CLI result is itself owner evidence, even without a turn notice.
  const explicit = presentThread([tool('e2', 'Execute', {}, { error: true, output: 'Tool execution cancelled by user' })], false)[0];
  assert.equal(explicit.kind, 'activity');
  if (explicit.kind === 'activity') {
    assert.equal(explicit.state, 'cancelled');
    assert.equal(explicit.actions[0].state, 'cancelled');
    assert.equal(explicit.cancelled, 1);
  }
});

test('unit: late captured Script owner evidence cancels its lone interrupted child once without rewriting errors', () => {
  const entries = capturedCancellation();
  const original = JSON.stringify(entries);
  const row = presentThread(entries, false)[0];
  assert.equal(row.kind, 'activity');
  if (row.kind !== 'activity') return;
  assert.equal(row.state, 'cancelled');
  assert.equal(row.failed.length, 0);
  assert.equal(row.cancelled, 1);
  assert.equal(row.label, 'Ran a command');
  assert.deepEqual(
    row.actions.map((action) => action.state),
    ['cancelled', 'cancelled'],
  );
  assert.equal(row.actions[0].causedBy, entries[1].id);
  assert.equal(row.actions[1].entry.output, 'Tool execution was interrupted');
  assert.ok(row.actions.every((action) => action.entry.error));
  assert.equal(JSON.stringify(entries), original);
  const earlier = presentThread([{ ...entries[0], output: undefined, error: undefined }, entries[1]], false)[0];
  assert.equal(earlier.id, row.id, 'late results preserve the activity key');
});

test('unit capture variants: malformed, truncated or unknown wrapper outcomes never prove owner cancellation', () => {
  const [wrapper, child] = capturedCancellation();
  for (const output of [
    'Tool execution was interrupted',
    'Tool execution was cancelled',
    'Error: Tool execution cancelled by us',
    'Error: Tool execution cancelled by user.json',
    'Error: Tool execution cancelled by user\nSyntaxError: Unexpected token',
    '{"error":"Error: Tool execution cancelled by user"}',
  ]) {
    const row = presentThread([{ ...wrapper, output }, child], false)[0];
    assert.equal(row.kind, 'activity');
    if (row.kind === 'activity') {
      assert.equal(row.failed.length, 2, output);
      assert.equal(row.cancelled, 0, output);
    }
  }
  const row = presentThread([{ ...wrapper, error: false }, child], false)[0];
  if (row.kind === 'activity') {
    assert.equal(row.failed.length, 1, 'a non-error wrapper is not cancellation evidence');
    assert.equal(row.cancelled, 0);
  }
});

test('unit capture variants: owner-cancelled wrappers never conceal independent child or wrapper errors', () => {
  const [wrapper, child] = capturedCancellation();
  const missing = tool('read-cancelled-file', 'Read', { file_path: '/tmp/cancelled.json' }, { error: true, output: "Error reading file: ENOENT: no such file or directory, access '/tmp/cancelled.json'" });
  for (const failedChild of [missing, { ...child, output: 'SyntaxError: Unexpected token' }, { ...child, output: 'Tool execution was interrupted by an external signal' }]) {
    const row = presentThread([wrapper, failedChild], false)[0];
    assert.equal(row.kind, 'activity');
    if (row.kind === 'activity') {
      assert.equal(row.failed.length, 1);
      assert.equal(row.failed[0].entry, failedChild);
      assert.equal(row.cancelled, 1);
      assert.equal(row.actions[0].causedBy, undefined);
    }
  }
  const row = presentThread(
    [
      { ...wrapper, output: 'SyntaxError: Unexpected token' },
      { ...child, output: 'Tool execution cancelled by user' },
    ],
    false,
  )[0];
  if (row.kind === 'activity') {
    assert.equal(row.failed[0].entry.id, wrapper.id);
    assert.equal(row.cancelled, 1);
  }
});

test('unit capture variants: owner evidence stays inside its Script and message boundaries', () => {
  const [wrapper, child] = capturedCancellation();
  const independent = tool('independent-script', 'Script', {}, { error: true, output: 'SyntaxError: Unexpected token' });
  for (const entries of [
    [wrapper, independent, child],
    [child, wrapper, independent],
    [wrapper, child, { ...child, id: 'another-interrupted-call' }],
  ]) {
    const row = presentThread(entries, false)[0];
    assert.equal(row.kind, 'activity');
    if (row.kind === 'activity') {
      assert.equal(row.failed.length, 2);
      assert.equal(row.cancelled, 1);
      assert.equal(row.actions.find((action) => action.entry.id === wrapper.id)?.causedBy, undefined);
    }
  }
  const separated = presentThread([wrapper, text('boundary'), child], false);
  assert.equal(separated[0].kind, 'activity');
  assert.equal(separated[2].kind, 'activity');
  if (separated[0].kind === 'activity' && separated[2].kind === 'activity') {
    assert.equal(separated[0].cancelled, 1);
    assert.equal(separated[2].failed.length, 1);
  }
  const missing = presentThread([wrapper, { ...child, output: undefined, error: false }], false)[0];
  if (missing.kind === 'activity') {
    assert.equal(missing.cancelled, 1);
    assert.equal(missing.noResult, 1);
  }
});

test('unit: crash/resume interruption stays Failed without explicit owner evidence, even next to a cancellation notice', () => {
  const child = capturedCancellation()[1];
  for (const entries of [[child], [child, { id: 'turn:unknown:cancelled', seq: 2, role: 'system', kind: 'notice', text: 'Turn cancelled' } as ThreadEntry]]) {
    const row = presentThread(entries, false)[0];
    assert.equal(row.kind, 'activity');
    if (row.kind === 'activity') {
      assert.equal(row.failed.length, 1);
      assert.equal(row.cancelled, 0);
      assert.equal(row.state, 'failed');
    }
  }
});

test('a filename mentioning cancelled cannot turn a genuine read failure into a cancellation', () => {
  const rows = presentThread(
    [
      tool(
        'r1',
        'Read',
        { file_path: '/tmp/office-clone-qeTy/floors/droid-office/cancelled.json' },
        { error: true, output: "Error reading file: ENOENT: no such file or directory, access '/tmp/office-clone-qeTy/floors/droid-office/cancelled.json'" },
      ),
      { id: 'turn:t:cancelled', seq: 2, role: 'system', kind: 'notice', text: 'Turn cancelled' },
    ],
    false,
  );
  assert.equal(rows[0].kind, 'activity');
  if (rows[0].kind === 'activity') {
    assert.equal(rows[0].state, 'failed');
    assert.equal(rows[0].actions[0].state, 'failed');
    assert.equal(rows[0].cancelled, 0);
  }
});

test('read counts agree with the visible rows even when the same path was read twice', () => {
  const rows = presentThread([tool('r1', 'Read', { file_path: '/same' }), tool('r2', 'Read', { file_path: '/same' })], false);
  assert.equal(rows[0].kind, 'activity');
  if (rows[0].kind === 'activity') {
    assert.equal(rows[0].label, 'Read 2 files');
    assert.equal(rows[0].actions.length, 2);
  }
});

test('Loop management actions do not claim that a read or cancellation scheduled work', () => {
  for (const [action, title] of [
    ['list', 'Checked scheduled loops'],
    ['pause', 'Paused a loop'],
    ['resume', 'Resumed a loop'],
    ['cancel', 'Cancelled a loop'],
    ['create', 'Scheduled a loop'],
  ]) {
    assert.equal(threadAction(tool('l1', 'Loop', { action })).title, title);
  }
  assert.equal(threadAction(tool('l1', 'Loop', { action: 'cancel' }, { error: true })).title, "Couldn't cancel the loop");
});

test('task controls have meaningful summaries without claiming missing or failed results succeeded', () => {
  for (const [name, input, done, pending, failed] of [
    ['TaskStop', {}, 'Stopped a background task', 'Stopping a background task', "Couldn't stop the background task"],
    ['Loop', { action: 'create' }, 'Scheduled a loop', 'Scheduling a loop', "Couldn't schedule the loop"],
    ['Loop', { action: 'cancel' }, 'Cancelled a loop', 'Cancelling a loop', "Couldn't cancel the loop"],
    ['Loop', { action: 'list' }, 'Checked scheduled loops', 'Checking scheduled loops', "Couldn't read scheduled loops"],
    ['Loop', { action: 'pause' }, 'Paused a loop', 'Pausing a loop', "Couldn't pause the loop"],
    ['Loop', { action: 'resume' }, 'Resumed a loop', 'Resuming a loop', "Couldn't resume the loop"],
  ] as const) {
    for (const [extra, expected] of [
      [{}, done],
      [{ output: undefined }, pending],
      [{ error: true }, failed],
    ] as const) {
      const row = presentThread([tool('t1', name, input, extra)], false)[0];
      assert.equal(row.kind, 'activity');
      if (row.kind === 'activity') assert.equal(row.label, expected);
    }
  }
  const row = presentThread([tool('s1', 'TaskStop'), tool('s2', 'TaskStop', {}, { error: true })], false)[0];
  if (row.kind === 'activity') assert.equal(row.label, '2 attempts to stop background tasks');
  const cancelled = presentThread([tool('s1', 'TaskStop', {}, { error: true, output: 'Tool execution cancelled by user' }), { id: 'turn:stop:cancelled', seq: 2, role: 'system', kind: 'notice', text: 'Turn cancelled' }], false)[0];
  if (cancelled.kind === 'activity') assert.equal(cancelled.label, 'Background task stop cancelled');
});
