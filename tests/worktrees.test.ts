import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Changes } from '../src/server/changes.js';
import { Worktrees } from '../src/server/worktrees.js';
import { githubPulls } from '../src/server/github.js';
import type { ChangesState } from '../src/shared/protocol.js';

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

test('forks copy staged, unstaged, binary, deleted, executable and untracked files without touching the source', (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.dir, 'removed.txt'), 'remove me');
  writeFileSync(path.join(f.dir, 'image.bin'), Buffer.from([0, 1, 2]));
  writeFileSync(path.join(f.dir, '.gitignore'), '.env\n.droid-office/\n');
  f.git('add', '.');
  f.git('commit', '-qm', 'snapshot inputs');
  writeFileSync(path.join(f.dir, 'a.txt'), 'staged\n');
  f.git('add', 'a.txt');
  writeFileSync(path.join(f.dir, 'a.txt'), 'staged\nand unstaged\n');
  writeFileSync(path.join(f.dir, 'image.bin'), Buffer.from([0, 255, 17, 0]));
  chmodSync(path.join(f.dir, 'a.txt'), 0o755);
  unlinkSync(path.join(f.dir, 'removed.txt'));
  const odd = 'a folder/untracked\nfile.txt';
  mkdirSync(path.join(f.dir, 'a folder'));
  writeFileSync(path.join(f.dir, odd), 'new file');
  symlinkSync('a.txt', path.join(f.dir, 'link'));
  writeFileSync(path.join(f.dir, '.env'), 'LOCAL=source');
  const head = f.git('rev-parse', 'HEAD');
  const status = f.git('status', '--porcelain=v1', '-z');
  const staged = f.git('diff', '--cached', '--binary');
  const unstaged = f.git('diff', '--binary');
  const index = readFileSync(path.join(f.dir, '.git', 'index'));
  const trees = new Worktrees(f.dir);
  trees.saveBranch('missing-floor-override');
  const made = trees.fork('twin', f.dir);
  assert.ok(typeof made !== 'string', String(made));
  if (typeof made === 'string') return;
  const target = path.join(f.dir, made.path);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: target, encoding: 'utf8' }).trim();
  assert.equal(made.base, head, 'does not fetch or use the floor override');
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('diff', '--cached', '--binary'), staged);
  assert.equal(git('diff', '--binary'), unstaged);
  assert.deepEqual(readFileSync(path.join(target, 'image.bin')), Buffer.from([0, 255, 17, 0]));
  assert.equal(readFileSync(path.join(target, odd), 'utf8'), 'new file');
  assert.equal(readlinkSync(path.join(target, 'link')), 'a.txt');
  assert.equal(existsSync(path.join(target, 'removed.txt')), false);
  assert.equal(existsSync(path.join(target, '.env')), false, 'ignored files are left to the normal setup');
  assert.equal(existsSync(path.join(target, '.droid-office')), false, 'runtime state is never copied');
  assert.deepEqual(readFileSync(path.join(f.dir, '.git', 'index')), index);
  assert.equal(f.git('status', '--porcelain=v1', '-z'), status);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.git('stash', 'list'), '');
  writeFileSync(path.join(target, 'a.txt'), 'alternative');
  assert.equal(readFileSync(path.join(f.dir, 'a.txt'), 'utf8'), 'staged\nand unstaged\n');
});

test('forks start at a detached source HEAD and preserve staged additions deleted from the working tree', (t) => {
  const f = fixture(t);
  f.git('switch', '--detach', '-q');
  writeFileSync(path.join(f.dir, 'new.txt'), 'indexed');
  f.git('add', 'new.txt');
  unlinkSync(path.join(f.dir, 'new.txt'));
  const made = new Worktrees(f.dir).fork('detached-twin', f.dir);
  assert.ok(typeof made !== 'string', String(made));
  if (typeof made === 'string') return;
  const target = path.join(f.dir, made.path);
  assert.equal(execFileSync('git', ['show', ':new.txt'], { cwd: target, encoding: 'utf8' }), 'indexed');
  assert.equal(existsSync(path.join(target, 'new.txt')), false);
});

