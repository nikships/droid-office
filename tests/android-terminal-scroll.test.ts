import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { browserStatus, closeBrowser, launchBrowser } from '../src/server/whiteboard-browser.js';
import { COMPANION_THEMES } from '../src/shared/companion-themes.js';
import { blockRow, checkBlockPixels, glassTheme } from './wterm-block-pixels.js';

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

test('a streamed RIS drops pre-reset Find results and queued navigation', browserTest, async (t) => {
  const { page } = await openPhone(t);
  await page.evaluate(() => {
    const w = window as any;
    w.office.receive({ t: 'data', data: 'BIRD BIRD BIRD' });
    w.office.receive({ t: 'search', query: 'BIRD', request: 11 });
  });
  const last = () => page.evaluate(() => (window as any).posted.filter((m: any) => m.t === 'matches').at(-1));
  await page.waitForFunction(() => (window as any).posted.some((m: any) => m.count === 3 && !m.searching));
  await page.evaluate(() => {
    const w = window as any;
    w.office.receive({ t: 'data', data: '\r\n' });
    w.office.receive({ t: 'match', direction: 1 });
    w.office.receive({ t: 'data', data: '\x1b' });
    w.office.receive({ t: 'data', data: 'cfresh BIRD BIRD' });
  });
  await page.waitForFunction(() => (window as any).posted.some((m: any) => m.count === 2 && !m.searching));
  assert.deepEqual(await last(), { t: 'matches', active: 0, count: 2, searching: false, limited: false, request: 11 });
});

test('Latest during a Find rescan keeps the tail and leaves Find open', browserTest, async (t) => {
  const { page } = await openPhone(t);
  await page.evaluate(() => {
    const w = window as any;
    w.office.receive({ t: 'snapshot', cols: 40, rows: 14, data: ('BIRD\r\n' + 'line\r\n'.repeat(100)).repeat(3) });
    w.office.receive({ t: 'search', query: 'BIRD', request: 11 });
  });
  await page.waitForFunction(() => (window as any).posted.some((m: any) => m.count === 3 && !m.searching));
  await page.evaluate(() => {
    const w = window as any;
    w.office.receive({ t: 'data', data: '\x1b[?2026h\r\n' });
    w.office.receive({ t: 'match', direction: 1 });
    w.office.receive({ t: 'bottom' });
    w.office.receive({ t: 'data', data: 'BIRD\r\n\x1b[?2026l' });
  });
  await page.waitForFunction(() => (window as any).posted.some((m: any) => m.count === 4 && !m.searching));
  const result = await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    const root = document.querySelector('.office-wterm')!;
    const m = (window as any).posted.filter((m: any) => m.t === 'matches').at(-1);
    return [m.active, root.scrollHeight - root.clientHeight - root.scrollTop];
  });
  assert.deepEqual(result, [0, 0]);
});

