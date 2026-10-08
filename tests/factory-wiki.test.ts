import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { FactoryApi } from '../src/server/factory/api.js';
import type { FactoryRequest, FeatureHost } from '../src/server/factory/feature.js';
import { FactoryDownload } from '../src/server/factory/feature.js';
import { WikiFeature } from '../src/server/factory/wiki.js';
import { WIKI_WORKTREE, WikiRunner, parseDroidModels, readWikiEvent, wikiRunSettings, type WikiFloorDef } from '../src/server/factory/wiki-run.js';
import { isModelId, flattenWiki, resolveWikiLink, sameRepo, wikiHitOf, wikiNodeOf, wikiPageOf, wikiRepoOf, wikiRunDetailOf, wikiRunOf, wikiShelfLine, type FactoryWikiJob, type FactoryWikiNode } from '../src/shared/factory-wiki.js';

const KEY = 'fk-test-wiki-5678';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Factory as the feature sees it: an answer per path (as the server got it, still encoded). */
function factory(routes: Record<string, Handler>) {
  const seen: string[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    seen.push(`${init.method ?? 'GET'} ${url.pathname}${url.search}`);
    const r = routes[`${init.method ?? 'GET'} ${url.pathname}`] ?? routes[url.pathname];
    return r ? r(url, init) : json(404, { detail: `no ${url.pathname}` });
  }) as typeof fetch;
  return { api: new FactoryApi(KEY, fn), fn, seen };
}

function host() {
  const h = { changes: 0, polls: 0, toasts: [] as string[] };
  const fh: FeatureHost = {
    changed: () => h.changes++,
    pollSoon: () => h.polls++,
    api: () => undefined,
    toast: (t) => h.toasts.push(t),
  };
  return { ...h, fh, get: () => h };
}

/** A route of the feature, called as the registry would. */
function call(feature: WikiFeature, api: FactoryApi, method: string, p: string, opts: { query?: string; body?: unknown } = {}) {
  for (const r of feature.routes) {
    if (r.method !== method) continue;
    const want = r.path.split('/').filter(Boolean);
    const got = p.split('/').filter(Boolean);
    if (want.length !== got.length) continue;
    const params: Record<string, string> = {};
    if (!want.every((w, i) => (w.startsWith(':') ? ((params[w.slice(1)] = decodeURIComponent(got[i])), true) : w === got[i]))) continue;
    const req: FactoryRequest = { method, path: p, params, query: new URLSearchParams(opts.query ?? ''), json: async <T>() => (opts.body ?? {}) as T, api, by: 'Olive' };
    return Promise.resolve().then(() => r.handle(req));
  }
  throw new Error(`no route ${method} ${p}`);
}

