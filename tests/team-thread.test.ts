import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEAM_RECONCILE_INTERVAL, TEAM_THREAD_CHARACTERS, TEAM_THREAD_ENTRIES, TEAM_THREAD_WORKERS, TeamThread, TeamThreadPaint, teamThreadChildren, teamThreadVisible } from '../src/client/team-thread.js';
import type { ClientMsg, ServerMsg, WorkerInfo } from '../src/shared/protocol.js';
import { presentThread, THREAD_MODEL_VERSION, type ThreadRow } from '../src/shared/thread-presentation.js';
import type { ThreadEntry } from '../src/shared/worker-thread.js';

// Local display-model values, not third-party API or terminal fixtures.
const worker = (id: string, extra: Partial<WorkerInfo> = {}): WorkerInfo => ({
  id,
  kind: 'agent',
  deskId: id,
  name: id,
  color: '#ffffff',
  status: 'working',
  acked: false,
  createdBy: 'lead',
  createdAt: 1,
  cols: 80,
  rows: 24,
  open: false,
  lead: 'lead',
  sessionId: `session-${id}`,
  ...extra,
});
const entry = (seq: number, extra: Partial<ThreadEntry> = {}): ThreadEntry => ({ id: `entry-${seq}`, seq, kind: 'text', role: 'assistant', text: `Message ${seq}`, ...extra });
type Read = Extract<ClientMsg, { t: 'thread.read' }>;
type Watch = Extract<ClientMsg, { t: 'thread.watch' }>;
const snapshot = (read: Read, entries: ThreadEntry[] = [entry(1)], extra: Partial<Extract<ServerMsg, { t: 'thread.snapshot' }>> = {}): Extract<ServerMsg, { t: 'thread.snapshot' }> => ({
  ...read,
  t: 'thread.snapshot',
  sessionId: `session-${read.workerId}`,
  hasMore: false,
  entries,
  ...extra,
});
const pushedSnapshot = (workerId: string, entries: ThreadEntry[] = [entry(1)], extra: Partial<Extract<ServerMsg, { t: 'thread.snapshot' }>> = {}): Extract<ServerMsg, { t: 'thread.snapshot' }> => ({
  t: 'thread.snapshot',
  workerId,
  request: 'push',
  push: true,
  sessionId: `session-${workerId}`,
  hasMore: false,
  entries,
  ...extra,
});

function rig(workers = [worker('one')]) {
  const team = new TeamThread();
  const reads: Read[] = [];
  const watches: Watch[] = [];
  let sequence = 0;
  const sendWatch = (msg: Watch) => {
    watches.push(msg);
    return true;
  };
  team.sync('floor:lead', 'lead', workers);
  team.enable(true, sendWatch);
  const read = (now: number, succeeds = true) =>
    team.read(
      now,
      (msg) => {
        reads.push(msg);
        return succeeds;
      },
      () => `team-${++sequence}`,
    );
  return { team, reads, watches, sendWatch, read };
}

test('team eligibility uses lead ownership and only local office-owned Droid workers', () => {
  const local = worker('local');
  assert.deepEqual(teamThreadChildren('lead', [worker('lead'), worker('other', { lead: 'elsewhere' }), worker('shell', { kind: 'shell' }), worker('cloud', { kind: 'cloud' }), local]), [local]);
  assert.deepEqual(
    teamThreadChildren('lead', [worker('z'), worker('a'), worker('first', { createdAt: 0 })]).map((w) => w.id),
    ['first', 'a', 'z'],
  );
});

