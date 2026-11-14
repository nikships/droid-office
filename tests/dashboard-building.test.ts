import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type BuildingFilter, type BuildingWorkerRow, buildingCounts, buildingRoster, filterBuildingRows, MISSION_FLOOR } from '../src/client/dashboard-building.js';
import { type MissionControlState, ORCHESTRATOR_ID } from '../src/shared/mission-control.js';
import type { FloorInfo, FloorRoster, WorkerInfo } from '../src/shared/protocol.js';

function worker(id: string, extra: Partial<WorkerInfo> = {}): WorkerInfo {
  return { id, name: id, kind: 'agent', deskId: `desk-${id}`, color: '#ee6018', status: 'idle', acked: true, createdBy: 'owner', createdAt: 0, cols: 80, rows: 24, open: false, ...extra };
}

function floor(id: string, extra: Partial<FloorInfo> = {}): FloorInfo {
  return { id, name: id, dir: `/projects/${id}`, palette: 0, addedBy: 'owner', addedAt: 0, workers: 0, busy: 0, waiting: 0, ...extra };
}

function building(...entries: [string, WorkerInfo[]][]): Map<string, FloorRoster> {
  return new Map(entries.map(([id, workers]) => [id, { floor: id, workers, pulls: [] }]));
}

function mission(on = true, extra: Partial<MissionControlState> = {}): MissionControlState {
  return { orchestrator: { settings: { on }, team: [] }, bots: [], ...extra };
}

function roster(workers: WorkerInfo[]): BuildingWorkerRow[] {
  return buildingRoster({ floors: [floor('office')], building: new Map(), currentFloor: 'office', workers });
}

function ids(rows: readonly BuildingWorkerRow[]): string[] {
  return rows.map((row) => row.worker.id);
}

test('aggregates floors with repo context, including a snapshot arriving before floor metadata', () => {
  const rows = buildingRoster({
    floors: [floor('web', { name: 'Website', repo: 'nikships/droid-office' }), floor('android')],
    building: building(['web', [worker('Pixel')]], ['android', [worker('Byte')]], ['loading', [worker('Nibble')]]),
    currentFloor: null,
    workers: [],
  });
  assert.deepEqual(ids(rows), ['Pixel', 'Byte', 'Nibble']);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.floorId, row.floorName, row.repo]),
    [
      ['desk', 'web', 'Website', 'nikships/droid-office'],
      ['desk', 'android', 'android', undefined],
      ['desk', 'loading', 'loading', undefined],
    ],
  );
  assert.deepEqual(buildingRoster({ floors: [], building: new Map(), currentFloor: null, workers: [] }), []);
});

test('current-floor live workers replace stale snapshots, including removals and duplicates on other floors', () => {
  const live = worker('Pixel', { status: 'working' });
  const rows = buildingRoster({
    floors: [floor('stale-first'), floor('current')],
    building: building(['stale-first', [worker('Pixel', { status: 'offline' }), worker('Byte')]], ['current', [worker('Pixel'), worker('removed')]]),
    currentFloor: 'current',
    workers: new Map([[live.id, live]]).values(),
  });
  assert.deepEqual(ids(rows), ['Pixel', 'Byte']);
  assert.equal(rows[0].worker, live);
  assert.equal(rows[0].floorId, 'current');
  const empty = buildingRoster({ floors: [floor('current')], building: building(['current', [worker('removed')]]), currentFloor: 'current', workers: [] });
  assert.deepEqual(empty, []);
});

test('deduplicates workers by floor order and handles a current floor without its roster or metadata yet', () => {
  const rows = buildingRoster({
    floors: [floor('first'), floor('second')],
    building: building(['second', [worker('same', { name: 'Stale' })]], ['first', [worker('same', { name: 'First' }), worker('same')]]),
    currentFloor: 'new',
    workers: [worker('new-worker')],
  });
  assert.deepEqual(ids(rows), ['same', 'new-worker']);
  assert.equal(rows[0].worker.name, 'First');
  assert.equal(rows[1].floorName, 'new');
});

