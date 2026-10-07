import test from 'node:test';
import assert from 'node:assert/strict';
import { FactoryApi, FactoryError } from '../src/server/factory/api.js';
import { HttpError, SliceFeature, badRequest, httpErrorOf, matchPath, notFound, str, type FactoryRoute, type FeatureHost } from '../src/server/factory/feature.js';
import { FactoryRegistry, HEARTBEAT_MS, MAX_BACKOFF_MS, sameness, type FactoryLink } from '../src/server/factory/registry.js';
import { emptyWiki, type FactoryWikiState } from '../src/shared/factory-wiki.js';
import { emptyFactoryState, type FactoryConnection, type FactoryState } from '../src/shared/factory.js';

const API = new FactoryApi('fk-test-registry-0000', (async () => new Response('{}')) as typeof fetch);

/** A connection the test switches on and off. */
function link() {
  const l = {
    connected: false,
    rejectedWith: undefined as FactoryError | undefined,
    connection: (): FactoryConnection => ({ connected: l.connected, capabilities: [], ...(l.rejectedWith ? { rejected: 'r' } : {}) }),
    client: () => (l.connected && !l.rejectedWith ? API : undefined),
    rejected: (err: FactoryError) => {
      l.rejectedWith = err;
    },
  } satisfies FactoryLink & Record<string, unknown>;
  return l;
}

/** A feature that counts its polls and does what `next` says. */
class Probe extends SliceFeature<'wiki'> {
  readonly interval = 60_000;
  readonly fastInterval = 10_000;
  polls = 0;
  resets = 0;
  next: () => Promise<void> = async () => {};
  routes: FactoryRoute[] = [];
  isBusy = false;
  constructor(host: FeatureHost) {
    super('wiki', host, emptyWiki);
  }
  async poll() {
    this.polls++;
    await this.next();
    this.set({ fetchedAt: this.polls, error: undefined });
  }
  busy() {
    return this.isBusy;
  }
  override reset() {
    this.resets++;
    super.reset();
  }
  hostOf() {
    return this.host;
  }
  change(patch: Partial<FactoryWikiState>) {
    this.set(patch);
  }
}

class Second extends SliceFeature<'ci'> {
  readonly interval = 60_000;
  readonly fastInterval = 10_000;
  polls = 0;
  constructor(host: FeatureHost) {
    super('ci', host, () => ({ github: null, owners: [], workflows: [], runs: [], fetchedAt: 0 }));
  }
  async poll() {
    this.polls++;
  }
}

