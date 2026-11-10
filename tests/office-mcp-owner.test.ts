import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import headless from '@xterm/headless';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { RemoteWorkers } from '../src/server/remote-workers.js';
import { RemoteOffice, type RemoteFloor } from '../src/server/remote-office.js';
import { remoteMcpListener } from '../src/server/remote-mcp-http.js';
import { createOfficeMcp, type OfficeMcpFloor } from '../src/server/office-mcp/index.js';
import { OWNER_ACTIONS, findWorker, pickFloor, roster, type OwnerAction, type OwnerFloor, type OwnerOffice, type OwnerReply } from '../src/server/office-mcp/owner.js';
import { OWNER_TOOLS } from '../src/server/office-mcp/owner-tools.js';
import { z } from 'zod';
import { WhiteboardStore } from '../src/server/whiteboard.js';
import { plainTail } from '../src/server/history.js';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { SUBAGENT_DEFAULTS, type ServerMsg, type WorkerInfo } from '../src/shared/protocol.js';
import { DESKS } from '../src/shared/layout.js';

const proxyFetch: typeof fetch = async (input, init) => {
  const req = new Request(input, init);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.from(await req.arrayBuffer());
  return new Promise((resolve, reject) => {
    const outgoing = request(req.url, { method: req.method, headers: Object.fromEntries(req.headers), signal: req.signal }, (incoming) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const status = incoming.statusCode ?? 500;
      resolve(new Response([204, 205, 304].includes(status) ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), { status, headers }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
};

const worker = (id: string, name: string, extra: Partial<WorkerInfo> = {}): WorkerInfo => ({
  id,
  name,
  kind: 'agent',
  deskId: 'desk-1',
  color: '#888',
  status: 'idle',
  acked: true,
  createdAt: 1,
  createdBy: 'Owner',
  cols: 100,
  rows: 30,
  open: false,
  ...extra,
});

const building = (): OwnerFloor[] => [
  { id: 'f-app', name: 'app', workers: [worker('grok', 'Grok', { remote: true, deskId: 'desk-1' }), worker('b-1', 'Byte', { lead: 'grok', deskId: 'desk-2', createdAt: 2 })] },
  {
    id: 'f-api',
    name: 'api',
    workers: [
      worker('pixel', 'Pixel', { deskId: 'desk-3', task: { name: 'Fix login', summary: 'The session expires' }, activeModel: 'opus', activeEffort: 'high', worktree: { path: 'w', branch: 'office/pixel', base: 'abc' } }),
      worker('b-2', 'Byte', { deskId: 'desk-4' }),
    ],
  },
  { id: 'f-docs', name: 'docs', workers: [worker('sh', 'Sandy 🐚', { kind: 'shell', deskId: 'desk-5' })] },
];

test('the building roster spans floors in elevator order, with desks, tasks, models and whose subagent each is', () => {
  const all = roster(building(), 'grok');
  assert.deepEqual(
    all.map((w) => [w.name, w.floorNumber, w.floor]),
    [
      ['Grok', 1, 'f-app'],
      ['Byte', 1, 'f-app'],
      ['Pixel', 2, 'f-api'],
      ['Byte', 2, 'f-api'],
      ['Sandy 🐚', 3, 'f-docs'],
    ],
  );
  const [grok, byte, pixel] = all;
  assert.equal(grok.you, true);
  assert.equal(grok.remote, true);
  assert.deepEqual([byte.yours, byte.lead], [true, { id: 'grok', name: 'Grok' }]);
  assert.equal(pixel.yours, false);
  assert.equal(pixel.task, 'Fix login: The session expires');
  assert.deepEqual([pixel.model, pixel.effort, pixel.worktree], ['opus', 'high', { branch: 'office/pixel' }]);
  assert.equal(pixel.desk, DESKS.find((d) => d.id === 'desk-3')?.label ?? 'desk-3');
  assert.deepEqual(
    roster(building(), 'grok', 'f-api').map((w) => w.id),
    ['pixel', 'b-2'],
  );
});

test('floors resolve by id, elevator number or name; workers by id or name, refusing ambiguity and unknown names', () => {
  const floors = building();
  for (const ref of ['f-api', '2', 'API']) assert.deepEqual(pickFloor(floors, ref), { floor: floors[1], number: 2 });
  assert.match(pickFloor(floors, '4') as string, /No floor 4\. Floors: 1 app \(f-app\), 2 api \(f-api\), 3 docs \(f-docs\)/);
  const pixel = findWorker(floors, 'pixel');
  assert.ok(typeof pixel !== 'string');
  assert.deepEqual([pixel.worker.id, pixel.number], ['pixel', 2]);
  assert.match(findWorker(floors, 'Byte') as string, /several floors \(1 app: b-1, 2 api: b-2\)/);
  assert.equal((findWorker(floors, 'Byte', '2') as { worker: WorkerInfo }).worker.id, 'b-2');
  assert.equal((findWorker(floors, 'B-1') as { worker: WorkerInfo }).worker.id, 'b-1', 'an id works case-insensitively');
  assert.equal((findWorker(floors, 'sandy') as { worker: WorkerInfo }).worker.id, 'sh', 'a shell answers to its name without the shell mark');
  assert.match(findWorker(floors, 'Nobody') as string, /No worker called Nobody in the building/);
  assert.match(findWorker(floors, 'Pixel', 'app') as string, /No worker called Pixel on that floor/);
  const repeated = floors.map((f) => ({ ...f, name: 'same' }));
  assert.match(pickFloor(repeated, 'same') as string, /Several floors are called same/);
  assert.deepEqual(pickFloor(repeated, '2'), { floor: repeated[1], number: 2 });
  const numericName = floors.map((f, i) => ({ ...f, name: i === 2 ? '1' : f.name }));
  assert.match(pickFloor(numericName, '1') as string, /both an elevator number/);
  assert.deepEqual(pickFloor(numericName, 'f-docs'), { floor: numericName[2], number: 3 });
});

/** An external worker on a real Office MCP listener, with the owner's window faked so each call is recorded. */
async function remoteRig(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'owner-mcp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new RemoteWorkers(dir);
  const people = new Map<string, WorkerInfo>();
  const whiteboard = new WhiteboardStore(dir);
  t.after(() => whiteboard.stop());
  const team = { handle: async () => ({ status: 200, body: { canHire: true, subagents: 0, max: 4, wakeLead: true } }), cannotHire: () => undefined, hasNews: () => false, inbox: () => [], onWorkerGone() {} };
  const visits = { handle: () => ({ status: 403, body: { error: 'off' } }), cannotVisit: () => 'Visits are off', onWorkerGone() {} };
  const floor = {
    id: 'f-app',
    dir,
    def: { name: 'app' },
    workers: {
      list: () => [...people.values()],
      get: (id: string) => people.get(id),
      authenticate: () => undefined,
      remoteSeat: () => DESKS.find((d) => ![...people.values()].some((w) => w.deskId === d.id))!.id,
      attachRemote: (w: WorkerInfo) => void people.set(w.id, w),
      detachRemote: (id: string) => void people.delete(id),
      releaseRemoteLead() {},
      remoteStatus() {},
    },
    team,
    visits,
    whiteboard,
  } as unknown as RemoteFloor;
  const office = new RemoteOffice(store, () => [floor]);
  const grok = office.add('Grok');
  people.set('b-1', worker('b-1', 'Byte', { lead: grok.worker.id, deskId: 'desk-2', createdAt: Number.MAX_SAFE_INTEGER }));
  const calls: { msg: Record<string, unknown>; floor?: string; by: string }[] = [];
  const floors = () => [{ id: 'f-app', name: 'app', workers: [...people.values()] }, ...building().slice(1)];
  const answers: Record<string, (msg: Record<string, unknown>) => OwnerReply> = {};
  const owner: OwnerOffice = {
    floors,
    mission: () => [{ worker: grok.worker, team: [] }],
    tail: (id, lines, floorId) => (id === 'office-shell' ? (floorId === 'f-api' ? 'npm test\nok' : undefined) : id === 'pixel' ? `last ${lines} lines of Pixel` : undefined),
    act: async (by, msg, opts) => {
      calls.push({ msg, floor: opts?.floor, by: by.name });
      return answers[msg.t]?.(msg) ?? { notes: [] };
    },
  };
  const hostname = 'office.example.ts.net';
  const server = remoteMcpListener({
    remote: office,
    owner,
    remoteTransport: { hostname: () => hostname, owner: () => undefined },
    settings: () => ({ ...SUBAGENT_DEFAULTS }),
    floor: (id) => {
      const f = office.floor(id);
      return f ? ({ ...f, name: f.def.name } as unknown as OfficeMcpFloor) : undefined;
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const client = new Client({ name: 'owner-test', version: '1' });
  t.after(() => client.close());
  const url = new URL('/office/mcp', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await client.connect(new StreamableHTTPClientTransport(url, { fetch: proxyFetch, requestInit: { headers: { host: `${hostname}:8443`, Authorization: `Bearer ${grok.token}`, 'x-droid-office-worker-id': grok.worker.id } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: r.isError === true, text: (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n'), data: r.structuredContent };
  };
  return { client, call, calls, answers, owner, grok: grok.worker, people, dir };
}

test('an external worker sees the whole building and every worker’s terminal through the Office MCP', async (t) => {
  const r = await remoteRig(t);
  const names = (await r.client.listTools()).tools.map((x) => x.name);
  for (const name of ['office_roster', 'office_look', 'office_send_home', ...OWNER_TOOLS.map((tool) => tool.name)]) assert.ok(names.includes(name), name);
  assert.ok(!names.includes('office_owner'), 'no untyped owner gateway');
  assert.match(r.client.getInstructions()!, /owner-level access/);
  const who = await r.call('office_whoami');
  assert.match(who.text, /Owner access: yes/);
  assert.doesNotMatch(who.text, /office_owner/);
  assert.equal(who.data?.ownerAccess, true);

  const all = await r.call('office_roster');
  assert.equal(all.error, false, all.text);
  assert.match(all.text, /^Floor 1: app \(f-app\), 1 worker\n {2}Byte \(b-1\) \[your subagent\]/);
  assert.match(all.text, /Floor 2: api \(f-api\), 2 workers\n {2}Pixel \(pixel\), .*, idle, opus high\n {4}Task: Fix login: The session expires/);
  assert.match(all.text, /Floor 3: docs \(f-docs\), 1 worker\n {2}Sandy 🐚 \(sh\) \[shell\]/);
  assert.match(all.text, /\n\nMission Control\n {2}Grok \(.+\) \[you, external\], Mission Control, offline/);
  assert.equal((all.data!.workers as unknown[]).length, 4);
  assert.equal((all.data!.mission as unknown[]).length, 1);
  const one = await r.call('office_roster', { floor: '3' });
  assert.deepEqual(
    (one.data!.workers as { id: string }[]).map((w) => w.id),
    ['sh'],
  );
  assert.match((await r.call('office_roster', { floor: 'attic' })).text, /No floor attic/);

  assert.match((await r.call('office_look', { name: 'Pixel', lines: 5 })).text, /Pixel on floor 2 \(api\):\n\nlast 5 lines of Pixel/);
  assert.match((await r.call('office_look', { name: 'office-shell', floor: 'api' })).text, /api's shell:\n\nnpm test/);
  assert.equal((await r.call('office_look', { name: 'Byte' })).error, true, 'a repeated name needs a floor or id');
  assert.equal(r.calls.length, 0, 'reading the building takes no owner action');
});

test('Mission Control is discoverable before a session and building agents cannot control each other', async (t) => {
  const r = await remoteRig(t);
  const bot = worker('other-bot', 'Orchestrator', { remote: true, deskId: '' });
  const dormant = worker('orchestrator', 'Orchestrator', { deskId: '', activity: 'Ready for its first prompt' });
  // Put the colliding bot name first: an exact id must still win over that name.
  r.owner.mission = () => [
    { worker: bot, team: [] },
    { worker: dormant, team: [] },
    { worker: r.grok, team: [] },
  ];
  const roster = await r.call('office_roster');
  assert.match(roster.text, /Orchestrator \(orchestrator\) \[orchestrator\]/);
  assert.match(roster.text, /Ready for its first prompt/);
  const look = await r.call('office_look', { name: 'orchestrator' });
  assert.equal(look.error, true);
  assert.match(look.text, /has no terminal yet/, 'the fixed id never resolves to the bot with the same name');
  for (const id of ['orchestrator', 'other-bot', r.grok.id]) {
    for (const [name, args] of [
      ['office_worker_prompt', { workerId: id, prompt: 'Do something' }],
      ['office_worker_interrupt', { workerId: id }],
      ['office_send_home', { name: id }],
      ['office_worker_answer', { workerId: id, menu: { choices: [{ number: 1, label: 'Yes' }], freeText: false }, choice: 1 }],
    ] as const) {
      const result = await r.call(name, args);
      assert.equal(result.error, true, name);
      assert.match(result.text, /building agent in Mission Control/, name);
    }
  }
  assert.equal(r.calls.length, 0, 'no refused action reached the owner handler');
  assert.equal((await r.call('office_worker_thread', { workerId: 'orchestrator' })).error, false);
  assert.equal(r.calls[0].msg.workerId, 'orchestrator');
  assert.equal((await r.call('office_worker_thread', { workerId: 'other-bot' })).error, true);
});

test('office_look bounds worker and boss-shell output while preserving the latest text', async (t) => {
  const r = await remoteRig(t);
  const long = `${'older\n'.repeat(10_000)}latest output`;
  r.owner.tail = () => long;
  for (const args of [
    { name: 'Pixel', lines: 400 },
    { name: 'office-shell', floor: 'api', lines: 400 },
  ]) {
    const result = await r.call('office_look', args);
    assert.equal(result.error, false);
    assert.equal(result.data?.text, long.slice(-48_000));
    assert.equal(result.data?.truncated, true);
    assert.match(result.text, /\[Truncated: latest 48,000 characters\]/);
    assert.ok(result.text.endsWith('latest output'));
    assert.ok(result.text.length < 48_100);
  }
});

test('office_send_home sends anyone home through the owner’s path, keeping the worktree unless asked', async (t) => {
  const r = await remoteRig(t);
  r.answers['worker.worktree'] = (msg) => ({ notes: [], reply: { t: 'worker.worktree', workerId: String(msg.workerId), state: { exists: true, dirty: 1, ahead: 3, unpushed: 2 } } as ServerMsg });
  r.answers['worker.kill'] = (msg) => (msg.workerId === 'ghost' ? { error: 'No such worker', notes: [] } : { notes: [`Grok sent ${msg.workerId === 'pixel' ? 'Pixel' : 'Sandy 🐚'} home`, "Kept Pixel's worktree and branch office/pixel"] });

  const sent = await r.call('office_send_home', { name: 'pixel' });
  assert.equal(sent.error, false, sent.text);
  assert.deepEqual(
    r.calls.map((c) => [c.msg.t, c.msg.workerId, c.msg.cleanup, c.by]),
    [
      ['worker.worktree', 'pixel', undefined, 'Grok'],
      ['worker.kill', 'pixel', 'keep', 'Grok'],
    ],
    'cleanup defaults to keep, after reading what the worktree holds',
  );
  assert.match(sent.text, /Sent Pixel home from floor 2 \(api\), cleanup keep\.\nIts worktree had 1 uncommitted file and 2 commits on no remote\.\nGrok sent Pixel home/);
  assert.deepEqual((sent.data as { worktree: { unpushed: number } }).worktree.unpushed, 2);

  r.calls.length = 0;
  assert.equal((await r.call('office_send_home', { name: 'Sandy', cleanup: 'all' })).error, false);
  assert.deepEqual(
    r.calls.map((c) => [c.msg.t, c.msg.cleanup]),
    [['worker.kill', 'all']],
    'a worker without a worktree has nothing to inspect; all is passed only when asked',
  );

  r.calls.length = 0;
  const unknown = await r.call('office_send_home', { name: 'Nobody' });
  assert.equal(unknown.error, true);
  assert.match(unknown.text, /No worker called Nobody in the building\. office_roster lists everyone/);
  assert.equal(r.calls.length, 0, 'an unknown name sends nothing');
  assert.match((await r.call('office_send_home', { name: 'Byte' })).text, /several floors/);
  assert.equal((await r.call('office_send_home', { name: 'Pixel', cleanup: 'everything' })).error, true, 'only keep, worktree or all');

  const self = await r.call('office_send_home', { name: r.grok.id });
  assert.equal(self.error, true, 'a building agent cannot send itself home through MCP');
  assert.match(self.text, /building agent in Mission Control/);
  assert.match(self.text, /office_send_home is not available/);
  assert.notEqual(r.calls.at(-1)?.msg.workerId, r.grok.id);
});

test('focused owner tools report refusal, pending, unconfirmed and bounded replies', async (t) => {
  const r = await remoteRig(t);
  r.answers['worker.prompt'] = () => ({ error: 'No such worker', notes: [] });
  r.answers['worker.spawn'] = () => ({ pending: true, notes: [] });
  r.answers['worker.interrupt'] = () => ({ unconfirmed: true, notes: [] });
  r.answers['thread.read'] = () => ({ notes: [], reply: { t: 'thread.snapshot', workerId: 'b-1', text: 'x'.repeat(70_000) } as unknown as ServerMsg });
  const refused = await r.call('office_worker_prompt', { workerId: 'pixel', prompt: 'hi' });
  assert.equal(refused.error, true);
  assert.match(refused.text, /office_worker_prompt refused: No such worker/);
  assert.match((await r.call('office_worker_spawn', { floor: 'app' })).text, /started; no outcome yet/);
  const silent = await r.call('office_worker_interrupt', { workerId: 'pixel' });
  assert.equal(silent.error, false);
  assert.match(silent.text, /neither refused nor confirmed/, 'silence is not reported as done');
  assert.equal(silent.data?.status, 'unconfirmed');
  const big = await r.call('office_worker_thread', { workerId: 'b-1' });
  assert.match(big.text, /\[Truncated: \d+ more characters\]$/);
  assert.equal(r.calls.length, 4);
  assert.equal((await r.call('office_owner', { action: 'worker.spawn', args: {} })).error, true, 'old gateway cannot be called');
  assert.equal(r.calls.length, 4);
});

// Tool inputs only: no external service is called. The rig records the message sent to the owner bridge.
const actionInputs: Record<Exclude<OwnerAction, 'worker.kill' | 'worker.worktree'>, Record<string, unknown>> = {
  'worker.spawn': { floor: 'app' },
  'worker.prompt': { workerId: 'pixel', prompt: 'Continue' },
  'worker.answer': {
    workerId: 'pixel',
    menu: {
      choices: [
        { number: 1, label: 'Yes' },
        { number: 2, label: 'No' },
      ],
      freeText: false,
    },
    choice: 1,
  },
  'worker.interrupt': { workerId: 'pixel' },
  'thread.read': { workerId: 'pixel' },
};

test('every retained owner tool has a strict self-contained schema', async (t) => {
  const r = await remoteRig(t);
  assert.deepEqual(new Set([...OWNER_TOOLS.map((tool) => tool.action), 'worker.kill', 'worker.worktree']), new Set(OWNER_ACTIONS));
  assert.equal(new Set(OWNER_TOOLS.map((tool) => tool.name)).size, OWNER_TOOLS.length);
  const listed = (await r.client.listTools()).tools;
  for (const entry of OWNER_TOOLS) {
    const definition = listed.find((tool) => tool.name === entry.name)!;
    assert.ok(definition, entry.name);
    assert.equal(definition.inputSchema.additionalProperties, false, entry.name);
    assert.ok(!('args' in (definition.inputSchema.properties ?? {})), entry.name);
    assert.ok(!('action' in (definition.inputSchema.properties ?? {})), entry.name);
    assert.doesNotMatch(definition.description ?? '', /protocol\.ts|ClientMsg/);
    const args = actionInputs[entry.action as Exclude<OwnerAction, 'worker.kill' | 'worker.worktree'>];
    const result = await r.call(entry.name, args);
    assert.equal(result.error, false, `${entry.name}: ${result.text}`);
    const sent = r.calls.at(-1)!;
    assert.equal(sent.msg.t, entry.action, entry.name);
    assert.equal(sent.by, 'Grok');
    if (entry.scope === 'worker') assert.equal(sent.floor, 'f-api', entry.name);
    if (entry.scope === 'floor') assert.equal(sent.floor, 'f-app', entry.name);
    const count = r.calls.length;
    assert.equal((await r.call(entry.name, { ...args, unexpected: true })).error, true, entry.name);
    assert.equal(r.calls.length, count, 'unknown fields cannot reach the bridge');
  }
  assert.equal(r.calls.length, OWNER_TOOLS.length);
  // Ensure zod conversion used by MCP includes nested fields rather than unconstrained dictionaries.
  for (const entry of OWNER_TOOLS) assert.doesNotThrow(() => z.toJSONSchema(entry.inputSchema, { io: 'input' }));
});

test('focused tools resolve names, bind target floors and generate internal request ids', async (t) => {
  const r = await remoteRig(t);
  await r.call('office_worker_prompt', { workerId: 'Pixel', floor: '2', prompt: 'Continue' });
  assert.deepEqual(r.calls.at(-1), { by: 'Grok', floor: 'f-api', msg: { t: 'worker.prompt', workerId: 'pixel', prompt: 'Continue', queue: false } });
  await r.call('office_worker_thread', { workerId: 'Pixel', before: 10 });
  assert.equal(r.calls.at(-1)?.msg.before, 10);
  assert.equal(typeof r.calls.at(-1)?.msg.request, 'string');
  const count = r.calls.length;
  for (const [name, args] of [
    ['office_worker_prompt', { workerId: 'Byte', prompt: 'Continue' }],
    ['office_worker_prompt', { workerId: 'Pixel', floor: 'app', prompt: 'Continue' }],
    ['office_worker_prompt', { workerId: 'Nobody', prompt: 'Continue' }],
    ['office_worker_spawn', { floor: 'missing' }],
  ] as const)
    assert.equal((await r.call(name, args)).error, true, name);
  assert.equal(r.calls.length, count, 'ambiguous, unknown or mismatched targets cannot act');
});

test('nested and conditional arguments are rejected before owner actions', async (t) => {
  const r = await remoteRig(t);
  const invalid: [string, Record<string, unknown>][] = [
    ['office_worker_thread', { workerId: 'pixel', before: -1 }],
    ['office_worker_spawn', { kind: 'cloud' }],
    ['office_worker_spawn', { kind: 'agent', cloud: { computerId: 'one' } }],
    ['office_worker_spawn', { kind: 'cloud', cloud: { computerId: 'one', environmentId: 'two' } }],
    ['office_worker_spawn', { kind: 'cloud', cloud: { computerId: 'one', extra: true } }],
    ['office_worker_answer', { ...actionInputs['worker.answer'], text: 'Yes' }],
    ['office_worker_answer', { workerId: 'pixel', menu: { choices: [], freeText: false }, choice: 1 }],
    ['office_worker_spawn', { model: 'bad model' }],
    ['office_worker_spawn', { model: 'x'.repeat(257) }],
    ['office_worker_spawn', { images: ['not-an-upload-id'] }],
    ['office_worker_spawn', { images: Array(11).fill('0123456789abcdef') }],
  ];
  for (const [name, args] of invalid) assert.equal((await r.call(name, args)).error, true, name);
  assert.equal(r.calls.length, 0);
});

test('send-home preserves cloud deletion capability and never claims uncertain dismissal succeeded', async (t) => {
  const r = await remoteRig(t);
  await r.call('office_send_home', { name: 'Sandy', deleteSession: true });
  assert.equal(r.calls.at(-1)?.msg.deleteSession, true);
  r.answers['worker.kill'] = () => ({ notes: [], unconfirmed: true });
  const uncertain = await r.call('office_send_home', { name: 'Sandy' });
  assert.equal(uncertain.data?.status, 'unconfirmed');
  assert.doesNotMatch(uncertain.text, /Sent .* home|key no longer works/);
  r.answers['worker.kill'] = () => ({ notes: [], pending: true });
  assert.equal((await r.call('office_send_home', { name: 'Sandy' })).data?.status, 'pending');
  r.answers['worker.worktree'] = () => ({ notes: [], reply: { t: 'worker.worktree', workerId: 'pixel', state: { exists: true, dirty: 2, ahead: 3, unpushed: 1 } } });
  for (const outcome of ['pending', 'unconfirmed'] as const) {
    r.answers['worker.kill'] = () => ({ notes: [], [outcome]: true });
    const result = await r.call('office_send_home', { name: 'Pixel', cleanup: 'all' });
    assert.equal(result.data?.status, outcome);
    assert.equal(result.data?.worker, 'pixel');
    assert.equal(result.data?.floor, 'f-api');
    assert.equal(result.data?.cleanup, 'all');
    assert.equal(result.data?.deleteSession, false);
    assert.ok(result.data);
    assert.equal((result.data.worktree as { dirty: number }).dirty, 2);
    assert.match(result.text, /2 uncommitted files and 1 commit on no remote/);
    assert.doesNotMatch(result.text, /^Sent/);
  }
});

test('local workers never get owner access', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'owner-local-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const whiteboard = new WhiteboardStore(dir);
  t.after(() => whiteboard.stop());
  const me = worker('local', 'Ada');
  const acted: string[] = [];
  const owner: OwnerOffice = { floors: building, tail: () => 'x', act: async (_by, msg) => (acted.push(msg.t), { notes: [] }) };
  const floor = {
    id: 'f-app',
    name: 'app',
    dir,
    workers: { authenticate: (id: string, token: string) => (id === 'local' && token === 'tok' ? me : undefined), get: (id: string) => (id === 'local' ? me : undefined), list: () => [me] },
    team: { handle: async () => ({ status: 200, body: {} }), cannotHire: () => 'no', hasNews: () => false },
    visits: { handle: () => ({ status: 403, body: {} }), cannotVisit: () => 'off' },
    whiteboard,
  } as unknown as OfficeMcpFloor;
  const mcp = createOfficeMcp({ owner, floor: () => floor, settings: () => ({ ...SUBAGENT_DEFAULTS }) });
  const server = createServer((req, res) => void mcp.handle(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const client = new Client({ name: 'local-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/office/mcp`), { requestInit: { headers: { Authorization: 'Bearer tok', 'x-droid-office-worker-id': 'local' } } }));
  const names = (await client.listTools()).tools.map((x) => x.name);
  for (const name of ['office_roster', 'office_look', 'office_send_home', ...OWNER_TOOLS.map((tool) => tool.name)]) {
    assert.ok(!names.includes(name), name);
    const result = await client.callTool({ name, arguments: {} });
    assert.equal(result.isError, true, name);
    assert.match(JSON.stringify(result.content), /Only building agents have owner access/, name);
  }
  const guessed = await client.callTool({ name: 'office_send_home', arguments: { name: 'Pixel' } });
  assert.equal(guessed.isError, true);
  assert.match(JSON.stringify(guessed.content), /Only building agents have owner access/);
  assert.doesNotMatch(client.getInstructions()!, /owner-level access/);
  assert.deepEqual(acted, []);
});

test('owner actions from an external worker run through the owner’s own handler on any floor, attributed to it', { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'owner-office-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  for (const d of [project, home]) {
    mkdirSync(d, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: d });
  }
  const cfg = loadConfig([project, '--home', home, '--projects', root, '--weather', 'clear', '--host', '127.0.0.1']);
  cfg.port = 0;
  const office = await startServer(cfg);
  t.after(async () => {
    const closed = once(office.server, 'close');
    office.shutdown();
    await closed;
  });
  const grok = worker('remote-grok', 'Grok', { remote: true, color: '#123456' });
  const first = office.owner.floors()[0];
  const base = `ws://127.0.0.1:${(office.server.address() as AddressInfo).port}/ws?name=Owner&floor=${first.id}`;
  const msgs: ServerMsg[] = [];
  const ws = new WebSocket(base, { origin: base.replace('ws:', 'http:').split('/ws')[0] });
  t.after(() => ws.terminate());
  ws.on('message', (raw) => msgs.push(JSON.parse(String(raw))));
  await once(ws, 'open');

  // Floor controls remain available in the owner's UI, not through remote-bot MCP.
  const added = new Promise<void>((resolve) =>
    ws.on('message', (raw) => {
      if ((JSON.parse(String(raw)) as ServerMsg).t === 'floor.added') resolve();
    }),
  );
  ws.send(JSON.stringify({ t: 'floor.add', dir: home }));
  await added;
  const second = office.owner.floors()[1];
  assert.ok(second, 'the project floor and the added one');

  // A shell on the second floor, where the owner's window isn't.
  const hired = await office.owner.act(grok, { t: 'worker.spawn', deskId: 'auto', kind: 'shell' }, { floor: second.id });
  assert.equal(hired.error, undefined, JSON.stringify(hired));
  assert.ok(hired.workerId);
  assert.deepEqual(hired.notes, ['Grok opened a shell at a desk']);
  const shell = office.owner.floors()[1].workers.find((w) => w.id === hired.workerId)!;
  assert.ok(shell, 'it sits on the floor it was hired for');

  const missing = await office.owner.act(grok, { t: 'worker.kill', workerId: 'nobody', cleanup: 'keep' });
  assert.equal(missing.error, 'No such worker');
  const interrupted = await office.owner.act(grok, { t: 'worker.interrupt', workerId: 'nobody' });
  assert.equal(interrupted.error, 'No such worker');
  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await office.owner.act(grok, { t: 'thread.read', workerId: shell.id, request: 'r' }, { signal: aborted.signal })).pending, true, 'an already cancelled call returns at once');
  const thread = await office.owner.act(grok, { t: 'thread.read', workerId: shell.id, request: 'r' });
  assert.equal(thread.reply?.t, 'thread.snapshot', 'an action with an answer gets it back');
  assert.equal(thread.unconfirmed, undefined, 'its answer confirms it, including a refused shell thread');

  const sent = await office.owner.act(grok, { t: 'worker.kill', workerId: shell.id, cleanup: 'keep' });
  assert.equal(sent.error, undefined, JSON.stringify(sent));
  assert.ok(sent.notes.includes(`Grok sent ${shell.name} home`), sent.notes.join('; '));
  assert.equal(
    office.owner.floors().some((f) => f.workers.some((w) => w.id === shell.id)),
    false,
  );
  assert.equal(
    msgs.some((m) => m.t === 'toast' && m.text === `Grok sent ${shell.name} home`),
    false,
    'the owner standing on another floor gets that floor’s toasts only',
  );
});

test('office_look text joins the rows a long line wrapped onto', async () => {
  const term = new headless.Terminal({ cols: 10, rows: 5, scrollback: 1000, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write('first\r\n0123456789abcdefghij-end\r\nlast\r\n', resolve));
  assert.equal(plainTail(term, 2), '0123456789abcdefghij-end\nlast');
  assert.equal(plainTail(term, 10), 'first\n0123456789abcdefghij-end\nlast');
  await new Promise<void>((resolve) => term.write(`${'y'.repeat(5000)}\r\n`, resolve));
  const long = plainTail(term, 1);
  assert.equal(long.length, 4001, 'one very long line is capped to its end');
  assert.ok(long.startsWith('…y'));
  term.dispose();
});
