import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { createServer } from 'vite';
import { screenSnapshot } from '../src/server/screen.js';
import { browserStatus, closeBrowser, launchBrowser } from '../src/server/whiteboard-browser.js';
import { KITTY_DIACRITICS, KITTY_PLACEHOLDER_CHAR } from '../src/shared/kitty.js';

const apc = (s: string) => `\x1b_G${s}\x1b\\`;
const red = 0xff0000ff,
  blue = 0x0000ffff;
test('wterm and xterm Kitty placements on real Chromium', { skip: !browserStatus().installed }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'office-wterm-graphics-'));
  const server = await createServer({
    root: fileURLToPath(new URL('../src/client', import.meta.url)),
    configFile: false,
    resolve: { alias: { '/oracle': fileURLToPath(new URL('./oracle', import.meta.url)) } },
    cacheDir,
    logLevel: 'error',
    appType: 'custom',
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true, include: ['@wterm/dom', '@wterm/ghostty', '@xterm/xterm'] },
  });
  t.after(async () => {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  });
  await server.listen();
  const addr = server.httpServer!.address();
  assert.ok(addr && typeof addr === 'object');
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(3500);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/fixture', (route) => route.fulfill({ contentType: 'text/html', body: '<style>.host{width:420px;height:144px;position:relative;}</style><div id="w" class="host"></div><div id="x" class="host"></div>' }));
  await page.goto(`http://127.0.0.1:${addr.port}/fixture`);
  await page.addStyleTag({ url: '/style.css?direct' });
  await page.evaluate(async () => {
    const modules = ['/oracle/terminal.ts', '/term-engine/wterm-graphics.ts', '/oracle/kitty.ts'];
    const [{ comparisonTerminal }, { attachWtermGraphics }, { attachKittyTerminal }] = await Promise.all(modules.map((m) => import(m)));
    const win = window as any;
    const opts = { fontSize: 16, fontFamily: 'monospace', lineHeight: 1.1, scrollback: 100, allowProposedApi: true };
    const w = (win.wt = comparisonTerminal(opts, 'ghostty'));
    const x = (win.xt = comparisonTerminal(opts, 'xterm'));
    win.expandImage = async (img: { imageId: number; blob: Blob }) => {
      const bmp = await createImageBitmap(img.blob);
      win.expanded = [img.imageId, bmp.width, bmp.height];
      bmp.close();
    };
    win.graphics = attachWtermGraphics(w, { onExpandImage: win.expandImage });
    if (win.graphics.expandAtClient(0, 0)) throw new Error('expanded before open');
    attachKittyTerminal(x, { onExpandImage: win.expandImage });
    x.open(document.querySelector('#x'));
    const pitch = x.element.querySelector('.xterm-rows > div').getBoundingClientRect().height;
    for (const host of document.querySelectorAll<HTMLElement>('.host')) host.style.height = `${8 * pitch}px`;
    await w.open(document.querySelector('#w'));
    x.resize(40, 8);
    w.resize(40, 8);
    win.sent = [];
    w.onData((s: string) => win.sent.push(s));
    win.pixel = (kind: string, col: number, row: number, background = false) => {
      const screen = document.querySelector<HTMLElement>(kind === 'w' ? '.wterm-kitty-screen' : '.xterm-screen')!;
      const c = screen.querySelector<HTMLCanvasElement>(background ? 'canvas:not(.term-kitty-layer)' : 'canvas.term-kitty-layer')!;
      if (!c.width || !c.height) return 0;
      const style = getComputedStyle(w.native.element);
      const cellW = kind === 'w' ? parseFloat(style.getPropertyValue('--term-cell-width')) : screen.clientWidth / x.cols;
      const cellH = kind === 'w' ? parseFloat(style.getPropertyValue('--term-row-height')) : screen.clientHeight / x.rows;
      const data = c.getContext('2d')!.getImageData(Math.floor((col + 0.5) * cellW * devicePixelRatio), Math.floor((row + 0.5) * cellH * devicePixelRatio), 1, 1).data;
      return new DataView(data.buffer).getUint32(0);
    };
  });
  const write = (data: string) =>
    page.evaluate(async (data) => {
      const { wt, xt } = window as any;
      await Promise.all([wt, xt].map((term) => new Promise((r) => term.write(data, r))));
    }, data);
  const both = (col: number, row: number, color: number) =>
    page.waitForFunction(
      ([c, r, v]) => {
        const { pixel } = window as any;
        return pixel('w', c, r) === v && pixel('x', c, r) === v;
      },
      [col, row, color],
    );
  const reset = () =>
    page.evaluate(() => {
      const { wt, xt } = window as any;
      wt.reset();
      xt.reset();
    });
  const packed = deflateSync(Buffer.from([255, 0, 0])).toString('base64');
  await t.test('split compressed RGB, placement cursor, z-order, C=1 and deletion', async () => {
    await write(`label\r\n${apc(`a=t,i=2,f=24,o=z,s=1,v=1,m=1;${packed.slice(0, 4)}`)}`);
    const end = apc(`m=0;${packed.slice(4)}`) + apc('a=p,i=2,p=7,c=4,r=3,z=-1');
    await write(end.slice(0, -1));
    await write(`${end.slice(-1)}X`);
    assert.deepEqual(
      await page.evaluate(() => {
        const { wt, xt } = window as any;
        return [
          [wt.core.getCursor().col, wt.core.getCursor().row],
          [xt.buffer.active.cursorX, xt.buffer.active.cursorY],
        ];
      }),
      [
        [5, 3],
        [5, 3],
      ],
    );
    await page.waitForFunction(() => {
      const { pixel } = window as any;
      return pixel('w', 1, 1, true) === pixel('x', 1, 1) && pixel('w', 1, 1, true) === 0xff0000ff && pixel('w', 1, 1) === 0;
    });
    await write(`\x1b[2;1H${apc('a=T,i=3,f=32,s=1,v=1,c=3,r=2,z=2,C=1;AAD//w==')}T`);
    await both(1, 1, blue);
    assert.deepEqual(
      await page.evaluate(() => {
        const { wt, xt } = window as any;
        return [wt.core.getCursor().col, xt.buffer.active.cursorX, wt.core.getResourceState().graphics.used];
      }),
      [1, 1, 0],
    );
    await write(apc('a=d,d=i,i=3'));
    await page.waitForFunction(() => {
      const { pixel } = window as any;
      return !pixel('w', 1, 1) && pixel('w', 1, 1, true) === pixel('x', 1, 1) && pixel('x', 1, 1) === 0xff0000ff;
    });
    // Read final composited pixels, not just the backing stores. The white T
    // must be visible over the negative placement and covered by a positive one.
    const clip = await page.evaluate(() => {
      const row = document.querySelectorAll('.wterm .term-row')[1].getBoundingClientRect();
      return { x: Math.ceil(row.x), y: Math.ceil(row.y), width: 18, height: Math.floor(row.height) };
    });
    const ink = async () => {
      const png = await page.screenshot({ clip });
      return page.evaluate(async (b64) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const c = document.createElement('canvas');
        c.width = bmp.width;
        c.height = bmp.height;
        const g = c.getContext('2d')!;
        g.drawImage(bmp, 0, 0);
        bmp.close();
        const pixels = g.getImageData(0, 0, c.width, c.height).data;
        let red = 0,
          white = 0,
          blue = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] === 255 && !pixels[i + 1] && !pixels[i + 2]) red++;
          if (pixels[i + 1] > 100 && pixels[i + 2] > 100) white++;
          if (!pixels[i] && !pixels[i + 1] && pixels[i + 2] === 255) blue++;
        }
        return { red, white, blue };
      }, png.toString('base64'));
    };
    const back = await ink();
    assert.ok(back.red > 0 && back.white > 0, JSON.stringify(back));
    await write(`\x1b[2;1H${apc('a=T,i=3,f=32,s=1,v=1,c=3,r=2,C=1,z=2;AAD//w==')}`);
    await both(1, 1, blue);
    const front = await ink();
    assert.ok(front.blue > 0 && front.white === 0, JSON.stringify(front));
  });
  await t.test('61st placement stays invisible, advances the cursor and can be retried after deletion', async () => {
    await reset();
    await write(apc('a=t,i=9,f=24,s=1,v=1;/wAA') + Array.from({ length: 60 }, (_, i) => apc(`a=p,i=9,p=${i + 1},c=1,r=1,C=1`)).join(''));
    await both(0, 0, red);
    await write(`\x1b[3;5H${apc('a=p,i=9,p=61,c=2,r=2')}`);
    await page.waitForFunction(() => {
      const { pixel } = window as any;
      return pixel('x', 4, 2) === 0xff0000ff && pixel('w', 4, 2) === 0;
    });
    assert.deepEqual(
      await page.evaluate(() => {
        const { wt, xt } = window as any;
        return [
          [wt.core.getCursor().row, wt.core.getCursor().col],
          [xt.buffer.active.cursorY, xt.buffer.active.cursorX],
        ];
      }),
      [
        [3, 6],
        [3, 6],
      ],
    );
    await write(`${apc('a=d,d=i,i=9,p=1')}\x1b[3;5H${apc('a=p,i=9,p=61,c=2,r=2,C=1')}`);
    await both(4, 2, red);
  });
  await t.test('replayed direct and virtual placements, clipping, overwritten placeholder, reset', async () => {
    const host = new headless.Terminal({ rows: 8, cols: 40, allowProposedApi: true });
    const serializer = new serialize.SerializeAddon();
    host.loadAddon(serializer);
    try {
      const snapshot = screenSnapshot(host, serializer);
      const cell = (c: number) => KITTY_PLACEHOLDER_CHAR + String.fromCodePoint(KITTY_DIACRITICS[0], KITTY_DIACRITICS[c]);
      await new Promise<void>((done) => host.write(`head\r\n${apc('a=T,f=32,s=1,v=1,c=4,r=2,i=4,C=1;/wAA/w==')}\x1b[4;39H${apc('a=T,i=5,U=1,c=2,r=1,f=24,s=1,v=1;AAD/')}\x1b[38;2;0;0;5m${cell(0)}${cell(1)}\x1b[0m`, done));
      await reset();
      await write(snapshot());
      await both(2, 2, red);
      await both(39, 3, blue);
      await write('\x1b[4;40H ');
      await both(39, 3, 0);
      await both(38, 3, blue);
      await write('\x1b[?1049h');
      await both(0, 1, 0);
      await write('\x1b[?1049l');
      await both(38, 3, blue);
      await both(1, 1, red);
      await write('\x1bc');
      await both(38, 3, 0);
      await write(`\x1bc${apc('a=T,i=5,U=1,c=1,r=1,f=24,s=1,v=1;AAD/')}\x1b[38;2;0;0;5m${cell(0)}`);
      await both(0, 0, blue);
      await reset();
    } finally {
      host.dispose();
    }
  });
  await t.test('alternate-screen applications preserve normal history pins unless resized, including ED 3 in alternate', async () => {
    for (const mode of [47, 1047, 1049]) {
      await reset();
      await write(`FIRST\r\nUNIQUE${apc('a=T,i=12,c=2,r=1,C=1,f=24,s=1,v=1;/wAA')}${'\r\nother'.repeat(12)}`);
      await page.waitForFunction(() => (window as any).wt.native.element.scrollTop > 0);
      const scrollUp = () =>
        page.evaluate(() => {
          const { wt, xt } = window as any;
          wt.native.element.scrollTop = 0;
          xt.scrollToTop();
        });
      await scrollUp();
      await both(6, 1, red);
      await write(`\x1b[?${mode}h${'alt\r\n'.repeat(20)}\x1b[2J\x1b[3J`);
      await both(6, 1, 0);
      await write(`\x1b[?${mode}l`);
      await page.waitForFunction(() => (window as any).wt.native.element.scrollTop > 0);
      await scrollUp();
      await both(6, 1, red);
      assert.deepEqual(
        await page.evaluate(() => {
          const { wt, xt } = window as any;
          const c = wt.core;
          return [Array.from({ length: 6 }, (_, i) => String.fromCodePoint(c.getScrollbackCell(c.getScrollbackCount() - 2, i).char)).join(''), xt.buffer.active.getLine(1).translateToString(true)];
        }),
        ['UNIQUE', 'UNIQUE'],
      );
      // The final grid and history count match: the intermediate resize is the
      // only reason the recorded row is unsafe, even with no intervening paint.
      await write(`\x1b[?${mode}h`);
      await page.evaluate(() => {
        const { wt, xt } = window as any;
        for (const term of [wt, xt]) {
          term.resize(33, 7);
          term.resize(40, 8);
        }
      });
      await write(`\x1b[?${mode}l`);
      await scrollUp();
      await page.waitForFunction(() => {
        const { pixel } = window as any;
        const c = document.querySelector<HTMLCanvasElement>('.wterm .term-kitty-layer')!;
        return !c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.some(Boolean) && pixel('x', 6, 1) === 0xff0000ff;
      });
    }
  });
  await t.test('PNG, animation frame, plain / modified click, button, mouse reporting outside image', async () => {
    await reset();
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const g = c.getContext('2d')!;
      g.fillStyle = 'red';
      g.fillRect(0, 0, 1, 1);
      return c.toDataURL().split(',')[1];
    });
    await write(`\x1b_Ga=T,i=7,f=100,c=9,r=5,C=1;${png}\x07`);
    await both(1, 1, red);
    const point = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.wterm')!,
        r = document.querySelector('.wterm-kitty-screen')!.getBoundingClientRect(),
        style = getComputedStyle(root);
      return { x: r.x + parseFloat(style.getPropertyValue('--term-cell-width')) * 2, y: r.y + parseFloat(style.getPropertyValue('--term-row-height')) * 2 };
    });
    const expanded = async () => {
      await page.waitForFunction(() => !!(window as any).expanded);
      assert.deepEqual(
        await page.evaluate(() => {
          const w = window as any,
            v = w.expanded;
          w.expanded = null;
          return v;
        }),
        [7, 1, 1],
      );
    };
    await page.mouse.click(point.x, point.y);
    await expanded();
    await page.mouse.move(point.x, point.y);
    await page.locator('#w .term-kitty-expand').click();
    await expanded();
    await write('\x1b[?1000h\x1b[?1006h');
    await page.keyboard.down('Control');
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up('Control');
    await expanded();
    assert.deepEqual(await page.evaluate(() => (window as any).sent), []);
    await page.mouse.click(point.x + 190, point.y);
    assert.ok(await page.evaluate(() => (window as any).sent.some((s: string) => s.startsWith('\x1b[<'))));
    await write(`\x1b[?1000l\x1b[?1006l${apc('a=f,i=7,f=24,s=1,v=1,z=400;AAD/')}`);
    await both(1, 1, blue);
    await write(apc('a=d,d=A'));
    await both(1, 1, 0);
  });
  await t.test('native tap uses painted coordinates and not desktop mouse policy', async () => {
    await reset();
    const cell = KITTY_PLACEHOLDER_CHAR + String.fromCodePoint(KITTY_DIACRITICS[0], KITTY_DIACRITICS[0]);
    await write(`\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[3;14H${apc('a=T,i=41,U=1,c=1,r=1,f=24,s=1,v=1;/wAA')}\x1b[38;2;0;0;41m${cell}\x1b[0m`);
    await page.waitForFunction(() => (window as any).pixel('w', 13, 2) === 0xff0000ff);
    const tapped = await page.evaluate(() => {
      const w = window as any,
        host = document.querySelector<HTMLElement>('#w')!;
      const canvas = host.querySelector<HTMLCanvasElement>('.term-kitty-layer')!;
      const before = canvas.toDataURL();
      host.style.transformOrigin = 'top left';
      host.style.transform = 'scale(.625,.75)';
      const rect = canvas.getBoundingClientRect(),
        style = getComputedStyle(w.wt.native.element);
      const col = parseFloat(style.getPropertyValue('--term-cell-width')) * 0.625;
      const row = parseFloat(style.getPropertyValue('--term-row-height')) * 0.75;
      const x = rect.left + 13.5 * col,
        y = rect.top + 2.5 * row;
      w.sent.length = 0;
      return {
        x,
        y,
        miss: w.graphics.expandAtClient(rect.left + 15.5 * col, y),
        hit: w.graphics.expandAtClient(x, y),
        sameCanvas: canvas.toDataURL() === before,
      };
    });
    assert.ok(tapped.hit && !tapped.miss && tapped.sameCanvas);
    await page.waitForFunction(() => (window as any).expanded?.[0] === 41);
    assert.deepEqual(await page.evaluate(() => (window as any).sent), []);
    await page.evaluate(() => {
      (window as any).expanded = null;
    });
    await page.mouse.click(tapped.x, tapped.y);
    assert.ok(await page.evaluate(() => (window as any).sent.some((s: string) => s.startsWith('\x1b[<')) && !(window as any).expanded));
    await write(apc('a=d,d=A'));
    assert.equal(await page.evaluate(({ x, y }) => (window as any).graphics.expandAtClient(x, y), tapped), false);
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('#w')!.style.transform = '';
    });
  });
  await t.test('native fractional scroll, partly shown top row, metrics changes, selection outside image', async () => {
    await reset();
    await write(`START\r\n${apc('a=T,i=8,c=6,r=3,C=1,f=24,s=1,v=1;/wAA')}${'row\r\n'.repeat(16)}`);
    await page.waitForFunction(() => (window as any).wt.native.element.scrollTop > 0);
    await page.evaluate(() => {
      const { wt, xt } = window as any;
      wt.native.element.scrollTop = 0;
      xt.scrollToTop();
    });
    await both(1, 1, red);
    const measured = await page.evaluate(() => {
      const root = (window as any).wt.native.element,
        screen = document.querySelector('.wterm-kitty-screen')!;
      const a = screen.getBoundingClientRect().top;
      root.scrollTop = 5;
      return [root.scrollTop, a - screen.getBoundingClientRect().top];
    });
    assert.deepEqual(measured, [5, 5], 'canvas scrolls synchronously even before the scroll event');
    await page.evaluate(async () => {
      const { wt, xt } = window as any;
      wt.options.fontSize = xt.options.fontSize = 18;
      wt.resize(32, 7);
      xt.resize(32, 7);
      // Let the resized grid and history spacer paint before scrolling to the new origin.
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      wt.native.element.scrollTop = 0;
      xt.scrollToTop();
    });
    await both(1, 1, red);
    const row = page.locator('#w .term-row').filter({ hasText: 'START' }).first();
    await row.waitFor({ state: 'visible' });
    const rect = await row.boundingBox();
    assert.ok(rect);
    await page.mouse.move(rect.x + 1, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + 60, rect.y + rect.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.match(await page.evaluate(() => document.getSelection()?.toString() ?? ''), /START/);
  });
  await page.evaluate(() => {
    const { wt, xt } = window as any;
    wt.dispose();
    xt.dispose();
    if ((window as any).graphics.expandAtClient(0, 0)) throw new Error('expanded after dispose');
  });
  assert.equal(await page.locator('canvas.term-kitty-layer,.wterm-kitty-screen').count(), 0);
  assert.deepEqual(errors, []);
});
