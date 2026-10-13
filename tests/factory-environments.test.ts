import test from 'node:test';
import assert from 'node:assert/strict';
import { FactoryApi } from '../src/server/factory/api.js';
import { EnvironmentsFeature } from '../src/server/factory/environments.js';
import type { FactoryRequest, FeatureHost } from '../src/server/factory/feature.js';
import { computerOf } from '../src/shared/factory-computers.js';
import { canStartFrom, environmentOf, environmentPhase, instanceName, logOf, repoFolder, sourcesOf, unbuiltChanges, type FactoryEnvironment } from '../src/shared/factory-environments.js';

const KEY = 'fk-test-environments-4321';
const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Answers copied from the owner's account (GET /environments, /environments/source-options,
// /environments/{id}/build-diagnostics and POST /computers with an Environment source), trimmed.
const ENV_ID = 'cf248f8e-05ce-4fa4-9769-84d85d19792e';
const REPO_SCRIPT =
  "# droid-office: install, build, and the Whiteboard renderer's Chromium. Runs in the clone.\n# Electron is only for the Mac app; a Linux computer never runs it.\nexport ELECTRON_SKIP_BINARY_DOWNLOAD=1\n# prepare installs the pre-commit hook and builds the client and server (dist/).\nnpm ci --no-audit --no-fund\nnode bin/droid-office.js browser install\n";
const SOURCE = { provider: { id: 'factory-managed', name: 'Factory managed' }, id: 'factory-default', name: 'Factory default', supportsRepositories: true, supportsSetupScripts: true };
const REAL_ENV = {
  id: ENV_ID,
  name: 'droid-office-default',
  scope: 'organization',
  repositories: [{ url: 'https://github.com/nikships/droid-office', script: REPO_SCRIPT }],
  activeRepositories: [{ url: 'https://github.com/nikships/droid-office', script: REPO_SCRIPT }],
  setupScript: 'export DEBIAN_FRONTEND=noninteractive\n\necho "==> apt: Pillow and fonts for screenshots"\n',
  latestBuild: {
    id: '25128393-78d5-4841-a8db-2c2c442f9bc0',
    status: 'succeeded',
    trigger: 'edit',
    repositories: [{ url: 'https://github.com/nikships/droid-office', name: 'droid-office', defaultBranch: 'main', commitSha: '9bacc73d61e6d743206cd2548ac653df28562845' }],
    excerpt: '[validation] environment check passed (9648ms)\n[validation] temporary Computer teardown started\n[validation] temporary Computer teardown completed',
    truncated: true,
    withheld: false,
    createdAt: 1791868403886,
    startedAt: 1791868406593,
    finishedAt: 1791868529007,
    promotedAt: 1791868529007,
  },
  lastSuccessfulBuildAt: 1791868529007,
  status: 'ready',
  isDefault: true,
  createdAt: 1791867364265,
  updatedAt: 1791868529007,
  source: SOURCE,
  activeSource: SOURCE,
};
const REAL_LIST = { environments: [REAL_ENV], defaultEnvironmentId: ENV_ID };
const REAL_SOURCES = { providers: [{ id: 'factory-managed', name: 'Factory managed', sources: [{ id: 'factory-default', name: 'Factory default', supportsRepositories: true, supportsSetupScripts: true }] }], unavailableProviders: [] };
const REAL_LOG = {
  buildId: '25128393-78d5-4841-a8db-2c2c442f9bc0',
  status: 'ready',
  excerpt: '[2026-10-13T05:14:54.584Z] Build finished, took 1m27s\n[validation] temporary Computer creation started\n[validation] Droid check passed (1527ms)',
  truncated: true,
  withheld: false,
};
const REAL_INSTANCE = {
  id: 'a3283d44-f68a-4fdb-b7b6-a8ec87ff0ceb',
  hostId: 'ee5c2252-1516-4f5a-81a4-35176cbca595',
  name: 'droid-office-default-probe01',
  isListed: false,
  providerType: 'e2b',
  status: 'provisioning',
  createdAt: 1791871271173,
  remoteUser: 'factory-user',
  clonedRepoDirectories: ['/home/factory-user/repos/droid-office'],
  ownerPrincipalKind: 'human',
  ownerId: 'user_test',
  computerSource: { kind: 'template', templateId: ENV_ID },
};

