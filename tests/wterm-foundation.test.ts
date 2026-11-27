import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

test('wterm real WASM: open, ordered write/drain, reset, fixed-size resize and close', { skip: !browserStatus().installed }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'office-wterm-'));
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
  await page.route('**/fixture', (route) => route.fulfill({ contentType: 'text/html', body: '<button id="other">other</button><div style="width:640px;height:200px" id="host"></div>' }));
  await page.goto(`http://127.0.0.1:${address.port}/fixture`);
  await page.focus('#other');
  const result = await page.evaluate(async () => {
    const mod = '/term-engine/wterm.ts',
      { WTermAdapter } = await import(mod);
    const a = new WTermAdapter({});
    await a.open(document.getElementById('host'));
    const focus = document.activeElement?.id;
    a.resize(40, 8);
    a.write('one');
    a.write('two');
    const parsed = a.core.getCursor().col;
    await new Promise<void>((r) => a.write('', r));
    a.write('\r\nline'.repeat(30));
    const history = a.buffer.active.baseY;
    a.reset();
    const reset = [a.core.getCursor().col, a.buffer.active.baseY, a.cols, a.rows];
    a.dispose();
    return { focus, parsed, history, reset, children: document.getElementById('host')!.childElementCount };
  });
  assert.deepEqual(result, { focus: 'other', parsed: 6, history: 23, reset: [0, 0, 40, 8], children: 0 });
});
