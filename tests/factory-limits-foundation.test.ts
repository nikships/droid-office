import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FactoryApi, type FactoryError } from '../src/server/factory/api.js';
import { SliceFeature, type FeatureHost } from '../src/server/factory/feature.js';
import { mountFactory } from '../src/server/factory/index.js';
import { LIMITS_RECHECK_MS, LimitsFeature, limitsOf } from '../src/server/factory/limits.js';
import { FactoryRegistry } from '../src/server/factory/registry.js';
import { emptySessions } from '../src/shared/factory-sessions.js';
import { emptyLimits } from '../src/shared/factory-limits.js';
import { emptyFactoryState, type FactoryConnection } from '../src/shared/factory.js';
import { createOwnerOffice } from '../src/server/server-runtime/owner.js';
import { ORCHESTRATOR_ID } from '../src/shared/mission-control.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const KEY = 'fk-test-limits-1234';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
// Trimmed from the owner's DOFF-930 capture. Usage variants below exercise quota boundaries.
function capture() {
  return {
    usesTokenRateLimitsBilling: true,
    hasActiveSubscription: true,
    limits: {
      standard: {
        fiveHour: { usedPercent: 61, windowEnd: '2026-11-14T06:06:30.724Z', secondsRemaining: 1251 },
        weekly: { usedPercent: 86, windowEnd: '2026-11-14T19:35:51.947Z', secondsRemaining: 49812 },
        monthly: { usedPercent: 56, windowEnd: '2026-12-01T05:59:57.602Z', secondsRemaining: 1469657 },
      },
      core: {
        fiveHour: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
        weekly: { usedPercent: 20, windowEnd: '2026-11-17T03:30:49.318Z', secondsRemaining: 251109 },
        monthly: { usedPercent: 15, windowEnd: '2026-12-10T03:30:49.318Z', secondsRemaining: 2238309 },
      },
    },
    overagePreference: 'droidCore',
    canManageOverage: true,
    extraUsageBalanceCents: 0,
    extraUsageAllowed: true,
  };
}

function host() {
  const h = {
    changed: () => {},
    pollSoon: () => {
      h.refreshes++;
    },
    api: () => undefined,
    toast: () => {},
    refreshes: 0,
  } satisfies FeatureHost & { refreshes: number };
  return h;
}

test('non-v0 requests share Bearer auth, redirect refusal, JSON and one GET retry; never retry writes', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let fail = true;
  const api = new FactoryApi(KEY, (async (url, init) => {
    calls.push({ url: String(url), init: init! });
    if (fail) {
      fail = false;
      throw new Error(`network ${KEY}`);
    }
    return json(200, capture());
  }) as typeof fetch);
  assert.deepEqual(await api.limits(), capture());
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.factory.ai/api/billing/limits');
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].init.redirect, 'error');
  await api.setOveragePreference('droidCore');
  assert.equal(calls.at(-1)!.url, 'https://api.factory.ai/api/organization/subscription/set-overage-preference');
  assert.equal(calls.at(-1)!.init.method, 'POST');
  assert.equal(calls.at(-1)!.init.body, '{"overagePreference":"droidCore"}');
  assert.equal((calls.at(-1)!.init.headers as Record<string, string>)['content-type'], 'application/json');
  fail = true;
  await assert.rejects(api.setOveragePreference('extraUsage'), (err: Error) => !err.message.includes(KEY));
  assert.equal(calls.length, 4);
  await assert.rejects(api.requestApi('GET', 'https://other.test/api/limits'), /Factory \/api/);
});

test('non-v0 timeouts retry reads and API errors redact keys with unchanged HTTP status', async () => {
  let calls = 0;
  const timeoutApi = new FactoryApi(KEY, (async (_url, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
  }) as typeof fetch);
  await assert.rejects(timeoutApi.requestApi('GET', '/api/billing/limits', { timeoutMs: 5 }), (err: FactoryError) => err.timedOut && err.status === 0);
  assert.equal(calls, 2);
  const api = new FactoryApi(KEY, (async () => json(401, { title: KEY, detail: `bad ${KEY}` })) as typeof fetch);
  await assert.rejects(api.limits(), (err: FactoryError) => err.status === 401 && !JSON.stringify([err.message, err.title, err.detail]).includes(KEY));
});

