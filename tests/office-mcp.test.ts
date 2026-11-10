import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { Answers } from '../src/server/answers.js';
import {
  createOfficeMcp,
  OFFICE_MCP_OFFICE_HEADER,
  OFFICE_MCP_PATH,
  OFFICE_MCP_WORKER_HEADER,
  officeAccess,
  officeAnswers,
  officeResult,
  syncOfficeMcpConnection,
  type OfficeMcpDeps,
  type OfficeMcpFloor,
} from '../src/server/office-mcp/index.js';
import { Team, type TeamWorkers } from '../src/server/team.js';
import { Visits } from '../src/server/visits.js';
import { WhiteboardStore } from '../src/server/whiteboard.js';
import { Subagents } from '../src/server/subagents.js';
import { SUBAGENT_DEFAULTS, type WorkerInfo } from '../src/shared/protocol.js';

function worker(id: string, extra: Partial<WorkerInfo> = {}): WorkerInfo {
  return { id, name: id, kind: 'agent', deskId: 'desk-1', color: '#ff8800', status: 'idle', acked: true, createdBy: 'test', createdAt: 1, cols: 100, rows: 30, open: false, ...extra };
}

function temporary(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-mcp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function rig(t: { after(fn: () => void | Promise<void>): void }, probes = true, orchestrator?: OfficeMcpDeps['orchestrator']) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-mcp-'));
  const settings = { ...SUBAGENT_DEFAULTS };
  const people = new Map([
    ['lead', worker('lead')],
    ['sub', worker('sub', { lead: 'lead', deskId: 'desk-2', worktree: { path: '.droid-office/worktrees/sub', branch: 'office/sub', base: 'abc' } })],
    ['shell', worker('shell', { kind: 'shell' })],
    ['cloud', worker('cloud', { kind: 'cloud' })],
  ]);
  const tokens = new Map([...people.keys()].map((id) => [id, `test-token-${id}`]));
  const workers: TeamWorkers & OfficeMcpFloor['workers'] = {
    list: () => [...people.values()],
    get: (id) => people.get(id),
    authenticate: (id, token) => (tokens.get(id) === token ? people.get(id) : undefined),
    officeDefault: undefined,
    deskOccupied: () => false,
    hire: () => 'Not used by this test',
    prompt: () => undefined,
    resume: () => undefined,
    kill: async () => ({}),
    tail: () => '',
    setTask() {},
  };
  const team = new Team(workers, { dataDir: dir, dir, git: true, settings: () => settings, toast() {} });
  const visits = new Visits({ ...workers, cancelTurn: () => false, turnScreen: () => undefined }, { on: () => settings.visits, emit() {} });
  const whiteboard = new WhiteboardStore(dir);
  const floor: OfficeMcpFloor = { id: 'floor', name: 'Test floor', dir, workers, team, visits, whiteboard };
  let office: ReturnType<typeof createOfficeMcp> | undefined;
  const http = createServer((req, res) => {
    if (req.url === OFFICE_MCP_PATH && office) void office.handle(req, res);
    else res.writeHead(404).end();
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  office = createOfficeMcp({ answers: new Answers(), hookUrl: origin, settings: () => settings, floor: (id) => (people.has(id) ? floor : undefined), orchestrator });
  if (probes) {
    for (const [name, access] of Object.entries({ test_hire: officeAccess.mayHire, test_team: officeAccess.team, test_report: officeAccess.subagent, test_visit: officeAccess.visits })) {
      office.tool({ name, description: 'Permission probe', inputSchema: z.object({}) }, access, () => officeResult('allowed'));
    }
    office.tool({ name: 'test_error', description: 'Error probe', inputSchema: z.object({}) }, officeAccess.worker, () => {
      throw new Error('private diagnostic stack must not reach the model');
    });
  }
  const url = new URL(OFFICE_MCP_PATH, origin);
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
  const connect = async (id?: string, token = id ? tokens.get(id) : undefined, via = url, headers: Record<string, string> = {}) => {
    const client = new Client({ name: 'office-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(via, { requestInit: { headers: { ...(id ? { [OFFICE_MCP_WORKER_HEADER]: id } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } } }));
    return client;
  };
  return { dir, settings, people, tokens, connect, url, origin, office, workers, team };
}

test('the HTTP MCP refuses missing, mismatched and non-agent identities', async (t) => {
  const r = await rig(t);
  await assert.rejects(r.connect(), /Office MCP requires/);
  await assert.rejects(r.connect('lead', 'test-token-sub'), /Office MCP requires/);
  await assert.rejects(r.connect('missing', 'test-token-lead'), /Office MCP requires/);
  for (const id of ['shell', 'cloud']) await assert.rejects(r.connect(id), /Office MCP requires/);
  const response = await fetch(r.url, { method: 'POST', headers: { [OFFICE_MCP_WORKER_HEADER]: 'lead', Authorization: 'test-token-lead' } });
  assert.equal(response.status, 401, 'a bare token is not a bearer credential');
  const rebound = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(r.url, { method: 'POST', headers: { host: 'attacker.example', [OFFICE_MCP_WORKER_HEADER]: 'lead', Authorization: 'Bearer test-token-lead' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end('{}');
  });
  assert.equal(rebound, 403, 'a page that rebinds its own name to loopback is refused');
});

test('a floor token cannot impersonate the reserved Orchestrator id, even if its floor claims that id', async (t) => {
  const agent = worker('orchestrator', { name: 'Orchestrator', deskId: '' });
  const r = await rig(t, false, { cwd: '/office/orchestrator', authenticate: (id, token) => (id === agent.id && token === 'orchestrator-own-hook-token' ? agent : undefined) });
  r.people.set('orchestrator', worker('orchestrator'));
  r.tokens.set('orchestrator', 'floor-own-hook-token');
  await assert.rejects(r.connect('orchestrator'), /Office MCP requires/);
  await assert.rejects(r.connect('orchestrator', 'test-token-lead'), /Office MCP requires/);
  const client = await r.connect('orchestrator', 'orchestrator-own-hook-token');
  const identity = await client.callTool({ name: 'office_whoami', arguments: {} });
  assert.equal(identity.structuredContent?.floor, null);
  assert.equal(identity.structuredContent?.cwd, '/office/orchestrator');
  assert.equal(identity.structuredContent?.room, 'Mission Control');
  assert.ok(!(await client.listTools()).tools.some((tool) => tool.name === 'office_status'));
});

test("a worker reaching another local office's endpoint is routed to its own office", async (t) => {
  const [here, there] = await Promise.all([rig(t), rig(t)]);
  there.tokens.set('lead', 'token-of-the-other-office');
  const routed = await here.connect('lead', 'token-of-the-other-office', here.url, { [OFFICE_MCP_OFFICE_HEADER]: there.origin });
  const identity = await routed.callTool({ name: 'office_whoami', arguments: {} });
  assert.equal(identity.structuredContent?.cwd, there.dir, "served by the worker's own office");
  await assert.rejects(here.connect('lead', 'token-of-the-other-office'), /Office MCP requires/, 'without its office, the token is foreign here');
  const local = await here.connect('lead', undefined, here.url, { [OFFICE_MCP_OFFICE_HEADER]: here.origin });
  assert.equal((await local.callTool({ name: 'office_whoami', arguments: {} })).structuredContent?.cwd, here.dir);
  const remote = await here.connect('lead', undefined, here.url, { [OFFICE_MCP_OFFICE_HEADER]: 'http://example.com:4600' });
  assert.equal((await remote.callTool({ name: 'office_whoami', arguments: {} })).structuredContent?.cwd, here.dir, 'only loopback offices are routing targets');
  const gone = createServer();
  gone.listen(0, '127.0.0.1');
  await once(gone, 'listening');
  const dead = `http://127.0.0.1:${(gone.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => gone.close(() => resolve()));
  const refused = await fetch(here.url, { method: 'POST', headers: { [OFFICE_MCP_OFFICE_HEADER]: dead, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(refused.status, 502);
  assert.equal(await officeAnswers(here.url.href), true);
  assert.equal(await officeAnswers(new URL(OFFICE_MCP_PATH, dead).href), false);
  assert.equal(await officeAnswers('https://example.com/office/mcp'), false);
});

test('a local worker client that accepts only JSON gets one JSON body, and an SSE client still streams', async (t) => {
  const r = await rig(t);
  const post = (accept: string, id: number) =>
    fetch(r.url, {
      method: 'POST',
      headers: { [OFFICE_MCP_WORKER_HEADER]: 'lead', Authorization: 'Bearer test-token-lead', Accept: accept, 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'office_whoami', arguments: {} } }),
    });
  const plain = await post('application/json', 1);
  assert.match(plain.headers.get('content-type')!, /^application\/json/);
  const body = (await plain.json()) as { id: number; result: { structuredContent: { cwd: string } } };
  assert.equal(body.id, 1);
  assert.equal(body.result.structuredContent.cwd, r.dir);
  const streamed = await post('application/json, text/event-stream', 2);
  assert.match(streamed.headers.get('content-type')!, /^text\/event-stream/);
  assert.match(await streamed.text(), /^data: .*"id":2/m);
});

test('the server registers office tools without test probes', async (t) => {
  const r = await rig(t, false);
  const client = await r.connect('lead');
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes('office_whoami'));
  assert.ok(names.every((name) => !name.startsWith('test_')));
});

test('internal workers retain the tools removed from remote-bot MCP under their existing permissions', async (t) => {
  const r = await rig(t, false);
  const lead = await r.connect('lead');
  const names = new Set((await lead.listTools()).tools.map((tool) => tool.name));
  for (const name of ['team', 'models_list', 'visit_roster', 'visit_look', 'whiteboard_read', 'whiteboard_card', 'whiteboard_state', 'whiteboard_marks', 'whiteboard_apply']) assert.ok(names.has(name), name);
  assert.ok(!names.has('team_report'), 'only subagents report to a lead');
  const subagent = await r.connect('sub');
  assert.ok((await subagent.listTools()).tools.some((tool) => tool.name === 'team_report'));
});

test('a real HTTP MCP client reads office identity and server instructions', async (t) => {
  const r = await rig(t);
  const lead = await r.connect('lead');
  assert.equal(lead.getServerVersion()?.name, 'droid-office');
  assert.match(lead.getInstructions() ?? '', /owner's instructions outrank/);
  assert.match(lead.getInstructions() ?? '', /end your turn when nothing else is left to do/);
  const result = await lead.callTool({ name: 'office_whoami', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent?.canHire, true);
  assert.equal(result.structuredContent?.canVisit, true);
  assert.equal(result.structuredContent?.subagents, 1);
  assert.equal(result.structuredContent?.cwd, r.dir);
  assert.deepEqual(result.structuredContent?.floor, { id: 'floor', name: 'Test floor' });
  assert.match(JSON.stringify(result.content), /lead/);
  const sub = await r.connect('sub');
  const identity = await sub.callTool({ name: 'office_whoami', arguments: {} });
  assert.equal(identity.structuredContent?.canHire, false);
  assert.equal(identity.structuredContent?.canVisit, false);
  assert.equal(identity.structuredContent?.cwd, path.join(r.dir, '.droid-office/worktrees/sub'));
  assert.deepEqual(identity.structuredContent?.lead, { id: 'lead', name: 'lead' });
});

test('discovery and direct calls apply the same permissions per caller, including live changes', async (t) => {
  const r = await rig(t);
  const [lead, sub] = await Promise.all([r.connect('lead'), r.connect('sub')]);
  const names = async (client: Client) =>
    (await client.listTools()).tools
      .map((tool) => tool.name)
      .filter((name) => name === 'office_whoami' || name.startsWith('test_'))
      .sort();
  assert.deepEqual(await names(lead), ['office_whoami', 'test_error', 'test_hire', 'test_team', 'test_visit']);
  assert.deepEqual(await names(sub), ['office_whoami', 'test_error', 'test_report']);
  const forbidden = await sub.callTool({ name: 'test_hire', arguments: {} });
  assert.equal(forbidden.isError, true);
  assert.match(JSON.stringify(forbidden.content), /subagent/);
  assert.equal((await lead.callTool({ name: 'test_report', arguments: {} })).isError, true);
  r.settings.on = false;
  r.settings.visits = false;
  assert.deepEqual(await names(lead), ['office_whoami', 'test_error', 'test_team']);
  assert.ok(
    (await lead.listTools()).tools.some((tool) => tool.name === 'team'),
    'an existing lead keeps team status when hiring is off',
  );
  r.people.delete('sub');
  assert.deepEqual(await names(lead), ['office_whoami', 'test_error']);
  assert.equal((await lead.callTool({ name: 'test_visit', arguments: {} })).isError, true);
  r.settings.officeMcp = false;
  await assert.rejects(lead.listTools(), /Office MCP requires/);
  r.settings.officeMcp = true;
  r.tokens.delete('lead');
  await assert.rejects(lead.callTool({ name: 'office_whoami', arguments: {} }), /Office MCP requires/);
});

test('tool failures return useful errors without internal diagnostics', async (t) => {
  const r = await rig(t);
  const client = await r.connect('lead');
  const result = await client.callTool({ name: 'test_error', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /Read the current state/);
  assert.doesNotMatch(JSON.stringify(result), /private diagnostic|Error:|at /);
  r.office.tool({ name: 'test_count', description: 'Argument probe', inputSchema: z.object({ count: z.number() }) }, officeAccess.worker, ({ count }) => officeResult(String(count)));
  const invalid = await client.callTool({ name: 'test_count', arguments: { count: 'three' } });
  assert.equal(invalid.isError, true);
  assert.match(JSON.stringify(invalid.content), /Invalid arguments for test_count/);
  const unknown = await client.callTool({ name: 'no_such_tool', arguments: {} });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.structuredContent?.code, 'unknown_tool');
  assert.equal(invalid.structuredContent?.code, 'bad_argument');
  assert.equal(result.structuredContent?.code, 'internal_error');
  assert.throws(() => r.office.tool({ name: 'test_error', description: 'Duplicate', inputSchema: z.object({}) }, officeAccess.worker, () => officeResult('no')), /Duplicate/);
});

test('split team tools have strict action-specific schemas and retain the deprecated alias', async (t) => {
  const r = await rig(t);
  const client = await r.connect('lead');
  const listed = (await client.listTools()).tools;
  for (const name of ['team_status', 'team_message', 'team_dismiss', 'models_list', 'worker_diff', 'worker_log']) {
    const tool = listed.find((tool) => tool.name === name);
    assert.ok(tool, name);
    assert.equal(tool.inputSchema.additionalProperties, false, name);
  }
  assert.match(listed.find((tool) => tool.name === 'team')!.description!, /Deprecated/);
  assert.equal((await client.callTool({ name: 'team_message', arguments: { worker: 'sub' } })).structuredContent?.code, 'bad_argument');
  assert.equal((await client.callTool({ name: 'team_status', arguments: { text: 'not a status argument' } })).isError, true);
  assert.equal((await client.callTool({ name: 'team_status', arguments: { worker: 'missing' } })).structuredContent?.code, 'unknown_worker');
  assert.equal((await client.callTool({ name: 'team_message', arguments: { worker: 'sub', text: 'Follow up' } })).isError, undefined);
  const snapshot = await client.callTool({ name: 'team_status', arguments: { worker: 'sub' } });
  assert.ok(snapshot.structuredContent);
  assert.equal((snapshot.structuredContent.team as { id: string }[])[0].id, 'sub');
  const terminal = await client.callTool({ name: 'worker_log', arguments: { worker: 'sub', tail: 20 } });
  assert.equal(terminal.structuredContent?.terminal, '');
  assert.equal((await client.callTool({ name: 'worker_log', arguments: { worker: 'sub', tail: 401 } })).isError, true);
  assert.equal((await client.callTool({ name: 'worker_diff', arguments: { worker: 'sub', base: 'HEAD', commits: 1 } })).isError, true);
  assert.equal((await client.callTool({ name: 'worker_diff', arguments: { worker: 'sub', base: '--output=/tmp/no' } })).isError, true);
  let dismissal: unknown;
  r.workers.dismiss = async (...args) => {
    dismissal = args;
    return { note: 'Kept worktree' };
  };
  assert.equal((await client.callTool({ name: 'team_dismiss', arguments: { worker: 'sub', keepBranch: false } })).isError, true);
  const dismissed = await client.callTool({ name: 'team_dismiss', arguments: { worker: 'sub' } });
  assert.equal(dismissed.isError, undefined);
  assert.deepEqual(dismissal, ['sub', false, true]);
});

test('Gone team errors identify an unknown worker rather than a bad argument', async (t) => {
  const r = await rig(t);
  const client = await r.connect('lead');
  t.mock.method(r.team, 'handle', async () => ({ status: 410, body: { error: 'The lead left the floor' } }));
  const result = await client.callTool({ name: 'team_status', arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.code, 'unknown_worker');
});

test('full model discovery distinguishes owner restrictions from unavailable models in prose', async (t) => {
  const r = await rig(t);
  const client = await r.connect('lead');
  t.mock.method(r.team, 'handle', async () => ({
    status: 200,
    body: {
      models: [
        { id: 'opus', name: 'Opus', enabled: false },
        { id: 'custom:mine', name: 'Mine', enabled: false, cannotRun: 'Switched off in Droid.' },
      ],
    },
  }));
  const result = await client.callTool({ name: 'models_list', arguments: {} });
  assert.match(JSON.stringify(result.content), /Not allowed: opus: Opus/);
  assert.match(JSON.stringify(result.content), /Unavailable: custom:mine: Mine/);
});

test('structured hire controls base and branch and immediately returns its worktree', async (t) => {
  const r = await rig(t);
  const client = await r.connect('lead');
  let brief = '';
  r.workers.hire = (_desk, _by, prompt, worktree, _choice, lead, from, branch) => {
    brief = prompt;
    assert.equal(worktree, true);
    assert.equal(lead, 'lead');
    assert.equal(from, 'main');
    assert.equal(branch, 'feat/ticket');
    return worker('new', { lead, worktree: { path: '.droid-office/worktrees/new', branch: branch!, base: 'abc' } });
  };
  const task = { title: 'Ticket', brief: 'Fix the bug', repo: r.dir, baseBranch: 'main', branch: 'feat/ticket', prNumber: 375, acceptanceCriteria: ['Regression tests pass'] };
  const result = await client.callTool({ name: 'team_hire', arguments: { task } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent?.worktree, path.join(r.dir, '.droid-office/worktrees/new'));
  assert.equal(result.structuredContent?.branch, 'feat/ticket');
  assert.match(brief, /Regression tests pass/);
  assert.match(brief, /Pull request: #375/);
  for (const args of [{}, { task, from: 'other' }, { task, worktree: false }, { task: { ...task, repo: '/another/repo' } }]) {
    assert.equal((await client.callTool({ name: 'team_hire', arguments: args })).structuredContent?.code, 'bad_argument');
  }
});

test('a structured task with no baseBranch of its own starts from the base named with from', async (t) => {
  const r = await rig(t);
  const client = await r.connect('lead');
  const bases: (string | undefined)[] = [];
  r.workers.hire = (_desk, _by, _prompt, _worktree, _choice, lead, from) => {
    bases.push(from);
    return worker('new', { lead, worktree: { path: '.droid-office/worktrees/new', branch: 'office/new', base: 'abc' } });
  };
  const task = { title: 'Ticket', brief: 'Fix the bug', repo: r.dir };
  for (const args of [{ task, from: 'release' }, { task }, { task: { ...task, baseBranch: 'release' }, from: 'release' }]) {
    const hired = await client.callTool({ name: 'team_hire', arguments: args });
    assert.equal(hired.isError, undefined, JSON.stringify(hired.content));
  }
  assert.deepEqual(bases, ['release', undefined, 'release']);
});

test('from and task.baseBranch are one setting: origin/main agrees with main, and different bases are refused naming both', async (t) => {
  const r = await rig(t);
  const client = await r.connect('lead');
  const bases: (string | undefined)[] = [];
  r.workers.hire = (_desk, _by, _prompt, _worktree, _choice, lead, from) => {
    bases.push(from);
    return worker('new', { lead, worktree: { path: '.droid-office/worktrees/new', branch: 'office/new', base: 'abc' } });
  };
  const task = { title: 'Ticket', brief: 'Fix the bug', repo: r.dir, baseBranch: 'main', branch: 'feat/ticket' };
  for (const args of [
    { task, from: 'origin/main' },
    { task, from: 'main' },
    { task: { ...task, baseBranch: 'origin/main' }, from: 'main' },
  ]) {
    const hired = await client.callTool({ name: 'team_hire', arguments: args });
    assert.equal(hired.isError, undefined, JSON.stringify(hired.content));
  }
  assert.deepEqual(bases, ['main', 'main', 'origin/main'], 'the structured task’s baseBranch is the one the hire uses');
  const refused = await client.callTool({ name: 'team_hire', arguments: { task: { ...task, baseBranch: 'dev' }, from: 'origin/main' } });
  assert.equal(refused.structuredContent?.code, 'bad_argument');
  assert.match(JSON.stringify(refused.content), /from \(origin\/main\) and task\.baseBranch \(dev\) name different bases\. They set the same thing, so give only one\./);
  assert.equal((await client.callTool({ name: 'team_hire', arguments: { task, from: 'origin/dev' } })).structuredContent?.code, 'bad_argument');
  assert.equal(bases.length, 3, 'a refused hire starts nothing');
  const tools = (await client.listTools()).tools.find((tool) => tool.name === 'team_hire')!;
  const props = tools.inputSchema.properties as Record<string, { description?: string; properties?: Record<string, { description?: string }> }>;
  assert.match(props.from.description!, /same setting as task\.baseBranch/);
  assert.match(props.task.properties!.baseBranch.description!, /same setting as from/);
});

test('ordinary workers may hire through MCP but subagents cannot list or invoke nested hiring', async (t) => {
  const r = await rig(t, false);
  Object.assign(r.settings, { deskWorkers: false });
  const [root, sub] = await Promise.all([r.connect('lead'), r.connect('sub')]);
  let hires = 0;
  r.workers.hire = (_desk, _by, _prompt, _worktree, _choice, lead) => {
    hires++;
    return worker('new', { lead, deskId: 'desk-3' });
  };
  const rootTools = (await root.listTools()).tools.map((tool) => tool.name);
  assert.ok(rootTools.includes('team_hire'));
  assert.equal((await root.callTool({ name: 'office_whoami', arguments: {} })).structuredContent?.canHire, true);
  const hired = await root.callTool({ name: 'team_hire', arguments: { title: 'Read source', brief: 'Read the source', worktree: false } });
  assert.equal(hired.isError, undefined, JSON.stringify(hired.content));
  assert.equal(hires, 1);
  assert.ok(!(await sub.listTools()).tools.some((tool) => tool.name === 'team_hire'));
  assert.equal((await sub.callTool({ name: 'office_whoami', arguments: {} })).structuredContent?.canHire, false);
  const nested = await sub.callTool({ name: 'team_hire', arguments: { title: 'Nested helper', brief: 'Nested helper', worktree: false } });
  assert.equal(nested.isError, true);
  assert.equal(nested.structuredContent?.code, 'permission_denied');
  assert.equal(hires, 1, 'a direct call cannot bypass discovery permissions');
  r.people.get('sub')!.remote = true;
  assert.ok(r.team.cannotHire(r.people.get('sub')!), 'external identities cannot bypass the no-nested rule');
});

test('reports preserve structured pushed SHA and PR URL alongside prose', async (t) => {
  const r = await rig(t);
  const [lead, sub] = await Promise.all([r.connect('lead'), r.connect('sub')]);
  const pushedSha = 'a'.repeat(40);
  const prUrl = 'https://github.com/nikships/droid-office/pull/375';
  const report = await sub.callTool({ name: 'team_report', arguments: { text: 'All done', pushedSha, prUrl } });
  assert.equal(report.structuredContent?.pushedSha, pushedSha);
  const status = await lead.callTool({ name: 'team_status', arguments: {} });
  assert.ok(status.structuredContent);
  const member = (status.structuredContent.team as { report: { pushedSha: string; prUrl: string } }[])[0];
  assert.equal(member.report.pushedSha, pushedSha);
  assert.equal(member.report.prUrl, prUrl);
  const events = status.structuredContent?.events as { pushedSha: string; prUrl: string }[];
  assert.equal(events[0].pushedSha, pushedSha);
  assert.equal(events[0].prUrl, prUrl);
});

test('HTTP authentication and SDK argument errors carry code and hint without changing status', async (t) => {
  const r = await rig(t);
  const base = { [OFFICE_MCP_WORKER_HEADER]: 'lead', Authorization: 'Bearer test-token-lead' };
  for (const [headers, code] of [
    [{}, 'missing_token'],
    [{ Authorization: base.Authorization }, 'missing_worker_id'],
    [{ ...base, [OFFICE_MCP_WORKER_HEADER]: 'missing' }, 'unknown_worker_id'],
    [{ ...base, Authorization: 'Bearer wrong' }, 'bad_token'],
  ] as const) {
    const response = await fetch(r.url, { method: 'POST', headers });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.code, code);
    assert.ok(body.hint);
  }
  const response = await fetch(r.url, {
    method: 'POST',
    headers: { ...base, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'MCP-Protocol-Version': '1999-01-01' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, 'bad_protocol_version');
  assert.ok(body.hint);
  assert.ok(body.error, 'SDK JSON-RPC error remains');
});

test('rewritten SDK errors discard stale body framing while retaining protocol headers and JSON-RPC errors', async (t) => {
  const r = await rig(t);
  const headers = { [OFFICE_MCP_WORKER_HEADER]: 'lead', Authorization: 'Bearer test-token-lead', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
  const sdk = (r.office as unknown as { mcp: { fetch(request: Request): Promise<Response> } }).mcp;
  const original = await sdk.fetch(new Request(r.url, { method: 'POST', headers, body: '{}' }));
  assert.equal(original.status, 400);
  const body = await original.json();
  t.mock.method(sdk, 'fetch', async () => Response.json(body, { status: 400, headers: { 'content-length': '1', 'content-encoding': 'gzip', 'MCP-Protocol-Version': '2025-06-18' } }));
  const response = await fetch(r.url, { method: 'POST', headers, body: '{}' });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.notEqual(response.headers.get('content-length'), '1');
  assert.equal(response.headers.get('MCP-Protocol-Version'), '2025-06-18');
  const rewritten = await response.json();
  assert.deepEqual(rewritten.error, body.error);
  assert.equal(rewritten.code, 'bad_argument');
  assert.ok(rewritten.hint);
});

test('Office MCP defaults on and survives old clients and persisted settings', (t) => {
  const dir = temporary(t);
  const make = () => new Subagents(dir, () => {});
  const settings = make();
  assert.equal(settings.settings.officeMcp, true);
  assert.equal(settings.set({ officeMcp: false }, 'test'), undefined);
  assert.equal(make().state().officeMcp, false);
  settings.set({ on: false }, 'old client');
  assert.equal(settings.settings.officeMcp, false, 'an older client does not turn MCP back on');
});

test('the Droid profile merges only office-owned config and removes it when off', async (t) => {
  const dir = temporary(t);
  const file = path.join(dir, '.factory', 'mcp.json');
  mkdirSync(path.dirname(file));
  const other = { type: 'http', url: 'https://example.com/mcp', headers: { 'x-test': 'kept' } };
  writeFileSync(file, JSON.stringify({ custom: 'kept', mcpServers: { other } }));
  const dead = async () => false;
  assert.equal(await syncOfficeMcpConnection(file, 'http://127.0.0.1:1234', true, dead), undefined);
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  const config = read();
  assert.equal(config.custom, 'kept');
  assert.deepEqual(config.mcpServers.other, other);
  assert.deepEqual(config.mcpServers['droid-office'], {
    type: 'http',
    url: 'http://127.0.0.1:1234/office/mcp',
    oauth: false,
    headers: { Authorization: `Bearer \${DROID_OFFICE_HOOK_TOKEN}`, [OFFICE_MCP_WORKER_HEADER]: `\${DROID_OFFICE_WORKER_ID}`, [OFFICE_MCP_OFFICE_HEADER]: `\${DROID_OFFICE_HOOK_URL}` },
  });
  const before = readFileSync(file, 'utf8');
  assert.equal(await syncOfficeMcpConnection(file, 'http://127.0.0.1:1234', true, dead), undefined);
  assert.equal(readFileSync(file, 'utf8'), before);
  // Another office that still answers keeps the entry, and routes this office's workers here.
  const probed: string[] = [];
  const alive = async (url: string) => {
    probed.push(url);
    return true;
  };
  assert.equal(await syncOfficeMcpConnection(file, 'http://127.0.0.1:5678', true, alive), undefined);
  assert.deepEqual(probed, ['http://127.0.0.1:1234/office/mcp']);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(await syncOfficeMcpConnection(file, 'http://127.0.0.1:5678', false, alive), undefined);
  assert.equal(readFileSync(file, 'utf8'), before, "turning Office MCP off elsewhere leaves this office's entry");
  // Once that office is gone, the next one takes the entry over.
  assert.equal(await syncOfficeMcpConnection(file, 'http://127.0.0.1:5678', true, dead), undefined);
  assert.equal(read().mcpServers['droid-office'].url, 'http://127.0.0.1:5678/office/mcp');
  assert.equal(await syncOfficeMcpConnection(file, 'http://127.0.0.1:5678', false, dead), undefined);
  assert.deepEqual(read(), { custom: 'kept', mcpServers: { other } });
  // An entry written before routing existed is replaced even if its office still answers.
  writeFileSync(
    file,
    JSON.stringify({ mcpServers: { 'droid-office': { type: 'http', url: 'http://127.0.0.1:1234/office/mcp', headers: { Authorization: `Bearer \${DROID_OFFICE_HOOK_TOKEN}`, [OFFICE_MCP_WORKER_HEADER]: `\${DROID_OFFICE_WORKER_ID}` } } } }),
  );
  assert.equal(await syncOfficeMcpConnection(file, 'http://127.0.0.1:5678', true, alive), undefined);
  assert.equal(read().mcpServers['droid-office'].url, 'http://127.0.0.1:5678/office/mcp');
});

test('profile creation, absent config and malformed or foreign entries do not clobber user files', async (t) => {
  const dir = temporary(t);
  const file = path.join(dir, 'factory', 'mcp.json');
  assert.equal(await syncOfficeMcpConnection(undefined, 'http://127.0.0.1:1234', true), undefined);
  assert.equal(await syncOfficeMcpConnection(file, 'http://127.0.0.1:1234', false), undefined);
  assert.equal(existsSync(file), false);
  assert.equal(await syncOfficeMcpConnection(file, 'http://127.0.0.1:1234', true), undefined);
  for (const content of ['{broken', '[]', '{"mcpServers":[]}', JSON.stringify({ mcpServers: { 'droid-office': { type: 'stdio', command: 'my-server' } } })]) {
    writeFileSync(file, content);
    assert.match((await syncOfficeMcpConnection(file, 'http://127.0.0.1:1234', true)) ?? '', /unchanged/);
    assert.equal(readFileSync(file, 'utf8'), content);
    assert.match((await syncOfficeMcpConnection(file, 'http://127.0.0.1:1234', false)) ?? '', /unchanged/);
    assert.equal(readFileSync(file, 'utf8'), content);
  }
  const blocked = path.join(dir, 'file');
  writeFileSync(blocked, 'not a folder');
  assert.match((await syncOfficeMcpConnection(path.join(blocked, 'mcp.json'), 'http://127.0.0.1:1234', true)) ?? '', /could not/);
});
