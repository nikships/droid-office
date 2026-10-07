import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FactoryApi } from '../src/server/factory/api.js';
import { ComputersFeature } from '../src/server/factory/computers.js';
import type { FeatureHost } from '../src/server/factory/feature.js';
import { mountFactory } from '../src/server/factory/index.js';
import { SessionsFeature } from '../src/server/factory/sessions.js';
import { WikiFeature } from '../src/server/factory/wiki.js';
import { computerOf, metricOf, metricsOf, METRICS_HISTORY } from '../src/shared/factory-computers.js';
import { ciRunOf, workflowOf } from '../src/shared/factory-ci.js';
import { SESSION_TITLE_MAX, sessionOf } from '../src/shared/factory-sessions.js';
import { wikiRunOf } from '../src/shared/factory-wiki.js';
import { isFactoryFeature, type FactoryState } from '../src/shared/factory.js';
import type { ServerMsg } from '../src/shared/protocol.js';

const KEY = 'fk-test-features-1234';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Factory as the features see it, an answer per path; `seen` lists what was asked. */
function factory(routes: Record<string, Handler>) {
  const seen: string[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    seen.push(url.pathname + url.search);
    const r = routes[url.pathname];
    return r ? r(url, init) : json(404, { detail: `no ${url.pathname}` });
  }) as typeof fetch;
  return { api: new FactoryApi(KEY, fn), fn, seen };
}

function host() {
  let changes = 0;
  const h: FeatureHost & { changes: () => number } = {
    changed: () => changes++,
    pollSoon: () => {},
    api: () => undefined,
    toast: () => {},
    changes: () => changes,
  };
  return h;
}

const sample = (iso: string, cpu: number) => ({ timestamp: iso, cpuUsedPct: cpu, cpuCount: 4, memUsed: 5e8, memTotal: 8e9, diskUsed: 9e9, diskTotal: 5.6e10 });

const COMPUTERS = {
  computers: [
    {
      id: 'orb-id',
      name: 'orb',
      providerType: 'e2b',
      status: 'active',
      createdAt: 1791043801861,
      provisioningSteps: [{ id: 'create-computer', name: 'Creating computer', status: 'completed', startedAt: 1, completedAt: 2 }, { bogus: true }],
      relayClientUrl: 'wss://relay.example/client',
      computerIdentity: { publicKey: 'secret-ish' },
      remoteUser: 'factory-user',
      ownerPrincipalKind: 'human',
      ownerId: 'user_1',
    },
    { id: 'mac-id', name: 'macbook', providerType: 'byom', status: 'active', createdAt: 1790895059911 },
    { name: 'no id' },
  ],
};

test('computers: the list, providers and each managed computer’s metrics, read again only once they’re stale', async () => {
  let now = Date.parse('2026-10-07T12:00:00Z');
  let metricsFail = false;
  const f = factory({
    '/api/v0/computers': () => json(200, COMPUTERS),
    '/api/v0/computers/providers': () => json(200, { providers: ['e2b', 7] }),
    '/api/v0/computers/orb-id/metrics': () => (metricsFail ? json(503, { detail: 'metrics down' }) : json(200, [sample('2026-10-07T11:55:00Z', 20), sample('2026-10-07T11:50:00Z', 10)])),
    '/api/v0/computers/mac-id/metrics': () => json(400, { detail: 'Metrics are not supported for BYOM computers' }),
  });
  const h = host();
  const feature = new ComputersFeature(h, () => now);
  assert.equal(feature.key, 'computers');
  await feature.poll(f.api);
  const s = feature.state();
  assert.deepEqual(
    s.items.map((c) => [c.name, c.managed]),
    [
      ['orb', true],
      ['macbook', false],
    ],
  );
  assert.ok(!JSON.stringify(s).includes('relay.example'), 'no relay URLs or keys in the slice');
  assert.deepEqual(s.items[0].provisioningSteps, [{ id: 'create-computer', name: 'Creating computer', status: 'completed', startedAt: 1, completedAt: 2 }]);
  assert.deepEqual(s.providers, ['e2b']);
  assert.deepEqual(Object.keys(s.metrics), ['orb-id'], 'only managed computers have metrics');
  assert.equal(s.metrics['orb-id'].latest?.cpuPct, 20);
  assert.deepEqual(
    s.metrics['orb-id'].history.map((m) => m.cpuPct),
    [10, 20],
  );
  assert.equal(s.fetchedAt, now);
  assert.ok(!f.seen.some((p) => p.includes('mac-id')), 'BYOM metrics are never asked for');
  assert.match(f.seen.find((p) => p.includes('orb-id')) ?? '', /start=2026-10-07T10%3A00%3A00/);
  assert.ok(h.changes() >= 1);
  assert.ok(!feature.busy());

  const asked = f.seen.length;
  now += 60_000;
  await feature.poll(f.api);
  assert.deepEqual(f.seen.slice(asked), ['/api/v0/computers'], 'metrics and providers are still fresh');

  now += 3 * 60_000;
  metricsFail = true;
  await feature.poll(f.api);
  const m = feature.state().metrics['orb-id'];
  assert.equal(m.latest?.cpuPct, 20, 'a failed read keeps the last samples');
  assert.match(m.error ?? '', /metrics down/);

  const route = feature.routes.find((r) => r.path === '/:id/metrics')!;
  metricsFail = false;
  const answer = (await route.handle({ api: f.api, params: { id: 'orb-id' }, query: new URLSearchParams('hours=48') } as never)) as { samples: unknown[] };
  assert.equal(answer.samples.length, 2);
  await assert.rejects(() => Promise.resolve(route.handle({ api: f.api, params: { id: 'orb-id' }, query: new URLSearchParams('hours=500') } as never)), /hours is 1 to 96/);

  const provisioning = factory({ '/api/v0/computers': () => json(200, { computers: [{ id: 'n', name: 'new', providerType: 'e2b', status: 'provisioning', createdAt: 1 }] }), '/api/v0/computers/n/metrics': () => json(200, []) });
  await feature.poll(provisioning.api);
  assert.ok(feature.busy(), 'a computer provisioning polls fast');
  assert.equal(feature.state().metrics.n.latest, undefined, 'an asleep computer has no latest sample');
  feature.reset();
  assert.deepEqual(feature.state().items, []);
});

