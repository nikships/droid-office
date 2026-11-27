import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import headless from '@xterm/headless';
import { Ghostty, type GhosttyTerminal } from 'ghostty-web';
import { GraphicsRows } from '../src/client/term-engine/ghostty-graphics-rows.js';

const cs = '\x1b[';
const modes = [1, 7, 9, 12, 25, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1015, 1016, 2004, 2027];
const binary = await readFile(new URL(import.meta.resolve('ghostty-web/ghostty-vt.wasm')));
const load = async (cols: number, rows: number) => (await Ghostty.load(`data:application/wasm;base64,${binary.toString('base64')}`)).createTerminal(cols, rows, { scrollbackLimit: 5000 });
const rowName = (i: number) => `R${i.toString(36).padStart(4, '0')}`;
function contents(core: GhosttyTerminal, index: number) {
  const history = core.getScrollbackLength();
  const cells = index < history ? core.getScrollbackLine(index) : core.getLine(index - history);
  return cells
    ?.map((c) => String.fromCodePoint(c.codepoint || 32))
    .join('')
    .trimEnd();
}
function feed(core: GhosttyTerminal, rows: GraphicsRows, s: string) {
  rows.begin(s);
  core.write(s);
  rows.end();
}

test('line and display erases cancel the last-cell wrap without moving neighbouring image rows', async (t) => {
  const core = await load(40, 8);
  t.after(() => core.free());
  for (const wrap of ['h', 'l'])
    for (const erase of ['K', '0K', '1K', '2K', 'J', '0J', '1J']) {
      const setup = `\x1bcR0000\r\nUNIQUE\r\nR0002${cs}2;1H`;
      core.write(setup);
      const rows = new GraphicsRows(core),
        marker = rows.anchor()!;
      const data = `${cs}?7${wrap}${'x'.repeat(40)}${cs}${erase}${cs}?7hY`;
      feed(core, rows, `${cs}8;1H`);
      feed(core, rows, data);
      if (erase === '2K' || erase === 'J') {
        const xt = new headless.Terminal({ cols: 40, rows: 8, allowProposedApi: true });
        await new Promise<void>((r) => xt.write(setup, r));
        const ref = xt.registerMarker(0)!;
        await new Promise<void>((r) => xt.write(`${cs}8;1H${data}`, r));
        assert.equal(marker.line, ref.line);
        xt.dispose();
      }
      assert.deepEqual([core.getScrollbackLength(), core.getCursor().y, marker.line], [0, 7, 1], `${wrap} ${erase}`);
      if (erase !== '1J')
        assert.deepEqual(
          [0, 1, 2].map((i) => contents(core, i)),
          ['R0000', 'UNIQUE', 'R0002'],
        );
    }
});

test('pending-wrap control classification on the pinned WASM', async (t) => {
  const core = await load(40, 8);
  t.after(() => core.free());
  const preserving = ['\t', `${cs}m`, `${cs}31m`, ...['0;title', '1;title', '2;title', '7;file:///local', '8;;https://example.invalid', '133;A'].map((s) => `\x1b]${s}\x07`)];
  const clearing = ['\r', '\b', '\n', '\v', '\f', ...['K', '0K', '1K', '2K', 'J', '0J', '1J', 'C', 'D', '40G', 'G', '40`', '`'].map((s) => cs + s)];
  for (const on of ['h', 'l'])
    for (const seq of [...preserving, ...clearing, ...modes.flatMap((m) => ['h', 'l'].map((op) => `${cs}?${m}${op}`))]) {
      const pre = seq.startsWith(`${cs}?`) && !seq.startsWith(`${cs}?7`) ? seq.slice(0, -1) + (seq.endsWith('h') ? 'l' : 'h') : '';
      core.write(`\x1bc${pre}${cs}?7${on}${cs}8;1H${'x'.repeat(40)}${seq}`);
      assert.equal(core.getCursor().y, 7);
      const history = core.getScrollbackLength();
      assert.equal(history, Number(['\n', '\v', '\f'].includes(seq)));
      core.write(`${cs}?7hY`);
      assert.equal(core.getScrollbackLength() - history, Number(!clearing.includes(seq)), JSON.stringify({ on, seq }));
    }
});

