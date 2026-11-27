import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import unicode11 from '@xterm/addon-unicode11';
import { KITTY_CELL_PX_H, KITTY_CELL_PX_W, KITTY_DIACRITICS, KITTY_PLACEHOLDER_CHAR } from '../src/shared/kitty.js';
import { FLAG_INVERSE, FLAG_INVISIBLE, FLAG_ITALIC, FLAG_OVERLINE, FLAG_STRIKE, FLAG_UNDERLINE, screenHistoryRows, type Run } from '../src/shared/protocol.js';
import { plainTail, searchTerminal } from '../src/server/history.js';
import { screenSnapshot } from '../src/server/screen.js';
import { snapshotScreen } from '../src/server/screen-frame.js';

function terminal(cols: number, rows: number) {
  const term = new headless.Terminal({ cols, rows, scrollback: 200, allowProposedApi: true });
  const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  return { term, write };
}

const numbered = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `line ${from + i}`).join('\r\n');
const texts = (rows: Run[][] | undefined) => rows?.map((runs) => runs.map((r) => r[0]).join(''));

test('conceal drops ink-only flags and retains inverse background', async (t) => {
  const { term, write } = terminal(20, 3);
  t.after(() => term.dispose());
  await write('\x1b[1;2;3;4;8;9;53mhidden\r\n\x1b[7mX');
  const lines = snapshotScreen(term, [])!.lines;
  assert.deepEqual(lines[0], []);
  assert.deepEqual(lines[1], [[' ', -1, -1, FLAG_INVISIBLE | FLAG_INVERSE]]);
});

test('trim preserves trailing whitespace inside a width-bearing grapheme', async (t) => {
  const { term, write } = terminal(2, 2);
  t.after(() => term.dispose());
  term.loadAddon(new unicode11.Unicode11Addon());
  term.unicode.activeVersion = '11';
  await write('A\u0600\u00a0');
  assert.deepEqual(snapshotScreen(term, [])!.lines[0].at(-1), ['\u0600\u00a0', -1, -1, 0, 1]);
});

test('Kitty keeps backgrounds on concealed and decorated spaces after a placeholder', async (t) => {
  const { term, write } = terminal(20, 3);
  t.after(() => term.dispose());
  const ph = `\x1b[38;2;0;0;9m${KITTY_PLACEHOLDER_CHAR}${String.fromCodePoint(KITTY_DIACRITICS[0]).repeat(2)}`;
  await write(`${ph}\x1b[0;100m   \x1b[0;8;41m \x1b[0;4;42m `);
  assert.deepEqual(snapshotScreen(term, [])!.lines[0], [
    ['    ', -1, -1, 0],
    [' ', -1, 1, FLAG_INVISIBLE],
    [' ', -1, 2, FLAG_UNDERLINE],
  ]);
});