test('reader gestures supersede pending Find steps without closing Find', browserTest, async (t) => {
  for (const gesture of ['wheel', 'touch', 'horizontal wheel', 'zoom wheel', 'horizontal swipe', 'wheel at top', 'swipe at top'] as const) {
    await t.test(gesture, async (t) => {
      const { page, context } = await openPhone(t);
      const root = page.locator('.office-wterm');
      const cdp = await context.newCDPSession(page);
      await page.evaluate(() => {
        const w = window as any;
        w.posted.length = 0;
        w.office.receive({ t: 'snapshot', cols: 40, rows: 14, data: ('BIRD\r\n' + 'line\r\n'.repeat(100)).repeat(3) });
        w.office.receive({ t: 'search', query: 'BIRD', request: 11 });
      });
      await page.waitForFunction(() => (window as any).posted.some((m: any) => m.count === 3 && !m.searching));
      await root.evaluate(async (el) => {
        el.scrollTop = 0;
        await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
        const w = window as any;
        w.office.receive({ t: 'data', data: '\x1b[?2026h\r\n' });
        w.office.receive({ t: 'match', direction: 1 });
      });
      if (gesture === 'zoom wheel') {
        await root.evaluate((el) => el.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 180, bubbles: true })));
      } else if (gesture.includes('wheel')) {
        await page.mouse.move(120, 200);
        await page.mouse.wheel(gesture === 'horizontal wheel' ? 180 : 0, gesture === 'horizontal wheel' ? 0 : gesture === 'wheel at top' ? -180 : 180);
      } else {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 120, y: 300 }] });
        const point = gesture === 'horizontal swipe' ? { x: 200, y: 300 } : { x: 120, y: gesture === 'swipe at top' ? 380 : 220 };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      if (gesture === 'wheel' || gesture === 'touch') await page.waitForFunction(() => document.querySelector('.office-wterm')!.scrollTop > 0, undefined, { timeout: 2000 });
      else
        assert.equal(
          await root.evaluate(async (el) => {
            await new Promise(requestAnimationFrame);
            return el.scrollTop;
          }),
          0,
        );
      assert.equal(await page.evaluate(() => (window as any).posted.some((m: any) => m.t === 'matches' && m.active > 0)), false);
      await page.evaluate(() => (window as any).office.receive({ t: 'data', data: 'BIRD\r\n\x1b[?2026l' }));
      await page.waitForFunction(() => (window as any).posted.some((m: any) => m.count === 4 && !m.searching));
      assert.equal(await page.evaluate(() => (window as any).posted.filter((m: any) => m.t === 'matches').at(-1).active), gesture.startsWith('horizontal') || gesture === 'zoom wheel' ? 1 : 0);
    });
  }
});

test('only Find presses after the last reader action apply to refreshed results', browserTest, async (t) => {
  for (const [action, expected] of [
    ['output at tail', 1],
    ['Find reveal', 1],
    ['prompt', 0],
    ['Latest then Previous', 3],
  ] as const) {
    await t.test(action, async (t) => {
      const { page } = await openPhone(t);
      await page.evaluate(() => {
        const w = window as any;
        w.office.receive({ t: 'snapshot', cols: 40, rows: 14, data: ('\x1b]133;A\x07BIRD\r\n' + 'line\r\n'.repeat(100)).repeat(3) });
        w.office.receive({ t: 'search', query: 'BIRD', request: 11 });
      });
      await page.waitForFunction(() => (window as any).posted.some((m: any) => m.count === 3 && !m.searching));
      const before = await page.evaluate(async (action) => {
        const w = window as any;
        const root = document.querySelector('.office-wterm')!;
        w.office.receive({ t: 'bottom' });
        await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
        const tail = root.scrollTop;
        if (action === 'Find reveal') w.office.receive({ t: 'match', direction: 1 });
        const initial = root.scrollTop;
        w.office.receive({ t: 'data', data: '\x1b[?2026h\r\n' });
        w.office.receive({ t: 'match', direction: 1 });
        if (action === 'prompt') w.office.receive({ t: 'prompt', direction: -1 });
        if (action === 'Latest then Previous') {
          w.office.receive({ t: 'bottom' });
          w.office.receive({ t: 'match', direction: -1 });
        }
        await new Promise(requestAnimationFrame);
        w.office.receive({ t: 'data', data: 'BIRD\r\n\x1b[?2026l' });
        return [tail, initial];
      }, action);
      assert.ok(before[0] > 0);
      if (action === 'Find reveal') assert.ok(before[1] < before[0]);
      await page.waitForFunction(() => (window as any).posted.some((m: any) => m.count === 4 && !m.searching));
      assert.equal(await page.evaluate(() => (window as any).posted.filter((m: any) => m.t === 'matches').at(-1).active), expected);
    });
  }
});

