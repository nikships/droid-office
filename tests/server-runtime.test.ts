import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebSocket } from 'ws';
import type { Floor } from '../src/server/floor.js';
import type { DevicesStore } from '../src/server/devices.js';
import type { Client } from '../src/server/server-runtime/client.js';
import { createClientTransport } from '../src/server/server-runtime/transport.js';
import { createHttpHandler } from '../src/server/server-runtime/http.js';
import { isFloorHttpPath } from '../src/server/server-runtime/floor-http.js';

function connection(id: string, floor = 'a') {
  const sent: unknown[] = [];
  let pings = 0;
  let terminated = 0;
  const ws = {
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    send(data: unknown) {
      sent.push(JSON.parse(String(data)));
    },
    close() {},
    ping() {
      pings++;
    },
    terminate() {
      terminated++;
    },
  };
  const client: Client = {
    id,
    ws,
    floor,
    peer: { name: id, color: '#4f86f7' },
    attached: new Set(),
    stale: new Set(),
    lastGongAt: 0,
    isAlive: true,
    dashboard: false,
    requests: new Set(),
    boards: new Map(),
  };
  return { client, ws, sent, pings: () => pings, terminated: () => terminated };
}

test('transport preserves floor routing, exclusions and exact droppable buffer threshold', () => {
  const a = connection('a');
  const b = connection('b', 'b');
  const closed = connection('closed');
  closed.ws.readyState = WebSocket.CLOSED;
  const clients = new Map([a, b, closed].map((c) => [c.client.id, c.client]));
  const transport = createClientTransport({ clients, floors: new Map() });
  const floor = { id: 'a' } as Floor;
  const msg = { t: 'pong' as const, at: 1, now: 2 };

  b.ws.bufferedAmount = 4 * 1024 * 1024;
  assert.equal(transport.broadcast(msg, 'a', true), false);
  assert.deepEqual(b.sent, [msg], 'the exact threshold still sends');
  assert.equal(a.sent.length, 0);
  assert.equal(closed.sent.length, 0);
  b.ws.bufferedAmount++;
  assert.equal(transport.broadcast(msg, 'a', true), true);
  assert.equal(b.sent.length, 1);
  assert.equal(transport.toFloor(floor, msg, true), false);
  assert.deepEqual(a.sent, [msg]);
  assert.equal(transport.broadcast(msg), false, 'non-droppable messages ignore backpressure');
  assert.equal(b.sent.length, 2);
});

test('terminal delivery marks stale once, resnapshots attached terminals after recovery, and stops timers', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const a = connection('a');
  const clients = new Map([[a.client.id, a.client]]);
  const transport = createClientTransport({ clients, floors: new Map() });
  const attached: string[] = [];
  const seen: string[] = [];
  const stop = transport.startTimers(
    (wid) => {
      attached.push(wid);
      return { data: 'current screen', cols: 80, rows: 24, shared: true };
    },
    { seen: (id: string) => seen.push(id) } as DevicesStore,
  );
  t.after(stop);
  a.client.device = 'phone';
  a.client.attached.add('worker');
  a.ws.bufferedAmount = 8 * 1024 * 1024;
  transport.termData('worker', 'first', ['missing', a.client.id]);
  assert.equal(a.sent.length, 1, 'the exact terminal threshold sends');
  a.ws.bufferedAmount++;
  transport.termData('worker', 'skipped', [a.client.id]);
  assert.deepEqual([...a.client.stale], ['worker']);
  a.ws.bufferedAmount = 0;
  transport.termData('worker', 'also skipped until snapshot', [a.client.id]);
  a.client.stale.add('detached');
  a.ws.bufferedAmount = 1024 * 1024 + 1;
  t.mock.timers.tick(1000);
  assert.equal(attached.length, 0);
  a.ws.bufferedAmount--;
  t.mock.timers.tick(1000);
  assert.deepEqual(attached, ['worker']);
  assert.equal(a.client.stale.size, 0);
  assert.deepEqual(a.sent.at(-1), { t: 'term.snapshot', workerId: 'worker', data: 'current screen', cols: 80, rows: 24, shared: true });
  t.mock.timers.tick(18_000);
  assert.equal(a.pings(), 1);
  assert.deepEqual(seen, ['phone']);
  t.mock.timers.tick(20_000);
  assert.equal(a.terminated(), 1, 'missing pong terminates rather than pinging again');
  stop();
  t.mock.timers.tick(40_000);
  assert.equal(a.pings(), 1);
  assert.equal(a.terminated(), 1);
});

