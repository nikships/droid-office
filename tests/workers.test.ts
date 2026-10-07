import test from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CARRY_ON_PROMPT, WorkerManager, type WorkerEvents } from '../src/server/workers.js';
import { Worktrees } from '../src/server/worktrees.js';
import type { PromptSource } from '../src/server/prompts.js';
import { PROMPTS } from '../src/shared/prompts.js';
import type { AgentChoice, AgentEffort, WorkerInfo } from '../src/shared/protocol.js';

type Invocation = {
  kind: string;
  args: string[];
  stdin?: string;
  env: {
    workerId?: string;
    hookToken?: string;
    hookUrl?: string;
    path?: string;
  };
};

type Fixture = {
  root: string;
  data: string;
  log: string;
  droid: string;
  read(): Invocation[];
  close(): void;
};

/** Keep the Droid CLI in this test fixture from seeing a user's config or credentials. */
function isolateAgentEnvironment(f: Fixture, t: { after(fn: () => void): void }) {
  const previous = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  };
  const home = path.join(f.root, 'home');
  const config = path.join(f.root, 'config');
  process.env.PATH = `${path.dirname(f.droid)}${path.delimiter}${previous.PATH ?? ''}`;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = config;
  process.env.XDG_DATA_HOME = path.join(f.root, 'xdg-data');
  process.env.XDG_STATE_HOME = path.join(f.root, 'xdg-state');
  process.env.XDG_CACHE_HOME = path.join(f.root, 'xdg-cache');
  // Delete by variable name only. Do not read or log any credential value.
  for (const key of Object.keys(process.env)) {
    // These are the office hook variables used by the in-process tests;
    // they are synthetic protocol values, not credentials.
    if (key.startsWith('DROID_OFFICE_')) continue;
    if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|CREDENTIAL|TOKEN)/i.test(key)) delete process.env[key];
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const fakeAgent = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const log = process.env.FAKE_AGENT_LOG;
const kind = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const record = (extra = {}) => fs.appendFileSync(log, JSON.stringify({
  kind,
  args,
  ...extra,
  env: {
    workerId: process.env.DROID_OFFICE_WORKER_ID,
    hookToken: process.env.DROID_OFFICE_HOOK_TOKEN,
    hookUrl: process.env.DROID_OFFICE_HOOK_URL,
    path: process.env.PATH,
  },
}) + '\\n');
record();

// The task namer invokes droid as a non-interactive JSON command (droid exec). Keep that
// invocation deterministic and separate from the worker's real PTY process.
if (args.includes('--output-format')) {
  process.stdout.write(JSON.stringify({ structured_output: { name: 'Fake Task', summary: 'Recording a deterministic test task' } }));
  process.exit(0);
}

