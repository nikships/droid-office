import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Answers } from '../src/server/answers.js';
import { createOfficeMcp, OFFICE_MCP_PATH, OFFICE_MCP_WORKER_HEADER, type OfficeMcpFloor } from '../src/server/office-mcp/index.js';
import { Team, type TeamOptions, type TeamWorkers } from '../src/server/team.js';
import { Visits } from '../src/server/visits.js';
import { WhiteboardStore } from '../src/server/whiteboard.js';
import { SUBAGENT_DEFAULTS, type SubagentSettings, type WorkerInfo } from '../src/shared/protocol.js';
import type { ModelAvailability, ModelUsage } from '../src/shared/subscriptions.js';

function worker(id: string, extra: Partial<WorkerInfo> = {}): WorkerInfo {
  return { id, name: id, kind: 'agent', deskId: 'desk-1', color: '#fff', status: 'done', acked: true, createdBy: 'test', createdAt: 1, cols: 100, rows: 30, open: false, ...extra };
}

async function rig(t: { after(fn: () => void | Promise<void>): void }, options: Partial<TeamOptions> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-mcp-team-'));
  const settings: SubagentSettings = { ...SUBAGENT_DEFAULTS, wakeLead: false };
  const people = new Map([
    ['lead', worker('lead', { name: 'Nibble' })],
    ['other', worker('other', { name: 'Gizmo', deskId: 'desk-9' })],
  ]);
  const hired: Parameters<TeamWorkers['hire']>[] = [];
  const prompts: [string, string][] = [];
  const resumed: [string, string | undefined][] = [];
  const tails: [string, number][] = [];
  const fetched: [string, string | undefined][] = [];
  let refusal: string | undefined;
  const workers: TeamWorkers & OfficeMcpFloor['workers'] = {
    list: () => [...people.values()],
    get: (id) => people.get(id),
    authenticate: (id, token) => (token === `token-${id}` ? people.get(id) : undefined),
    officeDefault: { model: 'claude-opus-5-5', effort: 'medium' },
    deskOccupied: (desk) => [...people.values()].some((w) => w.deskId === desk),
    hire: (...args) => {
      if (refusal) return refusal;
      hired.push(args);
      const [deskId, , , worktree, choice, lead, from] = args;
      const id = `sub${hired.length}`;
      const sub = worker(id, {
        name: ['Pixel', 'Byte'][hired.length - 1] ?? id,
        deskId,
        lead,
        status: 'working',
        createdAt: hired.length + 1,
        model: choice.model ?? 'claude-opus-5-5',
        effort: choice.effort,
        ...(worktree ? { worktree: { path: `.droid-office/worktrees/${id}`, branch: `office/${id}`, base: 'abc', from } } : {}),
      });
      people.set(id, sub);
      return sub;
    },
    prompt: (id, message) => {
      prompts.push([id, message]);
      return undefined;
    },
    resume: (id, message) => {
      resumed.push([id, message]);
      return undefined;
    },
    kill: async (id) => {
      people.delete(id);
      team.onWorkerGone(id);
      return { note: 'Kept its worktree' };
    },
    tail: (id, lines) => {
      tails.push([id, lines]);
      return people.get(id)?.status === 'starting' ? undefined : Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n');
    },
    setTask: (id, task) => {
      const w = people.get(id);
      if (w) w.task = task;
    },
    fetchStart: async (id, from) => {
      fetched.push([id, from]);
    },
  };
  const team = new Team(workers, {
    dataDir: dir,
    dir,
    git: true,
    settings: () => settings,
    toast() {},
    models: async () => ({
      defaultModel: 'claude-opus-5-5',
      models: [
        { id: 'custom:mine', displayName: 'Mine', custom: true, provider: 'generic-chat-completion-api' },
        { id: 'claude-opus-5-5', displayName: 'Opus 5.5', provider: 'anthropic', tokenMultiplier: 1.6, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high'] },
        { id: 'glm-5.3-flash', displayName: 'GLM-5.3-Flash', provider: 'factory', tokenMultiplier: 0.06, noImages: true, promo: 'Half off' },
      ],
    }),
    ...options,
  });
  const visits = new Visits({ ...workers, cancelTurn: () => false, turnScreen: () => undefined }, { on: () => settings.visits, emit() {} });
  const whiteboard = new WhiteboardStore(dir);
  const floor: OfficeMcpFloor = { id: 'floor', name: 'Floor', dir, workers, team, visits, whiteboard };
  const office = createOfficeMcp({ answers: new Answers(), settings: () => settings, floor: (id) => (people.has(id) ? floor : undefined) });
  const http = createServer((req, res) => {
    if (req.url === OFFICE_MCP_PATH) void office.handle(req, res);
    else res.writeHead(404).end();
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}${OFFICE_MCP_PATH}`);
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map((c) => c.close()));
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    team.stop();
    visits.stop();
    whiteboard.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  async function connect(id: string) {
    const client = new Client({ name: 'team-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { [OFFICE_MCP_WORKER_HEADER]: id, Authorization: `Bearer token-${id}` } } }));
    return client;
  }
  const lead = await connect('lead');
  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    return { ...result, output: JSON.stringify(result.content), body: result.structuredContent as Record<string, any> };
  }
  const hire = (args: Record<string, unknown> = {}) => call(lead, 'team_hire', { title: 'Fix login', brief: 'Fix the redirect, test, commit and report.', ...args });
  const status = (args: Record<string, unknown> = {}) => call(lead, 'team', { action: 'status', ...args });
  function set(id: string, status: WorkerInfo['status'], extra: Partial<WorkerInfo> = {}) {
    const w = people.get(id)!;
    Object.assign(w, extra, { status });
    team.onWorker({ ...w });
  }
  return {
    dir,
    settings,
    people,
    hired,
    prompts,
    resumed,
    tails,
    fetched,
    team,
    connect,
    call,
    lead,
    hire,
    status,
    set,
    refuse: (reason: string) => {
      refusal = reason;
    },
  };
}

test('team models describes costs, notes, efforts, images, default and unavailable catalogues', async (t) => {
  const r = await rig(t);
  r.settings.models = [{ id: 'glm-5.3-flash', note: 'tests and docs' }, { id: 'custom:mine' }];
  const result = await r.call(r.lead, 'team_models');
  assert.equal(result.isError, undefined);
  assert.equal(result.body.restricted, true);
  assert.deepEqual(
    result.body.models.map((m: Record<string, unknown>) => m.id),
    ['claude-opus-5-5', 'glm-5.3-flash', 'custom:mine'],
  );
  assert.match(result.output, /x1.6 credits/);
  assert.match(result.output, /effort low\/medium\/high/);
  assert.match(result.output, /x0.06 credits, no images/);
  assert.match(result.output, /tests and docs/);
  assert.match(result.output, /owner's API key, no Factory credits/);
  const unavailable = await rig(t, {
    models: async () => {
      throw new Error('private error');
    },
  });
  const fallback = await unavailable.call(unavailable.lead, 'team_models');
  assert.equal(fallback.body.unavailable, true);
  assert.match(fallback.output, /could not list its models/);
  assert.doesNotMatch(fallback.output, /private error/);
});

test('team_models and models_list print the plan a subscription model runs on, and leave other models alone', async (t) => {
  const SOL = 'custom:droidproxy:gpt-6.1-sol';
  const GROK = 'custom:droidproxy:grok-4.7';
  const now = Date.now();
  const availability: Record<string, ModelAvailability> = { [SOL]: { state: 'ok' }, [GROK]: { state: 'exhausted', until: now + 3_600_000, window: 'Weekly' } };
  const usage: Record<string, ModelUsage> = {
    [SOL]: {
      provider: 'codex',
      accounts: 2,
      windows: [
        { name: '5-hour', leftPercent: 100, resetsAt: now + 296 * 60_000 + 30_000 },
        { name: 'Weekly', leftPercent: 61, resetsAt: now + 57 * 3_600_000 + 30_000 },
      ],
      updatedAt: now - 40 * 60_000,
      at: now,
    },
    [GROK]: { provider: 'grok', accounts: 1, windows: [], unreadable: 'timed out', at: now },
  };
  const r = await rig(t, {
    availability: (model) => availability[model],
    usage: (model) => usage[model],
    now: () => now,
    models: async () => ({
      defaultModel: 'glm-5.3-flash',
      models: [
        { id: SOL, displayName: 'DroidProxy: GPT 6.1 Sol', custom: true },
        { id: GROK, displayName: 'DroidProxy: Grok 4.7', custom: true },
        { id: 'glm-5.3-flash', displayName: 'GLM-5.3-Flash', tokenMultiplier: 0.06 },
      ],
    }),
  });
  const text = (await r.call(r.lead, 'team_models')).content as { text: string }[];
  const shown = text.map((c) => c.text).join('\n');
  assert.match(shown, /Subscription usage: ChatGPT, best of 2 accounts: 5-hour 100% left \(resets in 4 h 57 min\), Weekly 61% left \(resets in 2 d 9 h\); read 40 min ago, may be out of date/);
  assert.match(shown, /Subscription usage: Grok: usage couldn't be read \(timed out\)\nCannot run: Out of quota, back in 1 h \(Weekly\)/);
  assert.equal((shown.match(/Subscription usage/g) ?? []).length, 2, 'GLM is not a subscription model');
  const listed = (await r.call(r.lead, 'models_list')).content as { text: string }[];
  assert.match(listed.map((c) => c.text).join('\n'), /Subscription usage: ChatGPT, best of 2 accounts/);
});

test('hiring preserves the literal brief, uses nearest desk and a worktree, and forwards model, effort and from', async (t) => {
  const r = await rig(t);
  const brief = "Don't expand $HOME or `this`.\nRun tests.";
  const result = await r.hire({ brief, model: 'glm-5.3-flash', effort: 'high', from: 'origin/main' });
  assert.equal(result.isError, undefined);
  assert.deepEqual(r.hired[0], ['desk-3', 'Nibble', brief, true, { model: 'glm-5.3-flash', effort: 'high' }, 'lead', 'origin/main']);
  assert.deepEqual(r.fetched, [['lead', 'origin/main']]);
  assert.equal(result.body.worker.task, 'Fix login');
  assert.equal(result.body.worker.worktree.path, path.join(r.dir, '.droid-office/worktrees/sub1'));
  assert.match(result.output, /Pixel.*Desk 3/);
  assert.match(result.output, /origin\/main/);
  await r.hire({ worktree: false });
  assert.equal(r.hired[1][3], false);
  assert.equal(r.fetched.length, 1);
  assert.match((await r.hire({ worktree: false, from: 'main' })).output, /leave from out/);
  assert.match((await r.hire({ from: '--upload-pack=evil' })).output, /branch, tag or commit/);
  const instructions = r.lead.getInstructions() ?? '';
  for (const rule of [/fresh subagent per task/, /touch separate files/, /Owner notes take priority/, /no-images/, /review and integration/, /Subagents cannot hire/]) assert.match(instructions, rule);
});

test('hire refusals are actionable errors and do not take a desk', async (t) => {
  const availability: Record<string, ModelAvailability> = {
    'claude-opus-5-5': { state: 'signed-out', provider: 'claude' },
    'glm-5.3-flash': { state: 'ok' },
  };
  const r = await rig(t, { availability: (model) => availability[model] });
  const blocked = await r.hire();
  assert.equal(blocked.isError, true);
  assert.match(blocked.output, /no Claude account is connected/);
  assert.match(blocked.output, /set model in team_hire/);
  assert.match(blocked.output, /glm-5.3-flash/);
  assert.equal(r.hired.length, 0);
  assert.equal(r.fetched.length, 0);
  r.settings.models = [{ id: 'glm-5.3-flash' }];
  const restricted = await r.hire({ model: 'not-allowed' });
  assert.equal(restricted.isError, true);
  assert.match(restricted.output, /pick one from team_models/);
  await r.hire({ model: 'glm-5.3-flash' });
  r.settings.maxPerLead = 1;
  const full = await r.hire({ model: 'glm-5.3-flash' });
  assert.equal(full.isError, true);
  assert.match(full.output, /action dismiss/);
  assert.equal(r.hired.length, 1);
  const sub = await r.connect('sub1');
  const tools = (await sub.listTools()).tools.map((tool) => tool.name).filter((name) => !name.startsWith('whiteboard_'));
  assert.deepEqual(tools, ['office_whoami', 'team_report']);
  assert.equal((await r.call(sub, 'team_hire', { title: 'No', brief: 'No' })).isError, true);
  assert.equal((await r.call(sub, 'team_models')).isError, true);
  assert.equal((await r.call(sub, 'team', { action: 'status' })).isError, true);
  assert.equal((await r.call(r.lead, 'team_report', { text: 'No' })).isError, true);
  r.settings.on = false;
  assert.match((await r.hire()).output, /Settings/);
  assert.equal((await r.status()).isError, undefined, 'existing leads can still manage their team');
});

test('status snapshots include work, last report and bounded optional terminals; news drains only for its caller', async (t) => {
  const r = await rig(t);
  await r.hire();
  await r.hire();
  r.set('sub1', 'working', { activity: 'Editing login.ts', activeModel: 'glm-5.3-flash', activeEffort: 'low' });
  const sub = await r.connect('sub1');
  const other = await r.connect('other');
  const report = await r.call(sub, 'team_report', { text: 'Fixed it.\nCommit abc', question: false });
  assert.match(report.output, /Reported to Nibble.*End your turn/);
  r.set('sub1', 'done');
  r.set('sub2', 'needs_input', { activity: 'Allow this command?' });
  assert.deepEqual((await r.call(other, 'team', { action: 'status' })).body.events, []);
  const result = await r.status({ name: 'pIxEl', lines: 2 });
  assert.equal(result.body.team.length, 1);
  const member = result.body.team[0];
  assert.equal(member.model, 'glm-5.3-flash');
  assert.equal(member.effort, 'low');
  assert.equal(member.activity, 'Editing login.ts');
  assert.equal(member.report.text, 'Fixed it.\nCommit abc');
  assert.equal(member.terminal, 'line 1\nline 2');
  assert.deepEqual(r.tails, [['sub1', 2]]);
  assert.deepEqual(
    result.body.events.map((e: Record<string, unknown>) => e.kind),
    ['report', 'needs_input'],
  );
  assert.match(result.output, /Byte needs someone to answer in its own terminal/);
  assert.match(result.output, /someone must answer at its desk/);
  assert.deepEqual((await r.status()).body.events, []);
  assert.equal(r.tails.length, 1, 'terminal reads are opt-in');
  await r.status({ lines: 400 });
  assert.deepEqual(r.tails.slice(1), [
    ['sub1', 400],
    ['sub2', 400],
  ]);
  for (const lines of [0, 401, 1.5]) assert.equal((await r.status({ lines })).isError, true);
  r.set('sub1', 'starting');
  assert.match((await r.status({ name: 'Pixel', lines: 1 })).output, /no terminal yet/);
  const wrong = await r.status({ name: 'Gizmo' });
  assert.equal(wrong.isError, true);
  assert.match(wrong.output, /isn't one of your subagents/);
});

test('a progress report ends the turn as done, but tells the lead the subagent is not finished and waits on its background work', async (t) => {
  const r = await rig(t);
  await r.hire();
  r.set('sub1', 'working');
  const sub = await r.connect('sub1');
  const both = await r.call(sub, 'team_report', { text: 'Waiting', progress: true, question: true });
  assert.equal(both.isError, true);
  assert.match(both.output, /leave progress out/);
  const sent = await r.call(sub, 'team_report', { text: 'Items 1-3 committed. The from-zero rebuild runs in the background (30 to 45 minutes); verification follows.', progress: true });
  assert.equal(sent.isError, undefined);
  assert.equal(sent.body.progress, true);
  assert.match(sent.output, /Sent Nibble a progress report: Nibble sees you are not finished\. End your turn now; your background job wakes you when it exits\./);
  assert.match(sent.output, /final report \(progress left out\)/);
  r.set('sub1', 'done');

  const full = await r.status({ name: 'Pixel' });
  const member = full.body.team[0];
  assert.equal(member.status, 'done', 'its turn really ended');
  assert.equal(member.state, 'done');
  assert.equal(member.report.progress, true);
  assert.match(full.output, /Idle for 0 minutes\.\\nNot finished: its turn ended after a progress report, and it waits on its own background work/);
  assert.match(full.output, /Last progress report:\\nItems 1-3 committed/);
  assert.match(full.output, /Worker progress report from Pixel \(not finished; its turn ended waiting on its own background work, which wakes it\)/);
  assert.deepEqual(
    full.body.events.map((e: Record<string, unknown>) => [e.kind, e.progress]),
    [['report', true]],
  );

  assert.equal(member.awaitingJob, true);
  const compact = await r.call(r.lead, 'team_status', { verbose: false });
  assert.equal(compact.body.workers[0].lastReportKind, 'progress');
  assert.equal(compact.body.workers[0].awaitingJob, true);
  assert.match(compact.output, /Pixel \(sub1\) done \(not finished: its progress report says it waits on its own background work\)/);
  const got = await r.call(r.lead, 'team_report_get', { worker: 'Pixel' });
  assert.equal(got.body.report.progress, true);
  assert.match(got.output, /Progress report \(not finished\) team:floor:\d+ from Pixel/);

  // Woken by its job, a turn that ends without a report is no longer waiting on it.
  r.set('sub1', 'working');
  r.set('sub1', 'done');
  const woken = await r.status({ name: 'Pixel' });
  assert.equal(woken.body.team[0].report.progress, true, 'its last report is still the progress report');
  assert.equal(woken.body.team[0].awaitingJob, undefined);
  assert.doesNotMatch(woken.output, /Not finished/);
  const wokenCompact = await r.call(r.lead, 'team_status', { verbose: false });
  assert.equal(wokenCompact.body.workers[0].awaitingJob, undefined);
  assert.doesNotMatch(wokenCompact.output, /not finished: its progress report/);

  // It finishes with a final report: done again, and nothing says unfinished.
  r.set('sub1', 'working');
  const final = await r.call(sub, 'team_report', { text: 'Rebuild passed; all four items done.' });
  assert.match(final.output, /Reported to Nibble\. End your turn now/);
  assert.equal(final.body.progress, undefined);
  r.set('sub1', 'done');
  const after = await r.status({ name: 'Pixel' });
  assert.equal(after.body.team[0].report.progress, undefined);
  assert.doesNotMatch(after.output, /Not finished/);
  assert.match(after.output, /Last report:\\nRebuild passed/);
});

test('status delivers questions, finished turns, stops and departures without waiting or duplicating news', async (t) => {
  const r = await rig(t);
  await r.hire();
  const sub = await r.connect('sub1');
  assert.match((await r.call(sub, 'team_report', { text: 'Which branch?', question: true })).output, /Asked Nibble/);
  r.set('sub1', 'done');
  r.set('sub1', 'working');
  r.set('sub1', 'exited', { exitCode: 1 });
  r.people.delete('sub1');
  r.team.onWorkerGone('sub1');
  r.settings.on = false;
  assert.ok(
    (await r.lead.listTools()).tools.some((tool) => tool.name === 'team'),
    'final news remains readable after the last subagent leaves and hiring is off',
  );
  const result = await r.status();
  assert.deepEqual(result.body.team, []);
  assert.deepEqual(
    result.body.events.map((e: Record<string, unknown>) => e.kind),
    ['question', 'done', 'stopped', 'left'],
  );
  assert.match(result.output, /Worker question from Pixel/);
  assert.match(result.output, /finished its turn without reporting/);
  assert.match(result.output, /exit code 1/);
  assert.match(result.output, /left the floor/);
  assert.ok(!(await r.lead.listTools()).tools.some((tool) => tool.name === 'team'), 'the former lead loses team access after draining final news');
  r.settings.on = true;
  assert.deepEqual((await r.status()).body.events, []);
  assert.deepEqual(r.prompts, [], 'Wake the lead is off');
});

test('message and dismiss enforce ownership and give readable delivery and cleanup results', async (t) => {
  const r = await rig(t);
  await r.hire();
  const message = await r.call(r.lead, 'team', { action: 'message', name: 'Pixel', text: 'Use v2.\nKeep $HOME literal.' });
  assert.match(message.output, /Sent to Pixel/);
  assert.match(r.prompts[0][1], /message from your lead Nibble/);
  assert.match(r.prompts[0][1], /Keep \$HOME literal/);
  r.set('sub1', 'offline');
  await r.call(r.lead, 'team', { action: 'message', name: 'Pixel', text: 'Continue' });
  assert.equal(r.resumed[0][0], 'sub1');
  r.set('sub1', 'needs_input', { activity: 'Allow edit?' });
  assert.match((await r.call(r.lead, 'team', { action: 'message', name: 'Pixel', text: 'yes' })).output, /own terminal/);
  r.set('sub1', 'starting');
  assert.match((await r.call(r.lead, 'team', { action: 'message', name: 'Pixel', text: 'hi' })).output, /still starting up/);
  for (const args of [{ action: 'message' }, { action: 'dismiss' }, { action: 'message', name: 'Pixel' }, { action: 'message', name: 'Pixel', text: 'hi', lines: 1 }, { action: 'status', text: 'hi' }, { action: 'dismiss', name: 'Gizmo' }])
    assert.equal((await r.call(r.lead, 'team', args)).isError, true);
  const gone = await r.call(r.lead, 'team', { action: 'dismiss', name: 'Pixel' });
  assert.match(gone.output, /Sent Pixel home.*Kept its worktree/);
  assert.equal(r.people.has('sub1'), false);
  const after = (await r.status()).output;
  assert.doesNotMatch(after, /Pixel left the floor/);
  assert.match(after, /No unread team news/);
});

test('status says when the owner sent a subagent home', async (t) => {
  const r = await rig(t);
  await r.hire();
  r.team.sendingHome('sub1', 'owner', () => {
    r.people.delete('sub1');
    r.team.onWorkerGone('sub1');
  });
  assert.match((await r.status()).output, /Office status: Pixel was sent home by the owner\./);
});

test('hire reports runtime capacity refusal and non-git worktree guidance', async (t) => {
  const r = await rig(t);
  r.refuse('Every desk is taken: ask the person to send someone home');
  const result = await r.hire();
  assert.equal(result.isError, true);
  assert.match(result.output, /ask the person/);
  const plain = await rig(t, { git: false });
  const noTree = await plain.hire({ worktree: true });
  assert.equal(noTree.isError, true);
  assert.match(noTree.output, /set worktree: false/);
  assert.equal((await plain.hire({ worktree: false })).isError, undefined);
  assert.equal((await plain.hire()).isError, undefined, 'a non-git floor needs no worktree argument');
});

test("hire without worktree follows the owner's Subagents setting", async (t) => {
  const r = await rig(t);
  r.settings.worktree = false;
  await r.hire();
  assert.equal(r.hired[0][3], false, "Lead's checkout is kept when the lead leaves worktree out");
  r.settings.worktree = true;
  await r.hire();
  assert.equal(r.hired[1][3], true);
});

test('team tool schemas reject missing text and unsupported values before hiring or delivery', async (t) => {
  const r = await rig(t);
  for (const args of [{ brief: '' }, { title: '' }, { effort: 'huge' }, { worktree: 'true' }, { brief: 'x'.repeat(20_001) }]) assert.equal((await r.hire(args)).isError, true);
  assert.equal((await r.call(r.lead, 'team_hire', { brief: 'No title' })).isError, true);
  assert.equal(r.hired.length, 0);
  await r.hire();
  const sub = await r.connect('sub1');
  assert.equal((await r.call(sub, 'team_report', { text: '' })).isError, true);
  assert.equal((await r.call(sub, 'team_report', { text: 'Which?', question: 'true' })).isError, true);
  assert.equal((await r.call(r.lead, 'team', { action: 'wait' })).isError, true);
  assert.deepEqual((await r.status()).body.events, []);
});
