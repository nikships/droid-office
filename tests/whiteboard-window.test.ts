import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { CANONICAL_WIDTH, OWNER_AUTHOR, applyOps, emptyBoard, type Author, type Board, type Op } from '../src/shared/whiteboard.js';
import { canvasBounds, changesSince, dragBox, dragMarkOps, pictureSize, placeMarks, reattachMarkOps } from '../src/shared/whiteboard-marks.js';
import { forgeWords } from '../src/shared/floors.js';
import { folderFiles, mimeFor, pingRows, pingTask, pingWhere, pingedText } from '../src/client/ui/whiteboard-picker.js';
import {
  CANVAS_MARGIN,
  ZOOM_MAX,
  ZOOM_MIN,
  artifactCardView,
  artifactFromCardView,
  artifactLayout,
  authorName,
  canvasCardView,
  canvasFit,
  canvasFromCardView,
  changedCount,
  clampZoom,
  copyForAgent,
  deleteConfirmText,
  deleteOps,
  fitZoom,
  newId,
  ownerReadPoint,
  selectedOnBoard,
  stepZoom,
  viewMoved,
  wheelNavigation,
  zoomArtifact,
  zoomCanvas,
  zoomLabel,
} from '../src/client/ui/whiteboard-view.js';

const PIXEL: Author = { kind: 'worker', id: 'w1', name: 'Pixel', color: '#ff00aa' };
const BOLT: Author = { kind: 'worker', id: 'w2', name: 'Bolt', color: '#00aaff' };
const PAGE = { entry: 'index.html', files: { 'index.html': { hash: 'a'.repeat(64), size: 10, mime: 'text/html' } } };
const PAGE2 = { entry: 'index.html', files: { 'index.html': { hash: 'b'.repeat(64), size: 12, mime: 'text/html' } } };

/** Applies batches in turn, each by its author at the next revision. */
function play(...steps: [Author, Op[]][]): Board {
  let b = emptyBoard();
  for (const [who, ops] of steps) {
    const r = applyOps(b, ops, who, b.rev + 1, 1000 + b.rev);
    if (!r.ok) throw new Error(r.error.message);
    b = r.board;
  }
  return b;
}

test('zoom: clamps, steps between the stops, and labels', () => {
  assert.equal(clampZoom(0.01), ZOOM_MIN);
  assert.equal(clampZoom(99), ZOOM_MAX);
  assert.equal(clampZoom(Number.NaN), 1);
  assert.equal(stepZoom(1, 1), 1.25);
  assert.equal(stepZoom(1, -1), 0.9);
  assert.equal(stepZoom(0.8, 1), 0.9);
  assert.equal(stepZoom(0.8, -1), 0.75);
  assert.equal(stepZoom(ZOOM_MAX, 1), ZOOM_MAX);
  assert.equal(stepZoom(ZOOM_MIN, -1), ZOOM_MIN);
  assert.equal(zoomLabel(0.666), '67%');
  assert.equal(fitZoom(640), 0.5);
  assert.equal(fitZoom(0), 1);
});

test('navigation: pixel, line, page, Shift and pinch deltas retain device-space motion', () => {
  assert.deepEqual(wheelNavigation(12.5, 30.25, 0, false, false, 600), { x: 12.5, y: 30.25, factor: 1 });
  assert.deepEqual(wheelNavigation(0, 3, 1, true, false, 600), { x: 48, y: 0, factor: 1 });
  assert.deepEqual(wheelNavigation(1, -1, 2, false, false, 600), { x: 600, y: -600, factor: 1 });
  assert.deepEqual(wheelNavigation(2, 3, 0, true, false, 600), { x: 2, y: 3, factor: 1 });
  const pinch = wheelNavigation(0, -5, 0, false, true, 600);
  assert.ok(pinch.factor > 1 && pinch.factor < 1.1);
  assert.equal(pinch.x, 0);
  assert.equal(pinch.y, 0);
  assert.ok(Math.abs(wheelNavigation(0, 5, 0, false, true, 600).factor - 1 / pinch.factor) < 1e-12);
  assert.ok(Number.isFinite(wheelNavigation(0, -100000, 0, false, true, 600).factor));
});

