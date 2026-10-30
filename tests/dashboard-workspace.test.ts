import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assign,
  clampRatio,
  closeSlot,
  emptyWorkspace,
  focusedWorker,
  openInSplit,
  openWorker,
  paneOf,
  parseWorkspace,
  prune,
  rectsFor,
  seedWorkspace,
  serializeWorkspace,
  setLayout,
  shortDuration,
  swap,
  toggleMax,
  visibleSlots,
  workedFor,
} from '../src/client/dashboard-workspace.js';

test('a fresh floor gets a layout sized to its workers', () => {
  assert.equal(seedWorkspace([]).layout, 'single');
  assert.deepEqual(visibleSlots(seedWorkspace([])), [null]);
  assert.equal(seedWorkspace(['a']).layout, 'single');
  assert.deepEqual(visibleSlots(seedWorkspace(['a', 'b'])), ['a', 'b']);
  const many = seedWorkspace(['a', 'b', 'c', 'd', 'e']);
  assert.equal(many.layout, 'triple');
  assert.deepEqual(many.slots, ['a', 'b', 'c', null]);
});

test('opening a worker focuses its pane, then fills an empty one, then takes the focused one', () => {
  const ws = emptyWorkspace('split');
  openWorker(ws, 'a');
  assert.deepEqual(visibleSlots(ws), ['a', null]);
  openWorker(ws, 'b');
  assert.deepEqual(visibleSlots(ws), ['a', 'b']);
  assert.equal(ws.focused, 1);
  openWorker(ws, 'a');
  assert.equal(ws.focused, 0);
  openWorker(ws, 'c');
  assert.deepEqual(visibleSlots(ws), ['c', 'b']);
  assert.equal(focusedWorker(ws), 'c');
});

test('opening while a pane is maximized keeps the opened worker maximized', () => {
  const ws = seedWorkspace(['a', 'b']);
  toggleMax(ws, 0);
  openWorker(ws, 'b');
  assert.equal(ws.maximized, 1);
  openWorker(ws, 'c');
  assert.equal(ws.maximized, 1);
  assert.deepEqual(visibleSlots(ws), ['a', 'c']);
});

test('assigning a worker that is already open trades the two panes', () => {
  const ws = seedWorkspace(['a', 'b', 'c']);
  assign(ws, 0, 'c');
  assert.deepEqual(visibleSlots(ws), ['c', 'b', 'a']);
  swap(ws, 0, 1);
  assert.deepEqual(visibleSlots(ws), ['b', 'c', 'a']);
  assert.equal(ws.focused, 1);
  swap(ws, 1, 1);
  assert.deepEqual(visibleSlots(ws), ['b', 'c', 'a']);
});

test('open in a new pane grows the layout, and stops growing at four', () => {
  const ws = seedWorkspace(['a']);
  openInSplit(ws, 'b');
  assert.equal(ws.layout, 'split');
  assert.deepEqual(visibleSlots(ws), ['a', 'b']);
  openInSplit(ws, 'a');
  assert.equal(ws.focused, 0);
  openInSplit(ws, 'c');
  openInSplit(ws, 'd');
  assert.equal(ws.layout, 'grid');
  assert.deepEqual(visibleSlots(ws), ['a', 'b', 'c', 'd']);
  ws.focused = 2;
  openInSplit(ws, 'e');
  assert.equal(ws.layout, 'grid');
  assert.deepEqual(visibleSlots(ws), ['a', 'b', 'e', 'd']);
  closeSlot(ws, 1);
  openInSplit(ws, 'f');
  assert.deepEqual(visibleSlots(ws), ['a', 'f', 'e', 'd']);
});

test('a smaller layout hides panes without forgetting them', () => {
  const ws = seedWorkspace(['a', 'b', 'c']);
  ws.focused = 2;
  setLayout(ws, 'single');
  assert.deepEqual(visibleSlots(ws), ['a']);
  assert.equal(ws.focused, 0);
  assert.equal(paneOf(ws, 'c'), -1);
  setLayout(ws, 'triple');
  assert.deepEqual(visibleSlots(ws), ['a', 'b', 'c']);
});