test('billing normalization retains raw windows/nulls; Enterprise and malformed reads are distinct', () => {
  assert.deepEqual(limitsOf(capture(), 42), { ...capture(), fetchedAt: 42, error: null });
  const enterprise = limitsOf({ usesTokenRateLimitsBilling: false, hasActiveSubscription: true }, 42);
  assert.deepEqual(enterprise.limits, {});
  for (const raw of [null, [], {}, { ...capture(), limits: { standard: {} } }, { ...capture(), overagePreference: 'paid' }]) assert.throws(() => limitsOf(raw, 42), /Factory returned/);
  const invalid = capture();
  invalid.limits.standard.fiveHour.usedPercent = NaN;
  assert.throws(() => limitsOf(invalid, 42), /unreadable/);
});

test('the limits poller is 60s normally, 20s watched or with hosted workers; failure preserves cached data', async (t) => {
  let busy = false;
  const api = new FactoryApi(KEY, (async () => json(200, capture())) as typeof fetch);
  const reg = new FactoryRegistry({ link: { connection: () => ({ connected: true, capabilities: [] }), client: () => api, rejected: () => {} }, broadcast: () => {}, toast: () => {} });
  t.after(() => reg.stop());
  const feature = reg.register((h) => new LimitsFeature(h, { hostedWorkers: () => busy, now: () => 42 }));
  assert.equal(reg.intervalOf('limits'), 60_000);
  reg.watch('window', 'limits', true);
  await reg.recheck('limits');
  assert.equal(reg.intervalOf('limits'), 20_000);
  reg.drop('window');
  busy = true;
  assert.equal(reg.intervalOf('limits'), 20_000);
  feature.failed(new Error('read failed'));
  assert.equal(feature.state().limits.standard!.fiveHour.usedPercent, 61);
  assert.equal(feature.state().error, 'read failed');
  feature.reset();
  assert.deepEqual(feature.state(), emptyLimits());
});

test('simultaneous rechecks coalesce with polling and never wait for cold sessions', async (t) => {
  const limits = deferred<Response>();
  const sessions = deferred<void>();
  const started = deferred<void>();
  let calls = 0;
  const api = new FactoryApi(KEY, (async () => {
    calls++;
    started.resolve();
    return limits.promise;
  }) as typeof fetch);
  const reg = new FactoryRegistry({ link: { connection: () => ({ connected: true, capabilities: [] }), client: () => api, rejected: () => {} }, broadcast: () => {}, toast: () => {} });
  t.after(() => reg.stop());
  class SlowSessions extends SliceFeature<'sessions'> {
    readonly interval = 60_000;
    readonly fastInterval = 20_000;
    constructor(h: FeatureHost) {
      super('sessions', h, emptySessions);
    }
    async poll() {
      await sessions.promise;
    }
  }
  reg.register((h) => new SlowSessions(h));
  reg.register((h) => new LimitsFeature(h));
  const tick = reg.tick();
  await started.promise;
  const first = reg.recheck('limits');
  const second = reg.recheck('limits');
  let tickDone = false;
  void tick.then(() => {
    tickDone = true;
  });
  limits.resolve(json(200, capture()));
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(tickDone, false, 'limits completed without waiting for sessions');
  sessions.resolve();
  await tick;
});

