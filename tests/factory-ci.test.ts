import test from 'node:test';
import assert from 'node:assert/strict';
import { FactoryApi } from '../src/server/factory/api.js';
import { AFTER_EDIT_MS, CiFeature, REPOSITORIES_TTL_MS, editRequestOf } from '../src/server/factory/ci.js';
import type { FeatureHost } from '../src/server/factory/feature.js';
import { ago, ciBoardEmpty, ciBoardKey, type CiBoardInput } from '../src/client/world/factory-ci.js';
import {
  CI_REVIEW_PATH,
  CI_RUNS_MAX,
  WEEK_MS,
  ciEditBody,
  ciEditProblem,
  ciEditResultOf,
  ciJobOf,
  ciKindOf,
  ciOutcome,
  ciRepositoryOf,
  ciRunOf,
  ciTotals,
  customWorkflowPath,
  emptyCi,
  groupCi,
  isCron,
  isGithubRepo,
  reviewParams,
  runOfWorkflow,
  triggerLabel,
  workflowOf,
  type CiEditRequest,
  type FactoryCiState,
} from '../src/shared/factory-ci.js';
import { BOARDS, ELEVATOR, FLOOR, GONG, PLANTS } from '../src/shared/layout.js';

const KEY = 'fk-test-ci-1234';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Factory as the feature sees it, an answer per path; `seen` lists what was asked, `bodies` what was posted. */
function factory(routes: Record<string, Handler>) {
  const seen: string[] = [];
  const bodies: unknown[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    seen.push(url.pathname + url.search);
    if (init.body) bodies.push(JSON.parse(String(init.body)));
    const r = routes[url.pathname];
    return r ? r(url, init) : json(404, { detail: `no ${url.pathname}` });
  }) as typeof fetch;
  return { api: new FactoryApi(KEY, fn), seen, bodies };
}

function host() {
  const toasts: string[] = [];
  let soon = 0;
  const h: FeatureHost & { toasts: string[]; soon: () => number } = {
    changed: () => {},
    pollSoon: () => soon++,
    api: () => undefined,
    toast: (text) => toasts.push(text),
    toasts,
    soon: () => soon,
  };
  return h;
}

const REVIEW = {
  repoFullName: 'nikships/droidproxy',
  filePath: '.github/workflows/droid-review.yml',
  workflowName: 'Droid Auto Review',
  triggerEvents: ['pull_request', 3],
  droidActionInputs: { actionRef: 'main', automaticReview: true, model: 'gpt-5.2', reviewDepth: '' },
  githubUrl: 'https://github.com/nikships/droidproxy/blob/HEAD/.github/workflows/droid-review.yml',
  fileSha: '8146b297',
  templateId: 'code-review',
  authoredBy: { login: 'nikships', name: 'Nik Anand' },
  userPermission: 'admin',
};
const TAG = {
  repoFullName: 'nikships/droidproxy',
  filePath: '.github/workflows/droid.yml',
  workflowName: 'Droid Tag',
  triggerEvents: ['issue_comment', 'pull_request_review_comment', 'issues'],
  droidActionInputs: { actionRef: 'main' },
  templateId: 'code-review',
};
const SECURITY = { repoFullName: 'NikShips/Droid-Office', filePath: '.github/workflows/security-review.yml', workflowName: 'Security review', triggerEvents: ['pull_request', 'schedule'], scheduleCron: '23 5 * * 1', droidActionInputs: {} };

const HOUR = 3600_000;
const T0 = Date.UTC(2026, 9, 7, 12);

