import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { needsOwnerAttention, needsOwnerInput, STATUS_MARK_WORD, statusMark } from '../src/shared/status.js';
import { waitingOnSomeone, DesktopNotifier } from '../src/client/notify.js';
import { officeStatus, waitingStatus } from '../src/server/office-status.js';

const worker: WorkerInfo = {
  id: 'pixel',
  name: 'Pixel',
  kind: 'agent',
  color: '#a8d354',
  deskId: 'desk-1',
  createdAt: 1,
  createdBy: 'test',
  status: 'needs_input',
  acked: false,
  cols: 80,
  rows: 24,
  open: false,
};

test('all terminal questions need the owner, while subagent completions stay with the lead', () => {
  for (const status of ['starting', 'working', 'needs_input', 'done', 'idle', 'offline', 'exited'] as const) {
    for (const lead of [undefined, 'orchestrator']) {
      for (const acked of [false, true]) {
        const w = { ...worker, status, lead, acked };
        const input = status === 'needs_input';
        const attention = input || (!lead && status === 'done' && !acked);
        assert.equal(needsOwnerInput(w), input);
        assert.equal(needsOwnerAttention(w), attention);
        assert.equal(waitingOnSomeone(w), attention);
        assert.equal(waitingStatus(w), attention ? status : undefined);
        assert.equal(w.status, status, 'display helpers do not change orchestrator-visible state');
      }
    }
  }
});

test('each status wears the same mark and word as Android’s StatusIcon', () => {
  const marks = (['starting', 'working', 'needs_input', 'done', 'idle', 'offline', 'exited'] as const).map((status) => [status, statusMark(status), statusMark(status, false)]);
  assert.deepEqual(marks, [
    ['starting', 'starting', 'starting'],
    ['working', 'working', 'working'],
    ['needs_input', 'needs_you', 'needs_you'],
    ['done', 'done', 'done_new'],
    ['idle', 'ready', 'ready'],
    ['offline', 'asleep', 'asleep'],
    ['exited', 'asleep', 'asleep'],
  ]);
  assert.equal(statusMark('working', true, true), 'blocked', 'a blocked Orchestrator says so whatever it last reported');
  assert.deepEqual(
    (['needs_you', 'done_new', 'ready', 'asleep'] as const).map((mark) => STATUS_MARK_WORD[mark]),
    ['Needs you', 'Done · new', 'Ready', 'Asleep'],
  );
});
test('floor waiting counts include subagent questions, even after their lead leaves', () => {
  const workers = [worker, { ...worker, id: 'nibble', lead: worker.id }, { ...worker, id: 'dot', lead: worker.id, status: 'done' as const }, { ...worker, id: 'widget', lead: 'departed-lead', status: 'needs_input' as const }];
  const status = officeStatus([{ id: 'home', name: 'Home', workers }], []);
  assert.equal(status.workers, 4);
  assert.equal(status.needsInput, 3);
  assert.equal(status.done, 0);
  assert.deepEqual(
    status.waiting.map((w) => w.id),
    ['nibble', worker.id, 'widget'],
  );
  assert.equal(waitingStatus({ ...worker, kind: 'shell' }), undefined);
});

test('desktop alerts ignore subagent completions but check whether input alerts are enabled', () => {
  let checked = false;
  DesktopNotifier.prototype.alert.call(
    {
      enabled: () => {
        checked = true;
        return false;
      },
    } as unknown as DesktopNotifier,
    { ...worker, status: 'needs_input', lead: 'orchestrator' },
  );
  assert.equal(checked, true);
  DesktopNotifier.prototype.alert.call({} as DesktopNotifier, { ...worker, status: 'done', lead: 'orchestrator' });
});