test('artifact: fractional zoom and pan never snap the pointer to rounded screen pixels', () => {
  const vp = { w: 853, h: 571 };
  let view = { zoom: fitZoom(vp.w), panX: 0, scrollY: 450.25 };
  const at = { x: 337.4, y: 279.2 };
  const pageX = at.x / view.zoom;
  const pageY = view.scrollY + at.y / view.zoom;
  for (let i = 0; i < 80; i++) {
    view = zoomArtifact(view, vp, view.zoom * 1.007, at);
    const lay = artifactLayout(vp, view.zoom, view.panX);
    assert.ok(Math.abs((at.x - lay.left) / view.zoom - pageX) < 1e-8);
    assert.ok(Math.abs(view.scrollY + at.y / view.zoom - pageY) < 1e-8);
  }
});

test('artifact: Fit centres the page and makes the frame as tall as the window in page px', () => {
  const vp = { w: 960, h: 600 };
  const z = fitZoom(vp.w);
  assert.equal(z, 0.75);
  const lay = artifactLayout(vp, z, 300);
  assert.equal(lay.left, 0);
  assert.equal(lay.panX, 0, 'no pan when the whole width shows');
  assert.equal(lay.frameH, 800);
  // Narrower than the window: centred.
  const small = artifactLayout(vp, 0.5, 0);
  assert.equal(small.left, Math.round((960 - 640) / 2));
});

test('artifact: at 100% the page pans sideways within its width', () => {
  const vp = { w: 960, h: 600 };
  const lay = artifactLayout(vp, 1, 1000);
  assert.equal(lay.panX, CANONICAL_WIDTH - 960, 'clamped to the right edge');
  assert.equal(lay.left, -(CANONICAL_WIDTH - 960));
  assert.equal(artifactLayout(vp, 1, -50).panX, 0);
  assert.equal(lay.frameH, 600);
});

test('artifact: zooming keeps the point under the pointer still', () => {
  const vp = { w: 960, h: 600 };
  const v = { zoom: 0.75, panX: 0, scrollY: 400 };
  const at = { x: 480, y: 300 };
  const pageY = v.scrollY + at.y / v.zoom;
  const next = zoomArtifact(v, vp, 1.5, at);
  assert.equal(next.zoom, 1.5);
  assert.ok(Math.abs(next.scrollY + at.y / next.zoom - pageY) < 1e-9);
  const lay = artifactLayout(vp, next.zoom, next.panX);
  assert.ok(Math.abs((at.x - lay.left) / next.zoom - 640) < 1, 'the page middle stays under the pointer');
  assert.equal(zoomArtifact({ zoom: 1, panX: 0, scrollY: 0 }, vp, 0.5, { x: 0, y: 0 }).scrollY, 0, 'never above the top');
});

test('artifact: the CardView is the region in view, and opening from it gives that view back', () => {
  const vp = { w: 960, h: 600 };
  const fit = artifactCardView(vp, { zoom: 0.75, panX: 0, scrollY: 1200 });
  assert.deepEqual(fit, { x: 0, y: 1200, w: CANONICAL_WIDTH, h: 800 });
  assert.deepEqual(artifactCardView(vp, { zoom: 0.75, panX: 0, scrollY: 5000 }, 3000), { x: 0, y: 2200, w: CANONICAL_WIDTH, h: 800 }, 'clamped to the page');
  const back = artifactFromCardView(vp, fit);
  assert.deepEqual(back.mode, { fit: true });
  assert.equal(back.view.scrollY, 1200);
  const actual = artifactCardView(vp, { zoom: 1, panX: 200, scrollY: 50 });
  assert.deepEqual(actual, { x: 200, y: 50, w: 960, h: 600 });
  const again = artifactFromCardView(vp, actual);
  assert.deepEqual(again.mode, { fit: false, zoom: 1 });
  assert.deepEqual(again.view, { zoom: 1, panX: 200, scrollY: 50 });
});

