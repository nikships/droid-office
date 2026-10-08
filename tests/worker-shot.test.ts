import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkerManager, type WorkerEvents } from '../src/server/workers.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

const REVIVE_MS = 30_000;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-worker-shot-'));
  const data = path.join(dir, '.droid-office');
  const bin = path.join(data, 'bin');
  mkdirSync(bin, { recursive: true });
  const command = path.join(bin, 'fake-agent');
  writeFileSync(command, '#!/usr/bin/env node\nprocess.stdin.resume();\n', { mode: 0o700 });
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
  const updates: WorkerInfo[] = [];
  const removed: string[] = [];
  const toasts: { text: string; level: string }[] = [];
  const events: WorkerEvents = { update: (info) => updates.push(info), remove: (id) => removed.push(id), data() {}, screen() {}, toast: (text, level) => toasts.push({ text, level }) };
  const managers: WorkerManager[] = [];
  const manager = () => {
    const workers = new WorkerManager(dir, data, command, [], { url: 'http://127.0.0.1:1', token: '' }, events);
    managers.push(workers);
    return workers;
  };
  t.after(() => {
    for (const workers of managers) workers.shutdown();
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'a.txt'), 'a');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-qm', 'init');
  writeFileSync(path.join(dir, '.git', 'info', 'exclude'), '.droid-office/\n');
  return { dir, data, manager, updates, removed, toasts, saved: () => JSON.parse(readFileSync(path.join(data, 'workers.json'), 'utf8')) as WorkerInfo[] };
}

function spawn(workers: WorkerManager, desk = 'desk-1', worktree = false) {
  const info = workers.spawn(desk, 'test', undefined, worktree);
  if (typeof info === 'string') assert.fail(info);
  return info;
}

test('shoot persists an exact 30-second deadline without stopping the session, then dismisses at it', (t) => {
  const f = fixture(t);
  const workers = f.manager();
  const w = spawn(workers);
  const status = w.status;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const until = Date.now() + REVIVE_MS;
  assert.equal(workers.shoot(w.id), undefined);
  assert.equal(w.downedUntil, until);
  assert.equal(w.status, status);
  assert.equal(f.saved()[0].downedUntil, until);
  assert.equal(f.updates.at(-1)?.downedUntil, until);
  t.mock.timers.tick(REVIVE_MS - 1);
  assert.ok(workers.get(w.id));
  t.mock.timers.tick(1);
  assert.equal(workers.get(w.id), undefined);
  assert.deepEqual(f.removed, [w.id]);
  assert.deepEqual(f.saved(), []);
});

