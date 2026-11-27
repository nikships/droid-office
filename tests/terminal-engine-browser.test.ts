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
    w.events = [];
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      w.events.push(`${e.type}:${e.key}`);
      if (e.type === 'keyup' && e.key === 'b') term.input('release');
      return e.key !== 'b';
    });
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
  assert.deepEqual(await page.evaluate(() => (window as any).events), ['keydown:a', 'keyup:a', 'keydown:b', 'keyup:b']);
  assert.deepEqual(
    await page.evaluate(() => {
      const { term } = window as any;
      const bubbled: string[] = [];
      for (const phase of ['keypress', 'keyup']) {
        term.native.element.addEventListener(phase, (e: KeyboardEvent) => bubbled.push(`${phase}:${e.key}`));
        for (const key of ['a', 'b']) term.textarea.dispatchEvent(new KeyboardEvent(phase, { key, bubbles: true, cancelable: true }));
      }
      return bubbled;
    }),
    ['keypress:a', 'keyup:a'],
  );
  await page.evaluate(() => {
    const { term } = window as any;
    term.paste('p');
    term.input('i');
    term.options.disableStdin = true;
    term.paste('ignored');
  });
  await page.keyboard.press('c');
  assert.deepEqual(await page.evaluate(() => (window as any).sent), ['\x1b[I', 'a', 'release', 'release', '\x1b[200~p\x1b[201~', 'i']);
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
      const root = term.native.element;
      term.dispose();
      const count = (window as any).events.length;
      root.dispatchEvent(new KeyboardEvent('keyup', { key: 'b', bubbles: true }));
      if ((window as any).events.length !== count) throw Error('Disposed terminal received a release');
      return after;
    }),
    { history: 0, parsed: 3, scroll: true, focusMode: false, font: 19 },
  );
  assert.equal(await page.locator('#host canvas').count(), 0);
  assert.deepEqual(await page.evaluate(() => [(window as any).opened, (window as any).released]), [true, true]);
  assert.deepEqual(await page.evaluate(() => (window as any).hooks), ['before', 'parsed', 'disableStdin', 'before', 'parsed', 'reset', 'before', 'parsed', 'fontSize', 'cursorStyle', 'theme', 'scrollSensitivity']);
  assert.deepEqual(
    await page.evaluate(async () => {
      const url = '/term-engine/ghostty.ts';
      const { GhosttyAdapter } = await import(url);
      const term = new GhosttyAdapter({});
      await term.open(document.getElementById('host'));
      try {
        const widths = [];
        for (const mode of ['', '\x1b[?2027h', '\x1b[?2027l', '\x1bc', '\x1b[?1;2027;2004h']) {
          term.write(`\r${mode}👩‍💻`);
          widths.push(term.native.wasmTerm.getCursor().x);
        }
        const { applicationCursorKeysMode, bracketedPasteMode } = term.modes;
        term.native.write('\x1b[?2027h'); // Ensure adapter.reset restores the pinned mode itself.
        term.reset();
        term.write('👩‍💻');
        return [widths, applicationCursorKeysMode, bracketedPasteMode, term.native.wasmTerm.getCursor().x];
      } finally {
        term.dispose();
      }
    }),
    [[4, 4, 4, 4, 4], true, true, 4],
  );
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
    await p.close();
  });
  await t.test('display writes never forward a native DA reply as user input', async () => {
    assert.deepEqual(
      await page.evaluate(async () => {
        const url = '/term-engine/ghostty.ts',
          { GhosttyAdapter } = await import(url);
        const a = new GhosttyAdapter({});
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
  await t.test('snapshot reset and streamed RIS clear the selection', async () => {
    assert.deepEqual(
      await page.evaluate(async () => {
        const url = '/term-engine/ghostty.ts',
          { GhosttyAdapter } = await import(url);
        const a = new GhosttyAdapter({});
        await a.open(document.getElementById('host'));
        const selected = [];
        for (const reset of [() => a.reset(), () => a.write('\x1bc')]) {
          a.write('old');
          a.native.select(0, 0, 3);
          selected.push(a.native.hasSelection());
          reset();
          selected.push(a.native.hasSelection());
        }
        a.dispose();
        return selected;
      }),
      [true, false, true, false],
    );
  });
  await t.test('closing 30 panes releases their adapters and reports native WASM retention', async () => {
    const p = await context.newPage();
    await p.route('**/fixture', (r) => r.fulfill({ contentType: 'text/html', body: '<div id="host"></div>' }));
    await p.goto(page.url());
    const cdp = await context.newCDPSession(p);
    const measure = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      const { result } = await cdp.send('Runtime.evaluate', { expression: 'WebAssembly.Memory.prototype', objectGroup: 'measurement' });
      const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: result.objectId!, objectGroup: 'measurement' });
      const mem = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objectId, functionDeclaration: 'function(){return this.reduce((sum,m)=>sum+m.buffer.byteLength,0)}', returnByValue: true });
      await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'measurement' });
      const counts = await p.evaluate(() => ((window as any).refs ?? []).reduce(([a, n]: number[], [adapter, native]: WeakRef<object>[]) => [a + Number(!!adapter.deref()), n + Number(!!native.deref())], [0, 0]));
      return { adapters: counts[0], native: counts[1], wasmBytes: mem.result.value };
    };
    const before = await measure();
    await p.evaluate(async () => {
      const mod = '/term-engine/ghostty.ts',
        features = '/term-engine/features.ts';
      const { GhosttyAdapter } = await import(mod),
        { attachEngineFeatures } = await import(features);
      const refs = ((window as any).refs = [] as WeakRef<object>[][]);
      for (let i = 0; i < 30; i++) {
        const a = new GhosttyAdapter({ allowProposedApi: true });
        attachEngineFeatures({ term: a, ghostty: a });
        await a.open(document.getElementById('host'));
        refs.push([new WeakRef(a), new WeakRef(a.native)]);
        a.dispose();
      }
    });
    const after = await measure();
    t.diagnostic(JSON.stringify({ before, after }));
    await p.close();
    assert.equal(after.adapters, 0);
  });
  assert.deepEqual(errors, []);
});
