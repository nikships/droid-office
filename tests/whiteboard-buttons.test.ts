import test from 'node:test';
import assert from 'node:assert/strict';
import { actionOp as phoneActionOp, pingOf as phonePingOf, pinged as phonePinged, stateWith } from '../android/app/src/main/assets/whiteboard/marks.js';
import { deliverPress, freshPresses, type PressWorkers } from '../src/server/whiteboard-buttons.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { actionOp, parseFrameMsg, parseHostMsg, wrap } from '../src/shared/whiteboard-bridge.js';
import { buttonDelivery, buttonTarget } from '../src/shared/whiteboard-ping.js';
import { ACTIONS_KEY, MAX_PING_LABEL_LENGTH, MAX_PING_TEXT_LENGTH, OWNER_AUTHOR, PINGED_KEY, applyOps, emptyBoard, findCard, pinged, stateAt, type Author, type Board, type Card, type Op } from '../src/shared/whiteboard.js';

const PIXEL: Author = { kind: 'worker', id: 'w-pixel', name: 'Pixel', color: '#ff8800' };
const NIBBLE: Author = { kind: 'worker', id: 'w-nibble', name: 'Nibble', color: '#00aaff' };
const content = (n: number) => ({ entry: 'index.html', files: { 'index.html': { hash: n.toString(16).padStart(64, '0'), size: 100, mime: 'text/html' } } });
const worker = (over: Partial<WorkerInfo>): WorkerInfo => ({ id: PIXEL.id, kind: 'agent', deskId: 'desk-1', name: 'Pixel', color: '#f00', status: 'idle', createdBy: 'x', createdAt: 0, ...over }) as WorkerInfo;

function run(b: Board, ops: Op[], who: Author = OWNER_AUTHOR): Board {
  const r = applyOps(b, ops, who, b.rev + 1, 1000 + b.rev);
  assert.ok(r.ok, r.ok ? '' : r.error.message);
  return r.board;
}

/** A page Pixel made: the card its buttons are on. */
const board = (by: Author = PIXEL): Board => run(emptyBoard(), [{ op: 'card.create', card: 'c1', kind: 'html', title: 'Proposal', content: content(1) }], by);
const cardOf = (b: Board): Card => findCard(b, 'c1')!;
const accept: Op = { op: 'state.action', card: 'c1', name: 'accept', ping: { text: 'Build it.', label: ' Accept and build ' } };

test('a data-wb-ping press is recorded once, until the worker deletes it', () => {
  let b = run(board(), [accept]);
  const at = 1000 + b.rev - 1;
  assert.deepEqual(stateAt(cardOf(b).state, [PINGED_KEY, 'accept']), { text: 'Build it.', label: 'Accept and build', at });
  assert.deepEqual(stateAt(cardOf(b).state, [ACTIONS_KEY, 'accept']), { name: 'accept', data: null, at });
  assert.ok(pinged(cardOf(b).state, 'accept'));
  assert.ok(!pinged(cardOf(b).state, 'deny'));

  // Pressed again (a second window, a retry): the action is recorded, the ping isn't replaced.
  b = run(b, [{ ...accept, ping: { text: 'Something else.' } } as Op]);
  assert.deepEqual(stateAt(cardOf(b).state, [PINGED_KEY, 'accept']), { text: 'Build it.', label: 'Accept and build', at });
  assert.equal((stateAt(cardOf(b).state, [ACTIONS_KEY, 'accept']) as { at: number }).at, 1000 + b.rev - 1);

  // The worker re-arms it.
  b = run(b, [{ op: 'state.del', card: 'c1', path: [PINGED_KEY, 'accept'] }], PIXEL);
  assert.ok(!pinged(cardOf(b).state, 'accept'));
  b = run(b, [{ op: 'state.action', card: 'c1', name: 'accept', ping: { text: 'Again.', label: '   ' } }]);
  assert.deepEqual(stateAt(cardOf(b).state, [PINGED_KEY, 'accept']), { text: 'Again.', at: 1000 + b.rev - 1 }, 'a blank label is left out');
  // A plain press records no ping.
  b = run(b, [{ op: 'state.action', card: 'c1', name: 'deny' }]);
  assert.ok(!pinged(cardOf(b).state, 'deny'));
});

test('a ping of the wrong shape or size fails the batch', () => {
  for (const [ping, re] of [
    ['Build it.', /ping must be an object/],
    [{ label: 'x' }, /ping\.text/],
    [{ text: 'x'.repeat(MAX_PING_TEXT_LENGTH + 1) }, /ping\.text/],
    [{ text: 'ok', label: 'x'.repeat(MAX_PING_LABEL_LENGTH + 1) }, /ping\.label/],
    [{ text: 'ok', label: 7 }, /ping\.label/],
  ] as const) {
    const r = applyOps(board(), [{ op: 'state.action', card: 'c1', name: 'accept', ping } as unknown as Op], OWNER_AUTHOR, 2, 2);
    assert.ok(!r.ok, JSON.stringify(ping).slice(0, 40));
    assert.match(r.error.message, re);
  }
});

