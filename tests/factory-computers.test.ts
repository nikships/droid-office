import test from 'node:test';
import assert from 'node:assert/strict';
import { FactoryApi } from '../src/server/factory/api.js';
import { ComputersFeature } from '../src/server/factory/computers.js';
import type { FactoryRequest, FeatureHost } from '../src/server/factory/feature.js';
import { age, gridOf, rackCubesOf, wallSummary, wallView } from '../src/client/world/factory-computers.js';
import { ASLEEP_AFTER_MS, computerOf, computerPhase, currentStep, emptyComputers, hereOf, hostKey, mergeMetrics, METRICS_HOURS, samplesOf, type FactoryComputer } from '../src/shared/factory-computers.js';
import { emptyFactoryState, type FactoryState } from '../src/shared/factory.js';

const KEY = 'fk-test-computers-9876';
const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: unknown;
}
type Handler = (req: Seen) => Response | Promise<Response>;

/** Factory as the computers feature sees it: an answer per "METHOD /path" (or just "/path" for a GET). */
function factory(routes: Record<string, Handler>) {
  const seen: Seen[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const req: Seen = { method, path: url.pathname.replace('/api/v0', ''), query: url.searchParams, body: init.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(req);
    const r = routes[`${method} ${req.path}`] ?? (method === 'GET' ? routes[req.path] : undefined);
    return r ? r(req) : json(404, { detail: `no ${method} ${req.path}` });
  }) as typeof fetch;
  return { api: new FactoryApi(KEY, fn), seen };
}

function host() {
  const toasts: string[] = [];
  let soon = 0;
  let changes = 0;
  const h: FeatureHost = {
    changed: () => changes++,
    pollSoon: () => soon++,
    api: () => undefined,
    toast: (text) => toasts.push(text),
  };
  return { h, toasts, soon: () => soon, changes: () => changes };
}

const T0 = Date.parse('2026-10-07T12:00:00Z');
const sample = (at: number, cpu: number, extra: Record<string, number> = {}) => ({ timestamp: new Date(at).toISOString(), cpuUsedPct: cpu, cpuCount: 4, memUsed: 2e9, memTotal: 8e9, diskUsed: 1e10, diskTotal: 5e10, ...extra });

const ORB = {
  id: 'orb-id',
  hostId: 'h1',
  name: 'orb',
  providerType: 'e2b',
  status: 'active',
  createdAt: 1791043801861,
  provisioningSteps: [
    { id: 'create-computer', name: 'Creating computer', status: 'completed', startedAt: 1, completedAt: 2 },
    { id: 'clone-repos', name: 'Cloning repositories', status: 'completed', startedAt: 3, completedAt: 9 },
  ],
  relayClientUrl: 'wss://relay.example/client',
  computerIdentity: { publicKey: 'secret-ish' },
  remoteUser: 'factory-user',
  clonedRepoDirectories: ['/home/factory-user/droid-office'],
};
const MAC = { id: 'mac-id', name: 'nikhils-macbook-pro', providerType: 'byom', status: 'active', createdAt: 1790895059911, remoteUser: 'nik' };