process.stdout.write('fake-agent-ready\\r\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => record({ stdin: chunk }));
process.stdin.resume();
const delay = Number(process.env.FAKE_AGENT_EXIT_MS || 0);
if (delay > 0) setTimeout(() => process.exit(0), delay).unref();
`;

function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'droid-office-workers-'));
  const data = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'invocations.jsonl');
  const droid = path.join(bin, 'droid');
  mkdirSync(data, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(droid, fakeAgent, { mode: 0o700 });
  writeFileSync(log, '');
  return {
    root,
    data,
    log,
    droid,
    read() {
      if (!existsSync(log)) return [];
      return readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Invocation);
    },
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function events(updates: WorkerInfo[]): WorkerEvents {
  return {
    update: (info) => updates.push(info),
    remove() {},
    data() {},
    screen() {},
    toast() {},
  };
}

function manager(f: Fixture, updates: WorkerInfo[], args = ['--from-test']) {
  return new WorkerManager(f.root, f.data, f.droid, args, { url: 'http://127.0.0.1:1', token: '' }, events(updates));
}

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeout = 4000): Promise<T> {
  const end = Date.now() + timeout;
  let value = read();
  while (!predicate(value) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = read();
  }
  assert.ok(predicate(value), 'timed out waiting for fake agent state');
  return value;
}

test('Droid workers launch with their own hook overlay and resume the correct session', async (t) => {
  const f = fixture();
  const updates: WorkerInfo[] = [];
  isolateAgentEnvironment(f, t);
  const previousExit = process.env.FAKE_AGENT_EXIT_MS;
  const previousLog = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_EXIT_MS = '180';
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    if (previousExit === undefined) delete process.env.FAKE_AGENT_EXIT_MS;
    else process.env.FAKE_AGENT_EXIT_MS = previousExit;
    if (previousLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = previousLog;
    f.close();
  });

  const workers = manager(f, updates);
  t.after(() => workers.shutdown());
  const worker = workers.spawn('desk-2', 'test', '- inspect this code');
  assert.equal(typeof worker, 'object');
  if (typeof worker === 'string') return;
  const first = (
    await waitFor(
      () => f.read(),
      (records) => records.some((r) => r.kind === 'droid' && r.args.includes('--settings')),
    )
  ).find((r) => r.kind === 'droid' && r.args.includes('--settings'))!;
  assert.deepEqual(first.args.slice(0, 3), ['--settings', path.join(f.data, 'droid-hooks.json'), '--from-test']);
  assert.deepEqual(first.args.slice(-2), ['--', '- inspect this code']);
  assert.equal(first.env.workerId, worker.id);
  assert.ok(first.env.hookToken);
  const settings = JSON.parse(readFileSync(path.join(f.data, 'droid-hooks.json'), 'utf8'));
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /\/hooks\/droid/);
  assert.ok(!settings.hooks.PermissionRequest, 'Droid only receives supported hook events');

  const hook = (event: string, data: Record<string, unknown> = {}, token = first.env.hookToken!) => workers.handleHook(worker.id, token, event, { session_id: 'droid-1', hook_event_name: event, ...data });
  assert.equal(hook('SessionStart', { source: 'startup' }, 'wrong-token'), false);
  assert.equal(hook('SessionStart', { source: 'startup' }), true);
  assert.equal(workers.get(worker.id)?.status, 'idle');
  assert.equal(hook('UserPromptSubmit', { prompt: 'inspect this code' }), true);
  assert.equal(workers.get(worker.id)?.status, 'working');
  assert.equal(hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/main.ts' } }), true);
  assert.equal(workers.get(worker.id)?.action, 'read');
  assert.equal(hook('PreToolUse', { tool_name: 'Execute', tool_input: { command: 'git push' } }), true);
  assert.equal(hook('Notification', { notification_type: 'permission_prompt' }), true);
  assert.equal(workers.get(worker.id)?.status, 'needs_input');
  assert.equal(hook('PostToolUse', { tool_name: 'Read' }), true);
  assert.equal(workers.get(worker.id)?.status, 'needs_input', 'unrelated tools cannot dismiss a permission prompt');
  assert.equal(hook('PostToolUse', { tool_name: 'Execute' }), true);
  assert.equal(workers.get(worker.id)?.status, 'working', 'the tool it asked about ran: the prompt was answered');
  assert.equal(hook('UserPromptSubmit', { prompt: 'continue' }), true);
  assert.equal(hook('Stop', {}), true);
  assert.equal(workers.get(worker.id)?.status, 'done');
  // A hook payload without its event name, or one from another session, is turned away.
  assert.equal(workers.handleHook(worker.id, first.env.hookToken!, 'Stop', { session_id: 'droid-1' }), false);
  assert.equal(workers.handleHook(worker.id, first.env.hookToken!, 'Stop', { session_id: 'other', hook_event_name: 'Stop' }), false);

  await waitFor(
    () => workers.get(worker.id)?.status,
    (status) => status === 'exited',
  );
  assert.equal(workers.resume(worker.id), undefined);
  const second = (
    await waitFor(
      () => f.read(),
      (records) => records.filter((r) => r.kind === 'droid' && r.args.includes('--settings')).length >= 2,
    )
  ).filter((r) => r.kind === 'droid' && r.args.includes('--settings'))[1];
  assert.deepEqual(second.args.slice(-2), ['--resume', 'droid-1']);
  assert.notEqual(second.env.hookToken, first.env.hookToken);
  assert.equal(hook('Stop', {}), false, 'hooks from the old process must not control a resumed worker');
  assert.equal(hook('SessionStart', { source: 'resume' }, second.env.hookToken!), true);

  await waitFor(
    () => workers.get(worker.id)?.task?.name,
    (name) => name === 'Fake Task',
    8000,
  );
  workers.shutdown();
  const restored = manager(f, []);
  t.after(() => restored.shutdown());
  await restored.start();
  assert.equal(restored.get(worker.id)?.sessionId, 'droid-1');
  const third = (
    await waitFor(
      () => f.read(),
      (records) => records.filter((r) => r.kind === 'droid' && r.args.includes('--settings')).length >= 3,
    )
  ).filter((r) => r.kind === 'droid' && r.args.includes('--settings'))[2];
  assert.deepEqual(third.args.slice(-2), ['--resume', 'droid-1']);
});

test('a guest brought in sits at its desk with its name and resumes its own session, on the session’s model', async (t) => {
  const f = fixture();
  isolateAgentEnvironment(f, t);
  const previousLog = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    if (previousLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = previousLog;
    f.close();
  });
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  const guest: WorkerInfo = {
    id: 'guest-89430-abc',
    kind: 'agent',
    deskId: 'desk-4',
    name: 'Pixel',
    color: '#ff8800',
    status: 'done',
    acked: true,
    createdBy: 'outside the office',
    createdAt: 0,
    prompt: 'Fix the login redirect',
    task: { name: 'Login redirect', summary: 'outside the office · Droid · pid 89430' },
    activeModel: 'claude-opus-5-5',
    activeEffort: 'high',
    cols: 100,
    rows: 30,
    open: false,
    guest: { pid: 89430, tty: '/dev/ttys000', provider: 'droid', cwd: f.root, startedAt: 0, seen: 'transcript' },
  };
  const info = workers.takeIn(guest, 'outside-session', 'Nik');
  assert.equal(typeof info, 'object');
  if (typeof info === 'string') return;
  assert.notEqual(info.id, guest.id);
  assert.equal(info.guest, undefined, 'one of the office’s own workers now');
  assert.deepEqual([info.deskId, info.name, info.color, info.sessionId], ['desk-4', 'Pixel', '#ff8800', 'outside-session']);
  assert.equal(info.model, undefined, 'its model stays the session’s own');
  assert.equal(info.activeModel, 'claude-opus-5-5');
  assert.equal(info.task?.name, 'Login redirect');
  assert.equal(info.task?.summary, 'Fix the login redirect');
  assert.equal(info.worktree, undefined, 'it works in the checkout, where it was');
  const run = (
    await waitFor(
      () => f.read(),
      (records) => records.some((r) => r.kind === 'droid' && r.args.includes('--settings')),
    )
  ).find((r) => r.kind === 'droid' && r.args.includes('--settings'))!;
  assert.deepEqual(run.args, ['--settings', path.join(f.data, 'droid-hooks.json'), '--from-test', '--resume', 'outside-session']);
  assert.equal(run.env.workerId, info.id);

  assert.match(String(workers.takeIn({ ...guest, id: 'guest-2' }, 's-2', 'Nik')), /taken/, 'never onto a desk someone has');
  assert.match(String(workers.takeIn({ ...guest, deskId: 'station-issues' }, 's-3', 'Nik')), /desk or a bean bag/);
  const second = workers.takeIn({ ...guest, id: 'guest-3', deskId: 'desk-5' }, 's-4', 'Nik');
  assert.equal(typeof second, 'object');
  assert.notEqual(typeof second === 'object' && second.name, 'Pixel', 'a name already taken here is not reused');
  assert.equal(workers.full(), undefined);
});

test('Droid workers pin their model and effort in a per-worker settings overlay, kept across a restart', async (t) => {
  const f = fixture();
  const updates: WorkerInfo[] = [];
  isolateAgentEnvironment(f, t);
  const previousLog = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    if (previousLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = previousLog;
    f.close();
  });
  const workers = manager(f, updates);
  assert.match(workers.spawn('desk-4', 'test', 'bad', false, 'agent', 'has a space') as string, /Droid model/i);
  const worker = workers.spawn('desk-3', 'test', 'do the thing', false, 'agent', 'custom:droidproxy:gpt-6-sol', 'high');
  assert.equal(typeof worker, 'object');
  if (typeof worker === 'string') return;
  assert.equal(worker.model, 'custom:droidproxy:gpt-6-sol');
  assert.equal(worker.effort, 'high');
  const launch = (
    await waitFor(
      () => f.read(),
      (records) => records.some((r) => r.kind === 'droid' && r.args.includes('--settings')),
    )
  ).find((r) => r.kind === 'droid' && r.args.includes('--settings'))!;
  const overlayPath = path.join(f.data, `droid-${worker.id}.json`);
  assert.deepEqual(launch.args.slice(0, 2), ['--settings', overlayPath]);
  assert.ok(launch.args.includes('--from-test'), 'the office’s own --agent-args still go through');
  const overlay = JSON.parse(readFileSync(overlayPath, 'utf8'));
  assert.equal(overlay.sessionDefaultSettings.model, 'custom:droidproxy:gpt-6-sol');
  assert.equal(overlay.sessionDefaultSettings.reasoningEffort, 'high');
  assert.match(overlay.hooks.SessionStart[0].hooks[0].command, /\/hooks\/droid/);
  // The shared hooks file stays model-free for workers without an override.
  const shared = JSON.parse(readFileSync(path.join(f.data, 'droid-hooks.json'), 'utf8'));
  assert.equal(shared.sessionDefaultSettings, undefined);

  workers.shutdown();
  const restored = manager(f, []);
  t.after(() => restored.shutdown());
  await restored.start();
  assert.equal(restored.get(worker.id)?.model, 'custom:droidproxy:gpt-6-sol');
  assert.equal(restored.get(worker.id)?.effort, 'high');
  await workers.kill(worker.id);
  assert.equal(existsSync(overlayPath), false, 'a worker going home takes its overlay with it');
});

test('board agents are hired with the requested model and effort', async (t) => {
  const f = fixture();
  const updates: WorkerInfo[] = [];
  isolateAgentEnvironment(f, t);
  const previousLog = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    if (previousLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = previousLog;
    f.close();
  });
  const workers = manager(f, updates);
  t.after(() => workers.shutdown());
  assert.match(workers.station('station-queue', 'test', 'queue this', 'has a space') as string, /Droid model/i);
  const r = workers.station('station-queue', 'test', 'queue this', 'custom:droidproxy:gpt-6-sol', 'low');
  assert.equal(typeof r, 'object');
  if (typeof r === 'string') return;
  assert.equal(r.hired, true);
  assert.equal(r.info.model, 'custom:droidproxy:gpt-6-sol');
  assert.equal(r.info.effort, 'low');
  await waitFor(
    () => f.read(),
    (records) => records.some((x) => x.kind === 'droid' && x.args.includes('--settings')),
  );
  // An agent that's already there keeps its engine; the prompt just goes to its session.
  const again = workers.station('station-queue', 'test', 'and this', 'glm-5.3-flash', 'max');
  assert.equal(typeof again, 'object');
  if (typeof again === 'string') return;
  assert.equal(again.hired, false);
  assert.equal(workers.get(r.info.id)?.model, 'custom:droidproxy:gpt-6-sol');
});

test('a worker nobody picked for starts on the office default worker, told its board brief in the office’s words', async (t) => {
  const f = fixture();
  isolateAgentEnvironment(f, t);
  const previousLog = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    if (previousLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = previousLog;
    f.close();
  });
  let agent: AgentChoice | undefined = { model: 'custom:droidproxy:opus-5-5', effort: 'high' };
  const prompts: PromptSource = { text: (id) => (id === 'station.pulls' ? 'You review {{pullName}}s on {{site}}. The request:' : PROMPTS[id].text), agent: () => agent };
  const workers = new WorkerManager(f.root, f.data, f.droid, [], { url: 'http://127.0.0.1:1', token: '' }, events([]), undefined, undefined, prompts);
  t.after(() => workers.shutdown());
  assert.deepEqual(workers.officeDefault, agent);

  const r = workers.station('station-pulls', 'Ada', 'Sum up the open PRs');
  if (typeof r === 'string') return assert.fail(r);
  assert.deepEqual([r.info.model, r.info.effort], ['custom:droidproxy:opus-5-5', 'high']);
  const launch = (
    await waitFor(
      () => f.read(),
      (records) => records.some((x) => x.kind === 'droid' && x.args.includes('--settings')),
    )
  ).find((x) => x.kind === 'droid' && x.args.includes('--settings'))!;
  assert.ok(launch.args.includes('You review pull requests on GitHub. The request:\n\nSum up the open PRs'));
  const overlay = JSON.parse(readFileSync(path.join(f.data, `droid-${r.info.id}.json`), 'utf8'));
  assert.equal(overlay.sessionDefaultSettings.model, 'custom:droidproxy:opus-5-5');
  assert.equal(overlay.sessionDefaultSettings.reasoningEffort, 'high');

  // A picked model wins, and a shell is never given one.
  const picked = workers.spawn('desk-1', 'Ada', 'fix it', false, 'agent', 'glm-5.3-flash');
  if (typeof picked === 'string') return assert.fail(picked);
  assert.deepEqual([picked.model, picked.effort], ['glm-5.3-flash', undefined]);
  const shell = workers.spawn('desk-2', 'Ada', undefined, false, 'shell');
  if (typeof shell === 'string') return assert.fail(shell);
  assert.deepEqual([shell.model, shell.effort], [undefined, undefined], 'a shell is never given one');
  // Unset, it's Droid's own default model as before.
  agent = undefined;
  const plain = workers.spawn('desk-3', 'Ada', 'fix that');
  if (typeof plain === 'string') return assert.fail(plain);
  assert.deepEqual([plain.model, plain.effort], [undefined, undefined]);
});

test('workers reject malformed model ids, unknown efforts, and models or efforts on shells', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  assert.match(workers.spawn('desk-1', 'test', 'bad', false, 'agent', 'has a space') as string, /Droid model/i);
  assert.match(workers.spawn('desk-2', 'test', 'bad', false, 'agent', undefined, 'overdrive' as AgentEffort) as string, /effort/i);
  assert.match(workers.spawn('desk-3', 'test', 'bad', false, 'shell', 'glm-5.3-flash') as string, /shell/i);
  assert.match(workers.spawn('desk-4', 'test', 'bad', false, 'shell', undefined, 'high' as AgentEffort) as string, /shell/i);
});

test('a saved worker comes back with a valid model, without an invalid one', (t) => {
  const f = fixture();
  t.after(() => f.close());
  writeFileSync(
    path.join(f.data, 'workers.json'),
    JSON.stringify([
      { id: 'kept', kind: 'agent', deskId: 'desk-1', name: 'Kept', model: 'glm-5.3-flash', sessionId: 'd-1', hookToken: 'kept-token' },
      { id: 'kept-bad', kind: 'agent', deskId: 'desk-2', name: 'Bad', model: 'has a space' },
      { id: 'shell-kept', kind: 'shell', deskId: 'desk-4', name: 'Shell' },
    ]),
  );
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  assert.deepEqual(
    workers
      .list()
      .map((w) => w.id)
      .sort(),
    ['kept', 'kept-bad', 'shell-kept'],
  );
  assert.equal(workers.get('kept')?.model, 'glm-5.3-flash');
  assert.equal(workers.get('kept-bad')?.model, undefined);
});

test('a board agent is hired with its brief on the first prompt, then prompted, woken and asked to prove who it is', async (t) => {
  const f = fixture();
  const updates: WorkerInfo[] = [];
  isolateAgentEnvironment(f, t);
  const previousExit = process.env.FAKE_AGENT_EXIT_MS;
  const previousLog = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_EXIT_MS = '600';
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    if (previousExit === undefined) delete process.env.FAKE_AGENT_EXIT_MS;
    else process.env.FAKE_AGENT_EXIT_MS = previousExit;
    if (previousLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = previousLog;
    f.close();
  });
  const workers = manager(f, updates);
  t.after(() => workers.shutdown());
  // Each start of the agent, not what it reads from its terminal afterwards.
  const launches = () => f.read().filter((r) => r.kind === 'droid' && r.args.includes('--settings') && r.stdin === undefined);

  assert.match(workers.station('desk-1', 'test', 'file an issue') as string, /no agent/i);
  assert.match(workers.station('station-issues', 'test', '   ') as string, /empty/i);
  assert.match(workers.spawn('station-issues', 'test', undefined, false, 'shell') as string, /shell/i);

  // Nobody there yet: it's hired, told what it's for, with the request after that.
  const hired = workers.station('station-issues', 'Ada', 'File an issue about the dog');
  assert.equal(typeof hired, 'object');
  if (typeof hired === 'string') return;
  assert.equal(hired.hired, true);
  assert.equal(hired.info.name, 'Issues agent');
  assert.equal(hired.info.deskId, 'station-issues');
  assert.equal(hired.info.activity, 'File an issue about the dog');
  const [first] = await waitFor(launches, (l) => l.length === 1);
  const initial = first.args.at(-1)!;
  assert.match(initial, /Issues agent/);
  assert.match(initial, /office-queue add/);
  assert.ok(initial.endsWith('File an issue about the dog'));
  const id = hired.info.id;

  // The same agent takes the next request in its session.
  const again = workers.station('station-issues', 'Grace', 'Label it as a bug');
  assert.deepEqual(typeof again === 'object' && [again.hired, again.info.id], [false, id]);
  await waitFor(
    () => f.read(),
    (records) => records.some((r) => r.stdin?.includes('Label it as a bug')),
  );

  // Waiting on an answer, a prompt would answer the question, so it's refused.
  assert.equal(workers.handleHook(id, first.env.hookToken!, 'SessionStart', { session_id: 'issues-session', hook_event_name: 'SessionStart' }), true);
  assert.equal(workers.handleHook(id, first.env.hookToken!, 'Notification', { session_id: 'issues-session', hook_event_name: 'Notification', notification_type: 'permission_prompt' }), true);
  assert.equal(workers.get(id)?.status, 'needs_input');
  assert.match(workers.station('station-issues', 'Ada', 'hello?') as string, /waiting on an answer/i);

  // Its own token proves who it is; anyone else's doesn't.
  assert.equal(workers.authenticate(id, first.env.hookToken!)?.id, id);
  assert.equal(workers.authenticate(id, 'not-its-token'), undefined);
  assert.equal(workers.authenticate(id, ''), undefined);

  // Asleep, a request wakes it up carrying on its session, without the brief again.
  await waitFor(
    () => workers.get(id)?.status,
    (s) => s === 'exited',
  );
  assert.equal(workers.authenticate(id, first.env.hookToken!), undefined);
  const woken = workers.station('station-issues', 'Ada', 'Close the duplicates');
  assert.deepEqual(typeof woken === 'object' && [woken.hired, woken.info.id], [false, id]);
  const [, second] = await waitFor(launches, (l) => l.length === 2);
  assert.ok(second.args.includes('--resume') && second.args.includes('issues-session'));
  assert.equal(second.args.at(-1), 'Close the duplicates');
});

test('board agents get office-queue on their PATH, and the queue agent is told by its brief alone', async (t) => {
  const f = fixture();
  const updates: WorkerInfo[] = [];
  isolateAgentEnvironment(f, t);
  const previousExit = process.env.FAKE_AGENT_EXIT_MS;
  const previousLog = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_EXIT_MS = '600';
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    if (previousExit === undefined) delete process.env.FAKE_AGENT_EXIT_MS;
    else process.env.FAKE_AGENT_EXIT_MS = previousExit;
    if (previousLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = previousLog;
    f.close();
  });
  const workers = manager(f, updates);
  t.after(() => workers.shutdown());
  const launches = (id: string) => f.read().filter((r) => r.kind === 'droid' && r.args.includes('--settings') && r.stdin === undefined && r.env.workerId === id);
  const bin = path.join(f.data, 'bin');
  const onPath = (r: Invocation) => (r.env.path ?? '').split(path.delimiter)[0] === bin;

  // The command is there, and runs the shipped script with the office's own node.
  accessSync(path.join(bin, 'office-queue'), constants.X_OK);
  assert.match(execFileSync(path.join(bin, 'office-queue'), ['--help'], { encoding: 'utf8' }), /office-queue add --title/);

  const hired = workers.station('station-queue', 'Ada', 'Fix the typo in the README');
  assert.equal(typeof hired, 'object');
  if (typeof hired === 'string') return;
  const id = hired.info.id;
  const [first] = await waitFor(
    () => launches(id),
    (l) => l.length === 1,
  );
  // Its brief is what keeps it from doing the work itself; it keeps its tools.
  assert.equal(first.args.includes('--disallowedTools'), false);
  assert.ok(first.args.at(-1)!.endsWith('Fix the typo in the README'));
  assert.ok(onPath(first), 'office-queue is first on its PATH');

  // Woken up carrying on its session, the command is still there.
  assert.equal(workers.handleHook(id, first.env.hookToken!, 'SessionStart', { session_id: 'queue-session', hook_event_name: 'SessionStart' }), true);
  await waitFor(
    () => workers.get(id)?.status,
    (s) => s === 'exited',
  );
  workers.station('station-queue', 'Grace', 'Also bump the version');
  const [, second] = await waitFor(
    () => launches(id),
    (l) => l.length === 2,
  );
  assert.ok(second.args.includes('--resume') && second.args.includes('queue-session'));
  assert.equal(second.args.at(-1), 'Also bump the version');
  assert.ok(onPath(second));

  // The other board agents get the command too; a desk worker gets none of it.
  const pulls = workers.station('station-pulls', 'Ada', 'Sum up the open PRs');
  const desk = workers.spawn('desk-2', 'Ada', 'Fix login');
  assert.ok(typeof pulls === 'object' && typeof desk === 'object');
  if (typeof pulls !== 'object' || typeof desk !== 'object') return;
  const [pullsLaunch] = await waitFor(
    () => launches(pulls.info.id),
    (l) => l.length === 1,
  );
  const [deskLaunch] = await waitFor(
    () => launches(desk.id),
    (l) => l.length === 1,
  );
  assert.ok(onPath(pullsLaunch));
  assert.equal((deskLaunch.env.path ?? '').split(path.delimiter).includes(bin), false);
});

test('a Droid worker acts out its latest tool call, and puts its head in its hands when its tests keep failing', async (t) => {
  const f = fixture();
  isolateAgentEnvironment(f, t);
  const previousExit = process.env.FAKE_AGENT_EXIT_MS;
  const previousLog = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_EXIT_MS = '5000';
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    if (previousExit === undefined) delete process.env.FAKE_AGENT_EXIT_MS;
    else process.env.FAKE_AGENT_EXIT_MS = previousExit;
    if (previousLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = previousLog;
    f.close();
  });
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  const worker = workers.spawn('desk-1', 'test', 'make the tests pass');
  if (typeof worker === 'string') return assert.fail(worker);
  const [launch] = await waitFor(
    () => f.read().filter((r) => r.kind === 'droid' && r.args.includes('--settings')),
    (l) => l.length === 1,
  );
  const settings = JSON.parse(readFileSync(launch.args[launch.args.indexOf('--settings') + 1], 'utf8'));
  assert.ok(settings.hooks.PostToolUse, 'tool calls are reported');

  const token = launch.env.hookToken!;
  const hook = (event: string, payload: object) => assert.equal(workers.handleHook(worker.id, token, event, { session_id: 'acting', hook_event_name: event, ...payload }), true);
  const action = () => workers.get(worker.id)?.action;
  const npmTest = { tool_name: 'Bash', tool_input: { command: 'npm test 2>&1 | tail -5' } };
  hook('SessionStart', { source: 'startup' });
  hook('UserPromptSubmit', { prompt: 'make the tests pass' });
  assert.equal(action(), undefined);
  hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } });
  assert.equal(action(), 'read');
  hook('PreToolUse', npmTest);
  assert.equal(action(), 'test');
  // Failed once, by the summary it printed through the pipe: still watching.
  hook('PostToolUse', { ...npmTest, tool_response: { stdout: '# tests 5\n# pass 3\n# fail 2', stderr: '' } });
  assert.equal(action(), 'test');
  hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  assert.equal(action(), 'edit');
  // Failed again, by its exit code: head in hands, until its next tool call.
  hook('PreToolUse', npmTest);
  hook('PostToolUse', { ...npmTest, error: 'Exit code 1\n# fail 2', is_interrupt: false });
  assert.equal(action(), 'failing');
  hook('PreToolUse', npmTest);
  assert.equal(action(), 'test');
  // A pass ends the streak: one more failure isn't "again and again".
  hook('PostToolUse', { ...npmTest, tool_response: { stdout: '# tests 5\n# pass 5\n# fail 0', stderr: '' } });
  hook('PreToolUse', npmTest);
  hook('PostToolUse', { ...npmTest, error: 'Exit code 1' });
  assert.equal(action(), 'test');
  // A failing command that isn't a test run doesn't count.
  hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git push' }, error: 'Exit code 1' });
  assert.equal(action(), 'test');
  hook('Stop', {});
  assert.equal(workers.get(worker.id)?.status, 'done');
  assert.equal(action(), undefined);
});

test('a worker is stamped with when it started waiting on someone, afresh each time', async (t) => {
  const f = fixture();
  isolateAgentEnvironment(f, t);
  const oldLog = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    if (oldLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = oldLog;
    f.close();
  });
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  const worker = workers.spawn('desk-1', 'test', 'fix the login');
  assert.notEqual(typeof worker, 'string');
  if (typeof worker === 'string') return;
  const calls = await waitFor(f.read, (x) => x.some((r) => r.kind === 'droid' && r.args.includes('--settings')));
  const token = calls.find((r) => r.kind === 'droid' && r.args.includes('--settings'))!.env.hookToken!;
  const hook = (event: string, extra = {}) => workers.handleHook(worker.id, token, event, { session_id: 'waiting', hook_event_name: event, ...extra });
  hook('SessionStart', { source: 'startup' });
  hook('UserPromptSubmit', { prompt: 'fix the login' });
  assert.equal(workers.get(worker.id)?.status, 'working');
  assert.equal(workers.get(worker.id)?.waitingSince, undefined);
  const before = Date.now();
  hook('Notification', { notification_type: 'permission_prompt', message: 'Allow git push?' });
  assert.equal(workers.get(worker.id)?.status, 'needs_input');
  const asked = worker.waitingSince!;
  assert.ok(asked >= before && asked <= Date.now());
  await new Promise((resolve) => setTimeout(resolve, 5));
  hook('Stop', {});
  assert.equal(workers.get(worker.id)?.status, 'done');
  assert.ok(worker.waitingSince! > asked, 'finishing is a new wait');
});

/** A worker that stays running, and its hooks as `session` (or another session). */
async function liveWorker(t: { after(fn: () => void): void }, session: string) {
  const f = fixture();
  isolateAgentEnvironment(f, t);
  const oldLog = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    if (oldLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = oldLog;
    f.close();
  });
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  const worker = workers.spawn('desk-1', 'test', 'fix the login');
  if (typeof worker === 'string') throw new Error(worker);
  const token = (await waitFor(f.read, (x) => x.some((r) => r.kind === 'droid' && r.args.includes('--settings')))).find((r) => r.kind === 'droid')!.env.hookToken!;
  const hook = (event: string, extra: Record<string, unknown> = {}, from = session) => workers.handleHook(worker.id, token, event, { session_id: from, hook_event_name: event, ...extra });
  const status = () => workers.get(worker.id)?.status;
  return { workers, worker, hook, status };
}

test("a prompt answered in the terminal puts the worker back to work, and a cancelled one puts it at rest (droid's own hook order)", async (t) => {
  const { hook, status } = await liveWorker(t, 'answered');
  const execute = { tool_name: 'Execute', tool_input: { command: 'sleep 5 && echo done' } };
  hook('SessionStart', { source: 'startup' });
  // Approved: droid reports nothing more until the tool it asked about has run.
  hook('UserPromptSubmit', { prompt: 'run it' });
  hook('PreToolUse', execute);
  hook('Notification', { notification_type: 'permission_prompt', message: 'Factory CLI needs permission to execute 1 tool(s)' });
  assert.equal(status(), 'needs_input');
  hook('PostToolUse', { ...execute, tool_response: 'done' });
  assert.equal(status(), 'working');
  hook('Stop', {});
  assert.equal(status(), 'done');

  // A question through droid's AskUser tool, answered.
  hook('UserPromptSubmit', { prompt: 'ask me' });
  hook('PreToolUse', { tool_name: 'AskUser', tool_input: { questionnaire: '1. [question] red or blue?' } });
  assert.equal(status(), 'needs_input');
  hook('Notification', { notification_type: 'elicitation_dialog', message: 'Factory CLI is asking the user 1 question(s)' });
  assert.equal(status(), 'needs_input');
  hook('PostToolUse', { tool_name: 'AskUser', tool_response: '[answer] Red' });
  assert.equal(status(), 'working');

  // Esc while it thinks: droid sends idle_prompt instead of Stop, with or without a prompt up.
  hook('Notification', { notification_type: 'idle_prompt', message: 'Agent stopped by user and is waiting for input' });
  assert.equal(status(), 'done');
  hook('UserPromptSubmit', { prompt: 'run it again' });
  hook('PreToolUse', execute);
  hook('Notification', { notification_type: 'permission_prompt' });
  hook('Notification', { notification_type: 'idle_prompt' });
  assert.equal(status(), 'done');
  // An idle_prompt at rest stays at rest.
  hook('SessionStart', { source: 'startup' });
  hook('Notification', { notification_type: 'idle_prompt' });
  assert.equal(status(), 'idle');
});

test("a subagent's hooks don't take over its worker's session (droid's own hook order)", async (t) => {
  const { workers, worker, hook, status } = await liveWorker(t, 'lead-session');
  const sub = (event: string, extra: Record<string, unknown> = {}) => hook(event, extra, 'sub-session');
  const task = { tool_name: 'Task', tool_input: { subagent_type: 'worker', description: 'Run echo command' } };
  const execute = { tool_name: 'Execute', tool_input: { command: 'echo from-sub' } };
  assert.equal(hook('SessionStart', { source: 'startup' }), true);
  hook('UserPromptSubmit', { prompt: 'fix the login with a subagent' });
  hook('PreToolUse', task);
  // Another session nobody started is still turned away.
  assert.equal(sub('PreToolUse', execute), false);
  assert.equal(sub('SessionStart', { source: 'startup', calling_session_id: 'someone-else' }), false);
  assert.equal(sub('SessionStart', { source: 'startup', calling_session_id: 'lead-session' }), true);
  assert.equal(sub('SessionStart', { source: 'resume', calling_session_id: 'lead-session' }), true);
  assert.equal(sub('UserPromptSubmit', { prompt: '# Task Tool Invocation\n\nSubagent type: worker' }), true);
  assert.equal(workers.get(worker.id)?.sessionId, 'lead-session', 'the worker resumes its own session, not the subagent');
  assert.equal(status(), 'working');
  assert.doesNotMatch(workers.get(worker.id)?.activity ?? '', /Task Tool Invocation/);

  // Its permission prompt shows in the worker's terminal.
  assert.equal(sub('PreToolUse', execute), true);
  assert.equal(sub('Notification', { notification_type: 'permission_prompt', message: 'Factory CLI needs permission to execute 1 tool(s)' }), true);
  assert.equal(status(), 'needs_input');
  // The worker's own tools don't answer the subagent's prompt.
  hook('PostToolUse', { tool_name: 'Read' });
  assert.equal(status(), 'needs_input');
  sub('PostToolUse', { ...execute, tool_response: 'from-sub' });
  assert.equal(status(), 'working');

  // The subagent finishing is not the worker finishing.
  assert.equal(sub('Stop', {}), true);
  assert.equal(sub('Notification', { notification_type: 'idle_prompt' }), true);
  assert.equal(status(), 'working');
  assert.equal(hook('PostToolUse', { ...task, tool_response: 'session_id: sub-session' }), true);
  assert.equal(status(), 'working');
  assert.equal(hook('Stop', {}), true);
  assert.equal(status(), 'done');

  // A subagent asks, and returns before anyone sees a tool of its finish: the Task coming back answers it.
  hook('UserPromptSubmit', { prompt: 'again' });
  sub('SessionStart', { source: 'startup', calling_session_id: 'lead-session' });
  sub('PreToolUse', execute);
  sub('Notification', { notification_type: 'permission_prompt' });
  assert.equal(status(), 'needs_input');
  hook('PostToolUse', task);
  assert.equal(status(), 'working');

  // A new conversation (/clear) forgets the old one's subagents.
  hook('SessionStart', { source: 'clear' }, 'new-session');
  assert.equal(sub('PreToolUse', execute), false);
});

/** Types `text` into a worker's terminal, which echoes it back (the fake agent's tty is in cooked mode), and waits to see it. */
async function show(workers: WorkerManager, id: string, text: string) {
  workers.write(id, `${text}\r`);
  for (let i = 0; i < 200 && !workers.tail(id, 3)?.includes(text); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(workers.tail(id, 3)?.includes(text), `the terminal shows ${text}`);
}

test("a status the hooks left wrong follows the agent's screen once it has settled", async (t) => {
  const { workers, worker, hook, status } = await liveWorker(t, 'healed');
  hook('SessionStart', { source: 'startup' });
  hook('UserPromptSubmit', { prompt: 'fix the login' });
  assert.equal(status(), 'working');
  const start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const at = (ms: number) => {
    t.mock.timers.setTime(start + ms);
    workers.reconcile();
  };

  // Its Stop never came (the office was down longer than the hook retries): at rest on screen, and still.
  await show(workers, worker.id, '[⏱ 6s, context: 4%] ? for help');
  at(0);
  at(3000);
  assert.equal(status(), 'working', 'not before the screen has settled');
  at(4000);
  assert.equal(status(), 'done');

  // A message queued with Ctrl+Enter starts a turn with no UserPromptSubmit: busy on screen, spinner printing.
  await show(workers, worker.id, ' ⠋ Executing...  (Press ESC to stop)');
  at(5000);
  at(9000);
  assert.equal(status(), 'done', 'a spinner that stopped printing is no turn');
  await show(workers, worker.id, '[⏱ 9s, context: 4%]');
  at(9000);
  assert.equal(status(), 'working');

  // A permission prompt whose Notification never came.
  await show(workers, worker.id, '  ↑↓ navigate   Enter select   Esc cancel   Alt/Option+E to inspect approval details');
  at(10_000);
  at(14_000);
  assert.equal(status(), 'needs_input');
  assert.equal(workers.get(worker.id)?.activity, 'Waiting for input');

  // A hook that just came in is believed over the screen, until the screen has had time to catch up.
  t.mock.timers.setTime(start + 20_000);
  hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'a.ts' } });
  assert.equal(status(), 'working');
  at(22_000);
  assert.equal(status(), 'working');
  at(24_000);
  assert.equal(status(), 'needs_input');
});

/** Each worker launch so far (not the task namer's calls, nor what was typed into it), oldest first. */
const launchesOf = (f: Fixture) => f.read().filter((r) => r.kind === 'droid' && r.args.includes('--settings') && r.stdin === undefined);
/** What a launch was told to do: the prompt after `--`, if any. */
const promptOf = (r: Invocation) => (r.args.includes('--') ? r.args[r.args.indexOf('--') + 1] : undefined);

function carryOnFixture(t: { after(fn: () => void): void }) {
  const f = fixture();
  isolateAgentEnvironment(f, t);
  const oldLog = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    if (oldLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = oldLog;
    f.close();
  });
  return f;
}

/** Hires a worker and puts its session in `state`: mid-turn ('working', 'needs_input') or finished ('done'). */
async function hireInState(f: Fixture, workers: WorkerManager, deskId: string, session: string, state: 'working' | 'needs_input' | 'done') {
  const before = launchesOf(f).length;
  const worker = workers.spawn(deskId, 'test', `task for ${session}`);
  assert.notEqual(typeof worker, 'string');
  if (typeof worker === 'string') throw new Error(worker);
  const token = (
    await waitFor(
      () => launchesOf(f),
      (x) => x.length > before,
    )
  ).at(-1)?.env.hookToken as string;
  const hook = (event: string, extra: Record<string, unknown> = {}) => assert.equal(workers.handleHook(worker.id, token, event, { session_id: session, hook_event_name: event, ...extra }), true);
  hook('SessionStart', { source: 'startup' });
  hook('UserPromptSubmit', { prompt: `task for ${session}` });
  if (state === 'needs_input') hook('Notification', { notification_type: 'permission_prompt' });
  if (state === 'done') hook('Stop', {});
  assert.equal(workers.get(worker.id)?.status, state);
  return worker;
}

test('a restart that takes a mid-turn worker down resumes it with continue; a finished one just wakes up', async (t) => {
  const f = carryOnFixture(t);
  const before = manager(f, []);
  // Never started, so its terminals run in-process and go down with it.
  await hireInState(f, before, 'desk-1', 'mid-turn', 'working');
  await hireInState(f, before, 'desk-2', 'asking', 'needs_input');
  await hireInState(f, before, 'desk-3', 'finished', 'done');
  before.shutdown(true);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const after = manager(f, []);
  t.after(() => after.shutdown());
  await after.start();
  const resumed = (
    await waitFor(
      () => launchesOf(f),
      (x) => x.length >= 6,
    )
  ).slice(3);
  const of = (session: string) => resumed.find((r) => r.args.includes(session));
  for (const session of ['mid-turn', 'asking']) {
    assert.ok(of(session)?.args.includes('--resume'));
    assert.equal(promptOf(of(session) as Invocation), CARRY_ON_PROMPT);
  }
  assert.ok(of('finished')?.args.includes('--resume'));
  assert.equal(promptOf(of('finished') as Invocation), undefined);
});

test('a worker whose terminal outlives the office is picked back up mid-turn, not relaunched or told to continue', async (t) => {
  const f = carryOnFixture(t);
  const before = manager(f, []);
  await before.start();
  const worker = await hireInState(f, before, 'desk-1', 'kept', 'working');
  before.shutdown(true);

  const after = manager(f, []);
  t.after(() => after.shutdown());
  await after.start();
  assert.equal(after.get(worker.id)?.status, 'working');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(launchesOf(f).length, 1);
});

test('a worker whose terminal was in the host when an older office went down carries on if the host is gone', async (t) => {
  const f = carryOnFixture(t);
  // workers.json as the office before midTurn left it: only the host terminal's status says it was mid-turn.
  const saved = (id: string, deskId: string, sessionId: string, status: string) => ({
    id,
    kind: 'agent',
    deskId,
    name: id,
    sessionId,
    hookToken: `${id}-token`,
    pty: { id: `${id}-pty`, status, acked: true },
  });
  writeFileSync(path.join(f.data, 'workers.json'), JSON.stringify([saved('upgraded', 'desk-1', 'was-working', 'working'), saved('idle', 'desk-2', 'was-done', 'done')]));
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  await workers.start();
  const resumed = await waitFor(
    () => launchesOf(f),
    (x) => x.length >= 2,
  );
  assert.equal(promptOf(resumed.find((r) => r.args.includes('was-working')) as Invocation), CARRY_ON_PROMPT);
  assert.equal(promptOf(resumed.find((r) => r.args.includes('was-done')) as Invocation), undefined);
});

test('stopping the office on purpose (Ctrl+C) leaves nothing to carry on', async (t) => {
  const f = carryOnFixture(t);
  const before = manager(f, []);
  // Its terminals run in the host, which ends them without telling the office they exited.
  await before.start();
  await hireInState(f, before, 'desk-1', 'stopped', 'working');
  before.shutdown(false);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const after = manager(f, []);
  t.after(() => after.shutdown());
  await after.start();
  const resumed = (
    await waitFor(
      () => launchesOf(f),
      (x) => x.length >= 2,
    )
  )[1];
  assert.ok(resumed.args.includes('stopped'));
  assert.equal(promptOf(resumed), undefined);
});

test('a worktree worker that makes its own branch is followed there: O finds the PR it opened, and sending it home tidies both branches', async (t) => {
  const f = carryOnFixture(t);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  git(f.root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(f.root, 'a.txt'), 'a');
  git(f.root, 'add', 'a.txt');
  git(f.root, 'commit', '-qm', 'init');
  // GitHub has one open pull request, from the branch the worker is about to make.
  writeFileSync(path.join(path.dirname(f.droid), 'gh'), `#!/bin/sh\ncase "$*" in *"--head fix-x "*) echo '[{"number":242,"url":"https://github.com/o/r/pull/242"}]';; *) echo '[]';; esac\n`, { mode: 0o700 });
  const updates: WorkerInfo[] = [];
  const workers = manager(f, updates);
  t.after(() => workers.shutdown());
  const worker = workers.spawn('desk-1', 'test', 'fix x on a new branch and open a PR', true);
  assert.notEqual(typeof worker, 'string');
  if (typeof worker === 'string') return;
  const office = worker.worktree!.branch;
  assert.match(office, /^office\//);
  const token = (
    await waitFor(
      () => launchesOf(f),
      (x) => x.length > 0,
    )
  )[0].env.hookToken!;
  const hook = (event: string, extra: Record<string, unknown> = {}) => assert.equal(workers.handleHook(worker.id, token, event, { session_id: 'own-branch', hook_event_name: event, ...extra }), true);
  hook('SessionStart', { source: 'startup' });
  hook('UserPromptSubmit', { prompt: 'fix x on a new branch and open a PR' });
  // What the task told it to do: a branch of its own, a commit, a PR from there.
  const cwd = path.join(f.root, worker.worktree!.path);
  git(cwd, 'checkout', '-qb', 'fix-x');
  writeFileSync(path.join(cwd, 'x.txt'), 'x');
  git(cwd, 'add', 'x.txt');
  git(cwd, 'commit', '-qm', 'fix x');
  hook('Stop', {});
  const info = await waitFor(
    () => workers.get(worker.id)!,
    (w) => w.worktree?.branch === 'fix-x',
  );
  assert.equal(info.worktree!.made, office);
  assert.equal(updates.at(-1)?.worktree?.branch, 'fix-x');
  // Saved, for a restarted office and for `droid-office prune`.
  const saved = JSON.parse(readFileSync(path.join(f.data, 'workers.json'), 'utf8')) as WorkerInfo[];
  assert.deepEqual(saved.find((w) => w.id === worker.id)?.worktree, info.worktree);
  // O at the desk: the PR it opened, not "has no commits on office/… yet".
  const pr = await workers.openPr(worker.id, 'Cody');
  assert.deepEqual(pr, { prs: [{ number: 242, url: 'https://github.com/o/r/pull/242', existed: true, dirty: false }], failed: [] });
  assert.deepEqual(workers.get(worker.id)?.pr, { number: 242, url: 'https://github.com/o/r/pull/242' });
  // Sent home: the worktree goes, with its branch and the office's (which holds nothing fix-x lacks).
  const home = await workers.kill(worker.id, 'all');
  assert.equal(home.error, undefined);
  assert.equal(home.note, `Deleted ${worker.name}'s worktree and branch fix-x`);
  assert.equal(git(f.root, 'branch', '--list', 'fix-x', office), '');
  assert.ok(!existsSync(cwd));
  // One that checked out a branch from before it was hired leaves that branch be.
  execFileSync('git', ['branch', 'release'], { cwd: f.root, env: { ...process.env, GIT_COMMITTER_DATE: '@1000000000 +0000' } });
  const other = workers.spawn('desk-2', 'test', 'look at the release branch', true);
  assert.notEqual(typeof other, 'string');
  if (typeof other === 'string') return;
  git(path.join(f.root, other.worktree!.path), 'checkout', '-q', 'release');
  const left = await workers.kill(other.id, 'all');
  assert.equal(left.note, `Deleted ${other.name}'s worktree and branch ${other.worktree!.branch}`);
  assert.equal(git(f.root, 'branch', '--list', '--format=%(refname:short)', 'release', other.worktree!.branch), 'release');
});