test('reads require active, connected, visible and expanded, and disabling invalidates pending replies', () => {
  for (const flags of [
    [false, true, true, true],
    [true, false, true, true],
    [true, true, false, true],
    [true, true, true, false],
  ] as const)
    assert.equal(teamThreadVisible(...flags), false);
  assert.equal(teamThreadVisible(true, true, true, true), true);
  const { team, reads, watches, sendWatch, read } = rig();
  assert.deepEqual(watches, [{ t: 'thread.watch', workerId: 'one', on: true }]);
  read(1000);
  team.enable(false, sendWatch);
  assert.deepEqual(watches.at(-1), { t: 'thread.watch', workerId: 'one', on: false });
  read(2000);
  assert.equal(reads.length, 1);
  assert.equal(team.receive(snapshot(reads[0])), false);
  team.enable(true, sendWatch);
  assert.deepEqual(watches.at(-1), { t: 'thread.watch', workerId: 'one', on: true });
  read(2000);
  assert.equal(team.receive(snapshot(reads[0])), false);
  assert.equal(team.receive(snapshot(reads[1])), true);
});

test('initial hydration runs one child per second, then reconciles hydrated children at 15s', () => {
  const { team, reads, read } = rig([worker('one'), worker('two')]);
  read(1000);
  read(1001);
  assert.equal(reads.length, 1);
  team.receive(snapshot(reads[0]), 1000);
  read(1999);
  assert.equal(reads.length, 1);
  // Child two is still unreceived, so it hydrates at 2000ms.
  read(2000);
  assert.equal(reads.length, 2);
  assert.equal(reads[1].workerId, 'two');
  // Child one is received (reconciles at 1000 + 15000 = 16000ms) and two is pending, so 3000..15999 send no reads!
  read(3000);
  read(15_999);
  assert.equal(reads.length, 2);
  // At 16000ms (with two timed out at 10000ms if checked), let's answer two at 3500ms first:
  const rig2 = rig([worker('one'), worker('two')]);
  rig2.read(1000);
  rig2.team.receive(snapshot(rig2.reads[0]), 1000);
  rig2.read(2000);
  rig2.team.receive(snapshot(rig2.reads[1]), 2000);
  for (let t = 3000; t < 1000 + TEAM_RECONCILE_INTERVAL; t += 1000) {
    rig2.read(t);
  }
  assert.equal(rig2.reads.length, 2, 'zero 1s polling once both children hydrated');
  rig2.read(1000 + TEAM_RECONCILE_INTERVAL);
  assert.equal(rig2.reads.length, 3);
  assert.equal(rig2.reads[2].workerId, 'one');
  rig2.read(2000 + TEAM_RECONCILE_INTERVAL);
  assert.equal(rig2.reads.length, 4);
  assert.equal(rig2.reads[3].workerId, 'two');
});

test('pushed snapshots update active children immediately, supersede pending reads, and bump revision only on changes', () => {
  const { team, reads, read } = rig([worker('one'), worker('two')]);
  read(1000);
  assert.equal(reads.length, 1);
  assert.ok(team.members.get('one')?.pending);

  const beforeRev = team.revision;
  // Push arrives while initial thread.read is still in flight -> clears pending and marks received!
  assert.equal(team.receive(pushedSnapshot('one', [entry(1, { text: 'Live push 1' })]), 1200), true);
  assert.equal(team.members.get('one')?.pending, undefined);
  assert.equal(team.members.get('one')?.received, true);
  assert.equal(team.members.get('one')?.history.entries[0]?.text, 'Live push 1');
  assert.ok(team.revision > beforeRev);

  // Stale reply from superseded thread.read is ignored.
  assert.equal(team.receive(snapshot(reads[0], [entry(1, { text: 'Stale poll' })])), false);
  assert.equal(team.members.get('one')?.history.entries[0]?.text, 'Live push 1');

  // Identical push does not bump revision.
  const revAfterPush = team.revision;
  assert.equal(team.receive(pushedSnapshot('one', [entry(1, { text: 'Live push 1' })]), 1500), true);
  assert.equal(team.revision, revAfterPush);

  // Push for another session or unknown/disabled/before page is rejected.
  assert.equal(team.receive(pushedSnapshot('one', [entry(2)], { sessionId: 'wrong-session' })), false);
  assert.equal(team.receive(pushedSnapshot('unknown', [entry(2)])), false);
  assert.equal(team.receive(pushedSnapshot('one', [entry(2)], { before: 2 })), false);

  // Push updates child two even before any thread.read ran for two!
  assert.equal(team.receive(pushedSnapshot('two', [entry(10, { text: 'Instant push' })]), 1600), true);
  assert.equal(team.members.get('two')?.received, true);
  // At 2000ms, neither child needs a poll because both received pushes < 15s ago.
  read(2000);
  assert.equal(reads.length, 1);
});

