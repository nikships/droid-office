import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Server as NetServer, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { TailnetHttps, TAILNET_HTTPS_FILE } from '../src/server/tailnet-https.js';
import { TailscaleCli, type ServeRoute } from '../src/server/tailscale.js';
import { isLocalRequest } from '../src/server/lan.js';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { tailnetProxy } from './tailnet-proxy.js';

const DNS = 'office-mac.tail08b849.ts.net';
// Identity and route shapes from the real Tailscale captures in remote-mcp.test.ts.
class ServeCli extends TailscaleCli {
  up = true;
  mappings: ServeRoute[] = [];
  calls: string[] = [];
  failure?: { ok: false; message: string; fixUrl?: string };
  serving?: () => Promise<void>;
  constructor() {
    super([]);
  }
  override async self() {
    return this.up ? { dnsName: DNS, ips: ['100.101.102.103'], login: 'owner@example.com' } : undefined;
  }
  override async routes() {
    return this.mappings.map((r) => ({ ...r }));
  }
  override async serve(port: number, proxy: string) {
    await this.serving?.();
    this.calls.push(`serve:${port}`);
    if (this.failure) return this.failure;
    this.mappings = [...this.mappings.filter((r) => r.port !== port), { port, proxy, funnel: false }];
    return { ok: true as const };
  }
  override async unserve(port: number) {
    this.calls.push(`off:${port}`);
    this.mappings = this.mappings.filter((r) => r.port !== port);
    return true;
  }
}

