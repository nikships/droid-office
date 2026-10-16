import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  BRIDGE_CHANNEL,
  CANONICAL_WIDTH as PHONE_WIDTH,
  CANVAS_MARGIN as PHONE_MARGIN,
  CARD_ALLOW as PHONE_ALLOW,
  CARD_SANDBOX as PHONE_SANDBOX,
  STICKY_COLORS as PHONE_COLORS,
  STICKY_SIZE as PHONE_STICKY,
  applyLocal,
  canvasBounds as phoneBounds,
  dragMarkOps as phoneDragOps,
  dragPreview as phonePreview,
  jsonEqual,
  normalize,
  parseStatePathKey,
  pictureSize as phonePictureSize,
  reattachMarkOps as phoneReattachOps,
  stateChanges,
  stateWith,
  writeOp as phoneWriteOp,
} from '../android/app/src/main/assets/whiteboard/marks.js';
import { CANVAS_MARGIN } from '../src/client/ui/whiteboard-view.js';
import { CARD_SANDBOX } from '../src/server/whiteboard.js';
import { CANONICAL_WIDTH, OWNER_AUTHOR, STICKY_COLORS, STICKY_SIZE, applyOps, emptyBoard, findCard, statePathKey, type Board, type Card, type Op } from '../src/shared/whiteboard.js';
import { CARD_ALLOW, BRIDGE_CHANNEL as CHANNEL, writeOp } from '../src/shared/whiteboard-bridge.js';
import { canvasBounds, dragMarkOps, dragPreview, pictureSize, reattachMarkOps } from '../src/shared/whiteboard-marks.js';

const WORKER = { kind: 'worker' as const, id: 'w1', name: 'Pixel', color: '#33aaff' };

function board(kind: 'html' | 'canvas'): Board {
  const content = { entry: 'index.html', files: { 'index.html': { hash: 'a'.repeat(64), size: 1, mime: 'text/html' } } };
  const r = applyOps(emptyBoard(), [{ op: 'card.create', card: 'c1', kind, title: 'Card', ...(kind === 'html' ? { content } : {}) }], OWNER_AUTHOR, 1, 1);
  assert.ok(r.ok);
  return r.board;
}

function run(b: Board, ops: Op[], who = OWNER_AUTHOR): Board {
  const r = applyOps(b, ops, who, b.rev + 1, 1000 + b.rev);
  assert.ok(r.ok, r.ok ? '' : r.error.message);
  return r.board;
}

const cardOf = (b: Board): Card => findCard(b, 'c1')!;
const phoneCard = (b: Board) => normalize(JSON.parse(JSON.stringify(cardOf(b))));

test("the phone's card page uses the office's constants, sandbox and bridge channel", () => {
  assert.equal(PHONE_WIDTH, CANONICAL_WIDTH);
  assert.equal(PHONE_SANDBOX, CARD_SANDBOX);
  assert.ok(!PHONE_SANDBOX.includes('allow-same-origin'));
  assert.equal(PHONE_ALLOW, CARD_ALLOW);
  assert.equal(BRIDGE_CHANNEL, CHANNEL);
  assert.deepEqual(PHONE_COLORS, STICKY_COLORS);
  assert.deepEqual(PHONE_STICKY, STICKY_SIZE);
  assert.equal(PHONE_MARGIN, CANVAS_MARGIN);
});

test("the phone's host page frames cards with the sandbox and loads nothing but its own files", () => {
  const html = readFileSync('android/app/src/main/assets/whiteboard/index.html', 'utf8');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /frame-src 'self'/);
  const host = readFileSync('android/app/src/main/assets/whiteboard/host.js', 'utf8');
  assert.match(host, /setAttribute\('sandbox', CARD_SANDBOX\)/);
  assert.match(host, /setAttribute\('allow', CARD_ALLOW\)/);
});