function setup() {
  const l = link();
  let now = 1_000_000;
  const sent: FactoryState[] = [];
  const toasts: string[] = [];
  const reg = new FactoryRegistry({ link: l, broadcast: (s) => sent.push(s), toast: (t) => toasts.push(t), now: () => now, broadcastMs: 1 });
  const probe = reg.register((host) => new Probe(host)) as Probe;
  const second = reg.register((host) => new Second(host)) as Second;
  const connect = () => {
    l.connected = true;
    reg.connectionChanged();
  };
  return {
    l,
    reg,
    probe,
    second,
    sent,
    toasts,
    connect,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

test('nothing polls until the office is connected, then the features start staggered', async () => {
  const { reg, probe, second, connect, advance } = setup();
  await reg.tick();
  assert.equal(probe.polls, 0);
  connect();
  await settle();
  assert.equal(probe.polls, 1, 'the first one goes at once');
  assert.equal(second.polls, 0, 'the second waits its turn');
  advance(1500);
  await reg.tick();
  assert.equal(second.polls, 1);
  reg.stop();
});

test('a feature polls on its interval, fast while watched or busy, never twice at once', async () => {
  const { reg, probe, connect, advance } = setup();
  connect();
  await settle();
  assert.equal(probe.polls, 1);
  advance(59_000);
  await reg.tick();
  assert.equal(probe.polls, 1);
  advance(1000);
  await reg.tick();
  assert.equal(probe.polls, 2);

  reg.watch('tab-1', 'wiki', true);
  reg.watch('tab-2', 'wiki', true);
  assert.equal(reg.intervalOf('wiki'), 10_000);
  advance(10_000);
  await reg.tick();
  assert.equal(probe.polls, 3);
  reg.watch('tab-1', 'wiki', false);
  assert.ok(reg.watched('wiki'), 'tab-2 still watches');
  reg.drop('tab-2');
  assert.ok(!reg.watched('wiki'));
  assert.equal(reg.intervalOf('wiki'), 60_000);
  probe.isBusy = true;
  assert.equal(reg.intervalOf('wiki'), 10_000, 'busy polls fast too');
  probe.isBusy = false;
  assert.equal(reg.intervalOf('cloud' as 'wiki'), 0);

  // A slow poll isn't started again while it runs.
  let release!: () => void;
  probe.next = () => new Promise<void>((r) => (release = r));
  advance(60_000);
  const running = reg.tick();
  advance(60_000);
  await Promise.race([reg.tick(), settle()]);
  assert.equal(probe.polls, 4);
  release();
  await running;
});

test('errors back off, doubling, and a 429 waits out its Retry-After', async () => {
  const { reg, probe, connect, advance } = setup();
  probe.next = async () => {
    throw new Error('Factory answered 500.');
  };
  connect();
  await settle();
  assert.equal(probe.polls, 1);
  assert.equal(probe.state().error, 'Factory answered 500.');
  advance(60_000);
  await reg.tick();
  assert.equal(probe.polls, 2, 'the first retry is one interval later');
  advance(60_000);
  await reg.tick();
  assert.equal(probe.polls, 2, 'the second waits twice as long');
  advance(60_000);
  await reg.tick();
  assert.equal(probe.polls, 3);

  probe.next = async () => {
    throw new FactoryError('slow down', 429, '', '', 600);
  };
  advance(10 * 60_000);
  await reg.tick();
  assert.equal(probe.polls, 4);
  advance(599_000);
  await reg.tick();
  assert.equal(probe.polls, 4, 'waits out the Retry-After');
  advance(1000);
  probe.next = async () => {};
  await reg.tick();
  assert.equal(probe.polls, 5);
  assert.equal(probe.state().error, undefined);
  advance(60_000);
  await reg.tick();
  assert.equal(probe.polls, 6, 'a success ends the backoff');
  assert.ok(MAX_BACKOFF_MS >= 60_000);
});

test('a refresh polls now, past the backoff', async () => {
  const { reg, probe, connect } = setup();
  probe.next = async () => {
    throw new Error('down');
  };
  connect();
  await settle();
  reg.refresh('wiki');
  await settle();
  assert.equal(probe.polls, 2);
  probe.hostOf().pollSoon();
  await settle();
  assert.equal(probe.polls, 3);
  reg.refresh();
  await settle();
  assert.equal(probe.polls, 4);
});

test('a 401 marks the key rejected and polling stops', async () => {
  const { l, reg, probe, connect, advance } = setup();
  probe.next = async () => {
    throw new FactoryError('no', 401);
  };
  connect();
  await settle();
  assert.equal(l.rejectedWith?.status, 401);
  reg.connectionChanged();
  advance(10 * 60_000);
  await reg.tick();
  assert.equal(probe.polls, 1);
});

test('slice changes go out as one broadcast, with the connection', async () => {
  const { reg, probe, sent, toasts } = setup();
  const host = probe.hostOf();
  host.changed();
  host.changed();
  host.changed();
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].connection.connected, false);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['ci', 'computers', 'connection', 'sessions', 'wiki']);
  assert.equal(host.api(), undefined);
  host.toast('hello');
  assert.deepEqual(toasts, ['hello']);
  assert.equal(reg.feature('wiki'), probe);
  assert.throws(() => reg.register((h) => new Probe(h)), /registered twice/);
});