const until = async (ok: () => boolean, what = 'the condition') => {
  for (let i = 0; i < 200; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
};

const node = (pageId: string, p: string, order: number, children: FactoryWikiNode[] = []): FactoryWikiNode => ({ pageId, title: pageId, path: p, order, children });

const TREE = [node('overview', 'overview', 0, [node('arch', 'overview/architecture', 1), node('start', 'overview/getting-started', 0)]), node('systems', 'systems', 1, [node('terms', 'systems/terminals', 0)])];

const RUN = {
  wikiRunId: 'run-1',
  createdAt: 1791000000000,
  sourceSessionId: 'sess-1',
  repoUrl: 'https://github.com/o/r',
  commitHash: 'abcdef0123456789',
  branch: 'main',
  hasLocalChanges: false,
  hasNonRemoteCommits: false,
  modelUsed: { id: 'claude-opus', reasoningEffort: 'high' },
  droidVersion: '0.80.0',
  privacyLevel: 'organization',
  canUpdatePrivacy: true,
  pageCount: 4,
};

test('shared: runs, trees, pages and hits parse, and skip what isn’t there', () => {
  const run = wikiRunOf(RUN);
  assert.deepEqual(run, {
    id: 'run-1',
    repoUrl: 'https://github.com/o/r',
    repo: 'o/r',
    createdAt: 1791000000000,
    pageCount: 4,
    commitHash: 'abcdef0123456789',
    branch: 'main',
    hasLocalChanges: false,
    hasNonRemoteCommits: false,
    privacyLevel: 'organization',
    canUpdatePrivacy: true,
    model: 'claude-opus',
    droidVersion: '0.80.0',
    sessionId: 'sess-1',
  });
  assert.equal(wikiRunOf({ id: 'x', modelUsed: 'm', privacyLevel: 'public', createdAt: '2026-10-01T00:00:00Z' })?.model, 'm');
  assert.equal(wikiRunOf({ id: 'x', privacyLevel: 'public' })?.privacyLevel, undefined);
  assert.equal(wikiRunOf({ id: 'x', createdAt: 'never' })?.createdAt, 0);
  assert.equal(wikiRunOf('nope'), undefined);

  const detail = wikiRunDetailOf({ ...RUN, pageTree: [{ pageId: 'b', path: 'b', order: 2 }, { pageId: 'a', path: 'x/a', order: 1, children: [{ pageId: 'c', order: 1 }, { pageId: 'd', order: 0 }, 'junk'] }, { title: 'no id' }] });
  assert.deepEqual(
    detail?.pageTree.map((n) => [n.pageId, n.title, n.children.map((c) => c.pageId)]),
    [
      ['a', 'a', ['d', 'c']],
      ['b', 'b', []],
    ],
  );
  assert.equal(wikiRunDetailOf({ ...RUN, pageTree: 'no' })?.pageTree.length, 0);
  assert.equal(wikiRunDetailOf(null), undefined);
  let deep: unknown = { pageId: 'leaf' };
  for (let i = 0; i < 12; i++) deep = { pageId: `n${i}`, children: [deep] };
  const depth = flattenWiki([wikiNodeOf(deep) as FactoryWikiNode]).length;
  assert.equal(depth, 9, 'a tree deeper than 8 is cut');
  assert.equal(wikiNodeOf(null), undefined);

  assert.deepEqual(wikiPageOf({ pageId: 'p', path: 'a/b', content: '# Hi', order: 3 }), { pageId: 'p', path: 'a/b', title: 'a/b', content: '# Hi', order: 3 });
  assert.equal(wikiPageOf({ path: 'x' }), undefined);
  assert.equal(wikiPageOf(4), undefined);
  assert.deepEqual(wikiHitOf({ pageId: 'p', snippet: 'a <b>', matchCount: 2.4 }), { pageId: 'p', title: 'p', path: '', snippet: 'a <b>', matchCount: 2 });
  assert.equal(wikiHitOf({}), undefined);
  assert.equal(wikiHitOf(null), undefined);
});

test('shared: which repositories can have one, and the same repository however it’s written', () => {
  assert.deepEqual(wikiRepoOf('o/r'), { repoUrl: 'https://github.com/o/r' });
  assert.deepEqual(wikiRepoOf('gitlab.com/g/p'), { repoUrl: 'https://gitlab.com/g/p' });
  assert.ok('why' in wikiRepoOf(undefined));
  assert.ok(sameRepo('https://github.com/O/R.git', 'git@github.com:o/r.git'));
  assert.ok(!sameRepo('https://github.com/o/r', 'https://github.com/o/other'));
  assert.ok(!sameRepo(undefined, 'o/r'));
});

test('shared: links between pages resolve as Markdown files would', () => {
  const at = (from: string, href: string) => resolveWikiLink(TREE, from, href);
  assert.deepEqual(at('overview/architecture', 'getting-started.md'), { pageId: 'start', hash: '' });
  assert.deepEqual(at('overview/architecture', '../systems/terminals.md#pty-host'), { pageId: 'terms', hash: 'pty-host' });
  assert.deepEqual(at('overview', 'architecture.md'), { pageId: 'arch', hash: '' }, 'a section’s links start from its own folder');
  assert.deepEqual(at('overview', '../systems/index.md'), { pageId: 'systems', hash: '' });
  assert.deepEqual(at('systems/terminals', '/overview/architecture'), { pageId: 'arch', hash: '' });
  assert.deepEqual(at('systems/terminals', 'arch'), { pageId: 'arch', hash: '' });
  assert.deepEqual(at('systems/terminals', '#top'), { pageId: 'terms', hash: 'top' });
  assert.deepEqual(at('systems/terminals', './terminals.md?x=1'), { pageId: 'terms', hash: '' });
  assert.equal(at('systems/terminals', 'https://example.com'), undefined);
  assert.equal(at('systems/terminals', '//cdn.example.com/x'), undefined);
  assert.equal(at('systems/terminals', 'mailto:a@b'), undefined);
  assert.equal(at('systems/terminals', '../../../../nowhere.md'), undefined);
  assert.equal(at('systems/terminals', '%E0%A4%A'), undefined);
  assert.equal(at('nowhere', '#x'), undefined);
});

test('shared: the line at the bookshelf', () => {
  const run = wikiRunOf(RUN);
  assert.equal(wikiShelfLine(undefined), 'Generate AutoWiki');
  assert.equal(wikiShelfLine({ history: [], fetchedAt: 0, why: 'no remote' }), '');
  assert.equal(wikiShelfLine({ history: [], fetchedAt: 0, latest: run }), 'AutoWiki: 4 pages');
  assert.equal(wikiShelfLine({ history: [], fetchedAt: 0, latest: run && { ...run, pageCount: 1 } }), 'AutoWiki: 1 page');
  assert.equal(wikiShelfLine({ history: [], fetchedAt: 0, latest: run, job: { state: 'running', by: 'O', startedAt: 1, lines: [] } }), 'AutoWiki: writing…');
  assert.equal(wikiShelfLine({ history: [], fetchedAt: 0, latest: run, job: { state: 'failed', by: 'O', startedAt: 1, lines: [] } }), 'AutoWiki: 4 pages');
});

test('readWikiEvent: what a stream-json line shows, and the session and run it names', () => {
  assert.deepEqual(readWikiEvent(''), { lines: [] });
  assert.deepEqual(readWikiEvent('{"type":"system","session_id":"s-1"}'), { lines: [], sessionId: 's-1' });
  assert.deepEqual(readWikiEvent(JSON.stringify({ type: 'tool_call', toolName: 'Read', parameters: { file_path: 'src/a.ts' } })).lines, ['Read src/a.ts']);
  assert.deepEqual(readWikiEvent(JSON.stringify({ type: 'tool_call', toolId: 'Glob' })).lines, ['Glob']);
  const long = readWikiEvent(JSON.stringify({ type: 'tool_call', toolName: 'Execute', parameters: { command: 'x'.repeat(500) } })).lines[0];
  assert.equal(long.length, 240);
  assert.ok(long.endsWith('…'));
  const up = readWikiEvent(JSON.stringify({ type: 'tool_result', value: 'Uploaded.\nWiki run ID: wr_abc123' }));
  assert.equal(up.runId, 'wr_abc123');
  assert.deepEqual(up.lines, ['Uploaded wiki run wr_abc123']);
  assert.deepEqual(readWikiEvent(JSON.stringify({ type: 'tool_result', isError: true, value: '\nboom\nmore' })).lines, ['✗ boom']);
  assert.deepEqual(readWikiEvent(JSON.stringify({ type: 'tool_result', is_error: true, content: { a: 1 } })).lines, ['✗ {"a":1}']);
  assert.deepEqual(readWikiEvent(JSON.stringify({ type: 'tool_result', value: 'fine' })).lines, []);
  assert.deepEqual(readWikiEvent(JSON.stringify({ type: 'message', role: 'assistant', text: '\nWriting the overview.\nMore.' })).lines, ['Writing the overview.']);
  assert.deepEqual(readWikiEvent(JSON.stringify({ type: 'message', role: 'user', text: '/wiki' })).lines, []);
  const done = readWikiEvent(JSON.stringify({ type: 'completion', finalText: 'Done: https://app.factory.ai/wiki/wr_xyz789' }));
  assert.equal(done.runId, 'wr_xyz789');
  assert.deepEqual(done.lines, ['Done: https://app.factory.ai/wiki/wr_xyz789']);
  assert.deepEqual(readWikiEvent(JSON.stringify({ type: 'error', message: 'rate limited' })), { lines: ['✗ rate limited'], error: true });
  assert.deepEqual(readWikiEvent('plain text, Wiki run ID: wr_plain1'), { lines: ['plain text, Wiki run ID: wr_plain1'], runId: 'wr_plain1' });
  assert.deepEqual(readWikiEvent('42'), { lines: ['42'] });
  assert.deepEqual(readWikiEvent(JSON.stringify({ type: 'other' })), { lines: [] });
});

/** Floors in a temp dir: one on GitHub, one with no remote. */
function floors(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'factory-wiki-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const make = (id: string, repo?: string): WikiFloorDef => {
    const d = path.join(dir, id);
    mkdirSync(path.join(d, '.droid-office'), { recursive: true });
    return { id, dir: d, name: id === 'main' ? 'Main' : 'Home', ...(repo ? { repo } : {}) };
  };
  return [make('main', 'o/r'), make('home')];
}

