import test from 'node:test';
import assert from 'node:assert/strict';
import { companionCapabilities, companionRoster, companionWorkedMs } from '../src/shared/companion-roster.js';
import { companionFloorWorkspace, companionWorkspaceLayout, createCompanionWorkspace, reduceCompanionWorkspace, restoreCompanionWorkspace } from '../src/shared/companion-workspace.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const worker = (id: string, patch: Partial<WorkerInfo> = {}): WorkerInfo => ({
  id,
  name: id,
  kind: 'agent',
  deskId: 'desk',
  color: '#fff',
  status: 'idle',
  acked: false,
  createdBy: 'owner',
  createdAt: 1,
  cols: 80,
  rows: 24,
  open: false,
  ...patch,
});

test('roster uses supervision, not fork ancestry or team identity; all kinds remain visible', () => {
  const workers = [
    worker('lead'),
    worker('child', { lead: 'lead', status: 'needs_input' }),
    worker('grandchild', { lead: 'child', kind: 'shell', status: 'working' }),
    worker('fork', { forkedFrom: { workerId: 'lead', name: 'lead', sessionId: 'session' } }),
    worker('orphan', { lead: 'departed' }),
    worker('cloud', { kind: 'cloud' }),
  ];
  const rows = companionRoster(workers);
  assert.equal(rows.length, workers.length);
  assert.equal(rows.find((r) => r.worker.id === 'child')?.depth, 1);
  assert.equal(rows.find((r) => r.worker.id === 'grandchild')?.depth, 2);
  assert.equal(rows.find((r) => r.worker.id === 'fork')?.depth, 0);
  assert.equal(rows.find((r) => r.worker.id === 'orphan')?.depth, 0);
  const lead = rows.find((r) => r.worker.id === 'lead')!;
  assert.equal(lead.childCount, 1);
  assert.equal(lead.descendantCount, 2);
  assert.deepEqual(lead.childStatuses, { needs_input: 1, working: 1 });
  const collapsed = companionRoster(workers, {}, new Set(['lead']));
  assert.equal(collapsed.length, 4);
  const filtered = companionRoster(workers, { query: 'grandchild', kind: 'shell' }, new Set(['lead']));
  assert.deepEqual(
    filtered.map((r) => [r.worker.id, r.matches]),
    [
      ['lead', false],
      ['child', false],
      ['grandchild', true],
    ],
  );
});

test('malformed supervision cycles stay bounded and visible', () => {
  const rows = companionRoster([worker('a', { lead: 'b' }), worker('b', { lead: 'a' }), worker('c', { lead: 'c' })]);
  assert.deepEqual(
    rows.map((r) => r.depth),
    [0, 0, 0],
  );
});

test('prototype-like floor IDs are ordinary isolated workspaces', () => {
  let state = createCompanionWorkspace();
  for (const floor of ['__proto__', 'constructor', 'toString']) {
    assert.deepEqual(companionFloorWorkspace(state, floor).panes, []);
    state = reduceCompanionWorkspace(state, { type: 'open', floor, workerId: floor });
  }
  assert.equal(Object.keys(state.floors).length, 3);
  for (const floor of ['__proto__', 'constructor', 'toString']) assert.equal(companionFloorWorkspace(state, floor).panes[0]?.workerId, floor);
  assert.equal(Object.getPrototypeOf(state.floors), Object.prototype);
});

test('reconciliation cannot select an unpinned worker and preserves an intentional roster view', () => {
  let state = reduceCompanionWorkspace(createCompanionWorkspace(), { type: 'open', floor: 'one', workerId: 'pinned' });
  state.floors.one!.active = 'unpinned';
  state = reduceCompanionWorkspace(state, { type: 'reconcile', floor: 'one', workerIds: ['pinned', 'unpinned'] });
  assert.equal(state.floors.one!.active, 'pinned');
  state = reduceCompanionWorkspace(state, { type: 'focus', floor: 'one', workerId: '' });
  state = reduceCompanionWorkspace(state, { type: 'reconcile', floor: 'one', workerIds: ['pinned'] });
  assert.equal(state.floors.one!.active, '');
});

test('untrusted persisted layouts restore four distinct panes and no drafts, epochs or invalid active ID', () => {
  for (const value of [null, 5, [], { floors: [] }, { floors: { a: 4 } }]) assert.deepEqual(restoreCompanionWorkspace(value), createCompanionWorkspace());
  const saved = JSON.parse(
    '{"epoch":9,"floors":{"__proto__":{"panes":[null,{},{"workerId":"a","view":"terminal","size":99},{"workerId":"a"},{"workerId":"b","view":"unknown","size":-1},{"workerId":"c"},{"workerId":"d"},{"workerId":"e"}],"active":"not-pinned","collapsed":["a","a",2],"drafts":{"a":{"text":"never replay","attachments":["image"]}}}}}',
  );
  const state = restoreCompanionWorkspace(saved);
  const floor = companionFloorWorkspace(state, '__proto__');
  assert.equal(state.epoch, 0);
  assert.deepEqual(
    floor.panes.map((p) => p.workerId),
    ['a', 'b', 'c', 'd'],
  );
  assert.equal(floor.panes[0]?.view, 'terminal');
  assert.equal(floor.panes[0]?.size, 4);
  assert.equal(floor.panes[1]?.view, 'thread');
  assert.equal(floor.panes[1]?.size, 0.25);
  assert.equal(floor.active, 'd');
  assert.deepEqual(floor.collapsed, ['a']);
  assert.deepEqual(floor.drafts, {});
});

