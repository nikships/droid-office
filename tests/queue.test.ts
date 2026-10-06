import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskQueue, type QueueWorkers } from '../src/server/queue.js';
import type { AgentEffort, WorkerInfo } from '../src/shared/protocol.js';

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-queue-'));
  const workers: WorkerInfo[] = [];
  let hired = 0;
  const manager: QueueWorkers = {
    list: () => workers,
    deskOccupied: (desk) => workers.some((w) => w.deskId === desk),
    spawn(deskId, by, prompt, worktree, kind, model, effort) {
      const id = `worker-${hired++}`;
      const worker: WorkerInfo = {
        id,
        deskId,
        kind,
        model,
        effort,
        prompt,
        name: 'Test',
        color: '#ffffff',
        status: 'working',
        acked: false,
        createdBy: by,
        createdAt: Date.now(),
        cols: 80,
        rows: 24,
        open: false,
        worktree: worktree ? { path: `.droid-office/worktrees/${id}`, branch: `office/${id}`, base: 'abc' } : undefined,
      };
      workers.push(worker);
      return worker;
    },
    kill(id) {
      // Gone from the desks right away, the way the real one does it (before its worktree is dealt with).
      const i = workers.findIndex((w) => w.id === id);
      if (i >= 0) workers.splice(i, 1);
      return Promise.resolve({});
    },
  };
  const queues: TaskQueue[] = [];
  let emptied = 0;
  const open = (room?: () => number, worktrees = false) => {
    const queue = new TaskQueue(dir, manager, worktrees, {
      update() {},
      toast() {},
      claimIssue: async () => undefined,
      refreshGitHub() {},
      hiringPaused: () => undefined,
      emptied: () => emptied++,
      room,
    });
    queues.push(queue);
    return queue;
  };
  return {
    dir,
    workers,
    open,
    emptied: () => emptied,
    close() {
      queues.forEach((q) => q.shutdown());
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('queue seats the picked model and effort and preserves them through completion and retry', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const q = f.open();
  assert.equal(q.add('Fix login', 'Tester', undefined, undefined, 'glm-5.3-flash', 'high'), undefined);
  assert.equal(f.workers[0].model, 'glm-5.3-flash');
  assert.equal(f.workers[0].effort, 'high');
  f.workers[0].status = 'needs_input';
  q.onWorker(f.workers[0]);
  assert.equal(q.state().tasks[0].status, 'running');
  f.workers[0].status = 'done';
  q.onWorker(f.workers[0]);
  assert.equal(q.state().tasks[0].outcome, 'done');
  q.retry(q.state().tasks[0].id);
  assert.equal(f.workers[1].model, 'glm-5.3-flash');
  assert.equal(f.workers[1].effort, 'high');
});

test('queue rejects models that are not valid Droid model ids', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const q = f.open();
  assert.match(q.add('Task', 'Tester', undefined, undefined, 'has a space') ?? '', /Invalid Droid model/);
  assert.match(q.add('Task', 'Tester', undefined, undefined, `x${'y'.repeat(300)}`) ?? '', /Invalid Droid model/);
  assert.equal(q.state().tasks.length, 0);
});

test('queue rejects an unknown effort level before a task is queued', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const q = f.open();
  assert.match(q.add('Task', 'Tester', undefined, undefined, undefined, 'overdrive' as AgentEffort) ?? '', /Invalid effort/);
  assert.equal(q.add('Task', 'Tester', undefined, undefined, 'custom:droidproxy:gpt-6-sol', 'high'), undefined);
  assert.equal(q.state().tasks.length, 1);
});

test('a saved task keeps a valid model and effort, without an invalid one', (t) => {
  const f = fixture();
  t.after(() => f.close());
  writeFileSync(
    path.join(f.dir, 'queue.json'),
    JSON.stringify({
      maxWorkers: 0,
      tasks: [
        { id: 'kept', title: 'Kept', prompt: 'First task', status: 'queued', model: 'glm-5.3-flash', effort: 'max' },
        { id: 'dropped', title: 'Dropped', prompt: 'Second task', status: 'queued', model: 'has a space', effort: 'turbo' },
      ],
    }),
  );
  const q = f.open();
  q.setLimit(2);
  const models = f.workers.map((w) => w.model);
  assert.deepEqual(models, ['glm-5.3-flash', undefined]);
  assert.deepEqual(
    f.workers.map((w) => w.effort),
    ['max', undefined],
  );
});

