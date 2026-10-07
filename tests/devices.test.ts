import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { DevicesStore, SEEN_EVERY_MS, cleanDeviceName, machineName, pairingAddresses } from '../src/server/devices.js';
import { TailscaleWatch, parseTailscaleStatus, tailscaleSelf } from '../src/server/tailscale.js';
import { bearerToken, isTailscaleIPv4, lanIPv4s, tailscaleIPv4s } from '../src/server/lan.js';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { DEVICES_MAX, DEVICE_NAME_MAX, pairingLink, type PairingState } from '../src/shared/devices.js';
import { AUTO_DESK } from '../src/shared/protocol.js';
import { DESKS, nextFreeSeat } from '../src/shared/layout.js';
import type { IncomingMessage } from 'node:http';

const tmp = (t: { after(fn: () => unknown): unknown }, prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// --- The store ------------------------------------------------------------------------------------

test('a paired phone keeps working across a new store, and only its hash is on disk', (t) => {
  const dir = tmp(t, 'devices-');
  const store = new DevicesStore(dir);
  const paired = store.pair('  Pixel 10 Pro XL \n');
  assert.ok(paired);
  assert.equal(paired.device.name, 'Pixel 10 Pro XL');
  assert.match(paired.device.id, /^[0-9a-f]{12}$/);
  assert.match(paired.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(store.verify(paired.token)?.id, paired.device.id);

  const file = path.join(dir, 'devices.json');
  const text = readFileSync(file, 'utf8');
  assert.ok(!text.includes(paired.token), 'the token itself is never written down');
  const saved = JSON.parse(text).devices[0];
  assert.match(saved.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(saved).sort(), ['hash', 'id', 'lastSeenAt', 'name', 'pairedAt']);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);

  // The office restarts: a new store reads the same file.
  const again = new DevicesStore(dir);
  assert.equal(again.verify(paired.token)?.name, 'Pixel 10 Pro XL');
  assert.equal(again.verify('not-a-token'), undefined);
  assert.equal(again.verify(''), undefined);
  assert.equal(again.verify(undefined), undefined);
  assert.deepEqual(
    again.list().map((d) => d.id),
    [paired.device.id],
  );
});

test('forgetting a phone stops its token at once, and for the next office too', (t) => {
  const dir = tmp(t, 'devices-');
  const store = new DevicesStore(dir);
  const a = store.pair('Pixel')!;
  const b = store.pair('Galaxy')!;
  assert.notEqual(a.token, b.token);
  assert.equal(store.forget(a.device.id), true);
  assert.equal(store.forget(a.device.id), false);
  assert.equal(store.verify(a.token), undefined);
  assert.equal(store.verify(b.token)?.name, 'Galaxy');
  assert.equal(new DevicesStore(dir).verify(a.token), undefined);
});

test('lastSeenAt is written down at most once a minute', (t) => {
  const dir = tmp(t, 'devices-');
  let now = Date.parse('2026-10-01T10:00:00Z');
  const store = new DevicesStore(dir, () => now);
  const { device } = store.pair('Pixel')!;
  const seen = () => JSON.parse(readFileSync(path.join(dir, 'devices.json'), 'utf8')).devices[0].lastSeenAt;
  now += SEEN_EVERY_MS - 1;
  store.seen(device.id);
  assert.equal(seen(), '2026-10-01T10:00:00.000Z');
  now += 1;
  store.seen(device.id);
  assert.equal(seen(), new Date(now).toISOString());
  store.seen('nobody');
  assert.equal(store.list()[0].lastSeenAt, new Date(now).toISOString());
});

test('the store caps how many phones pair, and survives a mangled file', (t) => {
  const dir = tmp(t, 'devices-');
  writeFileSync(path.join(dir, 'devices.json'), '{ not json');
  const store = new DevicesStore(dir);
  assert.deepEqual(store.list(), []);
  for (let i = 0; i < DEVICES_MAX; i++) assert.ok(store.pair(`Phone ${i}`));
  assert.equal(store.pair('One too many'), undefined);

  writeFileSync(path.join(dir, 'devices.json'), JSON.stringify({ devices: [{ id: 'x', hash: 'short' }, { id: 'y', hash: 'a'.repeat(64), name: 'Kept' }, null] }));
  assert.deepEqual(
    new DevicesStore(dir).list().map((d) => d.name),
    ['Kept'],
  );
});

test('device names are one clean line', () => {
  assert.equal(cleanDeviceName('Pixel\u0000 10\tPro\u009b'), 'Pixel 10 Pro');
  assert.equal(cleanDeviceName(''), 'Android phone');
  assert.equal(cleanDeviceName(42), 'Android phone');
  assert.equal(cleanDeviceName('x'.repeat(200)).length, DEVICE_NAME_MAX);
  assert.ok(machineName().length > 0);
});

// --- The pairing link and its addresses --------------------------------------------------------------

test('the pairing link carries the name, the token and every base URL, encoded', () => {
  const link = pairingLink("Nik's MacBook Pro (2)", 'tok_en-1', ['http://192.168.1.20:4600', 'http://my-mac.tail1.ts.net:4600']);
  assert.ok(link.startsWith('droidoffice://pair?v=1&'));
  assert.doesNotMatch(link.slice('droidoffice://pair?'.length), /[()'!*:/ ]/);
  const q = new URL(link).searchParams;
  assert.equal(q.get('v'), '1');
  assert.equal(q.get('name'), "Nik's MacBook Pro (2)");
  assert.equal(q.get('t'), 'tok_en-1');
  assert.deepEqual(q.getAll('u'), ['http://192.168.1.20:4600', 'http://my-mac.tail1.ts.net:4600']);
});

test('pairing addresses: Wi-Fi first, then the MagicDNS name, then tailnet IPs; none on loopback', () => {
  const tailscale = { dnsName: 'my-mac.tail1.ts.net', ips: ['100.96.1.2'] };
  assert.deepEqual(pairingAddresses({ scheme: 'http', host: '0.0.0.0', port: 4600, lan: ['192.168.1.20', '100.96.1.2'], tailscale, tailscaleIps: ['100.96.1.2', '100.64.0.9'] }), [
    { url: 'http://192.168.1.20:4600', kind: 'wifi' },
    { url: 'http://my-mac.tail1.ts.net:4600', kind: 'tailscale', dns: true },
    { url: 'http://100.96.1.2:4600', kind: 'tailscale' },
    { url: 'http://100.64.0.9:4600', kind: 'tailscale' },
  ]);
  assert.deepEqual(pairingAddresses({ scheme: 'https', host: '::', port: 1, lan: [] }), []);
  for (const host of ['127.0.0.1', '::1', 'localhost']) assert.deepEqual(pairingAddresses({ scheme: 'http', host, port: 4600, lan: ['192.168.1.20'], tailscale }), [], host);
  assert.deepEqual(pairingAddresses({ scheme: 'https', host: '192.168.1.20', port: 4600, lan: ['10.0.0.1'], tailscale }), [{ url: 'https://192.168.1.20:4600', kind: 'wifi' }]);
  assert.deepEqual(pairingAddresses({ scheme: 'http', host: '100.96.1.2', port: 4600, lan: [] }), [{ url: 'http://100.96.1.2:4600', kind: 'tailscale' }]);
  assert.deepEqual(pairingAddresses({ scheme: 'http', host: 'fe80::1', port: 4600, lan: [] }), [{ url: 'http://[fe80::1]:4600', kind: 'wifi' }]);
});

// --- Tailscale ---------------------------------------------------------------------------------------

test('tailnet addresses are 100.64.0.0/10 and never listed as Wi-Fi', () => {
  for (const ip of ['100.64.0.1', '100.96.217.59', '100.127.255.255']) assert.equal(isTailscaleIPv4(ip), true, ip);
  for (const ip of ['100.63.0.1', '100.128.0.1', '10.0.0.1', '192.168.0.148', 'fd7a::1']) assert.equal(isTailscaleIPv4(ip), false, ip);
  for (const ip of lanIPv4s()) assert.equal(isTailscaleIPv4(ip), false, ip);
  for (const ip of tailscaleIPv4s()) assert.equal(isTailscaleIPv4(ip), true, ip);
});

test('tailscale status --json: the MagicDNS name (no trailing dot) and the IPv4s', () => {
  assert.deepEqual(parseTailscaleStatus({ BackendState: 'Running', Self: { DNSName: 'My-Mac.tail1.ts.net.', TailscaleIPs: ['100.96.1.2', 'fd7a:115c::1'] }, CurrentTailnet: { MagicDNSEnabled: true } }), {
    dnsName: 'my-mac.tail1.ts.net',
    ips: ['100.96.1.2'],
  });
  assert.deepEqual(parseTailscaleStatus({ BackendState: 'Running', Self: { DNSName: 'my-mac.tail1.ts.net.', TailscaleIPs: ['100.96.1.2'] }, CurrentTailnet: { MagicDNSEnabled: false } }), { ips: ['100.96.1.2'] });
  assert.equal(parseTailscaleStatus({ BackendState: 'Stopped', Self: { DNSName: 'a.b.', TailscaleIPs: ['100.96.1.2'] } }), undefined);
  assert.equal(parseTailscaleStatus({ BackendState: 'Running', Self: { DNSName: '', TailscaleIPs: [] } }), undefined);
  assert.equal(parseTailscaleStatus({ BackendState: 'Running' }), undefined);
  assert.equal(parseTailscaleStatus(null), undefined);
});

test('tailscaleSelf asks the first CLI that answers, and copes with none', { skip: process.platform === 'win32' }, async (t) => {
  const dir = tmp(t, 'tailscale-');
  const ok = path.join(dir, 'tailscale-ok');
  writeFileSync(ok, `#!/bin/sh\necho '{"BackendState":"Running","Self":{"DNSName":"box.tail1.ts.net.","TailscaleIPs":["100.100.1.1"]}}'\n`);
  const junk = path.join(dir, 'tailscale-junk');
  writeFileSync(junk, '#!/bin/sh\necho not json\n');
  const slow = path.join(dir, 'tailscale-slow');
  writeFileSync(slow, '#!/bin/sh\nsleep 5\n');
  for (const f of [ok, junk, slow]) chmodSync(f, 0o755);
  assert.deepEqual(await tailscaleSelf([path.join(dir, 'missing'), junk, slow, ok], 300), { dnsName: 'box.tail1.ts.net', ips: ['100.100.1.1'] });
  assert.equal(await tailscaleSelf([path.join(dir, 'missing'), junk], 300), undefined);
});

test('TailscaleWatch asks once per interval, even when asked at the same time', async () => {
  let now = 0;
  let asked = 0;
  const watch = new TailscaleWatch(
    async () => {
      asked++;
      return { ips: [`100.64.0.${asked}`] };
    },
    1000,
    () => now,
  );
  const [a, b] = await Promise.all([watch.get(), watch.get()]);
  assert.deepEqual(a, b);
  assert.equal(asked, 1);
  now = 999;
  await watch.get();
  assert.equal(asked, 1);
  now = 1000;
  assert.deepEqual(await watch.get(), { ips: ['100.64.0.2'] });
  const failing = new TailscaleWatch(() => Promise.reject(new Error('boom')));
  assert.equal(await failing.get(), undefined);
});

test('bearerToken reads only a Bearer authorization', () => {
  const req = (authorization?: string) => ({ headers: authorization === undefined ? {} : { authorization } }) as IncomingMessage;
  assert.equal(bearerToken(req('Bearer abc_DEF-1')), 'abc_DEF-1');
  assert.equal(bearerToken(req('bearer   abc ')), 'abc');
  assert.equal(bearerToken(req('Basic abc')), undefined);
  assert.equal(bearerToken(req('Bearer')), undefined);
  assert.equal(bearerToken(req()), undefined);
});

test('AUTO_DESK takes the first free desk in DESKS order', () => {
  assert.equal(AUTO_DESK, 'auto');
  assert.equal(nextFreeSeat(() => false)?.id, DESKS[0].id);
  const taken = new Set([DESKS[0].id, DESKS[2].id]);
  assert.equal(nextFreeSeat((id) => taken.has(id))?.id, DESKS[1].id);
});

// --- Through the office ------------------------------------------------------------------------------

async function startOffice(t: { after(fn: () => unknown): unknown }, home: string, ...argv: string[]) {
  const cfg = loadConfig(['--home', home, '--projects', home, '--weather', 'clear', ...argv]);
  cfg.port = 0;
  const office = await startServer(cfg);
  let closed = false;
  const stop = async () => {
    if (closed) return;
    closed = true;
    const done = once(office.server, 'close');
    office.shutdown();
    await done;
    await delay(100);
  };
  t.after(stop);
  return { office, port: (office.server.address() as AddressInfo).port, stop };
}

const socket = (url: string, headers: Record<string, string>) =>
  new Promise<{ ws: WebSocket; first?: { t: string; [k: string]: unknown }; status?: number }>((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once('message', (raw) => resolve({ ws, first: JSON.parse(String(raw)) }));
    ws.once('unexpected-response', (_req, res) => {
      resolve({ ws, status: res.statusCode });
      ws.terminate();
    });
    ws.once('error', () => resolve({ ws, status: -1 }));
  });

test('pairing over the LAN: the token pairs, the bearer opens HTTP and the socket, forgetting refuses it', { timeout: 60_000 }, async (t) => {
  const ip = lanIPv4s()[0];
  if (!ip) return t.skip('no LAN address to arrive from');
  const home = mkdtempSync(path.join(os.tmpdir(), 'devices-office-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { office, port, stop } = await startOffice(t, home, '--host', '0.0.0.0');
  const lan = `http://${ip}:${port}`;
  const local = `http://127.0.0.1:${port}`;
  const wsLan = lan.replace('http:', 'ws:');
  const t0 = office.lanToken;
  const json = { 'content-type': 'application/json' };

  // Pairing needs this start's LAN token from off the machine, and refuses a web page's cross-origin POST.
  assert.equal((await fetch(`${lan}/api/mobile/pair`, { method: 'POST', headers: json, body: '{"device":"Pixel"}' })).status, 401);
  assert.equal((await fetch(`${lan}/api/mobile/pair?t=wrong`, { method: 'POST', headers: json, body: '{"device":"Pixel"}' })).status, 401);
  assert.equal((await fetch(`${lan}/api/mobile/pair?t=${t0}`, { method: 'POST', headers: { ...json, origin: 'http://evil.test' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${lan}/api/mobile/pair?t=${t0}`, { method: 'POST', headers: json, body: '{nope' })).status, 400);
  const res = await fetch(`${lan}/api/mobile/pair?t=${t0}`, { method: 'POST', headers: json, body: JSON.stringify({ device: '  Pixel 10 Pro XL  ' }) });
  assert.equal(res.status, 200);
  const paired = (await res.json()) as { deviceId: string; token: string; office: { name: string; version: string } };
  assert.deepEqual(Object.keys(paired).sort(), ['deviceId', 'office', 'token']);
  assert.match(paired.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(typeof paired.office.name, 'string');
  assert.equal(typeof paired.office.version, 'string');
  const bearer = { authorization: `Bearer ${paired.token}` };
  const onDisk = readFileSync(path.join(home, '.droid-office', 'devices.json'), 'utf8');
  assert.ok(!onDisk.includes(paired.token) && onDisk.includes('Pixel 10 Pro XL'), 'only the hash is kept, in the office’s own .droid-office');

  // hello: the bearer (or ?d=) says which phone; the LAN token alone says nothing about one.
  const hello = await (await fetch(`${lan}/api/mobile/hello`, { headers: bearer })).json();
  assert.deepEqual(hello, { ok: true, office: paired.office, deviceId: paired.deviceId });
  assert.equal(((await (await fetch(`${lan}/api/mobile/hello?d=${paired.token}`)).json()) as { deviceId?: string }).deviceId, paired.deviceId);
  assert.deepEqual(await (await fetch(`${lan}/api/mobile/hello?t=${t0}`)).json(), { ok: true, office: paired.office });
  assert.equal((await fetch(`${lan}/api/mobile/hello`)).status, 401);
  assert.equal((await fetch(`${lan}/api/health`, { headers: bearer })).status, 200);
  assert.equal((await fetch(`${lan}/`, { headers: bearer })).status, 200);

  // The socket: the bearer header needs no Origin; ?d= can come from a web page, so it needs a matching one.
  const viaHeader = await socket(`${wsLan}/ws?name=Pixel`, bearer);
  t.after(() => viaHeader.ws.terminate());
  assert.equal(viaHeader.first?.t, 'welcome');
  assert.equal((await socket(`${wsLan}/ws?name=Pixel&d=${paired.token}`, {})).status, 401);
  const viaQuery = await socket(`${wsLan}/ws?name=Pixel&d=${paired.token}`, { origin: lan });
  t.after(() => viaQuery.ws.terminate());
  assert.equal(viaQuery.first?.t, 'welcome');

  // The Phone window's routes answer only the office's own page on its own machine.
  assert.equal((await fetch(`${lan}/api/mobile/pairing`, { headers: bearer })).status, 403);
  assert.equal((await fetch(`${lan}/api/mobile/pairing?t=${t0}`, { headers: { origin: lan, 'sec-fetch-site': 'same-origin' } })).status, 403);
  assert.equal((await fetch(`${local}/api/mobile/pairing`)).status, 403);
  assert.equal((await fetch(`${local}/api/mobile/pairing`, { headers: { origin: 'http://evil.test' } })).status, 403);
  assert.equal((await fetch(`${local}/api/mobile/pairing`, { headers: { ...bearer, 'sec-fetch-site': 'same-origin' } })).status, 403);
  assert.equal((await fetch(`${local}/api/mobile/devices/${paired.deviceId}`, { method: 'DELETE', headers: { origin: 'http://evil.test' } })).status, 403);
  assert.equal((await fetch(`${lan}/api/mobile/devices/${paired.deviceId}?t=${t0}`, { method: 'DELETE', headers: { origin: lan } })).status, 403);
  const own = await fetch(`${local}/api/mobile/pairing`, { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(own.status, 200);
  const state = (await own.json()) as PairingState;
  assert.ok(state.link?.startsWith('droidoffice://pair?v=1&'));
  const link = new URL(state.link!);
  assert.equal(link.searchParams.get('t'), t0);
  assert.equal(link.searchParams.get('name'), state.office.name);
  assert.deepEqual(
    link.searchParams.getAll('u'),
    state.addresses.map((a) => a.url),
  );
  assert.equal(state.addresses[0].url, `http://${ip}:${port}`);
  assert.equal(state.addresses[0].kind, 'wifi');
  assert.deepEqual(
    state.devices.map((d) => d.name),
    ['Pixel 10 Pro XL'],
  );
  assert.equal((await fetch(`${local}/api/mobile/pairing`, { method: 'POST', headers: { origin: local } })).status, 405);

  // It survives a restart: a new office on the same folder, a new LAN token, the same device token.
  await stop();
  const second = await startOffice(t, home, '--host', '0.0.0.0');
  const lan2 = `http://${ip}:${second.port}`;
  assert.notEqual(second.office.lanToken, t0);
  assert.equal((await fetch(`${lan2}/api/mobile/hello`, { headers: bearer })).status, 200);
  const again = await socket(`${lan2.replace('http:', 'ws:')}/ws?name=Pixel`, bearer);
  assert.equal(again.first?.t, 'welcome');

  // The owner forgets it from the Phone window: the open socket closes, and the token is refused.
  const closed = once(again.ws, 'close');
  const forgot = await fetch(`http://127.0.0.1:${second.port}/api/mobile/devices/${paired.deviceId}`, { method: 'DELETE', headers: { origin: `http://127.0.0.1:${second.port}` } });
  assert.equal(forgot.status, 200);
  assert.deepEqual(((await forgot.json()) as PairingState).devices, []);
  assert.equal((await closed)[0], 4401);
  assert.equal((await fetch(`http://127.0.0.1:${second.port}/api/mobile/devices/${paired.deviceId}`, { method: 'DELETE', headers: { origin: `http://127.0.0.1:${second.port}` } })).status, 404);
  const refused = await fetch(`${lan2}/api/mobile/hello`, { headers: bearer });
  assert.equal(refused.status, 401);
  assert.match(((await refused.json()) as { error: string }).error, /not paired/);
  assert.equal((await fetch(`http://127.0.0.1:${second.port}/api/health`, { headers: bearer })).status, 401, 'a forgotten token is refused even on loopback');
  assert.equal((await socket(`${lan2.replace('http:', 'ws:')}/ws?name=Pixel`, bearer)).status, 401);
});

test('the phone unpairs itself with DELETE /api/mobile/pair', { timeout: 60_000 }, async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'devices-office-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { port } = await startOffice(t, home, '--host', '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const paired = (await (await fetch(`${base}/api/mobile/pair`, { method: 'POST', body: '{"device":"Pixel"}' })).json()) as { deviceId: string; token: string };
  assert.equal((await fetch(`${base}/api/mobile/pair`, { method: 'DELETE' })).status, 400);
  const bye = await fetch(`${base}/api/mobile/pair`, { method: 'DELETE', headers: { authorization: `Bearer ${paired.token}` } });
  assert.deepEqual([bye.status, await bye.json()], [200, { ok: true }]);
  assert.equal((await fetch(`${base}/api/mobile/hello`, { headers: { authorization: `Bearer ${paired.token}` } })).status, 401);
  // Bound to loopback, the Phone window has nothing to show a phone.
  const state = (await (await fetch(`${base}/api/mobile/pairing`, { headers: { 'sec-fetch-site': 'same-origin' } })).json()) as PairingState;
  assert.equal(state.link, undefined);
  assert.deepEqual(state.addresses, []);
  assert.match(state.reason ?? '', /127\.0\.0\.1/);
});

test('worker.spawn with deskId "auto" takes the first free desk on the floor', { timeout: 60_000, skip: process.platform === 'win32' }, async (t) => {
  const project = mkdtempSync(path.join(os.tmpdir(), 'devices-auto-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: project });
  const { port } = await startOffice(t, project, project, '--host', '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const paired = (await (await fetch(`${base}/api/mobile/pair`, { method: 'POST', body: '{"device":"Pixel"}' })).json()) as { token: string };
  const { ws, first } = await socket(`${base.replace('http:', 'ws:')}/ws?name=Pixel`, { authorization: `Bearer ${paired.token}` });
  t.after(() => ws.terminate());
  const floors = (first as { floors: { id: string }[] }).floors;
  const messages: { t: string; worker?: { id: string; deskId: string } }[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
  const waitFor = async (pred: (m: (typeof messages)[number]) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const m = messages.find(pred);
      if (m) return m;
      await delay(50);
    }
    assert.fail('timed out waiting for the office');
  };
  if ((first as { arrival: { floor: string } }).arrival.floor !== floors[0].id) {
    ws.send(JSON.stringify({ t: 'floor.go', floor: floors[0].id }));
    await waitFor((m) => m.t === 'floor.enter');
  }
  const hired: string[] = [];
  for (const want of [DESKS[0].id, DESKS[1].id]) {
    ws.send(JSON.stringify({ t: 'worker.spawn', deskId: AUTO_DESK, kind: 'shell' }));
    const m = await waitFor((x) => x.t === 'worker.update' && !!x.worker && !hired.includes(x.worker.id));
    hired.push(m.worker!.id);
    assert.equal(m.worker!.deskId, want);
  }
  for (const id of hired) ws.send(JSON.stringify({ t: 'worker.kill', workerId: id, cleanup: 'keep' }));
  await waitFor((m) => m.t === 'worker.remove');
});
