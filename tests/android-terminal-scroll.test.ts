import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { browserStatus, closeBrowser, launchBrowser } from '../src/server/whiteboard-browser.js';

const status = browserStatus();
const assets = fileURLToPath(new URL('../android/app/src/main/assets/', import.meta.url));
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };

test("the phone's Raw TTY follows a finger pixel for pixel and settles on a whole row", { skip: status.installed ? false : `Chromium is not installed in ${status.path}` }, async (t) => {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 400, height: 700 }, deviceScaleFactor: 2 });
  t.after(() => context.close());
  await context.route('http://phone.test/**', async (route) => {
    const file = path.join(assets, new URL(route.request().url()).pathname);
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
      for (const row of document.querySelectorAll('.xterm-rows > div')) if (row.textContent?.trimEnd() === `line ${n}`) return row.getBoundingClientRect().top;
      return null;
    }, n);
  const transform = () => page.evaluate(() => document.querySelector<HTMLElement>('.xterm-screen')!.style.transform);

  const before = await rowTop(190);
  assert.ok(before !== null);
  // Drag down (toward older lines) by a distance that is not a whole number of rows, and keep the finger there.
  await touch('touchStart', 200, 300);
  let y = 300;
  for (let i = 0; i < 12; i++) {
    y += 7.25;
    await touch('touchMove', 200, y);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
  });
  const moved = await rowTop(190);
  // Moves within the 8 px tap slop do nothing, and the first past it only starts the drag.
  const dragged = y - 300 - 2 * 7.25;
  assert.ok(moved !== null && Math.abs(moved - before - dragged) < 1, `the text moved with the finger: ${before} → ${moved}, finger ${dragged}`);
  assert.match(await transform(), /translate3d/, 'mid-row, the screen is drawn part way between rows');
  // Resting, the finger holds it there.
  await page.waitForTimeout(400);
  assert.equal(await rowTop(190), moved);
  await touch('touchEnd', 200, y);
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.xterm-screen')!.style.transform === '', undefined, { timeout: 2000 });
  const settled = await rowTop(190);
  const cell = await page.evaluate(() => document.querySelector('.xterm-rows > div')!.getBoundingClientRect().height);
  assert.ok(settled !== null && Math.abs(settled - before - Math.round((settled - before) / cell) * cell) < 0.5, `settled on a whole row: ${settled}`);
  assert.ok(Math.abs(settled - moved) <= cell / 2 + 0.5, 'settling moves less than half a row');
});