/** A feature against a Factory with orb (managed) and this machine's BYOM computer. */
function setup(overrides: Record<string, Handler> = {}) {
  let now = T0;
  const metrics: { status: number; body: unknown } = { status: 200, body: [sample(T0 - 10 * 60_000, 10), sample(T0 - 5 * 60_000, 20)] };
  const f = factory({
    '/computers': () => json(200, { computers: [ORB, MAC, { name: 'no id' }] }),
    '/computers/providers': () => json(200, { providers: ['e2b', 7] }),
    '/organization/computer-secrets': () => json(200, { secrets: [{ key: 'NPM_TOKEN' }, { key: 'A_KEY' }, { nope: 1 }] }),
    '/computers/orb-id/metrics': () => json(metrics.status, metrics.body),
    '/computers/mac-id/metrics': () => json(400, { detail: 'Metrics are not supported for BYOM computers' }),
    ...overrides,
  });
  const hh = host();
  const feature = new ComputersFeature(hh.h, () => now, ['Nikhils-MacBook-Pro.local']);
  return {
    ...f,
    ...hh,
    feature,
    metrics,
    at: (t: number) => (now = t),
    later: (ms: number) => (now += ms),
    route: (method: string, path: string) => {
      const r = feature.routes.find((x) => x.method === method && x.path === path);
      assert.ok(r, `${method} ${path}`);
      return (params: Record<string, string> = {}, body: unknown = {}, query = '') => Promise.resolve(r.handle({ api: f.api, params, query: new URLSearchParams(query), json: async () => body, by: 'Olive', method, path } as FactoryRequest));
    },
  };
}

test('the poll reads the list with its steps, the providers, the secret names and orb’s metrics, and finds this machine', async () => {
  const s = setup();
  await s.feature.poll(s.api);
  const st = s.feature.state();
  assert.deepEqual(
    st.items.map((c) => [c.name, c.managed]),
    [
      ['orb', true],
      ['nikhils-macbook-pro', false],
    ],
  );
  assert.equal(s.seen[0].query.get('includeProvisioningSteps'), 'true');
  assert.ok(!JSON.stringify(st).includes('relay.example') && !JSON.stringify(st).includes('secret-ish'), 'no relay URLs or keys');
  assert.deepEqual(st.items[0].repos, ['/home/factory-user/droid-office']);
  assert.deepEqual(st.providers, ['e2b']);
  assert.deepEqual(st.secrets, ['A_KEY', 'NPM_TOKEN']);
  assert.equal(st.here, 'mac-id', 'the BYOM computer named after this machine is this machine');
  assert.deepEqual(Object.keys(st.metrics), ['orb-id']);
  assert.equal(st.metrics['orb-id'].latest?.cpuPct, 20);
  assert.deepEqual(
    st.metrics['orb-id'].history.map((p) => p[1]),
    [10, 20],
  );
  assert.deepEqual(st.metrics['orb-id'].history[0], [T0 - 10 * 60_000, 10, 25, 20]);
  assert.ok(!s.seen.some((r) => r.path.includes('mac-id')), 'BYOM metrics are never asked for');
  const first = s.seen.find((r) => r.path === '/computers/orb-id/metrics')!;
  assert.equal(first.query.get('start'), new Date(T0 - 24 * 3600_000).toISOString(), 'the first read looks back a day');
  assert.equal(st.fetchedAt, T0);
  assert.ok(!s.feature.busy());
});

test('metrics roll: later reads ask only for what’s new, keep the last hours, and a failed read keeps the samples', async () => {
  const s = setup();
  await s.feature.poll(s.api);
  const asked = s.seen.length;
  s.later(60_000);
  await s.feature.poll(s.api);
  assert.deepEqual(
    s.seen.slice(asked).map((r) => r.path),
    ['/computers'],
    'metrics, providers and secrets are still fresh',
  );

  s.later(3 * 60_000);
  s.metrics.body = [sample(T0 + 0, 30)];
  const before = s.seen.length;
  await s.feature.poll(s.api);
  const read = s.seen.slice(before).find((r) => r.path === '/computers/orb-id/metrics')!;
  assert.equal(read.query.get('start'), new Date(T0 - 5 * 60_000 + 1).toISOString(), 'from just after the newest sample');
  assert.deepEqual(
    s.feature.state().metrics['orb-id'].history.map((p) => p[1]),
    [10, 20, 30],
  );

  s.later(3 * 60_000);
  s.metrics.status = 503;
  s.metrics.body = { detail: 'metrics down' };
  await s.feature.poll(s.api);
  const m = s.feature.state().metrics['orb-id'];
  assert.equal(m.latest?.cpuPct, 30, 'a failed read keeps the last samples');
  assert.match(m.error ?? '', /metrics down/);

  // Hours later, the old samples age out of the history but the newest stays as latest.
  s.later(METRICS_HOURS * 3600_000);
  s.metrics.status = 200;
  s.metrics.body = [];
  await s.feature.poll(s.api);
  const late = s.feature.state().metrics['orb-id'];
  assert.deepEqual(late.history, []);
  assert.equal(late.latest?.cpuPct, 30);
  assert.equal(late.error, undefined);
});

