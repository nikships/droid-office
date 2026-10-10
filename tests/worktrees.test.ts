import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Changes } from '../src/server/changes.js';
import { Worktrees } from '../src/server/worktrees.js';

/**
 * A project cloned from a bare origin, plus a second clone standing in for the forge: whatever it
 * pushes is a pull request merged there, which the project hasn't pulled.
 */
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'office-worktrees-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const origin = path.join(root, 'origin.git');
  run(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const dir = path.join(root, 'project');
  run(root, 'clone', '-q', origin, dir);
  run(dir, 'checkout', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'a.txt'), 'a');
  run(dir, 'add', '.');
  run(dir, 'commit', '-qm', 'a');
  run(dir, 'push', '-q', '-u', 'origin', 'main');
  const github = path.join(root, 'github');
  run(root, 'clone', '-q', origin, github);
  const commit = (cwd: string, file: string) => {
    writeFileSync(path.join(cwd, file), file);
    run(cwd, 'add', '.');
    run(cwd, 'commit', '-qm', file);
    return run(cwd, 'rev-parse', 'HEAD');
  };
  const merge = (file: string) => {
    run(github, 'pull', '-q', '--ff-only');
    const sha = commit(github, file);
    run(github, 'push', '-q', 'origin', 'main');
    return sha;
  };
  return { root, dir, git: (...args: string[]) => run(dir, ...args), commit: (file: string) => commit(dir, file), merge };
}

test("a worktree starts from the PR merged on origin, not from the project's stale checkout", async (t) => {
  const f = fixture(t);
  const stale = f.git('rev-parse', 'HEAD');
  const merged = f.merge('fix.txt');
  const trees = new Worktrees(f.dir);
  // Nothing fetched it yet: the project's main and its origin/main both still say `stale`.
  assert.equal(f.git('rev-parse', 'origin/main'), stale);
  const fetching = trees.fetch();
  assert.ok(fetching, 'fetches the first time');
  await fetching;
  assert.equal(f.git('rev-parse', 'origin/main'), merged);
  // A burst of hires shares that fetch.
  assert.equal(trees.fetch(), undefined);
  const made = trees.create('rex-1');
  assert.ok(typeof made !== 'string', String(made));
  if (typeof made === 'string') return;
  assert.equal(made.base, merged);
  assert.equal(made.from, 'main');
  assert.equal(made.note, undefined);
  assert.ok(existsSync(path.join(f.dir, made.path, 'fix.txt')), 'the worktree has the merged fix');
  // The project's own checkout is left where it was.
  assert.equal(f.git('rev-parse', 'HEAD'), stale);
});

test('a project ahead of origin (commits not pushed yet) still branches from its HEAD', async (t) => {
  const f = fixture(t);
  const local = f.commit('wip.txt');
  const trees = new Worktrees(f.dir);
  await trees.fetch();
  const made = trees.create('rex-2');
  assert.ok(typeof made !== 'string', String(made));
  if (typeof made === 'string') return;
  assert.equal(made.base, local);
  assert.equal(made.note, undefined);
});

test("when both moved on, it starts from origin's and says what it left out", async (t) => {
  const f = fixture(t);
  const merged = f.merge('fix.txt');
  f.commit('wip1.txt');
  f.commit('wip2.txt');
  const trees = new Worktrees(f.dir);
  await trees.fetch();
  const made = trees.create('rex-3');
  assert.ok(typeof made !== 'string', String(made));
  if (typeof made === 'string') return;
  assert.equal(made.base, merged);
  assert.match(made.note ?? '', /origin\/main.*2 commits on main/);
});