test('on-demand limits recheck does not start unrelated due pollers', async (t) => {
  const api = new FactoryApi(KEY, (async () => json(200, capture())) as typeof fetch);
  const reg = new FactoryRegistry({ link: { connection: () => ({ connected: true, capabilities: [] }), client: () => api, rejected: () => {} }, broadcast: () => {}, toast: () => {} });
  t.after(() => reg.stop());
  let sessions = 0;
  class Sessions extends SliceFeature<'sessions'> {
    readonly interval = 60_000;
    readonly fastInterval = 20_000;
    constructor(h: FeatureHost) {
      super('sessions', h, emptySessions);
    }
    async poll() {
      sessions++;
    }
  }
  reg.register((h) => new Sessions(h));
  reg.register((h) => new LimitsFeature(h));
  await Promise.all([reg.recheck('limits'), reg.recheck('limits')]);
  assert.equal(sessions, 0);
});

test('overage requires a trusted office/paired-device request and manager permission, validates JSON, then refreshes', async (t) => {
  const calls: string[] = [];
  let writable = true;
  const api = new FactoryApi(KEY, (async (url, init) => {
    calls.push(`${init!.method} ${new URL(String(url)).pathname}`);
    return json(200, { ...capture(), canManageOverage: writable });
  }) as typeof fetch);
  const reg = new FactoryRegistry({ link: { connection: () => ({ connected: true, capabilities: [] }), client: () => api, rejected: () => {} }, broadcast: () => {}, toast: () => {} });
  t.after(() => reg.stop());
  reg.register((h) => new LimitsFeature(h));
  await reg.recheck('limits');
  const request = (body: string, trusted = true) => reg.http('POST', '/limits/overage', new URLSearchParams(), async () => body, { trusted });
  assert.equal((await request('{"overagePreference":"extraUsage"}', false)).status, 403);
  assert.equal((await request('no json')).status, 400);
  for (const body of ['null', '{}', '{"overagePreference":"paid"}', '{"overagePreference":null}']) assert.equal((await request(body)).status, 400);
  writable = false;
  await reg.recheck('limits');
  assert.equal((await request('{"overagePreference":"extraUsage"}')).status, 403);
  assert.ok(calls.every((s) => s.startsWith('GET')));
  writable = true;
  await reg.recheck('limits');
  assert.equal((await request('{"overagePreference":"droidCore"}')).status, 200);
  await reg.recheck('limits');
  assert.equal(calls.filter((s) => s === 'POST /api/organization/subscription/set-overage-preference').length, 1);
  assert.ok(calls.at(-1)!.startsWith('GET'));
});

test('limits 401 rejects the shared key, blocks writes and stops reads', async (t) => {
  let rejected = false;
  const conn = (): FactoryConnection => ({ connected: true, capabilities: [], ...(rejected ? { rejected: '401' } : {}) });
  const api = new FactoryApi(KEY, (async () => json(401, { detail: `bad ${KEY}` })) as typeof fetch);
  const reg = new FactoryRegistry({
    link: {
      connection: conn,
      client: () => (rejected ? undefined : api),
      rejected: () => {
        rejected = true;
      },
    },
    broadcast: () => {},
    toast: () => {},
  });
  t.after(() => reg.stop());
  const feature = reg.register((h) => new LimitsFeature(h));
  await reg.recheck('limits');
  assert.ok(rejected);
  assert.ok(!feature.state().error!.includes(KEY));
  assert.equal((await reg.http('POST', '/limits/overage', new URLSearchParams(), async () => '{}', { trusted: true })).status, 409);
  await reg.recheck('limits');
});

test('reset during an in-flight limits read discards the old answer', async () => {
  const answer = deferred<Response>();
  const feature = new LimitsFeature(host());
  const api = new FactoryApi(KEY, (async () => answer.promise) as typeof fetch);
  const polling = feature.poll(api);
  feature.reset();
  answer.resolve(json(200, capture()));
  await polling;
  assert.deepEqual(feature.state(), emptyLimits());
});

