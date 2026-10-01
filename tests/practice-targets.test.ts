import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkerManager, type WorkerEvents } from '../src/server/workers.js';
import { Ledger } from '../src/server/usage.js';
import { TargetStage, pickTargetDesk, type TargetStageHooks } from '../src/client/native/stage.js';
import { DESK_BY_ID } from '../src/shared/layout.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { isPracticeTarget, nextTargetName, targetNumber } from '../src/shared/targets.js';

// Practice targets: the only workers a tool may shoot. The office hires them as plain shells named
// "Target <n>" (worker.spawn with target: true), nothing else is ever given that name, and the
// headset's debug staging hires and dismisses them through the office.

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function office(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-practice-targets-'));
  const data = path.join(dir, '.droid-office');
  const bin = path.join(data, 'bin');
  mkdirSync(bin, { recursive: true });
  const command = path.join(bin, 'fake-agent');
  writeFileSync(command, '#!/usr/bin/env node\nprocess.stdin.resume();\n', { mode: 0o700 });
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
  const removed: string[] = [];
  const events: WorkerEvents = { update() {}, remove: (id) => removed.push(id), data() {}, screen() {}, toast() {} };
  const workers = new WorkerManager(
    dir,
    data,
    command,
    [],
    { url: 'http://127.0.0.1:1', token: '' },
    events,
    new Ledger(
      data,
      { pauseHiring: false },
      () => {},
      () => {},
    ),
  );
  t.after(() => {
    workers.shutdown();
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'a.txt'), 'a');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-qm', 'init');
  writeFileSync(path.join(dir, '.git', 'info', 'exclude'), '.droid-office/\n');
  /** worker.spawn as server.ts hands it on: a shell, with `target` as asked. */
  const hire = (deskId: string, target = true, kind: 'shell' | 'agent' = 'shell', worktree = false) => workers.spawn(deskId, 'test', undefined, worktree, kind, undefined, undefined, undefined, undefined, [], target);
  return { workers, hire, removed, saved: () => JSON.parse(readFileSync(path.join(data, 'workers.json'), 'utf8')) as WorkerInfo[] };
}

const info = (r: WorkerInfo | string): WorkerInfo => (typeof r === 'string' ? assert.fail(r) : r);

test('a practice target is "Target <n>", the lowest number free; no other name is one', () => {
  assert.equal(targetNumber('Target 1 🐚'), 1);
  assert.equal(targetNumber('target 12'), 12);
  for (const name of ['Pixel 🐚', 'Target', 'Target 0', 'Target 1a', 'Targets 1', 'Target practice', 'My Target 1']) assert.equal(targetNumber(name), null, name);
  assert.equal(nextTargetName([]), 'Target 1');
  assert.equal(nextTargetName(['Pixel', 'Target 1', 'Target 3']), 'Target 2');
  assert.equal(nextTargetName(['Target 1', 'Target 2']), 'Target 3');
  assert.equal(isPracticeTarget({ name: 'Target 1 🐚', kind: 'shell' }), true);
  assert.equal(isPracticeTarget({ name: 'Target 1', kind: 'agent' }), false, 'an agent is real work');
  assert.equal(isPracticeTarget({ name: 'Target 1 🐚', kind: 'shell', worktree: { path: '/w', branch: 'b', base: 'main' } }), false, 'so is a worktree');
  assert.equal(isPracticeTarget({ name: 'Target 1 🐚', kind: 'shell', repos: [{}] }), false);
  assert.equal(isPracticeTarget({ name: 'Target 1 🐚', kind: 'shell', meeting: 'm1' }), false);
  assert.equal(isPracticeTarget({ name: 'Target 1 🐚' }), false, 'nor is a worker the office has not described');
  assert.equal(isPracticeTarget({ name: 'Pixel 🐚', kind: 'shell' }), false);
});

test('the office hires a practice target as a plain shell named Target <n>, and never as real work', async (t) => {
  const o = office(t);
  const first = info(o.hire('desk-1'));
  assert.equal(first.name, 'Target 1 🐚');
  assert.equal(first.kind, 'shell');
  assert.equal(first.worktree, undefined);
  assert.equal(isPracticeTarget(first), true);
  assert.equal(info(o.hire('desk-2')).name, 'Target 2 🐚');
  const shell = info(o.hire('desk-3', false));
  assert.equal(targetNumber(shell.name), null, `an ordinary shell is not one: ${shell.name}`);
  const agent = info(o.hire('desk-4', false, 'agent'));
  assert.equal(targetNumber(agent.name), null, `nor an agent: ${agent.name}`);
  assert.deepEqual(
    o.saved().map((w) => w.name),
    ['Target 1 🐚', 'Target 2 🐚', shell.name, agent.name],
    'the names persist',
  );

  for (const [desk, kind, worktree] of [
    ['desk-5', 'agent', false],
    ['desk-6', 'shell', true],
    ['meeting-1', 'shell', false],
    ['station-issues', 'agent', false],
  ] as const) {
    const refused = o.hire(desk, true, kind, worktree);
    assert.equal(typeof refused, 'string', `${desk} ${kind}${worktree ? ' with a worktree' : ''}`);
  }
  assert.equal(o.workers.list().length, 4, 'nothing else was hired');

  await o.workers.kill(first.id);
  assert.equal(info(o.hire('desk-7')).name, 'Target 1 🐚', 'the lowest free number again');
});

