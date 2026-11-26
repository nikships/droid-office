import test from 'node:test';
import assert from 'node:assert/strict';
import { GUEST_PRESETS, type GuestPreset } from '../src/shared/guest-links.js';
import {
  GUEST_INBOUND,
  GUEST_OUTBOUND,
  guestAdmit,
  guestBuilding,
  guestFloors,
  guestFloorView,
  guestMission,
  guestOutbound,
  guestSeesFloor,
  guestSeesWorker,
  type GuestScopeGrant,
  type GuestSendContext,
  type GuestWorld,
} from '../src/shared/guest-policy.js';
import { guestAuditDetail, guestName } from '../src/server/server-runtime/guest-gate.js';
import { ORCHESTRATOR_ID } from '../src/shared/mission-control.js';
import { OFFICE_SHELL_ID } from '../src/shared/office-shell.js';
import { ROOF } from '../src/shared/rooftop.js';
import { readMenu } from '../src/shared/asks.js';
import type { ClientMsg, FloorInfo, FloorView, ServerMsg, WorkerInfo } from '../src/shared/protocol.js';

// Floors A and B are open, C was closed; a1/a2 sit on A, b1 on B, c1 on the closed C. ab sits on A and works in B's repository too.
const SEATS: Record<string, string> = { a1: 'A', a2: 'A', b1: 'B', c1: 'C', ab: 'A' };
const REPOS: Record<string, string[]> = { ab: ['B'] };
const isOpen = (id: string) => id === 'A' || id === 'B';
// As guestWorld: only open floors seat anyone.
const world: GuestWorld = { floorOf: (id) => (isOpen(SEATS[id] ?? '') ? SEATS[id] : undefined), isOpen, reposOf: (id) => REPOS[id] };

const GRANTS: Record<GuestPreset, GuestScopeGrant> = {
  'view-office': { preset: 'view-office' },
  'edit-office': { preset: 'edit-office' },
  'view-floor': { preset: 'view-floor', floorId: 'A' },
  'edit-floor': { preset: 'edit-floor', floorId: 'A' },
  'view-worker': { preset: 'view-worker', floorId: 'A', workerId: 'a1' },
};
const WRITES = new Set<GuestPreset>(['edit-floor', 'edit-office']);
const OFFICE = new Set<GuestPreset>(['view-office', 'edit-office']);

const types = Object.keys(GUEST_INBOUND) as ClientMsg['t'][];
/** A message of type `t` about worker `id` (or floor `floor`), with the fields the table reads. */
const about = (t: string, id: string, floor = SEATS[id] ?? id) => ({ t, workerId: id, worker: id, floor });

test('every guest refusal is the same for owner-only types, unknown types and junk', () => {
  for (const preset of GUEST_PRESETS) {
    const g = GRANTS[preset];
    for (const t of types.filter((t) => GUEST_INBOUND[t].access === 'never')) assert.equal(guestAdmit(g, about(t, 'a1', 'A'), 'A', world), undefined, `${preset} ${t}`);
    for (const junk of [null, 'worker.prompt', 42, {}, { t: 7 }, { t: 'guestLinks.create' }, { t: 'toString' }, { t: '__proto__' }]) assert.equal(guestAdmit(g, junk, 'A', world), undefined);
  }
  // The long owner-only list stays owner-only.
  const owner = [
    'profile',
    'orchestrator.set',
    'shell.attach',
    'shell.input',
    'floor.add',
    'floor.remove',
    'floor.reorder',
    'floor.projectsDir',
    'prompts.set',
    'factory.connect',
    'jira.connect',
    'linear.connect',
    'gemini.connect',
    'subscriptions.connect',
    'setup.droid.install',
    'upgrade.start',
    'decor.add',
    'jukebox.play',
    'gong',
    'automation.result',
    'worktreeSetup.set',
    'subagents.set',
    'machine.limit',
    'vibes.watch',
  ] as const;
  for (const t of owner) assert.equal(GUEST_INBOUND[t].access, 'never', t);
});

