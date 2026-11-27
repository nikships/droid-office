import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const status = browserStatus();

test('the legacy xterm comparison scroller keeps rendered rows, selection, links and images aligned', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const bundle = buildSync({
    stdin: {
      contents:
        "export { attachKittyTerminal } from './tests/oracle/kitty'; export { TerminalPathLinksAddon } from './tests/oracle/paths'; export { attachPixelScroll, pixelScrollOf, SETTLE_DELAY_MS, SETTLE_MS } from './tests/oracle/pixel-scroll'; export { Terminal } from '@xterm/xterm';",
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    },
    bundle: true,
    format: 'iife',
    globalName: 'TerminalUI',
    write: false,
    target: 'es2022',
  }).outputFiles[0].text;
  const css = await readFile(new URL('../src/client/style.css', import.meta.url), 'utf8');
  const xtermCss = await readFile(new URL('../node_modules/@xterm/xterm/css/xterm.css', import.meta.url), 'utf8');

  const rig = async () => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    t.after(async () => {
      await page.close();
      assert.deepEqual(errors, []);
    });
    await page.setContent('<!doctype html><div id="mount"></div><div id="modal-root"></div>');
    await page.addStyleTag({ content: `${css}${xtermCss} body { margin: 0 } .term-kitty-layer {position:absolute;inset:0;pointer-events:none}` });
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => {
      const w = window as any;
      const { Terminal, attachKittyTerminal, TerminalPathLinksAddon, attachPixelScroll } = w.TerminalUI;
      const mount = document.getElementById('mount')!;
      mount.style.width = '800px';
      mount.style.height = '420px';
      w.messages = [];
      w.opened = [];
      // Every path the terminal asks about exists, as itself.
      const realFetch = window.fetch.bind(window);
      window.fetch = (async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (String(url).includes('/api/term/paths')) return new Response(JSON.stringify({ paths: body.paths.map((p: string) => ({ path: `/checkout/${p.replace(/:\d+$/, '')}`, displayPath: p })), local: true }));
        if (String(url).includes('/api/term/path/open')) {
          w.opened.push(...body.paths);
          return new Response(JSON.stringify({ ok: true }));
        }
        return realFetch(url, init);
      }) as typeof fetch;
      w.feed = (data: string) => new Promise<void>((resolve) => w.term.write(data, resolve));
      w.lines = (from: number, count: number) => Array.from({ length: count }, (_, i) => `line ${from + i} src/file-${from + i}.ts`).join('\r\n');
      // An opaque red picture, for a Kitty image the test can find by its pixels.
      const red = document.createElement('canvas');
      red.width = red.height = 8;
      const g = red.getContext('2d')!;
      g.fillStyle = '#ff0000';
      g.fillRect(0, 0, 8, 8);
      w.png = red.toDataURL('image/png').split(',')[1];
      w.frames = async (n = 3) => {
        for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame);
      };
      w.pixel = () => w.TerminalUI.pixelScrollOf(w.term);
      // No named arrow functions in here: tsx would wrap them in a helper the page doesn't have.
      w.scroller = () => w.term._core._viewport._scrollableElement;
      w.cellH = () => w.term._core._renderService.dimensions.css.cell.height;
      w.scrollTop = () => w.scroller().getScrollPosition().scrollTop;
      /** Where the screen's first row sits when nothing is moved: the clipping box xterm scrolls in. */
      w.box = () => w.scroller().getDomNode().getBoundingClientRect();
      /** The buffer line whose pixels sit at `clientY`, from xterm's own scroll position alone. */
      w.lineAt = (clientY: number) => Math.floor((clientY - w.box().top + w.scrollTop()) / w.cellH());
      /** The text the page draws at a point inside the terminal's clipping box (rows take no pointer events, so find them by their boxes). */
      w.textAt = (clientX: number, clientY: number) => {
        const box = w.box();
        if (clientY < box.top || clientY >= box.bottom) return null;
        for (const row of document.querySelectorAll('.xterm-rows > div')) {
          const r = row.getBoundingClientRect();
          if (clientX >= r.left && clientX < r.right && clientY >= r.top && clientY < r.bottom) return row.textContent?.trimEnd() ?? '';
        }
        return null;
      };
      w.expected = (line: number) => w.term.buffer.active.getLine(line)?.translateToString(true) ?? null;
      const term = (w.term = new Terminal({ allowProposedApi: true, smoothScrollDuration: 125, fontSize: 14, lineHeight: 1.1, cols: 80, rows: 20 }));
      attachKittyTerminal(term, { onExpandImage() {} });
      term.loadAddon(new TerminalPathLinksAddon({ floor: 'floor', workerId: 'pixel' }));
      term.open(mount);
      const scroll = attachPixelScroll(term);
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => !scroll.handleKey(e));
      term.onData((data: string) => w.messages.push({ t: 'term.input', data }));
      new ResizeObserver(() => term.resize(80, Math.max(2, Math.floor(mount.clientHeight / w.cellH())))).observe(mount);
    });
    await page.waitForFunction(() => !!(window as any).term?.element && !(window as any).term.options.disableStdin);
    await page.evaluate(async () => {
      const w = window as any;
      await w.feed(`${w.lines(0, 300)}\r\n`);
      await w.frames();
    });
    return page;
  };

  /** Scrolls with real wheel input over the terminal, holding the position there (as a resting finger would). */
  const wheel = async (page: Awaited<ReturnType<typeof rig>>, rows: number) => {
    const box = await page.evaluate(() => (window as any).box().toJSON());
    await page.mouse.move(box.x + 200, box.y + 100);
    const dy = await page.evaluate((rows) => rows * (window as any).cellH(), rows);
    await page.mouse.wheel(0, dy);
    await page.evaluate(async () => {
      const w = window as any;
      w.pixel().hold(true);
      // A wheel notch glides; wait for it to arrive.
      const scrollable = w.term._core._viewport._scrollableElement._scrollable;
      while (Math.abs(scrollable.getFutureScrollPosition().scrollTop - w.scrollTop()) > 0.01) await w.frames(1);
      await w.frames();
    });
  };
  /** Each point down the screen (and the strips a row past each edge) shows the line xterm's position puts there. */
  const aligned = (page: Awaited<ReturnType<typeof rig>>) =>
    page.evaluate(() => {
      const w = window as any;
      const box = w.box();
      const h = w.cellH();
      const wrong: unknown[] = [];
      for (let y = box.top + 1; y < box.bottom - 1; y += 3) {
        // The screen moves by whole device pixels, so a row edge can sit up to half a pixel from
        // xterm's exact position: look clear of the edges.
        const at = (y - box.top + w.scrollTop()) / h;
        if (Math.abs(at - Math.round(at)) * h < 1) continue;
        const line = w.lineAt(y);
        const got = w.textAt(box.left + 40, y);
        if (got !== w.expected(line)) wrong.push({ y: y - box.top, line, got, want: w.expected(line) });
      }
      return wrong.slice(0, 5);
    });

  /** Moves the scrollback by `rows` (fractions too) through the scroller's own entry point, and holds it there. */
  const scrollBy = (page: Awaited<ReturnType<typeof rig>>, rows: number) =>
    page.evaluate(async (rows) => {
      const w = window as any;
      w.pixel().hold(true);
      w.pixel().scrollBy(rows * w.cellH());
      await w.frames();
    }, rows);
  const lineTop = (page: Awaited<ReturnType<typeof rig>>, line: number) =>
    page.evaluate((line) => {
      const w = window as any;
      return w.box().top + line * w.cellH() - w.scrollTop();
    }, line);

  /** The offset xterm's own position asks for: how far it sits past the rows xterm drew, in device pixels. */
  const wantOffset = (page: Awaited<ReturnType<typeof rig>>) =>
    page.evaluate(() => {
      const w = window as any;
      const dpr = window.devicePixelRatio || 1;
      return Math.round((w.scrollTop() - w.term.buffer.active.viewportY * w.cellH()) * dpr) / dpr || 0;
    });

  await t.test('a real wheel moves the screen to the position xterm keeps, by pixels, and it settles on a whole row', async () => {
    const page = await rig();
    const before = await page.evaluate(() => (window as any).scrollTop());
    await wheel(page, -4.4);
    const moved = await page.evaluate(() => (window as any).scrollTop());
    assert.ok(moved < before, `the wheel scrolled back: ${before} → ${moved}`);
    assert.equal(await page.evaluate(() => (window as any).pixel().offset()), await wantOffset(page));
    assert.deepEqual(await aligned(page), []);
    await page.evaluate(async () => {
      const w = window as any;
      w.pixel().hold(false);
      await new Promise((r) => setTimeout(r, w.TerminalUI.SETTLE_DELAY_MS + w.TerminalUI.SETTLE_MS + 100));
      await w.frames();
    });
    const rows = await page.evaluate(() => (window as any).scrollTop() / (window as any).cellH());
    assert.ok(Math.abs(rows - Math.round(rows)) < 1e-6, `settled on a whole row: ${rows}`);
    assert.equal(await page.evaluate(() => (window as any).pixel().offset()), 0);
  });

  await t.test('a part-row scroll draws a fractional offset, the row past the edge included, and settles on a whole row', async () => {
    const page = await rig();
    // 4.4 rows up through xterm's own scroller, whatever a wheel notch comes to on this platform.
    await scrollBy(page, -4.4);
    const mid = await page.evaluate(() => {
      const w = window as any;
      const h = w.cellH();
      return { offset: w.pixel().offset(), h, frac: (w.scrollTop() / h) % 1, transform: document.querySelector<HTMLElement>('.xterm-screen')!.style.transform };
    });
    assert.ok(Math.abs(mid.offset) > 1 && Math.abs(mid.offset) < mid.h, `a part of a row: ${JSON.stringify(mid)}`);
    assert.equal(mid.offset, await wantOffset(page));
    assert.match(mid.transform, /translate3d\(0px, -?[\d.]+px, 0px\)/);
    assert.deepEqual(await aligned(page), []);
    // The rows past each edge are clipped to the box xterm's screen has at rest.
    const clip = await page.evaluate(() => {
      const w = window as any;
      const node = w.scroller().getDomNode();
      return { overflow: getComputedStyle(node).overflowY, box: w.box().height, screen: w.term.rows * w.cellH() };
    });
    assert.equal(clip.overflow, 'clip');
    assert.ok(Math.abs(clip.box - clip.screen) < 0.5, `the clip is exactly the screen: ${JSON.stringify(clip)}`);
    await page.evaluate(async () => {
      const w = window as any;
      w.pixel().hold(false);
      await new Promise((r) => setTimeout(r, w.TerminalUI.SETTLE_DELAY_MS + w.TerminalUI.SETTLE_MS + 100));
      await w.frames();
    });
    const rest = await page.evaluate(() => {
      const w = window as any;
      return { offset: w.pixel().offset(), rows: w.scrollTop() / w.cellH(), transform: document.querySelector<HTMLElement>('.xterm-screen')!.style.transform };
    });
    assert.equal(rest.offset, 0);
    assert.ok(Math.abs(rest.rows - Math.round(rest.rows)) < 1e-6, `settled on a whole row: ${rest.rows}`);
    assert.equal(rest.transform, '');
    assert.deepEqual(await aligned(page), []);
  });
  await t.test('a fling that jumps rows at a time between renders never paints a frame out of line', async () => {
    const page = await rig();
    const wrong = await page.evaluate(async () => {
      const w = window as any;
      w.pixel().hold(true);
      const bad: unknown[] = [];
      let last = w.scrollTop();
      w.check = () => {
        const box = w.box();
        const h = w.cellH();
        const now = w.scrollTop();
        // Where the painted rows put the scrollback: one position for every row, xterm's current
        // one or, in the frame a jump lands in before xterm draws it, the one before.
        const painted = [...document.querySelectorAll('.xterm-rows > div')].flatMap((row) => {
          const r = row.getBoundingClientRect();
          const n = Number(/^line (\d+)/.exec(row.textContent ?? '')?.[1]);
          return r.bottom > box.top && r.top < box.bottom && Number.isFinite(n) ? [n * h - (r.top - box.top)] : [];
        });
        const at = painted[0];
        const one = painted.every((p) => Math.abs(p - at) <= 1);
        if (!painted.length || !one || (Math.abs(at - now) > 1 && Math.abs(at - last) > 1)) bad.push({ now: now / h, last: last / h, painted: painted.map((p) => p / h) });
        last = now;
      };
      // Resize observers run after every animation frame callback and before the paint: what they
      // see is what the frame shows.
      const probe = document.body.appendChild(document.createElement('div'));
      let checks = 0;
      new ResizeObserver(() => {
        checks++;
        w.check();
      }).observe(probe);
      // Every other frame, jump several rows and a part, from inside an animation frame as a fast fling does.
      const jumps = [-4.3, -7.7, -3.1, -9.45, -5.6, 2.35, 6.8, -11.2];
      for (let i = 0; i < 2 * jumps.length + 4; i++) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => {
            if (i % 2 === 0 && i / 2 < jumps.length) w.scroller().setScrollPosition({ scrollTop: w.scrollTop() + jumps[i / 2] * w.cellH() });
            probe.style.width = `${i + 1}px`;
            resolve();
          }),
        );
      }
      if (checks < 2 * jumps.length) bad.push({ checks });
      await w.frames();
      w.check();
      return bad;
    });
    assert.deepEqual(wrong, []);
  });

  await t.test('selection, its highlight, path links and their underline line up with the text at a part-row offset', async () => {
    const page = await rig();
    await scrollBy(page, -40.45);
    const { offset, h } = await page.evaluate(() => ({ offset: (window as any).pixel().offset(), h: (window as any).cellH() }));
    assert.ok(Math.abs(offset) > 2 && Math.abs(offset) < h - 2, `part of a row: ${offset}`);
    assert.deepEqual(await aligned(page), []);
    const box = await page.evaluate(() => (window as any).box().toJSON());
    // Drag from the start of one line to the middle of the next, at the points where those lines are drawn.
    const first = await page.evaluate((y) => (window as any).lineAt(y), box.y + h * 5.5);
    const y0 = (await lineTop(page, first)) + h / 2;
    await page.mouse.move(box.x + 2, y0);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, y0 + h, { steps: 4 });
    await page.mouse.up();
    const selected = await page.evaluate(() => (window as any).term.getSelection());
    const want = await page.evaluate((first) => [(window as any).expected(first), (window as any).expected(first + 1)], first);
    assert.ok(selected.startsWith(want[0]), `selection starts on the line under the pointer: ${JSON.stringify(selected)}`);
    assert.ok(want[1].startsWith(selected.split('\n')[1] ?? '\u0000'), `and ends on the next one: ${JSON.stringify(selected)}`);
    const highlight = await page.evaluate(() => [...document.querySelectorAll('.xterm-selection div')].map((d) => d.getBoundingClientRect().top));
    assert.ok(highlight.length > 0);
    assert.ok(Math.abs(highlight[0] - (y0 - h / 2)) < 1, `the highlight sits on the selected text: ${highlight[0]} vs ${y0 - h / 2}`);
    await page.evaluate(() => (window as any).term.clearSelection());

    // Hover a path two lines further down: its underline is drawn on the row the pointer is over.
    const target = first + 2;
    const yLink = (await lineTop(page, target)) + h / 2;
    const xLink = await page.evaluate(() => {
      const w = window as any;
      return w.box().left + 12 * w.term._core._renderService.dimensions.css.cell.width;
    });
    await page.mouse.move(xLink, yLink - 3);
    await page.mouse.move(xLink, yLink);
    await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows span')].some((s) => getComputedStyle(s).textDecorationLine.includes('underline')));
    const underlined = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('.xterm-rows span')].filter((s) => getComputedStyle(s).textDecorationLine.includes('underline'));
      const r = spans[0].getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, text: spans.map((s) => s.textContent).join('') };
    });
    assert.ok(underlined.top <= yLink && yLink < underlined.bottom, `underline on the hovered row: ${JSON.stringify(underlined)} at ${yLink}`);
    assert.equal(underlined.text, `src/file-${target}.ts`);
    await page.keyboard.down('Meta');
    await page.mouse.click(xLink, yLink);
    await page.keyboard.up('Meta');
    await page.waitForFunction(() => (window as any).opened.length > 0);
    assert.deepEqual(await page.evaluate(() => (window as any).opened), [`src/file-${target}.ts`], '⌘-click opens the path drawn under the pointer');
  });

  await t.test('a press or a selection drag on the part-shown row past an edge lands on the line drawn there', async () => {
    const page = await rig();
    const h = await page.evaluate(() => (window as any).cellH());
    const box = await page.evaluate(() => (window as any).box().toJSON());
    const colX = (col: number) => page.evaluate((col) => (window as any).box().left + col * (window as any).term._core._renderService.dimensions.css.cell.width, col);
    /** Holds the view part way between rows and finds the line in the strip past the edge, where it is drawn. */
    const strip = async (rows: number) => {
      await page.evaluate(() => (window as any).term.clearSelection());
      await scrollBy(page, rows);
      return page.evaluate(() => {
        const w = window as any;
        const o = w.pixel().offset();
        const b = w.box();
        const y = o > 0 ? b.bottom - o / 2 : b.top - o / 2;
        const line = w.lineAt(y);
        return { o, y, line, drawn: w.textAt(b.left + 40, y), want: w.expected(line), top: w.term.buffer.active.viewportY, rows: w.term.rows };
      });
    };

    // The row below: ⌘-click on its path never opens the path of the row beside it.
    let s = await strip(-40.55);
    assert.ok(s.o > 2 && s.o < h - 2, `part of the row below shows: ${JSON.stringify(s)}`);
    assert.equal(s.line, s.top + s.rows, 'the strip is the row past the bottom edge');
    assert.equal(s.drawn, s.want);
    const x = await colX(12);
    await page.mouse.move(x, s.y);
    await page.keyboard.down('Meta');
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.up('Meta');
    await page.waitForTimeout(300);
    const first = await page.evaluate(() => (window as any).opened.slice());
    assert.ok(
      first.every((p: string) => p === `src/file-${s.line}.ts`),
      `nothing but its own path opens: ${JSON.stringify(first)}`,
    );
    // The press brought that row fully in, under the pointer.
    const after = await page.evaluate((y) => ({ offset: (window as any).pixel().offset(), line: (window as any).lineAt(y), drawn: (window as any).textAt((window as any).box().left + 40, y) }), s.y);
    assert.deepEqual(after, { offset: 0, line: s.line, drawn: s.want });
    await page.mouse.move(x, s.y - 2);
    await page.mouse.move(x, s.y);
    await page.waitForFunction(() => [...document.querySelectorAll('.xterm-rows span')].some((el) => getComputedStyle(el).textDecorationLine.includes('underline')));
    await page.keyboard.down('Meta');
    await page.mouse.click(x, s.y);
    await page.keyboard.up('Meta');
    await page.waitForFunction((n) => (window as any).opened.length > n, first.length);
    assert.deepEqual(await page.evaluate((n) => (window as any).opened.slice(n), first.length), [`src/file-${s.line}.ts`]);

    // A selection pressed on the strip starts on its line.
    s = await strip(-0.55);
    assert.ok(s.o > 2, JSON.stringify(s));
    await page.mouse.move(box.x + 2, s.y);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, s.y, { steps: 4 });
    await page.mouse.up();
    let selected = await page.evaluate(() => (window as any).term.getSelection());
    assert.ok(selected.length > 4 && !selected.includes('\n') && s.want.startsWith(selected), `selected on the strip's line: ${JSON.stringify(selected)} of ${s.want}`);

    // A selection dragged from inside onto the strip ends on the strip's line.
    s = await strip(-0.55);
    const from = s.line - 3;
    const y0 = (await lineTop(page, from)) + h / 2;
    await page.mouse.move(box.x + 2, y0);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, s.y, { steps: 6 });
    await page.mouse.up();
    selected = await page.evaluate(() => (window as any).term.getSelection());
    const lines = selected.split('\n');
    const want = await page.evaluate((from) => (window as any).expected(from), from);
    assert.equal(lines.length, 4, JSON.stringify(selected));
    assert.ok(lines[0] === want && s.want.startsWith(lines[3]) && lines[3].length > 4, `from line ${from} to the strip's line ${s.line}: ${JSON.stringify(selected)}`);

    // The row above: a press there starts on its line too.
    s = await strip(-0.45);
    assert.ok(s.o < -2 && s.line === s.top - 1, `part of the row above shows: ${JSON.stringify(s)}`);
    await page.mouse.move(box.x + 2, s.y);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, s.y, { steps: 4 });
    await page.mouse.up();
    selected = await page.evaluate(() => (window as any).term.getSelection());
    assert.ok(selected.length > 4 && !selected.includes('\n') && s.want.startsWith(selected), `selected on the line above: ${JSON.stringify(selected)} of ${s.want}`);
  });

  await t.test('a resize leaves xterm its own rows and no stale extra row on screen', async () => {
    const page = await rig();
    const state = () =>
      page.evaluate(() => {
        const w = window as any;
        const all = [...document.querySelectorAll('.xterm-rows > div')];
        const extra = all.filter((r) => r.classList.contains('term-extra-row'));
        return { rows: w.term.rows, owned: all.length - extra.length, extraText: extra.map((r) => r.textContent), offset: w.pixel().offset() };
      });
    const resize = async (height: number) => {
      const rows = await page.evaluate(() => (window as any).term.rows);
      await page.evaluate((height) => {
        document.getElementById('mount')!.style.height = `${height}px`;
      }, height);
      await page.waitForFunction((rows) => (window as any).term.rows !== rows, rows);
      await page.evaluate(() => (window as any).frames());
    };
    await scrollBy(page, -3.45);
    let s = await state();
    assert.ok(s.offset !== 0 && s.owned === s.rows && s.extraText.some((t) => t), JSON.stringify(s));
    // Settled, the extra rows are emptied; growing the screen over where they sat shows none of them.
    await page.evaluate(async () => {
      const w = window as any;
      w.pixel().hold(false);
      await new Promise((r) => setTimeout(r, w.TerminalUI.SETTLE_DELAY_MS + w.TerminalUI.SETTLE_MS + 100));
      await w.frames();
    });
    await resize(520);
    s = await state();
    assert.deepEqual(s, { rows: s.rows, owned: s.rows, extraText: ['', ''], offset: 0 });
    assert.deepEqual(await aligned(page), []);
    // Resized while between rows: still xterm's own rows only, and the extra rows at the new edges.
    await scrollBy(page, -2.45);
    await resize(380);
    await scrollBy(page, -0.3);
    s = await state();
    assert.equal(s.owned, s.rows);
    assert.deepEqual(await aligned(page), []);
    const edges = await page.evaluate(() => {
      const w = window as any;
      const [above, below] = [...document.querySelectorAll('.term-extra-row')].map((r) => Number.parseFloat((r as HTMLElement).style.top));
      return { above, below, h: w.cellH(), rows: w.term.rows };
    });
    assert.deepEqual([edges.above, edges.below], [-edges.h, edges.rows * edges.h]);
  });

  await t.test('Kitty images move with their rows, into the part-shown row past the edge too', async () => {
    const page = await rig();
    const line = await page.evaluate(async () => {
      const w = window as any;
      const b = w.term.buffer.active;
      const at = b.baseY + b.cursorY;
      await w.feed(`\x1b_Ga=T,f=100,c=4,r=2;${w.png}\x1b\\\r\n${w.lines(1000, 60)}\r\n`);
      await w.frames();
      return at;
    });
    const redBox = () =>
      page.evaluate(async () => {
        const w = window as any;
        for (let i = 0; i < 60; i++) {
          const canvas = document.querySelector<HTMLCanvasElement>('canvas.term-kitty-layer')!;
          const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
          let top = Infinity;
          let bottom = -Infinity;
          for (let p = 0; p < data.length; p += 4) {
            if (data[p] > 200 && data[p + 1] < 50 && data[p + 3] > 200) {
              const y = Math.floor(p / 4 / canvas.width);
              top = Math.min(top, y);
              bottom = Math.max(bottom, y);
            }
          }
          if (top !== Infinity) {
            const r = canvas.getBoundingClientRect();
            const scale = r.height / canvas.height;
            return { top: r.top + top * scale, bottom: r.top + (bottom + 1) * scale };
          }
          await w.frames(1);
        }
        return null;
      });
    const h = await page.evaluate(() => (window as any).cellH());
    const rows = await page.evaluate(() => (window as any).term.rows);
    const base = await page.evaluate(() => (window as any).term.buffer.active.baseY);
    // The image's first row in the middle of the screen, a part-row past a whole one.
    await scrollBy(page, line - 6.4 - base);
    let red = await redBox();
    let top = await lineTop(page, line);
    assert.ok(red && Math.abs(red.top - top) < 1 && Math.abs(red.bottom - (top + 2 * h)) < 1, `image on its rows: ${JSON.stringify({ red, top })}`);
    assert.ok(Math.abs(await page.evaluate(() => (window as any).pixel().offset())) > 2);
    // Now its first row is the one only partly shown below the last whole row.
    await scrollBy(page, line - rows + 0.4 - (await page.evaluate(() => (window as any).scrollTop() / (window as any).cellH())));
    red = await redBox();
    top = await lineTop(page, line);
    const box = await page.evaluate(() => (window as any).box().toJSON());
    assert.ok(top < box.y + box.height && top > box.y + box.height - h, `the image's row is the one past the edge: ${top}`);
    assert.ok(red && Math.abs(red.top - top) < 1, `drawn there, not popping in later: ${JSON.stringify({ red, top })}`);
    // Its part that shows answers the pointer as the rest of the image does.
    await page.mouse.move(box.x + 10, (top + box.y + box.height) / 2);
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.term-kitty-expand')?.hidden === false);
  });

  await t.test('output streaming in keeps a scrolled-up reader exactly where they are', async () => {
    const page = await rig();
    await scrollBy(page, -6.3);
    const before = await page.evaluate(() => {
      const w = window as any;
      const box = w.box();
      return { top: w.scrollTop(), offset: w.pixel().offset(), text: [0.2, 0.5, 0.9].map((f) => w.textAt(box.left + 40, box.top + f * box.height)) };
    });
    assert.ok(before.offset !== 0);
    await page.evaluate(async () => {
      const w = window as any;
      for (let i = 0; i < 10; i++) {
        await w.feed(`${w.lines(2000 + i * 5, 5)}\r\n`);
        await w.frames(1);
      }
      await w.frames();
    });
    const after = await page.evaluate(() => {
      const w = window as any;
      const box = w.box();
      return { top: w.scrollTop(), offset: w.pixel().offset(), text: [0.2, 0.5, 0.9].map((f) => w.textAt(box.left + 40, box.top + f * box.height)) };
    });
    assert.deepEqual(after, before);
    assert.deepEqual(await aligned(page), []);
  });

  await t.test('typing snaps to the bottom row at once, also from part of a row above it', async () => {
    const page = await rig();
    for (const rows of [-3.4, -0.3]) {
      await scrollBy(page, rows);
      assert.notEqual(await page.evaluate(() => (window as any).pixel().offset()), 0);
      await page.evaluate(() => (window as any).term.focus());
      await page.keyboard.type('x');
      await page.evaluate(() => (window as any).frames());
      const state = await page.evaluate(() => {
        const w = window as any;
        const b = w.term.buffer.active;
        return { viewport: b.viewportY, base: b.baseY, offset: w.pixel().offset(), rows: w.scrollTop() / w.cellH() };
      });
      assert.equal(state.viewport, state.base);
      assert.equal(state.offset, 0);
      assert.ok(Math.abs(state.rows - state.base) < 1e-6, `exactly on the bottom row: ${JSON.stringify(state)}`);
      assert.ok((await page.evaluate(() => (window as any).messages.filter((m: any) => m.t === 'term.input').length)) > 0);
      await page.evaluate(() => (window as any).pixel().hold(false));
    }
  });

  await t.test('Shift+Page Up glides a page by pixels and presses in a row add up', async () => {
    const page = await rig();
    await page.evaluate(() => (window as any).term.focus());
    const start = await page.evaluate(() => (window as any).term.buffer.active.baseY);
    const rows = await page.evaluate(() => (window as any).term.rows);
    await page.evaluate(() => {
      const w = window as any;
      w.offsets = [];
      w.sampling = true;
      w.sample = () => {
        w.offsets.push(w.pixel().offset());
        if (w.sampling) requestAnimationFrame(w.sample);
      };
      requestAnimationFrame(w.sample);
    });
    await page.keyboard.press('Shift+PageUp');
    await page.keyboard.press('Shift+PageUp');
    await page.waitForFunction(() => {
      const w = window as any;
      return Math.abs(w.term._core._viewport._scrollableElement._scrollable.getFutureScrollPosition().scrollTop - w.scrollTop()) < 0.01;
    });
    const result = await page.evaluate(async () => {
      const w = window as any;
      await w.frames();
      w.sampling = false;
      return { offsets: w.offsets, rows: w.scrollTop() / w.cellH(), viewport: w.term.buffer.active.viewportY };
    });
    const h = await page.evaluate(() => (window as any).cellH());
    assert.ok(result.offsets.filter((o: number) => o !== 0 && Math.abs(o) < h).length >= 3, `frames between rows: ${result.offsets.join(',')}`);
    assert.ok(Math.abs(result.rows - (start - 2 * (rows - 1))) < 1e-6, `two whole pages up: ${result.rows}`);
    assert.equal(result.viewport, start - 2 * (rows - 1));
    assert.deepEqual(await aligned(page), []);
  });

  await t.test('the alternate screen and programs reading the wheel still move by whole lines', async () => {
    const page = await rig();
    await page.evaluate(() => (window as any).feed('\x1b[?1049h'));
    await wheel(page, -2.5);
    assert.equal(await page.evaluate(() => (window as any).pixel().offset()), 0);
    assert.equal(await page.evaluate(() => document.querySelector<HTMLElement>('.xterm-screen')!.style.transform), '');
    await page.evaluate(() => (window as any).feed('\x1b[?1049l\x1b[?1000h\x1b[?1006h'));
    await page.evaluate(() => {
      const w = window as any;
      w.messages = [];
      w.pixel().hold(false);
    });
    const before = await page.evaluate(() => (window as any).scrollTop());
    await wheel(page, -2.5);
    assert.equal(await page.evaluate(() => (window as any).scrollTop()), before, 'the program gets the wheel, not the scrollback');
    assert.equal(await page.evaluate(() => (window as any).pixel().offset()), 0);
    assert.ok(await page.evaluate(() => (window as any).messages.some((m: any) => m.t === 'term.input' && m.data.startsWith('\x1b[<64;'))));
  });

  await t.test('with smoothScrollDuration forced to 0, the screen keeps whole rows', async () => {
    const page = await rig();
    await page.evaluate(() => {
      (window as any).term.options.smoothScrollDuration = 0;
    });
    await wheel(page, -4.4);
    const state = await page.evaluate(() => {
      const w = window as any;
      const box = w.box();
      const b = w.term.buffer.active;
      return { offset: w.pixel().offset(), transform: document.querySelector<HTMLElement>('.xterm-screen')!.style.transform, moved: b.viewportY < b.baseY, top: w.textAt(box.left + 40, box.top + 1) === w.expected(b.viewportY) };
    });
    assert.deepEqual(state, { offset: 0, transform: '', moved: true, top: true });
  });
});