test('watch subscriptions reconcile cleanly across sync, member removal, lost/sessionless states, clear, resetWatches and dispose', () => {
  const { team, watches, sendWatch } = rig([worker('one'), worker('two'), worker('starting', { sessionId: undefined }), worker('lost', { lost: { branch: 'here' } })]);
  assert.deepEqual(
    watches.map((w) => [w.workerId, w.on]),
    [
      ['one', true],
      ['two', true],
    ],
  );
  watches.length = 0;

  // Starting child acquires sessionId and child two leaves -> two unwatched, starting watched.
  team.sync('floor:lead', 'lead', [worker('one'), worker('starting', { sessionId: 'session-starting' })], sendWatch);
  assert.deepEqual(
    watches.map((w) => [w.workerId, w.on]),
    [
      ['two', false],
      ['starting', true],
    ],
  );
  watches.length = 0;

  // Scope switch un-watches previous scope's children and watches the new scope's children.
  team.sync('floor-2:lead', 'lead', [worker('three')], sendWatch);
  assert.deepEqual(
    watches.map((w) => [w.workerId, w.on]),
    [
      ['one', false],
      ['starting', false],
      ['three', true],
    ],
  );
  watches.length = 0;

  // Disconnect resets local watches without sending over dead socket; reconnect re-subscribes.
  team.resetWatches();
  team.syncWatches(sendWatch);
  assert.deepEqual(watches, [{ t: 'thread.watch', workerId: 'three', on: true }]);
  watches.length = 0;

  // Dispose un-watches remaining watched children.
  team.dispose(sendWatch);
  assert.deepEqual(watches, [{ t: 'thread.watch', workerId: 'three', on: false }]);
  assert.equal(team.watched.size, 0);
});

test('six cached children hydrate one per second fairly, then reconcile every 15s', () => {
  assert.equal(TEAM_THREAD_WORKERS, 6);
  const workers = Array.from({ length: 9 }, (_, i) => worker(`child-${i}`));
  const { team, reads, read } = rig(workers);
  for (let second = 1; second <= 6; second++) {
    read(second * 1000);
    assert.equal(reads.length, second);
    team.receive(snapshot(reads.at(-1) as Read), second * 1000);
    read(second * 1000);
    read(second * 1000 + 999);
    assert.equal(reads.length, second);
  }
  assert.equal(team.members.size, 6);
  assert.equal(team.total, 9);
  assert.deepEqual(
    reads.map((r) => r.workerId),
    Array.from({ length: 6 }, (_, i) => `child-${i}`),
  );
  // Once all 6 hydrated, 7s..15s send zero reads, then 16s..21s reconcile child-0..child-5.
  for (let second = 7; second <= 15; second++) read(second * 1000);
  assert.equal(reads.length, 6);
  for (let second = 16; second <= 21; second++) {
    read(second * 1000);
    team.receive(snapshot(reads.at(-1) as Read), second * 1000);
  }
  assert.equal(reads.length, 12);
  assert.deepEqual(
    reads.slice(6).map((r) => r.workerId),
    Array.from({ length: 6 }, (_, i) => `child-${i}`),
  );
});