test('sessions: the newest page, with titles cut, and the detail route with credits', async () => {
  const long = 'x'.repeat(500);
  const f = factory({
    '/api/v0/sessions': () =>
      json(200, {
        sessions: [
          {
            sessionId: 's1',
            title: long,
            status: 'running',
            messageCount: 3,
            createdAt: 1,
            updatedAt: 2,
            computerId: 'orb-id',
            sessionSettings: { model: 'opus', reasoningEffort: 'high' },
            artifacts: [{ id: 'pr', url: 'https://github.com/o/r/pull/1', kind: 'pull_request', action: 'create', externalId: 'o/r#1' }, {}],
          },
          { sessionId: 's2', title: 'Local', status: 'running', parent_session_id: 's1' },
          { title: 'no id' },
        ],
        pagination: { hasMore: true, nextCursor: 'c' },
      }),
    '/api/v0/sessions/s1': () => json(200, { sessionId: 's1', title: 'One', status: 'idle', factoryCredits: 841059 }),
    '/api/v0/sessions/nope': () => json(200, {}),
  });
  const feature = new SessionsFeature(host(), () => 42);
  await feature.poll(f.api);
  assert.match(f.seen[0], /limit=50/);
  const s = feature.state();
  assert.equal(s.items.length, 2);
  assert.equal(s.hasMore, true);
  assert.equal(s.fetchedAt, 42);
  assert.equal(s.items[0].title.length, SESSION_TITLE_MAX);
  assert.equal(s.items[0].model, 'opus');
  assert.equal(s.items[0].effort, 'high');
  assert.deepEqual(s.items[0].artifacts, [{ id: 'pr', kind: 'pull_request', url: 'https://github.com/o/r/pull/1', action: 'create', externalId: 'o/r#1' }]);
  assert.equal(s.items[1].parentId, 's1');
  assert.ok(feature.busy(), 'a session running on a Factory computer');
  const detail = feature.routes[0];
  assert.deepEqual(await detail.handle({ api: f.api, params: { id: 's1' } } as never), { session: sessionOf({ sessionId: 's1', title: 'One', status: 'idle' }), credits: 841059 });
  await assert.rejects(() => Promise.resolve(detail.handle({ api: f.api, params: { id: 'nope' } } as never)), /No such session/);
});

// CI automations have their own file: tests/factory-ci.test.ts.

test('wiki: the runs, and whether a repository may get one', async () => {
  const f = factory({
    '/api/v0/wiki': () => json(200, { wikiRuns: [{ wikiRunId: 'w1', repoUrl: 'https://github.com/o/r', status: 'completed', createdAt: '2026-10-01T00:00:00Z', completedAt: 5 }, { nope: 1 }] }),
    '/api/v0/wiki/upload-access': (url) => json(200, { allowed: url.searchParams.get('repoUrl') === 'https://github.com/o/r' }),
  });
  const feature = new WikiFeature(host(), () => 3);
  await feature.poll(f.api);
  const s = feature.state();
  assert.equal(s.runs.length, 1);
  assert.equal(s.runs[0].id, 'w1');
  assert.equal(s.runs[0].createdAt, Date.parse('2026-10-01T00:00:00Z'));
  assert.equal(s.runs[0].updatedAt, 5);
  assert.equal(s.fetchedAt, 3);
  const route = feature.routes[0];
  assert.deepEqual(await route.handle({ api: f.api, query: new URLSearchParams('repoUrl=https://github.com/o/r') } as never), { allowed: true });
  await assert.rejects(() => Promise.resolve(route.handle({ api: f.api, query: new URLSearchParams() } as never)), /Say which repository/);
});