function ciFactory(over: Record<string, Handler> = {}) {
  return factory({
    '/api/v0/automations/ci/repository-owners': () => json(200, { owners: [{ login: 'nikships', type: 'user' }, { login: 'org' }, {}], integration: { connected: true } }),
    '/api/v0/automations/ci/scan': () => json(200, { workflows: [REVIEW, TAG, SECURITY, { repoFullName: 'o/r' }], scannedAt: T0 - HOUR, cacheTtlMs: 30 * 60_000, integration: { connected: true } }),
    '/api/v0/automations/ci/runs': () =>
      json(200, {
        runs: [
          {
            id: 7,
            repository: { full_name: 'nikships/droidproxy' },
            path: '.github/workflows/droid-review.yml',
            name: 'Droid Auto Review',
            status: 'completed',
            conclusion: 'failure',
            html_url: 'https://github.com/nikships/droidproxy/actions/runs/7',
            run_started_at: new Date(T0 - 2 * HOUR).toISOString(),
            updated_at: new Date(T0 - 2 * HOUR + 95_000).toISOString(),
            event: 'pull_request',
            pull_requests: [{ number: 12 }],
            head_sha: 'abc1234def',
            display_title: 'Fix it\nmore',
          },
          { runId: 'r8', repoFullName: 'nikships/droidproxy', workflowName: 'Droid Auto Review', status: 'in_progress', startedAt: T0 - 60_000 },
          { id: '' },
        ],
      }),
    '/api/v0/automations/ci/jobs': () =>
      json(200, {
        jobs: [
          {
            id: 'nikships/droid-office::.github/workflows/droid-review.yml',
            action: 'create',
            repoFullName: 'nikships/droid-office',
            filePath: '.github/workflows/droid-review.yml',
            prUrl: 'https://github.com/nikships/droid-office/pull/80',
            status: 'ready',
            createdAt: T0 - HOUR,
            updatedAt: T0 - HOUR,
          },
          { nope: true },
        ],
      }),
    ...over,
  });
}

test('CI poll: owners, workflows with all they say, runs newest first and workflow PRs', async () => {
  const f = ciFactory();
  const feature = new CiFeature(host(), () => T0);
  await feature.poll(f.api);
  const s = feature.state();
  assert.equal(s.github, true);
  assert.deepEqual(s.owners, [
    { login: 'nikships', type: 'user' },
    { login: 'org', type: 'user' },
  ]);
  assert.equal(s.workflows.length, 3, 'a workflow without a file is skipped');
  assert.deepEqual(s.workflows[0], {
    repo: 'nikships/droidproxy',
    path: '.github/workflows/droid-review.yml',
    name: 'Droid Auto Review',
    triggers: ['pull_request'],
    templateId: 'code-review',
    model: 'gpt-5.2',
    inputs: { actionRef: 'main', automaticReview: true },
    url: REVIEW.githubUrl,
    sha: '8146b297',
    author: 'nikships',
    authorName: 'Nik Anand',
    permission: 'admin',
  });
  assert.equal(s.workflows[2].cron, '23 5 * * 1');
  assert.equal(s.scannedAt, T0 - HOUR);
  assert.deepEqual(
    s.runs.map((r) => r.id),
    ['r8', '7'],
  );
  const failed = s.runs[1];
  assert.equal(failed.repo, 'nikships/droidproxy');
  assert.equal(failed.durationMs, 95_000);
  assert.deepEqual(failed.pr, { number: 12 });
  assert.equal(failed.title, 'Fix it');
  assert.equal(failed.sha, 'abc1234def');
  assert.equal(s.runs[0].durationMs, undefined, 'a run still going has no duration');
  assert.equal(s.jobs.length, 1);
  assert.equal(s.jobs[0].prUrl, 'https://github.com/nikships/droid-office/pull/80');
  assert.equal(s.fetchedAt, T0);
  assert.equal(s.error, undefined);
});

