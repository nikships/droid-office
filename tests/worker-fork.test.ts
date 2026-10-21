import assert from 'node:assert/strict';
import test from 'node:test';
import { DESK_BY_ID, DESKS } from '../src/shared/layout.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { forkLinks, forkRefusal, nearestForkSeat } from '../src/shared/worker-fork.js';

const worker = (id: string): WorkerInfo => ({ id, kind: 'agent', name: id, deskId: 'desk-1', color: '#ff8a5b', status: 'done', sessionId: `${id}-session`, acked: true, createdBy: 'test', createdAt: 0, cols: 100, rows: 30, open: false });

test('fork eligibility admits only local agents between turns with a known session', () => {
  const w = worker('source');
  assert.equal(forkRefusal(w), undefined);
  assert.equal(forkRefusal({ ...w, status: 'idle' }), undefined);
  for (const status of ['starting', 'working', 'needs_input', 'offline', 'exited'] as const) assert.match(forkRefusal({ ...w, status })!, /turn ends/);
  assert.match(forkRefusal({ ...w, kind: 'shell' })!, /local Droid/);
  assert.match(forkRefusal({ ...w, kind: 'cloud' })!, /local Droid/);
  assert.match(forkRefusal({ ...w, sessionId: undefined })!, /session to start/);
  assert.match(forkRefusal({ ...w, lost: { branch: 'here' } })!, /missing worktree/);
  assert.match(forkRefusal({ ...w, prOpening: true })!, /pull request/);
});

test('the nearest available desk wins, guests hold seats, and overflow uses a bean bag', () => {
  const source = DESK_BY_ID.get('desk-1')!;
  const taken = new Set(['desk-1']);
  assert.equal(nearestForkSeat(source, (id) => taken.has(id))?.id, 'desk-3');
  taken.add('desk-3');
  assert.equal(nearestForkSeat(source, (id) => taken.has(id))?.id, 'desk-2');
  for (const d of DESKS) taken.add(d.id);
  assert.equal(nearestForkSeat(source, (id) => taken.has(id))?.beanbag, true);
  assert.equal(
    nearestForkSeat(source, () => true),
    undefined,
  );
});

test('fork links are separate from teams and vanish once either endpoint leaves', () => {
  const source = worker('source');
  const twin = { ...worker('twin'), forkedFrom: { workerId: source.id, name: source.name, sessionId: source.sessionId! } };
  assert.deepEqual(forkLinks([source, twin]), [{ source, twin }]);
  assert.deepEqual(forkLinks([twin]), []);
  assert.deepEqual(forkLinks([source]), []);
  assert.equal(twin.lead, undefined);
});