test('Raw TTY keeps program colors, opaque reverse-video ink and inert links on every artwork ground', browserTest, async (t) => {
  const { page } = await openPhone(t);
  const send = (msg: Record<string, unknown>) => page.evaluate((m) => (window as any).office.receive(m), msg);
  await send({ t: 'snapshot', cols: 60, rows: 12, data: '\x1b[38;2;36;40;42mink\x1b[0;7mrev\x1b[0m\x1b]8;;https://example.org\x07link\x1b]8;;\x07' });
  const root = page.locator('.office-wterm');
  for (const theme of COMPANION_THEMES) {
    const ground = theme.terminal.background;
    await send({ t: 'colors', theme: { background: theme.id === 'og' ? ground : `${ground}00` } });
    const colors = await root.evaluate(async (el) => {
      await new Promise(requestAnimationFrame);
      const spans = Array.from(el.querySelectorAll('.term-row span'));
      return [...['ink', 'rev'].map((text) => getComputedStyle(spans.find((s) => s.textContent === text)!).color), getComputedStyle(el).backgroundColor];
    });
    const rgb = ground
      .slice(1)
      .match(/../g)!
      .map((v) => parseInt(v, 16))
      .join(', ');
    assert.equal(colors[0], 'rgb(36, 40, 42)', theme.id);
    assert.equal(colors[1], `rgb(${rgb})`, theme.id);
    assert.equal(colors[2], theme.id === 'og' ? `rgb(${rgb})` : `rgba(${rgb}, 0)`, theme.id);
    assert.equal(await root.locator('a').count(), 0);
  }
});

test('partial blocks and shades expose the unframed Android pane', browserTest, async (t) => {
  const { page } = await openPhone(t);
  await page.evaluate(
    ({ data, theme }) => {
      const office = (window as any).office;
      office.receive({ t: 'colors', theme });
      office.receive({ t: 'snapshot', cols: 40, rows: 8, data });
      document.body.style.backgroundColor = '#346088';
    },
    { data: blockRow, theme: glassTheme },
  );
  await checkBlockPixels(page.locator('.office-wterm'));
});

test('the touch input does not extend the Raw TTY below its last row and fitted padding', browserTest, async (t) => {
  const { page } = await openPhone(t);
  const root = page.locator('.wterm');
  const send = (m: Record<string, unknown>) => page.evaluate((m) => (window as any).office.receive(m), m);
  for (const data of ['line\r\n'.repeat(180), 'short replay']) {
    await send({ t: 'snapshot', cols: 60, rows: 12, data });
    await root.locator('textarea').focus();
    for (const width of [700, 400]) {
      await page.setViewportSize({ width, height: 700 });
      const { expected, actual } = await root.evaluate(async (el) => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const last = Array.from(el.querySelectorAll('.term-row:not(.term-scrollback-row)')).at(-1)!;
        const end = el.scrollTop + last.getBoundingClientRect().bottom - el.getBoundingClientRect().top + parseFloat(getComputedStyle(el).paddingBottom);
        return { expected: Math.max(el.clientHeight, Math.round(end)), actual: el.scrollHeight };
      });
      assert.ok(Math.abs(expected - actual) <= 1, JSON.stringify({ expected, actual, width }));
    }
  }
});

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

test('rotating a near-tail reader at fractional density does not resume following new output', browserTest, async (t) => {
  const { page } = await openPhone(t, undefined, 2.625);
  const portrait = { width: 420, height: 700 };
  const root = page.locator('.wterm');
  const settle = () =>
    page.evaluate(async () => {
      for (let i = 0; i < 6; i++) await new Promise(requestAnimationFrame);
    });
  const position = () => root.evaluate((el) => ({ top: el.scrollTop, gap: el.scrollHeight - el.clientHeight - el.scrollTop }));
  const send = (msg: Record<string, unknown>) => page.evaluate((m) => (window as any).office.receive(m), msg);
  await page.setViewportSize(portrait);
  await send({ t: 'snapshot', cols: 136, rows: 39, data: Array.from({ length: 1000 }, (_, i) => `row ${i}\r\n`).join('') });
  await settle();
  await root.evaluate((el) => {
    el.scrollTop = el.scrollHeight - el.clientHeight - 9;
  });
  await settle();
  const before = await position();
  assert.ok(before.top > 0 && Math.abs(before.gap - 9) < 1);
  await page.setViewportSize({ width: 899, height: 260 });
  await settle();
  await page.setViewportSize(portrait);
  await settle();
  const rotated = await position();
  await send({ t: 'data', data: 'new output\r\n'.repeat(50) });
  await settle();
  const after = await position();
  t.diagnostic(JSON.stringify({ before, rotated, after }));
  assert.ok(Math.abs(rotated.top - before.top) < 2, 'rotation restores the reader');
  assert.ok(Math.abs(after.top - before.top) < 2 && after.gap > 50, 'new lines stay below the reader');
});

