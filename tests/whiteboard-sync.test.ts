import test from 'node:test';
import assert from 'node:assert/strict';
import { WhiteboardSync } from '../src/client/whiteboard-sync.js';
import type { ClientMsg, ServerMsg, WorkerInfo } from '../src/shared/protocol.js';
import { OWNER_AUTHOR, applyOps, emptyBoard, findCard, type Board, type BoardPatch, type Op } from '../src/shared/whiteboard.js';
import { pingEligibility } from '../src/shared/whiteboard-ping.js';

/** A fake server: commits what the window sends, once per (epoch, seq), and answers like server.ts. */
class FakeServer {
  board: Board = emptyBoard();
  record = new Map<string, number>();
  sent: ClientMsg[] = [];
  up = true;
  expired = new Set<string>();
  /** Answers held back (an outage between commit and ack). */
  drop = false;
  sync!: WhiteboardSync;
  epochN = 0;

  send = (msg: ClientMsg): boolean => {
    if (!this.up) return false;
    this.sent.push(msg);
    if (msg.t === 'whiteboard.apply') this.apply(msg.envelope.epoch, msg.envelope.seq, msg.envelope.ops);
    if (msg.t === 'whiteboard.sync') this.snapshot(this.lastEpoch);
    return true;
  };
  lastEpoch = '';
  welcome() {
    this.lastEpoch = `e${++this.epochN}`;
    this.sync.status(true);
    this.sync.handle({ t: 'welcome', floor: 'f1' } as unknown as ServerMsg);
    this.snapshot(this.lastEpoch);
  }
  snapshot(epoch: string) {
    this.sync.handle({ t: 'whiteboard', floor: 'f1', update: { kind: 'snapshot', board: this.board, epoch }, caps: { c1: 'kcap1' }, renderer: { available: false, reason: 'none' } });
  }
  private apply(epoch: string, seq: number, ops: Op[]) {
    const reply = (m: ServerMsg) => {
      if (!this.drop) this.sync.handle(m);
    };
    if (this.expired.has(epoch)) return reply({ t: 'whiteboard', floor: 'f1', update: { kind: 'rejected', epoch, seq, reason: 'expired' } });
    const key = `${epoch}#${seq}`;
    const done = this.record.get(key);
    if (done !== undefined) return reply({ t: 'whiteboard', floor: 'f1', update: { kind: 'ack', epoch, seq, rev: done } });
    const rev = this.board.rev + 1;
    const r = applyOps(this.board, ops, OWNER_AUTHOR, rev, 1000);
    if (!r.ok) return reply({ t: 'whiteboard', floor: 'f1', update: { kind: 'rejected', epoch, seq, reason: 'invalid', error: r.error } });
    this.board = r.board;
    this.record.set(key, rev);
    const patch: BoardPatch = { rev, at: 1000, actor: OWNER_AUTHOR, ops };
    reply({ t: 'whiteboard', floor: 'f1', update: { kind: 'patch', patch }, origin: { epoch, seq } });
    reply({ t: 'whiteboard', floor: 'f1', update: { kind: 'ack', epoch, seq, rev } });
  }
}

function setup() {
  const server = new FakeServer();
  const sync = new WhiteboardSync(server.send, () => 1000);
  server.sync = sync;
  return { server, sync };
}

const create = (card: string): Op => ({ op: 'card.create', card, kind: 'canvas', title: card });

test('a batch shows at once, is committed once, and the window lands on the server board', async () => {
  const { server, sync } = setup();
  server.welcome();
  assert.equal(sync.state('f1'), 'live');
  const changes: string[] = [];
  sync.subscribe((f) => changes.push(f));
  const r = await sync.apply('f1', [create('c1')]);
  assert.deepEqual(r, { ok: true, rev: 1 });
  assert.deepEqual(sync.board('f1'), server.board);
  assert.ok(changes.length > 0);
  assert.equal(sync.floor('f1').pending.length, 0);
  // Refused before it's sent when it can't apply to the board as the window has it.
  const before = server.sent.length;
  const bad = await sync.apply('f1', [{ op: 'card.title', card: 'nope', title: 'x' }]);
  assert.equal(bad.ok, false);
  assert.equal(server.sent.length, before);
  assert.equal(sync.cardUrl('f1', 'c1', 'n'), undefined, 'a canvas has no page');
});

test('offline, batches wait and show; on reconnect they go once, and one committed before the outage is not applied twice', async () => {
  const { server, sync } = setup();
  server.welcome();
  // Committed, but the answer is lost with the connection.
  server.drop = true;
  const lost = sync.apply('f1', [create('c1')]);
  server.drop = false;
  server.up = false;
  sync.status(false);
  assert.equal(sync.state('f1'), 'offline');
  const queued = sync.apply('f1', [{ op: 'card.title', card: 'c1', title: 'Renamed' }]);
  const view = sync.board('f1')!;
  assert.equal(findCard(view, 'c1')?.title, 'Renamed', 'shown at once while offline');
  assert.equal(sync.floor('f1').pending.length, 2);

  server.up = true;
  server.welcome();
  assert.deepEqual(await lost, { ok: true, rev: 1 }, 'the retry is recognised');
  assert.deepEqual(await queued, { ok: true, rev: 2 });
  assert.equal(server.board.rev, 2, 'each applied once');
  assert.equal(server.board.cards.length, 1);
  assert.deepEqual(sync.board('f1'), server.board);
  // Batches sent after the reconnect are numbered in the new epoch.
  const after = server.sent.filter((m) => m.t === 'whiteboard.apply').map((m) => (m as Extract<ClientMsg, { t: 'whiteboard.apply' }>).envelope);
  assert.deepEqual(
    after.map((e) => [e.epoch, e.seq]),
    [
      ['e1', 1],
      ['e1', 1],
      ['e1', 2],
    ],
  );
});