test('CI poll: the scan is read again only once its cacheTtlMs runs out, or on Rescan', async () => {
  let now = T0;
  const f = ciFactory();
  const feature = new CiFeature(host(), () => now);
  const scans = () => f.seen.filter((p) => p.startsWith('/api/v0/automations/ci/scan')).length;
  await feature.poll(f.api);
  assert.equal(scans(), 1);
  now += 10 * 60_000;
  await feature.poll(f.api);
  assert.equal(scans(), 1, 'within the 30 minutes the scan caches');
  assert.equal(f.seen.filter((p) => p === '/api/v0/automations/ci/runs').length, 2, 'runs are read every poll');
  now += 21 * 60_000;
  await feature.poll(f.api);
  assert.equal(scans(), 2);

  const r = (await feature.routes.find((x) => x.path === '/rescan')!.handle({ api: f.api } as never)) as { workflows: number };
  assert.equal(r.workflows, 3);
  assert.ok(f.seen.includes('/api/v0/automations/ci/scan?forceRefresh=true'));

  // A tiny cacheTtlMs still waits a normal poll; a huge one at most an hour.
  const quick = ciFactory({ '/api/v0/automations/ci/scan': () => json(200, { workflows: [], cacheTtlMs: 5 }) });
  now = T0;
  const q = new CiFeature(host(), () => now);
  await q.poll(quick.api);
  now += q.interval - 1;
  await q.poll(quick.api);
  assert.equal(quick.seen.filter((p) => p.includes('/scan')).length, 1);
  now += 1;
  await q.poll(quick.api);
  assert.equal(quick.seen.filter((p) => p.includes('/scan')).length, 2);
  const slow = ciFactory({ '/api/v0/automations/ci/scan': () => json(200, { workflows: [], cacheTtlMs: 24 * HOUR }) });
  const sl = new CiFeature(host(), () => now);
  await sl.poll(slow.api);
  now += HOUR;
  await sl.poll(slow.api);
  assert.equal(slow.seen.filter((p) => p.includes('/scan')).length, 2);

  // Disconnecting forgets when the scan was due.
  feature.reset();
  await feature.poll(f.api);
  assert.equal(scans(), 4);
});

test('CI poll: one failing read keeps the rest, all failing or a 401 fails the poll', async () => {
  let runsFail = false;
  const f = ciFactory({ '/api/v0/automations/ci/runs': () => (runsFail ? json(500, { detail: 'runs broke' }) : json(200, { runs: [{ id: 1, repoFullName: 'o/r', status: 'queued' }] })) });
  const feature = new CiFeature(host(), () => T0);
  await feature.poll(f.api);
  runsFail = true;
  await feature.poll(f.api);
  assert.equal(feature.state().runs.length, 1, 'the last runs stay');
  assert.equal(feature.state().workflows.length, 3);
  assert.match(feature.state().error ?? '', /runs broke/);

  const down = factory({});
  await assert.rejects(() => new CiFeature(host(), () => T0).poll(down.api), /no \/api\/v0\/automations/);
  const rejected = ciFactory({ '/api/v0/automations/ci/jobs': () => json(401, { detail: 'gone' }) });
  await assert.rejects(
    () => feature.poll(rejected.api),
    (e: { status?: number }) => e.status === 401,
  );
  const noGithub = ciFactory({ '/api/v0/automations/ci/repository-owners': () => json(200, { owners: [], integration: { connected: false } }) });
  const g = new CiFeature(host(), () => T0);
  await g.poll(noGithub.api);
  assert.equal(g.state().github, false);
});

test('CI repositories: listed writable-or-not, sorted, kept 10 minutes per owner, and fresh on asking', async () => {
  let now = T0;
  const f = factory({
    '/api/v0/automations/ci/repositories': (url) =>
      json(200, {
        repositories: [
          { fullName: 'z/last', isPrivate: true, defaultBranch: 'main', userPermission: 'admin', factoryAppWritable: true },
          { fullName: 'a/first', factoryAppWritable: false },
          { nope: 1 },
          ...(url.searchParams.get('owner') ? [{ fullName: 'org/x' }] : []),
        ],
      }),
  });
  const feature = new CiFeature(host(), () => now);
  const route = feature.routes.find((r) => r.path === '/repositories')!;
  const ask = (q = '') => route.handle({ api: f.api, query: new URLSearchParams(q) } as never) as Promise<{ repositories: unknown[]; fetchedAt: number }>;
  const first = await ask();
  assert.deepEqual(first.repositories, [
    { fullName: 'a/first', private: false, writable: false },
    { fullName: 'z/last', private: true, defaultBranch: 'main', permission: 'admin', writable: true },
  ]);
  now += REPOSITORIES_TTL_MS - 1;
  assert.equal((await ask()).fetchedAt, T0, 'from the cache');
  assert.equal(f.seen.length, 1);
  await ask('fresh=1');
  assert.equal(f.seen.length, 2);
  const org = await ask('owner=org');
  assert.equal(org.repositories.length, 3);
  assert.equal(f.seen[2], '/api/v0/automations/ci/repositories?owner=org');
  now += REPOSITORIES_TTL_MS;
  await ask('owner=org');
  assert.equal(f.seen.length, 4, 'stale after 10 minutes');
  assert.equal(ciRepositoryOf(null), undefined);
});

