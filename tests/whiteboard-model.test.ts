import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIONS_KEY,
  CANONICAL_WIDTH,
  MAX_ASSET_BYTES,
  MAX_CARD_BYTES,
  MAX_CARDS,
  MAX_COMMENT_LENGTH,
  MAX_FLOOR_BYTES,
  MAX_HTML_BYTES,
  MAX_STATE_BYTES,
  MAX_STICKY_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  OWNER,
  OWNER_AUTHOR,
  TOMBSTONE_TTL_MS,
  advanceReads,
  applyOps,
  applyPatch,
  boardChanges,
  cardChanged,
  cardsNewestFirst,
  changesFor,
  emptyBoard,
  findCard,
  isContentPath,
  isServerOnly,
  parseEnvelope,
  parseStatePath,
  pruneTombstones,
  stateAt,
  statePathKey,
  utf8Length,
  type Author,
  type Board,
  type CardContent,
  type FileRef,
  type Op,
  type OpError,
  type PieceRef,
} from '../src/shared/whiteboard.js';
import { BRIDGE_CHANNEL, MAX_FOCUS_VALUE, actionOp, nonceFromHash, parseFrameMsg, parseHostMsg, wrap, writeOp } from '../src/shared/whiteboard-bridge.js';

const PIXEL: Author = { kind: 'worker', id: 'a1b2c3d4e5f6', name: 'Pixel', color: '#ff8800' };
const NIBBLE: Author = { kind: 'worker', id: '0f9e8d7c6b5a', name: 'Nibble', color: '#00aaff' };
const ME = OWNER_AUTHOR;

test('bridge navigation validates gestures, sequence numbers and load nonces', () => {
  const nonce = 'navigation-nonce-000000';
  const wheel = { type: 'wheel' as const, point: { x: 200.5, y: 100 }, dx: 12, dy: -3, deltaMode: 0, zoom: true, shift: false };
  assert.deepEqual(parseFrameMsg(wrap(wheel, nonce), nonce), wheel);
  for (const bad of [{ dx: NaN }, { dy: Infinity }, { point: { x: 'x', y: 1 } }, { deltaMode: 3 }, { zoom: 1 }, { shift: null }]) {
    assert.equal(parseFrameMsg({ ...wrap(wheel, nonce), ...bad }, nonce), undefined);
  }
  assert.equal(parseFrameMsg(wrap(wheel, nonce), 'wrong-nonce-000000'), undefined);
  for (const pressed of [true, false]) assert.deepEqual(parseFrameMsg(wrap({ type: 'space', pressed }, nonce), nonce), { type: 'space', pressed });
  assert.equal(parseFrameMsg({ ...wrap({ type: 'space', pressed: true }, nonce), pressed: 'true' }, nonce), undefined);
  assert.deepEqual(parseFrameMsg(wrap({ type: 'shortcut', key: 'h' }, nonce), nonce), { type: 'shortcut', key: 'h' });
  assert.equal(parseFrameMsg({ ...wrap({ type: 'shortcut', key: 'h' }, nonce), key: 'Escape' }, nonce), undefined);
  for (const phase of ['start', 'move', 'end'] as const) {
    const pan = { type: 'pan' as const, phase, point: { x: -20, y: 90 } };
    assert.deepEqual(parseFrameMsg(wrap(pan, nonce), nonce), pan);
  }
  assert.equal(parseFrameMsg({ ...wrap({ type: 'pan', phase: 'start', point: { x: 0, y: 0 } }, nonce), phase: 'wrong' }, nonce), undefined);
  const scroll = { type: 'scrollTo' as const, x: 0, y: 100, seq: 7 };
  assert.deepEqual(parseHostMsg(wrap(scroll, nonce), nonce), scroll);
  assert.equal(parseHostMsg({ ...wrap(scroll, nonce), seq: -1 }, nonce), undefined);
  const layout = { type: 'layout' as const, width: 1280, height: 5000, scrollX: 0, scrollY: 100, seq: 7 };
  assert.deepEqual(parseFrameMsg(wrap(layout, nonce), nonce), layout);
  assert.equal(parseFrameMsg({ ...wrap(layout, nonce), seq: 0.5 }, nonce), undefined);
});

let hashes = 0;
/** A fresh sha256-shaped hash. */
const hash = () => (++hashes).toString(16).padStart(64, '0');
const file = (size: number, mime = 'text/html'): FileRef => ({ hash: hash(), size, mime });
const page = (size = 1000, assets: Record<string, FileRef> = {}): CardContent => ({ entry: 'index.html', files: { 'index.html': file(size), ...assets } });
const png = (size = 5000): FileRef => file(size, 'image/png');
const at = (x: number, y: number) => ({ kind: 'point' as const, point: { x, y } });
const el = (wbId: string) => ({ kind: 'element' as const, wbId, offset: { x: 4, y: 8 }, point: { x: 100, y: 200 } });

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

/** The server's side: one board, batches applied in order, each a revision. Every board is frozen, so the reducer can't change one. */
class Sim {
  board: Board = deepFreeze(emptyBoard());
  now = 1_000_000;
  patches: { rev: number; at: number; actor: Author; ops: Op[] }[] = [];

  apply(actor: Author, ...ops: Op[]): Board {
    const r = this.try(actor, ...ops);
    assert.ok(r.ok, r.ok ? '' : r.error.message);
    return this.board;
  }

  fail(actor: Author, ...ops: Op[]): OpError {
    const before = JSON.stringify(this.board);
    const r = this.try(actor, ...ops);
    assert.ok(!r.ok, 'the batch should have failed');
    assert.equal(JSON.stringify(this.board), before, 'a failed batch changes nothing');
    return r.error;
  }

  try(actor: Author, ...ops: Op[]) {
    const rev = this.board.rev + 1;
    this.now += 1000;
    const r = applyOps(this.board, ops, actor, rev, this.now);
    if (r.ok) {
      this.board = deepFreeze(r.board);
      this.patches.push({ rev, at: this.now, actor, ops });
    }
    return r;
  }

  /** A read: the snapshot's revision becomes the reader's read point for these cards. */
  read(reader: Author, cards: string[], snapshot = this.board.rev) {
    return this.apply(reader, { op: 'read', cards, rev: snapshot });
  }

  card(id: string) {
    const c = findCard(this.board, id);
    assert.ok(c, `card ${id}`);
    return c;
  }
}

const refs = (pieces: PieceRef[]) => pieces.map((p) => JSON.stringify(p)).sort();

test('the canonical layout width is 1280', () => {
  assert.equal(CANONICAL_WIDTH, 1280);
});