const env = (patch: Partial<FactoryEnvironment> = {}): FactoryEnvironment => ({ ...environmentOf(REAL_ENV)!, ...patch });
const build = (status: string) => ({ id: 'b2', status, repos: [], createdAt: 1 });

test('an Environment from the real list: repositories, scripts, source and latest build, without the log', () => {
  const e = environmentOf(REAL_ENV)!;
  assert.equal(e.name, 'droid-office-default');
  assert.equal(e.scope, 'organization');
  assert.equal(e.isDefault, true);
  assert.deepEqual(e.repositories, [{ url: 'https://github.com/nikships/droid-office', script: REPO_SCRIPT }]);
  assert.match(e.setupScript, /DEBIAN_FRONTEND/);
  assert.deepEqual(e.source, { id: 'factory-default', name: 'Factory default', providerId: 'factory-managed', providerName: 'Factory managed', supportsRepositories: true, supportsSetupScripts: true });
  assert.equal(e.latestBuild?.trigger, 'edit');
  assert.deepEqual(e.latestBuild?.repos, [{ url: 'https://github.com/nikships/droid-office', name: 'droid-office', branch: 'main', commit: '9bacc73d61e6d743206cd2548ac653df28562845' }]);
  assert.equal(e.latestBuild?.finishedAt, 1791868529007);
  assert.ok(!JSON.stringify(e).includes('teardown'), 'the excerpt stays out of the slice');
  assert.equal(environmentOf({ name: 'no id' }), undefined);
  assert.equal(environmentOf(null), undefined);
  const bare = environmentOf({ id: 'x' })!;
  assert.deepEqual([bare.name, bare.scope, bare.status, bare.repositories, bare.setupScript, bare.source, bare.latestBuild], ['x', 'user', 'building', [], '', undefined, undefined]);

  assert.deepEqual(sourcesOf(REAL_SOURCES), [{ id: 'factory-default', name: 'Factory default', providerId: 'factory-managed', providerName: 'Factory managed', supportsRepositories: true, supportsSetupScripts: true }]);
  assert.deepEqual(sourcesOf({}), []);
  assert.deepEqual(logOf(REAL_LOG), { buildId: REAL_LOG.buildId, status: 'ready', excerpt: REAL_LOG.excerpt, truncated: true, withheld: false });
  assert.equal(logOf({ excerpt: 'no build' }), undefined);
});

test('phases: a built Environment keeps serving while it builds again or after a rebuild fails', () => {
  assert.equal(environmentPhase(env()), 'ready');
  const fresh = { lastSuccessfulBuildAt: undefined, status: 'building' };
  assert.equal(environmentPhase(env({ ...fresh, latestBuild: build('queued') })), 'queued');
  assert.equal(environmentPhase(env({ ...fresh, latestBuild: build('building') })), 'building');
  assert.equal(environmentPhase(env({ ...fresh, latestBuild: build('validating') })), 'building');
  assert.equal(environmentPhase(env({ ...fresh, latestBuild: undefined })), 'building');
  assert.equal(environmentPhase(env({ lastSuccessfulBuildAt: undefined, status: 'failed', latestBuild: build('failed') })), 'failed');
  assert.equal(environmentPhase(env({ latestBuild: build('building') })), 'updating');
  assert.equal(environmentPhase(env({ latestBuild: build('failed') })), 'update-failed');
  assert.equal(environmentPhase(env({ status: 'failed', latestBuild: build('superseded') })), 'failed');
  assert.equal(environmentPhase(env({ source: { ...env().source!, unavailable: true } })), 'unavailable');

  assert.equal(canStartFrom(env()), true);
  assert.equal(canStartFrom(env({ latestBuild: build('building') })), true);
  assert.equal(canStartFrom(env({ latestBuild: build('failed') })), true);
  assert.equal(canStartFrom(env({ ...fresh, latestBuild: build('building') })), false);
  assert.equal(canStartFrom(env({ source: { ...env().source!, unavailable: true } })), false);

  assert.equal(unbuiltChanges(env()), false);
  assert.equal(unbuiltChanges(env({ repositories: [{ url: 'https://github.com/nikships/droid-office', script: 'npm ci' }] })), true);
  assert.equal(unbuiltChanges(env({ activeRepositories: undefined })), false);
});