test('view-only links never write, and write links write only inside their scope', () => {
  for (const t of types) {
    const rule = GUEST_INBOUND[t];
    if (rule.access !== 'write') continue;
    for (const preset of GUEST_PRESETS) {
      const got = guestAdmit(GRANTS[preset], about(t, 'a1', 'A'), 'A', world);
      const mission = rule.target.kind === 'mission';
      const expected = WRITES.has(preset) && (!mission || OFFICE.has(preset));
      assert.equal(!!got, expected, `${preset} ${t}`);
      if (got) {
        assert.equal(got.write, true);
        assert.equal(got.audit, rule.audit);
      }
    }
  }
  assert.equal(GUEST_INBOUND['term.resize'].access, 'write', 'a view-only guest never resizes the owner’s terminal');
});

test('worker targets: in scope, other floors, closed floors, missing workers, the Orchestrator and the office shell', () => {
  const cases: [GuestPreset, string, boolean][] = [
    ['view-worker', 'a1', true],
    ['view-worker', 'a2', false],
    ['view-worker', 'b1', false],
    ['view-floor', 'a2', true],
    ['view-floor', 'b1', false],
    ['edit-floor', 'b1', false],
    ['view-office', 'b1', true],
    ['edit-office', 'b1', true],
  ];
  for (const [preset, id, ok] of cases) assert.equal(!!guestAdmit(GRANTS[preset], about('worker.attach', id), 'A', world), ok, `${preset} ${id}`);
  for (const preset of GUEST_PRESETS) {
    const g = GRANTS[preset];
    for (const id of ['c1', 'nobody', OFFICE_SHELL_ID, '', 'x'.repeat(65)]) assert.equal(guestAdmit(g, about('worker.attach', id), 'A', world), undefined, `${preset} ${id}`);
    assert.equal(guestAdmit(g, { t: 'worker.attach' }, 'A', world), undefined);
    // The Orchestrator is Mission Control: office-wide links only, and its prompts are writes.
    assert.deepEqual(guestAdmit(g, about('worker.attach', ORCHESTRATOR_ID), 'A', world)?.target, OFFICE.has(preset) ? { kind: 'missionControl' } : undefined);
    assert.equal(!!guestAdmit(g, about('worker.prompt', ORCHESTRATOR_ID), 'A', world), preset === 'edit-office');
    assert.equal(!!guestAdmit(g, { t: 'orchestrator.reset' }, 'A', world), preset === 'edit-office');
    assert.equal(guestSeesWorker(g, 'a1', ROOF, undefined), false);
  }
  assert.deepEqual(guestAdmit(GRANTS['edit-floor'], about('worker.prompt', 'a2'), 'A', world), { write: true, audit: 'prompt', target: { kind: 'worker', workerId: 'a2', floorId: 'A' } });
  // A single-worker link's worker moved to another floor is out of scope.
  assert.equal(guestSeesWorker(GRANTS['view-worker'], 'a1', 'B', undefined), false);
});

test('a worker’s changed files and diffs are for write links only, unaudited', () => {
  for (const t of ['changes.watch', 'changes.unwatch', 'changes.diff'] as const) {
    assert.deepEqual(GUEST_INBOUND[t], { access: 'write', target: GUEST_INBOUND['changes.commit'].target, audit: null }, t);
    for (const preset of GUEST_PRESETS) {
      const got = guestAdmit(GRANTS[preset], { t, workerId: 'a1', path: 'secret.txt' }, 'A', world);
      assert.equal(!!got, WRITES.has(preset), `${preset} ${t}`);
      if (got) assert.equal(got.audit, null);
    }
  }
  const state = { t: 'changes', state: { workerId: 'a1', dir: '', base: 'HEAD', ahead: 0, files: [{ path: '.env', status: '?' }], more: 0, at: 1 } };
  const diff = { t: 'changes.diff', workerId: 'a1', path: '.env', diff: 'TOKEN=x', truncated: false };
  for (const preset of GUEST_PRESETS) for (const msg of [state, diff]) for (const via of ['direct', 'floor', 'all'] as const) assert.equal(!!out(preset, msg, ctx({ via, floor: 'A' })), WRITES.has(preset), `${preset} ${msg.t} ${via}`);
});

