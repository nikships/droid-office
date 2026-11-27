import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import unicode from '@xterm/addon-unicode11';
import { Ghostty } from 'ghostty-web';

// The shipped WASM, via Ghostty.load's public URL API. No browser globals or fake terminal.
const binary = new URL(import.meta.resolve('ghostty-web/ghostty-vt.wasm'));
test('actual headless Unicode 11 attach snapshots replay in the Ghostty core', async (t) => {
  const url = `data:application/wasm;base64,${(await readFile(binary)).toString('base64')}`;
  for (const [label, bytes, serverX, ghostX] of [
    ['VT cursor moves and styled text', 'alpha\r\n\x1b[32mbravo\x1b[0m\x1b[2DZ', 4, 4],
    ['CJK', 'A漢B', 4, 4],
    ['combining mark', 'e\u0301', 1, 1],
    ['ZWJ', '👩‍💻', 4, 4],
    ['mixed precomposed text', 'A漢é👩‍💻!', 9, 9],
    ['mixed combining text', 'A漢e\u0301👩‍💻!', 9, 9],
    ['flag width divergence', '🇺🇸', 2, 4],
    ['skin tone', '👍🏽', 4, 4],
    ['variation selector', '❤️', 1, 1],
  ] as const)
    await t.test(label, async () => {
      const server = new headless.Terminal({ cols: 40, rows: 8, allowProposedApi: true });
      const snapshot = new serialize.SerializeAddon();
      server.loadAddon(snapshot);
      server.loadAddon(new unicode.Unicode11Addon());
      server.unicode.activeVersion = '11';
      const ghost = (await Ghostty.load(url)).createTerminal(40, 8);
      try {
        await new Promise<void>((done) => server.write(bytes, done));
        ghost.write('\x1b[?2027l');
        ghost.write(snapshot.serialize());
        ghost.update();
        assert.equal(server.buffer.active.cursorX, serverX);
        assert.equal(ghost.getCursor().x, ghostX);
        assert.equal(ghost.getCursor().y, server.buffer.active.cursorY);
        if (label === 'VT cursor moves and styled text')
          for (let row = 0; row < 8; row++) {
            const line = (ghost.getLine(row) ?? [])
              .map((c) => String.fromCodePoint(c.codepoint || 32))
              .join('')
              .trimEnd();
            assert.equal(line, server.buffer.active.getLine(row)?.translateToString(true));
          }
      } finally {
        ghost.free();
        server.dispose();
      }
    });
});
