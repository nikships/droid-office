import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { integrateWorker, type ConflictFile } from '../src/server/team-integrate.js';
import { Team, type TeamOptions, type TeamWorkers } from '../src/server/team.js';
import { SUBAGENT_DEFAULTS, type WorkerInfo } from '../src/shared/protocol.js';

function fixture(t: { after(fn: () => void): void }) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'office-integrate-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', '--local', 'user.name', 'droid-office-tests');
  git(dir, 'config', '--local', 'user.email', 'tests@droid-office.local');
  const commit = (cwd: string, file: string, body: string) => {
    writeFileSync(path.join(cwd, file), body);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-qm', `Change ${file}`);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  const base = commit(dir, 'shared.txt', 'base\n');
  // Keep generated worktrees out of the fixture's target status.
  writeFileSync(path.join(dir, '.git', 'info', 'exclude'), '.droid-office/\n');
  const cwd = path.join(dir, '.droid-office', 'worktrees', 'sub');
  git(dir, 'worktree', 'add', '-b', 'office/sub', cwd);
  const worker: WorkerInfo = {
    id: 'sub',
    name: 'Pixel',
    kind: 'agent',
    lead: 'lead',
    deskId: 'desk-2',
    color: '#fff',
    status: 'done',
    acked: true,
    createdAt: 2,
    createdBy: 'test',
    cols: 100,
    rows: 30,
    open: false,
    worktree: { path: cwd, branch: 'office/sub', base },
  };
  const lead: WorkerInfo = { ...worker, id: 'lead', name: 'Lead', lead: undefined, deskId: 'desk-1', worktree: undefined };
  const people = new Map([
    [lead.id, lead],
    [worker.id, worker],
  ]);
  let hired: { from?: string; prompt: string } | undefined;
  const workers: TeamWorkers = {
    list: () => [...people.values()],
    get: (id) => people.get(id),
    officeDefault: undefined,
    deskOccupied: () => false,
    hire: (deskId, _by, prompt, _worktree, _choice, boss, from) => {
      hired = { from, prompt };
      const next = { ...worker, id: 'next', name: 'Fixer', deskId, lead: boss };
      people.set(next.id, next);
      return next;
    },
    prompt: () => undefined,
    resume: () => undefined,
    kill: async () => ({}),
    tail: () => '',
    setTask() {},
  };
  const team = (opts: Partial<TeamOptions> = {}) => {
    const dataDir = path.join(dir, '.droid-office');
    mkdirSync(dataDir, { recursive: true });
    const instance = new Team(workers, { dir, dataDir, git: true, settings: () => ({ ...SUBAGENT_DEFAULTS }), toast() {}, ...opts });
    t.after(() => instance.stop());
    return instance;
  };
  const push = () => {
    const origin = path.join(dir, '.droid-office', 'origin.git');
    if (!existsSync(origin)) {
      git(dir, 'init', '-q', '--bare', origin);
      git(dir, 'remote', 'add', 'origin', origin);
    }
    git(cwd, 'push', '-q', 'origin', 'HEAD');
  };
  return { dir, cwd, git, commit, push, base, worker, lead, people, team, hired: () => hired };
}

test('team merge lands a worker on the lead branch and returns a one-line summary', async (t) => {
  const r = fixture(t);
  const sha = r.commit(r.cwd, 'feature.txt', 'implemented\n');
  const result = await r.team().handle(r.lead, { action: 'merge', worker: 'Pixel' });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'ok');
  assert.equal(result.body.head, sha);
  assert.match(String(result.body.summary), /Landed office\/sub on main.*1 file changed/);
  assert.equal(String(result.body.summary).includes('\n'), false);
  assert.equal(readFileSync(path.join(r.dir, 'feature.txt'), 'utf8'), 'implemented\n');
  assert.equal(r.git(r.cwd, 'branch', '--show-current'), 'office/sub');
  const unchanged = await r.team().handle(r.lead, { action: 'merge', worker: 'Pixel' });
  assert.equal(unchanged.status, 200);
  assert.equal((unchanged.body.artifacts as { mergeCommit?: string }).mergeCommit, undefined);
});