test('shows one Orchestrator stand-in while on with a team and never resurrects it from a stale floor while off', () => {
  const sub = { id: 'w-sub', name: 'Sub', floor: 'web', floorName: 'web', status: 'working' as const };
  const input = { floors: [floor('web')], building: building(['web', [worker(ORCHESTRATOR_ID)]]), currentFloor: null, workers: [] };
  assert.deepEqual(buildingRoster({ ...input, mission: mission() }), [], 'an Orchestrator without subagents stays out of the list');
  const rows = buildingRoster({ ...input, mission: mission(true, { orchestrator: { settings: { on: true }, team: [sub] } }) });
  assert.deepEqual(ids(rows), [ORCHESTRATOR_ID]);
  assert.equal(rows[0].kind, 'orchestrator');
  assert.equal(rows[0].floorId, MISSION_FLOOR);
  assert.equal(rows[0].floorName, 'Mission Control');
  assert.equal(rows[0].worker.status, 'idle');
  assert.deepEqual(buildingRoster({ ...input, mission: mission(false) }), []);
  assert.deepEqual(buildingRoster(input), []);
  const active = worker(ORCHESTRATOR_ID, { status: 'working' });
  const state = mission(true, { orchestrator: { settings: { on: true }, team: [sub], agent: { worker: active, team: [sub] } } });
  assert.equal(buildingRoster({ ...input, mission: state })[0].worker, active);
  const lead = worker('w-sub', { lead: ORCHESTRATOR_ID });
  assert.deepEqual(ids(buildingRoster({ ...input, building: building(['web', [lead]]), mission: mission() })), [ORCHESTRATOR_ID, 'w-sub'], 'a subagent seen on a floor counts as its team');
});

test('bots with a team appear once from Mission Control and fall back to remote floor workers without mission state', () => {
  const bot = worker('bot', { remote: true, status: 'working' });
  const sub = worker('bot-sub', { lead: 'bot' });
  const input = { floors: [floor('web'), floor('android')], building: building(['web', [bot, sub]], ['android', [bot]]), currentFloor: null, workers: [] };
  const state = mission(false, {
    bots: [
      { worker: bot, team: [] },
      { worker: bot, team: [] },
    ],
  });
  assert.deepEqual(ids(buildingRoster({ ...input, building: building(['web', [bot]]) })), [], 'a lone legacy bot stays out of the list');
  assert.deepEqual(ids(buildingRoster({ ...input, building: new Map(), mission: state })), [], 'a lone bot stays out of the list');
  for (const rows of [buildingRoster(input), buildingRoster({ ...input, mission: state })]) {
    assert.deepEqual(ids(rows), ['bot', 'bot-sub']);
    assert.equal(rows[0].kind, 'bot');
    assert.equal(rows[0].floorId, MISSION_FLOOR);
  }
  assert.equal(buildingRoster(input)[0].navigationFloor, 'web', 'legacy floor bots must retain their navigation destination');
  assert.equal(buildingRoster({ ...input, mission: state })[0].navigationFloor, undefined, 'real Mission Control agents open globally');
  assert.equal(buildingRoster({ ...input, building: building(['web', [bot]], ['android', [bot, sub]]), currentFloor: 'android', workers: [bot, sub] })[0].navigationFloor, 'android', 'the live floor wins over an old duplicate');
  assert.deepEqual(ids(buildingRoster({ ...input, mission: mission(false) })), ['bot-sub']);
});

test('links cross-floor teams and resolves Mission Control and departed lead names', () => {
  const rows = buildingRoster({
    floors: [floor('web'), floor('android')],
    building: building(
      ['web', [worker('Pixel', { name: 'Pixel Prime', team: { id: 'Pixel', role: 'lead', accent: '#ee6018', emblem: 'star', leadName: 'Pixel Prime' } }), worker('orch-sub', { lead: ORCHESTRATOR_ID }), worker('bot-sub', { lead: 'bot' })]],
      ['android', [worker('Nibble', { lead: 'Pixel' }), worker('orphan', { lead: 'gone', team: { id: 'gone', role: 'member', accent: '#ee6018', emblem: 'star', leadName: 'Former lead' } })]],
    ),
    currentFloor: null,
    workers: [],
    mission: mission(true, { bots: [{ worker: worker('bot', { remote: true, name: 'Atlas' }), team: [] }] }),
  });
  const byId = new Map(rows.map((row) => [row.worker.id, row]));
  assert.equal(byId.get('Pixel')?.leadName, undefined, 'a lead is not its own subworker');
  assert.equal(byId.get('Nibble')?.leadName, 'Pixel Prime');
  assert.equal(byId.get('Nibble')?.depth, 1);
  assert.equal(byId.get('orch-sub')?.leadName, 'Orchestrator');
  assert.equal(byId.get('orch-sub')?.depth, 1);
  assert.equal(byId.get('bot-sub')?.leadName, 'Atlas');
  assert.equal(byId.get('bot-sub')?.depth, 1);
  assert.equal(byId.get('orphan')?.leadName, 'Former lead');
  assert.equal(byId.get('orphan')?.depth, 0);
  for (const [parent, child] of [
    ['Pixel', 'Nibble'],
    [ORCHESTRATOR_ID, 'orch-sub'],
    ['bot', 'bot-sub'],
  ])
    assert.equal(ids(rows).indexOf(child), ids(rows).indexOf(parent) + 1);
});

