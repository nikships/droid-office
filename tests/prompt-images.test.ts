import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);

test('a picture pasted into a prompt is kept on the office machine until the prompt is sent or it is taken out', { timeout: 60_000 }, async (t) => {
  const project = mkdtempSync(path.resolve('tests/.pimg-'));
  const home = mkdtempSync(path.resolve('tests/.pimg-home-'));
  const cfg = loadConfig([project, '--home', home, '--weather', 'clear', '--host', '127.0.0.1']);
  cfg.port = 0;
  const office = await startServer(cfg);
  t.after(async () => {
    const closed = once(office.server, 'close');
    office.shutdown();
    await closed;
    await delay(100);
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(office.server.address() as AddressInfo).port}`;
  const staged = path.join(project, '.droid-office', 'drops', 'staged');
  const same = { origin: base };

  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?name=Pasting`, { headers: { origin: base } });
  t.after(() => ws.terminate());
  const [raw] = await once(ws, 'message');
  const floor = (JSON.parse(String(raw)) as { floors: { id: string }[] }).floors[0]?.id;
  assert.ok(floor, 'the office has a floor to paste into');
  const url = (extra: string) => `${base}/api/prompt/image?floor=${encodeURIComponent(floor)}&${extra}`;

  // Only the office's own page may upload, and only into a floor that exists.
  assert.equal((await fetch(url('name=a.png'), { method: 'POST', body: PNG })).status, 403);
  assert.equal((await fetch(`${base}/api/prompt/image?floor=nope&name=a.png`, { method: 'POST', headers: same, body: PNG })).status, 404);
  assert.equal((await fetch(url('name=a.png'), { method: 'GET' })).status, 405);

  // Only pictures, whatever the browser says they are.
  const script = await fetch(url('name=a.png'), { method: 'POST', headers: { ...same, 'content-type': 'image/png' }, body: '#!/bin/sh\necho hi\n' });
  assert.equal(script.status, 415);
  assert.ok(!existsSync(staged) || readdirSync(staged).length === 0);

  const res = await fetch(url('name=Screenshot%201.png'), { method: 'POST', headers: { ...same, 'content-type': 'image/png' }, body: PNG });
  assert.equal(res.status, 200);
  const { id } = (await res.json()) as { id: string };
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.deepEqual(readdirSync(path.join(staged, id)), ['Screenshot-1.png']);
  assert.deepEqual(readFileSync(path.join(staged, id, 'Screenshot-1.png')), PNG);

  // Taking it out of the prompt deletes it; an id that isn't one deletes nothing else.
  assert.equal((await fetch(url('id=..%2F..'), { method: 'DELETE', headers: same })).status, 200);
  assert.ok(existsSync(path.join(staged, id)));
  assert.equal((await fetch(url(`id=${id}`), { method: 'DELETE' })).status, 403);
  assert.equal((await fetch(url(`id=${id}`), { method: 'DELETE', headers: same })).status, 200);
  assert.ok(!existsSync(path.join(staged, id)));
});
