import test from 'node:test';
import assert from 'node:assert/strict';
import { FactoryApi, FactoryError } from '../src/server/factory/api.js';
import type { FactoryRoute, FeatureHost } from '../src/server/factory/feature.js';
import { HttpError } from '../src/server/factory/feature.js';
import { NEW_SESSION_BACKOFF_MS, NEW_SESSION_MS, alreadyGone, isMissing, isNew, whileNew } from '../src/server/factory/new-session.js';
import { SessionsFeature } from '../src/server/factory/sessions.js';

const KEY = 'fk-test-young-4242';
const T0 = 5_000_000;
const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const missing = () => new FactoryError('Session not found (404)', 404);

/** A call that 404s `misses` times, then answers `ok`; `calls` counts the tries. */
function flaky(misses: number, ok = 'done') {
  const c = {
    calls: 0,
    run: async () => {
      c.calls++;
      if (c.calls <= misses) throw missing();
      return ok;
    },
  };
  return c;
}

/** A clock and a sleep that moves it, so the waits take no time. */
function clock(start = T0) {
  const c = {
    now: start,
    slept: [] as number[],
    opts: () => ({ now: () => c.now, sleep: async (ms: number) => void (c.slept.push(ms), (c.now += ms)) }),
  };
  return c;
}

test('whileNew: a just-made session that 404s is tried again with the backoff until Factory finds it', async () => {
  const c = clock();
  const f = flaky(2);
  assert.equal(await whileNew(T0 - 1000, f.run, c.opts()), 'done');
  assert.equal(f.calls, 3);
  assert.deepEqual(c.slept, NEW_SESSION_BACKOFF_MS.slice(0, 2));
});

test('whileNew: one that never turns up gives the last 404 after every try', async () => {
  const c = clock();
  const f = flaky(99);
  await assert.rejects(whileNew(T0, f.run, c.opts()), (err) => isMissing(err));
  assert.equal(f.calls, NEW_SESSION_BACKOFF_MS.length + 1);
  assert.deepEqual(c.slept, [...NEW_SESSION_BACKOFF_MS]);
  assert.ok(NEW_SESSION_BACKOFF_MS.reduce((a, b) => a + b, 0) <= 15_000, 'the tries are short: someone is waiting on the answer');
});

test('whileNew: its age counts at the first 404, so one made 29 s ago still gets every try', async () => {
  const c = clock();
  const f = flaky(99);
  await assert.rejects(whileNew(T0 - (NEW_SESSION_MS - 1000), f.run, c.opts()));
  assert.equal(f.calls, NEW_SESSION_BACKOFF_MS.length + 1);
});

test('whileNew: an older or unknown session, and every other failure, go through at once', async () => {
  for (const madeAt of [T0 - NEW_SESSION_MS, T0 - 3_600_000, undefined, 0]) {
    const c = clock();
    const f = flaky(1);
    await assert.rejects(whileNew(madeAt, f.run, c.opts()), (err) => isMissing(err));
    assert.equal(f.calls, 1, `made at ${madeAt}`);
    assert.deepEqual(c.slept, []);
  }
  for (const err of [new FactoryError('boom', 500), new FactoryError('nope', 401), new Error('plain')]) {
    const c = clock();
    let calls = 0;
    await assert.rejects(
      whileNew(
        T0,
        async () => {
          calls++;
          throw err;
        },
        c.opts(),
      ),
      (e) => e === err,
    );
    assert.equal(calls, 1);
  }
  // A custom backoff is used as given; an empty one tries once.
  const c = clock();
  const f = flaky(5);
  await assert.rejects(whileNew(T0, f.run, { ...c.opts(), backoff: [] }));
  assert.equal(f.calls, 1);
});

test('whileNew: without a sleep of its own it waits for real', async () => {
  const f = flaky(1);
  const started = Date.now();
  assert.equal(await whileNew(Date.now(), f.run, { backoff: [20] }), 'done');
  assert.ok(Date.now() - started >= 15);
});

test('isNew and alreadyGone: a 404 counts as gone only for a session past its first moments when asked', () => {
  assert.equal(isNew(T0, T0 + NEW_SESSION_MS - 1), true);
  assert.equal(isNew(T0, T0 + NEW_SESSION_MS), false);
  assert.equal(isNew(undefined, T0), false);
  assert.equal(isNew(0, T0), false);
  assert.equal(alreadyGone(missing(), T0 - 3_600_000, T0), true);
  assert.equal(alreadyGone(missing(), undefined, T0), true, 'nothing says it was just made');
  assert.equal(alreadyGone(missing(), T0 - 1000, T0), false);
  assert.equal(alreadyGone(new FactoryError('boom', 500), T0 - 3_600_000, T0), false);
  assert.equal(isMissing(new HttpError(404, 'x')), false, 'only Factory’s own 404');
});

// ---- The Sessions routes that write to a session ----

function host(): FeatureHost & { toasts: string[] } {
  const toasts: string[] = [];
  return { changed: () => {}, pollSoon: () => {}, api: () => undefined, toast: (t) => toasts.push(t), toasts };
}

