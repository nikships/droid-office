import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { RemoteWorkers } from '../src/server/remote-workers.js';
import { RemoteOffice, type RemoteFloor } from '../src/server/remote-office.js';
import { REMOTE_MCP_FILE, RemoteMcp, remoteMcpListener } from '../src/server/remote-mcp-http.js';
import { createOfficeMcp, tailnetIdentity } from '../src/server/office-mcp/index.js';
import { planServe, serveFailure, TailscaleCli, type CliRun } from '../src/server/tailscale.js';
import { remoteMcpConfig } from '../src/shared/remote-mcp.js';
import { Team, type TeamWorkers } from '../src/server/team.js';
import { Visits } from '../src/server/visits.js';
import { WhiteboardStore } from '../src/server/whiteboard.js';
import { WorkerManager } from '../src/server/workers.js';
import { workerLeft } from '../src/server/floor.js';
import { SUBAGENT_DEFAULTS, type WorkerInfo } from '../src/shared/protocol.js';
import { DESKS } from '../src/shared/layout.js';

type Cleanup = { after(fn: () => void | Promise<void>): void };
/** Node fetch ignores a caller's Host header; emulate Serve with a real HTTP request instead. */
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
function temporary(t: Cleanup) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'remote-mcp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function rig(t: Cleanup) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'remote-mcp-'));
  const store = new RemoteWorkers(dir);
  const settings = { ...SUBAGENT_DEFAULTS, deskWorkers: true, visits: true, maxPerLead: 3 };
  let now = 1000;
  const floors: RemoteFloor[] = [];
  const office = new RemoteOffice(store, () => floors);
  const maps: Map<string, WorkerInfo>[] = [];
  const teams: Team[] = [];
  const visits: Visits[] = [];
  let seq = 0;
  for (const id of ['alpha', 'beta']) {
    const data = path.join(dir, id);
    mkdirSync(data);
    const people = new Map<string, WorkerInfo>();
    maps.push(people);
    const get = (id: string) => people.get(id) ?? store.identity(id);
    const workers: TeamWorkers & RemoteFloor['workers'] = {
      list: () => [...people.values()],
      get: (id) => people.get(id),
      authenticate: () => undefined,
      remoteSeat: (name) => {
        if ([...people.values()].some((w) => w.name === name)) throw new Error('Name taken');
        const seat = DESKS.find((d) => ![...people.values()].some((w) => w.deskId === d.id));
        if (!seat) throw new Error('No free desk');
        return seat.id;
      },
      attachRemote: (w) => {
        people.set(w.id, w);
      },
      detachRemote: (id) => {
        people.delete(id);
      },
      releaseRemoteLead: (id) => {
        for (const w of people.values()) if (w.lead === id) delete w.lead;
      },
      remoteStatus: (id, status, activity) => {
        Object.assign(people.get(id)!, { status, activity });
      },
      officeDefault: undefined,
      deskOccupied: (id) => [...people.values()].some((w) => w.deskId === id),
      hire: (deskId, _by, _prompt, _worktree, _choice, lead) => {
        const w: WorkerInfo = { id: `sub-${++seq}`, name: 'Byte', kind: 'agent', deskId, lead, color: '#888', status: 'idle', acked: true, createdAt: now, createdBy: 'test', cols: 100, rows: 30, open: false };
        people.set(w.id, w);
        return w;
      },
      prompt: (wid, text) => (store.identity(wid) ? store.enqueue(wid, text, id) : undefined),
      resume: (wid, text) => (text && store.identity(wid) ? store.enqueue(wid, text, id) : undefined),
      kill: async (wid) => {
        people.delete(wid);
        return {};
      },
      tail: () => 'working',
      setTask() {},
    };
    const team = new Team(
      { ...workers, get },
      { dataDir: data, dir: data, git: false, settings: () => settings, remoteTeamSize: (id) => maps.flatMap((m) => [...m.values()]).filter((w) => w.lead === id).length, toast() {}, now: () => now },
    );
    teams.push(team);
    const visit = new Visits({ ...workers, get, tell: workers.prompt, cancelTurn: () => false, turnScreen: () => undefined }, { on: () => settings.visits, emit() {}, now: () => now });
    visits.push(visit);
    floors.push({ id, dir: data, def: { name: id }, workers, team, visits: visit, whiteboard: new WhiteboardStore(data) });
  }
  const remote = office.add('Grok', 'alpha');
  t.after(() => {
    for (const f of floors) f.whiteboard.stop();
    for (const team of teams) team.stop();
    for (const v of visits) v.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const floor = (id: string) => {
    const f = office.floor(id);
    return f ? { ...f, name: f.def.name } : undefined;
  };
  return {
    dir,
    store,
    office,
    settings,
    remote,
    maps,
    floors,
    teams,
    visits,
    floor,
    advance: (ms: number) => {
      now += ms;
      for (const v of visits) v.tick(now);
    },
  };
}

async function listening(t: Cleanup, server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('remote credentials and explicit inbox acknowledgments persist, rotate and revoke', (t) => {
  const dir = temporary(t);
  const store = new RemoteWorkers(dir);
  const { worker, token } = store.add('Grok', 'alpha', 'desk-1');
  assert.equal(store.authenticate(worker.id, token), true);
  assert.equal(store.authenticate(worker.id, 'wrong'), false);
  assert.equal(store.enqueue(worker.id, 'hello', 'alpha'), undefined);
  const first = store.inbox(worker.id);
  assert.equal(store.inbox(worker.id).messages.length, 1);
  const restarted = new RemoteWorkers(dir);
  assert.deepEqual(restarted.inbox(worker.id), first);
  assert.equal(statSync(path.join(dir, 'remote-workers.json')).mode & 0o777, 0o600);
  assert.equal(restarted.token(worker.id), token, 'Settings can show a bot its connection again');
  assert.ok(!JSON.stringify(restarted.list()).includes(token));
  const newToken = restarted.rotate(worker.id);
  assert.equal(restarted.authenticate(worker.id, token), false);
  assert.equal(restarted.authenticate(worker.id, newToken), true);
  restarted.inbox(worker.id, [first.messages[0].id]);
  assert.equal(new RemoteWorkers(dir).inbox(worker.id).messages.length, 0);
  restarted.remove(worker.id);
  assert.equal(restarted.authenticate(worker.id, newToken), false);
  assert.equal(new RemoteWorkers(dir).identity(worker.id), undefined);
});

test('full inbox refuses new delivery rather than silently losing old messages; corrupt state fails closed', (t) => {
  const dir = temporary(t);
  const store = new RemoteWorkers(dir);
  const { worker } = store.add('Grok', 'alpha', 'desk-1');
  for (let i = 0; i < 500; i++) assert.equal(store.enqueue(worker.id, String(i)), undefined);
  assert.match(store.enqueue(worker.id, 'overflow')!, /full/);
  assert.equal(store.inbox(worker.id, [], 500).messages.length, 500);
  writeFileSync(path.join(dir, 'remote-workers.json'), '{bad');
  assert.throws(() => new RemoteWorkers(dir), /not reset/);
});

test('a moving remote lead keeps both teams, reports, replies, and a building-wide hiring cap', async (t) => {
  const r = rig(t);
  const id = r.remote.worker.id;
  const first = await r.teams[0].handle(r.remote.worker, { action: 'hire', task: 'Work on alpha' });
  assert.equal(first.status, 200);
  r.office.move(id, 'beta');
  assert.equal(r.maps[0].has(id), false);
  assert.equal(r.maps[1].has(id), true);
  const worker = r.maps[1].get(id)!;
  const second = await r.teams[1].handle(worker, { action: 'hire', task: 'Work on beta' });
  assert.equal(second.status, 200);
  assert.equal((await r.teams[1].handle(worker, { action: 'hire', task: 'More work' })).status, 200);
  assert.equal((await r.teams[1].handle(worker, { action: 'hire', task: 'Too many' })).status, 409);
  const sub = r.maps[0].get((first.body.worker as WorkerInfo).id)!;
  assert.equal((await r.teams[0].handle(sub, { action: 'report', text: 'Alpha finished' })).status, 200);
  const inbox = r.office.inbox(id);
  assert.match(inbox.messages[0].text, /Alpha finished/);
  assert.equal(inbox.messages[0].floor, 'alpha');
  const status = await r.office.team(worker, { action: 'status' });
  assert.equal((status.body.team as unknown[]).length, 3);
  assert.equal(r.office.inbox(id).messages.length, 1, 'status does not consume a remote report');
  assert.equal((await r.office.team(worker, { action: 'send', worker: sub.id, text: 'Please continue' })).status, 200);
  assert.equal((await r.office.team(worker, { action: 'send', worker: 'Byte', text: 'Ambiguous' })).status, 409);
  r.office.inbox(id, [inbox.messages[0].id]);
  assert.equal(r.office.inbox(id).messages.length, 0);
  r.office.revoke(id);
  assert.equal(r.maps[0].get(sub.id)?.lead, undefined);
  assert.equal(r.maps[1].has(id), false);
});

test('visit questions and answers route to the remote inbox after its desk moves', (t) => {
  const r = rig(t);
  const a = r.office.add('Alice', 'alpha').worker;
  const g = r.remote.worker;
  const ask = r.visits[0].handle(a, { action: 'visit', kind: 'ask', worker: g.id, text: 'Are you ready?' });
  assert.equal(ask.status, 200);
  r.office.move(g.id, 'beta');
  r.advance(60_000);
  assert.match(r.office.inbox(g.id).messages[0].text, /Are you ready/);
  const reply = r.office.reply(r.maps[1].get(g.id)!, String(ask.body.visit), 'Yes');
  assert.equal(reply.status, 200);
  assert.match(r.office.inbox(a.id).messages[0].text, /Yes/);
  assert.equal(r.office.reply(r.maps[1].get(g.id)!, String(ask.body.visit), 'Again').status, 409);
});

test('real MCP transport enforces host, tailnet identity, remote bearer auth, revocation, and route isolation', async (t) => {
  const r = rig(t);
  const hostname = 'office.example.ts.net';
  const owner = 'owner@example.com';
  const server = remoteMcpListener({ remote: r.office, remoteTransport: { hostname: () => hostname, owner: () => owner }, floor: r.floor, settings: () => r.settings });
  const origin = await listening(t, server);
  const url = new URL('/office/mcp', origin);
  const headers = { host: `${hostname}:8443`, 'tailscale-user-login': owner, Authorization: `Bearer ${r.remote.token}`, 'x-droid-office-worker-id': r.remote.worker.id };
  assert.equal((await proxyFetch(url, { method: 'POST', headers: { ...headers, host: 'evil.example' }, body: '{}' })).status, 403);
  assert.equal((await proxyFetch(url, { method: 'POST', headers: { ...headers, 'tailscale-user-login': 'friend@example.com' }, body: '{}' })).status, 403, 'a shared-in user is not one of the owner’s devices');
  assert.equal((await proxyFetch(url, { method: 'POST', headers: { ...headers, 'tailscale-funnel-request': '?1' }, body: '{}' })).status, 403, 'Funnel traffic is public');
  assert.equal((await proxyFetch(url, { method: 'POST', headers: { ...headers, Origin: `https://${hostname}` }, body: '{}' })).status, 403);
  assert.equal((await proxyFetch(url, { method: 'POST', headers: { ...headers, Authorization: 'Bearer wrong' }, body: '{}' })).status, 401);
  for (const route of ['/hooks/droid', '/api/finder/dispatch', '/office/remote-workers', '/']) assert.equal((await fetch(new URL(route, origin), { headers })).status, 404);
  const client = new Client({ name: 'remote-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(url, { fetch: proxyFetch, requestInit: { headers } }));
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('office_move') && names.includes('office_inbox') && names.includes('team_hire'));
  assert.ok(!names.includes('team_report'));
  assert.match(client.getInstructions()!, /OFFICE MACHINE/);
  assert.equal((await client.callTool({ name: 'office_move', arguments: { floor: 'beta' } })).isError, undefined);
  const who = await client.callTool({ name: 'office_whoami', arguments: {} });
  assert.deepEqual(who.structuredContent?.floor, { id: 'beta', name: 'beta' });
  // Its floor is gone without it being re-seated (closed with no other open, then one opened): the next call seats it.
  r.maps[1].delete(r.remote.worker.id);
  r.floors.splice(1, 1);
  const healed = await client.callTool({ name: 'office_whoami', arguments: {} });
  assert.deepEqual(healed.structuredContent?.floor, { id: 'alpha', name: 'alpha' });
  r.settings.officeMcp = false;
  await assert.rejects(client.listTools(), /Active remote worker/);
  r.settings.officeMcp = true;
  r.store.rotate(r.remote.worker.id);
  await assert.rejects(client.listTools(), /Active remote worker/);
  assert.equal(tailnetIdentity(new Headers(), owner), true, 'a tagged device of the tailnet carries no login');
  assert.equal(tailnetIdentity(new Headers({ 'tailscale-user-login': 'OWNER@example.com' }), owner), true);
  assert.equal(tailnetIdentity(new Headers({ 'tailscale-user-login': 'friend@example.com' }), owner), false);
  assert.equal(tailnetIdentity(new Headers({ 'tailscale-funnel-request': '?1' }), owner), false);
});

test('remote status starts at the current news, advances per caller, and timestamps each item', async (t) => {
  const r = rig(t);
  const worker = r.remote.worker;
  await r.teams[0].handle(worker, { action: 'hire', task: 'Fix the report' });
  const sub = r.maps[0].get('sub-1')!;
  await r.teams[0].handle(sub, { action: 'report', text: 'An old report' });
  r.advance(86_400_000);
  const hostname = 'office.example.ts.net';
  const server = remoteMcpListener({ remote: r.office, remoteTransport: { hostname: () => hostname, owner: () => undefined }, floor: r.floor, settings: () => r.settings });
  const origin = await listening(t, server);
  const connect = async () => {
    const client = new Client({ name: 'remote-news-test', version: '1' });
    t.after(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/office/mcp', origin), {
        fetch: proxyFetch,
        requestInit: { headers: { host: `${hostname}:8443`, Authorization: `Bearer ${r.remote.token}`, 'x-droid-office-worker-id': worker.id } },
      }),
    );
    return client;
  };
  let client = await connect();
  const status = () => client.callTool({ name: 'team', arguments: { action: 'status' } });
  assert.deepEqual((await status()).structuredContent?.events, [], 'a new caller does not replay historical news');
  assert.deepEqual((await status()).structuredContent?.events, []);

  await r.teams[0].handle(sub, { action: 'report', text: 'A new report' });
  const other = r.office.add('Other bot', 'beta').worker;
  assert.deepEqual((await r.office.team(other, { action: 'status' })).body.events, [], 'another caller sees no foreign news');
  await client.close();
  client = await connect();
  const fresh = await status();
  const events = fresh.structuredContent?.events as { text: string; at: number }[];
  assert.deepEqual(
    events.map((e) => [e.text, e.at]),
    [['A new report', 86_401_000]],
    'reconnecting does not reset the cursor',
  );
  assert.match(JSON.stringify(fresh.content), /\[1970-01-02T00:00:01\.000Z\] Worker report from Byte/);
  assert.deepEqual((await status()).structuredContent?.events, [], 'each report appears once in status');

  // Sequence cursors do not miss events that share the previous status call's millisecond.
  await r.teams[0].handle(sub, { action: 'report', text: 'A question', question: true });
  const question = await status();
  assert.match(JSON.stringify(question.content), /\[1970-01-02T00:00:01\.000Z\] Worker question from Byte/);
  assert.equal((question.structuredContent?.events as unknown[] | undefined)?.length, 1);
  sub.status = 'working';
  r.teams[0].onWorker(sub);
  sub.status = 'needs_input';
  r.teams[0].onWorker(sub);
  assert.match(JSON.stringify((await status()).content), /\[1970-01-02T00:00:01\.000Z\] Office status: Byte needs someone/);
  assert.equal(r.office.inbox(worker.id).messages.length, 4, 'status retains the separate explicit-ack inbox');
});

test('remote status cursors survive restart independently for each caller', async (t) => {
  const r = rig(t);
  const worker = r.remote.worker;
  await r.teams[0].handle(worker, { action: 'status' });
  await r.teams[0].handle(worker, { action: 'hire', task: 'Fix the report' });
  const sub = r.maps[0].get('sub-1')!;
  await r.teams[0].handle(sub, { action: 'report', text: 'Before restart' });
  const other = r.office.add('Other bot', 'alpha').worker;
  await r.teams[0].handle(other, { action: 'status' });
  r.teams[0].stop();
  const floor = r.floors[0];
  const restarted = new Team({ ...floor.workers, get: (id) => floor.workers.get(id) ?? r.store.identity(id) } as TeamWorkers, { dataDir: floor.dir, dir: floor.dir, git: false, settings: () => r.settings, toast() {}, now: () => 1234 });
  t.after(() => restarted.stop());
  const read = async () => (await restarted.handle(worker, { action: 'status' })).body.events as { text: string }[];
  assert.deepEqual(
    (await read()).map((e) => e.text),
    ['Before restart'],
    'another caller did not advance this cursor',
  );
  assert.deepEqual(await read(), []);
  await restarted.handle(sub, { action: 'report', text: 'After restart' });
  assert.deepEqual(
    (await read()).map((e) => e.text),
    ['After restart'],
  );
});

test('remote tokens never authenticate on the local hook MCP', async (t) => {
  const r = rig(t);
  const local = createOfficeMcp({ floor: r.floor, settings: () => r.settings });
  const origin = await listening(
    t,
    createServer((req, res) => void local.handle(req, res)),
  );
  const response = await fetch(`${origin}/office/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${r.remote.token}`, 'x-droid-office-worker-id': r.remote.worker.id }, body: '{}' });
  assert.equal(response.status, 401);
});

