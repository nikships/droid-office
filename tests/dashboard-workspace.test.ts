import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assign,
  clampRatio,
  closeSlot,
  emptyWorkspace,
  fillPanes,
  focusedWorker,
  LAYOUT_DIVIDERS,
  LAYOUT_ORDER,
  MAX_SLOTS,
  openInSplit,
  openWorker,
  paneOf,
  parseWorkspace,
  prune,
  rectsFor,
  releaseChangedPanes,
  seedWorkspace,
  serializeWorkspace,
  setLayout,
  shortDuration,
  SLOT_COUNT,
  swap,
  toggleMax,
  visibleSlots,
  workedFor,
  workerView,
} from '../src/client/dashboard-workspace.js';

test('a fresh floor gets a layout sized to its workers', () => {
  assert.equal(seedWorkspace([]).layout, 'single');
  assert.deepEqual(visibleSlots(seedWorkspace([])), [null]);
  assert.equal(seedWorkspace(['a']).layout, 'single');
  assert.deepEqual(visibleSlots(seedWorkspace(['a', 'b'])), ['a', 'b']);
  assert.equal(seedWorkspace(['a', 'b', 'c']).layout, 'triple');
  assert.equal(seedWorkspace(['a', 'b', 'c', 'd']).layout, 'grid');
  assert.equal(seedWorkspace(['a', 'b', 'c', 'd', 'e']).layout, 'five');
  assert.deepEqual(visibleSlots(seedWorkspace(['a', 'b', 'c', 'd', 'e'])), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(seedWorkspace(['a', 'b', 'c', 'd', 'e', 'f']).layout, 'six');
  assert.equal(seedWorkspace(['a', 'b', 'c', 'd', 'e', 'f', 'g']).layout, 'seven');
  assert.equal(seedWorkspace(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']).layout, 'eight');
  const crowd = seedWorkspace(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  assert.equal(crowd.layout, 'eight');
  assert.deepEqual(crowd.slots, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 'an eighth pane has no room for a ninth');
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

test('hiring into a specific empty pane keeps its target despite focus changes', () => {
  const ws = emptyWorkspace('grid');
  ws.slots[0] = 'a';
  ws.focused = 1;
  openWorker(ws, 'new', 3);
  assert.deepEqual(visibleSlots(ws), ['a', null, null, 'new']);
  assert.equal(ws.focused, 3);
});

test('a filled or hidden hire target falls back to an available visible pane', () => {
  const ws = seedWorkspace(['a', 'b']);
  closeSlot(ws, 1);
  openWorker(ws, 'new', 0);
  assert.deepEqual(visibleSlots(ws), ['a', 'new']);
  closeSlot(ws, 1);
  openWorker(ws, 'other', 3);
  assert.deepEqual(visibleSlots(ws), ['a', 'other']);
  assert.equal(ws.slots[3], null);
  openWorker(ws, 'a', 1);
  assert.deepEqual(visibleSlots(ws), ['a', 'other']);
  assert.equal(ws.focused, 0);
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

test('open in a new pane grows the layout one pane at a time, up to eight', () => {
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
  for (const [id, layout] of [
    ['e', 'five'],
    ['f', 'six'],
    ['g', 'seven'],
    ['h', 'eight'],
  ] as const) {
    openInSplit(ws, id);
    assert.equal(ws.layout, layout);
  }
  assert.deepEqual(visibleSlots(ws), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  ws.focused = 2;
  openInSplit(ws, 'i');
  assert.equal(ws.layout, 'eight');
  assert.deepEqual(visibleSlots(ws), ['a', 'b', 'i', 'd', 'e', 'f', 'g', 'h'], 'the floor of eight keeps eight');
  closeSlot(ws, 1);
  openInSplit(ws, 'j');
  assert.deepEqual(visibleSlots(ws), ['a', 'j', 'i', 'd', 'e', 'f', 'g', 'h']);
});

test('open in a new pane reveals its target while another pane is maximized', () => {
  const ws = seedWorkspace(['a', 'b']);
  toggleMax(ws, 0);
  openInSplit(ws, 'b');
  assert.equal(ws.focused, 1);
  assert.equal(ws.maximized, 1);
  closeSlot(ws, 0);
  openInSplit(ws, 'c');
  assert.equal(ws.focused, 0);
  assert.equal(ws.maximized, 0);
  openInSplit(ws, 'd');
  assert.equal(ws.layout, 'triple');
  assert.equal(ws.focused, 2);
  assert.equal(ws.maximized, null);
});

test('pane views keep their initial default when another worker changes the default', () => {
  const ws = seedWorkspace(['a', 'b']);
  assert.equal(workerView(ws, 'a', 'terminal'), 'terminal');
  assert.equal(workerView(ws, 'b', 'terminal'), 'terminal');
  ws.views.a = 'thread';
  assert.equal(workerView(ws, 'a', 'thread'), 'thread');
  assert.equal(workerView(ws, 'b', 'thread'), 'terminal');
  assert.equal(workerView(ws, 'c', 'thread'), 'thread');
  const restored = parseWorkspace(serializeWorkspace(ws))!;
  assert.equal(workerView(restored, 'a', 'terminal'), 'thread');
  assert.equal(workerView(restored, 'b', 'thread'), 'terminal');
});

test('swapping releases both old panes before either replacement attaches', () => {
  const ws = seedWorkspace(['a', 'b', 'c']);
  const events: string[] = [];
  const pane = (id: string) => ({ workerId: () => id, dispose: () => events.push(`detach ${id}`) });
  const panes: (ReturnType<typeof pane> | undefined)[] = ['a', 'b', 'c'].map(pane);
  const unchanged = panes[2];
  swap(ws, 0, 1);
  releaseChangedPanes(panes, visibleSlots(ws));
  for (const [i, id] of visibleSlots(ws).entries()) {
    if (!panes[i] && id) {
      panes[i] = pane(id);
      events.push(`attach ${id}`);
    }
  }
  assert.deepEqual(events, ['detach a', 'detach b', 'attach b', 'attach a']);
  assert.equal(panes[2], unchanged, 'unmoved terminals stay mounted');
  releaseChangedPanes(panes, ['b', null]);
  assert.deepEqual(events.slice(4), ['detach a', 'detach c'], 'closed and hidden panes detach too');
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

test('switching to a bigger layout fills its new panes with the workers on the floor', () => {
  const ws = seedWorkspace(['a']);
  setLayout(ws, 'six');
  assert.deepEqual(visibleSlots(ws), ['a', null, null, null, null, null]);
  assert.equal(fillPanes(ws, ['a', 'b', 'c', 'd']), true);
  assert.deepEqual(visibleSlots(ws), ['a', 'b', 'c', 'd', null, null]);
  assert.equal(fillPanes(ws, ['a', 'b', 'c', 'd']), false, 'nothing to fill with');
  setLayout(ws, 'eight');
  fillPanes(ws, ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(visibleSlots(ws), ['a', 'b', 'c', 'd', 'e', 'f', null, null]);
});

test('empty panes take the floor in order, then the workers hidden by a smaller layout', () => {
  const ws = seedWorkspace(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  setLayout(ws, 'split');
  assert.deepEqual(visibleSlots(ws), ['a', 'b']);
  closeSlot(ws, 0);
  fillPanes(ws, ['x', 'y']);
  assert.deepEqual(visibleSlots(ws), ['x', 'b'], 'a worker in no pane at all comes before the parked ones');
  closeSlot(ws, 0);
  fillPanes(ws, []);
  assert.deepEqual(visibleSlots(ws), ['c', 'b'], 'then the parked workers, in their own order');
  const parked = seedWorkspace(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  setLayout(parked, 'split');
  closeSlot(parked, 1);
  fillPanes(parked, ['a', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.deepEqual(visibleSlots(parked), ['a', 'c'], 'a parked worker moves back into sight, and out of its old slot');
  assert.deepEqual(parked.slots, ['a', 'c', null, 'd', 'e', 'f', 'g', 'h']);
  assert.equal(fillPanes(emptyWorkspace('single'), []), false);
});

test('filling never duplicates workers and prefers available floor workers to parked ones', () => {
  const ws = seedWorkspace(['a', 'b', 'c']);
  setLayout(ws, 'split');
  closeSlot(ws, 1);
  fillPanes(ws, ['a', '', 'b', 'b', 'c']);
  assert.deepEqual(visibleSlots(ws), ['a', 'b']);
  setLayout(ws, 'eight');
  fillPanes(ws, ['a', 'b', 'd', 'd', 'e']);
  assert.deepEqual(visibleSlots(ws), ['a', 'b', 'c', 'd', 'e', null, null, null]);
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
  assert.deepEqual(ws.slots, ['a', null, 'c', null, null, null, null, null]);
  assert.deepEqual(ws.views, { a: 'thread' });
  assert.equal(ws.maximized, null);
});

test('pane boxes tile the workspace for every layout, and it shows as many panes as it has boxes', () => {
  assert.deepEqual(
    LAYOUT_ORDER.map((mode) => SLOT_COUNT[mode]),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(MAX_SLOTS, 8);
  for (const layout of LAYOUT_ORDER) {
    const rects = rectsFor(layout, 0.6, 0.4);
    assert.equal(rects.length, SLOT_COUNT[layout], layout);
    const area = rects.reduce((sum, [, , w, h]) => sum + w * h, 0);
    assert.ok(Math.abs(area - 1) < 1e-9, layout);
  }
  assert.deepEqual(rectsFor('triple', 0.6, 0.4)[2], [0.6, 0.4, 0.4, 0.6]);
  assert.deepEqual(rectsFor('five', 0.5, 0.4).slice(0, 2), [
    [0, 0, 0.5, 1],
    [0.5, 0, 0.25, 0.5],
  ]);
  assert.deepEqual(rectsFor('eight', 0.5, 0.5)[7], [0.75, 0.5, 0.25, 0.5]);
  for (const layout of LAYOUT_ORDER) {
    for (const ratio of [0.22, 0.5, 0.78]) {
      const rects = rectsFor(layout, ratio, 1 - ratio);
      for (const [i, [x, y, w, h]] of rects.entries()) {
        assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 1.000001 && y + h <= 1.000001, `${layout} stays in bounds`);
        for (const [xx, yy, ww, hh] of rects.slice(i + 1)) {
          const overlapX = Math.min(x + w, xx + ww) - Math.max(x, xx);
          const overlapY = Math.min(y + h, yy + hh) - Math.max(y, yy);
          assert.ok(overlapX <= 1e-9 || overlapY <= 1e-9, `${layout} has no overlapping panes`);
        }
      }
    }
  }
});

test('only the layouts with a divider to drag show one', () => {
  assert.deepEqual(LAYOUT_DIVIDERS.single, { col: false, row: false });
  assert.deepEqual(LAYOUT_DIVIDERS.split, { col: true, row: false });
  assert.deepEqual(LAYOUT_DIVIDERS.triple, { col: true, row: true });
  assert.deepEqual(LAYOUT_DIVIDERS.grid, { col: true, row: true });
  assert.deepEqual(LAYOUT_DIVIDERS.five, { col: true, row: false });
  assert.deepEqual(LAYOUT_DIVIDERS.six, { col: false, row: false });
  assert.deepEqual(LAYOUT_DIVIDERS.seven, { col: true, row: false });
  assert.deepEqual(LAYOUT_DIVIDERS.eight, { col: false, row: false });
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
  assert.deepEqual(cleaned, { layout: 'split', slots: ['a', null, null, 'b', 'c', null, null, null], focused: 0, maximized: 1, col: 0.78, row: 0.5, views: { a: 'thread' } });
  assert.equal(parseWorkspace(JSON.stringify({ layout: 'single', slots: ['a'], maximized: 0 }))?.maximized, null);
});

test('legacy four-pane saves expand safely and all eight slots survive shrink and restore', () => {
  const legacy = parseWorkspace(JSON.stringify({ layout: 'grid', slots: ['a', 'b', 'c', 'd'], focused: 3, views: { d: 'terminal' } }));
  assert.ok(legacy);
  assert.deepEqual(legacy.slots, ['a', 'b', 'c', 'd', null, null, null, null]);
  setLayout(legacy, 'eight');
  fillPanes(legacy, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  toggleMax(legacy, 7);
  assert.deepEqual(parseWorkspace(serializeWorkspace(legacy)), legacy);
  setLayout(legacy, 'single');
  setLayout(legacy, 'eight');
  assert.deepEqual(visibleSlots(legacy), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.equal(legacy.views.d, 'terminal');
});

test('worked time adds the current stretch and reads short', () => {
  assert.equal(workedFor(undefined, undefined, 10), 0);
  assert.equal(workedFor(5_000, 1_000, 3_000), 7_000);
  assert.equal(shortDuration(31_000), '31s');
  assert.equal(shortDuration(12 * 60_000 + 3_000), '12m');
  assert.equal(shortDuration(2 * 3_600_000 + 14 * 60_000), '2h 14m');
  assert.equal(shortDuration(3_600_000), '1h');
});