test('an input request in a subworker lifts its whole team above unread main completions and working workers', () => {
  const rows = roster([
    worker('working', { status: 'working' }),
    worker('completed', { status: 'done', acked: false }),
    worker('lead'),
    worker('sub-done', { lead: 'lead', status: 'done', acked: false }),
    worker('sub-question', { lead: 'lead', status: 'needs_input', waitingSince: 5 }),
    worker('starting', { status: 'starting' }),
    worker('asleep', { status: 'offline' }),
  ]);
  assert.deepEqual(ids(rows), ['lead', 'sub-question', 'sub-done', 'completed', 'working', 'starting', 'asleep']);
  assert.deepEqual(
    rows.slice(0, 3).map((row) => row.depth),
    [0, 1, 1],
  );
  assert.deepEqual(ids(roster([worker('sub', { lead: 'lead', status: 'done', acked: false }), worker('lead'), worker('working', { status: 'working' })])), ['working', 'lead', 'sub']);
});

test('orders urgent groups by oldest waiting member and breaks ties by floor, hire time, then id', () => {
  const rows = roster([
    worker('old-lead', { createdAt: 10 }),
    worker('old-sub', { lead: 'old-lead', status: 'needs_input', waitingSince: 1 }),
    worker('new-question', { status: 'needs_input', waitingSince: 2 }),
    worker('unknown-wait', { status: 'needs_input' }),
    worker('z', { createdAt: 20 }),
    worker('b', { createdAt: 10 }),
    worker('a', { createdAt: 10 }),
  ]);
  assert.deepEqual(ids(rows), ['old-lead', 'old-sub', 'new-question', 'unknown-wait', 'a', 'b', 'z']);
  assert.deepEqual(ids(roster([...rows].reverse().map((row) => row.worker))), ids(rows));
});

test('self links, missing leads, cycles and nested descendants never hide or repeat workers', () => {
  const workers = [
    worker('a', { lead: 'b' }),
    worker('b', { lead: 'a', status: 'needs_input' }),
    worker('child', { lead: 'a' }),
    worker('grandchild', { lead: 'child' }),
    worker('deep', { lead: 'grandchild' }),
    worker('self', { lead: 'self' }),
    worker('orphan', { lead: 'gone' }),
  ];
  const rows = roster(workers);
  assert.deepEqual(ids(rows), ['b', 'a', 'child', 'grandchild', 'deep', 'orphan', 'self']);
  assert.deepEqual(
    rows.slice(0, 5).map((row) => row.depth),
    [0, 1, 2, 2, 2],
  );
  assert.equal(new Set(ids(rows)).size, workers.length);
  assert.deepEqual(ids(roster([...workers].reverse())), ids(rows));
});

test('counts and status filters distinguish actionable input, all done, startup, idle and asleep', () => {
  const rows = buildingRoster({
    floors: [floor('office')],
    building: building([
      'office',
      [
        worker('ask', { status: 'needs_input', acked: true, lead: 'lead' }),
        worker('lead'),
        worker('working', { status: 'working' }),
        worker('starting', { status: 'starting' }),
        worker('done-new', { status: 'done', acked: false }),
        worker('done-read', { status: 'done' }),
        worker('done-sub', { status: 'done', acked: false, lead: 'lead' }),
        worker('exited', { status: 'exited' }),
        worker('offline', { status: 'offline' }),
        worker('bot-sub', { status: 'done', lead: 'bot-done' }),
      ],
    ]),
    currentFloor: null,
    workers: [],
    mission: mission(false, {
      bots: [
        { worker: worker('bot-ask', { status: 'needs_input', remote: true }), team: [{ id: 'bot-ask-sub', name: 'Sub', floor: 'elsewhere', floorName: 'elsewhere', status: 'idle' }] },
        { worker: worker('bot-done', { status: 'done', remote: true, acked: false }), team: [] },
      ],
    }),
  });
  assert.deepEqual(buildingCounts(rows), { all: 12, needs_input: 1, working: 2, done: 5, asleep: 2 });
  const expected: Record<BuildingFilter, string[]> = {
    all: ids(rows).sort(),
    needs_input: ['ask'],
    working: ['starting', 'working'],
    done: ['bot-done', 'bot-sub', 'done-new', 'done-read', 'done-sub'],
    asleep: ['exited', 'offline'],
  };
  for (const filter of Object.keys(expected) as BuildingFilter[]) assert.deepEqual(ids(filterBuildingRows(rows, '', '', filter)).sort(), expected[filter]);
  assert.deepEqual(buildingCounts([]), { all: 0, needs_input: 0, working: 0, done: 0, asleep: 0 });
  assert.equal(rows[0].worker.id, 'lead', 'a bot request must not outrank a desk request');
});