test('a provisioning computer polls fast and isn’t asked for metrics; secrets failing don’t fail the poll', async () => {
  const s = setup({
    '/computers': () =>
      json(200, {
        computers: [
          {
            id: 'n',
            name: 'new',
            providerType: 'e2b',
            status: 'provisioning',
            createdAt: 1,
            provisioningSteps: [
              { id: 'a', name: 'Creating computer', status: 'completed' },
              { id: 'b', name: 'Installing Droid', status: 'in_progress', startedAt: 5 },
              { id: 'c', name: 'Cloning', status: 'pending' },
            ],
          },
        ],
      }),
    '/organization/computer-secrets': () => json(403, { detail: 'Admins only' }),
  });
  await s.feature.poll(s.api);
  assert.ok(s.feature.busy());
  assert.ok(!s.seen.some((r) => r.path.includes('/metrics')));
  assert.match(s.feature.state().secretsError ?? '', /Admins only/);
  assert.equal(currentStep(s.feature.state().items[0])?.name, 'Installing Droid');
  assert.equal(s.feature.state().here, undefined);
});

test('a 401 anywhere fails the poll, so the key is marked rejected', async () => {
  const s = setup({ '/organization/computer-secrets': () => json(401, { detail: 'bad key' }) });
  await assert.rejects(
    () => s.feature.poll(s.api),
    (e: Error & { status?: number }) => e.status === 401,
  );
  const m = setup({ '/computers/orb-id/metrics': () => json(401, { detail: 'bad key' }) });
  await assert.rejects(
    () => m.feature.poll(m.api),
    (e: Error & { status?: number }) => e.status === 401,
  );
});

test('waking: a restart that woke it polls fast until a sample comes, and gives up after a while', async () => {
  const s = setup();
  s.metrics.body = [sample(T0 - 3 * 3600_000, 5)];
  await s.feature.poll(s.api);
  assert.equal(computerPhase(s.feature.state().items[0], s.feature.state(), T0), 'asleep');

  const restarts: unknown[] = [];
  s.seen.length = 0;
  const restart = s.route('POST', '/:id/restart');
  const f2 = factory({ 'POST /computers/orb-id/restart': (r) => (restarts.push(r.body), json(200, { wasRestarted: true })) });
  const r = await s.feature.routes.find((x) => x.path === '/:id/restart')!.handle({ api: f2.api, params: { id: 'orb-id' }, json: async () => ({}), by: 'Olive' } as never);
  assert.deepEqual(r, { wasRestarted: true });
  assert.deepEqual(restarts, [{ mode: 'resume' }]);
  assert.deepEqual(s.toasts, ['🖥️ Olive woke the Droid Computer orb']);
  assert.ok(s.feature.busy());
  assert.equal(computerPhase(s.feature.state().items[0], s.feature.state(), T0), 'waking');
  assert.equal(s.soon(), 1);

  // A minute on, it reads the metrics again (not three): still nothing, still waking.
  s.later(61_000);
  s.metrics.body = [];
  await s.feature.poll(s.api);
  assert.ok(s.seen.some((x) => x.path === '/computers/orb-id/metrics'));
  assert.ok(s.feature.state().waking['orb-id']);

  // Its first sample since: awake.
  s.later(61_000);
  s.metrics.body = [sample(T0, 40)];
  await s.feature.poll(s.api);
  assert.deepEqual(s.feature.state().waking, {});
  assert.equal(computerPhase(s.feature.state().items[0], s.feature.state(), T0 + 122_000), 'active');

  // One that never comes back is given up on.
  const f3 = factory({ 'POST /computers/orb-id/restart': () => json(200, { wasRestarted: true }) });
  await s.feature.routes.find((x) => x.path === '/:id/restart')!.handle({ api: f3.api, params: { id: 'orb-id' }, json: async () => ({ mode: 'reboot' }), by: 'Olive' } as never);
  assert.match(s.toasts.at(-1) ?? '', /rebooted/);
  s.later(13 * 60_000);
  s.metrics.body = [];
  await s.feature.poll(s.api);
  assert.deepEqual(s.feature.state().waking, {});

  // Already running: nothing to wait for.
  const f4 = factory({ 'POST /computers/orb-id/restart': () => json(200, { wasRestarted: false }) });
  assert.deepEqual(await s.feature.routes.find((x) => x.path === '/:id/restart')!.handle({ api: f4.api, params: { id: 'orb-id' }, json: async () => ({}), by: 'Olive' } as never), { wasRestarted: false });
  assert.deepEqual(s.feature.state().waking, {});
  assert.ok(restart);
});

