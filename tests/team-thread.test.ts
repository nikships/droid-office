import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEAM_THREAD_CHARACTERS, TEAM_THREAD_ENTRIES, TEAM_THREAD_WORKERS, TeamThread, TeamThreadPaint, teamThreadChildren, teamThreadVisible } from '../src/client/team-thread.js';
import type { ClientMsg, ServerMsg, WorkerInfo } from '../src/shared/protocol.js';
import { THREAD_MODEL_VERSION, type ThreadRow } from '../src/shared/thread-presentation.js';
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
const snapshot = (read: Read, entries: ThreadEntry[] = [entry(1)], extra: Partial<Extract<ServerMsg, { t: 'thread.snapshot' }>> = {}): Extract<ServerMsg, { t: 'thread.snapshot' }> => ({
  ...read,
  t: 'thread.snapshot',
  sessionId: `session-${read.workerId}`,
  hasMore: false,
  entries,
  ...extra,
});
function rig(workers = [worker('one')]) {
  const team = new TeamThread();
  const reads: Read[] = [];
  let sequence = 0;
  team.sync('floor:lead', 'lead', workers);
  team.enable(true);
  const read = (now: number, succeeds = true) =>
    team.read(
      now,
      (msg) => {
        reads.push(msg);
        return succeeds;
      },
      () => `team-${++sequence}`,
    );
  return { team, reads, read };
}

test('team eligibility uses lead ownership and only local office-owned Droid workers', () => {
  const local = worker('local');
  assert.deepEqual(teamThreadChildren('lead', [worker('lead'), worker('other', { lead: 'elsewhere' }), worker('shell', { kind: 'shell' }), worker('cloud', { kind: 'cloud' }), worker('guest', { guest: {} as WorkerInfo['guest'] }), local]), [
    local,
  ]);
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
  const { team, reads, read } = rig();
  read(1000);
  team.enable(false);
  read(2000);
  assert.equal(reads.length, 1);
  assert.equal(team.receive(snapshot(reads[0])), false);
  team.enable(true);
  read(2000);
  assert.equal(team.receive(snapshot(reads[0])), false);
  assert.equal(team.receive(snapshot(reads[1])), true);
});

test('at most one child is read per second in total, without overlapping a pending child', () => {
  const { team, reads, read } = rig([worker('one'), worker('two')]);
  read(1000);
  read(1001);
  assert.equal(reads.length, 1);
  team.receive(snapshot(reads[0]));
  read(1999);
  assert.equal(reads.length, 1);
  read(2000);
  assert.equal(reads.length, 2);
  read(2000);
  read(2999);
  assert.equal(reads.length, 2);
  read(3000);
  assert.equal(reads.length, 3);
  // two is still pending, so one gets the next turn rather than overlapping it.
  team.receive(snapshot(reads[2]));
  read(4000);
  assert.equal(reads.length, 4);
  assert.deepEqual(
    reads.map((r) => r.workerId),
    ['one', 'two', 'one', 'one'],
  );
});

