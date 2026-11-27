import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

test('native terminal search, working directory and read-only snapshots in Chromium', { skip: !browserStatus().installed }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'office-find-'));
  const vite = await createServer({
    root: fileURLToPath(new URL('../src/client', import.meta.url)),
    configFile: false,
    cacheDir,
    logLevel: 'error',
    appType: 'custom',
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true },
  });
  t.after(async () => {
    await vite.close();
    await rm(cacheDir, { recursive: true, force: true });
  });
  await vite.listen();
  const addr = vite.httpServer!.address();
  assert.ok(addr && typeof addr === 'object');
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(4000);
  await page.route('**/fixture', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><link rel="stylesheet" href="/style.css"><style>.host{height:80px;width:400px}</style><div id="host" data-worker-id="w" class="host"></div><div class="modal" tabindex="0"><div id="log" class="host"></div></div><div id="modal-root"></div>`,
    }),
  );
  await page.goto(`http://127.0.0.1:${addr.port}/fixture`);
  await page.addScriptTag({ content: 'window.__name = fn => fn;' });
  await page.evaluate(async () => {
    const load = (p: string) => import(p);
    const [{ createWebTerminal }, { createAutomation }, { TerminalPaths }] = await Promise.all([load('/term-engine/web-terminal.ts'), load('/automation.ts'), load('/ui/terminal-path-links.ts')]);
    const r = window as any;
    r.office = createAutomation({});
    r.sent = [];
    r.keys = [];
    for (const id of ['host', 'log']) {
      const paths = id === 'host' ? new TerminalPaths({ floor: 'f', workerId: 'w' }) : undefined;
      const { term, features: hooks } = createWebTerminal({ disableStdin: id === 'log', scrollback: 200, fontSize: 14, fontFamily: 'monospace' }, undefined, paths);
      term.onData((s: string) => r.sent.push(s));
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        r.keys.push([e.type, e.key]);
        return id !== 'log';
      });
      await term.open(document.getElementById(id));
      term.resize(12, 5);
      term.write(`1234567890漢e\u0301Ab\r\n${'line\r\n'.repeat(35)}漢e\u0301ab`);
      r[`${id}Rig`] = { term, paths, hooks };
    }
    r.hostRig.term.focus();
  });
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  const shortcut = mac ? 'Meta+f' : 'Control+Shift+f';
  const status = page.locator('#host .wterm-search-bar [role=status]');
  const state = () => page.evaluate(() => (window as any).hostRig.term.native.getSearchState());
  const find = page.locator('#host input[aria-label="Find in terminal"]');
  const frame = () => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  await frame();
  await t.test('shortcuts, counts, case, reflow and refresh use native search without PTY input', async () => {
    await page.keyboard.press(shortcut);
    assert.equal(await find.evaluate((e) => e === document.activeElement), true);
    assert.equal(await find.getAttribute('maxlength'), '1024');
    await page.keyboard.insertText('漢e\u0301ab');
    await page.waitForFunction(() => document.querySelector('#host [role=status]')?.textContent === '1 of 2');
    await page.keyboard.press('Enter');
    assert.equal(await status.innerText(), '2 of 2');
    await page.keyboard.press('Shift+Enter');
    assert.equal(await status.innerText(), '1 of 2');
    await page.keyboard.press('Meta+g');
    assert.equal(await status.innerText(), '2 of 2');
    await page.keyboard.press('Meta+Shift+g');
    assert.equal(await status.innerText(), '1 of 2');
    await page.getByRole('button', { name: 'Match case', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#host [role=status]')?.textContent === '1 of 1');
    await page.evaluate(() => {
      const t = (window as any).hostRig.term;
      t.write('\r\n漢e\u0301ab');
      t.resize(9, 5);
    });
    await page.waitForFunction(() => document.querySelector('#host [role=status]')?.textContent === '1 of 2');
    assert.equal((await state()).caseSensitive, true);
    await find.fill('not found');
    await page.waitForFunction(() => document.querySelector('#host [role=status]')?.textContent === 'No matches');
    await find.focus();
    await page.keyboard.type('xyz');
    await page.keyboard.press('Escape');
    await frame();
    assert.equal(await find.isVisible(), false);
    assert.equal((await state()).query, '');
    assert.equal(await page.locator('#host textarea').evaluate((e) => e === document.activeElement), true);
    assert.deepEqual(await page.evaluate(() => (window as any).sent), []);
    assert.equal(await page.locator('#host .term-search-match').count(), 0);
    assert.ok(await page.locator('#host .wterm').evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop <= 1));
  });
  await t.test('reader stays off bottom after closing; reset clears the bar; read-only log accepts search only', async () => {
    const top = await page.evaluate(() => {
      const r = (window as any).hostRig.term.native.element;
      r.scrollTop = 64;
      return r.scrollTop;
    });
    await page.keyboard.press(shortcut);
    await find.fill('漢e\u0301ab');
    await frame();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Escape');
    await frame();
    assert.equal(await page.locator('#host .wterm').evaluate((e) => e.scrollTop), top);
    await page.keyboard.press(shortcut);
    await find.fill('line');
    await page.evaluate(() => (window as any).hostRig.term.reset());
    assert.equal(await find.isVisible(), false);
    await page.locator('.modal').focus();
    await page.keyboard.press(shortcut);
    const logFind = page.locator('#log input');
    assert.equal(await logFind.evaluate((e) => e === document.activeElement), true);
    await page.keyboard.type('line');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(() => (window as any).sent), []);
  });
  await t.test('stepping between matches supersedes a queued reader restore', async () => {
    await page.evaluate(() => {
      const { term } = (window as any).hostRig;
      term.reset();
      term.resize(24, 5);
      term.write(`first match\r\n${'between\r\n'.repeat(12)}second match\r\n${'after\r\n'.repeat(12)}`);
      term.focus();
    });
    await frame();
    await page.keyboard.press(shortcut);
    await find.fill('match');
    await frame();
    const position = () => page.locator('#host .wterm').evaluate((e) => e.scrollTop);
    for (const key of ['Enter', 'Shift+Enter']) {
      const before = await position();
      await page.evaluate(() => {
        const w = window as any;
        w.stale = w.hostRig.term.saveReader();
        if (!w.stale) throw Error('expected historical reader');
      });
      await page.keyboard.press(key);
      await frame();
      const target = await position();
      assert.notEqual(target, before);
      await page.evaluate(() => (window as any).stale());
      await frame();
      assert.equal(await position(), target);
    }
    await page.keyboard.press('Escape');
  });
  await t.test('an in-pane search releases a global jump; a later jump owns the highlight and the viewport through reflow', async () => {
    const jump = () => page.evaluate(() => (window as any).hostRig.hooks.find({ needle: 'beginning', fromEnd: 40 }));
    await page.evaluate(() => {
      const { term } = (window as any).hostRig;
      term.reset();
      term.resize(24, 5);
      term.write(`beginning of search example\r\n${'between\r\n'.repeat(32)}end of example`);
      term.focus();
    });
    await frame();
    await jump();
    await frame();
    const mark = page.locator('#host .wterm-find-line');
    assert.ok((await mark.allTextContents()).join('').startsWith('beginning'));
    await page.keyboard.press(shortcut);
    await find.fill('end of example');
    await frame();
    assert.equal(await mark.count(), 0);
    await page.evaluate(() => (window as any).hostRig.term.resize(20, 5));
    await frame();
    assert.equal(await find.isVisible(), true);
    assert.equal((await state()).count, 1);
    await jump();
    await page.evaluate(() => (window as any).hostRig.term.resize(10, 5));
    await frame();
    assert.equal(await find.isVisible(), false);
    assert.equal((await state()).query, '');
    assert.ok((await mark.allTextContents()).join('').startsWith('beginning'));
    assert.equal(await page.locator('#host .wterm').evaluate((e) => e.scrollTop), 0);
  });
  await t.test('latest OSC 7 URI follows lookup, remote preview and reset; readTerminal excludes hidden and disposed views', async () => {
    const bodies: unknown[] = [];
    await page.route('**/api/term/paths?**', (r) => {
      bodies.push(r.request().postDataJSON());
      return r.fulfill({ json: { paths: [{ path: '/work/sub/server.ts', line: 7, displayPath: 'sub/server.ts' }], local: false } });
    });
    await page.route('**/api/term/file?**', (r) => r.fulfill({ json: { path: 'sub/server.ts', text: 'server.ts' } }));
    await page.evaluate(() => {
      const r = window as any;
      r.hostRig.term.write('\x1b]7;file:///work/sub\x07server.ts:7');
    });
    const pre = page.waitForRequest('**/api/term/file?**');
    await page.evaluate(async () => {
      const { paths } = (window as any).hostRig;
      const open = await paths.resolveTarget('server.ts:7', false);
      open();
    });
    const url = new URL((await pre).url());
    assert.equal(url.searchParams.get('cwdHint'), 'file:///work/sub');
    assert.equal(url.searchParams.get('path'), 'server.ts:7');
    assert.deepEqual(bodies, [{ paths: ['server.ts:7'], cwdHint: 'file:///work/sub' }]);
    const entries = await page.evaluate(() => (window as any).office.readTerminal());
    assert.equal(entries.length, 2);
    assert.match(entries[0].text, /server.ts:7/);
    assert.equal(entries[0].workerId, 'w');
    const relay = await page.evaluate(async () => {
      const module = '/automation.ts';
      const { runCommand } = await import(module);
      try {
        await runCommand((window as any).office, 'readTerminal', []);
        return 'allowed';
      } catch (error) {
        return String(error);
      }
    });
    assert.match(relay, /No command "readTerminal"/);
    await page.evaluate(() => {
      document.getElementById('log')!.hidden = true;
    });
    assert.equal((await page.evaluate(() => (window as any).office.readTerminal())).length, 1);
    assert.equal(
      await page.evaluate(() => {
        const { term, paths } = (window as any).hostRig;
        term.reset();
        return paths.cwdHint;
      }),
      undefined,
    );
    await page.evaluate(() => {
      const r = window as any;
      r.hostRig.term.dispose();
      r.logRig.term.dispose();
    });
    assert.deepEqual(await page.evaluate(() => (window as any).office.readTerminal()), []);
    assert.equal(await page.locator('.wterm-search-panel').count(), 0);
  });
  await t.test('native control ownership leaves search state available without installing a web bar', async () => {
    const measured = await page.evaluate(async () => {
      const load = (p: string) => import(p);
      const [{ WTermAdapter }, { useNativeSearchControls, createWtermSearch }] = await Promise.all([load('/term-engine/wterm.ts'), load('/term-engine/wterm-search-controls.ts')]);
      const t = new WTermAdapter({ disableStdin: true });
      useNativeSearchControls(t);
      await t.open(document.querySelector('#host'));
      t.write('native controls native');
      let controller: ReturnType<typeof createWtermSearch>;
      let closed = 0;
      const complete = new Promise<number>((resolve) => {
        t.onOpen((native: unknown, signal: AbortSignal) => {
          controller = createWtermSearch(t, native, signal, {
            onClose: () => closed++,
            onChange: (s: { searching: boolean; query: string; count: number }) => {
              if (s.query && !s.searching) resolve(s.count);
            },
          });
        });
      });
      controller.open();
      controller.setQuery('native', { caseSensitive: true });
      const result = [await complete, document.querySelectorAll('.wterm-search-panel').length];
      controller.next();
      result.push(controller.getState().activeIndex);
      controller.previous();
      result.push(controller.getState().activeIndex);
      controller.close();
      result.push(closed, controller.getState().count);
      t.dispose();
      return result;
    });
    assert.deepEqual(measured, [2, 0, 1, 0, 1, 0]);
  });
});
