import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doingLine } from '../src/client/worker-words.js';
import { workerActivity } from '../src/shared/status.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const worker = { kind: 'agent', status: 'working', activity: 'Read: instructions.md', title: 'Original session title', task: { name: 'Worker Conversation Labels', summary: 'Checking cancellation handling', generated: true } } as WorkerInfo;

test('generated current work wins over a stale tool hint without changing the subject or session title', () => {
  assert.equal(workerActivity(worker), 'Checking cancellation handling');
  assert.equal(doingLine(worker), 'Checking cancellation handling');
  assert.equal(worker.task?.name, 'Worker Conversation Labels');
  assert.equal(worker.title, 'Original session title');
});

test('live questions, missing worktrees and cloud errors win over generated text', () => {
  assert.equal(workerActivity({ ...worker, status: 'needs_input', activity: 'Approve the command?' }), 'Approve the command?');
  assert.equal(doingLine({ ...worker, status: 'needs_input', activity: 'Approve the command?' }), 'Approve the command?');
  assert.equal(workerActivity({ ...worker, lost: { branch: 'here' } }), 'Worktree missing');
  assert.equal(doingLine({ ...worker, lost: { branch: 'here' } }), 'Worktree missing');
  assert.equal(workerActivity({ ...worker, cloud: { error: 'Computer stopped' } as WorkerInfo['cloud'] }), 'Computer stopped');
});

test('cloud and preview labels keep live activity ahead of an earlier task summary', () => {
  const legacy = { ...worker, task: { name: 'Earlier turn', summary: 'Finished the earlier task' }, activity: 'Checking the new cloud turn' };
  assert.equal(workerActivity({ ...legacy, cloud: {} as WorkerInfo['cloud'] }), 'Checking the new cloud turn');
  assert.equal(workerActivity(legacy), 'Checking the new cloud turn');
  assert.equal(workerActivity({ ...legacy, activity: undefined }), 'Finished the earlier task');
});
