import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { build } from 'vite';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import { DevicesStore } from '../src/server/devices.js';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol.js';
import type { PairingState } from '../src/shared/devices.js';
import { reachableLan } from './lan-probe.js';

async function office(t: TestContext, home?: string) {
  const dir = home ?? mkdtempSync(path.join(os.tmpdir(), 'dashboard-'));
  if (!home) {
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: dir });
  }
  const cfg = loadConfig(['--home', dir, '--projects', dir, dir, '--weather', 'clear', '--host', '0.0.0.0']);
  cfg.port = 0;
  const server = await startServer(cfg);
  const port = (server.server.address() as AddressInfo).port;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const closing = once(server.server, 'close');
    server.shutdown();
    await closing;
  };
  t.after(stop);
  return { server, dir, stop, base: `http://127.0.0.1:${port}`, port };
}

function socket(t: TestContext, base: string, query: string, origin = base) {
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?${query}`, { origin });
  t.after(() => ws.terminate());
  const messages: ServerMsg[] = [];
  const listeners = new Set<() => void>();
  ws.on('message', (data) => {
    messages.push(JSON.parse(String(data)));
    listeners.forEach((fn) => fn());
  });
  function wait<T extends ServerMsg['t']>(type: T, predicate: (msg: Extract<ServerMsg, { t: T }>) => boolean = () => true): Promise<Extract<ServerMsg, { t: T }>> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = messages.find((m): m is Extract<ServerMsg, { t: T }> => m.t === type && predicate(m as Extract<ServerMsg, { t: T }>));
        if (!found) return;
        clearTimeout(timer);
        listeners.delete(check);
        resolve(found);
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(Error(`Timed out waiting for ${type}`));
      }, 8000);
      listeners.add(check);
      check();
    });
  }
  const send = (msg: ClientMsg) => ws.send(JSON.stringify(msg));
  return { ws, messages, wait, send };
}

test('hidden models sync to every device and new connections, with invalid changes refused', async (t) => {
  const { base, dir } = await office(t);
  const desktop = socket(t, base, '');
  const web = socket(t, base, 'client=dashboard');
  const phone = socket(t, base, 'client=mobile');
  const welcome = await desktop.wait('welcome');
  assert.deepEqual(welcome.hiddenModels, []);
  assert.equal(welcome.workerAnswerMultiSelect, true);
  await web.wait('welcome');
  await phone.wait('welcome');
  desktop.send({ t: 'models.hide', id: 'gpt-6.1-sol', hidden: true, requestId: 'hide-model' });
  assert.equal((await desktop.wait('action.result', (m) => m.requestId === 'hide-model')).ok, true);
  for (const client of [desktop, web, phone]) assert.deepEqual((await client.wait('models.hidden')).ids, ['gpt-6.1-sol']);
  const fresh = socket(t, base, '');
  assert.deepEqual((await fresh.wait('welcome')).hiddenModels, ['gpt-6.1-sol']);
  desktop.ws.send(JSON.stringify({ t: 'models.hide', id: 'two words', hidden: true, requestId: 'invalid-model' }));
  await desktop.wait('toast', (m) => m.text.includes('valid model'));
  assert.equal((await desktop.wait('action.result', (m) => m.requestId === 'invalid-model')).ok, false);
  const temporary = path.join(dir, '.droid-office/hidden-models.json.tmp');
  mkdirSync(temporary);
  desktop.send({ t: 'models.hide', id: null, hidden: false, requestId: 'failed-save' });
  const failed = await desktop.wait('action.result', (m) => m.requestId === 'failed-save');
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? '', /Could not save/);
  rmSync(temporary, { recursive: true });
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, '.droid-office/hidden-models.json'), 'utf8')), ['gpt-6.1-sol']);
  desktop.send({ t: 'models.hide', id: null, hidden: false });
  for (const client of [desktop, web, phone]) await client.wait('models.hidden', (m) => m.ids.length === 0);
});

test('host update routes require office access and same-origin writes, with clear source-host fallback', async (t) => {
  const { base, server } = await office(t);
  const state = await fetch(`${base}/api/host/update`);
  assert.equal(state.status, 200);
  assert.equal((await state.json()).supported, false);
  const post = (body: string, headers: Record<string, string> = {}) => fetch(`${base}/api/host/update`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  assert.equal((await post('{"action":"check"}')).status, 403, 'a write requires an own request even on loopback');
  assert.equal((await post('{"action":"check"}', { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await post('not json', { Origin: base })).status, 400);
  assert.equal((await post('{"action":"install"}', { Origin: base })).status, 400);
  assert.equal((await post('{"action":"exec"}', { Origin: base })).status, 400);
  assert.equal((await post('{"action":"check"}', { Origin: base })).status, 409);
  assert.equal((await fetch(`${base}/api/host/update`, { method: 'DELETE' })).status, 405);
  const paired = server.devices.pair('Phone')!;
  const headers = { Authorization: `Bearer ${paired.token}` };
  assert.equal((await fetch(`${base}/api/host/update`, { headers })).status, 200);
  assert.equal((await post('{"action":"check"}', headers)).status, 409, 'native paired phones may write without Origin');
  server.devices.forget(paired.device.id);
  assert.equal((await fetch(`${base}/api/host/update`, { headers })).status, 401);
  const ip = await reachableLan(t, server.server);
  if (ip) assert.equal((await fetch(`${base.replace('127.0.0.1', ip)}/api/host/update`)).status, 401);
});

test('floor moves from a companion update every client and the next welcome, with invalid moves refused', async (t) => {
  const { base, dir, server } = await office(t);
  const desktop = socket(t, base, '');
  const mobile = socket(t, base, 'client=mobile');
  const initial = await desktop.wait('welcome');
  await mobile.wait('welcome');
  const addedDir = path.join(dir, 'notes');
  mkdirSync(addedDir);
  mobile.send({ t: 'floor.add', dir: addedDir });
  const added = await mobile.wait('floor.added');
  assert.ok(added.floor, added.error);
  const first = initial.floors[0].id;
  mobile.send({ t: 'floor.reorder', floor: added.floor, before: first, requestId: 'move-floor' });
  assert.equal((await mobile.wait('action.result', (m) => m.requestId === 'move-floor')).ok, true);
  const changed = await desktop.wait('floors', (m) => m.floors[0]?.id === added.floor);
  assert.equal((await mobile.wait('floors', (m) => m.floors[0]?.id === added.floor)).floors[0].id, added.floor);
  assert.deepEqual(
    changed.floors.map((f) => f.id),
    [added.floor, ...initial.floors.map((f) => f.id)],
  );
  const fresh = socket(t, base, '');
  assert.equal((await fresh.wait('welcome')).floor, added.floor, 'new connections arrive on the new first floor');
  assert.equal(server.floors()[0].id, added.floor, 'live floor readers use the canonical order');
  assert.deepEqual(
    (await fresh.wait('welcome')).floors.map((f) => f.id),
    changed.floors.map((f) => f.id),
  );
  mobile.send({ t: 'floor.reorder', floor: added.floor, before: 'gone', requestId: 'stale-floor' });
  assert.equal((await mobile.wait('action.result', (m) => m.requestId === 'stale-floor')).ok, false);
  mobile.ws.send(JSON.stringify({ t: 'floor.reorder', floor: added.floor, before: 12, requestId: 'bad-floor' }));
  assert.equal((await mobile.wait('action.result', (m) => m.requestId === 'bad-floor')).ok, false);
  assert.equal(JSON.parse(readFileSync(path.join(dir, '.droid-office/floors.json'), 'utf8'))[0].id, added.floor);
});

test('production dashboard has a public data-free bootstrap, gated APIs and no 3D office in its bundle', async (t) => {
  const { base, server } = await office(t);
  const ip = await reachableLan(t, server.server);
  const remote = ip ? base.replace('127.0.0.1', ip) : base;
  for (const route of ['/dashboard', '/dashboard/', '/dashboard.html']) {
    const response = await fetch(remote + route);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /id="dashboard"/);
    assert.doesNotMatch(html, /hot-reload|window\.office|devices\.json/);
    assert.ok(!html.includes(server.lanToken));
    for (const asset of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) assert.equal((await fetch(remote + asset[1])).status, 200);
  }
  if (ip) {
    assert.equal((await fetch(`${remote}/api/mobile/hello`)).status, 401);
    assert.equal((await fetch(`${remote}/api/agents/droid/models`)).status, 401);
    assert.equal((await fetch(`${remote}/api/agents/droid/commands?worker=missing`)).status, 401);
    assert.equal((await fetch(`${remote}/api/whiteboard/render?floor=missing&card=missing`)).status, 401);
    assert.equal((await fetch(`${remote}/`)).status, 401);
  }
  assert.equal((await fetch(`${base}/api/agents/droid/commands?worker=missing`)).status, 404);
  assert.match(await (await fetch(`${base}/`)).text(), /id="loading"/);
  const result = await build({ configFile: path.resolve('vite.config.ts'), logLevel: 'silent', build: { write: false, reportCompressedSize: false } });
  assert.ok(!Array.isArray(result) && 'output' in result);
  const chunks = new Map(result.output.filter((o) => o.type === 'chunk').map((c) => [c.fileName, c]));
  const entry = [...chunks.values()].find((c) => c.facadeModuleId?.endsWith('/dashboard.html'));
  assert.ok(entry);
  const reached = new Set<string>();
  const walk = (name: string) => {
    if (reached.has(name)) return;
    reached.add(name);
    const c = chunks.get(name);
    for (const next of [...(c?.imports ?? []), ...(c?.dynamicImports ?? [])]) walk(next);
  };
  walk(entry.fileName);
  const modules = [...reached].flatMap((name) => Object.keys(chunks.get(name)?.modules ?? {}));
  assert.ok(modules.some((id) => id.endsWith('/dashboard.ts')));
  assert.ok(modules.some((id) => id.endsWith('/ui/whiteboard.ts')));
  assert.ok(modules.some((id) => id.endsWith('/ui/terminal.ts')));
  // Neither the overview nor any lazy-loaded dashboard view needs the 3D office.
  assert.deepEqual(
    modules.filter((id) => /\/node_modules\/three\/|\/client\/(?:office-map|main|automation|shader-warmup)\.ts|\/client\/world\/(?!glyph\.ts)/.test(id)),
    [],
  );
  const cold = new Set<string>();
  const initial = (name: string) => {
    if (cold.has(name)) return;
    cold.add(name);
    for (const next of chunks.get(name)?.imports ?? []) initial(next);
  };
  initial(entry.fileName);
  const coldModules = [...cold].flatMap((name) => Object.keys(chunks.get(name)?.modules ?? {}));
  assert.ok(!coldModules.some((id) => id.includes('/node_modules/@xterm/xterm/')));
});

test('browser pairing preserves phone flow, refuses foreign origins and local management, survives restart and revokes active sockets', async (t) => {
  const first = await office(t);
  const { base, server, dir } = first;
  const headers = { origin: base, 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/mobile/pair`, { method: 'POST', body: '{"kind":"browser"}' })).status, 403);
  assert.equal((await fetch(`${base}/api/mobile/pair`, { method: 'POST', headers: { ...headers, origin: 'https://foreign.test' }, body: '{"kind":"browser"}' })).status, 403);
  const res = await fetch(`${base}/api/mobile/pair`, { method: 'POST', headers, body: '{"kind":"browser","device":"Desktop"}' });
  assert.equal(res.status, 200);
  const pair = (await res.json()) as { token: string; device: { id: string; kind: string; name: string } };
  assert.equal(pair.device.kind, 'browser');
  assert.equal(pair.device.name, 'Desktop');
  const query = `d=${pair.token}&client=dashboard`;
  const browser = socket(t, base, query);
  await browser.wait('welcome');
  const hello = await fetch(`${base}/api/mobile/hello?d=${pair.token}`);
  assert.equal(hello.status, 200);
  assert.equal((await fetch(`${base}/api/mobile/pairing?d=${pair.token}`, { headers: { 'sec-fetch-site': 'same-origin' } })).status, 403);
  assert.equal((await fetch(`${base}/api/mobile/devices/${pair.device.id}?d=${pair.token}`, { method: 'DELETE', headers })).status, 403);
  assert.equal((await fetch(`${base}/api/mobile/hello?d=${pair.token}`, { headers: { origin: 'https://foreign.test' } })).status, 403);
  const refused = new WebSocket(`${base.replace('http:', 'ws:')}/ws?${query}`, { origin: 'https://foreign.test' });
  refused.on('error', () => {});
  const rejected = await once(refused, 'unexpected-response');
  assert.equal(rejected[1].statusCode, 401);
  refused.terminate();
  const disk = readFileSync(path.join(dir, '.droid-office/devices.json'), 'utf8');
  assert.ok(!disk.includes(pair.token));
  assert.equal(new DevicesStore(path.join(dir, '.droid-office')).verify(pair.token)?.kind, 'browser');
  const oldLanToken = server.lanToken;
  await first.stop();
  const second = await office(t, dir);
  assert.notEqual(second.server.lanToken, oldLanToken);
  assert.equal((await fetch(`${second.base}/dashboard`)).status, 200);
  assert.equal((await fetch(`${second.base}/api/mobile/hello?d=${pair.token}`)).status, 200);
  const restored = socket(t, second.base, query);
  await restored.wait('welcome');
  const closed = once(restored.ws, 'close');
  assert.equal((await fetch(`${second.base}/api/mobile/devices/${pair.device.id}`, { method: 'DELETE', headers: { origin: second.base } })).status, 200);
  assert.equal((await closed)[0], 4401);
  assert.equal((await fetch(`${second.base}/api/mobile/hello?d=${pair.token}`)).status, 401);
  assert.equal((await fetch(`${second.base}/api/health?d=invalid`)).status, 401);
  assert.equal((await fetch(`${second.base}/dashboard`)).status, 200, 'revocation never blocks the generic bootstrap');
});

