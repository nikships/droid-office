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
test('real wterm dev asset, same-view retry and WASM disposal', { skip: status.installed ? false : `No Chromium in ${status.path}` }, async (t) => {
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
  await t.test('blocked WASM leaves an inert shell and one toast; Retry opens the same window', async () => {
    const p = await context.newPage();
    await p.route('**/fixture', (r) => r.fulfill({ contentType: 'text/html', body: '<div id="modal-root"></div><div id="toasts"></div>' }));
    await p.addInitScript('window.__name = fn => fn');
    let blocked = 0;
    await p.route('**/*.wasm*', (r) => {
      blocked++;
      return r.abort();
    });
    await p.goto(page.url());
    await p.evaluate(async () => {
      const url = '/ui/terminal.ts',
        w = window as any;
      w.messages = [];
      (await import(url)).openOfficeShell({ up: true, send: (msg: unknown) => w.messages.push(msg), onStatus: () => () => {} });
      w.shell = document.querySelector('.modal.term');
    });
    const retry = p.getByRole('button', { name: 'Retry' });
    await retry.waitFor();
    assert.equal(await p.locator('#toasts .toast').count(), 1);
    assert.equal(await p.locator('.term-host textarea').count(), 0);
    const requests = blocked;
    assert.ok(requests);
    await p.keyboard.type('not sent');
    assert.equal(blocked, requests);
    assert.deepEqual(await p.evaluate(() => (window as any).messages.filter((m: any) => m.t === 'shell.input' || m.t === 'shell.attach')), []);
    await p.unroute('**/*.wasm*');
    await retry.click();
    await p.locator('.term-host .wterm textarea').waitFor({ state: 'attached' });
    await p.waitForFunction(() => (window as any).messages.some((m: any) => m.t === 'shell.attach'));
    assert.equal(await p.evaluate(() => (window as any).shell === document.querySelector('.modal.term')), true);
    assert.equal(await retry.count(), 0);
    await p.close();
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
  await t.test('idle warmup and concurrent panes share a single WASM request but not memory', async () => {
    const p = await context.newPage();
    await p.route('**/fixture', (r) => r.fulfill({ contentType: 'text/html', body: '<div id="a"></div><div id="b"></div>' }));
    let requests = 0;
    p.on('response', (r) => {
      if (r.headers()['content-type']?.startsWith('application/wasm')) requests++;
    });
    await p.goto(page.url());
    const independent = await p.evaluate(async () => {
      const runtime = '/term-engine/wterm-core.ts',
        adapter = '/term-engine/wterm.ts';
      const [{ warmWterm }, { WTermAdapter }] = await Promise.all([import(runtime), import(adapter)]);
      const a = new WTermAdapter({}),
        b = new WTermAdapter({});
      try {
        await Promise.all([warmWterm(), a.open(document.getElementById('a')), b.open(document.getElementById('b'))]);
        a.write('A');
        b.write('B');
        return [a.core.getCell(0, 0).char, b.core.getCell(0, 0).char];
      } finally {
        a.dispose();
        b.dispose();
      }
    });
    assert.equal(requests, 1);
    assert.deepEqual(independent, [65, 66]);
    await p.close();
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
        const mod = '/term-engine/web-terminal.ts',
          { createWebTerminal } = await import(mod);
        const refs = ((window as any).refs = [] as WeakRef<object>[][]);
        for (let i = 0; i < n; i++) {
          const { term: a } = createWebTerminal({});
          await a.open(document.getElementById('host'));
          refs.push([new WeakRef(a), new WeakRef(a.native)]);
          // A pending browser UI event may keep its target alive after detach.
          // Retaining a button must not keep its disposed pane or WASM alive.
          if (i === n - 1) (window as any).detachedControls = Array.from(a.native.element.querySelectorAll('button'));
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
