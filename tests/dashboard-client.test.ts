import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { BROWSER_KEY, browserCredential, draftKey, forgetBrowserCredential, saveBrowserCredential } from '../src/client/browser-session.js';
import { Net } from '../src/client/net.js';
import { store } from '../src/client/state.js';
import { setBrowserAuth, withToken } from '../src/client/token.js';
import { TerminalMirror, suppressMirrorQueries } from '../src/client/term-mirror.js';

test('browser credentials persist without minting devices; local forget is only local storage', () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
  };
  const saved = { token: 'a'.repeat(43), device: { id: 'browser-id', name: 'Browser' } };
  assert.equal(browserCredential(storage), undefined);
  assert.equal(saveBrowserCredential(storage, saved), true);
  assert.deepEqual(browserCredential(storage), saved);
  assert.deepEqual(browserCredential(storage), saved);
  assert.equal(forgetBrowserCredential(storage), true);
  assert.equal(browserCredential(storage), undefined);
  data.set(BROWSER_KEY, 'not json');
  assert.equal(browserCredential(storage), undefined);
  data.set(BROWSER_KEY, JSON.stringify({ ...saved, token: 'wrong' }));
  assert.equal(browserCredential(storage), undefined);
  const blocked = {
    getItem: () => {
      throw Error('blocked');
    },
    setItem: () => {
      throw Error('blocked');
    },
    removeItem: () => {
      throw Error('blocked');
    },
  };
  assert.equal(browserCredential(blocked), undefined);
  assert.equal(saveBrowserCredential(blocked, saved), false);
  assert.equal(forgetBrowserCredential(blocked), false);
  assert.notEqual(draftKey('floor-a', 'worker-a'), draftKey('floor-b', 'worker-a'));
  assert.notEqual(draftKey('floor-a', 'worker-a'), draftKey('floor-a', 'worker-b'));
});

test('credentials only go to office APIs, never external links or Whiteboard capability paths', () => {
  setBrowserAuth('device-token', 'bootstrap');
  assert.equal(withToken('/api/whiteboard/render?floor=a'), '/api/whiteboard/render?floor=a&d=device-token');
  for (const path of ['https://other.test/api/test', '//other.test/api/test', '/whiteboard/c/cap/index.html', '/assets/font.woff']) assert.equal(withToken(path), path);
  setBrowserAuth('', 'lan-token');
  assert.equal(withToken('/api/health'), '/api/health?t=lan-token');
  setBrowserAuth('');
  assert.equal(withToken('/api/health'), '/api/health');
});

class FakeSocket {
  static OPEN = 1;
  static created: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  constructor(readonly url: string) {
    FakeSocket.created.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  close() {
    this.drop(1000);
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}
function network(t: TestContext) {
  const before = { socket: globalThis.WebSocket, location: Object.getOwnPropertyDescriptor(globalThis, 'location') };
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'http:', host: 'office.test:4677', search: '' } });
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  FakeSocket.created = [];
  t.after(() => {
    globalThis.WebSocket = before.socket;
    if (before.location) Object.defineProperty(globalThis, 'location', before.location);
    else Reflect.deleteProperty(globalThis, 'location');
    setBrowserAuth('');
  });
  const net = new Net(
    () => store.profile,
    () => null,
    { client: 'dashboard', device: () => 'paired-token', floor: () => 'floor-a' },
  );
  t.after(() => net.close());
  return net;
}

test('one socket per connection; request receipts confirm actions, and disconnected actions are never replayed', async (t) => {
  const net = network(t);
  const statuses: boolean[] = [];
  const off = net.onStatus((up) => statuses.push(up));
  let messages = 0;
  const unsubscribe = net.onMessage(() => messages++);
  await Promise.all([net.connect(), net.connect()]);
  assert.equal(FakeSocket.created.length, 1);
  const ws = FakeSocket.created[0]!;
  const url = new URL(ws.url);
  assert.equal(url.searchParams.get('d'), 'paired-token');
  assert.equal(url.searchParams.get('client'), 'dashboard');
  assert.equal(url.searchParams.get('floor'), 'floor-a');
  assert.equal(url.protocol, 'ws:');
  ws.open();
  const pending = net.request({ t: 'worker.prompt', workerId: 'a', prompt: 'hello' });
  const sent = JSON.parse(ws.sent[0]!);
  assert.ok(sent.requestId);
  ws.message({ t: 'action.result', requestId: sent.requestId, ok: true });
  assert.equal((await pending).ok, true);
  const uncertain = net.request({ t: 'worker.kill', workerId: 'a' });
  ws.drop(1006);
  assert.match((await uncertain).error!, /not replayed/);
  assert.equal(net.send({ t: 'term.input', workerId: 'a', data: 'never buffer me' }), false);
  assert.equal((await net.request({ t: 'worker.spawn', deskId: 'auto' })).ok, false);
  await net.connect();
  const again = FakeSocket.created[1]!;
  again.open();
  assert.deepEqual(again.sent, []);
  ws.message({ t: 'toast', text: 'late data' });
  assert.equal(messages, 1);
  unsubscribe();
  off();
  again.message({ t: 'toast', text: 'ignored' });
  assert.equal(messages, 1);
  assert.deepEqual(statuses, [true, false, true]);
});

