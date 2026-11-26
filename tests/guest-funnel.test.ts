import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { GUEST_FUNNEL_FILE, GuestFunnel } from '../src/server/guest-funnel.js';
import { TailnetHttps } from '../src/server/tailnet-https.js';
import { FUNNEL_PORTS, planFunnel, planServe, TailscaleCli, tailscaleSelf, useTailscaleBinary, type ServeRoute } from '../src/server/tailscale.js';
import { loadConfig } from '../src/server/config.js';
import { isGuestRequest, isLocalRequest, lanAllowed } from '../src/server/lan.js';

const DNS = 'office-mac.tail08b849.ts.net';
// Identity and route shapes from the real Tailscale captures in remote-mcp.test.ts.
class FunnelCli extends TailscaleCli {
  up = true;
  mappings: ServeRoute[] = [];
  calls: string[] = [];
  failure?: { ok: false; message: string; fixUrl?: string };
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
    this.calls.push(`serve:${port}`);
    this.mappings = [...this.mappings.filter((r) => r.port !== port), { port, proxy, funnel: false }];
    return { ok: true as const };
  }
  override async unserve(port: number) {
    this.calls.push(`serve-off:${port}`);
    this.mappings = this.mappings.filter((r) => r.port !== port);
    return true;
  }
  override async funnel(port: number, proxy: string) {
    this.calls.push(`funnel:${port}`);
    if (this.failure) return this.failure;
    this.mappings = [...this.mappings.filter((r) => r.port !== port), { port, proxy, funnel: true }];
    return { ok: true as const };
  }
  override async unfunnel(port: number) {
    this.calls.push(`funnel-off:${port}`);
    this.mappings = this.mappings.filter((r) => r.port !== port);
    return true;
  }
}