test('queue preserves a Droid model and effort through seating, retry, and restart', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const q = f.open();
  assert.equal(q.add('Fix login', 'Tester', undefined, undefined, 'custom:droidproxy:gpt-6-sol', 'high'), undefined);
  assert.equal(f.workers[0].model, 'custom:droidproxy:gpt-6-sol');
  assert.equal(f.workers[0].effort, 'high');
  assert.equal(q.state().tasks[0].model, 'custom:droidproxy:gpt-6-sol');
  assert.equal(q.state().tasks[0].effort, 'high');
  f.workers[0].status = 'done';
  q.onWorker(f.workers[0]);
  q.retry(q.state().tasks[0].id);
  assert.equal(f.workers[1].model, 'custom:droidproxy:gpt-6-sol');
  assert.equal(f.workers[1].effort, 'high');

  q.setLimit(0);
  q.add('Queued', 'Tester', undefined, undefined, 'glm-5.3-flash', 'max');
  q.shutdown();
  const restored = f.open();
  restored.setLimit(2);
  assert.equal(f.workers[2].model, 'glm-5.3-flash');
  assert.equal(f.workers[2].effort, 'max');
});

test('queue takes Fable and restores it from queue.json', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const q = f.open();
  q.setLimit(0);
  assert.equal(q.add('Big task', 'Tester', undefined, undefined, 'fable', 'xhigh'), undefined);
  q.shutdown();
  const saved = JSON.parse(readFileSync(path.join(f.dir, 'queue.json'), 'utf8'));
  assert.equal(saved.tasks[0].model, 'fable');
  const restored = f.open();
  assert.equal(restored.state().tasks[0].model, 'fable');
  restored.setLimit(1);
  assert.equal(f.workers[0].model, 'fable');
  assert.equal(f.workers[0].effort, 'xhigh');
});

test('the queue says it emptied once, when its last task gets done', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const q = f.open();
  q.add('First', 'Tester');
  q.add('Second', 'Tester');
  f.workers[0].status = 'done';
  q.onWorker(f.workers[0]);
  assert.equal(f.emptied(), 0, 'the second task is still running');
  f.workers[1].status = 'done';
  q.onWorker(f.workers[1]);
  assert.equal(f.emptied(), 1);
  q.onWorker({ ...f.workers[1], status: 'idle' });
  q.onWorker(f.workers[1]);
  assert.equal(f.emptied(), 1, 'finished tasks never empty it again');
});

test('the queue does not celebrate a task that stopped short, or one taken off it', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const q = f.open();
  q.add('Crashes', 'Tester');
  f.workers[0].status = 'exited';
  q.onWorker(f.workers[0]);
  assert.equal(q.state().tasks[0].outcome, 'exited');
  q.setLimit(0);
  q.add('Never starts', 'Tester');
  q.remove(q.state().tasks[1].id);
  assert.equal(f.emptied(), 0);
});

test("a board agent at work does not hold one of the queue's slots", (t) => {
  const f = fixture();
  t.after(() => f.close());
  f.workers.push({
    id: 'issues-agent',
    deskId: 'station-issues',
    kind: 'agent',
    name: 'Issues agent',
    color: '#ef476f',
    status: 'working',
    acked: true,
    createdBy: 'Ada',
    createdAt: Date.now(),
    cols: 80,
    rows: 24,
    open: false,
  });
  const q = f.open();
  q.setLimit(1);
  q.add('Fix login', 'Tester');
  assert.equal(q.state().tasks[0].status, 'running');
  // Its seat is a desk, never the kiosk.
  assert.match(f.workers[1].deskId, /^desk-/);
});

