import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { screenHistoryRows } from '../src/shared/protocol.js';
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