test('six cached children share one read per second fairly, even when sends fail', () => {
  assert.equal(TEAM_THREAD_WORKERS, 6);
  const workers = Array.from({ length: 9 }, (_, i) => worker(`child-${i}`));
  const { team, reads, read } = rig(workers);
  for (let second = 1; second <= 18; second++) {
    read(second * 1000, second % 3 !== 0);
    assert.equal(reads.length, second);
    if (second % 3 !== 0) team.receive(snapshot(reads.at(-1) as Read));
    read(second * 1000);
    read(second * 1000 + 999);
    assert.equal(reads.length, second);
  }
  assert.equal(team.members.size, 6);
  assert.equal(team.total, 9);
  assert.deepEqual(
    reads.map((r) => r.workerId),
    Array.from({ length: 18 }, (_, i) => `child-${i % 6}`),
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
  team.receive(snapshot(reads[1]));
  read(3000);
  assert.equal(reads[2].workerId, 'd');
  team.receive(snapshot(reads[2]));
  read(9000);
  assert.match(team.members.get('a')?.error ?? '', /did not return/);
  assert.equal(reads.at(-1)?.workerId, 'd');
  team.receive(snapshot(reads.at(-1) as Read));
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

test('timed out reads report an error, reject late replies and retry with a fresh request', () => {
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
  team.receive(snapshot(reads[2]));
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
  team.receive(snapshot(reads[0], entries));
  const history = team.members.get(reads[0].workerId)?.history;
  assert.equal(history?.entries.length, TEAM_THREAD_ENTRIES);
  assert.equal(history?.entries.at(-1)?.seq, 100);
  assert.equal(history?.hasMore, true);
  read(2000);
  const huge = [entry(101, { input: 'i'.repeat(100_000), output: 'o'.repeat(100_000), text: 't'.repeat(100_000) }), entry(102, { output: 'x'.repeat(100_000) })];
  team.receive(snapshot(reads.at(-1) as Read, huge));
  const bounded = team.members.get(reads.at(-1)?.workerId ?? '')?.history.entries ?? [];
  assert.ok(JSON.stringify(bounded).length <= TEAM_THREAD_CHARACTERS);
  assert.match(bounded[0].output ?? '', /truncated; open the worker thread/);
  assert.equal(huge[0].input?.length, 100_000);
});

test('a long-running stream retains only the bounded recent tail and all selected children stay bounded', () => {
  const { team, reads, read } = rig([worker('one'), worker('two')]);
  const latest = new Map<string, number>();
  for (let page = 1; page <= 10; page++) {
    read(page * 1000);
    const entries = Array.from({ length: 100 }, (_, i) => entry(page * 100 + i, { text: 'x'.repeat(8000) }));
    const rows: ThreadRow[] = entries.map((e) => ({ kind: 'message', id: e.id, from: e.seq, to: e.seq, role: 'assistant', startsTurn: false }));
    const request = reads.at(-1) as Read;
    team.receive(snapshot(request, entries, { hasMore: true, presentation: { version: THREAD_MODEL_VERSION, rows } }));
    latest.set(request.workerId, page * 100 + 99);
    for (const member of team.members.values()) {
      assert.ok(member.history.entries.length <= TEAM_THREAD_ENTRIES);
      assert.deepEqual(
        member.history.rows.map((row) => row.id),
        member.history.entries.map((e) => e.id),
      );
      assert.ok(JSON.stringify(member.history.entries).length <= TEAM_THREAD_CHARACTERS);
      assert.equal(member.history.entries.at(-1)?.seq, latest.get(member.worker.id));
      assert.equal(member.history.hasMore, latest.has(member.worker.id));
    }
  }
});

test('revision changes only for displayed state, not ticks, pending IDs or identical snapshots', () => {
  const { team, reads, read } = rig();
  const initial = team.revision;
  team.sync('floor:lead', 'lead', [worker('one', { open: true, cols: 120 })]);
  assert.equal(team.revision, initial);
  read(1000);
  read(1001);
  assert.equal(team.revision, initial);
  team.receive(snapshot(reads[0]));
  const received = team.revision;
  assert.ok(received > initial);
  read(2000);
  team.receive(snapshot(reads[1]));
  assert.equal(team.revision, received);
  team.sync('floor:lead', 'lead', [worker('one', { activity: 'New activity' })]);
  assert.ok(team.revision > received);
  const changed = team.revision;
  team.enable(false);
  team.enable(true);
  assert.equal(team.revision, changed);
  read(3000);
  team.receive(snapshot(reads[2], [entry(1, { text: 'Updated' })]));
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
  team.receive(snapshot(reads[0], [entry(1, { kind: 'tool', input: '{"command":"git diff"}' })]));
  read(2000);
  team.receive(snapshot(reads[1], [entry(1, { kind: 'tool', input: '{"command":"git diff"}', output: 'recorded patch' })]));
  assert.equal(team.members.get('one')?.history.entries[0].output, 'recorded patch');
  assert.equal(team.members.get('one')?.history.entries.length, 1);
  read(3000);
  team.receive(snapshot(reads[2], [entry(1, { id: 'replacement', text: 'New branch' })]));
  assert.equal(team.members.get('one')?.history.entries[0].id, 'replacement');
});
