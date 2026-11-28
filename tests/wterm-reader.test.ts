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
        for (const scenario of ['write before resize paint', 'page up during fit', 'scroll during fit', 'scroll after partial fallback'])
          await t.test(`viewport ownership: ${scenario}`, async () => {
            const page = await pane();
            try {
              const result = await page.evaluate(async (scenario) => {
                const { term } = window as any;
                const el = term.native.element,
                  pitch = parseFloat(el.style.getPropertyValue('--term-row-height'));
                const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                const first = () => {
                  const y = el.getBoundingClientRect().top + 1;
                  return [...el.querySelectorAll('.term-row')]
                    .find((r) => r.getBoundingClientRect().top <= y && r.getBoundingClientRect().bottom > y)
                    ?.textContent.trim()
                    .slice(0, 8);
                };
                const stream = scenario === 'write before resize paint',
                  partial = scenario === 'scroll after partial fallback';
                term.reset();
                term.resize(100, partial ? 32 : 10);
                el.parentElement.style.cssText = `flex:none;height:${10 * pitch + 12}px`;
                const facts = (redraw: boolean) => Array.from({ length: 150 }, (_, i) => `Fact ${String(i).padStart(3, '0')}${' some details'.repeat(5)}\r\n${redraw ? '\r\n\r\n' : ''}`).join('');
                term.write(facts(false));
                await frame();
                el.scrollTop = stream ? el.scrollHeight - el.clientHeight - 2 : 1250;
                await frame();
                await frame();
                if (stream) {
                  const before = first();
                  term.resize(20, 10);
                  term.write('z');
                  await frame();
                  return { before, after: first() };
                }
                if (partial) {
                  term.write('\x1b[?2026h\x1b[2J\x1b[3J\x1b[H' + Array.from({ length: 25 }, (_, i) => `Partial ${i}\r\n`).join(''));
                  await new Promise<void>((r) => {
                    const observer = new MutationObserver(() => {
                      if (!el.querySelector('.term-grid')?.textContent.includes('Partial 6')) return;
                      observer.disconnect();
                      r();
                    });
                    observer.observe(el, { subtree: true, childList: true });
                  });
                  await frame();
                  el.scrollTop = 129;
                } else {
                  term.setFitPending(true);
                  term.write('\x1b[?2026h\x1b[2J\x1b[3J\x1b[H' + facts(true) + '\x1b[?2026l');
                  if (scenario === 'page up during fit') term.cancelReaderRestore();
                  el.scrollTop -= el.clientHeight - pitch;
                }
                const before = el.scrollTop;
                await frame();
                await frame();
                if (partial) term.write('more');
                else term.setFitPending(false);
                await frame();
                return { before, after: el.scrollTop, mounted: first() };
              }, scenario);
              assert.ok(result.before);
              assert.equal(result.after, result.before);
              if (scenario !== 'write before resize paint') assert.notEqual(result.mounted, undefined, 'a live or history row covers the selected viewport');
            } finally {
              await page.close();
            }
          });
        await t.test('a rows-only font fit mounts the reader on the first paint after paused output evicts history', async () => {
          const page = await pane();
          try {
            const result = await page.evaluate(async () => {
              const { term } = window as any;
              const el = term.native.element;
              const next = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              const visible = () => {
                const y = el.getBoundingClientRect().top + 2;
                return [...el.querySelectorAll('.term-row')]
                  .find((row) => {
                    const box = row.getBoundingClientRect();
                    return box.top <= y && box.bottom > y;
                  })
                  ?.textContent.trim();
              };
              term.reset();
              term.resize(20, 16);
              const lines = (start: number, length: number) => Array.from({ length }, (_, i) => `line ${start + i}\r\n`).join('');
              term.write(lines(0, 900));
              await next();
              const pitch = Number.parseFloat(el.style.getPropertyValue('--term-row-height'));
              el.scrollTop = 260.5 * pitch + Number.parseFloat(getComputedStyle(el).paddingTop);
              await next();
              await next();
              const before = visible();
              const base = term.core.getScrollbackDiscardedCount();
              term.setFitPending(true);
              term.write(lines(900, 120));
              term.setFontForFit(16);
              term.resize(20, 12);
              await Promise.resolve();
              term.setFitPending(false);
              await next();
              const first = visible();
              await next();
              await next();
              return { before, first, settled: visible(), evicted: term.core.getScrollbackDiscardedCount() - base };
            });
            assert.match(result.before ?? '', /^line \d+$/);
            assert.ok(result.evicted >= 120);
            assert.equal(result.settled, result.before);
            assert.equal(result.first, result.before, 'the remapped passage must already be mounted on the first paint');
          } finally {
            await page.close();
          }
        });
        await t.test('native history mounts the passage on the first resize and the first completed-reprint frame', async () => {
          const page = await pane();
          try {
            const result = await page.evaluate(async () => {
              const { term } = window as any;
              const el = term.native.element;
              const pitch = parseFloat(el.style.getPropertyValue('--term-row-height'));
              const inset = parseFloat(getComputedStyle(el).paddingTop);
              // The native frame runs first; read its mounted cells before another scroll render can repair them.
              const next = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
              const visible = () => {
                const y = el.getBoundingClientRect().top + 1;
                return [...el.querySelectorAll('.term-row')]
                  .find((r) => r.getBoundingClientRect().top <= y && r.getBoundingClientRect().bottom > y)
                  ?.textContent.trim()
                  .slice(0, 8);
              };
              const facts = (n: number, redraw: boolean) => Array.from({ length: n }, (_, i) => `Fact ${i}: ${'some detailed text '.repeat(4)}${redraw ? '\r\n\r\n\r\n' : '\r\n'}`).join('');
              const contract = '_pendingResizeScrollTop' in term.native && '_shouldScrollToBottom' in term.native;
              term.reset();
              term.write(facts(100, false));
              await next();
              el.scrollTop = 140 * pitch + inset + 7;
              await next();
              await next();
              const before = visible();
              term.resize(28, 15);
              await next();
              const resize = visible();
              await next();
              await next();
              term.write('\x1b[?2026h\x1b[2J\x1b[3J\x1b[H');
              term.write(facts(100, true));
              term.write('\x1b[?2026l');
              await next();
              return { contract, before, resize, redraw: visible() };
            });
            assert.equal(result.contract, true, 'review the wterm viewport bridge on a package upgrade');
            assert.deepEqual([result.before, result.resize, result.redraw], ['Fact 70:', 'Fact 70:', 'Fact 70:']);
          } finally {
            await page.close();
          }
        });
        for (const caseName of ['repeated continuation', 'clipped live row', 'widen into live rows', 'top padding', 'continued cell', 'synchronized fallback'])
          await t.test(`reader reflow: ${caseName}`, async () => {
            const page = await pane();
            try {
              const result = await page.evaluate(async (kind) => {
                const { term } = window as any;
                const el = term.native.element;
                const paint = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
                const pitch = parseFloat(el.style.getPropertyValue('--term-row-height'));
                const inset = parseFloat(getComputedStyle(el).paddingTop);
                const wide = kind === 'widen into live rows';
                const live = kind === 'clipped live row';
                const repeated = kind === 'repeated continuation' || kind === 'continued cell';
                term.reset();
                term.resize(wide ? 30 : 60, wide ? 16 : 32);
                el.parentElement.style.cssText = `flex:none;height:${(wide ? 16 : 9) * pitch + 12}px`;
                const facts = (redraw: boolean) =>
                  Array.from({ length: repeated ? 60 : 120 }, (_, i) => {
                    const label = `Fact ${String(i).padStart(3, '0')}:`;
                    if (repeated) return `${label}\r\n${redraw ? '\r\n\r\n' : ''}${'0123456789'.repeat(13)}\r\n`;
                    return `${label}${redraw === wide ? ' ' : '\r\n'}ordinary text\r\n`;
                  }).join('');
                term.write(facts(false));
                await paint();
                const rowText = (row: number) => {
                  const base = term.core.getScrollbackCount();
                  return Array.from({ length: term.cols }, (_, col) => String.fromCodePoint((row < base ? term.core.getScrollbackCell(base - 1 - row, col) : term.core.getCell(row - base, col)).char || 32))
                    .join('')
                    .trimEnd();
                };
                const mark = repeated ? 'Fact 020:' : 'Fact 104:';
                let row = 0;
                if (!live && kind !== 'top padding') {
                  while (row < term.core.getScrollbackCount() && !rowText(row).startsWith(mark)) row++;
                  if (repeated) row += 2;
                }
                el.scrollTop = live ? el.scrollHeight - el.clientHeight - 2 : kind === 'top padding' ? 0 : row * pitch + inset + 7;
                await paint();
                const read = () => {
                  const row = Math.max(0, Math.floor((el.scrollTop - inset) / pitch));
                  let i = row;
                  while (i > 0 && !rowText(i).startsWith('Fact ')) i--;
                  return { row, live: row >= term.core.getScrollbackCount(), fact: rowText(i).slice(0, 9), offset: el.scrollTop - inset - row * pitch };
                };
                const before = read();
                term.resize(wide ? 60 : kind === 'continued cell' ? 28 : 30, term.rows);
                await paint();
                const resized = read();
                if (kind === 'continued cell') term.resize(60, term.rows);
                else {
                  term.write('\x1b[?2026h\x1b[2J\x1b[3J\x1b[H');
                  if (kind === 'synchronized fallback') {
                    // A real native fallback paint, not a guessed delay. The update has not closed.
                    await new Promise<void>((resolve) => {
                      const observer = new MutationObserver(() => {
                        if (el.querySelector('.term-scrollback-row')) return;
                        observer.disconnect();
                        resolve();
                      });
                      observer.observe(el, { childList: true, subtree: true });
                    });
                  }
                  term.write(`${facts(true)}\x1b[?2026l`);
                }
                await paint();
                return { before, resized, after: read() };
              }, caseName);
              if (caseName === 'clipped live row') assert.equal(result.before.live, true);
              assert.equal(result.resized.fact, result.before.fact);
              assert.equal(result.after.fact, result.before.fact);
              assert.equal(result.after.offset, result.before.offset);
              if (caseName === 'continued cell') assert.equal(result.after.row, result.before.row);
            } finally {
              await page.close();
            }
          });
        await t.test('column changes keep the first visible passage and its partial row at the same height', async () => {
          const page = await pane();
          try {
            const result = await page.evaluate(async () => {
              const { term } = window as any;
              const el = term.native.element;
              const paint = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
              term.reset();
              term.write(Array.from({ length: 150 }, (_, n) => `Fact ${n}: ${'some detailed text '.repeat(4)}\r\n`).join(''));
              await paint();
              const pitch = parseFloat(el.style.getPropertyValue('--term-row-height'));
              const inset = parseFloat(getComputedStyle(el).paddingTop);
              el.scrollTop = 160 * pitch + inset + 7;
              await paint();
              const current = () => {
                const row = Math.floor((el.scrollTop - inset) / pitch);
                const offset = term.core.getScrollbackCount() - row - 1;
                const str = Array.from({ length: 10 }, (_, i) => String.fromCodePoint(term.core.getScrollbackCell(offset, i).char || 32)).join('');
                return [str, (el.scrollTop - inset) % pitch];
              };
              const before = current();
              term.setFitPending(true);
              term.resize(28, 15);
              term.setFitPending(false);
              await paint();
              const narrow = current();
              term.resize(60, 32);
              await paint();
              const wide = current();
              // A TUI can then erase scrollback and print explicit line breaks at
              // its new width. There is no native cell identity across that clear.
              term.write('\x1b[?2026h\x1b[2J\x1b[3J\x1b[H');
              term.write(Array.from({ length: 150 }, (_, n) => `Fact ${n}: some detailed text\r\n${'some detailed text \r\n'.repeat(3)}`).join(''));
              term.write('\x1b[?2026l');
              await paint();
              return [before, narrow, wide, current()];
            });
            assert.match(String(result[0][0]), /Fact 80:/);
            assert.deepEqual(result[1], result[0]);
            assert.deepEqual(result[2], result[0]);
            assert.deepEqual(result[3], result[0]);
          } finally {
            await page.close();
          }
        });
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
