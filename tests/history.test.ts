import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { ScrollbackStore, searchTerminal, terminalTail } from '../src/server/history.js';
import { findLine, searchKey, snippet } from '../src/shared/search.js';

function dataDir(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'droid-office-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function terminal(cols = 80, rows = 10) {
  const term = new headless.Terminal({ cols, rows, scrollback: 3000, allowProposedApi: true });
  const ser = new serialize.SerializeAddon();
  term.loadAddon(ser as any);
  const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  return { term, ser, write };
}

test('a terminal tail restores its lines, colors and wrapping into a new terminal of another width', async () => {
  const a = terminal(120);
  let out = '';
  for (let i = 1; i <= 50; i++) out += `\x1b[32mline ${i}\x1b[0m\r\n`;
  out += `wrapped ${'y'.repeat(150)} END\r\n`;
  // A TUI leaves the cursor above its last line; the tail still ends after it.
  await a.write(`${out}\x1b[5A`);
  const tail = terminalTail(a.term, a.ser, 20);
  assert.ok(tail.includes('\x1b[32m'), 'keeps colors');

  const b = terminal(100);
  await b.write(`${tail}\r\nNEXT\r\n`);
  const buf = b.term.buffer.normal;
  const text: string[] = [];
  for (let y = 0; y < buf.length; y++) text.push(buf.getLine(y)!.translateToString(true));
  assert.ok(!text.includes('line 30'), 'only the last 20 lines');
  assert.ok(text.includes('line 50'));
  const next = text.indexOf('NEXT');
  assert.ok(text[next - 1].endsWith(' END'), 'what follows comes right after the old last line');
  assert.equal(searchTerminal(b.term, searchKey('yyy end'), 5).hits.length, 1, 'a wrapped line is found as one line');
});

test('scrollback saved across a restart replays into a new terminal and stays searchable', async (t) => {
  const dir = dataDir(t);
  const a = terminal(120);
  await a.write('first boot: all green\r\nfirst boot: disk full\r\n');
  new ScrollbackStore(dir).save('w1', terminalTail(a.term, a.ser, 500));

  // After a restart the kept output replays, and search finds it there.
  const kept = new ScrollbackStore(dir).load('w1');
  assert.ok(kept?.includes('disk full'));
  const b = terminal(100);
  await b.write(`${kept}\r\nsecond boot: running\r\n`);
  assert.deepEqual(
    searchTerminal(b.term, searchKey('disk full'), 10).hits.map((h) => h.text),
    ['first boot: disk full'],
  );
  new ScrollbackStore(dir).remove('w1');
  assert.equal(new ScrollbackStore(dir).load('w1'), undefined);
});

test('terminal search shows each distinct line once, newest first, and says where it is', async () => {
  const { term, write } = terminal();
  await write('status: building\r\nError: disk full\r\nstatus: building\r\nerror: DISK full again\r\n');
  const found = searchTerminal(term, searchKey('disk full'), 10);
  assert.deepEqual(
    found.hits.map((h) => h.text),
    ['error: DISK full again', 'Error: disk full'],
  );
  assert.deepEqual(
    searchTerminal(term, searchKey('status'), 10).hits.map((h) => h.text),
    ['status: building'],
  );
  // The row is where the browser's copy of the terminal looks for it again.
  const hit = found.hits[1];
  assert.equal(findLine(term.buffer.active, searchKey('disk full'), hit.rows - hit.row), hit.row);
});

test('terminal search says when more lines matched than it answers with', async () => {
  const { term, write } = terminal();
  await write('needle one\r\nneedle two\r\nneedle three\r\n');
  const capped = searchTerminal(term, searchKey('needle'), 2);
  assert.equal(capped.hits.length, 2);
  assert.equal(capped.more, true);
  assert.equal(searchTerminal(term, searchKey('needle'), 10).more, false);
});

test('snippets cut long lines down around the match', () => {
  const long = `${'a '.repeat(200)}NEEDLE${' b'.repeat(200)}`;
  const s = snippet(long, 'needle', 60);
  assert.ok(s.includes('NEEDLE'));
  assert.ok(s.startsWith('…') && s.endsWith('…'));
  assert.ok(s.length <= 62);
});

test('scrollback files are per worker, and pruning keeps only workers still at a desk', (t) => {
  const store = new ScrollbackStore(dataDir(t));
  store.save('aaa', 'one');
  store.save('bbb', 'two');
  store.save('../evil', 'nope');
  store.prune(new Set(['aaa']));
  assert.equal(store.load('aaa'), 'one');
  assert.equal(store.load('bbb'), undefined);
  assert.equal(store.load('../evil'), undefined);
  store.remove('aaa');
  assert.equal(store.load('aaa'), undefined);
});
