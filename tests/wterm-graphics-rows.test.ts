import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { GhosttyCore } from '@wterm/ghostty';
import headless from '@xterm/headless';
import { graphicsAnchors, placeholderCells } from '../src/client/term-engine/wterm-graphics-cells.js';
import { KITTY_DIACRITICS, KITTY_PLACEHOLDER_CHAR } from '../src/shared/kitty.js';
import { VtScanner } from '../src/shared/vt-scanner.js';

const wasmPath = `data:application/wasm;base64,${(await readFile(new URL(import.meta.resolve('@wterm/ghostty/ghostty-vt.wasm')))).toString('base64')}`;
const cs = '\x1b[';
const ph = KITTY_PLACEHOLDER_CHAR;
const load = async (cols: number, rows: number) => {
  const c = await GhosttyCore.load({ wasmPath, scrollbackLines: 16, imageStorageLimit: 0 });
  c.init(cols, rows);
  return c;
};

test('tracks follow history and reflow, reserve four slots and refuse to resurrect unobserved pins', async () => {
  const core = await load(24, 6);
  const anchors = graphicsAnchors(core, new VtScanner());
  try {
    core.writeString('long line that wraps twice with a narrower grid\r\nHERE');
    const pinned = anchors.anchor()!;
    const rest = Array.from({ length: 59 }, () => anchors.anchor());
    assert.ok(rest.every(Boolean));
    assert.equal(anchors.anchor(), undefined);
    const other = Array.from({ length: 4 }, () => core.trackPosition({ row: 0, col: 0 }));
    assert.ok(other.every(Boolean));
    assert.equal(core.trackPosition({ row: 0, col: 0 }), null);
    for (const h of other) h!.dispose();
    rest[0]!.dispose();
    assert.ok(anchors.anchor());
    core.writeString('\r\n'.repeat(8));
    core.resize(12, 6);
    assert.equal(core.getScrollbackCell(core.getScrollbackCount() - pinned.line - 1, 0).char, 72);
    core.writeString('\x1b[?1049h\x1b[?1049l');
    assert.equal(pinned.line, -1);
  } finally {
    anchors.dispose();
    core.dispose();
  }
});

test('saved normal pins respect deletion, app-driven resize and margins left by the alternate program', async () => {
  const core = await load(20, 6);
  const parser = new VtScanner();
  const anchors = graphicsAnchors(core, parser);
  const write = (s: string) =>
    parser.write(s, (data) => {
      core.writeString(data);
      anchors.parsed();
    });
  try {
    write('history');
    const old = anchors.anchor()!;
    write(`${'\r\n'.repeat(9)}live`);
    const live = anchors.anchor()!,
      deleted = anchors.anchor()!;
    write(`${cs}?1049h${cs}2;4r`);
    deleted.dispose();
    write(`${cs}?1049l`);
    assert.deepEqual([old.line, live.line, deleted.line], [0, -1, -1]);
    write(`${cs}r${cs}?47h${cs}?40h${cs}?3h${cs}?3l${cs}?47l`);
    assert.equal(old.line, -1);
    write(`${cs}?47s`);
    const implicit = anchors.anchor()!;
    write(`${cs}?47h${cs}?47r${cs}?47h${cs}?47l`);
    assert.equal(implicit.line, -1);
  } finally {
    anchors.dispose();
    core.dispose();
  }
});

test('a restored pin cannot survive an ambiguous right-edge ED0 followed by xterm erasing its marker', async () => {
  const core = await load(8, 4),
    xt = new headless.Terminal({ cols: 8, rows: 4, allowProposedApi: true });
  const parser = new VtScanner(),
    anchors = graphicsAnchors(core, parser);
  const write = async (s: string) => {
    parser.write(s, (data) => {
      core.writeString(data);
      anchors.parsed();
    });
    await new Promise<void>((done) => xt.write(s, done));
  };
  try {
    await write(`FIRST\r\nUNIQUE${cs}2;1H`);
    const pin = anchors.anchor()!,
      ref = xt.registerMarker(0)!;
    await write(`${cs}2;5H${cs}?1049h${cs}?1049l`);
    assert.equal(pin.line, ref.line);
    await write(`\te\u0301${cs}?1000l${cs}0Je\u0301${cs}1K\r${cs}1J${cs}1K`);
    assert.deepEqual([pin.line, ref.line], [-1, -1]);
  } finally {
    anchors.dispose();
    core.dispose();
    xt.dispose();
  }
});

test('live and history placeholders retain graphemes, inherited column and RGB underline placement ID; palette indices are unavailable', async () => {
  const core = await load(20, 4);
  try {
    core.writeString(`${cs}38;2;0;2;3;58;2;1;2;3m${ph}${String.fromCodePoint(KITTY_DIACRITICS[2], KITTY_DIACRITICS[3])}${ph}`);
    for (const data of ['', '\r\n'.repeat(5)]) {
      core.writeString(data);
      const cells = placeholderCells(core, 0).map!;
      assert.deepEqual(
        [...cells.values()].map(({ imageId, placementId, row, col }) => [imageId, placementId, row, col]),
        [
          [515, 66051, 2, 3],
          [515, 66051, 2, 4],
        ],
      );
    }
    core.writeString(`\x1bc${cs}38;5;196;58;5;196m${ph}${cs}38;2;255;0;0;58;2;255;0;0m${ph}`);
    assert.deepEqual(core.getCell(0, 0), core.getCell(0, 1));
  } finally {
    core.dispose();
  }
});

