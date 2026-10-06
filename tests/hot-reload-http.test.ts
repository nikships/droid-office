import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';

test('local built-office reload API has independent recovery, validates controls, and leaves the live socket intact', { timeout: 30_000 }, async (t) => {
  const home = mkdtempSync(path.resolve('tests/.reload-http-'));
  const cfg = loadConfig(['--home', home, '--projects', home, '--host', '127.0.0.1', '--weather', 'clear']);
  cfg.port = 0;
  const office = await startServer(cfg);
  const base = `http://127.0.0.1:${(office.server.address() as AddressInfo).port}`;
  t.after(async () => {
    const closed = once(office.server, 'close');
    office.shutdown();
    await closed;
    await delay(100);
    rmSync(home, { recursive: true, force: true });
  });
  const get = (route: string) => fetch(`${base}${route}`);
  const post = (body: unknown, origin = base) => fetch(`${base}/api/hot-reload`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const initial = await (await get('/api/hot-reload')).json();
  assert.equal(initial.available, true);
  assert.ok(!('admin' in initial), 'no admin gate on hot reload');
  assert.equal(initial.enabled, false);
  const html = await (await get('/')).text();
  assert.match(html, new RegExp(`<meta name="office-revision" content="${initial.revision}">`));
  assert.equal(html.match(/src="\/api\/hot-reload\/client\.js"/g)?.length, 1);
  const recovery = await get('/api/hot-reload/client.js');
  assert.equal(recovery.headers.get('cache-control'), 'no-store');
  assert.match(await recovery.text(), /hot-reload/);
  assert.equal((await post({ enabled: true }, 'https://not-the-office.example')).status, 403);
  for (const invalid of [null, {}, { enabled: 'yes' }, { rebuild: false }, { enabled: true, rebuild: true }]) assert.equal((await post(invalid)).status, 400);
  assert.equal((await post({ rebuild: true })).status, 400, 'rebuild requires opting in');
  const unsupported = await fetch(`${base}/api/hot-reload`, { method: 'DELETE' });
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get('allow'), 'GET, POST');

  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?name=ReloadTest`, { headers: { origin: base } });
  t.after(() => ws.terminate());
  const welcome = once(ws, 'message');
  await once(ws, 'open');
  assert.equal(JSON.parse(String((await welcome)[0])).t, 'welcome');
  assert.equal((await post({ enabled: true })).status, 200);
  assert.equal((await post({ enabled: false })).status, 200);
  assert.equal((await (await get('/api/hot-reload')).json()).enabled, false);
  assert.equal(ws.readyState, WebSocket.OPEN);
  const pong = new Promise<void>((resolve) =>
    ws.on('message', (data) => {
      if (JSON.parse(String(data)).t === 'pong') resolve();
    }),
  );
  ws.send(JSON.stringify({ t: 'ping', at: 123 }));
  await pong;
  ws.terminate();
});