test('canvas: bounds round the marks, fit, zoom about a point, and its CardView', () => {
  const anchor = (x: number, y: number) => ({ kind: 'point' as const, point: { x, y } });
  const blank = canvasBounds({ threads: [], stickies: [], pictures: [] }, CANVAS_MARGIN);
  assert.deepEqual(blank, { x: 0, y: 0, w: CANONICAL_WIDTH, h: 720 });
  const card = {
    threads: [{ id: 't', anchor: anchor(-100, 50), resolved: false, messages: [], stamps: {} as never }],
    stickies: [{ id: 's', text: '', color: 'yellow', anchor: anchor(400, 300), box: { x: 10, y: 10, w: 200, h: 160 }, stamps: {} as never }],
    pictures: [],
  };
  const b = canvasBounds(card, 0);
  assert.deepEqual(b, { x: -100, y: 50, w: 710, h: 420 });
  // The window's fit margin is 80. The renderer passes 48 into the same bounds; it is not this number.
  assert.deepEqual(canvasBounds(card, CANVAS_MARGIN), { x: -180, y: -30, w: 870, h: 580 });
  const placed = placeMarks(card);
  assert.deepEqual(
    placed.map((m) => [m.kind, m.x, m.y, m.w, m.h]),
    [
      ['sticky', 410, 310, 200, 160],
      ['thread', -100, 50, 1, 1],
    ],
  );
  assert.equal(placeMarks(card, undefined, 28).find((m) => m.kind === 'thread')?.x, -114);
  const vp = { w: 800, h: 600 };
  const fit = canvasFit({ x: 0, y: 0, w: 1600, h: 600 }, vp);
  assert.equal(fit.zoom, 0.5);
  assert.equal(fit.x, 0);
  assert.equal(fit.y, -300, 'centred vertically');
  assert.equal(canvasFit({ x: 0, y: 0, w: 100, h: 100 }, vp).zoom, 1, 'never past 100%');
  const z = zoomCanvas({ zoom: 1, x: 0, y: 0 }, 2, { x: 100, y: 100 });
  assert.deepEqual(z, { zoom: 2, x: 50, y: 50 });
  const cv = canvasCardView(vp, { zoom: 2, x: 50, y: 50 });
  assert.deepEqual(cv, { x: 50, y: 50, w: 400, h: 300 });
  assert.deepEqual(canvasFromCardView(vp, cv), { zoom: 2, x: 50, y: 50 });
});

test('views: small moves are not worth sending', () => {
  assert.equal(viewMoved(undefined, { x: 0, y: 0, w: 1, h: 1 }), true);
  assert.equal(viewMoved({ x: 0, y: 100, w: 1280, h: 800 }, { x: 1, y: 101, w: 1280, h: 800 }), false);
  assert.equal(viewMoved({ x: 0, y: 100, w: 1280, h: 800 }, { x: 0, y: 140, w: 1280, h: 800 }), true);
});

test('a drag becomes a sticky box; a short one gets the default size', () => {
  assert.deepEqual(dragBox({ x: 300, y: 300 }, { x: 100, y: 200 }, { w: 200, h: 160 }), { x: 100, y: 200, w: 200, h: 100 });
  assert.deepEqual(dragBox({ x: 10, y: 10 }, { x: 20, y: 15 }, { w: 200, h: 160 }), { x: 10, y: 10, w: 200, h: 160 });
  assert.deepEqual(dragBox({ x: 0, y: 0 }, { x: 100, y: 5 }, { w: 200, h: 160 }), { x: 0, y: 0, w: 100, h: 40 }, 'at least the minimum');
  assert.deepEqual(pictureSize({ w: 1920, h: 1080 }), { w: 480, h: 270 });
  assert.deepEqual(pictureSize({ w: 100, h: 50 }), { w: 100, h: 50 });
  assert.deepEqual(dragMarkOps({ card: 'c', kind: 'sticky', id: 's', what: 'resize', box: { x: 1, y: 2, w: 100, h: 80 }, dx: 10.2, dy: -100 }), [{ op: 'sticky.move', card: 'c', id: 's', box: { w: 110, h: 40 } }]);
  assert.deepEqual(dragMarkOps({ card: 'c', kind: 'picture', id: 'p', what: 'move', box: { x: 5, y: 6, w: 10, h: 10 }, dx: 1.2, dy: 2.8 }), [{ op: 'picture.move', card: 'c', id: 'p', box: { x: 6, y: 9 } }]);
  const anchor = { kind: 'element' as const, selector: '#a', offset: { x: 0, y: 0 }, point: { x: 3, y: 4 } };
  assert.deepEqual(dragMarkOps({ card: 'c', kind: 'sticky', id: 's', what: 'move', box: { x: 2, y: 0, w: 10, h: 10 }, dx: 0, dy: 0, anchor }), [
    { op: 'sticky.reattach', card: 'c', id: 's', anchor },
    { op: 'sticky.move', card: 'c', id: 's', box: { x: 0, y: 0 } },
  ]);
  assert.deepEqual(reattachMarkOps({ card: 'c', kind: 'thread', id: 't', anchor }), [{ op: 'comment.reattach', card: 'c', thread: 't', anchor }]);
});

