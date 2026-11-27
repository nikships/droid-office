import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { Ghostty } from 'ghostty-web';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { createServer } from 'vite';
import { GraphicsRows, placeholderRow } from '../src/client/term-engine/ghostty-graphics-rows.js';
import { KITTY_DIACRITICS, KITTY_PLACEHOLDER_CHAR } from '../src/shared/kitty.js';
import { screenSnapshot } from '../src/server/screen.js';
import { VtScanner } from '../src/shared/vt-scanner.js';
import { browserStatus, closeBrowser, launchBrowser } from '../src/server/whiteboard-browser.js';

const apc = (body: string) => `\x1b_G${body}\x1b\\`;
const cell = (r: number, c: number) => KITTY_PLACEHOLDER_CHAR + String.fromCodePoint(KITTY_DIACRITICS[r], KITTY_DIACRITICS[c]);

test('the zsh prompt preserves a placed image above the cursor on real WASM', async (t) => {
  const binary = await readFile(new URL(import.meta.resolve('ghostty-web/ghostty-vt.wasm')));
  const core = (await Ghostty.load(`data:application/wasm;base64,${binary.toString('base64')}`)).createTerminal(111, 36, { scrollbackLimit: 1000 });
  t.after(() => core.free());
  const rows = new GraphicsRows(core);
  const write = (data: string) => {
    rows.begin(data);
    core.write(data);
    rows.end();
  };
  write(`${'row\r\n'.repeat(500)}\x1b[2J\x1b[HInline PNG\r\n`);
  const image = rows.anchor()!;
  write('\r\n'.repeat(11));
  assert.deepEqual([core.getScrollbackLength(), core.getCursor().y, image.line], [465, 12, 466]);
  write('\r\n'.repeat(23));
  assert.equal(core.getCursor().y, 35);
  // zsh paints a reverse-video %, pads the row, then erases below its prompt.
  write(`\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m${' '.repeat(110)}\r \r`);
  for (const ed of ['\x1b[J', '\x1b[0J', '\x1b[1J']) {
    write(`\r\x1b[0m\x1b[27m\x1b[24m${ed}user@host droid-office % \x1b[K`);
    write('\x1b[?2004h');
    assert.equal(image.line, 466, JSON.stringify(ed));
  }
  for (const [control, expected] of [
    ['', 1],
    ['\r', 0],
    ['\n', 1],
    ['\b', 0],
  ] as const) {
    const history = core.getScrollbackLength();
    write(`\r${'x'.repeat(110)}`);
    write('x'); // Transport split immediately before and after filling the margin.
    write(`${control}Y`);
    assert.equal(core.getScrollbackLength() - history, expected);
    assert.equal(image.line, 466);
  }
});

test('autowrap changes do not invent a row trim for an image anchor', async (t) => {
  const binary = await readFile(new URL(import.meta.resolve('ghostty-web/ghostty-vt.wasm')));
  const core = (await Ghostty.load(`data:application/wasm;base64,${binary.toString('base64')}`)).createTerminal(40, 8);
  t.after(() => core.free());
  const rows = new GraphicsRows(core);
  const write = (data: string) => {
    rows.begin(data);
    core.write(data);
    rows.end();
  };
  write('\r\n');
  const image = rows.anchor()!;
  const text = 'a'.repeat(41);
  for (const chunks of [[`\x1b[?7l${text}\x1b[?7h`], ['\r\x1b[?7l', text], ['\r', `${text}\x1b[?25;7h`]]) {
    for (const chunk of chunks) write(chunk);
    assert.deepEqual([core.getCursor().y, core.getScrollbackLength(), image.line], [1, 0, 1]);
  }
  write('\r\n'.repeat(6));
  write('\x1b[?7lX\x1b[?7h');
  assert.deepEqual([core.getCursor().y, core.getScrollbackLength(), image.line], [7, 0, 1]);
  write(`\r\x1b[?7l${'x'.repeat(40)}`);
  write('\x1b[?7hY'); // Printing the last cell sets pending wrap even with DECAWM disabled.
  assert.deepEqual([core.getCursor().x, core.getScrollbackLength(), image.line], [1, 1, 1]);
});