test('seeded physical row identity survives or the direct image is dropped', async (t) => {
  const seed = Number(process.env.ROW_SEED ?? 0x76cb9d11) >>> 0;
  const cases = Number(process.env.ROW_CASES ?? 8192);
  t.diagnostic(`seed ${seed}, ${cases} cases`);
  assert.ok(Number.isSafeInteger(cases) && cases > 0 && cases % 4 === 0);
  // Invalid combining positions and the unsupported native mode are deliberate fuzz
  // inputs. Summarize only their two expected messages; preserve every other log.
  const log = console.log;
  let nativeNotices = 0;
  t.mock.method(console, 'log', (...args: unknown[]) => {
    if (args[0] === '[ghostty-vt]' && (args[1] === 'warning(terminal): zero-width character with no prior character, ignoring' || args[1] === 'warning(stream): unimplemented mode: 1001')) nativeNotices++;
    else log(...args);
  });
  let state = seed,
    checked = 0,
    kept = 0,
    evictions = 0,
    overwritten = 0,
    retainedAfterEviction = 0,
    evictedMarkers = 0;
  const pick = (n: number) => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * n);
  };
  const alphabet = ['é', '日本', '👩‍💻', 'e\u0301', '\t', '\r', '\n', '\v', '\f', '\b', ...['K', '0K', '1K', '2K', 'J', '0J', '1J', '?7h', '?7l', '0m', '38;2;190;30;5m', 'C', '3D', '1G', '1`'].map((s) => cs + s), '\x1b]2;row test\x07'];
  for (const [cols, height] of [
    [8, 4],
    [20, 6],
    [40, 8],
    [80, 24],
  ]) {
    const core = await load(cols, height);
    t.after(() => core.free());
    let firstEviction = 0;
    let history = 0;
    while (firstEviction < 20000) {
      core.write('r\r\n');
      firstEviction++;
      const next = core.getScrollbackLength();
      if (next < history) break;
      history = next;
    }
    assert.ok(firstEviction < 20000);
    // Old history rows are immutable under this alphabet. Their labels give an
    // independent row identity even when ED or an overwrite removes the anchor's text.
    const numbered = Array.from({ length: firstEviction + height + 1 }, (_, i) => rowName(i));
    const normal = numbered.slice(0, height * 2).join('\r\n');
    const tail = numbered.slice(height * 2, firstEviction - 1).join('\r\n');
    const near = `${normal}\r\n${tail}`;
    for (let n = 0; n < cases / 4; n++) {
      const atCap = n % 64 === 0;
      const oldMarker = atCap && n % 128 === 0;
      core.write(`\x1bc${atCap && !oldMarker ? near : normal}`);
      const base = core.getScrollbackLength();
      const row = pick(height);
      const origin = base + row;
      core.write(`${cs}${row + 1};1H`);
      assert.equal(contents(core, origin), rowName(origin));
      const rows = new GraphicsRows(core),
        marker = rows.anchor()!;
      if (oldMarker) {
        feed(core, rows, `${cs}${height};1H`);
        feed(core, rows, `\r\n${tail}`);
      }
      const y = pick(2) ? height - 1 : pick(height),
        x = pick(2) ? cols - 1 : pick(cols),
        pending = x === cols - 1 && pick(2) > 0;
      feed(core, rows, `${cs}${y + 1};${pending ? cols - 1 : x + 1}H`);
      if (pending) feed(core, rows, 'xx');
      assert.equal(marker.line, origin);
      const spans: string[] = [];
      const limit = 1 + pick(4);
      for (let j = 0; j < limit; j++) {
        let s = '';
        const tokens = 1 + pick(10);
        for (let k = 0; k < tokens; k++) {
          const kind = pick(12);
          if (kind < 3) s += 'x'.repeat(1 + pick(2 * cols));
          else if (kind === 3) s += `${cs}?${modes[pick(modes.length)]}${pick(2) ? 'h' : 'l'}`;
          else if (kind === 4) s += cs + (1 + pick(cols)) + ['C', 'D', 'G', '`'][pick(4)];
          else if (kind === 5 && !pick(4)) s += cs + ['A', 'B', `${1 + pick(height)};1H`][pick(3)];
          else s += alphabet[pick(alphabet.length)];
        }
        if (atCap && j === 0) s += '\r\n'.repeat(height + 1);
        if (spans.at(-1)?.endsWith('x') && n % 4 === 0) s = `\u0301${s}`;
        spans.push(s);
      }
      for (const [j, s] of spans.entries()) {
        feed(core, rows, s);
        const first = contents(core, 0)!;
        assert.match(first, /^R[0-9a-z]{4}$/);
        const trimmed = parseInt(first.slice(1), 36);
        const expected = origin - trimmed;
        if (j === spans.length - 1 && trimmed) {
          evictions++;
          if (expected < 0) evictedMarkers++;
          if (!marker.isDisposed) retainedAfterEviction++;
        }
        checked++;
        if (marker.isDisposed) continue;
        kept++;
        assert.equal(marker.line, expected, JSON.stringify({ seed, n, cols, height, origin, x, y, pending, first, j, spans, actual: marker.line, actualText: contents(core, marker.line) }));
        if (contents(core, expected) !== rowName(origin)) overwritten++;
      }
      marker.dispose();
    }
  }
  assert.ok(evictedMarkers > 0 && retainedAfterEviction > 0 && overwritten > 0, `seed ${seed}`);
  t.diagnostic(JSON.stringify({ seed, cases, checked, kept, overwritten, evictions, retainedAfterEviction, evictedMarkers, nativeNotices }));
});
