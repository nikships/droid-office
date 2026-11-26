import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { guestBackendListener, type GuestFunnel } from '../src/server/guest-funnel.js';
import { GUEST_FAILS_PER_SOURCE, GuestLinks } from '../src/server/guest-links.js';
import { GuestAudit } from '../src/server/guest-audit.js';
import { createGuestHttp } from '../src/server/server-runtime/guest-http.js';
import { send } from '../src/server/server-runtime/http-utils.js';
import { isGuestClient, ownerDevices } from '../src/server/server-runtime/access.js';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { ORCHESTRATOR_ID } from '../src/shared/mission-control.js';
import type { GuestLinkCreated, GuestLinksState, GuestPreset, GuestTransportState } from '../src/shared/guest-links.js';
import { tailnetProxy } from './tailnet-proxy.js';

const ORIGIN = 'https://office-mac.tail08b849.ts.net:10000';
const HOST = new URL(ORIGIN).host;
// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

interface Reply {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
  json: () => any;
}

function call(base: string, p: string, opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const r = request(`${base}${p}`, { method: opts.method ?? 'GET', headers: opts.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode!, headers: res.headers, body, json: () => JSON.parse(body) });
      });
    });
    r.on('error', reject);
    r.end(opts.body);
  });
}

async function listen(t: TestContext, handler: RequestListener, origin?: string) {
  const backend = origin ? guestBackendListener({ origin: () => origin, request: handler, upgrade: (_req, s) => s.destroy() }) : undefined;
  const server = backend?.server ?? createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = once(server, 'close');
    if (backend) backend.close();
    else {
      server.closeAllConnections();
      server.close();
    }
    await closed;
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * Floors shaped like Floor where guest-http reads them: two floors, one Whiteboard card each, and four
 * workers. w4 sits on floor-a and works in floor-b's repository too.
 */
function fakeFloors() {
  const floor = (id: string, name: string, workers: (string | { id: string; repos: string[] })[], cap: string) => ({
    id,
    dir: `/projects/${id}`,
    def: { name },
    everyone: () => workers.map((w) => (typeof w === 'string' ? { id: w, name: `Worker ${w}` } : { id: w.id, name: `Worker ${w.id}`, repos: w.repos.map((r) => ({ floor: r })) })),
    whiteboard: {
      serve: (c: string, rel: string) => (c === cap ? { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(`${id}:${rel || 'index'}`) } : undefined),
    },
  });
  return new Map([
    ['floor-a', floor('floor-a', 'Droid Office', ['w1', 'w2', { id: 'w4', repos: ['floor-b'] }], `k${'a'.repeat(30)}`)],
    ['floor-b', floor('floor-b', 'Website', ['w3'], `k${'b'.repeat(30)}`)],
  ]);
}

function unitRig(t: TestContext) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'guest-http-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const floors = fakeFloors();
  const links = new GuestLinks({
    dataDir,
    timers: false,
    names: ({ floorId, workerId }) => {
      const f = floorId ? floors.get(floorId) : undefined;
      const w = workerId ? f?.everyone().find((x) => x.id === workerId) : undefined;
      return { ...(f ? { floorName: f.def.name } : {}), ...(w ? { workerName: w.name } : {}) };
    },
  });
  const audit = new GuestAudit({ dataDir, timers: false });
  const floorCalls: { p: string; method: string; own: boolean }[] = [];
  const transport: { state: GuestTransportState; origin?: string; sets: boolean[] } = { state: { status: 'serving', origin: ORIGIN }, origin: ORIGIN, sets: [] };
  const funnel = {
    state: () => transport.state,
    origin: () => transport.origin,
    set: async (on: boolean) => {
      transport.sets.push(on);
      return transport.state;
    },
  } as unknown as GuestFunnel;
  const http = createGuestHttp({
    guestLinks: links,
    guestAudit: audit,
    guestFunnel: () => funnel,
    floors: floors as never,
    orchestrator: { cwd: '/orchestrator' } as never,
    workersOf: (() => ({ agentFolder: () => '/projects/floor-a' })) as never,
    availableDroidModels: (async () => ({ models: [{ id: 'm' }], customOnly: false })) as never,
    droidCommands: { get: async () => [{ name: 'review' }] } as never,
    floorRequest: async (req, res, p, url, ownRequest) => {
      floorCalls.push({ p, method: req.method ?? 'GET', own: ownRequest() });
      if (url.searchParams.get('name') === 'bad') return send(res, 415, { error: 'Only pictures' });
      return send(res, 200, { ok: true, p });
    },
    publicFile: (p: string) => (p === '/dashboard.html' || p === '/assets/app.js' ? p : undefined),
    serveFile: (res: ServerResponse, file: string) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`file:${file}`);
    },
  });
  links.setOn(true);
  const make = (preset: GuestPreset, target: { floorId?: string; workerId?: string } = {}, expiry: 'never' | '1h' = 'never') => {
    const made = links.create({ label: `${preset} link`, preset, expiry, ...target });
    assert.ok(made.ok, made.ok ? '' : made.error);
    return made;
  };
  return { links, audit, http, floorCalls, transport, make };
}