test('without an origin, or offline, it branches from HEAD as before', async (t) => {
  const f = fixture(t);
  f.merge('fix.txt');
  f.git('remote', 'set-url', 'origin', path.join(f.root, 'nowhere.git'));
  const trees = new Worktrees(f.dir);
  await trees.fetch();
  const made = trees.create('rex-4');
  assert.ok(typeof made !== 'string', String(made));
  if (typeof made === 'string') return;
  assert.equal(made.base, f.git('rev-parse', 'HEAD'));
  f.git('remote', 'remove', 'origin');
  const again = new Worktrees(f.dir);
  assert.equal(again.fetch(), undefined, 'nothing to fetch from');
  const other = again.create('rex-5');
  assert.ok(typeof other !== 'string', String(other));
  if (typeof other === 'string') return;
  assert.equal(other.base, f.git('rev-parse', 'HEAD'));
});

test('on a detached HEAD there is no branch to fetch', (t) => {
  const f = fixture(t);
  f.git('checkout', '-q', '--detach');
  const trees = new Worktrees(f.dir);
  assert.equal(trees.fetch(), undefined);
  const made = trees.create('rex-6');
  assert.ok(typeof made !== 'string', String(made));
  if (typeof made === 'string') return;
  assert.equal(made.base, f.git('rev-parse', 'HEAD'));
  assert.equal(made.from, undefined);
});

test("the Changes window doesn't count PRs merged on origin as the worker's changes", async (t) => {
  const f = fixture(t);
  f.merge('fix.txt');
  const trees = new Worktrees(f.dir);
  await trees.fetch();
  const made = trees.create('rex-7');
  assert.ok(typeof made !== 'string', String(made));
  if (typeof made === 'string') return;
  const cwd = path.join(f.dir, made.path);
  writeFileSync(path.join(cwd, 'mine.txt'), 'mine');
  execFileSync('git', ['add', 'mine.txt'], { cwd });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'mine'], { cwd });
  const target = { name: 'Rex', cwd, rel: made.path, worktreeBase: made.base };
  const changes = new Changes(
    'main',
    () => target,
    () => undefined,
    { state() {}, toast() {}, refreshGitHub() {} },
  );
  t.after(() => changes.stop());
  const state = await (changes as unknown as { compute(id: string, t: typeof target): Promise<{ files: { path: string }[]; ahead: number; error?: string }> }).compute('w1', target);
  assert.equal(state.error, undefined);
  assert.deepEqual(
    state.files.map((x) => x.path),
    ['mine.txt'],
  );
  assert.equal(state.ahead, 1);
});

test('a worktree deleted with its branch comes back from origin when it was pushed', async (t) => {
  const f = fixture(t);
  const trees = new Worktrees(f.dir);
  const made = trees.create('rex-9');
  assert.ok(typeof made !== 'string', String(made));
  const abs = path.join(f.dir, made.path);
  const run = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: abs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  writeFileSync(path.join(abs, 'pushed.txt'), 'pushed');
  run('add', '.');
  run('commit', '-qm', 'pushed');
  run('push', '-q', 'origin', made.branch);
  const pushed = run('rev-parse', 'HEAD');
  assert.equal(trees.branchState(made.branch), 'here');
  rmSync(abs, { recursive: true, force: true });
  f.git('worktree', 'prune');
  f.git('branch', '-D', made.branch);
  assert.equal(trees.branchState(made.branch), 'origin');
  assert.deepEqual(await trees.restore(made), { from: 'origin' });
  assert.equal(run('rev-parse', 'HEAD'), pushed);
  assert.equal(run('rev-parse', '--abbrev-ref', 'HEAD'), made.branch);
  // Checked out somewhere else already, it can't come back here: git says why.
  rmSync(abs, { recursive: true, force: true });
  f.git('worktree', 'prune');
  f.git('checkout', '-q', made.branch);
  const refused = await trees.restore(made);
  assert.ok('error' in refused && /already (checked out|used by worktree)/.test(refused.error), JSON.stringify(refused));
});

