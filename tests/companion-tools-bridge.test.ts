import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridgeHttp, linkAction } from '../src/client/companion-tools-bridge.js';
import { Net, type NetTransport } from '../src/client/net.js';
import type { ToolsToNative } from '../src/shared/companion-tools.js';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol.js';

type HttpRequest = Extract<ToolsToNative, { t: 'http' }>;

function rig() {
  const posted: HttpRequest[] = [];
  const http = createBridgeHttp((m) => posted.push(m));
  http.setUp(true);
  return { http, posted };
}

test('a request goes to the app with its query and body, and the answer comes back as a Response', async () => {
  const { http, posted } = rig();
  const reply = http.fetch('/api/whiteboard/blob?floor=f1', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } });
  assert.equal(posted.length, 1);
  assert.deepEqual({ ...posted[0], id: 0 }, { t: 'http', id: 0, method: 'POST', path: '/api/whiteboard/blob', query: 'floor=f1', contentType: 'application/json', body: '{"a":1}', base64: false });
  http.result({ t: 'http.result', id: posted[0]!.id, status: 200, contentType: 'application/json', body: '{"ok":true}' });
  const r = await reply;
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('a request off the allowlist is refused before anything is sent', async () => {
  const { http, posted } = rig();
  await assert.rejects(http.fetch('/api/settings/token'), /only available on the office’s own computer/);
  assert.equal(posted.length, 0);
});

test('an answer the page cannot build a Response from rejects instead of hanging', async () => {
  const { http, posted } = rig();
  const bad64 = http.fetch('/api/factory/computers');
  const zero = http.fetch('/api/factory/computers');
  const reset = http.fetch('/api/factory/computers');
  http.result({ t: 'http.result', id: posted[0]!.id, status: 200, body: '%%%not base64%%%', base64: true });
  http.result({ t: 'http.result', id: posted[1]!.id, status: 0 });
  // 205 has no body, even when the app sends an empty one.
  http.result({ t: 'http.result', id: posted[2]!.id, status: 205, body: '' });
  await assert.rejects(bad64, /cannot read/);
  await assert.rejects(zero, /cannot read/);
  assert.equal((await reset).status, 205);
});

test('an abort before the call, or while a picture is being read, sends nothing', async () => {
  const { http, posted } = rig();
  const before = new AbortController();
  before.abort();
  await assert.rejects(http.fetch('/api/factory/computers', { signal: before.signal }), { name: 'AbortError' });
  const during = new AbortController();
  const picture = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
  const pending = http.fetch('/api/whiteboard/blob', { method: 'POST', body: picture, signal: during.signal });
  during.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(posted.length, 0);
});

test('an abort after sending rejects, and a late answer is dropped', async () => {
  const { http, posted } = rig();
  const c = new AbortController();
  const pending = http.fetch('/api/factory/computers', { signal: c.signal });
  c.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  http.result({ t: 'http.result', id: posted[0]!.id, status: 200, body: '{}' });
});

test('a connection loss fails every request in flight and nothing started before it is sent after', async () => {
  const { http, posted } = rig();
  const inFlight = http.fetch('/api/factory/computers');
  const reading = http.fetch('/api/whiteboard/blob', { method: 'POST', body: new Blob([new Uint8Array([1])]) });
  http.setUp(false);
  await assert.rejects(inFlight, /lost before it answered/);
  http.setUp(true);
  await assert.rejects(reading, /Not connected/);
  assert.equal(posted.length, 1, 'only the request made before the loss went out');
  // Its answer, arriving on the new connection, reaches nobody.
  http.result({ t: 'http.result', id: posted[0]!.id, status: 200, body: '{}' });
  await assert.rejects(http.fetch('/api/factory/computers', { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('nothing is sent while the socket is down or outside the app', async () => {
  const posted: HttpRequest[] = [];
  const down = createBridgeHttp((m) => posted.push(m));
  await assert.rejects(down.fetch('/api/factory/computers'), /Not connected/);
  assert.equal(posted.length, 0);
  await assert.rejects(createBridgeHttp(null).fetch('/api/factory/computers'), /only works inside Droid Office for Android/);
});

test('links are judged by where the browser goes, not the attribute text', () => {
  const page = 'https://appassets.androidplatform.net';
  const at = (href: string) => new URL(href, `${page}/assets/companion-tools/index.html`).href;
  assert.deepEqual(linkAction('#top', at('#top'), page, false), { do: 'stay' });
  // `/\evil.com` resolves to //evil.com: it leaves the page, so it goes to the app as an outside link.
  assert.deepEqual(linkAction('/\\evil.com/x', at('/\\evil.com/x'), page, false), { do: 'external', url: 'https://evil.com/x' });
  assert.deepEqual(linkAction('https://github.com/o/r/pull/1', at('https://github.com/o/r/pull/1'), page, false), { do: 'external', url: 'https://github.com/o/r/pull/1' });
  // The office's own file downloads through the app; any other same-origin link never navigates the page.
  assert.deepEqual(linkAction('/api/factory/wiki/runs/1/export', at('/api/factory/wiki/runs/1/export'), page, true), { do: 'stay' });
  assert.deepEqual(linkAction('/elsewhere', at('/elsewhere'), page, false), { do: 'block' });
  assert.deepEqual(linkAction('x', 'not a url', page, false), { do: 'block' });
});

class Transport implements NetTransport {
  private messages = new Set<(msg: ServerMsg) => void>();
  private statuses = new Set<(up: boolean) => void>();
  open = false;
  connect() {}
  close() {}
  send(_msg: ClientMsg) {
    return this.open;
  }
  onMessage(fn: (msg: ServerMsg) => void) {
    this.messages.add(fn);
    return () => this.messages.delete(fn);
  }
  onStatus(fn: (up: boolean) => void) {
    this.statuses.add(fn);
    return () => this.statuses.delete(fn);
  }
  status(up: boolean) {
    this.open = up;
    for (const fn of this.statuses) fn(up);
  }
  deliver(msg: ServerMsg) {
    for (const fn of this.messages) fn(msg);
  }
}

test('a loss in the middle of a floor switch is a connection loss, though readiness already went', () => {
  // companion-tools.ts discards unsent Whiteboard writes on onConnectionLost for this reason.
  const transport = new Transport();
  const net = new Net(
    () => ({ name: 'Owner', color: '#fff' }) as never,
    () => null,
    { transport },
  );
  const ready: boolean[] = [];
  let lost = 0;
  net.onReady((r) => ready.push(r));
  net.onConnectionLost(() => lost++);
  transport.status(true);
  transport.deliver({ t: 'welcome', floor: 'a', workers: [] } as unknown as ServerMsg);
  net.send({ t: 'floor.go', floor: 'b' } as ClientMsg);
  assert.deepEqual(ready, [true, false]);
  transport.status(false);
  assert.deepEqual(ready, [true, false], 'no second onReady(false) for the loss');
  assert.equal(lost, 1);
});