test("the office's branch keeps a worker's commits once it has moved on: the dialog warns, and sending it home never deletes them", async (t) => {
  const f = carryOnFixture(t);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  git(f.root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(f.root, 'a.txt'), 'a');
  git(f.root, 'add', 'a.txt');
  git(f.root, 'commit', '-qm', 'init');
  execFileSync('git', ['branch', 'release'], { cwd: f.root, env: { ...process.env, GIT_COMMITTER_DATE: '@1000000000 +0000' } });
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  /** A worker that commits on the office's branch, then goes to another one. */
  const hire = (desk: string, ...checkout: string[]) => {
    const w = workers.spawn(desk, 'test', 'commit, then switch branches', true);
    if (typeof w === 'string') throw new Error(w);
    const cwd = path.join(f.root, w.worktree!.path);
    writeFileSync(path.join(cwd, `${desk}.txt`), desk);
    git(cwd, 'add', `${desk}.txt`);
    git(cwd, 'commit', '-qm', `work at ${desk}`);
    git(cwd, 'checkout', '-q', ...checkout);
    return { w, cwd, office: w.worktree!.branch };
  };
  const tip = (branch: string) => git(f.root, 'log', '-1', '--format=%s', branch);
  // Onto release, which was there before it: the commit is only on the office's branch.
  const a = hire('desk-1', 'release');
  assert.deepEqual(await workers.inspectWorktree(a.w.id), { exists: true, dirty: 0, ahead: 1, unpushed: 1 });
  assert.equal(workers.get(a.w.id)?.worktree?.made, a.office);
  // Deleting the worktree and branch anyway: release isn't the office's, and the office's has the commit.
  const sent = await workers.kill(a.w.id, 'all');
  assert.equal(sent.error, undefined);
  assert.equal(sent.note, `Deleted ${a.w.name}'s worktree and kept branch ${a.office} — it has 1 unpushed commit`);
  assert.ok(!existsSync(a.cwd));
  assert.equal(tip(a.office), 'work at desk-1');
  assert.equal(tip('release'), 'init');
  // Sent home with no choice (the queue recycling its desk, leave-on-merge): nothing goes.
  const b = hire('desk-2', 'release');
  assert.equal((await workers.kill(b.w.id)).note, `Kept ${b.w.name}'s worktree and branch release — it has 1 unpushed commit`);
  assert.ok(existsSync(b.cwd));
  assert.equal(tip(b.office), 'work at desk-2');
  // A branch of its own, cut from main without that commit: it goes, the office's stays.
  const c = hire('desk-3', '-b', 'fix-z', 'main');
  const own = await workers.kill(c.w.id, 'all');
  assert.equal(own.note, `Deleted ${c.w.name}'s worktree and branch fix-z, and kept branch ${c.office} — it has 1 unpushed commit`);
  assert.equal(git(f.root, 'branch', '--list', 'fix-z'), '');
  assert.equal(tip(c.office), 'work at desk-3');
});

