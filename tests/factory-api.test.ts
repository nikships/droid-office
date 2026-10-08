import test from 'node:test';
import assert from 'node:assert/strict';
import { FactoryApi, FactoryError, fingerprint } from '../src/server/factory/api.js';

const KEY = 'fk-test-0123456789abcdef';

interface Call {
  url: URL;
  init: RequestInit;
}

/** A fetch that answers with `answer(call, n)`; `n` counts calls from 1. */
function fakeFetch(answer: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: new URL(String(input)), init };
    calls.push(call);
    return answer(call, calls.length);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fetch that never answers until its signal aborts. */
const hang = (call: Call) =>
  new Promise<Response>((_, reject) => {
    call.init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  });

test('a GET goes to /api/v0 with the key as a Bearer, its query and JSON back', async () => {
  const { fn, calls } = fakeFetch(() => json(200, { sessions: [{ sessionId: 'a' }] }));
  const api = new FactoryApi(KEY, fn, 'https://factory.test');
  const r = await api.sessions(500, 'next');
  assert.deepEqual(r, { sessions: [{ sessionId: 'a' }] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, 'https://factory.test');
  assert.equal(calls[0].url.pathname, '/api/v0/sessions');
  assert.equal(calls[0].url.searchParams.get('limit'), '100', 'limit is capped at 100');
  assert.equal(calls[0].url.searchParams.get('cursor'), 'next');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${KEY}`);
  assert.equal(headers.accept, 'application/json');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
});

test('a POST sends JSON, and undefined query values are left out', async () => {
  const { fn, calls } = fakeFetch(() => json(200, { ok: true }));
  const api = new FactoryApi(KEY, fn);
  await api.post('/computers', { name: 'orb' }, { query: { a: 1, b: undefined, c: true } });
  assert.equal(calls[0].url.href, 'https://api.factory.ai/api/v0/computers?a=1&c=true');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, JSON.stringify({ name: 'orb' }));
  assert.equal((calls[0].init.headers as Record<string, string>)['content-type'], 'application/json');
  await api.patch('/computers/x', { name: 'y' });
  await api.delete('/computers/x');
  assert.deepEqual(
    calls.map((c) => c.init.method),
    ['POST', 'PATCH', 'DELETE'],
  );
});

test('an empty 2xx body is undefined', async () => {
  const { fn } = fakeFetch(() => new Response(null, { status: 204 }));
  assert.equal(await new FactoryApi(KEY, fn).delete('/sessions/a'), undefined);
});

test('errors carry the API’s status, title and detail, and never the key', async () => {
  const cases: [number, RegExp][] = [
    [401, /didn't accept the API key \(401\)/],
    [402, /needs another Factory plan \(402\)/],
    [403, /isn't allowed to do that \(403\)/],
    [404, /\(404\)/],
    [500, /\(500\)/],
  ];
  for (const [status, message] of cases) {
    const { fn } = fakeFetch(() => json(status, { status, title: `Title ${KEY}`, detail: `Nope for ${KEY}` }));
    const err = await new FactoryApi(KEY, fn).get('/wiki').catch((e) => e);
    assert.ok(err instanceof FactoryError);
    assert.equal(err.status, status);
    assert.match(err.message, message);
    assert.ok(!err.message.includes(KEY), `${status} message has no key`);
    assert.ok(!err.detail.includes(KEY) && !err.title.includes(KEY));
    assert.match(err.detail, /Nope for \[redacted\]/);
  }
});

test("a validation 400's first errors[].message is the reason when there's no detail", async () => {
  const { fn } = fakeFetch(() => json(400, { status: 400, title: 'Invalid request body', errors: [{ message: 'model: unknown id' }, { message: 'also this' }] }));
  const err = await new FactoryApi(KEY, fn).post('/sessions', {}).catch((e) => e);
  assert.ok(err instanceof FactoryError);
  assert.equal(err.detail, 'model: unknown id');
  assert.match(err.message, /model: unknown id \(400\)/);
  // A real detail still wins over errors[].
  const { fn: fn2 } = fakeFetch(() => json(400, { detail: 'the real reason', errors: [{ message: 'secondary' }] }));
  const err2 = await new FactoryApi(KEY, fn2).post('/sessions', {}).catch((e) => e);
  assert.equal(err2.detail, 'the real reason');
});

test('a non-JSON error still says what status it was', async () => {
  const { fn } = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
  const err = await new FactoryApi(KEY, fn).get('/wiki').catch((e) => e);
  assert.equal(err.status, 502);
  assert.equal(err.message, 'Factory answered 502.');
});

test('a 429 says when to come back', async () => {
  const { fn } = fakeFetch(() => json(429, { detail: 'slow down' }, { 'retry-after': '120' }));
  const err = await new FactoryApi(KEY, fn).get('/wiki').catch((e) => e);
  assert.equal(err.status, 429);
  assert.equal(err.retryAfter, 120);
  const { fn: noAfter } = fakeFetch(() => json(429, {}));
  assert.equal((await new FactoryApi(KEY, noAfter).get('/wiki').catch((e) => e)).retryAfter, undefined);
});

test('a GET that times out is tried once more, then fails as a timeout', async () => {
  const { fn, calls } = fakeFetch(hang);
  const err = await new FactoryApi(KEY, fn).get('/computers', undefined, { timeoutMs: 20 }).catch((e) => e);
  assert.ok(err instanceof FactoryError);
  assert.equal(err.status, 0);
  assert.equal(err.timedOut, true);
  assert.match(err.message, /did not answer within 0s/);
  assert.equal(calls.length, 2);
});

test('a GET that times out once and then answers succeeds', async () => {
  const { fn, calls } = fakeFetch((call, n) => (n === 1 ? hang(call) : json(200, { computers: [] })));
  assert.deepEqual(await new FactoryApi(KEY, fn).get('/computers', undefined, { timeoutMs: 20 }), { computers: [] });
  assert.equal(calls.length, 2);
});

test('a network error is retried for a GET, but never for a write, and the message has no key', async () => {
  const boom = () => {
    throw Object.assign(new TypeError(`fetch failed for ${KEY}`), { cause: { code: 'ECONNREFUSED' } });
  };
  const get = fakeFetch(boom);
  const err = await new FactoryApi(KEY, get.fn).get('/wiki').catch((e) => e);
  assert.equal(err.status, 0);
  assert.equal(err.timedOut, false);
  assert.match(err.message, /ECONNREFUSED/);
  assert.equal(get.calls.length, 2);
  const post = fakeFetch(boom);
  await new FactoryApi(KEY, post.fn).post('/wiki', {}).catch(() => {});
  assert.equal(post.calls.length, 1);
  const noRetry = fakeFetch(boom);
  await new FactoryApi(KEY, noRetry.fn).get('/wiki', undefined, { retry: false }).catch(() => {});
  assert.equal(noRetry.calls.length, 1);
  const leaky = fakeFetch(() => {
    throw new TypeError(`bad ${KEY}`);
  });
  const e2 = await new FactoryApi(KEY, leaky.fn).get('/wiki').catch((e) => e);
  assert.ok(!e2.message.includes(KEY));
});

test('an HTTP error is not retried', async () => {
  const { fn, calls } = fakeFetch(() => json(500, { detail: 'down' }));
  await new FactoryApi(KEY, fn).get('/wiki').catch(() => {});
  assert.equal(calls.length, 1);
});

test('the typed reads hit the right paths', async () => {
  const { fn, calls } = fakeFetch(() => json(200, {}));
  const api = new FactoryApi(KEY, fn);
  await api.providers();
  await api.computers();
  await api.metrics('a b', new Date('2026-10-07T00:00:00Z'));
  await api.metrics('c');
  await api.ciOwners();
  await api.ciScan();
  await api.ciRuns();
  await api.wikiRuns();
  await api.users();
  await api.serviceAccounts();
  assert.deepEqual(
    calls.map((c) => c.url.pathname + c.url.search),
    [
      '/api/v0/computers/providers',
      '/api/v0/computers',
      '/api/v0/computers/a%20b/metrics?start=2026-10-07T00%3A00%3A00.000Z',
      '/api/v0/computers/c/metrics',
      '/api/v0/automations/ci/repository-owners',
      '/api/v0/automations/ci/scan',
      '/api/v0/automations/ci/runs',
      '/api/v0/wiki',
      '/api/v0/organization/users?limit=100',
      '/api/v0/service-accounts',
    ],
  );
});

test('the fingerprint is the fk- prefix and the last four', () => {
  assert.equal(fingerprint(KEY), 'fk-…cdef');
  assert.equal(fingerprint('  sk-other-1234  '), '…1234');
});