test('an instance’s name, and the folder of the floor’s repository on it', () => {
  assert.equal(instanceName('droid-office-default', 'a7caa037ffff'), 'droid-office-default-a7caa037');
  const long = instanceName(`a${'b'.repeat(61)}c`, '12345678');
  assert.equal(long.length, 63);
  assert.match(long, /^ab+-12345678$/);
  assert.equal(instanceName(`${'a'.repeat(53)}--x`, '12345678'), `${'a'.repeat(53)}-12345678`, 'no double hyphen where it was cut');

  const dirs = ['/home/factory-user/repos/droid-office', '/home/factory-user/repos/gemdex'];
  assert.equal(repoFolder(dirs, 'nikships/gemdex'), '/home/factory-user/repos/gemdex');
  assert.equal(repoFolder(dirs, 'https://github.com/nikships/Droid-Office.git'), '/home/factory-user/repos/droid-office');
  assert.equal(repoFolder(dirs, 'nikships/other'), undefined, 'two clones and neither is it: the home folder');
  assert.equal(repoFolder(dirs.slice(0, 1), 'nikships/other'), '/home/factory-user/repos/droid-office', 'the only clone there is');
  assert.equal(repoFolder(undefined, 'x/y'), undefined);
});

test('a computer started from an Environment is tagged with it, and an unlisted one says so', () => {
  const c = computerOf(REAL_INSTANCE)!;
  assert.equal(c.environmentId, ENV_ID);
  assert.equal(c.unlisted, true);
  const listed = computerOf({ ...REAL_INSTANCE, isListed: true, computerSource: { kind: 'environment', environmentId: 'e2' } })!;
  assert.equal(listed.environmentId, 'e2');
  assert.equal(listed.unlisted, undefined);
  assert.equal(computerOf({ id: 'plain', providerType: 'e2b' })!.environmentId, undefined);
});

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: unknown;
}
type Handler = (req: Seen) => Response | Promise<Response>;

function setup(overrides: Record<string, Handler> = {}) {
  const seen: Seen[] = [];
  const routes: Record<string, Handler> = {
    'GET /environments': () => json(200, REAL_LIST),
    'GET /environments/source-options': () => json(200, REAL_SOURCES),
    ...overrides,
  };
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const req: Seen = { method, path: url.pathname.replace('/api/v0', ''), query: url.searchParams, body: init.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(req);
    const r = routes[`${method} ${req.path}`];
    return r ? r(req) : json(404, { status: 404, title: 'Not Found', detail: `no ${method} ${req.path}` });
  }) as typeof fetch;
  const api = new FactoryApi(KEY, fn);
  const toasts: string[] = [];
  let soon = 0;
  let now = 1_800_000_000_000;
  const host: FeatureHost = { changed: () => {}, pollSoon: () => soon++, api: () => api, toast: (t) => toasts.push(t) };
  const feature = new EnvironmentsFeature(host, () => now);
  const route = (method: string, path: string) => {
    const r = feature.routes.find((x) => x.method === method && x.path === path);
    assert.ok(r, `${method} ${path}`);
    return (params: Record<string, string> = {}, body: unknown = {}, query = '') => Promise.resolve(r.handle({ api, params, query: new URLSearchParams(query), json: async () => body, by: 'Olive', method, path } as FactoryRequest));
  };
  return { api, seen, toasts, feature, route, soon: () => soon, later: (ms: number) => (now += ms) };
}