test('seeded direct-placement row identity against real xterm markers', async (t) => {
  const cases = Number(process.env.ROW_CASES ?? 512);
  const seed = Number(process.env.ROW_SEED ?? 0x76cb9d11);
  let state = seed;
  const pick = (n: number) => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * n);
  };
  let kept = 0,
    xtermKept = 0,
    overwritten = 0,
    trimmed = 0;
  const osc = (cmd: string) => `\x1b]909;${cmd}\x07`;
  for (const [cols, height] of [
    [8, 4],
    [20, 6],
    [40, 8],
    [80, 24],
  ]) {
    const core = await load(cols, height);
    const xt = new headless.Terminal({ cols, rows: height, scrollback: 16, allowProposedApi: true });
    // A second xterm keeps the entire short case. Its marker gives a physical
    // row independent of differences in the number of rows the cores trimmed.
    const untrimmed = new headless.Terminal({ cols, rows: height, scrollback: 1000, allowProposedApi: true });
    const parser = new VtScanner();
    const anchors = graphicsAnchors(core, parser);
    const write = (s: string) =>
      parser.write(s, (data) => {
        core.writeString(data);
        anchors.parsed();
      });
    const expected: { row: number; text: string }[] = [];
    const physical: number[] = [];
    let witness: ReturnType<typeof xt.registerMarker>;
    untrimmed.parser.registerOscHandler(909, (cmd) => {
      if (cmd === 'mark') witness = untrimmed.registerMarker(0);
      else {
        physical.push(witness!.line);
        witness!.dispose();
      }
      return true;
    });
    let marker: ReturnType<typeof xt.registerMarker>;
    xt.parser.registerOscHandler(909, (cmd) => {
      if (cmd === 'mark') marker = xt.registerMarker(0);
      else {
        expected.push({ row: marker!.line, text: xt.buffer.active.getLine(marker!.line)?.translateToString(true) ?? '' });
        marker!.dispose();
      }
      return true;
    });
    try {
      for (let start = 0; start < cases / 4; start += 128) {
        const batch = Array.from({ length: Math.min(128, cases / 4 - start) }, () => {
          const labels = Array.from({ length: height + 1 + pick(15) }, (_, i) => `R${i.toString(36).padStart(3, '0')}`).join('\r\n');
          const row = 1 + pick(height);
          const before = `\x1bc${cs}?2027l${labels}${cs}${row};1H`;
          const pos = `${cs}${pick(2) ? height : 1 + pick(height)};${pick(2) ? cols : 1 + pick(cols)}H`;
          const tokens = [
            'e\u0301',
            'ö\b!',
            '界',
            '\t',
            '\r',
            '\n',
            '\v',
            '\f',
            '\b',
            'x'.repeat(pick(cols * 2) + 1),
            '\x1b]2;title\x07',
            // xterm 6's ED1 throws when issued at the last column of the final live row with history.
            `\r${cs}1J`,
            ...['K', '1K', '2K', '0J', '31m', '0m', '1G', '3C', '2D', '?7l', '?7h', '?1000h', '?1000l'].map((s) => cs + s),
          ];
          const spans = Array.from({ length: 1 + pick(10) }, () => tokens[pick(tokens.length)]);
          const special = ['', '', '\r\n'.repeat(1 + pick(33)), `${cs}2;${height}r${cs}${height};1H\n`, `${cs}2S`, `${cs}T`, `${cs}2L`, `${cs}M`, `${cs}2J`, '\x1bM', `${cs}?1049h${cs}?1049l`];
          spans.splice(pick(spans.length), 0, special[pick(special.length)]);
          return { before, after: pos + spans.join('') };
        });
        // OSC boundaries let xterm register/read a real marker synchronously
        // inside its parser, without a timer per fuzz case.
        const stream = batch.map(({ before, after }) => before + osc('mark') + after + osc('check')).join('');
        await Promise.all([xt, untrimmed].map((term) => new Promise<void>((done) => term.write(stream, done))));
        for (const [i, { before, after }] of batch.entries()) {
          anchors.reset();
          write(before);
          const pin = anchors.anchor()!;
          const discarded = core.getScrollbackDiscardedCount();
          write(after);
          const ref = expected[i];
          if (ref.row >= 0) xtermKept++;
          if (core.getScrollbackDiscardedCount()) trimmed++;
          if (pin.line >= 0) {
            const detail = JSON.stringify({ seed, cols, n: start + i, before, after, ref, actual: pin.line });
            const offset = core.getScrollbackCount() - pin.line - 1;
            let text = '';
            for (let col = 0; col < cols; col++) {
              const c = offset < 0 ? core.getCell(-offset - 1, col) : core.getScrollbackCell(offset, col);
              if (c.width !== 0) text += c.chars ?? String.fromCodePoint(c.char);
            }
            // The original unique row labels, not matching numeric indices
            // alone, catch moved content; a VT erase can deliberately replace one.
            assert.ok(ref.row >= 0, detail);
            // The cores disagree on some right-margin writes after ED/EL. A
            // differing glyph or number of trimmed rows is not a different
            // physical row: normalize the retained coordinates by actual trims.
            assert.equal(pin.line + core.getScrollbackDiscardedCount() - discarded, physical[i], detail);
            const label = (s: string) => s.match(/^R[0-9a-z]{3}/)?.[0];
            if (label(text) && label(ref.text)) assert.equal(label(text), label(ref.text), detail);
            if (!ref.text.startsWith('R')) overwritten++;
            kept++;
          }
          pin.dispose();
        }
        expected.length = 0;
        physical.length = 0;
      }
    } finally {
      anchors.dispose();
      core.dispose();
      xt.dispose();
      untrimmed.dispose();
    }
  }
  assert.ok(kept && xtermKept && overwritten && trimmed);
  t.diagnostic(JSON.stringify({ seed, cases, kept, xtermKept, overwritten, trimmed }));
});