test('pending, lost and starting children do not block round-robin progress or steal other slots', () => {
  const { team, reads, read } = rig([worker('a'), worker('b', { lost: { branch: 'here' } }), worker('c', { sessionId: undefined }), worker('d')]);
  read(1000);
  read(2000);
  assert.deepEqual(
    reads.map((r) => r.workerId),
    ['a', 'd'],
  );
  team.receive(snapshot(reads[1]), 2000);
  // At 9000ms, 'a' times out (8000ms timeout) and sets nextReadAt = 10000ms; 'd' is hydrated (< 17000ms).
  read(9000);
  assert.match(team.members.get('a')?.error ?? '', /did not return/);
  read(10000);
  assert.equal(reads.at(-1)?.workerId, 'a');
});

test('snapshot routing checks request, worker, latest page and session', () => {
  const { team, reads, read } = rig();
  read(1000);
  const reply = snapshot(reads[0]);
  assert.equal(team.receive({ ...reply, workerId: 'elsewhere' }), false);
  assert.equal(team.receive({ ...reply, request: 'unrelated' }), false);
  assert.equal(team.receive({ ...reply, before: 10 }), false);
  assert.equal(team.receive({ ...reply, sessionId: 'old-session' }), false);
  assert.equal(team.members.get('one')?.history.entries.length, 0);
  read(2000);
  assert.equal(team.receive(snapshot(reads[1])), true);
  assert.equal(team.receive(snapshot(reads[1])), false);
});

test('timed out reads report an error, reject late replies and retry after 1s', () => {
  const { team, reads, read } = rig();
  read(1000);
  read(8999);
  assert.equal(reads.length, 1);
  read(9000);
  assert.match(team.members.get('one')?.error ?? '', /did not return/);
  assert.equal(team.receive(snapshot(reads[0])), false);
  read(9999);
  assert.equal(reads.length, 1);
  read(10000);
  assert.equal(reads.length, 2);
  assert.equal(team.receive(snapshot(reads[1], [], { error: 'Unavailable' })), true);
  assert.equal(team.members.get('one')?.error, 'Unavailable');
  read(11000);
  team.receive(snapshot(reads[2]), 11000);
  assert.equal(team.members.get('one')?.error, '');
  assert.equal(team.members.get('one')?.received, true);
});

test('failed sends are throttled too and lost checkouts or workers without sessions are not polled', () => {
  const { reads, read } = rig([worker('one'), worker('lost', { lost: { branch: 'here' } }), worker('starting', { sessionId: undefined })]);
  read(1000, false);
  read(1999, false);
  assert.equal(reads.length, 1);
  read(2000);
  assert.equal(reads.length, 2);
  assert.equal(reads[1].workerId, 'one');
});

test('a replacement session still respects the worker read interval', () => {
  const { team, reads, read } = rig();
  read(1000);
  team.sync('floor:lead', 'lead', [worker('one', { sessionId: 'replacement' })]);
  read(1001);
  assert.equal(reads.length, 1);
  read(2000);
  assert.equal(reads.length, 2);
  assert.equal(team.receive(snapshot(reads[0])), false);
  assert.equal(team.receive(snapshot(reads[1], [], { sessionId: 'replacement' })), true);
  team.sync('floor:lead', 'new-lead', [worker('one', { lead: 'new-lead', sessionId: 'replacement' })]);
  assert.equal(team.members.get('one')?.received, false);
});

test('collapse/reactivation and scope replacement do not reset the total read budget', () => {
  const { team, reads, read } = rig();
  read(1000);
  team.enable(false);
  team.sync('new-floor:new-lead', 'new-lead', [worker('two', { lead: 'new-lead' })]);
  team.enable(true);
  read(1001);
  read(1999);
  assert.equal(reads.length, 1);
  assert.equal(team.receive(snapshot(reads[0])), false);
  read(2000);
  assert.equal(reads.length, 2);
  assert.equal(reads[1].workerId, 'two');
  assert.equal(team.receive(snapshot(reads[1])), true);
});

