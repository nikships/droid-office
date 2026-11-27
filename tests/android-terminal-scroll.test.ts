import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { browserStatus, closeBrowser, launchBrowser } from '../src/server/whiteboard-browser.js';

const status = browserStatus();
const assets = fileURLToPath(new URL('../android/app/src/main/assets/', import.meta.url));
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.ttf': 'font/ttf' };

const browserTest = { skip: status.installed ? false : `Chromium is not installed in ${status.path}` };
async function openPhone(t: TestContext, missing?: 'fonts' | 'renderer', deviceScaleFactor = 2) {
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 400, height: 700 }, deviceScaleFactor });
  t.after(() => context.close());
  await context.route('http://phone.test/**', async (route) => {
    const url = new URL(route.request().url());
    if ((missing === 'fonts' && url.pathname.startsWith('/fonts/')) || (missing === 'renderer' && url.pathname.endsWith('/android-terminal.js'))) return route.fulfill({ status: 404, body: '' });
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
  await page.waitForFunction(() => (window as any).posted.some((m: any) => m.t === 'ready' || m.t === 'unavailable'));
  return { context, page };
}

test('fitting a wide desktop grid keeps the reader through landscape and keyboard layouts', browserTest, async (t) => {
  const { page } = await openPhone(t, undefined, 1.75);
  const frame = { t: 'snapshot', cols: 136, rows: 39, data: Array.from({ length: 220 }, (_, i) => `row ${i}\r\n`).join('') };
  await page.setViewportSize({ width: 404, height: 598 });
  await page.evaluate((m) => (window as any).office.receive(m), frame);
  await page.waitForFunction(() => document.querySelector('.wterm')!.scrollTop > 500);
  const position = () => page.locator('.wterm').evaluate((el) => el.scrollTop / parseFloat(getComputedStyle(el).getPropertyValue('--term-row-height')));
  await page.locator('.wterm').evaluate((el) => {
    el.scrollTop = 74.25 * parseFloat(getComputedStyle(el).getPropertyValue('--term-row-height'));
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const before = await position();
  for (const size of [
    { width: 899, height: 136 },
    { width: 404, height: 598 },
    { width: 404, height: 240 },
  ]) {
    await page.setViewportSize(size);
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const after = await position();
    assert.ok(Math.abs(after - before) < 0.5, `reader moved from ${before} to ${after} rows at ${size.width}x${size.height}`);
  }
  await page.evaluate(() => (window as any).office.receive({ t: 'config', fontScale: 1.3, view: 'desktop' }));
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  assert.ok(Math.abs((await position()) - before) < 0.5);
});

test('unavailable fonts fall back to monospace but the renderer is mandatory', browserTest, async (t) => {
  for (const [missing, expected] of [
    ['fonts', 'ready'],
    ['renderer', 'unavailable'],
  ] as const) {
    await t.test(missing, async (t) => {
      const { page } = await openPhone(t, missing);
      assert.equal(await page.evaluate(() => (window as any).posted.at(-1).t), expected);
    });
  }
});

test('a swipe starting below the fitted desktop grid scrolls history or its fullscreen program', browserTest, async (t) => {
  const { page, context } = await openPhone(t);
  await page.evaluate(() => {
    const w = window as any;
    w.office.receive({ t: 'snapshot', cols: 136, rows: 20, data: 'history\r\n'.repeat(200) });
  });
  await page.waitForFunction(() => (window as any).posted.some((m: any) => m.t === 'drawn'));
  const point = { x: 200, y: 510 };
  await page.waitForFunction(() => document.querySelector('.wterm')!.scrollTop > 0);
  assert.ok(await page.evaluate((y) => [...document.querySelectorAll('.term-row')].at(-1)!.getBoundingClientRect().bottom < y, point.y));
  const top = () => page.locator('.wterm').evaluate((el) => el.scrollTop);
  const before = await top();
  assert.ok(before > 0);
  const cdp = await context.newCDPSession(page);
  const drag = async () => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y + i * 12 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await drag();
  assert.ok((await top()) < before, 'the blank area belongs to the native scroll surface');
  await page.evaluate(() => (window as any).office.receive({ t: 'data', data: '\x1b[?1049h' }));
  await drag();
  assert.ok(await page.evaluate(() => (window as any).posted.some((m: any) => m.t === 'input' && m.data.includes('\x1b[A'))));
  // The wide grid has space below; the narrow one also has space on the right.
  for (const [cols, rows, x] of [
    [136, 20, 200],
    [12, 5, 360],
  ]) {
    point.x = x;
    await page.evaluate(
      ({ cols, rows }) => {
        const w = window as any;
        w.office.receive({ t: 'size', cols, rows });
        w.office.receive({ t: 'data', data: `\x1b[?1000h\x1b[?1016h\x1b[2J\x1b[H${'X'.repeat(cols)}` });
        w.posted.length = 0;
      },
      { cols, rows },
    );
    const ink = page
      .locator('.term-row')
      .filter({ hasText: new RegExp(`^X{${cols}}$`) })
      .first();
    const bounds = await ink.evaluate((row, rows) => {
      const cells = [...row.children].map((el) => el.getBoundingClientRect());
      return { left: cells[0].left, width: cells.at(-1)!.right - cells[0].left, height: row.getBoundingClientRect().height * rows };
    }, rows);
    await drag();
    const reports = await page.evaluate(() =>
      (window as any).posted
        .filter((m: any) => m.t === 'input')
        .map((m: any) => m.data)
        .join(''),
    );
    const expected = `\x1b[<64;${Math.min(Math.floor(x - bounds.left) + 1, Math.ceil(bounds.width))};${Math.ceil(bounds.height)}M`;
    assert.ok(reports.length > 0);
    assert.equal(reports, expected.repeat(reports.split('M').length - 1));
  }
});

test("the phone's Raw TTY follows a finger pixel for pixel with native scrolling and holds a historical reader", browserTest, async (t) => {
  const { context, page } = await openPhone(t);
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
  assert.ok(moved !== null && moved > before! + 15 && moved <= before! + 60, `text moves with the native pan after browser touch slop (${before} to ${moved})`);
  await page.waitForTimeout(300);
  assert.equal(await rowTop(190), moved, 'holding the finger holds the reader');
  await touch('touchEnd', 200, 236);
  await page.evaluate(() => (window as any).office.receive({ t: 'data', data: 'new output\r\n' }));
  await page.waitForFunction(() => (window as any).posted.some((m: any) => m.t === 'bottom' && !m.at));
  assert.equal(await rowTop(190), moved, 'new output does not pull a reader down');
  await page.evaluate(() => (window as any).office.receive({ t: 'bottom' }));
  await page.waitForFunction(() => (window as any).posted.at(-1)?.at === true);
  await t.test('prompt buttons follow alternate-screen entry and exit without new shell marks', async () => {
    await page.evaluate(() => (window as any).office.receive({ t: 'data', data: '\x1b]133;A\x07shell % ' }));
    await page.waitForFunction(() => (window as any).posted.some((m: any) => m.t === 'prompts' && m.available));
    const changes = await page.evaluate(() => {
      const w = window as any;
      for (const data of ['\x1b[?1049h', 'editor', '\x1b[?1049l', 'normal']) w.office.receive({ t: 'data', data });
      return w.posted.filter((m: any) => m.t === 'prompts').map((m: any) => m.available);
    });
    assert.deepEqual(changes, [true, false, true]);
  });
});