test('an expired batch becomes a draft, never applied twice, and can be reapplied against the board as it is now', async () => {
  const { server, sync } = setup();
  server.welcome();
  server.up = false;
  sync.status(false);
  const p = sync.apply('f1', [create('c1')]);
  server.up = true;
  server.expired.add('e1');
  server.welcome();
  assert.deepEqual(await p, { ok: false, reason: 'expired' });
  const f = sync.floor('f1');
  assert.equal(f.drafts.length, 1);
  assert.equal(server.board.rev, 0);
  const r = await sync.reapplyDraft('f1', f.drafts[0].id);
  assert.deepEqual(r, { ok: true, rev: 1 });
  assert.equal(sync.floor('f1').drafts.length, 0);
  assert.equal(await sync.reapplyDraft('f1', 999), undefined);
  // A draft that no longer applies stays a draft.
  server.up = false;
  sync.status(false);
  const again = sync.apply('f1', [create('c2')]);
  server.up = true;
  server.expired.add('e2');
  server.welcome();
  await again;
  sync.apply('f1', [create('c2')]);
  await new Promise((r) => setTimeout(r, 0));
  const d = sync.floor('f1').drafts[0];
  assert.equal((await sync.reapplyDraft('f1', d.id))?.ok, false);
  assert.equal(sync.floor('f1').drafts.length, 1);
  sync.discardDraft('f1', d.id);
  assert.equal(sync.floor('f1').drafts.length, 0);
});

test('a patch with a gap starts over from a snapshot; a batch made before any snapshot is numbered when one comes', async () => {
  const { server, sync } = setup();
  const early = sync.apply('f1', [create('c1')]);
  assert.equal(sync.board('f1'), null);
  server.welcome();
  assert.deepEqual(await early, { ok: true, rev: 1 });
  sync.handle({ t: 'whiteboard', floor: 'f1', update: { kind: 'patch', patch: { rev: 5, at: 1, actor: OWNER_AUTHOR, ops: [create('zz')] } } });
  assert.ok(
    server.sent.some((m) => m.t === 'whiteboard.sync'),
    'asked for a snapshot',
  );
  assert.deepEqual(sync.board('f1'), server.board);
  // Another floor: its batches wait for its snapshot, asked for when the window is elsewhere.
  sync.handle({ t: 'floor.enter', floor: 'f2' } as unknown as ServerMsg);
  assert.equal(sync.state('f1'), 'syncing');
  sync.handle({ t: 'whiteboard', floor: 'f1', update: { kind: 'patch', patch: { rev: 2, at: 1, actor: OWNER_AUTHOR, ops: [create('c2')] } } });
  assert.equal(sync.board('f1')!.rev, 1, 'patches for a floor the window left are ignored');
});

test('the card URL carries the capability and the nonce', () => {
  const { server, sync } = setup();
  const r = applyOps(emptyBoard(), [{ op: 'card.create', card: 'c1', kind: 'html', title: 'x', content: { entry: 'a b.html', files: { 'a b.html': { hash: 'a'.repeat(64), size: 1, mime: 'text/html' } } } }], OWNER_AUTHOR, 1, 1);
  assert.ok(r.ok);
  server.board = r.board;
  server.welcome();
  assert.equal(sync.cardUrl('f1', 'c1', 'n1'), '/whiteboard/c/kcap1/a%20b.html#wb=n1');
});

const worker = (over: Partial<WorkerInfo>): WorkerInfo => ({ id: 'w1', kind: 'agent', deskId: 'desk-1', name: 'Pixel', color: '#f00', status: 'idle', createdBy: 'x', createdAt: 0, ...over }) as WorkerInfo;

test('ping eligibility for every status, kind and condition', () => {
  assert.deepEqual(pingEligibility(worker({ status: 'idle' })), { ok: true, how: 'type' });
  assert.deepEqual(pingEligibility(worker({ status: 'done' })), { ok: true, how: 'type' });
  assert.deepEqual(pingEligibility(worker({ status: 'exited' })), { ok: true, how: 'resume' });
  assert.deepEqual(pingEligibility(worker({ status: 'offline' })), { ok: true, how: 'resume' });
  assert.deepEqual(pingEligibility(worker({ status: 'working' })), { ok: true, how: 'queue' });
  const busy = pingEligibility(worker({ status: 'working', kind: 'claude' as WorkerInfo['kind'] }));
  assert.equal(busy.ok, false);
  assert.equal(!busy.ok && busy.busy, true);
  for (const [w, re] of [
    [worker({ status: 'starting' }), /still starting/],
    [worker({ status: 'needs_input' }), /waiting on an answer/],
    [worker({ kind: 'shell' }), /plain shell/],
    [worker({ kind: 'cloud' as WorkerInfo['kind'] }), /Factory computer/],
    [worker({ guest: { pid: 1, tty: 'x' } as WorkerInfo['guest'] }), /guest/],
    [worker({ downedUntil: Date.now() + 10_000 }), /is down/],
    [worker({ lost: true } as Partial<WorkerInfo>), /worktree is gone/],
  ] as const) {
    const r = pingEligibility(w);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : '', re);
  }
});