test('a guest never hands a Linear ticket to a worker: that would move it on the owner’s Linear account', () => {
  for (const preset of ['edit-floor', 'edit-office'] as const) {
    const g = GRANTS[preset];
    assert.ok(guestAdmit(g, { t: 'worker.spawn', deskId: 'auto', prompt: 'fix it' }, 'A', world));
    assert.ok(guestAdmit(g, { t: 'worker.prompt', workerId: 'a1', prompt: 'fix it', issue: 7 }, 'A', world), 'a GitHub issue on its own floor is fine');
    for (const linear of ['ENG-12', '', null]) {
      assert.equal(guestAdmit(g, { t: 'worker.spawn', deskId: 'auto', prompt: 'fix it', linear }, 'A', world), undefined, `${preset} hire ${linear}`);
      assert.equal(guestAdmit(g, { t: 'worker.prompt', workerId: 'a1', prompt: 'fix it', linear }, 'A', world), undefined, `${preset} prompt ${linear}`);
    }
  }
});

test('floors: scoped links only ever return to their own floor, office links move between open floors', () => {
  for (const preset of GUEST_PRESETS) {
    const g = GRANTS[preset];
    for (const floor of ['A', 'B']) assert.equal(!!guestAdmit(g, { t: 'floor.go', floor }, 'A', world), OFFICE.has(preset) || floor === g.floorId, `${preset} → ${floor}`);
    // Back from the lobby, once the floor is open again.
    assert.equal(!!guestAdmit(g, { t: 'floor.go', floor: 'A' }, null, world), true);
    assert.equal(guestAdmit(g, { t: 'floor.go', floor: 'A' }, null, { ...world, isOpen: (id) => id === 'B' }), undefined);
    for (const floor of ['C', ROOF, '', undefined]) assert.equal(guestAdmit(g, { t: 'floor.go', floor }, 'A', world), undefined);
    assert.equal(!!guestAdmit(g, { t: 'whiteboard.sync', floor: 'A' }, 'A', world), preset !== 'view-worker');
    assert.equal(!!guestAdmit(g, { t: 'whiteboard.sync', floor: 'B' }, 'A', world), OFFICE.has(preset));
    assert.equal(!!guestAdmit(g, { t: 'whiteboard.apply', floor: 'B', ops: [] }, 'A', world), preset === 'edit-office');
    // Floor content and hires happen where the guest stands, which must be in scope.
    assert.equal(!!guestAdmit(g, { t: 'gh.refresh' }, 'A', world), preset !== 'view-worker');
    assert.equal(!!guestAdmit(g, { t: 'gh.refresh' }, 'B', world), OFFICE.has(preset));
    assert.equal(guestAdmit(g, { t: 'gh.refresh' }, null, world), undefined);
    assert.equal(guestAdmit(g, { t: 'gh.refresh' }, 'C', world), undefined);
    assert.equal(!!guestAdmit(g, { t: 'worker.spawn', deskId: 'auto' }, 'A', world), WRITES.has(preset));
    assert.equal(!!guestAdmit(g, { t: 'worker.spawn', deskId: 'auto', repos: ['B'] }, 'A', world), preset === 'edit-office');
    for (const repos of [['C'], [ROOF], 'B', [1]]) assert.equal(guestAdmit(g, { t: 'worker.spawn', deskId: 'auto', repos }, 'A', world), undefined);
    assert.deepEqual(guestAdmit(g, { t: 'ping', at: 1 }, null, world), { write: false, audit: null, target: { kind: 'none' } });
  }
  assert.equal(guestSeesFloor(GRANTS['view-worker'], 'A'), false);
  assert.equal(guestSeesFloor(GRANTS['view-office'], ROOF), false);
});

const ctx = (over: Partial<GuestSendContext> = {}): GuestSendContext => ({ via: 'all', here: 'A', ...over });
const out = (preset: GuestPreset, msg: unknown, c = ctx()) => guestOutbound(GRANTS[preset], msg as ServerMsg, c, world);
const worker = (id: string) => ({ id, name: id }) as WorkerInfo;