test("a worker that renames the office's branch goes home with it; one that deletes it leaves the branch it's on", async (t) => {
  const f = carryOnFixture(t);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  git(f.root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(f.root, 'a.txt'), 'a');
  git(f.root, 'add', 'a.txt');
  git(f.root, 'commit', '-qm', 'init');
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  const hire = (desk: string) => {
    const w = workers.spawn(desk, 'test', 'fix x and name the branch after it', true);
    if (typeof w === 'string') throw new Error(w);
    return { w, cwd: path.join(f.root, w.worktree!.path), office: w.worktree!.branch };
  };
  const a = hire('desk-1');
  const token = (
    await waitFor(
      () => launchesOf(f),
      (x) => x.length > 0,
    )
  )[0].env.hookToken!;
  const hook = (event: string, extra: Record<string, unknown> = {}) => assert.equal(workers.handleHook(a.w.id, token, event, { session_id: 'renamed', hook_event_name: event, ...extra }), true);
  hook('SessionStart', { source: 'startup' });
  hook('UserPromptSubmit', { prompt: 'fix x and name the branch after it' });
  writeFileSync(path.join(a.cwd, 'x.txt'), 'x');
  git(a.cwd, 'add', 'x.txt');
  git(a.cwd, 'commit', '-qm', 'fix x');
  git(a.cwd, 'branch', '-m', 'fix-x');
  hook('Stop', {});
  // Followed there, with nothing to remember: office/… is gone, fix-x is it.
  const info = await waitFor(
    () => workers.get(a.w.id)!,
    (w) => w.worktree?.branch === 'fix-x',
  );
  assert.equal(info.worktree!.made, undefined);
  const sent = await workers.kill(a.w.id, 'all');
  assert.equal(sent.error, undefined);
  assert.equal(sent.note, `Deleted ${a.w.name}'s worktree and branch fix-x`);
  assert.equal(git(f.root, 'branch', '--list', 'fix-x', a.office), '');
  assert.ok(!existsSync(a.cwd));
  // Renamed with nothing unpushed (its PR merged, say) and sent home before it came to rest: all of it goes.
  const b = hire('desk-2');
  git(b.cwd, 'branch', '-m', 'fix-y');
  assert.deepEqual(await workers.kill(b.w.id), { note: `Deleted ${b.w.name}'s worktree and branch fix-y` });
  assert.equal(git(f.root, 'branch', '--list', 'fix-y', b.office), '');
  // The office's branch deleted instead: git can't say whether the one it's on is its own, so it stays.
  const c = hire('desk-3');
  git(c.cwd, 'checkout', '-qb', 'fix-w');
  git(c.cwd, 'branch', '-D', c.office);
  assert.deepEqual(await workers.kill(c.w.id, 'all'), { note: `Deleted ${c.w.name}'s worktree and kept branch fix-w` });
  assert.equal(git(f.root, 'branch', '--list', '--format=%(refname:short)', 'fix-w', c.office), 'fix-w');
  assert.ok(!existsSync(c.cwd));
});