test('state writes land as the board reducer writes them', () => {
  let b = board('html');
  const state = { fields: { email: 'a@b.c', tags: ['x'] }, keep: 1 };
  const writes: Op[] = [
    { op: 'state.set', card: 'c1', path: [], value: state },
    { op: 'state.set', card: 'c1', path: ['fields', 'email'], value: 'me@x.y' },
    { op: 'state.set', card: 'c1', path: ['deep', 'er', 'still'], value: true },
    { op: 'state.merge', card: 'c1', path: ['fields'], value: { name: 'N', tags: ['y', 'z'] } },
    { op: 'state.merge', card: 'c1', path: ['keep'], value: { now: 'object' } },
    { op: 'state.merge', card: 'c1', path: [], value: { top: { a: 1 } } },
    { op: 'state.del', card: 'c1', path: ['fields', 'name'] },
    { op: 'state.del', card: 'c1', path: ['missing', 'leaf'] },
  ];
  let phone = cardOf(b).state;
  for (const op of writes) {
    b = run(b, [op]);
    phone = stateWith(phone, op);
    assert.deepEqual(phone, cardOf(b).state, op.op);
  }
  const action: Op = { op: 'state.action', card: 'c1', name: 'approve', data: { ok: true } };
  b = run(b, [action]);
  const after = stateWith(phone, action, 1000 + b.rev - 1);
  assert.deepEqual(after, cardOf(b).state);
});

test('a frame write becomes the operation the office window sends', () => {
  for (const w of [
    { op: 'set', path: ['fields', 'a'], value: 1 },
    { op: 'merge', path: [], value: { b: 2 } },
    { op: 'del', path: ['c'] },
  ] as const) {
    assert.deepEqual(phoneWriteOp('c1', w), writeOp('c1', w as never));
  }
  assert.equal(phoneWriteOp('c1', { op: 'del', path: [] }), null);
  assert.equal(phoneWriteOp('c1', { op: 'merge', path: [], value: 3 }), null);
  assert.equal(phoneWriteOp('c1', { op: 'set', path: [1] as never, value: 1 }), null);
});

test('state changes name each leaf someone else changed, by its path', () => {
  const b0 = run(board('html'), [{ op: 'state.set', card: 'c1', path: ['a'], value: 1 }]);
  const b1 = run(b0, [{ op: 'state.set', card: 'c1', path: ['b', 'c.d'], value: 2 }], WORKER);
  assert.deepEqual(stateChanges(cardOf(b0), cardOf(b1)), [{ path: ['b', 'c.d'], author: WORKER }]);
  assert.deepEqual(parseStatePathKey(statePathKey(['x', 'y.z'])), ['x', 'y.z']);
  assert.deepEqual(parseStatePathKey('not json'), ['not json']);
});

test("the page's own mark operations show as the board will have them", () => {
  let b = board('canvas');
  const anchor = { kind: 'point' as const, point: { x: 10, y: 20 } };
  const steps: Op[][] = [
    [{ op: 'sticky.add', card: 'c1', id: 's1', anchor, box: { x: 0, y: 0, w: 220, h: 150 }, text: '', color: 'yellow' }],
    [{ op: 'picture.add', card: 'c1', id: 'p1', file: { hash: 'b'.repeat(64), size: 3, mime: 'image/png' }, anchor, box: { x: 0, y: 0, w: 64, h: 48 } }],
    [{ op: 'sticky.move', card: 'c1', id: 's1', box: { x: 5, y: -4 } }],
    [{ op: 'picture.move', card: 'c1', id: 'p1', box: { w: 90, h: 70 } }],
    [{ op: 'comment.add', card: 'c1', thread: 't1', message: 'm1', anchor, text: 'hi' }],
    [{ op: 'comment.reattach', card: 'c1', thread: 't1', anchor: { kind: 'point', point: { x: 300, y: 40 } } }],
    [{ op: 'sticky.reattach', card: 'c1', id: 's1', anchor: { kind: 'point', point: { x: 1, y: 2 } } }],
    [{ op: 'picture.rm', card: 'c1', id: 'p1' }],
    [{ op: 'sticky.rm', card: 'c1', id: 's1' }],
  ];
  for (const ops of steps) {
    const phone = phoneCard(b);
    b = run(b, ops);
    if (ops[0].op === 'comment.add') continue;
    for (const op of ops) applyLocal(phone, op);
    const view = (c: Card) => ({ stickies: c.stickies.map((s) => [s.id, s.box, s.anchor, s.text, s.color]), pictures: c.pictures.map((p) => [p.id, p.box, p.anchor, p.file]), threads: c.threads.map((t) => [t.id, t.anchor]) });
    assert.deepEqual(view(phone), view(cardOf(b)), ops[0].op);
  }
});