const auth = (token: string, extra: Record<string, string> = {}) => ({ host: HOST, authorization: `Bearer ${token}`, ...extra });

test('the guest backend serves only its allowlist, and refuses office credentials and loopback trust', async (t) => {
  const { http, make, links } = unitRig(t);
  const base = await listen(t, http.guestRequest, ORIGIN);
  const { token } = make('view-office');
  const assets = await call(base, '/assets/app.js', { headers: { host: HOST } });
  assert.equal(assets.status, 200);
  assert.equal(assets.headers['x-content-type-options'], 'nosniff');
  assert.equal(assets.headers['referrer-policy'], 'no-referrer');
  assert.equal((await call(base, '/dashboard', { headers: { host: HOST } })).body, 'file:/dashboard.html');
  assert.equal((await call(base, '/dashboard', { headers: { host: HOST } })).headers['x-frame-options'], 'DENY');
  for (const p of [
    '/',
    '/index.html',
    '/api/health',
    '/api/mobile/hello',
    '/api/mobile/pairing',
    '/api/guest-links',
    '/api/status',
    '/api/remote-mcp',
    '/api/automation',
    '/api/factory/state',
    '/api/docs',
    '/api/decor/picture',
    '/api/image',
    '/open/floor/x',
    '/assets/missing.js',
  ]) {
    const r = await call(base, p, { headers: auth(token) });
    assert.equal(r.status, 404, p);
    assert.deepEqual(r.json(), { error: 'Not found' }, p);
  }
  const noToken = await call(base, '/api/guest/hello', { headers: { host: HOST } });
  assert.equal(noToken.status, 401);
  assert.deepEqual(noToken.json(), { ok: false, reason: 'unavailable', error: 'This share link isn’t available. Ask the person who shared it for a new one.' });
  assert.equal((await call(base, '/api/guest/hello?t=lan-token&d=device-token', { headers: { host: HOST } })).status, 401, 'LAN and device tokens are not guest tokens');
  const hello = await call(base, `/api/guest/hello?g=${token}`, { headers: { host: HOST } });
  assert.equal(hello.status, 200);
  assert.deepEqual(hello.json(), { ok: true, session: { preset: 'view-office', write: false, scope: 'office', missionControl: true } });
  assert.ok(!hello.body.includes('view-office link'), 'the label never reaches guests');
  assert.equal((await call(base, '/api/guest/hello', { method: 'POST', headers: auth(token) })).status, 405);
  links.setOn(false);
  const off = await call(base, '/api/guest/hello', { headers: auth(token) });
  assert.equal(off.status, 403);
  assert.equal(off.json().reason, 'disabled');
});

