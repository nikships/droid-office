import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const status = browserStatus();
test('Ghostty scrollback preserves the fractional reader, settles and routes application wheels', { skip: status.installed ? false : `No Chromium in ${status.path}` }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'office-ghostty-scroll-'));
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
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/fixture', (route) => route.fulfill({ contentType: 'text/html', body: '<div id="host"></div>' }));
  await page.goto(`http://127.0.0.1:${address.port}/fixture`);
  await page.evaluate(async () => {
    const a = '/term-engine/ghostty.ts',
      s = '/term-engine/ghostty-scroll.ts';
    const { GhosttyAdapter } = await import(a);
    const { attachGhosttyScroll } = await import(s);
    const w = window as any;
    const term = (w.term = new GhosttyAdapter({ scrollback: 1000, fontSize: 15, smoothScrollDuration: 125 }));
    w.scroll = attachGhosttyScroll(term);
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => !w.scroll.handleKey(e));
    await term.open(document.querySelector('#host'));
    term.resize(40, 8);
    w.sent = [];
    term.onData((d: string) => w.sent.push(d));
    term.write(Array.from({ length: 90 }, (_, i) => `row ${i}\r\n`).join(''));
    const renderer = term.native.renderer;
    const canvas = renderer.getCanvas();
    const { width, height } = renderer.getMetrics();
    w.wheel = (rows: number, options: WheelEventInit = {}) => {
      const { left, top } = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: rows * height, clientX: left + 2 * width + 1, clientY: top + height + 1, ...options }));
    };
    term.focus();
  });
  assert.deepEqual(
    await page.evaluate(() => {
      const { term, wheel } = window as any;
      term.options.scrollSensitivity = 0.5;
      wheel(-2.5);
      const { baseY, viewportY } = term.buffer.active;
      term.write('new\r\n'.repeat(7));
      term.write('\x1b[?1004h');
      term.write('');
      return [baseY - viewportY, term.buffer.active.viewportY - viewportY, term.buffer.active.baseY - baseY];
    }),
    [1.25, 0, 7],
  );
  await page.waitForFunction(() => Number.isInteger((window as any).term.native.getViewportY()));
  // A held thumb must not creep while the hand is still, and releasing it resumes settling.
  const held = await page.evaluate(() => {
    const { term, wheel } = window as any;
    wheel(-0.5);
    term.native.renderer.getCanvas().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    return term.native.getViewportY();
  });
  assert.ok(!Number.isInteger(held));
  await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  assert.equal(await page.evaluate(() => (window as any).term.native.getViewportY()), held);
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup')));
  await page.waitForFunction(() => Number.isInteger((window as any).term.native.getViewportY()));
  assert.deepEqual(
    await page.evaluate(() => {
      const { term, wheel } = window as any;
      term.paste('paste');
      const bottom = term.native.getViewportY();
      term.options.scrollSensitivity = 2;
      wheel(-1.5, { altKey: true });
      return [bottom, term.native.getViewportY()];
    }),
    [0, 15],
  );
  await page.keyboard.press('a');
  assert.equal(await page.evaluate(() => (window as any).term.native.getViewportY()), 0);
  // Chromium sends one 120-unit wheel detent even when the configured pixel delta is large.
  await page.evaluate(() => {
    (window as any).term.options.scrollSensitivity = 1;
  });
  await page.locator('#host canvas').hover();
  await page.mouse.wheel(0, -540);
  await page.waitForFunction(() => {
    const { native } = (window as any).term;
    return native.getViewportY() === Math.round(50 / native.renderer.getMetrics().height);
  });
  await page.evaluate(() => (window as any).term.scrollToBottom());
  // An external absolute move (the search path) supersedes a page glide from the old viewport.
  await page.evaluate(() => {
    const { term, scroll } = window as any;
    scroll.handleKey(new KeyboardEvent('keydown', { key: 'PageUp', shiftKey: true }));
    term.native.scrollToTop();
    term.write('more\r\n');
  });
  await page.evaluate(async () => {
    for (let i = 0; i < 12; i++) await new Promise(requestAnimationFrame);
  });
  assert.equal(await page.evaluate(() => (window as any).term.buffer.active.viewportY), 0);
  await page.evaluate(() => (window as any).term.input('i'));
  await page.evaluate(() => {
    const { term, scroll } = window as any;
    for (const key of ['PageUp', 'PageUp', 'PageUp', 'PageDown']) scroll.handleKey(new KeyboardEvent('keydown', { key, shiftKey: true }));
    term.write('new output\r\n');
  });
  // Two net pages plus the row of output that arrived while they were in flight.
  await page.waitForFunction(() => (window as any).term.native.getViewportY() === 15);
  await page.evaluate(() => {
    const { term, scroll } = window as any;
    scroll.handleKey(new KeyboardEvent('keydown', { key: 'PageUp', shiftKey: true }));
    term.options.smoothScrollDuration = 0;
    term.scrollToBottom();
    term.options.smoothScrollDuration = 125;
    scroll.snap();
  });
  await page.evaluate(async () => {
    for (let i = 0; i < 12; i++) await new Promise(requestAnimationFrame);
  });
  assert.equal(await page.evaluate(() => (window as any).term.native.getViewportY()), 0);
  assert.deepEqual(
    await page.evaluate(() => {
      const { term, wheel, sent } = window as any;
      term.options.scrollSensitivity = 1;
      term.write('\x1b[?1049h');
      sent.length = 0;
      for (let i = 0; i < 4; i++) wheel(-1); // 0.3 rows each, one arrow in total
      term.write('\x1b[?1h');
      wheel(1, { deltaY: 1, deltaMode: WheelEvent.DOM_DELTA_LINE });
      term.write('\x1b[?1000h\x1b[?1006h');
      wheel(-5);
      wheel(5, { shiftKey: true });
      term.write('\x1b[?1049l'); // reporting on the normal screen, too
      wheel(5, { altKey: true });
      term.options.disableStdin = true;
      wheel(-5);
      return sent;
    }),
    ['\x1b[A', '\x1bOB', '\x1b[<64;3;2M', '\x1b[<73;3;2M'],
  );
  await t.test('top-of-history height growth clamps the native viewport', async () => {
    assert.deepEqual(
      await page.evaluate(() => {
        const { term } = window as any;
        return [40, 8].map((lines) => {
          term.reset();
          term.resize(40, 8);
          term.write('x\r\n'.repeat(lines));
          term.native.scrollToTop();
          const oldDepth = term.native.getViewportY();
          term.resize(40, 10);
          return [oldDepth, term.native.getViewportY(), term.native.getScrollbackLength(), term.buffer.active.viewportY];
        });
      }),
      [
        [33, 31, 31, 0],
        [1, 0, 0, 0],
      ],
    );
  });
  await page.evaluate(() => (window as any).term.dispose());
  assert.deepEqual(errors, []);
});
