import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Answers } from '../src/server/answers.js';
import { webhookWorkerFromMember } from '../src/server/grok-webhook.js';
import { createOfficeMcp, OFFICE_MCP_PATH, OFFICE_MCP_WORKER_HEADER, type OfficeMcpFloor } from '../src/server/office-mcp/index.js';
import type { roster, OwnerOffice } from '../src/server/office-mcp/owner.js';
import { RemoteOffice } from '../src/server/remote-office.js';
import { RemoteWorkers } from '../src/server/remote-workers.js';
import { Team, type TeamOptions, type TeamWorkers } from '../src/server/team.js';
import { Visits } from '../src/server/visits.js';
import { WhiteboardStore } from '../src/server/whiteboard.js';
import { WorkerLabels } from '../src/server/worker-labels.js';
import {
  buildWorkerInspection,
  describeTaskLabel,
  formatForgeLines,
  formatProviderQuotas,
  formatTaskTag,
  formatWorkerInspection,
  inspectModelStatus,
  inspectTerminalRetry,
  inspectWorkerForge,
  summarizeProviderQuotas,
  type WorkerRuntimeSnapshot,
} from '../src/server/worker-status.js';
import { WorkerManager } from '../src/server/workers.js';
import { ORCHESTRATOR_ID } from '../src/shared/mission-control.js';
import type { PipelinesState } from '../src/shared/pipelines.js';
import { SUBAGENT_DEFAULTS, type GhPull, type SubagentSettings, type WorkerInfo } from '../src/shared/protocol.js';
import type { ModelAvailability, ModelUsage } from '../src/shared/subscriptions.js';
import { todoItems } from '../src/shared/todos.js';

const SOL = 'custom:droidproxy:gpt-6.1-sol';
const OPUS = 'custom:droidproxy:opus-5-5';
const GROK = 'custom:droidproxy:grok-4.7';
const NOW = Date.parse('2026-04-17T22:00:00.000Z');

function makeWorker(id: string, extra: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    id,
    name: id,
    kind: 'agent',
    deskId: 'desk-1',
    color: '#ee6018',
    status: 'working',
    acked: false,
    createdBy: 'test',
    createdAt: NOW - 120_000,
    cols: 100,
    rows: 30,
    open: false,
    ...extra,
  };
}

test('todoItems parses PreToolUse numbered lists and PostToolUse structured arrays cleanly', () => {
  const fromString = todoItems({
    todos: ['1. [completed] Inspect subscriptions control API', '2. [in_progress] Wire worker-status into office_look and team_status', `3. [pending] ${'x'.repeat(250)}`].join('\n'),
  });
  assert.deepEqual(fromString, [
    { status: 'completed', content: 'Inspect subscriptions control API' },
    { status: 'in_progress', content: 'Wire worker-status into office_look and team_status' },
    { status: 'pending', content: `${'x'.repeat(199)}…` },
  ]);

  const fromArray = todoItems({
    todos: [
      { status: 'completed', content: '  Done step  ' },
      { status: 'completed', content: '   ' },
      { status: 'in_progress', content: 'Running step' },
      { status: 'unknown', content: 'Defaults to pending' },
    ],
  });
  assert.deepEqual(fromArray, [
    { status: 'completed', content: 'Done step' },
    { status: 'in_progress', content: 'Running step' },
    { status: 'pending', content: 'Defaults to pending' },
  ]);
  assert.deepEqual(todoItems({}), []);
});