test("only a branch the worker made is its own to delete, and the office's stays when it has commits that one doesn't", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-made-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'a.txt'), 'a');
  git('add', 'a.txt');
  git('commit', '-qm', 'init');
  // A branch that was there long before any worker (its reflog says it was made in 2001).
  execFileSync('git', ['branch', 'release'], { cwd: dir, env: { ...process.env, GIT_COMMITTER_DATE: '@1000000000 +0000' } });
  const trees = new Worktrees(dir);
  const made = trees.create('mochi-1234');
  assert.notEqual(typeof made, 'string');
  if (typeof made === 'string') return;
  const cwd = path.join(dir, made.path);
  const gitIn = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  // A commit on the office's branch, then a fresh branch from main that doesn't have it.
  writeFileSync(path.join(cwd, 'o.txt'), 'o');
  gitIn('add', 'o.txt');
  gitIn('commit', '-qm', 'on the office branch');
  gitIn('checkout', '-qb', 'fix-y', 'main');
  assert.equal(await trees.branchOf(made), 'fix-y');
  assert.equal(await trees.madeSince('fix-y', made.branch), true);
  assert.equal(await trees.madeSince('release', made.branch), false);
  assert.equal(await trees.madeSince('main', made.branch), false);
  assert.equal(await trees.remove({ ...made, branch: 'fix-y', made: made.branch }, 'all'), undefined);
  assert.equal(git('branch', '--list', 'fix-y'), '');
  assert.equal(git('branch', '--list', made.branch).replace(/^\*?\s+/, ''), made.branch);
});