test('a 120×40 Han screen sends one exact fixed-stride run per row', async (t) => {
  const { term, write } = terminal(120, 40);
  t.after(() => term.dispose());
  term.loadAddon(new unicode11.Unicode11Addon());
  term.unicode.activeVersion = '11';
  const row = Array.from({ length: 60 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');
  await write(Array(40).fill(row).join('\r\n'));
  const frame = snapshotScreen(term, [])!;
  assert.equal(Object.keys(frame.lines).length, 40);
  for (const runs of Object.values(frame.lines)) assert.deepEqual(runs, [[row, -1, -1, 0, 120, 2]]);
  assert.deepEqual(frame.cursor, [120, 39]);
});

for (const [label, cluster, cols] of [
  ['regional indicator flag', '🇯🇵', 2],
  ['combining accent', 'é', 1],
  ['variation selector', '🖥️', 1],
  ['joined emoji', '👩‍💻', 4],
] as const) {
  test(`never marks a ${label} cluster as fixed-stride`, async (t) => {
    const { term, write } = terminal(40, 2);
    t.after(() => term.dispose());
    term.loadAddon(new unicode11.Unicode11Addon());
    term.unicode.activeVersion = '11';
    await write(`界語${cluster}${cluster}語界éà\x1b[3m界語`);
    assert.deepEqual(snapshotScreen(term, [])!.lines[0], [
      ['界語', -1, -1, 0, 4, 2],
      [cluster, -1, -1, 0, cols],
      [cluster, -1, -1, 0, cols],
      ['語界', -1, -1, 0, 4, 2],
      ['éà', -1, -1, 0, 2, 1],
      ['界語', -1, -1, FLAG_ITALIC, 4, 2],
    ]);
  });
}

test('joined and RTL words carry their total advance without a fixed stride', async (t) => {
  const { term, write } = terminal(40, 2);
  t.after(() => term.dispose());
  await write('سلامZ\r\nשלוםZ');
  const frame = snapshotScreen(term, [])!;
  for (const [i, word] of ['سلام', 'שלום'].entries()) {
    assert.deepEqual(frame.lines[i], [
      [word, -1, -1, 0, 4],
      ['Z', -1, -1, 0],
    ]);
    assert.equal(term.buffer.active.getLine(i)?.getCell(4)?.getChars(), 'Z');
  }
});

test('compact frames retain terminal widths and SGR without leaking concealed text', async () => {
  const { term, write } = terminal(40, 4);
  term.loadAddon(new unicode11.Unicode11Addon());
  term.unicode.activeVersion = '11';
  try {
    const last: string[] = [];
    await write('x界👩‍💻éZ\r\n\x1b[3;4;9;53m   \x1b[0m\r\n\x1b[8;41msecret界\x1b[0m');
    const f = snapshotScreen(term, last)!;
    assert.deepEqual(f.lines[0], [
      ['x', -1, -1, 0],
      ['界', -1, -1, 0, 2],
      ['👩‍💻', -1, -1, 0, 4],
      ['é', -1, -1, 0, 1],
      ['Z', -1, -1, 0],
    ]);
    assert.deepEqual(f.lines[1], [['   ', -1, -1, FLAG_ITALIC | FLAG_UNDERLINE | FLAG_STRIKE | FLAG_OVERLINE]]);
    assert.deepEqual(f.lines[2], [['        ', -1, 1, FLAG_INVISIBLE]]);
    assert.deepEqual(f.cursor, [8, 2]);
    await write('\x1b[H');
    assert.equal(snapshotScreen(term, last), null, 'a cursor-only move does not send a visual update');
    term.resize(44, 4);
    assert.equal(snapshotScreen(term, last)?.full, true, 'a column-only resize resets the frame');
  } finally {
    term.dispose();
  }
});

test('a terminal wider than a laptop sends the scrollback rows just above its screen', async () => {
  const { term, write } = terminal(150, 30);
  await write(numbered(0, 80));
  const n = screenHistoryRows(150, 30);
  assert.equal(n, 20);
  const last: string[] = [];
  const frame = snapshotScreen(term, last);
  assert.ok(frame?.full);
  assert.deepEqual(texts(frame.above), numbered(30, 50).split('\r\n'), 'oldest first, ending just above the screen');
  assert.deepEqual(frame.lines[0], [['line 50', -1, -1, 0]]);

  assert.equal(snapshotScreen(term, last), null, 'nothing changed, nothing sent');
  await write('\r\nline 80');
  const scrolled = snapshotScreen(term, last);
  assert.equal(scrolled?.full, false);
  assert.deepEqual(texts(scrolled?.above)?.at(-1), 'line 50', 'the row that scrolled off the screen is now the last one above it');
  await write('\x1b[1;1H\x1b[2Ksame scrollback');
  const edited = snapshotScreen(term, last);
  assert.ok(edited && !('above' in edited), 'a change on the screen alone leaves the rows above out');
});

test('a terminal a laptop fits, a short scrollback and the alternate screen send what they have', async () => {
  const narrow = terminal(80, 30);
  await narrow.write(numbered(0, 80));
  assert.equal(screenHistoryRows(80, 30), 0);
  assert.deepEqual(snapshotScreen(narrow.term, [])?.above, []);

  const young = terminal(150, 30);
  await young.write(numbered(0, 35));
  assert.deepEqual(texts(snapshotScreen(young.term, [])?.above), numbered(0, 5).split('\r\n'));

  const alt = terminal(150, 30);
  await alt.write(numbered(0, 80));
  await alt.write('\x1b[?1049h\x1b[Hfull-screen app');
  assert.deepEqual(snapshotScreen(alt.term, [])?.above, [], 'the alternate screen has no scrollback');
});

test('screenHistoryRows covers a laptop and stays within the screen it extends', () => {
  assert.equal(screenHistoryRows(100, 30), 4);
  assert.equal(screenHistoryRows(140, 38), 9);
  assert.equal(screenHistoryRows(400, 5), 5);
  assert.equal(screenHistoryRows(56, 22), 0);
});

test('snapshotScreen coalesces Kitty U=1 placeholders, strips U+10EEEE from text runs and diffs image payloads once', async () => {
  const term = new headless.Terminal({ cols: 40, rows: 6, scrollback: 50, allowProposedApi: true });
  const ser = new serialize.SerializeAddon();
  term.loadAddon(ser as any);
  term.loadAddon(new unicode11.Unicode11Addon() as any);
  term.unicode.activeVersion = '11';
  screenSnapshot(term, ser);
  const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));

  const d0 = String.fromCodePoint(KITTY_DIACRITICS[0]);
  const d1 = String.fromCodePoint(KITTY_DIACRITICS[1]);
  await write(
    `header\r\n` +
      `\x1b_Ga=T,U=1,q=2,f=32,s=18,v=36,i=7,c=2,r=2;AAAAAAAAAAAAAAAA\x1b\\` +
      `\x1b[38;2;0;0;7m${KITTY_PLACEHOLDER_CHAR}${d0}${d0}${KITTY_PLACEHOLDER_CHAR}${d0}${d1}\x1b[39m\r\n` +
      `\x1b[38;2;0;0;7m${KITTY_PLACEHOLDER_CHAR}${d1}${d0}${KITTY_PLACEHOLDER_CHAR}${d1}${d1}\x1b[39m caption\r\n`,
  );

  const last: string[] = [];
  const first = snapshotScreen(term, last);
  assert.ok(first);
  assert.deepEqual(first.lines[0], [['header', -1, -1, 0]]);
  assert.deepEqual(first.lines[1], [], 'placeholder-only row trims to empty text runs');
  assert.deepEqual(first.lines[2], [['   caption', -1, -1, 0]], 'placeholders become spaces preserving column alignment');
  assert.deepEqual(first.placements, [{ id: 7, x: 0, y: 1, cols: 2, rows: 2, srcCol: 0, srcRow: 0, totalCols: 2, totalRows: 2 }]);
  assert.equal(first.images?.[7]?.data, 'AAAAAAAAAAAAAAAA');

  // Subsequent text updates do not re-transmit unchanged image bytes.
  await write('footer');
  const next = snapshotScreen(term, last);
  assert.ok(next);
  assert.equal(next.images, undefined);
  assert.equal(next.placements, undefined);

  // Re-uploading the same image ID with equal-length different bytes delivers the updated payload.
  await write('\x1b_Ga=T,U=1,q=2,f=32,s=18,v=36,i=7,c=2,r=2;////////////////\x1b\\');
  const updated = snapshotScreen(term, last);
  assert.equal(updated?.images?.[7]?.data, '////////////////');

  // Plain-text log & search helpers never expose U+10EEEE or combining diacritics.
  assert.equal(plainTail(term, 10).includes(KITTY_PLACEHOLDER_CHAR), false);
  const search = searchTerminal(term, 'caption', 5);
  assert.equal(search.hits.length, 1);
  assert.equal(search.hits[0].text, 'caption');
  term.dispose();
});