test('cards are made, renamed, updated and listed newest first, each with its author snapshot', () => {
  const s = new Sim();
  s.apply(PIXEL, { op: 'card.create', card: 'c1', kind: 'html', title: '  Pricing draft ', content: page() });
  s.apply(ME, { op: 'card.create', card: 'c2', kind: 'canvas', title: 'Ideas' });
  const c1 = s.card('c1');
  assert.equal(c1.title, 'Pricing draft');
  assert.deepEqual(c1.author, PIXEL);
  assert.equal(c1.stamps.title.rev, 1);
  assert.equal(c1.stamps.content?.rev, 1);
  assert.deepEqual(c1.revs, { content: 1, state: 1, marks: 1 });
  assert.equal(s.card('c2').content, undefined);
  assert.deepEqual(
    cardsNewestFirst(s.board).map((c) => c.id),
    ['c2', 'c1'],
  );

  s.apply(NIBBLE, { op: 'card.title', card: 'c1', title: 'Pricing v2' });
  assert.deepEqual(s.card('c1').stamps.title, { rev: 3, author: NIBBLE });
  assert.deepEqual(s.card('c1').author, PIXEL, 'the card is still Pixel’s');

  // Writing the same value keeps the old stamp.
  s.apply(ME, { op: 'card.title', card: 'c1', title: 'Pricing v2' });
  assert.deepEqual(s.card('c1').stamps.title, { rev: 3, author: NIBBLE });
  const content = s.card('c1').content!;
  s.apply(ME, { op: 'card.content', card: 'c1', content });
  assert.equal(s.card('c1').stamps.content?.rev, 1);

  s.apply(PIXEL, { op: 'card.content', card: 'c1', content: page(2000) });
  assert.equal(s.card('c1').stamps.content?.rev, 6);
  assert.equal(s.card('c1').revs.content, 6);
  assert.equal(s.card('c1').stamps.title.rev, 3, 'a content change leaves the title’s stamp alone');

  assert.match(s.fail(ME, { op: 'card.content', card: 'c2', content: page() }).reason, /canvas/);
  assert.match(s.fail(ME, { op: 'card.create', card: 'c3', kind: 'canvas', title: 'x', content: page() }).reason, /canvas/);
  assert.match(s.fail(ME, { op: 'card.create', card: 'c3', kind: 'html', title: 'x' }).reason, /content/);
  assert.match(s.fail(ME, { op: 'card.create', card: 'c1', kind: 'canvas', title: 'x' }).reason, /already used/);
  assert.match(s.fail(ME, { op: 'card.create', card: '__proto__', kind: 'canvas', title: 'x' }).reason, /id/);
  assert.match(s.fail(ME, { op: 'card.title', card: 'c1', title: '   ' }).reason, /empty/);
});

test('a dismissed worker’s card, comment and stamps still say who made them', () => {
  const s = new Sim();
  s.apply(PIXEL, { op: 'card.create', card: 'c1', kind: 'html', title: 'Plan', content: page() }, { op: 'comment.add', card: 'c1', thread: 't1', message: 'm1', anchor: el('hero'), text: 'Look here' });
  // Pixel is gone from the floor: nothing on the board refers to a live worker record.
  const saved: Board = JSON.parse(JSON.stringify(s.board));
  const c = findCard(saved, 'c1')!;
  assert.deepEqual(c.author, PIXEL);
  assert.deepEqual(c.threads[0].messages[0].author, PIXEL);
  assert.equal(c.threads[0].messages[0].stamp.author.kind === 'worker' && c.threads[0].messages[0].stamp.author.name, 'Pixel');
});

test('a batch that fails anywhere changes nothing and names the operation', () => {
  const s = new Sim();
  s.apply(ME, { op: 'card.create', card: 'c1', kind: 'canvas', title: 'Board' });
  const before = s.board;
  const err = s.fail(PIXEL, { op: 'card.title', card: 'c1', title: 'Renamed' }, { op: 'sticky.add', card: 'c1', id: 's1', anchor: at(10, 10), text: 'hi' }, { op: 'sticky.move', card: 'c1', id: 'nope', box: { x: 5 } });
  assert.equal(err.index, 2);
  assert.equal(err.op, 'sticky.move');
  assert.match(err.message, /^Operation 2 \(sticky\.move\) failed: There is no sticky "nope" on card "c1"\. Nothing was changed\.$/);
  assert.equal(s.board, before);
  assert.equal(s.card('c1').title, 'Board');

  assert.match(s.fail(ME, { op: 'nope' } as unknown as Op).reason, /Unknown operation "nope"/);
  assert.equal(s.fail(ME).index, -1);

  // The batch as a whole: its actor and revision.
  const stale = applyOps(s.board, [{ op: 'card.title', card: 'c1', title: 'x' }], ME, s.board.rev, 1);
  assert.ok(!stale.ok && stale.error.index === -1 && /after/.test(stale.error.reason));
  const nobody = applyOps(s.board, [{ op: 'card.title', card: 'c1', title: 'x' }], { kind: 'worker', id: 'owner', name: 'x', color: '#000' }, s.board.rev + 1, 1);
  assert.ok(!nobody.ok && nobody.error.index === -1);
});

test('one batch is one revision: every piece it changes carries it', () => {
  const s = new Sim();
  s.apply(
    PIXEL,
    { op: 'card.create', card: 'c1', kind: 'html', title: 'Form', content: page() },
    { op: 'state.set', card: 'c1', path: ['fields', 'email'], value: 'a@b.c' },
    { op: 'sticky.add', card: 'c1', id: 's1', anchor: el('email'), text: 'Fill me' },
  );
  const c = s.card('c1');
  assert.equal(s.board.rev, 1);
  assert.equal(c.stamps.state[statePathKey(['fields', 'email'])].rev, 1);
  assert.deepEqual(c.stickies[0].stamps.text, { rev: 1, author: PIXEL });
});

test('a patch replayed on a window’s copy gives the server’s board', () => {
  const s = new Sim();
  s.apply(PIXEL, { op: 'card.create', card: 'c1', kind: 'html', title: 'Plan', content: page() });
  s.apply(ME, { op: 'state.merge', card: 'c1', path: [], value: { fields: { a: '1' } } }, { op: 'state.action', card: 'c1', name: 'approve', data: { ok: true } });
  s.apply(ME, { op: 'comment.add', card: 'c1', thread: 't1', message: 'm1', anchor: el('x'), text: 'Hmm' }, { op: 'show', selection: { kind: 'card', id: 'c1' } });
  s.apply(PIXEL, { op: 'comment.rm', card: 'c1', thread: 't1' });
  let mirror = emptyBoard();
  for (const p of s.patches) {
    const r = applyPatch(mirror, p);
    assert.ok(r.ok);
    mirror = r.board;
  }
  assert.deepEqual(mirror, JSON.parse(JSON.stringify(s.board)));
});

test('marks are anchored to an element or a point, and canvas cards take points only', () => {
  const s = new Sim();
  s.apply(ME, { op: 'card.create', card: 'h', kind: 'html', title: 'Page', content: page() }, { op: 'card.create', card: 'k', kind: 'canvas', title: 'Canvas' });
  s.apply(
    ME,
    { op: 'comment.add', card: 'h', thread: 't1', message: 'm1', anchor: { kind: 'element', selector: 'main > h1', quote: 'Pricing', point: { x: 40, y: 30 } } as never, text: 'Bigger' },
    { op: 'sticky.add', card: 'h', id: 's1', anchor: el('cta') },
    { op: 'picture.add', card: 'k', id: 'p1', file: png(), anchor: at(-50, 20), box: { w: 320, h: 200 } },
  );
  const h = s.card('h');
  assert.deepEqual(h.threads[0].anchor, { kind: 'element', selector: 'main > h1', quote: 'Pricing', offset: { x: 0, y: 0 }, point: { x: 40, y: 30 } });
  assert.deepEqual(h.stickies[0].box, { x: 0, y: 0, w: 200, h: 160 });
  assert.equal(h.stickies[0].color, 'yellow');
  assert.deepEqual(s.card('k').pictures[0].box, { x: 0, y: 0, w: 320, h: 200 });

  assert.match(s.fail(ME, { op: 'sticky.add', card: 'k', id: 's2', anchor: el('x') }).reason, /canvas card anchors marks to points only/);
  assert.match(s.fail(ME, { op: 'sticky.add', card: 'h', id: 's2', anchor: { kind: 'element', offset: { x: 0, y: 0 }, point: { x: 0, y: 0 } } }).reason, /wbId or a selector/);
  assert.match(s.fail(ME, { op: 'sticky.add', card: 'h', id: 's2', anchor: at(Number.NaN, 0) }).reason, /anchor\.point\.x/);
  assert.match(s.fail(ME, { op: 'sticky.add', card: 'h', id: 's1', anchor: at(0, 0) }).reason, /already used/);
  assert.match(s.fail(ME, { op: 'sticky.add', card: 'h', id: 'm1', anchor: at(0, 0) }).reason, /already used/, 'ids are unique across a card’s marks and messages');
  assert.match(s.fail(ME, { op: 'sticky.add', card: 'h', id: 's2', anchor: at(0, 0), box: { w: 2 } }).reason, /box\.w/);
  assert.match(s.fail(ME, { op: 'picture.add', card: 'h', id: 'p2', file: file(10, 'image/svg+xml'), anchor: at(0, 0), box: { w: 50, h: 50 } }).reason, /picture must be/);
  assert.match(s.fail(ME, { op: 'picture.add', card: 'h', id: 'p2', file: png(), anchor: at(0, 0) } as never).reason, /size/);
});