test('the poll reads the list and the sources, which it reads again only every half hour', async () => {
  const s = setup();
  await s.feature.poll(s.api);
  const st = s.feature.state();
  assert.deepEqual(
    st.items.map((e) => e.name),
    ['droid-office-default'],
  );
  assert.equal(st.defaultId, ENV_ID);
  assert.equal(st.sources[0].id, 'factory-default');
  assert.ok(st.fetchedAt > 0);
  assert.equal(s.feature.busy(), false);
  s.seen.length = 0;
  s.later(60_000);
  await s.feature.poll(s.api);
  assert.deepEqual(
    s.seen.map((r) => r.path),
    ['/environments'],
  );
  s.later(31 * 60_000);
  await s.feature.poll(s.api);
  assert.ok(s.seen.some((r) => r.path === '/environments/source-options'));

  const busy = setup({ 'GET /environments': () => json(200, { environments: [{ ...REAL_ENV, isDefault: false, latestBuild: { ...REAL_ENV.latestBuild, status: 'building' } }] }) });
  await busy.feature.poll(busy.api);
  assert.equal(busy.feature.busy(), true, 'a build in flight polls fast');
  assert.equal(busy.feature.state().defaultId, undefined);
  busy.feature.reset();
  assert.deepEqual(busy.feature.state().items, []);
});

test('create checks the name, scripts and repositories before Factory sees them', async () => {
  const s = setup({ 'POST /environments': () => json(201, { id: 'new-id', buildId: 'b1' }) });
  const create = s.route('POST', '');
  await assert.rejects(() => create({}, {}), /Give the Environment a name/);
  await assert.rejects(() => create({}, { name: 'Has Caps' }), /lower-case/);
  await assert.rejects(() => create({}, { name: 'ends-' }), /lower-case/);
  await assert.rejects(() => create({}, { name: 'ok', repositories: 'nope' }), /list of/);
  await assert.rejects(() => create({}, { name: 'ok', repositories: [{ url: 'http://x.test/a/b' }] }), /https/);
  await assert.rejects(() => create({}, { name: 'ok', setupScript: 'x'.repeat(10_001) }), /at most 10,000/);
  await assert.rejects(() => create({}, { name: 'ok', repositories: [{ url: 'a/b', script: 7 }] }), /is text/);
  assert.equal(s.seen.length, 0);
  const r = await create(
    {},
    { name: 'gemdex-env', scope: 'organization', makeDefault: true, setupScript: 'sudo apt-get install -y jq', repositories: [{ url: 'nikships/gemdex', script: 'npm ci' }, { url: 'https://github.com/nikships/gemdex/' }] },
  );
  assert.deepEqual(r, { id: 'new-id', buildId: 'b1' });
  assert.deepEqual(s.seen[0].body, {
    name: 'gemdex-env',
    scope: 'organization',
    repositories: [{ url: 'https://github.com/nikships/gemdex', script: 'npm ci' }],
    setupScript: 'sudo apt-get install -y jq',
    makeOrganizationDefault: true,
  });
  assert.match(s.toasts[0], /Olive made the Environment gemdex-env/);
  await create({}, { name: 'mine' });
  assert.deepEqual(s.seen[1].body, { name: 'mine', scope: 'user', repositories: [] });
});