/** Factory with `misses` 404s for every call on a session before it answers; `seen` is every call. */
function factory(misses: Record<string, number>, answers: Record<string, () => Response>) {
  const seen: string[] = [];
  const left = new Map(Object.entries(misses));
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const at = `${init.method ?? 'GET'} ${url.pathname.replace(/^\/api\/v0/, '')}`;
    seen.push(at);
    const n = left.get(at) ?? 0;
    if (n > 0) {
      left.set(at, n - 1);
      return json(404, { detail: 'Session not found' });
    }
    const a = answers[at];
    return a ? a() : json(404, { detail: 'Session not found' });
  }) as typeof fetch;
  return { api: new FactoryApi(KEY, fn), seen, count: (at: string) => seen.filter((s) => s === at).length };
}

const route = (f: SessionsFeature, method: string, p: string) => f.routes.find((r) => r.method === method && r.path === p) as FactoryRoute;
const call = (r: FactoryRoute, req: Record<string, unknown>) => Promise.resolve(r.handle({ params: {}, query: new URLSearchParams(), json: async () => ({}), by: 'Olive', ...req } as never));
const made = (id: string, createdAt: number) => ({ sessionId: id, title: '', status: 'idle', createdAt, updatedAt: createdAt, messageCount: 0, computerId: 'orb' });

test('sessions: a session made here moments ago is changed, messaged, interrupted, read and deleted through its first 404s', async () => {
  const c = clock();
  const f = factory(
    { 'POST /sessions/s1/messages': 1, 'PATCH /sessions/s1': 2, 'POST /sessions/s1/interrupt': 1, 'GET /sessions/s1': 1, 'DELETE /sessions/s1': 2 },
    {
      // Factory's createdAt is when it started making it, long before it answered.
      'POST /sessions': () => json(201, made('s1', T0 - 3_600_000)),
      'POST /sessions/s1/messages': () => json(200, { messageId: 'm1', status: 'running' }),
      'PATCH /sessions/s1': () => json(200, { ...made('s1', T0), sessionSettings: { model: 'gpt-y' } }),
      'POST /sessions/s1/interrupt': () => json(200, { status: 'idle' }),
      'GET /sessions/s1': () => json(200, { ...made('s1', T0), factoryCredits: 12 }),
      'DELETE /sessions/s1': () => json(204, null),
    },
  );
  const { now, sleep } = c.opts();
  const feature = new SessionsFeature(host(), { now, retry: { sleep } });
  const first = (await call(route(feature, 'POST', ''), { api: f.api, json: async () => ({ computerId: 'orb', prompt: 'say hi' }) })) as { messageId?: string; error?: string };
  assert.equal(first.error, undefined, 'its first message went through its first 404');
  assert.equal(first.messageId, 'm1');
  assert.equal(feature.madeAt('s1'), T0, 'when the office made it, by its own clock');

  const patched = (await call(route(feature, 'PATCH', '/:id'), { api: f.api, params: { id: 's1' }, json: async () => ({ model: 'gpt-y' }) })) as { session: { model?: string } };
  assert.equal(patched.session.model, 'gpt-y');
  assert.equal(f.count('PATCH /sessions/s1'), 3);
  assert.deepEqual(await call(route(feature, 'POST', '/:id/interrupt'), { api: f.api, params: { id: 's1' } }), { status: 'idle' });
  assert.equal(f.count('POST /sessions/s1/interrupt'), 2);
  const detail = (await call(route(feature, 'GET', '/:id'), { api: f.api, params: { id: 's1' } })) as { credits?: number };
  assert.equal(detail.credits, 12);
  assert.deepEqual(await call(route(feature, 'DELETE', '/:id'), { api: f.api, params: { id: 's1' } }), { ok: true });
  assert.equal(f.count('DELETE /sessions/s1'), 3);
  assert.ok(c.slept.length >= 7, 'each 404 waited before the next try');
});

test('sessions: deleting an old session Factory can’t find counts as gone; a just-made one that never turns up says so', async () => {
  const c = clock();
  const { now, sleep } = c.opts();
  const f = factory({}, { 'GET /sessions': () => json(200, { sessions: [made('old', T0 - 3_600_000)] }) });
  const h = host();
  const feature = new SessionsFeature(h, {
    now,
    retry: { sleep },
    officeSessions: () => [{ sessionId: 'cloudy', workerId: 'w1', name: 'Ada', createdAt: T0 - 2000 }],
  });
  await feature.poll(f.api);

  assert.deepEqual(await call(route(feature, 'DELETE', '/:id'), { api: f.api, params: { id: 'old' } }), { ok: true });
  assert.equal(f.count('DELETE /sessions/old'), 1, 'asked once');
  assert.deepEqual(c.slept, []);
  assert.match(h.toasts.at(-1) ?? '', /deleted/);

  // A cloud droid's session, made when the droid was: Factory hasn't caught up.
  await assert.rejects(
    () => call(route(feature, 'DELETE', '/:id'), { api: f.api, params: { id: 'cloudy' } }),
    (err) => err instanceof HttpError && err.status === 409 && /only just made/.test(err.message),
  );
  assert.equal(f.count('DELETE /sessions/cloudy'), NEW_SESSION_BACKOFF_MS.length + 1);

  // Changing or interrupting an old one that's gone is a plain 404, at once.
  const before = c.slept.length;
  await assert.rejects(
    () => call(route(feature, 'PATCH', '/:id'), { api: f.api, params: { id: 'old' }, json: async () => ({ model: 'x' }) }),
    (err) => isMissing(err),
  );
  await assert.rejects(
    () => call(route(feature, 'POST', '/:id/interrupt'), { api: f.api, params: { id: 'old' } }),
    (err) => isMissing(err),
  );
  assert.equal(c.slept.length, before);
});