test('mounted limits rechecks throttle failures and coalesce, and Airgap resets/refuses without losing the key', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'factory-limits-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'factory.json'), JSON.stringify({ key: KEY, by: 'Test', at: 1, capabilities: [] }));
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  let fail = false;
  let pending: ReturnType<typeof deferred<Response>> | undefined;
  const mount = mountFactory({
    dataDir: dir,
    broadcast: () => {},
    toast: () => {},
    fetchImpl: (async (url) => {
      if (new URL(String(url)).pathname !== '/api/billing/limits') return json(200, {});
      calls++;
      if (pending) return pending.promise;
      return fail ? json(500, { detail: 'temporary' }) : json(200, capture());
    }) as typeof fetch,
  });
  t.after(() => mount.stop());
  await mount.office.check();
  pending = deferred<Response>();
  const first = mount.recheckLimits();
  const second = mount.recheckLimits();
  assert.equal(calls, 1);
  pending.resolve(json(200, capture()));
  await Promise.all([first, second]);
  pending = undefined;
  await mount.recheckLimits();
  assert.equal(calls, 1);
  now += LIMITS_RECHECK_MS;
  fail = true;
  await mount.recheckLimits();
  assert.equal(calls, 2);
  assert.match(mount.state().limits.error!, /temporary/);
  await mount.recheckLimits();
  assert.equal(calls, 2, 'failed attempts are throttled too');
  mount.setPaused(true);
  assert.deepEqual(mount.state(), emptyFactoryState());
  assert.deepEqual(mount.registry.state().limits, emptyLimits());
  const response = await mount.registry.http('POST', '/limits/overage', new URLSearchParams(), async () => '{"overagePreference":"extraUsage"}', { trusted: true });
  assert.equal(response.status, 403);
  assert.match((response.body as { error: string }).error, /airgapped/i);
  await mount.recheckLimits();
  assert.equal(calls, 2);
  mount.setPaused(false);
  fail = false;
  await mount.recheckLimits();
  assert.equal(calls, 3);
  assert.equal(mount.state().limits.error, null);
  assert.ok(mount.state().connection.connected);
});

test('Orchestrator inspection rechecks hosted settled 402/rate-limit failures as well as active retries', async () => {
  const worker = { id: ORCHESTRATOR_ID, kind: 'agent', name: 'Orchestrator', model: 'auto', status: 'done', deskId: '', createdAt: 1 } as WorkerInfo;
  let screenRows = ['Usage is exhausted for the model request.'];
  let currentTool: unknown;
  let rechecks = 0;
  const factory = emptyFactoryState();
  factory.connection.connected = true;
  factory.limits = limitsOf(capture(), Date.now());
  const owner = createOwnerOffice({
    floors: new Map(),
    orchestrator: { workers: { get: () => worker, runtime: () => ({ screenRows, currentTool }) } },
    factory: {
      state: () => factory,
      recheckLimits: async () => {
        rechecks++;
      },
    },
    subscriptions: { availability: () => undefined, usage: () => undefined },
    labelPreferences: { get: () => ({ on: false }) },
  } as unknown as Parameters<typeof createOwnerOffice>[0]);
  for (const status of ['done', 'idle', 'working'] as const) {
    worker.status = status;
    await owner.inspect!(ORCHESTRATOR_ID);
  }
  assert.equal(rechecks, 3);
  screenRows = ['The model provider rate limited the request.'];
  await owner.inspect!(ORCHESTRATOR_ID);
  assert.equal(rechecks, 4);
  screenRows = ['Retrying the model request (attempt 2/5)...'];
  await owner.inspect!(ORCHESTRATOR_ID);
  assert.equal(rechecks, 5);
  currentTool = { name: 'Execute' };
  await owner.inspect!(ORCHESTRATOR_ID);
  assert.equal(rechecks, 5, 'a running tool is not a model retry');
  currentTool = undefined;
  worker.model = 'custom:droidproxy:gpt-6.1-sol';
  await owner.inspect!(ORCHESTRATOR_ID);
  assert.equal(rechecks, 5, 'custom models never recheck Factory billing');
});
