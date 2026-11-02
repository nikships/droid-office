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
import { remoteMcpListener, RemoteMcpAdmin, REMOTE_ADMIN_TOKEN } from '../src/server/remote-mcp-http.js';
import { createOfficeMcp, tailnetIdentity } from '../src/server/office-mcp/index.js';
import { Team, type TeamWorkers } from '../src/server/team.js';
import { Visits } from '../src/server/visits.js';
import { WhiteboardStore } from '../src/server/whiteboard.js';
import { WorkerManager } from '../src/server/workers.js';
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
  assert.ok(!readFileSync(path.join(dir, 'remote-workers.json'), 'utf8').includes(token));
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
  const server = remoteMcpListener({ remote: r.office, remoteTransport: { hostname }, floor: r.floor, settings: () => r.settings });
  const origin = await listening(t, server);
  const url = new URL('/office/mcp', origin);
  const headers = { host: hostname, 'tailscale-user-login': 'test-user', Authorization: `Bearer ${r.remote.token}`, 'x-droid-office-worker-id': r.remote.worker.id };
  assert.equal((await proxyFetch(url, { method: 'POST', headers: { ...headers, host: 'evil.example' }, body: '{}' })).status, 403);
  assert.equal((await proxyFetch(url, { method: 'POST', headers: { ...headers, 'tailscale-user-login': '' }, body: '{}' })).status, 403);
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
  r.settings.officeMcp = false;
  await assert.rejects(client.listTools(), /Active remote worker/);
  r.settings.officeMcp = true;
  r.store.rotate(r.remote.worker.id);
  await assert.rejects(client.listTools(), /Active remote worker/);
  assert.equal(tailnetIdentity(new Headers({ 'tailscale-app-capabilities': '{"droid-office/remote-worker":[{}]}' })), true);
  assert.equal(tailnetIdentity(new Headers({ 'tailscale-app-capabilities': '{"other":[{}]}' })), false);
});

test('remote tokens never authenticate on the local hook MCP, and provisioning requires its separate owner secret', async (t) => {
  const r = rig(t);
  const local = createOfficeMcp({ floor: r.floor, settings: () => r.settings });
  const origin = await listening(
    t,
    createServer((req, res) => void local.handle(req, res)),
  );
  const response = await fetch(`${origin}/office/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${r.remote.token}`, 'x-droid-office-worker-id': r.remote.worker.id }, body: '{}' });
  assert.equal(response.status, 401);
  const admin = new RemoteMcpAdmin(r.dir, r.office, 'office.example.ts.net', 4611);
  const adminOrigin = await listening(
    t,
    createServer((req, res) => void admin.handle(req, res)),
  );
  const secret = readFileSync(path.join(r.dir, REMOTE_ADMIN_TOKEN), 'utf8');
  assert.equal((await fetch(adminOrigin)).status, 403);
  assert.equal((await fetch(adminOrigin, { headers: { Authorization: `Bearer ${r.remote.token}` } })).status, 403);
  assert.equal((await fetch(adminOrigin, { headers: { Authorization: `Bearer ${secret}`, Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await fetch(adminOrigin, { headers: { Authorization: `Bearer ${secret}` } })).status, 200);
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
    const m = new WorkerManager(dir, data, 'missing-test-agent', [], { url: 'http://127.0.0.1:1', token: '' }, { update() {}, remove() {}, data() {}, screen() {}, toast() {} }, undefined, undefined, undefined, true, { store, floor });
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
  assert.equal(beta.owners().length, 0);
  beta.shutdown();
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'beta', 'workers.json'), 'utf8')), []);
  assert.equal(new RemoteWorkers(dir).workers('beta').length, 1);
});
