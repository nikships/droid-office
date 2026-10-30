import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { needsOwnerAttention, needsOwnerInput, statusTone } from '../src/shared/status.js';
import { statusWord } from '../src/shared/guests.js';
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

test('only main workers ask for owner attention; child CLI status remains available to its lead', () => {
  for (const status of ['starting', 'working', 'needs_input', 'done', 'idle', 'offline', 'exited'] as const) {
    for (const lead of [undefined, 'orchestrator']) {
      for (const acked of [false, true]) {
        const w = { ...worker, status, lead, acked };
        const input = !lead && status === 'needs_input';
        const attention = !lead && (status === 'needs_input' || (status === 'done' && !acked));
        assert.equal(needsOwnerInput(w), input);
        assert.equal(needsOwnerAttention(w), attention);
        assert.equal(waitingOnSomeone(w), attention);
        assert.equal(waitingStatus(w), attention ? status : undefined);
        assert.equal(statusTone(w), lead && status === 'needs_input' ? 'waiting' : status);
        assert.equal(statusWord(w, { needs_input: 'needs you' }), lead && status === 'needs_input' ? 'waiting for lead' : status === 'needs_input' ? 'needs you' : status);
        assert.equal(w.status, status, 'display helpers do not change orchestrator-visible state');
      }
    }
  }
});

test('floor waiting counts and menu-bar notifications exclude delegated questions and completions', () => {
  const workers = [worker, { ...worker, id: 'nibble', lead: worker.id }, { ...worker, id: 'dot', lead: worker.id, status: 'done' as const }, { ...worker, id: 'widget', lead: 'departed-lead', status: 'needs_input' as const }];
  const status = officeStatus([{ id: 'home', name: 'Home', workers }], []);
  assert.equal(status.workers, 4);
  assert.equal(status.needsInput, 1);
  assert.equal(status.done, 0);
  assert.deepEqual(
    status.waiting.map((w) => w.id),
    [worker.id],
  );
  assert.equal(waitingStatus({ ...worker, kind: 'shell' }), undefined);
});

test('desktop alerts ignore subagents before checking browser notification permissions', () => {
  // No browser globals: the delegated status must exit before touching Notification or document.
  DesktopNotifier.prototype.alert.call({} as DesktopNotifier, { ...worker, status: 'needs_input', lead: 'orchestrator' });
  DesktopNotifier.prototype.alert.call({} as DesktopNotifier, { ...worker, status: 'done', lead: 'orchestrator' });
});