test('CI edit: the body Factory takes, the PR it opened, and what it refuses', async () => {
  let now = T0;
  let answer: unknown = { sessions: [{ repoFullName: 'nikships/droid-office', sessionId: 's1', prUrl: 'https://github.com/nikships/droid-office/pull/81' }] };
  const f = factory({ '/api/v0/automations/ci/edit': () => json(200, answer) });
  const h = host();
  const feature = new CiFeature(h, () => now);
  const route = feature.routes.find((r) => r.path === '/edit')!;
  const edit = (body: unknown) => route.handle({ api: f.api, json: async () => body, by: 'Olive' } as never) as Promise<unknown>;

  assert.ok(!feature.busy());
  const result = await edit({ action: 'create', repo: 'nikships/droid-office', template: 'code-review', events: ['pull-request', 'pull-request'], security: true, model: 'openai-latest-premium', extra: 'ignored' });
  assert.deepEqual(result, { repo: 'nikships/droid-office', path: CI_REVIEW_PATH, prUrl: 'https://github.com/nikships/droid-office/pull/81' });
  const sent = f.bodies[0] as Record<string, unknown>;
  assert.equal(sent.action, 'create');
  assert.equal(sent.modeId, 'code-review');
  assert.equal(sent.automationName, 'Droid Code Review');
  assert.match(String(sent.factoryAutomationId), /^[0-9a-f-]{36}$/);
  assert.deepEqual(sent.repos, [{ repoFullName: 'nikships/droid-office', filePath: CI_REVIEW_PATH }]);
  assert.deepEqual(sent.changes, {
    name: 'Droid Code Review',
    yamlParams: 'automatic_review: true\nreview_depth: deep\nautomatic_security_review: true\nreview_model: openai-latest-premium\n',
    customPrompt: '',
    schedule: '',
    githubEvents: ['pull-request'],
  });
  assert.equal(h.soon(), 1);
  assert.deepEqual(h.toasts, ['🤖 Olive opened a PR to add droid-review.yml in nikships/droid-office']);
  assert.ok(feature.busy(), 'watching for the PR to show up');
  now += AFTER_EDIT_MS;
  assert.ok(!feature.busy());

  answer = { sessions: [{ repoFullName: 'nikships/droid-office', message: 'Automation deleted' }] };
  assert.deepEqual(await edit({ action: 'delete', repo: 'nikships/droid-office', path: '.github/workflows/droid-review.yml' }), { repo: 'nikships/droid-office', path: CI_REVIEW_PATH, message: 'Automation deleted' });
  assert.deepEqual(f.bodies[1], { action: 'delete', repos: [{ repoFullName: 'nikships/droid-office', filePath: CI_REVIEW_PATH }] });
  assert.equal(h.toasts.length, 1, 'no PR, no toast');

  answer = { sessions: [{ repoFullName: 'nikships/droid-office', error: 'Invalid repo target' }] };
  await assert.rejects(edit({ action: 'delete', repo: 'nikships/droid-office', path: '.github/workflows/x.yml' }), (e: { status?: number; message: string }) => e.status === 422 && e.message === 'Invalid repo target');
  answer = {};
  await assert.rejects(edit({ action: 'delete', repo: 'nikships/droid-office', path: '.github/workflows/x.yml' }), /didn’t say what it did/);

  const asked = f.seen.length;
  await assert.rejects(edit({ action: 'create', repo: 'not a repo' }), (e: { status?: number }) => e.status === 400);
  await assert.rejects(edit({ action: 'edit', repo: 'o/r' }), /which workflow file/);
  await assert.rejects(edit(null), /add, change or remove/);
  assert.equal(f.seen.length, asked, 'nothing that fails a check reaches Factory');
});

