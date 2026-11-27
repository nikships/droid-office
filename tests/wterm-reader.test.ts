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
  for (const dpr of [0.8, 1, 2, 1.8, 2.2]) {
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
      if (dpr < 1) {
        await t.test('below DPR 1 the tail tolerance is one device pixel, not one CSS pixel', async () => {
          const page = await pane();
          try {
            const samples = await page.locator('.office-wterm').evaluate((el) => {
              const t = (window as any).term;
              const host = el.parentElement!;
              host.style.flex = 'none';
              const samples = [];
              for (let height = 240; height < 250; height++) {
                host.style.height = `${height}px`;
                const range = el.scrollHeight - el.clientHeight;
                el.scrollTop = range - 1;
                samples.push({ gap: range - el.scrollTop, pinned: t.isAtTail(), tolerance: 1 / devicePixelRatio });
              }
              return samples;
            });
            assert.ok(samples.some((s) => s.gap >= 1 && s.gap < s.tolerance));
            assert.ok(samples.some((s) => s.gap >= s.tolerance));
            for (const s of samples) assert.equal(s.pinned, s.gap < s.tolerance);
          } finally {
            await page.close();
          }
        });
        continue;
      }
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
                await page.getByRole('button', { name: 'Header' }).focus();
                await page.locator('.office-wterm').click({ position: { x: 60, y: 70 } });
                assert.equal(await page.locator(':focus').evaluate((el) => el.tagName), 'TEXTAREA');
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
            const end = await top(page);
            await page.mouse.wheel(0, -31);
            await frame(page);
            assert.equal(await top(page), end - 31);
            const idleEvents = await page.locator('.office-wterm').evaluate(async (el) => {
              let events = 0;
              const life = new AbortController();
              el.addEventListener('scroll', () => events++, { signal: life.signal });
              for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
              life.abort();
              return events;
            });
            assert.ok(idleEvents <= 1, `idle scroll events: ${idleEvents}`);
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
            const samples = await page.evaluate(async () => {
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
                  // Sample the cached proposal after the adapter has observed this box.
                  await new Promise<void>((resolve) => {
                    const observer = new ResizeObserver(() => {
                      observer.disconnect();
                      resolve();
                    });
                    observer.observe(el);
                  });
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
      if (dpr === 1)
        for (const kind of ['horizontal history', 'alternate pinch', 'tracked travel', 'tracked near-tail reader']) {
          await t.test(kind, async () => {
            const page = await pane();
            try {
              const state = await page.evaluate(async (kind) => {
                const w = window as any,
                  t = w.term,
                  el = t.native.element;
                const frame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
                if (kind === 'alternate pinch') t.write('\x1b[?1049h');
                if (kind.startsWith('tracked')) t.write('\x1b[?1000;1006h');
                await frame();
                t.scrollToBottom();
                if (kind === 'horizontal history') el.scrollTop -= 60;
                if (kind === 'tracked near-tail reader') el.scrollTop -= 2;
                await frame();
                const previous = el.scrollTop;
                const row = el.querySelectorAll('.term-row:not(.term-scrollback-row)')[20];
                const rect = row.getBoundingClientRect();
                const pitch = parseFloat(el.style.getPropertyValue('--term-row-height'));
                const wheel = (x: number, y: number, opts: WheelEventInit = {}) =>
                  !row.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: rect.left + 2, clientY: rect.top + 2, deltaX: x, deltaY: y, ...opts }));
                const cancelled = [],
                  counts = [];
                w.sent.length = 0;
                if (kind === 'horizontal history')
                  for (const speed of [0.5, 2, 1]) {
                    t.options.scrollSensitivity = speed;
                    cancelled.push(wheel(80, 2, { altKey: speed === 1 }));
                  }
                if (kind === 'alternate pinch') cancelled.push(wheel(0, -120, { ctrlKey: true }), wheel(80, 2));
                if (kind === 'tracked near-tail reader') cancelled.push(wheel(0, -30));
                if (kind === 'tracked travel') {
                  for (const axis of ['y', 'x']) {
                    for (let i = 0; i < pitch; i++) {
                      wheel(axis === 'x' ? -1 : 0, axis === 'y' ? -1 : 0);
                      counts.push(w.sent.length);
                    }
                  }
                }
                return { previous, after: el.scrollTop, cancelled, sent: w.sent, counts, pitch };
              }, kind);
              if (kind === 'tracked travel') {
                assert.deepEqual(
                  state.counts,
                  Array.from({ length: state.pitch * 2 }, (_, i) => Math.floor((i + 1) / state.pitch)),
                );
                assert.equal(state.sent.length, 2);
                assert.match(state.sent[0], /^\x1b\[<64;/);
                assert.match(state.sent[1], /^\x1b\[<66;/);
              } else {
                assert.equal(state.after, state.previous);
                assert.ok(
                  state.cancelled.every((v) => !v),
                  JSON.stringify(state),
                );
                assert.deepEqual(state.sent, []);
                if (kind === 'tracked near-tail reader') {
                  await page.locator('.office-wterm').hover();
                  await page.mouse.wheel(0, -2);
                  await frame(page);
                  assert.equal(await top(page), state.previous - 2);
                  assert.deepEqual(await page.evaluate(() => (window as any).sent), []);
                }
              }
            } finally {
              await page.close();
            }
          });
        }
      if (dpr === 1) {
        for (const action of ['empty Find', 'close empty Find', 'Find without a match', 'Next prompt without a target'])
          await t.test(`${action} keeps a near-tail reader during output`, async () => {
            const page = await pane();
            try {
              await page.evaluate(() => (window as any).term.write('\x1b]133;A\x07'));
              await frame(page);
              const root = page.locator('.office-wterm');
              await root.hover();
              await page.mouse.wheel(0, -2);
              await frame(page);
              const before = await top(page);
              if (action.startsWith('Next')) {
                await page.getByRole('button', { name: 'Next prompt', exact: true }).evaluate((b) => b.click());
              } else {
                await root.getByRole('button', { name: /Find in terminal/ }).click();
                const field = page.getByRole('textbox', { name: 'Find in terminal' });
                if (action.startsWith('close')) await field.press('Escape');
                if (action.includes('without')) {
                  await field.fill('absent phrase');
                  await page.getByText('No matches', { exact: true }).waitFor();
                }
              }
              await page.evaluate(() => (window as any).term.write('stream\r\n'));
              await frame(page);
              assert.equal(await top(page), before);
            } finally {
              await page.close();
            }
          });
        for (const surface of ['window', 'log'])
          await t.test(`a clipped alternate ${surface} retains its thumb offset through paint`, async () => {
            const page = await pane(surface);
            try {
              await page.evaluate(() => {
                const { term } = window as any;
                term.write('\x1b[3J\x1b[?1049h');
              });
              await frame(page);
              const root = page.locator('.office-wterm');
              const requested = await root.evaluate((e) => {
                e.scrollTop = 53;
                return e.scrollTop;
              });
              assert.equal(requested, 53);
              await frame(page);
              await page.evaluate(() => (window as any).term.write('updated'));
              await frame(page);
              assert.equal(await top(page), requested);
            } finally {
              await page.close();
            }
          });
        await t.test('wheel fractions belong to the program and tracking mode that received them', async () => {
          const page = await pane();
          try {
            const results = await page.evaluate(async () => {
              const { term, sent } = window as any,
                el = term.native.element;
              const frame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
              const row = () => el.querySelector('.term-row:not(.term-scrollback-row)');
              const wheel = (y: number) => {
                const rect = row().getBoundingClientRect();
                row().dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -y, clientX: rect.left + 2, clientY: rect.top + 2 }));
              };
              const height = parseFloat(el.style.getPropertyValue('--term-row-height')),
                results = [];
              term.resize(40, 8);
              for (const [initial, transition] of [
                ['\x1b[?1049;1000;1006h', '\x1b[?1000;1049l\x1b[?1049;1000h'],
                ['\x1b[?1049;1000;1006h', '\x1b[?1000l\x1b[?1002h'],
                ['\x1b[?1049h', '\x1b[?1049l\x1b[?1049h'],
              ]) {
                term.reset();
                term.write(initial);
                await frame();
                sent.length = 0;
                wheel(height - 1);
                term.write(transition);
                await frame();
                wheel(1);
                results.push({ after: sent.splice(0) });
                wheel(height - 1);
                results.at(-1).whole = sent.splice(0);
              }
              return results;
            });
            assert.deepEqual(
              results.map((r) => r.after),
              [[], [], []],
            );
            assert.deepEqual(
              results.map((r) => r.whole.length),
              [1, 1, 1],
            );
          } finally {
            await page.close();
          }
        });
      }
      if (dpr === 2.2)
        await t.test('a 0.9px Shift-wheel at Retina 110% stays at the tail for reporting and output', async () => {
          const page = await pane();
          try {
            const el = page.locator('.office-wterm');
            await page.evaluate(() => (window as any).term.write('\x1b[?1000;1006h'));
            await frame(page);
            await el.hover();
            const end = await top(page);
            await page.keyboard.down('Shift');
            await page.mouse.wheel(0, -1);
            await page.keyboard.up('Shift');
            await frame(page);
            const offset = end - (await top(page));
            assert.ok(offset > 0.89 && offset < 0.92, `Shift+wheel moved ${offset}px`);
            await page.mouse.wheel(0, -30);
            await frame(page);
            assert.match(await page.evaluate(() => (window as any).sent.join('')), /^\x1b\[<64;/);
            await page.evaluate(() => (window as any).term.write('next\r\n'));
            await frame(page);
            assert.ok((await top(page)) > end);
          } finally {
            await page.close();
          }
        });
      if (dpr === 1.8) {
        for (const action of ['wheel to end', 'close Find'])
          await t.test(`one device pixel short at DPR 1.8 still follows the tail after ${action}`, async () => {
            const page = await pane(action === 'close Find' ? 'log' : 'window');
            try {
              const el = page.locator('.office-wterm');
              await page.evaluate(() => (window as any).term.write(`needle\r\n${'more\r\n'.repeat(50)}`));
              await frame(page);
              const end = await el.evaluate((el) => {
                (window as any).term.scrollToBottom();
                const end = el.scrollTop;
                el.scrollTop -= 1 / devicePixelRatio;
                return end;
              });
              await frame(page);
              const start = await top(page);
              assert.ok(end - start > 0.54 && end - start < 0.57, `${end} -> ${start}`);
              if (action === 'close Find') {
                await el.getByRole('button', { name: /Find in terminal/ }).click();
                const field = page.getByRole('textbox', { name: 'Find in terminal' });
                await field.fill('needle');
                await page.getByText('1 of 1', { exact: true }).waitFor();
                await frame(page);
                assert.ok((await top(page)) < start - 100, 'Find revealed the earlier hit');
                await field.press('Escape');
                await frame(page);
                assert.equal(await top(page), end);
              } else {
                await el.hover();
                await page.mouse.wheel(0, 10000);
                await frame(page);
                assert.equal(await top(page), start, 'the compositor already considers this the end');
                await page.evaluate(() => (window as any).term.write('more\r\n'));
                await frame(page);
                assert.ok((await top(page)) > end, `output did not follow from ${start}`);
              }
            } finally {
              await page.close();
            }
          });
      }
      await t.test(`a two-pixel reader holds through twenty streamed lines and resumes at the end at DPR ${dpr}`, async () => {
        const page = await pane();
        try {
          const el = page.locator('.office-wterm');
          const tail = await top(page);
          await el.hover();
          await page.mouse.wheel(0, -2);
          await frame(page);
          const reader = await top(page);
          assert.ok(reader < tail && tail - reader < 4, `${tail} → ${reader}`);
          for (let i = 0; i < 20; i++) {
            await page.evaluate(() => (window as any).term.write('next\r\n'));
            await frame(page);
            assert.equal(await top(page), reader, `output ${i + 1}`);
          }
          await page.mouse.wheel(0, 8000);
          await frame(page);
          const following = await top(page);
          assert.ok(following > tail);
          await page.evaluate(() => (window as any).term.write('latest\r\n'));
          await frame(page);
          assert.ok((await top(page)) > following);
          await page.mouse.wheel(0, -2);
          await frame(page);
          await page.locator('textarea').evaluate((el) => el.focus({ preventScroll: true }));
          await page.keyboard.press('k');
          await page.evaluate(() => (window as any).term.write('k\r\n'));
          await frame(page);
          assert.ok(await el.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop < 1));
        } finally {
          await page.close();
        }
      });
    } finally {
      await browser.close();
    }
  }
});
