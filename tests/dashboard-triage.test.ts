import assert from 'node:assert/strict';
import test from 'node:test';
import { buildingRoster } from '../src/client/dashboard-building.js';
import { buildTriageFloors, filterSwitcherFloors, floorChord, maxSurfacedBays, nextUrgentTarget, partitionTriageFloors, unackedDoneBuildingCount } from '../src/client/dashboard-triage.js';
import { ORCHESTRATOR_ID } from '../src/shared/mission-control.js';
import type { FloorInfo, FloorRoster, GhPull, WorkerInfo } from '../src/shared/protocol.js';

function makeFloor(index: number, overrides: Partial<FloorInfo> = {}): FloorInfo {
  const id = overrides.id ?? `f-${index + 1}`;
  const name = overrides.name ?? `repo-${index + 1}`;
  return {
    id,
    name,
    repo: `nikships/${name}`,
    dir: `/tmp/${name}`,
    branch: 'main',
    palette: index,
    addedBy: 'Owner',
    addedAt: index + 1,
    workers: 0,
    busy: 0,
    waiting: 0,
    ...overrides,
  };
}

function makeWorker(id: string, status: WorkerInfo['status'], overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    id,
    kind: 'agent',
    name: id,
    color: '#ee6018',
    deskId: `desk-${id}`,
    status,
    acked: false,
    createdBy: 'Owner',
    createdAt: 1,
    cols: 120,
    rows: 36,
    open: false,
    ...overrides,
  };
}