test('changed since you looked: one line per thing someone else did, newest first', () => {
  const b0 = play([PIXEL, [{ op: 'card.create', card: 'c1', kind: 'html', title: 'Plan', content: PAGE }]], [OWNER_AUTHOR, [{ op: 'sticky.add', card: 'c1', id: 's1', anchor: { kind: 'point', point: { x: 0, y: 0 } }, text: 'mine' }]]);
  // Never opened: the card is the news.
  const first = changesSince(b0, 'c1', ownerReadPoint(b0, 'c1'));
  assert.deepEqual(
    first.map((c) => c.text),
    ['Put this card up'],
  );
  assert.equal(authorName(first[0].author), 'Pixel');
  const opened = b0.rev;
  const b = play(
    [PIXEL, [{ op: 'card.create', card: 'c1', kind: 'html', title: 'Plan', content: PAGE }]],
    [OWNER_AUTHOR, [{ op: 'sticky.add', card: 'c1', id: 's1', anchor: { kind: 'point', point: { x: 0, y: 0 } }, text: 'mine' }]],
    [PIXEL, [{ op: 'card.title', card: 'c1', title: 'Plan v2' }]],
    [PIXEL, [{ op: 'card.content', card: 'c1', content: PAGE2 }]],
    [BOLT, [{ op: 'comment.add', card: 'c1', thread: 't1', message: 'm1', anchor: { kind: 'point', point: { x: 5, y: 5 } }, text: 'Looks good' }]],
    [PIXEL, [{ op: 'comment.reply', card: 'c1', thread: 't1', message: 'm2', text: 'Thanks' }]],
    [BOLT, [{ op: 'sticky.edit', card: 'c1', id: 's1', text: 'edited by bolt' }]],
    [PIXEL, [{ op: 'sticky.add', card: 'c1', id: 's2', anchor: { kind: 'point', point: { x: 9, y: 9 } }, text: 'new' }]],
    [PIXEL, [{ op: 'state.merge', card: 'c1', path: ['fields'], value: { a: 1, b: 2 } }]],
    [OWNER_AUTHOR, [{ op: 'comment.add', card: 'c1', thread: 't2', message: 'm3', anchor: { kind: 'point', point: { x: 1, y: 1 } }, text: 'mine too' }]],
    [BOLT, [{ op: 'comment.rm', card: 'c1', thread: 't2' }]],
  );
  const items = changesSince(b, 'c1', opened);
  assert.deepEqual(
    items.map((c) => c.text),
    ['Removed a comment thread', 'Set 2 values: fields.a, fields.b', 'Added a sticky: “new”', 'Edited a sticky: “edited by bolt”', 'Replied: “Thanks”', 'Commented: “Looks good”', 'Changed the page', 'Renamed it to “Plan v2”'],
  );
  assert.deepEqual(items.find((c) => c.verb === 'replied')?.mark, { kind: 'thread', id: 't1' });
  assert.equal(items.find((c) => c.verb === 'edited')?.author.kind, 'worker');
  // Nothing new since the board as it is now.
  assert.deepEqual(changesSince(b, 'c1', b.rev), []);
  assert.deepEqual(changesSince(b, 'nope', 0), []);
});