test('worker removal, session replacement, floor/lead scope and disposal discard histories and pending IDs', () => {
  const { team, reads, read } = rig();
  read(1000);
  team.receive(snapshot(reads[0]));
  team.sync('floor:lead', 'lead', [worker('one', { sessionId: 'replacement' })]);
  assert.equal(team.members.get('one')?.history.entries.length, 0);
  read(2000);
  team.sync('other-floor:lead', 'lead', [worker('one')]);
  assert.equal(team.receive(snapshot(reads[1], [], { sessionId: 'replacement' })), false);
  read(3000);
  team.sync('other-floor:lead', 'lead', []);
  assert.equal(team.members.size, 0);
  assert.equal(team.receive(snapshot(reads[2])), false);
  team.sync('other-floor:lead', 'lead', [worker('one')]);
  read(4000);
  team.dispose();
  team.enable(true);
  team.sync('floor:lead', 'lead', [worker('one')]);
  read(5000);
  assert.equal(team.members.size, 0);
  assert.equal(reads.length, 4);
  assert.equal(team.receive(snapshot(reads[3])), false);
});

test('cache bounds cap workers, entries and content without mutating snapshots', () => {
  const workers = Array.from({ length: TEAM_THREAD_WORKERS + 5 }, (_, i) => worker(`child-${i.toString().padStart(2, '0')}`));
  const { team, reads, read } = rig(workers);
  assert.equal(team.total, workers.length);
  assert.equal(team.members.size, TEAM_THREAD_WORKERS);
  read(1000);
  assert.equal(reads.length, 1);
  const entries = Array.from({ length: 100 }, (_, i) => entry(i + 1));
  team.receive(snapshot(reads[0], entries), 1000);
  const history = team.members.get(reads[0].workerId)?.history;
  assert.equal(history?.entries.length, TEAM_THREAD_ENTRIES);
  assert.equal(history?.entries.at(-1)?.seq, 100);
  assert.equal(history?.hasMore, true);
  const huge = [entry(101, { input: 'i'.repeat(100_000), output: 'o'.repeat(100_000), text: 't'.repeat(100_000) }), entry(102, { output: 'x'.repeat(100_000) })];
  team.receive(pushedSnapshot(reads[0].workerId, huge), 1200);
  const bounded = team.members.get(reads[0].workerId)?.history.entries ?? [];
  assert.ok(JSON.stringify(bounded).length <= TEAM_THREAD_CHARACTERS);
  assert.match(bounded[0].output ?? '', /truncated; open the worker thread/);
  assert.equal(huge[0].input?.length, 100_000);
});

test('a long-running pushed stream retains only the bounded recent tail and all selected children stay bounded', () => {
  const { team } = rig([worker('one'), worker('two')]);
  const latest = new Map<string, number>();
  for (let page = 1; page <= 10; page++) {
    const wid = page % 2 ? 'one' : 'two';
    const entries = Array.from({ length: 100 }, (_, i) => entry(page * 100 + i, { text: 'x'.repeat(8000) }));
    const rows: ThreadRow[] = entries.map((e) => ({ kind: 'message', id: e.id, from: e.seq, to: e.seq, role: 'assistant', startsTurn: false }));
    team.receive(pushedSnapshot(wid, entries, { hasMore: true, presentation: { version: THREAD_MODEL_VERSION, rows } }), page * 1000);
    latest.set(wid, page * 100 + 99);
    for (const member of team.members.values()) {
      if (!latest.has(member.worker.id)) continue;
      assert.ok(member.history.entries.length <= TEAM_THREAD_ENTRIES);
      assert.deepEqual(
        member.history.rows.map((row) => row.id),
        member.history.entries.map((e) => e.id),
      );
      assert.ok(JSON.stringify(member.history.entries).length <= TEAM_THREAD_CHARACTERS);
      assert.equal(member.history.entries.at(-1)?.seq, latest.get(member.worker.id));
      assert.equal(member.history.hasMore, true);
    }
  }
});