test('CI edit request: only its fields, trimmed and capped', () => {
  const req = editRequestOf({
    action: 'create',
    repo: ' o/r ',
    path: '',
    template: 'custom',
    name: 'x'.repeat(200),
    events: ['push', 'push', 4],
    cron: '0 9 * * 1',
    model: 'm',
    effort: 'high',
    prompt: ' do it ',
    depth: 'shallow',
    security: 'yes',
  });
  assert.deepEqual(req, { action: 'create', repo: 'o/r', template: 'custom', name: 'x'.repeat(80), events: ['push'], cron: '0 9 * * 1', model: 'm', effort: 'high', prompt: 'do it', depth: 'shallow' });
  assert.deepEqual(editRequestOf('nope'), { action: '', repo: '' });
});

test('CI edit checks and bodies for each kind of change', () => {
  const ok: CiEditRequest = { action: 'create', repo: 'o/r' };
  assert.equal(ciEditProblem(ok), undefined);
  const bad: [Partial<CiEditRequest>, RegExp][] = [
    [{ action: 'nuke' as 'create' }, /add, change or remove/],
    [{ repo: 'o/..' }, /GitHub repository/],
    [{ repo: 'gitlab.com/g/p' }, /GitHub repository/],
    [{ action: 'delete' }, /which workflow file/],
    [{ path: '../../etc/passwd' }, /\.github\/workflows/],
    [{ template: 'wiki' as 'custom' }, /Unknown template/],
    [{ events: ['fork' as 'push'] }, /Unknown trigger/],
    [{ cron: 'every day' }, /five cron fields/],
    [{ depth: 'medium' as 'deep' }, /deep or shallow/],
    [{ model: 'gpt\n  evil: true' }, /model is an id/],
    [{ effort: 'very high' }, /reasoning effort/],
    [{ name: 'a\nb' }, /one line/],
    [{ template: 'custom', events: ['push'] }, /what the Droid job does/],
    [{ template: 'custom', prompt: 'Triage' }, /trigger or a schedule/],
  ];
  for (const [over, why] of bad) assert.match(ciEditProblem({ ...ok, ...over }) ?? '', why, JSON.stringify(over));
  assert.equal(ciEditProblem({ action: 'delete', repo: 'o/r', path: '.github/workflows/a.yaml', cron: 'junk' }), undefined, 'a removal needs only the file');

  const custom = ciEditBody({ action: 'create', repo: 'o/r', template: 'custom', name: 'Issue Triage!', prompt: ' Label new issues ', cron: '0 9 * * 1', model: 'anthropic-latest-fast', effort: 'low' }, 'id-1');
  assert.deepEqual(custom, {
    action: 'create',
    automationName: 'Issue Triage!',
    factoryAutomationId: 'id-1',
    repos: [{ repoFullName: 'o/r', filePath: '.github/workflows/factory-issue-triage.yml' }],
    changes: { name: 'Issue Triage!', yamlParams: '', customPrompt: 'Label new issues', schedule: '0 9 * * 1', customCIModel: 'anthropic-latest-fast', customCIReasoningEffort: 'low' },
  });
  const change = ciEditBody({ action: 'edit', repo: 'o/r', path: CI_REVIEW_PATH, depth: 'shallow', events: ['pr-opened'] }, 'id-2');
  assert.equal(change.action, 'edit');
  assert.deepEqual((change.changes as Record<string, unknown>).yamlParams, 'automatic_review: true\nreview_depth: shallow\n');
  assert.equal(customWorkflowPath('  '), '.github/workflows/factory-droid.yml');
  assert.equal(reviewParams({}), 'automatic_review: true\nreview_depth: deep\n');
  assert.ok(isCron('*/15 0-6 * * MON-FRI'));
  assert.ok(!isCron('* * * *'));
  assert.ok(isGithubRepo('Factory-AI/droid-action'));
  assert.ok(!isGithubRepo('o/r/x'));
  // Factory answers one session per repository; ours is found by name whatever the case.
  assert.equal(
    ciEditResultOf(
      {
        sessions: [
          { repoFullName: 'x/y', prUrl: 'u1' },
          { repoFullName: 'O/R', prUrl: 'u2' },
        ],
      },
      ok,
      'p',
    ).prUrl,
    'u2',
  );
  assert.equal(ciEditResultOf({ sessions: [{ prUrl: 'u3', error: 'partly' }] }, ok, 'p').prUrl, 'u3', 'a PR despite an error still counts');
});