test('changed since you looked: resolve, reopen, a moved pin, a picture, and the menu count', () => {
  const pic = { hash: 'c'.repeat(64), size: 5, mime: 'image/png' };
  const base = play(
    [PIXEL, [{ op: 'card.create', card: 'c1', kind: 'canvas', title: 'Board' }]],
    [OWNER_AUTHOR, [{ op: 'comment.add', card: 'c1', thread: 't1', message: 'm1', anchor: { kind: 'point', point: { x: 5, y: 5 } }, text: 'q' }]],
    [OWNER_AUTHOR, [{ op: 'picture.add', card: 'c1', id: 'p1', file: pic, anchor: { kind: 'point', point: { x: 0, y: 0 } }, box: { w: 100, h: 100 } }]],
  );
  const opened = base.rev;
  const b = play(
    [PIXEL, [{ op: 'card.create', card: 'c1', kind: 'canvas', title: 'Board' }]],
    [OWNER_AUTHOR, [{ op: 'comment.add', card: 'c1', thread: 't1', message: 'm1', anchor: { kind: 'point', point: { x: 5, y: 5 } }, text: 'q' }]],
    [OWNER_AUTHOR, [{ op: 'picture.add', card: 'c1', id: 'p1', file: pic, anchor: { kind: 'point', point: { x: 0, y: 0 } }, box: { w: 100, h: 100 } }]],
    [PIXEL, [{ op: 'comment.resolve', card: 'c1', thread: 't1' }]],
    [PIXEL, [{ op: 'comment.reattach', card: 'c1', thread: 't1', anchor: { kind: 'point', point: { x: 50, y: 50 } } }]],
    [BOLT, [{ op: 'picture.move', card: 'c1', id: 'p1', box: { x: 20 } }]],
    [BOLT, [{ op: 'picture.add', card: 'c1', id: 'p2', file: pic, anchor: { kind: 'point', point: { x: 0, y: 0 } }, box: { w: 50, h: 50 } }]],
    [PIXEL, [{ op: 'card.create', card: 'c2', kind: 'canvas', title: 'Other' }]],
  );
  assert.deepEqual(
    changesSince(b, 'c1', opened).map((c) => c.verb),
    ['added', 'moved', 'moved-pin', 'resolved'],
  );
  assert.equal(changedCount(b), 2, 'both cards are news to the owner');
  const read = applyOps(b, [{ op: 'read', cards: ['c1'], rev: b.rev }], OWNER_AUTHOR, b.rev + 1, 5000);
  assert.ok(read.ok);
  assert.equal(changedCount(read.board), 1);
  assert.equal(changedCount(null), 0);
});

function worker(over: Partial<WorkerInfo>): WorkerInfo {
  return { id: 'w', kind: 'agent', deskId: 'd1', name: 'W', color: '#fff', status: 'idle', acked: true, createdBy: 'me', createdAt: 0, cols: 80, rows: 24, open: false, ...over } as WorkerInfo;
}

test('ping picker: eligibility and why for each worker, the ones that can first', () => {
  const labels = { idle: 'ready', working: 'working', needs_input: 'needs input', starting: 'starting', offline: 'asleep', done: 'done', exited: 'exited' };
  const rows = pingRows(
    [
      worker({ id: 'g', name: 'Guest', guest: true }),
      worker({ id: 'n', name: 'Nibble', status: 'needs_input' }),
      worker({ id: 'z', name: 'Zed', status: 'idle' }),
      worker({ id: 'a', name: 'Ada', status: 'offline' }),
      worker({ id: 'q', name: 'Queue', status: 'working' }),
      worker({ id: 'b', name: 'Busy', status: 'working', kind: 'claude' as WorkerInfo['kind'] }),
      worker({ id: 's', name: 'Shell', kind: 'shell' }),
      worker({ id: 'c', name: 'Cloud', kind: 'cloud' }),
    ],
    labels,
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ['a', 'q', 'z', 'b', 'c', 'g', 'n', 's'],
  );
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.z.how, 'type');
  assert.equal(by.a.how, 'resume');
  assert.equal(by.a.status, 'asleep');
  assert.equal(by.q.how, 'queue');
  assert.equal(by.b.ok, false);
  assert.equal(by.b.busy, true);
  assert.equal(by.g.guest, true);
  assert.equal(by.g.status, 'guest');
  assert.match(by.g.note, /Bring it in/);
  assert.match(by.n.note, /waiting on an answer/);
  assert.match(by.z.note, /Types the line/);
  assert.equal(by.z.task, undefined);
  assert.equal(by.z.where, undefined);
  assert.equal(pingedText('Zed', 'queue'), 'Queued for Zed after its turn');
  assert.equal(pingedText('Zed', 'resume'), 'Woke Zed up with it');
  assert.equal(pingedText('Zed', 'type'), "Typed it into Zed's terminal");
});