test('wiki: polls the runs and each floor’s history by its full, encoded repository URL', async (t) => {
  const list = floors(t);
  let historyFails = false;
  const f = factory({
    '/api/v0/wiki': () => json(200, { wikiRuns: [{ ...RUN, wikiRunId: 'old', createdAt: 1 }, RUN, { ...RUN, wikiRunId: 'elsewhere', repoUrl: 'https://github.com/x/y' }, { nope: 1 }] }),
    '/api/v0/wiki/history/https%3A%2F%2Fgithub.com%2Fo%2Fr': () => (historyFails ? json(500, { detail: 'history down' }) : json(200, { wikiRuns: [RUN, { ...RUN, wikiRunId: 'run-0', createdAt: 5 }] })),
  });
  const h = host();
  let now = 100;
  const feature = new WikiFeature(h.fh, { floors: () => list, now: () => now });
  assert.equal(feature.busy(), false);
  await feature.poll(f.api);
  assert.ok(f.seen.includes('GET /api/v0/wiki/history/https%3A%2F%2Fgithub.com%2Fo%2Fr'));
  const s = feature.state();
  assert.deepEqual(
    s.runs.map((r) => r.id),
    ['run-1', 'elsewhere', 'old'],
  );
  assert.equal(s.fetchedAt, 100);
  assert.equal(s.error, undefined);
  assert.equal(s.floors.main.latest?.id, 'run-1');
  assert.equal(s.floors.main.repoUrl, 'https://github.com/o/r');
  assert.deepEqual(
    s.floors.main.history.map((r) => r.id),
    ['run-1', 'run-0'],
  );
  assert.equal(s.floors.main.fetchedAt, 100);
  assert.ok(s.floors.home.why);
  assert.equal(s.floors.home.latest, undefined);

  historyFails = true;
  now = 200;
  await feature.poll(f.api);
  assert.match(feature.state().error ?? '', /history of Main: history down/);
  assert.equal(feature.state().floors.main.history.length, 2, 'the last history is kept');

  const rejected = factory({
    '/api/v0/wiki': () => json(200, { wikiRuns: [RUN] }),
    '/api/v0/wiki/history/https%3A%2F%2Fgithub.com%2Fo%2Fr': () => json(401, { detail: 'bad key' }),
  });
  await assert.rejects(
    () => feature.poll(rejected.api),
    (e: { status?: number }) => e.status === 401,
  );

  feature.reset();
  assert.deepEqual(feature.state().runs, []);
  assert.equal(feature.state().floors.main.history.length, 0);
});

test('wiki: a floor without a run skips its history until asked', async (t) => {
  const list = floors(t);
  const f = factory({
    '/api/v0/wiki': () => json(200, { wikiRuns: [] }),
    '/api/v0/wiki/history/https%3A%2F%2Fgithub.com%2Fo%2Fr': () => json(200, { wikiRuns: [] }),
  });
  const h = host();
  const feature = new WikiFeature(h.fh, { floors: () => list, now: () => 7 });
  await feature.poll(f.api);
  assert.ok(!f.seen.some((s) => s.includes('/history/')));
  const floor = (await call(feature, f.api, 'GET', '/floor', { query: 'floor=main' })) as { history: unknown[]; fetchedAt: number; repoUrl: string };
  assert.deepEqual(floor, { history: [], fetchedAt: 7, repoUrl: 'https://github.com/o/r' });
  assert.ok(f.seen.some((s) => s.includes('/history/')));
  await assert.rejects(() => call(feature, f.api, 'GET', '/floor', { query: 'floor=nope' }), /No such floor/);
  await assert.rejects(() => call(feature, f.api, 'GET', '/floor'), /No such floor/);
  // A repository Factory's integration doesn't cover answers 403: the floor says so, the read didn't fail.
  const denied = factory({ '/api/v0/wiki/history/https%3A%2F%2Fgithub.com%2Fo%2Fr': () => json(403, { detail: 'You do not have access to this repository', status: 403 }) });
  const blocked = (await call(feature, denied.api, 'GET', '/floor', { query: 'floor=main' })) as { noAccess?: string; history: unknown[] };
  assert.equal(blocked.noAccess, 'You do not have access to this repository');
  assert.deepEqual(blocked.history, []);
  const broken = factory({ '/api/v0/wiki/history/https%3A%2F%2Fgithub.com%2Fo%2Fr': () => json(500, { detail: 'down' }) });
  await assert.rejects(() => call(feature, broken.api, 'GET', '/floor', { query: 'floor=main' }), /down/);
  // home has no remote: asking reads nothing.
  const before = f.seen.length;
  assert.ok(((await call(feature, f.api, 'GET', '/floor', { query: 'floor=home' })) as { why?: string }).why);
  assert.equal(f.seen.length, before);
});

