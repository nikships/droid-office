import test from 'node:test';
import assert from 'node:assert/strict';
import { OWNER, OWNER_AUTHOR, applyOps, emptyBoard, type Author, type Board, type Op } from '../src/shared/whiteboard.js';
import {
  GRID_MAX,
  MIN_REGION_W,
  OWNER_COLOR,
  WALL_H,
  WALL_W,
  agoText,
  authorLabel,
  fitText,
  gridSummary,
  gridTiles,
  placeholderNote,
  renderLine,
  thumbRect,
  tileDraws,
  tileGrid,
  viewOnImage,
  tileNote,
  wallRegion,
  wallView,
  wrapText,
} from '../src/client/world/whiteboard-wall.js';

const PIXEL: Author = { kind: 'worker', id: 'w1', name: 'Pixel', color: '#4fb3ff' };

function board(ops: Op[], actor: Author = PIXEL, start: Board = emptyBoard()): Board {
  const r = applyOps(start, ops, actor, start.rev + 1, 1_000);
  assert.ok(r.ok, r.ok ? '' : r.error.message);
  return r.board;
}

const cards = (n: number): Op[] => Array.from({ length: n }, (_, i) => ({ op: 'card.create', card: `c${i}`, kind: 'canvas', title: `Card ${i}` }) as Op);

test('the wall follows the selection, and a selection whose card is gone is the grid', () => {
  const b = board(cards(2));
  assert.deepEqual(wallView(b), { kind: 'grid' });
  const shown = board([{ op: 'show', selection: { kind: 'card', id: 'c1' } }], PIXEL, b);
  const v = wallView(shown);
  assert.equal(v.kind, 'card');
  assert.equal(v.kind === 'card' && v.card.id, 'c1');
  // The reducer resets it on delete; a stale one still reads as the grid.
  assert.deepEqual(wallView({ ...shown, selection: { kind: 'card', id: 'gone' } }), { kind: 'grid' });
  const deleted = board([{ op: 'card.rm', card: 'c1' }], OWNER_AUTHOR, shown);
  assert.deepEqual(deleted.selection, { kind: 'grid' });
  assert.deepEqual(wallView(deleted), { kind: 'grid' });
});

