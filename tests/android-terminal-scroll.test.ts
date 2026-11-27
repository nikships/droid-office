import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { browserStatus, closeBrowser, launchBrowser } from '../src/server/whiteboard-browser.js';

const status = browserStatus();
const assets = fileURLToPath(new URL('../android/app/src/main/assets/', import.meta.url));
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.ttf': 'font/ttf' };

test("the phone's Raw TTY follows a finger pixel for pixel with native scrolling and holds a historical reader", { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 400, height: 700 }, deviceScaleFactor: 2 });
  t.after(() => context.close());
  await context.route('http://phone.test/**', async (route) => {
    const url = new URL(route.request().url());
    const file = url.pathname.startsWith('/fonts/') ? path.join(assets, '../res/font', path.basename(url.pathname)) : path.join(assets, url.pathname);
    try {
      await route.fulfill({ body: await readFile(file), contentType: TYPES[path.extname(file)] ?? 'application/octet-stream' });
    } catch {
      await route.fulfill({ status: 404, body: '' });
    }
  });
  await context.addInitScript(() => {
    const w = window as any;
    w.posted = [];
    w.OfficeBridge = {
      post(json: string) {
        w.posted.push(JSON.parse(json));
      },
    };
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto('http://phone.test/terminal/index.html');
  await page.waitForFunction(() => (window as any).posted.some((m: any) => m.t === 'ready'));
  const data = `${Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\r\n')}\r\n`;
  await page.evaluate((data) => {
    const w = window as any;
    w.office.receive({ t: 'config', fontScale: 1, view: 'desktop' });
    w.office.receive({ t: 'snapshot', data, cols: 40, rows: 20 });
  }, data);
  await page.waitForFunction(() => (window as any).posted.some((m: any) => m.t === 'drawn'));
  const cdp = await context.newCDPSession(page);
  const touch = (type: string, x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  /** Where the row showing `line N` is drawn, in page pixels. */
  const rowTop = (n: number) =>
    page.evaluate((n) => {
      for (const row of document.querySelectorAll('.term-row')) if (row.textContent?.trimEnd() === `line ${n}`) return row.getBoundingClientRect().top;
      return null;
    }, n);
  await page.waitForFunction(() => [...document.querySelectorAll('.term-row')].some((row) => row.textContent?.trimEnd() === 'line 190'));
  const before = await rowTop(190);
  assert.notEqual(before, null);
  await touch('touchStart', 200, 180);
  for (let i = 1; i <= 7; i++) {
    await touch('touchMove', 200, 180 + i * 8);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  const moved = await rowTop(190);
  assert.ok(moved !== null && moved > before! + 15 && moved <= before! + 60, 'text moves with the native pan after browser touch slop');
  await page.waitForTimeout(300);
  assert.equal(await rowTop(190), moved, 'holding the finger holds the reader');
  await touch('touchEnd', 200, 236);
  await page.evaluate(() => (window as any).office.receive({ t: 'data', data: 'new output\r\n' }));
  await page.waitForFunction(() => (window as any).posted.some((m: any) => m.t === 'bottom' && !m.at));
  assert.equal(await rowTop(190), moved, 'new output does not pull a reader down');
  await page.evaluate(() => (window as any).office.receive({ t: 'bottom' }));
  await page.waitForFunction(() => (window as any).posted.at(-1)?.at === true);
});