test('anchor resolution marks detached marks without stamping them, and reattaching brings them back', () => {
  const s = new Sim();
  s.apply(
    PIXEL,
    { op: 'card.create', card: 'h', kind: 'html', title: 'Page', content: page() },
    { op: 'sticky.add', card: 'h', id: 's1', anchor: el('old') },
    { op: 'comment.add', card: 'h', thread: 't1', message: 'm1', anchor: el('old'), text: 'Hi' },
  );
  s.read(ME, ['h']);
  const updatedAt = s.card('h').updatedAt;

  s.apply(ME, {
    op: 'marks.resolve',
    card: 'h',
    marks: [
      { id: 's1', detached: true },
      { id: 't1', detached: true },
      { id: 'gone', detached: true },
    ],
  });
  const c = s.card('h');
  assert.equal(c.stickies[0].detached, true);
  assert.equal(c.threads[0].detached, true);
  assert.equal(c.revs.marks, s.board.rev, 'the render changes');
  assert.equal(c.updatedAt, updatedAt, 'nobody changed the card');
  assert.equal(c.stickies[0].stamps.anchor.rev, 1);
  assert.equal(cardChanged(s.board, PIXEL.id, 'h'), false);

  s.apply(ME, { op: 'sticky.reattach', card: 'h', id: 's1', anchor: el('new') }, { op: 'comment.reattach', card: 'h', thread: 't1', anchor: el('old') });
  const r = s.card('h');
  assert.equal(r.stickies[0].detached, undefined);
  assert.equal(r.threads[0].detached, undefined);
  assert.deepEqual(r.stickies[0].stamps.anchor, { rev: s.board.rev, author: ME });
  assert.equal(r.threads[0].stamps.anchor.rev, 1, 'reattached to the same anchor: the anchor didn’t change');
});

test('the owner edits a sticky’s text, an agent then moves it: the text still shows as changed to that agent', () => {
  const s = new Sim();
  s.apply(PIXEL, { op: 'card.create', card: 'c', kind: 'canvas', title: 'Plan' }, { op: 'sticky.add', card: 'c', id: 's1', anchor: at(0, 0), text: 'Draft' });
  s.read(PIXEL, ['c']);
  s.apply(ME, { op: 'sticky.edit', card: 'c', id: 's1', text: 'Ship Friday' });
  s.apply(PIXEL, { op: 'sticky.move', card: 'c', id: 's1', box: { x: 300, y: 40 } });
  const sticky = s.card('c').stickies[0];
  assert.deepEqual(sticky.box, { x: 300, y: 40, w: 200, h: 160 });
  assert.equal(sticky.stamps.text.author.kind, 'owner');
  assert.deepEqual(refs(changesFor(s.board, PIXEL.id, 'c').pieces), refs([{ kind: 'sticky', id: 's1', field: 'text' }]));
  // And the owner sees the move, not their own edit.
  s.read(ME, ['c'], 2);
  assert.deepEqual(refs(changesFor(s.board, OWNER, 'c').pieces), refs([{ kind: 'sticky', id: 's1', field: 'box' }]));

  // Color and text are separate pieces too.
  s.apply(NIBBLE, { op: 'sticky.edit', card: 'c', id: 's1', color: 'pink' });
  assert.equal(s.card('c').stickies[0].stamps.text.author.kind, 'owner');
  assert.match(s.fail(ME, { op: 'sticky.edit', card: 'c', id: 's1', color: 'teal' as never }).reason, /color must be one of/);
  assert.match(s.fail(ME, { op: 'sticky.edit', card: 'c', id: 's1' }).reason, /text or color/);
});

test('changed marks are right for the owner and two agents', () => {
  const s = new Sim();
  s.apply(PIXEL, { op: 'card.create', card: 'c1', kind: 'html', title: 'Pricing', content: page() });
  s.apply(NIBBLE, { op: 'card.create', card: 'c2', kind: 'html', title: 'Logo', content: page() });
  // Nobody has read anything: each sees the other's card as changed, never their own.
  assert.deepEqual(boardChanges(s.board, OWNER).cards, ['c1', 'c2']);
  assert.deepEqual(boardChanges(s.board, PIXEL.id).cards, ['c2']);
  assert.deepEqual(boardChanges(s.board, NIBBLE.id).cards, ['c1']);

  for (const who of [ME, PIXEL, NIBBLE]) s.read(who, ['c1', 'c2']);
  for (const who of [OWNER, PIXEL.id, NIBBLE.id]) assert.deepEqual(boardChanges(s.board, who).cards, []);

  s.apply(ME, { op: 'comment.add', card: 'c1', thread: 't1', message: 'm1', anchor: el('price'), text: 'Too high' });
  assert.deepEqual(boardChanges(s.board, OWNER).cards, []);
  assert.deepEqual(boardChanges(s.board, PIXEL.id).cards, ['c1']);
  assert.deepEqual(boardChanges(s.board, NIBBLE.id).cards, ['c1']);
  assert.deepEqual(
    refs(changesFor(s.board, PIXEL.id, 'c1').pieces),
    refs([
      { kind: 'thread', id: 't1', field: 'resolved' },
      { kind: 'thread', id: 't1', field: 'anchor' },
      { kind: 'message', thread: 't1', id: 'm1' },
    ]),
  );

  s.apply(PIXEL, { op: 'comment.reply', card: 'c1', thread: 't1', message: 'm2', text: 'Lowered it' }, { op: 'comment.resolve', card: 'c1', thread: 't1' });
  s.read(PIXEL, ['c1']);
  assert.deepEqual(boardChanges(s.board, PIXEL.id).cards, []);
  assert.deepEqual(
    refs(changesFor(s.board, OWNER, 'c1').pieces),
    refs([
      { kind: 'thread', id: 't1', field: 'resolved' },
      { kind: 'message', thread: 't1', id: 'm2' },
    ]),
  );
  // Nibble hasn't read since the owner's comment, so it sees all of the thread.
  assert.equal(changesFor(s.board, NIBBLE.id, 'c1').pieces.length, 4);
});