test("laptop placements use an image's explicit c/r, and size images without them from the reported cells", async () => {
  const term = new headless.Terminal({ cols: 40, rows: 4, scrollback: 20, allowProposedApi: true });
  const ser = new serialize.SerializeAddon();
  term.loadAddon(ser as any);
  term.loadAddon(new unicode11.Unicode11Addon() as any);
  term.unicode.activeVersion = '11';
  screenSnapshot(term, ser);
  const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  const d0 = String.fromCodePoint(KITTY_DIACRITICS[0]);
  const cell = (id: number) => `\x1b[38;2;0;0;${id}m${KITTY_PLACEHOLDER_CHAR}${d0}${d0}\x1b[39m`;
  // What Droid sends for a 2400×1640 screenshot: 35×12 cells, 630×431 px. Only its top-left cell is on screen.
  await write(`\x1b_Ga=T,U=1,q=2,f=32,s=630,v=431,i=11,c=35,r=12;AAAA\x1b\\${cell(11)}\r\n`);
  await write(`\x1b_Ga=T,U=1,q=2,f=32,s=${KITTY_CELL_PX_W * 4},v=${KITTY_CELL_PX_H * 3},i=12;AAAA\x1b\\${cell(12)}`);
  const frame = snapshotScreen(term, []);
  assert.deepEqual(
    frame?.placements?.map((p) => [p.id, p.totalCols, p.totalRows]),
    [
      [11, 35, 12],
      [12, 4, 3],
    ],
  );
  term.dispose();
});