test('a worker whose worktree was deleted outside the office waits, marked lost, instead of failing to start; rebuilding puts it back and it carries on', async (t) => {
  const f = carryOnFixture(t);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
  git(f.root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(f.root, 'a.txt'), 'a');
  git(f.root, 'add', 'a.txt');
  git(f.root, 'commit', '-qm', 'init');
  const officeWith = (updates: WorkerInfo[], toasts: string[]) => new WorkerManager(f.root, f.data, f.droid, ['--from-test'], { url: 'http://127.0.0.1:1', token: '' }, { ...events(updates), toast: (text) => toasts.push(text) });
  const before = officeWith([], []);
  const hire = async (deskId: string, session: string) => {
    const n = launchesOf(f).length;
    const w = before.spawn(deskId, 'test', `task for ${session}`, true);
    assert.notEqual(typeof w, 'string');
    if (typeof w === 'string') throw new Error(w);
    const token = (
      await waitFor(
        () => launchesOf(f),
        (x) => x.length > n,
      )
    ).at(-1)!.env.hookToken!;
    assert.equal(before.handleHook(w.id, token, 'SessionStart', { session_id: session, hook_event_name: 'SessionStart' }), true);
    return w;
  };
  const kept = await hire('desk-1', 'kept-branch');
  const gone = await hire('desk-2', 'gone-branch');
  // Kept did some work on its branch; gone's branch goes with its folder.
  const keptDir = path.join(f.root, kept.worktree!.path);
  writeFileSync(path.join(keptDir, 'work.txt'), 'work');
  git(keptDir, 'add', 'work.txt');
  git(keptDir, 'commit', '-qm', 'work');
  before.shutdown(true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Deleted while the office was down, by hand.
  rmSync(keptDir, { recursive: true, force: true });
  rmSync(path.join(f.root, gone.worktree!.path), { recursive: true, force: true });
  git(f.root, 'worktree', 'prune');
  git(f.root, 'branch', '-D', gone.worktree!.branch);

  const updates: WorkerInfo[] = [];
  const toasts: string[] = [];
  const after = officeWith(updates, toasts);
  t.after(() => after.shutdown());
  const launched = launchesOf(f).length;
  await after.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Nobody started, nobody was told "could not start": both wait at their desks, marked lost.
  assert.equal(launchesOf(f).length, launched);
  assert.deepEqual(toasts, []);
  assert.deepEqual(after.get(kept.id)?.lost, { branch: 'here' });
  assert.deepEqual(after.get(gone.id)?.lost, { branch: 'gone' });
  assert.equal(after.get(kept.id)?.status, 'offline');
  assert.match(after.resume(kept.id) ?? '', /worktree .* was deleted outside droid-office/);
  assert.equal(launchesOf(f).length, launched);

  // Put back on its own branch, work and all, and it carries on its conversation.
  assert.deepEqual(await after.rebuild(kept.id), { rebuilt: true, note: undefined });
  assert.equal(git(keptDir, 'rev-parse', '--abbrev-ref', 'HEAD'), kept.worktree!.branch);
  assert.ok(existsSync(path.join(keptDir, 'work.txt')));
  assert.equal(after.get(kept.id)?.lost, undefined);
  const resumed = await waitFor(
    () => launchesOf(f).slice(launched),
    (x) => x.length > 0,
  );
  assert.ok(resumed[0].args.includes('--resume') && resumed[0].args.includes('kept-branch'));

  // Its branch gone too: made again from where it started.
  const again = await after.rebuild(gone.id);
  assert.equal(again.rebuilt, true);
  assert.match(again.note ?? '', /was deleted too/);
  assert.equal(git(path.join(f.root, gone.worktree!.path), 'rev-parse', 'HEAD'), gone.worktree!.base);
  assert.equal(after.get(gone.id)?.lost, undefined);
  assert.deepEqual(toasts, []);
});

test('two connections share one terminal: closing one leaves the other subscribed, open and streaming', async (t) => {
  const f = carryOnFixture(t);
  const updates: WorkerInfo[] = [];
  const streamed: { workerId: string; data: string; to: string[] }[] = [];
  const workers = new WorkerManager(f.root, f.data, f.droid, ['--from-test'], { url: 'http://127.0.0.1:1', token: '' }, { ...events(updates), data: (workerId, data, to) => streamed.push({ workerId, data, to }) });
  t.after(() => workers.shutdown());
  const spawned = workers.spawn('desk-1', 'test', 'share this terminal');
  assert.notEqual(typeof spawned, 'string');
  if (typeof spawned === 'string') throw new Error(spawned);
  const id = spawned.id;
  assert.equal(workers.get(id)?.open, false);

  const a = workers.attach(id, 'conn-a');
  assert.ok(a);
  assert.equal(workers.get(id)?.open, true);
  assert.ok(workers.attach(id, 'conn-b'));
  // The fake agent announces itself; both connections stream it.
  const first = await waitFor(
    () => streamed,
    (x) => x.some((s) => s.data.includes('fake-agent-ready')),
  );
  assert.deepEqual(first.find((s) => s.data.includes('fake-agent-ready'))?.to, ['conn-a', 'conn-b']);

  // One window closes: the other keeps the terminal open and streaming.
  workers.detach(id, 'conn-a');
  assert.equal(workers.get(id)?.open, true);
  workers.write(id, 'echo still-here\r');
  const second = await waitFor(
    () => streamed,
    (x) => x.some((s) => s.data.includes('still-here')),
  );
  assert.deepEqual(
    second.filter((s) => s.data.includes('still-here')).map((s) => s.to),
    [['conn-b']],
  );
  // The echo is the PTY's; the agent logs the keystrokes on its own time, before teardown takes its log away.
  await waitFor(
    () =>
      f
        .read()
        .map((inv) => inv.stdin ?? '')
        .join(''),
    (x) => x.includes('still-here'),
  );

  // The last one out closes it; detaching a stranger changes nothing.
  workers.detach(id, 'conn-b');
  assert.equal(workers.get(id)?.open, false);
  const n = updates.length;
  workers.detach(id, 'conn-a');
  assert.equal(updates.length, n);

  // Gone for good: no subscriber entry is left behind.
  workers.attach(id, 'conn-a');
  await workers.kill(id);
  assert.equal((workers as unknown as { subscribers: Map<string, Set<string>> }).subscribers.has(id), false);
  assert.equal(workers.attach(id, 'conn-a'), undefined);
});

test('opening a finished terminal acknowledges its wait; answering a question takes input', async (t) => {
  const f = carryOnFixture(t);
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  const done = await hireInState(f, workers, 'desk-1', 'finished-session', 'done');
  assert.equal(workers.get(done.id)?.acked, false);
  assert.equal(workers.get(done.id)?.open, false);
  const waiting = workers.get(done.id)?.waitingSince;
  workers.attach(done.id, 'conn-a');
  assert.equal(workers.get(done.id)?.acked, true);
  assert.equal(workers.get(done.id)?.waitingSince, waiting);
  assert.equal(workers.get(done.id)?.open, true);
  workers.detach(done.id, 'conn-a');

  const asking = await hireInState(f, workers, 'desk-2', 'asking-session', 'needs_input');
  assert.equal(workers.get(asking.id)?.acked, false);
  workers.attach(asking.id, 'conn-a');
  assert.equal(workers.get(asking.id)?.acked, false, 'opening a question does not answer it');
  workers.write(asking.id, 'yes\r');
  assert.equal(workers.get(asking.id)?.acked, true);
  assert.ok(typeof workers.get(asking.id)?.lastInputAt === 'number');
  // The agent answers on its own time: let it log the keystrokes before teardown takes its log away.
  await waitFor(
    () =>
      f
        .read()
        .map((inv) => inv.stdin ?? '')
        .join(''),
    (x) => x.includes('yes'),
  );
});

test('a worker restored from before subscriptions keeps its names, maps its last input time, and starts unopened', async (t) => {
  const f = carryOnFixture(t);
  writeFileSync(
    path.join(f.data, 'workers.json'),
    JSON.stringify([
      {
        id: 'legacy-1',
        kind: 'agent',
        deskId: 'desk-1',
        name: 'Legacy',
        color: '#fff',
        createdBy: 'Old Teammate',
        createdAt: 1000,
        viewers: ['Old Teammate'],
        viewerIds: ['ghost-connection'],
        lastInput: { by: 'Old Teammate', at: 4242 },
      },
      {
        id: 'legacy-2',
        kind: 'agent',
        deskId: 'desk-2',
        name: 'Legacy Two',
        color: '#fff',
        createdBy: 'Old Teammate',
        createdAt: 1000,
        lastInput: { by: 'Old Teammate' },
      },
    ]),
  );
  const workers = manager(f, []);
  t.after(() => workers.shutdown());
  const info = workers.get('legacy-1');
  assert.ok(info);
  assert.equal(info.createdBy, 'Old Teammate');
  assert.equal(info.lastInputAt, 4242);
  assert.equal(info.open, false);
  assert.equal(workers.get('legacy-2')?.lastInputAt, undefined);
  // Subscriptions start empty: no ghost streams, and detaching the ghost changes nothing.
  assert.deepEqual([...(workers as unknown as { subscribers: Map<string, Set<string>> }).subscribers.keys()], []);
  workers.detachAll('ghost-connection');
  assert.equal(workers.get('legacy-1')?.open, false);
  // Still visible and actionable: it opens, closes, and gets back to work.
  assert.ok(workers.attach('legacy-1', 'conn-a'));
  assert.equal(workers.get('legacy-1')?.open, true);
  workers.detachAll('conn-a');
  assert.equal(workers.get('legacy-1')?.open, false);
  assert.equal(workers.resume('legacy-1'), undefined);
  await waitFor(
    () => launchesOf(f),
    (x) => x.length > 0,
  );
});

test('a subagent sits down told who hired it and where it works; every agent gets office-workers, and its lead goes on record', async (t) => {
  const f = carryOnFixture(t);
  const workers = manager(f, [], []);
  t.after(() => workers.shutdown());
  const bin = path.join(f.data, 'bin', 'team');
  const launches = (id: string) => launchesOf(f).filter((r) => r.env.workerId === id);

  // The command is there, and runs the shipped script with the office's own node.
  accessSync(path.join(bin, 'office-workers'), constants.X_OK);
  assert.match(execFileSync(path.join(bin, 'office-workers'), ['--help'], { encoding: 'utf8' }), /office-workers hire --title/);

  const lead = workers.spawn('desk-1', 'Ada', 'Ship the login fix');
  assert.ok(typeof lead === 'object');
  if (typeof lead !== 'object') return;
  assert.equal(lead.lead, undefined);
  assert.match(workers.spawn('desk-3', lead.name, 'x', false, 'agent', undefined, undefined, undefined, [], 'nobody') as string, /lead has left/);
  assert.match(workers.spawn('desk-3', lead.name, 'x', false, 'shell', undefined, undefined, undefined, [], lead.id) as string, /an agent at a desk/);
  assert.match(workers.spawn('station-lead', lead.name, 'x', false, 'agent', undefined, undefined, undefined, [], lead.id) as string, /an agent at a desk/);

  const sub = workers.spawn('desk-3', lead.name, 'Fix the redirect', false, 'agent', undefined, undefined, undefined, [], lead.id);
  assert.ok(typeof sub === 'object');
  if (typeof sub !== 'object') return;
  assert.equal(sub.lead, lead.id);
  assert.equal(sub.prompt, 'Fix the redirect', 'its card shows the task alone');
  assert.match(workers.spawn('desk-4', sub.name, 'x', false, 'agent', undefined, undefined, undefined, [], sub.id) as string, /can't hire subagents of its own/);

  const [leadLaunch] = await waitFor(
    () => launches(lead.id),
    (l) => l.length === 1,
  );
  const [subLaunch] = await waitFor(
    () => launches(sub.id),
    (l) => l.length === 1,
  );
  assert.equal(promptOf(leadLaunch), 'Ship the login fix', 'a worker nobody hired is told nothing extra');
  const brief = promptOf(subLaunch) ?? '';
  assert.match(brief, new RegExp(`^You're ${sub.name}, a subagent in Droid Office.*${lead.name} hired you`));
  assert.match(brief, /the project's main checkout/);
  assert.match(brief, /office-workers report <<'EOF'/);
  assert.ok(brief.endsWith('Your task:\n\nFix the redirect'));
  for (const r of [leadLaunch, subLaunch]) assert.ok((r.env.path ?? '').split(path.delimiter).includes(bin), 'office-workers is on every agent’s PATH');
  assert.equal((leadLaunch.env.path ?? '').split(path.delimiter).includes(path.join(f.data, 'bin')), false, 'office-queue stays with the board agents');

  // What its lead reads of it: the end of its terminal, as text.
  await waitFor(
    () => workers.tail(sub.id, 20),
    (s) => !!s?.includes('fake-agent-ready'),
  );
  assert.equal(workers.tail('nobody', 20), undefined);
  // Its lead's title goes on its card.
  workers.setTask(sub.id, { name: `  ${'Fix login '.repeat(10)}`, summary: 'Fix the redirect' });
  assert.equal(workers.get(sub.id)?.task?.name.length, 60);

  // The lead survives a restart; a subagent of a lead that's gone has none.
  workers.shutdown(true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const saved = JSON.parse(readFileSync(path.join(f.data, 'workers.json'), 'utf8')) as WorkerInfo[];
  assert.equal(saved.find((w) => w.id === sub.id)?.lead, lead.id);
  writeFileSync(path.join(f.data, 'workers.json'), JSON.stringify([...saved, { ...saved.find((w) => w.id === sub.id), id: 'orphan', deskId: 'desk-6', name: 'Orphan', lead: 'gone' }]));
  const after = manager(f, [], []);
  t.after(() => after.shutdown());
  assert.equal(after.get(sub.id)?.lead, lead.id);
  assert.equal(after.get('orphan')?.lead, undefined);
  assert.equal(after.get(sub.id)?.task?.name.length, 60);

  // Sending the lead home leaves its subagents at their desks, on their own.
  await after.kill(lead.id);
  assert.equal(after.get(sub.id)?.lead, undefined);
});

/** Everything the agent has read from its terminal so far: a pty hands it over a line at a time. */
const typed = (records: Invocation[]) => records.map((r) => r.stdin ?? '').join('');

const PICTURE = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);

test('pictures staged for a prompt are listed, numbered, after a new worker’s first prompt and after later ones', async (t) => {
  const f = fixture();
  const updates: WorkerInfo[] = [];
  isolateAgentEnvironment(f, t);
  const previousLog = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    if (previousLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = previousLog;
    f.close();
  });
  const workers = manager(f, updates);
  t.after(() => workers.shutdown());
  const launches = () => f.read().filter((r) => r.kind === 'droid' && r.args.includes('--settings') && r.stdin === undefined);

  assert.equal(workers.stageImage('notes.png', Buffer.from('not a picture')), undefined);
  const [a, b] = [workers.stageImage('first.png', PICTURE)!, workers.stageImage('second.png', PICTURE)!];
  assert.ok(a && b);

  // Hired with a prompt and two pictures: its card shows the prompt alone, the agent is given the list too.
  const hired = workers.spawn('desk-2', 'test', 'What is wrong here?', false, 'agent', undefined, undefined, undefined, [], undefined, [a, b]);
  assert.equal(typeof hired, 'object');
  if (typeof hired === 'string') return;
  assert.equal(hired.prompt, 'What is wrong here?');
  const drops = path.join(f.data, 'drops', hired.id);
  const [first] = await waitFor(launches, (l) => l.length === 1);
  const given = first.args.at(-1)!;
  assert.match(given, new RegExp(`^What is wrong here\\?\\n\\nImage 1: ${drops.replace(/[\\/^$.*+?()[\]{}|]/g, '\\$&')}[\\\\/][0-9a-f]{8}-first\\.png\\nImage 2: .*[0-9a-f]{8}-second\\.png$`));
  assert.deepEqual(readFileSync(given.match(/Image 1: (.*)/)![1]), PICTURE);

  // Later prompts: the pictures go in the same bracketed paste, so they're one message.
  const c = workers.stageImage('third.png', PICTURE)!;
  assert.equal(workers.prompt(hired.id, 'And this one?', [c]), undefined);
  await waitFor(
    () => f.read(),
    (records) => typed(records).includes('And this one?\n\nImage 1: '),
  );
  // Pictures alone are a prompt, and the card says so.
  const d = workers.stageImage('fourth.png', PICTURE)!;
  assert.equal(workers.prompt(hired.id, '  ', [d]), undefined);
  assert.equal(workers.get(hired.id)?.activity, 'See the attached images');
  await waitFor(
    () => f.read(),
    (records) => typed(records).includes('\x1b[200~Image 1: '),
  );
  assert.equal(workers.prompt(hired.id, '  ', []), 'Empty prompt');
  assert.equal(workers.prompt(hired.id, '  ', ['ffffffffffffffff']), 'Empty prompt');

  // The pictures go when the worker does; the staged originals when they're thrown away.
  workers.unstage([a, b, c, d]);
  assert.deepEqual(workers.stageImage('x.png', PICTURE)?.length, 16);
  await workers.kill(hired.id);
  assert.ok(!existsSync(drops));
});

test('a picture-only first prompt hires a worker with the list as its prompt', async (t) => {
  const f = fixture();
  const updates: WorkerInfo[] = [];
  isolateAgentEnvironment(f, t);
  const previousLog = process.env.FAKE_AGENT_LOG;
  process.env.FAKE_AGENT_LOG = f.log;
  t.after(() => {
    if (previousLog === undefined) delete process.env.FAKE_AGENT_LOG;
    else process.env.FAKE_AGENT_LOG = previousLog;
    f.close();
  });
  const workers = manager(f, updates);
  t.after(() => workers.shutdown());
  const a = workers.stageImage('shot.png', PICTURE)!;
  const hired = workers.station('station-issues', 'Ada', '', undefined, undefined, [a]);
  assert.equal(typeof hired, 'object');
  if (typeof hired === 'string') return;
  assert.equal(hired.info.prompt, 'See the attached images');
  const [first] = await waitFor(
    () => f.read().filter((r) => r.kind === 'droid' && r.args.includes('--settings') && r.stdin === undefined),
    (l) => l.length === 1,
  );
  assert.match(first.args.at(-1)!, /\n\nImage 1: .*[0-9a-f]{8}-shot\.png$/);
  assert.equal(workers.station('station-issues', 'Ada', '', undefined, undefined, []), 'Empty prompt');
});