test('outbound: owner-only messages never reach a guest, worker and floor messages only in scope', () => {
  const dropped = Object.entries(GUEST_OUTBOUND)
    .filter(([, r]) => r.pass === 'drop')
    .map(([t]) => t);
  for (const t of ['guestLinks.changed', 'factory', 'setup', 'subscriptions', 'prompts', 'automation.run', 'upgrade', 'machine', 'projectsDir', 'floor.added', 'jira', 'linear', 'gemini', 'decor']) assert.ok(dropped.includes(t), t);
  for (const preset of GUEST_PRESETS) {
    for (const t of dropped) assert.equal(out(preset, { t }), undefined, `${preset} ${t}`);
    assert.equal(out(preset, { t: 'no.such.message' }), undefined);
    assert.ok(out(preset, { t: 'pong', at: 1 }));
    assert.ok(out(preset, { t: 'action.result', requestId: 'r', ok: false }));
    const termData = (id: string) => out(preset, { t: 'term.data', workerId: id, data: 'x' });
    assert.equal(!!termData('a1'), true);
    assert.equal(!!termData('a2'), preset !== 'view-worker');
    assert.equal(!!termData('b1'), OFFICE.has(preset));
    assert.equal(termData('c1'), undefined);
    assert.equal(termData(OFFICE_SHELL_ID), undefined);
    assert.equal(!!out(preset, { t: 'worker.update', worker: worker(ORCHESTRATOR_ID) }), OFFICE.has(preset));
    assert.equal(!!out(preset, { t: 'building.worker', floor: 'B', worker: worker('b1') }), OFFICE.has(preset));
    // A worker that just left no longer sits anywhere: the send names its floor.
    assert.equal(!!out(preset, { t: 'worker.remove', workerId: 'gone' }, ctx({ via: 'floor', floor: 'A' })), preset !== 'view-worker');
    assert.equal(!!out(preset, { t: 'gh.pulls', pulls: {} }, ctx({ via: 'floor', floor: 'A' })), preset !== 'view-worker');
    assert.equal(!!out(preset, { t: 'gh.pulls', pulls: {} }, ctx({ via: 'floor', floor: 'B' })), OFFICE.has(preset));
    assert.equal(!!out(preset, { t: 'whiteboard', floor: 'B' }), OFFICE.has(preset));
    assert.equal(out(preset, { t: 'whiteboard', floor: 'C' }), undefined);
    assert.equal(!!out(preset, { t: 'missionControl', state: { orchestrator: {}, bots: [{ id: 'bot' }] } }), OFFICE.has(preset));
  }
  assert.equal(out('view-worker', { t: 'worker.remove', workerId: 'a1' }, ctx({ via: 'floor', floor: 'A' }))?.t, 'worker.remove', 'a single-worker guest hears its worker leave');
  assert.deepEqual(out('edit-office', { t: 'missionControl', state: { orchestrator: { id: ORCHESTRATOR_ID }, bots: [{ id: 'bot' }] } }), { t: 'missionControl', state: { orchestrator: { id: ORCHESTRATOR_ID }, bots: [] } });
});

test('outbound toasts: about an in-scope worker, a reply, or the guest’s own floor', () => {
  const toast = { t: 'toast', text: 'hi' };
  assert.ok(out('view-floor', toast, ctx({ via: 'direct' })));
  assert.equal(out('view-floor', toast, ctx({ via: 'all' })), undefined, 'office-wide news never reaches a scoped guest');
  assert.equal(out('view-office', toast, ctx({ via: 'all' })), undefined);
  assert.ok(out('view-floor', toast, ctx({ via: 'floor', floor: 'A' })));
  assert.equal(out('view-floor', toast, ctx({ via: 'floor', floor: 'B' })), undefined);
  assert.equal(out('view-worker', toast, ctx({ via: 'floor', floor: 'A' })), undefined);
  assert.ok(out('view-worker', { ...toast, workerId: 'a1' }));
  assert.equal(out('view-floor', { ...toast, workerId: 'b1' }, ctx({ via: 'direct' })), undefined);
});