test('a poll that read the same data doesn’t go out, but one does at least every minute', async () => {
  const { reg, probe, sent, connect, advance } = setup();
  connect();
  await settle();
  assert.equal(probe.polls, 1);
  assert.equal(sent.at(-1)?.wiki.fetchedAt, 1, 'the first read goes out: the slice went from never read to read');
  const count = sent.length;

  advance(30_000);
  probe.hostOf().pollSoon();
  await settle();
  assert.equal(probe.polls, 2);
  assert.equal(sent.length, count, 'only fetchedAt moved');

  advance(HEARTBEAT_MS - 30_000 - 1);
  await reg.tick();
  await settle();
  assert.equal(sent.length, count, 'not yet a minute');
  advance(1);
  await reg.tick();
  assert.equal(sent.length, count + 1, 'a minute on, the newer fetchedAt goes out');
  assert.equal(sent.at(-1)?.wiki.fetchedAt, 2);
  await reg.tick();
  assert.equal(sent.length, count + 1, 'once');

  probe.next = async () => {
    probe.change({ runs: [{ id: 'r1', repoUrl: 'https://github.com/o/r', status: 'running', raw: {} }] });
  };
  probe.hostOf().pollSoon();
  await settle();
  assert.equal(sent.length, count + 2, 'new data goes out at once');
  assert.equal(sent.at(-1)?.wiki.runs.length, 1);
  reg.stop();
});

test('a broadcast compares fetchedAt only as read or not', () => {
  const a = emptyFactoryState();
  const b = emptyFactoryState();
  b.wiki.fetchedAt = 5;
  b.computers.metrics = { c1: { history: [], fetchedAt: 9 } };
  const c = structuredClone(b);
  c.wiki.fetchedAt = 6;
  c.computers.metrics.c1.fetchedAt = 10;
  assert.notEqual(sameness(a), sameness(b));
  assert.equal(sameness(b), sameness(c));
  c.wiki.error = 'boom';
  assert.notEqual(sameness(b), sameness(c));
});

test('disconnecting resets every feature, even one that was polling', async () => {
  const { l, reg, probe, connect } = setup();
  let release!: () => void;
  probe.next = () => new Promise<void>((r) => (release = r));
  connect();
  await settle();
  l.connected = false;
  reg.connectionChanged();
  assert.equal(probe.resets, 1);
  release();
  await settle();
  assert.equal(probe.resets, 2, 'what the poll read belonged to the old connection');
  assert.equal(probe.state().fetchedAt, 0);
  reg.keyReplaced();
  assert.equal(probe.resets, 3);
});

test('start and stop run the ticker', async () => {
  const { reg, l, probe } = setup();
  l.connected = true;
  reg.start();
  reg.start();
  await settle();
  assert.equal(probe.polls, 1);
  reg.stop();
  reg.changed();
  reg.stop();
});

// ---- Routes ------------------------------------------------------------------------------------

function routed() {
  const s = setup();
  s.probe.routes = [
    { method: 'GET', path: '', handle: () => ({ root: true }) },
    { method: 'GET', path: '/runs/:id', handle: ({ params, query, by }) => ({ id: params.id, q: query.get('q'), by }) },
    { method: 'POST', path: '/runs/:id', handle: async ({ json }) => ({ got: await json(), again: await json() }) },
    {
      method: 'DELETE',
      path: '/runs/:id',
      handle: () => {
        throw new FactoryError('That needs another Factory plan (402).', 402);
      },
    },
    {
      method: 'PATCH',
      path: '/runs/:id',
      handle: () => {
        throw new FactoryError('nope', 401);
      },
    },
    {
      method: 'PUT',
      path: '/runs/:id',
      handle: () => {
        throw badRequest('name is required');
      },
    },
    { method: 'GET', path: '/empty', handle: () => undefined },
  ];
  return s;
}

const q = (s = '') => new URLSearchParams(s);
const body = (text: string) => async () => text;