test('Unicode prompts and output keep direct image rows at the bottom and mid-screen like xterm', async (t) => {
  const binary = await readFile(new URL(import.meta.resolve('ghostty-web/ghostty-vt.wasm')));
  const inputs = ['➜  droid-office git:(main) ', 'héllo wörld\r\n'.repeat(5), '日本語のテキスト\r\n'.repeat(3), '\r\x1b[K❯ '];
  for (const y of [23, 11]) {
    const actual = [];
    const expected = [];
    for (const input of inputs) {
      const core = (await Ghostty.load(`data:application/wasm;base64,${binary.toString('base64')}`)).createTerminal(80, 24, { scrollbackLimit: 5000 });
      const xt = new headless.Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
      const rows = new GraphicsRows(core);
      const write = async (s: string) => {
        rows.begin(s);
        core.write(s);
        rows.end();
        await new Promise<void>((r) => xt.write(s, r));
      };
      await write('\r\n'.repeat(y - 5));
      const marker = rows.anchor()!,
        ref = xt.registerMarker(0)!;
      await write('\r\n'.repeat(5));
      await write(input);
      actual.push([core.getCursor().y, core.getScrollbackLength(), marker.line]);
      expected.push([xt.buffer.active.cursorY, xt.buffer.active.baseY, ref.line]);
      if (input === inputs[0] && y === 23) {
        // Real zsh echo backs up over the first typed character before drawing the rest.
        await write('r');
        await write("\brepeat 5 print 'héll");
        assert.equal(marker.line, ref.line, 'Unicode command echo after leading backspace');
      }
      xt.dispose();
      core.free();
    }
    t.diagnostic(JSON.stringify({ y, ghostty: actual, xterm: expected }));
    await t.test(`start row ${y}`, () => assert.deepEqual(actual, expected));
  }
});

test('tabular output and horizontal command edits keep the bottom-row image marker like xterm', async (t) => {
  const binary = await readFile(new URL(import.meta.resolve('ghostty-web/ghostty-vt.wasm')));
  // Captured from an 80×24 macOS PTY: /bin/ls src/client/term-engine and /bin/zsh -dfi
  // with bindkey -e. Up recalls the command, Ctrl-A/Meta-f move inside it, X inserts.
  const listing =
    'features.ts\t\t\tghostty-runtime.ts\r\nghostty-graphics-rows.ts\tghostty-scroll-wheel.ts\r\nghostty-graphics.ts\t\tghostty-scroll.ts\r\nghostty-keys.ts\t\t\tghostty.ts\r\nghostty-links-appearance.ts\tindex.ts\r\nghostty-links-find.ts\t\ttypes.ts\r\nghostty-links-lines.ts\t\txterm-find.ts\r\nghostty-links.ts\r\n';
  const recall = 'print alpha beta gamma delta epsilon zeta eta theta';
  const edit = ['\x1b[51D', '\x1b[6C', 'Xalpha beta gamma delta epsilon zeta eta theta\x1b[45D', '\x1b[1C', '\x1b[44C'];
  const cases: [string, string[], boolean][] = [
    ['printf', Array<string>(3).fill('a\tb\tc\r\n'), true],
    ['ls', [listing], true],
    ['recall', [recall], true],
    ['edit', [recall, ...edit], true],
    ['progress', Array.from({ length: 10 }, (_, i) => `\rprogress ${i + 1}/10\x1b[K`), true],
    ['CUF/CUB/CHA/HPA', ['\x1b[30Cfoo\x1b[3Dbar\x1b[31Gbaz\x1b[31`foo'], true],
    ['cursor up', ['\x1b[Aline repaint\x1b[K'], false],
    ['absolute position', ['\x1b[18;1Hline repaint\x1b[K'], false],
    ['existing continuation', ['x'.repeat(81), 'é'], false],
    ['reverse CUB', ['\x1b[3Dpaint'], false],
  ];
  const results = [];
  for (const [name, chunks] of cases) {
    const core = (await Ghostty.load(`data:application/wasm;base64,${binary.toString('base64')}`)).createTerminal(80, 24, { scrollbackLimit: 5000 });
    const xt = new headless.Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
    const rows = new GraphicsRows(core);
    const write = async (s: string) => {
      rows.begin(s);
      core.write(s);
      rows.end();
      await new Promise<void>((r) => xt.write(s, r));
    };
    if (name === 'reverse CUB') await write('\x1b[?1045h');
    await write('\r\n'.repeat(18));
    const image = rows.anchor()!,
      marker = xt.registerMarker(0)!;
    await write('\r\n'.repeat(5));
    if (name === 'edit' || name === 'recall') await write('% ');
    for (const chunk of chunks) await write(chunk);
    results.push({ name, ghostty: image.line, xterm: marker.line });
    assert.equal(marker.line, 18);
    xt.dispose();
    core.free();
  }
  t.diagnostic(JSON.stringify(results));
  assert.deepEqual(
    results.map((r) => r.ghostty),
    cases.map((c) => (c[2] ? 18 : -1)),
  );
});