test('CI grouping: this floor first whatever the case, each workflow with its latest run, and the totals', () => {
  const workflows = [REVIEW, TAG, SECURITY].map((w) => workflowOf(w)!);
  const runs = [
    ciRunOf({ id: 1, repoFullName: 'nikships/droidproxy', path: '.github/workflows/droid-review.yml', status: 'completed', conclusion: 'success', createdAt: T0 - 3 * HOUR })!,
    ciRunOf({ id: 2, repoFullName: 'NIKSHIPS/DROIDPROXY', workflowName: 'Droid Auto Review', status: 'completed', conclusion: 'failure', createdAt: T0 - HOUR })!,
    ciRunOf({ id: 3, repoFullName: 'other/repo', status: 'in_progress', createdAt: T0 - 8 * 24 * HOUR })!,
  ];
  const jobs = [ciJobOf({ repoFullName: 'nikships/droid-office', filePath: CI_REVIEW_PATH, prUrl: 'p' })!];
  const groups = groupCi({ workflows, runs, jobs }, 'nikships/droid-office');
  assert.deepEqual(
    groups.map((g) => [g.repo, g.here, g.workflows.length, g.runs.length, g.jobs.length]),
    [
      ['nikships/droid-office', true, 1, 0, 1],
      ['nikships/droidproxy', false, 2, 2, 0],
      ['other/repo', false, 0, 1, 0],
    ],
    'NikShips/Droid-Office is this floor, nikships/droid-office',
  );
  assert.equal(groupCi({ workflows, runs, jobs: [] }, 'someone/else')[0].repo, 'someone/else', 'this floor has a group even with no workflows');
  const proxy = groups.find((g) => g.repo === 'nikships/droidproxy')!;
  assert.deepEqual(
    proxy.workflows.map((w) => [w.workflow.path, w.kind, w.latest?.id]),
    [
      ['.github/workflows/droid-review.yml', 'review', '2'],
      ['.github/workflows/droid.yml', 'tag', undefined],
    ],
  );
  assert.ok(!runOfWorkflow(runs[0], workflows[1]), 'another file in the same repository');
  assert.deepEqual(ciTotals({ workflows, runs }, T0), { workflows: 3, repos: 2, week: 2, passed: 1, failed: 1, running: 0 });
  assert.equal(ciTotals({ workflows, runs }, T0 + WEEK_MS).week, 0);
  assert.deepEqual(groupCi(emptyCi()), []);
});

test('CI words: what a workflow is, how a run went, and its triggers', () => {
  const kind = (o: object) => ciKindOf({ path: '.github/workflows/x.yml', triggers: [], inputs: {}, ...o });
  assert.equal(kind({ templateId: 'wiki' }), 'wiki');
  assert.equal(kind({ path: '.github/workflows/qa.yml' }), 'qa');
  assert.equal(kind({ templateId: 'security-audit' }), 'security');
  assert.equal(kind({ inputs: { automaticSecurityReview: true } }), 'security');
  assert.equal(kind({ inputs: { automaticSecurityReview: true, automaticReview: true } }), 'review');
  assert.equal(kind({ triggers: ['issue_comment'] }), 'tag');
  assert.equal(kind({ cron: '0 0 * * *' }), 'scheduled');
  assert.equal(kind({}), 'custom');
  assert.equal(ciOutcome({ conclusion: 'success' }), 'pass');
  assert.equal(ciOutcome({ conclusion: 'timed_out' }), 'fail');
  assert.equal(ciOutcome({ conclusion: 'cancelled' }), 'skipped');
  assert.equal(ciOutcome({ status: 'queued' }), 'running');
  assert.equal(ciOutcome({ status: 'completed' }), 'unknown');
  assert.equal(triggerLabel('pull_request'), 'PRs');
  assert.equal(triggerLabel('merge_group'), 'merge group');
  assert.equal(ciRunOf({ id: 1, durationMs: 5, pullRequest: { number: 3, htmlUrl: 'u' } })?.durationMs, 5);
  assert.deepEqual(ciRunOf({ id: 1, prNumber: 4, prUrl: 'u' })?.pr, { number: 4, url: 'u' });
  assert.equal(ciRunOf({ id: 1, head_commit: { message: 'first\nsecond' } })?.title, 'first');
  assert.equal(ciJobOf({ repoFullName: 'o/r' }), undefined);
  assert.equal(ciJobOf({ repoFullName: 'o/r', filePath: 'f' })?.id, 'o/r::f');
  assert.equal(CI_RUNS_MAX, 50);
});

