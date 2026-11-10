import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Orchestrator, type OrchestratorFloor } from '../src/server/orchestrator.js';
import { Team } from '../src/server/team.js';
import { HOOK_VERSION, WorkerManager } from '../src/server/workers.js';
import { ORCHESTRATOR_ID } from '../src/shared/mission-control.js';
import { SUBAGENT_DEFAULTS, type WorkerInfo } from '../src/shared/protocol.js';

type Launch = { args: string[]; token: string; stdin?: string };

/** Stands in for Droid: records each launch's arguments and hook token, and what is typed into it. */
const fakeDroid = `#!/usr/bin/env node
const fs = require('node:fs');
const record = (extra = {}) => fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ args: process.argv.slice(2), token: process.env.DROID_OFFICE_HOOK_TOKEN, ...extra }) + '\\n');
record();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => record({ stdin: chunk }));
process.stdin.resume();
`;

async function until<T>(read: () => T | undefined | false, what: string): Promise<T> {
  const end = Date.now() + 8000;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** An Orchestrator whose Droid is `fakeDroid`, with its launches and the hooks a real session would send. */
function rig(t: { after(fn: () => void): void }, dir = mkdtempSync(path.join(tmpdir(), 'orchestrator-')), floors: () => OrchestratorFloor[] = () => []) {
  const droid = path.join(dir, 'droid');
  const log = path.join(dir, 'launches.jsonl');
  if (!existsSync(droid)) {
    writeFileSync(droid, fakeDroid, { mode: 0o700 });
    writeFileSync(log, '');
  }
  const before = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_LOG = log;
  let blocked: string | undefined;
  const orchestrator = new Orchestrator({
    dataDir: dir,
    agentCmd: droid,
    agentArgs: [],
    hook: { url: 'http://127.0.0.1:1', token: '' },
    floors,
    unready: () => blocked,
    changed() {},
    data() {},
    screen() {},
    toast() {},
  });
  t.after(() => {
    orchestrator.shutdown();
    if (before === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = before;
    rmSync(dir, { recursive: true, force: true });
  });
  const records = (): Launch[] =>
    readFileSync(log, 'utf8')
      .split('\n')
      // A poll can land mid-append; a finished record ends with a newline.
      .slice(0, -1)
      .map((line) => JSON.parse(line) as Launch);
  const launches = () => records().filter((r) => r.stdin === undefined);
  const launched = (count: number) => until(() => launches().length >= count && launches()[count - 1], `launch ${count}`);
  /** Every message pasted into one launch's terminal, oldest first. */
  const typed = (launch: Launch) =>
    [
      ...records()
        .filter((r) => r.stdin !== undefined && r.token === launch.token)
        .map((r) => r.stdin)
        .join('')
        .matchAll(/\x1b\[200~([\s\S]*?)\x1b\[201~/g),
    ].map((m) => m[1]);
  /** A hook from one launch's session; what the office answers is what Droid reads. */
  const hook = (launch: Launch, event: string, extra: Record<string, unknown> = {}) => {
    const reply = orchestrator.workers.hookReply(ORCHESTRATOR_ID, launch.token, event, { session_id: 'session-1', hook_event_name: event, ...extra }, HOOK_VERSION);
    assert.notEqual(reply, undefined, event);
    return reply;
  };
  return {
    dir,
    orchestrator,
    launches,
    launched,
    typed,
    hook,
    block: (why: string | undefined) => {
      blocked = why;
    },
  };
}

test('the Orchestrator starts on its first prompt, takes the next one in the same session, and stops no turn that isn’t running', async (t) => {
  const r = rig(t);
  r.block('Sign in first');
  assert.equal(r.orchestrator.prompt('Plan the release'), 'Sign in first');
  assert.equal(r.orchestrator.identity()?.activity, 'Sign in first');
  r.block(undefined);
  assert.equal(r.orchestrator.identity()?.activity, 'Ready for its first prompt');
  assert.equal(r.orchestrator.state().agent, undefined);
  assert.equal(r.orchestrator.interrupt(), false, 'no session, so no turn to stop');
  assert.deepEqual(r.launches(), [], 'being asked who it is starts nothing');

  assert.equal(r.orchestrator.prompt('Plan the release'), undefined);
  assert.equal(r.orchestrator.prompt('And list the risks'), undefined, 'a prompt sent before Droid is ready');
  const first = await r.launched(1);
  assert.deepEqual(r.orchestrator.authenticate(ORCHESTRATOR_ID, first.token)?.id, ORCHESTRATOR_ID);
  assert.equal(r.orchestrator.authenticate(ORCHESTRATOR_ID, 'another-worker-token'), undefined);
  r.hook(first, 'SessionStart', { source: 'startup' });
  await until(() => r.typed(first).length === 2, 'both prompts');
  assert.deepEqual([...r.typed(first)].sort(), ['And list the risks', 'Plan the release']);
  assert.equal(r.launches().length, 1, 'one session, however fast the prompts came');
  assert.equal(r.orchestrator.interrupt(), false, 'at rest, so nothing to stop');
});

test('a prompt for an Orchestrator whose session ended carries its conversation on, pictures included', async (t) => {
  const r = rig(t);
  r.orchestrator.prompt('Plan the release');
  const first = await r.launched(1);
  r.hook(first, 'SessionStart', { source: 'startup' });
  assert.equal(r.orchestrator.workers.halt(ORCHESTRATOR_ID), true);
  // The smallest PNG the office accepts as a picture.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const picture = r.orchestrator.workers.stageImage('mock.png', png);
  assert.ok(picture);
  assert.equal(r.orchestrator.prompt('What is on this mock-up?', [picture]), undefined);
  assert.equal(r.orchestrator.info?.activity, 'What is on this mock-up?', 'its card shows the prompt, not the file list');
  const second = await r.launched(2);
  assert.deepEqual(second.args.slice(-2), ['--resume', 'session-1']);
  r.hook(second, 'SessionStart', { source: 'resume' });
  const message = await until(() => r.typed(second)[0], 'the prompt with its picture');
  assert.match(message, /^What is on this mock-up\?\n\nImage 1: .+mock\.png$/);
  assert.equal(existsSync(/Image 1: (.+)$/.exec(message)![1]), true, 'the picture is the Orchestrator’s own file now');
});

test('pictures sent alone to an Orchestrator cut off mid-turn reach its session instead of a carry-on note', async (t) => {
  const r = rig(t);
  r.orchestrator.prompt('Plan the release');
  const first = await r.launched(1);
  r.hook(first, 'SessionStart', { source: 'startup' });
  r.orchestrator.shutdown(true);
  // The office went down mid-turn, and the next one opened without waking it.
  const file = path.join(r.dir, 'orchestrator', '.droid-office', 'workers.json');
  const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[];
  writeFileSync(file, JSON.stringify(saved.map((s) => ({ ...s, midTurn: true }))));
  const reopened = rig(t, r.dir);
  const asleep = reopened.orchestrator.workers.asleep;
  reopened.orchestrator.workers.asleep = () => true;
  await reopened.orchestrator.start();
  reopened.orchestrator.workers.asleep = asleep;
  assert.equal(reopened.launches().length, 1);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const picture = reopened.orchestrator.workers.stageImage('mock.png', png);
  assert.ok(picture);
  assert.equal(reopened.orchestrator.prompt('', [picture]), undefined);
  const second = await reopened.launched(2);
  reopened.hook(second, 'SessionStart', { source: 'resume' });
  const message = await until(() => reopened.typed(second)[0], 'the pictures');
  assert.match(message, /^Image 1: .+mock\.png$/);
});

test('off stops only the Orchestrator’s session; on carries its conversation on, as an office restart does', async (t) => {
  const r = rig(t);
  r.orchestrator.prompt('Plan the release');
  const first = await r.launched(1);
  r.hook(first, 'SessionStart', { source: 'startup' });
  assert.equal(r.orchestrator.set({ on: false }), undefined);
  assert.equal(r.orchestrator.identity(), undefined, 'it leads nobody while it is off');
  assert.equal(r.orchestrator.authenticate(ORCHESTRATOR_ID, first.token), undefined);
  assert.match(r.orchestrator.prompt('Are you there?') ?? '', /is off/);
  assert.equal(r.orchestrator.tell('Team news'), 'The Orchestrator is off');
  assert.equal(r.orchestrator.state().agent?.worker.sessionId, 'session-1', 'its conversation is kept');
  assert.deepEqual(JSON.parse(readFileSync(path.join(r.dir, 'orchestrator.json'), 'utf8')), { on: false });
  r.orchestrator.shutdown(true);

  const reopened = rig(t, r.dir);
  await reopened.orchestrator.start();
  assert.equal(reopened.orchestrator.state().settings.on, false);
  assert.equal(reopened.launches().length, 1, 'an office that opens with it off leaves it asleep');
  assert.equal(reopened.orchestrator.set({ on: true }), undefined);
  const second = await reopened.launched(2);
  assert.deepEqual(second.args.slice(-2), ['--resume', 'session-1']);
  assert.equal(reopened.orchestrator.identity()?.id, ORCHESTRATOR_ID);
});

test('a new model waits for the Orchestrator’s turn to end, then restarts its session on it', async (t) => {
  const r = rig(t);
  r.orchestrator.prompt('Plan the release');
  const first = await r.launched(1);
  r.hook(first, 'SessionStart', { source: 'startup' });
  r.hook(first, 'UserPromptSubmit', { prompt: 'Plan the release' });
  assert.equal(r.orchestrator.info?.status, 'working');
  assert.equal(r.orchestrator.set({ on: true, model: 'claude-haiku-5-5', effort: 'low' }), undefined);
  assert.equal(r.orchestrator.workers.running(ORCHESTRATOR_ID), true);
  assert.equal(r.launches().length, 1, 'the turn in progress is left alone');
  r.hook(first, 'Stop');
  const second = await r.launched(2);
  assert.deepEqual(second.args.slice(-2), ['--resume', 'session-1']);
  assert.deepEqual([r.orchestrator.info?.model, r.orchestrator.info?.effort], ['claude-haiku-5-5', 'low']);
  assert.deepEqual(JSON.parse(readFileSync(path.join(r.dir, 'orchestrator.json'), 'utf8')), { on: true, model: 'claude-haiku-5-5', effort: 'low' });
});

test('a new conversation ends the Orchestrator’s session, and a prompt sent straight after starts a fresh one', async (t) => {
  const r = rig(t);
  r.orchestrator.prompt('Plan the release');
  const first = await r.launched(1);
  r.hook(first, 'SessionStart', { source: 'startup' });
  r.orchestrator.reset();
  assert.equal(r.orchestrator.state().agent, undefined);
  assert.equal(r.orchestrator.authenticate(ORCHESTRATOR_ID, first.token), undefined, 'the old session’s token is dead');
  assert.equal(r.orchestrator.identity()?.id, ORCHESTRATOR_ID, 'it is still who its team reports to');
  assert.equal(r.orchestrator.tell('Team news'), 'The Orchestrator has no session running');
  assert.equal(r.orchestrator.prompt('Start over'), undefined);
  const second = await r.launched(2);
  assert.equal(second.args.includes('--resume'), false);
  assert.notEqual(second.token, first.token);
  assert.equal(r.orchestrator.info?.sessionId, undefined);
});

test('its team’s news is typed into an Orchestrator at rest, and handed over at the end of a turn in progress', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orchestrator-'));
  const floors: OrchestratorFloor[] = [];
  let floor: WorkerManager | undefined;
  let team: Team | undefined;
  // Before the rig's own cleanup, which removes the folder they save to.
  t.after(() => {
    team?.stop();
    floor?.shutdown();
  });
  const r = rig(t, dir, () => floors);
  const sub: WorkerInfo = { id: 'sub', name: 'Byte', kind: 'agent', deskId: 'desk-1', color: '#4f9dde', status: 'working', acked: true, createdBy: 'owner', createdAt: 1, cols: 100, rows: 30, open: false, lead: ORCHESTRATOR_ID };
  mkdirSync(path.join(dir, 'floor'));
  const building = {
    agents: {
      identity: (id: string) => (id === ORCHESTRATOR_ID ? r.orchestrator.identity() : undefined),
      known: (id: string) => id === ORCHESTRATOR_ID,
      tell: (_id: string, text: string) => r.orchestrator.tell(text),
    },
    floor: 'alpha',
  };
  floor = new WorkerManager(dir, path.join(dir, 'floor'), '/not-a-droid', [], { url: 'http://127.0.0.1:1', token: '' }, { update() {}, remove() {}, data() {}, screen() {}, toast() {} }, undefined, undefined, undefined, true, building);
  const workers = floor;
  team = new Team(
    {
      list: () => [sub],
      get: (id) => (id === sub.id ? sub : workers.buildingIdentity(id)),
      officeDefault: undefined,
      deskOccupied: () => false,
      hire: () => 'Not used',
      prompt: (id, text) => workers.tell(id, text),
      resume: () => undefined,
      kill: async () => ({}),
      tail: () => '',
      setTask() {},
    },
    // A clock a minute ahead: the prompt just typed for the owner no longer holds a wake note back.
    { dataDir: path.join(dir, 'team'), dir, git: false, settings: () => ({ ...SUBAGENT_DEFAULTS, wakeLead: true }), toast() {}, nudgeDelayMs: 1, now: () => Date.now() + 60_000 },
  );
  floors.push({ id: 'alpha', def: { name: 'alpha' }, workers: { list: () => [sub] }, team });

  assert.equal(r.orchestrator.prompt('Plan the release'), undefined);
  const session = await r.launched(1);
  r.hook(session, 'SessionStart');
  await until(() => r.typed(session).length === 1, 'the prompt its session started for');
  assert.equal((await team.handle(sub, { action: 'report', text: 'Tests passed' })).status, 200);
  assert.match(await until(() => r.typed(session)[1], 'the wake note typed in at rest'), /Byte reported back/);

  r.hook(session, 'UserPromptSubmit', { prompt: 'Read the report' });
  assert.equal((await team.handle(sub, { action: 'report', text: 'Which branch?', question: true })).status, 200);
  const held = JSON.parse(r.hook(session, 'Stop') ?? '') as { decision: string; reason: string };
  assert.equal(held.decision, 'block');
  assert.match(held.reason, /Byte asked you a question/);

  // Its subagent finishes a turn without a word while the Orchestrator's own turn goes on.
  for (const status of ['idle', 'working', 'done'] as const) {
    sub.status = status;
    team.onWorker({ ...sub });
  }
  assert.equal(r.hook(session, 'Stop', { stop_hook_active: true }), '', 'a Stop the office already held is not held again');
  assert.match(await until(() => r.typed(session)[2], 'the wake note once its turn ended'), /Byte finished its turn without reporting/);
  assert.equal(r.typed(session).length, 3, 'nothing was typed into the turn in progress');
});
