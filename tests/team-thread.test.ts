import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEAM_THREAD_CHARACTERS, TEAM_THREAD_ENTRIES, TEAM_THREAD_WORKERS, TeamThread, teamThreadChildren, teamThreadVisible } from '../src/client/team-thread.js';
import type { ClientMsg, ServerMsg, WorkerInfo } from '../src/shared/protocol.js';
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

test('each child has one request at a time and no more than one read a second', () => {
  const { team, reads, read } = rig([worker('one'), worker('two')]);
  read(1000);
  read(1001);
  assert.equal(reads.length, 2);
  team.receive(snapshot(reads[0]));
  team.receive(snapshot(reads[1]));
  read(1999);
  assert.equal(reads.length, 2);
  read(2000);
  assert.equal(reads.length, 4);
  assert.deepEqual(
    reads.map((r) => r.workerId),
    ['one', 'two', 'one', 'two'],
  );
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
  assert.equal(reads.length, TEAM_THREAD_WORKERS);
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
  for (let page = 1; page <= 10; page++) {
    read(page * 1000);
    const entries = Array.from({ length: 100 }, (_, i) => entry(page * 100 + i, { text: 'x'.repeat(8000) }));
    for (const request of reads.slice(-2)) team.receive(snapshot(request, entries, { hasMore: true }));
    for (const member of team.members.values()) {
      assert.ok(member.history.entries.length <= TEAM_THREAD_ENTRIES);
      assert.ok(JSON.stringify(member.history.entries).length <= TEAM_THREAD_CHARACTERS);
      assert.equal(member.history.entries.at(-1)?.seq, page * 100 + 99);
      assert.equal(member.history.hasMore, true);
    }
  }
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