test('marks.resolve sets and clears detached as the board does', () => {
  let b = board('html');
  b = run(b, [{ op: 'comment.add', card: 'c1', thread: 't1', message: 'm1', anchor: { kind: 'element', wbId: 'x', offset: { x: 0, y: 0 }, point: { x: 1, y: 1 } }, text: 'hi' }]);
  for (const detached of [true, false]) {
    const phone = phoneCard(b);
    const op: Op = { op: 'marks.resolve', card: 'c1', marks: [{ id: 't1', detached }] };
    b = run(b, [op]);
    applyLocal(phone, op);
    assert.equal(!!phone.threads[0].detached, !!cardOf(b).threads[0].detached);
  }
});

test("drags, reattaches, picture sizes and a canvas's bounds match the office's window", () => {
  const box = { x: 4, y: -6, w: 200, h: 160 };
  const anchor = { kind: 'element' as const, wbId: 'hero', offset: { x: 1, y: 2 }, point: { x: 100, y: 50 } };
  for (const what of ['move', 'resize'] as const) {
    for (const a of [undefined, anchor]) {
      const o = { card: 'c1', kind: 'sticky' as const, id: 's1', what, box, dx: 33.4, dy: -250.6, anchor: a };
      assert.deepEqual(phoneDragOps(o), dragMarkOps(o));
    }
    assert.deepEqual(phonePreview({ x: 10, y: 20 }, box, -300, 7, what), dragPreview({ x: 10, y: 20 }, box, -300, 7, what));
  }
  for (const kind of ['thread', 'sticky', 'picture'] as const) {
    for (const b of [undefined, box, { ...box, x: 0, y: 0 }]) {
      const o = { card: 'c1', kind, id: 'x1', anchor, box: b };
      assert.deepEqual(phoneReattachOps(o), reattachMarkOps(o));
    }
  }
  for (const n of [
    { w: 4000, h: 3000 },
    { w: 10, h: 2000 },
    { w: 0, h: 0 },
    { w: 300, h: 200 },
  ]) {
    assert.deepEqual(phonePictureSize(n), pictureSize(n));
  }
  let b = board('canvas');
  const empty = phoneCard(b);
  assert.deepEqual(phoneBounds(empty), canvasBounds(cardOf(b), CANVAS_MARGIN));
  b = run(b, [
    { op: 'sticky.add', card: 'c1', id: 's1', anchor: { kind: 'point', point: { x: -400, y: 30 } }, box: { x: 0, y: 0, w: 200, h: 160 } },
    { op: 'comment.add', card: 'c1', thread: 't1', message: 'm1', anchor: { kind: 'point', point: { x: 2000, y: 900 } }, text: 'far' },
  ]);
  assert.deepEqual(phoneBounds(phoneCard(b)), canvasBounds(cardOf(b), CANVAS_MARGIN));
});

test('jsonEqual compares JSON by value', () => {
  assert.ok(jsonEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] }));
  assert.ok(!jsonEqual({ a: 1 }, { a: 1, b: undefined }));
  assert.ok(!jsonEqual([1], { 0: 1 }));
  assert.ok(!jsonEqual({ a: 1 }, { b: 1 }));
  assert.ok(!jsonEqual(null, {}));
});