test('create and bulk create: checked here, sent to Factory, added to the list straight away', async () => {
  const made = { id: 'new-id', name: 'office-test', providerType: 'e2b', status: 'provisioning', createdAt: 5, provisioningSteps: [{ id: 'create-computer', name: 'Creating computer', status: 'in_progress' }] };
  const s = setup({
    'POST /computers': () => json(201, made),
    'POST /computers/bulk': (r) => json(201, { computers: [{ ...made, id: 'b1', name: 'fleet-1' }], requestedQuantity: (r.body as { quantity: number }).quantity, error: { message: 'Only 1 of 3 could be made' } }),
  });
  await s.feature.poll(s.api);
  const create = s.route('POST', '');
  await assert.rejects(() => create({}, { name: '' }), /Give the computer a name/);
  await assert.rejects(() => create({}, { name: 'x'.repeat(64) }), /at most 63/);
  await assert.rejects(() => create({}, { name: 'a', repos: 'nope' }), /list of repository URLs/);
  await assert.rejects(() => create({}, { name: 'a', repos: ['http://github.com/o/r'] }), /https/);
  await assert.rejects(() => create({}, { name: 'a', repos: ['not a url'] }), /isn’t a repository URL/);
  const r = (await create({}, { name: ' office-test ', repos: ['nikships/droid-office', 'https://github.com/o/r/'], autoInstallDeps: true, provider: 'e2b', remoteUser: '' })) as { computer: FactoryComputer };
  assert.equal(r.computer.id, 'new-id');
  const sent = s.seen.find((x) => x.method === 'POST' && x.path === '/computers')!;
  // A blank remote user goes out as the default: Factory turns a create without one down.
  assert.deepEqual(sent.body, { name: 'office-test', provider: 'e2b', remoteUser: 'factory-user', repos: ['https://github.com/nikships/droid-office', 'https://github.com/o/r'], autoInstallDeps: true });
  assert.ok(s.feature.state().items.some((c) => c.id === 'new-id'));
  assert.ok(s.feature.busy(), 'a new computer provisions');
  assert.match(s.toasts[0], /Olive made the Droid Computer office-test/);

  const bulk = s.route('POST', '/bulk');
  await assert.rejects(() => bulk({}, { quantity: 21, namePrefix: 'fleet' }), /1 to 20/);
  await assert.rejects(() => bulk({}, { quantity: 2, namePrefix: 'Fleet' }), /name prefix/);
  const b = (await bulk({}, { quantity: 3, namePrefix: 'fleet' })) as { computers: FactoryComputer[]; error?: string; requested: number };
  assert.equal(b.computers.length, 1);
  assert.equal(b.requested, 3);
  assert.equal(b.error, 'Only 1 of 3 could be made');
  assert.deepEqual(s.seen.find((x) => x.path === '/computers/bulk')!.body, { quantity: 3, namePrefix: 'fleet' });
  assert.ok(s.feature.state().items.some((c) => c.name === 'fleet-1'));
});

