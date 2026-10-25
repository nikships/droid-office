import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { type ControlError, controlClient } from '../src/server/subscriptions/control.js';
import { CONTROL_FILE, MODELS, TOKEN, USAGE, status, tempDir } from './subscriptions-fixtures.js';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A DroidProxy control API on a loopback port, answering by route. */
async function fakeProxy(t: { after(fn: () => void): void }, answer: (req: Seen) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const s = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      seen.push(s);
      const a = answer(s);
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(typeof a.body === 'string' ? a.body : JSON.stringify(a.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { port: (server.address() as AddressInfo).port, seen };
}

function writeControl(home: string, file: Record<string, unknown>) {
  mkdirSync(path.join(home, '.droidproxy'), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(home, '.droidproxy', 'control.json'), JSON.stringify(file), { mode: 0o600 });
}

test('calls carry the token from control.json, JSON bodies, and no Origin', async (t) => {
  const home = tempDir(t, 'control');
  const proxy = await fakeProxy(t, (req) => {
    if (req.url === '/droidproxy/control/status') return { status: 200, body: status() };
    if (req.url === '/droidproxy/control/models') return { status: 200, body: MODELS };
    if (req.url === '/droidproxy/usage') return { status: 200, body: USAGE };
    if (req.url === '/droidproxy/control/connect') return { status: 202, body: { connecting: { started_at: '2026-10-25T21:31:54Z', user_code: null, verification_uri: null, error: null } } };
    if (req.url === '/droidproxy/control/factory-models') return { status: 200, body: { installed: 14, backup: null } };
    return { status: 200, body: {} };
  });
  writeControl(home, { ...CONTROL_FILE, port: proxy.port });
  const c = controlClient({ home });
  assert.equal((await c.status()).providers?.length, 4);
  assert.equal((await c.models()).models?.length, 5);
  assert.equal((await c.usage()).accounts?.length, 3);
  assert.ok((await c.connect('claude')).connecting);
  await c.cancelConnect('claude');
  await c.removeAccount('codex', 'a.json');
  await c.setProvider('grok', false);
  assert.equal((await c.factoryModels()).installed, 14);
  await c.open();
  const control = proxy.seen.filter((s) => s.url.startsWith('/droidproxy/control/'));
  for (const s of control) {
    assert.equal(s.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(s.headers.origin, undefined);
    assert.equal(s.headers.host, `127.0.0.1:${proxy.port}`);
    if (s.method === 'POST') assert.equal(s.headers['content-type'], 'application/json');
  }
  assert.equal(proxy.seen.find((s) => s.url === '/droidproxy/usage')?.headers.authorization, undefined);
  assert.deepEqual(
    control.filter((s) => s.method === 'POST').map((s) => [s.url.replace('/droidproxy/control', ''), JSON.parse(s.body)]),
    [
      ['/connect', { provider: 'claude' }],
      ['/connect/cancel', { provider: 'claude' }],
      ['/accounts/remove', { provider: 'codex', account: 'a.json' }],
      ['/providers', { provider: 'grok', enabled: false }],
      ['/factory-models', {}],
      ['/open', {}],
    ],
  );
});

test('a 401 reads control.json again and retries once with the new token', async (t) => {
  const home = tempDir(t, 'control-401');
  const fresh = 'b'.repeat(64);
  const proxy = await fakeProxy(t, (req) => (req.headers.authorization === `Bearer ${fresh}` ? { status: 200, body: status() } : { status: 401, body: { error: 'Unauthorized' } }));
  writeControl(home, { ...CONTROL_FILE, port: proxy.port });
  const c = controlClient({
    home,
    fetchImpl: async (url, init) => {
      const res = await fetch(url, init);
      // DroidProxy relaunched between the office reading the file and the call landing.
      if (res.status === 401) writeControl(home, { ...CONTROL_FILE, port: proxy.port, token: fresh });
      return res;
    },
  });
  assert.equal((await c.status()).api, 1);
  assert.equal(proxy.seen.length, 2);
});

test('a token DroidProxy keeps refusing, a missing file and a missing API say so in words, never with the token', async (t) => {
  const home = tempDir(t, 'control-errors');
  const c = controlClient({ home });
  await assert.rejects(c.status(), (e: ControlError) => e.kind === 'no-file');
  const proxy = await fakeProxy(t, (req) => {
    if (req.url.endsWith('/status')) return { status: 401, body: { error: `bad token ${TOKEN}` } };
    if (req.url.endsWith('/models')) return { status: 404, body: 'Not Found' };
    if (req.url.endsWith('/connect')) return { status: 409, body: { error: `A sign-in is already running (${TOKEN})` } };
    return { status: 500, body: 'oops' };
  });
  writeControl(home, { ...CONTROL_FILE, port: proxy.port });
  const errors: ControlError[] = [];
  for (const call of [() => c.status(), () => c.models(), () => c.connect('claude'), () => c.open()]) {
    try {
      await call();
      assert.fail('should have failed');
    } catch (e) {
      errors.push(e as ControlError);
    }
  }
  assert.deepEqual(
    errors.map((e) => e.kind),
    ['unauthorized', 'no-api', 'http', 'http'],
  );
  assert.equal(errors[2].message, 'A sign-in is already running (…)');
  assert.equal(errors[3].message, "DroidProxy answered 500 with something that isn't JSON");
  for (const e of errors) assert.ok(!e.message.includes(TOKEN) && !String(e.stack).includes(TOKEN));
  // Only the reread after the 401, and the same token: no second try.
  assert.equal(proxy.seen.filter((s) => s.url.endsWith('/status')).length, 1);
});

test('nothing listening, or no answer in time, is told apart', async (t) => {
  const home = tempDir(t, 'control-down');
  writeControl(home, CONTROL_FILE);
  const refusedErr = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const down = controlClient({ home, fetchImpl: () => Promise.reject(refusedErr) });
  await assert.rejects(down.status(), (e: ControlError) => e.kind === 'refused' && e.message === "DroidProxy isn't running");
  await assert.rejects(down.usage(), (e: ControlError) => e.kind === 'refused');
  const slow = controlClient({ home, fetchImpl: () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })) });
  await assert.rejects(slow.models(), (e: ControlError) => e.kind === 'timeout' && e.message === "DroidProxy didn't answer in 5 s");
  await assert.rejects(slow.factoryModels(), (e: ControlError) => e.message === "DroidProxy didn't answer in 15 s");
  writeControl(home, { api: 1, port: 8317 });
  assert.equal(await down.file(), undefined);
});
