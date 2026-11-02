import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prune } from '../src/server/prune.js';

test('prune help prints usage and returns 0', async (t) => {
  const stdout = t.mock.method(process.stdout, 'write', () => true);
  assert.equal(await prune(['--help']), 0);
  assert.ok(stdout.mock.calls.some((c) => String(c.arguments[0]).includes('droid-office prune')));
});

test('prune validates arguments and repository', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(process.stderr, 'write', () => true);
  assert.equal(await prune(['--unknown']), 2);

  const missing = path.join(tmpdir(), `missing-office-dir-${Date.now()}`);
  assert.equal(await prune([missing]), 2);

  const nonRepo = mkdtempSync(path.join(tmpdir(), 'office-non-repo-'));
  t.after(() => rmSync(nonRepo, { recursive: true, force: true }));
  assert.equal(await prune([nonRepo]), 1);
});

test('prune cleans unused worktrees and branches', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'office-prune-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'ignore' });

  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-qm', 'initial commit');

  const log = t.mock.method(console, 'log', () => {});

  // Clean repo has nothing to prune
  assert.equal(await prune([root]), 0);
  assert.ok(log.mock.calls.some((c) => String(c.arguments[0]).includes('all clean')));

  // Create a clean worker worktree
  const wtClean = path.join(root, '.droid-office', 'worktrees', 'pixel-clean');
  git('worktree', 'add', '-q', '-b', 'office/pixel-clean', wtClean);

  // Create a dirty worker worktree
  const wtDirty = path.join(root, '.droid-office', 'worktrees', 'pixel-dirty');
  git('worktree', 'add', '-q', '-b', 'office/pixel-dirty', wtDirty);
  writeFileSync(path.join(wtDirty, 'dirty.txt'), 'dirty work');

  // Create a saved worker in workers.json using another worktree
  const wtSaved = path.join(root, '.droid-office', 'worktrees', 'pixel-saved');
  git('worktree', 'add', '-q', '-b', 'office/pixel-saved', wtSaved);
  const dataDir = path.join(root, '.droid-office');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    path.join(dataDir, 'workers.json'),
    JSON.stringify([
      {
        name: 'Pixel',
        worktree: { path: '.droid-office/worktrees/pixel-saved', branch: 'office/pixel-saved' },
      },
    ]),
  );

  // Dry run: does not delete
  assert.equal(await prune([root, '--dry-run']), 0);
  assert.ok(existsSync(wtClean));
  assert.ok(existsSync(wtDirty));
  assert.ok(existsSync(wtSaved));

  // Regular prune: removes clean, keeps dirty and saved
  assert.equal(await prune([root]), 0);
  assert.equal(existsSync(wtClean), false, 'clean worktree is removed');
  assert.equal(existsSync(wtDirty), true, 'dirty worktree is kept');
  assert.equal(existsSync(wtSaved), true, 'saved worker worktree is kept');

  // Force prune: removes dirty worktree, but still keeps saved worker worktree
  assert.equal(await prune([root, '--force']), 0);
  assert.equal(existsSync(wtDirty), false, 'dirty worktree is removed with --force');
  assert.equal(existsSync(wtSaved), true, 'saved worker worktree is kept even with --force');
});