test('rename, remote user, refresh, install-deps, activity and the detail', async () => {
  const s = setup({
    'PATCH /computers/orb-id': (r) => json(200, { ...ORB, ...(r.body as object) }),
    'POST /computers/orb-id/refresh': () => json(200, { configured: 2, secretsConfigured: 1 }),
    'POST /computers/orb-id/install-deps': () => json(202, { ...ORB, status: 'provisioning' }),
    'POST /computers/orb-id/activity': () => json(200, { lastActiveAt: 77 }),
    '/computers/orb-id': () => json(200, { ...ORB, remoteUser: 'root' }),
  });
  await s.feature.poll(s.api);
  const patch = s.route('PATCH', '/:id');
  await assert.rejects(() => patch({ id: 'orb-id' }, {}), /Nothing to change/);
  await assert.rejects(() => patch({ id: 'orb-id' }, { remoteUser: '' }), /remote user/);
  await patch({ id: 'orb-id' }, { name: 'orb-2', remoteUser: 'dev' });
  assert.deepEqual(s.seen.at(-1)?.body, { name: 'orb-2', remoteUser: 'dev' });
  assert.equal(s.feature.state().items[0].name, 'orb-2');
  assert.equal(s.feature.state().items[0].provisioningSteps?.length, 2, 'an answer without steps keeps the ones it had');

  assert.deepEqual(await s.route('POST', '/:id/refresh')({ id: 'orb-id' }), { configured: 2, secretsConfigured: 1 });
  await s.route('POST', '/:id/install-deps')({ id: 'orb-id' });
  assert.equal(s.feature.state().items[0].status, 'provisioning');
  assert.deepEqual(await s.route('POST', '/:id/activity')({ id: 'orb-id' }), { lastActiveAt: 77 });
  const d = (await s.route('GET', '/:id')({ id: 'orb-id' })) as { computer: FactoryComputer };
  assert.equal(d.computer.remoteUser, 'root');
  assert.equal(s.feature.state().items[0].remoteUser, 'root');
  await assert.rejects(() => s.route('GET', '/:id')({ id: 'gone' }), /no GET/);

  const metrics = s.route('GET', '/:id/metrics');
  const m = (await metrics({ id: 'orb-id' }, {}, 'hours=48')) as { samples: { cpuPct: number }[] };
  assert.deepEqual(
    m.samples.map((x) => x.cpuPct),
    [10, 20],
  );
  assert.equal(s.seen.at(-1)?.query.get('start'), new Date(T0 - 48 * 3600_000).toISOString());
  await assert.rejects(() => metrics({ id: 'orb-id' }, {}, 'hours=500'), /hours is 1 to 96/);
});

test('delete takes the computer’s name typed out', async () => {
  const s = setup({ 'DELETE /computers/orb-id': () => json(204), '/computers/other': () => json(200, { id: 'other', name: 'other', providerType: 'e2b' }) });
  await s.feature.poll(s.api);
  const del = s.route('DELETE', '/:id');
  await assert.rejects(() => del({ id: 'orb-id' }, { confirm: 'orb!' }), /Type the computer’s name, orb/);
  await assert.rejects(() => del({ id: 'other' }, {}), /Type the computer’s name, other/);
  assert.ok(!s.seen.some((x) => x.method === 'DELETE'), 'nothing was deleted');
  assert.deepEqual(await del({ id: 'orb-id' }, {}, 'confirm=orb'), { deleted: 'orb-id' });
  assert.ok(!s.feature.state().items.some((c) => c.id === 'orb-id'));
  assert.equal(s.feature.state().metrics['orb-id'], undefined);
  assert.match(s.toasts.at(-1) ?? '', /Olive deleted the Droid Computer orb/);
});