function rig(t: TestContext, cli = new ServeCli()) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'tailnet-https-'));
  const make = () =>
    new TailnetHttps({
      dataDir,
      cli,
      retryMs: 60_000,
      request: (req, res) => res.end(String(isLocalRequest(req))),
      upgrade: (_req, socket) => socket.destroy(),
    });
  const service = make();
  t.after(() => {
    service.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { cli, service, make, file: path.join(dataDir, TAILNET_HTTPS_FILE) };
}

function status(backend: string, host: string, headers: Record<string, string> = {}): Promise<{ code: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(backend, { headers: { host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += String(c);
      });
      res.on('end', () => resolve({ code: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('HTTPS starts by default, avoids occupied ports, preserves its URL across restarts and disables only its own mapping', async (t) => {
  const { cli, service, make, file } = rig(t);
  cli.mappings = [
    { port: 443, proxy: 'http://127.0.0.1:3000', funnel: false },
    { port: 8443, proxy: 'http://127.0.0.1:4611', funnel: false },
  ];
  assert.equal(service.state().on, true);
  const ready = await service.start();
  assert.equal(ready.status, 'serving');
  assert.equal(ready.origin, `https://${DNS}:8444`);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const backend = `http://127.0.0.1:${saved.backendPort}`;
  assert.deepEqual(await status(backend, `${DNS}:8444`), { code: 200, body: 'false' });
  for (const headers of [{ host: 'localhost' }, { origin: `http://${DNS}:8444` }, { 'tailscale-funnel-request': '' }, { 'tailscale-user-login': 'shared@example.com' }]) {
    assert.equal((await status(backend, `${DNS}:8444`, headers)).code, 403);
  }
  assert.equal((await status(backend, `${DNS}:8444`, { 'tailscale-user-login': 'OWNER@example.com' })).code, 200);
  service.stop();
  const again = make();
  t.after(() => again.stop());
  assert.equal((await again.start()).origin, ready.origin);
  assert.deepEqual(cli.calls, ['serve:8444'], 'an unchanged mapping needs no rewrite');
  assert.equal((await again.set(false)).status, 'off');
  assert.deepEqual(cli.calls, ['serve:8444', 'off:8444']);
  assert.deepEqual(
    cli.mappings.map((r) => r.port),
    [443, 8443],
  );
  const disabled = make();
  t.after(() => disabled.stop());
  assert.equal((await disabled.start()).on, false);
  assert.deepEqual(cli.calls, ['serve:8444', 'off:8444']);
});

test('missing Tailscale and admin approval are actionable and recover without changing the local listener', async (t) => {
  const { cli, service } = rig(t);
  cli.up = false;
  assert.equal((await service.start()).status, 'unavailable');
  cli.up = true;
  cli.failure = { ok: false, message: 'HTTPS is not enabled on your tailnet.', fixUrl: 'https://login.tailscale.com/f/serve' };
  assert.equal((await service.start()).fixUrl, cli.failure.fixUrl);
  cli.failure = undefined;
  assert.equal((await service.start()).status, 'serving');
  assert.equal(service.state().reason, undefined);
});

test('a failed backend bind is discarded so the next attempt can listen', async (t) => {
  const { service } = rig(t);
  const listen = t.mock.method(NetServer.prototype, 'listen', function (this: NetServer) {
    queueMicrotask(() => this.emit('error', Object.assign(new Error('Denied'), { code: 'EACCES' })));
    return this;
  });
  assert.equal((await service.start()).status, 'unavailable');
  listen.mock.restore();
  assert.equal((await service.start()).status, 'serving');
});

test('a failed settings write still closes remote access immediately', async (t) => {
  const { service, file } = rig(t);
  await service.start();
  const { backendPort } = JSON.parse(readFileSync(file, 'utf8'));
  rmSync(file);
  mkdirSync(file);
  assert.throws(() => service.set(false), /EISDIR/);
  assert.equal(service.state().status, 'off');
  await assert.rejects(status(`http://127.0.0.1:${backendPort}`, `${DNS}:8443`));
});

test('backend collisions move only the owned HTTPS mapping; an outside replacement is never removed', async (t) => {
  const { cli, service, file } = rig(t);
  await service.start();
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  service.stop();
  const occupied = createServer();
  occupied.listen(saved.backendPort, '127.0.0.1');
  await once(occupied, 'listening');
  t.after(() => occupied.close());
  const again = new TailnetHttps({ dataDir: path.dirname(file), cli, request: (_req, res) => res.end(), upgrade: (_req, s) => s.destroy() });
  t.after(() => again.stop());
  assert.equal((await again.start()).origin, `https://${DNS}:8443`);
  assert.notEqual(JSON.parse(readFileSync(file, 'utf8')).backendPort, saved.backendPort);
  cli.mappings[0].proxy = 'http://127.0.0.1:3999';
  await again.set(false);
  assert.equal(cli.mappings[0].proxy, 'http://127.0.0.1:3999');
});

test('Funnel and exhausted port tables fail closed without taking over another service', async (t) => {
  const { cli, service } = rig(t);
  await service.start();
  cli.mappings[0].funnel = true;
  assert.equal((await service.start()).status, 'unavailable');
  assert.equal(service.state().origin, undefined);
  assert.match(service.state().reason!, /Funnel/);
  cli.mappings = [8443, 8444, 8445, 8446, 8447, 8448, 8449, 10443].map((port) => ({ port, proxy: 'http://127.0.0.1:3999', funnel: false }));
  assert.equal((await service.start()).status, 'unavailable');
  assert.deepEqual(cli.calls, ['serve:8443']);
});

test('disabling during an in-flight enable closes immediately and cleans up the completed mapping', async (t) => {
  const { cli, service } = rig(t);
  let release!: () => void;
  let entered!: () => void;
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  cli.serving = () => {
    entered();
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  const enabling = service.start();
  await running;
  const disabling = service.set(false);
  assert.equal(service.state().status, 'off');
  release();
  await enabling;
  await disabling;
  assert.equal(service.state().origin, undefined);
  assert.deepEqual(cli.mappings, []);
});

test('two HTTPS services serialize Serve port allocation instead of overwriting one another', async (t) => {
  const cli = new ServeCli();
  const a = rig(t, cli);
  const b = rig(t, cli);
  const states = await Promise.all([a.service.start(), b.service.start()]);
  assert.deepEqual(states.map((s) => s.origin).sort(), [`https://${DNS}:8443`, `https://${DNS}:8444`]);
  assert.equal(cli.mappings.length, 2);
});

test('invalid saved ports fall back safely and stopping during discovery cannot start a backend', async (t) => {
  const { cli, service, make, file } = rig(t);
  service.stop();
  writeFileSync(file, '{"on":true,"backendPort":-1,"httpsPort":99999}');
  const again = make();
  t.after(() => again.stop());
  assert.equal((await again.start()).status, 'serving');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).httpsPort, 8443);
  await again.set(false);
  const stopped = make();
  cli.self = async () => {
    stopped.stop();
    return { dnsName: DNS, ips: [], login: 'owner@example.com' };
  };
  await stopped.set(true);
  assert.equal(stopped.state().origin, undefined);
  assert.deepEqual(cli.mappings, []);
});

test('Serve preserves pairing and WebSockets but can never access local owner routes, even with the start token', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tailnet-office-'));
  const cfg = loadConfig(['--home', home, '--projects', home, '--trust-proxy', '--weather', 'clear']);
  cfg.port = 0;
  const office = await startServer(cfg);
  const local = `http://127.0.0.1:${(office.server.address() as AddressInfo).port}`;
  t.after(async () => {
    const closed = once(office.server, 'close');
    office.shutdown();
    office.server.closeAllConnections();
    await closed;
    rmSync(home, { recursive: true, force: true });
  });
  const proxy = await tailnetProxy(t, office.server);
  const fetch = proxy.fetch;
  const headers = { origin: proxy.origin, 'sec-fetch-site': 'same-origin' };
  const bounce = await fetch(`${proxy.base}/open/floor/droid-office`, { headers: { 'user-agent': 'Android' }, redirect: 'manual' });
  assert.equal(bounce.status, 302);
  const intent = new URL(bounce.headers.get('location')!.split('#')[0]);
  assert.equal(intent.searchParams.get('u'), proxy.origin, 'Android links retain the external HTTPS origin, not the HTTP backend');
  for (const p of ['/api/mobile/pairing', '/api/remote-mcp', '/api/status']) {
    assert.equal((await fetch(`${proxy.base}${p}?t=${office.lanToken}`, { headers })).status, 403, p);
  }
  for (const p of ['/api/mobile/https', '/api/mobile/companion']) {
    assert.equal((await fetch(`${proxy.base}${p}?t=${office.lanToken}`, { method: 'PUT', headers, body: '{"on":false}' })).status, 403, p);
  }
  assert.equal((await fetch(`${proxy.base}/api/health?t=${office.lanToken}`, { headers: { origin: 'https://evil.test', 'x-forwarded-host': 'evil.test' } })).status, 403);
  assert.equal((await fetch(`${proxy.base}/api/health`, { headers: { 'x-forwarded-for': '127.0.0.1' } })).status, 401);
  const pair = await fetch(`${proxy.base}/api/mobile/pair?t=${office.lanToken}`, { method: 'POST', headers, body: '{"kind":"browser","device":"Chrome"}' });
  assert.equal(pair.status, 200);
  const { token, device } = await pair.json();
  const ws = new WebSocket(`${proxy.base.replace('http:', 'ws:')}/ws?d=${token}&client=dashboard`, { origin: proxy.origin, headers: { host: proxy.host } });
  t.after(() => ws.terminate());
  assert.equal(JSON.parse(String((await once(ws, 'message'))[0])).t, 'welcome');
  const closed = once(ws, 'close');
  assert.equal((await fetch(`${local}/api/mobile/devices/${device.id}`, { method: 'DELETE', headers: { origin: local } })).status, 200);
  assert.equal((await closed)[0], 4401);
  assert.equal((await fetch(`${proxy.base}/api/mobile/hello?d=${token}`)).status, 401);
  assert.equal((await fetch(`${local}/api/mobile/https`, { method: 'PUT', headers: { origin: local }, body: '{"on":"yes"}' })).status, 400);
});
