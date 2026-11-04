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
import { findWorker, pickFloor, roster, type OwnerFloor, type OwnerOffice, type OwnerReply } from '../src/server/office-mcp/owner.js';
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
  const grok = office.add('Grok', 'f-app');
  people.set('b-1', worker('b-1', 'Byte', { lead: grok.worker.id, deskId: 'desk-2', createdAt: Number.MAX_SAFE_INTEGER }));
  const calls: { msg: Record<string, unknown>; floor?: string; by: string }[] = [];
  const floors = () => [{ id: 'f-app', name: 'app', workers: [...people.values()] }, ...building().slice(1)];
  const answers: Record<string, (msg: Record<string, unknown>) => OwnerReply> = {};
  const owner: OwnerOffice = {
    floors,
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
  return { client, call, calls, answers, grok: grok.worker, people, dir };
}

test('an external worker sees the whole building and every worker’s terminal through the Office MCP', async (t) => {
  const r = await remoteRig(t);
  const names = (await r.client.listTools()).tools.map((x) => x.name);
  for (const name of ['office_roster', 'office_look', 'office_send_home', 'office_owner']) assert.ok(names.includes(name), name);
  assert.match(r.client.getInstructions()!, /owner's full access/);
  const who = await r.call('office_whoami');
  assert.match(who.text, /Owner access: yes/);
  assert.equal(who.data?.ownerAccess, true);

  const all = await r.call('office_roster');
  assert.equal(all.error, false, all.text);
  assert.match(all.text, /^Floor 1: app \(f-app\), 2 workers\n {2}Grok \(.+\) \[you, external\]/);
  assert.match(all.text, /\n {2}Byte \(b-1\) \[your subagent\]/);
  assert.match(all.text, /Floor 2: api \(f-api\), 2 workers\n {2}Pixel \(pixel\), .*, idle, opus high\n {4}Task: Fix login: The session expires/);
  assert.match(all.text, /Floor 3: docs \(f-docs\), 1 worker\n {2}Sandy 🐚 \(sh\) \[shell\]/);
  assert.equal((all.data!.workers as unknown[]).length, 5);
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
  assert.equal(self.error, false, 'it may send itself home');
  assert.match(self.text, /That was you: your key no longer works/);
  assert.equal(r.calls.at(-1)?.msg.workerId, r.grok.id);
});

test('office_owner forwards any owner action and reports its refusal, reply and toasts', async (t) => {
  const r = await remoteRig(t);
  r.answers['gh.merge'] = () => ({ notes: ['🎉 Grok merged PR #12'], reply: { t: 'gh.merged', number: 12 } as ServerMsg });
  r.answers['worker.prompt'] = () => ({ error: 'No such worker', notes: [] });
  r.answers['pipelines.run'] = () => ({ pending: true, notes: [] });
  r.answers['worker.shoot'] = () => ({ unconfirmed: true, notes: [] });
  r.answers['thread.read'] = () => ({ notes: [], reply: { t: 'thread.snapshot', workerId: 'b-1', text: 'x'.repeat(70_000) } as unknown as ServerMsg });
  const merged = await r.call('office_owner', { action: 'gh.merge', args: { number: 12, method: 'squash', deleteBranch: true }, floor: '2' });
  assert.equal(merged.error, false, merged.text);
  assert.match(merged.text, /gh\.merge: done\.\n🎉 Grok merged PR #12\nReply \(gh\.merged\)/);
  assert.deepEqual(r.calls[0], { msg: { number: 12, method: 'squash', deleteBranch: true, t: 'gh.merge' }, floor: 'f-api', by: 'Grok' });
  const refused = await r.call('office_owner', { action: 'worker.prompt', args: { workerId: 'gone', prompt: 'hi' } });
  assert.equal(refused.error, true);
  assert.match(refused.text, /worker\.prompt refused: No such worker/);
  assert.match((await r.call('office_owner', { action: 'pipelines.run', args: { workflow: 'ci', ref: 'main' } })).text, /started; no outcome yet/);
  const silent = await r.call('office_owner', { action: 'worker.shoot', args: { workerId: 'stale' } });
  assert.equal(silent.error, false);
  assert.match(silent.text, /neither refused nor confirmed/, 'silence is not reported as done');
  const big = await r.call('office_owner', { action: 'thread.read', args: { workerId: 'b-1' } });
  assert.match(big.text, /\[Truncated: \d+ more characters\]$/);
  assert.equal(r.calls.length, 5);
  assert.equal((await r.call('office_owner', { action: 'automation.result', args: {} })).error, true, 'only the listed owner actions');
  assert.equal((await r.call('office_owner', { action: 'gh.merge', floor: 'attic' })).error, true);
  assert.equal(r.calls.length, 5);
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
  for (const name of ['office_roster', 'office_look', 'office_send_home', 'office_owner']) assert.ok(!names.includes(name), name);
  const guessed = await client.callTool({ name: 'office_send_home', arguments: { name: 'Pixel' } });
  assert.equal(guessed.isError, true);
  assert.match(JSON.stringify(guessed.content), /Only external workers have owner access/);
  assert.doesNotMatch(client.getInstructions()!, /owner's full access/);
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
  // A second floor, added the way the owner's elevator panel adds one.
  const added = await office.owner.act(grok, { t: 'floor.add', dir: home });
  assert.equal(added.reply?.t, 'floor.added');
  assert.ok(
    added.notes.some((n) => n.includes('added by Grok')),
    added.notes.join('; '),
  );
  const [first, second] = office.owner.floors();
  assert.ok(second, 'the project floor and the added one');
  const base = `ws://127.0.0.1:${(office.server.address() as AddressInfo).port}/ws?name=Owner&floor=${first.id}`;
  const msgs: ServerMsg[] = [];
  const ws = new WebSocket(base, { origin: base.replace('ws:', 'http:').split('/ws')[0] });
  t.after(() => ws.terminate());
  ws.on('message', (raw) => msgs.push(JSON.parse(String(raw))));
  await once(ws, 'open');

  // A shell on the second floor, where the owner's window isn't.
  const hired = await office.owner.act(grok, { t: 'worker.spawn', deskId: 'auto', kind: 'shell' }, { floor: second.id });
  assert.equal(hired.error, undefined, JSON.stringify(hired));
  assert.ok(hired.workerId);
  assert.deepEqual(hired.notes, ['Grok opened a shell at a desk']);
  const shell = office.owner.floors()[1].workers.find((w) => w.id === hired.workerId)!;
  assert.ok(shell, 'it sits on the floor it was hired for');

  const missing = await office.owner.act(grok, { t: 'worker.kill', workerId: 'nobody', cleanup: 'keep' });
  assert.equal(missing.error, 'No such worker');
  const wrongFloor = await office.owner.act(grok, { t: 'floor.branch', floor: second.id, request: 'r', branch: null }, { floor: first.id });
  assert.match(wrongFloor.error!, /Choose a branch on the floor you are on/);
  const ignored = await office.owner.act(grok, { t: 'worker.shoot', workerId: 'nobody' });
  assert.deepEqual([ignored.error, ignored.unconfirmed], [undefined, true], 'a handler that ignores the action is not reported as done');
  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await office.owner.act(grok, { t: 'floor.repos' }, { signal: aborted.signal })).pending, true, 'an already cancelled call returns at once');
  const repos = await office.owner.act(grok, { t: 'floor.repos' });
  assert.equal(repos.reply?.t, 'floor.repos', 'an action with an answer gets it back');

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
  const term = new headless.Terminal({ cols: 10, rows: 5, scrollback: 50, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write('first\r\n0123456789abcdefghij-end\r\nlast\r\n', resolve));
  assert.equal(plainTail(term, 2), '0123456789abcdefghij-end\nlast');
  assert.equal(plainTail(term, 10), 'first\n0123456789abcdefghij-end\nlast');
  term.dispose();
});