test('the desk for a practice target is the one clearest of every other worker, then the nearest', () => {
  const free = [
    { id: 'a', x: 0, z: 0 },
    { id: 'b', x: 10, z: 0 },
    { id: 'c', x: -10, z: 0 },
  ];
  assert.deepEqual(pickTargetDesk(free, [{ x: -11, z: 0 }], { x: 0, z: 0 }), { id: 'b', clearance: 21 });
  assert.deepEqual(pickTargetDesk(free, [], { x: 9, z: 0 }), { id: 'b', clearance: null }, 'nobody else: the nearest desk');
  assert.deepEqual(pickTargetDesk(free, [{ x: 0, z: 10 }], { x: -9, z: 0 }), { id: 'c', clearance: 14.14 }, 'as clear: the nearer one');
  assert.equal(pickTargetDesk([], [], { x: 0, z: 0 }), null);
});

/** TargetStage wired to a real WorkerManager the way main.ts wires it to the office. */
function staging(o: ReturnType<typeof office>, debuggable = true) {
  let said = '';
  const sentHome: string[] = [];
  const hooks: TargetStageHooks = {
    crew: () => o.workers.list(),
    taken: (deskId) => o.workers.deskOccupied(deskId),
    you: () => ({ x: -11.6, z: -3 }),
    present: () => true,
    hire: (deskId) => {
      // server.ts's worker.spawn handler: a refusal comes back as a toast.
      const r = o.hire(deskId);
      said = typeof r === 'string' ? r : `test set up ${r.name} for target practice`;
    },
    sendHome: (id) => {
      sentHome.push(id);
      void o.workers.kill(id);
    },
    officeNow: () => Date.now(),
    lastToast: () => said,
  };
  const stage = new TargetStage(hooks, 5);
  stage.debuggable = debuggable;
  return { stage, sentHome };
}

test('stageTarget hires a practice target through the office, clear of real work; dismissTarget sends only it home', async (t) => {
  const o = office(t);
  const pixel = info(o.hire('desk-1', false, 'agent'));
  assert.equal(pixel.name, 'Pixel');

  const inert = staging(o, false);
  assert.match((await inert.stage.hire()).reason ?? '', /debuggable/);
  assert.match((await inert.stage.dismiss('Pixel')).reason ?? '', /debuggable/);
  assert.match(inert.stage.allow(['x']).reason ?? '', /debuggable/);
  assert.equal(o.workers.list().length, 1, 'a release build hires nothing');

  const { stage, sentHome } = staging(o);
  const hired = await stage.hire();
  assert.equal(hired.ok, true, hired.reason);
  assert.equal(hired.worker, 'Target 1 🐚');
  const far = DESK_BY_ID.get(hired.desk!)!;
  const desk1 = DESK_BY_ID.get('desk-1')!;
  assert.equal(hired.desk, 'desk-16', 'the free desk farthest from Pixel');
  assert.equal(hired.clearance, Math.round(Math.hypot(far.x - desk1.x, far.z - desk1.z) * 100) / 100);
  const target = o.workers.get(hired.workerId!)!;
  assert.equal(isPracticeTarget(target), true);

  assert.match((await stage.hire({ desk: 'desk-1' })).reason ?? '', /taken/);
  assert.match((await stage.hire({ desk: 'station-issues' })).reason ?? '', /not a desk/);

  // Nobody but a practice target is sent home, and not while it lies shot within its window.
  const refused = await stage.dismiss('Pixel');
  assert.equal(refused.ok, false);
  assert.match(refused.reason ?? '', /only practice targets/);
  assert.equal(o.workers.shoot(target.id), undefined);
  const down = await stage.dismiss('Target 1');
  assert.equal(down.ok, false);
  assert.match(down.reason ?? '', /revive it first/);
  assert.deepEqual(sentHome, []);
  assert.equal(o.workers.revive(target.id), undefined);
  const gone = await stage.dismiss('target 1');
  assert.equal(gone.ok, true, gone.reason);
  assert.equal(gone.gone, true);
  assert.deepEqual(sentHome, [target.id]);
  assert.deepEqual(stage.targets.list(), [], 'a target sent home is off the list');

  // Staging goes by worker id, never by name: a practice target hired some other way is not on the
  // list until a harness lists its id, and a listed agent is still real work.
  const other = info(o.hire('desk-9'));
  assert.equal(other.name, 'Target 1 🐚');
  assert.match((await stage.dismiss(other.id)).reason ?? '', /listed by worker id/);
  assert.match(stage.allow('not a list').reason ?? '', /array/);
  assert.deepEqual(stage.allow([other.id, pixel.id, 7, '']).targets, [other.id, pixel.id]);
  assert.match((await stage.dismiss('Pixel')).reason ?? '', /plain shells/);
  assert.equal((await stage.dismiss(other.id)).ok, true);
  assert.deepEqual(sentHome, [target.id, other.id]);
  assert.deepEqual(
    o.workers.list().map((w) => w.name),
    ['Pixel'],
    'Pixel is untouched',
  );
});

test('stageTarget says why when the office does not seat one', async () => {
  const stage = new TargetStage(
    {
      crew: () => [],
      taken: () => false,
      you: () => ({ x: 0, z: 0 }),
      present: () => true,
      hire() {
        said = '🚫 The office is at its limit of 2 workers';
      },
      sendHome: () => assert.fail('nothing to send home'),
      officeNow: () => Date.now(),
      lastToast: () => said,
    },
    5,
  );
  let said = 'an older toast';
  stage.debuggable = true;
  const result = await stage.hire({ timeoutMs: 500 });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /did not seat a practice target at desk-\d+: 🚫 The office is at its limit/);
});