test('the team cache never holds a row whose entries it dropped', () => {
  const { team, reads, read } = rig();
  read(1000);
  const entries: ThreadEntry[] = [entry(1, { role: 'user', text: 'Ship the release' }), ...Array.from({ length: 60 }, (_, i) => entry(i + 2, { kind: 'tool', name: 'Read', input: '{}', output: 'Done' }))];
  team.receive(snapshot(reads[0], entries, { hasMore: true, presentation: { version: THREAD_MODEL_VERSION, rows: presentThread(entries, false) } }));
  const history = team.members.get('one')?.history;
  assert.ok(history);
  assert.equal(history.entries.length, TEAM_THREAD_ENTRIES);
  assert.ok(!history.entries.some((item) => item.id === 'entry-1'), 'the oldest entries are dropped');
  const preview = history.rows.slice(-4);
  assert.ok(preview.length, 'the card has rows to show');
  assert.ok(
    preview.every((row) => row.kind !== 'message'),
    'a message row whose text the cache dropped would be an empty bubble',
  );
  const loaded = new Set(history.entries.map((item) => item.id));
  for (const row of preview) if (row.kind !== 'activity') assert.ok(loaded.has(row.id), `${row.id} is loaded`);
});

test('revision changes only for displayed state, not ticks, pending IDs or identical snapshots', () => {
  const { team, reads, read } = rig();
  const initial = team.revision;
  team.sync('floor:lead', 'lead', [worker('one', { open: true, cols: 120 })]);
  assert.equal(team.revision, initial);
  read(1000);
  read(1001);
  assert.equal(team.revision, initial);
  team.receive(snapshot(reads[0]), 1000);
  const received = team.revision;
  assert.ok(received > initial);
  read(16_000);
  team.receive(snapshot(reads[1]), 16_000);
  assert.equal(team.revision, received);
  team.sync('floor:lead', 'lead', [worker('one', { activity: 'New activity' })]);
  assert.ok(team.revision > received);
  const changed = team.revision;
  team.enable(false);
  team.enable(true);
  assert.equal(team.revision, changed);
  team.receive(pushedSnapshot('one', [entry(1, { text: 'Updated' })]), 17_000);
  assert.ok(team.revision > changed);
});

test('paint policy skips unchanged collapsed/expanded ticks and hidden updates, then catches up once', () => {
  const paint = new TeamThreadPaint();
  assert.equal(paint.changed(1, true, false, true), true);
  for (let tick = 0; tick < 20; tick++) assert.equal(paint.changed(1, true, false, true), false);
  assert.equal(paint.changed(1, true, true, true), true);
  assert.equal(paint.changed(1, true, true, true), false);
  assert.equal(paint.changed(2, true, true, false), false);
  assert.equal(paint.changed(3, false, false, false), false);
  assert.equal(paint.changed(3, false, false, true), true);
  assert.equal(paint.changed(3, false, false, true), false);
  assert.equal(paint.changed(3, false, false, true, true), true);
  assert.equal(paint.changed(3, false, false, false, true), false);
});

test('latest tool results update in place and rewritten sessions do not retain abandoned entries', () => {
  const { team, reads, read } = rig();
  read(1000);
  team.receive(snapshot(reads[0], [entry(1, { kind: 'tool', input: '{"command":"git diff"}' })]), 1000);
  team.receive(pushedSnapshot('one', [entry(1, { kind: 'tool', input: '{"command":"git diff"}', output: 'recorded patch' })]), 1500);
  assert.equal(team.members.get('one')?.history.entries[0].output, 'recorded patch');
  assert.equal(team.members.get('one')?.history.entries.length, 1);
  team.receive(pushedSnapshot('one', [entry(1, { id: 'replacement', text: 'New branch' })]), 2000);
  assert.equal(team.members.get('one')?.history.entries[0].id, 'replacement');
});