test('snapshotScreen clears grey container background beside and behind inline Kitty images while keeping prompt accent bars', async () => {
  const term = new headless.Terminal({ cols: 30, rows: 4, scrollback: 20, allowProposedApi: true });
  const ser = new serialize.SerializeAddon();
  term.loadAddon(ser as any);
  term.loadAddon(new unicode11.Unicode11Addon() as any);
  term.unicode.activeVersion = '11';
  screenSnapshot(term, ser);
  const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));

  const d0 = String.fromCodePoint(KITTY_DIACRITICS[0]);
  const d1 = String.fromCodePoint(KITTY_DIACRITICS[1]);
  // Row 0: 1-col orange prompt border (#d75f00) + 2-col grey margin (#262626) + 2-col Kitty U=1 image + 25-col grey padding.
  // Row 1: same border + 2-col image + caption on #262626 + trailing grey padding.
  await write(
    `\x1b_Ga=T,U=1,q=2,f=32,s=18,v=36,i=9,c=2,r=2;AAAAAAAAAAAAAAAA\x1b\\` +
      `\x1b[48;2;215;95;0m \x1b[48;2;38;38;38m  \x1b[38;2;0;0;9m${KITTY_PLACEHOLDER_CHAR}${d0}${d0}${KITTY_PLACEHOLDER_CHAR}${d0}${d1}\x1b[39m${' '.repeat(25)}\x1b[0m\r\n` +
      `\x1b[48;2;215;95;0m \x1b[48;2;38;38;38m  \x1b[38;2;0;0;9m${KITTY_PLACEHOLDER_CHAR}${d1}${d0}${KITTY_PLACEHOLDER_CHAR}${d1}${d1}\x1b[38;2;220;220;220m tag${' '.repeat(21)}\x1b[0m`,
  );

  const frame = snapshotScreen(term, []);
  assert.ok(frame);
  assert.deepEqual(frame.placements, [{ id: 9, x: 3, y: 0, cols: 2, rows: 2, srcCol: 0, srcRow: 0, totalCols: 2, totalRows: 2 }]);
  assert.deepEqual(frame.lines[0], [[' ', -1, 0x1d75f00, 0]], 'orange prompt border stays while grey padding next to image clears to black');
  assert.deepEqual(
    frame.lines[1],
    [
      [' ', -1, 0x1d75f00, 0],
      ['    ', -1, -1, 0],
      [' tag', 0x1dcdcdc, 0x1262626, 0],
    ],
    'visible caption text keeps its background while trailing grey spaces to the right clear to black',
  );
  term.dispose();
});

test('client store skips redundant screen repaints when incoming frames match existing state', async () => {
  const { store } = await import('../src/client/state.js');
  const wid = '__perf_test_screen__';
  let emits = 0;
  const unsub = store.on('screens', () => {
    emits++;
  });
  try {
    store.apply({
      t: 'screen',
      workerId: wid,
      cols: 80,
      rows: 4,
      full: true,
      lines: { 0: [['prompt > ', -1, -1, 0]] },
      cursor: [9, 0],
    });
    assert.equal(emits, 1);
    assert.equal(store.screens.get(wid)?.version, 1);

    // Identical keyframe and diff must not bump version or wake screen listeners.
    store.apply({
      t: 'screen',
      workerId: wid,
      cols: 80,
      rows: 4,
      full: true,
      lines: { 0: [['prompt > ', -1, -1, 0]] },
      cursor: [9, 0],
    });
    store.apply({
      t: 'screen',
      workerId: wid,
      cols: 80,
      rows: 4,
      full: false,
      lines: { 0: [['prompt > ', -1, -1, 0]] },
      cursor: [9, 0],
    });
    assert.equal(emits, 1);
    assert.equal(store.screens.get(wid)?.version, 1);

    // A recovery keyframe may carry a new cursor on an otherwise identical screen.
    store.apply({ t: 'screen', workerId: wid, cols: 80, rows: 4, full: true, lines: { 0: [['prompt > ', -1, -1, 0]] }, cursor: [0, 0] });
    assert.deepEqual(store.screens.get(wid)?.cursor, [0, 0]);
    assert.equal(store.screens.get(wid)?.version, 1);
    assert.equal(emits, 1);

    // Changing the visible text bumps version once and notifies listeners.
    store.apply({
      t: 'screen',
      workerId: wid,
      cols: 80,
      rows: 4,
      full: false,
      lines: { 0: [['prompt > ls', -1, -1, 0]] },
      cursor: [11, 0],
    });
    assert.equal(emits, 2);
    assert.equal(store.screens.get(wid)?.version, 2);
  } finally {
    unsub();
    store.apply({ t: 'worker.remove', workerId: wid });
  }
});