// Trimmed from this Mac's real `tailscale status --json` and `tailscale serve status --json`, the address and login replaced.
const DNS = 'office-mac.tail08b849.ts.net';
const STATUS = {
  BackendState: 'Running',
  Self: { DNSName: `${DNS}.`, TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'], UserID: 4463762094514452 },
  User: { '4463762094514452': { ID: 4463762094514452, LoginName: 'owner@example.com', DisplayName: 'Office Owner' } },
  CurrentTailnet: { Name: 'owner@example.com', MagicDNSSuffix: 'tail08b849.ts.net', MagicDNSEnabled: true },
};
const SKEW = 'Warning: client version "1.104.2-te26db7a57" != tailscaled server version "1.104.4-t938213198-gd38c96d6a"\n';
const servedAt = (port: number, proxy: string) => ({ TCP: { [port]: { HTTPS: true } }, Web: { [`${DNS}:${port}`]: { Handlers: { '/': { Proxy: proxy } } } } });

/** tailscaled's Serve config behind a fake CLI that answers the way the real one does. */
function fakeTailscale(start: { TCP?: Record<string, unknown>; Web?: Record<string, unknown> } = {}, up = true) {
  const state = { serve: { TCP: { ...start.TCP }, Web: { ...start.Web } } as { TCP: Record<string, unknown>; Web: Record<string, unknown> }, up, calls: [] as string[][] };
  const run: CliRun = async (_bin, args) => {
    state.calls.push(args);
    if (!state.up) return { ok: false, stdout: '', stderr: 'failed to connect to local tailscaled; it doesn’t appear to be running\n' };
    if (args[0] === 'status') return { ok: true, stdout: JSON.stringify(STATUS), stderr: SKEW };
    if (args[0] === 'serve' && args[1] === 'status') return { ok: true, stdout: Object.keys(state.serve.TCP).length ? JSON.stringify(state.serve, null, 2) : '{}\n', stderr: SKEW };
    const port = Number(args.find((a) => a.startsWith('--https='))?.slice('--https='.length));
    if (args.at(-1) === 'off') {
      delete state.serve.TCP[port];
      delete state.serve.Web[`${DNS}:${port}`];
    } else {
      const next = servedAt(port, args.at(-1)!);
      Object.assign(state.serve.TCP, next.TCP);
      Object.assign(state.serve.Web, next.Web);
    }
    return { ok: true, stdout: '', stderr: SKEW };
  };
  return { ...state, state, cli: () => new TailscaleCli(['tailscale'], run) };
}

test('Serve ports: the office reuses its own mapping, reclaims its old one and never takes another service’s', () => {
  const other = { port: 8443, proxy: 'http://127.0.0.1:3000', funnel: false };
  assert.deepEqual(planServe([other], 'http://127.0.0.1:4611'), { port: 8444, existing: false });
  assert.deepEqual(planServe([other, { port: 8444, proxy: 'http://127.0.0.1:4611', funnel: false }], 'http://127.0.0.1:4611'), { port: 8444, existing: true });
  assert.deepEqual(planServe([{ port: 8445, proxy: 'http://127.0.0.1:5000', funnel: false }], 'http://127.0.0.1:4611', 8445, 'http://127.0.0.1:5000'), { port: 8445, existing: false });
  assert.deepEqual(planServe([{ port: 8445, proxy: 'http://127.0.0.1:5000', funnel: false }], 'http://127.0.0.1:4611', 8445, 'http://127.0.0.1:6000'), { port: 8443, existing: false });
  assert.deepEqual(serveFailure(`${SKEW}error: cannot serve web; already serving TCP\n`), { message: 'error: cannot serve web; already serving TCP' });
});

test('the office serves external workers on its tailnet by itself, keeps the URL across restarts and unserves only its own mapping', async (t) => {
  const r = rig(t);
  const ts = fakeTailscale(servedAt(8443, 'http://127.0.0.1:3000'));
  const opts = { dataDir: r.dir, office: r.office, mcp: { floor: r.floor, settings: () => r.settings }, floors: () => r.floors.map((f) => ({ id: f.id, name: f.def.name })), backendPort: 0, log() {} };
  const first = new RemoteMcp({ ...opts, cli: ts.cli() });
  t.after(() => first.stop());
  const on = await first.start();
  assert.equal(on.on, true, 'on by default');
  assert.equal(on.status, 'serving');
  assert.equal(on.url, `https://${DNS}:8444/office/mcp`, 'another service keeps 8443');
  assert.equal(ts.state.calls.filter((c) => c[1] === '--bg').length, 1);
  const bot = on.bots.find((b) => b.id === r.remote.worker.id)!;
  assert.deepEqual(bot.connection, { url: on.url, headers: { Authorization: `Bearer ${r.remote.token}`, 'x-droid-office-worker-id': r.remote.worker.id } });
  assert.match(remoteMcpConfig(bot.connection!), /"type": "http"/);

  // What a bot on the owner's laptop sends through Serve reaches the office's tools.
  const backend = (ts.state.serve.Web[`${DNS}:8444`] as { Handlers: { '/': { Proxy: string } } }).Handlers['/'].Proxy;
  const client = new Client({ name: 'bot', version: '1' });
  t.after(() => client.close());
  const headers = { ...bot.connection!.headers, host: `${DNS}:8444`, 'tailscale-user-login': 'owner@example.com' };
  await client.connect(new StreamableHTTPClientTransport(new URL('/office/mcp', backend), { fetch: proxyFetch, requestInit: { headers } }));
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'office_inbox'));

  const added = first.add('Claw', 'beta');
  const claw = added.bots.find((b) => b.name === 'Claw')!;
  assert.equal(claw.floorName, 'beta');
  const rotated = first.rotate(claw.id).bots.find((b) => b.id === claw.id)!;
  assert.notEqual(rotated.connection!.headers.Authorization, claw.connection!.headers.Authorization);
  assert.equal(
    first.revoke(claw.id).bots.some((b) => b.id === claw.id),
    false,
  );
  first.stop();

  const again = new RemoteMcp({ ...opts, cli: ts.cli() });
  t.after(() => again.stop());
  assert.equal((await again.start()).url, on.url, 'same URL after a restart');
  assert.equal(ts.state.calls.filter((c) => c[1] === '--bg').length, 1, 'the mapping tailscaled kept is reused');

  const off = await again.set(false);
  assert.equal(off.status, 'off');
  assert.equal(off.url, undefined);
  assert.deepEqual(Object.keys(ts.state.serve.TCP), ['8443'], 'the other service is untouched');
  assert.equal(JSON.parse(readFileSync(path.join(r.dir, REMOTE_MCP_FILE), 'utf8')).on, false);
  const stillOff = new RemoteMcp({ ...opts, cli: ts.cli() });
  assert.equal((await stillOff.start()).status, 'off');
  assert.equal((await stillOff.set(true)).url, on.url, 'turned back on, at the same address');
  stillOff.stop();
});

