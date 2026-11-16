import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const status = browserStatus();

test('terminal scrollback moves by pixels with everything drawn on it lined up', { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const bundle = buildSync({
    stdin: {
      contents:
        "export { openTerminal, routeTerminalMessage } from './src/client/ui/terminal'; export { setTerminalPrefs } from './src/client/ui/terminal-prefs'; export { pixelScrollOf, SETTLE_DELAY_MS, SETTLE_MS } from './src/client/term-pixel-scroll'; export { store } from './src/client/state'; export { Terminal } from '@xterm/xterm';",
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

  const rig = async (smooth = true) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    t.after(async () => {
      await page.close();
      assert.deepEqual(errors, []);
    });
    await page.setContent('<!doctype html><div id="mount"></div><div id="modal-root"></div>');
    await page.addStyleTag({ content: `${css}${xtermCss} body { margin: 0 }` });
    await page.addScriptTag({ content: bundle });
    await page.evaluate(
      ({ smooth }) => {
        const w = window as any;
        const { Terminal, store, openTerminal, routeTerminalMessage, setTerminalPrefs } = w.TerminalUI;
        setTerminalPrefs({ smoothScroll: smooth });
        const open = Terminal.prototype.open;
        Terminal.prototype.open = function (host: HTMLElement) {
          w.term = this;
          open.call(this, host);
        };
        const mount = document.getElementById('mount')!;
        mount.style.width = '800px';
        mount.style.height = '420px';
        const worker = { id: 'pixel', name: 'Pixel', kind: 'agent', color: '#89d9ed', status: 'idle', cols: 100, rows: 20, open: false };
        store.floor = 'floor';
        store.workers.set(worker.id, worker);
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
        w.net = {
          up: true,
          send(msg: any) {
            w.messages.push(msg);
            if (msg.t === 'worker.attach') queueMicrotask(() => routeTerminalMessage({ t: 'term.snapshot', workerId: worker.id, data: '', cols: worker.cols, rows: worker.rows, shared: false }));
            if (msg.t === 'term.resize') queueMicrotask(() => store.apply({ t: 'worker.update', worker: { ...worker, cols: msg.cols, rows: msg.rows } }));
            return true;
          },
          async request() {
            return { ok: true };
          },
          onStatus() {
            return () => {};
          },
        };
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
        w.handle = openTerminal(w.net, worker.id, undefined, undefined, { mount, focus: false, hideTeam: true });
      },
      { smooth },
    );
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
      const wrong: unknown[] = [];
      for (let y = box.top + 1; y < box.bottom - 1; y += 3) {
        const line = w.lineAt(y);
        const got = w.textAt(box.left + 40, y);
        if (got !== w.expected(line)) wrong.push({ y: y - box.top, line, got, want: w.expected(line) });
      }
      return wrong.slice(0, 5);
    });

  await t.test('a part-row scroll draws a fractional offset, the row past the edge included, and settles on a whole row', async () => {
    const page = await rig();
    await wheel(page, -4.4);
    const mid = await page.evaluate(() => {
      const w = window as any;
      const h = w.cellH();
      return { offset: w.pixel().offset(), h, frac: (w.scrollTop() / h) % 1, transform: document.querySelector<HTMLElement>('.xterm-screen')!.style.transform };
    });
    assert.ok(Math.abs(mid.offset) > 1 && Math.abs(mid.offset) < mid.h, `a part of a row: ${JSON.stringify(mid)}`);
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
  });

  await t.test('output streaming in keeps a scrolled-up reader exactly where they are', async () => {
    const page = await rig();
    await wheel(page, -6.3);
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
      await wheel(page, rows);
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

  await t.test('with smooth scrolling off, the screen keeps whole rows as before', async () => {
    const page = await rig(false);
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
