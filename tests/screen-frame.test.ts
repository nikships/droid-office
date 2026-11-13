import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import unicode11 from '@xterm/addon-unicode11';
import { KITTY_DIACRITICS, KITTY_PLACEHOLDER_CHAR } from '../src/shared/kitty.js';
import { screenHistoryRows } from '../src/shared/protocol.js';
import { plainTail, searchTerminal } from '../src/server/history.js';
import { screenSnapshot } from '../src/server/screen.js';
import { snapshotScreen } from '../src/server/screen-frame.js';

function terminal(cols: number, rows: number) {
  const term = new headless.Terminal({ cols, rows, scrollback: 200, allowProposedApi: true });
  const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  return { term, write };
}

const numbered = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `line ${from + i}`).join('\r\n');
const texts = (rows: [string, number, number, number][][] | undefined) => rows?.map((runs) => runs.map((r) => r[0]).join(''));

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

    // Changing text or cursor bumps version once and notifies listeners.
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