test('without Tailscale the office still opens, says why, and serves once Tailscale is up', async (t) => {
  const r = rig(t);
  const ts = fakeTailscale({}, false);
  const service = new RemoteMcp({ dataDir: r.dir, office: r.office, mcp: { floor: r.floor, settings: () => r.settings }, floors: () => [], cli: ts.cli(), backendPort: 0, log() {} });
  t.after(() => service.stop());
  const down = await service.start();
  assert.equal(down.status, 'unavailable');
  assert.match(down.reason!, /Tailscale isn’t running/);
  assert.equal(down.bots[0].connection, undefined);
  ts.state.up = true;
  const up = await service.refresh();
  assert.equal(up.status, 'serving');
  assert.equal(up.url, `https://${DNS}:8443/office/mcp`);
});

test('while Tailscale waits on the owner, opening Settings does not run serve again', async (t) => {
  const r = rig(t);
  const calls: string[][] = [];
  // The real CLI's answer on a tailnet without HTTPS certificates, the node id replaced.
  const run: CliRun = async (_bin, args) => {
    calls.push(args);
    if (args[0] === 'status') return { ok: true, stdout: JSON.stringify(STATUS), stderr: '' };
    if (args[1] === 'status') return { ok: true, stdout: '{}\n', stderr: '' };
    return { ok: false, stdout: 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nXXXX\n', stderr: '' };
  };
  const service = new RemoteMcp({ dataDir: r.dir, office: r.office, mcp: { floor: r.floor, settings: () => r.settings }, floors: () => [], cli: new TailscaleCli(['tailscale'], run), backendPort: 0, retryMs: 60_000, log() {} });
  t.after(() => service.stop());
  const waiting = await service.start();
  assert.equal(waiting.status, 'unavailable');
  assert.equal(waiting.fixUrl, 'https://login.tailscale.com/f/serve?node=nXXXX');
  const serves = () => calls.filter((c) => c[1] === '--bg').length;
  assert.equal(serves(), 1);
  const again = await service.refresh();
  assert.equal(again.fixUrl, waiting.fixUrl);
  assert.equal(serves(), 1, 'the admin link is still the answer; serve would only block on it again');
});

test('a remote lead moving between real floors keeps its team log and visits; a closed floor re-seats it', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'remote-floors-'));
  const store = new RemoteWorkers(dir);
  const { worker: grok } = store.add('Grok', 'alpha', 'desk-1');
  mkdirSync(path.join(dir, 'alpha'));
  writeFileSync(path.join(dir, 'alpha', 'workers.json'), JSON.stringify([{ id: 'sub', kind: 'agent', name: 'Byte', deskId: 'desk-2', lead: grok.id }]));
  const settings = { ...SUBAGENT_DEFAULTS, deskWorkers: true, visits: true, maxPerLead: 3 };
  let now = 1000;
  const floors: RemoteFloor[] = [];
  const office = new RemoteOffice(store, () => floors);
  const managers: WorkerManager[] = [];
  const removed: string[] = [];
  const updates: WorkerInfo[] = [];
  t.after(() => {
    for (const f of floors) {
      f.whiteboard.stop();
      (f.team as Team).stop();
      (f.visits as Visits).stop();
    }
    for (const m of managers) m.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  const open = (id: string) => {
    const data = path.join(dir, id);
    mkdirSync(data, { recursive: true });
    const floor = {} as RemoteFloor;
    const m = new WorkerManager(
      dir,
      data,
      'missing-test-agent',
      [],
      { url: 'http://127.0.0.1:1', token: '' },
      {
        update: (w) => updates.push({ ...w }),
        remove: (wid) => {
          removed.push(wid);
          workerLeft(wid, store, floor);
        },
        data() {},
        screen() {},
        toast() {},
      },
      undefined,
      undefined,
      undefined,
      true,
      { store, floor: id, revoke: (wid) => office.revoke(wid) },
    );
    managers.push(m);
    const get = (wid: string) => m.get(wid) ?? m.remoteIdentity(wid);
    const team = new Team(
      {
        list: () => m.list(),
        get,
        deskOccupied: (d) => m.deskOccupied(d),
        officeDefault: undefined,
        hire: () => 'No hiring in this test',
        prompt: (wid, text) => m.tell(wid, text),
        resume: (wid, text) => m.resume(wid, text),
        kill: (wid) => m.kill(wid),
        tail: (wid, lines) => m.tail(wid, lines),
        setTask: (wid, task) => m.setTask(wid, task),
      },
      { dataDir: data, dir: data, git: false, settings: () => settings, toast() {}, now: () => now },
    );
    const visits = new Visits(
      {
        list: () => m.list(),
        get,
        tail: (wid, lines) => m.tail(wid, lines),
        prompt: (wid, text) => m.prompt(wid, text),
        tell: (wid, text) => m.tell(wid, text),
        resume: (wid, text) => m.resume(wid, text),
        cancelTurn: (wid) => m.cancelTurn(wid),
        turnScreen: (wid) => m.turnScreen(wid),
      },
      { on: () => settings.visits, emit() {}, now: () => now },
    );
    Object.assign(floor, { id, dir: data, def: { name: id }, workers: m, team, visits, whiteboard: new WhiteboardStore(data) });
    floors.push(floor);
    return floor;
  };
  const alpha = open('alpha');
  const beta = open('beta');
  const alice = office.add('Alice', 'alpha').worker;

  assert.equal((await alpha.team.handle(alpha.workers.get('sub')!, { action: 'report', text: 'Alpha finished' })).status, 200);
  const ask = alpha.visits.handle(alice, { action: 'visit', kind: 'ask', worker: grok.id, text: 'Are you ready?' });
  assert.equal(ask.status, 200);

  office.move(grok.id, 'beta');
  assert.ok(removed.includes(grok.id), 'the move went through the floor’s real remove path');
  assert.equal(alpha.workers.get(grok.id), undefined);
  assert.equal(beta.workers.get(grok.id)?.remote, true);
  assert.equal(alpha.team.inbox(grok.id).length, 1, 'the old floor kept its report to the lead');
  now += 60_000;
  (alpha.visits as Visits).tick(now);
  assert.ok(
    office.inbox(grok.id).messages.some((m) => /Are you ready/.test(m.text)),
    'the question reached it on its new floor',
  );
  assert.equal(office.reply(beta.workers.get(grok.id)!, String(ask.body.visit), 'Yes').status, 200);

  beta.workers.remoteStatus(grok.id, 'working', 'Reading the issue');
  const seen = updates.length;
  beta.workers.remoteStatus(grok.id, 'working', 'Writing the fix');
  assert.equal(updates.length, seen + 1, 'new activity alone is sent to clients');
  assert.equal(updates.at(-1)?.activity, 'Writing the fix');

  // Beta comes off the building: the server re-seats its external workers first.
  assert.equal(office.rehome(grok.id, 'beta'), true);
  floors.splice(floors.indexOf(beta), 1);
  assert.equal(office.floor(grok.id)?.id, 'alpha');
  assert.equal(store.identity(grok.id)?.deskId, alpha.workers.get(grok.id)?.deskId);
  assert.equal(alpha.team.inbox(grok.id).length, 1);

  await alpha.workers.kill(grok.id);
  assert.equal(store.identity(grok.id), undefined, 'removing it at its desk revokes it everywhere');
  assert.equal(alpha.workers.get('sub')?.lead, undefined);
});
test('real worker managers restore remote seats and off-floor leads without launching a terminal', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'remote-manager-'));
  const store = new RemoteWorkers(dir);
  const { worker, token } = store.add('Grok', 'beta', 'desk-1');
  const data = path.join(dir, 'alpha');
  mkdirSync(data);
  writeFileSync(path.join(data, 'workers.json'), JSON.stringify([{ id: 'sub', kind: 'agent', name: 'Byte', deskId: 'desk-2', lead: worker.id }]));
  const managers: WorkerManager[] = [];
  t.after(() => {
    for (const m of managers) m.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  const make = (floor: string) => {
    const data = path.join(dir, floor);
    mkdirSync(data, { recursive: true });
    const m = new WorkerManager(dir, data, 'missing-test-agent', [], { url: 'http://127.0.0.1:1', token: '' }, { update() {}, remove() {}, data() {}, screen() {}, toast() {} }, undefined, undefined, undefined, true, {
      store,
      floor,
      revoke: (id) => store.remove(id),
    });
    managers.push(m);
    return m;
  };
  const alpha = make('alpha');
  const beta = make('beta');
  assert.equal(alpha.get('sub')?.lead, worker.id);
  assert.equal(beta.get(worker.id)?.remote, true);
  assert.equal(beta.authenticate(worker.id, token), undefined);
  assert.equal(beta.threadSession(worker.id), undefined);
  assert.equal(beta.agentFolder(worker.id), undefined);
  assert.equal(alpha.tell(worker.id, 'Report from old floor'), undefined);
  assert.equal(store.inbox(worker.id).messages[0].floor, 'alpha');
  assert.match(beta.resume(worker.id)!, /remotely/);
  beta.shutdown();
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'beta', 'workers.json'), 'utf8')), []);
  assert.equal(new RemoteWorkers(dir).workers('beta').length, 1);
});