test('forks refuse unresolved conflicts and changed gitlinks without making a new branch', (t) => {
  const f = fixture(t);
  const trees = new Worktrees(f.dir);
  f.git('switch', '-q', '-c', 'conflicting');
  writeFileSync(path.join(f.dir, 'a.txt'), 'other');
  f.git('commit', '-qam', 'other edit');
  f.git('switch', '-q', 'main');
  writeFileSync(path.join(f.dir, 'a.txt'), 'main');
  f.git('commit', '-qam', 'main edit');
  assert.throws(() => f.git('merge', 'conflicting'));
  assert.match(String(trees.fork('conflicted', f.dir)), /conflicts before forking/);
  assert.equal(trees.branchState('office/conflicted'), 'gone');
  f.git('merge', '--abort');
  f.git('update-index', '--add', '--cacheinfo', `160000,${f.git('rev-parse', 'HEAD')},submodule`);
  assert.match(String(trees.fork('submodule', f.dir)), /submodule changes before forking/);
  assert.equal(trees.branchState('office/submodule'), 'gone');
});

test('a failed fork cleans up only its new worktree and branch', (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.dir, 'untracked'), 'source');
  const trees = new Worktrees(f.dir);
  const create = trees.create.bind(trees);
  trees.create = (...args) => {
    const made = create(...args);
    if (typeof made !== 'string') writeFileSync(path.join(f.dir, made.path, 'untracked'), 'collision');
    return made;
  };
  assert.match(String(trees.fork('broken-twin', f.dir)), /Could not fork/);
  assert.equal(existsSync(path.join(f.dir, '.droid-office', 'worktrees', 'broken-twin')), false);
  assert.equal(trees.branchState('office/broken-twin'), 'gone');
  assert.equal(readFileSync(path.join(f.dir, 'untracked'), 'utf8'), 'source');
});

test('a saved floor branch overrides main and checkout starts, survives new instances, and resets to the default', async (t) => {
  const f = fixture(t);
  f.git('switch', '-q', '-c', 'release/next');
  const release = f.commit('release.txt');
  f.git('push', '-q', 'origin', 'release/next');
  f.git('switch', '-q', 'main');
  const trees = new Worktrees(f.dir);
  assert.equal(trees.baseBranch(), 'main');
  trees.saveBranch('release/next');
  assert.equal(new Worktrees(f.dir).selectedBranch(), 'release/next');
  assert.equal(trees.defaultBranch(), 'main', 'the forge default is unchanged');
  assert.equal(trees.baseBranch(), 'release/next');
  assert.ok(trees.branches().includes('release/next'));
  await trees.fetch('main');
  for (const start of ['main', 'checkout'] as const) {
    const made = trees.create(`picked-${start}`, undefined, f.dir, start);
    assert.notEqual(typeof made, 'string', String(made));
    if (typeof made === 'string') return;
    assert.equal(made.from, 'release/next');
    assert.equal(made.base, release);
    assert.ok(!trees.branches().includes(made.branch), 'a branch checked out in a worker worktree is not a selectable floor base');
  }
  assert.equal(f.git('branch', '--show-current'), 'main', 'worktree creation never moves the checkout');
  assert.equal(trees.freshen().branch, 'release/next');
  assert.equal(trees.delivered([{ state: 'MERGED', headRefName: 'release/next', headRefOid: release }]), false, 'never settle away from the selected base');
  trees.saveBranch(null);
  assert.equal(new Worktrees(f.dir).selectedBranch(), undefined);
  assert.equal(trees.freshen().branch, 'main');
});

test('invalid and missing saved floor branches never become arbitrary worktree bases', (t) => {
  const f = fixture(t);
  const trees = new Worktrees(f.dir);
  for (const branch of ['--detach', '@{-1}', 'bad name', 'bad..branch']) assert.throws(() => trees.saveBranch(branch), /Invalid branch/);
  trees.saveBranch('gone');
  assert.match(String(trees.create('missing', undefined, f.dir, 'main')), /selected floor branch gone no longer exists/);
  writeFileSync(path.join(f.dir, '.droid-office', 'floor-branch.json'), '{broken');
  assert.equal(trees.selectedBranch(), undefined);
});

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

