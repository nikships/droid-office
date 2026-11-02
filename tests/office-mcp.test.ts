import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { createOfficeMcp, OFFICE_MCP_OFFICE_HEADER, OFFICE_MCP_PATH, OFFICE_MCP_WORKER_HEADER, officeAccess, officeAnswers, officeResult, syncOfficeMcpConnection, type OfficeMcpFloor } from '../src/server/office-mcp/index.js';
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

async function rig(t: { after(fn: () => void | Promise<void>): void }, probes = true) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-mcp-'));
  const settings = { ...SUBAGENT_DEFAULTS };
  const people = new Map([
    ['lead', worker('lead')],
    ['sub', worker('sub', { lead: 'lead', deskId: 'desk-2', worktree: { path: '.droid-office/worktrees/sub', branch: 'office/sub', base: 'abc' } })],
    ['shell', worker('shell', { kind: 'shell' })],
    ['guest', worker('guest', { guest: { pid: 1, cmd: 'droid' } as WorkerInfo['guest'] })],
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
  office = createOfficeMcp({ hookUrl: origin, settings: () => settings, floor: (id) => (people.has(id) ? floor : undefined) });
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
  return { dir, settings, people, tokens, connect, url, origin, office };
}

test('the HTTP MCP refuses missing, mismatched and non-agent identities', async (t) => {
  const r = await rig(t);
  await assert.rejects(r.connect(), /Office MCP requires/);
  await assert.rejects(r.connect('lead', 'test-token-sub'), /Office MCP requires/);
  await assert.rejects(r.connect('missing', 'test-token-lead'), /Office MCP requires/);
  for (const id of ['shell', 'guest', 'cloud']) await assert.rejects(r.connect(id), /Office MCP requires/);
  const response = await fetch(r.url, { method: 'POST', headers: { [OFFICE_MCP_WORKER_HEADER]: 'lead', Authorization: 'test-token-lead' } });
  assert.equal(response.status, 401, 'a bare token is not a bearer credential');
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

test('the server registers office tools without test probes', async (t) => {
  const r = await rig(t, false);
  const client = await r.connect('lead');
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes('office_whoami'));
  assert.ok(names.every((name) => !name.startsWith('test_')));
});

test('a real HTTP MCP client reads office identity and server instructions', async (t) => {
  const r = await rig(t);
  const lead = await r.connect('lead');
  assert.equal(lead.getServerVersion()?.name, 'droid-office');
  assert.match(lead.getInstructions() ?? '', /owner's instructions outrank/);
  assert.match(lead.getInstructions() ?? '', /Do not block waiting/);
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
  assert.throws(() => r.office.tool({ name: 'test_error', description: 'Duplicate', inputSchema: z.object({}) }, officeAccess.worker, () => officeResult('no')), /Duplicate/);
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