test('ping picker: each row says what the worker is on and where', () => {
  const labels = { idle: 'ready', starting: 'starting' };
  const worktree = { path: '.droid-office/worktrees/byte', branch: 'office/byte-1', base: 'abc' };
  const rows = pingRows(
    [
      worker({ id: 'b', name: 'Byte', task: { name: 'Fix login redirect', summary: 'Editing auth.ts' }, prompt: 'ignored', worktree: { ...worktree, made: 'fix-login' }, pr: { number: 12, url: 'u' } }),
      worker({ id: 'd', name: 'Dot', prompt: `\n  Add a dark mode toggle to the settings window ${'and more '.repeat(20)}\nsecond line`, worktree }),
      worker({ id: 's', name: 'Sprocket', status: 'starting' }),
    ],
    labels,
    forgeWords('gitlab'),
  );
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.b.task, 'Fix login redirect');
  assert.equal(by.b.where, 'fix-login · MR !12');
  assert.match(by.d.task ?? '', /^Add a dark mode toggle to the settings window and more/);
  assert.ok((by.d.task ?? '').endsWith('…'));
  assert.ok((by.d.task ?? '').length <= 80);
  assert.equal(by.d.where, 'office/byte-1');
  assert.equal(by.s.task, undefined);
  assert.equal(by.s.where, undefined);
  assert.equal(by.s.ok, false);
  assert.equal(pingWhere(worker({ pr: { number: 7, url: 'u' } })), 'PR #7');
  assert.equal(pingTask(worker({ prompt: 'short' })), 'short');
});

test('Copy for agent: one line with the id, the title and the read command', () => {
  const line = copyForAgent({ id: 'c-1a2b', title: '  Pricing\n draft ', kind: 'html' });
  assert.equal(line, 'Whiteboard card c-1a2b “Pricing draft” (artifact): run `office-whiteboard read c-1a2b` to see it with my marks.');
  assert.ok(!line.includes('\n'));
  assert.match(copyForAgent({ id: 'c-9', title: 'Sketch', kind: 'canvas' }), /\(canvas\)/);
});

test('ids, media types and folder uploads', () => {
  let i = 0;
  const id = newId('s', () => (i++ % 36) / 36);
  assert.equal(id, 's-abcdefghij');
  assert.match(newId('c'), /^c-[a-z0-9]{10}$/);
  assert.equal(mimeFor('a/b/app.MJS'), 'text/javascript; charset=utf-8');
  assert.equal(mimeFor('x.woff2'), 'font/woff2');
  assert.equal(mimeFor('data.bin', 'application/x-thing'), 'application/x-thing');
  assert.equal(mimeFor('noext'), 'application/octet-stream');
  const got = folderFiles([{ path: 'site/index.html' }, { path: 'site/css/a.css' }, { path: 'site/.git/HEAD' }, { path: 'site/node_modules/x/i.js' }, { path: 'site/.DS_Store' }, { path: 'site/pages/about.html' }]);
  assert.deepEqual(
    got.files.map((f) => f.rel),
    ['index.html', 'css/a.css', 'pages/about.html'],
  );
  assert.equal(got.entry, 'index.html');
  assert.equal(got.skipped, 3);
  assert.equal(folderFiles([{ path: 'x/b/deep.html' }, { path: 'x/top.html' }]).entry, 'top.html');
  assert.equal(folderFiles([{ path: 'x/a.css' }]).entry, undefined);
});

test('selecting: only cards still on the board, newest first, deleted in one batch', () => {
  const b = play(
    [PIXEL, [{ op: 'card.create', card: 'a', kind: 'canvas', title: 'A' }]],
    [OWNER_AUTHOR, [{ op: 'card.create', card: 'b', kind: 'canvas', title: 'B' }]],
    [BOLT, [{ op: 'card.create', card: 'c', kind: 'canvas', title: 'C' }]],
  );
  assert.deepEqual(selectedOnBoard(b, new Set(['a', 'c', 'gone'])), ['c', 'a']);
  assert.deepEqual(selectedOnBoard(b, new Set()), []);
  const ops = deleteOps(selectedOnBoard(b, new Set(['a', 'c'])));
  assert.deepEqual(ops, [
    { op: 'card.rm', card: 'c' },
    { op: 'card.rm', card: 'a' },
  ]);
  const r = applyOps(b, ops, OWNER_AUTHOR, b.rev + 1, 5000);
  assert.ok(r.ok);
  if (r.ok)
    assert.deepEqual(
      r.board.cards.map((c) => c.id),
      ['b'],
    );
});

test('selecting: the delete confirm names one card, or lists several with the rest counted', () => {
  const one = deleteConfirmText(['Plan']);
  assert.equal(one.title, 'Delete this card?');
  assert.match(one.lead, /“Plan” goes from the board/);
  assert.deepEqual(one.more, []);
  const many = deleteConfirmText(['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(many.title, 'Delete 7 cards?');
  assert.match(many.lead, /These 7 cards/);
  assert.deepEqual(many.more, ['“1”', '“2”', '“3”', '“4”', '“5”', 'and 2 more']);
});