test('confirmed worker actions deduplicate on a socket, respect the active floor, and browser sizing does not restore like a phone', { skip: process.platform === 'win32' }, async (t) => {
  const { base } = await office(t);
  const res = await fetch(`${base}/api/mobile/pair`, { method: 'POST', headers: { origin: base }, body: '{"kind":"browser","device":"Desktop"}' });
  const pair = (await res.json()) as { token: string };
  const browser = socket(t, base, `d=${pair.token}&client=dashboard`);
  const welcome = await browser.wait('welcome');
  const floor = welcome.floor!;
  browser.send({ t: 'worker.spawn', kind: 'shell', deskId: 'auto', requestId: 'hire', requestFloor: floor });
  const hired = await browser.wait('action.result', (m) => m.requestId === 'hire');
  assert.equal(hired.ok, true);
  assert.ok(hired.workerId);
  const workerId = hired.workerId;
  browser.send({ t: 'worker.spawn', kind: 'shell', deskId: 'auto', requestId: 'hire', requestFloor: floor });
  // Roundtrip barrier: the duplicate is processed before this refusal.
  browser.send({ t: 'worker.spawn', kind: 'shell', deskId: 'auto', requestId: 'wrong-floor', requestFloor: 'gone' });
  const wrong = await browser.wait('action.result', (m) => m.requestId === 'wrong-floor');
  assert.equal(wrong.ok, false);
  const hireResults = browser.messages.filter((m) => m.t === 'action.result' && m.requestId === 'hire');
  assert.equal(hireResults.length, 2);
  assert.equal(hireResults[1]?.ok, false);
  assert.equal(new Set(browser.messages.filter((m) => m.t === 'worker.update').map((m) => m.worker.id)).size, 1);
  browser.send({ t: 'worker.attach', workerId });
  assert.equal((await browser.wait('term.snapshot')).shared, false);
  browser.send({ t: 'worker.prompt', workerId, prompt: 'printf "dashboard-stream-check\\n"', requestId: 'prompt', requestFloor: floor });
  assert.equal((await browser.wait('action.result', (m) => m.requestId === 'prompt')).ok, true);
  await browser.wait('term.data', (m) => m.data.includes('dashboard-stream-check'));
  browser.send({ t: 'term.input', workerId, data: 'printf "typed-keys-check\\n"\r', requestId: 'keys', requestFloor: floor });
  assert.equal((await browser.wait('action.result', (m) => m.requestId === 'keys')).ok, true, 'keys typed into an attached terminal are confirmed');
  await browser.wait('term.data', (m) => m.data.includes('typed-keys-check'));
  const observer = socket(t, base, 'client=dashboard');
  await observer.wait('welcome');
  const phonePair = (await (await fetch(`${base}/api/mobile/pair`, { method: 'POST', body: '{"device":"Phone"}' })).json()) as { token: string };
  const phone = socket(t, base, `d=${phonePair.token}`);
  await phone.wait('welcome');
  phone.send({ t: 'worker.attach', workerId });
  assert.equal((await phone.wait('term.snapshot')).shared, true);
  phone.send({ t: 'term.resize', workerId, cols: 50, rows: 20 });
  await observer.wait('worker.update', (m) => m.worker.id === workerId && m.worker.cols === 50);
  browser.send({ t: 'term.resize', workerId, cols: 120, rows: 40 });
  await observer.wait('worker.update', (m) => m.worker.id === workerId && m.worker.cols === 120);
  browser.ws.close();
  await once(browser.ws, 'close');
  observer.send({ t: 'worker.attach', workerId });
  const snapshot = await observer.wait('term.snapshot');
  assert.equal(snapshot.cols, 120, 'a paired browser never restores a temporary PhoneSizes value');
  assert.equal(snapshot.rows, 40);
  observer.send({ t: 'worker.answer', workerId, menu: { choices: [], freeText: false }, choice: 1, requestId: 'unsupported' });
  assert.equal((await observer.wait('action.result', (m) => m.requestId === 'unsupported')).ok, false);
  observer.send({ t: 'worker.answer', workerId, menu: { choices: [], freeText: false }, choice: 1, text: 'also', requestId: 'both' });
  assert.equal((await observer.wait('action.result', (m) => m.requestId === 'both')).ok, false);
  observer.send({ t: 'worker.answer', workerId, menu: { choices: [], freeText: false }, requestId: 'neither' });
  assert.equal((await observer.wait('action.result', (m) => m.requestId === 'neither')).ok, false);
  observer.send({ t: 'worker.kill', workerId, cleanup: 'keep', requestId: 'home' });
  assert.equal((await observer.wait('action.result', (m) => m.requestId === 'home')).ok, true);
  await observer.wait('worker.remove', (m) => m.workerId === workerId);
});