const FLOORS = [
  { id: 'A', name: 'alpha', dir: '/Users/owner/alpha', workers: 2, busy: 1, waiting: 0, lastVisitedAt: 5, hires: 3 },
  { id: 'B', name: 'beta', dir: '/Users/owner/beta', workers: 1, busy: 0, waiting: 1 },
] as unknown as FloorInfo[];
const VIEW = {
  floor: 'A',
  project: { name: 'alpha', dir: '/Users/owner/alpha', agentCmd: 'droid --secret', forge: 'github', branch: 'main' },
  workers: [worker('a1'), worker('a2')],
  issues: { items: [{ number: 1 }], fetchedAt: 1, loading: false },
  pulls: { items: [{ number: 2 }], fetchedAt: 1, loading: false },
  pipelines: { runs: [{ id: 1 }] },
  decor: [{ id: 'plant' }],
  jira: { site: 'owner.atlassian.net' },
  jiraBoard: { issues: [] },
  linear: { autopilot: {}, working: 3 },
  linearBoard: { issues: [] },
} as unknown as FloorView;

test('a guest’s welcome, floor list and roster hold only its scope, without paths or connections', () => {
  const welcome = {
    t: 'welcome',
    connection: 'c1',
    arrival: { floor: 'A', via: 'lobby' },
    floors: FLOORS,
    version: '1',
    building: [
      { floor: 'A', workers: [worker('a1'), worker('a2')], pulls: [{ number: 2 }] },
      { floor: 'B', workers: [worker('b1')], pulls: [] },
    ],
    missionControl: { orchestrator: { id: ORCHESTRATOR_ID }, bots: [{ id: 'bot' }] },
    guest: { preset: 'view-worker' },
    factory: { key: 'secret' },
    setup: { droid: {} },
    projectsDir: '/Users/owner',
    prompts: {},
    ...VIEW,
  };
  const w = out('view-worker', welcome, ctx({ via: 'direct' })) as Record<string, unknown> & {
    floors: FloorInfo[];
    workers: WorkerInfo[];
    building: { workers: WorkerInfo[]; pulls: unknown[] }[];
    project: { dir: string; agentCmd: string };
  };
  for (const key of ['factory', 'setup', 'projectsDir', 'prompts', 'missionControl']) assert.equal(key in w, false, key);
  assert.deepEqual(w.floors, [{ id: 'A', name: 'alpha', dir: '', workers: 0, busy: 0, waiting: 0 }]);
  assert.deepEqual(
    w.workers.map((x) => x.id),
    ['a1'],
  );
  assert.deepEqual(w.building, [{ floor: 'A', workers: [worker('a1')], pulls: [] }]);
  assert.deepEqual([w.project.dir, w.project.agentCmd, w.decor, w.jira, w.jiraBoard, w.linearBoard], ['', '', [], {}, null, null]);
  assert.deepEqual((w.issues as { items: unknown[] }).items, [], 'one worker sees no floor boards');
  assert.deepEqual(w.guest, { preset: 'view-worker' });

  const o = out('view-office', welcome, ctx({ via: 'direct' })) as Record<string, unknown> & { floors: FloorInfo[] };
  assert.deepEqual(
    o.floors.map((f) => [f.id, f.dir, f.workers]),
    [
      ['A', '', 2],
      ['B', '', 1],
    ],
  );
  assert.equal('lastVisitedAt' in o.floors[0]!, false);
  assert.deepEqual(o.missionControl, { orchestrator: { id: ORCHESTRATOR_ID }, bots: [] });

  // A scoped guest entering another floor's view gets an empty one, as if in the lobby.
  const beta = out('view-floor', { t: 'floor.enter', arrival: { floor: 'B', via: 'elevator' }, ...VIEW, floor: 'B', workers: [worker('b1')] }) as unknown as FloorView & { arrival: unknown };
  assert.equal(beta.floor, null);
  assert.deepEqual(beta.workers, []);
  assert.deepEqual(beta.arrival, { floor: null, via: 'lobby' });

  assert.deepEqual(
    guestFloors(FLOORS, GRANTS['edit-floor']).map((f) => [f.id, f.dir, f.workers]),
    [['A', '', 2]],
  );
  assert.deepEqual(guestFloorView({ ...VIEW, floor: 'C' }, GRANTS['view-office'], world).floor, null);
  assert.deepEqual(guestBuilding([{ floor: ROOF, workers: [], pulls: [] } as never], GRANTS['view-office'], world), []);
  assert.equal(guestMission({ orchestrator: {}, bots: [] } as never, GRANTS['edit-floor']), undefined);
});