test('capabilities and duration do not infer activity timestamps', () => {
  assert.equal(companionCapabilities(worker('cloud', { kind: 'cloud' })).terminal, false);
  assert.equal(companionCapabilities(worker('shell', { kind: 'shell' })).thread, false);
  assert.equal(companionCapabilities(worker('lost', { lost: { branch: 'here' } })).prompt, false);
  assert.equal(companionWorkedMs(worker('a', { workedMs: 120, workingSince: 100 }), 160), 180);
  assert.equal(companionWorkedMs(worker('a'), 160), 0);
});

test('persisted restore bounds floor count, IDs, collapsed rows and scanned invalid panes', () => {
  const floor = { panes: [{ workerId: 'worker' }], collapsed: Array.from({ length: 501 }, (_, i) => `child-${i}`) };
  const floors = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`floor-${i}`, floor]));
  const state = restoreCompanionWorkspace({ floors });
  assert.equal(Object.keys(state.floors).length, 200);
  assert.equal(Object.hasOwn(state.floors, 'floor-200'), false);
  assert.equal(state.floors['floor-0']?.collapsed.length, 500);
  assert.equal(state.floors['floor-0']?.collapsed.at(-1), 'child-499');
  const long = 'x'.repeat(201);
  const boundary = 'x'.repeat(200);
  const bounded = restoreCompanionWorkspace({
    floors: {
      [long]: floor,
      [boundary]: { panes: [{ workerId: long }, { workerId: boundary }], collapsed: [long, boundary], active: long },
      invalid: { panes: [...Array.from({ length: 100 }, () => null), { workerId: 'not-scanned' }] },
    },
  });
  assert.equal(Object.hasOwn(bounded.floors, long), false);
  assert.deepEqual(
    bounded.floors[boundary]?.panes.map((p) => p.workerId),
    [boundary],
  );
  assert.deepEqual(bounded.floors[boundary]?.collapsed, [boundary]);
  assert.equal(bounded.floors[boundary]?.active, boundary);
  assert.deepEqual(bounded.floors.invalid?.panes, []);
  // The cap applies before accessing later values, not only after filtering or building arrays.
  Object.defineProperty(floors, 'beyond-cap', {
    enumerable: true,
    get: () => {
      throw Error('Read beyond floor bound');
    },
  });
  assert.equal(Object.keys(restoreCompanionWorkspace({ floors }).floors).length, 200);
});

test('one to four distinct panes, new panes default Thread and existing panes focus without duplication', () => {
  let state = createCompanionWorkspace();
  for (const workerId of ['a', 'b', 'c', 'd', 'e']) state = reduceCompanionWorkspace(state, { type: 'open', floor: 'one', workerId, pin: true });
  assert.equal(state.floors.one!.panes.length, 4);
  assert.equal(state.floors.one!.active, 'd');
  state = reduceCompanionWorkspace(state, { type: 'view', floor: 'one', workerId: 'a', view: 'terminal' });
  state = reduceCompanionWorkspace(state, { type: 'open', floor: 'one', workerId: 'a', pin: true });
  assert.equal(state.floors.one!.active, 'a');
  assert.equal(state.floors.one!.panes[0]!.view, 'terminal');
  state = reduceCompanionWorkspace(state, { type: 'open', floor: 'one', workerId: 'e' });
  assert.deepEqual(state.floors.one!.panes[0], { workerId: 'e', view: 'thread', size: 1 });
  state = reduceCompanionWorkspace(state, { type: 'resize', floor: 'one', workerId: 'e', size: 99 });
  assert.equal(state.floors.one!.panes[0]!.size, 4);
  state = reduceCompanionWorkspace(state, { type: 'close', floor: 'one', workerId: 'e' });
  assert.equal(state.floors.one!.active, 'b');
});

test('floor switching preserves drafts; actual disconnect clears every floor without losing panes or replaying', () => {
  let state = createCompanionWorkspace();
  for (const floor of ['one', 'two']) {
    state = reduceCompanionWorkspace(state, { type: 'open', floor, workerId: 'same' });
    state = reduceCompanionWorkspace(state, { type: 'draft', floor, workerId: 'same', draft: { text: floor, attachments: ['upload'] } });
  }
  assert.equal(state.floors.one!.drafts.same!.text, 'one');
  assert.equal(state.floors.two!.drafts.same!.text, 'two');
  assert.deepEqual(companionWorkspaceLayout(state).floors.one!.drafts, {});
  assert.equal(state.floors.one!.drafts.same!.text, 'one');
  const disconnected = reduceCompanionWorkspace(state, { type: 'disconnect' });
  assert.equal(disconnected.epoch, 1);
  for (const floor of ['one', 'two']) {
    assert.deepEqual(disconnected.floors[floor]!.drafts, {});
    assert.equal(disconnected.floors[floor]!.panes[0]!.workerId, 'same');
  }
});

test('reconciliation removes only departed panes, without dismissing or losing children', () => {
  let state = createCompanionWorkspace();
  for (const workerId of ['lead', 'child']) state = reduceCompanionWorkspace(state, { type: 'open', floor: 'one', workerId, pin: true });
  state = reduceCompanionWorkspace(state, { type: 'collapse', floor: 'one', workerId: 'lead' });
  state = reduceCompanionWorkspace(state, { type: 'reconcile', floor: 'one', workerIds: ['child'] });
  assert.deepEqual(
    state.floors.one!.panes.map((p) => p.workerId),
    ['child'],
  );
  assert.deepEqual(state.floors.one!.collapsed, []);
});