test('workers at rest keep the checkout on their branch, but not from fast-forwarding main', async (t) => {
  const f = fixture(t);
  f.merge('fix.txt');
  const trees = new Worktrees(f.dir);
  await trees.fetch('main');
  // On a stale main, a worker at rest doesn't mind it moving up.
  assert.deepEqual(trees.freshen([], ['Pixel']), { main: 'main', branch: 'main' });
  assert.equal(f.git('rev-parse', 'HEAD'), f.git('rev-parse', 'origin/main'));
  // On another branch, it might come back to it: left alone, and one mid-turn always blocks.
  f.git('checkout', '-q', '-b', 'feature');
  f.merge('more.txt');
  await new Worktrees(f.dir).fetch('main');
  const r = trees.freshen([], ['Pixel']);
  assert.match(r.kept ?? '', /^Pixel is working in it$/);
  assert.equal(f.git('rev-parse', '--abbrev-ref', 'HEAD'), 'feature');
  assert.equal(trees.freshen([], []).switchedFrom, 'feature');
});

test("a branch counts as delivered once a merged pull request ends at the commit it's on", (t) => {
  const f = fixture(t);
  const trees = new Worktrees(f.dir);
  const merged = (oid?: string) => [{ state: 'MERGED', headRefName: 'feature', headRefOid: oid }];
  assert.equal(trees.delivered(merged('x')), false, 'main is never delivered');
  f.git('checkout', '-q', '-b', 'feature');
  f.commit('work.txt');
  const head = f.git('rev-parse', 'HEAD');
  assert.equal(trees.delivered([]), false);
  assert.equal(trees.delivered([{ state: 'OPEN', headRefName: 'feature', headRefOid: head }]), false);
  assert.equal(trees.delivered(merged('0'.repeat(40))), false, 'it has moved past what merged');
  assert.equal(trees.delivered(merged(head)), true);
  assert.equal(trees.delivered([{ state: 'MERGED', headRefName: 'other', headRefOid: head }]), false);
});

