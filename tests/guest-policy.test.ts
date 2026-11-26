import test from 'node:test';
import assert from 'node:assert/strict';
import { GUEST_PRESETS, type GuestPreset } from '../src/shared/guest-links.js';
import {
  GUEST_INBOUND,
  GUEST_ORCHESTRATOR_BLOCKED,
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
import { orchestratorBlocked, orchestratorSettingsPane } from '../src/client/mission.js';
import { GUEST_ORCHESTRATOR_BLOCKED as CLIENT_GUEST_ORCHESTRATOR_BLOCKED } from '../src/client/dashboard-guest.js';
import type { ClientMsg, FloorInfo, FloorView, ServerMsg, WorkerInfo } from '../src/shared/protocol.js';

// Floors A and B are open, C was closed; a1/a2 sit on A, b1 on B, c1 on the closed C. ab sits on A and works in B's repository too.
const SEATS: Record<string, string> = { a1: 'A', a2: 'A', b1: 'B', c1: 'C', ab: 'A' };
const REPOS: Record<string, string[]> = { ab: ['B'] };
const isOpen = (id: string) => id === 'A' || id === 'B';
// As guestWorld: only open floors seat anyone.
// Visits under way on A: a1 tells a2, ab tells a1, a2 asks ab.
// v4: a1 still visiting a host that has been sent home (off the roster).
const VISITS: Record<string, { visitor: string; host: string }> = { v1: { visitor: 'a1', host: 'a2' }, v2: { visitor: 'ab', host: 'a1' }, v3: { visitor: 'a2', host: 'ab' }, v4: { visitor: 'a1', host: 'left' } };
const world: GuestWorld = { floorOf: (id) => (isOpen(SEATS[id] ?? '') ? SEATS[id] : undefined), isOpen, reposOf: (id) => REPOS[id], visitOf: (id) => VISITS[id] };

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
    assert.equal(!!out(preset, { t: 'missionControl', state: { orchestrator: { settings: { on: true } }, bots: [{ id: 'bot' }] } }), OFFICE.has(preset));
  }
  assert.equal(out('view-worker', { t: 'worker.remove', workerId: 'a1' }, ctx({ via: 'floor', floor: 'A' }))?.t, 'worker.remove', 'a single-worker guest hears its worker leave');
  assert.deepEqual(out('edit-office', { t: 'missionControl', state: { orchestrator: { id: ORCHESTRATOR_ID, settings: { on: true } }, bots: [{ id: 'bot' }] } }), {
    t: 'missionControl',
    state: { orchestrator: { id: ORCHESTRATOR_ID, settings: { on: true } }, bots: [] },
  });
  // Its saved model and effort are the owner's settings: a guest gets only whether it's on.
  const saved = { orchestrator: { settings: { on: false, model: 'claude-opus', effort: 'high' }, team: [] }, bots: [] };
  for (const preset of ['view-office', 'edit-office'] as const) {
    assert.deepEqual(out(preset, { t: 'missionControl', state: saved }), { t: 'missionControl', state: { orchestrator: { settings: { on: false }, team: [] }, bots: [] } });
    assert.deepEqual((out(preset, { t: 'welcome', connection: 'c', arrival: { floor: 'A', via: 'lobby' }, floors: [], version: '1', missionControl: saved, ...VIEW }) as { missionControl: unknown }).missionControl, {
      orchestrator: { settings: { on: false }, team: [] },
      bots: [],
    });
  }
  assert.equal(saved.orchestrator.settings.model, 'claude-opus', 'the owner’s state is untouched');
});