test("workers hired by hand, or left at their prompt after a restart, do not hold the queue's slots", (t) => {
  const f = fixture();
  t.after(() => f.close());
  // A room full of workers from before the restart, back at their prompts, and a couple at work.
  for (let i = 1; i <= 6; i++) {
    f.workers.push({
      id: `resumed-${i}`,
      deskId: `desk-${i}`,
      kind: 'agent',
      name: `Resumed ${i}`,
      color: '#ffffff',
      status: i <= 4 ? 'idle' : 'working',
      acked: true,
      createdBy: 'Ada',
      createdAt: Date.now(),
      cols: 80,
      rows: 24,
      open: false,
    });
  }
  const q = f.open();
  q.setLimit(2);
  q.add('First', 'Tester');
  q.add('Second', 'Tester');
  q.add('Third', 'Tester');
  // Only the queue's own tasks count against its limit.
  assert.deepEqual(
    q.state().tasks.map((t) => t.status),
    ['running', 'running', 'queued'],
  );
  assert.deepEqual(
    f.workers.slice(6).map((w) => w.deskId),
    ['desk-7', 'desk-8'],
  );
  // One of its tasks finishes: the third takes the slot, whatever the other workers are up to.
  f.workers[6].status = 'done';
  q.onWorker(f.workers[6]);
  assert.deepEqual(
    q.state().tasks.map((t) => t.status),
    ['done', 'running', 'running'],
  );
});

test('an office at its worker limit holds the queue, and a finished queue worker makes room', (t) => {
  const f = fixture();
  t.after(() => f.close());
  let limit = 1;
  const q = f.open(() => limit - f.workers.length);
  q.add('First', 'Tester');
  q.add('Second', 'Tester');
  assert.deepEqual(
    q.state().tasks.map((t) => t.status),
    ['running', 'queued'],
  );
  assert.equal(f.workers.length, 1);
  // The first finishes: its worker goes home to make room, and the second task gets the seat.
  f.workers[0].status = 'done';
  q.onWorker(f.workers[0]);
  assert.deepEqual(
    q.state().tasks.map((t) => t.status),
    ['done', 'running'],
  );
  assert.deepEqual(
    f.workers.map((w) => w.id),
    ['worker-1'],
  );
  // The limit lowered past who's there: nobody is sent home and nothing fails, the queue just waits.
  q.add('Third', 'Tester');
  limit = 0;
  f.workers[0].status = 'done';
  q.onWorker(f.workers[0]);
  assert.deepEqual(
    q.state().tasks.map((t) => [t.status, t.outcome]),
    [
      ['done', 'done'],
      ['done', 'done'],
      ['queued', undefined],
    ],
  );
  assert.equal(f.workers.length, 1);
  // Room again: it carries on.
  limit = 2;
  q.pump();
  assert.equal(q.state().tasks[2].status, 'running');
});

test('an open terminal holds its finished queue worker at its desk until it closes', (t) => {
  const f = fixture();
  t.after(() => f.close());
  const q = f.open(() => 1 - f.workers.length);
  q.add('First', 'Tester');
  q.add('Second', 'Tester');
  assert.deepEqual(
    q.state().tasks.map((t) => t.status),
    ['running', 'queued'],
  );
  // The first finishes while its terminal is open: the second waits, nobody goes home.
  f.workers[0].status = 'done';
  f.workers[0].open = true;
  q.onWorker(f.workers[0]);
  assert.deepEqual(
    q.state().tasks.map((t) => t.status),
    ['done', 'queued'],
  );
  assert.equal(f.workers.length, 1);
  // Closed: its worker goes home to make room, and the second task gets the seat.
  f.workers[0].open = false;
  q.pump();
  assert.deepEqual(
    q.state().tasks.map((t) => t.status),
    ['done', 'running'],
  );
  assert.deepEqual(
    f.workers.map((w) => w.id),
    ['worker-1'],
  );
});

