import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';

test('props are revalidated each load, so an update that adds or changes one reaches a browser that cached the old set', { timeout: 30_000 }, async (t) => {
  const home = mkdtempSync(path.resolve('tests/.props-http-'));
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

  for (const route of ['/props/manifest.json', '/props/robot-arm.glb']) {
    const first = await fetch(`${base}${route}`);
    assert.equal(first.status, 200, route);
    assert.equal(first.headers.get('cache-control'), 'no-cache', `${route} is never cached as immutable`);
    const etag = first.headers.get('etag');
    assert.ok(etag, `${route} carries an etag`);
    await first.arrayBuffer();

    const again = await fetch(`${base}${route}`, { headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304, `${route} answers an unchanged copy with 304`);
    assert.equal(again.headers.get('etag'), etag);

    const stale = await fetch(`${base}${route}`, { headers: { 'if-none-match': '"old"' } });
    assert.equal(stale.status, 200, `${route} sends the new bytes to a stale copy`);
    await stale.arrayBuffer();
  }

  const manifest = await (await fetch(`${base}/props/manifest.json`)).json();
  for (const name of ['robot-arm', 'conveyor', 'pr-crate', 'droid-computer']) assert.ok(manifest[name], `the served manifest lists ${name}`);
});