function makePull(number: number, state: GhPull['state'] = 'OPEN'): GhPull {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/nikships/repo/pull/${number}`,
    state,
    isDraft: state === 'DRAFT',
    headRefName: `feat-${number}`,
    baseRefName: 'main',
    author: 'nik',
    updatedAt: '2026-04-20T00:00:00Z',
  };
}

test('floor chords map floors 1–9 and 10 (0) and omit 11+', () => {
  assert.equal(floorChord(0), '⇧ ⌘ 1');
  assert.equal(floorChord(8), '⇧ ⌘ 9');
  assert.equal(floorChord(9), '⇧ ⌘ 0');
  assert.equal(floorChord(10), undefined);
  assert.equal(floorChord(-1), undefined);
  assert.equal(maxSurfacedBays(1280), 5);
  assert.equal(maxSurfacedBays(1100), 5);
  assert.equal(maxSurfacedBays(1024), 4);
});

test('10-floor triage pins active first, then needs_input before unacked done, and folds quiet/working floors', () => {
  const floors = [
    makeFloor(0, { id: 'droid-office', name: 'droid-office', workers: 3, busy: 3, waiting: 1 }),
    makeFloor(1, { id: 'droid-proxy', name: 'droid-proxy', workers: 2, busy: 2, waiting: 1 }),
    makeFloor(2, { id: 'factory-cli', name: 'factory-cli', branch: 'release/2.4', workers: 3, busy: 3, waiting: 0 }),
    makeFloor(3, { id: 'orca', name: 'orca', workers: 2, busy: 0, waiting: 1 }),
    makeFloor(4, { id: 'screenplay', name: 'screenplay', workers: 2, busy: 2, waiting: 0 }),
    makeFloor(5, { id: 'hyperframes', name: 'hyperframes', branch: 'feat/timeline', workers: 2, busy: 2, waiting: 1 }),
    makeFloor(6, { id: 'browse-mcp', name: 'browse-mcp', workers: 1, busy: 0, waiting: 0 }),
    makeFloor(7, { id: 'muse-agent', name: 'muse-agent', workers: 2, busy: 1, waiting: 1 }),
    makeFloor(8, { id: 'gemdex', name: 'gemdex', workers: 1, busy: 0, waiting: 0 }),
    makeFloor(9, { id: 'home', name: 'Home', repo: undefined, branch: undefined, home: true, plain: true }),
  ];

  const building = new Map<string, FloorRoster>([
    ['droid-proxy', { floor: 'droid-proxy', workers: [makeWorker('sprocket', 'needs_input'), makeWorker('widget', 'working')], pulls: [makePull(12)] }],
    ['factory-cli', { floor: 'factory-cli', workers: [makeWorker('bolt', 'working'), makeWorker('rivet', 'starting'), makeWorker('sub', 'done', { lead: 'bolt' })], pulls: [] }],
    ['orca', { floor: 'orca', workers: [makeWorker('claw', 'done', { acked: false }), makeWorker('fuse', 'idle')], pulls: [] }],
    ['screenplay', { floor: 'screenplay', workers: [makeWorker('frame', 'working'), makeWorker('lens', 'working')], pulls: [] }],
    ['hyperframes', { floor: 'hyperframes', workers: [makeWorker('keyframe', 'needs_input'), makeWorker('spline', 'working')], pulls: [] }],
    ['browse-mcp', { floor: 'browse-mcp', workers: [makeWorker('tab', 'idle'), makeWorker('acked-done', 'done', { acked: true })], pulls: [] }],
    ['muse-agent', { floor: 'muse-agent', workers: [makeWorker('echo', 'done', { acked: false }), makeWorker('pulse', 'working')], pulls: [] }],
    ['gemdex', { floor: 'gemdex', workers: [makeWorker('index', 'offline')], pulls: [] }],
    ['home', { floor: 'home', workers: [], pulls: [] }],
  ]);

  const currentWorkers = [makeWorker('pixel', 'needs_input'), makeWorker('byte', 'working'), makeWorker('nibble', 'working'), makeWorker(ORCHESTRATOR_ID, 'needs_input'), makeWorker('ext-bot', 'needs_input', { remote: true })];
  const pulls = [makePull(431, 'OPEN'), makePull(432, 'DRAFT'), makePull(400, 'MERGED')];

  const items = buildTriageFloors({
    floors,
    building,
    currentFloor: 'droid-office',
    workers: currentWorkers,
    pulls,
  });

  assert.equal(items[0]?.openPrs, 2);
  assert.equal(items[0]?.needsInput, 1, 'ignores orchestrator and remote bots in floor-local counts');
  assert.equal(items[0]?.busy, 2);
  assert.equal(items[2]?.unackedDone, 0, 'subagent done does not trigger owner attention');
  assert.equal(items[6]?.unackedDone, 0, 'acked done does not trigger owner attention');
  assert.equal(items[8]?.idleState, 'asleep');
  assert.equal(items[9]?.idleState, 'empty');
  assert.equal(items[9]?.metaLabel, 'plain folder');

  const part = partitionTriageFloors(items, 'droid-office', 5);
  assert.deepEqual(
    part.surfaced.map((i) => i.floor.id),
    ['droid-office', 'droid-proxy', 'hyperframes', 'orca', 'muse-agent'],
    'active first, then needs_input floors in order, then unacked done floors up to cap 5',
  );
  assert.deepEqual(
    part.quiet.map((i) => i.floor.id),
    ['factory-cli', 'screenplay', 'browse-mcp', 'gemdex', 'home'],
  );
  assert.equal(part.quietBusy, 4, '2 working on factory-cli + 2 working on screenplay');
  assert.equal(part.quietNeeds, 0);

  // Narrow viewport cap (4) pushes muse-agent into quiet while tracking quietDone.
  const narrow = partitionTriageFloors(items, 'droid-office', 4);
  assert.deepEqual(
    narrow.surfaced.map((i) => i.floor.id),
    ['droid-office', 'droid-proxy', 'hyperframes', 'orca'],
  );
  assert.equal(narrow.quietDone, 1);

  // Switcher search: empty query lists quiet floors; non-empty query searches all 10 floors.
  assert.equal(filterSwitcherFloors(items, part.quiet, '').length, 5);
  assert.deepEqual(
    filterSwitcherFloors(items, part.quiet, 'release/2.4').map((i) => i.floor.id),
    ['factory-cli'],
  );
  assert.deepEqual(
    filterSwitcherFloors(items, part.quiet, '06 feat').map((i) => i.floor.id),
    ['hyperframes'],
    'searches surfaced floors too when query is non-empty',
  );
  assert.deepEqual(
    filterSwitcherFloors(items, [], '').map((i) => i.floor.id),
    items.map((i) => i.floor.id),
    'falls back to all floors when zero floors are quiet so ⌘ K always opens a populated list',
  );
});

test('building pulse helpers count unacked done and cycle urgent needs_input targets across floors', () => {
  const floors = [makeFloor(0, { id: 'f1', name: 'one', waiting: 1 }), makeFloor(1, { id: 'f2', name: 'two', waiting: 1 })];
  const building = new Map<string, FloorRoster>([
    ['f1', { floor: 'f1', workers: [makeWorker('w1', 'needs_input', { waitingSince: 10 }), makeWorker('w-done', 'done', { acked: false })], pulls: [] }],
    ['f2', { floor: 'f2', workers: [makeWorker('w2', 'needs_input', { waitingSince: 20 }), makeWorker('w-acked', 'done', { acked: true })], pulls: [] }],
  ]);
  const rows = buildingRoster({ floors, building, currentFloor: 'f1', workers: building.get('f1')!.workers });
  assert.equal(unackedDoneBuildingCount(rows), 1);

  const items = buildTriageFloors({ floors, building, currentFloor: 'f1', workers: building.get('f1')!.workers });
  // When not yet focused on w1, picks w1 on the current floor first.
  const first = nextUrgentTarget(rows, items, 'f1', undefined);
  assert.equal(first?.kind, 'worker');
  if (first?.kind === 'worker') assert.equal(first.row.worker.id, 'w1');

  // Once focused on w1 on f1, clicking NEEDS YOU cycles to w2 on f2.
  const second = nextUrgentTarget(rows, items, 'f1', 'w1');
  assert.equal(second?.kind, 'worker');
  if (second?.kind === 'worker') assert.equal(second.row.worker.id, 'w2');

  // Fallback when building rosters have not arrived yet.
  const fallbackItems = buildTriageFloors({ floors, building: new Map(), currentFloor: 'f1', workers: [] });
  assert.deepEqual(nextUrgentTarget([], fallbackItems, 'f1'), { kind: 'floor', floorId: 'f2' });
});