test('wiki: runs, pages and searches are read on demand and cached; privacy and delete change the slice', async (t) => {
  const list = floors(t);
  const bodies: unknown[] = [];
  const f = factory({
    '/api/v0/wiki': () => json(200, { wikiRuns: [RUN] }),
    '/api/v0/wiki/history/https%3A%2F%2Fgithub.com%2Fo%2Fr': () => json(200, { wikiRuns: [RUN] }),
    '/api/v0/wiki/run-1': () => json(200, { ...RUN, pageTree: TREE }),
    '/api/v0/wiki/empty': () => json(200, null),
    '/api/v0/wiki/run-1/pages/arch': () => json(200, { pageId: 'arch', path: 'overview/architecture', title: 'Architecture', content: '# A', order: 1 }),
    '/api/v0/wiki/run-1/pages/blank': () => json(200, {}),
    '/api/v0/wiki/run-1/search': (url) => json(200, { results: [{ pageId: 'arch', title: 'Architecture', snippet: url.searchParams.get('q'), matchCount: Number(url.searchParams.get('limit')) }, { bad: 1 }] }),
    '/api/v0/wiki/run-1/privacy': async (_u, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return json(200, { ok: true });
    },
    'DELETE /api/v0/wiki/run-1': () => json(200, { deleted: true }),
    '/api/v0/wiki/upload-access': (url) => json(200, { allowed: url.searchParams.get('repoUrl') === 'https://github.com/o/r' }),
  });
  const h = host();
  const feature = new WikiFeature(h.fh, { floors: () => list });
  await feature.poll(f.api);

  const run = (await call(feature, f.api, 'GET', '/runs/run-1')) as { pageTree: FactoryWikiNode[]; repo: string };
  assert.equal(run.repo, 'o/r');
  assert.deepEqual(
    run.pageTree[0].children.map((c) => c.pageId),
    ['start', 'arch'],
  );
  const asked = f.seen.length;
  await call(feature, f.api, 'GET', '/runs/run-1');
  assert.equal(f.seen.length, asked, 'a run’s tree is cached');
  await assert.rejects(() => call(feature, f.api, 'GET', '/runs/empty'), /no run/);

  const page = (await call(feature, f.api, 'GET', '/runs/run-1/pages/arch')) as { title: string };
  assert.equal(page.title, 'Architecture');
  await call(feature, f.api, 'GET', '/runs/run-1/pages/arch');
  assert.equal(f.seen.filter((s) => s.includes('/pages/arch')).length, 1, 'a page is cached');
  await assert.rejects(() => call(feature, f.api, 'GET', '/runs/run-1/pages/blank'), /no page/);

  const hits = (await call(feature, f.api, 'GET', '/runs/run-1/search', { query: 'q=%20queue%20&limit=500' })) as { results: { snippet: string; matchCount: number }[] };
  assert.deepEqual(
    hits.results.map((r) => [r.snippet, r.matchCount]),
    [['queue', 30]],
  );
  await assert.rejects(() => call(feature, f.api, 'GET', '/runs/run-1/search', { query: 'q=%20' }), /Say what to look for/);

  assert.deepEqual(await call(feature, f.api, 'GET', '/upload-access', { query: 'repoUrl=https://github.com/o/r' }), { allowed: true });
  await assert.rejects(() => call(feature, f.api, 'GET', '/upload-access'), /Say which repository/);

  await assert.rejects(() => call(feature, f.api, 'POST', '/runs/run-1/privacy', { body: { privacyLevel: 'public' } }), /privacyLevel is one of/);
  const polls = h.get().polls;
  assert.deepEqual(await call(feature, f.api, 'POST', '/runs/run-1/privacy', { body: { privacyLevel: 'private' } }), { privacyLevel: 'private' });
  assert.deepEqual(bodies, [{ privacyLevel: 'private' }]);
  assert.equal(feature.state().runs[0].privacyLevel, 'private');
  assert.equal(feature.state().floors.main.history[0].privacyLevel, 'private');
  assert.equal(h.get().polls, polls + 1);
  assert.match(h.get().toasts.at(-1) ?? '', /Olive made the AutoWiki private/);

  assert.deepEqual(await call(feature, f.api, 'DELETE', '/runs/run-1'), { deleted: true });
  assert.deepEqual(feature.state().runs, []);
  assert.deepEqual(feature.state().floors.main.history, []);
  assert.match(h.get().toasts.at(-1) ?? '', /Olive deleted an AutoWiki run/);
  await call(feature, f.api, 'GET', '/runs/run-1/pages/arch');
  assert.equal(f.seen.filter((s) => s.includes('/pages/arch')).length, 2, 'a deleted run’s pages are forgotten');
});

const collect = async (d: FactoryDownload) => {
  const parts: Buffer[] = [];
  for await (const c of d.body as AsyncIterable<Uint8Array>) parts.push(Buffer.from(c));
  return Buffer.concat(parts).toString();
};

