import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StateReplay } from '../src/shared/companion-replay.js';
import type { ServerMsg } from '../src/shared/protocol.js';

// Only the fields the replay reads; the store applies the rest as they come.
const welcome = (floor: string) => ({ t: 'welcome', floor, workers: [] }) as unknown as ServerMsg;
const enter = (floor: string) => ({ t: 'floor.enter', floor, workers: [] }) as unknown as ServerMsg;
const update = (id: string, status: string) => ({ t: 'worker.update', worker: { id, status } }) as unknown as ServerMsg;
const remove = (workerId: string): ServerMsg => ({ t: 'worker.remove', workerId });
const kinds = (msgs: ServerMsg[]) => msgs.map((m) => (m.t === 'worker.update' ? `${m.t}:${m.worker.id}:${m.worker.status}` : m.t === 'worker.remove' ? `${m.t}:${m.workerId}` : m.t));

test('nothing replays before a welcome', () => {
  const r = new StateReplay();
  r.record(update('w1', 'idle'));
  r.record({ t: 'floors', floors: [] });
  assert.deepEqual(r.snapshot(), []);
  assert.equal(r.floorId(), null);
});

test('the replay is the welcome, the floor, the latest state and each worker once', () => {
  const r = new StateReplay();
  r.record(welcome('f1'));
  r.record({ t: 'floors', floors: [] });
  r.record(update('w1', 'idle'));
  r.record(update('w2', 'working'));
  r.record(update('w1', 'working'));
  r.record({ t: 'term.data', workerId: 'w1', data: 'x' });
  r.record({ t: 'toast', text: 'hi', level: 'info' } as ServerMsg);
  r.record({ t: 'floors', floors: [{ id: 'f1' }] } as unknown as ServerMsg);
  r.record({ t: 'whiteboard', floor: 'f1' } as unknown as ServerMsg);
  r.record(remove('w2'));
  const snap = r.snapshot();
  assert.deepEqual(kinds(snap), ['welcome', 'floors', 'worker.update:w1:working', 'worker.remove:w2']);
  assert.deepEqual((snap[1] as Extract<ServerMsg, { t: 'floors' }>).floors, [{ id: 'f1' }]);
  assert.equal(r.floorId(), 'f1');
});

test('a floor change drops the old floor and keeps the office', () => {
  const r = new StateReplay();
  r.record(welcome('f1'));
  r.record({ t: 'subagents', state: {} } as unknown as ServerMsg);
  r.record({ t: 'gh.pulls', state: {} } as unknown as ServerMsg);
  r.record({ t: 'visits', visits: [] });
  assert.ok(kinds(r.snapshot()).includes('visits'));
  r.record(update('w1', 'idle'));
  r.record(enter('f2'));
  r.record(update('w9', 'idle'));
  assert.deepEqual(kinds(r.snapshot()), ['welcome', 'floor.enter', 'subagents', 'worker.update:w9:idle']);
  assert.equal(r.floorId(), 'f2');
});

test('a new welcome or a closed socket starts over', () => {
  const r = new StateReplay();
  r.record(welcome('f1'));
  r.record(enter('f2'));
  r.record({ t: 'factory', state: {} } as unknown as ServerMsg);
  r.record(welcome('f3'));
  assert.deepEqual(kinds(r.snapshot()), ['welcome']);
  assert.equal(r.floorId(), 'f3');
  r.reset();
  assert.deepEqual(r.snapshot(), []);
});
