import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkerInfo } from '../src/shared/protocol.js';
import {
  assign,
  autoLayout,
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
  syncWorkspace,
  toggleMax,
  visibleSlots,
  workedFor,
  workerView,
} from '../src/client/dashboard-workspace.js';

const workers = (ids: readonly string[]) => ids.map((id, createdAt) => ({ id, createdAt, status: 'working' as WorkerInfo['status'], lead: undefined as string | undefined }));
const known = (ids: readonly string[]) => new Map(ids.map((id) => [id, 0]));

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

test('hire confirmation moves an auto-placed arrival to the requested empty pane', () => {
  const ws = emptyWorkspace('grid');
  ws.auto = false;
  ws.slots[0] = 'a';
  const previous = known(['a']);
  assert.deepEqual(syncWorkspace(ws, workers(['a', 'new']), previous), { gone: [], filled: true });
  assert.deepEqual(visibleSlots(ws), ['a', 'new', null, null]);
  toggleMax(ws, 0);
  openWorker(ws, 'new', 3);
  assert.deepEqual(visibleSlots(ws), ['a', null, null, 'new']);
  assert.equal(ws.focused, 3);
  assert.equal(ws.maximized, 3);
  assert.deepEqual(syncWorkspace(ws, workers(['a', 'new']), previous), { gone: [], filled: false });
  assert.deepEqual(visibleSlots(ws), ['a', null, null, 'new']);
});

test('hire confirmation keeps automatic placement when its target is occupied or hidden', () => {
  for (const target of [0, 4, -1]) {
    const ws = emptyWorkspace('grid');
    ws.auto = false;
    ws.slots[0] = 'a';
    syncWorkspace(ws, workers(['a', 'new']), known(['a']));
    openWorker(ws, 'new', target);
    assert.deepEqual(visibleSlots(ws), ['a', 'new', null, null]);
    assert.equal(ws.focused, 1);
  }
});

test('arrivals on a crowded floor take free panes without reopening unrelated closed or parked workers', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'older-hidden'];
  const previous = known(ids);
  const ws = seedWorkspace(ids);
  setLayout(ws, 'grid');
  closeSlot(ws, 1);
  closeSlot(ws, 3);
  assert.deepEqual(syncWorkspace(ws, workers([...ids, 'new']), previous), { gone: [], filled: true });
  assert.deepEqual(ws.slots, ['a', 'new', 'c', null, 'e', 'f', 'g', 'h']);
  assert.deepEqual(syncWorkspace(ws, workers([...ids, 'new']), previous), { gone: [], filled: false });
  closeSlot(ws, 1);
  syncWorkspace(ws, workers([...ids, 'new', 'later']), previous);
  assert.deepEqual(ws.slots, ['a', 'later', 'c', null, 'e', 'f', 'g', 'h']);
  assert.deepEqual(syncWorkspace(ws, workers([...ids.filter((id) => id !== 'c'), 'new', 'later']), previous), { gone: ['c'], filled: false });
  assert.deepEqual(visibleSlots(ws), ['a', 'later', null, null]);
});