test('terminal retry and model cooldown helpers distinguish real 429 cooldowns from tool output and thinking', () => {
  // Active retry banner in Droid TUI when no tool is running.
  const retry = inspectTerminalRetry(['Thinking...', 'Retrying the model request (attempt 3/5)...', '─────────────────'], 'working', false);
  assert.deepEqual(retry, {
    retrying: true,
    attempt: 3,
    maxAttempts: 5,
    detail: 'Retrying the model request (attempt 3/5)...',
  });

  // Ignored when a tool is currently executing (e.g. grepping source files that contain the phrase).
  assert.equal(inspectTerminalRetry(['Retrying the model request (attempt 2)...'], 'working', true), undefined);
  assert.equal(inspectTerminalRetry(['Retrying the model request (attempt 2)...'], 'done', false), undefined);

  // Proxy 429 model_cooldown payload & exhausted terminal banners.
  const proxyCooldown = inspectTerminalRetry(['{"error":{"code":"model_cooldown","message":"All credentials for model gpt-6.1-sol are cooling down","reset_time":"57m26s"}}'], 'working', false);
  assert.equal(proxyCooldown?.retrying, false);
  assert.match(proxyCooldown!.detail, /cooling down/i);

  const terminalExhausted = inspectTerminalRetry(['Usage is exhausted for the model request.'], 'done', false);
  assert.equal(terminalExhausted?.retrying, false);
  assert.match(terminalExhausted!.detail, /Usage is exhausted for the model request/);

  const resetAt = NOW + 57 * 60_000;
  const exhaustedAvail: ModelAvailability = { state: 'exhausted', until: resetAt, window: '5-hour' };
  const usage: ModelUsage = {
    provider: 'codex',
    accounts: 1,
    windows: [
      { name: '5-hour', leftPercent: 0, resetsAt: resetAt },
      { name: 'Weekly', leftPercent: 64, resetsAt: NOW + 48 * 3_600_000 },
    ],
    updatedAt: NOW - 30_000,
    at: NOW,
  };

  const cooldown = inspectModelStatus(SOL, exhaustedAvail, usage, NOW, retry);
  assert.equal(cooldown?.state, 'cooldown');
  assert.equal(cooldown?.provider, 'codex');
  assert.equal(cooldown?.window, '5-hour');
  assert.equal(cooldown?.resetsAt, new Date(resetAt).toISOString());
  assert.equal(cooldown?.remainingMs, 57 * 60_000);
  assert.match(cooldown!.summary, /Out of quota on 5-hour/);
  assert.match(cooldown!.summary, /resets in 57 min/);

  // Fallback when usage window hit 0% before /models flipped to exhausted.
  const usageCooldown = inspectModelStatus(SOL, { state: 'ok' }, usage, NOW, retry);
  assert.equal(usageCooldown?.state, 'cooldown');
  assert.equal(usageCooldown?.resetsAt, new Date(resetAt).toISOString());

  // Signed-out subscription provider surfaces signed-out.
  const signedOut = inspectModelStatus(OPUS, { state: 'signed-out', provider: 'claude' }, undefined, NOW, undefined);
  assert.equal(signedOut?.state, 'signed-out');

  // Retrying when subscription still reports quota left surfaces retrying with quota context.
  const healthyUsage: ModelUsage = {
    provider: 'codex',
    accounts: 2,
    windows: [{ name: '5-hour', leftPercent: 82, resetsAt: resetAt }],
    updatedAt: NOW - 10_000,
    at: NOW,
  };
  const transientRetry = inspectModelStatus(SOL, { state: 'ok' }, healthyUsage, NOW, retry);
  assert.equal(transientRetry?.state, 'retrying');
  assert.match(transientRetry!.summary, /Retrying the model request \(attempt 3\/5\)/);
  assert.match(transientRetry!.summary, /ChatGPT.*5-hour 82% left/);
});

