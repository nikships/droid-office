import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Ghostty } from 'ghostty-web';
import { ghosttyLines } from '../src/client/term-engine/ghostty-links-lines.js';
import { contrasted } from '../src/client/term-engine/ghostty-links-appearance.js';
import { parseTerminalPathRefs } from '../src/shared/path-links.js';
import { findLine, searchKey } from '../src/shared/search.js';
import { contrastRatio } from '../src/shared/companion-themes.js';

async function core(cols: number, rows: number) {
  const bytes = await readFile(new URL(import.meta.resolve('ghostty-web/ghostty-vt.wasm')));
  return (await Ghostty.load(`data:application/wasm;base64,${bytes.toString('base64')}`)).createTerminal(cols, rows);
}

test('logical lines preserve holes, wide trailers, combining and ZWJ clusters and wrapped path cell ranges', async (t) => {
  const term = await core(20, 6);
  t.after(() => term.free());
  term.write('A\x1b[3C漢e\u0301👩‍💻 Edit src/server.ts:14\r\nshort');
  const expected = 'A   漢e\u0301👩‍💻 Edit src/server.ts:14';
  const first = ghosttyLines(term).logical(1);
  assert.equal(first.text, expected);
  assert.deepEqual(ghosttyLines(term).logical(2), first);
  const [path] = parseTerminalPathRefs(expected);
  assert.deepEqual(first.cells[path.start], { x: 16, y: 1 });
  assert.deepEqual(first.cells[path.end - 1], { x: 11, y: 2 });
  assert.deepEqual(first.cells.slice(5, 7), [
    { x: 7, y: 1 },
    { x: 7, y: 1 },
  ]);
  assert.equal(findLine(ghosttyLines(term).buffer, searchKey('漢e\u0301👩‍💻 Edit src/server.ts'), 6), 0);
  term.write('\r\n'.repeat(7));
  assert.equal(ghosttyLines(term).buffer.getLine(0)?.translateToString(true), 'A   漢e\u0301👩‍💻 Edit src/s');
});

test('find uses distance from end to disambiguate repeated hits and does not guess scrollback wraps', async (t) => {
  const term = await core(20, 4);
  t.after(() => term.free());
  term.write('disk full\r\nagain\r\ndisk      FULL\r\nlast\r\nnew');
  const { buffer } = ghosttyLines(term);
  assert.equal(findLine(buffer, 'disk full', 5), 0);
  assert.equal(findLine(buffer, 'disk full', 2), 2);
  assert.equal(findLine(buffer, 'lost hit', 1), undefined);
});

test('minimum contrast moves either ink direction and keeps already contrasting colors', () => {
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
  for (const bg of [0, 0x121212, 0x747474, 0x777777, 0xeeeeee, 0xffffff])
    for (const fg of [0, 0x171a36, 0x657575, 0x7c715d, 0xffffff]) {
      const newFg = contrasted(fg, bg, 4.5);
      assert.ok(contrastRatio(hex(newFg), hex(bg)) >= 4.5);
      if (contrastRatio(hex(fg), hex(bg)) >= 4.5) assert.equal(newFg, fg);
    }
});