test('wiki: the export streams the .zip, follows a link or redirect to it without the key, and says why it failed', async (t) => {
  const list = floors(t);
  const auth: (string | null)[] = [];
  let answer: () => Response = () => new Response('PK-zip', { status: 200, headers: { 'content-type': 'application/zip', 'content-length': '6' } });
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    auth.push(new Headers(init.headers).get('authorization'));
    if (url.host === 'storage.test') return new Response(`zip from ${url.pathname}`, { status: url.pathname === '/gone' ? 410 : 200, headers: { 'content-type': 'application/octet-stream' } });
    if (url.pathname === '/api/v0/wiki/run-1/export') return answer();
    return json(404, { detail: 'no' });
  }) as typeof fetch;
  const f = factory({ '/api/v0/wiki': () => json(200, { wikiRuns: [RUN] }), '/api/v0/wiki/history/https%3A%2F%2Fgithub.com%2Fo%2Fr': () => json(200, { wikiRuns: [] }) });
  let key: string | undefined = KEY;
  const feature = new WikiFeature(host().fh, { floors: () => list, key: () => key, fetchImpl, base: 'https://factory.test' });
  await feature.poll(f.api);

  const d = (await call(feature, f.api, 'GET', '/runs/run-1/export')) as FactoryDownload;
  assert.ok(d instanceof FactoryDownload);
  assert.equal(d.filename, 'o-r-wiki-abcdef0.zip');
  assert.equal(d.type, 'application/zip');
  assert.equal(d.size, 6);
  assert.equal(await collect(d), 'PK-zip');
  assert.deepEqual(auth, [`Bearer ${KEY}`]);

  auth.length = 0;
  answer = () => json(200, { url: 'https://storage.test/signed' });
  assert.equal(await collect((await call(feature, f.api, 'GET', '/runs/run-1/export')) as FactoryDownload), 'zip from /signed');
  assert.deepEqual(auth, [`Bearer ${KEY}`, null], 'the signed link is fetched without the key');

  auth.length = 0;
  answer = () => new Response(null, { status: 302, headers: { location: 'https://storage.test/redirected' } });
  assert.equal(await collect((await call(feature, f.api, 'GET', '/runs/run-1/export')) as FactoryDownload), 'zip from /redirected');
  assert.deepEqual(auth, [`Bearer ${KEY}`, null]);

  answer = () => json(200, { url: 'http://insecure.test/x' });
  await assert.rejects(() => call(feature, f.api, 'GET', '/runs/run-1/export'), /no export to download/);
  answer = () => json(200, { url: 'https://storage.test/gone' });
  await assert.rejects(() => call(feature, f.api, 'GET', '/runs/run-1/export'), /download answered 410/);
  answer = () => json(404, { detail: `Run not found for ${KEY}` });
  await assert.rejects(
    () => call(feature, f.api, 'GET', '/runs/run-1/export'),
    (e: Error & { status?: number }) => e.status === 404 && /Run not found/.test(e.message) && !e.message.includes(KEY),
  );
  answer = () => new Response('<html>', { status: 503 });
  await assert.rejects(() => call(feature, f.api, 'GET', '/runs/run-1/export'), /Factory answered 503 for the export/);
  answer = () => {
    throw new Error(`socket closed ${KEY}`);
  };
  await assert.rejects(
    () => call(feature, f.api, 'GET', '/runs/run-1/export'),
    (e: Error) => /Couldn’t reach Factory/.test(e.message) && !e.message.includes(KEY),
  );
  key = undefined;
  await assert.rejects(() => call(feature, f.api, 'GET', '/runs/run-1/export'), /key isn’t usable/);
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  out(text: string) {
    this.stdout.emit('data', Buffer.from(text));
  }
}

/** What `droid exec --help` prints about its models, cut down. */
const HELP = `Usage: droid exec [options] [prompt]

Options:
  -m, --model <id>            Model ID to use (default: gpt-6-sol)

Available Models:
  auto                                           Auto Model
  gpt-6-sol                                      GPT-6 Sol (default)
  glm-5.3-flash                                  GLM-5.3-Flash
  minimax-m2.7                                   MiniMax M2.7 [Deprecated]

Custom Models:
  custom:proxy:gemini-3.1-pro                    Proxy: Gemini 3.1 Pro (High)

Model details:
  - Auto Model: supports reasoning: No; supported: [none]; default: none
  - GPT-6 Sol: supports reasoning: Yes; supported: [none, low, medium, high, xhigh, max]; default: medium
  - GLM-5.3-Flash: supports reasoning: Yes; supported: [low, high, max]; default: high
`;

/** A runner's world: git and Droid stubbed, every spawn and signal written down. */
function rig(t: { after(fn: () => void): void }, over: { platform?: NodeJS.Platform; command?: string | null; gitFails?: string; isWikiProcess?: boolean; help?: () => Promise<string> } = {}) {
  const list = floors(t);
  const spawned: { command: string; args: readonly string[]; options: Record<string, unknown>; child: FakeChild }[] = [];
  const kills: [number, string][] = [];
  const git: string[][] = [];
  const changes: string[] = [];
  const ends: FactoryWikiJob[] = [];
  const officeEnv = { PATH: '/usr/bin', HOME: '/home/o' };
  const opts = {
    command: () => (over.command === undefined ? '/usr/local/bin/droid' : over.command),
    env: () => officeEnv,
    spawn: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      const child = new FakeChild();
      spawned.push({ command, args, options, child });
      return child as unknown as ChildProcess;
    }) as never,
    git: async (args: string[], cwd: string) => {
      git.push(args);
      if (over.gitFails && args[0] === over.gitFails) throw new Error(`${args[0]} failed`);
      if (args[0] === 'rev-parse' && args.includes('origin/HEAD')) return 'origin/main';
      if (args[0] === 'rev-parse' && args.includes('--short')) return 'e05ddc1';
      if (args[0] === 'worktree' && args[1] === 'add') mkdirSync(args[4], { recursive: true });
      return cwd ? '' : '';
    },
    help: over.help ?? (async () => HELP),
    killTree: (pid: number, signal: NodeJS.Signals) => kills.push([pid, signal]),
    isWikiProcess: () => over.isWikiProcess ?? true,
    now: () => 1000,
    graceMs: 20,
    platform: over.platform ?? ('linux' as NodeJS.Platform),
  };
  return { list, spawned, kills, git, changes, ends, officeEnv, opts };
}