test('ended links answer typed reasons, and wrong tokens are rate limited', async (t) => {
  const { http, make, links } = unitRig(t);
  const base = await listen(t, http.guestRequest, ORIGIN);
  const revoked = make('view-office');
  links.revoke(revoked.link.id);
  const r = await call(base, '/api/guest/hello', { headers: auth(revoked.token) });
  assert.equal(r.status, 410);
  assert.equal(r.json().reason, 'revoked');
  assert.ok(!/office-mac|floor|\/projects/.test(r.body), 'no internal details');
  const live = make('view-office');
  const junk = (source: string) => call(base, '/api/guest/hello', { headers: auth('W'.repeat(43), { 'x-forwarded-for': source }) });
  for (let i = 0; i < GUEST_FAILS_PER_SOURCE; i++) assert.equal((await junk('203.0.113.9')).status, 401);
  const limited = await junk('203.0.113.9');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal(limited.json().reason, 'unavailable');
  assert.equal((await call(base, '/api/guest/hello', { headers: auth(live.token, { 'x-forwarded-for': '203.0.113.9' }) })).status, 200, 'a valid token passes while its source is limited');
  assert.equal((await junk('198.51.100.1')).status, 401);
});

test('each preset reaches only in-scope floors, workers and Mission Control, and writes only when allowed', async (t) => {
  const { http, make, floorCalls, audit } = unitRig(t);
  const base = await listen(t, http.guestRequest, ORIGIN);
  const status = (token: string, p: string, method = 'GET', body?: Buffer) => call(base, p, { method, headers: auth(token, { origin: ORIGIN }), ...(body ? { body } : {}) }).then((r) => r.status);

  const worker = make('view-worker', { floorId: 'floor-a', workerId: 'w1' }).token;
  assert.equal(await status(worker, '/api/thread/image?worker=w1&image=x'), 200);
  assert.equal(await status(worker, '/api/thread/image?worker=w1&floor=floor-a&image=x'), 200);
  assert.equal(await status(worker, '/api/thread/image?worker=w1&floor=floor-b&image=x'), 404);
  assert.equal(await status(worker, '/api/thread/image?worker=w2&image=x'), 404);
  assert.equal(await status(worker, '/api/thread/image?worker=w3&image=x'), 404);
  assert.equal(await status(worker, `/api/thread/image?worker=${ORCHESTRATOR_ID}&image=x`), 404);
  assert.equal(await status(worker, '/api/changes/file?worker=w1&floor=floor-a&path=a.png&side=new'), 200);
  assert.equal(await status(worker, '/api/term/paths?worker=w1', 'POST'), 404, 'view presets never resolve file paths');
  assert.equal(await status(worker, '/api/term/file?worker=w1&path=~/.config/gh/hosts.yml'), 404);
  assert.equal(await status(worker, '/api/thread/file?worker=w1&path=.env'), 404);
  assert.equal(await status(worker, '/api/whiteboard/file?floor=floor-a&card=c&hash=h'), 404, 'a worker link sees no Whiteboard');
  assert.equal(await status(worker, '/api/gh/pull?floor=floor-a&number=1'), 404);
  assert.equal(await status(worker, '/api/prompt/image?floor=floor-a', 'POST', PNG), 404);
  assert.equal(await status(worker, '/api/thread/files?worker=w1'), 404);
  assert.equal(await status(worker, '/api/agents/droid/models'), 404);

  const floor = make('view-floor', { floorId: 'floor-a' }).token;
  assert.equal(await status(floor, '/api/thread/file?worker=w2&path=README.md'), 404, 'view presets never read files by path');
  assert.equal(await status(floor, '/api/term/file?worker=w2&path=README.md'), 404);
  assert.equal(await status(floor, '/api/whiteboard/render/status?floor=floor-a&card=c'), 200);
  assert.equal(await status(floor, '/api/whiteboard/render/status?floor=floor-b&card=c'), 404);
  assert.equal(await status(floor, '/api/whiteboard/render/status?card=c'), 404, 'a floor route needs its floor');
  assert.equal(await status(floor, '/api/gh/pull?floor=floor-a&number=1'), 200);
  assert.equal(await status(floor, `/api/thread/image?worker=${ORCHESTRATOR_ID}&image=x`), 404);
  assert.equal(await status(floor, '/api/term/drop?worker=w1&floor=floor-a', 'POST', PNG), 404);
  assert.equal(await status(floor, '/api/whiteboard/blob?floor=floor-a', 'POST', PNG), 404);
  assert.equal(await status(floor, '/api/gh/labels?floor=floor-a'), 404);

  const editFloor = make('edit-floor', { floorId: 'floor-a' }).token;
  assert.equal(await status(editFloor, '/api/prompt/image?floor=floor-a&name=shot.png', 'POST', PNG), 200);
  assert.equal(await status(editFloor, '/api/prompt/image?floor=floor-a&name=bad', 'POST', PNG), 415);
  assert.equal(await status(editFloor, '/api/prompt/image?floor=floor-b', 'POST', PNG), 404);
  assert.equal(await status(editFloor, `/api/prompt/image?worker=${ORCHESTRATOR_ID}`, 'POST', PNG), 404);
  assert.equal(await status(editFloor, '/api/term/drop?worker=w2&floor=floor-a&name=notes.txt', 'POST', PNG), 200);
  assert.equal(await status(editFloor, '/api/term/drop?worker=w3&name=notes.txt', 'POST', PNG), 404);
  assert.equal(await status(editFloor, '/api/thread/files?worker=w1&q=src'), 200);
  // The Hire dialog's @ list names a floor and no worker: only a floor the link reaches, and only for write presets.
  assert.equal(await status(editFloor, '/api/thread/files?floor=floor-a&q=src'), 200);
  assert.equal(await status(editFloor, '/api/thread/files?floor=floor-b'), 404);
  assert.equal(await status(editFloor, '/api/thread/files'), 404);
  assert.equal(await status(editFloor, '/api/thread/file?floor=floor-a&path=README.md'), 404, 'reading a file still needs a worker');
  assert.equal(await status(make('view-floor', { floorId: 'floor-a' }).token, '/api/thread/files?floor=floor-a'), 404);
  assert.equal(await status(editFloor, '/api/thread/file?worker=w2&path=README.md'), 200);
  assert.equal(await status(editFloor, '/api/thread/file?worker=w3&path=README.md'), 404);
  assert.equal(await status(editFloor, '/api/term/file?worker=w1&path=README.md'), 200);
  assert.equal(await status(editFloor, '/api/term/paths?worker=w1', 'POST'), 200, 'resolving paths is not audited as a change');
  assert.equal(await status(editFloor, '/api/agents/droid/models'), 200);
  assert.equal(await status(editFloor, '/api/agents/droid/commands?worker=w1'), 200);
  assert.equal(await status(editFloor, '/api/agents/droid/commands?floor=floor-a'), 200);
  assert.equal(await status(editFloor, '/api/agents/droid/commands?worker=w3'), 404);
  assert.equal(await status(editFloor, '/api/agents/droid/commands?floor=floor-b'), 404);
  assert.equal(await status(editFloor, '/api/whiteboard/blob?floor=floor-a', 'POST', PNG), 200);

  const viewOffice = make('view-office').token;
  assert.equal(await status(viewOffice, '/api/thread/image?worker=w3&image=x'), 200);
  assert.equal(await status(viewOffice, `/api/thread/image?worker=${ORCHESTRATOR_ID}&image=x`), 200, 'view-office watches Mission Control');
  assert.equal(await status(viewOffice, `/api/prompt/image?worker=${ORCHESTRATOR_ID}`, 'POST', PNG), 404);
  assert.equal(await status(viewOffice, '/api/whiteboard/file?floor=floor-b&card=c&hash=h'), 200);

  const editOffice = make('edit-office').token;
  assert.equal(await status(editOffice, `/api/prompt/image?worker=${ORCHESTRATOR_ID}&name=plan.png`, 'POST', PNG), 200);
  assert.equal(await status(editOffice, '/api/term/drop?worker=w3&floor=floor-b&name=x', 'POST', PNG), 200);
  assert.equal(await status(editOffice, '/api/term/drop?worker=w3&floor=floor-a&name=x', 'POST', PNG), 404, 'the floor named must be the worker’s');

  assert.ok(
    floorCalls.every((c) => c.own === (c.method !== 'GET')),
    'only mutations count as the page’s own writes',
  );
  const entries = audit.read({ limit: 100 }).entries;
  assert.deepEqual(
    entries.map((e) => [e.linkLabel, e.action, e.target.kind, e.target.workerName ?? e.target.floorName ?? '']).reverse(),
    [
      ['edit-floor link', 'upload', 'floor', 'Droid Office'],
      ['edit-floor link', 'upload', 'worker', 'Worker w2'],
      ['edit-floor link', 'whiteboard', 'floor', 'Droid Office'],
      ['edit-office link', 'upload', 'missionControl', ''],
      ['edit-office link', 'upload', 'worker', 'Worker w3'],
    ],
    'accepted writes are audited; refused and failed ones are not',
  );
  assert.equal(entries.at(-1)?.detail, 'Picture for a prompt: shot.png');
});