test('a Unicode line crossing the native trim boundary keeps only the correct numbered row', async (t) => {
  const binary = await readFile(new URL(import.meta.resolve('ghostty-web/ghostty-vt.wasm')));
  const core = (await Ghostty.load(`data:application/wasm;base64,${binary.toString('base64')}`)).createTerminal(80, 24, { scrollbackLimit: 5000 });
  t.after(() => core.free());
  const rows = new GraphicsRows(core);
  const write = (s: string) => {
    rows.begin(s);
    core.write(s);
    rows.end();
  };
  // Discover a real page eviction instead of assuming the configured limit is in lines.
  let previous = 0;
  for (let i = 0; i < 6000; i++) {
    write('fill\r\n');
    const current = core.getScrollbackLength();
    if (current < previous) break;
    previous = current;
  }
  assert.ok(core.getScrollbackLength() < previous);
  write('UNIQUE');
  const kept = rows.anchor()!;
  write('\r\n');
  for (let i = 0; i < 6000 && core.getScrollbackLength() < previous; i++) write('fill\r\n');
  assert.equal(core.getScrollbackLength(), previous);
  const before = core.getScrollbackLength();
  write('日本語\r\n');
  assert.ok(core.getScrollbackLength() < before);
  assert.equal(
    core
      .getScrollbackLine(kept.line)
      ?.slice(0, 6)
      .map((c) => String.fromCodePoint(c.codepoint))
      .join(''),
    'UNIQUE',
  );
  // At eviction, a wide glyph wraps from the last cell. The following five hard
  // breaks put that wrap at the farthest row the tab-aware proof needs to inspect.
  for (const [data, continuation] of [
    ['日', 23],
    [`\t日${'\r\n'.repeat(5)}`, 18],
  ] as const) {
    const uncertain = rows.anchor()!;
    for (let i = 0; i < 6000 && core.getScrollbackLength() < previous; i++) write('fill\r\n');
    assert.equal(core.getScrollbackLength(), previous);
    write('x'.repeat(79));
    write(data);
    assert.ok(core.getScrollbackLength() < previous);
    assert.ok(core.isRowWrapped(continuation));
    assert.ok(uncertain.isDisposed);
  }
});

test('ED2 and ED3 handle screen and history image markers like xterm clear', async (t) => {
  const binary = await readFile(new URL(import.meta.resolve('ghostty-web/ghostty-vt.wasm')));
  for (const command of ['\x1b[2J', '\x1b[3J', '\x1b[H\x1b[2J\x1b[3J']) {
    const server = new headless.Terminal({ cols: 111, rows: 36, allowProposedApi: true });
    const core = (await Ghostty.load(`data:application/wasm;base64,${binary.toString('base64')}`)).createTerminal(111, 36, { scrollbackLimit: 1000 });
    t.after(() => {
      core.free();
      server.dispose();
    });
    const rows = new GraphicsRows(core);
    const scanner = new VtScanner();
    scanner.registerCsiHandler({ final: 'J' }, ([mode]) => {
      if (mode !== 2 && mode !== 3) return false;
      rows.erase(mode, () => core.write(`\x1b[${mode}J`));
      return true;
    });
    const write = async (data: string) => {
      await new Promise<void>((resolve) => server.write(data, resolve));
      rows.begin(data);
      scanner.write(data, (chunk) => core.write(chunk));
      rows.end();
    };
    await write('image\r\n');
    const historic = [rows.anchor()!, server.registerMarker(0)!];
    await write('row\r\n'.repeat(500));
    const visible = [rows.anchor()!, server.registerMarker(0)!];
    await write(command);
    for (const [ghost, xterm] of [historic, visible]) assert.equal(ghost.line, xterm.line, JSON.stringify(command));
  }
});