test('why the Orchestrator is blocked is the owner’s setup: guests get one fixed line and no Settings pane', () => {
  // The subscriptions gate names the owner's model and provider; unready() names their Droid sign-in.
  const blocked = (why: string, pane?: string) => ({ orchestrator: { settings: { on: true }, team: [], blocked: why, ...(pane ? { blockedPane: pane } : {}) }, bots: [] });
  for (const state of [blocked('claude-opus-4 needs a Claude Max subscription: connect it in ⚙️ Settings → Subscriptions'), blocked('Droid isn’t ready on this computer. Install it, then sign in…', 'connections')]) {
    for (const preset of ['view-office', 'edit-office'] as const) {
      const sent = out(preset, { t: 'missionControl', state }) as Extract<ServerMsg, { t: 'missionControl' }>;
      assert.deepEqual(sent.state.orchestrator, { settings: { on: true }, team: [], blocked: GUEST_ORCHESTRATOR_BLOCKED });
      assert.equal(orchestratorBlocked(sent.state), GUEST_ORCHESTRATOR_BLOCKED, 'the guest page paints the fixed line');
      assert.equal(orchestratorSettingsPane(sent.state), 'orchestrator');
      const welcome = out(preset, { t: 'welcome', connection: 'c', arrival: { floor: 'A', via: 'lobby' }, floors: [], version: '1', missionControl: state, ...VIEW }) as { missionControl: { orchestrator: unknown } };
      assert.deepEqual(welcome.missionControl.orchestrator, sent.state.orchestrator);
    }
    assert.notEqual(state.orchestrator.blocked, GUEST_ORCHESTRATOR_BLOCKED, 'the owner’s state is untouched');
  }
  assert.equal(GUEST_ORCHESTRATOR_BLOCKED, CLIENT_GUEST_ORCHESTRATOR_BLOCKED, 'the server sends the line the guest page paints');
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
    missionControl: { orchestrator: { id: ORCHESTRATOR_ID, settings: { on: true } }, bots: [{ id: 'bot' }] },
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
  assert.deepEqual(o.missionControl, { orchestrator: { id: ORCHESTRATOR_ID, settings: { on: true } }, bots: [] });

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

test('toasts reach a floor link only when it sees every worker they name, the ones that left included', () => {
  const ab = { ...worker('ab'), repos: [{ floor: 'B', name: 'beta', dir: '/Users/owner/beta', path: 'ws/beta', branch: 'office/ab', base: 'abc' }] } as WorkerInfo;
  const onA = (about?: GuestSendContext['about']) => ctx({ via: 'floor', floor: 'A', ...(about ? { about } : {}) });
  const toast = (text: string, workerId?: string) => ({ t: 'toast', text, level: 'info', ...(workerId ? { workerId } : {}) });
  const hire = toast('Owner hired ab across alpha + beta', 'ab');
  const sentHome = toast('Owner sent ab home');
  const reported = toast('📨 a1 reported to ab: “done”', 'a1');
  for (const preset of ['view-floor', 'edit-floor'] as const) {
    assert.equal(out(preset, hire, onA()), undefined, `${preset}: the hire of a worker across repositories`);
    assert.equal(out(preset, sentHome, onA([ab])), undefined, `${preset}: it left already, its repos still count`);
    assert.equal(out(preset, reported, onA([{ id: 'ab' }])), undefined, `${preset}: a toast about a1 that names ab`);
    assert.ok(out(preset, toast('Owner hired a2', 'a2'), onA()));
    assert.ok(out(preset, toast('Owner sent gone home'), onA([{ id: 'gone' }])), 'a plain worker that left is still floor news');
    assert.ok(out(preset, toast('📨 a1 reported to a2: “done”', 'a1'), onA([{ id: 'a2' }])));
    assert.ok(out(preset, toast('🚀 Owner started CI'), onA()));
  }
  // A single-worker link: its own worker's toasts only, as before, and none that names another worker.
  const pick: GuestScopeGrant = { preset: 'view-worker', floorId: 'A', workerId: 'ab' };
  const o = (msg: unknown, c: GuestSendContext) => guestOutbound(pick, msg as ServerMsg, c, world);
  assert.ok(o(hire, onA()));
  assert.equal(o(toast('🧭 a1 hired ab', 'ab'), onA([{ id: 'a1' }])), undefined);
  assert.equal(o(sentHome, onA([ab])), undefined, 'floor news never reaches a single-worker link');
  assert.equal(o(toast('Owner hired a2', 'a2'), onA()), undefined);
  // Office links see every open floor.
  for (const preset of ['view-office', 'edit-office'] as const)
    for (const [msg, about] of [
      [hire, undefined],
      [sentHome, [ab]],
      [reported, [{ id: 'ab' }]],
    ] as const)
      assert.ok(out(preset, msg, onA(about)), preset);
});

test('visits and what visitors say reach a guest only between two workers it sees', () => {
  const visit = (id: string, visitor: string, host: string) => ({ id, visitor, host, kind: 'tell', phase: 'talking', slot: 0, since: 1 });
  const visits = { t: 'visits', visits: [visit('v1', 'a1', 'a2'), visit('v2', 'ab', 'a1'), visit('v3', 'a2', 'ab')] };
  const ids = (m: unknown) => (m as { visits?: { id: string }[] } | undefined)?.visits?.map((v) => v.id);
  const say = (v: string) => ({ t: 'visit_say', visit: v, worker: VISITS[v]?.visitor ?? 'a1', text: 'the build is green' });
  for (const via of ['floor', 'direct'] as const) {
    const c = ctx({ via, ...(via === 'floor' ? { floor: 'A' } : {}), here: 'A' });
    for (const preset of ['view-floor', 'edit-floor'] as const) {
      assert.deepEqual(ids(out(preset, visits, c)), ['v1'], `${preset} ${via}`);
      assert.ok(out(preset, say('v1'), c));
      for (const v of ['v2', 'v3', 'gone']) assert.equal(out(preset, say(v), c), undefined, `${preset} ${v}`);
    }
    for (const preset of ['view-office', 'edit-office'] as const) {
      assert.deepEqual(ids(out(preset, visits, c)), ['v1', 'v2', 'v3']);
      for (const v of ['v1', 'v2', 'v3']) assert.ok(out(preset, say(v), c));
      assert.equal(out(preset, say('gone'), c), undefined, 'a visit nobody knows says nothing');
    }
    // A single-worker link sees no floor content, visits included, as before.
    const pick: GuestScopeGrant = { preset: 'view-worker', floorId: 'A', workerId: 'a1' };
    assert.equal(guestOutbound(pick, visits as ServerMsg, c, world), undefined);
    assert.equal(guestOutbound(pick, say('v1') as ServerMsg, c, world), undefined);
  }
  assert.equal(out('view-floor', visits, ctx({ via: 'floor', floor: 'B' })), undefined, 'another floor’s visits');
});

test('a visit whose host was sent home mid-visit reaches only office links', () => {
  // Off the roster, the host's floors went with it: a floor link can't tell it was ever one of its workers.
  const returning = { id: 'v4', visitor: 'a1', host: 'left', kind: 'tell', phase: 'returning', slot: 0, since: 1 };
  const visits = { t: 'visits', visits: [{ ...returning, id: 'v1', host: 'a2', phase: 'talking' }, returning] };
  const say = { t: 'visit_say', visit: 'v4', worker: 'a1', text: 'see you' };
  const ids = (m: unknown) => (m as { visits?: { id: string }[] } | undefined)?.visits?.map((v) => v.id);
  const c = ctx({ via: 'floor', floor: 'A' });
  for (const preset of ['view-floor', 'edit-floor'] as const) {
    assert.deepEqual(ids(out(preset, visits, c)), ['v1'], preset);
    assert.equal(out(preset, say, c), undefined, preset);
  }
  for (const preset of ['view-office', 'edit-office'] as const) {
    assert.deepEqual(ids(out(preset, visits, c)), ['v1', 'v4'], preset);
    assert.ok(out(preset, say, c), preset);
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

test('a worker across repositories leaves without a word to the floor links that never saw it', () => {
  // Off every map by then: only the floors it worked in, sent with the removal, say it was never theirs.
  const left = [{ id: 'gone', repos: [{ floor: 'B', name: 'beta', dir: '/Users/owner/beta', path: 'ws/beta', branch: 'office/gone', base: 'abc' }] }];
  const removal = { t: 'worker.remove', workerId: 'gone' };
  const building = { t: 'building.remove', floor: 'A', workerId: 'gone' };
  for (const preset of ['view-floor', 'edit-floor'] as const) {
    assert.equal(out(preset, removal, ctx({ via: 'floor', floor: 'A', about: left })), undefined, preset);
    assert.equal(out(preset, building, ctx({ via: 'all', about: left })), undefined, preset);
    // A worker of this floor alone still leaves in plain sight.
    assert.ok(out(preset, removal, ctx({ via: 'floor', floor: 'A', about: [{ id: 'gone' }] })));
    assert.ok(out(preset, building, ctx({ via: 'all', about: [{ id: 'gone' }] })));
  }
  for (const preset of ['view-office', 'edit-office'] as const) {
    assert.ok(out(preset, removal, ctx({ via: 'floor', floor: 'A', about: left })), preset);
    assert.ok(out(preset, building, ctx({ via: 'all', about: left })), preset);
  }
  // A single-worker link picked it: it sees its own worker go, other floors or not.
  const pick: GuestScopeGrant = { preset: 'view-worker', floorId: 'A', workerId: 'gone' };
  assert.ok(guestOutbound(pick, removal as ServerMsg, ctx({ via: 'floor', floor: 'A', about: left }), world));
  assert.ok(guestOutbound(pick, building as ServerMsg, ctx({ via: 'all', about: left }), world));
  assert.equal(guestOutbound({ ...pick, workerId: 'a1' }, removal as ServerMsg, ctx({ via: 'floor', floor: 'A', about: left }), world), undefined);
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