test('inspectWorkerForge correlates cached PR checks, branch CI jobs, and post-merge Release runs without subprocess calls', () => {
  const mergeSha = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  const w = makeWorker('sprocket', {
    worktree: { path: '.droid-office/worktrees/sprocket', branch: 'office/sprocket', base: '0000000' },
    pr: { number: 426, url: 'https://github.com/nikships/droid-office/pull/426' },
  });
  const pulls: GhPull[] = [
    {
      number: 426,
      title: 'feat: structured worker status and model cooldowns',
      state: 'MERGED',
      isDraft: false,
      author: 'nik',
      labels: [],
      headRefName: 'office/sprocket',
      headRefOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      baseRefName: 'main',
      createdAt: '2026-04-17T21:45:00.000Z',
      updatedAt: '2026-04-17T21:58:00.000Z',
      additions: 320,
      deletions: 18,
      reviewDecision: 'APPROVED',
      checks: 'pass',
      body: '',
      closes: [],
      url: 'https://github.com/nikships/droid-office/pull/426',
    },
  ];
  const pipelines: PipelinesState = {
    available: true,
    checkedAt: NOW,
    runs: [
      {
        id: 1001,
        number: 88,
        workflow: 'Release',
        title: 'PR check',
        state: 'success',
        status: 'completed',
        branch: 'office/sprocket',
        sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        event: 'pull_request',
        url: 'https://github.com/nikships/droid-office/actions/runs/1001',
        createdAt: '2026-04-17T21:50:00.000Z',
        updatedAt: '2026-04-17T21:55:00.000Z',
        jobs: { total: 4, done: 4, failed: 0 },
      },
      {
        id: 1002,
        number: 89,
        workflow: 'Release',
        title: 'feat: structured worker status (#426)',
        state: 'running',
        status: 'in_progress',
        branch: 'main',
        sha: mergeSha,
        event: 'push',
        url: 'https://github.com/nikships/droid-office/actions/runs/1002',
        createdAt: '2026-04-17T21:58:10.000Z',
        updatedAt: '2026-04-17T21:59:30.000Z',
        jobs: { total: 5, done: 2, failed: 0, current: 'Package Mac app' },
      },
    ],
    workflows: [],
  };

  const forge = inspectWorkerForge(w, pulls, pipelines, { mergeCommit: mergeSha });
  assert.equal(forge?.pr?.state, 'merged');
  assert.equal(forge?.ci?.number, 88);
  assert.equal(forge?.releaseRun?.number, 89);
  assert.equal(forge?.releaseRun?.state, 'running');

  const lines = formatForgeLines({ pr: forge?.pr, ci: forge?.ci, releaseRun: forge?.releaseRun });
  assert.match(lines.join('\n'), /PR #426 \(merged\)/);
  assert.match(lines.join('\n'), /CI: Release #88 success \(4\/4 jobs\) on office\/sprocket/);
  assert.match(lines.join('\n'), /Post-merge CI: Release #89 running \(2\/5 jobs\) on main/);
});

test('WorkerManager tracks TodoWrite steps and current/last tool spans and persists generated label updatedAt', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'worker-runtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, '.droid-office');
  mkdirSync(dataDir, { recursive: true });

  // Verify WorkerLabels stamps updatedAt and WorkerManager persists & restores it.
  let generatedTask: WorkerInfo['task'];
  const labels = new WorkerLabels({
    settings: () => ({ on: true, implementation: 'droid', model: 'glm-5.3-flash', effort: 'low', intervalSec: 60, scriptCommand: '', scriptArgs: [] }),
    workers: () => [
      {
        id: 'f:w1',
        sessionId: 's1',
        cwd: dir,
        epoch: 1,
        since: 1,
        status: 'done',
        task: generatedTask,
        apply: (next) => {
          generatedTask = next;
        },
      },
    ],
    read: () => 'User: Ship structured worker status\nAssistant: Working on worker-status.ts',
    generate: async () => ({ name: 'Worker Status', summary: 'Shipping structured MCP telemetry' }),
    changed: () => {},
    now: () => NOW,
  });
  t.after(() => labels.stop());

  await labels.tick();
  for (let i = 0; i < 40 && !generatedTask; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(generatedTask?.generated, true);
  assert.equal(generatedTask?.updatedAt, NOW);

  // Seed saved workers.json with generatedTask + updatedAt and verify WorkerManager restores updatedAt.
  writeFileSync(
    path.join(dataDir, 'workers.json'),
    JSON.stringify([
      {
        id: 'w1',
        name: 'Sprocket',
        kind: 'agent',
        deskId: 'desk-1',
        color: '#ee6018',
        createdBy: 'nik',
        createdAt: NOW - 60_000,
        sessionId: 's1',
        task: generatedTask,
      },
    ]),
  );
  const restored = new WorkerManager(dir, dataDir, process.execPath, ['-e', ''], { url: 'http://127.0.0.1:0', token: 'tok' }, { update: () => {}, remove: () => {}, termData: () => {}, toast: () => {} });
  t.after(() => restored.shutdown(false));
  const w = restored.get('w1')!;
  assert.equal(w.task?.generated, true);
  assert.equal(w.task?.updatedAt, NOW);

  const descOn = describeTaskLabel(w, true);
  assert.deepEqual(descOn, { source: 'generated', generated: true, updatedAt: new Date(NOW).toISOString() });
  assert.equal(formatTaskTag(descOn), ` [generated label, updated ${new Date(NOW).toISOString()}]`);

  const descOff = describeTaskLabel(w, false);
  assert.deepEqual(descOff, { source: 'generated', generated: true, updatedAt: new Date(NOW).toISOString(), stale: true });
  assert.equal(formatTaskTag(descOff), ` [generated label, stale (worker labels off), updated ${new Date(NOW).toISOString()}]`);
});

test('MCP end-to-end: office_look, worker_log, team_status, office_roster, team_models, and webhook isolation', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'worker-status-mcp-'));
  const settings: SubagentSettings = { ...SUBAGENT_DEFAULTS, wakeLead: false };
  const resetAt = NOW + 42 * 60_000;
  let labelsOn = true;
  let recheckCalls = 0;
  let solExhausted = false;

  const lead = makeWorker('lead', { name: 'Nibble', status: 'idle', deskId: 'desk-1' });
  const sub = makeWorker('sub1', {
    name: 'Sprocket',
    lead: 'lead',
    deskId: 'desk-2',
    status: 'working',
    model: SOL,
    effort: 'high',
    activity: 'Model thinking…',
    todos: { done: 2, total: 4, current: 'Wire office_look structured header' },
    task: { name: 'Worker Status', summary: 'Surface cooldowns and plan steps', generated: true, updatedAt: NOW - 30_000 },
    worktree: { path: '.droid-office/worktrees/sub1', branch: 'office/sub1', base: 'abc1234', from: 'main' },
    pr: { number: 427, url: 'https://github.com/nikships/droid-office/pull/427' },
  });
  const assignedSub = makeWorker('sub2', {
    name: 'Widget',
    lead: 'lead',
    deskId: 'desk-3',
    status: 'working',
    model: 'claude-opus-5-5',
    effort: 'high',
    activity: 'Editing src/server/team.ts',
    task: { name: 'Fix MCP edges', summary: 'Clean up error codes' },
  });
  const standalone = makeWorker('solo', {
    name: 'Pixel',
    deskId: 'desk-4',
    status: 'idle',
    model: 'claude-opus-5-5',
    task: { name: 'Audit docs', summary: 'Check guide links' },
  });

  const people = new Map<string, WorkerInfo>([
    [lead.id, lead],
    [sub.id, sub],
    [assignedSub.id, assignedSub],
    [standalone.id, standalone],
  ]);

  const runtimes = new Map<string, WorkerRuntimeSnapshot>([
    [
      sub.id,
      {
        todoSteps: [
          { status: 'completed', content: 'Inspect DroidProxy control API' },
          { status: 'completed', content: 'Add todoItems helper' },
          { status: 'in_progress', content: 'Wire office_look structured header' },
          { status: 'pending', content: 'Run tests and ocr-review' },
        ],
        lastTool: { name: 'Execute', summary: 'Running command: npm test', at: NOW - 95_000 },
        lastHookAt: NOW - 95_000,
        lastOutputAt: NOW - 2_000,
        queuedMessages: ['Remember to keep webhook payloads untouched'],
        queuedNotices: 1,
        screenRows: ['● Thinking through edge cases in office_look...', 'Retrying the model request (attempt 4)...', '──────────────────────────────────────────'],
      },
    ],
    [
      assignedSub.id,
      {
        currentTool: { name: 'Edit', summary: 'Editing team.ts', at: NOW - 8_000 },
        lastHookAt: NOW - 8_000,
      },
    ],
  ]);

  const pulls: GhPull[] = [
    {
      number: 427,
      title: 'feat: structured worker status',
      state: 'OPEN',
      isDraft: false,
      author: 'nik',
      labels: [],
      headRefName: 'office/sub1',
      baseRefName: 'main',
      createdAt: '2026-04-17T21:55:00.000Z',
      updatedAt: '2026-04-17T21:59:00.000Z',
      additions: 240,
      deletions: 12,
      reviewDecision: '',
      checks: 'pass',
      body: '',
      closes: [],
      url: 'https://github.com/nikships/droid-office/pull/427',
    },
  ];
  const pipelines: PipelinesState = {
    available: true,
    checkedAt: NOW,
    runs: [
      {
        id: 501,
        number: 12,
        workflow: 'Release',
        title: 'feat: structured worker status',
        state: 'running',
        status: 'in_progress',
        branch: 'office/sub1',
        sha: 'abc1234',
        event: 'pull_request',
        url: 'https://github.com/nikships/droid-office/actions/runs/501',
        createdAt: '2026-04-17T21:58:00.000Z',
        updatedAt: '2026-04-17T21:59:30.000Z',
        jobs: { total: 3, done: 1, failed: 0, current: 'Checks' },
      },
    ],
    workflows: [],
  };

  const availability = (model: string): ModelAvailability | undefined => {
    if (model === SOL) return solExhausted ? { state: 'exhausted', until: resetAt, window: '5-hour' } : { state: 'ok' };
    if (model === OPUS) return { state: 'ok' };
    if (model === GROK) return { state: 'exhausted', until: NOW + 7_200_000, window: 'Weekly' };
    return undefined;
  };
  const usage = (model: string): ModelUsage | undefined => {
    if (model === SOL) {
      return {
        provider: 'codex',
        accounts: 2,
        windows: [
          { name: '5-hour', leftPercent: solExhausted ? 0 : 18, resetsAt: resetAt },
          { name: 'Weekly', leftPercent: 62, resetsAt: NOW + 48 * 3_600_000 },
        ],
        updatedAt: NOW - 20_000,
        at: NOW,
      };
    }
    if (model === OPUS) {
      return {
        provider: 'claude',
        accounts: 1,
        windows: [{ name: '5-hour', leftPercent: 74, resetsAt: NOW + 120 * 60_000 }],
        updatedAt: NOW - 20_000,
        at: NOW,
      };
    }
    if (model === GROK) {
      return {
        provider: 'grok',
        accounts: 1,
        windows: [{ name: 'Weekly', leftPercent: 0, resetsAt: NOW + 7_200_000 }],
        updatedAt: NOW - 20_000,
        at: NOW,
      };
    }
    return undefined;
  };

  const workers: TeamWorkers & OfficeMcpFloor['workers'] = {
    list: () => [...people.values()],
    get: (id) => people.get(id),
    authenticate: (id, token) => (token === `token-${id}` ? people.get(id) : undefined),
    officeDefault: { model: 'claude-opus-5-5', effort: 'high' },
    deskOccupied: (desk) => [...people.values()].some((w) => w.deskId === desk),
    hire: () => 'unused',
    prompt: () => undefined,
    resume: () => undefined,
    kill: async () => ({}),
    tail: (id, lines) => `raw thinking noise (${lines} lines of ${id})\nRetrying the model request (attempt 4)...`,
    runtime: (id) => runtimes.get(id),
    setTask: (id, task) => {
      const w = people.get(id);
      if (w) w.task = task;
    },
  };

  const teamOpts: TeamOptions = {
    dataDir: dir,
    dir,
    git: true,
    pullItems: () => pulls,
    pipelineState: () => pipelines,
    labelsOn: () => labelsOn,
    settings: () => settings,
    availability,
    usage,
    recheckModels: async () => {
      recheckCalls++;
      solExhausted = true;
    },
    models: async () => ({
      defaultModel: 'claude-opus-5-5',
      models: [
        { id: SOL, displayName: 'DroidProxy: GPT 6.1 Sol', custom: true },
        { id: OPUS, displayName: 'DroidProxy: Claude Opus 5.5', custom: true },
        { id: GROK, displayName: 'DroidProxy: Grok 4.7', custom: true },
        { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', provider: 'anthropic', tokenMultiplier: 1.6 },
      ],
    }),
    toast: () => {},
    now: () => NOW,
  };
  const team = new Team(workers, teamOpts);
  const visits = new Visits(workers, { settings: () => settings, toast: () => {}, emit: () => {} });
  const whiteboard = new WhiteboardStore(dir);
  const floorObj: OfficeMcpFloor = { id: 'f-main', name: 'main', dir, workers, team, visits, whiteboard };

  const orchWorker = makeWorker(ORCHESTRATOR_ID, {
    name: 'Orchestrator',
    deskId: '',
    status: 'idle',
    task: { name: 'Coordinate', summary: 'Oversee release', generated: true, updatedAt: NOW - 10_000 },
  });
  const remoteStore = new RemoteWorkers(dir);
  const remoteOffice = new RemoteOffice(
    remoteStore,
    () => [{ id: 'f-main', dir, def: { name: 'main' }, workers: { ...workers, remoteSeat: () => 'desk-8', attachRemote() {}, detachRemote() {}, releaseRemoteLead() {}, remoteStatus() {} }, team, visits, whiteboard }] as never,
  );
  const createdBot = remoteOffice.add('GrokLead');
  const grokWorker = createdBot.worker;

  const owner: OwnerOffice = {
    floors: () => [{ id: 'f-main', name: 'main', workers: [...people.values()] }],
    mission: () => [
      { worker: orchWorker, team: [] },
      { worker: grokWorker, team: [] },
    ],
    tail: (id, lines) => (id === ORCHESTRATOR_ID ? 'orchestrator tty' : workers.tail(id, lines)),
    labelsOn: () => labelsOn,
    inspect: async (id) => {
      if (id === ORCHESTRATOR_ID) return buildWorkerInspection({ worker: orchWorker, labelsOn, now: NOW });
      const w = people.get(id);
      if (!w) return undefined;
      await team.recheckIfRetrying([w]);
      return team.inspectWorker(w);
    },
    act: async () => ({ notes: [] }),
  };

  const mcp = createOfficeMcp({
    hookUrl: 'http://127.0.0.1:0',
    answers: new Answers(),
    settings: () => settings,
    floor: () => floorObj,
    remote: remoteOffice,
    owner,
    orchestrator: {
      authenticate: (id, token) => (id === ORCHESTRATOR_ID && token === 'token-orch' ? orchWorker : undefined),
      cwd: dir,
    },
  });
  const httpServer = createServer((req, res) => {
    if (!(req.url ?? '/').startsWith(OFFICE_MCP_PATH)) {
      res.writeHead(404).end();
      return;
    }
    void mcp.handle(req, res);
  });
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const url = new URL(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}${OFFICE_MCP_PATH}`);

  const connect = async (headers: Record<string, string>) => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    await client.connect(transport);
    return { client, transport };
  };
  const leadConn = await connect({ authorization: 'Bearer token-lead', [OFFICE_MCP_WORKER_HEADER]: 'lead' });
  const botConn = await connect({ authorization: 'Bearer token-orch', [OFFICE_MCP_WORKER_HEADER]: ORCHESTRATOR_ID });

  t.after(async () => {
    await leadConn.client.close();
    await botConn.client.close();
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    team.stop();
    visits.stop();
    whiteboard.stop();
    remoteOffice.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  // 1. Inspecting a retrying subscription worker via worker_log (tail: 0) triggers recheckModels and surfaces cooldown + steps + PR/CI without terminal noise!
  assert.equal(solExhausted, false);
  const logZero = await leadConn.client.callTool({ name: 'worker_log', arguments: { worker: 'Sprocket', tail: 0 } });
  const logZeroText = (logZero.content as { text: string }[]).map((c) => c.text).join('\n');
  assert.equal(recheckCalls, 1, 'retrying subscription worker triggered throttled model recheck');
  assert.equal(solExhausted, true);
  assert.doesNotMatch(logZeroText, /raw thinking noise/, 'tail: 0 omits raw terminal output');
  assert.match(logZeroText, /Model cooldown: Out of quota on 5-hour, resets in 42 min \(2026-04-17T22:42:00\.000Z\)/);
  assert.match(logZeroText, /Plan: 2\/4 · Wire office_look structured header/);
  assert.match(logZeroText, /\[>\] Wire office_look structured header/);
  assert.match(logZeroText, /Queued: 1 terminal queued \("Remember to keep webhook payloads untouched"\), 1 next-step notice/);
  assert.match(logZeroText, /PR #427 \(open, checks pass\)/);
  assert.match(logZeroText, /CI: Release #12 running \(1\/3 jobs · Checks\) on office\/sub1/);
  assert.equal((logZero.structuredContent as Record<string, unknown>).terminal, null);

  // 2. office_look with lines: 0 (structured-only) and lines: 5 (structured header + terminal)
  const lookZero = await botConn.client.callTool({ name: 'office_look', arguments: { name: 'Sprocket', lines: 0 } });
  const lookZeroText = (lookZero.content as { text: string }[]).map((c) => c.text).join('\n');
  assert.doesNotMatch(lookZeroText, /raw thinking noise/);
  assert.match(lookZeroText, /Sprocket on floor 1 \(main\):/);
  assert.match(lookZeroText, /Model cooldown: Out of quota on 5-hour/);
  assert.match(lookZeroText, /\[x\] Inspect DroidProxy control API/);

  const lookWithTerm = await botConn.client.callTool({ name: 'office_look', arguments: { name: 'Sprocket', lines: 5 } });
  const lookTermText = (lookWithTerm.content as { text: string }[]).map((c) => c.text).join('\n');
  assert.match(lookTermText, /Model cooldown: Out of quota on 5-hour[\s\S]*Terminal:\nraw thinking noise/);

  const lookOrchZero = await botConn.client.callTool({ name: 'office_look', arguments: { name: ORCHESTRATOR_ID, lines: 0 } });
  assert.equal(lookOrchZero.isError, undefined);
  assert.match((lookOrchZero.content as { text: string }[])[0].text, /Orchestrator in Mission Control:\n\nState: idle/);

  // 3. office_roster & team_status label provenance, updatedAt, and stale flag when Worker labels are turned off — while webhook payload stays clean!
  const rosterOn = await botConn.client.callTool({ name: 'office_roster', arguments: {} });
  const rosterOnText = (rosterOn.content as { text: string }[]).map((c) => c.text).join('\n');
  const updatedIso = new Date(NOW - 30_000).toISOString();
  assert.match(rosterOnText, new RegExp(`Sprocket[\\s\\S]*Task: Worker Status: Surface cooldowns and plan steps \\[generated label, updated ${updatedIso}\\]`));
  assert.match(rosterOnText, /Widget[\s\S]*Task: Fix MCP edges: Clean up error codes\n/);
  assert.match(rosterOnText, /Pixel[\s\S]*Task: Audit docs: Check guide links/);
  assert.doesNotMatch(rosterOnText, /stale \(worker labels off\)/);

  // Turn Worker labels OFF -> generated labels are flagged stale in both office_roster and team_status!
  labelsOn = false;
  const rosterOff = await botConn.client.callTool({ name: 'office_roster', arguments: {} });
  const rosterOffText = (rosterOff.content as { text: string }[]).map((c) => c.text).join('\n');
  assert.match(rosterOffText, new RegExp(`Task: Worker Status: Surface cooldowns and plan steps \\[generated label, stale \\(worker labels off\\), updated ${updatedIso}\\]`));
  const rosterWorkers = (rosterOff.structuredContent as { workers: ReturnType<typeof roster> }).workers;
  const sprocketRoster = rosterWorkers.find((w) => w.id === 'sub1')!;
  assert.deepEqual(sprocketRoster.taskLabel, { source: 'generated', generated: true, updatedAt: updatedIso, stale: true });
  assert.deepEqual(rosterWorkers.find((w) => w.id === 'sub2')!.taskLabel, { source: 'lead', generated: false });
  assert.deepEqual(rosterWorkers.find((w) => w.id === 'solo')!.taskLabel, { source: 'prompt', generated: false });

  const statusVerbose = await leadConn.client.callTool({ name: 'team_status', arguments: {} });
  const statusVerboseText = (statusVerbose.content as { text: string }[]).map((c) => c.text).join('\n');
  assert.match(statusVerboseText, /Task: Worker Status \[generated label, stale \(worker labels off\), updated /);
  assert.match(statusVerboseText, /Task: Fix MCP edges\n/);
  assert.match(statusVerboseText, /Model cooldown: Out of quota on 5-hour/);
  assert.match(statusVerboseText, /Current tool: Editing team\.ts \(running 8s\)/);

  const statusCompact = await leadConn.client.callTool({ name: 'team_status', arguments: { verbose: false } });
  const statusCompactText = (statusCompact.content as { text: string }[]).map((c) => c.text).join('\n');
  assert.match(statusCompactText, /Sprocket \(sub1\) working, Desk 2: Worker Status \[generated label, stale \(worker labels off\), updated /);
  assert.match(statusCompactText, /Model cooldown: Out of quota on 5-hour/);
  assert.match(statusCompactText, /Plan 2\/4 \(Wire office_look structured header\)/);

  // Verify Grok Bot webhook worker payload does NOT include taskLabel or stale/updatedAt fields!
  const teamMembers = (statusVerbose.structuredContent as { team: Parameters<typeof webhookWorkerFromMember>[0][] }).team;
  const webhookWorker = webhookWorkerFromMember(
    teamMembers.find((m) => m?.id === 'sub1'),
    sub,
  );
  assert.ok(webhookWorker);
  assert.equal('taskLabel' in webhookWorker, false);
  assert.deepEqual(Object.keys(webhookWorker).sort(), ['branch', 'desk', 'id', 'name', 'prUrl', 'settled', 'status', 'task', 'worktree']);

  // 4. team_models compact provider quota summary + `only` filters ('quotas', 'subscriptions', 'available')
  const prevRechecks = recheckCalls;
  const quotasOnly = await leadConn.client.callTool({ name: 'team_models', arguments: { only: 'quotas' } });
  assert.equal(recheckCalls, prevRechecks + 1, 'team_models triggers throttled recheckModels');
  const quotasText = (quotasOnly.content as { text: string }[]).map((c) => c.text).join('\n');
  assert.match(quotasText, /Subscription quotas:/);
  assert.match(quotasText, /ChatGPT \(COOLDOWN, best of 2 accounts, 0\/1 runnable\): out of quota on 5-hour, resets in 42 min \(2026-04-17T22:42:00\.000Z\) · 5-hour 0% left.*Weekly 62% left/);
  assert.match(quotasText, /Claude \(1\/1 runnable\): 5-hour 74% left/);
  assert.match(quotasText, /Grok \(COOLDOWN, 0\/1 runnable\): out of quota on Weekly.*Weekly 0% left/);
  assert.doesNotMatch(quotasText, /Claude Opus 5\.5\nanthropic, x1\.6 credits/, 'only: quotas omits per-model catalogue blocks');

  const subsOnly = await leadConn.client.callTool({ name: 'team_models', arguments: { only: 'subscriptions' } });
  const subsModels = (subsOnly.structuredContent as { models: { id: string }[] }).models.map((m) => m.id);
  assert.deepEqual(subsModels, [SOL, OPUS, GROK]);

  const availOnly = await leadConn.client.callTool({ name: 'team_models', arguments: { only: 'available' } });
  const availModels = (availOnly.structuredContent as { models: { id: string }[] }).models.map((m) => m.id);
  assert.deepEqual(availModels, [OPUS, 'claude-opus-5-5']);

  // Pure unit sanity check on summarizeProviderQuotas + formatWorkerInspection
  const summary = summarizeProviderQuotas((subsOnly.structuredContent as { models: never[] }).models, NOW);
  assert.equal(summary.length, 3);
  assert.ok(formatProviderQuotas(summary).startsWith('Subscription quotas:\n'));
  assert.ok(formatWorkerInspection(team.inspectWorker(sub), { includeSteps: true }).includes('1. [x] Inspect DroidProxy control API'));
});
