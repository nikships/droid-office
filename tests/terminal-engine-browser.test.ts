import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const status = browserStatus();
test('real Ghostty dev asset, passive focus, mirror/input gates, scroll geometry and disposal', { skip: status.installed ? false : `No Chromium in ${status.path}` }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'office-ghostty-vite-'));
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
  await page.route('**/fixture', (route) => route.fulfill({ contentType: 'text/html', body: '<button id="elsewhere">Other pane</button><div id="host"></div>' }));
  await page.goto(`http://127.0.0.1:${address.port}/fixture`);
  await page.focus('#elsewhere');
  await page.evaluate(async () => {
    const url = '/term-engine/ghostty.ts';
    const { GhosttyAdapter } = await import(url);
    const term = new GhosttyAdapter({ fontSize: 15, fontFamily: 'monospace', scrollback: 100, theme: { foreground: '#dddddd', background: '#101010' } });
    const w = window as any;
    w.term = term;
    w.sent = [];
    w.parsed = 0;
    w.hooks = [];
    term.onBeforeWrite(() => w.hooks.push('before'));
    term.onWriteParsed(() => w.hooks.push('parsed'));
    term.onReset(() => w.hooks.push('reset'));
    term.onOptionChange((key: string) => w.hooks.push(key));
    term.onOpen((native: { element?: HTMLElement }, lifetime: AbortSignal) => {
      w.opened = native.element?.isConnected;
      lifetime.addEventListener('abort', () => {
        w.released = true;
      });
    });
    term.onData((d: string) => w.sent.push(d));
    term.onWriteParsed(() => w.parsed++);
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => e.key !== 'b');
    await term.open(document.getElementById('host'));
    await new Promise((r) => setTimeout(r, 15));
    term.resize(40, 8);
    term.write('\x1b[?1004h\x1b[?2004h\x1b[?1h');
  });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'elsewhere');
  assert.deepEqual(await page.evaluate(() => (window as any).term.modes), { sendFocusMode: true, applicationCursorKeysMode: true, bracketedPasteMode: true, mouseTrackingMode: 'none' });
  await page.evaluate(() => (window as any).term.focus());
  await page.keyboard.press('a');
  await page.keyboard.press('b');
  await page.evaluate(() => {
    const { term } = window as any;
    term.paste('p');
    term.input('i');
    term.options.disableStdin = true;
    term.paste('ignored');
  });
  await page.keyboard.press('c');
  assert.deepEqual(await page.evaluate(() => (window as any).sent), ['\x1b[I', 'a', '\x1b[200~p\x1b[201~', 'i']);
  assert.deepEqual(
    await page.evaluate(async () => {
      const { term } = window as any;
      term.write('line\r\n'.repeat(60));
      term.native.scrollToTop();
      const scrolled = term.buffer.active;
      term.reset();
      await new Promise<void>((r) => term.write('', r));
      term.options.fontSize = 19;
      term.options.cursorStyle = 'bar';
      term.options.theme = { foreground: '#ffffff', background: '#121212' };
      term.options.scrollSensitivity = 2;
      const after = { history: term.buffer.active.baseY, parsed: (window as any).parsed, scroll: scrolled.viewportY === 0 && scrolled.baseY > 0, focusMode: term.modes.sendFocusMode, font: term.native.options.fontSize };
      term.dispose();
      return after;
    }),
    { history: 0, parsed: 3, scroll: true, focusMode: false, font: 19 },
  );
  assert.equal(await page.locator('#host canvas').count(), 0);
  assert.deepEqual(await page.evaluate(() => [(window as any).opened, (window as any).released]), [true, true]);
  assert.deepEqual(await page.evaluate(() => (window as any).hooks), ['before', 'parsed', 'disableStdin', 'before', 'parsed', 'reset', 'before', 'parsed', 'fontSize', 'cursorStyle', 'theme', 'scrollSensitivity']);
  assert.deepEqual(errors, []);
});