test('a reveal after fitting owns the viewport when the next frame paints', browserTest, async (t) => {
  const { page } = await openPhone(t);
  const send = (msg: Record<string, unknown>) => page.evaluate((m) => (window as any).office.receive(m), msg);
  const data = Array.from({ length: 220 }, (_, row) => `${row % 60 === 20 ? '\x1b]133;A\x07hit' : 'line'} ${row}\r\n`).join('');
  await send({ t: 'snapshot', cols: 40, rows: 16, data });
  await page.waitForFunction(() => (window as any).posted.some((m: any) => m.t === 'drawn'));
  await send({ t: 'search', query: 'hit', request: 1 });
  await page.waitForFunction(() => (window as any).posted.some((m: any) => m.t === 'matches' && m.request === 1 && m.count === 4 && !m.searching));
  await send({ t: 'match', direction: 1 });
  for (const [label, msg, target, active] of [
    ['Find Next', { t: 'match', direction: 1 }, 'hit 140', 2],
    ['Find Previous', { t: 'match', direction: -1 }, 'hit 80', 1],
    ['Find query', { t: 'search', query: 'line 211', request: 2 }, 'line 211', 0],
    ['previous prompt', { t: 'prompt', direction: -1 }, 'hit 20', null],
    ['next prompt', { t: 'prompt', direction: 1 }, 'hit 80', null],
    ['Latest', { t: 'bottom' }, 'line 219', null],
  ] as const) {
    await t.test(label, async () => {
      const result = await page.evaluate(
        async ({ msg, target }) => {
          const w = window as any;
          const root = document.querySelector<HTMLElement>('.wterm')!;
          root.scrollTop = parseFloat(root.style.getPropertyValue('--term-row-height')) * 60.55;
          await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
          w.office.receive({ t: 'config', fontScale: 1.1, view: 'desktop' });
          w.office.receive(msg);
          await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
          const height = parseFloat(root.style.getPropertyValue('--term-row-height'));
          const row = [...root.querySelectorAll('.term-row')].find((r) => r.textContent?.trim() === target);
          const top = row ? row.getBoundingClientRect().top - root.getBoundingClientRect().top : -Infinity;
          return { visible: top > -height && top < height * 16, reader: root.scrollTop / height, active: w.posted.filter((m: any) => m.t === 'matches').at(-1)?.active };
        },
        { msg, target },
      );
      if (active !== null) assert.equal(result.active, active);
      assert.ok(result.visible, `${target} was off screen at reader row ${result.reader}`);
    });
  }
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
  const lines = 200;
  const rows = 20;
  await page.evaluate((snapshot) => (window as any).office.receive(snapshot), { t: 'snapshot', cols: 136, rows, data: 'history\r\n'.repeat(lines) });
  await page.waitForFunction(() => (window as any).posted.some((m: any) => m.t === 'drawn'));
  const point = { x: 200, y: 510 };
  await page.waitForFunction((historyRows) => {
    const el = document.querySelector('.wterm')!;
    const rowHeight = parseFloat(getComputedStyle(el).getPropertyValue('--term-row-height'));
    // The initial spacer can be at its own tail before the snapshot's history is painted.
    return el.scrollTop >= Math.floor(historyRows * rowHeight) && el.scrollHeight - el.scrollTop - el.clientHeight < 1;
  }, lines - rows);
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

test('native Find navigates retained hits and restores the historical reader when closed', browserTest, async (t) => {
  const { page } = await openPhone(t);
  const send = (event: Record<string, unknown>) => page.evaluate((event) => (window as any).office.receive(event), event);
  const history = Array.from({ length: 120 }, (_, i) => `${i % 30 === 0 ? 'needle' : 'line'} ${i}`).join('\r\n');
  await send({ t: 'snapshot', data: history, cols: 50, rows: 20 });
  await page.waitForFunction(() => document.querySelector('.wterm')!.scrollTop > 600);
  const before = await page.locator('.wterm').evaluate((el) => {
    el.scrollTop = 610;
    return el.scrollTop;
  });
  await send({ t: 'search', query: 'needle', request: 7 });
  for (const [direction, active] of [
    [0, 0],
    [1, 1],
    [-1, 0],
  ]) {
    if (direction) await send({ t: 'match', direction });
    await page.waitForFunction((active) => {
      const msg = (window as any).posted.filter((m: any) => m.t === 'matches').at(-1);
      return msg?.active === active && msg.count === 4 && msg.request === 7;
    }, active);
  }
  assert.notEqual(await page.locator('.wterm').evaluate((el) => el.scrollTop), before);
  await send({ t: 'searchClose' });
  await page.waitForFunction((top) => Math.abs(document.querySelector('.wterm')!.scrollTop - top) < 1, before);
  assert.equal(await page.evaluate(() => (window as any).posted.some((m: any) => m.t === 'input')), false);

  await t.test('replacement snapshot closes the current Find before drawn and keeps its reading position', async () => {
    await send({ t: 'search', query: 'needle', request: 8 });
    await page.waitForFunction(() => (window as any).posted.some((m: any) => m.t === 'matches' && m.request === 8 && m.count === 4 && !m.searching));
    await send({ t: 'match', direction: 1 });
    const settled = () => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await settled();
    const reader = () => page.locator('.wterm').evaluate((el) => Math.floor(el.scrollTop / parseFloat(getComputedStyle(el).getPropertyValue('--term-row-height'))));
    const row = await reader();
    assert.ok(row > 0);
    await page.evaluate(() => {
      (window as any).posted.length = 0;
    });
    await send({ t: 'snapshot', data: history, cols: 50, rows: 20 });
    await page.waitForFunction(() => (window as any).posted.some((m: any) => m.t === 'drawn'));
    assert.deepEqual(await page.evaluate(() => (window as any).posted.filter((m: any) => m.t === 'searchClosed' || m.t === 'drawn')), [{ t: 'searchClosed', request: 8 }, { t: 'drawn' }]);
    await settled();
    assert.equal(await reader(), row);
  });
});

test('the native clipboard accepts only whole live writes and never answers queries', browserTest, async (t) => {
  const { page } = await openPhone(t);
  const osc = (text: string) => `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`;
  const data = (data: string, writable = false) => ({ t: 'data', data, writable });
  const denied = osc('split replay');
  const split = osc('split live');
  const stream = [
    { t: 'snapshot', data: osc('snapshot'), cols: 40, rows: 20, writable: true },
    data(osc('buffered')),
    data(osc('offline')),
    data(denied.slice(0, -1)),
    data(denied.slice(-1), true),
    data(osc('live'), true),
    data(split.slice(0, 2), true),
    data(split.slice(2), true),
    data('\x1b]52;c;?\x07', true),
  ];
  const messages = await page.evaluate((stream) => {
    const w = window as any;
    for (const event of stream) w.office.receive(event);
    return w.posted.filter((m: { t: string }) => ['clipboardWrite', 'input'].includes(m.t));
  }, stream);
  assert.deepEqual(messages, [
    { t: 'clipboardWrite', text: 'live' },
    { t: 'clipboardWrite', text: 'split live' },
  ]);
});

test('prompt buttons follow alternate-screen entry and exit without new shell marks', browserTest, async (t) => {
  const { page } = await openPhone(t);
  await page.evaluate(() => {
    const w = window as any;
    w.office.receive({ t: 'snapshot', data: '\x1b]133;A\x07shell % ', cols: 40, rows: 20 });
  });
  await page.waitForFunction(() => (window as any).posted.some((m: any) => m.t === 'prompts' && m.available));
  const changes = await page.evaluate(() => {
    const w = window as any;
    for (const data of ['\x1b[?1049h', 'editor', '\x1b[?1049l', 'normal']) w.office.receive({ t: 'data', data });
    return w.posted.filter((m: any) => m.t === 'prompts').map((m: any) => m.available);
  });
  assert.deepEqual(changes, [true, false, true]);
});