test("with 'main', a worktree is cut from origin's latest main whatever branch the checkout is on", async (t) => {
  const f = fixture(t);
  f.git('checkout', '-q', '-b', 'feature');
  const wip = f.commit('wip.txt');
  const merged = f.merge('fix.txt');
  const trees = new Worktrees(f.dir);
  assert.equal(trees.defaultBranch(), 'main');
  await trees.fetch('main');
  assert.equal(f.git('rev-parse', 'origin/main'), merged);
  const made = trees.create('rex-10', undefined, f.dir, 'main');
  assert.ok(typeof made !== 'string', String(made));
  if (typeof made === 'string') return;
  assert.equal(made.base, merged);
  assert.equal(made.from, 'main');
  assert.ok(!existsSync(path.join(f.dir, made.path, 'wip.txt')), "the checkout's own branch isn't in it");
  // The checkout stays on its branch, untouched.
  assert.equal(f.git('rev-parse', '--abbrev-ref', 'HEAD'), 'feature');
  assert.equal(f.git('rev-parse', 'HEAD'), wip);
  // 'checkout' is the branch the checkout is on, as before.
  const own = trees.create('rex-11');
  assert.ok(typeof own !== 'string', String(own));
  if (typeof own === 'string') return;
  assert.equal(own.base, wip);
  assert.equal(own.from, 'feature');
});

test("the default branch is origin/HEAD's when it's set, else main or master", (t) => {
  const f = fixture(t);
  f.git('branch', 'trunk');
  f.git('push', '-q', 'origin', 'trunk');
  const trees = new Worktrees(f.dir);
  assert.equal(trees.defaultBranch(), 'main');
  f.git('remote', 'set-head', 'origin', 'trunk');
  assert.equal(trees.defaultBranch(), 'trunk');
  const bare = mkdtempSync(path.join(tmpdir(), 'office-no-main-'));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'dev', bare]);
  assert.equal(new Worktrees(bare).defaultBranch(), undefined);
});

test('a start names a branch, a branch only on origin, or a commit, read from where the lead is', async (t) => {
  const f = fixture(t);
  const trees = new Worktrees(f.dir);
  const lead = trees.create('lead-1');
  assert.ok(typeof lead !== 'string', String(lead));
  if (typeof lead === 'string') return;
  const cwd = path.join(f.dir, lead.path);
  writeFileSync(path.join(cwd, 'lead.txt'), 'lead');
  execFileSync('git', ['add', '.'], { cwd });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'lead'], { cwd });
  const leadHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  assert.deepEqual(trees.resolve('HEAD', cwd), { commit: leadHead, branch: lead.branch });
  assert.deepEqual(trees.resolve('HEAD'), { commit: f.git('rev-parse', 'HEAD'), branch: 'main' });
  assert.deepEqual(trees.resolve(lead.branch), { commit: leadHead, branch: lead.branch });
  const merged = f.merge('fix.txt');
  await trees.fetch('main');
  assert.deepEqual(trees.resolve('origin/main'), { commit: merged, branch: 'main' });
  f.git('push', '-q', 'origin', `${lead.branch}:only-there`);
  f.git('fetch', '-q', 'origin');
  assert.deepEqual(trees.resolve('only-there'), { commit: leadHead, branch: 'only-there' });
  assert.deepEqual(trees.resolve(leadHead.slice(0, 10)), { commit: leadHead });
  assert.equal(trees.resolve('no-such-branch'), undefined);
  const sub = trees.create('sub-1', undefined, f.dir, trees.resolve('HEAD', cwd)!);
  assert.ok(typeof sub !== 'string', String(sub));
  if (typeof sub === 'string') return;
  assert.equal(sub.base, leadHead);
  assert.equal(sub.from, lead.branch);
  assert.ok(existsSync(path.join(f.dir, sub.path, 'lead.txt')), 'it has what the lead committed');
});