test('off-floor screen coalescing uses the latest frame and cancels removed-worker and shutdown work', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  const local = connection('local');
  const remote = connection('remote', 'b');
  const slow = connection('slow', 'b');
  slow.ws.bufferedAmount = 4 * 1024 * 1024 + 1;
  let generation = 0;
  const floor = {
    id: 'a',
    workers: {
      get: () => ({ status: 'needs_input' }),
      fullScreen: () => ({ cols: 80, rows: 24, seq: generation, lines: {} }),
    },
  } as unknown as Floor;
  const floors = new Map([[floor.id, floor]]);
  const clients = new Map([local, remote, slow].map((c) => [c.client.id, c.client]));
  const transport = createClientTransport({ clients, floors });
  t.after(() => transport.clearOffFloorScreens());
  transport.broadcastOffFloorScreen(floor, 'worker');
  generation = 1;
  transport.broadcastOffFloorScreen(floor, 'worker');
  generation = 2;
  transport.broadcastOffFloorScreen(floor, 'worker');
  assert.equal(remote.sent.length, 1);
  t.mock.timers.tick(49);
  assert.equal(remote.sent.length, 1);
  t.mock.timers.tick(1);
  assert.equal(remote.sent.length, 2);
  assert.equal((remote.sent[1] as { seq: number }).seq, 2);
  assert.equal(local.sent.length, 0);
  assert.equal(slow.sent.length, 0);
  transport.broadcastOffFloorScreen(floor, 'worker');
  transport.clearOffFloorThrottle('worker');
  t.mock.timers.tick(50);
  assert.equal(remote.sent.length, 2);
  transport.broadcastOffFloorScreen(floor, 'worker');
  transport.broadcastOffFloorScreen(floor, 'worker');
  floors.delete(floor.id);
  t.mock.timers.tick(50);
  assert.equal(remote.sent.length, 3, 'a removed floor never flushes its pending frame');
  floors.set(floor.id, floor);
  transport.broadcastOffFloorScreen(floor, 'worker');
  transport.broadcastOffFloorScreen(floor, 'worker');
  transport.clearOffFloorScreens();
  const before = remote.sent.length;
  t.mock.timers.tick(1000);
  assert.equal(remote.sent.length, before);
});

function response() {
  const output = { status: 0, body: '', headers: {} };
  const res = {
    headersSent: false,
    writeHead(status: number, headers: object = {}) {
      output.status = status;
      output.headers = headers;
      this.headersSent = true;
      return this;
    },
    end(body = '') {
      output.body = body;
      return this;
    },
  } as unknown as ServerResponse;
  return { res, output };
}

function request(url: string, method = 'GET', origin?: string): IncomingMessage {
  return { url, method, headers: { host: 'localhost:1234', ...(origin ? { origin } : {}) }, socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage;
}

function httpContext(overrides: Partial<Parameters<typeof createHttpHandler>[0]> = {}) {
  const calls: string[] = [];
  const context = {
    cfg: { trustProxy: false },
    companion: { on: true },
    devices: { seen: () => calls.push('seen') },
    access: () => {
      calls.push('access');
      return { ok: true };
    },
    publicFile: () => undefined,
    floorRequest: async () => {
      calls.push('floor');
    },
    serveCard: () => calls.push('card'),
    refuseHttp: () => calls.push('refused'),
    ...overrides,
  } as unknown as Parameters<typeof createHttpHandler>[0];
  return { calls, handler: createHttpHandler(context) };
}

test('HTTP capability routes bypass office auth, while floor APIs do not', async () => {
  const { calls, handler } = httpContext({ access: () => ({ ok: false }) });
  await handler(request('/whiteboard/c/any-cap/index.html'), response().res);
  assert.deepEqual(calls, ['card']);
  await handler(request('/api/docs'), response().res);
  assert.deepEqual(calls, ['card', 'refused']);
});

test('HTTP rejects foreign origins before floor resource dispatch', async () => {
  const { calls, handler } = httpContext();
  const { res, output } = response();
  await handler(request('/api/docs', 'GET', 'https://foreign.example'), res);
  assert.equal(output.status, 403);
  assert.deepEqual(calls, ['access']);
});

test('asynchronous extracted floor failures retain the HTTP handler error response', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { handler } = httpContext({
    floorRequest: async () => {
      throw new Error('resource failure');
    },
  });
  const { res, output } = response();
  await handler(request('/api/docs'), res);
  assert.equal(output.status, 500);
  assert.deepEqual(JSON.parse(output.body), { error: 'Internal error' });
  assert.equal(errors.mock.callCount(), 1);
});

test('floor route selection preserves method fallthrough and prefix semantics', () => {
  const writes = ['/api/term/drop', '/api/prompt/image', '/api/decor/picture', '/api/changes/file', '/api/factory/x', '/api/docs-extra', '/api/whiteboard/blob'];
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) for (const route of writes) assert.equal(isFloorHttpPath(route, method), true, `${method} ${route}`);
  const reads = ['/api/thread/image', '/api/linear/issue', '/api/linear/image', '/api/jira/ticket', '/api/search', '/api/gh/pull'];
  for (const route of reads) {
    assert.equal(isFloorHttpPath(route, 'GET'), true, route);
    assert.equal(isFloorHttpPath(route, 'POST'), false, route);
  }
  for (const route of ['/', '/index.html', '/api/health', '/api/factory', '/api/whiteboard', '/api/linear/image/extra']) assert.equal(isFloorHttpPath(route, 'GET'), false, route);
});