function rig(t: TestContext, cli = new FunnelCli(), extra: Partial<ConstructorParameters<typeof GuestFunnel>[0]> = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'guest-funnel-'));
  const make = () =>
    new GuestFunnel({
      dataDir,
      cli,
      retryMs: 60_000,
      request: (req, res) => res.end(JSON.stringify({ guest: isGuestRequest(req), local: isLocalRequest(req), lan: lanAllowed(req, new URL(req.url ?? '/', 'http://x'), 'tok') })),
      upgrade: (_req, socket) => socket.destroy(),
      ...extra,
    });
  const funnel = make();
  t.after(async () => {
    await funnel.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { cli, funnel, make, dataDir, file: path.join(dataDir, GUEST_FUNNEL_FILE) };
}

function get(backend: string, headers: Record<string, string>): Promise<{ code: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request(backend, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += String(c);
      });
      res.on('end', () => resolve({ code: res.statusCode!, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

test('planFunnel uses only Funnel ports and never takes a port another mapping uses', () => {
  assert.deepEqual(FUNNEL_PORTS, [10000, 8443, 443]);
  const target = 'http://127.0.0.1:5000';
  assert.deepEqual(planFunnel([], target), { port: 10000, existing: false });
  assert.deepEqual(planFunnel([{ port: 10000, proxy: 'http://127.0.0.1:3000', funnel: true }], target), { port: 8443, existing: false });
  assert.deepEqual(planFunnel([{ port: 8443, proxy: target, funnel: true }], target), { port: 8443, existing: true });
  assert.deepEqual(planFunnel([{ port: 8443, proxy: target, funnel: false }], target), { port: 8443, existing: false }, 'a private mapping to our target is made public again');
  assert.deepEqual(planFunnel([], target, 8444), { port: 10000, existing: false }, 'a saved non-Funnel port is ignored');
  assert.equal(
    planFunnel(
      FUNNEL_PORTS.map((port) => ({ port, proxy: 'http://127.0.0.1:1', funnel: false })),
      target,
    ),
    undefined,
  );
  assert.deepEqual(planServe([{ port: 8443, proxy: target, funnel: true }], target), { port: 8443, existing: true }, 'planServe is unchanged');
});

test('sharing on publishes a Funnel next to the tailnet Serve mapping without touching it; off removes only its own', async (t) => {
  const cli = new FunnelCli();
  const { funnel, file, make } = rig(t, cli);
  const tailnetDir = mkdtempSync(path.join(os.tmpdir(), 'guest-funnel-tailnet-'));
  const tailnet = new TailnetHttps({ dataDir: tailnetDir, cli, retryMs: 60_000, request: (_req, res) => res.end(), upgrade: (_req, s) => s.destroy() });
  t.after(() => {
    tailnet.stop();
    rmSync(tailnetDir, { recursive: true, force: true });
  });
  assert.equal((await tailnet.start()).origin, `https://${DNS}:8443`);
  assert.deepEqual(funnel.state(), { status: 'off' });
  const on = await funnel.set(true);
  assert.equal(on.status, 'serving');
  assert.equal(on.origin, `https://${DNS}:10000`);
  assert.equal(funnel.origin(), on.origin);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(saved.httpsPort, 10000);
  assert.deepEqual(
    cli.mappings.map((r) => [r.port, r.funnel]),
    [
      [8443, false],
      [10000, true],
    ],
  );
  const backend = `http://127.0.0.1:${saved.backendPort}`;
  const host = `${DNS}:10000`;
  const ok = await get(backend, { host, 'tailscale-funnel-request': '?1', 'x-forwarded-host': 'evil.test' });
  assert.equal(ok.code, 200);
  assert.deepEqual(JSON.parse(ok.body), { guest: true, local: false, lan: false }, 'a guest is never local and never takes the LAN token');
  assert.equal((await get(`${backend}/?t=tok`, { host })).code, 200);
  assert.equal(JSON.parse((await get(`${backend}/?t=tok`, { host })).body).lan, false);
  assert.equal((await get(backend, { host, 'tailscale-user-login': 'owner@example.com' })).code, 200, 'tailnet visitors on the guest URL are guests too');
  for (const headers of [{ host: 'localhost' }, { host: `${DNS}:8443` }, { host, origin: `http://${DNS}:10000` }, { host, origin: 'https://evil.test' }]) {
    assert.equal((await get(backend, headers)).code, 403, JSON.stringify(headers));
  }
  // The tailnet listener keeps refusing Funnel traffic.
  const tailnetPort = JSON.parse(readFileSync(path.join(tailnetDir, 'tailnet-https.json'), 'utf8')).backendPort;
  assert.equal((await get(`http://127.0.0.1:${tailnetPort}`, { host: `${DNS}:8443`, 'tailscale-funnel-request': '?1' })).code, 403);
  await funnel.stop();
  assert.deepEqual(
    cli.mappings.map((r) => r.port),
    [8443],
    'shutdown removes the public mapping',
  );
  await assert.rejects(get(backend, { host }), 'the guest backend is closed');
  const again = make();
  t.after(() => again.stop());
  assert.equal((await again.set(true)).origin, on.origin, 'the URL is the same after a restart');
  assert.equal((await again.set(false)).status, 'off');
  assert.deepEqual(cli.calls, ['serve:8443', 'funnel:10000', 'funnel-off:10000', 'funnel:10000', 'funnel-off:10000']);
  assert.deepEqual(
    cli.mappings.map((r) => r.port),
    [8443],
  );
  assert.equal((await tailnet.start()).status, 'serving', 'tailnet HTTPS is untouched');
});

test('an outside replacement of the guest port is never removed, and taken ports move the guest URL', async (t) => {
  const { cli, funnel, file } = rig(t);
  cli.mappings = [{ port: 10000, proxy: 'http://127.0.0.1:3000', funnel: true }];
  assert.equal((await funnel.set(true)).origin, `https://${DNS}:8443`);
  const port = JSON.parse(readFileSync(file, 'utf8')).httpsPort;
  cli.mappings.find((r) => r.port === port)!.proxy = 'http://127.0.0.1:3999';
  await funnel.set(false);
  assert.deepEqual(
    cli.mappings.map((r) => r.proxy),
    ['http://127.0.0.1:3000', 'http://127.0.0.1:3999'],
  );
  cli.mappings = FUNNEL_PORTS.map((p) => ({ port: p, proxy: 'http://127.0.0.1:3000', funnel: false }));
  const full = await funnel.set(true);
  assert.equal(full.status, 'unavailable');
  assert.match(full.reason!, /443, 8443 and 10000/);
});

test('missing Tailscale and Funnel approval are actionable, and a lock never runs the CLI', async (t) => {
  const { cli, funnel } = rig(t);
  cli.up = false;
  const down = await funnel.set(true);
  assert.equal(down.status, 'unavailable');
  assert.match(down.reason!, /Start Tailscale/);
  cli.up = true;
  cli.failure = { ok: false, message: 'Funnel is not enabled on your tailnet.', fixUrl: 'https://login.tailscale.com/f/funnel?node=abc' };
  const pending = await funnel.set(true);
  assert.equal(pending.fixUrl, cli.failure.fixUrl);
  assert.equal(pending.origin, undefined);
  cli.failure = undefined;
  assert.equal((await funnel.set(true)).status, 'serving');
  const locked = rig(t, new FunnelCli(), { locked: 'External sharing is disabled by DROID_OFFICE_GUEST_SHARING=off.' });
  assert.deepEqual(await locked.funnel.set(true), { status: 'unavailable', locked: 'External sharing is disabled by DROID_OFFICE_GUEST_SHARING=off.' });
  await locked.funnel.stop();
  assert.deepEqual(locked.cli.calls, []);
});

test('turning sharing off closes open guest WebSockets immediately, even while the CLI is slow', async (t) => {
  const wss = new WebSocketServer({ noServer: true });
  const cli = new FunnelCli();
  const { funnel, file } = rig(t, cli, { upgrade: (req, socket, head) => wss.handleUpgrade(req, socket, head, () => undefined) });
  t.after(() => wss.close());
  await funnel.set(true);
  const { backendPort } = JSON.parse(readFileSync(file, 'utf8'));
  const ws = new WebSocket(`ws://127.0.0.1:${backendPort}/ws`, { headers: { host: `${DNS}:10000` }, origin: `https://${DNS}:10000` });
  await once(ws, 'open');
  let release!: () => void;
  const self = cli.self.bind(cli);
  cli.self = () =>
    new Promise((resolve) => {
      release = () => {
        cli.self = self;
        resolve({ dnsName: DNS, ips: [], login: 'owner@example.com' });
      };
    });
  const closed = once(ws, 'close');
  const off = funnel.set(false);
  await closed;
  assert.equal(funnel.state().status, 'off');
  release();
  await off;
  assert.deepEqual(cli.mappings, []);
});

test('a mapping left by an unclean exit is reclaimed or removed at the next start, only by the office that made it', async (t) => {
  const cli = new FunnelCli();
  const { make, file, dataDir } = rig(t, cli);
  const office = realpathSync(dataDir);
  const leftover = (owner: string) => {
    writeFileSync(file, JSON.stringify({ office: owner, backendPort: 45678, httpsPort: 10000, published: true }));
    cli.mappings = [{ port: 10000, proxy: 'http://127.0.0.1:45678', funnel: true }];
    cli.calls = [];
  };

  leftover(office);
  const off = make();
  t.after(() => off.stop());
  assert.equal((await off.start(false)).status, 'off');
  assert.deepEqual(cli.calls, ['funnel-off:10000'], 'sharing off removes its own leftover mapping');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).published, false);
  await off.stop();

  leftover(office);
  const on = make();
  t.after(() => on.stop());
  const back = await on.start(true);
  assert.equal(back.origin, `https://${DNS}:10000`, 'sharing on keeps its URL');
  const { backendPort } = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(cli.mappings, [{ port: 10000, proxy: `http://127.0.0.1:${backendPort}`, funnel: true }], 'the mapping points at the live backend');
  await on.stop();
  assert.deepEqual(cli.mappings, []);

  // A copy of another office's file (a clone, a test run) is never its own mapping.
  leftover('/Users/owner/droid-office/.droid-office');
  const copy = make();
  t.after(() => copy.stop());
  await copy.start(false);
  assert.deepEqual(cli.calls, []);
  assert.equal((await copy.start(true)).origin, `https://${DNS}:8443`, 'it takes a free port instead');
  await copy.stop();
  assert.deepEqual(cli.mappings, [{ port: 10000, proxy: 'http://127.0.0.1:45678', funnel: true }], 'the other office’s mapping is untouched');

  // Locked never runs the CLI; it tells the owner how to remove its own leftover.
  leftover(office);
  const warn = t.mock.method(console, 'warn', () => undefined);
  const locked = new GuestFunnel({ dataDir, cli, request: (_q, s) => s.end(), upgrade: (_q, s) => s.destroy(), locked: 'External sharing is disabled by DROID_OFFICE_GUEST_SHARING=off.' });
  assert.deepEqual(await locked.start(true), { status: 'unavailable', locked: 'External sharing is disabled by DROID_OFFICE_GUEST_SHARING=off.' });
  await locked.stop();
  assert.deepEqual(cli.calls, []);
  assert.equal(cli.mappings.length, 1, 'the leftover stays for the owner to remove');
  assert.match(String(warn.mock.calls.at(-1)?.arguments[0]), /tailscale funnel --https=10000 off/);
});

test('DROID_OFFICE_TAILSCALE_BIN pins every call to one executable, with no fallback to an installed CLI', { skip: process.platform === 'win32' }, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tailscale-bin-'));
  t.after(() => {
    useTailscaleBinary(undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  // Trimmed from a real `tailscale status --json` (remote-mcp.test.ts).
  const status = { BackendState: 'Running', Self: { DNSName: `${DNS}.`, TailscaleIPs: ['100.101.102.103'], UserID: 1 }, User: { '1': { LoginName: 'owner@example.com' } }, CurrentTailnet: { MagicDNSEnabled: true } };
  const stub = path.join(dir, 'tailscale');
  writeFileSync(stub, `#!/bin/sh\n[ "$1" = status ] && printf '%s\\n' '${JSON.stringify(status)}'\n`, { mode: 0o755 });
  const prev = process.env.DROID_OFFICE_TAILSCALE_BIN;
  process.env.DROID_OFFICE_TAILSCALE_BIN = stub;
  t.after(() => (prev === undefined ? delete process.env.DROID_OFFICE_TAILSCALE_BIN : (process.env.DROID_OFFICE_TAILSCALE_BIN = prev)));
  const cfg = loadConfig(['--home', dir, '--projects', dir]);
  assert.equal(cfg.tailscaleBin, stub);
  useTailscaleBinary(cfg.tailscaleBin);
  assert.equal((await tailscaleSelf())?.dnsName, DNS);
  assert.equal((await new TailscaleCli().self())?.login, 'owner@example.com');
  // A stub that is gone answers nothing; the installed Tailscale is never tried instead.
  useTailscaleBinary(path.join(dir, 'missing'));
  assert.equal(await tailscaleSelf(), undefined);
  assert.equal(await new TailscaleCli().self(), undefined);
});
