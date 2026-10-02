import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { WebSocket } from 'ws';
import { isLoopback, lanAllowed, lanIPv4s, lanTokenOk, mintLanToken } from '../src/server/lan.js';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';

test('LAN tokens are unique and URL-safe', () => {
  const a = mintLanToken();
  const b = mintLanToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{32,}$/);
});

test('only loopback bypasses the gate', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(ip), true, ip);
  for (const ip of [undefined, '', '0.0.0.0', '::', '10.0.0.1', '192.168.1.5', '100.96.217.59', '::ffff:192.168.1.1', '8.8.8.8']) assert.equal(isLoopback(ip), false, String(ip));
});

test('the token compare needs the exact token', () => {
  const token = mintLanToken();
  assert.equal(lanTokenOk(token, token), true);
  assert.equal(lanTokenOk(`${token}x`, token), false);
  assert.equal(lanTokenOk(token.slice(1), token), false);
  assert.equal(lanTokenOk('wrong', token), false);
  assert.equal(lanTokenOk('', token), false);
  assert.equal(lanTokenOk(null, token), false);
  assert.equal(lanTokenOk(undefined, token), false);
});

test('the gate passes loopback and checks ?t= everywhere else', () => {
  const token = mintLanToken();
  const req = (remoteAddress: string | undefined) => ({ socket: { remoteAddress } }) as unknown as IncomingMessage;
  const url = (t: string | null) => new URL(t === null ? '/' : `/?t=${t}`, 'http://x');
  assert.equal(lanAllowed(req('127.0.0.1'), url(null), token), true);
  assert.equal(lanAllowed(req('::1'), url(null), token), true);
  assert.equal(lanAllowed(req('::ffff:127.0.0.1'), url(null), token), true);
  assert.equal(lanAllowed(req('192.168.1.5'), url(token), token), true);
  assert.equal(lanAllowed(req('192.168.1.5'), url(null), token), false);
  assert.equal(lanAllowed(req('192.168.1.5'), url('wrong'), token), false);
  assert.equal(lanAllowed(req(undefined), url(null), token), false);
});

test('lanIPv4s lists dotted IPv4 addresses', () => {
  for (const ip of lanIPv4s()) assert.match(ip, /^\d{1,3}(\.\d{1,3}){3}$/, ip);
});

async function startOffice(t: { after(fn: () => unknown): unknown }, ...argv: string[]) {
  const home = mkdtempSync(path.resolve('tests/.lan-'));
  const cfg = loadConfig(['--home', home, '--projects', home, '--no-discovery', '--weather', 'clear', ...argv]);
  cfg.port = 0;
  const office = await startServer(cfg);
  t.after(async () => {
    const closed = once(office.server, 'close');
    office.shutdown();
    await closed;
    await delay(100);
    rmSync(home, { recursive: true, force: true });
  });
  return { office, home };
}

test('loopback connects with no token: pages, APIs and sockets', { timeout: 60_000 }, async (t) => {
  const { office, home } = await startOffice(t, '--host', '127.0.0.1');
  const base = `http://127.0.0.1:${(office.server.address() as AddressInfo).port}`;
  assert.match(office.lanToken, /^[A-Za-z0-9_-]{32,}$/);
  assert.ok(!readFileSync(path.join(home, '.droid-office', 'config.json'), 'utf8').includes(office.lanToken), 'the token is never written to disk');

  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/search?q=zzz-nothing-here`)).status, 200);
  assert.equal((await fetch(`${base}/favicon.svg`)).status, 200);

  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?name=Loopback`, { headers: { origin: base } });
  t.after(() => ws.terminate());
  const [raw] = await once(ws, 'message');
  assert.equal(JSON.parse(String(raw)).t, 'welcome');
});

test('the sign-in routes are gone', { timeout: 60_000 }, async (t) => {
  const { office } = await startOffice(t, '--host', '127.0.0.1');
  const base = `http://127.0.0.1:${(office.server.address() as AddressInfo).port}`;
  for (const page of ['/login', '/login.html', '/claim', '/claim.html', '/join', '/join.html']) assert.equal((await fetch(`${base}${page}`)).status, 404, page);
  assert.equal((await fetch(`${base}/api/login`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${base}/api/login`)).status, 404);
  assert.equal((await fetch(`${base}/api/join`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${base}/api/claim`)).status, 404);
  assert.equal((await fetch(`${base}/api/whoami`)).status, 404);
  assert.equal((await fetch(`${base}/api/logout`, { method: 'POST' })).status, 404);
});

test('off the machine, missing and wrong tokens are refused', { timeout: 60_000 }, async (t) => {
  const ip = lanIPv4s()[0];
  if (!ip) return t.skip('no LAN address to arrive from');
  const { office } = await startOffice(t, '--host', '0.0.0.0');
  const port = (office.server.address() as AddressInfo).port;
  const base = `http://${ip}:${port}`;
  const token = office.lanToken;

  assert.equal((await fetch(`${base}/`)).status, 401);
  assert.equal((await fetch(`${base}/?t=wrong`)).status, 401);
  assert.equal((await fetch(`${base}/api/health`)).status, 401);
  assert.equal((await fetch(`${base}/?t=${token}`)).status, 200);
  assert.equal((await fetch(`${base}/api/health?t=${token}`)).status, 200);
  // The bundle's static files carry no office data and load openly.
  assert.equal((await fetch(`${base}/favicon.svg`)).status, 200);

  const refused = new WebSocket(`${base.replace('http:', 'ws:')}/ws?name=Stranger`, { headers: { origin: base } });
  t.after(() => refused.terminate());
  const [err] = await Promise.race([once(refused, 'error'), once(refused, 'open').then(() => assert.fail('a socket without the token opened'))]);
  assert.match((err as Error).message, /401/);

  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?name=Owner&t=${token}`, { headers: { origin: base } });
  t.after(() => ws.terminate());
  const [raw] = await once(ws, 'message');
  assert.equal(JSON.parse(String(raw)).t, 'welcome');
});