test('runner: runs /wiki in a fresh worktree with the key only in the child’s environment, and never shows it', async (t) => {
  const r = rig(t);
  const runner = new WikiRunner({ ...r.opts, onChange: (_f, what) => r.changes.push(what), onEnd: (_f, job) => r.ends.push(job) });
  const main = r.list[0];
  const job = runner.start(main, 'Olive', KEY);
  assert.equal(job.state, 'starting');
  assert.equal(runner.busy(), true);
  await until(() => r.spawned.length === 1, 'the spawn');
  const s = r.spawned[0];
  const worktree = path.join(main.dir, '.droid-office', WIKI_WORKTREE);
  const settings = path.join(main.dir, '.droid-office', 'wiki-run-settings.json');
  assert.equal(s.command, '/usr/local/bin/droid');
  assert.deepEqual(s.args, ['exec', '--auto', 'high', '-m', 'glm-5.3-flash', '--settings', settings, '--output-format', 'stream-json', '--tag', 'droid-office-wiki', '--cwd', worktree, '/wiki']);
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), { subagentModelSettings: { lightModel: 'glm-5.3-flash', mediumModel: 'glm-5.3-flash', heavyModel: 'glm-5.3-flash' } });
  assert.equal(job.model, 'glm-5.3-flash');
  assert.equal(s.options.cwd, worktree);
  assert.deepEqual(s.options.env, { PATH: '/usr/bin', HOME: '/home/o', FACTORY_API_KEY: KEY });
  assert.equal((r.officeEnv as Record<string, string>).FACTORY_API_KEY, undefined, 'the office’s own environment is untouched');
  assert.equal(s.options.detached, true);
  assert.equal(s.options.shell, false);
  assert.deepEqual(r.git[0], ['fetch', '--quiet', 'origin']);
  assert.ok(r.git.some((g) => g.join(' ') === `worktree add --detach --force ${worktree} origin/main`));
  const marker = JSON.parse(readFileSync(path.join(main.dir, '.droid-office', 'wiki-run.json'), 'utf8'));
  assert.deepEqual(marker, { pid: 4242, startedAt: 1000, by: 'Olive', model: 'glm-5.3-flash', modelName: 'glm-5.3-flash' });
  assert.equal(runner.job('main')?.state, 'running');
  assert.equal(runner.job('main')?.commit, 'e05ddc1');

  assert.throws(
    () => runner.start(main, 'Pat', KEY),
    (e: Error & { status?: number }) => e.status === 409 && /already running for Main, started by Olive/.test(e.message),
  );

  s.child.out(`{"type":"system","session_id":"sess-9"}\n{"type":"tool_call","toolName":"Execute","parameters":{"command":"echo ${KEY}"}}\nhalf a li`);
  s.child.stderr.emit('data', Buffer.from(`ne ${KEY}\n`));
  const now = runner.job('main');
  assert.equal(now?.sessionId, 'sess-9');
  assert.ok(now?.lines.some((l) => l.startsWith('Execute echo')));
  assert.ok(now?.lines.includes('half a line [redacted]') || now?.lines.some((l) => l.startsWith('half a line') && !l.includes(KEY)));
  assert.ok(!JSON.stringify(now).includes(KEY), 'the key never reaches a line');
  assert.ok(r.changes.includes('lines'));

  s.child.out('{"type":"completion","finalText":"Wiki run ID: wr_done42"}');
  s.child.emit('close', 0, null);
  const done = runner.job('main');
  assert.equal(done?.state, 'done');
  assert.equal(done?.runId, 'wr_done42');
  assert.equal(done?.endedAt, 1000);
  assert.equal(done?.lines.at(-1), 'Done: the wiki is uploaded.');
  assert.equal(runner.busy(), false);
  assert.equal(r.ends.length, 1);
  s.child.emit('close', 0, null);
  assert.equal(r.ends.length, 1, 'a run ends once');
  assert.ok(!existsSync(path.join(main.dir, '.droid-office', 'wiki-run.json')), 'the marker goes when it ends');
  assert.ok(!existsSync(settings), 'so do its settings');
  await until(() => !existsSync(worktree), 'the worktree to go');
});

test('runner: a non-zero exit fails with its last lines; a spawn error fails too', async (t) => {
  const r = rig(t);
  const runner = new WikiRunner({ ...r.opts, onChange: () => {}, onEnd: (_f, job) => r.ends.push(job) });
  runner.start(r.list[0], 'Olive', KEY);
  await until(() => r.spawned.length === 1);
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  r.spawned[0].child.out(`${lines.join('\n')}\n`);
  r.spawned[0].child.emit('close', 2, null);
  const failed = runner.job('main');
  assert.equal(failed?.state, 'failed');
  const err = failed?.error?.split('\n') ?? [];
  assert.equal(err[0], '/wiki didn’t finish: it exited with 2.');
  assert.equal(err.length, 21);
  assert.equal(err.at(-1), 'line 29');
  assert.equal(err[1], 'line 10');

  runner.start(r.list[0], 'Olive', KEY);
  await until(() => r.spawned.length === 2);
  r.spawned[1].child.emit('close', null, 'SIGSEGV');
  assert.match(runner.job('main')?.error ?? '', /it was stopped \(SIGSEGV\)/);

  runner.start(r.list[0], 'Olive', KEY);
  await until(() => r.spawned.length === 3);
  r.spawned[2].child.emit('error', new Error(`ENOENT ${KEY}`));
  r.spawned[2].child.emit('close', -2, null);
  const errored = runner.job('main');
  assert.equal(errored?.state, 'failed');
  assert.match(errored?.error ?? '', /Couldn’t run droid: ENOENT/);
  assert.ok(!errored?.error?.includes(KEY));
  assert.equal(r.ends.length, 3);
});

test('runner: cancel sends SIGTERM to the tree, then SIGKILL; a cancel before the spawn never spawns', async (t) => {
  const r = rig(t);
  const runner = new WikiRunner({ ...r.opts, onChange: () => {} });
  assert.equal(runner.cancel('main', 'Olive'), false);
  runner.start(r.list[0], 'Olive', KEY);
  await until(() => r.spawned.length === 1);
  assert.equal(runner.cancel('main', 'Pat'), true);
  assert.deepEqual(r.kills, [[4242, 'SIGTERM']]);
  assert.equal(runner.job('main')?.lines.at(-1), 'Stopping (Pat)…');
  await until(() => r.kills.length === 2, 'the SIGKILL');
  assert.deepEqual(r.kills[1], [4242, 'SIGKILL']);
  r.spawned[0].child.emit('close', null, 'SIGKILL');
  assert.equal(runner.job('main')?.state, 'cancelled');
  assert.equal(runner.job('main')?.lines.at(-1), 'Stopped.');
  assert.equal(runner.cancel('main', 'Olive'), false, 'nothing left to stop');

  // Cancelled while still fetching: it ends there.
  runner.start(r.list[0], 'Olive', KEY);
  assert.equal(runner.cancel('main', 'Olive'), true);
  await until(() => runner.job('main')?.state === 'cancelled', 'the cancel');
  assert.equal(r.spawned.length, 1);

  // Stopping the office kills what's running, and leaves its marker and worktree for the next office.
  runner.start(r.list[0], 'Olive', KEY);
  await until(() => r.spawned.length === 2);
  r.kills.length = 0;
  runner.stopAll();
  assert.deepEqual(r.kills, [[4242, 'SIGKILL']]);
  r.spawned[1].child.emit('close', null, 'SIGKILL');
  const main = r.list[0];
  const marker = path.join(main.dir, '.droid-office', 'wiki-run.json');
  assert.ok(existsSync(marker), 'the marker stays, so the run isn’t a silent failure');
  assert.equal(runner.job('main')?.state, 'running');
  const again = rig(t, { isWikiProcess: false });
  const next = new WikiRunner({ ...again.opts, onChange: () => {} });
  next.adopt(main);
  assert.equal(next.job('main')?.state, 'lost');
  assert.equal(next.job('main')?.by, 'Olive');
});