test('partial reads and writes between reads never hide another author’s unread change', () => {
  const s = new Sim();
  s.apply(PIXEL, { op: 'card.create', card: 'a', kind: 'canvas', title: 'A' }, { op: 'card.create', card: 'b', kind: 'canvas', title: 'B' });
  s.read(PIXEL, ['a', 'b']);
  s.apply(ME, { op: 'sticky.add', card: 'a', id: 's1', anchor: at(0, 0), text: 'on A' }, { op: 'sticky.add', card: 'b', id: 's2', anchor: at(0, 0), text: 'on B' });

  // Pixel reads only card a: b stays changed.
  s.read(PIXEL, ['a']);
  assert.equal(cardChanged(s.board, PIXEL.id, 'a'), false);
  assert.equal(cardChanged(s.board, PIXEL.id, 'b'), true);

  // A read takes a snapshot; the owner writes while it runs; the read point moves to the snapshot, not past the write.
  const snapshot = s.board.rev;
  s.apply(ME, { op: 'sticky.edit', card: 'a', id: 's1', text: 'on A, edited mid-read' });
  s.read(PIXEL, ['a'], snapshot);
  assert.deepEqual(refs(changesFor(s.board, PIXEL.id, 'a').pieces), refs([{ kind: 'sticky', id: 's1', field: 'text' }]));

  // Read points never go backwards, and a read can't claim a revision the board hasn't reached.
  const latest = s.board.rev;
  s.read(PIXEL, ['a']);
  s.read(PIXEL, ['a'], 1);
  assert.equal(s.board.reads[PIXEL.id].a, latest);
  assert.match(s.fail(PIXEL, { op: 'read', cards: ['a'], rev: s.board.rev + 5 }).reason, /snapshot revision/);

  // The helper does the same outside a batch, without a new revision.
  const moved = advanceReads(s.board, NIBBLE.id, ['a', 'ghost'], s.board.rev);
  assert.equal(moved.rev, s.board.rev);
  assert.deepEqual(moved.reads[NIBBLE.id], { a: s.board.rev });
  assert.equal(s.board.reads[NIBBLE.id], undefined, 'the board passed in is untouched');
});

test('removals show as changes through tombstones, which hold no content', () => {
  const s = new Sim();
  s.apply(PIXEL, { op: 'card.create', card: 'c', kind: 'canvas', title: 'Plan' }, { op: 'sticky.add', card: 'c', id: 's1', anchor: at(0, 0), text: 'secret plan' });
  s.apply(PIXEL, { op: 'comment.add', card: 'c', thread: 't1', message: 'm1', anchor: at(5, 5), text: 'one' }, { op: 'comment.reply', card: 'c', thread: 't1', message: 'm2', text: 'two' });
  s.read(ME, ['c']);
  s.apply(ME, { op: 'sticky.rm', card: 'c', id: 's1' }, { op: 'comment.rm', card: 'c', thread: 't1', message: 'm2' });

  const changes = changesFor(s.board, PIXEL.id, 'c');
  assert.equal(changes.changed, true);
  assert.deepEqual(changes.pieces, []);
  assert.deepEqual(
    changes.removed.map((t) => [t.kind, t.id, t.parent]),
    [
      ['sticky', 's1', undefined],
      ['message', 'm2', 't1'],
    ],
  );
  assert.ok(!JSON.stringify(s.board.tombstones).includes('secret'));
  assert.equal(cardChanged(s.board, OWNER, 'c'), false, 'the owner removed them');

  // Removing the last message removes the thread, and its message tombstones fold into the thread's.
  s.apply(ME, { op: 'comment.rm', card: 'c', thread: 't1', message: 'm1' });
  assert.deepEqual(s.card('c').threads, []);
  assert.deepEqual(
    changesFor(s.board, PIXEL.id, 'c').removed.map((t) => [t.kind, t.id]),
    [
      ['sticky', 's1'],
      ['thread', 't1'],
    ],
  );
  assert.match(s.fail(ME, { op: 'sticky.add', card: 'c', id: 's1', anchor: at(0, 0) }).reason, /already used/, 'a tombstoned id is not reused');

  // A removed card: its own tombstone, the card's inner tombstones go, and the wall goes back to the grid.
  s.apply(ME, { op: 'show', selection: { kind: 'card', id: 'c' } });
  s.apply(PIXEL, { op: 'card.rm', card: 'c' });
  assert.deepEqual(s.board.selection, { kind: 'grid' });
  assert.deepEqual(
    s.board.tombstones.map((t) => [t.kind, t.id]),
    [['card', 'c']],
  );
  assert.deepEqual(
    boardChanges(s.board, OWNER).removed.map((t) => t.id),
    ['c'],
  );
  assert.deepEqual(boardChanges(s.board, PIXEL.id).removed, []);
  assert.match(s.fail(ME, { op: 'card.create', card: 'c', kind: 'canvas', title: 'again' }).reason, /already used/);
  assert.match(s.fail(ME, { op: 'show', selection: { kind: 'card', id: 'c' } }).reason, /no card "c"/);
});

test('deleting a card that isn’t on the wall leaves the selection alone', () => {
  const s = new Sim();
  s.apply(ME, { op: 'card.create', card: 'a', kind: 'canvas', title: 'A' }, { op: 'card.create', card: 'b', kind: 'canvas', title: 'B' }, { op: 'show', selection: { kind: 'card', id: 'a' } });
  s.apply(PIXEL, { op: 'card.rm', card: 'b' });
  assert.deepEqual(s.board.selection, { kind: 'card', id: 'a' });
  s.apply(PIXEL, { op: 'show', selection: { kind: 'grid' } });
  assert.deepEqual(s.board.selection, { kind: 'grid' });
});

test('tombstones are pruned once every other reader has read past them, or after 30 days', () => {
  const s = new Sim();
  s.apply(ME, { op: 'card.create', card: 'c', kind: 'canvas', title: 'Plan' }, { op: 'sticky.add', card: 'c', id: 's1', anchor: at(0, 0) }, { op: 'sticky.add', card: 'c', id: 's2', anchor: at(0, 0) });
  s.read(PIXEL, ['c']);
  s.read(NIBBLE, ['c']);
  s.apply(ME, { op: 'sticky.rm', card: 'c', id: 's1' });
  const readers = [OWNER, PIXEL.id, NIBBLE.id];

  s.apply(ME, { op: 'prune', readers });
  assert.equal(s.board.tombstones.length, 1, 'neither agent has seen it');
  s.read(PIXEL, ['c']);
  s.apply(ME, { op: 'prune', readers });
  assert.equal(s.board.tombstones.length, 1, 'Nibble still hasn’t');
  s.read(NIBBLE, ['c']);
  s.apply(ME, { op: 'prune', readers });
  assert.equal(s.board.tombstones.length, 0, 'everyone but its author has; the owner’s own read point doesn’t matter');

  // A reader that never reads holds a tombstone 30 days at most.
  s.apply(PIXEL, { op: 'sticky.rm', card: 'c', id: 's2' });
  const t = s.board.tombstones[0];
  assert.equal(pruneTombstones(s.board, t.at + TOMBSTONE_TTL_MS - 1, readers).tombstones.length, 1);
  assert.equal(pruneTombstones(s.board, t.at + TOMBSTONE_TTL_MS, readers).tombstones.length, 0);

  // A dismissed worker is forgotten, and no longer holds it.
  s.read(ME, ['c']);
  s.apply(ME, { op: 'prune' });
  assert.equal(s.board.tombstones.length, 1, 'Nibble has a read point, so it counts by default');
  s.apply(ME, { op: 'reader.forget', reader: NIBBLE.id }, { op: 'prune' });
  assert.equal(s.board.tombstones.length, 0);
  assert.equal(s.board.reads[NIBBLE.id], undefined);

  // A removed card's read points go with its tombstone.
  s.apply(PIXEL, { op: 'card.rm', card: 'c' });
  s.read(ME, ['c']);
  assert.equal(s.board.reads[OWNER].c, s.board.rev - 1);
  s.apply(ME, { op: 'prune', readers: [OWNER, PIXEL.id] });
  assert.deepEqual(s.board.tombstones, []);
  assert.deepEqual(s.board.reads[OWNER], {});
  assert.deepEqual(s.board.reads[PIXEL.id], {});
});

