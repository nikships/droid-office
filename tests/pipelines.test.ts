import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ago, clock, eventLabel, githubState, gitlabState, isLive, pipelineGroups, runTime, stateWord, waitTime, type PipelineRun } from '../src/shared/pipelines.js';
import { floorPipelines, githubJob, githubRun, gitlabJob, gitlabPipeline, jobCount, parseYaml, Pipelines, workflowDispatch, type PipelineForge } from '../src/server/pipelines.js';
import { runRows } from '../src/client/world/pipeline-rows.js';

const NOW = Date.parse('2026-03-01T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function run(id: number, over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id,
    number: id,
    workflow: 'Release',
    title: `Commit ${id}`,
    state: 'success',
    status: 'success',
    event: 'push',
    branch: 'main',
    sha: 'abcdef1234',
    url: `https://github.com/o/r/actions/runs/${id}`,
    createdAt: iso(600_000),
    startedAt: iso(590_000),
    updatedAt: iso(300_000),
    ...over,
  };
}

test('GitHub and GitLab statuses become the office’s run states', () => {
  assert.equal(githubState('queued', null), 'pending');
  assert.equal(githubState('waiting', null), 'pending');
  assert.equal(githubState('in_progress', null), 'running');
  assert.equal(githubState('completed', 'success'), 'success');
  assert.equal(githubState('completed', 'failure'), 'failure');
  assert.equal(githubState('completed', 'timed_out'), 'failure');
  assert.equal(githubState('completed', 'startup_failure'), 'failure');
  assert.equal(githubState('completed', 'cancelled'), 'cancelled');
  assert.equal(githubState('completed', 'skipped'), 'skipped');
  assert.equal(githubState('completed', 'neutral'), 'skipped');
  assert.equal(githubState('completed', 'action_required'), 'pending');
  assert.equal(githubState(undefined, undefined), 'pending');
  for (const [s, want] of [
    ['RUNNING', 'running'],
    ['canceling', 'running'],
    ['SUCCESS', 'success'],
    ['FAILED', 'failure'],
    ['CANCELED', 'cancelled'],
    ['skipped', 'skipped'],
    ['MANUAL', 'pending'],
    ['WAITING_FOR_RESOURCE', 'pending'],
    ['created', 'pending'],
  ] as const)
    assert.equal(gitlabState(s), want, s);
  assert.equal(isLive('pending') && isLive('running'), true);
  assert.equal(isLive('failure') || isLive('success') || isLive('cancelled'), false);
});

test('runs are grouped running, then waiting, then the rest by when they finished', () => {
  const runs = [
    run(1, { updatedAt: iso(900_000) }),
    run(2, { state: 'running', createdAt: iso(100_000) }),
    run(3, { state: 'pending', status: 'queued' }),
    run(4, { state: 'failure', updatedAt: iso(60_000) }),
    run(5, { state: 'running', createdAt: iso(50_000) }),
  ];
  const g = pipelineGroups(runs);
  assert.deepEqual(
    g.running.map((r) => r.id),
    [5, 2],
  );
  assert.deepEqual(
    g.pending.map((r) => r.id),
    [3],
  );
  assert.deepEqual(
    g.recent.map((r) => r.id),
    [4, 1],
  );
});

test('times read like a clock and an age', () => {
  assert.equal(clock(42_000), '42s');
  assert.equal(clock(185_000), '3m 05s');
  assert.equal(clock(4_320_000), '1h 12m');
  assert.equal(ago(iso(10_000), NOW), 'now');
  assert.equal(ago(iso(240_000), NOW), '4m');
  assert.equal(ago(iso(3 * 3600_000), NOW), '3h');
  assert.equal(ago(iso(2 * 86400_000), NOW), '2d');
  assert.equal(ago('nonsense', NOW), '');
  assert.equal(runTime(run(1, { startedAt: iso(120_000), updatedAt: iso(60_000) }), NOW), 60_000);
  assert.equal(runTime(run(1, { state: 'running', startedAt: iso(120_000) }), NOW), 120_000);
  assert.equal(runTime(run(1, { state: 'pending' }), NOW), 0);
  assert.equal(runTime(run(1, { startedAt: 'x', createdAt: 'y' }), NOW), 0);
  assert.equal(waitTime(run(1, { createdAt: iso(30_000) }), NOW), 30_000);
  assert.equal(waitTime(run(1, { createdAt: 'x' }), NOW), 0);
  assert.equal(eventLabel('pull_request'), 'PR');
  assert.equal(eventLabel('merge_request_event'), 'MR');
  assert.equal(eventLabel('workflow_dispatch'), 'by hand');
  assert.equal(eventLabel('some_new_event'), 'some new event');
  assert.equal(stateWord(run(1, { state: 'pending', status: 'waiting' })), 'needs approval');
  assert.equal(stateWord(run(1, { state: 'pending', status: 'manual' })), 'manual');
  assert.equal(stateWord(run(1, { state: 'pending', status: 'scheduled' })), 'scheduled');
  assert.equal(stateWord(run(1, { state: 'pending', status: 'queued' })), 'queued');
  assert.equal(stateWord(run(1, { state: 'failure' })), 'failed');
});