test('computer secrets: names only, values never in the slice, a log or an error', async () => {
  const VALUE = 'super-secret-value-123';
  let next: Response | undefined;
  const s = setup({
    'PATCH /organization/computer-secrets': (r) => next ?? json(200, { secrets: [...(r.body as { upsert: { key: string }[] }).upsert.map((u) => ({ key: u.key })), { key: 'NPM_TOKEN' }] }),
  });
  const logs: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(' '));
  try {
    const patch = s.route('PATCH', '/secrets');
    await assert.rejects(() => patch({}, {}), /Nothing to change/);
    await assert.rejects(() => patch({}, { upsert: [{ key: 'lower', value: 'x' }] }), /isn’t a secret name/);
    await assert.rejects(() => patch({}, { upsert: [{ key: 'OK', value: '' }] }), /needs a value/);
    await assert.rejects(() => patch({}, { delete: ['bad-name'] }), /isn’t a secret name/);
    const r = await patch({}, { upsert: [{ key: 'API_KEY', value: VALUE }], delete: ['OLD'] });
    assert.deepEqual(r, { secrets: ['API_KEY', 'NPM_TOKEN'] });
    assert.deepEqual(s.seen.at(-1)?.body, { upsert: [{ key: 'API_KEY', value: VALUE }], delete: ['OLD'] });
    assert.deepEqual(s.feature.state().secrets, ['API_KEY', 'NPM_TOKEN']);
    next = json(400, { detail: `Value ${VALUE} is not allowed` });
    await assert.rejects(
      () => patch({}, { upsert: [{ key: 'API_KEY', value: VALUE }] }),
      (e: Error) => !e.message.includes(VALUE) && e.message.includes('[redacted]'),
    );
    assert.deepEqual(await s.route('GET', '/secrets')(), { secrets: ['A_KEY', 'NPM_TOKEN'] });
  } finally {
    console.log = log;
  }
  assert.ok(!JSON.stringify(s.feature.state()).includes(VALUE));
  assert.ok(!logs.join('\n').includes(VALUE));
  assert.match(logs.join('\n'), /Olive set 1 computer secret and removed 1 computer secret/);
});

test('the repositories Factory sees, for the form, are kept for a while', async () => {
  const s = setup({
    '/automations/ci/repositories': () => json(200, { repositories: [{ fullName: 'o/b', url: 'https://github.com/o/b', isPrivate: true }, { fullName: 'o/a' }, { nope: 1 }] }),
  });
  const repos = s.route('GET', '/repositories');
  assert.deepEqual(await repos(), {
    repositories: [
      { fullName: 'o/a', url: 'https://github.com/o/a' },
      { fullName: 'o/b', url: 'https://github.com/o/b', isPrivate: true },
    ],
  });
  await repos();
  assert.equal(s.seen.filter((x) => x.path === '/automations/ci/repositories').length, 1);
  s.feature.reset();
  await repos();
  assert.equal(s.seen.filter((x) => x.path === '/automations/ci/repositories').length, 2, 'reset forgets them');
  assert.deepEqual(s.feature.state(), emptyComputers());
});

