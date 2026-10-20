import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkerManager, type WorkerEvents } from '../src/server/workers.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

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
  const shots: string[] = [];
  const toasts: { text: string; level: string }[] = [];
  const events: WorkerEvents = {
    update: (info) => updates.push(info),
    remove: (id, shot) => {
      removed.push(id);
      if (shot) shots.push(id);
    },
    data() {},
    screen() {},
    toast: (text, level) => toasts.push({ text, level }),
  };
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
  return { dir, data, manager, updates, removed, shots, toasts, saved: () => JSON.parse(readFileSync(path.join(data, 'workers.json'), 'utf8')) as WorkerInfo[] };
}

function spawn(workers: WorkerManager, desk = 'desk-1', worktree = false) {
  const info = workers.spawn(desk, 'test', undefined, worktree);
  if (typeof info === 'string') assert.fail(info);
  return info;
}

test('normal shots never change a worker, stop its session, or schedule a dismissal', (t) => {
  const f = fixture(t);
  const workers = f.manager();
  const w = spawn(workers);
  const before = structuredClone(w);
  const saved = f.saved();
  const updates = f.updates.length;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  for (let i = 0; i < 3; i++) assert.equal(workers.shoot(w.id), undefined);
  t.mock.timers.tick(60_000);
  assert.equal(workers.get(w.id), w);
  assert.deepEqual(w, before);
  assert.deepEqual(f.saved(), saved);
  assert.deepEqual(f.removed, []);
  assert.equal(f.updates.length, updates);
});

test('a charged shot immediately dismisses one worker and deletes dirty work and unpublished commits', async (t) => {
  const f = fixture(t);
  const workers = f.manager();
  const w = spawn(workers, 'desk-1', true);
  const other = spawn(workers, 'desk-2');
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
  assert.equal(workers.shoot(w.id, true), undefined);
  assert.equal(workers.get(w.id), undefined);
  assert.deepEqual(f.removed, [w.id]);
  assert.deepEqual(f.shots, [w.id], 'clients receive the ascent on the removal, with no downed update');
  assert.equal(workers.shoot(w.id, true), 'No such worker');
  for (let i = 0; i < 250 && !f.toasts.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(existsSync(cwd), false);
  assert.equal(git(f.dir, 'branch', '--list', office, 'fix-shot'), '');
  assert.equal(git(f.dir, 'branch', '--show-current'), 'main');
  assert.equal(workers.get(other.id), other);
  assert.deepEqual(
    f.saved().map((x) => x.id),
    [other.id],
  );
});

test('ordinary send-home stays separate from charged dismissal', async (t) => {
  const f = fixture(t);
  const workers = f.manager();
  const w = spawn(workers, 'desk-1', true);
  const cwd = path.join(f.dir, w.worktree!.path);
  writeFileSync(path.join(cwd, 'dirty.txt'), 'keep me');
  workers.shoot(w.id);
  const result = await workers.kill(w.id, 'keep');
  assert.equal(result.error, undefined);
  assert.equal(existsSync(cwd), true);
  assert.deepEqual(f.removed, [w.id]);
  assert.deepEqual(f.shots, []);
});

test('restart ignores old saved revival deadlines, even expired ones, and keeps the workers', (t) => {
  const f = fixture(t);
  const workers = f.manager();
  const a = spawn(workers);
  const b = spawn(workers, 'desk-2');
  workers.shutdown(true);
  writeFileSync(path.join(f.data, 'workers.json'), JSON.stringify(f.saved().map((w, i) => ({ ...w, downedUntil: Date.now() + (i ? 10_000 : -10_000) }))));
  const again = f.manager();
  assert.ok(again.get(a.id));
  assert.ok(again.get(b.id));
  assert.equal('downedUntil' in again.get(a.id)!, false);
  assert.equal('downedUntil' in again.get(b.id)!, false);
  assert.deepEqual(f.removed, []);
});

test('all pre-made agents can open a terminal before their first task, without duplicate hires', (t) => {
  const f = fixture(t);
  const workers = f.manager();
  for (const deskId of ['station-issues', 'station-pulls', 'station-actions', 'station-lead']) {
    const info = workers.openStation(deskId, 'test');
    if (typeof info === 'string') assert.fail(info);
    assert.equal(info.deskId, deskId);
    assert.equal(info.prompt, undefined, 'opening a terminal must not invent an owner task');
    assert.equal(workers.openStation(deskId, 'test'), info);
    assert.equal(workers.list().filter((w) => w.deskId === deskId).length, 1);
    assert.equal(workers.shoot(info.id), undefined);
    assert.equal(workers.get(info.id), info);
  }
  assert.equal(workers.openStation('desk-1', 'test'), 'There is no agent to ask there');
});

test('shots reject missing workers and do nothing while the office closes', (t) => {
  const f = fixture(t);
  const workers = f.manager();
  const w = spawn(workers);
  assert.equal(workers.shoot('missing'), 'No such worker');
  workers.shutdown(true);
  assert.equal(workers.shoot(w.id, true), 'The office is closing');
  assert.ok(workers.get(w.id));
  assert.deepEqual(f.removed, []);
});