test('GitHub’s runs and jobs come through in the office’s shapes', () => {
  const r = githubRun({
    id: 99,
    run_number: 412,
    name: 'Release',
    display_title: 'feat: pipelines board',
    status: 'completed',
    conclusion: 'failure',
    event: 'push',
    head_branch: 'main',
    head_sha: 'f00',
    triggering_actor: { login: 'nikships' },
    html_url: 'https://github.com/o/r/actions/runs/99',
    created_at: iso(60_000),
    run_started_at: iso(55_000),
    updated_at: iso(1_000),
    run_attempt: 2,
    path: '.github/workflows/release.yml@refs/heads/main',
  });
  assert.equal(r.state, 'failure');
  assert.equal(r.status, 'failure');
  assert.equal(r.number, 412);
  assert.equal(r.actor, 'nikships');
  assert.equal(r.attempt, 2);
  assert.equal(r.path, '.github/workflows/release.yml');
  const bare = githubRun({ id: 1, status: 'queued', head_commit: { message: 'First line\nmore' } });
  assert.deepEqual([bare.workflow, bare.title, bare.state, bare.status, bare.actor, bare.path], ['Workflow', 'First line', 'pending', 'queued', undefined, undefined]);
  // Started by hand, GitHub titles it with the workflow's name: the commit says more.
  const byHand = (head_commit?: { message: string }) => githubRun({ id: 2, name: 'Release', display_title: 'Release', event: 'workflow_dispatch', head_commit }).title;
  assert.equal(byHand({ message: 'feat: a board\n\nbody' }), 'feat: a board');
  assert.equal(byHand(), 'Release');

  const j = githubJob({
    id: 7,
    name: 'build',
    status: 'in_progress',
    started_at: iso(30_000),
    html_url: 'https://github.com/o/r/actions/runs/99/job/7',
    steps: [
      { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
      { number: 2, name: 'npm test', status: 'in_progress' },
    ],
  });
  assert.equal(j.state, 'running');
  assert.deepEqual(
    j.steps.map((s) => [s.number, s.state]),
    [
      [1, 'success'],
      [2, 'running'],
    ],
  );
  assert.deepEqual(githubJob({ id: 8 }).steps, []);
});

test('GitLab’s pipelines and jobs come through in the office’s shapes', () => {
  const p = gitlabPipeline(
    {
      id: 'gid://gitlab/Ci::Pipeline/1234',
      iid: 56,
      status: 'FAILED',
      source: 'MERGE_REQUEST_EVENT',
      ref: 'feat/x',
      sha: 'abc',
      name: null,
      createdAt: iso(60_000),
      startedAt: iso(50_000),
      finishedAt: iso(10_000),
      updatedAt: iso(5_000),
      path: '/grp/proj/-/pipelines/1234',
      user: { username: 'ada' },
      commit: { title: 'Fix it' },
    },
    'gitlab.example.com',
  );
  assert.deepEqual([p.id, p.number, p.workflow, p.state, p.status, p.event, p.branch, p.actor, p.title], [1234, 56, 'Pipeline', 'failure', 'failed', 'merge_request_event', 'feat/x', 'ada', 'Fix it']);
  assert.equal(p.url, 'https://gitlab.example.com/grp/proj/-/pipelines/1234');
  assert.equal(p.updatedAt, iso(10_000), 'a finished pipeline is dated when it finished');
  const live = gitlabPipeline({ id: 'gid://gitlab/Ci::Pipeline/5', status: 'RUNNING', updatedAt: iso(1_000), finishedAt: null }, 'gitlab.com');
  assert.equal(live.updatedAt, iso(1_000));
  assert.equal(live.url, '');
  const j = gitlabJob({ id: 3, name: 'lint', status: 'failed', stage: 'test', allow_failure: true, web_url: 'https://gitlab.com/j/3', started_at: iso(20_000), finished_at: iso(10_000) });
  assert.deepEqual([j.state, j.stage, j.allowFailure, j.steps.length, j.completedAt], ['failure', 'test', true, 0, iso(10_000)]);
});

test('a running run’s progress counts its jobs, leaving out ones allowed to fail', () => {
  const jobs = [githubJob({ id: 1, name: 'a', status: 'completed', conclusion: 'success' }), githubJob({ id: 2, name: 'b', status: 'in_progress' }), githubJob({ id: 3, name: 'c', status: 'queued' })];
  assert.deepEqual(jobCount(jobs), { done: 1, total: 3, failed: 0, current: 'b' });
  const gl = [gitlabJob({ id: 1, status: 'failed', allow_failure: true }), gitlabJob({ id: 2, status: 'failed' })];
  assert.deepEqual(jobCount(gl), { done: 2, total: 2, failed: 1 });
});

test('a workflow can be started by hand when it has workflow_dispatch, with the inputs it takes', () => {
  const release = `name: Release
# Every push to main, or by hand
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      version:
        description: "Version to publish # not a comment"
        required: true
        type: string
      channel:
        description: Where it goes
        type: choice
        options:
          - stable
          - beta
        default: stable
      dry_run:
        type: boolean
        default: false
      notes:
        description: |
          Several lines
          of notes
      weird:
        type: something-else
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;
  const { manual, inputs } = workflowDispatch(release);
  assert.equal(manual, true);
  assert.deepEqual(inputs, [
    { name: 'version', description: 'Version to publish # not a comment', required: true, default: undefined, type: 'string' },
    { name: 'channel', description: 'Where it goes', required: false, default: 'stable', type: 'choice', options: ['stable', 'beta'] },
    { name: 'dry_run', description: undefined, required: false, default: 'false', type: 'boolean' },
    { name: 'notes', description: 'Several lines\nof notes', required: false, default: undefined, type: 'string' },
    { name: 'weird', description: undefined, required: false, default: undefined, type: 'string' },
  ]);
  assert.deepEqual(workflowDispatch('on: workflow_dispatch\njobs: {}'), { manual: true, inputs: [] });
  assert.deepEqual(workflowDispatch('on: [push, workflow_dispatch]'), { manual: true, inputs: [] });
  assert.deepEqual(workflowDispatch('"on":\n  workflow_dispatch:\n'), { manual: true, inputs: [] });
  assert.deepEqual(workflowDispatch('true:\n  workflow_dispatch: {}\n'), { manual: true, inputs: [] });
  assert.deepEqual(workflowDispatch('on: push'), { manual: false, inputs: [] });
  assert.deepEqual(workflowDispatch('on:\n  pull_request:\n    paths:\n      - src/**\n'), { manual: false, inputs: [] });
  assert.deepEqual(workflowDispatch('- just a list'), { manual: false, inputs: [] });
  assert.deepEqual(workflowDispatch(''), { manual: false, inputs: [] });
  assert.equal(parseYaml('---\n# nothing\n'), null);
  assert.deepEqual(parseYaml("a: 'x: y'\nb: >\n  folded\n  text\nc:\nd: {}"), { a: 'x: y', b: 'folded text', c: null, d: {} });
});

test('the board lists running runs with their progress, then waiting, then finished ones', () => {
  const rows = runRows(
    {
      runs: [
        run(1, { state: 'failure', status: 'failure', actor: 'ada', startedAt: iso(200_000), updatedAt: iso(80_000) }),
        run(2, { state: 'running', status: 'in_progress', startedAt: iso(65_000), jobs: { done: 1, total: 4, current: 'test', failed: 0 } }),
        run(3, { state: 'pending', status: 'waiting', createdAt: iso(20_000) }),
        run(4, { state: 'running', status: 'in_progress', startedAt: iso(5_000), jobs: { done: 2, total: 3, failed: 1 } }),
        run(5, { state: 'cancelled', status: 'cancelled', event: 'workflow_dispatch', updatedAt: iso(10_000) }),
        run(6, { state: 'running', status: 'in_progress', title: '', startedAt: iso(1_000) }),
      ],
      workflows: [],
      fetchedAt: NOW,
      loading: false,
    },
    NOW,
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    [2, 4, 6, 3, 5, 1],
  );
  const by = new Map(rows.map((r) => [r.id, r]));
  assert.deepEqual([by.get(2)?.side, by.get(2)?.sideSub, by.get(2)?.progress], ['1/4 JOBS  ·  1m 05s', 'test', 0.25]);
  assert.equal(by.get(4)?.sideSub, '1 failed');
  assert.deepEqual([by.get(6)?.title, by.get(6)?.side, by.get(6)?.sideSub, by.get(6)?.progress], ['Release', '1s', 'running', undefined]);
  assert.deepEqual([by.get(3)?.side, by.get(3)?.sideSub], ['NEEDS APPROVAL', 'for 20s']);
  assert.deepEqual([by.get(1)?.side, by.get(1)?.sideSub, by.get(1)?.sub], ['2m 00s', '1m ago', 'main  ·  push  ·  @ada']);
  assert.deepEqual([by.get(5)?.side, by.get(5)?.sideSub, by.get(5)?.sub], ['cancelled', 'just now', 'main  ·  by hand']);
});

/** A forge that answers from what the test sets, and remembers what it was asked to do. */
function fakeForge(forge: 'github' | 'gitlab' = 'github') {
  const calls: string[] = [];
  const f = {
    runs: [] as PipelineRun[],
    fail: '' as string,
    calls,
    source: {
      forge,
      runs: async () => {
        if (f.fail) throw new Error(f.fail);
        return f.runs.map((r) => ({ ...r }));
      },
      jobs: async (id: number) => {
        calls.push(`jobs ${id}`);
        return [githubJob({ id: id * 10, name: 'build', status: 'in_progress' })];
      },
      workflows: async () => [
        { id: 'release.yml', name: 'Release', path: '.github/workflows/release.yml', manual: true, active: true, inputs: [{ name: 'version', required: true, type: 'string' as const }] },
        { id: 'ci.yml', name: 'CI', path: '.github/workflows/ci.yml', manual: false, active: true, inputs: [] },
      ],
      defaultBranch: async () => 'main',
      rerun: async (r: PipelineRun, failed: boolean) => {
        calls.push(`rerun ${r.id} ${failed}`);
        if (r.id === 13) throw new Error('nope');
      },
      cancel: async (r: PipelineRun) => void calls.push(`cancel ${r.id}`),
      run: async (wf: { id: string }, ref: string, inputs: Record<string, string>) => void calls.push(`run ${wf.id} ${ref} ${JSON.stringify(inputs)}`),
    } satisfies PipelineForge,
  };
  return f;
}

test('the floor’s runs are read, counted, and a run that ends in front of the office is told, with whether the office started it', async () => {
  const f = fakeForge();
  const states: boolean[] = [];
  const finished: [number, boolean][] = [];
  const p = new Pipelines(f.source, { state: (s) => states.push(s.loading), finished: (r, ours) => finished.push([r.id, ours]) });
  assert.equal(p.forge, 'github');
  f.runs = [run(1, { state: 'failure', status: 'failure' }), run(2, { state: 'running', status: 'in_progress', createdAt: new Date(Date.now() - 1000).toISOString() })];
  await p.refresh();
  assert.deepEqual(states, [true, false]);
  assert.equal(p.state.defaultBranch, 'main');
  assert.equal(p.state.workflows.length, 2);
  assert.deepEqual(p.state.runs.find((r) => r.id === 2)?.jobs, { done: 0, total: 1, failed: 0, current: 'build' });
  assert.deepEqual(finished, [], 'the first look only learns what is going');

  // Re-run the failed one from the office; the running one finishes on its own.
  assert.equal(await p.rerun(1, true), undefined);
  await p.refresh();
  f.runs = [run(1, { state: 'running', status: 'in_progress' }), run(2, { state: 'success' })];
  await p.refresh();
  assert.deepEqual(finished, [[2, false]]);
  f.runs = [run(1, { state: 'success' }), run(2, { state: 'success' })];
  await p.refresh();
  assert.deepEqual(finished, [
    [2, false],
    [1, true],
  ]);

  // Started by hand: the run that shows up for that workflow and branch is the office's.
  assert.equal(await p.run('release.yml', '', { version: '1.2.3' }), undefined);
  assert.ok(f.calls.includes('run release.yml main {"version":"1.2.3"}'));
  await p.refresh();
  f.runs = [run(3, { state: 'running', path: '.github/workflows/release.yml', createdAt: new Date().toISOString() }), ...f.runs];
  await p.refresh();
  f.runs = [run(3, { state: 'failure', path: '.github/workflows/release.yml' }), ...f.runs.slice(1)];
  await p.refresh();
  assert.deepEqual(finished.at(-1), [3, true]);

  // A failed look keeps what was there and says why.
  f.fail = 'gh: HTTP 502';
  await p.refresh();
  assert.equal(p.state.error, 'gh: HTTP 502');
  assert.equal(p.state.runs.length, 3);
  assert.deepEqual(await p.detail(3), { id: 3, jobs: [githubJob({ id: 30, name: 'build', status: 'in_progress' })] });
});

test('a run that starts and ends between two looks is told too: new since the last look, or on a new attempt', async () => {
  const f = fakeForge();
  const finished: [number, number | undefined][] = [];
  const p = new Pipelines(f.source, { state() {}, finished: (r) => finished.push([r.id, r.attempt]) });
  f.runs = [run(30)];
  await p.refresh();
  const now = new Date().toISOString();
  f.runs = [run(31, { state: 'failure', createdAt: now }), run(30)];
  await p.refresh();
  assert.deepEqual(finished, [[31, undefined]], 'a lint job that failed in seconds');
  await p.refresh();
  assert.equal(finished.length, 1, 'once');
  f.runs = [run(31, { state: 'failure', createdAt: now, attempt: 2 }), run(30)];
  await p.refresh();
  assert.deepEqual(finished.at(-1), [31, 2], 'a re-run that failed as fast');
  f.runs = [run(31, { state: 'failure', createdAt: now, attempt: 2 }), run(30), run(29, { state: 'failure' })];
  await p.refresh();
  assert.equal(finished.length, 2, 'an old run back on the list ran long ago');
});

test('re-runs, cancels and runs are refused when they make no sense, with a reason', async () => {
  const f = fakeForge();
  const p = new Pipelines(f.source, { state() {}, finished() {} });
  f.runs = [run(11, { state: 'running' }), run(12, { state: 'failure' }), run(13, { state: 'failure' })];
  await p.refresh();
  assert.match((await p.rerun(99, false)) ?? '', /no longer on the list/);
  assert.match((await p.rerun(11, false)) ?? '', /still going/);
  assert.equal(await p.rerun(13, false), 'nope');
  assert.match((await p.cancel(99)) ?? '', /no longer on the list/);
  assert.match((await p.cancel(12)) ?? '', /already finished/);
  assert.equal(await p.cancel(11), undefined);
  assert.ok(f.calls.includes('cancel 11'));
  assert.match((await p.run('nope.yml', 'main', {})) ?? '', /no such workflow/);
  assert.match((await p.run('ci.yml', 'main', {})) ?? '', /can't be started by hand/);
  assert.match((await p.run('release.yml', 'main', {})) ?? '', /version is required/);
  assert.match((await p.run('release.yml', '--evil', { version: '1' })) ?? '', /isn't a branch name/);
  assert.match((await p.run('release.yml', 'a b', { version: '1' })) ?? '', /isn't a branch name/);
  assert.equal(await p.run('release.yml', 'feat/x', { version: '1' }), undefined);
});

test('on GitLab, running it all again is a new pipeline the office counts as its own', async () => {
  const f = fakeForge('gitlab');
  const finished: [number, boolean][] = [];
  const p = new Pipelines(f.source, { state() {}, finished: (r, ours) => finished.push([r.id, ours]) });
  f.runs = [run(20, { state: 'failure' })];
  await p.refresh();
  assert.equal(await p.rerun(20, false), undefined);
  await p.refresh();
  f.runs = [run(21, { state: 'running', createdAt: new Date().toISOString() }), run(20, { state: 'failure' })];
  await p.refresh();
  f.runs = [run(21, { state: 'success' }), run(20, { state: 'failure' })];
  await p.refresh();
  assert.deepEqual(finished, [[21, true]]);
});

test('the poll looks quickly while a run is going and someone watches, and seldom when nobody does', async (t) => {
  const f = fakeForge();
  let looks = 0;
  const p = new Pipelines(f.source, { state: (s) => s.loading && looks++, finished() {} });
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: NOW });
  t.after(() => p.stop());
  let active = true;
  p.start(() => active);
  t.mock.timers.tick(2_000);
  await p.refresh();
  assert.equal(looks, 1);
  f.runs = [run(1, { state: 'running' })];
  await p.refresh();
  assert.equal(looks, 2);
  t.mock.timers.tick(8_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(looks, 3, 'every 8s while a run is going');
  active = false;
  t.mock.timers.tick(60_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(looks, 3, 'nobody there: not for a while');
});

/** A fake `gh` and `glab` on PATH, answering from fixtures and logging what they were asked. */
function fakeClis(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'office-pipelines-'));
  const bin = path.join(root, 'bin');
  const repo = path.join(root, 'repo');
  mkdirSync(bin);
  mkdirSync(path.join(repo, '.github', 'workflows'), { recursive: true });
  const log = path.join(root, 'calls.jsonl');
  writeFileSync(log, '');
  const fixtures = {
    runs: { workflow_runs: [{ id: 5, run_number: 9, name: 'Release', status: 'in_progress', event: 'workflow_dispatch', head_branch: 'main', created_at: iso(1000), updated_at: iso(0), path: '.github/workflows/release.yml' }] },
    jobs: { jobs: [{ id: 50, name: 'build', status: 'in_progress', steps: [] }] },
    workflows: {
      workflows: [
        { name: 'Release', path: '.github/workflows/release.yml', state: 'active' },
        { name: 'Remote only', path: '.github/workflows/remote.yml', state: 'active' },
        { name: 'Missing', path: '.github/workflows/missing.yml', state: 'disabled_manually' },
        { name: 'Dependabot', path: 'dynamic/dependabot/dependabot-updates', state: 'active' },
      ],
    },
    remote: Buffer.from('on:\n  workflow_dispatch:\n    inputs:\n      env:\n        type: environment\n').toString('base64'),
    pipelines: { data: { project: { pipelines: { nodes: [{ id: 'gid://gitlab/Ci::Pipeline/77', iid: 3, status: 'RUNNING', ref: 'main', createdAt: iso(1000), updatedAt: iso(0), path: '/g/p/-/pipelines/77' }] } } } },
    glJobs: [
      { id: 2, name: 'test', stage: 'test', status: 'running' },
      { id: 1, name: 'build', stage: 'build', status: 'success' },
      { id: 3, name: 'lint', stage: 'test', status: 'pending' },
    ],
  };
  writeFileSync(path.join(root, 'fixtures.json'), JSON.stringify(fixtures));
  writeFileSync(path.join(repo, '.github', 'workflows', 'release.yml'), 'on:\n  workflow_dispatch:\n    inputs:\n      version:\n        required: true\n');
  const script = (name: string) => `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({ cli: ${JSON.stringify(name)}, args }) + '\\n');
const fx = JSON.parse(fs.readFileSync(path.join(root, 'fixtures.json'), 'utf8'));
if (fs.existsSync(path.join(root, 'fail'))) { process.stderr.write('HTTP 404: Not Found'); process.exit(1); }
const route = args[args.length - 1];
const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
if (${JSON.stringify(name)} === 'gh') {
  if (args[0] === 'repo') out('main\\n');
  else if (args[0] !== 'api') out('');
  else if (route.includes('/jobs')) out(fx.jobs);
  else if (route.includes('/actions/runs')) out(fx.runs);
  else if (route.includes('/actions/workflows')) out(fx.workflows);
  else if (route.includes('contents/.github/workflows/remote.yml')) out(fx.remote);
  else { process.stderr.write('HTTP 404: Not Found'); process.exit(1); }
} else {
  if (args[0] !== 'api') out('');
  else if (route === 'graphql') out(fx.pipelines);
  else if (route.includes('/jobs')) out(fx.glJobs);
  else if (/^projects\\/[^/]+$/.test(route)) out({ default_branch: 'trunk' });
  else out({});
}
`;
  for (const name of ['gh', 'glab']) writeFileSync(path.join(bin, name), script(name), { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous ?? ''}`;
  t.after(() => {
    process.env.PATH = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const calls = () => {
    // A poll can land mid-append. A finished record always ends with a newline, so a trailing segment without one is not a record yet.
    const text = readFileSync(log, 'utf8');
    const lines = text.split('\n');
    if (text.length > 0 && !text.endsWith('\n')) lines.pop();
    return lines.filter(Boolean).map((l) => JSON.parse(l) as { cli: string; args: string[] });
  };
  return { root, repo, calls, fail: () => writeFileSync(path.join(root, 'fail'), '') };
}

test('a GitHub floor reads its Actions through gh, and starts, re-runs and cancels with it', { skip: process.platform === 'win32' }, async (t) => {
  const cli = fakeClis(t);
  const p = floorPipelines(cli.repo, 'github', 'o/r', { state() {}, finished() {} });
  await p.refresh();
  assert.equal(p.state.error, undefined);
  assert.equal(p.state.defaultBranch, 'main');
  assert.deepEqual(p.state.runs[0].jobs, { done: 0, total: 1, failed: 0, current: 'build' });
  assert.deepEqual(
    p.state.workflows.map((w) => [w.id, w.manual, w.active, w.inputs.map((i) => `${i.name}:${i.type}:${i.required}`)]),
    [
      ['release.yml', true, true, ['version:string:true']],
      ['remote.yml', true, true, ['env:environment:false']],
      ['missing.yml', false, false, []],
    ],
  );
  assert.ok(cli.calls().some((c) => c.args.at(-1) === 'repos/{owner}/{repo}/actions/runs/5/jobs?per_page=100&filter=latest'));
  assert.equal(await p.run('release.yml', 'main', { version: '2.0', stray: 'x' }), undefined);
  assert.ok(cli.calls().some((c) => c.args.join(' ') === 'workflow run release.yml --ref main -f version=2.0'));
  assert.equal(await p.cancel(5), undefined);
  assert.ok(cli.calls().some((c) => c.args.join(' ') === 'run cancel 5'));
  await p.refresh();
  p.state = { ...p.state, runs: p.state.runs.map((r) => ({ ...r, state: 'failure' })) };
  assert.equal(await p.rerun(5, true), undefined);
  assert.ok(cli.calls().some((c) => c.args.join(' ') === 'run rerun 5 --failed'));
  const d = await p.detail(5);
  assert.equal(d.jobs[0].name, 'build');
  await p.refresh();
  cli.fail();
  await p.refresh();
  assert.match(p.state.error ?? '', /can't find this repository/);
});

test('a GitLab floor reads its pipelines through glab, jobs in stage order, and runs one with variables', { skip: process.platform === 'win32' }, async (t) => {
  const cli = fakeClis(t);
  const p = floorPipelines(cli.repo, 'gitlab', 'gitlab.example.com/g/p', { state() {}, finished() {} });
  assert.equal(p.forge, 'gitlab');
  await p.refresh();
  assert.equal(p.state.error, undefined);
  assert.equal(p.state.defaultBranch, 'trunk');
  assert.deepEqual(
    p.state.workflows.map((w) => w.id),
    ['pipeline'],
  );
  assert.equal(p.state.runs[0].url, 'https://gitlab.example.com/g/p/-/pipelines/77');
  assert.deepEqual(
    (await p.detail(77)).jobs.map((j) => j.name),
    ['build', 'test', 'lint'],
  );
  assert.equal(await p.run('pipeline', 'main', { DEPLOY: 'staging', 'bad key': 'x', EMPTY: '' }), undefined);
  assert.ok(cli.calls().some((c) => c.cli === 'glab' && c.args.join(' ') === 'ci run --repo https://gitlab.example.com/g/p --branch main --variables DEPLOY:staging'));
  assert.equal(await p.cancel(77), undefined);
  assert.ok(cli.calls().some((c) => c.args.at(-1) === 'projects/g%2Fp/pipelines/77/cancel'));
  await p.refresh();
  p.state = { ...p.state, runs: p.state.runs.map((r) => ({ ...r, state: 'failure' })) };
  assert.equal(await p.rerun(77, true), undefined);
  assert.ok(cli.calls().some((c) => c.args.at(-1) === 'projects/g%2Fp/pipelines/77/retry'));
  await p.refresh();
  p.state = { ...p.state, runs: p.state.runs.map((r) => ({ ...r, state: 'failure' })) };
  assert.equal(await p.rerun(77, false), undefined);
  assert.ok(cli.calls().some((c) => c.args.at(-1) === 'projects/g%2Fp/pipeline' && c.args.includes('ref=main')));
});