test('search matches every supported field, multiple words across fields, and no nonmatching ancestors', () => {
  const rows = buildingRoster({
    floors: [floor('web', { name: 'Public website', repo: 'nikships/droid-office' })],
    building: new Map(),
    currentFloor: 'web',
    workers: [
      worker('lead', { name: 'Pixel' }),
      worker('sub', {
        name: 'Nibble',
        lead: 'lead',
        title: 'Companion roster',
        task: { name: 'Aggregation', summary: 'Cross-floor workers' },
        activity: 'Running tests',
        prompt: 'Ship carefully',
        model: 'requested-model',
        activeModel: 'active-model',
        status: 'working',
        worktree: { path: 'worktree', branch: 'office/roster', base: 'abc' },
        repos: [{ floor: 'android', name: 'phone-folder', repo: 'nikships/mobile', dir: '/projects/mobile', path: 'mobile', branch: 'office/phone', base: 'abc' }],
      }),
    ],
  });
  for (const query of ['NIBBLE', 'companion', 'aggregation', 'cross-floor', 'tests', 'carefully', 'requested-model', 'active-model', 'phone-folder', 'nikships/mobile', 'office/phone', 'office/roster']) {
    const filtered = filterBuildingRows(rows, query, '', 'all');
    assert.deepEqual(ids(filtered), ['sub'], query);
    assert.equal(filtered[0].leadName, 'Pixel');
    assert.equal(filtered[0].depth, 0);
  }
  assert.deepEqual(ids(filterBuildingRows(rows, '  PUBLIC   pixel   OFFICE/ROSTER  ', 'web', 'working')), ['sub']);
  assert.deepEqual(ids(filterBuildingRows(rows, 'nikships/droid-office', 'all', 'all')), ['lead', 'sub']);
  assert.deepEqual(filterBuildingRows(rows, 'missing', '', 'all'), []);
  assert.deepEqual(filterBuildingRows(rows, 'Nibble', 'android', 'all'), []);
  assert.deepEqual(filterBuildingRows(rows, 'Nibble', 'web', 'done'), []);
  assert.equal(rows[1].depth, 1, 'filtering must not mutate source rows');
});

test('filtering by floor resets hidden ancestors while keeping visible team links', () => {
  const rows = buildingRoster({
    floors: [floor('web'), floor('android')],
    building: building(['web', [worker('lead')]], ['android', [worker('sub', { lead: 'lead' }), worker('child', { lead: 'sub' })]]),
    currentFloor: null,
    workers: [],
  });
  assert.deepEqual(
    filterBuildingRows(rows, '', 'android', 'all').map((row) => [row.worker.id, row.depth, row.leadName]),
    [
      ['sub', 0, 'lead'],
      ['child', 1, 'sub'],
    ],
  );
  assert.deepEqual(
    filterBuildingRows(rows, 'child', '', 'all').map((row) => [row.worker.id, row.depth]),
    [['child', 0]],
  );
  assert.deepEqual(filterBuildingRows(rows, '', 'all', 'all'), rows);
});

test('repo labels match Android home, folder, slug and distinct checkout name fallbacks', () => {
  const floors = [floor('home', { home: true }), floor('plain', { plain: true }), floor('repo', { repo: ' owner/project ' }), floor('label', { name: 'Display', dir: 'C:\\projects\\checkout\\' })];
  const rows = buildingRoster({ floors, building: building(...floors.map((f): [string, WorkerInfo[]] => [f.id, [worker(f.id)]])), currentFloor: null, workers: [] });
  assert.deepEqual(
    rows.map((row) => row.repo),
    ['Home', 'Folder', 'owner/project', 'checkout'],
  );
});