test('a worker across repositories is outside floor links, and a single-worker link gets it without its other floor', () => {
  const repo = { floor: 'B', name: 'beta', dir: '/Users/owner/beta', path: 'ws/beta', branch: 'office/ab', base: 'abc' };
  const ab = { ...worker('ab'), repos: [repo] } as WorkerInfo;
  const view = { ...VIEW, workers: [worker('a1'), ab] } as FloorView;
  const roster = [{ floor: 'A', workers: [worker('a1'), ab], pulls: [] }];
  for (const preset of ['view-floor', 'edit-floor'] as const) {
    const g = GRANTS[preset];
    for (const t of ['worker.attach', 'thread.read', 'term.input', 'worker.prompt', 'worker.pr', 'changes.commit', 'changes.discard', 'changes.pr']) assert.equal(guestAdmit(g, about(t, 'ab'), 'A', world), undefined, `${preset} ${t}`);
    for (const msg of [
      { t: 'term.data', workerId: 'ab', data: 'x' },
      { t: 'worker.update', worker: ab },
      // Its card without repos: the office still knows where it works.
      { t: 'worker.update', worker: worker('ab') },
      { t: 'building.worker', floor: 'A', worker: ab },
      { t: 'toast', text: 'hi', workerId: 'ab' },
    ])
      assert.equal(out(preset, msg), undefined, `${preset} ${msg.t}`);
    assert.deepEqual(
      guestFloorView(view, g, world).workers.map((w) => w.id),
      ['a1'],
    );
    assert.deepEqual(
      guestBuilding(roster, g, world)[0]!.workers.map((w) => w.id),
      ['a1'],
    );
    assert.ok(guestAdmit(g, about('worker.attach', 'a1'), 'A', world), 'its floor-mates stay in scope');
  }

  const pick: GuestScopeGrant = { preset: 'view-worker', floorId: 'A', workerId: 'ab' };
  assert.ok(guestAdmit(pick, about('worker.attach', 'ab'), 'A', world));
  assert.ok(guestOutbound(pick, { t: 'term.data', workerId: 'ab', data: 'x' }, ctx(), world));
  const update = guestOutbound(pick, { t: 'worker.update', worker: ab }, ctx(), world) as Extract<ServerMsg, { t: 'worker.update' }>;
  assert.equal('repos' in update.worker, false, 'its repository on another floor is left out');
  assert.equal(ab.repos?.length, 1, 'the owner’s card is untouched');
  const building = guestOutbound(pick, { t: 'building.worker', floor: 'A', worker: ab }, ctx(), world) as Extract<ServerMsg, { t: 'building.worker' }>;
  assert.equal('repos' in building.worker, false);
  assert.deepEqual(guestFloorView(view, pick, world).workers, [worker('ab')]);
  assert.deepEqual(guestBuilding(roster, pick, world)[0]!.workers, [worker('ab')]);

  // Office links reach every open floor: unchanged.
  for (const preset of ['view-office', 'edit-office'] as const) {
    assert.deepEqual(out(preset, { t: 'worker.update', worker: ab }), { t: 'worker.update', worker: ab });
    assert.ok(guestAdmit(GRANTS[preset], about('worker.attach', 'ab'), 'A', world));
    assert.deepEqual(guestFloorView(view, GRANTS[preset], world).workers, [worker('a1'), ab]);
  }
});