test('runner: a run the last office left behind is lost, killed and cleaned up', async (t) => {
  const r = rig(t);
  const main = r.list[0];
  const data = path.join(main.dir, '.droid-office');
  writeFileSync(path.join(data, 'wiki-run.json'), JSON.stringify({ pid: 999, startedAt: 50, by: 'Pat', model: 'glm-5.3-flash', modelName: 'GLM-5.3-Flash' }));
  writeFileSync(path.join(data, 'wiki-run-settings.json'), '{}');
  mkdirSync(path.join(data, WIKI_WORKTREE));
  const changes: string[] = [];
  const runner = new WikiRunner({ ...r.opts, onChange: (f) => changes.push(f) });
  runner.adopt(main);
  runner.adopt(main);
  assert.deepEqual(r.kills, [[999, 'SIGKILL']]);
  assert.deepEqual(changes, ['main']);
  const lost = runner.job('main');
  assert.equal(lost?.state, 'lost');
  assert.equal(lost?.by, 'Pat');
  assert.equal(lost?.startedAt, 50);
  assert.equal(lost?.modelName, 'GLM-5.3-Flash');
  assert.match(lost?.error ?? '', /office stopped while \/wiki was running/);
  assert.ok(!existsSync(path.join(data, 'wiki-run.json')));
  assert.ok(!existsSync(path.join(data, 'wiki-run-settings.json')));
  await until(() => !existsSync(path.join(data, WIKI_WORKTREE)), 'the stale worktree to go');
  assert.equal(runner.busy(), false);

  // A leftover worktree without a marker (or a pid that's something else now) is only cleaned.
  const home = r.list[1];
  const hd = path.join(home.dir, '.droid-office');
  writeFileSync(path.join(hd, 'wiki-run.json'), '{bad json');
  mkdirSync(path.join(hd, WIKI_WORKTREE));
  const other = rig(t, { isWikiProcess: false });
  const runner2 = new WikiRunner({ ...other.opts, onChange: () => {} });
  runner2.adopt(home);
  assert.equal(runner2.job('home'), undefined);
  await until(() => !existsSync(path.join(hd, WIKI_WORKTREE)));
  assert.deepEqual(other.kills, []);
  writeFileSync(path.join(hd, 'wiki-run.json'), JSON.stringify({ pid: 5 }));
  const runner3 = new WikiRunner({ ...other.opts, onChange: () => {} });
  runner3.adopt(home);
  assert.deepEqual(other.kills, [], 'a pid that is no /wiki run is left alone');
  assert.equal(runner3.job('home')?.by, 'Someone');
});

test('runner: no Droid command, no checkout, and a Windows .cmd shim', async (t) => {
  const none = rig(t, { command: null });
  const r1 = new WikiRunner({ ...none.opts, onChange: () => {} });
  assert.throws(() => r1.start(none.list[0], 'Olive', KEY), /can’t find its Droid command/);

  const broken = rig(t, { gitFails: 'worktree' });
  const r2 = new WikiRunner({ ...broken.opts, onChange: () => {} });
  r2.start(broken.list[0], 'Olive', KEY);
  await until(() => r2.job('main')?.state === 'failed');
  assert.match(r2.job('main')?.error ?? '', /Couldn’t make a clean checkout of the default branch: worktree failed/);
  assert.equal(broken.spawned.length, 0);

  const offline = rig(t, { gitFails: 'fetch' });
  const r3 = new WikiRunner({ ...offline.opts, onChange: () => {} });
  r3.start(offline.list[0], 'Olive', KEY);
  await until(() => offline.spawned.length === 1);
  assert.ok(r3.job('main')?.lines.some((l) => l.startsWith('Couldn’t fetch origin (fetch failed)')));

  const win = rig(t, { platform: 'win32', command: 'C:\\droid\\droid.cmd' });
  const r4 = new WikiRunner({ ...win.opts, onChange: () => {} });
  r4.start(win.list[0], 'Olive', KEY);
  await until(() => win.spawned.length === 1);
  assert.equal(win.spawned[0].options.shell, true);
  assert.equal(win.spawned[0].options.detached, false);
});

test('wiki: generate and cancel through the routes; a finished run polls for its upload', async (t) => {
  const r = rig(t);
  const f = factory({ '/api/v0/wiki': () => json(200, { wikiRuns: [] }) });
  const h = host();
  let key: string | undefined = KEY;
  const feature = new WikiFeature(h.fh, { floors: () => r.list, key: () => key, runner: { ...r.opts } });
  t.after(() => feature.stop());

  await assert.rejects(
    () => call(feature, f.api, 'POST', '/generate', { body: { floor: 'home' } }),
    (e: Error & { status?: number }) => e.status === 409 && /no origin remote/.test(e.message),
  );
  await assert.rejects(() => call(feature, f.api, 'POST', '/generate', { body: { floor: 'nope' } }), /No such floor/);
  key = undefined;
  await assert.rejects(() => call(feature, f.api, 'POST', '/generate', { body: { floor: 'main' } }), /Factory key isn’t usable/);
  key = KEY;
  await assert.rejects(() => call(feature, f.api, 'POST', '/cancel', { body: { floor: 'main' } }), /No \/wiki run to stop/);

  const started = (await call(feature, f.api, 'POST', '/generate', { body: { floor: 'main' } })) as { job: FactoryWikiJob };
  assert.equal(started.job.state, 'starting');
  assert.equal(started.job.by, 'Olive');
  assert.match(h.get().toasts.at(-1) ?? '', /Olive started writing Main’s AutoWiki/);
  assert.equal(feature.busy(), true);
  await until(() => r.spawned.length === 1);
  assert.equal(feature.state().floors.main.job?.state, 'running');
  await assert.rejects(
    () => call(feature, f.api, 'POST', '/generate', { body: { floor: 'main' } }),
    (e: Error & { status?: number }) => e.status === 409,
  );

  const changes = h.get().changes;
  r.spawned[0].child.out('{"type":"tool_call","toolName":"Read"}\n');
  r.spawned[0].child.out('{"type":"tool_call","toolName":"Grep"}\n');
  assert.equal(h.get().changes, changes, 'lines wait for the throttle');
  await until(() => h.get().changes === changes + 1, 'the throttled broadcast');

  const polls = h.get().polls;
  r.spawned[0].child.emit('close', 0, null);
  assert.equal(feature.state().floors.main.job?.state, 'done');
  assert.equal(h.get().polls, polls + 1, 'a finished run looks for its upload');
  assert.equal(feature.busy(), false);

  await call(feature, f.api, 'POST', '/generate', { body: { floor: 'main' } });
  await until(() => r.spawned.length === 2);
  assert.deepEqual(await call(feature, f.api, 'POST', '/cancel', { body: { floor: 'main' } }), { cancelled: true });
  r.spawned[1].child.emit('close', null, 'SIGTERM');
  assert.equal(feature.state().floors.main.job?.state, 'cancelled');
  assert.equal(h.get().polls, polls + 1, 'a cancelled run polls nothing');

  const plain = new WikiFeature(host().fh, { floors: () => r.list, key: () => KEY });
  await assert.rejects(() => call(plain, f.api, 'POST', '/generate', { body: { floor: 'main' } }), /can’t run \/wiki/);
  plain.stop();
});