test('screen cache keeps per-glyph advances in live rows and history across diffs and full frames', async () => {
  const { Store } = await import('../src/client/state.js');
  const store = new Store();
  const row = (width: number): Run[] => [['👩‍💻', -1, -1, 0, width]];
  const frame = { t: 'screen' as const, workerId: 'width', cols: 40, rows: 3, cursor: [0, 0] as [number, number] };
  const apply = (full: boolean, width: number) => store.apply({ ...frame, full, lines: { 0: row(width) }, above: [row(width)] });
  apply(true, 2);
  apply(false, 4);
  assert.equal(store.screens.get('width')!.version, 2);
  assert.deepEqual(store.screens.get('width')!.above, [row(4)]);
  apply(true, 2);
  assert.deepEqual(store.screens.get('width')!.lines[0], row(2));
  assert.equal(store.screens.get('width')!.version, 3);
  apply(false, 2);
  assert.equal(store.screens.get('width')!.version, 3);
  const oldHan: Run[] = [['界語', -1, -1, 0, 4]];
  const batchedHan: Run[] = [['界語', -1, -1, 0, 4, 2]];
  for (const runs of [oldHan, batchedHan]) store.apply({ ...frame, full: true, lines: { 0: runs }, above: [runs] });
  assert.deepEqual(store.screens.get('width')!.lines[0], batchedHan);
  assert.deepEqual(store.screens.get('width')!.above, [batchedHan]);
});

test('screen events identify both synchronous updates and delayed image-only updates', async (t) => {
  const { Store } = await import('../src/client/state.js');
  const store = new Store();
  const events: (string | undefined)[] = [];
  store.on('screens', (workerId) => events.push(workerId));
  const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  const bitmap = { width: 1, height: 1, close() {} } as ImageBitmap;
  let finishDecode!: (value: ImageBitmap) => void;
  const decoded = new Promise<ImageBitmap>((resolve) => {
    finishDecode = resolve;
  });
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: () => decoded });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'createImageBitmap', original);
    else Reflect.deleteProperty(globalThis, 'createImageBitmap');
  });

  const frame = { t: 'screen', workerId: 'boss-shell', cols: 80, rows: 4, full: true, lines: {}, cursor: [0, 0] } as const;
  store.apply({ ...frame, cursor: [0, 0] });
  assert.deepEqual(events, ['boss-shell']);
  events.length = 0;
  const version = store.screens.get(frame.workerId)!.version;
  store.apply({
    ...frame,
    full: false,
    cursor: [0, 0],
    images: { 1: { format: 100, width: 1, height: 1, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rS8AAAAASUVORK5CYII=' } },
  });
  assert.deepEqual(events, [], 'unchanged text does not wake before decoding finishes');
  const painted = new Promise<void>((resolve) => {
    const off = store.on('screens', () => {
      off();
      resolve();
    });
  });
  finishDecode(bitmap);
  await painted;
  assert.deepEqual(events, ['boss-shell'], 'a decoded image wakes its own screen without another WebSocket message');
  assert.equal(store.screens.get(frame.workerId)!.version, version + 1);
  assert.equal(store.screens.get(frame.workerId)!.bitmaps?.get(1)?.source, bitmap);
});