test('state: set replaces at a path, merge sets each leaf, del removes, each leaf has its own stamp', () => {
  const s = new Sim();
  s.apply(PIXEL, { op: 'card.create', card: 'c', kind: 'html', title: 'Form', content: page() });
  const key = (...p: string[]) => statePathKey(p);
  const stamp = (...p: string[]) => s.card('c').stamps.state[key(...p)];

  s.apply(PIXEL, { op: 'state.set', card: 'c', path: [], value: { plan: { tier: 'pro', seats: 5, tags: ['a', 'b'] }, note: 'hi' } });
  assert.deepEqual(Object.keys(s.card('c').stamps.state).sort(), [key('note'), key('plan', 'seats'), key('plan', 'tags'), key('plan', 'tier')].sort());

  // merge: leaves set one by one, objects recursed into, arrays replaced whole.
  s.apply(ME, { op: 'state.merge', card: 'c', path: [], value: { plan: { seats: 8, tags: ['c'] }, extra: { deep: { x: 1 } } } });
  assert.deepEqual(s.card('c').state, { plan: { tier: 'pro', seats: 8, tags: ['c'] }, note: 'hi', extra: { deep: { x: 1 } } });
  assert.equal(stamp('plan', 'tier').rev, 2, 'untouched leaf keeps its stamp');
  assert.equal(stamp('plan', 'seats').author.kind, 'owner');
  assert.equal(stamp('plan', 'tags').author.kind, 'owner');
  assert.equal(stamp('extra', 'deep', 'x').rev, 3);

  // A write of the same value keeps the stamp; set at a nested path creates its parents.
  s.apply(NIBBLE, { op: 'state.set', card: 'c', path: ['plan', 'seats'], value: 8 }, { op: 'state.set', card: 'c', path: ['new', 'deep', 'leaf'], value: [1, { two: 2 }] });
  assert.equal(stamp('plan', 'seats').author.kind, 'owner');
  assert.deepEqual(stateAt(s.card('c').state, ['new', 'deep', 'leaf']), [1, { two: 2 }]);

  // Two writers on different leaves don't collide; the same leaf is last writer wins.
  s.apply(PIXEL, { op: 'state.set', card: 'c', path: ['plan', 'tier'], value: 'team' });
  s.apply(ME, { op: 'state.set', card: 'c', path: ['note'], value: 'owner note' });
  s.apply(NIBBLE, { op: 'state.set', card: 'c', path: ['note'], value: 'nibble note' });
  assert.equal(stateAt(s.card('c').state, ['plan', 'tier']), 'team');
  assert.equal(stateAt(s.card('c').state, ['note']), 'nibble note');
  assert.deepEqual(stamp('note').author, NIBBLE);

  // set replaces a subtree: leaves that went leave tombstones, ones that stayed the same keep their stamp.
  const tierStamp = stamp('plan', 'tier');
  s.apply(ME, { op: 'state.set', card: 'c', path: ['plan'], value: { tier: 'team' } });
  assert.deepEqual(stamp('plan', 'tier'), tierStamp);
  const removed = (who: string) =>
    changesFor(s.board, who, 'c')
      .removed.map((t) => t.id)
      .sort();
  assert.deepEqual(removed(PIXEL.id), [key('plan', 'seats'), key('plan', 'tags')].sort());

  // del removes a path; a missing path is a no-op; recreating a leaf takes its tombstone back.
  s.apply(PIXEL, { op: 'state.del', card: 'c', path: ['extra', 'deep'] }, { op: 'state.del', card: 'c', path: ['missing', 'x'] });
  assert.deepEqual(s.card('c').state.extra, {});
  assert.ok(removed(OWNER).includes(key('extra', 'deep', 'x')));
  s.apply(PIXEL, { op: 'state.set', card: 'c', path: ['plan', 'seats'], value: 2 });
  assert.ok(!removed(OWNER).includes(key('plan', 'seats')));

  // A path through a leaf replaces it with an object: arrays are leaves, and a path never indexes into one.
  s.apply(ME, { op: 'state.set', card: 'c', path: ['new', 'deep', 'leaf', '0'], value: 'x' });
  assert.deepEqual(stateAt(s.card('c').state, ['new', 'deep', 'leaf']), { 0: 'x' });

  // The whole state.
  s.apply(ME, { op: 'state.set', card: 'c', path: [], value: {} });
  assert.deepEqual(s.card('c').state, {});
  assert.deepEqual(s.card('c').stamps.state, {});
  assert.equal(s.card('c').revs.state, s.board.rev);

  assert.match(s.fail(ME, { op: 'state.set', card: 'c', path: [], value: [1] }).reason, /must be an object/);
  assert.match(s.fail(ME, { op: 'state.merge', card: 'c', path: ['a'], value: 3 as never }).reason, /merge takes an object/);
  assert.match(s.fail(ME, { op: 'state.del', card: 'c', path: [] }).reason, /at least one key/);
  assert.match(s.fail(ME, { op: 'state.set', card: 'c', path: ['__proto__', 'x'], value: 1 }).reason, /__proto__/);
  assert.match(s.fail(ME, { op: 'state.set', card: 'c', path: ['a'], value: JSON.parse('{"__proto__":{"polluted":true}}') }).reason, /__proto__/);
  assert.match(s.fail(ME, { op: 'state.set', card: 'c', path: ['a'], value: Number.POSITIVE_INFINITY }).reason, /JSON/);
  assert.match(s.fail(ME, { op: 'state.set', card: 'c', path: 'a' as never, value: 1 }).reason, /list of keys/);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('merging into a path, empty objects and an action press', () => {
  const s = new Sim();
  s.apply(ME, { op: 'card.create', card: 'c', kind: 'html', title: 'Form', content: page() });
  s.apply(ME, { op: 'state.set', card: 'c', path: ['fields', 'name'], value: 'Sam' });
  s.apply(PIXEL, { op: 'state.merge', card: 'c', path: ['fields'], value: { email: 'sam@x.y', prefs: {} } });
  assert.deepEqual(s.card('c').state, { fields: { name: 'Sam', email: 'sam@x.y', prefs: {} } });
  // An empty object merged into an object with keys leaves it alone.
  s.apply(PIXEL, { op: 'state.merge', card: 'c', path: [], value: { fields: {} } });
  assert.equal(stateAt(s.card('c').state, ['fields', 'name']), 'Sam');

  s.apply(ME, { op: 'state.action', card: 'c', name: 'approve', data: { plan: 'pro', extras: ['a'] } });
  assert.deepEqual(stateAt(s.card('c').state, [ACTIONS_KEY, 'approve']), { name: 'approve', data: { plan: 'pro', extras: ['a'] }, at: s.now });
  // The next press replaces the last one whole: nothing of the old data is left behind.
  s.apply(ME, { op: 'state.action', card: 'c', name: 'approve' });
  assert.deepEqual(stateAt(s.card('c').state, [ACTIONS_KEY, 'approve']), { name: 'approve', data: null, at: s.now });
  const forPixel = changesFor(s.board, PIXEL.id, 'c');
  assert.deepEqual(
    refs(forPixel.pieces),
    refs([
      { kind: 'title' },
      { kind: 'content' },
      { kind: 'state', path: ['fields', 'name'] },
      { kind: 'state', path: [ACTIONS_KEY, 'approve', 'name'] },
      { kind: 'state', path: [ACTIONS_KEY, 'approve', 'data'] },
      { kind: 'state', path: [ACTIONS_KEY, 'approve', 'at'] },
    ]),
  );
  assert.deepEqual(forPixel.removed.map((t) => t.id).sort(), [statePathKey([ACTIONS_KEY, 'approve', 'data', 'extras']), statePathKey([ACTIONS_KEY, 'approve', 'data', 'plan'])].sort());
  assert.deepEqual(parseStatePath('fields.email'), ['fields', 'email']);
  assert.deepEqual(parseStatePath(''), []);
});

test('comments: threads, replies, edits, resolve and reopen', () => {
  const s = new Sim();
  s.apply(PIXEL, { op: 'card.create', card: 'c', kind: 'html', title: 'Page', content: page() });
  s.apply(ME, { op: 'comment.add', card: 'c', thread: 't1', message: 'm1', anchor: el('hero'), text: 'Too loud' });
  s.apply(PIXEL, { op: 'comment.reply', card: 'c', thread: 't1', message: 'm2', text: 'Toned down' }, { op: 'comment.resolve', card: 'c', thread: 't1' });
  let t = s.card('c').threads[0];
  assert.equal(t.resolved, true);
  assert.deepEqual(
    t.messages.map((m) => [m.id, m.author.kind, m.text]),
    [
      ['m1', 'owner', 'Too loud'],
      ['m2', 'worker', 'Toned down'],
    ],
  );
  const resolvedStamp = t.stamps.resolved;
  s.apply(NIBBLE, { op: 'comment.resolve', card: 'c', thread: 't1' });
  assert.deepEqual(s.card('c').threads[0].stamps.resolved, resolvedStamp, 'resolving a resolved thread changes nothing');
  s.apply(ME, { op: 'comment.reopen', card: 'c', thread: 't1' }, { op: 'comment.edit', card: 'c', thread: 't1', message: 'm1', text: 'Still too loud' });
  t = s.card('c').threads[0];
  assert.equal(t.resolved, false);
  assert.equal(t.messages[0].text, 'Still too loud');
  assert.equal(t.messages[0].author.kind, 'owner');
  assert.equal(t.messages[1].stamp.rev, 3, 'editing one message leaves the other’s stamp');
  assert.match(s.fail(ME, { op: 'comment.reply', card: 'c', thread: 't9', message: 'm3', text: 'x' }).reason, /no comment thread "t9"/);
  assert.match(s.fail(ME, { op: 'comment.reply', card: 'c', thread: 't1', message: 'm3', text: '  ' }).reason, /empty/);
  assert.match(s.fail(ME, { op: 'comment.edit', card: 'c', thread: 't1', message: 'm9', text: 'x' }).reason, /no message "m9"/);
});

test('pictures: their file, box and anchor are separate pieces', () => {
  const s = new Sim();
  s.apply(ME, { op: 'card.create', card: 'k', kind: 'canvas', title: 'Moodboard' }, { op: 'picture.add', card: 'k', id: 'p1', file: png(), anchor: at(0, 0), box: { x: 10, y: 10, w: 400, h: 300 } });
  s.apply(PIXEL, { op: 'picture.move', card: 'k', id: 'p1', box: { w: 200, h: 150 } });
  s.apply(NIBBLE, { op: 'picture.file', card: 'k', id: 'p1', file: png(9000) });
  s.apply(ME, { op: 'picture.reattach', card: 'k', id: 'p1', anchor: at(50, 50) });
  const p = s.card('k').pictures[0];
  assert.deepEqual(p.box, { x: 10, y: 10, w: 200, h: 150 });
  assert.deepEqual([p.stamps.box.rev, p.stamps.file.rev, p.stamps.anchor.rev], [2, 3, 4]);
  s.read(PIXEL, ['k'], 2);
  assert.deepEqual(
    refs(changesFor(s.board, PIXEL.id, 'k').pieces),
    refs([
      { kind: 'picture', id: 'p1', field: 'file' },
      { kind: 'picture', id: 'p1', field: 'anchor' },
    ]),
  );
  s.apply(PIXEL, { op: 'picture.rm', card: 'k', id: 'p1' });
  assert.deepEqual(s.card('k').pictures, []);
  assert.equal(changesFor(s.board, OWNER, 'k').removed[0].kind, 'picture');
});

test('a linked card takes content only from its link, and link status is not a change', () => {
  const s = new Sim();
  s.apply(PIXEL, { op: 'card.create', card: 'c', kind: 'html', title: 'Linked', content: page() }, { op: 'card.link', card: 'c', link: { path: 'docs/plan.html', status: 'ok', author: PIXEL } });
  s.read(ME, ['c']);
  const err = s.fail(PIXEL, { op: 'card.content', card: 'c', content: page(5) });
  assert.match(err.reason, /linked to docs\/plan\.html; edit that file, or unlink the card first/);
  s.apply(PIXEL, { op: 'card.content', card: 'c', content: page(6), viaLink: true });
  assert.equal(s.card('c').stamps.content?.rev, s.board.rev);

  s.read(ME, ['c']);
  s.apply(PIXEL, { op: 'card.link', card: 'c', link: { path: 'docs/plan.html', status: 'broken', reason: 'The file is gone', author: PIXEL } });
  assert.equal(s.card('c').link?.status, 'broken');
  assert.equal(cardChanged(s.board, OWNER, 'c'), false);
  s.apply(PIXEL, { op: 'card.link', card: 'c', link: null }, { op: 'card.content', card: 'c', content: page(7) });
  assert.equal(s.card('c').link, undefined);

  assert.equal(isServerOnly({ op: 'card.link', card: 'c', link: null }), true);
  assert.equal(isServerOnly({ op: 'card.content', card: 'c', content: page(), viaLink: true }), true);
  assert.equal(isServerOnly({ op: 'prune' }), true);
  assert.equal(isServerOnly({ op: 'reader.forget', reader: 'x' }), true);
  assert.equal(isServerOnly({ op: 'card.content', card: 'c', content: page() }), false);
  assert.equal(isServerOnly({ op: 'read', cards: [], rev: 0 }), false);
});

test('the owner’s view of a card is kept, unstamped', () => {
  const s = new Sim();
  s.apply(PIXEL, { op: 'card.create', card: 'c', kind: 'html', title: 'Long', content: page() });
  s.read(PIXEL, ['c']);
  s.apply(ME, { op: 'card.view', card: 'c', view: { x: 0, y: 2400, w: 1280, h: 640 } });
  assert.deepEqual(s.card('c').view, { x: 0, y: 2400, w: 1280, h: 640 });
  assert.equal(cardChanged(s.board, PIXEL.id, 'c'), false);
  s.apply(ME, { op: 'card.view', card: 'c', view: null });
  assert.equal(s.card('c').view, undefined);
  assert.match(s.fail(ME, { op: 'card.view', card: 'c', view: { x: 0, y: 0, w: 0, h: 10 } }).reason, /view\.w/);
});

test('content: relative paths inside the card’s folder, an html entry, and file refs by hash', () => {
  const s = new Sim();
  const ok = page(100, { 'css/site.css': file(50, 'text/css'), 'img/logo.png': png() });
  s.apply(PIXEL, { op: 'card.create', card: 'c', kind: 'html', title: 'Site', content: { ...ok, missing: [{ ref: '../secret.png', reason: 'outside the folder' }] } });
  assert.deepEqual(s.card('c').content?.missing, [{ ref: '../secret.png', reason: 'outside the folder' }]);
  for (const bad of ['/etc/passwd', '../x', 'a/../b', 'a//b', 'C:/x', 'a\\b', './a', '__proto__', '']) assert.equal(isContentPath(bad), false, bad);
  assert.equal(isContentPath('assets/fonts/inter.woff2'), true);

  const withFile = (path: string) => ({ entry: 'index.html', files: { 'index.html': file(10), [path]: file(10, 'text/plain') } });
  assert.match(s.fail(ME, { op: 'card.content', card: 'c', content: withFile('../up.txt') }).reason, /inside the card’s folder|inside the card's folder/);
  assert.match(s.fail(ME, { op: 'card.content', card: 'c', content: { entry: 'main.html', files: { 'index.html': file(10) } } }).reason, /entry/);
  assert.match(s.fail(ME, { op: 'card.content', card: 'c', content: { entry: 'logo.png', files: { 'logo.png': png() } } }).reason, /text\/html/);
  assert.match(s.fail(ME, { op: 'card.content', card: 'c', content: { entry: 'index.html', files: { 'index.html': { hash: 'xyz', size: 1, mime: 'text/html' } } } }).reason, /sha256/);
});

test('limits are enforced, each refusal naming the limit', () => {
  const s = new Sim();
  s.apply(ME, { op: 'card.create', card: 'c', kind: 'html', title: 'Limits', content: page() });

  assert.match(s.fail(ME, { op: 'card.title', card: 'c', title: 'x'.repeat(MAX_TITLE_LENGTH + 1) }).reason, new RegExp(`limit is ${MAX_TITLE_LENGTH}`));
  assert.match(s.fail(ME, { op: 'comment.add', card: 'c', thread: 't', message: 'm', anchor: at(0, 0), text: 'x'.repeat(MAX_COMMENT_LENGTH + 1) }).reason, /limit is 10000/);
  assert.match(s.fail(ME, { op: 'sticky.add', card: 'c', id: 's', anchor: at(0, 0), text: 'x'.repeat(MAX_STICKY_TEXT_LENGTH + 1) }).reason, /limit is 2000/);
  assert.match(s.fail(ME, { op: 'state.set', card: 'c', path: ['big'], value: 'é'.repeat(MAX_STATE_BYTES / 2) }).reason, /state would be .*; the limit is 256 KB/);
  s.apply(ME, { op: 'state.set', card: 'c', path: ['big'], value: 'x'.repeat(MAX_STATE_BYTES - 100) });

  assert.match(s.fail(ME, { op: 'card.content', card: 'c', content: page(MAX_HTML_BYTES + 1) }).reason, /the limit per card is 2 MB/);
  assert.match(s.fail(ME, { op: 'card.content', card: 'c', content: page(10, { 'big.bin': file(MAX_ASSET_BYTES + 1, 'application/octet-stream') }) }).reason, /the limit per file is 10 MB/);
  assert.match(s.fail(ME, { op: 'picture.add', card: 'c', id: 'p', file: png(MAX_ASSET_BYTES + 1), anchor: at(0, 0), box: { w: 50, h: 50 } }).reason, /limit per file is 10 MB/);

  // Per card: content and pictures together, the same file counted once.
  const shared = file(MAX_ASSET_BYTES, 'image/png');
  // Four distinct 10 MB files, one of them twice, and the page: 40 MB and a little.
  const assets: Record<string, FileRef> = {};
  for (let i = 0; i < 3; i++) assets[`a${i}.png`] = file(MAX_ASSET_BYTES, 'image/png');
  assets['shared.png'] = shared;
  assets['again.png'] = shared;
  s.apply(ME, { op: 'card.content', card: 'c', content: page(100, assets) });
  s.apply(ME, { op: 'picture.add', card: 'c', id: 'p0', file: png(MAX_ASSET_BYTES - 1000), anchor: at(0, 0), box: { w: 50, h: 50 } });
  assert.match(s.fail(ME, { op: 'picture.add', card: 'c', id: 'p', file: png(1000), anchor: at(0, 0), box: { w: 50, h: 50 } }).reason, /limit per card is 50 MB/);
  s.apply(ME, { op: 'picture.add', card: 'c', id: 'p', file: shared, anchor: at(0, 0), box: { w: 50, h: 50 } });
  assert.equal(MAX_CARD_BYTES, 5 * MAX_ASSET_BYTES);
});

test('the floor’s storage limit counts each distinct file on the board once', () => {
  const s = new Sim();
  const perCard = Math.floor(MAX_CARD_BYTES / MAX_ASSET_BYTES) - 1;
  const full = () => {
    const files: Record<string, FileRef> = {};
    for (let i = 0; i < perCard; i++) files[`f${i}.bin`] = file(MAX_ASSET_BYTES, 'application/octet-stream');
    return page(100, files);
  };
  const cards = Math.floor(MAX_FLOOR_BYTES / (perCard * MAX_ASSET_BYTES));
  const ops: Op[] = [];
  for (let i = 0; i < cards; i++) ops.push({ op: 'card.create', card: `c${i}`, kind: 'html', title: `Card ${i}`, content: full() });
  s.apply(PIXEL, ...ops);
  const err = s.fail(PIXEL, { op: 'card.create', card: 'over', kind: 'html', title: 'Over', content: full() });
  assert.match(err.reason, /the limit per floor is 1024 MB/);
  // A copy of files already on the board costs nothing more.
  s.apply(PIXEL, { op: 'card.create', card: 'copy', kind: 'html', title: 'Copy', content: s.card('c0').content! });
});

test('the board holds a limited number of cards and marks', () => {
  const s = new Sim();
  const ops: Op[] = [];
  for (let i = 0; i < MAX_CARDS; i++) ops.push({ op: 'card.create', card: `c${i}`, kind: 'canvas', title: `Card ${i}` });
  s.apply(ME, ...ops);
  assert.match(s.fail(ME, { op: 'card.create', card: 'one-more', kind: 'canvas', title: 'x' }).reason, /already has 200 cards, its limit/);

  const stickies: Op[] = [];
  for (let i = 0; i < 300; i++) stickies.push({ op: 'sticky.add', card: 'c0', id: `s${i}`, anchor: at(i, i) });
  s.apply(ME, ...stickies);
  assert.match(s.fail(ME, { op: 'sticky.add', card: 'c0', id: 'x', anchor: at(0, 0) }).reason, /300 stickies, its limit/);
  const tooMany: Op[] = Array.from({ length: 1001 }, () => ({ op: 'card.title', card: 'c1', title: 'x' }));
  assert.match(s.fail(ME, ...tooMany).reason, /at most 1000 operations/);
});

test('UTF-8 lengths count like the bytes on disk', () => {
  assert.equal(utf8Length('abc'), 3);
  assert.equal(utf8Length('é'), 2);
  assert.equal(utf8Length('€'), 3);
  assert.equal(utf8Length('😀'), 4);
});

test('client envelopes carry an epoch and a sequence number', () => {
  const ops: Op[] = [{ op: 'show', selection: { kind: 'grid' } }];
  assert.deepEqual(parseEnvelope({ epoch: 'e1', seq: 3, ops }), { epoch: 'e1', seq: 3, ops });
  assert.equal(typeof parseEnvelope({ epoch: '', seq: 1, ops }), 'string');
  assert.equal(typeof parseEnvelope({ epoch: 'e1', seq: 0, ops }), 'string');
  assert.equal(typeof parseEnvelope({ epoch: 'e1', seq: 1, ops: {} }), 'string');
  assert.equal(typeof parseEnvelope(null), 'string');
});

test('the bridge takes only messages on its channel with the load’s nonce', () => {
  const nonce = 'n0nce-0123456789abcdef';
  assert.equal(nonceFromHash(`#wb=${nonce}`), nonce);
  assert.equal(nonceFromHash(`#x=1&wb=${nonce}`), nonce);
  assert.equal(nonceFromHash('#wb=short'), undefined);

  const write = wrap({ type: 'write', write: { op: 'merge', path: ['fields'], value: { email: 'a@b.c' } } }, nonce);
  assert.equal(write.channel, BRIDGE_CHANNEL);
  assert.deepEqual(parseFrameMsg(write, nonce), { type: 'write', write: { op: 'merge', path: ['fields'], value: { email: 'a@b.c' } } });
  assert.equal(parseFrameMsg(write, 'another-load-nonce-000'), undefined);
  assert.equal(parseFrameMsg({ ...write, channel: 'other' }, nonce), undefined);
  assert.equal(parseFrameMsg(write, ''), undefined);
  assert.equal(parseFrameMsg(wrap({ type: 'write', write: { op: 'del', path: [] } }, nonce), nonce), undefined);
  assert.equal(parseFrameMsg({ ...wrap({ type: 'ready', version: 1 }, nonce), type: 'nope' }, nonce), undefined);

  const positions = wrap({ type: 'positions', req: 4, positions: [{ id: 's1', point: null, detached: true }] }, nonce);
  assert.deepEqual(parseFrameMsg(positions, nonce), { type: 'positions', req: 4, positions: [{ id: 's1', point: null, detached: true }] });
  assert.deepEqual(parseFrameMsg(wrap({ type: 'anchor', req: 1, anchor: el('x') }, nonce), nonce), { type: 'anchor', req: 1, anchor: el('x') });
  assert.equal(parseFrameMsg({ ...wrap({ type: 'anchor', req: 1, anchor: null }, nonce), anchor: { kind: 'element', point: { x: 0, y: 0 }, offset: { x: 0, y: 0 } } }, nonce), undefined);
  assert.deepEqual(parseFrameMsg(wrap({ type: 'layout', width: 1280, height: 4000, scrollX: 0, scrollY: 20 }, nonce), nonce), { type: 'layout', width: 1280, height: 4000, scrollX: 0, scrollY: 20 });
  assert.deepEqual(parseFrameMsg(wrap({ type: 'action', name: 'approve', data: { a: 1 } }, nonce), nonce), { type: 'action', name: 'approve', data: { a: 1 } });

  const init = wrap({ type: 'init', card: { id: 'c', title: 'T', author: PIXEL }, state: {}, rendering: false, mode: 'use', width: CANONICAL_WIDTH }, nonce);
  assert.equal(parseHostMsg(init, nonce)?.type, 'init');
  assert.equal(parseHostMsg({ ...init, mode: 'draw' }, nonce), undefined);
  assert.deepEqual(parseHostMsg(wrap({ type: 'state', state: { a: 1 }, changes: [{ path: ['a'], author: PIXEL }] }, nonce), nonce), { type: 'state', state: { a: 1 }, changes: [{ path: ['a'], author: PIXEL }] });
  assert.deepEqual(parseHostMsg(wrap({ type: 'anchorAt', req: 2, point: { x: 3, y: 4 } }, nonce), nonce), { type: 'anchorAt', req: 2, point: { x: 3, y: 4 } });
  assert.equal(parseHostMsg(wrap({ type: 'locate', req: 3, anchors: [{ id: 's1', anchor: at(1, 2) }] }, nonce), nonce)?.type, 'locate');
  assert.deepEqual(parseHostMsg(wrap({ type: 'mode', mode: 'markup' }, nonce), nonce), { type: 'mode', mode: 'markup' });
  assert.deepEqual(parseHostMsg(wrap({ type: 'scrollTo', x: 0, y: 100 }, nonce), nonce), { type: 'scrollTo', x: 0, y: 100 });
  assert.equal(parseHostMsg(wrap({ type: 'mode', mode: 'markup' }, nonce), 'wrong-nonce-0000000000'), undefined);

  // Focus: a field by its key (or another element by its path), its caret, its unsaved value; only keys it knows.
  const typing = { key: 'email', index: 0, start: 3, end: 5, direction: 'backward' as const, value: 'hello', composing: false };
  assert.deepEqual(parseFrameMsg(wrap({ type: 'focus', field: typing }, nonce), nonce), { type: 'focus', field: typing });
  assert.deepEqual(parseFrameMsg(wrap({ type: 'focus', field: null }, nonce), nonce), { type: 'focus', field: null });
  assert.deepEqual(parseFrameMsg({ ...wrap({ type: 'focus', field: { selector: 'body > button:nth-of-type(1)' } }, nonce), extra: 1 }, nonce), { type: 'focus', field: { selector: 'body > button:nth-of-type(1)' } });
  assert.deepEqual(parseFrameMsg(wrap({ type: 'focus', field: { key: 'a', sneaky: 'x' } as never }, nonce), nonce), { type: 'focus', field: { key: 'a' } });
  for (const bad of [
    {},
    { key: 'a', selector: 'b' },
    { key: '' },
    { key: 'a', index: -1 },
    { key: 'a', start: 1.5 },
    { key: 'a', direction: 'up' },
    { key: 'a', value: 7 },
    { key: 'a', value: 'x'.repeat(MAX_FOCUS_VALUE + 1) },
    { key: 'a', composing: 'yes' },
    'email',
  ]) {
    assert.equal(parseFrameMsg(wrap({ type: 'focus', field: bad as never }, nonce), nonce), undefined, JSON.stringify(bad).slice(0, 60));
  }
  assert.deepEqual(parseHostMsg(wrap({ type: 'focus', field: { key: 'email', start: 3, end: 3 } }, nonce), nonce), { type: 'focus', field: { key: 'email', start: 3, end: 3 } });
  assert.equal(parseHostMsg(wrap({ type: 'focus', field: null as never }, nonce), nonce), undefined, 'the host always names what to focus');
  // Esc, passed on from the frame.
  assert.deepEqual(parseFrameMsg(wrap({ type: 'escape' }, nonce), nonce), { type: 'escape' });
  assert.equal(parseFrameMsg(wrap({ type: 'escape' }, nonce), 'another-load-nonce-000'), undefined);
});

test('a frame’s writes and actions become state operations on its own card', () => {
  const s = new Sim();
  s.apply(PIXEL, { op: 'card.create', card: 'c', kind: 'html', title: 'Form', content: page() });
  s.apply(
    ME,
    writeOp('c', { op: 'set', path: ['fields', 'email'], value: 'a@b.c' }),
    writeOp('c', { op: 'merge', path: [], value: { board: { columns: ['todo'] } } }),
    writeOp('c', { op: 'del', path: ['fields', 'email'] }),
    actionOp('c', 'approve'),
    actionOp('c', 'pick', 'blue'),
  );
  assert.deepEqual(s.card('c').state, {
    fields: {},
    board: { columns: ['todo'] },
    actions: { approve: { name: 'approve', data: null, at: s.now }, pick: { name: 'pick', data: 'blue', at: s.now } },
  });
});