test('a worker across repositories is outside floor links, and a single-worker link never reaches its other floor', async (t) => {
  const { http, make } = unitRig(t);
  const base = await listen(t, http.guestRequest, ORIGIN);
  const status = (token: string, p: string, method = 'GET', body?: Buffer) => call(base, p, { method, headers: auth(token, { origin: ORIGIN }), ...(body ? { body } : {}) }).then((r) => r.status);
  const picture = '/api/changes/file?worker=w4&path=a.png&side=new';

  for (const preset of ['view-floor', 'edit-floor'] as const) {
    const token = make(preset, { floorId: 'floor-a' }).token;
    assert.equal(await status(token, picture), 404, preset);
    assert.equal(await status(token, `${picture}&repo=floor-b`), 404, preset);
    assert.equal(await status(token, '/api/thread/image?worker=w4&image=x'), 404, preset);
    assert.equal(await status(token, '/api/thread/image?worker=w1&image=x'), 200, preset);
  }
  const editFloor = make('edit-floor', { floorId: 'floor-a' }).token;
  assert.equal(await status(editFloor, '/api/thread/file?worker=w4&path=README.md'), 404);
  assert.equal(await status(editFloor, '/api/term/drop?worker=w4&name=x', 'POST', PNG), 404);

  const picked = make('view-worker', { floorId: 'floor-a', workerId: 'w4' }).token;
  assert.equal(await status(picked, picture), 200, 'the worker the owner picked is shared');
  assert.equal(await status(picked, `${picture}&repo=floor-b`), 404, 'but not its repository on another floor');

  const office = make('view-office').token;
  assert.equal(await status(office, `${picture}&repo=floor-b`), 200);
});

