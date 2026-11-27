import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { CDPSession } from 'playwright-core';
import { createServer } from 'vite';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

const status = browserStatus();
async function wasmBytes(cdp: CDPSession) {
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'WebAssembly.Memory.prototype', objectGroup: 'measurement' });
  const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: result.objectId!, objectGroup: 'measurement' });
  const mem = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objectId, functionDeclaration: 'function(){return this.reduce((sum,m)=>sum+m.buffer.byteLength,0)}', returnByValue: true });
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'measurement' });
  return Number(mem.result.value);
}
test('real wterm dev asset, same-view fallback and WASM disposal', { skip: status.installed ? false : `No Chromium in ${status.path}` }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'office-ghostty-vite-'));
  const server = await createServer({
    root: fileURLToPath(new URL('../src/client', import.meta.url)),
    configFile: false,
    cacheDir,
    logLevel: 'error',
    appType: 'custom',
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true, include: ['@wterm/dom', '@wterm/ghostty'] },
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
  await t.test('a failed Ghostty WASM request keeps the shell window and opens xterm once', async () => {
    const p = await context.newPage();
    await p.route('**/fixture', (r) => r.fulfill({ contentType: 'text/html', body: '<div id="modal-root"></div><div id="toasts"></div>' }));
    let blocked = 0;
    await p.route('**/*.wasm*', (r) => {
      blocked++;
      return r.abort();
    });
    await p.goto(page.url());
    await p.evaluate(async () => {
      localStorage.setItem('droid-office.terminal', JSON.stringify({ engine: 'ghostty' }));
      const url = '/ui/terminal.ts';
      const { openOfficeShell } = await import(url);
      openOfficeShell({ up: true, send: Boolean });
      (window as any).shell = document.querySelector('.modal.term');
    });
    await p.locator('#toasts .toast').waitFor({ timeout: 8000 });
    assert.ok(blocked);
    assert.deepEqual(
      await p.evaluate(() => [
        (window as any).shell === document.querySelector('.modal.term'),
        !!document.querySelector('.modal.term .xterm textarea'),
        document.querySelectorAll('#toasts .toast').length,
        document.querySelector('#toasts')?.textContent,
      ]),
      [true, true, 1, 'Ghostty could not load. Using xterm for this terminal.'],
    );
    await p.locator('.modal.term .close').click();
    await p.unroute('**/*.wasm*');
    await p.evaluate(async () => {
      const url = '/ui/terminal.ts';
      (await import(url)).openOfficeShell({ up: true, send: Boolean });
    });
    await p.locator('.modal.term .office-wterm textarea').waitFor();
    assert.equal(await p.locator('.modal.term .xterm').count(), 0);
    await p.close();
  });
  await t.test('a throw inside native open removes its root and falls back in the same shell', async () => {
    const p = await context.newPage();
    await p.route('**/fixture', (r) => r.fulfill({ contentType: 'text/html', body: '<div id="modal-root"></div><div id="toasts"></div>' }));
    await p.goto(page.url());
    try {
      await p.evaluate(async () => {
        localStorage.setItem('droid-office.terminal', JSON.stringify({ engine: 'ghostty' }));
        const get = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (...args: Parameters<typeof get>) {
          if (document.querySelector('.office-wterm')) {
            HTMLCanvasElement.prototype.getContext = get;
            throw Error('Canvas unavailable');
          }
          return get.apply(this, args);
        } as typeof get;
        const url = '/ui/terminal.ts';
        (await import(url)).openOfficeShell({ up: true, send: Boolean });
        (window as any).shell = document.querySelector('.modal.term');
      });
      await p.locator('.term-host .xterm textarea').waitFor({ state: 'attached', timeout: 3000 });
      assert.deepEqual(await p.evaluate(() => [(window as any).shell === document.querySelector('.modal.term'), document.querySelectorAll('.office-wterm').length, document.querySelectorAll('#toasts .toast').length]), [true, 0, 1]);
    } finally {
      await p.close();
    }
  });
  await t.test('display writes never forward a native DA reply as user input', async () => {
    assert.deepEqual(
      await page.evaluate(async () => {
        const url = '/term-engine/wterm.ts',
          { WTermAdapter } = await import(url);
        const a = new WTermAdapter({});
        await a.open(document.getElementById('host'));
        const sent: string[] = [];
        a.onData((s: string) => sent.push(s));
        a.write('\x1bZ');
        a.input('user');
        a.dispose();
        return sent;
      }),
      ['user'],
    );
  });
  await t.test('closing 30 panes releases every adapter and all pane WASM memory', async () => {
    const p = await context.newPage();
    await p.route('**/fixture', (r) => r.fulfill({ contentType: 'text/html', body: '<div id="host"></div>' }));
    await p.goto(page.url());
    const cdp = await context.newCDPSession(p);
    p.on('pageerror', (e) => errors.push(e.message));
    const measure = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      const bytes = await wasmBytes(cdp);
      const counts = await p.evaluate(() => ((window as any).refs ?? []).reduce(([a, n]: number[], [adapter, native]: WeakRef<object>[]) => [a + Number(!!adapter.deref()), n + Number(!!native.deref())], [0, 0]));
      return { adapters: counts[0], native: counts[1], wasmBytes: bytes, jsBytes: (await cdp.send('Runtime.getHeapUsage')).usedSize };
    };
    const cycle = (n: number) =>
      p.evaluate(async (n) => {
        const mod = '/term-engine/wterm.ts',
          features = '/term-engine/features.ts';
        const { WTermAdapter } = await import(mod),
          { attachEngineFeatures } = await import(features);
        const refs = ((window as any).refs = [] as WeakRef<object>[][]);
        for (let i = 0; i < n; i++) {
          const a = new WTermAdapter({ allowProposedApi: true });
          attachEngineFeatures({ term: a, ghostty: a });
          await a.open(document.getElementById('host'));
          refs.push([new WeakRef(a), new WeakRef(a.native)]);
          a.dispose();
        }
        document.dispatchEvent(new MouseEvent('mousedown'));
        document.dispatchEvent(new MouseEvent('mouseup'));
      }, n);
    await cycle(1); // Load modules and warm the renderer before measuring the additional 30 closes.
    const before = await measure();
    await cycle(30);
    const after = await measure();
    t.diagnostic(JSON.stringify({ before, after }));
    await p.close();
    assert.equal(after.adapters, 0);
    assert.equal(after.native, 0);
    assert.equal(after.wasmBytes, 0);
  });
  assert.deepEqual(errors, []);
});