test('the shared helpers: host names, phases, steps and merged metrics', () => {
  assert.equal(hostKey('Nikhils-MacBook-Pro.local'), 'nikhils-macbook-pro');
  assert.equal(hostKey('Nikhil’s MacBook Pro'), 'nikhils-macbook-pro');
  assert.equal(hostKey("  ada's box.lan "), 'adas-box');
  const items = [computerOf(ORB)!, computerOf(MAC)!];
  assert.equal(hereOf(items, ['NIKHILS-MACBOOK-PRO']), 'mac-id');
  assert.equal(hereOf(items, ['orb']), undefined, 'a managed computer is never this machine');
  assert.equal(hereOf(items, ['']), undefined);

  const st = { metrics: {}, waking: {} };
  assert.equal(computerPhase(items[0], st, T0), 'active', 'before its first read');
  assert.equal(computerPhase(items[1], st, T0), 'active');
  assert.equal(computerPhase({ ...items[0], status: 'error' }, st, T0), 'error');
  const m = mergeMetrics(undefined, samplesOf([sample(T0 - ASLEEP_AFTER_MS - 1, 3)]), T0);
  assert.equal(computerPhase(items[0], { metrics: { 'orb-id': m }, waking: {} }, T0), 'asleep');
  assert.equal(computerPhase(items[0], { metrics: { 'orb-id': mergeMetrics(undefined, [], T0) }, waking: {} }, T0), 'asleep');
  assert.equal(computerPhase(items[0], { metrics: { 'orb-id': m }, waking: { 'orb-id': T0 } }, T0), 'waking');
  assert.equal(currentStep(items[0]), undefined);
  assert.equal(
    currentStep({
      ...items[0],
      provisioningSteps: [
        { id: 'a', name: 'A', status: 'completed' },
        { id: 'b', name: 'B', status: 'failed', error: 'npm exploded' },
      ],
    })?.error,
    'npm exploded',
  );
  assert.deepEqual(samplesOf('nope'), []);
  assert.deepEqual(samplesOf([{ timestamp: 'never' }]), []);
  // An older answer doesn't replace a newer latest.
  const newer = mergeMetrics(undefined, samplesOf([sample(T0, 50)]), T0);
  assert.equal(mergeMetrics(newer, samplesOf([sample(T0 - 60_000, 1)]), T0).latest?.cpuPct, 50);
});

// ---- The wall -----------------------------------------------------------------------------------

function connected(slice: Partial<FactoryState['computers']>, conn: Partial<FactoryState['connection']> = {}): FactoryState {
  const s = emptyFactoryState();
  s.connection = { connected: true, capabilities: [{ group: 'computers', status: 'ok' }], ...conn };
  s.computers = { ...emptyComputers(), ...slice };
  return s;
}