test('actual WASM rows follow identical output across history growth and page trims; uncertain reflow drops direct anchors', async (t) => {
  const binary = await readFile(new URL(import.meta.resolve('ghostty-web/ghostty-vt.wasm')));
  const core = (await Ghostty.load(`data:application/wasm;base64,${binary.toString('base64')}`)).createTerminal(40, 8, { scrollbackLimit: 10 });
  t.after(() => core.free());
  const rows = new GraphicsRows(core);
  const write = (data: string) => {
    rows.begin(data);
    core.write(data);
    rows.end();
  };
  write('label');
  const first = rows.anchor()!;
  write('\r\nrepeat\r\n');
  assert.equal(first.line, 0);
  core.resize(48, 8);
  rows.resized();
  assert.equal(first.line, 0, 'safe width change, no wrapped lines or history');
  write('repeat\r\n'.repeat(100));
  assert.equal(first.line, 0);
  assert.equal(core.getScrollbackLine(first.line)?.[0].codepoint, 108);
  // Force a real trim: the pinned core's page budget is not the configured number of rows.
  write('repeat\r\n'.repeat(100_000));
  assert.ok(first.isDisposed);
  write('UNIQUE');
  const next = rows.anchor()!;
  write(`\r\n${'repeat\r\n'.repeat(700)}`);
  assert.equal(
    core
      .getScrollbackLine(next.line)
      ?.slice(0, 6)
      .map((c) => String.fromCodePoint(c.codepoint))
      .join(''),
    'UNIQUE',
  );
  await t.test('unchanged column count keeps absolute anchors on height growth and shrink', () => {
    const original = next.line;
    for (const height of [12, 6]) {
      core.resize(48, height);
      rows.resized();
      assert.equal(next.line, original, 'height-only resize preserved absolute marker');
      assert.equal(core.getScrollbackLine(next.line)?.[0].codepoint, 85);
    }
  });
  core.resize(30, 8);
  rows.resized();
  assert.ok(next.isDisposed);
  write(`\x1b[38;2;18;52;86m${cell(2, 3)}${KITTY_PLACEHOLDER_CHAR}\r\n`);
  const line = core.getScrollbackLength() + core.getCursor().y - 1;
  write('\r\n'.repeat(10));
  const found = placeholderRow(core, line, core.getScrollbackLength(), []).map;
  assert.deepEqual([found?.get(0)?.imageId, found?.get(0)?.row, found?.get(1)?.col], [0x123456, 2, 4]);
});