test('the grid shows up to six cards in 3×2, and five and a +N past that', () => {
  assert.deepEqual(gridTiles([]), []);
  const four = gridTiles(['a', 'b', 'c', 'd']);
  assert.deepEqual(
    four.map((t) => t.kind === 'card' && t.card),
    ['a', 'b', 'c', 'd'],
  );
  const six = gridTiles(['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(six.length, GRID_MAX);
  assert.ok(
    six.every((t) => t.kind === 'card'),
    'exactly six fit without a +N',
  );
  const nine = gridTiles(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  assert.equal(nine.length, GRID_MAX);
  assert.deepEqual(
    nine.slice(0, 5).map((t) => t.kind === 'card' && t.card),
    ['a', 'b', 'c', 'd', 'e'],
  );
  assert.deepEqual({ kind: nine[5].kind, count: nine[5].kind === 'more' && nine[5].count }, { kind: 'more', count: 4 });
  // Three columns, two rows, inside the wall, none overlapping.
  const rects = six.map((t) => t.rect);
  assert.equal(new Set(rects.map((r) => r.x)).size, 3);
  assert.equal(new Set(rects.map((r) => r.y)).size, 2);
  for (const r of rects) {
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= WALL_W && r.y + r.h <= WALL_H, JSON.stringify(r));
    const t = thumbRect(r);
    assert.ok(t.h > r.h / 2, 'the thumbnail is most of the tile');
  }
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${i} and ${j} overlap`);
    }
});

test('without a view, the wall shows the top of the page across its width', () => {
  assert.deepEqual(wallRegion(undefined, { width: 1280, height: 5000 }), { x: 0, y: 0, w: 1280, h: 640 });
  // A short page: the region still starts at its top.
  assert.deepEqual(wallRegion(undefined, { width: 1280, height: 300 }), { x: 0, y: 0, w: 1280, h: 640 });
});

test("the owner's last view is grown or cut to the wall's 2:1 and slid onto the page", () => {
  const page = { width: 1280, height: 8000 };
  // A 16:9 window far down a long page: all of it, widened around its middle.
  const r = wallRegion({ x: 200, y: 6000, w: 800, h: 450 }, page);
  assert.deepEqual(r, { x: 150, y: 6000, w: 900, h: 450 });
  // Wider than 2:1: grown in height around its middle.
  assert.deepEqual(wallRegion({ x: 0, y: 1000, w: 1280, h: 400 }, page), { x: 0, y: 880, w: 1280, h: 640 });
  // Taller than wide: cut to 2:1 from its top, so it stays readable.
  assert.deepEqual(wallRegion({ x: 100, y: 2000, w: 400, h: 900 }, page), { x: 100, y: 2000, w: 400, h: 200 });
  // Zoomed in further than MIN_REGION_W: widened to it around the middle.
  const tiny = wallRegion({ x: 500, y: 500, w: 100, h: 50 }, page);
  assert.equal(tiny.w, MIN_REGION_W);
  assert.equal(tiny.h, MIN_REGION_W / 2);
  assert.equal(tiny.x + tiny.w / 2, 550);
  assert.equal(tiny.y + tiny.h / 2, 525);
  // Past the bottom or the side: slid back onto the page.
  assert.deepEqual(wallRegion({ x: 900, y: 7900, w: 800, h: 400 }, page), { x: 480, y: 7600, w: 800, h: 400 });
  assert.deepEqual(wallRegion({ x: -50, y: -20, w: 800, h: 400 }, page), { x: 0, y: 0, w: 800, h: 400 });
  // The whole page width in a 16:9 window: growing it would only add margins, so it is cut from its top.
  assert.deepEqual(wallRegion({ x: 0, y: 4800, w: 1280, h: 720 }, page), { x: 0, y: 4800, w: 1280, h: 640 });
  // Zoomed out past the page's width (a canvas card, say): centered on it.
  const wide = wallRegion({ x: -400, y: 0, w: 2000, h: 1100 }, page);
  assert.equal(wide.w, 2200);
  assert.equal(wide.x, -460);
  // Every region is the wall's shape.
  for (const v of [undefined, { x: 3, y: 4, w: 777, h: 333 }, { x: 0, y: 0, w: 50, h: 900 }]) {
    const k = wallRegion(v, page);
    assert.ok(Math.abs(k.w / k.h - 2) < 1e-9, JSON.stringify(k));
  }
  // A view with no size is no view.
  assert.deepEqual(wallRegion({ x: 10, y: 4000, w: 0, h: 0 }, page), { x: 0, y: 0, w: 1280, h: 640 });
});

test('the region takes only the tiles it needs, each slice put where it goes on the wall', () => {
  // A 1280 × 5000 page at device scale 2, in tiles 2000 px tall (the last one 1000).
  const grid = tileGrid({ width: 1280, height: 5000, tiles: 3 }, { width: 2560, height: 4000 });
  assert.deepEqual(grid, { width: 1280, height: 5000, count: 3, tileHeight: 2000, scale: 2 });
  const dest = { x: 0, y: 0, w: WALL_W, h: WALL_H };
  // Straddling the first two tiles.
  const draws = tileDraws({ x: 0, y: 1800, w: 1280, h: 640 }, grid, dest);
  assert.deepEqual(
    draws.map((d) => d.tile),
    [0, 1],
  );
  const k = WALL_W / 1280;
  assert.deepEqual(draws[0], { tile: 0, sx: 0, sy: 3600, sw: 2560, sh: 400, dx: 0, dy: 0, dw: WALL_W, dh: 200 * k });
  assert.deepEqual(draws[1], { tile: 1, sx: 0, sy: 0, sw: 2560, sh: 880, dx: 0, dy: 200 * k, dw: WALL_W, dh: 440 * k });
  assert.equal(draws[0].dh + draws[1].dh, WALL_H, 'the slices fill the wall top to bottom');
  // At the very bottom: only the short last tile, and nothing past the page's end.
  const last = tileDraws({ x: 0, y: 4600, w: 1280, h: 640 }, grid, dest);
  assert.deepEqual(
    last.map((d) => [d.tile, d.sy, d.sh]),
    [[2, 1200, 800]],
  );
  // A region off the side of the page draws only the page's part of it.
  const side = tileDraws({ x: -360, y: 0, w: 2000, h: 1000 }, grid, dest);
  assert.deepEqual(
    side.map((d) => d.tile),
    [0],
  );
  assert.equal(side[0].dx, 360 * (WALL_W / 2000));
  assert.equal(side[0].sw, 2560);
  // One tile: its height is the page's.
  assert.equal(tileGrid({ width: 1280, height: 900, tiles: 1 }, { width: 1280, height: 900 }).tileHeight, 900);
  // A capped render: the region past its last tile draws nothing.
  const capped = tileGrid({ width: 1280, height: 50_000, tiles: 2 }, { width: 1280, height: 4000 });
  assert.deepEqual(tileDraws({ x: 0, y: 20_000, w: 1280, h: 640 }, capped, dest), []);
  // The status says where the cap is and how tall the tiles are: the grid ends at the cap, so a view past it is slid back onto what was rendered.
  const status = { width: 1280, height: 50_000, tiles: 8, tileHeight: 2048, capped: { capPx: 16_384 } };
  const atCap = tileGrid(status, { width: 1280, height: 2048 });
  assert.deepEqual(atCap, { width: 1280, height: 16_384, count: 8, tileHeight: 2048, scale: 1 });
  const slid = wallRegion({ x: 0, y: 30_000, w: 1280, h: 800 }, atCap);
  assert.equal(slid.y + slid.h, 16_384);
  assert.deepEqual(
    tileDraws(slid, atCap, dest).map((d) => d.tile),
    [7],
  );
});

test("a canvas's view is moved into its image's coordinates, which start at the canvas point the render says", () => {
  // A canvas rendered from -200,-100, at half scale (wider than the renderer's cap).
  const status = { width: 9000, height: 3000, tiles: 1, tileHeight: 2048, origin: { x: -200, y: -100 }, scale: 0.5 };
  const grid = tileGrid(status, { width: 4500, height: 1500 });
  assert.equal(grid.scale, 0.5);
  const view = { x: 800, y: 400, w: 1600, h: 800 };
  assert.deepEqual(viewOnImage(view, status.origin), { x: 1000, y: 500, w: 1600, h: 800 });
  assert.equal(viewOnImage(view, undefined), view);
  assert.equal(viewOnImage(undefined, status.origin), undefined);
  const [d] = tileDraws(wallRegion(viewOnImage(view, status.origin), grid), grid, { x: 0, y: 0, w: WALL_W, h: WALL_H });
  // The canvas point 800,400 is image px (800 + 200) * 0.5 = 500, (400 + 100) * 0.5 = 250.
  assert.deepEqual([d.sx, d.sy, d.sw, d.sh], [500, 250, 800, 400]);
});

test('placeholders say what the renderer is doing, and authors read "You" for the owner', () => {
  assert.equal(placeholderNote({ available: true }, undefined), 'Rendering…');
  assert.equal(placeholderNote({ available: false, reason: 'No Chromium' }, undefined), 'No Chromium');
  assert.match(placeholderNote({ available: false }, undefined), /not rendered/);
  assert.equal(placeholderNote({ available: false, installing: { message: 'Downloading Chromium', percent: 41.6 } }, undefined), 'Setting up the renderer: Downloading Chromium (42%)');
  assert.equal(placeholderNote({ available: true }, { current: false, error: 'timed out' }), 'The render failed: timed out');
  // A grid tile says it in a few words.
  assert.equal(tileNote({ available: true }, undefined), 'Rendering…');
  assert.equal(tileNote({ available: false, reason: 'No Chromium' }, undefined), 'No preview: renders are off');
  assert.equal(tileNote({ available: false, installing: { message: 'Downloading' } }, undefined), 'Setting up previews…');
  assert.equal(tileNote({ available: true }, { current: false, error: 'timed out' }), 'The render failed');
  assert.deepEqual(authorLabel(OWNER_AUTHOR), { name: 'You', color: OWNER_COLOR });
  assert.deepEqual(authorLabel(PIXEL), { name: 'Pixel', color: '#4fb3ff' });
});

test('the artifact line says how old the image is, and when a newer one is coming or failed', () => {
  const now = 10_000_000;
  assert.deepEqual(renderLine(undefined, now), { text: '', error: false });
  assert.deepEqual(renderLine({ at: now - 120_000, current: true }, now), { text: 'updated 2m ago', error: false });
  assert.deepEqual(renderLine({ at: now - 5_000, current: false }, now), { text: 'updated just now · updating…', error: false });
  assert.deepEqual(renderLine({ at: now - 3 * 3600_000, current: false, error: 'boom' }, now), { text: 'updated 3h ago · the last render failed', error: true });
  assert.deepEqual(renderLine({ current: false, error: 'boom' }, now), { text: 'render failed', error: true });
  assert.equal(agoText(now - 3 * 86400_000, now), '3d ago');
  assert.equal(agoText(now + 5_000, now), 'just now');
});

test('the grid header counts the cards and the ones changed since the owner looked', () => {
  const b = board(cards(3));
  assert.deepEqual(gridSummary(b), { cards: '3 cards', changed: 3 });
  const read = board([{ op: 'read', cards: ['c0', 'c1'], rev: b.rev }], OWNER_AUTHOR, b);
  assert.deepEqual(gridSummary(read), { cards: '3 cards', changed: 1 });
  // The owner's own cards aren't news to them.
  const mine = board([{ op: 'card.create', card: 'mine', kind: 'canvas', title: 'Mine' }], OWNER_AUTHOR);
  assert.deepEqual(gridSummary(mine), { cards: '1 card', changed: 0 });
  assert.equal(OWNER, 'owner');
});

test('text wraps to its width and line count, cut with an ellipsis', () => {
  const measure = (s: string) => s.length * 10;
  assert.deepEqual(wrapText('one two three', 1000, 2, measure), ['one two three']);
  assert.deepEqual(wrapText('one two three four', 80, 2, measure), ['one two', 'three…']);
  assert.deepEqual(wrapText('', 80, 2, measure), []);
  assert.equal(fitText('abcdefghij', 50, measure), 'abcd…');
  assert.equal(fitText('abc', 50, measure), 'abc');
  // One word longer than the line is cut too.
  assert.deepEqual(wrapText('supercalifragilistic', 60, 2, measure), ['super…']);
});