test('the status route counts connected phones and browsers for this Mac only', async (t) => {
  const { base } = await office(t);
  const scene = socket(t, base, '');
  const web = socket(t, base, 'client=dashboard');
  const pair = (await (await fetch(`${base}/api/mobile/pair`, { method: 'POST', body: '{"device":"Phone"}' })).json()) as { token: string };
  const phone = socket(t, base, `d=${pair.token}`);
  const again = socket(t, base, `d=${pair.token}`);
  await Promise.all([scene, web, phone, again].map((c) => c.wait('welcome')));
  const status = (await (await fetch(`${base}/api/status`)).json()) as Record<string, unknown>;
  assert.deepEqual({ ...status, floors: undefined }, { workers: 0, working: 0, needsInput: 0, done: 0, phones: 1, browsers: 2, floors: undefined, waiting: [] });
  assert.ok(Number.isInteger(status.floors) && (status.floors as number) >= 1);
  assert.equal((await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${pair.token}` } })).status, 403);
  assert.equal((await fetch(`${base}/api/status`, { headers: { origin: 'https://foreign.test' } })).status, 403);
  // A site that a DNS rebinding pointed at 127.0.0.1 asks by its own name; the app asks by localhost.
  assert.equal(await statusFor(base, 'foreign.test'), 403);
  assert.equal(await statusFor(base, 'localhost'), 200);
});

/** The status route's answer to a request that names the office `host` (fetch can't set Host). */
function statusFor(base: string, host: string): Promise<number> {
  const url = new URL('/api/status', base);
  return new Promise((resolve, reject) => {
    http
      .get({ host: url.hostname, port: url.port, path: url.pathname, headers: { host: `${host}:${url.port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on('error', reject);
  });
}

test('the web companion switch refuses browsers while off, keeps their pairing, leaves phones alone and survives a restart', async (t) => {
  const first = await office(t);
  const { base, dir } = first;
  const own = { origin: base, 'content-type': 'application/json' };
  const state = (await (await fetch(`${base}/api/mobile/pairing`, { headers: { 'sec-fetch-site': 'same-origin' } })).json()) as PairingState;
  assert.equal(state.companion, true);
  assert.equal(state.local, `http://localhost:${first.port}`);
  assert.equal(state.reachable, true);
  assert.equal(typeof state.tailscale, 'boolean');
  const pair = (await (await fetch(`${base}/api/mobile/pair`, { method: 'POST', headers: own, body: '{"kind":"browser","device":"Desktop"}' })).json()) as { token: string };
  const phone = (await (await fetch(`${base}/api/mobile/pair`, { method: 'POST', body: '{"device":"Phone"}' })).json()) as { token: string };
  const browser = socket(t, base, `d=${pair.token}&client=dashboard`);
  await browser.wait('welcome');
  const local = socket(t, base, 'client=dashboard');
  await local.wait('welcome');
  const tab = socket(t, base, 'name=Owner');
  await tab.wait('welcome');

  assert.equal((await fetch(`${base}/api/mobile/companion`, { method: 'PUT', headers: own, body: '{"on":"no"}' })).status, 400);
  assert.equal((await fetch(`${base}/api/mobile/companion?d=${phone.token}`, { method: 'PUT', headers: own, body: '{"on":false}' })).status, 403, 'a phone cannot turn it off');
  const closed = Promise.all([once(browser.ws, 'close'), once(local.ws, 'close')]);
  const off = await fetch(`${base}/api/mobile/companion`, { method: 'PUT', headers: own, body: '{"on":false}' });
  assert.equal(off.status, 200);
  assert.equal(((await off.json()) as PairingState).companion, false);
  for (const [code] of await closed) assert.equal(code, 4403);
  assert.equal(tab.ws.readyState, WebSocket.OPEN, 'the office’s own page stays connected');

  const refusedHello = await fetch(`${base}/api/mobile/hello?client=dashboard`);
  assert.equal(refusedHello.status, 403);
  assert.equal(((await refusedHello.json()) as { companionOff?: boolean }).companionOff, true);
  assert.equal((await fetch(`${base}/api/mobile/hello?d=${pair.token}`)).status, 403);
  assert.equal((await fetch(`${base}/api/mobile/pair`, { method: 'POST', headers: own, body: '{"kind":"browser"}' })).status, 403);
  assert.equal((await fetch(`${base}/api/mobile/hello?d=${phone.token}`)).status, 200, 'phones are not the companion');
  assert.equal((await fetch(`${base}/api/mobile/hello`)).status, 200);
  assert.equal((await fetch(`${base}/dashboard`)).status, 200, 'the bootstrap page still loads and explains');
  for (const query of [`d=${pair.token}&client=dashboard`, 'client=dashboard']) {
    const refused = new WebSocket(`${base.replace('http:', 'ws:')}/ws?${query}`, { origin: base });
    refused.on('error', () => {});
    assert.equal((await once(refused, 'unexpected-response'))[1].statusCode, 401);
    refused.terminate();
  }
  assert.match(readFileSync(path.join(dir, '.droid-office/web-companion.json'), 'utf8'), /"on": false/);

  await first.stop();
  const second = await office(t, dir);
  assert.equal((await fetch(`${second.base}/api/mobile/hello?d=${pair.token}`)).status, 403, 'off stays off across a restart');
  assert.equal((await fetch(`${second.base}/api/mobile/companion`, { method: 'PUT', headers: { ...own, origin: second.base }, body: '{"on":true}' })).status, 200);
  assert.equal((await fetch(`${second.base}/api/mobile/hello?d=${pair.token}`)).status, 200, 'the pairing outlived the switch');
  const back = socket(t, second.base, `d=${pair.token}&client=dashboard`);
  await back.wait('welcome');
});