test('Whiteboard card frames load by capability only on floors an active link shows, held to scope when a token comes with them', async (t) => {
  const { http, make, links } = unitRig(t);
  const base = await listen(t, http.guestRequest, ORIGIN);
  const capA = `k${'a'.repeat(30)}`;
  const capB = `k${'b'.repeat(30)}`;
  const frame = (cap: string, token?: string) => call(base, `/whiteboard/c/${cap}/page.html${token ? `?g=${token}` : ''}`, { headers: { host: HOST } });
  assert.equal((await frame(capA)).status, 404, 'sharing on with no link opens no card');
  const worker = make('view-worker', { floorId: 'floor-a', workerId: 'w1' }).token;
  assert.equal((await frame(capA)).status, 404, 'a single-worker link opens no card');
  const floor = make('view-floor', { floorId: 'floor-a' }).token;
  assert.equal((await frame(capA)).body, 'floor-a:page.html');
  assert.equal((await frame(capB)).status, 404, 'a link for another floor does not open this one');
  assert.equal((await frame(capA, floor)).body, 'floor-a:page.html');
  assert.equal((await frame(capB, floor)).status, 404);
  assert.equal((await frame(capA, worker)).status, 404);
  assert.equal((await frame(capA, 'Z'.repeat(43))).status, 401);
  const office = make('view-office');
  assert.equal((await frame(capB)).body, 'floor-b:page.html', 'an office link shows every floor');
  links.revoke(office.link.id);
  assert.equal((await frame(capB)).status, 404, 'revoked links stop counting');
  links.setOn(false);
  assert.equal((await frame(capA)).status, 403);
});