test('models: droid’s list with each one’s efforts, and the settings that put /wiki’s subagents on it', () => {
  const models = parseDroidModels(HELP);
  assert.deepEqual(models, [
    { id: 'auto', name: 'Auto Model', efforts: ['none'], defaultEffort: 'none' },
    { id: 'gpt-6-sol', name: 'GPT-6 Sol', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
    { id: 'custom:proxy:gemini-3.1-pro', name: 'Proxy: Gemini 3.1 Pro (High)', custom: true },
  ]);
  assert.deepEqual(parseDroidModels('Usage: droid exec\n'), []);
  assert.deepEqual(wikiRunSettings(models[2]), {
    subagentModelSettings: {
      lightModel: 'glm-5.3-flash',
      lightReasoningEffort: 'high',
      mediumModel: 'glm-5.3-flash',
      mediumReasoningEffort: 'high',
      heavyModel: 'glm-5.3-flash',
      heavyReasoningEffort: 'high',
    },
  });
  assert.ok(isModelId('glm-5.3-flash') && isModelId('custom:proxy:gemini-3.1-pro'));
  for (const bad of ['', 'x y', '--settings', '-m', 3]) assert.equal(isModelId(bad), false, String(bad));
});

test('wiki: Generate runs on the model picked, glm-5.3-flash unless told, and only one the office’s Droid lists', async (t) => {
  const r = rig(t);
  const f = factory({ '/api/v0/wiki': () => json(200, { wikiRuns: [] }) });
  const h = host();
  const feature = new WikiFeature(h.fh, { floors: () => r.list, key: () => KEY, runner: { ...r.opts } });
  t.after(() => feature.stop());

  const listed = (await call(feature, f.api, 'GET', '/models')) as { models: { id: string }[]; default: string };
  assert.equal(listed.default, 'glm-5.3-flash');
  assert.deepEqual(
    listed.models.map((m) => m.id),
    ['auto', 'gpt-6-sol', 'glm-5.3-flash', 'custom:proxy:gemini-3.1-pro'],
  );
  await assert.rejects(() => call(feature, f.api, 'POST', '/generate', { body: { floor: 'main', model: 'no-such-model' } }), /has no model no-such-model/);
  await assert.rejects(() => call(feature, f.api, 'POST', '/generate', { body: { floor: 'main', model: 'a b' } }), /model is a Droid model id/);
  await assert.rejects(() => call(feature, f.api, 'POST', '/generate', { body: { floor: 'main', model: '--settings' } }), /model is a Droid model id/);

  const started = (await call(feature, f.api, 'POST', '/generate', { body: { floor: 'main', model: 'gpt-6-sol' } })) as { job: FactoryWikiJob };
  assert.equal(started.job.model, 'gpt-6-sol');
  assert.equal(started.job.modelName, 'GPT-6 Sol');
  assert.match(h.get().toasts.at(-1) ?? '', /with GPT-6 Sol/);
  await until(() => r.spawned.length === 1);
  const args = r.spawned[0].args;
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-6-sol');
  const settings = JSON.parse(readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
  assert.equal(settings.subagentModelSettings.lightModel, 'gpt-6-sol');
  assert.equal(settings.subagentModelSettings.heavyReasoningEffort, 'medium');
  assert.ok(feature.state().floors.main.job?.lines.some((l) => l.endsWith('with GPT-6 Sol…')));
  r.spawned[0].child.emit('close', 0, null);

  await call(feature, f.api, 'POST', '/generate', { body: { floor: 'main' } });
  await until(() => r.spawned.length === 2);
  assert.equal(r.spawned[1].args[r.spawned[1].args.indexOf('-m') + 1], 'glm-5.3-flash');
  r.spawned[1].child.emit('close', 0, null);

  // A Droid that won't say which models it has: any id that looks like one goes to it.
  const quiet = rig(t, { help: async () => Promise.reject(new Error('no help')) });
  const f2 = new WikiFeature(host().fh, { floors: () => quiet.list, key: () => KEY, runner: { ...quiet.opts } });
  t.after(() => f2.stop());
  assert.deepEqual(await call(f2, f.api, 'GET', '/models'), { models: [], default: 'glm-5.3-flash' });
  const job = ((await call(f2, f.api, 'POST', '/generate', { body: { floor: 'main', model: 'kimi-k3' } })) as { job: FactoryWikiJob }).job;
  assert.equal(job.modelName, 'kimi-k3');
  await until(() => quiet.spawned.length === 1);
  quiet.spawned[0].child.emit('close', 0, null);

  const none = new WikiFeature(host().fh, { floors: () => r.list, key: () => KEY });
  assert.deepEqual(await call(none, f.api, 'GET', '/models'), { models: [], default: 'glm-5.3-flash' });
  none.stop();
});
