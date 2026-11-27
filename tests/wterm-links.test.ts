import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { browserStatus, closeBrowser, launchBrowser, newIsolatedContext } from '../src/server/whiteboard-browser.js';

test('wterm links and find against the xterm pane', { skip: !browserStatus().installed }, async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'wterm-links-'));
  const root = fileURLToPath(new URL('../src/client/', import.meta.url));
  const vite = await createServer({
    root,
    cacheDir,
    configFile: false,
    resolve: { alias: { '/oracle': fileURLToPath(new URL('./oracle', import.meta.url)) } },
    logLevel: 'error',
    appType: 'custom',
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true, include: ['@xterm/xterm', '@xterm/addon-web-links', '@xterm/addon-unicode11'] },
  });
  t.after(async () => {
    await vite.close();
    await rm(cacheDir, { recursive: true, force: true });
  });
  await vite.listen();
  const address = vite.httpServer!.address();
  assert.ok(address && typeof address === 'object');
  const browser = await launchBrowser();
  t.after(closeBrowser);
  const context = await newIsolatedContext(browser);
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e.stack)));
  await page.route('**/fixture', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: `<link rel="stylesheet" href="/term-engine/wterm-links.css"><link rel="stylesheet" href="/@fs/${root}../../node_modules/@xterm/xterm/css/xterm.css"><style>.pane{width:380px;height:128px;margin:16px}body{background:#111}</style><div class="pane" id="x"></div><div class="pane" id="w"></div><div class="pane" id="policy"></div><div id="modal-root"></div><div id="toasts"></div>`,
    }),
  );
  const opens: string[] = [];
  let local = true,
    delayed = false;
  let release = () => {};
  await page.route('**/api/term/paths?**', async (r) => {
    if (delayed)
      await new Promise<void>((res) => {
        release = res;
      });
    await r.fulfill({
      json: {
        paths: r
          .request()
          .postDataJSON()
          .paths.map((raw: string) => (/(file:\/\/\/checkout\/)?src\/server\.ts|wait\.ts/.test(raw) ? { path: '/checkout/src/server.ts', displayPath: 'src/server.ts', line: 120 } : null)),
        local,
      },
    });
  });
  await page.route('**/api/term/path/open?**', (r) => {
    opens.push(r.request().postDataJSON().paths[0]);
    return r.fulfill({ json: { revealed: true } });
  });
  await page.route('**/api/term/file?**', (r) => r.fulfill({ json: { path: 'src/server.ts', text: 'server.ts' } }));
  await page.goto(`http://127.0.0.1:${address.port}/fixture`);
  await page.addScriptTag({ content: 'window.__name = fn => fn;' });
  await page.evaluate(async () => {
    const load = (s: string) => import(s);
    const [{ comparisonTerminal }, { attachWtermLinks }, { findInXterm }, { TerminalPaths }, { TerminalPathLinksAddon }, { WebLinksAddon }, { Unicode11Addon }] = await Promise.all([
      load('/oracle/terminal.ts'),
      load('/term-engine/wterm-links.ts'),
      load('/oracle/find.ts'),
      load('/ui/terminal-path-links.ts'),
      load('/oracle/paths.ts'),
      load('/@id/@xterm/addon-web-links'),
      load('/@id/@xterm/addon-unicode11'),
    ]);
    const rig = window as any;
    rig.urls = [];
    window.open = (...args) => {
      rig.urls.push(args);
      return null;
    };
    rig.mount = async (id: string, name: string, policy: string) => {
      const paths = policy === 'changes' ? undefined : new (name === 'xterm' ? TerminalPathLinksAddon : TerminalPaths)({ floor: 'f', workerId: 'w', inert: policy === 'guest' });
      const term = comparisonTerminal({ allowProposedApi: true, fontSize: 14, fontFamily: 'monospace', lineHeight: 1.1, scrollback: 100, linkHandler: paths?.linkHandler }, name);
      if (name === 'xterm') {
        term.loadAddon(paths);
        term.loadAddon(
          new WebLinksAddon((e: MouseEvent, text: string) => {
            if (e.ctrlKey || e.metaKey) window.open(text, '_blank', 'noopener,noreferrer');
          }),
        );
        term.loadAddon(new Unicode11Addon());
        term.unicode.activeVersion = '11';
        rig.findX = (hit: unknown) => findInXterm(term, hit);
      } else rig[`find${id}`] = attachWtermLinks(term, paths).find;
      rig[id] = term;
      await term.open(document.getElementById(id));
      term.resize(24, 8);
    };
    await rig.mount('x', 'xterm', 'owner');
    await rig.mount('w', 'ghostty', 'owner');
  });
  const frame = () => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  const write = async (content: string, reset = true) => {
    await page.evaluate(
      async ({ content, reset }) => {
        const { x, w } = window as any;
        for (const term of [x, w]) {
          if (reset) term.reset();
          await new Promise<void>((r) => term.write(content, r));
        }
      },
      { content, reset },
    );
    await frame();
  };
  const position = async (id: string, col: number, row: number) =>
    page.evaluate(
      ({ id, col, row }) => {
        const el = document.getElementById(id)!;
        const grid = el.querySelector<HTMLElement>('.xterm-screen,.term-grid')!;
        const rect = grid.getBoundingClientRect();
        const style = getComputedStyle(grid);
        const width = id === 'x' ? rect.width / 24 : parseFloat(style.getPropertyValue('--term-cell-width'));
        const height = id === 'x' ? rect.height / 8 : parseFloat(style.getPropertyValue('--term-row-height'));
        return { x: rect.left + (col + 0.5) * width, y: rect.top + (row + 0.5) * height };
      },
      { id, col, row },
    );
  const click = async (id: string, col: number, row: number, mod = true) => {
    const p = await position(id, col, row);
    if (mod) await page.keyboard.down('Control');
    await page.mouse.move(p.x, p.y);
    await frame();
    await page.mouse.click(p.x, p.y);
    if (mod) await page.keyboard.up('Control');
  };
  const urls = () => page.evaluate(() => (window as any).urls.splice(0));
  await t.test('bare and OSC 8 URLs open only on modifier-click; denied schemes have no hover or action', async () => {
    await write('https://example.com/doc,\r\n\x1b]8;;https://example.com/osc\x07label\x1b]8;;\x07\r\n\x1b]8;;foo:denied\x07bad\x1b]8;;\x07');
    const actual = [];
    for (const id of ['x', 'w']) {
      for (const row of [0, 1, 2]) {
        await click(id, 1, row, false);
        await click(id, 1, row, true);
      }
      actual.push(await urls());
    }
    assert.deepEqual(actual[0], [
      ['https://example.com/doc', '_blank', 'noopener,noreferrer'],
      ['https://example.com/osc', '_blank', 'noopener,noreferrer'],
    ]);
    assert.deepEqual(actual[1], actual[0]);
    const p = await position('w', 1, 2);
    await page.keyboard.down('Control');
    await page.mouse.move(p.x, p.y);
    assert.equal(await page.locator('.wterm-link-range').count(), 0);
    await page.keyboard.up('Control');
  });
  await t.test('wrapped history ranges include the full path after wide text, activate the same local and remote actions', async () => {
    await write(`漢e\u0301 example: src/server.ts:120\r\nhttps://example.com/long/path\r\n${'tail\r\n'.repeat(12)}`);
    await page.evaluate(() => {
      const { x, w } = window as any;
      x.scrollToTop();
      w.native.element.scrollTop = 0;
    });
    await frame();
    for (const id of ['x', 'w']) {
      await click(id, 1, 1);
      await page.waitForFunction(() => document.body.innerText.includes('Revealed in Finder'));
      await click(id, 1, 3);
      assert.deepEqual(await urls(), [['https://example.com/long/path', '_blank', 'noopener,noreferrer']]);
    }
    assert.deepEqual(opens.splice(0), ['src/server.ts:120', 'src/server.ts:120']);
    const p = await position('w', 1, 1);
    await page.keyboard.down('Meta');
    await page.mouse.move(p.x, p.y);
    await page.locator('.wterm-link-range').first().waitFor();
    assert.equal(await page.locator('.wterm-link-range').count(), 2);
    assert.equal(await page.locator('#w .office-wterm').getAttribute('title'), 'Cmd/Ctrl-click to open src/server.ts:120');
    await page.keyboard.up('Meta');
    assert.equal(await page.locator('.wterm-link-range').count(), 0);
    local = false;
    await write('src/server.ts:121\r\n\x1b]8;;file:///checkout/src/server.ts\x07source\x1b]8;;\x07');
    for (const id of ['x', 'w'])
      for (const row of [0, 1]) {
        await click(id, 1, row);
        await page.locator('[aria-label="File preview: src/server.ts"]').waitFor();
        await page.keyboard.press('Escape');
      }
    local = true;
  });
  await t.test('ranges agree at the first, last and adjacent cells around each link', async () => {
    await write('漢e\u0301 https://e.dev.\r\n\x1b]8;;https://e.dev/link\x07word\x1b]8;;\x07!\r\n src/server.ts:120!');
    const edges = async (id: string) => {
      const result = [];
      for (const [row, columns] of [
        [0, [3, 4, 16, 17]],
        [1, [0, 3, 4]],
        [2, [0, 1, 17, 18]],
      ] as const) {
        for (const col of columns) {
          await click(id, col, row);
          await frame();
          result.push([await urls(), opens.splice(0)]);
        }
      }
      return result;
    };
    const x = await edges('x');
    assert.ok(x.flat(3).includes('https://e.dev'));
    assert.ok(x.flat(3).includes('src/server.ts:120'));
    assert.deepEqual(await edges('w'), x);
  });
  await t.test('an incomplete history line cannot open a URL or path fragment', async () => {
    // Plant valid-looking fragments in the retained suffix of a single giant token.
    await write('x'.repeat(24 * 1000) + 'https://example.com/docs'.padEnd(24, 'x') + 'src/server.ts:120'.padEnd(24, 'x'));
    const root = page.locator('#w .office-wterm');
    await root.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await frame();
    await page.keyboard.down('Meta');
    for (const text of ['https://example.com/docs', 'src/server.ts:120']) {
      const p = await root.locator('.term-row').filter({ hasText: text }).last().boundingBox();
      assert.ok(p);
      await page.mouse.click(p.x + 4, p.y + 5);
    }
    await page.keyboard.up('Meta');
    assert.deepEqual(await urls(), []);
    assert.deepEqual(opens, []);
  });
  await t.test('pending lookup survives unrelated edits, not replacement of its own target', async () => {
    for (const [raw, replacement, expected] of [
      ['wait.ts:1', '\x1b[1;14Hother', true],
      ['wait.ts:2', '\x1b[Hnew!.ts:2', false],
    ] as const) {
      await write(raw);
      delayed = true;
      const request = page.waitForRequest('**/api/term/paths?**');
      await click('w', 2, 0);
      await request;
      await page.evaluate((s) => (window as any).w.write(s), replacement);
      const response = page.waitForResponse('**/api/term/paths?**');
      const opened = expected ? page.waitForResponse('**/api/term/path/open?**') : undefined;
      delayed = false;
      release();
      await response;
      await opened;
      await frame();
      assert.deepEqual(opens.splice(0), expected ? [raw] : []);
    }
  });
  await t.test('mouse tracking, a drag, and text replaced after pressing suppress activation', async () => {
    await write('https://example.com/a');
    await page.keyboard.down('Control');
    const p = await position('w', 2, 0);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + 13, p.y);
    await page.mouse.move(p.x, p.y);
    await page.mouse.up();
    await page.mouse.down();
    await page.evaluate(() => (window as any).w.write('\x1b[Hhttps://example.com/b'));
    await page.mouse.up();
    await page.evaluate(() => (window as any).w.write('\x1b[?1003h'));
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up('Control');
    assert.deepEqual(await urls(), []);
  });
  await t.test('guest OSC files and Changes links do not become clickable', async () => {
    for (const policy of ['guest', 'changes']) {
      await page.evaluate(async (policy) => {
        const rig = window as any;
        await rig.mount('policy', 'ghostty', policy);
        rig.policy.write('\x1b]8;;file:///checkout/src/server.ts\x07file\x1b]8;;\x07\r\n\x1b]8;;https://example.com/osc\x07web\x1b]8;;\x07');
      }, policy);
      await frame();
      await click('policy', 1, 0);
      assert.equal(await page.locator('#policy .wterm-link-range').count(), 0);
      await click('policy', 1, 1);
      assert.deepEqual(await urls(), policy === 'guest' ? [['https://example.com/osc', '_blank', 'noopener,noreferrer']] : []);
      await page.evaluate(() => (window as any).policy.dispose());
    }
    assert.deepEqual(opens, []);
  });
  await t.test('a hit at the beginning of a just-replayed snapshot stays visible after first paint', async () => {
    const result = await page.evaluate(async () => {
      const rig = window as any;
      document.getElementById('policy')!.style.height = '420px';
      await rig.mount('policy', 'ghostty', 'changes');
      try {
        const term = rig.policy;
        term.resize(24, 24);
        if (term.native.element.scrollTop !== 0) throw Error('expected fresh pane at scrollTop zero');
        term.write(`first line needle\r\n${'ordinary line\r\n'.repeat(60)}`);
        const answer = rig.findpolicy({ needle: 'first line needle', fromEnd: 61 });
        for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
        const el = term.native.element;
        const hit = el.querySelector('.wterm-find-line')?.getBoundingClientRect();
        const view = el.getBoundingClientRect();
        return { answer, inView: hit && hit.top >= view.top - 1 && hit.bottom <= view.bottom + 1, top: el.scrollTop };
      } finally {
        rig.policy.dispose();
        document.getElementById('policy')!.style.height = '';
      }
    });
    assert.deepEqual(result, { answer: undefined, inView: true, top: 0 });
  });
  await t.test('find agrees on missing and repeated wrapped lines, tracks reflow, replacement, reset and expiry', async () => {
    const needle = '漢e\u0301 disk full';
    const label = 'A long repeated hit: 漢e\u0301 disk    FULL';
    const find = async (n: string, fromEnd: number) =>
      page.evaluate(
        ({ n, fromEnd }) => {
          const r = window as any;
          const hit = { needle: n, fromEnd };
          return [r.findX(hit), r.findw(hit)];
        },
        { n, fromEnd },
      );
    await write(`${'a'.repeat(23)}漢e\u0301`);
    for (const n of ['a漢', 'a 漢']) {
      const [x, w] = await find(n, 8);
      assert.equal(w, x, n);
    }
    await write(`1${label}\r\n${'between\r\n'.repeat(9)}2${label}\r\n${'end\r\n'.repeat(12)}`);
    assert.deepEqual(await find('absent', 1), Array(2).fill('That line has scrolled out of the terminal since'));
    for (const fromEnd of [24, 15]) {
      assert.deepEqual(await find(needle, fromEnd), [undefined, undefined]);
      await frame();
      const rows = await page.evaluate(() => {
        const { w, x } = window as any;
        const el = document.querySelector<HTMLElement>('.wterm-find-line')!;
        const height = parseFloat(getComputedStyle(w.native.element).getPropertyValue('--term-row-height'));
        return [x.markers.at(-1).line, Math.round(el.offsetTop / height), el.textContent, x.buffer.active.viewportY, Math.round(w.native.element.scrollTop / height)];
      });
      assert.equal(rows[1], rows[0]);
      assert.equal(rows[4], rows[3]);
      assert.match(rows[2], fromEnd === 24 ? /^1/ : /^2/);
    }
    await page.evaluate(() => (window as any).w.resize(15, 8));
    await frame();
    assert.match((await page.locator('.wterm-find-line').allTextContents()).join(''), /^2A long repeated hit:/);
    const colors = await page
      .locator('.wterm-find-line span')
      .first()
      .evaluate((e) => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor]);
    assert.deepEqual(colors, ['rgb(0, 0, 0)', 'rgb(255, 209, 102)']);
    await page.evaluate(() => (window as any).w.reset());
    assert.equal(await page.locator('.wterm-find-line').count(), 0);
    await write('disappearing');
    await find('disappearing', 8);
    await frame();
    await page.evaluate(() => (window as any).w.write('\r\x1b[2Kreplacement'));
    assert.equal(await page.locator('.wterm-find-line').count(), 0);
    await page.clock.install();
    await write('eight seconds');
    await find('eight seconds', 8);
    await page.clock.fastForward(7900);
    assert.ok(await page.locator('.wterm-find-line').count());
    await page.clock.fastForward(101);
    assert.equal(await page.locator('.wterm-find-line').count(), 0);
  });
  assert.deepEqual(errors, []);
});