test("a queue worker that switches to a branch of its own takes its task's branch along, so the PR from there is linked", (t) => {
  const f = fixture();
  t.after(() => f.close());
  const q = f.open(undefined, true);
  assert.equal(q.add('Fix login', 'Tester'), undefined);
  const w = f.workers[0];
  assert.equal(q.state().tasks[0].branch, 'office/worker-0');
  w.status = 'done';
  q.onWorker(w);
  assert.equal(q.state().tasks[0].outcome, 'done');
  // The office noticed it had run `git checkout -b fix-login` (see Workers.syncBranch).
  w.worktree = { ...w.worktree!, branch: 'fix-login', made: 'office/worker-0' };
  q.onWorker(w);
  assert.equal(q.state().tasks[0].branch, 'fix-login');
  q.onPulls([
    {
      number: 242,
      title: 'Fix login',
      state: 'OPEN',
      isDraft: false,
      url: 'https://github.com/o/r/pull/242',
      author: '',
      labels: [],
      reviewDecision: '',
      headRefName: 'fix-login',
      baseRefName: 'main',
      createdAt: new Date().toISOString(),
      updatedAt: '',
      additions: 0,
      deletions: 0,
      checks: 'none',
      body: '',
      closes: [],
    },
  ]);
  assert.equal(q.state().tasks[0].pr?.number, 242);
});

test('a worktree task waits for the fetch of what its worktree starts from, then sits down', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-queue-'));
  const workers: WorkerInfo[] = [];
  let fetches = 0;
  let fetched: (() => void) | undefined;
  let inFlight: Promise<void> | undefined;
  let fresh = false;
  const manager: QueueWorkers = {
    list: () => workers,
    deskOccupied: (desk) => workers.some((w) => w.deskId === desk),
    spawn(deskId, by, prompt, worktree, kind) {
      assert.equal(worktree, true);
      assert.ok(fresh, 'seated before its base was fetched');
      const worker: WorkerInfo = {
        id: `worker-${workers.length}`,
        deskId,
        kind,
        prompt,
        name: 'Test',
        color: '#ffffff',
        status: 'working',
        acked: false,
        createdBy: by,
        createdAt: Date.now(),
        cols: 80,
        rows: 24,
        open: false,
      };
      workers.push(worker);
      return worker;
    },
    kill: () => Promise.resolve({}),
    fetchBase() {
      if (fresh) return undefined;
      if (!inFlight) fetches++;
      inFlight ??= new Promise<void>((resolve) => {
        fetched = () => {
          fresh = true;
          resolve();
        };
      });
      return inFlight;
    },
  };
  const q = new TaskQueue(dir, manager, true, {
    update() {},
    toast() {},
    claimIssue: async () => undefined,
    refreshGitHub() {},
    hiringPaused: () => undefined,
    emptied() {},
  });
  t.after(() => {
    q.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  q.add('Fix login', 'Tester');
  q.add('Fix logout', 'Tester');
  assert.equal(workers.length, 0);
  assert.equal(q.state().tasks[0].status, 'queued');
  q.pump();
  assert.equal(workers.length, 0);
  fetched!();
  await new Promise((r) => setImmediate(r));
  // One fetch for the pair of them.
  assert.equal(workers.length, 2);
  assert.deepEqual(
    q.state().tasks.map((x) => x.status),
    ['running', 'running'],
  );
  assert.equal(fetches, 1);
});

test("a queue that has nowhere to seat anyone doesn't fetch", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-queue-'));
  let fetches = 0;
  const manager: QueueWorkers = {
    list: () => [],
    deskOccupied: () => false,
    spawn: () => 'unreachable',
    kill: () => Promise.resolve({}),
    fetchBase() {
      fetches++;
      return new Promise<void>(() => {});
    },
  };
  const q = new TaskQueue(dir, manager, true, {
    update() {},
    toast() {},
    claimIssue: async () => undefined,
    refreshGitHub() {},
    hiringPaused: () => undefined,
    emptied() {},
    room: () => 0,
  });
  t.after(() => {
    q.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  q.add('Fix login', 'Tester');
  assert.equal(fetches, 0);
});
