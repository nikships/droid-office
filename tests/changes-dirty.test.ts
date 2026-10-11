import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Changes } from '../src/server/changes.js';
import type { ChangesState } from '../src/shared/protocol.js';

/** Everything, including the remote and PR host, stays local to this temporary fixture. */
function fixture(t: TestContext, initial: Record<string, string> = { 'demo.txt': 'baseline\n' }) {
  // Actions refresh the watcher themselves; a background poll must not race fixture assertions.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const root = mkdtempSync(path.join(tmpdir(), 'office-changes-dirty-'));
  const dir = path.join(root, 'repo');
  const remote = path.join(root, 'origin.git');
  mkdirSync(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (file: string, content: string) => writeFileSync(path.join(dir, file), content);
  const read = (file: string) => readFileSync(path.join(dir, file), 'utf8');
  let head = '';
  const commit = (message = 'Fixture change') => {
    git('add', '-A');
    // These are fixed fixture-object bytes, not a configured or environment-supplied Git identity.
    const object = [`tree ${git('write-tree')}`, ...(head ? [`parent ${head}`] : []), 'author Fixture <fixture@example.invalid> 1000000000 +0000', 'committer Fixture <fixture@example.invalid> 1000000000 +0000', '', message, ''].join('\n');
    head = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: dir, input: object, encoding: 'utf8' }).trim();
    git('update-ref', 'HEAD', head);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  for (const [file, content] of Object.entries(initial)) write(file, content);
  commit('Baseline fixture');
  git('init', '--bare', '-q', remote);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'main');
  git('switch', '-qc', 'office/fixture');
  const pulls: { head: string; base?: string; title: string; body: string }[] = [];
  let last: ChangesState | undefined;
  let receive: ((state: ChangesState) => void) | undefined;
  const changes = new Changes(
    'main',
    (id) => (id === 'w1' ? { name: 'Fixture', cwd: dir, rel: 'repo' } : undefined),
    () => undefined,
    {
      state(state) {
        last = state;
        receive?.(state);
      },
      toast() {},
      refreshGitHub() {},
    },
    {
      async createPull(_cwd, head, base, title, body) {
        pulls.push({ head, base, title, body });
        return { number: 1, url: 'https://example.invalid/pull/1' };
      },
      async findOpenPull() {
        return undefined;
      },
    },
  );
  t.after(() => {
    changes.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const snapshot = () =>
    new Promise<ChangesState>((resolve) => {
      changes.unwatchAll('c1');
      receive = resolve;
      changes.watch('w1', 'c1');
    });
  const state = () => {
    assert.ok(last);
    assert.equal(last.error, undefined);
    return last;
  };
  const diff = async (file = 'demo.txt') => {
    const result = await changes.diff('w1', file);
    assert.notEqual(typeof result, 'string', String(result));
    assert.ok(typeof result !== 'string');
    assert.equal(result.truncated, false);
    return result.diff;
  };
  const assertNoPush = () => {
    assert.equal(pulls.length, 0);
    assert.equal(git('--git-dir', remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/office/fixture'), '');
  };
  return { dir, git, write, read, commit, changes, pulls, snapshot, state, diff, assertNoPush };
}

test('clean branch diffs and PR creation still use the branch base', async (t) => {
  const f = fixture(t);
  f.write('demo.txt', 'committed worker change\n');
  f.commit();
  await f.snapshot();
  assert.equal(f.state().base, 'main');
  assert.equal(f.state().ahead, 1);
  assert.equal(f.state().files.length, 1);
  assert.equal(f.state().files[0].uncommitted, false);
  assert.match(await f.diff(), /-baseline\n\+committed worker change/);
  assert.equal(await f.changes.pullRequest('w1', ' Fixture PR ', 'Body', 'Owner'), undefined);
  assert.deepEqual(f.pulls, [{ head: 'office/fixture', base: 'main', title: 'Fixture PR', body: 'Body' }]);
  assert.equal(f.state().pr?.number, 1);
});

for (const staged of [false, true]) {
  test(`${staged ? 'staged' : 'unstaged'} undo of a branch commit stays visible, diffable, and blocks PR until committed`, async (t) => {
    const f = fixture(t);
    f.write('demo.txt', 'committed worker change\n');
    f.commit();
    f.write('demo.txt', 'baseline\n');
    if (staged) f.git('add', 'demo.txt');
    await f.snapshot();
    assert.equal(f.state().files.length, 1);
    const file = f.state().files[0];
    assert.equal(file.path, 'demo.txt');
    assert.equal(file.status, 'M');
    assert.equal(file.uncommitted, true);
    assert.equal(file.additions, 1);
    assert.equal(file.deletions, 1);
    assert.match(await f.diff(), /-committed worker change\n\+baseline/);
    const status = f.git('status', '--porcelain=v1');
    assert.equal(await f.changes.pullRequest('w1', 'Fixture PR', '', 'Owner'), 'Commit the changes first');
    f.assertNoPush();
    assert.equal(f.git('status', '--porcelain=v1'), status);
    f.commit('Commit the undo');
    await f.snapshot();
    assert.equal(f.git('status', '--porcelain=v1'), '');
    assert.deepEqual(f.state().files, []);
    assert.equal(f.state().ahead, 2);
    assert.equal(await f.changes.pullRequest('w1', 'Fixture PR', '', 'Owner'), undefined);
    assert.equal(f.git('show', 'origin/office/fixture:demo.txt'), 'baseline');
  });
}

for (const all of [false, true]) {
  test(`discard ${all ? 'all' : 'one file'} restores a cancelled branch change to HEAD`, async (t) => {
    const f = fixture(t);
    f.write('demo.txt', 'committed worker change\n');
    f.commit();
    f.write('demo.txt', 'baseline\n');
    f.git('add', 'demo.txt');
    await f.snapshot();
    assert.equal(await f.changes.discard('w1', all ? undefined : 'demo.txt', 'Owner'), undefined);
    assert.equal(f.read('demo.txt'), 'committed worker change\n');
    assert.equal(f.git('status', '--porcelain=v1'), '');
    assert.equal(f.state().files[0].uncommitted, false);
    assert.match(await f.diff(), /-baseline\n\+committed worker change/);
  });
}

test('staged and unstaged edits that cancel each other retain an index diff and picture preview', async (t) => {
  const f = fixture(t, { 'demo.txt': 'baseline\n', 'logo.png': 'baseline picture' });
  f.write('demo.txt', 'staged change\n');
  f.write('logo.png', 'staged picture');
  f.git('add', '-A');
  f.write('demo.txt', 'baseline\n');
  f.write('logo.png', 'baseline picture');
  await f.snapshot();
  assert.equal(f.git('diff', 'HEAD'), '');
  assert.equal(f.state().files.length, 2);
  assert.ok(f.state().files.every((file) => file.uncommitted && file.additions === 1 && file.deletions === 1));
  assert.match(await f.diff(), /-staged change\n\+baseline/);
  const old = await f.changes.file('w1', 'logo.png', 'old');
  const now = await f.changes.file('w1', 'logo.png', 'new');
  assert.ok(!('error' in old) && !('error' in now));
  assert.equal(old.body.toString(), 'staged picture');
  assert.equal(now.body.toString(), 'baseline picture');
  assert.equal(await f.changes.pullRequest('w1', 'Fixture PR', '', 'Owner'), 'Commit the changes first');
  f.assertNoPush();
  assert.equal(await f.changes.discard('w1', undefined, 'Owner'), undefined);
  assert.equal(f.git('status', '--porcelain=v1'), '');
  assert.deepEqual(f.state().files, []);
});

test('a picture cancelling a branch change previews HEAD, not the identical branch base', async (t) => {
  const f = fixture(t, { 'logo.png': 'baseline picture' });
  f.write('logo.png', 'committed picture');
  f.commit();
  f.write('logo.png', 'baseline picture');
  await f.snapshot();
  const old = await f.changes.file('w1', 'logo.png', 'old');
  const now = await f.changes.file('w1', 'logo.png', 'new');
  assert.ok(!('error' in old) && !('error' in now));
  assert.equal(old.body.toString(), 'committed picture');
  assert.equal(now.body.toString(), 'baseline picture');
});

test('deleting a committed branch addition stays dirty even with no branch diff', async (t) => {
  const f = fixture(t);
  f.write('added.txt', 'branch addition\n');
  f.commit();
  rmSync(path.join(f.dir, 'added.txt'));
  await f.snapshot();
  const file = f.state().files[0];
  assert.equal(file.path, 'added.txt');
  assert.equal(file.status, 'D');
  assert.equal(file.uncommitted, true);
  assert.equal(file.deletions, 1);
  assert.match(await f.diff('added.txt'), /deleted file mode[\s\S]*-branch addition/);
  assert.equal(await f.changes.discard('w1', 'added.txt', 'Owner'), undefined);
  assert.equal(f.read('added.txt'), 'branch addition\n');
  assert.equal(f.git('status', '--porcelain=v1'), '');
});

test('staged restoration of a committed branch deletion is an addition against HEAD', async (t) => {
  const f = fixture(t);
  f.git('rm', 'demo.txt');
  f.commit();
  f.write('demo.txt', 'baseline\n');
  f.git('add', 'demo.txt');
  await f.snapshot();
  const file = f.state().files[0];
  assert.equal(file.status, 'A');
  assert.equal(file.uncommitted, true);
  assert.equal(file.additions, 1);
  assert.match(await f.diff(), /new file mode[\s\S]*\+baseline/);
  assert.equal(await f.changes.discard('w1', 'demo.txt', 'Owner'), undefined);
  assert.equal(existsSync(path.join(f.dir, 'demo.txt')), false);
  assert.equal(f.git('status', '--porcelain=v1'), '');
});

test('a rename that undoes a committed rename shows the HEAD paths and discards both', async (t) => {
  const f = fixture(t);
  f.git('mv', 'demo.txt', 'renamed.txt');
  f.commit();
  f.git('mv', 'renamed.txt', 'demo.txt');
  await f.snapshot();
  const file = f.state().files[0];
  assert.equal(file.path, 'demo.txt');
  assert.equal(file.from, 'renamed.txt');
  assert.equal(file.status, 'R');
  assert.equal(file.uncommitted, true);
  assert.match(await f.diff(), /rename from renamed.txt\nrename to demo.txt/);
  assert.equal(await f.changes.discard('w1', 'demo.txt', 'Owner'), undefined);
  assert.equal(f.read('renamed.txt'), 'baseline\n');
  assert.equal(existsSync(path.join(f.dir, 'demo.txt')), false);
  assert.equal(f.git('status', '--porcelain=v1'), '');
});

test('discarding an edit to a committed rename does not restore its obsolete base path', async (t) => {
  const content = 'baseline\n'.repeat(10);
  const f = fixture(t, { 'demo.txt': content });
  f.git('mv', 'demo.txt', 'renamed.txt');
  f.commit();
  f.write('renamed.txt', `${content}working edit\n`);
  await f.snapshot();
  assert.equal(f.state().files[0].from, 'demo.txt');
  assert.equal(await f.changes.discard('w1', 'renamed.txt', 'Owner'), undefined);
  assert.equal(f.read('renamed.txt'), content);
  assert.equal(existsSync(path.join(f.dir, 'demo.txt')), false);
  assert.equal(f.git('status', '--porcelain=v1'), '');
});

test('ordinary staged renames, untracked files, and deletions remain dirty and discardable', async (t) => {
  const f = fixture(t, { 'demo.txt': 'baseline\n', 'deleted.txt': 'gone\n' });
  f.git('mv', 'demo.txt', 'renamed.txt');
  rmSync(path.join(f.dir, 'deleted.txt'));
  f.write('untracked.txt', 'new\nsecond\n');
  await f.snapshot();
  assert.deepEqual(
    f.state().files.map((file) => [file.path, file.status, file.uncommitted]),
    [
      ['deleted.txt', 'D', true],
      ['renamed.txt', 'R', true],
      ['untracked.txt', '?', true],
    ],
  );
  assert.equal(f.state().files[2].additions, 2);
  assert.match(await f.diff('untracked.txt'), /\+new\n\+second/);
  assert.equal(await f.changes.discard('w1', 'renamed.txt', 'Owner'), undefined);
  assert.equal(f.read('demo.txt'), 'baseline\n');
  assert.equal(await f.changes.discard('w1', 'untracked.txt', 'Owner'), undefined);
  assert.equal(existsSync(path.join(f.dir, 'untracked.txt')), false);
  assert.equal(await f.changes.discard('w1', 'deleted.txt', 'Owner'), undefined);
  assert.equal(f.git('status', '--porcelain=v1'), '');
});

test('discarding a rename source restores both paths when the branch diff splits the rename', async (t) => {
  const f = fixture(t);
  f.git('mv', 'demo.txt', 'renamed.txt');
  f.write('renamed.txt', 'entirely rewritten after the staged rename\n');
  await f.snapshot();
  assert.ok(f.state().files.some((file) => file.path === 'demo.txt' && file.status === 'D' && file.uncommitted));
  assert.equal(await f.changes.discard('w1', 'demo.txt', 'Owner'), undefined);
  assert.equal(f.read('demo.txt'), 'baseline\n');
  assert.equal(existsSync(path.join(f.dir, 'renamed.txt')), false);
  assert.equal(f.git('status', '--porcelain=v1'), '');
});

test('an untracked restoration of a branch deletion cannot be mislabeled as committed', async (t) => {
  const f = fixture(t);
  f.git('rm', 'demo.txt');
  f.commit();
  f.write('demo.txt', 'baseline\n');
  await f.snapshot();
  assert.equal(f.state().files[0].status, '?');
  assert.equal(f.state().files[0].uncommitted, true);
  assert.match(await f.diff(), /\+baseline/);
  assert.equal(await f.changes.pullRequest('w1', 'Fixture PR', '', 'Owner'), 'Commit the changes first');
  f.assertNoPush();
  assert.equal(await f.changes.discard('w1', 'demo.txt', 'Owner'), undefined);
  assert.equal(existsSync(path.join(f.dir, 'demo.txt')), false);
  assert.equal(f.git('status', '--porcelain=v1'), '');
});

test('discard restores a staged deletion even when the same path was recreated untracked', async (t) => {
  const f = fixture(t);
  f.git('rm', 'demo.txt');
  f.write('demo.txt', 'baseline\n');
  await f.snapshot();
  assert.equal(f.state().files[0].uncommitted, true);
  assert.equal(await f.changes.discard('w1', 'demo.txt', 'Owner'), undefined);
  assert.equal(f.read('demo.txt'), 'baseline\n');
  assert.equal(f.git('status', '--porcelain=v1'), '');
  assert.deepEqual(f.state().files, []);
});

test('PR creation rechecks a previously clean watched checkout before pushing', async (t) => {
  const f = fixture(t);
  f.write('demo.txt', 'committed worker change\n');
  f.commit();
  await f.snapshot();
  assert.equal(f.state().files[0].uncommitted, false);
  f.write('demo.txt', 'baseline\n');
  assert.match(await f.diff(), /-committed worker change\n\+baseline/);
  assert.equal(await f.changes.pullRequest('w1', 'Fixture PR', '', 'Owner'), 'Commit the changes first');
  f.assertNoPush();
  assert.equal(f.read('demo.txt'), 'baseline\n');
  assert.equal(f.state().files[0].uncommitted, true);
});

test('binary cancellation retains binary counts and HEAD picture bytes', async (t) => {
  const f = fixture(t, { 'logo.png': '\0baseline picture' });
  f.write('logo.png', '\0committed picture');
  f.commit();
  f.write('logo.png', '\0baseline picture');
  await f.snapshot();
  assert.equal(f.state().files[0].binary, true);
  assert.equal(f.state().files[0].additions, 0);
  assert.equal(f.state().files[0].deletions, 0);
  assert.match(await f.diff('logo.png'), /Binary files .* differ/);
  const old = await f.changes.file('w1', 'logo.png', 'old');
  assert.ok(!('error' in old));
  assert.equal(old.body.toString(), '\0committed picture');
});

test('dirty files remain reachable when clean branch changes exceed the display cap', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 405; i++) f.write(`a-${String(i).padStart(3, '0')}.txt`, 'branch addition\n');
  f.write('z-dirty.txt', 'committed addition\n');
  f.commit();
  f.write('z-dirty.txt', 'uncommitted edit\n');
  await f.snapshot();
  assert.equal(f.state().files.length, 400);
  assert.equal(f.state().more, 6);
  assert.equal(f.state().files[0].path, 'z-dirty.txt');
  assert.equal(f.state().files[0].uncommitted, true);
  assert.equal(await f.changes.pullRequest('w1', 'Fixture PR', '', 'Owner'), 'Commit the changes first');
  f.assertNoPush();
});

test('cancelling edits preserve NUL-delimited paths and counts for unusual filenames', async (t) => {
  const name = 'space\tand\nunicode-λ.txt';
  const f = fixture(t, { [name]: 'baseline\n' });
  f.write(name, 'committed worker change\n');
  f.commit();
  f.write(name, 'baseline\n');
  await f.snapshot();
  assert.equal(f.state().files[0].path, name);
  assert.equal(f.state().files[0].additions, 1);
  assert.equal(f.state().files[0].deletions, 1);
  assert.match(await f.diff(name), /-committed worker change\n\+baseline/);
});