const status = browserStatus();
test('Ghostty graphics: ordered split APC, actual snapshot, Retina pixels, scroll, clipped placement, alternate screen, expand and teardown', { skip: !status.installed && 'Chromium not installed' }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'office-graphics-vite-'));
  const server = await createServer({
    root: fileURLToPath(new URL('../src/client', import.meta.url)),
    configFile: false,
    cacheDir,
    logLevel: 'error',
    appType: 'custom',
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true, include: ['ghostty-web'] },
  });
  t.after(async () => {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address === 'object');
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(4000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/fixture', (route) => route.fulfill({ contentType: 'text/html', body: '<div class="modal term"><div id="host" class="term-host"></div></div>' }));
  await page.goto(`http://127.0.0.1:${address.port}/fixture`);
  await page.addStyleTag({ url: '/style.css?direct' });
  await page.evaluate(async () => {
    const url = '/term-engine/ghostty.ts',
      feature = '/term-engine/ghostty-graphics.ts';
    const { GhosttyAdapter } = await import(url);
    const { attachGhosttyGraphics } = await import(feature);
    const links = '/term-engine/ghostty-links.ts';
    const { attachGhosttyLinks } = await import(links);
    const w = window as any;
    w.sent = [];
    w.open = async (interactive: boolean) => {
      const a = (w.term = new GhosttyAdapter({ fontSize: 15, fontFamily: 'monospace', scrollback: 200 }));
      w.expand = async (img: { blob: Blob; width: number; height: number }) => {
        const bmp = await createImageBitmap(img.blob);
        w.expanded = [img.width, img.height, bmp.width, bmp.height];
        bmp.close();
      };
      attachGhosttyGraphics(a, interactive ? { onExpandImage: w.expand } : {});
      attachGhosttyLinks(a);
      a.onData((s: string) => w.sent.push(s));
      await a.open(document.getElementById('host'));
      a.resize(40, 8);
    };
    await w.open(true);
    w.pixel = (x: number, y: number) => {
      const c = document.querySelector<HTMLCanvasElement>('.term-kitty-layer')!;
      if (!c.width) return [0, 0, 0, 0];
      const m = w.term.native.renderer.getMetrics();
      return Array.from(c.getContext('2d')!.getImageData(Math.floor((x + 0.5) * m.width * devicePixelRatio), Math.floor((y + 0.5) * m.height * devicePixelRatio), 1, 1).data);
    };
  });
  const write = (s: string) => page.evaluate((s) => (window as any).term.write(s), s);
  const painted = async (x: number, y: number, red: boolean) => {
    await page.waitForFunction(
      ([x, y, red]) => {
        const [r, , , a] = (window as any).pixel(x, y);
        return red ? r === 255 && a === 255 : a === 0;
      },
      [x, y, red] as const,
      { timeout: 4000 },
    );
  };
  const packed = deflateSync(Buffer.from([255, 0, 0])).toString('base64');
  await t.test('streamed RIS clears margins without dropping an incomplete APC', async () => {
    await write('\x1b[?69h\x1bc\x1b_G'); // RIS followed by a still-incomplete APC in the same write.
    await write('a=T,f=24,s=1,v=1,i=87;/wAA\x1b\\');
    await painted(0, 0, true);
    await write('\x1bc');
  });
  await write(`${apc('a=q,i=99,f=24,s=1,v=1;AAAA')}label\r\n${apc(`a=t,i=2,f=24,s=1,v=1,o=z,m=1;${packed.slice(0, 4)}`)}`);
  const tail = apc(`m=0;${packed.slice(4)}`) + apc('a=p,i=2,p=7,c=4,r=3');
  for (const chunk of [tail.slice(0, 2), tail.slice(2, -1), tail.slice(-1)]) await write(chunk);
  await painted(1, 1, true);
  assert.deepEqual(
    await page.evaluate(() => {
      const c = (window as any).term.native.wasmTerm.getCursor();
      return [c.x, c.y];
    }),
    [4, 3],
  );
  assert.deepEqual(await page.evaluate(() => (window as any).sent), []);
  const point = await page.evaluate(() => {
    const native = (window as any).term.native;
    const m = native.renderer.getMetrics();
    const r = native.renderer.getCanvas().getBoundingClientRect();
    const overlay = document.querySelector<HTMLCanvasElement>('.term-kitty-layer')!;
    const b = overlay.getBoundingClientRect();
    return { x: r.left + m.width * 1.5, y: r.top + m.height * 3.75, aligned: b.left === r.left && b.top === r.top, dpr: overlay.width / b.width };
  });
  assert.equal(point.aligned, true);
  assert.equal(point.dpr, 2);
  await page.mouse.move(point.x, point.y);
  await page.getByRole('button', { name: 'Expand image' }).click();
  await page.waitForFunction(() => (window as any).expanded);
  assert.deepEqual(await page.evaluate(() => (window as any).expanded), [1, 1, 1, 1]);
  await page.evaluate(() => {
    (window as any).expanded = null;
  });
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(() => (window as any).expanded);
  await write('\x1b[?1000h');
  await page.evaluate(() => {
    (window as any).expanded = null;
    (window as any).sent = [];
  });
  await page.keyboard.down('Control');
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up('Control');
  await page.waitForFunction(() => (window as any).expanded);
  assert.deepEqual(await page.evaluate(() => (window as any).sent), []);
  await write('\x1b[?1000l');
  await write('\x1b[?1049h');
  await painted(1, 1, false);
  await write('\x1b[?1049l');
  await painted(1, 1, true);
  await write(`\x1b[?1049h${'TUI\r\n'.repeat(10)}\x1b[?1049l${'same\r\n'.repeat(7)}`); // active screen top = history row 3; only the last image row remains.
  await painted(1, 0, true);
  await painted(1, 1, false);
  await page.evaluate(() => (window as any).term.native.scrollToTop());
  await painted(1, 1, true);
  await write(apc('a=d,d=i,i=2,p=7'));
  await painted(1, 0, false);
  await painted(1, 1, false);
  // Real server snapshot serialization, not a hand-written approximation of its prelude.
  const host = new headless.Terminal({ rows: 8, cols: 40, allowProposedApi: true });
  t.after(() => host.dispose());
  const serializer = new serialize.SerializeAddon();
  host.loadAddon(serializer);
  const snapshot = screenSnapshot(host, serializer);
  await new Promise<void>((done) => host.write(`title\r\n${apc('a=T,i=42,f=32,s=1,v=1,c=3,r=2;/wAA/w==')}`, done));
  await page.evaluate(() => (window as any).term.reset());
  await write(snapshot());
  await painted(0, 1, true);
  await painted(2, 2, true);
  await new Promise<void>((done) => host.write('\x1bc', done));
  await new Promise<void>((done) => host.write(`${apc('a=T,U=1,i=515,c=2,r=1,f=32,s=1,v=1;/wAA/w==')}\x1b[38;2;0;2;3m${cell(0, 0)}${cell(0, 1)}\x1b[39m`, done));
  await page.evaluate(() => (window as any).term.reset());
  await write(snapshot());
  await painted(0, 0, true);
  await painted(1, 0, true);
  await painted(2, 0, false);
  await page.evaluate(() => (window as any).term.resize(33, 6));
  await painted(1, 0, true);
  await write('\r \x1b[0m');
  await painted(0, 0, false);
  await painted(1, 0, true);
  await write('\x1bc');
  await painted(1, 0, false);
  await t.test('one large PNG in a BEL-terminated APC paints and immediately resumes ordinary text', async () => {
    const result = await page.evaluate(() => {
      const term = (window as any).term;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1600;
      const ctx = canvas.getContext('2d')!;
      const pixels = ctx.createImageData(canvas.width, canvas.height);
      // A red strip for an independent pixel assertion; opaque deterministic noise elsewhere
      // keeps the browser-encoded PNG larger than the former 8 Mi-character scanner limit.
      let noise = 17;
      for (let i = 0; i < pixels.data.length; i += 4) {
        noise ^= noise << 13;
        noise ^= noise >>> 17;
        noise ^= noise << 5;
        const red = (i / 4) % canvas.width < 200;
        pixels.data[i] = red ? 255 : noise & 255;
        pixels.data[i + 1] = red ? 0 : (noise >>> 8) & 255;
        pixels.data[i + 2] = red ? 0 : (noise >>> 16) & 255;
        pixels.data[i + 3] = 255;
      }
      ctx.putImageData(pixels, 0, 0);
      const payload = canvas.toDataURL('image/png').split(',')[1];
      term.write(`\x1b_Ga=T,i=71,f=100,c=8,r=4,C=1;${payload}\x07AFTER`);
      const text = term.native.wasmTerm
        .getLine(0)
        .slice(0, 5)
        .map((cell: { codepoint: number }) => String.fromCodePoint(cell.codepoint))
        .join('');
      return { chars: payload.length, text };
    });
    assert.ok(result.chars > 8 * 1024 * 1024 && result.chars < 16 * 1024 * 1024);
    assert.equal(result.text, 'AFTER', 'BEL ends the APC, not the next ordinary write');
    await painted(0, 0, true);
    t.diagnostic(`Rendered one ${result.chars}-character PNG payload terminated with BEL.`);
  });
  await page.evaluate(async () => {
    const w = window as any;
    w.term.dispose();
    await w.open(false);
  });
  assert.equal(await page.locator('.term-kitty-expand').count(), 0);
  await write(snapshot());
  await painted(1, 0, true);
  await page.evaluate(() => (window as any).term.dispose());
  assert.equal(await page.locator('.term-kitty-layer').count(), 0);
  assert.deepEqual(errors, []);
});