test('removal news reaches every guest whose scope held the worker, after it left every map', () => {
  // Sent home, shot or a cloud worker ended: the floor it left sends worker.remove (toFloor), the building building.remove (broadcast).
  for (const preset of GUEST_PRESETS) {
    const onA = ctx({ via: 'floor', floor: 'A' });
    assert.equal(!!out(preset, { t: 'worker.remove', workerId: 'a1' }, onA), true, `${preset} hears a1 leave`);
    assert.equal(!!out(preset, { t: 'worker.remove', workerId: 'a1', shot: { by: 'x' } }, onA), true);
    assert.equal(!!out(preset, { t: 'worker.remove', workerId: 'a2' }, onA), preset !== 'view-worker');
    assert.equal(!!out(preset, { t: 'building.remove', floor: 'A', workerId: 'a1' }, ctx({ via: 'all', here: 'B' })), true);
    assert.equal(!!out(preset, { t: 'building.remove', floor: 'A', workerId: 'a2' }, ctx({ via: 'all' })), preset !== 'view-worker');
    assert.equal(!!out(preset, { t: 'building.remove', floor: 'B', workerId: 'b9' }, ctx({ via: 'all' })), OFFICE.has(preset));
    assert.equal(!!out(preset, { t: 'worker.remove', workerId: 'b9' }, ctx({ via: 'floor', floor: 'B' })), OFFICE.has(preset));
    // A reply naming no floor about a worker that is gone says nothing.
    assert.equal(out(preset, { t: 'worker.remove', workerId: 'gone' }, ctx({ via: 'direct' })), undefined);
  }
});

// Droid's permission menu as tests/ask-question.test.ts and tests/droid-screen.test.ts captured it.
const PERMISSION_SCREEN = [
  '  Execute: git push origin HEAD',
  '',
  '> 1. Yes, allow',
  '  2. Yes, and always allow low risk commands',
  '  3. No, cancel',
  '',
  '  ↑↓ navigate   Enter select   Esc cancel   Alt/Option+E to inspect approval details',
];

test('audit lines name what a guest did, and permission answers say approve or deny', () => {
  assert.equal(guestName({ label: 'Alex - PR review' }), 'Alex - PR review (guest)');
  const permission = { id: 'a1', ask: { kind: 'permission', tool: 'Execute', command: 'git push origin HEAD' } } as unknown as WorkerInfo;
  const menu = readMenu(PERMISSION_SCREEN)!;
  assert.deepEqual(
    menu.choices.map((c) => c.label),
    ['Yes, allow', 'Yes, and always allow low risk commands', 'No, cancel'],
  );
  const answer = (extra: object) => guestAuditDetail({ t: 'worker.answer', workerId: 'a1', menu, ...extra } as ClientMsg, permission);
  assert.deepEqual(answer({ choice: 1 }), { action: 'permission.approve', detail: 'git push origin HEAD: Yes, allow' });
  assert.deepEqual(answer({ choice: 2 }), { action: 'permission.approve', detail: 'git push origin HEAD: Yes, and always allow low risk commands' });
  assert.deepEqual(answer({ choice: 3 }), { action: 'permission.deny', detail: 'git push origin HEAD: No, cancel' });
  assert.deepEqual(answer({ text: 'push to a branch instead' }), { action: 'permission.deny', detail: 'git push origin HEAD: push to a branch instead' }, 'typed feedback denies');
  // droid 0.234's boxed variant reads the same.
  const boxed = { ...menu, choices: [menu.choices[0]!, { ...menu.choices[1]!, label: 'Yes, and always allow low impact commands' }, menu.choices[2]!] };
  assert.equal(guestAuditDetail({ t: 'worker.answer', workerId: 'a1', menu: boxed, choice: 2 } as ClientMsg, permission).action, 'permission.approve');
  const question = { question: 'Allow?', choices: [{ number: 1, label: 'Yes, allow' }] };
  assert.deepEqual(guestAuditDetail({ t: 'worker.answer', workerId: 'a1', menu: question, choices: [1, 9] } as ClientMsg, worker('a1')), { detail: 'Allow? → Yes, allow, #9' });
  assert.deepEqual(guestAuditDetail({ t: 'worker.prompt', workerId: 'a1', prompt: `  fix\n${'x'.repeat(500)}` }, undefined).detail?.length, 160);
  assert.deepEqual(guestAuditDetail({ t: 'worker.spawn', deskId: 'auto', kind: 'shell' } as ClientMsg, undefined), { detail: 'Shell' });
});