test('arrivals that find a full workspace do not later refill a deliberately closed pane', () => {
  const ws = seedWorkspace(['a', 'b']);
  ws.auto = false;
  const previous = known(['a', 'b']);
  assert.deepEqual(syncWorkspace(ws, workers(['a', 'b', 'new']), previous), { gone: [], filled: false });
  closeSlot(ws, 1);
  assert.deepEqual(syncWorkspace(ws, workers(['a', 'b', 'new']), previous), { gone: [], filled: false });
  assert.deepEqual(visibleSlots(ws), ['a', null]);
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

test('empty panes take only the supplied workers in order, including parked workers', () => {
  const ws = seedWorkspace(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  setLayout(ws, 'split');
  assert.deepEqual(visibleSlots(ws), ['a', 'b']);
  closeSlot(ws, 0);
  fillPanes(ws, ['x', 'y']);
  assert.deepEqual(visibleSlots(ws), ['x', 'b']);
  closeSlot(ws, 0);
  assert.equal(fillPanes(ws, []), false);
  assert.deepEqual(visibleSlots(ws), [null, 'b'], 'parked workers are not implicitly eligible');
  const parked = seedWorkspace(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  setLayout(parked, 'split');
  closeSlot(parked, 1);
  fillPanes(parked, ['a', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.deepEqual(visibleSlots(parked), ['a', 'c'], 'a parked worker moves back into sight, and out of its old slot');
  assert.deepEqual(parked.slots, ['a', 'c', null, 'd', 'e', 'f', 'g', 'h']);
  assert.equal(fillPanes(emptyWorkspace('single'), []), false);
});

test('filling never duplicates workers or moves already-visible workers', () => {
  const ws = seedWorkspace(['a', 'b', 'c']);
  setLayout(ws, 'split');
  closeSlot(ws, 1);
  fillPanes(ws, ['a', '', 'b', 'b', 'c']);
  assert.deepEqual(visibleSlots(ws), ['a', 'b']);
  setLayout(ws, 'eight');
  fillPanes(ws, ['a', 'b', 'd', 'd', 'e']);
  assert.deepEqual(visibleSlots(ws), ['a', 'b', 'c', 'd', 'e', null, null, null]);
});

test('layout changes leave slot assignment to one explicit fill in caller order', () => {
  const ws = seedWorkspace(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  setLayout(ws, 'split');
  closeSlot(ws, 0);
  const before = [...ws.slots];
  setLayout(ws, 'grid');
  assert.deepEqual(ws.slots, before, 'the layout setter never fills or moves slots');
  fillPanes(ws, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.deepEqual(ws.slots, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 'floor order wins over an implicit parked-worker fill');
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
  assert.deepEqual(cleaned, { layout: 'split', auto: true, slots: ['a', null, null, 'b', 'c', null, null, null], focused: 0, maximized: 1, col: 0.78, row: 0.5, views: { a: 'thread' } });
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

test('Auto grows and contracts on main-worker arrivals and departures, including an empty floor', () => {
  const ws = emptyWorkspace('single');
  const previous = new Map<string, number>();
  const all = workers(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  for (let count = 1; count <= all.length; count++) {
    syncWorkspace(ws, all.slice(0, count), previous);
    assert.equal(SLOT_COUNT[ws.layout], Math.min(count, 8));
    assert.equal(visibleSlots(ws).filter(Boolean).length, Math.min(count, 8));
  }
  for (let count = all.length - 1; count >= 0; count--) {
    syncWorkspace(ws, all.slice(0, count), previous);
    assert.equal(SLOT_COUNT[ws.layout], Math.max(1, Math.min(count, 8)));
    assert.equal(visibleSlots(ws).filter(Boolean).length, Math.min(count, 8));
  }
  assert.deepEqual(visibleSlots(ws), [null]);
});

test('five mains do not expand for subagents; two mains can expand all the way to eight', () => {
  const mains = workers(['a', 'b', 'c', 'd', 'e']);
  const children = workers(['s1', 's2', 's3', 's4', 's5', 's6', 's7']).map((w) => ({ ...w, lead: 'a' }));
  const ws = emptyWorkspace('single');
  const previous = new Map<string, number>();
  syncWorkspace(ws, mains, previous);
  syncWorkspace(ws, [...mains, ...children], previous);
  assert.equal(ws.layout, 'five');
  assert.deepEqual(
    visibleSlots(ws),
    mains.map((w) => w.id),
  );
  syncWorkspace(ws, [...mains.slice(0, 2), ...children.slice(0, 5)], previous);
  assert.equal(ws.layout, 'seven');
  assert.deepEqual(visibleSlots(ws), ['a', 'b', 's1', 's2', 's3', 's4', 's5']);
  syncWorkspace(ws, [...mains.slice(0, 2), ...children], previous);
  assert.equal(ws.layout, 'eight');
  assert.ok(visibleSlots(ws).includes('a') && visibleSlots(ws).includes('b'));
  syncWorkspace(ws, mains.slice(0, 2), previous);
  assert.equal(ws.layout, 'split');
});

test('the fifth main stops subagent-driven expansion, and its departure makes room again', () => {
  const mains = workers(['a', 'b', 'c', 'd', 'e']);
  const children = workers(['s1', 's2', 's3', 's4']).map((w) => ({ ...w, lead: 'a' }));
  const ws = emptyWorkspace();
  const previous = new Map<string, number>();
  syncWorkspace(ws, [...mains.slice(0, 4), ...children], previous);
  assert.equal(ws.layout, 'eight');
  syncWorkspace(ws, [...mains, ...children], previous);
  assert.equal(ws.layout, 'five');
  assert.deepEqual(
    visibleSlots(ws),
    mains.map((w) => w.id),
  );
  syncWorkspace(ws, [...mains.slice(0, 4), ...children], previous);
  assert.equal(ws.layout, 'eight');
  assert.equal(new Set(visibleSlots(ws)).size, 8);
});

test('Auto selects active mains, main questions, active subagents, done mains, then done subagents', () => {
  const all = workers(['done-sub', 'done-main', 'active-sub', 'question', 'working', 'starting', 'sub-question']).map((w) => ({
    ...w,
    status: (w.id.startsWith('done') ? 'done' : w.id.includes('question') ? 'needs_input' : w.id === 'starting' ? 'starting' : 'working') as WorkerInfo['status'],
    lead: w.id.includes('sub') ? 'working' : undefined,
  }));
  const ws = emptyWorkspace();
  autoLayout(ws, all);
  assert.deepEqual(visibleSlots(ws), ['working', 'starting', 'question', 'active-sub', 'sub-question', 'done-main', 'done-sub']);
  // Five main workers set a five-pane budget, but active children outrank resting mains.
  autoLayout(ws, [...all, ...workers(['resting']).map((w) => ({ ...w, status: 'idle' as const }))]);
  assert.equal(ws.layout, 'five');
  assert.deepEqual(new Set(visibleSlots(ws)), new Set(['working', 'starting', 'question', 'active-sub', 'sub-question']));
});

test('priority changes replace lower-priority workers without shuffling equal-priority incumbents', () => {
  const all = workers(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  const ws = emptyWorkspace();
  const previous = new Map<string, number>();
  syncWorkspace(ws, all, previous);
  all[0].status = 'done';
  syncWorkspace(ws, all, previous);
  assert.deepEqual(visibleSlots(ws), ['i', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  all[0].status = 'working';
  syncWorkspace(ws, all, previous);
  assert.deepEqual(visibleSlots(ws), ['i', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 'equal priorities do not churn the visible set');
  all[8].status = 'done';
  syncWorkspace(ws, all, previous);
  assert.deepEqual(visibleSlots(ws), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
});

test('Auto keeps focus, maximization, views and ratios when compacting after a dismissal', () => {
  const all = workers(['a', 'b', 'c', 'd']);
  const ws = emptyWorkspace();
  const previous = new Map<string, number>();
  syncWorkspace(ws, all, previous);
  ws.col = 0.35;
  ws.row = 0.65;
  ws.views = { b: 'thread', d: 'terminal' };
  toggleMax(ws, 3);
  syncWorkspace(
    ws,
    all.filter((w) => w.id !== 'b'),
    previous,
  );
  assert.deepEqual(visibleSlots(ws), ['a', 'd', 'c']);
  assert.equal(ws.focused, 1);
  assert.equal(ws.maximized, 1);
  assert.deepEqual(ws.views, { d: 'terminal' });
  assert.equal(ws.col, 0.35);
  assert.equal(ws.row, 0.65);
  syncWorkspace(ws, all.slice(0, 1), previous);
  assert.equal(ws.focused, 0);
  assert.equal(ws.maximized, null);
});

test('manual layout and close choices persist until Auto is explicitly restored', () => {
  const all = workers(['a', 'b', 'c', 'd']);
  const ws = emptyWorkspace();
  const previous = new Map<string, number>();
  syncWorkspace(ws, all.slice(0, 2), previous);
  setLayout(ws, 'single');
  syncWorkspace(ws, all, previous);
  assert.equal(ws.auto, false);
  assert.equal(ws.layout, 'single');
  assert.equal(parseWorkspace(serializeWorkspace(ws))?.auto, false);
  autoLayout(ws, all);
  assert.equal(ws.auto, true);
  assert.equal(ws.layout, 'grid');
  closeSlot(ws, 2);
  syncWorkspace(ws, all, previous);
  assert.equal(ws.auto, false);
  assert.equal(ws.slots[2], null);
  autoLayout(ws, all);
  assert.ok(visibleSlots(ws).includes('c'));
  assert.equal(parseWorkspace(serializeWorkspace(ws))?.auto, true);
  assert.equal(parseWorkspace(JSON.stringify({ layout: 'split', slots: ['a', 'b'] }))?.auto, true, 'legacy workspaces gain Auto');
});

test('ordinary repaints keep explicit worker selections and swaps, even in Auto', () => {
  const all = workers(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  const ws = emptyWorkspace();
  const previous = new Map<string, number>();
  syncWorkspace(ws, all, previous);
  openWorker(ws, 'i');
  swap(ws, 1, 4);
  const before = serializeWorkspace(ws);
  assert.deepEqual(syncWorkspace(ws, [...all].reverse(), previous), { gone: [], filled: false });
  assert.equal(serializeWorkspace(ws), before);
  all[0].status = 'starting';
  assert.deepEqual(syncWorkspace(ws, all, previous), { gone: [], filled: false });
  assert.equal(serializeWorkspace(ws), before);
});

test('subagent classification follows lead links, including when the lead has left', () => {
  const all = workers(['a', 'b', 'c', 'd', 'orphan', 's1', 's2', 's3']).map((w, i) => ({ ...w, lead: i >= 4 ? 'gone-lead' : undefined }));
  const ws = emptyWorkspace();
  autoLayout(ws, all);
  assert.equal(ws.layout, 'eight', 'orphaned subagents do not count toward the five-main limit');
  assert.equal(autoLayout(ws, all), false, 'applying the same policy is idempotent');
});