test('maximize toggles, needs two panes, and closing the maximized pane restores the layout', () => {
  const single = seedWorkspace(['a']);
  toggleMax(single, 0);
  assert.equal(single.maximized, null);
  const ws = seedWorkspace(['a', 'b', 'c']);
  toggleMax(ws, 2);
  assert.equal(ws.maximized, 2);
  assert.equal(ws.focused, 2);
  toggleMax(ws, 2);
  assert.equal(ws.maximized, null);
  toggleMax(ws, 1);
  closeSlot(ws, 1);
  assert.equal(ws.maximized, null);
  assert.deepEqual(visibleSlots(ws), ['a', null, 'c']);
});

test('workers who left the floor leave their panes and views', () => {
  const ws = seedWorkspace(['a', 'b', 'c']);
  ws.views = { a: 'thread', b: 'terminal' };
  toggleMax(ws, 1);
  const gone = prune(ws, (id) => id !== 'b');
  assert.deepEqual(gone, ['b']);
  assert.deepEqual(ws.slots, ['a', null, 'c', null]);
  assert.deepEqual(ws.views, { a: 'thread' });
  assert.equal(ws.maximized, null);
});

test('pane boxes tile the workspace for every layout', () => {
  for (const layout of ['single', 'split', 'triple', 'grid'] as const) {
    const area = rectsFor(layout, 0.6, 0.4).reduce((sum, [, , w, h]) => sum + w * h, 0);
    assert.ok(Math.abs(area - 1) < 1e-9, layout);
  }
  assert.deepEqual(rectsFor('triple', 0.6, 0.4)[2], [0.6, 0.4, 0.4, 0.6]);
});

test('dividers stay away from the edges', () => {
  assert.equal(clampRatio(0.05), 0.22);
  assert.equal(clampRatio(0.95), 0.78);
  assert.equal(clampRatio(0.5), 0.5);
  assert.equal(clampRatio(Number.NaN), 0.5);
});

test('a saved workspace round-trips, and a damaged one is cleaned or refused', () => {
  const ws = seedWorkspace(['a', 'b', 'c']);
  ws.col = 0.3;
  ws.views.a = 'thread';
  toggleMax(ws, 2);
  assert.deepEqual(parseWorkspace(serializeWorkspace(ws)), ws);
  assert.equal(parseWorkspace(null), undefined);
  assert.equal(parseWorkspace('not json'), undefined);
  assert.equal(parseWorkspace('"triple"'), undefined);
  assert.equal(parseWorkspace(JSON.stringify({ layout: 'mosaic', slots: [] })), undefined);
  const cleaned = parseWorkspace(JSON.stringify({ layout: 'split', slots: ['a', 'a', 7, 'b', 'c'], focused: 3, maximized: 1, col: 4, row: 'x', views: { a: 'thread', b: 'grid' } }));
  assert.deepEqual(cleaned, { layout: 'split', slots: ['a', null, null, 'b'], focused: 0, maximized: 1, col: 0.78, row: 0.5, views: { a: 'thread' } });
  assert.equal(parseWorkspace(JSON.stringify({ layout: 'single', slots: ['a'], maximized: 0 }))?.maximized, null);
});

test('worked time adds the current stretch and reads short', () => {
  assert.equal(workedFor(undefined, undefined, 10), 0);
  assert.equal(workedFor(5_000, 1_000, 3_000), 7_000);
  assert.equal(shortDuration(31_000), '31s');
  assert.equal(shortDuration(12 * 60_000 + 3_000), '12m');
  assert.equal(shortDuration(2 * 3_600_000 + 14 * 60_000), '2h 14m');
  assert.equal(shortDuration(3_600_000), '1h');
});