test('edit, rebuild, cancel, the log, the default and delete', async () => {
  let latest = 'succeeded';
  const s = setup({
    'GET /environments': () => json(200, { ...REAL_LIST, environments: [{ ...REAL_ENV, latestBuild: { ...REAL_ENV.latestBuild, status: latest } }] }),
    [`PATCH /environments/${ENV_ID}`]: (req) => json(200, (req.body as { setupScript?: unknown }).setupScript !== undefined ? { id: ENV_ID, buildId: 'b9' } : { id: ENV_ID }),
    [`POST /environments/${ENV_ID}/builds`]: () => json(200, { id: ENV_ID, buildId: 'b10' }),
    [`POST /environments/${ENV_ID}/builds/25128393-78d5-4841-a8db-2c2c442f9bc0/cancel`]: () => new Response(null, { status: 204 }),
    [`GET /environments/${ENV_ID}/build-diagnostics`]: () => json(200, REAL_LOG),
    [`GET /environments/${ENV_ID}/builds/old/diagnostics`]: () => json(200, { ...REAL_LOG, buildId: 'old' }),
    'PUT /environments/default': (req) => json(200, { defaultEnvironmentId: (req.body as { environmentId: string }).environmentId }),
    [`DELETE /environments/${ENV_ID}`]: () => new Response(null, { status: 204 }),
    'GET /environments/gone': () => json(404, { status: 404, title: 'Not Found', detail: 'Environment not found' }),
  });
  await s.feature.poll(s.api);
  const id = { id: ENV_ID };

  const patch = s.route('PATCH', '/:id');
  await assert.rejects(() => patch(id, {}), /Nothing to change/);
  await assert.rejects(() => patch(id, { name: 'droid-office-default' }), /Nothing to change/, 'the same name is no change');
  assert.deepEqual(await patch(id, { setupScript: 'echo hi', repositories: [{ url: 'nikships/droid-office', script: 'npm ci' }] }), { buildId: 'b9' });
  assert.deepEqual(s.seen.at(-1)?.body, { repositories: [{ url: 'https://github.com/nikships/droid-office', script: 'npm ci' }], setupScript: 'echo hi' });
  assert.match(s.toasts.at(-1)!, /building it again/);
  assert.deepEqual(await patch(id, { name: 'office-env' }), { buildId: null });
  assert.deepEqual(await patch(id, { setupScript: null }), { buildId: 'b9' });
  await assert.rejects(() => patch({ id: 'gone' }, { name: 'x' }), /No such Environment|not found/);

  assert.deepEqual(await s.route('POST', '/:id/rebuild')(id), { buildId: 'b10' });
  await assert.rejects(() => s.route('POST', '/:id/cancel')(id), /isn’t building/);
  latest = 'building';
  await s.feature.poll(s.api);
  await assert.rejects(() => s.route('POST', '/:id/rebuild')(id), /building already/);
  assert.deepEqual(await s.route('POST', '/:id/cancel')(id), { cancelled: '25128393-78d5-4841-a8db-2c2c442f9bc0' });

  assert.equal(((await s.route('GET', '/:id/log')(id)) as { log: { excerpt: string } }).log.excerpt, REAL_LOG.excerpt);
  assert.equal(((await s.route('GET', '/:id/log')(id, {}, 'build=old')) as { log: { buildId: string } }).log.buildId, 'old');

  const def = s.route('PUT', '/default');
  await assert.rejects(() => def({}, { environmentId: 'nope' }), /No such Environment/);
  assert.deepEqual(await def({}, { environmentId: ENV_ID }), { defaultId: ENV_ID });
  assert.equal(s.feature.state().items[0].isDefault, true);

  const del = s.route('DELETE', '/:id');
  await assert.rejects(() => del(id, { confirm: 'droid-office' }), /Type the Environment’s name, droid-office-default/);
  assert.deepEqual(await del(id, { confirm: 'droid-office-default' }), { deleted: ENV_ID });
  assert.deepEqual(s.feature.state().items, []);
  assert.equal(s.feature.state().defaultId, undefined);
  assert.match(s.toasts.at(-1)!, /deleted the Environment droid-office-default/);
  assert.ok(s.soon() > 0);
});