test('routes dispatch by feature, path and method behind the not-connected check', async () => {
  const { reg, connect, l } = routed();
  const trusted = { trusted: true };
  assert.deepEqual(await reg.http('GET', '/nope/x', q(), body(''), trusted), { status: 404, body: { error: 'No such Factory feature' } });
  assert.equal((await reg.http('GET', '/wiki/runs/a', q(), body(''), trusted)).status, 409, 'not connected');
  connect();
  assert.deepEqual(await reg.http('GET', '/wiki', q(), body(''), trusted), { status: 200, body: { root: true } });
  assert.deepEqual(await reg.http('GET', '/wiki/runs/a%20b', q('q=1'), body(''), { trusted: false, by: 'Olive' }), { status: 200, body: { id: 'a b', q: '1', by: 'Olive' } });
  assert.deepEqual((await reg.http('GET', '/wiki/runs/a', q(), body(''), trusted)).body, { id: 'a', q: null, by: 'Someone' });
  assert.deepEqual(await reg.http('GET', '/wiki/empty', q(), body(''), trusted), { status: 200, body: {} });
  assert.equal((await reg.http('GET', '/wiki/runs', q(), body(''), trusted)).status, 404);
  assert.equal((await reg.http('OPTIONS', '/wiki/runs/a', q(), body(''), trusted)).status, 405);
  assert.equal((await reg.http('POST', '/wiki/runs/a', q(), body('{}'), { trusted: false })).status, 403, 'a write needs the office’s own page');
  assert.deepEqual(await reg.http('POST', '/wiki/runs/a', q(), body('{"n":1}'), trusted), { status: 200, body: { got: { n: 1 }, again: { n: 1 } } });
  assert.deepEqual((await reg.http('POST', '/wiki/runs/a', q(), body(''), trusted)).body, { got: {}, again: {} });
  assert.deepEqual(await reg.http('POST', '/wiki/runs/a', q(), body('{nope'), trusted), { status: 400, body: { error: 'Send JSON' } });
  const tooBig = async () => {
    throw new Error('too large');
  };
  assert.equal((await reg.http('POST', '/wiki/runs/a', q(), tooBig, trusted)).status, 413);
  assert.deepEqual(await reg.http('DELETE', '/wiki/runs/a', q(), body(''), trusted), { status: 402, body: { error: 'That needs another Factory plan (402).' } });
  assert.deepEqual(await reg.http('PUT', '/wiki/runs/a', q(), body(''), trusted), { status: 400, body: { error: 'name is required' } });
  assert.equal((await reg.http('PATCH', '/wiki/runs/a', q(), body(''), trusted)).status, 502, 'Factory’s 401 is about the key');
  assert.equal(l.rejectedWith?.status, 401);
  const rejected = await reg.http('GET', '/wiki', q(), body(''), trusted);
  assert.equal(rejected.status, 409);
  assert.match((rejected.body as { error: string }).error, /rejected the office’s API key/);
});

test('route helpers', () => {
  assert.deepEqual(matchPath('/:id/metrics', '/abc/metrics'), { id: 'abc' });
  assert.deepEqual(matchPath('', '/'), {});
  assert.equal(matchPath('/:id', '/a/b'), undefined);
  assert.equal(matchPath('/a', '/b'), undefined);
  assert.equal(matchPath('/:id', '/%E0%A4%A'), undefined);
  assert.deepEqual(httpErrorOf(new HttpError(418, 'teapot')), { status: 418, error: 'teapot' });
  assert.deepEqual(httpErrorOf(notFound()), { status: 404, error: 'Not found' });
  assert.equal(httpErrorOf(new FactoryError('t', 0, '', '', undefined, true)).status, 504);
  assert.equal(httpErrorOf(new FactoryError('n', 0)).status, 502);
  assert.equal(httpErrorOf(new FactoryError('x', 503)).status, 502);
  assert.equal(httpErrorOf(new FactoryError('x', 429)).status, 429);
  assert.deepEqual(httpErrorOf(new Error('secret stack')), { status: 500, error: 'Something went wrong talking to Factory.' });
  assert.equal(str('  hi  ', 10), 'hi');
  assert.equal(str(5, 10), '');
  assert.equal(str('abcdef', 3), 'abc');
});