test('another unchecked-out target uses a temporary worktree without switching the floor', async (t) => {
  const r = fixture(t);
  r.git(r.dir, 'branch', 'integration');
  const sha = r.commit(r.cwd, 'feature.txt', 'implemented\n');
  const result = await integrateWorker(r.dir, r.worker, { target: 'integration', mode: 'merge' });
  assert.equal(result.status, 'ok');
  assert.equal(r.git(r.dir, 'rev-parse', 'integration'), sha);
  assert.equal(r.git(r.dir, 'rev-parse', 'main'), r.base);
  assert.equal(r.git(r.dir, 'branch', '--show-current'), 'main');
  assert.equal(
    r
      .git(r.dir, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((line) => line.startsWith('worktree ')).length,
    2,
  );
});

test('a lead in its own worktree integrates there by default, not into the shared checkout', async (t) => {
  const r = fixture(t);
  const leadCwd = path.join(r.dir, '.droid-office', 'worktrees', 'lead');
  r.git(r.dir, 'worktree', 'add', '-b', 'office/lead', leadCwd);
  r.lead.worktree = { path: leadCwd, branch: 'office/lead', base: r.base };
  const sha = r.commit(r.cwd, 'feature.txt', 'feature\n');
  const result = await r.team().handle(r.lead, { action: 'merge', worker: 'sub' });
  assert.equal(result.status, 200);
  assert.equal(result.body.target, 'office/lead');
  assert.equal(r.git(leadCwd, 'rev-parse', 'HEAD'), sha);
  assert.equal(r.git(r.dir, 'rev-parse', 'HEAD'), r.base);
});

test('a non-fast-forward merge combines independent commits', async (t) => {
  const r = fixture(t);
  const source = r.commit(r.cwd, 'feature.txt', 'feature\n');
  const target = r.commit(r.dir, 'lead.txt', 'lead\n');
  const result = await integrateWorker(r.dir, r.worker, { target: 'main', mode: 'merge' });
  assert.equal(result.status, 'ok');
  assert.equal(r.git(r.dir, 'show', '-s', '--format=%P', 'HEAD'), `${target} ${source}`);
  assert.equal(readFileSync(path.join(r.dir, 'feature.txt'), 'utf8'), 'feature\n');
  assert.equal(readFileSync(path.join(r.dir, 'lead.txt'), 'utf8'), 'lead\n');
});

for (const mode of ['merge', 'cherry-pick'] as const) {
  test(`${mode} conflict reports files, stages and hunks and leaves Git ready to resolve`, async (t) => {
    const r = fixture(t);
    r.commit(r.cwd, 'shared.txt', 'worker change\n');
    const before = r.commit(r.dir, 'shared.txt', 'lead change\n');
    const result = await r.team().handle(r.lead, { action: 'merge', worker: 'sub', mode });
    assert.equal(result.status, 409);
    assert.equal(result.body.status, 'blocked');
    assert.equal(result.body.worktree, r.dir);
    assert.equal(r.git(r.dir, 'rev-parse', 'HEAD'), before);
    const [file] = result.body.conflicts as ConflictFile[];
    assert.equal(file.path, 'shared.txt');
    assert.deepEqual(
      file.stages.map((s) => s.stage),
      [1, 2, 3],
    );
    assert.ok(file.hunks.length);
    assert.equal(file.hunks[0].theirs, 'worker change\n');
    assert.equal(file.hunks[0].ours, 'lead change\n');
    assert.match(String(result.body.remaining), /--continue.*--abort/);
    r.git(r.dir, mode, '--abort');
  });
}

test('modify/delete conflicts report index stages even without text hunks', async (t) => {
  const r = fixture(t);
  r.commit(r.cwd, 'shared.txt', 'changed\n');
  r.git(r.dir, 'rm', 'shared.txt');
  r.git(r.dir, 'commit', '-qm', 'Delete shared');
  const result = await integrateWorker(r.dir, r.worker, { target: 'main', mode: 'merge' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.conflicts?.[0].path, 'shared.txt');
  assert.deepEqual(
    result.conflicts?.[0].stages.map((s) => s.stage),
    [1, 3],
  );
  r.git(r.dir, 'merge', '--abort');
});

test('binary conflicts name the file and stages without inventing text hunks', async (t) => {
  const r = fixture(t);
  r.commit(r.cwd, 'shared.txt', '\0worker\n');
  r.commit(r.dir, 'shared.txt', '\0lead\n');
  const result = await integrateWorker(r.dir, r.worker, { target: 'main', mode: 'merge' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.conflicts?.[0].path, 'shared.txt');
  assert.equal(result.conflicts?.[0].stages.length, 3);
  assert.deepEqual(result.conflicts?.[0].hunks, []);
  r.git(r.dir, 'merge', '--abort');
});

test('cherry-pick applies the recorded range in order, or just explicit commits', async (t) => {
  const r = fixture(t);
  r.git(r.dir, 'branch', 'selected');
  const first = r.commit(r.cwd, 'one.txt', 'one\n');
  const second = r.commit(r.cwd, 'two.txt', 'two\n');
  r.commit(r.dir, 'lead.txt', 'lead\n');
  const all = await integrateWorker(r.dir, r.worker, { target: 'main', mode: 'cherry-pick' });
  assert.equal(all.status, 'ok');
  assert.deepEqual(r.git(r.dir, 'log', '--reverse', '--format=%s', `${all.before}..HEAD`).split('\n'), ['Change one.txt', 'Change two.txt']);
  assert.equal(readFileSync(path.join(r.dir, 'one.txt'), 'utf8'), 'one\n');
  const selected = await integrateWorker(r.dir, r.worker, { target: 'selected', mode: 'cherry-pick', commits: [second] });
  assert.equal(selected.status, 'ok');
  assert.equal(r.git(r.dir, 'show', 'selected:two.txt'), 'two');
  assert.throws(() => r.git(r.dir, 'show', 'selected:one.txt'));
  assert.notEqual(first, second);
});

test('conflicts on unchecked-out targets retain their worktree for resolution', async (t) => {
  const r = fixture(t);
  r.commit(r.cwd, 'shared.txt', 'worker\n');
  r.commit(r.dir, 'shared.txt', 'target\n');
  r.git(r.dir, 'branch', 'integration');
  const result = await integrateWorker(r.dir, r.worker, { target: 'integration', mode: 'merge' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.temporaryWorktree, true);
  assert.ok(result.worktree && existsSync(result.worktree));
  assert.equal(r.git(r.dir, 'status', '--porcelain'), '');
  r.git(result.worktree!, 'merge', '--abort');
  r.git(r.dir, 'worktree', 'remove', result.worktree!);
});

test('worker and path handoffs pin committed HEAD and preserve original dirty files', async (t) => {
  const r = fixture(t);
  const sha = r.commit(r.cwd, 'feature.txt', 'committed\n');
  writeFileSync(path.join(r.cwd, 'feature.txt'), 'not committed\n');
  const team = r.team();
  for (const from of ['worker:Pixel', r.cwd]) {
    const result = await team.handle(r.lead, { action: 'hire', task: 'Continue implementation', from, worktree: true });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.handoff, { worker: 'sub', name: 'Pixel', branch: 'office/sub', commit: sha });
    assert.equal(r.hired()?.from, sha);
    assert.match(r.hired()!.prompt, /Handoff: continue from Pixel/);
    assert.equal(readFileSync(path.join(r.cwd, 'feature.txt'), 'utf8'), 'not committed\n');
  }
});

test('team PR uses the current worker branch and the floor forge without pushing', async (t) => {
  const r = fixture(t);
  r.git(r.cwd, 'switch', '-c', 'reviewed');
  r.push();
  const calls: unknown[][] = [];
  const recorded: unknown[][] = [];
  const result = await r
    .team({
      pulls: {
        createPull: async (...args) => {
          calls.push(args);
          return { number: 7, url: 'https://github.com/example/repo/pull/7' };
        },
      },
      onPull: (...args) => {
        recorded.push(args);
      },
    })
    .handle(r.lead, { action: 'pr', worker: 'Pixel', title: 'Feature', body: 'Checks passed', base: 'release' });
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [[r.cwd, 'reviewed', 'release', 'Feature', 'Checks passed']]);
  assert.equal(result.body.branch, 'reviewed');
  assert.deepEqual(recorded, [['sub', { number: 7, url: 'https://github.com/example/repo/pull/7' }]]);
  assert.equal(r.worker.pr?.number, 7);
});

test('plain floors, dirty targets and invalid cherry-pick arguments explain why integration cannot run', async (t) => {
  const r = fixture(t);
  const args = { action: 'merge', worker: 'sub' };
  assert.equal((await r.team({ git: false }).handle(r.lead, args)).status, 400);
  assert.equal((await r.team().handle(r.lead, { ...args, commits: ['HEAD'] })).status, 400);
  writeFileSync(path.join(r.dir, 'shared.txt'), 'owner work\n');
  const result = await r.team().handle(r.lead, args);
  assert.equal(result.status, 409);
  assert.equal(result.body.status, 'blocked');
  assert.match(String(result.body.summary), /uncommitted changes/);
  assert.equal(result.body.worktree, r.dir);
  assert.equal(readFileSync(path.join(r.dir, 'shared.txt'), 'utf8'), 'owner work\n');
});

test('follow-up cherry-pick excludes equivalent landed patches and resolves HEAD in the worker', async (t) => {
  const r = fixture(t);
  r.commit(r.dir, 'lead.txt', 'lead\n');
  r.commit(r.cwd, 'one.txt', 'one\n');
  const first = await integrateWorker(r.dir, r.worker, { target: 'main', mode: 'cherry-pick' });
  assert.equal(first.status, 'ok');
  assert.equal(first.artifacts?.mergeCommit, undefined);
  r.commit(r.cwd, 'two.txt', 'two\n');
  const next = await integrateWorker(r.dir, r.worker, { target: 'main', mode: 'cherry-pick' });
  assert.equal(next.status, 'ok');
  assert.equal(next.artifacts?.commits.length, 1);
  assert.equal(r.git(r.dir, 'show', 'HEAD:two.txt'), 'two');
  r.git(r.dir, 'branch', 'selected', r.base);
  const explicit = await integrateWorker(r.dir, r.worker, { target: 'selected', mode: 'cherry-pick', commits: ['HEAD'] });
  assert.equal(explicit.status, 'ok');
  assert.equal(r.git(r.dir, 'show', 'selected:two.txt'), 'two');
  assert.throws(() => r.git(r.dir, 'show', 'selected:lead.txt'));
});

test('self-targets and another worker checkout are blocked before Git changes', async (t) => {
  const r = fixture(t);
  const team = r.team();
  const self = await team.handle(r.lead, { action: 'merge', worker: 'sub', target: 'office/sub' });
  assert.equal(self.status, 409);
  assert.match(String(self.body.summary), /itself/);
  for (const status of ['working', 'needs_input'] as const) {
    r.people.set('busy', { ...r.lead, id: 'busy', name: 'Busy', status });
    const result = await team.handle(r.lead, { action: 'merge', worker: 'sub' });
    assert.equal(result.status, 409);
    assert.equal(result.body.status, 'blocked');
    assert.match(String(result.body.summary), /Busy/);
  }
  r.people.delete('busy');
  const other = path.join(r.dir, '.droid-office', 'worktrees', 'other');
  r.git(r.dir, 'worktree', 'add', '-b', 'other', other);
  r.people.set('other', { ...r.worker, id: 'other', name: 'Other', status: 'done', worktree: { path: other, branch: 'other' } });
  const result = await team.handle(r.lead, { action: 'merge', worker: 'sub', target: 'other' });
  assert.equal(result.status, 409);
  assert.match(String(result.body.summary), /Other/);
  assert.equal(r.git(other, 'rev-parse', 'HEAD'), r.base);
});

for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG']) {
  test(`pre-existing ${marker} is blocked and left untouched`, async (t) => {
    const r = fixture(t);
    const file = path.join(r.dir, '.git', marker);
    if (marker.startsWith('rebase-')) mkdirSync(file);
    else writeFileSync(file, `${r.base}\n`);
    const result = await r.team().handle(r.lead, { action: 'merge', worker: 'sub' });
    assert.equal(result.status, 409);
    assert.equal(result.body.status, 'blocked');
    assert.match(String(result.body.summary), new RegExp(marker));
    assert.equal(existsSync(file), true);
  });
}

test('non-conflict merge/cherry-pick failures abort Git state and remove temporary targets', async (t) => {
  const r = fixture(t);
  r.commit(r.cwd, 'feature.txt', 'feature\n');
  r.commit(r.dir, 'lead.txt', 'lead\n');
  const hook = path.join(r.dir, '.git', 'hooks', 'commit-msg');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  const before = r.git(r.dir, 'rev-parse', 'HEAD');
  const result = await integrateWorker(r.dir, r.worker, { target: 'main', mode: 'merge' });
  assert.equal(result.status, 'failed');
  assert.equal(existsSync(path.join(r.dir, '.git', 'MERGE_HEAD')), false);
  assert.equal(r.git(r.dir, 'status', '--porcelain'), '');
  assert.equal(r.git(r.dir, 'rev-parse', 'HEAD'), before);
  r.git(r.dir, 'branch', 'temporary-target');
  const temp = await integrateWorker(r.dir, r.worker, { target: 'temporary-target', mode: 'merge' });
  assert.equal(temp.status, 'failed');
  assert.ok(!readdirSync(path.join(r.dir, '.droid-office', 'worktrees')).some((name) => name.startsWith('integration-')));
  rmSync(hook);
  // An explicitly repeated patch is empty, not a conflict; it must not leave CHERRY_PICK_HEAD.
  const empty = await integrateWorker(r.dir, r.worker, { target: 'main', mode: 'cherry-pick', commits: [r.base] });
  assert.equal(empty.status, 'failed');
  assert.equal(existsSync(path.join(r.dir, '.git', 'CHERRY_PICK_HEAD')), false);
  assert.equal(r.git(r.dir, 'status', '--porcelain'), '');
  assert.ok(!String(empty.remaining).includes('--continue'));
});

test('worktree-add failure removes the newly allocated integration directory', async (t) => {
  const r = fixture(t);
  r.git(r.dir, 'branch', 'target');
  const hook = path.join(r.dir, '.git', 'hooks', 'post-checkout');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  await assert.rejects(() => integrateWorker(r.dir, r.worker, { target: 'target', mode: 'merge' }));
  assert.ok(!readdirSync(path.join(r.dir, '.droid-office', 'worktrees')).some((name) => name.startsWith('integration-')));
  assert.equal(
    r
      .git(r.dir, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((line) => line.startsWith('worktree ')).length,
    2,
  );
});

test('handoff accepts canonical aliases, detached workers and dismissed registered worktrees', async (t) => {
  const r = fixture(t);
  const sha = r.commit(r.cwd, 'feature.txt', 'feature\n');
  const alias = path.join(r.dir, '.droid-office', 'alias');
  symlinkSync(r.cwd, alias);
  const team = r.team();
  const linked = await team.handle(r.lead, { action: 'hire', task: 'Continue', from: alias, worktree: true });
  assert.equal(linked.status, 200);
  assert.equal((linked.body.handoff as { commit: string }).commit, sha);
  r.people.delete('next');
  r.git(r.cwd, 'switch', '--detach');
  const detached = await team.handle(r.lead, { action: 'hire', task: 'Continue', from: 'worker:Pixel', worktree: true });
  assert.equal(detached.status, 200);
  assert.equal((detached.body.handoff as { branch: string }).branch, 'office/sub');
  r.people.delete('sub');
  r.people.delete('next');
  const kept = await team.handle(r.lead, { action: 'hire', task: 'Continue', from: r.cwd, worktree: true });
  assert.equal(kept.status, 200);
  assert.equal((kept.body.handoff as { branch: string }).branch, sha.slice(0, 8));
});

test('a retained conflicted integration worktree can start a fresh follow-up at committed HEAD', async (t) => {
  const r = fixture(t);
  r.commit(r.cwd, 'shared.txt', 'worker\n');
  const before = r.commit(r.dir, 'shared.txt', 'lead\n');
  r.git(r.dir, 'branch', 'target');
  const conflict = await integrateWorker(r.dir, r.worker, { target: 'target', mode: 'merge' });
  assert.equal(conflict.status, 'blocked');
  const result = await r.team().handle(r.lead, { action: 'hire', task: 'Follow up', from: conflict.worktree, worktree: true });
  assert.equal(result.status, 200);
  assert.equal((result.body.handoff as { commit: string }).commit, before);
});

test('PR creation blocks unpublished or stale remote heads and defaults to worker then floor base', async (t) => {
  const r = fixture(t);
  const bases: (string | undefined)[] = [];
  const team = r.team({
    baseBranch: () => 'release',
    pulls: {
      createPull: async (_cwd, _branch, base) => {
        bases.push(base);
        return { number: 8, url: 'https://github.com/example/repo/pull/8' };
      },
    },
  });
  const args = { action: 'pr', worker: 'sub', title: 'Feature' };
  assert.equal((await team.handle(r.lead, args)).body.status, 'blocked');
  r.push();
  r.commit(r.cwd, 'feature.txt', 'feature\n');
  assert.equal((await team.handle(r.lead, args)).body.status, 'blocked');
  assert.deepEqual(bases, []);
  r.push();
  assert.equal((await team.handle(r.lead, args)).status, 200);
  r.worker.worktree!.from = 'origin/develop';
  assert.equal((await team.handle(r.lead, args)).status, 200);
  assert.deepEqual(bases, ['release', 'develop']);
  assert.equal((await team.handle(r.lead, { ...args, base: '--draft' })).status, 400);
});

test('adjacent conflict markers produce separate hunks without no-newline annotations', async (t) => {
  const r = fixture(t);
  r.commit(r.dir, 'shared.txt', 'one\nbetween-a\nbetween-b\nbetween-c\nbetween-d\nbetween-e\nlast');
  r.git(r.cwd, 'merge', '--ff-only', 'main');
  r.commit(r.cwd, 'shared.txt', 'worker one\nbetween-a\nbetween-b\nbetween-c\nbetween-d\nbetween-e\nworker last');
  r.commit(r.dir, 'shared.txt', 'lead one\nbetween-a\nbetween-b\nbetween-c\nbetween-d\nbetween-e\nlead last');
  const result = await integrateWorker(r.dir, r.worker, { target: 'main', mode: 'merge' });
  assert.equal(result.status, 'blocked');
  const hunks = result.conflicts![0].hunks;
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].header, hunks[1].header, 'both conflict blocks are inside the same combined diff hunk');
  assert.equal(hunks[0].ours, 'lead one\n');
  assert.equal(hunks[1].theirs, 'worker last\n');
  assert.ok(!JSON.stringify(hunks).includes('No newline at end of file'));
});