test('the bridge carries a press’s ping and who its buttons tell', () => {
  const nonce = 'ping-nonce-0000000000';
  assert.deepEqual(parseFrameMsg(wrap({ type: 'action', name: 'accept', ping: { text: 'Go', label: 'Accept' } }, nonce), nonce), { type: 'action', name: 'accept', ping: { text: 'Go', label: 'Accept' } });
  assert.deepEqual(parseFrameMsg(wrap({ type: 'action', name: 'accept', ping: { text: 'Go', extra: 1 } as never }, nonce), nonce), { type: 'action', name: 'accept', ping: { text: 'Go' } });
  for (const ping of ['Go', { label: 'x' }, { text: 1 }, { text: 'Go', label: null }]) {
    assert.equal(parseFrameMsg(wrap({ type: 'action', name: 'accept', ping: ping as never }, nonce), nonce), undefined, JSON.stringify(ping));
  }
  assert.deepEqual(parseHostMsg(wrap({ type: 'buttons', to: 'Pixel' }, nonce), nonce), { type: 'buttons', to: 'Pixel' });
  assert.deepEqual(parseHostMsg(wrap({ type: 'buttons', to: 'Pixel', reason: 'ignored' }, nonce), nonce), { type: 'buttons', to: 'Pixel' });
  assert.deepEqual(parseHostMsg(wrap({ type: 'buttons', to: null, reason: 'Gone.' }, nonce), nonce), { type: 'buttons', to: null, reason: 'Gone.' });
  assert.deepEqual(parseHostMsg(wrap({ type: 'buttons', to: null }, nonce), nonce), { type: 'buttons', to: null });
  for (const bad of [{ to: '' }, { to: 3 }, { to: null, reason: 4 }, {}]) assert.equal(parseHostMsg(wrap({ type: 'buttons', ...bad } as never, nonce), nonce), undefined, JSON.stringify(bad));
  assert.deepEqual(actionOp('c1', 'accept', undefined, { text: 'Go' }), { op: 'state.action', card: 'c1', name: 'accept', ping: { text: 'Go' } });
  assert.deepEqual(actionOp('c1', 'pick', 'blue'), { op: 'state.action', card: 'c1', name: 'pick', data: 'blue' });
});

test("the phone records a press and its ping as the board's reducer does", () => {
  let b = board();
  let phone = cardOf(b).state;
  for (const op of [accept, { ...accept, ping: { text: 'Other' } }, { op: 'state.del', card: 'c1', path: [PINGED_KEY, 'accept'] }, { op: 'state.action', card: 'c1', name: 'deny', data: 1, ping: { text: 'No.' } }] as Op[]) {
    b = run(b, [op]);
    phone = stateWith(phone, op, 1000 + b.rev - 1);
    assert.deepEqual(phone, cardOf(b).state, JSON.stringify(op));
  }
  assert.ok(phonePinged(phone, 'deny'));
  assert.ok(!phonePinged(phone, 'accept'));
  for (const args of [
    ['c1', 'accept'],
    ['c1', 'pick', 'blue'],
    ['c1', 'accept', undefined, { text: 'Go', label: 'Accept' }],
  ] as const) {
    assert.deepEqual(phoneActionOp(...(args as [string, string])), actionOp(...(args as [string, string])));
  }
  assert.equal(phonePingOf(undefined), undefined);
  assert.equal(phonePingOf({ label: 'x' }), null);
  assert.deepEqual(phonePingOf({ text: 'Go', label: 'A', extra: 1 }), { text: 'Go', label: 'A' });
});