test('401 and 4401 stop retries; delayed authorization cannot resurrect a closed socket', async (t) => {
  network(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rejected = 0;
  const invalid = new Net(
    () => store.profile,
    () => null,
    { authorize: async () => false, unauthorized: () => rejected++ },
  );
  await invalid.connect();
  t.mock.timers.tick(60_000);
  assert.equal(rejected, 1);
  assert.equal(FakeSocket.created.length, 0);
  const revoked = new Net(
    () => store.profile,
    () => null,
    { unauthorized: () => rejected++ },
  );
  t.after(() => revoked.close());
  await revoked.connect();
  FakeSocket.created[0]!.open();
  FakeSocket.created[0]!.drop(4401);
  t.mock.timers.tick(60_000);
  assert.equal(rejected, 2);
  assert.equal(FakeSocket.created.length, 1);
  let authorize: ((up: boolean) => void) | undefined;
  const delayed = new Net(
    () => store.profile,
    () => null,
    {
      authorize: () =>
        new Promise((resolve) => {
          authorize = resolve;
        }),
    },
  );
  const waiting = delayed.connect();
  delayed.close();
  authorize!(true);
  await waiting;
  assert.equal(FakeSocket.created.length, 1);
});

test('unreachable authorization retries with bounded backoff and closing cancels its timer', async (t) => {
  network(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let checks = 0;
  const net = new Net(
    () => store.profile,
    () => null,
    {
      authorize: async () => {
        checks++;
        throw Error('offline');
      },
    },
  );
  t.after(() => net.close());
  await net.connect();
  for (const delay of [500, 1000, 2000, 4000, 8000, 8000]) {
    t.mock.timers.tick(delay - 1);
    const before = checks;
    t.mock.timers.tick(1);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(checks, before + 1);
  }
  net.close();
  t.mock.timers.tick(30_000);
  assert.equal(checks, 7);
});

test('terminal snapshots drain old writes, preserve stream order, and invalidate stale callbacks', () => {
  const callbacks: (() => void)[] = [];
  const writes: string[] = [];
  const sizes: number[][] = [];
  let reset = 0,
    ready = 0,
    overflow = 0;
  const sink = {
    reset: () => reset++,
    resize: (c: number, r: number) => sizes.push([c, r]),
    write: (data: string | Uint8Array, callback?: () => void) => {
      writes.push(String(data));
      if (callback) callbacks.push(callback);
    },
  };
  const mirror = new TerminalMirror(
    sink,
    () => ready++,
    () => overflow++,
  );
  mirror.data('before snapshot');
  mirror.snapshot({ data: 'snapshot', cols: 80, rows: 24, shared: true });
  mirror.data('first live');
  callbacks.shift()!();
  assert.equal(reset, 1);
  assert.deepEqual(sizes, [[80, 24]]);
  callbacks.shift()!();
  assert.equal(mirror.ready, false);
  assert.deepEqual(writes, ['', 'snapshot', 'first live']);
  callbacks.shift()!();
  assert.equal(mirror.ready, true);
  assert.equal(ready, 1);
  mirror.data('second live');
  mirror.disconnect();
  mirror.data('dropped');
  mirror.snapshot({ data: 'stale', cols: 80, rows: 24 });
  mirror.disconnect();
  callbacks.shift()!();
  assert.ok(!writes.includes('stale'));
  mirror.snapshot({ data: 'new snapshot', cols: 100, rows: 30 });
  callbacks.shift()!();
  callbacks.shift()!();
  assert.equal(ready, 2);
  mirror.snapshot({ data: 'slow snapshot', cols: 100, rows: 30 });
  mirror.data('x'.repeat(1024 * 1024 + 1));
  assert.equal(overflow, 1);
  assert.equal(mirror.ready, false);
  callbacks.shift()!();
  assert.ok(!writes.includes('slow snapshot'));
});

test('a terminal mirror renders full-screen output without forwarding emulator query replies', async () => {
  const { Terminal } = createRequire(import.meta.url)('@xterm/headless');
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const replies: string[] = [];
  term.onData((data: string) => replies.push(data));
  const off = suppressMirrorQueries(term);
  try {
    await new Promise<void>((resolve) => term.write('\x1b[6n\x1b[c\x1b[>c\x1b[?6n\x1b[18t\x1bP$qm\x1b\\\x1b]10;?\x07\x1b[?1049hhello\x1b[?1049l', resolve));
    assert.deepEqual(replies, []);
    assert.equal(term.buffer.active.type, 'normal');
  } finally {
    off();
    term.dispose();
  }
});