test('the owner API creates one-time URLs, revokes, toggles and pages the audit', async (t) => {
  const { http, links, audit, transport } = unitRig(t);
  const base = await listen(t, async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    await http.ownerRequest(req, res, url.pathname, url, 'full');
  });
  const state = (await call(base, '/api/guest-links')).json() as GuestLinksState;
  assert.equal(state.manage, 'full');
  assert.equal(state.on, true);
  assert.equal(state.max, 32);
  assert.deepEqual(state.transport, { status: 'serving', origin: ORIGIN });
  assert.deepEqual(state.targets, [
    {
      id: 'floor-a',
      name: 'Droid Office',
      workers: [
        { id: 'w1', name: 'Worker w1' },
        { id: 'w2', name: 'Worker w2' },
        { id: 'w4', name: 'Worker w4' },
      ],
    },
    { id: 'floor-b', name: 'Website', workers: [{ id: 'w3', name: 'Worker w3' }] },
  ]);
  const post = (body: unknown) => call(base, '/api/guest-links', { method: 'POST', body: JSON.stringify(body) });
  const made = await post({ label: 'Alex - PR review', preset: 'edit-floor', floorId: 'floor-a', expiry: '24h' });
  assert.equal(made.status, 200);
  const created = made.json() as GuestLinkCreated;
  const token = /#g=([A-Za-z0-9_-]+)$/.exec(created.url)?.[1];
  assert.ok(created.url.startsWith(`${ORIGIN}/dashboard#g=`));
  assert.ok(token && links.verify(token).ok);
  assert.equal(created.link.floorName, 'Droid Office');
  assert.equal(created.state.links.length, 1);
  assert.ok(!(await call(base, '/api/guest-links')).body.includes(token!), 'the URL is shown once');
  assert.equal((await post({ label: '', preset: 'view-office' })).status, 400);
  assert.equal((await call(base, '/api/guest-links', { method: 'POST', body: 'nope' })).status, 400);
  transport.origin = undefined;
  transport.state = { status: 'unavailable', reason: 'Funnel is not enabled on your tailnet.' };
  const notReady = await post({ label: 'Sam', preset: 'view-office' });
  assert.equal(notReady.status, 409);
  assert.match(notReady.json().error, /Funnel is not enabled/);
  assert.equal((await call(base, `/api/guest-links/${created.link.id}`, { method: 'DELETE' })).json().links[0].status, 'revoked');
  assert.equal((await call(base, `/api/guest-links/${created.link.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await call(base, `/api/guest-links/${created.link.id}`, { method: 'PUT' })).status, 405);
  assert.equal((await call(base, '/api/guest-links', { method: 'PUT', body: '{"on":"yes"}' })).status, 400);
  const off = (await call(base, '/api/guest-links', { method: 'PUT', body: '{"on":false}' })).json() as GuestLinksState;
  assert.equal(off.on, false);
  assert.deepEqual(transport.sets, [false]);
  assert.equal((await post({ label: 'Sam', preset: 'view-office' })).status, 409);
  transport.state = { status: 'off', locked: 'External sharing is disabled by DROID_OFFICE_GUEST_SHARING=off.' };
  assert.equal((await call(base, '/api/guest-links', { method: 'PUT', body: '{"on":true}' })).status, 403);
  assert.equal(links.on, false);
  const g = { linkId: created.link.id, label: created.link.label, preset: created.link.preset };
  for (let i = 0; i < 5; i++) audit.record({ grant: g, target: { kind: 'floor', floorId: 'floor-a' }, action: 'git', detail: `merge ${i}` });
  const page = (await call(base, '/api/guest-links/audit?limit=2')).json();
  assert.deepEqual(
    page.entries.map((e: { detail: string }) => e.detail),
    ['merge 4', 'merge 3'],
  );
  const next = (await call(base, `/api/guest-links/audit?limit=2&before=${page.next}`)).json();
  assert.deepEqual(
    next.entries.map((e: { detail: string }) => e.detail),
    ['merge 2', 'merge 1'],
  );
  assert.equal((await call(base, '/api/guest-links/audit', { method: 'DELETE' })).status, 405);
});

test('a limited owner request reads, revokes and turns sharing off, but never creates or turns it on', async (t) => {
  const { http, links, make, transport } = unitRig(t);
  const base = await listen(t, async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    await http.ownerRequest(req, res, url.pathname, url, 'limited');
  });
  const live = make('view-office');
  const state = (await call(base, '/api/guest-links')).json() as GuestLinksState;
  assert.equal(state.manage, 'limited');
  assert.equal(state.links[0].label, 'view-office link');
  assert.equal((await call(base, '/api/guest-links/audit')).status, 200);
  const create = await call(base, '/api/guest-links', { method: 'POST', body: JSON.stringify({ label: 'Sam', preset: 'view-office' }) });
  assert.equal(create.status, 403);
  assert.match(create.json().error, /only from the office itself/);
  assert.equal(links.list().length, 1);
  const revoked = (await call(base, `/api/guest-links/${live.link.id}`, { method: 'DELETE' })).json() as GuestLinksState;
  assert.equal(revoked.links[0].status, 'revoked');
  assert.equal(revoked.manage, 'limited');
  const off = (await call(base, '/api/guest-links', { method: 'PUT', body: '{"on":false}' })).json() as GuestLinksState;
  assert.equal(off.on, false);
  assert.equal((await call(base, '/api/guest-links', { method: 'PUT', body: '{"on":true}' })).status, 403);
  assert.equal(links.on, false);
  assert.deepEqual(transport.sets, [false]);
});

test('the menu bar counts only the owner’s connections, never a guest’s', () => {
  const client = (extra: Record<string, unknown>) => ({ ws: {}, dashboard: true, ...extra }) as never;
  assert.deepEqual(ownerDevices([client({}), client({ phoneSizes: {} }), client({ guest: { linkId: 'x' } })]), [
    { device: undefined, phone: false },
    { device: undefined, phone: true },
  ]);
  assert.equal(isGuestClient(client({ guest: { linkId: 'x' } })), true);
  assert.equal(isGuestClient(client({})), false);
});

test('in a running office, guest tokens work only on the guest backend and management only on the owner’s own page', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'guest-office-'));
  const cfg = loadConfig(['--home', home, '--projects', home, home, '--trust-proxy', '--weather', 'clear']);
  cfg.port = 0;
  const office = await startServer(cfg);
  const local = `http://127.0.0.1:${(office.server.address() as AddressInfo).port}`;
  t.after(async () => {
    const closed = once(office.server, 'close');
    await office.shutdown();
    office.server.closeAllConnections();
    await closed;
    rmSync(home, { recursive: true, force: true });
  });
  const own = { origin: local };
  const state = await call(local, '/api/guest-links', { headers: own });
  assert.equal(state.status, 200);
  const initial = state.json() as GuestLinksState;
  assert.equal(initial.on, false, 'a new office starts with sharing off');
  assert.equal(initial.transport.locked, 'External sharing is disabled by DROID_OFFICE_GUEST_SHARING=off.', 'tests never reach Funnel');
  assert.equal((await call(local, '/api/guest-links', { method: 'PUT', headers: own, body: '{"on":true}' })).status, 403);
  assert.equal((await call(local, '/api/guest-links', { headers: { origin: 'https://evil.test' } })).status, 403);
  const pair = await call(local, '/api/mobile/pair', { method: 'POST', body: '{"device":"Pixel 10 Pro XL"}' });
  const device = pair.json().token as string;
  assert.equal(initial.manage, 'full', 'the office’s own page manages everything');
  const phone = { ...own, authorization: `Bearer ${device}` };
  const phoneState = await call(local, '/api/guest-links', { headers: phone });
  assert.equal(phoneState.status, 200);
  assert.equal((phoneState.json() as GuestLinksState).manage, 'limited', 'a paired phone may look');
  assert.equal((await call(local, '/api/guest-links', { method: 'POST', headers: phone, body: '{"label":"x","preset":"view-office"}' })).status, 403, 'but never create a link');
  assert.equal((await call(local, '/api/guest-links', { method: 'PUT', headers: phone, body: '{"on":true}' })).status, 403);
  assert.equal((await call(local, '/api/guest-links', { method: 'PUT', headers: phone, body: '{"on":false}' })).status, 200, 'it may always turn sharing off');
  const proxy = await tailnetProxy(t, office.server);
  const tailnet = await proxy.fetch(`${proxy.base}/api/guest-links?t=${office.lanToken}`, { headers: { origin: proxy.origin, 'sec-fetch-site': 'same-origin' } });
  assert.equal(tailnet.status, 200);
  assert.equal(((await tailnet.json()) as GuestLinksState).manage, 'limited', 'so is a tailnet browser');

  const { links, audit, request: guestRequest } = office.guests;
  links.setOn(true);
  const floorId = office.floors()[0].id;
  const made = links.create({ label: 'Alex - PR review', preset: 'edit-floor', floorId, expiry: 'never' });
  assert.ok(made.ok);
  const bearer = { authorization: `Bearer ${made.token}` };
  assert.equal((await call(local, '/api/health', { headers: bearer })).status, 401, 'the main listener refuses guest tokens');
  assert.equal((await call(local, '/api/mobile/hello', { headers: bearer })).status, 401);
  assert.equal((await call(local, '/api/guest/hello', { headers: bearer })).status, 401);
  assert.equal((await proxy.fetch(`${proxy.base}/api/health`, { headers: bearer })).status, 401, 'so does the tailnet listener');

  const guest = await listen(t, guestRequest, ORIGIN);
  const g = (p: string, opts: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}) => call(guest, p, { ...opts, headers: { host: HOST, ...opts.headers } });
  assert.equal((await g('/api/guest/hello', { headers: bearer })).json().session.floorId, floorId);
  assert.equal((await g(`/api/health?t=${office.lanToken}`)).status, 404);
  assert.equal((await g(`/api/mobile/pairing?t=${office.lanToken}`)).status, 404);
  assert.equal((await g('/api/guest/hello', { headers: { authorization: `Bearer ${device}` } })).status, 401, 'device tokens do not open the guest backend');
  assert.equal((await g('/api/guest/hello')).status, 401, 'loopback is not trusted there');
  const upload = await g(`/api/prompt/image?floor=${encodeURIComponent(floorId)}&name=shot.png`, { method: 'POST', headers: { ...bearer, origin: ORIGIN }, body: PNG });
  assert.equal(upload.status, 200);
  assert.match(upload.json().id, /^[0-9a-f]{16}$/);
  const entry = audit.read().entries[0];
  assert.equal(entry.linkLabel, 'Alex - PR review');
  assert.equal(entry.action, 'upload');
  assert.equal(entry.target.floorId, floorId);
  const listed = (await call(local, '/api/guest-links', { headers: own })).json() as GuestLinksState;
  assert.equal(listed.links[0].label, 'Alex - PR review');
  assert.equal(listed.targets[0].id, floorId);

  // A request the guest backend marks never reaches office routes, even through the main handler.
  const marked = await listen(t, (req, res) => office.server.emit('request', req, res), ORIGIN);
  assert.equal((await call(marked, '/api/health', { headers: { host: HOST } })).status, 404);
  assert.equal((await call(marked, `/api/mobile/pairing?t=${office.lanToken}`, { headers: { host: HOST } })).status, 404);
});