test("a card's buttons tell whoever last edited its page, while it's on the floor", () => {
  const b = board();
  assert.deepEqual(buttonTarget(cardOf(b), [worker({})]), { ok: true, id: PIXEL.id, name: 'Pixel' });
  for (const [workers, re] of [
    [[], /Pixel is no longer on this floor/],
    [[worker({ id: 'other' })], /no longer on this floor/],
    [[worker({ kind: 'shell' })], /can't take messages/],
    [[worker({ lost: true } as Partial<WorkerInfo>)], /worktree is gone/],
  ] as const) {
    const t = buttonTarget(cardOf(b), workers);
    assert.equal(t.ok, false);
    assert.match(!t.ok ? t.reason : '', re);
  }
  // Nibble rewrote the page: the buttons tell Nibble now. The owner's own page tells nobody.
  const nibble = run(b, [{ op: 'card.content', card: 'c1', content: content(2) }], NIBBLE);
  assert.equal((buttonTarget(cardOf(nibble), [worker({}), worker({ id: NIBBLE.id, name: 'Nibble' })]) as { name: string }).name, 'Nibble');
  // A state write or a title isn't the page.
  const titled = run(b, [{ op: 'card.title', card: 'c1', title: 'Renamed' }], NIBBLE);
  assert.equal((buttonTarget(cardOf(titled), [worker({})]) as { name: string }).name, 'Pixel');
  for (const mine of [board(OWNER_AUTHOR), run(b, [{ op: 'card.content', card: 'c1', content: content(3) }])]) {
    const t = buttonTarget(cardOf(mine), [worker({})]);
    assert.match(!t.ok ? t.reason : '', /You made this page/);
  }
});

test('a button message steers, wakes or waits, by status', () => {
  for (const s of ['idle', 'done', 'working']) assert.equal(buttonDelivery(worker({ status: s as WorkerInfo['status'] })), 'tell', s);
  for (const s of ['exited', 'offline']) assert.equal(buttonDelivery(worker({ status: s as WorkerInfo['status'] })), 'resume', s);
  for (const s of ['starting', 'needs_input']) assert.equal(buttonDelivery(worker({ status: s as WorkerInfo['status'] })), 'hold', s);
  assert.equal(buttonDelivery(worker({ status: 'offline', remote: true } as Partial<WorkerInfo>)), 'tell');
});

test("a batch's first press of each button that isn't sent yet goes on", () => {
  let b = board();
  const ops = [
    accept,
    { ...accept, ping: { text: 'twice' } },
    { op: 'state.action', card: 'c1', name: 'deny', ping: { text: 'No.', label: 7 } },
    { op: 'state.action', card: 'c1', name: 'plain' },
    { op: 'state.action', card: 'gone', name: 'accept', ping: { text: 'x' } },
    { op: 'state.set', card: 'c1', path: ['a'], value: 1 },
    null,
  ];
  assert.deepEqual(freshPresses(b, ops), [
    { card: 'c1', name: 'accept', ping: { text: 'Build it.', label: 'Accept and build' } },
    { card: 'c1', name: 'deny', ping: { text: 'No.' } },
    { card: 'gone', name: 'accept', ping: { text: 'x' } },
  ]);
  b = run(b, [accept]);
  assert.deepEqual(
    freshPresses(b, ops).map((p) => `${p.card}/${p.name}`),
    ['c1/deny', 'gone/accept'],
    'a sent button stays sent',
  );
});

function recorder(fail?: string) {
  const calls: { how: string; id: string; text: string }[] = [];
  const workers: PressWorkers = {
    tell: (id, text) => (calls.push({ how: 'tell', id, text }), fail),
    resume: (id, text) => (calls.push({ how: 'resume', id, text }), fail),
    hold: (id, text) => (calls.push({ how: 'hold', id, text }), fail),
  };
  return { calls, workers };
}

test("a press reaches the page's last editor as an office notice it can act on", () => {
  const b = run(board(), [accept]);
  const press = { card: 'c1', name: 'accept', ping: { text: 'Build it.\n```\nnot a fence\n```', label: 'Accept and build' } };
  const { calls, workers } = recorder();
  assert.deepEqual(deliverPress(b, press, [worker({})], workers, 'Main'), { ok: true, to: 'Pixel', how: 'tell' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, PIXEL.id);
  const text = calls[0].text;
  assert.match(text, /^Droid Office notice: the owner pressed “Accept and build” on the Whiteboard card “Proposal” \(c1\)\./);
  assert.ok(text.includes('\n````text\nBuild it.\n```\nnot a fence\n```\n````\n'), 'the message is fenced past its own backticks');
  assert.match(text, /path "pinged\.accept"/);

  for (const [status, how] of [
    ['offline', 'resume'],
    ['needs_input', 'hold'],
    ['starting', 'hold'],
  ] as const) {
    const r = recorder();
    assert.deepEqual(deliverPress(b, press, [worker({ status })], r.workers, 'Main'), { ok: true, to: 'Pixel', how });
    assert.equal(r.calls[0].how, how);
  }
  // A button with no message still says which was pressed; its action name stands in for its words.
  const bare = recorder();
  deliverPress(b, { card: 'c1', name: 'accept', ping: { text: '  ' } }, [worker({})], bare.workers, 'Main');
  assert.match(bare.calls[0].text, /pressed “accept”[\s\S]*The owner pressed “accept”\./);

  const broken = recorder('Worker is not running');
  assert.deepEqual(deliverPress(b, press, [worker({})], broken.workers, 'Main'), { ok: false, error: 'Pixel: Worker is not running' });
  const nobody = recorder();
  assert.match((deliverPress(b, press, [], nobody.workers, 'Main') as { error: string }).error, /no longer on this floor/);
  assert.match((deliverPress(b, { ...press, card: 'gone' }, [worker({})], nobody.workers, 'Main') as { error: string }).error, /card is gone/);
  assert.equal(nobody.calls.length, 0);
});