test("freshening switches a clean checkout to main and brings it up to origin's", async (t) => {
  const f = fixture(t);
  f.git('checkout', '-q', '-b', 'feature');
  f.commit('wip.txt');
  // Untracked files come along: nothing on main is in their way.
  writeFileSync(path.join(f.dir, 'notes.txt'), 'mine');
  const merged = f.merge('fix.txt');
  const trees = new Worktrees(f.dir);
  await trees.fetch('main');
  assert.deepEqual(trees.freshen(), { main: 'main', branch: 'main', switchedFrom: 'feature' });
  assert.equal(f.git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(f.git('rev-parse', 'HEAD'), merged);
  assert.ok(existsSync(path.join(f.dir, 'notes.txt')));
  // Already there: nothing to do, and nothing to say.
  assert.deepEqual(trees.freshen(), { main: 'main', branch: 'main' });
  // On main and behind, with a change git can carry: fast-forwarded, the change kept.
  writeFileSync(path.join(f.dir, 'a.txt'), 'edited');
  const next = f.merge('more.txt');
  await new Worktrees(f.dir).fetch('main');
  assert.deepEqual(trees.freshen(), { main: 'main', branch: 'main' });
  assert.equal(f.git('rev-parse', 'HEAD'), next);
  assert.equal(f.git('status', '--porcelain', '--untracked-files=no'), 'M a.txt');
});

test("freshening leaves the checkout alone when that would get in someone's way, and says why", async (t) => {
  const f = fixture(t);
  f.git('checkout', '-q', '-b', 'feature');
  f.merge('fix.txt');
  const trees = new Worktrees(f.dir);
  await trees.fetch('main');
  const head = f.git('rev-parse', 'HEAD');
  const stays = (r: ReturnType<Worktrees['freshen']>, why: RegExp) => {
    assert.match(r.kept ?? '', why);
    assert.equal(r.switchedFrom, undefined);
    assert.equal(f.git('rev-parse', 'HEAD'), head);
  };
  stays(trees.freshen(['Pixel']), /^Pixel is working in it$/);
  stays(trees.freshen(['Pixel', 'Byte', 'a guest']), /^Pixel, Byte and a guest are working in it$/);
  writeFileSync(path.join(f.dir, 'a.txt'), 'edited');
  stays(trees.freshen(), /^it has 1 uncommitted change on feature$/);
  f.git('checkout', '-q', '--', 'a.txt');
  // An untracked file where main has one: git refuses to switch, and that's what it says.
  writeFileSync(path.join(f.dir, 'fix.txt'), 'mine');
  stays(trees.freshen(), /git wouldn't switch it to main: .*fix\.txt/s);
  rmSync(path.join(f.dir, 'fix.txt'));
  f.git('checkout', '-q', '--detach');
  stays(trees.freshen(), /isn't on a branch/);
  f.git('checkout', '-q', 'feature');
  // Main has commits origin doesn't: switched to, but not moved past them.
  f.git('checkout', '-q', 'main');
  const local = f.commit('local.txt');
  f.git('checkout', '-q', 'feature');
  const r = trees.freshen();
  assert.equal(r.switchedFrom, 'feature');
  assert.match(r.kept ?? '', /main here has 1 commit that origin doesn't have/);
  assert.equal(f.git('rev-parse', 'HEAD'), local);
});

test('freshening waits out a merge under way', (t) => {
  const f = fixture(t);
  f.git('checkout', '-q', '-b', 'feature');
  writeFileSync(path.join(f.dir, 'a.txt'), 'feature');
  f.git('commit', '-qam', 'feature');
  f.git('checkout', '-q', 'main');
  writeFileSync(path.join(f.dir, 'a.txt'), 'main');
  f.git('commit', '-qam', 'main');
  f.merge('fix.txt');
  f.git('fetch', '-q', 'origin');
  assert.throws(() => f.git('merge', '-q', 'feature'));
  const r = new Worktrees(f.dir).freshen();
  assert.match(r.kept ?? '', /merge, rebase or cherry-pick is under way/);
});
