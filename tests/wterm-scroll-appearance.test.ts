import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const status = browserStatus();
test('wterm scroll and appearance against xterm in Chromium', { skip: !status.installed && `No Chromium in ${status.path}` }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'wterm-scroll-'));
  const server = await createServer({
    root: fileURLToPath(new URL('../src/client', import.meta.url)),
    cacheDir,
    configFile: false,
    resolve: { alias: { '/oracle': fileURLToPath(new URL('./oracle', import.meta.url)) } },
    logLevel: 'error',
    appType: 'custom',
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true, include: ['@xterm/xterm'] },
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
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  await page.addInitScript('window.__name = fn => fn'); // tsx's function-name helper inside page.evaluate
  page.setDefaultTimeout(4000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/fixture', (route) => route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/style.css"><div id="x"></div><div id="w" style="width:600px;height:128px"></div>' }));
  await page.goto(`http://127.0.0.1:${address.port}/fixture`);
  await page.evaluate(async () => {
    const w = window as any;
    const path = '/oracle/terminal.ts',
      scrolling = '/term-engine/wterm-scroll.ts',
      pixel = '/oracle/pixel-scroll.ts',
      theme = '/term-theme.ts';
    const { comparisonTerminal } = await import(path);
    const options = {
      allowProposedApi: true,
      allowTransparency: true,
      minimumContrastRatio: 4.5,
      fontFamily: '"Geist Mono", "Droid Office Terminal Symbols", monospace',
      fontSize: 14,
      lineHeight: 1.1,
      smoothScrollDuration: 125,
      scrollback: 64,
      theme: (await import(theme)).TERM_THEME,
    };
    await Promise.all([document.fonts.load('14px "Geist Mono"'), document.fonts.load('14px "Droid Office Terminal Symbols"', '\ue0b0')]);
    const a = (w.a = comparisonTerminal(options, 'ghostty'));
    const x = (w.x = comparisonTerminal(options, 'xterm'));
    w.scrollApi = (await import(scrolling)).attachWtermScroll(a);
    await a.open(document.querySelector('#w'));
    x.open(document.querySelector('#x'));
    w.pitch = () => x.element.querySelector('.xterm-rows > div').getBoundingClientRect().height;
    a.native.element.parentElement.style.height = `${8 * w.pitch()}px`;
    const xp = (await import(pixel)).attachPixelScroll(x);
    for (const [term, controls] of [
      [a, w.scrollApi],
      [x, xp],
    ]) {
      term.resize(40, 8);
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => !controls.handleKey(e));
    }
    w.input = [[], []];
    [a, x].forEach((term, i) => term.onData((d: string) => w.input[i].push(d)));
    w.frame = async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    };
    // Both grids must have painted the initial resize before testing the visible reader.
    await w.frame();
    w.write = async (s: string) => {
      await Promise.all([a, x].map((term) => new Promise((resolve) => term.write(s, resolve))));
      await w.frame();
    };
    w.el = a.native.element;
    w.wheel = (term: any, deltaY: number, opts: WheelEventInit = {}) => {
      const node = term === a ? w.el.querySelector('.term-row:not(.term-scrollback-row)') : x.element.querySelector('.xterm-screen');
      const rect = node.getBoundingClientRect();
      node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: rect.left + 1, clientY: rect.top + 1, deltaY, ...opts }));
    };
  });
  await t.test('opening an animated dashboard pane preserves the previous 566×769 PTY grid', async () => {
    const sample = await page.evaluate(async () => {
      const path = '/term-engine/web-terminal.ts',
        renderer = '/ui/terminal-renderer.ts';
      const { createWebTerminal } = await import(path),
        { openTerminalRenderer } = await import(renderer);
      const pane = document.createElement('section');
      pane.className = 'dash-pane';
      pane.style.cssText = 'width:566px;height:769px;border:0;transition:none';
      const modal = document.createElement('div');
      modal.className = 'modal term inline';
      const host = document.createElement('div');
      host.className = 'term-host';
      modal.append(host);
      pane.append(modal);
      document.body.append(pane);
      const scale = pane.animate([{ transform: 'scale(.97)' }, { transform: 'none' }], { duration: 10000 });
      scale.pause();
      const { term } = createWebTerminal({ fontFamily: (window as any).a.options.fontFamily, fontSize: 14, lineHeight: 1.1, scrollback: 5000 });
      try {
        const open = openTerminalRenderer(term, host, () => true);
        // A pane can mount under a transformed ancestor; the terminal probes the DOM in viewport pixels.
        await new Promise((r) => setTimeout(r, 120));
        const premature = !!term.native;
        scale.finish();
        await open;
        const { x } = window as any;
        const comparisons = [];
        try {
          for (const [px, size, cols] of [
            [566, 14, 80],
            [566, 16, 64],
            [566, 14, 64],
            [720, 14, 64],
            [566, 14, 80],
            [566, 14, 67],
          ]) {
            pane.style.width = `${px}px`;
            for (const t of [x, term]) {
              t.resize(cols, 39);
              t.options.fontSize = size;
            }
            const screen = x.element.querySelector('.xterm-screen').getBoundingClientRect();
            const expected = { cols: Math.floor((host.clientWidth - 28) / (screen.width / x.cols)), rows: Math.floor((host.clientHeight - 12) / (screen.height / x.rows)) };
            comparisons.push({ px, size, cols, fit: term.proposeDimensions(), expected });
          }
        } finally {
          x.resize(40, 8);
          x.options.fontSize = 14;
        }
        return { premature, box: [host.clientWidth, host.clientHeight], pitch: parseFloat(term.native.element.style.getPropertyValue('--term-cell-width')), comparisons };
      } finally {
        scale.cancel();
        term.dispose();
        pane.remove();
      }
    });
    t.diagnostic(JSON.stringify(sample));
    assert.deepEqual(sample.box, [566, 769]);
    assert.equal(sample.premature, false);
    assert.ok(Math.abs(sample.pitch - 8.4) < 0.02);
    for (const c of sample.comparisons) assert.deepEqual(c.fit, c.expected, JSON.stringify(c));
  });
  await t.test('painted row pitch and usable rows match the previous renderer across fonts, sizes and line spacing', async () => {
    const samples = await page.evaluate(async () => {
      const { a, x, el, frame } = window as any;
      const original = { fontFamily: a.options.fontFamily, fontSize: a.options.fontSize, lineHeight: a.options.lineHeight };
      const samples = [];
      try {
        for (const fontFamily of [original.fontFamily, 'monospace', 'Georgia, serif']) {
          for (const [fontSize, lineHeight] of [
            [12, 1],
            [14, 1.1],
            [17, 1.25],
            [21, 1.5],
          ]) {
            for (const term of [a, x]) Object.assign(term.options, { fontFamily, fontSize, lineHeight });
            await frame();
            const old = x.element.querySelector('.xterm-rows > div').getBoundingClientRect().height;
            const pitch = el.querySelector('.term-row').getBoundingClientRect().height;
            const xWidth = x.element.querySelector('.xterm-screen').getBoundingClientRect().width / x.cols;
            const originalWidth = el.parentElement.style.width;
            for (const width of [566, Math.ceil(xWidth * 80), Math.ceil(xWidth * 150)]) {
              el.parentElement.style.width = `${width}px`;
              const fit = a.proposeDimensions();
              samples.push({ fontFamily, fontSize, lineHeight, old, pitch, cols: fit.cols, expectedCols: Math.floor(el.clientWidth / xWidth), rows: fit.rows, expectedRows: Math.floor(el.clientHeight / old) });
            }
            el.parentElement.style.width = originalWidth;
          }
        }
      } finally {
        for (const term of [a, x]) Object.assign(term.options, original);
        await frame();
      }
      return samples;
    });
    t.diagnostic(JSON.stringify(samples));
    for (const sample of samples) {
      assert.equal(sample.pitch, sample.old, JSON.stringify(sample));
      assert.equal(sample.rows, sample.expectedRows, JSON.stringify(sample));
      assert.equal(sample.cols, sample.expectedCols, JSON.stringify(sample));
    }
  });
  await t.test('holds retained content through cap, resize and new output; typing and paste follow again', async () => {
    const result = await page.evaluate(async () => {
      const { a, x, write, frame, el } = window as any;
      const positions = () => [a, x].map((t) => [t.buffer.active.viewportY, t.buffer.active.baseY]);
      await write(Array.from({ length: 55 }, (_, i) => `row ${i}\r\n`).join(''));
      const bottom = positions();
      const top = 36;
      el.scrollTop = top * (window as any).pitch();
      x.options.smoothScrollDuration = 0;
      x.scrollToLine(top);
      await frame();
      x.options.smoothScrollDuration = 125;
      const rowText = () => [
        document
          .elementFromPoint(el.getBoundingClientRect().left + 1, el.getBoundingClientRect().top + 1)
          ?.closest('.term-row')
          ?.textContent?.trim(),
        x.buffer.active.getLine(x.buffer.active.viewportY).translateToString(true),
      ];
      const before = rowText();
      await write('another\r\n'.repeat(22));
      const capped = positions(),
        after = rowText();
      el.parentElement.style.height = `${10 * (window as any).pitch()}px`;
      for (const term of [a, x]) term.resize(40, 10);
      await frame();
      const resized = rowText();
      const reading = a.buffer.active;
      el.parentElement.style.display = 'none';
      const hidden = a.buffer.active;
      el.parentElement.style.display = '';
      for (const term of [a, x]) term.paste('paste');
      await frame();
      return { bottom, before, capped, after, resized, reading, hidden, pasted: positions() };
    });
    t.diagnostic(JSON.stringify(result));
    assert.deepEqual(result.bottom[0], result.bottom[1]);
    assert.deepEqual(result.before, ['row 36', 'row 36']);
    assert.deepEqual(result.after, result.before);
    assert.equal(result.resized[0], result.resized[1]);
    assert.deepEqual(result.capped[0], result.capped[1]);
    for (const [v, b] of result.pasted) assert.equal(v, b);
    await page.evaluate(() => {
      const { el, a } = window as any;
      el.scrollTop = 0;
      a.focus();
    });
    await page.keyboard.press('a');
    await page.waitForFunction(() => {
      const { viewportY, baseY } = (window as any).a.buffer.active;
      return viewportY === baseY;
    });
  });
  await t.test('accumulated page keys, snap, notch glide, precise deltas, speed and thumb visibility', async () => {
    await page.evaluate(async () => {
      const { a, x, input, frame } = window as any;
      for (const [term, i] of [
        [a, 0],
        [x, 1],
      ]) {
        term.focus();
        input[i].length = 0;
        for (const key of ['PageUp', 'PageUp', 'PageUp', 'PageDown']) term.textarea.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true, cancelable: true }));
      }
      await frame();
    });
    await page.waitForFunction(() => {
      const { a, x } = window as any;
      return [a, x].every((t) => t.buffer.active.baseY - t.buffer.active.viewportY === 2 * (t.rows - 1));
    });
    assert.deepEqual(await page.evaluate(() => (window as any).input), [[], []]);
    const gestures = await page.evaluate(async () => {
      const { a, el, wheel, scrollApi } = window as any;
      a.scrollToBottom();
      const bottom = el.scrollTop;
      a.options.scrollSensitivity = 2;
      wheel(a, -3);
      const precise = bottom - el.scrollTop;
      wheel(a, -3, { altKey: true });
      const fast = bottom - el.scrollTop - precise;
      wheel(a, -6, { deltaX: 22 });
      const horizontal = bottom - el.scrollTop - precise - fast;
      const thumb = getComputedStyle(el, '::-webkit-scrollbar-thumb').backgroundColor;
      a.scrollToBottom();
      wheel(a, -1, { deltaMode: 1 });
      const immediate = el.scrollTop;
      a.options.smoothScrollDuration = 0;
      a.scrollToBottom();
      a.options.smoothScrollDuration = 125;
      scrollApi.snap();
      return { precise, fast, horizontal, thumb, immediate, bottom };
    });
    assert.deepEqual([gestures.precise, gestures.fast, gestures.horizontal], [6, 30, 0]);
    assert.equal(gestures.immediate, gestures.bottom);
    assert.notEqual(gestures.thumb, 'rgba(0, 0, 0, 0)');
    await page.waitForFunction(() => !(window as any).el.classList.contains('wterm-scrolling'));
    assert.equal(await page.evaluate(() => (window as any).el.scrollTop), gestures.bottom);
    await page.locator('#w').hover();
    await page.mouse.wheel(0, -540);
    await page.waitForFunction((before) => {
      const { pitch, el } = window as any;
      return before - el.scrollTop === Math.round(100 / pitch()) * pitch();
    }, gestures.bottom); // 2×50 px, settled to the nearest row
  });
  await t.test('alternate arrows and SGR wheel bytes, including sub-line and horizontal swipes', async () => {
    const output = await page.evaluate(async () => {
      const { a, x, write, wheel, input } = window as any;
      for (const t of [x, a]) {
        t.options.scrollSensitivity = 1;
        t.scrollToBottom();
      }
      await write('\x1b[?1049h');
      input.forEach((d: string[]) => (d.length = 0));
      for (const t of [a, x]) {
        const h = (window as any).pitch();
        for (let i = 0; i < 4; i++) wheel(t, -h);
      }
      await write('\x1b[?1h');
      for (const t of [a, x]) wheel(t, 1, { deltaMode: 1 });
      await write('\x1b[?1000h\x1b[?1006h');
      for (const t of [a, x]) {
        wheel(t, -80);
        wheel(t, 80, { altKey: true });
        wheel(t, 80, { shiftKey: true });
      }
      wheel(a, -40, { deltaX: 80 });
      await write('\x1b[?1016h');
      for (const t of [a, x]) wheel(t, 1, { deltaMode: 1 });
      return input;
    });
    assert.deepEqual(output[0], output[1]);
    assert.equal(output[0].length, 5);
  });
  await t.test('legacy wheel reports at the byte-coordinate boundaries', async () => {
    const comparisons = await page.evaluate(async () => {
      const { a, x, el, frame, write, input } = window as any;
      const binary: string[] = [];
      const sub = x.onBinary((s: string) => binary.push(s));
      const report = [];
      el.parentElement.style.width = '2600px';
      for (const t of [a, x]) t.resize(240, 100);
      for (const [tracking, encoding] of [
        [1000, 0],
        [1002, 0],
        [1003, 0],
        [1000, 1005],
        [1000, 1015],
      ]) {
        const modes = `\x1bc\x1b[?${tracking}h${encoding ? `\x1b[?${encoding}h` : ''}`;
        await write(modes);
        const caps = [];
        for (const [col, row] of [
          [1, 3],
          [95, 3],
          [96, 3],
          [223, 3],
          [224, 3],
          [1, 95],
          [1, 96],
        ])
          for (const direction of [-1, 1]) {
            for (const out of [...input, binary]) out.length = 0;
            for (const t of [a, x]) {
              const node = t === x ? x.element.querySelector('.xterm-screen') : t.native.element.querySelector('.term-row:not(.term-scrollback-row)');
              const rect = node.getBoundingClientRect();
              const width = t === x ? rect.width / t.cols : parseFloat(t.native.element.style.getPropertyValue('--term-cell-width'));
              const height = t === x ? rect.height / t.rows : rect.height;
              node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaMode: 1, deltaY: direction, clientX: rect.left + (col - 0.5) * width, clientY: rect.top + height * (row - 0.5) }));
            }
            caps.push({ col, row, direction, adapter: input[0].join(''), xData: input[1].join(''), xBinary: binary.join('') });
          }
        report.push({ tracking, encoding, caps });
      }
      sub.dispose();
      el.parentElement.style.width = '';
      for (const t of [a, x]) t.resize(40, 10);
      await frame();
      return report;
    });
    for (const { tracking, encoding, caps } of comparisons)
      for (const { col, row, direction, xBinary, xData, adapter } of caps) {
        const label = `tracking ${tracking}, encoding ${encoding}, (${col},${row}), wheel ${direction}`;
        const binary = col > 223 ? '' : `\x1b[M${String.fromCharCode(direction < 0 ? 96 : 97, col + 32, row + 32)}`;
        assert.equal(xData, '', label);
        assert.equal(xBinary, binary, label);
        assert.equal(adapter, Math.max(col, row) <= 95 ? xBinary : '', label);
      }
  });
  await t.test('minimum contrast in both directions and reverse video; retain existing ANSI, truecolor and glyph styling', async () => {
    const rows = await page.evaluate(async () => {
      const { a, x, write } = window as any;
      a.reset();
      x.reset();
      await write('\x1b[2J\x1b[H');
      const entries = ['38;2;40;40;40', '38;2;210;210;210;48;2;255;255;255', '7;38;2;40;40;40;48;2;30;30;30', '38;2;188;220;188', '1', '3', '2', '4:1', '4:2', '4:3', '4:4', '4:5', '4;58;2;7;133;245'];
      await write(`${entries.map((s, i) => `\x1b[0;${s}m${String.fromCharCode(65 + i)}`).join('')}\x1b[0m`);
      return [a.native.element, x.element].map((el, i) =>
        entries.map((_, j) => {
          const nodes = el.querySelectorAll(i ? '.xterm-rows span' : '.term-row span');
          const n = Array.from(nodes as NodeListOf<HTMLElement>).find((n) => n.textContent === String.fromCharCode(65 + j))!;
          const s = getComputedStyle(n);
          return [s.color, s.fontWeight, s.fontStyle, s.opacity, s.textDecorationStyle, s.textDecorationColor];
        }),
      );
    });
    for (let i = 0; i < 4; i++) assert.equal(rows[0][i][0], rows[1][i][0]);
    assert.equal(rows[0][4][1], rows[1][4][1]);
    assert.equal(rows[0][5][2], rows[1][5][2]);
    assert.equal(rows[0][6][3], '0.5');
    assert.match(rows[1][6][0], /0\.5\)/);
    assert.deepEqual(
      rows[0].slice(7, 12).map((r) => r[4]),
      ['solid', 'double', 'wavy', 'dotted', 'dashed'],
    );
    assert.equal(rows[0][12][5], 'rgb(7, 133, 245)');
  });
  await t.test('display-only link and combining Kitty masks on screen and in retained history', async () => {
    const result = await page.evaluate(async () => {
      const { a, write } = window as any;
      await write('\x1b[H\x1b]8;id=sample;https://example.org\x1b\\L\x1b]8;;\x1b\\\x1b[4;58;2;5;6;7m\u{10eeee}\u0301\x1b[0m');
      const values = (method: string, row: number) => {
        const raw = a.core,
          shown = a.native.bridge;
        const link = shown[method](row, 0),
          original = raw[method](row, 1),
          mask = shown[method](row, 1);
        return [!!raw[method](row, 0).linkUri, !!(link.linkUri || link.linkKey || link.linkId), original.char, original.chars, mask.char, mask.chars ?? null, mask.width === original.width, mask.underlineStyle];
      };
      const live = values('getCell', 0),
        anchors = a.native.element.querySelectorAll('a').length;
      await write('\r\n'.repeat(a.rows));
      return { live, history: values('getScrollbackCell', 0), anchors };
    });
    assert.deepEqual(result.live, [true, false, 0x10eeee, '\u{10eeee}\u0301', 32, null, true, 'none']);
    assert.deepEqual(result.history, result.live);
    assert.equal(result.anchors, 0);
  });
  await t.test('live theme recolors existing text; transparent glass, selection, cursor and font metrics', async () => {
    const observed = await page.evaluate(async () => {
      const { a, x, write, el, frame } = window as any;
      await write('\x1bc\x1b[HA\x1b[31mR\x1b[0m\ue0b0漢🙂\x1b[7mI\x1b[0m');
      const spans = () => [...el.querySelectorAll('.term-row:not(.term-scrollback-row) span')] as HTMLElement[];
      const colors = () =>
        [el, x.element].map((root, i) =>
          ['A', 'R'].map((cp) => {
            const span = Array.from(root.querySelectorAll(i ? '.xterm-rows span' : '.term-row:not(.term-scrollback-row) span') as NodeListOf<HTMLElement>).find((n) => n.textContent === cp)!;
            return getComputedStyle(span).color;
          }),
        );
      const initial = colors();
      for (const term of [a, x]) term.options.theme = { ...term.options.theme, background: 'rgba(0, 0, 0, 0)', foreground: '#12de80', red: '#89abcd', selectionBackground: '#123456' };
      await frame();
      const live = colors();
      const inverseInk = getComputedStyle(spans().find((n) => n.textContent === 'I')!).color;
      const metrics = ['A', '\ue0b0', '漢', '🙂'].map(
        (cp) =>
          spans()
            .find((n) => n.textContent === cp)!
            .getBoundingClientRect().width,
      );
      const font = getComputedStyle(el).fontFamily;
      const selection = getComputedStyle(spans()[0], '::selection').backgroundColor;
      const cursor = [];
      a.focus();
      for (const blink of [false, true])
        for (const style of ['block', 'bar', 'underline']) {
          a.options.cursorBlink = blink;
          a.options.cursorStyle = style;
          await frame();
          const c = getComputedStyle(el.querySelector('.term-cursor'));
          cursor.push([el.querySelector('.term-grid').dataset.cursorShape, style === 'block' ? c.backgroundColor : c.boxShadow, c.animationName]);
        }
      return { initial, live, inverseInk, font, selection, metrics, cursor, glass: getComputedStyle(el).backgroundColor };
    });
    assert.deepEqual(observed.initial[0], observed.initial[1]);
    assert.deepEqual(observed.live[0], observed.live[1]);
    assert.notDeepEqual(observed.initial, observed.live);
    assert.equal(observed.glass, 'rgba(0, 0, 0, 0)');
    assert.equal(observed.inverseInk, 'rgb(0, 0, 0)');
    assert.equal(observed.selection, 'rgb(18, 52, 86)');
    assert.match(observed.font, /Geist Mono.*Droid Office Terminal Symbols/);
    const [latin, icon, ...wide] = observed.metrics;
    assert.ok(latin > 0 && icon === latin && wide.every((w) => Math.abs(w - 2 * latin) < 0.05));
    for (const [i, [shape, paint, animation]] of observed.cursor.entries()) {
      assert.equal(shape, ['block', 'bar', 'underline'][i % 3]);
      assert.match(paint, /rgb\(238, 96, 24\)/);
      assert.equal(animation === 'none', i < 3);
    }
  });
  await t.test('full-screen true-color repaint measurement', async () => {
    const times = await page.evaluate(async () => {
      const { a, el, frame } = window as any;
      const cols = 120,
        rows = 40;
      a.resize(cols, rows);
      el.parentElement.style.height = `${(window as any).pitch() * rows}px`;
      el.parentElement.style.width = '1100px';
      await frame();
      const samples: { off: number[]; on: number[] } = { off: [], on: [] };
      for (let j = 0; j < 24; j++) {
        const on = j % 4 === 1 || j % 4 === 2;
        a.options.minimumContrastRatio = on ? 4.5 : 1;
        // Distinct, mostly low-contrast pairs, different from the preceding repaint.
        const screen = `\x1b[H${Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => `\x1b[38;2;${x};${y + j};${x + y};48;2;${x + j};${y};${x}m${j % 2 ? 'x' : 'z'}`).join('')).join('\r\n')}`;
        let start = 0;
        requestAnimationFrame(() => {
          start = performance.now();
        });
        a.write(screen);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => {
            el.getBoundingClientRect(); // include synchronous DOM layout
            samples[on ? 'on' : 'off'].push(performance.now() - start);
            resolve();
          }),
        );
      }
      const reads = [];
      let checksum = 0;
      for (const ratio of [1, 4.5, 4.5, 1]) {
        a.options.minimumContrastRatio = ratio;
        const start = performance.now();
        for (let pass = 0; pass < 10; pass++) for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) checksum += a.native.bridge.getCell(y, x).fgRgb ?? 0;
        reads.push((performance.now() - start) / 10);
      }
      return { samples, reads, checksum, painted: el.querySelectorAll('.term-row:not(.term-scrollback-row)').length };
    });
    assert.equal(times.painted, 40);
    assert.ok(times.checksum > 0);
    t.diagnostic(`120x40 distinct true-color cells, render + layout ms: ${JSON.stringify(times.samples)}; full-screen cell reads, ABBA (off/on/on/off) ms: ${JSON.stringify(times.reads)}`);
  });
  await page.evaluate(() => {
    const { a, x } = window as any;
    a.dispose();
    x.dispose();
  });
  assert.deepEqual(errors, []);
});
