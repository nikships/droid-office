import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../src/server/orchestrator.js';
import { Team } from '../src/server/team.js';
import { WorkerManager } from '../src/server/workers.js';
import { SUBAGENT_DEFAULTS, type WorkerInfo } from '../src/shared/protocol.js';

test('Orchestrator settings, restart, off and reset preserve its teams without launching a discovery session', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orchestrator-lifecycle-'));
  let blocked: string | undefined = 'Sign in first';
  const changed: number[] = [];
  const orchestrator = new Orchestrator({
    dataDir: dir,
    agentCmd: '/not-a-droid',
    agentArgs: [],
    hook: { url: 'http://127.0.0.1:1', token: '' },
    floors: () => [],
    unready: () => blocked,
    changed: () => changed.push(1),
    data() {},
    screen() {},
    toast() {},
  });
  t.after(() => {
    orchestrator.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(orchestrator.state().agent, undefined);
  assert.equal(orchestrator.rosterAgent()?.worker.activity, 'Sign in first');
  assert.equal(orchestrator.prompt('Start'), 'Sign in first');
  assert.equal(orchestrator.info, undefined);
  blocked = undefined;
  assert.equal(orchestrator.rosterAgent()?.worker.activity, 'Ready for its first prompt');
  const worker: WorkerInfo = {
    id: 'orchestrator',
    name: 'Orchestrator',
    kind: 'agent',
    deskId: '',
    color: '#ee6018',
    status: 'done',
    acked: true,
    createdBy: 'owner',
    createdAt: 1,
    cols: 100,
    rows: 30,
    open: false,
  };
  t.mock.method(orchestrator.workers, 'get', () => worker);
  t.mock.method(orchestrator.workers, 'running', () => true);
  const choose = t.mock.method(orchestrator.workers, 'choose', () => undefined);
  const halt = t.mock.method(orchestrator.workers, 'halt', () => true);
  const resume = t.mock.method(orchestrator.workers, 'resume', () => undefined);
  const forget = t.mock.method(orchestrator.workers, 'forget', () => true);
  const cancel = t.mock.method(orchestrator.workers, 'cancelTurn', () => false);
  assert.equal(orchestrator.set({ on: true, model: 'claude-haiku-5-5', effort: 'low' }), undefined);
  assert.equal(choose.mock.callCount(), 1);
  assert.equal(halt.mock.callCount(), 1, 'a settled session restarts on its new model');
  assert.equal(resume.mock.callCount(), 1);
  worker.status = 'working';
  orchestrator.set({ on: true, model: 'kimi-k3' });
  assert.equal(halt.mock.callCount(), 1, 'a model change leaves the active turn alone');
  orchestrator.set({ on: false, model: 'kimi-k3' });
  assert.equal(halt.mock.callCount(), 2);
  assert.equal(orchestrator.identity(), undefined);
  assert.equal(orchestrator.rosterAgent(), undefined);
  assert.match(orchestrator.prompt('Start') ?? '', /is off/);
  assert.equal(orchestrator.tell('Team news'), 'The Orchestrator is off');
  assert.equal(orchestrator.authenticate('orchestrator', 'token'), undefined);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'orchestrator.json'), 'utf8')), { on: false, model: 'kimi-k3' });
  orchestrator.reset();
  assert.equal(forget.mock.callCount(), 1, 'reset forgets its conversation, not floor workers');
  assert.equal(orchestrator.interrupt(), false);
  assert.deepEqual(cancel.mock.calls[0].arguments, ['orchestrator']);
  assert.ok(changed.length >= 4);
});

test('reports, questions and finishes wake a resting deskless Orchestrator through its floor delivery path', { timeout: 10_000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orchestrator-wake-'));
  const orchestrator = new Orchestrator({
    dataDir: dir,
    agentCmd: '/not-a-droid',
    agentArgs: [],
    hook: { url: 'http://127.0.0.1:1', token: '' },
    floors: () => [],
    unready: () => undefined,
    changed() {},
    data() {},
    screen() {},
    toast() {},
  });
  const lead: WorkerInfo = {
    id: 'orchestrator',
    name: 'Orchestrator',
    kind: 'agent',
    deskId: '',
    color: '#ee6018',
    status: 'done',
    acked: true,
    createdBy: 'owner',
    createdAt: 1,
    cols: 100,
    rows: 30,
    open: false,
  };
  const sub: WorkerInfo = { ...lead, id: 'sub', name: 'Byte', lead: lead.id, deskId: 'desk-1', status: 'working' };
  t.mock.method(orchestrator.workers, 'get', () => lead);
  t.mock.method(orchestrator.workers, 'running', () => true);
  let delivered: ((text: string) => void) | undefined;
  t.mock.method(orchestrator.workers, 'tell', (id: string, text: string) => {
    assert.equal(id, 'orchestrator');
    delivered?.(text);
    return undefined;
  });
  mkdirSync(path.join(dir, 'floor'), { recursive: true });
  const floor = new WorkerManager(
    dir,
    path.join(dir, 'floor'),
    '/not-a-droid',
    [],
    { url: 'http://127.0.0.1:1', token: '' },
    {
      update() {},
      remove() {},
      data() {},
      screen() {},
      toast() {},
    },
    undefined,
    undefined,
    undefined,
    true,
    {
      agents: {
        identity: (id) => (id === lead.id ? orchestrator.identity() : undefined),
        known: (id) => id === lead.id,
        tell: (_id, text) => orchestrator.tell(text),
      },
      floor: 'alpha',
    },
  );
  const team = new Team(
    {
      list: () => [sub],
      get: (id) => (id === sub.id ? sub : floor.buildingIdentity(id)),
      officeDefault: undefined,
      deskOccupied: () => false,
      hire: () => 'Not used',
      prompt: (id, text) => floor.tell(id, text),
      resume: () => undefined,
      kill: async () => ({}),
      tail: () => '',
      setTask() {},
    },
    { dataDir: path.join(dir, 'team'), dir, git: false, settings: () => ({ ...SUBAGENT_DEFAULTS, wakeLead: true }), toast() {}, nudgeDelayMs: 1 },
  );
  t.after(() => {
    team.stop();
    floor.shutdown();
    orchestrator.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  const news = () =>
    new Promise<string>((resolve) => {
      delivered = resolve;
    });
  for (const question of [false, true]) {
    const wake = news();
    const result = await team.handle(sub, { action: 'report', text: question ? 'Which branch?' : 'Tests passed', question });
    assert.equal(result.status, 200);
    assert.match(await wake, question ? /asked you a question/ : /reported back/);
  }
  lead.status = 'working';
  sub.status = 'idle';
  team.onWorker({ ...sub });
  sub.status = 'working';
  team.onWorker({ ...sub });
  sub.status = 'done';
  team.onWorker({ ...sub });
  const wake = news();
  lead.status = 'done';
  team.leadRested(lead.id);
  assert.match(await wake, /finished its turn without reporting/);
});