test('a second shot confirms the kill: dismissed at once with its worktree and branch, other bodies untouched', async (t) => {
  const f = fixture(t);
  const workers = f.manager();
  const w = spawn(workers, 'desk-1', true);
  const other = spawn(workers, 'desk-2');
  const branch = w.worktree!.branch;
  const cwd = path.join(f.dir, w.worktree!.path);
  writeFileSync(path.join(cwd, 'dirty.txt'), 'discard me');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  workers.shoot(w.id);
  workers.shoot(other.id);
  const otherUntil = other.downedUntil;
  t.mock.timers.tick(1000);
  assert.equal(workers.shoot(w.id), undefined);
  assert.equal(workers.get(w.id), undefined);
  assert.deepEqual(f.removed, [w.id]);
  assert.equal(workers.shoot(w.id), 'No such worker');
  // The dismissal's worktree cleanup runs after the worker is gone, and toasts when it's done.
  t.mock.timers.reset();
  for (let i = 0; i < 250 && !f.toasts.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(existsSync(cwd), false);
  assert.equal(git(f.dir, 'branch', '--list', branch), '');
  assert.equal(other.downedUntil, otherUntil);
  assert.ok(workers.get(other.id));
  assert.deepEqual(
    f.saved().map((x) => x.id),
    [other.id],
  );
});

test('kill before the deadline rejects every cleanup option and preserves the worker and dismissal timer', async (t) => {
  const f = fixture(t);
  const workers = f.manager();
  const w = spawn(workers);
  const status = w.status;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  workers.shoot(w.id);
  const until = w.downedUntil;
  const saved = f.saved();
  const updates = f.updates.length;
  t.mock.timers.tick(1000);
  for (const cleanup of [undefined, 'keep', 'worktree', 'all'] as const) {
    const result = await workers.kill(w.id, cleanup);
    assert.match(result.error ?? '', /revive.*wait/i);
    assert.equal(result.note, undefined);
    assert.equal(workers.get(w.id), w);
    assert.equal(w.downedUntil, until);
    assert.equal(w.status, status);
    assert.deepEqual(f.saved(), saved);
    assert.deepEqual(f.removed, []);
    assert.equal(f.updates.length, updates);
  }
  t.mock.timers.tick(REVIVE_MS - 1001);
  assert.equal(workers.get(w.id), w);
  t.mock.timers.tick(1);
  assert.equal(workers.get(w.id), undefined);
  assert.deepEqual(f.removed, [w.id]);
  assert.deepEqual(f.saved(), []);
});

test('revival cancels only that worker’s timer and leaves its session untouched', (t) => {
  const f = fixture(t);
  const workers = f.manager();
  const a = spawn(workers);
  const b = spawn(workers, 'desk-2');
  const status = a.status;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  workers.shoot(a.id);
  t.mock.timers.tick(1000);
  workers.shoot(b.id);
  t.mock.timers.tick(REVIVE_MS - 1001);
  assert.equal(workers.revive(a.id), undefined);
  assert.equal(a.downedUntil, undefined);
  assert.equal(a.status, status);
  assert.equal(f.updates.at(-1)?.downedUntil, undefined);
  assert.equal(f.saved().find((w) => w.id === a.id)?.downedUntil, undefined);
  t.mock.timers.tick(1);
  assert.ok(workers.get(a.id));
  assert.ok(workers.get(b.id));
  t.mock.timers.tick(1000);
  assert.ok(workers.get(a.id));
  assert.equal(workers.get(b.id), undefined);
});

test('revive at the deadline cannot win even before the timeout callback runs', (t) => {
  const f = fixture(t);
  const workers = f.manager();
  const w = spawn(workers);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  workers.shoot(w.id);
  t.mock.timers.setTime(w.downedUntil!);
  assert.match(workers.revive(w.id) ?? '', /no longer|expired/i);
  assert.equal(workers.get(w.id), undefined);
});

test('shutdown clears old timers, and restart restores the original deadline rather than granting another 30 seconds', (t) => {
  const f = fixture(t);
  const workers = f.manager();
  const w = spawn(workers);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  workers.shoot(w.id);
  const until = w.downedUntil!;
  t.mock.timers.tick(10_000);
  workers.shutdown(true);
  const again = f.manager();
  assert.equal(again.get(w.id)?.downedUntil, until);
  t.mock.timers.tick(19_999);
  assert.ok(again.get(w.id));
  t.mock.timers.tick(1);
  assert.equal(again.get(w.id), undefined);
  assert.deepEqual(f.removed, [w.id]);
});

test('restart recovers an already expired shot without waking the worker', (t) => {
  const f = fixture(t);
  const workers = f.manager();
  const w = spawn(workers);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  workers.shoot(w.id);
  workers.shutdown(true);
  t.mock.timers.tick(REVIVE_MS + 1);
  const again = f.manager();
  t.mock.timers.tick(0);
  assert.equal(again.get(w.id), undefined);
  assert.deepEqual(f.removed, [w.id]);
});

test('gun dismissal ignores keep and discards dirty work and unique commits on both worker branches', async (t) => {
  const f = fixture(t);
  const workers = f.manager();
  const w = spawn(workers, 'desk-1', true);
  const office = w.worktree!.branch;
  const cwd = path.join(f.dir, w.worktree!.path);
  writeFileSync(path.join(cwd, 'office.txt'), 'office');
  git(cwd, 'add', 'office.txt');
  git(cwd, 'commit', '-qm', 'office-only');
  git(cwd, 'checkout', '-qb', 'fix-shot', 'main');
  writeFileSync(path.join(cwd, 'fix.txt'), 'fix');
  git(cwd, 'add', 'fix.txt');
  git(cwd, 'commit', '-qm', 'fix-only');
  writeFileSync(path.join(cwd, 'dirty.txt'), 'discard me');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  workers.shoot(w.id);
  t.mock.timers.setTime(w.downedUntil!);
  const result = await workers.kill(w.id, 'keep');
  assert.equal(result.error, undefined);
  assert.equal(existsSync(cwd), false);
  assert.equal(git(f.dir, 'branch', '--list', office, 'fix-shot'), '');
  assert.equal(git(f.dir, 'branch', '--show-current'), 'main');
});
