import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';

test('POST /api/automation runs a window.office command in the open office tab and answers with its result', { timeout: 30_000 }, async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'office-automation-'));
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
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/automation`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  assert.equal((await fetch(`${base}/api/automation`)).status, 405);
  assert.equal((await post({ cmd: 'state' }, { origin: 'https://not-the-office.example' })).status, 403, 'a web page elsewhere cannot drive the office');
  assert.equal((await post({ cmd: 'state' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post({ args: [] })).status, 400);
  const none = await post({ cmd: 'state' });
  assert.equal(none.status, 409);
  assert.match((await none.json()).error, /No office tab is open/);

  // The office tab: answers goTo with a state, and anything else with an error.
  const tab = new WebSocket(`${base.replace('http:', 'ws:')}/ws?name=AutomationTest`, { headers: { origin: base } });
  t.after(() => tab.terminate());
  const seen: { cmd: string; args: unknown[] }[] = [];
  tab.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.t !== 'automation.run') return;
    seen.push({ cmd: msg.cmd, args: msg.args });
    if (msg.cmd === 'slow') return;
    const answer = msg.cmd === 'goTo' ? { ok: true, value: { at: msg.args[0] } } : { ok: false, error: `No command "${msg.cmd}"` };
    // Someone else's answer under the same id is ignored: only the tab that was asked can answer.
    tab.send(JSON.stringify({ t: 'automation.result', id: msg.id, ...answer }));
  });
  await once(tab, 'open');

  const ok = await post({ cmd: 'goTo', args: ['desk-3'] }, { origin: base });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, value: { at: 'desk-3' } });
  const one = await post({ cmd: 'goTo', args: 'issues' });
  assert.deepEqual(await one.json(), { ok: true, value: { at: 'issues' } }, 'a lone argument is the first');
  const bad = await post({ cmd: 'fly' });
  assert.equal(bad.status, 422);
  assert.deepEqual(await bad.json(), { ok: false, error: 'No command "fly"' });
  const slow = await post({ cmd: 'slow', timeout: 1000 });
  assert.equal(slow.status, 504);
  assert.match((await slow.json()).error, /didn't answer within 1s/);
  assert.deepEqual(seen, [
    { cmd: 'goTo', args: ['desk-3'] },
    { cmd: 'goTo', args: ['issues'] },
    { cmd: 'fly', args: [] },
    { cmd: 'slow', args: [] },
  ]);

  // The tab closing while a command is out answers it at once.
  const pending = post({ cmd: 'slow' });
  await delay(200);
  tab.close();
  const gone = await pending;
  assert.equal(gone.status, 422);
  assert.match((await gone.json()).error, /tab closed/);
});