test('the shared shapes skip what isn’t there', () => {
  assert.equal(computerOf(null), undefined);
  assert.equal(computerOf({ name: 'x' }), undefined);
  assert.deepEqual(computerOf({ id: 'a' }), { id: 'a', name: 'a', providerType: '', managed: true, status: 'active', createdAt: 0 });
  assert.equal(metricOf({ timestamp: 'nope' }), undefined);
  assert.equal(metricOf(5), undefined);
  const many = Array.from({ length: 40 }, (_, i) => sample(new Date(Date.UTC(2026, 9, 7, 0, i * 5)).toISOString(), i));
  assert.equal(metricsOf(many, 1).history.length, METRICS_HISTORY);
  assert.equal(metricsOf(many, 1).latest?.cpuPct, 39);
  assert.deepEqual(metricsOf('nope', 1), { history: [], fetchedAt: 1 });
  assert.deepEqual(metricsOf(many, 1, 0).history, []);
  assert.equal(sessionOf(null), undefined);
  assert.equal(sessionOf({ sessionId: 'x' })?.status, 'idle');
  assert.equal(workflowOf('x'), undefined);
  assert.equal(ciRunOf({ id: '' }), undefined);
  assert.equal(ciRunOf(null), undefined);
  assert.equal(ciRunOf({ runId: 'r', workflowName: 'w', createdAt: 'never' })?.createdAt, undefined);
  assert.equal(wikiRunOf(null), undefined);
  assert.equal(wikiRunOf({ id: 'w' })?.repoUrl, '');
  assert.ok(isFactoryFeature('ci'));
  assert.ok(!isFactoryFeature('serviceAccounts'));
  assert.ok(!isFactoryFeature(3));
});

test('mounted: connecting answers its sender, the state carries every slice, and the messages drive it', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'factory-mount-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = factory({
    '/api/v0/computers/providers': () => json(200, { providers: ['e2b'] }),
    '/api/v0/computers': () => json(200, COMPUTERS),
    '/api/v0/computers/orb-id/metrics': () => json(200, [sample('2026-10-07T11:55:00Z', 20)]),
    '/api/v0/sessions': () => json(200, { sessions: [{ sessionId: 's1', title: 'One', status: 'idle' }], pagination: { hasMore: false } }),
    '/api/v0/automations/ci/repository-owners': () => json(200, { owners: [], integration: { connected: true } }),
    '/api/v0/automations/ci/scan': () => json(200, { workflows: [] }),
    '/api/v0/automations/ci/runs': () => json(200, { runs: [] }),
    '/api/v0/automations/ci/jobs': () => json(200, { jobs: [] }),
    '/api/v0/wiki': () => json(200, { wikiRuns: [] }),
    '/api/v0/organization/users': () => json(200, { users: [{ id: 'user_1', email: 'o@example.com', firstName: 'Olive' }], pagination: { hasMore: false } }),
    '/api/v0/service-accounts': () => json(402, { detail: 'Requires a Teams plan' }),
  });
  const sent: FactoryState[] = [];
  const toasts: string[] = [];
  const factoryMount = mountFactory({ dataDir: dir, broadcast: (s) => sent.push(s), toast: (text) => toasts.push(text), fetchImpl: f.fn });
  t.after(() => factoryMount.stop());
  assert.equal(factoryMount.state().connection.connected, false);

  const replies: ServerMsg[] = [];
  const reply = (m: ServerMsg) => replies.push(m);
  factoryMount.message('tab', 'Olive', { t: 'factory.connect', key: 'bad' }, reply);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(replies[0].t, 'factory.setup');
  assert.equal((replies[0] as { ok: boolean }).ok, false);

  factoryMount.message('tab', 'Olive', { t: 'factory.connect', key: KEY }, reply);
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(replies[1], { t: 'factory.setup', ok: true });
  assert.deepEqual(toasts, ['🏭 Olive connected the office to Factory']);
  const state = factoryMount.state();
  assert.equal(state.connection.account?.name, 'Olive');
  assert.equal(state.computers.items.length, 2, 'the computers slice is live');
  assert.ok(!JSON.stringify(state).includes(KEY));
  assert.ok(sent.length >= 1);

  factoryMount.message('tab', 'Olive', { t: 'factory.watch', feature: 'computers', on: true }, reply);
  assert.ok(factoryMount.registry.watched('computers'));
  factoryMount.drop('tab');
  assert.ok(!factoryMount.registry.watched('computers'));
  factoryMount.message('tab', 'Olive', { t: 'factory.watch', feature: 'bogus' as 'ci', on: true }, reply);
  const asked = f.seen.length;
  factoryMount.message('tab', 'Olive', { t: 'factory.refresh', feature: 'wiki' }, reply);
  factoryMount.message('tab', 'Olive', { t: 'factory.refresh' }, reply);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(f.seen.length > asked);

  factoryMount.message('tab', 'Olive', { t: 'factory.disconnect' }, reply);
  assert.equal(factoryMount.state().connection.connected, false);
  assert.deepEqual(factoryMount.state().computers.items, [], 'disconnecting forgets every feature’s data');
  factoryMount.message('tab', 'Olive', { t: 'factory.disconnect' }, reply);
  assert.equal(toasts.length, 2);
});
