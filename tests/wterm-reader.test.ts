import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';
import { createServer } from 'vite';
import { browserStatus } from '../src/server/whiteboard-browser.js';

const status = browserStatus();
const frame = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const top = (page: Page) => page.locator('.office-wterm').evaluate((el) => el.scrollTop);
test('browser focus, fit and reading in the terminal scrollport', { skip: !status.installed }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'wterm-reader-'));
  const server = await createServer({ root: fileURLToPath(new URL('../src/client', import.meta.url)), configFile: false, cacheDir, logLevel: 'error', appType: 'custom', server: { host: '127.0.0.1', port: 0, hmr: false } });
  t.after(async () => {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  });
  await server.listen();
  const port = server.httpServer!.address();
  assert.ok(port && typeof port === 'object');
  for (const dpr of [1, 2, 1.8]) {
    const browser = await chromium.launch({ executablePath: status.executable, chromiumSandbox: true, args: [`--force-device-scale-factor=${dpr}`] });
    try {
      const pane = async (surface = 'window') => {
        const page = await browser.newPage({ viewport: null });
        await page.addInitScript('window.__name = fn => fn');
        await page.route('**/fixture', (r) =>
          r.fulfill({
            contentType: 'text/html',
            body: `<link rel="stylesheet" href="/style.css"><div id="pane"><div class="modal term ${surface === 'dashboard' ? 'inline' : ''}" style="position:relative;width:640px;height:250px;animation:none"><header><button>Header</button></header><div id="host" class="${surface === 'log' ? 'changes-log' : 'term-host'}"></div></div></div>`,
          }),
        );
        await page.goto(`http://127.0.0.1:${port.port}/fixture`);
        await page.evaluate(async (surface) => {
          await document.fonts.load('14px "Geist Mono"');
          const path = '/term-engine/web-terminal.ts';
          const { createWebTerminal } = await import(path);
          if (surface === 'dashboard') {
            const pane = document.querySelector<HTMLElement>('#pane')!;
            pane.className = 'dash-pane';
            pane.style.cssText = 'width:640px;height:250px;animation:none;transition:none';
          }
          const { term } = createWebTerminal({ fontFamily: '"Geist Mono", monospace', fontSize: 14, lineHeight: 1.1, scrollback: 500 });
          if (surface === 'log') term.useWindowKeyboard();
          const w = window as any;
          w.term = term;
          w.sent = [];
          term.onData((data: string) => w.sent.push(data));
          await term.open(document.querySelector('#host'));
          term.resize(60, 32);
          term.write('row\r\n'.repeat(100));
        }, surface);
        await frame(page);
        return page;
      };
      if (dpr === 1) {
        for (const surface of ['window', 'dashboard'])
          await t.test(`Tab, click, paste and text insertion leave ${surface} at its visible tail`, async () => {
            const page = await pane(surface);
            try {
              for (const scale of ['none', 'scale(.97)']) {
                await page.locator('#pane').evaluate((el, transform) => {
                  el.style.transform = transform;
                }, scale);
                await page.getByRole('button', { name: 'Header' }).focus();
                await page.evaluate(() => (window as any).term.scrollToBottom());
                await frame(page);
                const end = await top(page);
                assert.ok(end > 500);
                await page.keyboard.press('Tab');
                assert.equal(await page.locator(':focus').textContent(), 'Find');
                await page.keyboard.press('Tab');
                assert.equal(await page.locator(':focus').evaluate((el) => el.tagName), 'TEXTAREA');
                assert.equal(await top(page), end, `${surface} Tab, ${scale}`);
                await page.locator('.office-wterm').click({ position: { x: 60, y: 70 } });
                assert.equal(await top(page), end);
                await page.keyboard.type('k');
                // Text insertion without keydown also exercises the native editable path.
                await page.keyboard.insertText('dictated');
                await page.locator('textarea').evaluate((el) => {
                  const clipboardData = new DataTransfer();
                  clipboardData.setData('text/plain', 'pasted');
                  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
                });
                await frame(page);
                assert.match(await page.evaluate(() => (window as any).sent.join('')), /kdictatedpasted/);
                assert.equal(await top(page), end);
              }
            } finally {
              await page.close();
            }
          });
        await t.test('wheel reaches the top of a taller Changes Log grid after ED3 without changing its gutter', async () => {
          const page = await pane('log');
          try {
            const geometry = () =>
              page.evaluate(() => {
                const t = (window as any).term;
                return [t.cols, t.rows, t.native.element.clientWidth, t.proposeDimensions().cols];
              });
            const old = await geometry();
            await page.evaluate(() => (window as any).term.write('\x1b[3J\x1b[H\x1b[2J'));
            await frame(page);
            await page.evaluate(() => (window as any).term.scrollToBottom());
            await frame(page);
            assert.equal(await page.evaluate(() => (window as any).term.core.getScrollbackCount()), 0);
            assert.ok((await top(page)) > 100);
            await page.locator('.office-wterm').hover();
            await page.mouse.wheel(0, -2000);
            await frame(page);
            assert.equal(await top(page), 0);
            assert.deepEqual(await geometry(), old);
          } finally {
            await page.close();
          }
        });
      }
      if (dpr !== 1.8)
        await t.test(`fractional-height fit preserves the unrounded pane's PTY rows at DPR ${dpr}`, async () => {
          const page = await pane();
          try {
            const samples = await page.evaluate(() => {
              const t = (window as any).term,
                el = t.native.element,
                host = el.parentElement;
              const pad = parseFloat(getComputedStyle(el).paddingTop) + parseFloat(getComputedStyle(el).paddingBottom);
              const paintedInset = pad + parseFloat(getComputedStyle(el.querySelector('.term-grid')).marginBottom);
              const pitch = parseFloat(el.style.getPropertyValue('--term-row-height'));
              const samples = [];
              for (let rows = 5; rows <= 42; rows++)
                for (const fraction of [0.25, 0.5, 0.75]) {
                  const height = Math.ceil(rows * pitch + 12) - 1 + fraction;
                  host.style.flex = 'none';
                  host.style.height = `${height}px`;
                  samples.push({ height, actual: t.proposeDimensions().rows, expected: Math.floor((host.clientHeight - 12) / pitch), painted: Math.floor((host.clientHeight - paintedInset) / pitch) });
                }
              return samples;
            });
            assert.deepEqual(
              samples.filter((s) => s.expected !== s.actual || s.painted !== s.actual),
              [],
            );
          } finally {
            await page.close();
          }
        });
    } finally {
      await browser.close();
    }
  }
});