test('the wall: not connected, no access, reading, and the computers with this machine merged in', () => {
  const off = wallView(emptyFactoryState(), T0);
  assert.equal(off.state, 'off');
  assert.equal(off.note, 'Connect Factory in ⚙️ Settings → Factory to see your Droid Computers');
  assert.equal(wallSummary(off), 'not connected');
  assert.equal(rackCubesOf(emptyFactoryState(), T0), null, 'the rack runs its demo');

  const denied = wallView(connected({}, { capabilities: [{ group: 'computers', status: 'denied', reason: 'Needs a Teams plan' }] }), T0);
  assert.equal(denied.state, 'denied');
  assert.match(denied.note ?? '', /Needs a Teams plan/);
  assert.equal(wallSummary(denied), 'no access');

  const loading = wallView(connected({}), T0);
  assert.equal(loading.state, 'loading');
  assert.equal(wallSummary(loading), 'reading…');

  const items = [
    computerOf(ORB)!,
    computerOf(MAC)!,
    computerOf({
      id: 'p',
      name: 'new',
      providerType: 'e2b',
      status: 'provisioning',
      provisioningSteps: [
        { id: 'a', name: 'Creating computer', status: 'completed' },
        { id: 'b', name: 'Cloning repositories', status: 'in_progress' },
      ],
    })!,
  ];
  const metrics = { 'orb-id': mergeMetrics(undefined, samplesOf([sample(T0 - 30 * 60_000, 10), sample(T0 - 5 * 60_000, 45)]), T0) };
  const v = wallView(connected({ items, metrics, here: 'mac-id', fetchedAt: T0 - 30_000 }), T0);
  assert.equal(v.state, 'ok');
  assert.deepEqual(v.here, { name: 'nikhils-macbook-pro', phase: 'active' });
  assert.deepEqual(
    v.tiles.map((t) => t.name),
    ['orb', 'new'],
    'this machine is on the left screen, not a tile',
  );
  assert.equal(v.total, 3);
  assert.deepEqual(v.counts, { active: 2, provisioning: 1 });
  assert.equal(v.tiles[0].cpu, 45);
  assert.equal(v.tiles[0].mem, 25);
  assert.equal(v.tiles[0].disk, 20);
  assert.equal(v.tiles[0].detail, '4 CPU · 7.5 GB');
  assert.deepEqual(
    v.tiles[0].spark.map((p) => p[0]),
    [30, 5],
  );
  assert.equal(v.tiles[1].detail, 'Cloning repositories (2/2)');
  assert.equal(v.updated, 'just now');
  assert.equal(wallSummary(v), '2 active · 1 provisioning');

  const cubes = rackCubesOf(connected({ items, metrics, fetchedAt: T0 }), T0)!;
  assert.deepEqual(
    cubes.map((c) => c.led),
    ['on', 'busy', 'off'],
  );
  assert.equal(cubes[0].mem, '1.9GB/7GB');

  // Asleep, with when it was last seen.
  const asleep = wallView(connected({ items: [items[0]], metrics: { 'orb-id': mergeMetrics(undefined, samplesOf([sample(T0 - 3 * 3600_000, 1)]), T0) }, fetchedAt: T0 }), T0);
  assert.equal(asleep.tiles[0].phase, 'asleep');
  assert.equal(asleep.tiles[0].detail, 'last seen 3h ago');
  assert.equal(rackCubesOf(connected({ items: [items[0]], metrics: { 'orb-id': mergeMetrics(undefined, [], T0) }, fetchedAt: T0 }), T0)?.[0].led, 'dim');
});

test('the wall keeps the last data with its age and the reason when the key is rejected or Factory is down', () => {
  const items = [computerOf(ORB)!];
  const rejected = wallView(connected({ items, fetchedAt: T0 - 14 * 60_000 }, { rejected: 'it answered 401' }), T0);
  assert.equal(rejected.tiles.length, 1);
  assert.equal(rejected.note, 'Key rejected (it answered 401) · data from 14m ago');
  assert.ok(rejected.warn);
  const never = wallView(connected({}, { rejected: 'it answered 401' }), T0);
  assert.match(never.note ?? '', /rejected the office’s key/);
  const down = wallView(connected({ items, fetchedAt: T0 - 3 * 60_000, error: 'Couldn’t reach Factory (ETIMEDOUT).' }), T0);
  assert.equal(down.note, 'Couldn’t reach Factory (ETIMEDOUT). · data from 3m ago');
  const none = wallView(connected({ fetchedAt: T0 }), T0);
  assert.equal(wallSummary(none), 'no Droid Computers yet');
  assert.equal(age(2 * 86400_000), '2d ago');
});

test('the wall lays out 0 to a dozen computers and more: a grid, then compact rows', () => {
  assert.deepEqual(gridOf(0), { cols: 1, rows: 1, compact: false, shown: 0 });
  assert.deepEqual(gridOf(1), { cols: 1, rows: 1, compact: false, shown: 1 });
  assert.deepEqual(gridOf(2), { cols: 1, rows: 2, compact: false, shown: 2 });
  assert.deepEqual(gridOf(4), { cols: 2, rows: 2, compact: false, shown: 4 });
  assert.deepEqual(gridOf(6), { cols: 3, rows: 2, compact: false, shown: 6 });
  assert.deepEqual(gridOf(7), { cols: 2, rows: 4, compact: true, shown: 7 });
  assert.deepEqual(gridOf(12), { cols: 2, rows: 6, compact: true, shown: 12 });
  assert.deepEqual(gridOf(30), { cols: 2, rows: 6, compact: true, shown: 11 }, 'the twelfth cell says how many more');
});