test("a start point behind its branch on origin is moved up to origin's, and only then", async (t) => {
  const f = fixture(t);
  const stale = f.git('rev-parse', 'HEAD');
  const merged = f.merge('fix.txt');
  const trees = new Worktrees(f.dir);
  // Not fetched yet: origin/main still says stale.
  assert.deepEqual(trees.caughtUp({ commit: stale, branch: 'main' }), { commit: stale, branch: 'main' });
  await trees.refresh('main');
  assert.deepEqual(trees.caughtUp({ commit: stale, branch: 'main' }), { commit: merged, branch: 'main' });
  assert.deepEqual(trees.caughtUp({ commit: merged, branch: 'main' }), { commit: merged, branch: 'main' });
  // A commit on a branch origin doesn't have, or no branch at all, stays.
  assert.deepEqual(trees.caughtUp({ commit: stale }), { commit: stale });
  assert.deepEqual(trees.caughtUp({ commit: stale, branch: 'office/x' }), { commit: stale, branch: 'office/x' });
  assert.equal(trees.refresh('office/x'), undefined);
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

for (const mode of ['switch', 'create', 'merge', 'local'] as const) {
  test(`freshening preserves ignored files during ${mode}`, async (t) => {
    const f = fixture(t);
    const merged = f.merge('config.txt');
    const trees = new Worktrees(f.dir);
    await trees.fetch('main');
    if (mode !== 'merge') f.git('switch', '-q', '-c', 'feature');
    if (mode === 'create') f.git('branch', '-D', 'main');
    if (mode === 'local') {
      f.git('branch', '-f', 'main', merged);
      f.git('remote', 'remove', 'origin');
    }
    writeFileSync(path.join(f.dir, '.git', 'info', 'exclude'), '/config.txt\n');
    writeFileSync(path.join(f.dir, 'config.txt'), 'local configuration');
    const before = f.git('rev-parse', 'HEAD');
    const branch = f.git('rev-parse', '--abbrev-ref', 'HEAD');
    const result = trees.freshen();
    assert.match(result.kept ?? '', /config\.txt/);
    assert.equal(result.switchedFrom, undefined);
    assert.equal(readFileSync(path.join(f.dir, 'config.txt'), 'utf8'), 'local configuration');
    assert.equal(f.git('rev-parse', 'HEAD'), before);
    assert.equal(f.git('rev-parse', '--abbrev-ref', 'HEAD'), branch);
  });
}

test('an explicit origin ref fetches that branch, including one outside a single-branch clone', async (t) => {
  const f = fixture(t);
  f.git('switch', '-q', '-c', 'feature');
  const stale = f.git('rev-parse', 'origin/main');
  const merged = f.merge('latest-main.txt');
  const trees = new Worktrees(f.dir);
  await trees.fetchRef('origin/main');
  assert.equal(trees.resolve('origin/main')?.commit, merged);
  assert.notEqual(merged, stale);
  assert.equal(f.git('rev-parse', '--abbrev-ref', 'HEAD'), 'feature');
  assert.equal(trees.fetchRef('origin/main'), undefined, 'a burst shares the fetched branch');
  // Simulate a clone whose configured refspec would not update this remote-tracking branch.
  f.git('config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
  f.git('push', '-q', 'origin', 'main:only-origin');
  assert.equal(trees.resolve('only-origin'), undefined);
  const fetching = trees.fetchRef('only-origin');
  assert.ok(fetching);
  assert.equal(trees.fetchRef('origin/only-origin'), fetching);
  await fetching;
  assert.equal(trees.resolve('only-origin')?.commit, f.git('rev-parse', 'main'));
  assert.equal(f.git('rev-parse', '--abbrev-ref', 'HEAD'), 'feature');
});

test('explicit local branches, tags, commits and a lead’s HEAD need no fetch', (t) => {
  const f = fixture(t);
  const trees = new Worktrees(f.dir);
  const lead = trees.create('local-lead');
  assert.ok(typeof lead !== 'string');
  const cwd = path.join(f.dir, lead.path);
  const head = f.git('rev-parse', 'HEAD');
  f.git('tag', 'v1');
  for (const ref of ['HEAD', 'main', lead.branch, 'v1', head, `${head}~0`, 'two words']) assert.equal(trees.fetchRef(ref, cwd), undefined, ref);
});

for (const published of [false, true]) {
  test(`the Changes PR ${published ? 'targets a published lead' : 'falls back from an unpublished lead'}, without changing its diff base`, async (t) => {
    const f = fixture(t);
    const trees = new Worktrees(f.dir);
    const lead = trees.create('pr-lead');
    assert.ok(typeof lead !== 'string');
    const leadDir = path.join(f.dir, lead.path);
    writeFileSync(path.join(leadDir, 'plan.txt'), 'plan');
    f.git('-C', leadDir, 'add', 'plan.txt');
    f.git('-C', leadDir, 'commit', '-qm', 'plan');
    if (published) f.git('-C', leadDir, 'push', '-q', 'origin', lead.branch);
    const sub = trees.create('pr-sub', undefined, f.dir, trees.resolve('HEAD', leadDir)!);
    assert.ok(typeof sub !== 'string');
    const cwd = path.join(f.dir, sub.path);
    writeFileSync(path.join(cwd, 'work.txt'), 'work');
    f.git('-C', cwd, 'add', 'work.txt');
    f.git('-C', cwd, 'commit', '-qm', 'work');
    const target = { name: 'Sub', cwd, rel: sub.path, worktreeBase: sub.base, baseBranch: sub.from, prBaseFallback: 'unpublished-checkout' };
    const bases: (string | undefined)[] = [];
    const changes = new Changes(
      'unpublished-checkout',
      () => target,
      () => undefined,
      { state() {}, toast() {}, refreshGitHub() {} },
      {
        ...githubPulls,
        createPull: async (_cwd, _head, base) => {
          assert.ok(f.git('ls-remote', '--heads', 'origin', `refs/heads/${base}`), 'the PR base exists on origin');
          bases.push(base);
          return { number: 1, url: 'https://example.invalid/pull/1' };
        },
      },
    );
    t.after(() => changes.stop());
    const state = await (changes as unknown as { compute(w: { workerId: string }, t: typeof target): Promise<ChangesState> }).compute({ workerId: 'sub' }, target);
    assert.equal(state.error, undefined);
    assert.deepEqual(
      state.files.map((f) => f.path),
      ['work.txt'],
    );
    assert.equal(state.ahead, 1);
    assert.equal(state.prBase, published ? lead.branch : 'main');
    assert.equal(await changes.pullRequest('sub', 'Subtask', 'A task', 'test'), undefined);
    assert.deepEqual(bases, [published ? lead.branch : 'main']);
  });
}