test('CI board: what it says with nothing to show, and redrawing only when that changes', () => {
  const base: CiBoardInput = { connection: { connected: false, capabilities: [] }, ci: emptyCi(), now: T0 };
  assert.match(ciBoardEmpty(base)?.title ?? '', /CONNECT FACTORY/);
  const connected = { ...base, connection: { connected: true, capabilities: [] } };
  assert.match(ciBoardEmpty({ ...connected, connection: { ...connected.connection, rejected: 'gone' } })?.title ?? '', /TURNED THE KEY DOWN/);
  assert.match(ciBoardEmpty({ ...connected, connection: { connected: true, capabilities: [{ group: 'ci', status: 'denied', reason: 'Needs a plan' }] } })?.sub ?? '', /NEEDS A PLAN/);
  assert.match(ciBoardEmpty(connected)?.title ?? '', /READING/);
  const read: FactoryCiState = { ...emptyCi(), fetchedAt: T0, github: true };
  assert.match(ciBoardEmpty({ ...connected, ci: { ...read, github: false } })?.title ?? '', /GITHUB ISN’T CONNECTED/);
  assert.match(ciBoardEmpty({ ...connected, ci: read, floorRepo: 'o/r' })?.sub ?? '', /ADD DROID CODE REVIEW TO O\/R/);
  const full = { ...connected, ci: { ...read, workflows: [workflowOf(REVIEW)!], scannedAt: T0 - 90_000 } };
  assert.equal(ciBoardEmpty(full), undefined);

  const key = ciBoardKey(full);
  assert.equal(ciBoardKey({ ...full, ci: { ...full.ci, fetchedAt: T0 + 5 } }), key, 'a poll that changed nothing redraws nothing');
  assert.equal(ciBoardKey({ ...full, now: T0 + 20_000 }), key, 'within the same minute');
  assert.notEqual(ciBoardKey({ ...full, now: T0 + 60_000 }), key, 'the scan age ticks over');
  assert.notEqual(ciBoardKey({ ...full, floorRepo: 'nikships/droidproxy' }), key);
  assert.equal(ago(T0 - 30_000, T0), 'NOW');
  assert.equal(ago(T0 - 5 * 60_000, T0), '5M');
  assert.equal(ago(T0 - 3 * HOUR, T0), '3H');
  assert.equal(ago(T0 - 49 * HOUR, T0), '2D');
});

test('the CI board hangs on the north wall clear of the gong, the elevator, the corner, the mural and the plants', () => {
  const b = BOARDS.ci;
  const left = b.x - b.width / 2;
  const right = b.x + b.width / 2;
  assert.equal(b.rotY, 0, 'facing into the room');
  assert.ok(Math.abs(b.z - FLOOR.minZ) < 0.2, 'on the north wall');
  // The gong's mounting plate is wider than the gong itself.
  assert.ok(left > GONG.x + GONG.width / 2 + 0.5, 'clear of the gong');
  assert.ok(left > ELEVATOR.x + ELEVATOR.width / 2, 'clear of the elevator');
  assert.ok(right < FLOOR.maxX - 0.1, 'inside the north-east corner');
  // The Factory hero mural (world/factory-floor.ts) hangs over it, its bottom edge at 4.8 − 3.3 / 2.
  assert.ok(b.y + b.height / 2 < 4.8 - 3.3 / 2, 'under the mural');
  assert.ok(b.y - b.height / 2 > 0.5, 'off the floor');
  for (const [x, z] of PLANTS) assert.ok(!(x > left - 0.6 && x < right + 0.6 && z < FLOOR.minZ + 2), `the plant at ${x}, ${z} stands in front of it`);
  for (const other of Object.values(BOARDS)) {
    if (other === b || other.rotY !== 0) continue;
    assert.ok(other.x + other.width / 2 < left || other.x - other.width / 2 > right, 'no other north-wall board overlaps it');
  }
});
